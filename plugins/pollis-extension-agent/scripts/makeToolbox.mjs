/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Antonio Saragga Seabra
 *  Licensed under the GNU Affero General Public License v3.0 or later. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// Build a Pollis toolbox (a data-only extension) from a spec that names Pollis menu entries and the
// menus and order they go in, and package it as a .vsix to install with "Install from VSIX...".
// Needs only Node 22: no Pollis source checkout, no npm packages.
//
//   node makeToolbox.mjs list [words...]                 the panels whose title or menu title has all the words
//   node makeToolbox.mjs build <spec.toml> [--out <dir>] [--overwrite]
//   node makeToolbox.mjs pack <toolbox folder> [--out <dir>]
//   any command: [--source <url or folder>]           where Pollis' files are read from
//
// build writes <out>/<name>/ (package.json, panels/, wiki/, notebooks/, icon.png, README.md) and
// <out>/<name>-<version>.vsix; <out> defaults to the current folder. pack packages a toolbox folder
// again, e.g. after its README was edited.
//
// Pollis' files are read from https://raw.githubusercontent.com/saragga/pollis/main/ (this plugin
// lives in another repository, Trumpingtons/pollis-plugins): first the panel index
// (build/pollis/panel-index.json, written there by build/pollis/makePanelIndex.ts, whose
// renameMaterialFolders in panelResolver.ts renames folders as this script does), which resolves
// every menu entry to its panel, then only the
// TOML, wiki and notebook files of the panels the spec names. --source reads them from another URL
// or from a local copy of the repository instead.
//
// Every panel is an independent copy: it gets its own panel id, <prefix>.<id>, its own command,
// pollis.<name>.<id>, and its own wiki and notebook folders, <prefix>.<folder>, so it has its own
// editor tab, its own ~/.pollis folders (saved examples, references, videos) and never replaces
// Pollis' wikis and notebooks of the original panel.
//
// The spec (TOML):
//   [extension]
//   name = "pollis-toolbox-stats101"       extension name and folder: lower case letters, digits, hyphens
//   displayName = "Statistics 101"
//   description = "..."
//   version = "1.0.0"                      optional, default 1.0.0
//   prefix = "stats101"                    optional, default: the name without pollis-toolbox-
//
//   [[menu]]                               one or more: where the entries go
//   id = "stats101"
//   title = "Statistics 101"               the submenu's title
//   menu = "Toolboxes"                     Toolboxes, Explore, Model, Simulate, Optimise or a submenu id
//   inline = false                         true: the entries go straight into that menu, no submenu
//   group = "2_toolboxes"                  optional, the group and order of the submenu in that menu
//   order = 4
//
//   [[menu.items]]                         the entries, in the order wanted
//   command = "chiara.statistics.lm"       the origin menu entry's command, or panel = "lm"
//   title = "Linear Regression"            optional menu title, default: the origin's menu title
//   group = "1_panels"                     optional, default "1_panels" (inline: the menu's group)
//   order = 1                              optional, default: the position in the list

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/saragga/pollis/main/';
const INDEX_PATH = 'build/pollis/panel-index.json';
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @typedef {{ id: string; model?: string; menuTitles: string[] }} IndexCommand
 * @typedef {{ id: string; title?: string; source: string; commands: IndexCommand[]; portable: boolean; reason?: string;
 *   defaultModel?: string; decisionFirstColumn?: string; toml?: string; wikiRoot?: string; notebookRoot?: string;
 *   wikis?: string[]; notebooks?: string[]; packages?: string[] }} IndexPanel
 * @typedef {{ version: number; icon: string; menus: { topLevel: string[]; submenus: string[] }; panels: IndexPanel[] }} PanelIndex
 * @typedef {{ [key: string]: unknown }} TomlTable
 */

class UserError extends Error { }

/** @param {string} message @returns {never} */
function fail(message) {
	throw new UserError(message);
}

// --- Reading Pollis' files --------------------------------------------------------------------

/** Reads the files of Pollis from a URL (the public repository) or a local folder. */
class Source {
	/** @param {string} location */
	constructor(location) {
		this.local = !/^https?:\/\//.test(location);
		this.location = this.local ? path.resolve(location) : location.replace(/\/?$/, '/');
	}

