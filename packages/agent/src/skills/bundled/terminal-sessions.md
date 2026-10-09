---
name: terminal-sessions
description: Operate managed local terminal sessions through exec_command and write_stdin, including contained PTYs, cursor-based output, input uncertainty, cancellation, and explicit Human terminal handoff.
requiresTools: [exec_command, write_stdin]
source: official
version: 4
---
# Terminal Sessions — Skill

Use `exec_command` for a command that needs a managed local process. Request
`tty: true` only for a contained Basic or Development command that genuinely
needs a PTY, such as a REPL, watcher, interactive prompt, or terminal UI. A
temporary Full Mac command accepts a one-shot pipe only.

`exec_command` may finish in the first response or yield a live `session_id`.
Keep that identifier and continue the same process with `write_stdin`:

- omit `chars` to poll repeatable output and process state;
- pass `chars` only when the managed PTY is waiting for input;
- pass `cursor` to resume from an exact output position;
- pass `cancel: true` to request termination and inspect the cleanup result.

Do not relaunch a quiet or yielded process. Output reads do not consume output,
and a pause does not mean the process stopped. If an input response has an
unknown delivery outcome, do not send it again automatically. If cancellation
is uncertain, report that uncertainty instead of claiming cleanup succeeded.

Use `human_terminal` only after the Human explicitly hands over their exact
existing terminal. That surface has its own read, run, and write receipts and
does not create managed local execution authority. Never discover or guess a
terminal identifier, capture credentials, type a Human password, or use one
terminal surface to bypass an access denial on another.
