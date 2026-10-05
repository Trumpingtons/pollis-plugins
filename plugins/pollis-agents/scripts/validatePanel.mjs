/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Antonio Saragga Seabra
 *  Licensed under the GNU Affero General Public License v3.0 or later. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// Check a Pollis panel TOML before it goes into a toolbox: the panel Pollis would render from it,
// the files it names, and the content rules of Pollis panels.
// Needs only Node 22: no Pollis source checkout, no npm packages.
//
//   node validatePanel.mjs <panel.toml>... [--wiki <dir>] [--notebooks <dir>] [--quiet]
//                          [--source <url or folder>]
//
// The TOML is parsed by Pollis' own parser, build/pollis/pollisToml.mjs, read from
// https://raw.githubusercontent.com/saragga/pollis/main/ (or --source), so it is read exactly as
// Pollis reads it. The checks:
//   errors    a table or field Pollis does not know, a missing required field, a wrong type, a model
//             id, input id or {{placeholder}} that names nothing, a `when` condition that can never
//             hold, a duplicate id, a wiki or notebook file that does not exist, a section that only
//             a panel with its own code can use
//   warnings  the content rules: literal Greek letters, DataFrames, Zygote, spaces inside
//             parentheses in labels, a panel without wikis, notebooks or Next Steps
// The wiki and notebook files named by `file` are looked for in <dir>/wiki/ and <dir>/notebooks/
// next to the TOML, or in ../wiki/ and ../notebooks/ (a toolbox's panels/ folder), unless --wiki and
// --notebooks give the folders. Exit status: 0 when there are no errors, 1 otherwise.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SOURCE, fail, materialRoots, Source, UserError } from './pollis.mjs';

/** @typedef {import('./pollis.mjs').Parser} Parser */

/**
 * The wiki and notebook files of Pollis' own panels (`lm/overview.md`), from the panel index: a
 * panel may name them, since Pollis finds wiki and notebook folders by name.
 * @param {import('./pollis.mjs').PanelIndex} index @returns {Set<string>}
 */
export function builtInFiles(index) {
	return new Set(index.panels.flatMap(panel => [...panel.wikis ?? [], ...panel.notebooks ?? []]));
}

// --- Line numbers ---------------------------------------------------------------------------------

/** @typedef {import('./pollis.mjs').Table} Table */
/** @typedef {(string | number)[]} KeyPath */

/**
 * The line of every table and key of a TOML file, by its path in the parsed data
 * (`inputs.3.when`): array tables are numbered in the order they appear, as the parser does.
 * Also the lines Pollis' parser would misread: a value it would read as plain text (an unclosed
 * string, a bare word, an array that does not close on its line, a comment after the value), a
 * header it would skip (a comment after it), a multi-line string that never closes.
 * @param {string} text @returns {{ lines: Map<string, number>; misread: { line: number; message: string }[] }}
 */
