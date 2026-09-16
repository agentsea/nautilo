---
name: developer-workstation
description: Set up and perform development through run_shell — Current Folder as locally identity-checked transient project authority, recursive additional grants, the active contained Developer Workstation identity, and the separately authorized Direct Mac containment relaxation. Install and configure required developer CLIs when authorized; teach tool decisions, approvals, and precise remediation without weakening protected boundaries.
requiresTools: [run_shell, apply_patch]
source: official
version: 9
---
# Developer Workstation — Skill

Use this skill when the user wants you to do real development work on their
machine: read or edit code, run git, run tests, build, or inspect a project.
The workhorse tool is `run_shell`. Nautilo derives its execution posture from
the requesting Human's live Desktop authority: ordinary Developer Workstation
commands remain contained, while separately activated Direct Mac removes that
containment. The model does not choose a lane. This skill teaches the mental
model that keeps that work safe and honest, the development-file workflow, the
decision of when to reach for `run_shell` vs. the persistent `terminal`, and
how to read denials without weakening the protections that keep the user's
machine intact.

Use the structured `file` surface to discover, search, read, and edit project
bytes. Core tools are only the always-present baseline, not the complete
catalog. If `file` is not currently callable, use `discover_tools` with the
`filesystem` family and activate it before proceeding; never treat a visible
core `apply_patch` as the only file capability.

## The mental model — five things that are true at once

1. **Current Folder is the selected project, not a second grant.** `run_shell`
   starts from the user's selected **Current Folder** — the folder shown in the
   Files header. With an active Developer Workstation session, the desktop
   locally identity-checks transient authority for that canonical root and its
   safe descendants. Do not tell the user to add the same project again as a
   guarded location. Known host paths *outside* Current Folder are not
   automatically visible just because you know they exist; use an additional
   root only when the target is genuinely outside Current Folder and Genie
   Workspace.

2. **Additional grants are recursive local capabilities, not your say-so.** A
   grant root covers its safe canonical descendants only for its declared
   operations. The most-specific explicit grant constrains the posture; it
   does not silently upgrade a read grant to write, delete, or execute. The
   desktop relay revalidates subject, operation, canonical identity, and the
   active `(instance, profile, relay)` tuple on every dispatch. Protected paths
   are deny-overrides: a broad grant never bypasses protected-path policy,
   approvals, OS controls, or identity checks.

3. **The active profile/session binds the call exactly.** When **Full
   Workstation Mode** is active, a `run_shell` attempt is admitted only against
   the **exact** active session + plan: the same relay, profile id+revision,
   capability, Current Folder identity, and relevant authority revisions the
   user activated. Server plans carry no filesystem roots; the desktop derives
   and revalidates local authority. A stale or mismatched plan fails closed —
   it does not fall back to a looser path. Outside Full Mode, there is no such
   plan and normal approval applies (see below).

4. **Workstation identity is available while contained.** An active Developer
   Workstation gives `run_shell` the requesting Human's approved local tools,
   PATH, and supported locally brokered CLI identity while the command remains
   inside Seatbelt/bubblewrap. GitHub support includes full `gh`, `gh api`,
   GraphQL, and authenticated HTTPS Git. Pass only the command; Nautilo derives
   the host and containment posture from live Human authority. A different
   Keychain-backed CLI needs its own narrow Desktop identity broker; Direct Mac
   must never be the feature gate for that identity.

5. **The selected boundary and the OS are final authority.** Developer
   Workstation uses a real containment boundary (Seatbelt/bubblewrap). Direct
   Mac is the separate, Human-activated posture that removes it; Direct Mac
   changes containment only and must never unlock a tool or credential. The OS
   (TCC, SIP, file permissions, ACLs) remains authoritative in both postures. A
   denial is the truth, not a suggestion. Surface it plainly; do **not**
   advise weakening protected paths or broadening the boundary to `/` as a
   workaround — those denies are load-bearing and stay.

## Own setup instead of bouncing the user to a terminal