	/** @param {string} file a path relative to the repository root @returns {Promise<Buffer>} */
	async read(file) {
		if (this.local) {
			return fs.promises.readFile(path.join(this.location, ...file.split('/')));
		}
		const url = this.location + file.split('/').map(encodeURIComponent).join('/');
		let lastError;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const response = await fetch(url);
				if (response.status === 404) {
					fail(`${url} does not exist`);
				}
				if (!response.ok) {
					throw new Error(`${url} returned ${response.status}`);
				}
				return Buffer.from(await response.arrayBuffer());
			} catch (error) {
				if (error instanceof UserError) {
					throw error;
				}
				lastError = error;
				await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
			}
		}
		fail(`cannot download ${url} (${lastError instanceof Error ? (lastError.cause instanceof Error ? lastError.cause.message : lastError.message) : String(lastError)}). Check the internet connection, or pass --source with a local copy of the Pollis repository`);
	}

	/** @returns {Promise<PanelIndex>} */
	async index() {
		const index = JSON.parse((await this.read(INDEX_PATH)).toString('utf-8'));
		if (index.version !== 1 || !Array.isArray(index.panels)) {
			fail(`${INDEX_PATH} has a format this script does not know: update the Pollis Extension Agent plugin`);
		}
		return index;
	}
}

/**
 * Runs `fn` on every item, at most `limit` at a time.
 * @template T
 * @param {readonly T[]} items @param {number} limit @param {(item: T) => Promise<void>} fn
 */
async function eachLimited(items, limit, fn) {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			await fn(items[next++]);
		}
	});
	await Promise.all(workers);
}

// --- TOML (the subset Pollis uses, as in Pollis' own parser, plus comments after a value) ---------

/** @param {TomlTable} root @param {string} dotPath */
function navigatePath(root, dotPath) {
	const parts = dotPath.split('.');
	let current = root;
	for (let i = 0; i < parts.length - 1; i++) {
		if (!Object.hasOwn(current, parts[i])) {
			current[parts[i]] = {};
		}
		current = /** @type {TomlTable} */ (current[parts[i]]);
	}
	return { parent: current, key: parts[parts.length - 1] };
}

/** A value without the comment after it (a `#` outside quotes). @param {string} value */
function stripComment(value) {
	let quote = '';
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quote) {
			if (ch === '\\' && quote === '"') {
				i++;
			} else if (ch === quote) {
				quote = '';
			}
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
		} else if (ch === '#') {
			return value.slice(0, i).trim();
		}
	}
	return value.trim();
}

/** @param {string} str @returns {unknown} */
function parseValue(str) {
	if (str.startsWith('"') && str.endsWith('"') && str.length >= 2) {
		return str.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	if (str.startsWith('\'') && str.endsWith('\'') && str.length >= 2) {
		return str.slice(1, -1);
	}
	if (str === 'true' || str === 'false') {
		return str === 'true';
	}
	if (/^-?\d+(\.\d+)?$/.test(str)) {
		return Number(str);
	}
	if (str.startsWith('[') && str.endsWith(']')) {
		const items = [];
		let current = '';
		let quote = '';
		for (const ch of str.slice(1, -1)) {
			if (quote) {
				current += ch;
				if (ch === quote) {
					quote = '';
				}
			} else if (ch === '"' || ch === '\'') {
				quote = ch;
				current += ch;
			} else if (ch === ',') {
				items.push(parseValue(current.trim()));
				current = '';
			} else {
				current += ch;
			}
		}
		if (current.trim()) {
			items.push(parseValue(current.trim()));
		}
		return items;
	}
	return str;
}

/** @param {string} content @returns {TomlTable} */
function parseToml(content) {
	/** @type {TomlTable} */
	const result = {};
	let section = result;
	/** @type {Map<string, TomlTable>} */
	const lastArrayElement = new Map();
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const header = stripComment(line);
		if (header.startsWith('[[') && header.endsWith(']]')) {
			const arrayPath = header.slice(2, -2).trim();
			const parts = arrayPath.split('.');
			let base = result;
			let childPath = arrayPath;
			for (let p = parts.length - 1; p >= 1; p--) {
				const prefix = parts.slice(0, p).join('.');
				const element = lastArrayElement.get(prefix);
				if (element) {
					base = element;
					childPath = parts.slice(p).join('.');
					break;
				}
			}
			const { parent, key } = navigatePath(base, childPath);
			if (!Array.isArray(parent[key])) {
				parent[key] = [];
			}
			section = {};
			/** @type {TomlTable[]} */ (parent[key]).push(section);
			lastArrayElement.set(arrayPath, section);
			continue;
		}
		if (header.startsWith('[') && header.endsWith(']')) {
			const { parent, key } = navigatePath(result, header.slice(1, -1).trim());
			if (!Object.hasOwn(parent, key)) {
				parent[key] = {};
			}
			section = /** @type {TomlTable} */ (parent[key]);
			continue;
		}
		const eq = line.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
		const value = line.slice(eq + 1).trim();
		if (value === '\'\'\'' || value === '"""') {
			const body = [];
			for (i++; i < lines.length && lines[i].trimEnd() !== value; i++) {
				body.push(lines[i]);
			}
			section[key] = body.join('\n');
			continue;
		}
		if ((value.startsWith('\'\'\'') || value.startsWith('"""')) && value.length > 6 && value.endsWith(value.slice(0, 3))) {
			section[key] = value.slice(3, -3);
			continue;
		}
		section[key] = parseValue(stripComment(value));
	}
	return result;
}

