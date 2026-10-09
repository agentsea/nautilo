---
name: developer-workstation
description: Develop on the initiating Nautilo Desktop through managed local execution — Current Folder authority, contained Basic and Development access, temporary Full Mac, file editing, Git and GitHub setup, retained execution, and precise denial remediation.
requiresTools: [exec_command, write_stdin, apply_patch]
source: official
version: 12
---
# Developer Workstation — Skill

Use this skill when the Human wants real development work on their computer:
inspect or edit code, run Git, test, build, or configure a developer CLI.
Use structured file tools to inspect and edit text, `exec_command` to launch a
complete local command, and `write_stdin` to continue an execution that yields.

Managed execution in the main foreground conversation (`foreground.main`)
uses the exact initiating Nautilo Desktop. Authorized background tasks,
schedules, and nested agents can inherit contained execution through a verified
delegation to the original Human, Mac, and project. Every run rechecks the saved
source, pairing, project grant, and Basic or Development ceiling. Delegated work
never inherits Full Mac or a Human terminal handoff and cannot switch computers.
A Task creation receipt or a filesystem path alone is not delegation;
remote-only conversations and standalone relays do not supply this authority.
If the tools are absent or admission fails, explain that local
execution is unavailable in this context and continue with file-only work when
that can still satisfy the request. Never invent results or route around the
boundary through another shell surface.

Use the structured `file` surface to discover, search, read, and edit project
bytes. Core tools are only the always-present baseline, not the complete
catalog. If `file` is not callable, use `discover_tools` with the filesystem
family and activate it before proceeding; do not treat visible `apply_patch`
as the only file capability.

## The access model

1. **Current Folder is the selected project.** Both file operations and local
   execution bind to the directory selected in the Files header. A known host
   path outside it is not automatically visible. `workdir` is relative to the
   admitted Current Folder and cannot select another root. Do not tell the
   Human to add Current Folder again as an additional guarded location.

2. **Basic is deliberately small.** Basic runs contained in Current Folder,
   with isolated network, no inherited host environment, and a private
   temporary `HOME`. Use it for local inspection and commands whose inputs are
   already in the project. Missing package downloads, credentials, dotfiles,
   or host configuration are expected constraints, not proof the sandbox is
   broken.

3. **Development is contained and profile-bound.** The active Development
   profile supplies its locally admitted tools, environment, grants, and
   network policy. It is the normal access for builds, tests, package managers,
   and other developer tools. Account access requires its separate admitted capability. The Desktop revalidates the same
   Human, relay, profile revision, Current Folder identity, grants, and
   protected policy before execution and continuation.

4. **Full Mac is temporary and separate.** The Human may authorize an
   uncontained Full Mac command through the Desktop. The model cannot activate
   or select it. Full Mac accepts a one-shot pipe only: no `tty` and no later
   stdin. It changes containment only; it never creates a tool, credential,
   account, grant, or developer identity. Ordinary command approval still
   applies.

5. **Local and OS authority remain final.** Protected paths, TCC, SIP, file
   permissions, ACLs, and Current Folder identity are checked locally. A
   denial is the truth. Do not weaken protected paths, broaden access to `/`,
   change profiles without the Human's choice, or use another terminal to
   bypass it.

## Own setup instead of bouncing the Human to a terminal

When developer setup is part of the request, diagnose and perform safe steps
through managed Development execution. Ask for the one exact UI action only
where Human presence is required.

The user-facing surfaces are:

1. **Current Folder** selects the project.
2. **Connections → GitHub** owns GitHub CLI account authentication and its
   clickable browser device flow.
3. **Settings → Workstation** owns Basic, the Development environment session,
   protected access, and temporary Full Mac authorization.

For GitHub work, inspect the available account tools and Connection status first.
An installed `gh` binary or the Human's host login does not prove that a
contained command has authenticated account access. Never copy credentials,
read protected account files, run shell authentication setup, or inject tokens
into a command to bypass the admitted account capability.

