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
//   author = "Ana Silva"                   optional: shown in Pollis as the toolbox's publisher (default: pollis)
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
//   command = "chiara.statistics.lm"       the origin menu entry's command, or panel = "lm", or
//                                          toml = "garch.toml", a panel of your own (below)
//   title = "Linear Regression"            optional menu title, default: the origin's menu title
//   group = "1_panels"                     optional, default "1_panels" (inline: the menu's group)
//   order = 1                              optional, default: the position in the list
//
// A panel of your own (the create-panel skill writes them) is a panel TOML, relative to the spec,
// whose id is its file name (garch.toml: garch). Its wiki and notebook files are looked for in
// wiki/ and notebooks/ next to it (wiki/garch/overview.md), as validatePanel.mjs does, and their
// folders are copied into the toolbox; a file that is not there must be one of Pollis' own. The
// panel must pass validatePanel.mjs, which the build runs first.
//
// Every TOML is read with Pollis' own parser, build/pollis/pollisToml.mjs, downloaded with the
// panel index (pollis.mjs). In the spec, a comment may also follow a value.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { DEFAULT_SOURCE, fail, materialRoots, Source, UserError } from './pollis.mjs';
import { builtInFiles, sortedProblems, validate } from './validatePanel.mjs';

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @typedef {import('./pollis.mjs').Table} TomlTable
 * @typedef {import('./pollis.mjs').IndexPanel} IndexPanel
 * @typedef {import('./pollis.mjs').IndexCommand} IndexCommand
 * @typedef {import('./pollis.mjs').PanelIndex} PanelIndex
 * @typedef {import('./pollis.mjs').Parser} Parser
 */

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

// --- TOML -----------------------------------------------------------------------------------------

/** A line without the comment after it (a `#` outside quotes). @param {string} line */
function stripComment(line) {
	let quote = '';
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === '\\' && quote === '"') {
				i++;
			} else if (ch === quote) {
				quote = '';
			}
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
		} else if (ch === '#') {
			return line.slice(0, i).trimEnd();
		}
	}
	return line;
}

/**
 * The spec, read with Pollis' parser after the comments that follow values are removed (a spec
 * has no multi-line strings).
 * @param {Parser} parser @param {string} text
 */
function parseSpec(parser, text) {
	return parser.parseToml(text.replace(/\r\n/g, '\n').split('\n').map(stripComment).join('\n'));
}

/** @param {unknown} value @returns {TomlTable[]} */
function tables(value) {
	return Array.isArray(value) ? value : [];
}