/** @param {TomlTable} toml @returns {TomlTable[]} the wiki and notebook entries of a panel TOML */
function materialEntries(toml) {
	const list = (/** @type {unknown} */ value) => Array.isArray(value) ? /** @type {TomlTable[]} */ (value) : [];
	return [...list(toml.wikis), ...list(toml.notebookSections).flatMap(section => list(section.notebooks))];
}

// --- Resolving the spec -------------------------------------------------------------------------

/**
 * The panel a menu entry of the spec names.
 * @param {PanelIndex} index @param {TomlTable} item
 * @returns {{ panel: IndexPanel; command: IndexCommand | undefined }}
 */
function resolveItem(index, item) {
	const prefer = (/** @type {IndexPanel[]} */ panels) => panels.find(panel => panel.source === 'pollis') ?? panels[0];
	if (typeof item.command === 'string') {
		const command = item.command;
		const panel = prefer(index.panels.filter(p => p.commands.some(c => c.id === command)));
		if (!panel) {
			fail(`no panel opens with the command ${command}: it is not a menu entry of Pollis that opens a panel (galleries and dialogs cannot be packaged). Run "list" to find the panel`);
		}
		return { panel, command: panel.commands.find(c => c.id === command) };
	}
	if (typeof item.panel === 'string') {
		const id = item.panel;
		const panel = prefer(index.panels.filter(p => p.id === id));
		if (!panel) {
			fail(`no panel has the id ${id}. Run "list" to find the panel`);
		}
		return { panel, command: panel.commands.find(c => !c.model) ?? panel.commands[0] };
	}
	fail('every [[menu.items]] needs a command or a panel');
}

/** @param {PanelIndex} index @param {string} menu */
function checkMenu(index, menu) {
	const lower = menu.toLowerCase();
	if (!index.menus.topLevel.some(top => top.toLowerCase() === lower) && !index.menus.submenus.includes(menu)) {
		fail(`the menu ${menu} does not exist (use ${index.menus.topLevel.join(', ')} or a submenu id)`);
	}
}

/**
 * The panel TOML with its wiki and notebook files moved into the renamed folders.
 * @param {string} text @param {Map<string, string>} renames folder -> new folder @param {number} expected
 */
function renameMaterial(text, renames, expected) {
	let count = 0;
	const renamed = text.replace(/^(\s*file\s*=\s*)(["'])([^"'/\n]+)\/([^"'\n]*)\2/gm, (match, before, quote, folder, rest) => {
		const to = renames.get(folder);
		if (!to) {
			return match;
		}
		count++;
		return `${before}${quote}${to}/${rest}${quote}`;
	});
	if (count !== expected) {
		fail(`cannot rename the wiki and notebook files of a panel TOML (${count} of ${expected} file entries found)`);
	}
	return renamed;
}

/** @param {string} file */
function writeFile(file, /** @type {string | Buffer} */ data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
}

/**
 * Writes the toolbox folder of the spec and returns it.
 * @param {Source} source @param {string} specFile @param {string} outDir @param {boolean} overwrite
 */
