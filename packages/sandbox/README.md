# @nautilo/sandbox

OS-level sandbox containment for LLM-emitted shell commands. Wraps `run_shell`
invocations in **bubblewrap** (Linux) or **sandbox-exec** (macOS) before they
ever reach the kernel.

This is defense-in-depth — layered *below* the severity resolver + zone
resolver + approval flow (D053, D061). If every higher-gate fails open and
the model emits `rm -rf ~`, the sandbox is the last line of defense that
makes the syscall impossible.

## What lives here

- **`Sandbox`** — shape + per-project config (workspace path, data dir,
  prompt allowlists). One instance per long-lived process. Loads
  lazily, then `refreshProjectPaths()` is called when the user
  switches projects.
- **`sandbox.wrap(program, args, cwd, env)`** — the dispatch point.
  Returns `{ program, args, cwd, env }` ready for `child_process.spawn()`.
  Backend is selected by `SandboxMode` × OS (see matrix below).
- **`spawnSandboxed()`** — convenience wrapper: wrap + spawn + stream
  capture + timeout + byte-cap. What callers actually consume.
- **`detectBackend()`** — runtime backend probe (bwrap binary + /proc
  support on Linux, sandbox-exec binary on Darwin). Cached per process.
- **Env-var taxonomy** — `SAFE_ENV_VARS` / `RESERVED_ENV_VARS` /
  `DANGEROUS_ENV_VARS` + classifiers. Bubblewrap uses
  `--clearenv` then selectively re-injects; passthrough enforces the
  same filter explicitly.
- **`sandboxPolicyForLevel(level)`** — maps `SecurityLevel` → `SandboxMode`
  (`workspace-containment` | `passthrough`) and `failIfNoBackend` flag.
  Paranoid fails loud when the backend is missing; every other level
  degrades to passthrough with a warning.

## Who uses this

- **Desktop's `relay-dispatch/local-dispatch-policy.ts`** +
  **`bin/nautilo-relay`** — use `resolveRelayDispatchSandbox()` for the
  per-turn policy-envelope decision, then keep dispatch execution and
  `Sandbox.close()` ownership locally. The server builds `sandboxProfile` from
  its Policy Resolver and `config.toml [security]` section. Production refuses
  a missing envelope; development receives one warning and a disabled sandbox
  rooted by its caller.
- **`bin/nautilo-server`** — the Policy Resolver lives here and
  invokes the deployment-profile helpers (`serverRestrictive` /
  `desktopPermissive` / `desktopLocked`) based on the Server's
  `deployment_mode` to produce the envelope.
- **`scripts/security-test-env/setup-linux.sh`** — installs
  bubblewrap inside the Lima VM used by the D063 smoke matrix.

## Backend matrix

| Mode / OS                  | Linux          | macOS           | Other            |
|----------------------------|----------------|-----------------|------------------|
| `workspace-containment`    | bubblewrap     | sandbox-exec    | passthrough+warn |
| `passthrough`              | passthrough    | passthrough     | passthrough      |

Both `bubblewrap` and `sandbox-exec` are live. Other platforms
(Windows etc.) fall back to passthrough + warn unless
`failIfNoBackend=true` — Windows support is out of scope for v1.

## Security-level → mode mapping

| SecurityLevel | Mode                   | failIfNoBackend |
|---------------|------------------------|-----------------|
| `yolo`        | passthrough            | false           |
| `permissive`  | passthrough            | false           |
| `standard`    | workspace-containment  | false           |
| `cautious`    | workspace-containment  | false           |
| `paranoid`    | workspace-containment  | **true**        |

**HOME inside the sandbox = workspace.** Every tool that reads
`$HOME` (npm, pip, python, bash, vim, etc.) sees the workspace
directory, not the real user home. This keeps HOME-relative reads
inside the writable scope the sandbox allows. Side effect:
interactive shells + history-keeping tools will scribble their
dotfiles (`.bash_history`, `.viminfo`, `.python_history`, etc.)
into the workspace directory. Matches Spacebot's port semantic;
the alternative (leaking the real HOME) is substantially worse.
If this matters for a specific workflow, add the dotfile paths to
a project-level `.gitignore` or use a fresh worktree.

