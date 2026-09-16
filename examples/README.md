# `examples/` — discoverable example configs

> **Status: SCAFFOLD ONLY (2026-05-08).** This directory will
> consolidate the reference configs (`.env.example`,
> `setup.example.toml`, future `recovery-config.example.toml`,
> etc.) that today live at the workspace root or buried under
> package-level `templates/`. Until D116 lands, the canonical
> locations stay where they are; this README describes the
> intent.

## What lives (or will live) here

Reference / starter configs that an operator copies and edits.
Never working files; never anything containing real secrets;
all guarded by gitignore patterns at the workspace root.

| File | Today's location | Future home (D116) |
|---|---|---|
| `.env.example` | workspace root | `examples/env.example` |
| `setup.example.toml` | workspace root | `examples/setup.example.toml` |
| `apps/cli/templates/nautilo-setup.quickstart.toml` | as-is (source-of-truth) | as-is — `examples/setup.example.toml` mirrors it for discoverability |

## Why both root + `examples/`

The workspace-root copies (`.env.example`,
`setup.example.toml`) maximize discoverability for new
operators browsing the repo on GitHub or via `ls`. The
`examples/` directory is where we go when there are more than
two — at that point a flat "list of reference files" is
clearer than scattering them across the root.

## Naming convention

- `*.example.<ext>` — copy, edit, save under a different name
  (or outside the repo). Tracked.
- `*.template.<ext>` — same intent, but the file embeds
  templating syntax (e.g. `${VAR}`) that gets substituted at
  runtime. Tracked.
- `*.<ext>` (no suffix) — working file. **Untracked**, blocked
  by `.gitignore`.

## Until D116

Most reference files stay at their current locations; this
directory exists to claim the convention. When D116 picks up,
moves are atomic and a single redirect is enough.
