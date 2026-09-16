---
name: shell-execution
description: One-shot shell command execution via the run_shell relay tool — Current Folder transient project authority, recursive additional roots, the conditional approval workflow, contained Developer Workstation identity, Direct Mac posture, and how it differs from the persistent terminal tool.
requiresTools: [run_shell]
source: official
version: 6
---
# Shell Execution — Skill

Use `run_shell` to execute a **one-shot** shell command on the user's machine and return its stdout/stderr. It is the right pick for bounded development tasks — file operations, git, tests, builds, and any command that finishes on its own: `git status`, `ls`, `bun test`, `rg …`, `cat a file`, etc. For the full mental model of doing development work on the user's machine (Current Folder, grants, profile/session, denial remediation), see the **developer-workstation** skill.

`run_shell` is a **relay tool** — execution goes through the relay protocol, never direct invocation from the cloud graph. That means it only works when a relay is connected:

- A **Nautilo desktop** relay (the Electron app running and attached), OR
- A **standalone `nautilo-relay`** process the user has paired.

If no relay is connected, the call fails at the relay layer — surface that to the user ("I need a connected desktop or standalone relay to run shell commands") rather than retrying.

## How it differs from `terminal`

| Need | Tool |
| --- | --- |
| Run one command, observe bounded live output, get its final result, done | `run_shell` |
| Persistent PTY, interactive REPL, long-running dev server, watching streaming output across multiple calls | `terminal` |

`run_shell` is **observable and one-shot**: the Human can see bounded, sequenced stdout/stderr while the process runs, and the final structured result is canonical. Live progress is read-only observation, not a terminal session: there is no stdin, PTY, background process, or session to come back to. If you need to interact with a prompt, send Ctrl-C, or return to a long-running process across turns, use `terminal` (see the **terminal-sessions** skill). Do not chain `run_shell` calls to fake a session. Note that `terminal` is a **separate path** — a working `terminal` session is not evidence that the profile-bound `run_shell` mount/binding works.

## Results, truncation, and continuation output

Treat every started process exit as data, including a nonzero exit. The final result preserves bounded stdout and stderr plus process disposition such as exit code, signal, timeout, cancellation, duration, and truncation. Do not describe an ordinary nonzero exit as a relay failure, and do not rerun a command merely because it failed before inspecting both streams.

The Human's `run_shell` card opens while the command runs and shows the safely rendered command, Current Folder context, sandbox/workstation mode, elapsed time, and bounded live stdout/stderr. Progress is provisional; the final structured result is the authority if it differs from an in-flight display.

Large output is deliberately bounded. A clipped transcript preview does **not** prove you saw the complete result. When the final receipt includes `outputArtifact.reference`, its existing `capturedBytes`, `totalBytes`, and `truncated` fields are canonical:

- `capturedBytes === totalBytes` and `truncated: false` means the short-lived retained capture contains all output available to Nautilo after redaction and UTF-8 normalization, even though the transcript preview was clipped.
- `capturedBytes < totalBytes` and `truncated: true` means the capture limit was reached and Nautilo retained only a bounded portion of that sanitized output; do not claim omitted bytes were inspected or that the command output was complete.

Use the mutually exclusive `output_artifact` form to inspect retained evidence — never rerun an expensive or side-effecting command merely to recover its output:

1. For a known error, warning, path, or test name, first issue literal search: `output_artifact: { reference, operation: "search", query }`. It returns a bounded set of stdout/stderr matches with **stream-local byte offsets**, combined-artifact offsets, and small context. Search is case-sensitive literal matching, not regex.
2. Inspect the returned context and offsets. A match has `matchOffsetBytes` within its own stream and `artifactOffsetBytes` in the combined retained artifact; page surrounding evidence using `artifactOffsetBytes`, never a stderr `matchOffsetBytes`. Use the existing bounded page form: `output_artifact: { reference, offset_bytes, max_bytes }`. Tail summaries are often near `max(0, capturedBytes - max_bytes)`; use `nextOffsetBytes` only when the next page is genuinely relevant.
3. Use only the pages or searches needed to resolve the conclusion. If decisive output remains outside the retained capture, run a deliberately narrower non-mutating query when appropriate, or state the uncertainty plainly.
4. On a final page you no longer need, set `delete_after_read: true` so the short-lived Desktop-local artifact is removed. Do not use deletion with search.

For example, after a large test command, search literally for `FAIL`, the named test, or an error path; then page around that match if its context is insufficient. For a build whose summary is likely at the end, page the tail rather than walking every preceding page. For a future output-flooding test run where a workspace log is appropriate, preserve its status while showing a bounded tail: `set +e; bun test >.nautilo-test.log 2>&1; status=$?; tail -n 200 .nautilo-test.log; exit "$status"`. That is a deliberate future command shape, not a reason to rerun the current command. Preserve exit-status reasoning when you choose future shell pipelines or filters.

Continuation artifacts are finite, private, bounded, and expiring. Retrieve only what is needed for the diagnosis, never guess or expose the opaque reference, and surface an expired/missing-artifact result rather than rerunning potentially side-effecting work automatically. Only a search continuation error `RUN_SHELL_OUTPUT_ARTIFACT_REQUEST_INVALID` (old Desktop) or `RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_UNSUPPORTED` (a future explicit compatibility result) warrants falling back **exactly once** to the existing offset-page form. `RUN_SHELL_OUTPUT_ARTIFACT_NOT_FOUND` and `RUN_SHELL_OUTPUT_ARTIFACT_UNAVAILABLE` mean the retained data cannot be read; surface that fact rather than paging, retrying search, or rerunning the original command for version skew.

