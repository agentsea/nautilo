# phase-end bundle

Fast 3-pass self-check gate to run **after** a coding pass in a phase,
before reporting "done" or committing. Sister to `/fb:pre-flight`
(before-the-fact gate) and `/fb:review-pr` (diff-level catcher).

## What it ships

| Surface | Slash command | File |
|---|---|---|
| Claude Code | `/fb:phase-end` | deployed `.claude/commands/fb/phase-end.md` |
| Cursor (containing workspace) | `/phase-end` | deployed `.cursor/commands/phase-end.md` |

## Source of truth

Single file: **`claude/commands/fb/phase-end.md`**.

`cursor/commands/phase-end.md` is a relative symlink to that file, so
editing the canonical updates both deploy shapes. **Do not** maintain
the cursor/ copy by hand.

## Install

```bash
# Just this bundle:
bash dev/tools/phase-end/install.sh

# Or all bundles at once:
bash dev/tools/install-all.sh
```

See `dev/tools/_lib/deploy.sh` for the full destination matrix
(worktrees, companion repos, `NAUTILO_EXTRA_CLAUDE_DIRS`,
`NAUTILO_EXTRA_CURSOR_DIRS`, the containing workspace ancestor).
