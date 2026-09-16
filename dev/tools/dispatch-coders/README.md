# dispatch-coders bundle

Orchestrator-side persona for sessions where the parent agent dispatches
role-matched subagents while it audits diffs and commits. GLM-5.2 is the
strong, economical default coder; Composer handles mechanical bulk work,
GPT-5.6 Terra is another strong choice and the first pick for visual/UX
work, and Opus 4.8 is a deliberate complex or visual/UX coding alternative. GPT-5.6 Sol and Fable are read-only planning
and validation consultants unless the user explicitly authorizes them to
execute a named implementation task. Ships two related commands.

Invoking `/dispatch-coders` is the standing authorization for the
orchestrator to commit this stack's audited work **autonomously** (no
per-commit confirmation); the usual guardrails still bind (selective
`git add`, no `git push` unless asked, no secrets). Subagents never commit.

## What it ships

| Surface | Slash command | Purpose | File |
|---|---|---|---|
| Claude Code | `/fb:dispatch-coders` | Load the orchestrator persona for the rest of the thread | deployed `.claude/commands/fb/dispatch-coders.md` |
| Claude Code | `/fb:subagent-rules` | Drop the anti-clobber + no-git block into a subagent prompt | deployed `.claude/commands/fb/subagent-rules.md` |
| Cursor (containing workspace) | `/dispatch-coders` | same as above | deployed `.cursor/commands/dispatch-coders.md` |
| Cursor (containing workspace) | `/subagent-rules` | same as above | deployed `.cursor/commands/subagent-rules.md` |

Use `/fb:dispatch-coders` at the **start** of a thread to load the
persona. Inside that thread, `/fb:subagent-rules` is for re-pasting the
verbatim subagent rules into individual dispatches without re-loading
the whole orchestrator persona.

## Source of truth

Two files, each in **`claude/commands/fb/`**:
- `dispatch-coders.md`
- `subagent-rules.md`

The `cursor/commands/*.md` entries are relative symlinks. **Do not**
maintain the cursor/ copies by hand.

## Install

```bash
# Just this bundle:
bash dev/tools/dispatch-coders/install.sh

# Or all bundles at once:
bash dev/tools/install-all.sh
```

See `dev/tools/_lib/deploy.sh` for the full destination matrix.
