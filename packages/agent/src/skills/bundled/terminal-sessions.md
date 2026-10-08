---
name: terminal-sessions
description: Operate the legacy persistent terminal relay tool when it is offered — shared PTY spawn/run/write/read/list/kill, capability gating, cursor discipline, and its separation from managed local execution and explicit Human terminal handoff.
requiresTools: [terminal]
source: official
version: 3
---
# Terminal Sessions — Skill

Use `terminal` only when it is present and the task benefits from its legacy
persistent, shared PTY: a long-running dev server, watcher, REPL, TUI, or a
workflow that must return to the same shell across calls. Newer Desktop
contexts may instead offer managed `exec_command` and `write_stdin`; do not
require the legacy tool when it is absent.

`terminal` is a relay tool offered only by a PTY-capable Desktop relay. It is
capability-gated by the Human's `use_workstation` authority and the relay's
`canUseTerminal` capability. It has no per-command approval dock. The session
is visible to and shared with the Human, who may type into it too.

## Choose the correct terminal surface

| Need | Surface |
| --- | --- |
| Complete local command, actual exit status, retained output, or a fresh contained managed PTY | `exec_command`, then `write_stdin` if it yields |
| Existing legacy shared PTY with spawn/list/kill lifecycle | `terminal`, when offered |
| The Human's exact existing terminal after an explicit handoff | `human_terminal`, when offered |

These are independent capabilities. A working legacy session does not prove
that managed Basic or Development execution is admitted. Do not use it to
work around an access denial, changed Current Folder, protected path, or Full
Mac restriction.

## Actions

| Action | Purpose |
| --- | --- |
| `spawn` | Create a session rooted at the selected Current Folder. |
| `run` | Submit one command plus Enter to a live session and observe initial output. |
| `write` | Send raw input or control characters without adding Enter. |
| `read` | Read output from a cursor without sending input. |
| `list` | Inspect live sessions; use sparingly when the Human refers ambiguously to one. |
| `kill` | Stop a session and release its process. |

Typical lifecycle:

```text
terminal({ action: "spawn", cwd: "/selected/project" })
terminal({ action: "run", session_id, data: "bun run dev" })
terminal({ action: "read", session_id, cursor })
terminal({ action: "write", session_id, data: "\u0003" })
terminal({ action: "kill", session_id })
```

Remember the returned `session_id` and latest cursor. Read incrementally; do
not repeatedly request the full transcript. A `run` body can execute a compound
script, but shell-local `cd` or `export` inside that body does not necessarily
persist afterward. Send a standalone command or raw keystrokes when later
calls need the changed shell state.

## Human handoff and lifecycle discipline

If the Human selected **Let Genie drive**, use the exact handed-over terminal
according to the tool result. When `terminal` is offered for that handoff,
start directly with `run`, `read`, or `write`; `session_id`
may remain omitted while Genie controls that PTY. No discovery, listing, or
new session is needed for the exact handed-over terminal.
If the separate `human_terminal` tool is offered,
prefer its explicit read/run/write contract for that handoff. Never guess a
session or send uncertain input twice.

Spawn against the selected Current Folder, not a remembered path. A PTY can
exit immediately because of a bad directory, missing binary, or login-shell
failure; confirm it remains live before sending more input. After a dead
session, fix the cause and respawn at most once rather than looping.

State intent before destructive commands even though the tool is
capability-gated. Never capture credentials or type a Human password. Send
Ctrl-C before killing a process when graceful shutdown matters, then `kill`
when finished so watchers, REPLs, and servers are not left behind.
