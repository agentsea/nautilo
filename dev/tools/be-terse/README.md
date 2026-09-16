# be-terse bundle

A lightweight **style modifier**: tells the model to cut output
tokens and be direct, while explicitly protecting essential signal
(file paths, links, ids, commands, caveats) and the required outputs
of any other active command.

It is composable, not overriding — it changes *how* the model
reports, never *what* the other commands make it do.

## What it ships

| Surface | Slash command | File |
|---|---|---|
| Claude Code | `/fb:be-terse` | deployed `.claude/commands/fb/be-terse.md` |
| Cursor (containing workspace) | `/be-terse` | deployed `.cursor/commands/be-terse.md` |

## Source of truth

Single file: **`claude/commands/fb/be-terse.md`**.

`cursor/commands/be-terse.md` is a relative symlink to that file, so
editing the canonical updates both deploy shapes. **Do not** maintain
the cursor/ copy by hand.

## Install

```bash
# Just this bundle:
bash dev/tools/be-terse/install.sh

# Or all bundles at once:
bash dev/tools/install-all.sh
```

See `dev/tools/_lib/deploy.sh` for the full destination matrix.
