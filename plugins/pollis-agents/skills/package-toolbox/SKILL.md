---
name: package-toolbox
description: "Package a toolbox: build a Pollis toolbox (a .vsix extension) from Pollis menu entries the user picks, in the menus and order they want, for example one toolbox per course for a teacher's students. Triggers include 'make a toolbox from these panels', 'package these menu entries as an extension', 'build a toolbox for my course', 'Extension Agent', 'build an extension from this spec', 'package my new panel'. The create-panel skill hands its new panels over to this one."
---

# Package a Toolbox

Builds a Pollis toolbox from a spec: a list of Pollis menu entries (the panels) and the menus and order they go in. The result is a `.vsix` file the user installs in Pollis with **Extensions: Install from VSIX...**, or gives to others (a teacher to their students, say). A toolbox has no code: its panels are copies of Pollis panels with their wikis and notebook tutorials.

The mechanical work is done by the builder script, `makeToolbox.mjs`, in the `scripts` folder of this plugin: two folders up from this SKILL.md, then `scripts/` (this file is `<plugin>/skills/package-toolbox/SKILL.md`, the script is `<plugin>/scripts/makeToolbox.mjs`). Use its absolute path in the commands below, quoted. You do the parts that need judgment.

It needs Node.js 22 or later (`node --version`); if Node is missing or older, tell the user to install it from nodejs.org and stop. It reads Pollis' panels from the public Pollis repository on GitHub, so it needs the internet; nothing is installed and Pollis itself is not changed.

## The builder

```
node "<plugin>/scripts/makeToolbox.mjs" list [words...]
node "<plugin>/scripts/makeToolbox.mjs" build <spec.toml> --out <folder> [--overwrite]
node "<plugin>/scripts/makeToolbox.mjs" pack <folder>/<name>
```

- `list` prints the panels whose id, title, menu title or command contain all the words, with their commands and menu titles; a panel marked NOT PORTABLE cannot go in a toolbox (it has its own code), with the reason. `list` alone also prints the menus a toolbox can go in.
- `build` writes `<folder>/<name>/` (package.json, panels/, wiki/, notebooks/, icon.png, README.md) and `<folder>/<name>-<version>.vsix`.
- `pack` packages a toolbox folder again, after its README was edited; the `.vsix` is written next to the folder.

## The spec

```toml
[extension]
name = "pollis-toolbox-stats101"     # lower case letters, digits and hyphens
displayName = "Statistics 101"
description = "The panels of the Statistics 101 course."
version = "1.0.0"                    # optional
author = "Ana Silva"                 # optional: shown in Pollis as the publisher

[[menu]]                             # one or more
id = "stats101"
title = "Statistics 101"             # the submenu's title
menu = "Model"                       # Compose (default; formerly Toolboxes), Explore, Model, Simulate, Optimise or a submenu id
group = "2_toolboxes"                # optional: where the submenu goes in that menu
order = 1

[[menu.items]]                       # the entries, in the order wanted
command = "chiara.statistics.lm"     # the menu entry's command (from list), or panel = "lm", or toml = "garch.toml"
title = "1. Linear Regression"       # optional: the menu title, default the one in Pollis
```

- **Origin**: each `[[menu.items]]` names a menu entry by its `command`, or the panel by `panel = "<id>"`. The user names entries by their menu titles: find them with `list` and say which command you chose when there is more than one match. A command that opens a panel on a given model (shown by `list`) opens the copy on that model too.
- **A panel of the user's own** (written by the `create-panel` skill, or by hand) is `toml = "<path>"`, relative to the spec: its id is the file name, and its `wiki/` and `notebooks/` folders next to it are copied with it. The build checks it with the validator first and stops on an error: fix it with the `create-panel` skill's reference, then build again.
- **Destination**: `menu` is a top-level menu or a submenu id (from `list`). `inline = true` puts the entries straight into that menu, without a submenu; they then take the menu's `group`. Items take `group` and `order` too (default: their position).
- Optional `prefix` in `[extension]` (default: the name without `pollis-toolbox-`) names the copies: panel `<prefix>.<id>`, wiki and notebook folders `<prefix>.<folder>`.

## Steps

1. **Understand the request.** Find each panel the user names with `list`; if a name matches several panels or none, ask. If something is missing (name, display name, description, the author to show as publisher, where the entries go, their order), ask once, offering sensible defaults. Do not invent a description: ask, or propose one for approval.
2. **Write the spec** as a `.toml` file in the folder the user wants (default: the open workspace folder), and show it.
3. **Run `build`** with `--out` that folder (`--overwrite` only when the user agreed to replace an existing toolbox folder of that name). It stops with a clear message on what cannot be packaged: a NOT PORTABLE panel, a panel of the user's own with errors, a gallery or dialog (not a panel), an unknown command, panel or menu, a panel listed twice. Report it, and continue without the entry only if the user agrees.
4. **Finish the README** (`<folder>/<name>/README.md`): fill the "What it covers" column, one short line per panel, from the panel's TOML in `<folder>/<name>/panels/` (its models and key points), for example "Ordinary, weighted and robust least squares, with diagnostics". Keep the rest. Show it to the user, then run `pack` on the toolbox folder.
5. **Report**: the panels and where they go, anything left out and why, and where the `.vsix` is. Tell the user how to install it: in Pollis, run **Extensions: Install from VSIX...** from the Command Palette and pick the file (students do the same with the file their teacher gives them). The panels appear in the menus at once. To change the toolbox later, edit the spec, raise `version`, build again and install the new `.vsix` over the old one; to remove it, uninstall it in the Extensions pane.

## Rules

- Every panel of the toolbox is an independent copy: its own editor tab, its own wiki and notebook folders, its own saved examples and references. Pollis keeps its own panels unchanged. Say so if the user asks whether the toolbox replaces anything.
- A copy is made from the current Pollis panels; when Pollis improves a panel later, the toolbox keeps the version it was built with until it is built again.
- If a download fails, say so with the message the builder printed. Behind a proxy, recent Node versions use `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set too.
- Never use DataFrames, never name a university, say Open VSX, never "VS Code Marketplace" (in the README and in what you tell the user).