When the user asks for GitHub or developer work, missing setup is part of the
task. Do not stop at “install `gh`,” “authenticate in a terminal,” or a generic
documentation link. Diagnose the missing layer, perform every step that can be
performed safely through `run_shell`, and give the user the one exact UI action
only where their presence is required.

The user-facing model has three surfaces:

1. **Current Folder** selects the repository or project Genie will work in. An
   active Developer Workstation session supplies its transient, locally
   identity-checked project authority; it is not an additional guarded
   location.
2. **Connections → GitHub** owns GitHub CLI installation/authentication status
   and the clickable browser device flow.
3. **Settings → Workstation** is the single place to review protected access,
   the Developer environment session, and Host command access. Host command
   consent is normally requested at first use; the user does not need to
   preconfigure it before asking for work.

For a GitHub setup or a GitHub task whose prerequisites are unknown:

1. Run a single non-destructive workstation preflight:

   ```sh
   command -v gh 2>/dev/null || true
   gh --version 2>/dev/null || true
   gh auth status 2>&1 || true
   git --version 2>/dev/null || true
   ```

   Pass the command normally. With Developer Workstation active it sees the
   approved host PATH and brokered GitHub identity while remaining contained.
   Explain that normal command approval and the Current Folder boundary still
   apply.

2. If `gh` is missing, install it rather than merely instructing the user to do
   so when a supported, already-installed package manager is available. Detect
   the platform and package manager first. On macOS, prefer the normal
   Homebrew package:

   ```sh
   brew install gh
   ```

   State the exact install command before invoking it and let the normal
   approval flow authorize it. Do not use `curl | sh`, invent an unofficial
   binary source, install a package manager, invoke `sudo`, or request an
   administrator password. If no safe existing package manager is available,
   explain the missing prerequisite and give the official platform-specific
   installation action; do not silently substitute a weaker GitHub
   implementation.

3. If `gh` is installed but signed out, direct the user to
   **Connections → GitHub → Sign in to GitHub**. Nautilo opens GitHub in the
   external browser and displays the copyable one-time code. Tell the user
   exactly what will happen, then wait for them to finish the GitHub page.
   Never ask them to open a terminal or manually type a hidden credential.

4. After authentication, refresh the connection and verify the real host
   account through workstation execution:

   ```sh
   gh auth status
   gh api user --jq .login
   ```

   If authenticated Git transport is part of the task, run
   `gh auth setup-git` with normal approval, then verify the intended remote
   without rewriting unrelated remotes or changing the user's chosen
   HTTPS/SSH protocol.

5. Continue the original task. Setup is not the deliverable unless that is all
   the user requested. Full `gh`, `gh api`, GraphQL, Git, releases, pull
   requests, issues, Actions, and worktrees are available; do not degrade the
workflow to a hand-maintained subset.

### Full Git and worktrees use contained Developer Workstation identity

For the user's existing repositories, branches, and worktrees, use a raw
`run_shell` command. With Developer Workstation active it sees the host Git
installation, repository-visible configuration, the brokered GitHub HTTPS
credential helper, sibling worktrees, and every Git subcommand while remaining
contained. It is also the correct
path for an explicitly approved `git worktree remove` of an existing worktree.
Run the safety proof first, show the exact targets, use plain
`git worktree remove <exact-path>` without `--force`, and verify registration
and folder removal afterward.

The structured `run_shell.git` variant is a separate, narrow GitBroker
workflow. It requires an active Full Workstation profile binding, and its
`worktree-remove` operation is only for a broker-created worktree. Do not use
it to manage pre-existing host worktrees. If it returns
`RUN_SHELL_GIT_REQUIRES_BINDING`, do not loop or ask the user to add Current
Folder as a duplicate guarded location. Re-activate the current Developer
Workstation session if structured Git is required, or use the raw Git command
for the full existing-repository workflow. A target outside the
Current Folder project still requires an additional guarded root.

### Write workstation commands portably

Contained commands run through a POSIX shell with the trusted workstation PATH
and approved CLI configuration. Write portable shell where possible: avoid
Bash-only arrays, indirect expansion, `shopt`, `mapfile`, and `BASH_SOURCE`; if
Bash is truly required, invoke it explicitly and make that dependency clear.
Direct Mac currently uses the host login shell, but commands must not depend on
Direct Mac merely to discover a tool or credential.