## Paranoid fail-loud behavior

Paranoid's fail-loud behavior: if the backend is unavailable
(`bwrap` not on PATH on Linux, or `/proc` unsupported in the kernel),
`Sandbox.wrap()` throws. No silent downgrade. Every other level logs a
warning and continues in passthrough — containment is a
defense-in-depth layer, not the only gate, so loud-fail would actively
break desktop usage in exchange for protection the user already rejected
by choosing a lower level.

## Quick usage

```ts
import {
  Sandbox,
  spawnSandboxed,
  sandboxPolicyForLevel,
  detectBackend,
} from "@nautilo/sandbox";

const backend = await detectBackend();
const policy = sandboxPolicyForLevel("standard");
const sandbox = await Sandbox.create({
  backend,
  mode: policy.mode,
  failIfNoBackend: policy.failIfNoBackend,
  projectRoot: "/home/me/my-project",
  workspacePath: "/home/me/my-project",
  dataDir: "/home/me/.nautilo",
});

const result = await spawnSandboxed(sandbox, "/bin/sh", ["-c", "ls -la"], {
  cwd: "/home/me/my-project",
  timeoutMs: 10_000,
});
// → { stdout, stderr, exitCode, timedOut, signal }
```

## Environment variables

> **Release builds do not honor policy-affecting env vars.** Security posture
> (`deployment_mode`, `security_level`) is stored in server `config.toml`
> and mutated via the Settings UI with `manage_server_security` Capability
> + PIN confirmation + audit log. See the security ship plan §1.3 and §5.6.

| Var                         | Purpose                                                  | Build mode |
|-----------------------------|----------------------------------------------------------|------------|
| `NAUTILO_TEST_MODE_ONLY=1`  | Server boots without DB/seed/policy — for in-VM smoke tests only. | dev only — hard-panic if set in production build |
| `NAUTILO_TEST_MODE=1`       | Enables `/api/test/*` routes when bearer-token-authenticated. | dev only — hard-panic if set in production build |
| `NAUTILO_TEST_TOKEN`        | Bearer token for `/api/test/*` (required if TEST_MODE=1).| dev only — hard-panic if set in production build |

Previously shipped env vars that have been **deleted** in D060
Sprint 1 (security ship plan G5.6): `NAUTILO_SANDBOX_RELAY`,
`NAUTILO_SECURITY_LEVEL`, `NAUTILO_TLS`. These were policy-affecting
bypass surfaces — an agent prompt-injection-socially-engineering
the user into unsetting them would silently weaken the sandbox. Gone.

## Env-var taxonomy (bubblewrap + passthrough)

| Set                    | Examples                                    | Behavior                    |
|------------------------|---------------------------------------------|-----------------------------|
| `SAFE_ENV_VARS`        | `PATH`, `HOME`, `USER`, `LANG`, `TERM`, …   | Forwarded / re-injected     |
| `RESERVED_ENV_VARS`    | `NAUTILO_*` family                          | Stripped — agent internals  |
| `DANGEROUS_ENV_VARS`   | `LD_PRELOAD`, `DYLD_*`, `AWS_*`, `GH_TOKEN`, …| Stripped unconditionally   |

Ported from Spacebot's env taxonomy (`EXTERNAL/spacebot/src/sandbox/env_vars.rs`)
with the `NAUTILO_*` reservation added. Predicates are exported
(`isReservedEnvVar`, `isDangerousEnvVar`) so the relay can assert
before spawn.

## File layout

