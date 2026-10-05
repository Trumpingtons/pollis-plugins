# The Pollis Panel Format

A Pollis panel is one TOML file, plus its wiki pages (Markdown) and notebook tutorials (Jupyter). Pollis draws every panel from the same scaffold: the TOML only says what goes in it. This page describes every section a panel can use, with a short example of each, taken from Pollis' own panels.

## Contents

- [The layout of a panel](#the-layout-of-a-panel)
- [The files](#the-files)
- [TOML as Pollis reads it](#toml-as-pollis-reads-it)
- The sections: [meta](#meta), [packages](#packages), [requires](#requires), [models](#models), [bullets](#bullets), [decisionRows](#decisionrows), [miniCharts](#minicharts), [inputs](#inputs), [codeBranches](#codebranches), [placeholders and guards](#placeholders-and-guards), [actionGroups](#actiongroups), [wikis](#wikis), [notebookSections](#notebooksections), [references](#references)
- [Content rules](#content-rules)
- [What a toolbox panel cannot do](#what-a-toolbox-panel-cannot-do)
- [Model panels](#model-panels)

## The layout of a panel

From top to bottom, a panel shows:

| Area | From |
|---|---|
| Title | `[meta] title` |
| Model toggle: one tab per model | `[[models]]` |
| Illustration: a small drawing per model | `[miniCharts.<model>]` |
| Key Points: a bullet list | `[[bullets]]` |
| Decision table: which model for which task | `[[decisionRows]]` |
| Inputs: text fields, choices, sub-tabs | `[[inputs]]` |
| Example Code: the code of the current model, with the inputs filled in | `[[codeBranches]]` |
| Next Steps: Visualise, Diagnose, Predict, Compare, Interpret | `[[actionGroups]]` |
| Powered by: the Julia packages, with install status | `[[packages]]`, `[requires]` |
| Learn More: wiki pages, notebook tutorials, references, videos | `[[wikis]]`, `[[notebookSections]]`, `[[references]]`, `[[packages.videos]]` |

The user picks a model and sets the inputs. The Example Code updates at once, and they send it to the Julia REPL, a notebook, the terminal or an editor. A Next Steps action runs after the Example Code in the same Julia session, so it can use the variables the Example Code defined (for example `model`).

## The files

A new panel, with the id `<id>`, is a folder like this:

```
<id>.toml
wiki/<id>/factsheet.md, overview.md, assumptions.md, diagnostics.md, interpretation.md, decision-guide.md
wiki/<id>/<one page per model>.md
notebooks/<id>/tutorial-01-<topic>.ipynb, tutorial-02-...
```

The TOML names each wiki page and notebook by its path below `wiki/` or `notebooks/`, starting with the folder: `file = "<id>/overview.md"`. Use lower case letters, digits and hyphens in ids, folder and file names.

## TOML as Pollis reads it

Pollis reads a subset of TOML. Keep to it, or a value is read as plain text:

- `[table]`, `[[array.of.tables]]` and nested arrays of tables: `[[actionGroups.actions]]` belongs to the `[[actionGroups]]` above it.
- Strings: `"double"` (with `\"` and `\n` escapes) or `'single'` (literal). Multi-line strings: `'''...'''`, literal, used for all code.
- Numbers (`3`, `-0.5`; no exponents or underscores), `true` and `false`.
- Arrays **on one line** (no inline tables `{...}`): `models = ["ols", "wls"]`. An array that runs over several lines is not read as an array.
- Comments start with `#`, **on a line of their own**. A comment after a value or a header is read as part of it: `n = 3  # rows` gives the text `3  # rows`, and `[[models]]  # first` is skipped. Inside a `'''` string, a comment is part of the code and is fine.
- A multi-line string starts with `'''` alone after the `=`, and ends with `'''` alone on a line, at its start.

Run the validator after every change: it uses Pollis' own parser.

## meta

```toml
[meta]
title = "Linear Regression"
# the model shown first: one of the [[models]] ids
defaultModel = "standard"
# optional: the header of the decision table's first column (default "Model")
decisionFirstColumn = "Estimator"
```

`title` and `defaultModel` are required. `viewType` appears in Pollis' own panels and is not needed.

## packages

The Julia packages the panel uses, shown on the Powered by line. Pollis offers to install the missing ones.

```toml
[[packages]]
name = "GLM.jl"
github = "https://github.com/JuliaStats/GLM.jl"

# optional: tutorial videos about this package
[[packages.videos]]
title = "GLM.jl Tutorial"
description = "Fitting and reading generalized linear models"
url = "https://www.youtube.com/watch?v=..."
```

`name` and `github` are required. `fork = true` installs the package from `github` instead of the Julia registry. Use it only for a package that is not registered.

## requires

Further packages the code uses, beyond `[[packages]]`, for the install status only (Plots.jl, Distributions.jl, ...):

```toml
[requires]
packages = ["GLM.jl", "Plots.jl", "Distributions.jl"]
```

## models

The tabs of the model toggle. Each model has its own Example Code, and can have its own inputs and Next Steps.

```toml
[[models]]
id = "standard"
label = "Standard"

[[models]]
id = "hc"
label = "HC0-HC3"
```

A panel without `[[models]]` has one tab: `meta.defaultModel` names it.

## bullets

The Key Points: a short list, one bullet per idea.

```toml
[[bullets]]
text = "OLS"
detail = "Ordinary Least-Squares: minimise the sum of squared residuals with equal weight on every observation"
```

Text is HTML: use entities for special characters (`&#8211;` for an en dash, `&#956;` for mu).

## decisionRows

The decision table: which model fits which task.

```toml
[[decisionRows]]
# the first column (meta.decisionFirstColumn)
task = "OLS + HC0-HC3"
# Structure
context = "Heteroskedastic errors"
# Use when
purpose = "Keep OLS estimates but make standard errors valid under unknown heteroskedasticity"
```

## miniCharts

A small drawing of each model, in a 54 by 86 box. The value is the body of a JavaScript function that returns SVG elements as a string. Draw with `currentColor` so it follows the theme.

```toml
[miniCharts.gf]
svg = '''
return '<path d="M8,64 L44,58 L20,26 Z" fill="none" stroke="currentColor" stroke-width="1" opacity="0.5"/>'
  + '<circle cx="34" cy="40" r="2" fill="currentColor"/>';
'''
```

Optional. Give every model one, or none.

## inputs

The settings the user can change. Their values fill the `{{id}}` placeholders of the code.

```toml
[[inputs]]
id = "x0"
label = "Initial Guess x0"
tooltip = "Starting point as a Julia vector, for example [-1.2, 1.0]."
default = "[-1.2, 1.0]"

[[inputs]]
id = "gfalgo"
label = "Algorithm"
kind = "select"
# one of the option values
default = "NelderMead"
# shown only for these models
models = ["gf"]
# start a new row of inputs
newRow = true

[[inputs.options]]
value = "NelderMead"
label = "Nelder-Mead"

[[inputs.options]]
value = "ParticleSwarm"
label = "Particle Swarm"
```

| Field | Meaning |
|---|---|
| `id`, `label` | required; `id` is what `{{id}}` names |
| `kind` | `text` (default), `select` (a drop-down list), `textarea` (several lines, one code line each), `tabs` (sub-tabs inside a model) |
| `default` | the starting value; for `select` and `tabs`, one of the option values |
| `tooltip` | the help shown on hover |
| `models` | the models that show the input (default: all) |
| `when` | a condition on other inputs: `"dim=uni"`, `"method!=quantile"`, `"family=a\|b"`, several joined by `&` |
| `newRow` | `true` starts a new row |
| `[[inputs.options]]` | for `select` and `tabs`: `value`, `label`, and optionally `models` and `when` per option |

An option value may appear twice only when each copy has its own `models` or `when` (the same choice, labelled differently per model).

## codeBranches

The Example Code. One branch per model, or one branch for all models with `model = "*"` and guards.

```toml
[[codeBranches]]
model = "*"
code = '''
{{?model=standard}}using GLM, Random
{{?model=hc}}using Regress, Random

rng = Xoshiro(42);  # fixed seed: the same data on every run
n  = {{n}};
x1 = randn(rng, n);
y  = 1.0 .+ 2.0 .* x1 .+ randn(rng, n);
data = (; y, x1);  # a named tuple of columns is a Tables.jl table

{{?model=standard}}model = lm(@formula(y ~ x1), data);
{{?model=hc}}model = Regress.ols(data, @formula(y ~ x1)) + vcov(HC3());

display(coeftable(model))
'''
```

Every model needs code: either its own branch or the `"*"` branch.

## Placeholders and guards

In any code (branches and actions):

- `{{id}}` is replaced by the value of the input `id`. `{{model}}` is the current model id.
- A line starting with `{{?id=a|b}}` is shown only when the input `id` is `a` or `b`. `{{?id!=a|b}}` shows it otherwise. `{{?model=hc}}` tests the model. Several guards at the start of a line must all hold.

The validator checks that every placeholder names an input or `model`, and that every value a guard tests is one of that input's choices.

## actionGroups

The Next Steps, in this order of groups: Visualise, Diagnose, Predict, Compare, Interpret (use only the groups the panel needs).

```toml
[[actionGroups]]
id = "visualise"
label = "Visualise"

[[actionGroups.actions]]
id = "fitted-observed"
label = "Fitted vs Observed"
desc = "Fitted values against the observed response"
# optional: only for these models
models = ["standard", "hc"]
# optional: only while this condition holds
when = "se=classic"
code = '''
using Plots

yhat = fitted(model);
scatter(yhat, response(model), xlabel="Fitted", ylabel="Observed", label=false)
'''
```

The group ids are `visualise`, `diagnose`, `predict`, `compare` and `interpret`. An action runs after the Example Code, so it uses its variables. A Compare action must compare two or more things (models, methods, settings), not report one model's statistic.

## wikis

The wiki pages, in the order shown. A Model, Simulate or Optimise panel has these six first, in this order, then one page per model after a separator:

```toml
[[wikis]]
name = "Factsheet"
file = "trad/factsheet.md"
bundled = true
# optional
description = "One-page reference: equations, key settings, packages"

[[wikis]]
name = "Overview"
file = "trad/overview.md"
bundled = true

# ... Assumptions (assumptions.md), Diagnostics (diagnostics.md),
#     Interpretation (interpretation.md), Decision Guide (decision-guide.md)

[[wikis]]
separator = true
label = "Models"

[[wikis]]
name = "Trading Agents"
file = "trad/trading-agents.md"
bundled = true
```

A page on the web instead of a file: `bundled = false` and `url = "https://..."`. Wiki pages are Markdown with `$...$` and `$$...$$` math. They are general reference: they never use the panel's example data. End each page with a `## See Also` list of links to the other pages.

## notebookSections

The notebook tutorials, in sections:

```toml
[[notebookSections]]
# a section title, or "" for none
label = ""

[[notebookSections.notebooks]]
name = "Grid Space: Schelling Segregation"
file = "abm/tutorial-01-grid.ipynb"
bundled = true
description = "Build the Schelling segregation model on a 2-D grid"
```

A notebook is a Jupyter `.ipynb` file with the Julia kernel:

```json
{"metadata": {"kernelspec": {"display_name": "Julia", "language": "julia", "name": "julia"}, "language_info": {"name": "julia"}},
 "nbformat": 4, "nbformat_minor": 5, "cells": [...]}
```

Ship notebooks without outputs. They are rebuilt when the user runs them, and outputs make the file many times larger. The notebooks are where the example data is walked through, step by step.

## references

The papers and software behind the panel, in groups:

```toml
[[references]]
separator = true
label = "Software"

[[references]]
title = "Julia: A Fresh Approach to Numerical Computing"
authors = "Bezanson, Jeff; Edelman, Alan; Karpinski, Stefan; Shah, Viral B."
year = 2017
journal = "SIAM Review"
doi = "10.1137/141000671"
openAccess = false
```

`title`, `authors` and `year` (a number) are required. Give a `doi` or a `url` when there is one. Never invent a reference: give only papers you are sure exist, with their real details.

## Content rules

- **Self-contained examples.** Every Example Code and action runs as it is: it simulates its data (with a fixed seed), or loads a real dataset from PollisDatasets.jl (`using PollisDatasets; dataset("produc")`). It never reads a file the user does not have.
- **No DataFrames.jl.** Use Tables.jl: a named tuple of columns is a table; `Tables.columntable`, `Tables.matrix`. The exception is a package that accepts only a DataFrame.
- **Reverse-mode automatic differentiation: Enzyme**, not Zygote.
- **No literal Greek letters** in code or labels. In code, use ASCII names (`mu_hat`, `sigma_hat`), except a package's own keyword spelled in Greek. In labels and text, use HTML entities (`&#956;`, `&#963;`).
- **Labels**: `(x)`, never `( x )`. Title-style capitals for labels.
- **Matrix transpose**: `transpose(A)`, never `A'` (the quote breaks the code strings).
- **Plots**: end a plotting example with the figure itself, or `display(fig)` when the last line is an assignment.
- **Comments**: short end-of-line comments that say why, as in the examples above.

## What a toolbox panel cannot do

A panel in a toolbox is data only: no JavaScript or CSS of its own. So it cannot have:

- `[notes]` (intro and footnote text on panes) or an `[explore]` pane;
- `models`, `illusCollapsed` or `illustrationText` in `[meta]`;
- a custom illustration, custom styles, or a data connector with its own forms (the Excel, ECB, Alpha Vantage, Yahoo Finance, FRED, EDGAR, Hugging Face and Kaggle panels);
- a gallery.

If a panel needs one of these, say so: it needs a change in Pollis itself.

## Model panels

Read the closest one before writing a new panel, and follow its shape. They go from simple to rich:

| Panel | What to learn from it | TOML |
|---|---|---|
| Linear Regression (`lm`) | Five models in one `"*"` branch with `{{?model=...}}` guards, no inputs; references | [lm.toml](https://raw.githubusercontent.com/saragga/pollis/main/src/vs/workbench/contrib/model/browser/webviews/lm.toml) |
| Markov Chain Monte Carlo (`mcmc`) | Text inputs filling the code; one branch per model | [mcmc.toml](https://raw.githubusercontent.com/saragga/pollis/main/src/vs/workbench/contrib/model/browser/webviews/mcmc.toml) |
| Local Optimisation (`optim`) | Per-model select inputs, `newRow`, mini charts | [optim.toml](https://raw.githubusercontent.com/saragga/pollis/main/src/vs/workbench/contrib/model/browser/webviews/optim.toml) |
| Generalized Method of Moments (`gmm`) | One tab (no `[[models]]`); selects with `when` conditions | [gmm.toml](https://raw.githubusercontent.com/saragga/pollis/main/src/vs/workbench/contrib/model/browser/webviews/gmm.toml) |
| Trading Agents (`trad`) | A complete wiki: the six standard pages, then one per model, with math | [trad.toml](https://raw.githubusercontent.com/saragga/pollis/main/src/vs/workbench/contrib/model/browser/webviews/trad.toml) |
| Time-Series Forecasting (`tsf`) | Six models with mini charts and per-model Next Steps | [tsf.toml](https://raw.githubusercontent.com/saragga/pollis/main/src/vs/workbench/contrib/model/browser/webviews/tsf.toml) |
| Hypothesis Testing (`ht`) | Many inputs shown by `when` conditions; guards on input values | [ht.toml](https://raw.githubusercontent.com/saragga/pollis/main/src/vs/workbench/contrib/model/browser/webviews/ht.toml) |
| Distribution Functions (`dist`) | The richest: eight models, per-model choices, sub-tabs, long `when` chains | [dist.toml](https://raw.githubusercontent.com/saragga/pollis/main/src/vs/workbench/contrib/model/browser/webviews/dist.toml) |

Their wiki pages are at `https://raw.githubusercontent.com/saragga/pollis/main/src/vs/workbench/contrib/model/browser/media/wiki/<id>/<page>.md` and their notebooks at `.../media/notebooks/<id>/<file>.ipynb`.
