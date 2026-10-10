---
name: create-panel
description: "Create a new Pollis panel on a topic the user chooses: write its panel TOML (models, key points, decision table, inputs, example code, Next Steps, references), its wiki pages and notebook tutorials, check it with the validator, and package it as a toolbox. Triggers include 'create a panel', 'make a new panel on', 'write a Pollis panel for', 'Panel Agent', 'add a panel about', 'I want a panel for my course on', 'create the panels of this request', 'run my panel request'."
---

# Create a Panel

Writes a new Pollis panel from what the user tells you: a topic, the models or methods to cover, the Julia packages to use. A panel is one TOML file plus its wiki pages and notebook tutorials. Pollis draws every panel from the same scaffold, so the TOML only says what goes in it. The new panel reaches Pollis inside a toolbox (a `.vsix` file), which the `package-toolbox` skill builds.

Two files of this plugin do the mechanical work:

- `reference.md`, next to this SKILL.md: the panel format, every section with an example, the wiki and notebook formats, the content rules, and the Pollis panels to copy the shape of. **Read it before writing anything.**
- `validatePanel.mjs`, in the `scripts` folder of this plugin: two folders up from this SKILL.md, then `scripts/` (this file is `<plugin>/skills/create-panel/SKILL.md`). It checks a panel with Pollis' own parser, downloaded from the public Pollis repository. Use its absolute path, quoted.

It needs Node.js 22 or later (`node --version`) and the internet; if Node is missing or older, tell the user to install it from nodejs.org and stop.

There are two ways to work:

- **From a request file**, when the user names one (`.jl` or `.toml`) or asks to create the panels of a request: no questions, every panel it asks for, one toolbox. Go to *1b*.
- **By interview**, otherwise: go to *1a*. Mention once, at the start, that a request file can do it without questions (*1b*).

## 1a. Ask

Ask in one message, and wait for the answers:

- the topic, and who the panel is for (a course, a research group, the user's own work);
- the models or methods it covers: they become the tabs of the panel (one to eight);
- the Julia packages to use, if the user has a preference;
- the folder to write it in (default: a new folder `pollis-panels/` in the current directory);
- whether it goes into a new toolbox or an existing toolbox spec.

Then propose, in a short list: the panel id (lower case letters, digits and hyphens, short: `garch`, `survival`), its title, the model ids and labels, the inputs of each model, and the Next Steps. Go on when the user agrees.

## 1b. Read the request

A request file says, for each panel, only what the user decides; you decide the rest. It is Julia, so it can loop over topics and branch on the audience:

```julia
toolbox(name = "pollis-toolbox-npreg", displayName = "Nonparametric Regression", author = "Ana Silva")

audience = "students"
for (topic, methods) in [
        "Scatterplot smoothing" => ["LOESS", "Smoothing splines", "Linear regression"],
        "Kernel density estimation" => ["Gaussian kernel", "Epanechnikov kernel"]]
    panel(topic = topic, audience = audience, methods = methods,
          menu = "Model > Nonparametric Regression")
end
```

- `toolbox` (once): `name` (`pollis-toolbox-...`), `displayName`, and optional `description`, `author`, `version`.
- `panel` (once per panel): `topic`, `methods` (1 to 8: the tabs), and optional `audience`, `packages`, `menu`, `title`, `id`, `notes`. `menu` is a top menu (Compose, Explore, Model, Simulate, Optimise) or a submenu id, then optionally `>` and the title of a submenu; default `Compose > <displayName>`. `notes` is anything else the user wants, in their words.

Never interpret the Julia yourself: run it with `readRequest.jl`, in the same `scripts` folder:

```
julia "<plugin>/scripts/readRequest.jl" "<request>.jl"
```

It runs the file and writes `<request>.request.toml` next to it: the toolbox and the list of panels, loops and conditions resolved (a `.toml` request, the same fields as `[toolbox]` and `[[panel]]` tables, is only checked). On a `Request error`, tell the user the message and stop. If Julia is missing, a `.jl` request cannot be read: say so, and offer the interview or a `.toml` request.

Then, without asking:

- **Write the panels one at a time**, in the order of the list: steps 2, 3 and 4 for each, before the next. Say one line as each starts and ends (`2 of 5: Kernel density estimation, valid, code ran`).
- **Make the choices of 1a yourself**: the id (the request's `id`, or a short one from the topic), the title (the request's `title`, or one from the topic), the model ids and labels from `methods`, the inputs, the Next Steps. Use the request's `packages` when given, otherwise the packages you would propose.
- **Fit the panel to the audience**: for `students` (or a course), plain key points, few inputs with defaults that work, wiki pages that explain from first principles, a notebook that goes slowly; for `research` (or researchers), more options and diagnostics, the primary papers in the references; anything else, read it as the user's description of who will use the panel. With no audience, write for a general user of Pollis.
- **When a panel cannot be written** (no working Julia package for a method, the validator or Julia still failing after you fixed what you could), leave it out, say why in the report, and go on with the next.
- **Pick up where a run stopped**: a long request can outlast one session. Before writing a panel, look in `pollis-panels/` for its TOML, which you start with the comment line `# Request topic: <topic>`: if it is there and the validator reports no errors, keep it and go on to the next. Tell the user how many panels were already done.
- Write the panels in a folder `pollis-panels/` next to the request file, and the toolbox spec next to the request file, as `<toolbox name>.toml`.

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

From a request, write the spec yourself and build it without asking: `[extension]` from `toolbox`; one `[[menu]]` per distinct `menu` of the panels, in the order they first appear (`menu` is the part before `>`, `title` the part after, `id` a short id from that title; a `menu` with no `>` is `inline = true` in that menu), and its panels as `[[menu.items]]` in the request's order. Then finish the README and pack, as the `package-toolbox` skill says.

## 6. Report

Tell the user, briefly (from a request, one table: panel, validator, code run, left out and why):

- the files written;
- the validator's result, and whether the code ran in Julia (and with which package versions);
- the `.vsix` file, and how to install it: **Extensions: Install from VSIX...** in Pollis;
- anything left out or unsure: a reference you could not confirm, a model whose package does not run.