async function build(source, specFile, outDir, overwrite) {
	const spec = parseToml(fs.readFileSync(specFile, 'utf-8'));
	const extension = /** @type {TomlTable | undefined} */ (spec.extension);
	const menus = /** @type {TomlTable[]} */ (Array.isArray(spec.menu) ? spec.menu : []);
	if (!extension || typeof extension.name !== 'string' || typeof extension.displayName !== 'string' || !menus.length) {
		fail('the spec needs [extension] with name and displayName, and at least one [[menu]]');
	}
	const name = extension.name;
	if (!NAME.test(name)) {
		fail(`the extension name ${name} must be lower case letters, digits and hyphens`);
	}
	if (extension.mode !== undefined && extension.mode !== 'copy') {
		fail('this builder only makes copies (mode = "copy"): Pollis keeps its own panels');
	}
	const prefix = typeof extension.prefix === 'string' ? extension.prefix : name.replace(/^pollis-toolbox-/, '');
	if (!NAME.test(prefix)) {
		fail(`the prefix ${prefix} must be lower case letters, digits and hyphens`);
	}
	const version = typeof extension.version === 'string' ? extension.version : '1.0.0';
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		fail(`the version ${version} must look like 1.0.0`);
	}
	const folder = path.join(outDir, name);
	if (fs.existsSync(folder)) {
		if (!overwrite) {
			fail(`${folder} exists: pass --overwrite to write it again`);
		}
		fs.rmSync(folder, { recursive: true });
	}

	const index = await source.index();
	/** @type {Map<string, IndexPanel>} the panels by panel id, to find the ones listed twice */
	const seen = new Map();
	/** @type {Map<string, string>} the source of each copied folder, `wiki:<new folder>` -> `<root>/<folder>` */
	const copiedFolders = new Map();
	/** @type {{ from: string; to: string }[]} */
	const downloads = [];
	const toolboxes = [];
	const readmeRows = [];
	const panelTomls = [];
	for (const menu of menus) {
		if (typeof menu.id !== 'string' || typeof menu.title !== 'string') {
			fail('every [[menu]] needs an id and a title');
		}
		if (typeof menu.menu === 'string') {
			checkMenu(index, menu.menu);
		}
		const items = /** @type {TomlTable[]} */ (Array.isArray(menu.items) ? menu.items : []);
		if (!items.length) {
			fail(`the menu ${menu.id} has no [[menu.items]]`);
		}
		const panels = [];
		for (const [position, item] of items.entries()) {
			const { panel, command } = resolveItem(index, item);
			if (!panel.portable || !panel.toml || !panel.wikiRoot || !panel.notebookRoot) {
				fail(`${panel.title ?? panel.id}: ${panel.reason ?? 'it cannot be packaged'}`);
			}
			if (seen.has(panel.id)) {
				fail(`the panel ${panel.id} is listed twice`);
			}
			seen.set(panel.id, panel);
			const id = `${prefix}.${panel.id}`;
			const title = panel.title ?? panel.id;
			const menuTitle = typeof item.title === 'string' ? item.title : command?.menuTitles[0];
			panelTomls.push({ panel, id });
			panels.push({
				id,
				command: `pollis.${name}.${panel.id}`,
				title,
				...(menuTitle && menuTitle !== title ? { menuTitle } : {}),
				group: typeof item.group === 'string' ? item.group : menu.inline === true && typeof menu.group === 'string' ? menu.group : '1_panels',
				order: typeof item.order === 'number' ? item.order : position + 1,
				data: `panels/${id}.toml`,
				defaultModel: command?.model ?? panel.defaultModel,
				...(panel.decisionFirstColumn ? { decisionFirstColumn: panel.decisionFirstColumn } : {}),
			});
			readmeRows.push(`| ${menuTitle ?? title} | TODO | ${(panel.packages ?? []).join(', ')} |`);
		}
		toolboxes.push({
			id: menu.id,
			title: menu.title,
			...(typeof menu.menu === 'string' ? { menu: menu.menu } : {}),
			...(menu.inline === true ? { inline: true } : {}),
			...(typeof menu.group === 'string' ? { group: menu.group } : {}),
			...(typeof menu.order === 'number' ? { order: menu.order } : {}),
			panels,
		});
	}

	// The panels' TOMLs, their wiki and notebook folders renamed <prefix>.<folder>
	await eachLimited(panelTomls, 8, async ({ panel, id }) => {
		const text = (await source.read(/** @type {string} */(panel.toml))).toString('utf-8');
		// Only the folders the toolbox ships are renamed: a file the TOML names elsewhere (in another
		// toolbox, say) keeps resolving where it did in Pollis
		const shipped = new Set([...(panel.wikis ?? []), ...(panel.notebooks ?? [])].map(file => file.split('/')[0]));
		const renames = new Map([...shipped].map(f => [f, `${prefix}.${f}`]));
		const entries = materialEntries(parseToml(text)).filter(entry => typeof entry.file === 'string' && renames.has(entry.file.split('/')[0]));
		writeFile(path.join(folder, 'panels', `${id}.toml`), renameMaterial(text, renames, entries.length));
		for (const [kind, root, files] of /** @type {const} */ ([['wiki', panel.wikiRoot, panel.wikis], ['notebooks', panel.notebookRoot, panel.notebooks]])) {
			for (const file of files ?? []) {
				const [from, ...rest] = file.split('/');
				const to = /** @type {string} */ (renames.get(from));
				const key = `${kind}:${to}`;
				const origin = `${root}/${from}`;
				if (copiedFolders.has(key) && copiedFolders.get(key) !== origin) {
					fail(`two panels use different ${kind} folders named ${from} (${copiedFolders.get(key)} and ${origin})`);
				}
				copiedFolders.set(key, origin);
				downloads.push({ from: `${root}/${file}`, to: path.join(folder, kind, to, ...rest) });
			}
		}
	});
	const unique = [...new Map(downloads.map(download => [download.to, download])).values()];
	let done = 0;
	await eachLimited(unique, 8, async download => {
		writeFile(download.to, await source.read(download.from));
		done++;
		if (process.stderr.isTTY) {
			process.stderr.write(`\rDownloading the wikis and notebooks: ${done}/${unique.length}`);
		}
	});
	if (process.stderr.isTTY && unique.length) {
		process.stderr.write('\n');
	}
	writeFile(path.join(folder, 'icon.png'), await source.read(index.icon));

	const manifest = {
		name,
		displayName: extension.displayName,
		description: typeof extension.description === 'string' ? extension.description : '',
		version,
		publisher: 'pollis',
		license: 'AGPL-3.0-or-later',
		icon: 'icon.png',
		engines: { vscode: '*' },
		categories: ['Other'],
		contributes: { pollisToolboxes: toolboxes },
	};
	writeFile(path.join(folder, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

	const where = toolboxes.map(toolbox => {
		const parent = toolbox.menu ?? 'Toolboxes';
		return toolbox.inline ? `adds its panels to the **${parent}** menu` : `adds the **${toolbox.title}** submenu to the **${parent}** menu`;
	}).join(', and ');
	writeFile(path.join(folder, 'README.md'), [
		`# ${extension.displayName}`,
		'',
		manifest.description,
		'',
		`Installing it ${where}. Each panel has key points, a decision table, example code you can send to the Julia REPL or a notebook, reference wikis and notebook tutorials.`,
		'',
		'## Panels',
		'',
		'| Panel | What it covers | Powered by |',
		'|---|---|---|',
		...readmeRows,
		'',
		'## Requirements',
		'',
		'Pollis and Julia. Each panel lists the Julia packages it uses on its Powered by line and offers to install the missing ones.',
		'',
		'## License',
		'',
		'AGPL-3.0-or-later.',
		'',
	].join('\n'));

	for (const { panel, id } of panelTomls) {
		console.log(`${id}: ${panel.title ?? panel.id} (${panel.wikis?.length ?? 0} wiki files, ${panel.notebooks?.length ?? 0} notebook files)`);
	}
	console.log(`Wrote ${folder}/ (${panelTomls.length} panels).`);
	return folder;
}

// --- Packaging ----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

/** @param {Buffer} data */
function crc32(data) {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) {
		crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** A zip of the entries, deflated (or stored where deflating does not make them smaller). @param {{ name: string; data: Buffer }[]} entries */
function writeZip(entries) {
	const dosTime = 0;
	const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf-8');
		const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
		const stored = deflated.length >= entry.data.length;
		const content = stored ? entry.data : deflated;
		const method = stored ? 0 : 8;
		const crc = crc32(entry.data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034B50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // file name in UTF-8
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(dosTime, 10);
		local.writeUInt16LE(dosDate, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(content.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, content);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014B50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(dosTime, 12);
		central.writeUInt16LE(dosDate, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(content.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + content.length;
	}
	const centralDirectory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054B50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralDirectory, end]);
}

/** The files of a folder, relative to it with forward slashes, sorted; dot files are left out. @param {string} folder @returns {string[]} */
function listFiles(folder, prefix = '') {
	const files = [];
	for (const entry of fs.readdirSync(path.join(folder, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith('.')) {
			continue;
		}
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...listFiles(folder, relative));
		} else if (entry.isFile()) {
			files.push(relative);
		}
	}
	return files;
}

/** @param {string} value */
function escapeXml(value) {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
	'.json': 'application/json',
	'.vsixmanifest': 'text/xml',
	'.md': 'text/markdown',
	'.toml': 'text/plain',
	'.ipynb': 'application/x-ipynb+json',
	'.txt': 'text/plain',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
};

/** @param {string[]} names */
function contentTypesXml(names) {
	const extensions = [...new Set(names.map(name => path.posix.extname(name).toLowerCase()).filter(ext => ext))].sort();
	const defaults = extensions.map(ext => `<Default Extension="${escapeXml(ext)}" ContentType="${CONTENT_TYPES[ext] ?? 'application/octet-stream'}"/>`);
	return `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}</Types>\n`;
}

/**
 * @param {{ name: string; displayName?: string; description?: string; version: string; publisher: string; categories?: string[]; engines?: { vscode?: string }; icon?: string }} manifest
 * @param {boolean} hasReadme
 */
function vsixManifestXml(manifest, hasReadme) {
	const properties = [
		['Microsoft.VisualStudio.Code.Engine', manifest.engines?.vscode ?? '*'],
		['Microsoft.VisualStudio.Code.ExtensionDependencies', ''],
		['Microsoft.VisualStudio.Code.ExtensionPack', ''],
		['Microsoft.VisualStudio.Code.ExtensionKind', 'workspace'],
		['Microsoft.VisualStudio.Code.LocalizedLanguages', ''],
	].map(([id, value]) => `\t\t\t<Property Id="${id}" Value="${escapeXml(value)}" />`);
	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
		'\t<Metadata>',
		`\t\t<Identity Language="en-US" Id="${escapeXml(manifest.name)}" Version="${escapeXml(manifest.version)}" Publisher="${escapeXml(manifest.publisher)}" />`,
		`\t\t<DisplayName>${escapeXml(manifest.displayName ?? manifest.name)}</DisplayName>`,
		`\t\t<Description xml:space="preserve">${escapeXml(manifest.description ?? '')}</Description>`,
		'\t\t<Tags></Tags>',
		`\t\t<Categories>${escapeXml((manifest.categories ?? []).join(','))}</Categories>`,
		'\t\t<GalleryFlags>Public</GalleryFlags>',
		'\t\t<Properties>',
		...properties,
		'\t\t</Properties>',
		'\t</Metadata>',
		'\t<Installation>',
		'\t\t<InstallationTarget Id="Microsoft.VisualStudio.Code"/>',
		'\t</Installation>',
		'\t<Dependencies/>',
		'\t<Assets>',
		'\t\t<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
		...(hasReadme ? ['\t\t<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />'] : []),
		...(manifest.icon ? [`\t\t<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${escapeXml(manifest.icon)}" Addressable="true" />`] : []),
		'\t</Assets>',
		'</PackageManifest>',
		'',
	].join('\n');
}

/** Writes `<outDir>/<name>-<version>.vsix` from a toolbox folder and returns its path. @param {string} folder @param {string} outDir */
function pack(folder, outDir) {
	const manifestFile = path.join(folder, 'package.json');
	if (!fs.existsSync(manifestFile)) {
		fail(`${folder} has no package.json`);
	}
	const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
	if (!manifest.name || !manifest.publisher || !manifest.version || !manifest.contributes?.pollisToolboxes) {
		fail(`${manifestFile} is not a Pollis toolbox (it needs a name, a publisher, a version and a pollisToolboxes contribution)`);
	}
	const files = listFiles(folder);
	if (manifest.icon && !files.includes(manifest.icon)) {
		fail(`${manifestFile} names the icon ${manifest.icon}, which does not exist`);
	}
	const hasReadme = files.includes('README.md');
	const readme = hasReadme && fs.readFileSync(path.join(folder, 'README.md'), 'utf-8');
	if (readme && readme.includes('| TODO |')) {
		console.warn('Warning: the README still has TODO in its "What it covers" column');
	}
	const entries = [
		{ name: 'extension.vsixmanifest', data: Buffer.from(vsixManifestXml(manifest, hasReadme), 'utf-8') },
		{ name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(['extension.vsixmanifest', ...files]), 'utf-8') },
		...files.map(file => ({
			name: `extension/${file}`,
			// The README gets the version on the line below its title, as the published toolboxes do
			data: file === 'README.md' && readme
				? Buffer.from(readme.replace(/^(#[^\n]*\n)(?!\nVersion )/, `$1\nVersion ${manifest.version}\n`), 'utf-8')
				: fs.readFileSync(path.join(folder, file)),
		})),
	];
	const vsix = path.join(outDir, `${manifest.name}-${manifest.version}.vsix`);
	writeFile(vsix, writeZip(entries));
	console.log(`Wrote ${vsix} (${files.length} files). Install it in Pollis with "Extensions: Install from VSIX...".`);
	return vsix;
}

// --- Listing ------------------------------------------------------------------------------------

/** @param {Source} source @param {string[]} words */
async function list(source, words) {
	const index = await source.index();
	const lower = words.map(word => word.toLowerCase());
	const matches = index.panels.filter(panel => {
		const text = [panel.id, panel.title ?? '', ...panel.commands.flatMap(command => [command.id, ...command.menuTitles])].join(' ').toLowerCase();
		return lower.every(word => text.includes(word));
	});
	for (const panel of matches) {
		const from = panel.source === 'pollis' ? 'Pollis' : `the ${panel.source.slice('toolbox:'.length)} toolbox`;
		console.log(`${panel.id}: ${panel.title ?? panel.commands[0]?.menuTitles[0] ?? panel.id} (from ${from})${panel.portable ? '' : ` NOT PORTABLE: ${panel.reason}`}`);
		for (const command of panel.commands) {
			console.log(`    command = "${command.id}"${command.model ? ` (opens on the model ${command.model})` : ''}${command.menuTitles.length ? `, menu item "${command.menuTitles.join('", "')}"` : ''}`);
		}
	}
	console.log(`${matches.length} of ${index.panels.length} panels.`);
	if (!words.length) {
		console.log(`Menus: ${index.menus.topLevel.join(', ')}, or a submenu id: ${index.menus.submenus.join(', ')}`);
	}
}

// --- Command line -------------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {string[]} */
	const positional = [];
	/** @type {Record<string, string | boolean>} */
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--overwrite') {
			options.overwrite = true;
		} else if (arg === '--out' || arg === '--source') {
			const value = argv[++i];
			if (!value) {
				fail(`${arg} needs a value`);
			}
			options[arg.slice(2)] = value;
		} else if (arg.startsWith('--')) {
			fail(`unknown option ${arg}`);
		} else {
			positional.push(arg);
		}
	}
	return { positional, options };
}

