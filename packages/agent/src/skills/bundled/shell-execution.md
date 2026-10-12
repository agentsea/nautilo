---
name: shell-execution
description: Managed local command execution through exec_command and write_stdin on the initiating Nautilo Desktop — contained Basic and Development access, temporary Full Mac, repeatable output, interactive contained PTYs, cancellation, and truthful fallback when execution is unavailable.
requiresTools: [exec_command, write_stdin]
source: official
version: 9
---
# Shell Execution — Skill

Use `exec_command` to launch one complete command on the authorized computer.
The main foreground conversation (`foreground.main`) uses the exact initiating
Human's Nautilo Desktop. Authorized background tasks, schedules, and nested
agents can also use contained execution when they inherit a verified delegation
to that original Human, Mac, and project. Every run rechecks the saved source,
pairing, project grant, and Basic or Development ceiling. A Task creation receipt
or a filesystem path alone is not delegation. Delegated work never inherits
Full Mac or a Human terminal handoff, and cannot switch to another computer.
Remote-only conversations and standalone relays do not supply this authority.
If the tools are absent or Desktop admission fails, say that local execution is
unavailable in this context. Do not claim that another relay is equivalent, do
not invent a shell result, and do not ask the Human to weaken the boundary.

## Pick the active access accurately

The Human selects access; the model does not choose or escalate it.

| Access | Execution contract |
| --- | --- |
| **Basic** | Contained execution in the selected Current Folder with isolated network, no inherited host environment, and a private temporary `HOME`. It is suitable for local inspection and work that does not need downloaded dependencies, host credentials, or developer configuration. |
| **Development** | Contained execution using the active Development profile, its locally admitted tools, environment, grants, and network policy. Use this for builds, tests, package managers, and developer CLIs when those capabilities are present. |
| **Full Mac** | A separately Human-authorized temporary uncontained command. It accepts a one-shot pipe only: omit `tty`, and never plan to send stdin. Ordinary command approval still applies. Full Mac changes containment; it does not create credentials, tools, grants, or account authority. |

Basic and Development both remain inside the Desktop containment boundary.
Current Folder identity, protected paths, OS permissions, and the exact
Human/Genie/Room/conversation binding are revalidated locally. A known host
path is not authority to access it, and `workdir` cannot select a different
root: it is relative to the admitted Current Folder.

## Pipes, managed PTYs, and continuation

Pipes are the default. Omit `tty` for commands that can run without interactive
terminal behavior. Set `tty: true` only when a contained Basic or Development
command genuinely needs a fresh PTY. Temporary Full Mac refuses PTYs and
subsequent input.

`exec_command` may return a completed result or a live `session_id`. A yielded
command is still running; yielding never terminates or restarts it. Preserve
the `session_id` and use `write_stdin` on that same execution:

- omit `chars` (or pass an empty string) to read status and repeatable output;
- pass `chars` only to a contained managed PTY that expects input;
- pass `cancel: true` to request termination and inspect the returned cleanup
  state;
- pass `cursor` to continue from an exact UTF-8 output position;
- where supported, use literal `search` and its `nextSearchCursor` to find
  retained evidence without rerunning the command.

Reads do not consume output. A quiet read does not mean the command completed.
Do not restart a quiet build, and do not use background shell syntax to make a
server appear durable. Continue reading the owned execution or cancel it.

Treat the final state, exit code, and signal as data. A nonzero command exit is
not a Desktop transport failure. If an input response is uncertain, never send
the same input again automatically. If cancellation is uncertain, report that
uncertainty rather than claiming the process stopped.

After a Desktop or server restart, `write_stdin` may recover the saved final
result for an execution referenced in this conversation. That recovery is
read-only and never restarts a command. If history is unavailable, say so. The
optional `read_shell_output` tool reads older retained shell evidence when it
is actually offered; it is not the continuation path for an `exec_command`
`session_id`.

## Related tools when available

- Use ordinary `git`, `gh`, package-manager, and developer CLI commands through
  `exec_command` when the active Development profile permits them.
- Use `human_terminal` only after the Human explicitly hands over their exact
  existing terminal. It sends input to that terminal and has its own receipts;
  it is not a way to acquire or replace managed local execution.
- Use the terminal-sessions skill for managed PTY continuation and explicit
  Human terminal handoff discipline.

## Workflow

1. Read the selected Current Folder from the available file context; do not
   assume a launch directory or remembered host path.
2. State the command's purpose and target folder briefly before running it.
3. Use `workdir` only for a relative directory inside Current Folder. Omit it
   when Current Folder itself is correct.
4. Prefer pipes. Request a contained PTY only for real interactive behavior.
5. Choose `yield_time_ms` for how long this call should wait for output, not as
   a process timeout. Set `max_output_bytes` only to bound the response; unread
   retained output remains available by cursor.
6. If a live `session_id` is returned, continue that execution with
   `write_stdin`; never relaunch merely because output paused or was clipped.
7. A retained execution keeps its original folder when Current Folder changes.
   Continue with its existing reference while authorized; do not restart it in
   the new folder. If access, identity, or policy revalidation fails, report
   the exact blocker and use the current Desktop recovery action. Never widen
   access to `/` or bypass an OS denial.

Write commands so the Human can understand exactly what will run. Avoid
obfuscation and pipelines that hide destructive behavior. Never request or
capture a password, use `sudo`, destroy uncommitted work, or replay a mutation
whose outcome is uncertain.