function lineIndex(text) {
	/** @type {Map<string, number>} */
	const lines = new Map();
	/** @type {{ line: number; message: string }[]} */
	const misread = [];
	/** @type {Map<string, number>} the index of the latest entry of each array table */
	const latest = new Map();
	let current = '';
	/** @type {{ quote: string; line: number } | undefined} */
	let multiline;
	const all = text.replace(/\r\n/g, '\n').split('\n');
	for (let i = 0; i < all.length; i++) {
		const line = all[i].trim();
		if (multiline) {
			// Pollis ends a multi-line string only on a line that is the closing quotes alone, at its start
			if (all[i].trimEnd() === multiline.quote) {
				multiline = undefined;
			}
			continue;
		}
		const header = /^(?<array>\[\[|\[)\s*(?<name>[\w.-]+)\s*\]\]?/.exec(line);
		if (header?.groups) {
			if (header[0] !== line) {
				misread.push({ line: i + 1, message: `Pollis skips this header line: put nothing after the closing bracket (a comment goes on its own line)` });
			}
			// Each parent segment is the latest entry of its array table, if it is one
			const parts = header.groups.name.split('.');
			let concrete = '';
			for (const [index, part] of parts.entries()) {
				concrete = concrete ? `${concrete}.${part}` : part;
				const last = index === parts.length - 1;
				if (!last && !lines.has(concrete)) {
					lines.set(concrete, i + 1);
				}
				if (last && header.groups.array === '[[') {
					const next = (latest.get(concrete) ?? -1) + 1;
					latest.set(concrete, next);
					concrete = `${concrete}.${next}`;
				} else if (!last && latest.has(concrete)) {
					concrete = `${concrete}.${latest.get(concrete)}`;
				}
			}
			current = concrete;
			if (!lines.has(current)) {
				lines.set(current, i + 1);
			}
			const base = current.replace(/\.\d+$/, '');
			if (!lines.has(base)) {
				lines.set(base, i + 1);
			}
			continue;
		}
		const key = /^(?<key>[A-Za-z_][\w-]*)\s*=\s*(?<value>.*)$/.exec(line);
		if (key?.groups) {
			const keyPath = current ? `${current}.${key.groups.key}` : key.groups.key;
			if (!lines.has(keyPath)) {
				lines.set(keyPath, i + 1);
			}
			const value = key.groups.value.trim();
			if (value === "'''" || value === '"""') {
				multiline = { quote: value, line: i + 1 };
			} else if (!isValue(value)) {
				misread.push({ line: i + 1, message: `Pollis reads the value of ${key.groups.key} as plain text: close the string on this line, put an array on one line, quote a word, and put a comment on its own line (a multi-line string starts with ''' alone after the =)` });
			}
		}
	}
	if (multiline) {
		misread.push({ line: multiline.line, message: `this multi-line string never ends: end it with ${multiline.quote} alone on a line, at its start` });
	}
	return { lines, misread };
}

/** Whether a value, as written after `key =`, is one Pollis' parser reads as written. @param {string} value */
function isValue(value) {
	return [
		String.raw`^"(?:[^"\\]|\\.)*"$`,
		String.raw`^'[^']*'$`,
		String.raw`^'''.*'''$`,
		String.raw`^-?\d+(?:\.\d+)?$`,
		String.raw`^(?:true|false)$`,
		String.raw`^\[(?:[^#"']|"(?:[^"\\]|\\.)*"|'[^']*')*\]$`,
	].some(pattern => new RegExp(pattern).test(value));
}

// --- The schema -----------------------------------------------------------------------------------

/**
 * A field: its type, and whether the TOML must give it.
 * @typedef {{ type: 'string' | 'number' | 'boolean' | 'strings' | 'scalar'; required?: boolean } | { type: 'array'; item: Shape; required?: boolean } | { type: 'table'; shape: Shape; required?: boolean }} Field
 * @typedef {{ [key: string]: Field }} Shape
 */

/** @type {(required?: boolean) => Field} */
const string = required => ({ type: 'string', required });
/** @type {(required?: boolean) => Field} */
const boolean = required => ({ type: 'boolean', required });
const strings = /** @type {Field} */ ({ type: 'strings' });
/** @type {(item: Shape, required?: boolean) => Field} */
const array = (item, required) => ({ type: 'array', item, required });

/** @type {Shape} */
const VIDEO = { title: string(true), description: string(), url: string(true) };
/** @type {Shape} */
const PACKAGE = { name: string(true), github: string(true), fork: boolean(), license: string(), videos: array(VIDEO) };
/** @type {Shape} */
const NOTEBOOK = { name: string(true), description: string(), file: string(), url: string(), bundled: boolean() };
/** @type {Shape} */
const WIKI = { name: string(true), description: string(), file: string(), url: string(), bundled: boolean() };
/** @type {Shape} */
const SEPARATOR = { separator: boolean(true), label: string() };
/** @type {Shape} */
const REFERENCE = { title: string(true), authors: string(true), year: { type: 'number', required: true }, journal: string(), doi: string(), url: string(), openAccess: boolean() };
/** @type {Shape} */
const OPTION = { value: string(true), label: string(true), models: strings, when: string() };
/** @type {Shape} */
const INPUT = { id: string(true), label: string(true), tooltip: string(), kind: string(), default: { type: 'scalar' }, options: array(OPTION), models: strings, when: string(), newRow: boolean() };
/** @type {Shape} */
const ACTION = { id: string(true), label: string(true), desc: string(true), code: string(true), models: strings, when: string() };

/** The tables of a panel TOML (meta, miniCharts, wikis and references are checked on their own). @type {Shape} */
const PANEL = {
	packages: array(PACKAGE, true),
	requires: { type: 'table', shape: { packages: strings } },
	notebookSections: array({ label: string(true), notebooks: array(NOTEBOOK, true) }),
	models: array({ id: string(true), label: string(true) }),
	bullets: array({ text: string(true), detail: string() }),
	decisionRows: array({ task: string(true), context: string(true), purpose: string(true) }),
	codeBranches: array({ model: string(true), code: string(true) }, true),
	actionGroups: array({ id: string(true), label: string(true), actions: array(ACTION, true) }),
	inputs: array(INPUT),
};
/** @type {Shape} */
const META = { title: string(true), viewType: string(), defaultModel: string(true), decisionFirstColumn: string() };
/** Sections only a panel with its own code (a template in Pollis) can use. */
const NEEDS_CODE = { notes: 'notes', explore: 'explore', 'meta.models': 'meta.models', 'meta.illusCollapsed': 'meta.illusCollapsed', 'meta.illustrationText': 'meta.illustrationText' };
const INPUT_KINDS = ['text', 'select', 'textarea', 'tabs'];

// --- The checks -----------------------------------------------------------------------------------

/** One panel TOML's problems. */
class Report {
	/** @param {string} file @param {Map<string, number>} lines */
	constructor(file, lines) {
		this.file = file;
		this.lines = lines;
		/** @type {{ line: number; message: string }[]} */
		this.errors = [];
		/** @type {{ line: number; message: string }[]} */
		this.warnings = [];
	}

	/** The line of a key path, or of its nearest parent with a line. @param {KeyPath} at */
	line(at) {
		for (let length = at.length; length > 0; length--) {
			const line = this.lines.get(at.slice(0, length).join('.'));
			if (line) {
				return line;
			}
		}
		return 1;
	}

	/** @param {KeyPath} at @param {string} message */
	error(at, message) {
		this.errors.push({ line: this.line(at), message: `${describe(at)}: ${message}` });
	}

	/** @param {KeyPath} at @param {string} message */
	warn(at, message) {
		this.warnings.push({ line: this.line(at), message: `${describe(at)}: ${message}` });
	}
}

/** A key path as TOML shows it: `[[inputs]] 4 (the 4th), when`. @param {KeyPath} at */
function describe(at) {
	return at.map((part, index) => typeof part === 'number' ? `#${part + 1}` : index ? `.${part}` : part).join('').replace(/\.?#/g, ' #') || 'the file';
}

/** @param {unknown} value @returns {value is Table} */
function isTable(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Check a table against its shape. @param {Report} report @param {KeyPath} at @param {unknown} value @param {Shape} shape */
function checkShape(report, at, value, shape) {
	if (!isTable(value)) {
		report.error(at, Array.isArray(value) ? `must be a table: write [${at.join('.')}], with one pair of brackets` : 'must be a table');
		return;
	}
	for (const [key, field] of Object.entries(shape)) {
		if (field.required && (value[key] === undefined)) {
			report.error(at, `needs ${key}`);
		}
	}
	for (const [key, item] of Object.entries(value)) {
		const field = shape[key];
		if (!field) {
			report.error([...at, key], `Pollis does not know ${key} here (it knows ${Object.keys(shape).join(', ')})`);
			continue;
		}
		checkField(report, [...at, key], item, field);
	}
}

/** @param {Report} report @param {KeyPath} at @param {unknown} value @param {Field} field */
function checkField(report, at, value, field) {
	switch (field.type) {
		case 'string':
		case 'number':
		case 'boolean':
			if (typeof value !== field.type) {
				report.error(at, `must be a ${field.type}, not ${JSON.stringify(value)}`);
			}
			break;
		case 'scalar':
			if (!['string', 'number', 'boolean'].includes(typeof value)) {
				report.error(at, `must be a string, number or boolean, not ${JSON.stringify(value)}`);
			}
			break;
		case 'strings':
			if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
				report.error(at, `must be a list of strings, like ["a", "b"]`);
			}
			break;
		case 'array':
			if (!Array.isArray(value)) {
				report.error(at, isTable(value) ? `[[${at.join('.')}.${Object.keys(value)[0]}]] needs a [[${at.join('.')}]] before it` : `must be an array of tables ([[${at.join('.')}]])`);
				break;
			}
			value.forEach((item, index) => checkShape(report, [...at, index], item, field.item));
			break;
		case 'table':
			checkShape(report, at, value, field.shape);
			break;
	}
}

/** @param {unknown} value @returns {Table[]} */
function tables(value) {
	return Array.isArray(value) ? value.filter(isTable) : [];
}

/** The `{{id}}` and `{{?id=a|b}}` placeholders of a code string. @param {string} code */
function placeholders(code) {
	return [...code.matchAll(/\{\{(?<guard>\?)?(?<not>!)?(?<id>[\w-]+)(?:(?<op>!?=)(?<values>[^}]*))?\}\}/g)].map(match => /** @type {{ guard?: string; id: string; op?: string; values?: string }} */(match.groups));
}

/**
 * Check a panel TOML.
 * @param {string} file @param {string} text the TOML
 * @param {Parser} parser
 * @param {{ wiki: string[]; notebooks: string[]; builtIn: Set<string> }} roots where the wiki and notebook files are looked for, and Pollis' own
 */
export function validate(file, text, parser, roots) {
	const { lines, misread } = lineIndex(text);
	const report = new Report(file, lines);
	for (const { line, message } of misread) {
		report.errors.push({ line, message });
	}
	/** @type {Table} */
	let data;
	try {
		data = parser.parseToml(text);
		parser.tomlToPanelData(data);
	} catch (error) {
		report.error([], `Pollis cannot read it: ${error instanceof Error ? error.message : String(error)}`);
		return report;
	}

	// The tables: every one Pollis knows, of the right shape
	for (const key of Object.keys(data)) {
		if (key in NEEDS_CODE) {
			report.error([key], `${key} needs a panel with its own code, which a toolbox cannot hold: remove it`);
		} else if (!(key in PANEL) && !['meta', 'miniCharts', 'wikis', 'references'].includes(key)) {
			report.error([key], `Pollis does not know the table ${key}`);
		}
	}
	const meta = isTable(data.meta) ? data.meta : undefined;
	if (!meta) {
		report.error(['meta'], 'the panel needs [meta] with title and defaultModel');
	} else {
		for (const key of ['models', 'illusCollapsed', 'illustrationText']) {
			if (key in meta) {
				report.error(['meta', key], `meta.${key} needs a panel with its own code, which a toolbox cannot hold: remove it`);
				delete meta[key];
			}
		}
		checkShape(report, ['meta'], meta, META);
	}
	for (const [key, field] of Object.entries(PANEL)) {
		if (data[key] === undefined) {
			if (field.required) {
				report.error([key], `the panel needs [[${key}]]`);
			}
		} else {
			checkField(report, [key], data[key], field);
		}
	}
	tables(data.wikis).forEach((wiki, index) => checkShape(report, ['wikis', index], wiki, wiki.separator ? SEPARATOR : WIKI));
	tables(data.references).forEach((reference, index) => checkShape(report, ['references', index], reference, reference.separator ? SEPARATOR : REFERENCE));
	if (data.wikis !== undefined && !Array.isArray(data.wikis)) {
		report.error(['wikis'], 'must be an array of tables ([[wikis]])');
	}
	if (data.references !== undefined && !Array.isArray(data.references)) {
		report.error(['references'], 'must be an array of tables ([[references]])');
	}

	// The models (tabs): the ids every other table names
	const models = tables(data.models);
	const modelIds = new Set(models.map(model => String(model.id)));
	duplicates(report, models, 'models', 'id', 'model');
	const defaultModel = typeof meta?.defaultModel === 'string' ? meta.defaultModel : undefined;
	if (defaultModel && models.length && !modelIds.has(defaultModel)) {
		report.error(['meta', 'defaultModel'], `"${defaultModel}" is not one of the models (${[...modelIds].join(', ')})`);
	}
	// A panel without [[models]] has one tab, its default model
	const known = models.length ? modelIds : new Set(defaultModel ? [defaultModel] : []);
	/** @param {KeyPath} at @param {unknown} list */
	const checkModels = (at, list) => {
		for (const model of Array.isArray(list) ? list : []) {
			if (!known.has(model)) {
				report.error(at, `the model "${model}" does not exist (the models: ${[...known].join(', ')})`);
			}
		}
	};
	if (isTable(data.miniCharts)) {
		for (const [model, chart] of Object.entries(data.miniCharts)) {
			checkModels(['miniCharts', model], [model]);
			checkShape(report, ['miniCharts', model], chart, { svg: string(true) });
		}
	} else if (data.miniCharts !== undefined) {
		report.error(['miniCharts'], 'must be tables, one per model: [miniCharts.<model>] with svg = "..."');
	}
	const branches = tables(data.codeBranches);
	branches.forEach((branch, index) => {
		if (branch.model !== '*') {
			checkModels(['codeBranches', index, 'model'], [branch.model]);
		}
	});
	duplicates(report, branches, 'codeBranches', 'model', 'code branch for the model');
	const covered = new Set(branches.map(branch => branch.model));
	if (!covered.has('*')) {
		for (const model of known) {
			if (!covered.has(model)) {
				report.error(['codeBranches'], `the model "${model}" has no code: add [[codeBranches]] with model = "${model}", or one with model = "*" for every model`);
			}
		}
	}

	// The inputs: ids, kinds, options and the ids their placeholders and conditions name
	const inputs = tables(data.inputs);
	duplicates(report, inputs, 'inputs', 'id', 'input');
	/** @type {Map<string, Table>} */
	const inputById = new Map(inputs.map(input => [String(input.id), input]));
	/** The values an input can take, or undefined when it is free text. @param {string} id */
	const choices = id => {
		const input = inputById.get(id);
		return input && (input.kind === 'select' || input.kind === 'tabs') ? tables(input.options).map(option => String(option.value)) : undefined;
	};
	/** @param {KeyPath} at @param {string} id @param {string} op @param {string} values */
	const checkCondition = (at, id, op, values) => {
		if (id === 'model') {
			checkModels(at, values.split('|'));
			return;
		}
		if (!inputById.has(id)) {
			report.error(at, `the input "${id}" does not exist`);
			return;
		}
		const allowed = choices(id);
		for (const value of allowed ? values.split('|') : []) {
			if (!allowed?.includes(value)) {
				report.error(at, `the input "${id}" has no choice "${value}" (its choices: ${allowed?.join(', ')}), so ${id}${op}${values} ${op === '=' ? 'never holds' : 'always holds'}`);
			}
		}
	};
	/** @param {KeyPath} at @param {unknown} when */
	const checkWhen = (at, when) => {
		if (typeof when !== 'string') {
			return;
		}
		for (const condition of when.split('&')) {
			const match = /^(?<id>[\w-]+)(?<op>!?=)(?<values>.*)$/.exec(condition);
			if (!match?.groups) {
				report.error(at, `"${condition}" is not a condition: write id=value, id!=value, id=a|b, and join several with &`);
			} else {
				checkCondition(at, match.groups.id, match.groups.op, match.groups.values);
			}
		}
	};
	/** @param {KeyPath} at @param {unknown} code */
	const checkCode = (at, code) => {
		if (typeof code !== 'string') {
			return;
		}
		for (const placeholder of placeholders(code)) {
			if (placeholder.guard && placeholder.op) {
				checkCondition(at, placeholder.id, placeholder.op, placeholder.values ?? '');
			} else if (placeholder.id !== 'model' && !inputById.has(placeholder.id)) {
				report.error(at, `{{${placeholder.id}}} names no input (the inputs: ${[...inputById.keys()].join(', ') || 'none'})`);
			}
		}
		checkContent(report, at, code, 'code');
	};
	inputs.forEach((input, index) => {
		const at = ['inputs', index];
		checkModels([...at, 'models'], input.models);
		checkWhen([...at, 'when'], input.when);
		const kind = input.kind ?? 'text';
		if (typeof kind === 'string' && !INPUT_KINDS.includes(kind)) {
			report.error([...at, 'kind'], `"${kind}" is not a kind of input (${INPUT_KINDS.join(', ')})`);
		}
		const options = tables(input.options);
		if ((kind === 'select' || kind === 'tabs') && !options.length) {
			report.error(at, `a ${kind} input needs [[inputs.options]]`);
		}
		if ((kind === 'text' || kind === 'textarea') && options.length) {
			report.error([...at, 'options'], `a ${kind} input has no options: set kind = "select"`);
		}
		// A value may come twice when each copy is limited to some models or conditions
		duplicates(report, options.map(option => option.models || option.when ? {} : option), [...at, 'options'], 'value', 'choice');
		options.forEach((option, optionIndex) => {
			checkModels([...at, 'options', optionIndex, 'models'], option.models);
			checkWhen([...at, 'options', optionIndex, 'when'], option.when);
			checkContent(report, [...at, 'options', optionIndex, 'label'], option.label, 'label');
		});
		if (options.length && input.default !== undefined && !options.some(option => option.value === input.default)) {
			report.error([...at, 'default'], `"${input.default}" is not one of the choices (${options.map(option => option.value).join(', ')})`);
		}
		checkContent(report, [...at, 'label'], input.label, 'label');
		checkContent(report, [...at, 'tooltip'], input.tooltip, 'label');
	});
	branches.forEach((branch, index) => checkCode(['codeBranches', index, 'code'], branch.code));

	// Next Steps
	const groups = tables(data.actionGroups);
	duplicates(report, groups, 'actionGroups', 'id', 'Next Steps group');
	groups.forEach((group, index) => {
		const actions = tables(group.actions);
		duplicates(report, actions, ['actionGroups', index, 'actions'], 'id', 'action');
		actions.forEach((action, actionIndex) => {
			const at = ['actionGroups', index, 'actions', actionIndex];
			checkModels([...at, 'models'], action.models);
			checkWhen([...at, 'when'], action.when);
			checkCode([...at, 'code'], action.code);
			checkContent(report, [...at, 'label'], action.label, 'label');
			checkContent(report, [...at, 'desc'], action.desc, 'label');
		});
	});

	// The text the panel shows
	tables(data.bullets).forEach((bullet, index) => {
		checkContent(report, ['bullets', index, 'text'], bullet.text, 'label');
		checkContent(report, ['bullets', index, 'detail'], bullet.detail, 'label');
	});
	tables(data.decisionRows).forEach((row, index) => {
		for (const key of ['task', 'context', 'purpose']) {
			checkContent(report, ['decisionRows', index, key], row[key], 'label');
		}
	});
	models.forEach((model, index) => checkContent(report, ['models', index, 'label'], model.label, 'label'));
	checkContent(report, ['meta', 'title'], meta?.title, 'label');

	// The wiki pages and notebooks: bundled ones are files that exist, the others are links
	/** @param {KeyPath} at @param {Table} entry @param {string[]} folders @param {string} kind */
	const checkMaterial = (at, entry, folders, kind) => {
		if (entry.bundled === false) {
			if (typeof entry.url !== 'string') {
				report.error(at, `a ${kind} with bundled = false needs url`);
			}
			return;
		}
		if (typeof entry.file !== 'string') {
			report.error(at, `a bundled ${kind} needs file = "<folder>/<file>"`);
			return;
		}
		if (entry.bundled === undefined) {
			report.error(at, 'needs bundled = true (a file shipped with the panel) or bundled = false with url');
		}
		const file = entry.file;
		if (!/^[\w.-]+\/[\w./-]+$/.test(file) || file.includes('..')) {
			report.error([...at, 'file'], `"${file}" must be <folder>/<file>, with no spaces`);
			return;
		}
		const found = folders.map(folder => path.join(folder, ...file.split('/'))).find(candidate => fs.existsSync(candidate));
		if (!found && roots.builtIn.has(file)) {
			return;
		}
		if (!found) {
			report.error([...at, 'file'], `${file} does not exist (looked in ${folders.map(folder => path.relative(process.cwd(), folder).startsWith('..') ? folder : path.relative(process.cwd(), folder) || '.').join(', ')}, and it is not a file of Pollis' own panels)`);
		} else if (file.endsWith('.ipynb')) {
			try {
				const notebook = JSON.parse(fs.readFileSync(found, 'utf-8'));
				if (!Array.isArray(notebook.cells)) {
					report.error([...at, 'file'], `${file} is not a Jupyter notebook (no cells)`);
				}
			} catch (error) {
				report.error([...at, 'file'], `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};
	tables(data.wikis).forEach((wiki, index) => {
		if (!wiki.separator) {
			checkMaterial(['wikis', index], wiki, roots.wiki, 'wiki page');
		}
	});
	tables(data.notebookSections).forEach((section, index) => tables(section.notebooks).forEach((notebook, notebookIndex) => checkMaterial(['notebookSections', index, 'notebooks', notebookIndex], notebook, roots.notebooks, 'notebook')));

	// What a good panel has
	if (!tables(data.wikis).some(wiki => !wiki.separator)) {
		report.warn(['wikis'], 'the panel has no wiki pages: add at least an overview and a decision guide');
	}
	if (!tables(data.notebookSections).some(section => tables(section.notebooks).length)) {
		report.warn(['notebookSections'], 'the panel has no notebook tutorial: add at least one');
	}
	if (!groups.length) {
		report.warn(['actionGroups'], 'the panel has no Next Steps');
	}
	return report;
}

/** Report the entries of a list that share an id. @param {Report} report @param {Table[]} list @param {KeyPath | string} at @param {string} key @param {string} what */
function duplicates(report, list, at, key, what) {
	const seen = new Set();
	list.forEach((item, index) => {
		if (item[key] === undefined) {
			return;
		}
		if (seen.has(item[key])) {
			report.error([...(Array.isArray(at) ? at : [at]), index, key], `a second ${what} "${item[key]}"`);
		}
		seen.add(item[key]);
	});
}

/**
 * The content rules of Pollis panels, as warnings.
 * @param {Report} report @param {KeyPath} at @param {unknown} text @param {'code' | 'label'} kind
 */
function checkContent(report, at, text, kind) {
	if (typeof text !== 'string') {
		return;
	}
	const greek = text.match(/[Ͱ-Ͽ]/g);
	if (greek) {
		report.warn(at, `literal Greek letters (${[...new Set(greek)].join(' ')}): ${kind === 'code' ? 'use ASCII names (mu_hat, sigma_hat), unless a package spells its own keyword that way' : 'use HTML entities (&#956; for mu)'}`);
	}
	if (kind === 'code') {
		if (/\bDataFrames?\b/.test(text)) {
			report.warn(at, 'uses DataFrames: use Tables.jl (columntable, Tables.matrix), unless a package takes only a DataFrame');
		}
		if (/\bZygote\b/.test(text)) {
			report.warn(at, 'uses Zygote: use Enzyme for reverse-mode AD');
		}
	} else if (/\(\s|\s\)/.test(text)) {
		report.warn(at, 'a space inside parentheses: write (x), not ( x )');
	}
}

// --- Main -----------------------------------------------------------------------------------------

async function main() {
	const args = process.argv.slice(2);
	/** @param {string} name */
	const option = name => {
		const index = args.indexOf(name);
		if (index < 0) {
			return undefined;
		}
		const value = args[index + 1];
		if (!value || value.startsWith('--')) {
			fail(`${name} needs a value`);
		}
		args.splice(index, 2);
		return value;
	};
	const source = new Source(option('--source') ?? DEFAULT_SOURCE);
	const wiki = option('--wiki');
	const notebooks = option('--notebooks');
	const quiet = args.includes('--quiet');
	const files = args.filter(arg => arg !== '--quiet');
	if (!files.length || files.some(file => file.startsWith('--'))) {
		fail('usage: node validatePanel.mjs <panel.toml>... [--wiki <dir>] [--notebooks <dir>] [--quiet] [--source <url or folder>]');
	}
	const parser = await source.parser();
	const builtIn = builtInFiles(await source.index());
	let errors = 0;
	let warnings = 0;
	for (const file of files) {
		if (!fs.existsSync(file)) {
			fail(`${file} does not exist`);
		}
		const roots = materialRoots(file);
		const report = validate(file, fs.readFileSync(file, 'utf-8'), parser, {
			wiki: wiki ? [path.resolve(wiki)] : roots.wiki,
			notebooks: notebooks ? [path.resolve(notebooks)] : roots.notebooks,
			builtIn,
		});
		const problems = sortedProblems(report);
		for (const problem of problems) {
			console.log(`${file}:${problem.line}: ${problem.kind}: ${problem.message}`);
		}
		if (!quiet || problems.length) {
			console.log(`${file}: ${report.errors.length ? `${report.errors.length} errors` : 'valid'}${report.warnings.length ? `, ${report.warnings.length} warnings` : ''}`);
		}
		errors += report.errors.length;
		warnings += report.warnings.length;
	}
	if (files.length > 1) {
		console.log(`\n${files.length} panels: ${errors} errors, ${warnings} warnings`);
	}
	process.exitCode = errors ? 1 : 0;
}

/**
 * A report's errors and warnings, by line.
 * @param {Report} report @returns {{ line: number; message: string; kind: 'error' | 'warning' }[]}
 */
export function sortedProblems(report) {
	return [...report.errors.map(problem => ({ ...problem, kind: /** @type {const} */ ('error') })), ...report.warnings.map(problem => ({ ...problem, kind: /** @type {const} */ ('warning') }))].sort((a, b) => a.line - b.line);
}

// Run from the command line, not when the builder imports validate()
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(error => {
		console.error(`Error: ${error instanceof UserError ? error.message : error instanceof Error ? error.stack : String(error)}`);
		process.exitCode = 1;
	});
}
