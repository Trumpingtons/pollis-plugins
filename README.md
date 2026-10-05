# Pollis Plugins

Agent plugins for [Pollis](https://github.com/saragga/pollis), the desktop environment for statistical modelling, simulation and optimisation built on Code - OSS and Julia.

This repository is a plugin marketplace (`.claude-plugin/marketplace.json`). Pollis lists it by default in its `chat.plugins.marketplaces` setting, so its plugins appear in the **Agent Plugins** section of the Extensions pane, ready to install.

| Plugin | What it does |
|---|---|
| [pollis-agents](plugins/pollis-agents/README.md) | Builds your own Pollis toolbox from the panels you pick, in the menus and order you want, as a `.vsix` to install or share (for example, one toolbox per course), and creates new panels on topics Pollis does not cover. |

## For developers

The plugins read Pollis' panels from the public Pollis repository, `saragga/pollis` on `main`. The scripts of Pollis Agents (`plugins/pollis-agents/scripts/`) download two generated files from there:

- the panel index, `build/pollis/panel-index.json`, written by `node build/pollis/makePanelIndex.ts`;
- Pollis' panel TOML parser as plain JavaScript, `build/pollis/pollisToml.mjs`, written by `node build/pollis/makePollisToml.ts`, so the validator and the builder read a panel exactly as Pollis does.

A change to the index format there needs the matching change to the scripts here.

The plugins need only Node.js 22 or later on the user's computer: no npm packages.

## License

AGPL-3.0-or-later, see [LICENSE.txt](LICENSE.txt).