For literal scripts or generated content, use a quoted heredoc delimiter — for
example `<<'EOF'` — so shell expansion, command substitution, and backslashes
remain literal. Keep the delimiter flush-left and unique. Do not escape a
whole command string into unreadability; send the intended multiline command
directly and let normal approval show its exact bytes. When Bash semantics are
actually required, use a literal heredoc directly:

```sh
/bin/bash <<'BASH'
set -euo pipefail
# Bash script here. Its contents are literal until the closing marker.
BASH
```

Do not wrap a multiline payload in `/bin/bash -lc '…'`: nested quotes,
substitutions, and user-controlled paths become fragile or change meaning
before Bash receives them. Never construct a shell program by interpolating
untrusted text; pass fixed, validated values as arguments or environment
variables.

If an existing GitHub login or Git configuration is healthy, preserve it. Do
not reauthenticate, switch accounts, rewrite global Git configuration, or
replace credential helpers without a concrete need and the user's approval.
For multiple GitHub accounts, account selection is explicit; report the active
host/account and ask before switching.

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

`file` glob → grep → read → `apply_patch` → focused `run_shell` verification.

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

## Tool decision

| Need | Tool |
| --- | --- |
| Find Current Folder files by path pattern | `file.glob` |
| Search Current Folder file contents | `file.grep` |
| Enumerate Workspace artifacts | `file.list` with a logical path prefix |
| Inspect Workspace contents | `file.read` on selected artifacts |
| Inspect exact bytes and context | `file.read` |
| Create a new file or intentionally replace a complete file | `file.write` |
| Surgical contextual edit across one or more text files | `apply_patch` when callable; otherwise focused `file` edit commands |
| Bounded development with approved host tools and credentials inside project containment | `run_shell` with Developer Workstation active |
| Remove Nautilo shell containment for an otherwise authorized command | Human activates Direct Mac; the model still calls ordinary `run_shell` |
| Persistent interactive PTY: long-running dev server, watcher, REPL, TUI, streaming output across calls | `terminal` (only if available) |
| Structured edits to a file you can already see | a file-editing tool, if one is available |

Prefer `run_shell` for anything that finishes on its own. Reach for
`terminal` only for genuinely long-running or interactive work, and only when
it is available — Member users may have `run_shell` without `terminal`, and
that is fine: `run_shell` covers bounded development on its own.

For Current Folder code changes, inspect before editing: `file.glob` → `file.grep` →
`file.read` → `apply_patch` (or a focused `file.str_replace`) → `run_shell`.
Use `file.write` for new files and deliberate whole-file replacement, not for a
surgical change to an existing file. Search results are pages: when
`truncated:true`, narrow the path/pattern/query or request a larger explicit
limit. Do not substitute shell `find`, shell `grep`, or ad hoc scripts for the
structured file tools when those tools are callable.

**`terminal` is a separate path, not evidence for `run_shell`.** A working
`terminal` session does **not** prove that the profile-bound `run_shell`
mount/binding works — they are different capabilities with different
validation. Do not use a `terminal` session as a substitute for a `run_shell`
baseline, and do not infer `run_shell` reach from what `terminal` can see.

## Preflight — establish the ground truth before commands

Before running anything, read the current file surfaces (the Files header,
the open/recently-viewed files) to learn the **live** Current Folder and the
repo you are actually in. **Never assume** a launch cwd or a known repo path
from memory — the user may have switched folders, and a wrong guess wastes a
turn or touches the wrong tree.

If the Current Folder is wrong for the work the user asked for (for example, it
points at a temp/system folder while the user wants a project repo), **stop and
tell the user the exact UI action**: open the **Files header → Open folder**
control (or the **Current Folder** control) and pick the project folder, then
tell you to continue. **Wait** for them to confirm — do not fire commands
against a folder you guessed.

Once the Current Folder is the right one, run **one batched, non-destructive
`run_shell` baseline** to pin the ground truth. Combine reads into a single
call rather than firing many:

