# Pollis Plugins

Agent plugins for [Pollis](https://github.com/saragga/pollis), the desktop environment for statistical modelling, simulation and optimisation built on Code - OSS and Julia.

This repository is a plugin marketplace (`.claude-plugin/marketplace.json`). Pollis lists it by default in its `chat.plugins.marketplaces` setting, so its plugins appear in the **Agent Plugins** section of the Extensions pane, ready to install.

| Plugin | What it does |
|---|---|
| [pollis-extension-agent](plugins/pollis-extension-agent/README.md) | Builds your own Pollis toolbox from the panels you pick, in the menus and order you want, as a `.vsix` to install or share (for example, one toolbox per course). |

## For developers

The plugins read Pollis' panels from the public Pollis repository, `saragga/pollis` on `main`: the Extension Agent's builder (`plugins/pollis-extension-agent/scripts/makeToolbox.mjs`) first reads the panel index, `build/pollis/panel-index.json`, written there by `node build/pollis/makePanelIndex.ts`. A change to the index format there needs the matching change to the builder here.

The plugins need only Node.js 22 or later on the user's computer: no npm packages.

## License

AGPL-3.0-or-later, see [LICENSE.txt](LICENSE.txt).