/** The wiki and notebook entries of a panel TOML, by the toolbox folder they go in. @param {TomlTable} toml */
function materialEntries(toml) {
	return { wiki: tables(toml.wikis), notebooks: tables(toml.notebookSections).flatMap(section => tables(section.notebooks)) };
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

/**
 * A panel the toolbox copies: what its package.json entry needs, and how to write its files.
 * @typedef {{ panelId: string; title: string; menuTitle?: string; defaultModel?: string; decisionFirstColumn?: string;
 *   packages: string[]; summary: string; write: () => Promise<void> }} PanelCopy
 * @typedef {(kind: string, to: string, origin: string) => void} ClaimFolder
 */

/**
 * A copy of a Pollis panel: its TOML, wiki and notebook files downloaded from Pollis.
 * @param {{ panel: IndexPanel; command: IndexCommand | undefined }} resolved
 * @param {{ parser: Parser; source: Source; prefix: string; folder: string; claimFolder: ClaimFolder; downloads: { from: string; to: string }[] }} context
 * @returns {PanelCopy}
 */
function pollisPanel({ panel, command }, { parser, source, prefix, folder, claimFolder, downloads }) {
	const { toml, wikiRoot, notebookRoot } = panel;
	if (!panel.portable || !toml || !wikiRoot || !notebookRoot) {
		fail(`${panel.title ?? panel.id}: ${panel.reason ?? 'it cannot be packaged'}`);
	}
	const id = `${prefix}.${panel.id}`;
	// Only the folders the toolbox ships are renamed: a file the TOML names elsewhere (in another
	// toolbox, say) keeps resolving where it did in Pollis
	const shipped = new Set([...(panel.wikis ?? []), ...(panel.notebooks ?? [])].map(file => file.split('/')[0]));
	const renames = new Map([...shipped].map(f => [f, `${prefix}.${f}`]));
	for (const [kind, root, files] of /** @type {const} */ ([['wiki', wikiRoot, panel.wikis], ['notebooks', notebookRoot, panel.notebooks]])) {
		for (const file of files ?? []) {
			const [from, ...rest] = file.split('/');
			const to = /** @type {string} */ (renames.get(from));
			claimFolder(kind, to, `${root}/${from}`);
			downloads.push({ from: `${root}/${file}`, to: path.join(folder, kind, to, ...rest) });
		}
	}
	return {
		panelId: panel.id,
		title: panel.title ?? panel.id,
		menuTitle: command?.menuTitles[0],
		defaultModel: command?.model ?? panel.defaultModel,
		decisionFirstColumn: panel.decisionFirstColumn,
		packages: panel.packages ?? [],
		summary: `${panel.wikis?.length ?? 0} wiki files, ${panel.notebooks?.length ?? 0} notebook files`,
		write: async () => {
			const text = (await source.read(toml)).toString('utf-8');
			const { wiki, notebooks } = materialEntries(parser.parseToml(text));
			const expected = [...wiki, ...notebooks].filter(entry => typeof entry.file === 'string' && renames.has(entry.file.split('/')[0])).length;
			writeFile(path.join(folder, 'panels', `${id}.toml`), renameMaterial(text, renames, expected));
		},
	};
}

/**
 * A copy of a panel of the user's own: a panel TOML that passes the validator, with the wiki and
 * notebook folders next to it.
 * @param {string} file
 * @param {{ parser: Parser; index: PanelIndex; prefix: string; folder: string; claimFolder: ClaimFolder }} context
 * @returns {PanelCopy}
 */
function localPanel(file, { parser, index, prefix, folder, claimFolder }) {
	if (!fs.existsSync(file)) {
		fail(`the panel ${file} does not exist`);
	}
	const panelId = path.basename(file, '.toml');
	if (!file.endsWith('.toml') || !NAME.test(panelId)) {
		fail(`the panel file ${path.basename(file)} must be named <id>.toml, the id in lower case letters, digits and hyphens`);
	}
	const text = fs.readFileSync(file, 'utf-8');
	const roots = materialRoots(file);
	const report = validate(file, text, parser, { ...roots, builtIn: builtInFiles(index) });
	if (report.errors.length) {
		const errors = sortedProblems(report).filter(problem => problem.kind === 'error').map(problem => `  ${file}:${problem.line}: ${problem.message}`);
		fail([`the panel ${file} has errors:`, ...errors, 'Fix them, and check it again with validatePanel.mjs.'].join('\n'));
	}
	if (report.warnings.length) {
		console.warn(`Warning: the panel ${file} has ${report.warnings.length} warnings: run validatePanel.mjs on it to see them`);
	}
	const toml = parser.parseToml(text);
	const meta = /** @type {TomlTable} */ (toml.meta);
	// The folders of the files found next to the panel are copied; the other files are Pollis' own
	/** @type {Map<string, string>} */
	const renames = new Map();
	/** @type {{ kind: string; from: string; to: string }[]} */
	const folders = [];
	let expected = 0;
	const counts = { wiki: 0, notebooks: 0 };
	for (const [kind, entries] of Object.entries(materialEntries(toml))) {
		const kindRoots = kind === 'wiki' ? roots.wiki : roots.notebooks;
		for (const entry of entries) {
			const entryFile = entry.file;
			const root = typeof entryFile === 'string' ? kindRoots.find(candidate => fs.existsSync(path.join(candidate, entryFile))) : undefined;
			if (typeof entryFile !== 'string' || !root) {
				continue;
			}
			const from = entryFile.split('/')[0];
			const to = `${prefix}.${from}`;
			claimFolder(kind, to, path.join(root, from));
			renames.set(from, to);
			folders.push({ kind, from: path.join(root, from), to: path.join(folder, kind, to) });
			counts[kind === 'wiki' ? 'wiki' : 'notebooks']++;
			expected++;
		}
	}
	const id = `${prefix}.${panelId}`;
	return {
		panelId,
		title: String(meta.title),
		defaultModel: String(meta.defaultModel),
		decisionFirstColumn: typeof meta.decisionFirstColumn === 'string' ? meta.decisionFirstColumn : undefined,
		packages: tables(toml.packages).map(pkg => String(pkg.name)),
		summary: `${counts.wiki} wiki files, ${counts.notebooks} notebook files, from ${path.dirname(file)}`,
		write: async () => {
			writeFile(path.join(folder, 'panels', `${id}.toml`), renameMaterial(text, renames, expected));
			for (const copy of folders) {
				fs.cpSync(copy.from, copy.to, { recursive: true });
			}
		},
	};
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
	const [index, parser] = await Promise.all([source.index(), source.parser()]);
	const spec = parseSpec(parser, fs.readFileSync(specFile, 'utf-8'));
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

	/** @type {Set<string>} the copies' panel ids, to find the panels listed twice */
	const seen = new Set();
	/** @type {Map<string, string>} the source of each copied folder, `wiki:<new folder>` -> `<root>/<folder>` */
	const copiedFolders = new Map();
	/** @param {string} kind @param {string} to @param {string} origin */
	const claimFolder = (kind, to, origin) => {
		const key = `${kind}:${to}`;
		if (copiedFolders.has(key) && copiedFolders.get(key) !== origin) {
			fail(`two panels use different ${kind} folders named ${to.slice(prefix.length + 1)} (${copiedFolders.get(key)} and ${origin})`);
		}
		copiedFolders.set(key, origin);
	};
	/** @type {{ from: string; to: string }[]} */
	const downloads = [];
	const toolboxes = [];
	const readmeRows = [];
	/** @type {{ id: string; title: string; summary: string; write: () => Promise<void> }[]} */
	const copies = [];
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
			const copy = typeof item.toml === 'string'
				? localPanel(path.resolve(path.dirname(specFile), item.toml), { parser, index, prefix, folder, claimFolder })
				: pollisPanel(resolveItem(index, item), { parser, source, prefix, folder, claimFolder, downloads });
			const id = `${prefix}.${copy.panelId}`;
			if (seen.has(id)) {
				fail(`the panel ${copy.panelId} is listed twice`);
			}
			seen.add(id);
			const menuTitle = typeof item.title === 'string' ? item.title : copy.menuTitle;
			copies.push({ id, title: copy.title, summary: copy.summary, write: copy.write });
			panels.push({
				id,
				command: `pollis.${name}.${copy.panelId}`,
				title: copy.title,
				...(menuTitle && menuTitle !== copy.title ? { menuTitle } : {}),
				group: typeof item.group === 'string' ? item.group : menu.inline === true && typeof menu.group === 'string' ? menu.group : '1_panels',
				order: typeof item.order === 'number' ? item.order : position + 1,
				data: `panels/${id}.toml`,
				defaultModel: copy.defaultModel,
				...(copy.decisionFirstColumn ? { decisionFirstColumn: copy.decisionFirstColumn } : {}),
			});
			readmeRows.push(`| ${menuTitle ?? copy.title} | TODO | ${copy.packages.join(', ')} |`);
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
	await eachLimited(copies, 8, copy => copy.write());
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
		...(typeof extension.author === 'string' && extension.author.trim() ? { author: extension.author.trim() } : {}),
		license: 'AGPL-3.0',
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
		'AGPL-3.0',
		'',
	].join('\n'));

	for (const copy of copies) {
		console.log(`${copy.id}: ${copy.title} (${copy.summary})`);
	}
	console.log(`Wrote ${folder}/ (${copies.length} panels).`);
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
