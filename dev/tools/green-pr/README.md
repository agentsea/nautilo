# green-pr bundle

Turn a sprint / worktree / folder into an **open PR with green CI**, fixing
lints and tests by their real root cause — never by silencing a check or
mutating a test to dodge it. "Flaky" and "pre-existing" are claims the
command forces you to prove, not excuses it lets you assume.

Sister to `/review-pr` (cold-eyes review of a diff) and `/phase-end`
(self-check after a coding pass). `/green-pr` is the loop that *produces*
the green, reviewable PR; it does not merge. Runs directly, or hands a
ready-to-paste block to a dispatched subagent.

## What it ships

| Surface | Slash command | File |
|---|---|---|
| Claude Code | `/fb:green-pr` | deployed `.claude/commands/fb/green-pr.md` |
| Cursor (containing workspace) | `/green-pr` | deployed `.cursor/commands/green-pr.md` |
| Codex | `/prompts:green-pr` | deployed `<codex-home>/prompts/green-pr.md` |

## Source of truth

Single file: **`claude/commands/fb/green-pr.md`**.

`cursor/commands/green-pr.md` is a relative symlink to that file, so editing
the canonical updates every deploy shape. **Do not** maintain the cursor/
copy by hand.

## Install

```bash
# Just this bundle:
bash dev/tools/green-pr/install.sh

# Or all bundles at once:
bash dev/tools/install-all.sh
```

See `dev/tools/_lib/deploy.sh` for the full destination matrix (worktrees,
companion repos, `NAUTILO_EXTRA_CLAUDE_DIRS`, `NAUTILO_EXTRA_CURSOR_DIRS`,
the containing workspace ancestor).