When `local_github` is offered, use its `account_status` operation to check the
admitted account instead of running `gh auth status`. Contained commands cannot
read the protected GitHub CLI configuration even when Development exposes the
Human's real home path. Use only the tool's declared account, issue/PR read, and
publishing operations. Publishing retains its separate Human review. It does
not provide arbitrary `gh`, merge, review submission, or authenticated network
Git. If the required operation or account capability is unavailable, report
that precise limitation; do not claim Development enables it. Human account
login and account selection remain in Connections. Ask before switching
accounts or changing healthy account configuration.

For other developer tools, use an already admitted installer only when setup is
part of the Human's request and its writes and network access fit the profile.
State the exact command and target. Do not install a package manager, run
`curl | sh`, request a password, or use `sudo` to overcome missing capability.

## Git and worktrees

Use ordinary Development execution for the complete installed Git CLI,
including read operations and explicitly authorized worktree management. For
`git worktree remove`, prove the exact target first, avoid `--force`, and verify
both registration and directory state afterward.

When `local_git` is actually available, it offers typed `status`, `diff`,
`add`, `commit`, `worktree-add`, and safe broker-created `worktree-remove`.
When the exact authenticated GitHub capability is also available, it adds
GitHub clone, fetch, fast-forward-only pull, and a separately reviewed exact
push. It disables hooks, signing, arbitrary credential helpers, external
filters, redirects, force options, and model-selected remotes. Respect its
`sideEffectStarted` and `retrySafe` result. Never retry an uncertain push.

## Write workstation commands portably

Contained commands run through a POSIX shell with the environment admitted by
the selected access. Basic has no host shell setup. Development may expose the
profile's approved PATH and variables. Write portable shell where possible;
avoid Bash-only arrays, indirect expansion, `shopt`, `mapfile`, and
`BASH_SOURCE`. If Bash is required, invoke it explicitly.

For literal scripts or generated text, use a quoted heredoc delimiter such as
`<<'EOF'` so substitutions and backslashes remain literal. Keep the delimiter
flush-left and unique. For Bash semantics:

```sh
/bin/bash <<'BASH'
set -euo pipefail
# Bash script here. Its contents are literal until the closing marker.
BASH
```

Do not wrap a multiline payload in `/bin/bash -lc '…'`. Nested quoting and
substitution can change meaning before Bash receives it. Never build a shell
program by interpolating untrusted text; pass fixed, validated values as
arguments or environment variables.

## Development file workflow

**Core is an always-present baseline, never the complete inventory.** Top-level
`apply_patch` is core and never needs activation, but its authority and runtime
availability still fail closed. `file` remains an additional/projected,
discoverable filesystem tool providing glob, grep, read, write, and history.
Eligible development requests receive `file` on the first call through the
intent-pack flow. If it is absent, call `discover_tools`, then activate the
eligible filesystem family or `file`; do not patch without file context.

For Current Folder UTF-8 line-oriented source/scripts; Markdown, plain, and extensionless
text; JSON/JSONL/YAML/TOML/INI/dotenv where policy permits; HTML/CSS/XML/text
SVG; and CSV/TSV/SQL/GraphQL/shell, use this order:

`file` glob → grep → read → `apply_patch` → focused `exec_command` verification when available.
If no authorized command tool is available, report verification as not run.

Read first, preserve unrelated dirty changes, reread affected context after the
edit, and verify only the changed behavior. Use `file.write` for one new UTF-8
file, an intentional whole-file replacement, append, or prepend. Use
`apply_patch` for contextual edits or one coherent multi-file text change; keep
simple `file` edit commands for simple edits. Use `file.undo` or
`file.undo_turn` for recovery when available.

Only use these text routes for UTF-8 line-oriented files. Reject non-UTF-8 or
binary content; images, media, fonts, archives, executables, and databases; and
PDF, OOXML, or other container formats. Route those to an appropriate
format-aware tool.

