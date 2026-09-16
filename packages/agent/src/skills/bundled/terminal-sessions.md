---
name: terminal-sessions
description: Persistent interactive PTY sessions via the terminal relay tool — spawn/run/write/read/list/kill over a shared shell, when to pick it over run_shell, and the capability-gated trust model.
requiresTools: [terminal]
source: official
version: 2
---
# Terminal Sessions — Skill

Use `terminal` to drive a **persistent, interactive PTY** the agent shares with the user. It is the right pick when a command is not a one-shot — long-running processes, interactive REPLs (node/python/psql), TUIs (vim, less, htop), dev servers, watchers, or any workflow where you need to keep coming back to the same shell across multiple calls.

`terminal` is a **relay tool** — execution goes through the relay protocol, never direct invocation from the cloud graph. It is offered **only when a PTY-capable desktop relay is connected** (a standalone `nautilo-relay` does not advertise PTY support). If the tool is bound, the relay is PTY-capable; if a call fails with a relay error, surface that to the user rather than retrying.

## How it differs from `run_shell`

| Need | Tool |
| --- | --- |
| Run one command, observe bounded live output, get its final result, done | `run_shell` |
| Persistent PTY, interactive REPL, long-running dev server, watching streaming output across calls | `terminal` |

`run_shell` is **observable and one-shot**: the Human sees bounded live stdout/stderr, while the final structured result remains canonical and large captured output may require bounded continuation-artifact reads. It still has no PTY, stdin, or persistent session, and retains conditional approval (`prove_it`/ask by default, or Full Workstation auto-admission for eligible profile-bound attempts). `terminal` is a **stream** over a long-lived session: you `spawn` once, then drive the same shell with `run`/`write`/`read` across as many calls as you need. Script-local `cd`/`export` state inside a `run` body does NOT persist after that body — but the session itself does, so a `cd` sent as its own `run` (or via `write` of the keystroke) persists for later reads.

**`terminal` is a separate path from `run_shell`.** A working `terminal` session is **not evidence** that the profile-bound `run_shell` mount/binding works — they are different capabilities with different validation, and `terminal` does not validate the `run_shell` shell-binding path. Do not use a `terminal` session as a substitute for a `run_shell` baseline.

Reach for `terminal` when:
- The process runs indefinitely (dev server, watcher, REPL).
- You need to interact with a prompt (answer y/n, feed input, send Ctrl-C).
- You want to watch output accumulate across multiple calls instead of blocking once for the whole thing.

Reach for `run_shell` when:
- The command finishes on its own and you just want its output.
- You want the operator to approve a specific destructive command via `prove_it`.

## Trust model — capability-gated **allow**, NOT `prove_it`

`terminal` is registered `trustTier: admin`, `impact: "high"` (not `destructive`), `requiresApproval: false`, requires the Human's `use_workstation` capability, and requires a PTY relay advertising `canUseTerminal`. It is **basic normal gating, NOT a PIN**: actors holding `use_workstation` get an `allow` path, with no per-call approval dock.

Practical implications:

- **No `prove_it` dock per command.** The trust lives at the capability gate, not per-call. The user has opted into terminal access; do not abuse it — state intent plainly before destructive operations, and prefer `run_shell` if you want a human-in-the-loop checkpoint for a specific destructive command.
- **The session is shared with the user.** The same PTY is visible on the user's workbench terminal surface. They can see what you type, and they can type into it too. Don't assume you have exclusive control.
- **Agent sessions are sandbox-wrapped on the relay** (contained shell), but the sandbox is a containment boundary, not a permission boundary — assume real filesystem/process reach inside the session. A spawned session **defaults to the dispatch sandbox workspace unless you pass `cwd`**; pass `cwd` (the selected Current Folder) to start inside the project boundary. Known host paths outside the Current Folder are not automatically visible just because you know they exist.

## Actions

