# Pollis Agents

An agent plugin for Pollis with two skills:

- **Package a toolbox**: you pick Pollis panels, put them in the menus and the order you want, and get a `.vsix` file to install in Pollis or to share. A teacher, for example, packages the panels of a course as one toolbox, in their own menu and order, and gives the file to their students.
- **Create a panel**: you describe a topic Pollis does not cover, and the agent writes a new panel for it, with its wiki pages and notebook tutorials, checks it, and packages it in a toolbox.

Each panel in the toolbox is an independent copy of the Pollis panel, with its key points, decision table, example code, Next Steps, wikis and notebook tutorials. It has its own editor tab and its own wiki and notebook folders, so Pollis' own panels stay as they are.

## Install the plugin

In Pollis, open the Extensions pane, find the **Agent Plugins** section (or type `@agentPlugins` in the search box), and install **pollis-agents** (from the `Trumpingtons/pollis-plugins` marketplace). The plugin needs Node.js 22 or later on your computer, and the internet: it reads the panels from the public Pollis repository.

## Build a toolbox

Ask the chat agent, for example:

> Make a toolbox called "Statistics 101" with Linear Regression, Generalized Linear Models and Hypothesis Tests, in that order, in a submenu of the Model menu.

The agent finds the panels, writes a spec like the one below, shows it to you, builds the toolbox, writes its README with you and packages it.

```toml
[extension]
name = "pollis-toolbox-stats101"
displayName = "Statistics 101"
description = "The panels of the Statistics 101 course: regression, generalized linear models and hypothesis tests."

[[menu]]
id = "stats101"
title = "Statistics 101"
menu = "Model"

[[menu.items]]
command = "chiara.statistics.lm"
title = "1. Linear Regression"

[[menu.items]]
panel = "glm"
title = "2. Generalized Linear Models"

[[menu.items]]
panel = "ht"
title = "3. Hypothesis Tests"
```

`menu` is Toolboxes, Explore, Model, Simulate, Optimise or the id of a submenu; `inline = true` puts the entries straight into that menu instead of a submenu of their own. The full format is at the top of `scripts/makeToolbox.mjs`.

You can also run the builder yourself:

```
node scripts/makeToolbox.mjs list regression          # find panels and their commands
node scripts/makeToolbox.mjs build stats101.toml      # writes pollis-toolbox-stats101/ and pollis-toolbox-stats101-1.0.0.vsix
node scripts/makeToolbox.mjs pack pollis-toolbox-stats101   # package again after editing its README
```

## Create a panel

Ask the chat agent, for example:

> Create a panel on GARCH volatility models, with GARCH, EGARCH and GJR-GARCH, for my financial econometrics course.

The agent asks what the panel covers, proposes its models, inputs and Next Steps, and then writes, in a folder you choose:

```
garch.toml                   the panel: models, key points, decision table, inputs, example code, Next Steps, references
wiki/garch/                  the wiki pages: factsheet, overview, assumptions, diagnostics, interpretation, decision guide, one page per model
notebooks/garch/             the notebook tutorials
```

It checks the panel with the validator, which reads it with Pollis' own parser, runs its example code in Julia when Julia is installed, and packages it as a toolbox: in the spec, the panel is an entry with `toml` instead of `command`.

```toml
[[menu.items]]
toml = "garch.toml"
title = "GARCH Models"
```

A toolbox can mix new panels and Pollis' own. You can also check a panel you wrote yourself:

```
node scripts/validatePanel.mjs garch.toml
```

The panel format is described in `skills/create-panel/reference.md`. A panel has no code of its own: it cannot have custom illustrations, styles or data connectors.

## Install the toolbox

In Pollis, run **Extensions: Install from VSIX...** from the Command Palette and pick the `.vsix` file. The toolbox's menu appears at once. Students install the file their teacher gives them the same way. To update a toolbox, raise `version` in the spec, build it again and install the new file; to remove it, uninstall it in the Extensions pane.

Panels that have their own code (the data connectors to Excel workbooks, the European Central Bank, Alpha Vantage, Yahoo Finance, FRED, EDGAR, Hugging Face and Kaggle) and the galleries cannot go in a toolbox.

## License

AGPL-3.0-or-later.