`file.glob`, `file.grep`, and top-level `apply_patch` are Desktop-local and do
not operate on Workspace artifacts. For Workspace, use `file.list` with a
logical path prefix, `file.read` on selected artifacts, and artifact-aware
`file.str_replace`, `file.insert`, `file.write`, `file.move`, or `file.delete`.
Workspace full-text search and multi-file patching are unavailable. The
optional `apply_patch` target selector remains for compatibility, but
`target:"workspace"` returns an unsupported-target error. Prefer
repository-relative Current Folder paths.

Keep every patch coherent and focused. Use about three context lines by default,
and add `@@` class/function anchors when a snippet could be ambiguous. Prefer a
generator, formatter, or script for generated output or a broad mechanical
rewrite when that better expresses the intended change. Never promise atomicity:
a patch can have partial results, so inspect the result and explain recovery. The
model-callable top-level `apply_patch` is different from historical internal
`file.apply_patch(patchId)` staging.

## Managed execution workflow

Before substantive changes, establish one bounded baseline from Current Folder:

```sh
pwd
git rev-parse --show-toplevel 2>/dev/null || true
git status --short 2>/dev/null || true
```

Use a pipe by default. Request `tty: true` only for an interactive contained
Basic or Development command. Full Mac refuses a PTY and subsequent input.

An `exec_command` call may complete or return a live `session_id`. Yielding is
only a response boundary; the process continues. Preserve that id and use
`write_stdin` to read repeatable output, supply permitted PTY input, search
retained output when supported, or cancel. A quiet read is not completion. Do
not restart a build, watcher, or server because one response contained no new
text, and do not use shell backgrounding as a session manager.

Use `cursor` to page retained UTF-8 output and `search.nextSearchCursor` to
continue a literal search. Reads are repeatable. Never resend input after an
uncertain response, and never claim cancellation succeeded until its receipt
confirms cleanup. After a restart, saved final history may be read through
`write_stdin` for a referenced execution, but history recovery never reruns it.
If the optional `read_shell_output` tool is offered, use it only for older
retained shell evidence, not for managed session continuation.

For an interactive local process, request a managed PTY through `exec_command`
and continue it with `write_stdin`. If the Human explicitly hands over their
existing terminal and `human_terminal` is offered, follow its exact
read/run/write receipts and never retry uncertain input.

## Denial and remediation map

| Failure | Meaning | Remediation |
| --- | --- | --- |
| Managed tools absent or local source admission denied | Neither the initiating foreground Desktop nor an exact saved delegation is currently admitted | Say local execution is unavailable here. For delegated work, report the original Mac or source/project permission that needs attention; never substitute another computer or recreate the Task automatically. Continue with admitted file tools only when that still satisfies the request. |
| Current Folder missing, changed, inaccessible, or outside the admitted root | The selected project identity no longer matches | Ask the Human to choose the intended folder in the Files header, then make a fresh call. Do not escape with an absolute `workdir`. |
| Basic command needs network, host configuration, credentials, or developer tooling | Basic intentionally isolates network and uses a private temporary `HOME` | Explain the constraint. If the task needs those capabilities, ask the Human to select the existing Development environment; never smuggle in host state. |
| Development profile, grant, capability, protected policy, relay, or pairing changed | Exact admission went stale | Request fresh access on the current Desktop and retry only after the state is current. Do not fall back to a looser executor. |
| Full Mac rejects `tty` or later input | Full Mac is a temporary one-shot pipe | Reshape only a genuinely noninteractive command as one pipe. If interaction is required, use contained managed execution or an explicitly handed-over terminal when available. |
| `write_stdin` history unavailable | The retained execution/result cannot be authorized or recovered | Report that no command was restarted. Do not rerun a side-effecting command merely to recover output. |
| OS, TCC, SIP, ACL, or protected-path denial | Desktop or the OS denied the operation | Surface the exact denial and offer a non-protected project path. Never request or capture a password and never weaken the boundary. |

## Safety floor

- No `sudo`, password capture, credential-file access, or hidden command tricks.
- No destructive reset, forced push, disk wipe, or deletion of unproved paths.
- State intent and exact targets before mutations.
- Preserve uncommitted Human work and unrelated configuration.
- Never replay a mutation whose outcome is uncertain.
- Never weaken containment or protected paths to make a command pass.