## Approval — conditional, not universal

`run_shell` is registered `trustTier: admin`, `impact: destructive`, `requiresApproval: true`, `approvalLevel: "prove_it"`, requires the Human's `use_workstation` capability, and requires a relay advertising `canRunShell`. **But approval is conditional, not "every call is `prove_it`" and not "no approval":**

- **Full Workstation Mode active:** routine, eligible, profile-bound sandbox `run_shell` attempts may be **auto-admitted** (the server-side admission resolver returns `override: auto`), which **suppresses** the normal `ask`/`prove_it` prompt for that attempt. Auto-admission requires an active exact session and a live admitted+revalidated plan pinning the relay, profile, capability, Current Folder identity, and authority revisions. Server plans carry no filesystem roots: the desktop derives and revalidates authority locally. It is permission to *attempt* execution, not a filesystem claim — the relay, sandbox, and OS still have final say.
- **Full Workstation Mode not active:** normal approval applies. Each call goes to the human **approval dock** (the `prove_it` / ask path) and the operator sees the exact command before it runs. There is no "read-only, auto-approve" path for `run_shell`; if read-probe approval friction is high, batch sensibly into fewer calls.
- **Direct Mac active:** the server may route an otherwise authorized raw
  command through the uncontained host runner after the separate Human/PIN
  ceremony. The model does not select this posture. Critical destruction or
  elevation retains normal approval and hard blocks remain blocked.

When a call does go to the dock, `prove_it` semantics apply: the approved command is what actually executes. Don't reword, reorder, or swap arguments after approval. If the user rejects, stop and ask — don't retry with a tweaked variant unprompted. Use the `terminal` tool's capability-gated allow path only if the user has it enabled — that is a different tool with a different trust model, NOT a way to bypass `run_shell`'s approval.

## Timeout tiers

A blocking `run_shell` holds the turn/lane for the command's whole duration and **cannot survive a server restart**. Caps are enforced:

- **omitted** → relay default (60s).
- **≤ 30 min (1800s)** → used as-is, no justification needed. Pass `timeout_seconds`.
- **30 min – 4 h (14400s)** → allowed ONLY with a `timeout_reason` (≥ 12 chars). The reason is shown to the human approving the command, so make it a real justification — not "because I want to wait."
- **> 4 h** → refused. Long work belongs in the background, not blocking here (durability + lane-hold).

For long-running work (dev servers, watchers, builds that take hours), prefer the **`terminal`** tool's persistent PTY, or run the work in the background and poll — do not try to hold a 3-hour `run_shell`.

## Sandbox / profile / Current Folder constraints

Default `run_shell` is **sandboxed** inside a kernel sandbox (Seatbelt/bubblewrap) built from locally derived authority and the active profile. The selected Current Folder receives transient, locally identity-checked project authority during an active Developer Workstation session; it is not a duplicate durable grant. Additional guarded roots are recursive for their declared operations, with the most-specific explicit grant constraining posture. Protected paths are deny-overrides, and neither broad grants nor server admission bypass identity checks, approvals, OS controls, or instance/profile/relay scoping.

An active Developer Workstation supplies the requesting Human's locally
installed tools and supported locally brokered CLI identity while `run_shell`
remains contained. GitHub support includes `gh`, its API/GraphQL commands, and
authenticated HTTPS Git without mounting the OS home or Keychain database or
copying a credential to the server. A different Keychain-backed CLI requires
its own narrow Desktop broker. Direct Mac changes containment only. It must
never make a tool, credential, Connection, or ordinary workstation capability
appear, and the model never selects it with a tool argument.

The call starts from the user's selected **Current Folder**. Known host paths outside it are not automatically visible just because you know they exist. Do not ask the user to add Current Folder again as an additional guarded root; use one only for an outside-project target. When Full Workstation Mode is active, the call is **exact-plan/profile-bound**: a stale or mismatched plan (session/profile/capability/Current-Folder identity or authority-revision drift, re-pair, server switch) fails closed rather than falling back to a looser path. The sandbox and the OS (TCC/SIP/ACLs/permissions) remain the **final authority** — a denial from either is the truth, not a suggestion. Do not advise weakening protected paths or broadening the boundary to `/` as a workaround.

If you need contained/repeatable execution (e.g. running tests in a fresh checkout), target the right worktree via `cwd` — but `cwd` selects within the authorized boundary; it is not an escape from the Current Folder.

## Workflow

1. Read the live Current Folder from the file surfaces before running; never assume a launch cwd or known repo path.
2. State what you're about to run and why (one line) before the call.
3. Pass `cwd` when the working directory matters; omit only when the default (Current Folder) is fine.
4. Pass `timeout_seconds` only when the command may exceed the 60s default; pass `timeout_reason` only when exceeding the 30 min soft cap.
5. If the operator rejects, stop and ask — don't silently retry with a tweak.
6. If the call fails with a relay-not-connected error, tell the user to connect a desktop or standalone relay; don't loop.
7. If a denial names the Current Folder, the profile/binding, or the OS, surface it and propose the exact remediation (see the **developer-workstation** denial map) — never widen the boundary as a workaround.