async function main() {
	const { positional: [command, ...rest], options } = parseArgs(process.argv.slice(2));
	const source = new Source(typeof options.source === 'string' ? options.source : DEFAULT_SOURCE);
	const outDir = path.resolve(typeof options.out === 'string' ? options.out : '.');
	switch (command) {
		case 'list':
			await list(source, rest);
			break;
		case 'build': {
			if (rest.length !== 1) {
				fail('usage: node makeToolbox.mjs build <spec.toml> [--out <dir>] [--overwrite] [--source <url or folder>]');
			}
			const folder = await build(source, rest[0], outDir, options.overwrite === true);
			pack(folder, outDir);
			console.log('Next: fill the "What it covers" column of its README.md, then run pack on the folder to package it again.');
			break;
		}
		case 'pack':
			if (rest.length !== 1) {
				fail('usage: node makeToolbox.mjs pack <toolbox folder> [--out <dir>]');
			}
			pack(path.resolve(rest[0]), typeof options.out === 'string' ? outDir : path.dirname(path.resolve(rest[0])));
			break;
		default:
			fail('usage: node makeToolbox.mjs list [words...] | build <spec.toml> | pack <toolbox folder>  (see the top of this file)');
	}
}

main().catch(error => {
	console.error(`Error: ${error instanceof UserError ? error.message : error instanceof Error ? error.stack : String(error)}`);
	process.exit(1);
});