| File                 | Purpose                                                         |
|----------------------|-----------------------------------------------------------------|
| `types.ts`           | `SandboxMode`, `SandboxBackend`, `SandboxConfig`, `SpawnArgs`   |
| `paths.ts`           | Canonicalize, realpath-or-self, unique-push, `/var` quirk doc   |
| `env-vars.ts`        | Env taxonomy constants + `isReservedEnvVar` / `isDangerousEnvVar` |
| `system-paths.ts`    | Linux + macOS read-only system paths (ported from Spacebot)     |
| `detect.ts`          | `detectBackend()` — binary + `/proc` probe, cached              |
| `sandbox.ts`         | `Sandbox` class — config, path accessors, `wrap()` dispatcher   |
| `bubblewrap.ts`      | `buildBubblewrap()` — 15-step mount-order arg builder           |
| `passthrough.ts`     | `buildPassthrough()` — no-containment spawn, env filter enforced|
| `seatbelt-profile.ts`| `buildSbplProfile()` — SBPL generator (base scaffold + workspace + governance denies + secret regex + worktree auto-detect) |
| `seatbelt.ts`        | `buildSandboxExec()` — wraps profile + env-map spawn args for `/usr/bin/sandbox-exec` |
| `security-level.ts`  | `sandboxPolicyForLevel()` + `failIfNoBackend` policy            |
| `relay-dispatch-policy.ts` | Shared envelope resolution + Current Folder error helpers; never executes or closes a sandbox |
| `spawn.ts`           | `spawnSandboxed()` — wrap + spawn + stream capture + timeout    |
| `index.ts`           | Public exports                                                  |

## Tests

```bash
bun run --filter @nautilo/sandbox test
```

Unit tests cover every arg builder (bubblewrap + Seatbelt/SBPL),
env-taxonomy predicates, detect-backend branches (each errno path),
security-level mapping, `spawnSandboxed()` stream capture + timeout,
SBPL escape helpers + profile-ordering invariants (deny-after-allow
for governance files, secret regex anchoring, git worktree
auto-detect), and runtime dispatch.

The live-VM `SANDBOX-LINUX-*` / `SANDBOX-MACOS-*` smoke matrices
land in a follow-up — the current server-side `/api/test/tool-invoke`
endpoint doesn't yet route `run_shell` through `@nautilo/sandbox`
(run_shell today is Electron-main-process only via the relay). The
Seatbelt profile generator IS live-validated against real
`/usr/bin/sandbox-exec` on Darwin hosts as part of this phase's
ad-hoc validation (see the phase-2 task doc).

Runtime validation on Darwin (profile parses + blocks expected paths):

```
PASS  write /etc/foo            → BLOCKED (exit 1)
PASS  write $HOME/.ssh/id_rsa   → BLOCKED (exit 1, honeypot path)
PASS  read /etc/hosts           → ALLOWED (base profile)
PASS  workspace touch           → ALLOWED
```

### Darwin-gated live regression tests — pre-merge discipline

`packages/sandbox/tests/unit/seatbelt-profile.test.ts` contains three
live `sandbox-exec` regression tests (gated on `process.platform ===
"darwin"` + `existsSync("/usr/bin/sandbox-exec")`). They plant real
`.env` / `.secret` / `credentials` fixtures, invoke the sandbox
against them, and assert the expected BLOCKED / ALLOWED outcomes.

**These tests skip silently on Linux CI.** That's correct — the
`sandbox-exec` binary only exists on Darwin — but it means CI
green does not imply the Seatbelt profile is actually blocking the
right things at runtime. The SEC-1 regression (commit `755ffec`:
secret-regex was silently inert due to Scheme-reader escape drift)
would have shipped CI-green under the byte-shape unit tests alone.

**Operator discipline — MUST run before merging any change to
`seatbelt-profile.ts`, `seatbelt.ts`, or `paths.ts`:**

```bash
# On a Darwin host (local dev machine, Tart VM, or macOS runner):
bun test packages/sandbox/tests/unit/seatbelt-profile.test.ts
```

Look for the `LIVE sandbox-exec regression (Darwin only)` describe
block in the output — it should report 3 `(pass)` entries, NOT
`(skip)`. If you see skips, you're running on a non-Darwin host and
the runtime invariants are unverified.

The Darwin-host run verifies the platform reader semantics; a unit pass on
another platform does not establish this behavior.

## Prior art

The Linux bubblewrap arg builder is a port of Spacebot's
`sandbox/linux.rs` (`EXTERNAL/spacebot/src/sandbox/linux.rs`) — same
15-step mount order (tmpfs, /proc, /dev, bind workspace RW, system
paths RO, clear env, setenv selected, seccomp-ready hook). Preserve upstream attribution when changing the adapter.

## Related

- [Security test environment](../../scripts/security-test-env/README.md)
- [Security policy](../../SECURITY.md)