| Action | What it does | When to use |
| --- | --- | --- |
| `spawn` | Start a new shell session; returns `session_id` + initial `cursor` (0). If an exact Human handoff is pending, reuses it with `reused_handoff:true`. | First step only when the Human did not identify or hand over an existing session. Pass `cwd` to set the working directory. |
| `run` | Execute command text and return new output + next cursor. **RECOMMENDED for running commands.** Pass ONLY the command/script text in `data`; do NOT add a trailing submit newline. Single-line → one Enter; multi-line → heredoc-wrapped and run as one bash script. | One-off commands inside a session. Script-local `cd`/`export` state does NOT persist after a multi-line body — for state that should persist, send it as its own `run`. |
| `write` | Send RAW keystrokes/bytes as-is, NO Enter added. | Control chars (Ctrl-C, Ctrl-D), answering a prompt, feeding a TUI, partial input the relay shouldn't terminate. |
| `read` | Return new output since the `cursor` from the previous `spawn`/`read`/`run` (+ next cursor). | Polling for more output from a long-running process, or seeing what a REPL printed after your last keystroke. |
| `list` | Live sessions (id/title/cwd/sandboxed/controller/consent), with `preferred_for_agent:true` on an exact pending Human handoff. | Use only when the Human refers ambiguously to an existing terminal without selecting **Let Genie drive**, or after a genuine direct-bind failure. |
| `kill` | End a session. | Cleanup when you're done with a dev server/REPL. Don't leave sessions dangling. |

## Typical loops

One-shot command inside a session (preferred over `run_shell` when you already have a session):

```
terminal({ action: "spawn", cwd: "/path/to/repo" })   // → session_id, cursor 0
terminal({ action: "run", session_id, data: "git status" })  // → output, next cursor
terminal({ action: "run", session_id, data: "bun test" })    // → output, next cursor
terminal({ action: "kill", session_id })
```

Long-running process + watch:

```
terminal({ action: "spawn", cwd: "/path/to/repo" })
terminal({ action: "run", session_id, data: "bun run dev" })  // returns initial output
terminal({ action: "read", session_id, cursor })              // poll for more output
terminal({ action: "read", session_id, cursor })              // poll again
// ... when done:
terminal({ action: "write", session_id, data: "\u0003" })     // Ctrl-C
terminal({ action: "kill", session_id })
```

Interactive REPL / answering a prompt:

```
terminal({ action: "spawn", cwd: "/path/to/repo" })
terminal({ action: "run", session_id, data: "node" })         // REPL prompt appears
terminal({ action: "write", session_id, data: "1 + 1" })      // type WITHOUT submitting
terminal({ action: "write", session_id, data: "\r" })         // press Enter
terminal({ action: "read", session_id, cursor })              // → 2
terminal({ action: "write", session_id, data: "\u0003" })     // Ctrl-C to exit
```

## Workflow rules

1. If the Human selected **Let Genie drive**, start directly with `run`, `read`, or `write`; `session_id` may remain omitted while Genie controls that PTY. Desktop binds every such call to the exact handed-over PTY and also returns its `session_id`, so acquisition through list/discover/activate/spawn is unnecessary. If the Human only refers ambiguously to an existing/shared terminal, `list` and use `preferred_for_agent:true`. Otherwise `spawn`, remember the `session_id` and latest `cursor`, and pass `cwd` to start in the selected Current Folder. Defense in depth: if a Human handoff is pending and you mistakenly call `spawn`, the relay reuses that exact PTY instead of creating a second one.
2. Prefer `run` over `write`+`read` for executing commands — `run` handles Enter / heredoc wrapping for you. Reach for `write` only when you need raw keystrokes (control chars, TUI input, mid-line partial input).
3. Never add a trailing submit newline in `run`'s `data` — the relay does that for single-line commands, and heredoc-wraps multi-line ones. Adding your own `\n` can double-fire or break the heredoc.
4. Poll with `read` + the last `cursor` to watch streaming output; don't busy-loop — leave time between reads for the process to produce output.
5. **Re-list after spawn if uncertain.** A spawned PTY may **exit immediately** (bad `cwd`, missing binary, login-shell quirk). Do not assume the returned `session_id` is still live — call `list` (or `read`) to confirm before driving it. A dead session ⇒ report it, fix the `cwd`, and respawn **once**; do not loop-spawn against the same broken path.
6. `kill` sessions when you're done. Don't leave dev servers / REPLs dangling for the user to clean up.
7. If the user rejects a destructive action by typing into the shared session, respect that — don't re-issue it via `write`.
8. Remember `terminal` is a **separate path** from `run_shell` — it neither proves nor disproves that the profile-bound `run_shell` binding/mount works.
