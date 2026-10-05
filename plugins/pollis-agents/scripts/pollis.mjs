/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Antonio Saragga Seabra
 *  Licensed under the GNU Affero General Public License v3.0 or later. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// Pollis' files, for the scripts of this plugin: read from the public Pollis repository,
// https://raw.githubusercontent.com/saragga/pollis/main/, or from a local copy of it (--source).
//   build/pollis/panel-index.json   every menu entry of Pollis and the panel it opens, written by
//                                   build/pollis/makePanelIndex.ts
//   build/pollis/pollisToml.mjs     Pollis' panel TOML parser as plain JavaScript, written by
//                                   build/pollis/makePollisToml.ts, so a panel is read exactly as
//                                   Pollis reads it

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/saragga/pollis/main/';
const INDEX_PATH = 'build/pollis/panel-index.json';
const PARSER_PATH = 'build/pollis/pollisToml.mjs';

/**
 * @typedef {{ [key: string]: unknown }} Table
 * @typedef {{ id: string; model?: string; menuTitles: string[] }} IndexCommand
 * @typedef {{ id: string; title?: string; source: string; commands: IndexCommand[]; portable: boolean; reason?: string;
 *   defaultModel?: string; decisionFirstColumn?: string; toml?: string; wikiRoot?: string; notebookRoot?: string;
 *   wikis?: string[]; notebooks?: string[]; packages?: string[] }} IndexPanel
 * @typedef {{ version: number; icon: string; menus: { topLevel: string[]; submenus: string[] }; panels: IndexPanel[] }} PanelIndex
 * @typedef {{ parseToml: (text: string) => Table; tomlToPanelData: (data: Table) => Table }} Parser
 */

/** An error in what the user gave: printed without a stack. */
export class UserError extends Error { }

/** @param {string} message @returns {never} */
export function fail(message) {
	throw new UserError(message);
}

/** Pollis' files, from a URL (the public repository by default) or a local copy of the repository. */
export class Source {
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

	/** The panel index. @returns {Promise<PanelIndex>} */
	async index() {
		const index = JSON.parse((await this.read(INDEX_PATH)).toString('utf-8'));
		if (index.version !== 1 || !Array.isArray(index.panels)) {
			fail(`${INDEX_PATH} has a format this script does not know: update the Pollis Agents plugin`);
		}
		return index;
	}

	/** Pollis' panel TOML parser. @returns {Promise<Parser>} */
	async parser() {
		if (this.local) {
			return import(pathToFileURL(path.join(this.location, ...PARSER_PATH.split('/'))).href);
		}
		// A module downloaded at run time is imported from a temporary file, removed straight after
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pollis-toml-'));
		const file = path.join(folder, 'pollisToml.mjs');
		try {
			fs.writeFileSync(file, await this.read(PARSER_PATH));
			return await import(pathToFileURL(file).href);
		} finally {
			fs.rmSync(folder, { recursive: true, force: true });
		}
	}
}

/**
 * The folders a panel's wiki and notebook files are looked for in: `wiki/` and `notebooks/` next
 * to its TOML, or one folder up (a toolbox's `panels/` folder), the first that exists.
 * @param {string} tomlFile
 */
export function materialRoots(tomlFile) {
	const dir = path.dirname(path.resolve(tomlFile));
	return {
		wiki: [path.join(dir, 'wiki'), path.join(dir, '..', 'wiki')],
		notebooks: [path.join(dir, 'notebooks'), path.join(dir, '..', 'notebooks')],
	};
}