```sh
pwd && git rev-parse --show-toplevel 2>/dev/null && git status --short 2>/dev/null; node --version 2>/dev/null; bun --version 2>/dev/null
```

This confirms: the actual cwd, the git repo root (so you know the project
boundary), the working-tree state, and the runtimes present. Use `run_shell`
for the baseline — **do not use `terminal`** for it. A baseline is one-shot and
bounded; that is exactly what `run_shell` is for.

## Approval — conditional, not universal

`run_shell` is a high-impact relay tool: by default each call goes through
Nautilo's approval path (the `prove_it` / ask dock), and the operator sees the
exact command. **This is not universal `prove_it` on every call, and it is not
"no approval".** Three real states:

- **Full Workstation Mode active:** routine, eligible, profile-bound sandbox
  `run_shell` attempts may be **auto-admitted** (the server-side admission
  resolver returns `override: auto`), which **suppresses** the normal
  `ask`/`prove_it` prompt for that attempt. Auto-admission requires an active
  exact session *and* a live admitted+revalidated plan pinning the relay +
  profile + capability + Current Folder identity and authority revisions. It
  is permission to attempt, not a filesystem claim — the relay still derives
  authority locally and the sandbox/OS still have final say.
- **Full Workstation Mode not active:** normal approval applies. Reads and
  writes go through the same approval path; there is no "read-only,
  auto-approve" special case for `run_shell`. If approval friction is high,
  batch sensibly into fewer calls rather than churning many small probes.
- **Direct Mac active:** the server may route an otherwise authorized command
  through the uncontained host runner after the separate Human/PIN ceremony.
  The model does not select this posture. Critical destruction or elevation
  retains normal approval and hard blocks remain blocked.

For GitHub authentication, follow the setup workflow above. Connections →
GitHub runs the official `gh auth login --web` device flow, opens GitHub's
fixed device page in the external browser, and presents a copyable code. Once
authenticated, use ordinary `run_shell` for the full CLI; do not invent a
GitHub subset or ask the user to drive a terminal.

Write commands that are self-explanatory and safe to read — no obfuscation, no
clever piping that hides what runs. If the operator rejects, stop and ask; do
not retry with a tweaked variant unprompted.

## Denial / remediation map

When a `run_shell` call fails, read the message and map it to the right
remediation. **Never** respond to any denial by widening the boundary to `/`,
disabling protected paths, or asking the user to weaken security. The right
fix is almost always "pick the right Current Folder" or "the OS said no,
surface it."

Shell and terminal access combines the Human's `use_workstation` authority with
the live relay capability required by the specific tool. A connected relay does
not grant either Human authority or a different workstation mode.

