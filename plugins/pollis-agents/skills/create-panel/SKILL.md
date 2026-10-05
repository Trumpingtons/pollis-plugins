---
name: create-panel
description: "Create a new Pollis panel on a topic the user chooses: write its panel TOML (models, key points, decision table, inputs, example code, Next Steps, references), its wiki pages and notebook tutorials, check it with the validator, and package it as a toolbox. Triggers include 'create a panel', 'make a new panel on', 'write a Pollis panel for', 'Panel Agent', 'add a panel about', 'I want a panel for my course on'."
---

# Create a Panel

Writes a new Pollis panel from what the user tells you: a topic, the models or methods to cover, the Julia packages to use. A panel is one TOML file plus its wiki pages and notebook tutorials. Pollis draws every panel from the same scaffold, so the TOML only says what goes in it. The new panel reaches Pollis inside a toolbox (a `.vsix` file), which the `package-toolbox` skill builds.

Two files of this plugin do the mechanical work:

- `reference.md`, next to this SKILL.md: the panel format, every section with an example, the wiki and notebook formats, the content rules, and the Pollis panels to copy the shape of. **Read it before writing anything.**
- `validatePanel.mjs`, in the `scripts` folder of this plugin: two folders up from this SKILL.md, then `scripts/` (this file is `<plugin>/skills/create-panel/SKILL.md`). It checks a panel with Pollis' own parser, downloaded from the public Pollis repository. Use its absolute path, quoted.

It needs Node.js 22 or later (`node --version`) and the internet; if Node is missing or older, tell the user to install it from nodejs.org and stop.

## 1. Ask

Ask in one message, and wait for the answers:

- the topic, and who the panel is for (a course, a research group, the user's own work);
- the models or methods it covers: they become the tabs of the panel (one to eight);
- the Julia packages to use, if the user has a preference;
- the folder to write it in (default: a new folder `pollis-panels/` in the current directory);
- whether it goes into a new toolbox or an existing toolbox spec.

Then propose, in a short list: the panel id (lower case letters, digits and hyphens, short: `garch`, `survival`), its title, the model ids and labels, the inputs of each model, and the Next Steps. Go on when the user agrees.

## 2. Write

Pick the model panel closest to the new one (the table at the end of `reference.md`), download its TOML, and follow its shape. Write, in the chosen folder:

```
<id>.toml
wiki/<id>/factsheet.md, overview.md, assumptions.md, diagnostics.md, interpretation.md, decision-guide.md
wiki/<id>/<model>.md                  one page per model
notebooks/<id>/tutorial-01-<topic>.ipynb   at least one
```

- **The Example Code** of every model runs as it is: simulated data with a fixed seed, or a dataset from PollisDatasets.jl. Use the packages' current API: read their documentation when unsure, never guess a function name or a keyword.
- **The Next Steps** go in the order Visualise, Diagnose, Predict, Compare, Interpret, and use the variables of the Example Code.
- **The wiki pages** are general reference: the method, its equations, assumptions and pitfalls, never the panel's example data. Each ends with `## See Also`.
- **The notebooks** walk through an example step by step, with Markdown cells between the code cells, and no outputs.
- **References**: only real papers and books, with their real details. If unsure of one, leave it out.

Follow the content rules of `reference.md` throughout.

## 3. Check

```
node "<plugin>/scripts/validatePanel.mjs" "<folder>/<id>.toml"
```

It finds the wiki and notebook files in `wiki/` and `notebooks/` next to the TOML. Fix every error and run it again until it reports none. Fix the warnings too, unless one is intended (say why in your report).

## 4. Run

If Julia is installed (`julia --version`), run every model's Example Code and its Next Steps in a temporary environment:

1. For each model, write the code Pollis would show: the code branch for that model, with the guards resolved for the default input values and each `{{id}}` replaced by its default. Append the actions of that model.
2. Run it with `julia --project=<temporary folder>` after `Pkg.add` of the panel's packages (and `[requires]`). Plots can be saved instead of displayed: set `ENV["GKSwstype"] = "100"`.
3. Fix any error in the TOML, and run the validator again.

The first run installs and compiles the packages: tell the user it can take several minutes. If Julia is missing, say that the code was not run.

## 5. Package

Hand over to the `package-toolbox` skill: in its spec, a panel of the user's own is a `[[menu.items]]` entry with `toml` instead of `command`:

```toml
[[menu.items]]
toml = "pollis-panels/garch.toml"     # relative to the spec
title = "GARCH Models"                # optional menu title, default: the panel's title
```

The builder copies the panel's wiki and notebook folders with it. A toolbox can mix new panels and Pollis' own.

## 6. Report

Tell the user, briefly:

- the files written;
- the validator's result, and whether the code ran in Julia (and with which package versions);
- the `.vsix` file, and how to install it: **Extensions: Install from VSIX...** in Pollis;
- anything left out or unsure: a reference you could not confirm, a model whose package does not run.
