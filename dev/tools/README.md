# dev/tools — agent command bundles + MCP servers

Two distinct kinds of thing live here:

1. **Command bundles** — markdown files that become slash commands in
   Claude Code (`/fb:<name>`), Cursor (`/<name>`), and Codex
   (`/prompts:<name>`). Replicated by
   per-bundle `install.sh` scripts that share `_lib/deploy.sh`.
2. **MCP servers** — TypeScript daemons (`electron-debug`,
   `nautilo-db`, `nautilo-backup`, `nautilo-server-logs`,
   etc.) that get installed under `~/.nautilo-dev/tools/<name>/` and
   wired into Cursor's `mcp.json`. **Out of scope for `install-all.sh`**
   — see each MCP server's own README for its install path.

This README covers the **command bundles**.

## At a glance

| Bundle | Slash commands | What it does |
|---|---|---|
| `phase-end/` | `/fb:phase-end`, `/phase-end`, `/prompts:phase-end` | Fast 3-pass self-check after a coding pass |
| `green-pr/` | `/fb:green-pr`, `/green-pr`, `/prompts:green-pr` | Drive a sprint/worktree/folder to an open PR with green CI; fix lints + tests by root cause, never by silencing checks |
| `dispatch-coders/` | `/fb:dispatch-coders`, `/fb:subagent-rules`, `/dispatch-coders`, `/subagent-rules`, `/prompts:dispatch-coders`, `/prompts:subagent-rules` | Orchestrator persona + subagent anti-clobber block |

> Cursor slash commands are flat: filename `phase-end.md` becomes
> `/phase-end`. Claude commands live under `commands/fb/` so they
> show up as `/fb:<name>`.
>
> Codex custom prompts are also flat but namespaced: filename
> `phase-end.md` under `~/.codex/prompts/` becomes `/prompts:phase-end`.
> Restart Codex or open a new chat after deploying prompt files.

## Replicate everything

```bash
bash dev/tools/install-all.sh                                    # all bundles
bash dev/tools/install-all.sh phase-end dispatch-coders          # selected public bundles
NAUTILO_DEPLOY_DRY_RUN=1 bash dev/tools/install-all.sh           # show, don't write
NAUTILO_DEPLOY_PRUNE=1 bash dev/tools/install-all.sh             # deploy + drop stale copies
```

This walks every `dev/tools/<bundle>/install.sh`, each of which is a
3-line wrapper around `_lib/deploy.sh`. **No central registry to
maintain** — adding a new bundle is one new directory.

## Where things deploy (auto-discovered)

| Surface | Discovery rule | Override env var |
|---|---|---|
| `<worktree>/.claude/agents/`, `<worktree>/.claude/commands/fb/` | every path in `git worktree list` for the nautilo repo | `NAUTILO_EXTRA_CLAUDE_DIRS` (colon-separated) |
| `<companion-repo>/.claude/...` | sibling dirs that already have `.claude/`, share the same GitHub org, and whose repo name is `nautilo`, `nautilo-*`, or `nautilo_*` | same |
| `<workspace-root>/.cursor/commands/`, `<workspace-root>/.cursor/rules/` | first ancestor of the nautilo checkout that contains a `.cursor/` directory | `NAUTILO_EXTRA_CURSOR_DIRS` (colon-separated) |
| `<codex-home>/prompts/` | `$NAUTILO_CODEX_HOME`, else `$CODEX_HOME`, else `~/.codex` | `NAUTILO_EXTRA_CODEX_HOMES` (colon-separated Codex home dirs) |
| `<codex-home>/skills/` | Same Codex-home discovery rule | Same |

Codex prompt source fallback is:

1. `codex/prompts/*.md`, when a bundle needs Codex-specific wording.
2. `cursor/commands/*.md`, when the Cursor command is already the flat command shape.
3. `claude/commands/fb/*.md`, for bundles that only ship Claude commands.

Full destination matrix and design notes live in **`_lib/deploy.sh`**'s
header comment.

## Adding a new command bundle

1. **Create the directory and the canonical file.**

   ```bash
   mkdir -p dev/tools/my-bundle/{claude/commands/fb,cursor/commands}
   ```

   Write the prompt body once at:

   ```
   dev/tools/my-bundle/claude/commands/fb/my-cmd.md
   ```

2. **Symlink the Cursor copy to the canonical** (single source of
   truth — never hand-edit the cursor/ side). Codex will reuse the
   Cursor copy automatically unless you add a Codex-specific file under
   `codex/prompts/`.

   ```bash
   cd dev/tools/my-bundle/cursor/commands
   ln -sf ../../claude/commands/fb/my-cmd.md my-cmd.md
   ```

3. **Add a 3-line install.sh wrapper:**

   ```bash
   cat > dev/tools/my-bundle/install.sh <<'SH'
   #!/usr/bin/env bash
   set -euo pipefail
   HERE="$(cd "$(dirname "$0")" && pwd)"
   . "$HERE/../_lib/deploy.sh"
   deploy_bundle "$HERE" "my-bundle"
   SH
   chmod +x dev/tools/my-bundle/install.sh
   ```

4. **Add a `README.md` for the bundle** (see `phase-end/README.md` as a template).

5. **Run it:**

   ```bash
   bash dev/tools/install-all.sh my-bundle
   ```

6. **Add an entry to the "At a glance" table** above.

That's it. The omnibus picks the new bundle up automatically on the
next run; no central registry to update.

### When to use Claude `agents/` vs `commands/`

- **`commands/fb/<name>.md`** — what the user invokes via `/fb:<name>`. Almost always what you want.
- **`agents/<name>.md`** — Claude Code subagent persona invoked by `Task(subagent_type=<name>)`. Cursor does not consume these.

### When to also ship `cursor/rules/*.mdc`

If the prompt is more "always-applied guidance" than "user-invoked
slash command", create it under `cursor/rules/` instead of (or in
addition to) `cursor/commands/`. The deployer handles both shapes
automatically.

## Deployed copies are gitignored — and stamped

Every materialized copy under `.claude/`, `.cursor/`, and
`<codex-home>/prompts/` carries an HTML-comment banner at the top:

```
DEPLOYED COPY — DO NOT EDIT THIS FILE DIRECTLY.
Canonical source: nautilo/dev/tools/<bundle>/...
```

The banner is regenerated on every `install.sh` run, so direct edits
to deployed files are silently overwritten. Edit the canonical, run
the omnibus, commit the canonical change. The deployed copies are
not committed (gitignored at every destination).

## Conventions

- **Bundle directory name = command name** when a bundle ships exactly
  one command (e.g. `phase-end/` → `/fb:phase-end`).
- **Bundle directory name = a topic** when it ships related commands.
- **Filenames** are kebab-case, lowercase. Filename = slash-command name.
- **No spaces or copies in command filenames.** The omnibus deploys
  literally what it finds; `review-pr copy.md` lying in the source
  dir would ship as a real command.

## What's NOT a command bundle

The following directories live under `dev/tools/` but are **not**
processed by `install-all.sh` (they have no `install.sh`):

- `electron-debug/`, `nautilo-db/`, `nautilo-backup/`,
  `nautilo-server-logs/` — MCP servers; install via
  `~/.nautilo-dev/tools/<name>/`
- `png-to-svg/`, `security-smoke/` — utility scripts, MCPs, or harnesses
- `_lib/` — shared library, sourced by bundle wrappers. Underscore prefix excludes it from the omnibus.

Private planning, issue, workflow, preflight, and review bundles are maintained
outside the public product repository.