| Failure (what you see) | What it means | Remediation |
| --- | --- | --- |
| `requires a connected relay with canRunShell` / relay-not-connected | No relay is connected for this user, or it dropped mid-run | Tell the user to connect the desktop app or run `nautilo-relay`; do not loop. |
| `requires relay capability "canRunShell" not available` (tool not bound) | The Human has `use_workstation`, but no connected relay can execute shell commands | Tell the user to connect a shell-capable desktop or standalone relay; do not attempt to bypass. |
| `Current Folder is unusable for run_shell: <cwd> is not a directory` / `cannot access <cwd> (<code>)` / `the sandbox cannot access <cwd>` | The selected Current Folder is not a usable directory, or the sandbox/OS cannot reach it (e.g. a `/System/Volumes/...` temp or system path) | Tell the user the **exact** UI action: Files header → Open folder (or the Current Folder control) → pick a normal user directory (e.g. a folder in the home directory); then retry. Do not pass a different `cwd` to escape it. |
| `cannot run on Full Workstation relay <id> without a valid plan-bound shell binding` (agent-side) or relay `errorCode: "WORKSTATION_SHELL_BINDING_REQUIRED"` | A Full-Workstation-eligible relay received an unbound generic shell, or the plan is missing/stale (session/profile/capability revision drift, re-pair, server switch) | Tell the user to **re-approve / re-activate** the operation on the currently bound workstation relay (re-PIN Full Workstation Mode if it cleared). Do not retry the same unbound call. |
| `error retrieving current directory: getcwd: ... operation not permitted` (EPERM) | The sandbox cannot access the cwd at execution time | Same as the Current Folder row: pick a usable Current Folder and retry. |
| Protected-path denial (command refused at execution; credential/Nautilo/system paths) | The command touched a protected path; deny-overrides are compiled into the sandbox | Do not attempt to work around it. Tell the user the path is protected by design; offer a non-protected alternative path inside the Current Folder. |
| Direct Mac activation/consent denied | The user did not activate the optional uncontained posture | Do not retry or treat it as missing tool authority. Continue through contained Developer Workstation unless the requested operation genuinely requires containment to be removed. |
| Uncontained workstation executor unavailable | The connected desktop cannot provide Direct Mac | Continue through contained Developer Workstation when possible; ask the user to update/connect Nautilo Desktop only when Direct Mac itself is required. |
| `RUN_SHELL_GIT_REQUIRES_BINDING` / `an unbound structured git dispatch is refused` | The narrow typed GitBroker lacks a current active Workstation binding; it is not the general raw Git path | Re-activate the current Developer Workstation session if the structured subset is needed, or use raw `command` for full Git. Do not retry blindly or ask the user to add Current Folder as a duplicate grant. An outside-project target needs an additional root. |
| OS / TCC / SIP / ACL denial (e.g. macOS prompts for Keychain, "operation not permitted" on a system path) | The OS — not Nautilo — denied the operation, or requires the user's own credential | Surface it plainly. macOS may prompt the user; **never** read, type, or capture the user's password or credential. Offer a path that does not need the OS grant. |

## Interactive teacher behavior

When you act under this skill, narrate the work so the user can follow and
correct:

1. **State intent** before the call — one line: what you're about to run and
   why, and which folder it targets.
2. **Summarize the result** — what the baseline/probe told you, in terms of the
   project (repo root, branch state, runtimes), not raw command noise.
3. **Differentiate the failure class** — is it *product config* (Current Folder,
   capability, relay, Full Mode session), *OS denial* (TCC/SIP/ACL/permissions),
   or *command failure* (non-zero exit, bad args)? They have different fixes.
4. **Propose the exact next user action** — name the UI control or the
   re-approval step; don't gesture vaguely at "try again".
5. **Stop retry loops** — if the same denial recurs, do not re-fire the same
   command. Surface the denial, propose the remediation, and wait for the
   user.

## Terminal rules (when `terminal` is available)

If you do reach for `terminal`, keep it disciplined — it is a **separate
persistent PTY path**, not a second `run_shell`:

- **Spawn with the selected Current Folder only** — pass `cwd` explicitly to
  `spawn` so the session starts inside the project boundary; do not spawn
  against a guessed path.
- **Re-list after spawn if uncertain** — a spawned PTY may **exit immediately**
  (bad cwd, missing binary, login-shell quirk). Do not assume the returned
  `session_id` is still live; call `list` (or `read`) to confirm before driving
  it.
- **Dead session ⇒ report, then respawn once** after fixing the cwd. Do not
  loop-spawn against the same broken path.
- **Kill when done** — clean up dev servers / REPLs; don't leave sessions
  dangling for the user.
- **Terminal is separate from `run_shell` validation** — a `terminal` session
  working (or not) says nothing about whether the profile-bound `run_shell`
  binding/mount works. Do not use `terminal` as evidence for `run_shell`
  reach, and do not use it for the one-shot baseline.

## Safety floor

- **No `sudo`, no password capture, no credential paths.** If the OS prompts
  for a credential, the user types it — never you.
- **No critical destruction.** Do not run commands that destroy the user's
  work or system (`rm -rf /`, `git reset --hard` against uncommitted work,
  forced pushes, disk wipes). State intent plainly and let the user approve.
- **No hidden command tricks.** No obfuscation, no smuggling destructive
  actions inside a "read" command, no aliasing/piping that hides what runs.
- **No boundary weakening as a workaround.** A denial from the sandbox, a
  protected path, or the OS is final for that call. Fix the Current Folder or
  the profile; never advise broadening to `/` or disabling protected paths.
