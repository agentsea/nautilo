# Nautilo Desktop — Production architecture lock

> Status: Living document, owner: desktop maintainers. Architecture baseline: 2026-05-12 (**D134** connect-to-server rescope); contributor packaging guidance updated 2026-09-12.
>
> **Audience**: anyone shipping changes to `apps/desktop/`. The README explains how to run dev mode; this document is the **production contract** every change must respect. If a code change appears to violate something here, either the change needs revision or this document needs revision — never silently diverge.
>
> **For build/package/smoke commands**, see the [Desktop README](README.md),
> [package manifest](PACKAGE-MANIFEST.md), [packaging and artifact trust](PACKAGING.md), and
> the scripts in `apps/desktop/package.json`. Public installation guidance lives
> at [Nautilo.ai](https://nautilo.ai/docs/use/install-and-connect).

## Architecture (connect-to-server)

**Binding contract (2026-05-12 rescope; D516 artifact update):** The packaged Electron app is a **connect-to-server client**. It does not bundle, spawn, or manage `nautilo-server`, Postgres, Logto, Docker, or database migrations. The shipped `.app` contains Electron main + preload bundles, the first-run picker UI, the onboarding wizard UI, brand assets, and a **vendored Bun runtime** used only where IPC tooling shells out to Bun. On macOS it also contains the first-party signed Computer Use Host, its qualified CUA driver, and the narrow screen-recording permission helper; Electron attests and brokers those artifacts but does not own CUA semantics. End users always pair with an operator-owned Nautilo server URL; the Workbench SPA is loaded from that server’s `<serverUrl>/` route (static assets live in the **server** package, not the desktop bundle).

**Multi-instance (D133):** The client is not welded to one server for life; it pairs to **N** servers and switches between them. That product shape is a load-bearing reason the retired “bundle/spawn a child server inside the desktop app” path was the wrong architecture.

**Authoritative references** (read before contradicting this file):
- [Package manifest](PACKAGE-MANIFEST.md)
- [Packaging and artifact trust](PACKAGING.md)
- [Workspace rule — Electron architecture](../../.cursor/rules/electron-architecture.mdc)

The historical **packaged-local** experiment (Electron spawning `bin/nautilo-server`, dynamic loopback port via child stdout, Workbench from `extraResources`, `NAUTILO_DESKTOP_MODE=local`, etc.) is **retired** — see D134 and the phase-9 record for rationale.

## 1. Runtime modes

The Electron shell is described here in **two** runtime modes. Mode resolution in `electron/main.ts` determines which preload loads, which origin the main window sees, which URL policy applies, and which security gates engage. (A future hosted “cloud” picker branch may exist in code but remains disabled until an explicit product decision ships it.)

| Mode | Trigger | What loads | Workbench / API origin | Status |
|---|---|---|---|---|
| **dev-from-source** | `!app.isPackaged` (typical: `bun dev` / Vite) without forcing a packaged-style URL override | Workbench from the Vite dev server; API against the dev Nautilo server URL from `@nautilo/config` (`resolveDevServerUrl()` and related helpers in `constants.ts`) | Developer machine — **not shipped** to end users | Maintainer daily driver |
| **connect** | `app.isPackaged` with pairing from the first-run picker (persisted config), and/or `NAUTILO_CONNECT_SERVER_URL=...` for automation | Main window loads Workbench from the **paired** server’s `/`; APIs and static assets share that origin | Operator-managed server URL (HTTPS typical off-loopback) | **Only end-user production mode** |

**Why two modes matter:** dev-from-source trusts the developer toolchain (Vite injects at runtime) and must **never** be confused with what ships to users. **connect** is third-party trust: the user (or org) chose the server URL; version-compat and navigation containment (§6) apply there.

**Selection rule:** mode resolution NEVER uses `NODE_ENV` as the release signal (see §9). At a high level, the signal hierarchy is:

1. `NAUTILO_FORCE_FIRST_RUN=1` → re-run first-run picker where supported (developer escape hatch)
2. `app.isPackaged === false` with normal dev scripts → **dev-from-source**
3. `NAUTILO_CONNECT_SERVER_URL` set (e.g. CI/smoke) → **connect** semantics against that base URL
4. Packaged app → persisted pairing / first-run flow yields **connect** against the chosen server URL(s); see D133 for switching among multiple saved servers

## 2. Port policy per mode

| Mode | Port / URL | Source of truth | Why |
|---|---|---|---|
| dev-from-source | predictable defaults (e.g. workbench + server ports from `@nautilo/config` `resolveInstance()`) | `@nautilo/config` | Developers want stable URLs across `bun run` invocations on the dev machine |
| **connect** | whatever the paired server advertises (any host/port/path prefix the operator chose) | URL captured at pairing time (first-run picker / persisted targets; D133 multi-server) | The desktop app is a client; it does not open listen ports for Workbench in production |

**Rule:** packaged **connect** code paths MUST NOT bake in dev-only literals like `localhost:3000` / `localhost:3001` as implicit production defaults. Phase 4b sweeps for violations. Any URL constructed in main / preload / renderer for the main window should derive from the resolved `serverUrl` for the active pairing (see D133 when multiple servers are configured).

## 3. Workbench-loading decision

**Decision (D134):** In **connect** mode, the **paired Nautilo server** serves the Workbench SPA at `/` and APIs under `/api/*` on the same origin. The desktop `BrowserWindow` loads `win.loadURL(<pairedServerUrl>/)` (exact URL comes from first-run / persisted pairing). Workbench static assets are built and deployed **with the server operator’s deployment**, not inside the Electron `.app` resource layout.

The alternative considered historically was a custom `nautilo://` protocol for static assets with HTTP only for `/api/*`. Single-origin via the real server URL remains the contract because:

1. One origin for UI + API avoids a large class of CSP/CORS mistakes at the renderer boundary.
2. A custom protocol split adds renderer complexity (relative URLs differ across schemes) for limited gain when the product already trusts an explicit user-chosen HTTPS (or loopback lab) base URL.
3. When the hosted “cloud” product exists, it is also single-origin HTTPS by definition; the renderer model stays aligned.

**Operator note:** Lab setups may still use HTTP or loopback; trust and certificate handling follow §5–§6 and the TLS pinning / CA-trust helpers in main — those paths exist for **whatever origin the user paired**, not because the desktop spawns a child server.

**Implementation owner:** Stack 1 / server packaging — static mount + `NAUTILO_WORKBENCH_DIST` (or equivalent deployment wiring) on the server side. Desktop packaging does **not** ship `dist/workbench/` as a load-bearing production artifact.

## 4. Update model

**Decision:** `electron-updater` with signed channels for the **Electron shell** (main, preload, picker/onboarding file bundles, vendored Bun, brand assets).

- `electron-updater@6.8.9` is already a runtime dep.
- Update artifacts (`latest-mac.yml`, `Nautilo-x.y.z.dmg`, blockmap) ship from GitHub Releases (Phase 5 wires the workflow).
- Signature verification is automatic when artifacts are signed (Phase 3b's cert-arrival flow lights this up).
- The ordinary `desktop-vX.Y.Z` GitHub Release is the stable identity. Unsigned
  `desktop-vX.Y.Z-rc.N` prereleases are build QA only, not an updater channel.

**Workbench / API surface:** Under D134, Workbench HTML/JS/CSS ships with the **paired server** deployment. Server operators version and roll that independently of the desktop build. The desktop must still enforce **API / protocol compatibility** against that server (§6) so a new Workbench cannot assume IPC or OIDC behavior the old shell does not provide — but that is a contract check, not “ship Workbench inside the `.app`”.

**REJECTED — treating the server’s web UI as silently updatable without compatibility thought.** Teams should still coordinate server + desktop rollouts when IPC or auth flows change; auto-updating only one side is how production incidents happen.

## 5. Per-origin threat model

Every origin a `BrowserWindow` may load is enumerated below with its preload assignment, allowed-URL policy, and trust posture. New windows added to the codebase MUST be added to this table.

| Origin | Preload | Allowed-URL policy | Trust posture |
|---|---|---|---|
| `http://<vite-host>:<port>` (dev workbench) | `preload.js` (full) | dev-only mode | Developer toolchain trusted; never ships to end users |
| `http://<server-host>:<port>` (dev server API + dev-served workbench) | `preload.js` (full) | dev-only mode | Same as above |
| `https?://<paired-host>` (connect — production or lab URL from pairing) | `preload.js` (full) | exact match against the active paired base URL (per-target list under D133) | **Trusted by explicit user/org pairing + version-compat check** (§6) |
| `file://.../dist/first-run/index.html` | `preload-first-run.js` (narrow: probeUrl, getConnectTargets, commit, cancel) | file URL only | Trusted — we shipped it |
| `file://.../dist/onboarding/index.html` | `preload-onboarding.js` | file URL + outbound to resolved server only | Trusted — we shipped it |
| `https://<logto-endpoint>/...` (auth window) | **none** | Logto IdP endpoint from `/health` payload | Untrusted — sandboxed, no preload, no nodeIntegration. PKCE and token handling are implemented in main/preload, not by trusting the IdP origin with Node integration. See `auth/auth-window.ts:6-22` for the trade-off rationale. |

**Boundaries that MUST hold**:
- The Workbench preload is the privilege boundary. Any origin loaded into `mainWindow` gets desktop-API access. **connect** targets (including `NAUTILO_CONNECT_SERVER_URL` in automation) are therefore **privileged** (see §6).
- The auth window NEVER receives a preload. If we ever needed to inject UX behavior there (e.g., the Tab-fix at `auth-window.ts:117-120`), it goes through `executeJavaScript` with explicit string source, NOT a preload.
- The first-run preload is intentionally minimal so a hostile picker page (e.g., a future federation-style content surface) cannot reach `fs`, `auth`, etc.

## 6. Privileged remote-origin policy

**connect** URLs (paired servers) receive the full Workbench preload — they are privileged origins. Three controls apply:

1. **User-explicit allowlisting**: the only way an origin gets here is the first-run picker's commit (or a developer's explicit env var). The picker URL probe (`first-run:probe-url` at `main.ts:1719-1722`) is the user's affirmative trust act. We do NOT auto-promote arbitrary URLs.
2. **API-version compatibility check**: before granting preload, the boot flow MUST verify the server's `/api/setup/status` (and/or a future `/api/version`) reports a compatible API version tuple. **Currently a gap** — `loadBootSetupStatus` at `main.ts:153` reads the response but does not version-gate. Phase 4 wires the gate; today the contract is "any reachable server is compatible," which is acceptable for v0 but a known weakness.
3. **Navigation containment**: once loaded, `mainWindow` MUST NOT navigate to a different origin while still holding the preload. **Currently a gap** — `mainWindow` has no `setWindowOpenHandler` or `will-navigate` guard. Phase 4 wires both. The auth window already does this correctly (`auth/auth-window.ts:127-132`).

A future cloud mode adds: TLS-only, certificate pinning to the cloud-service CA, and a server-side allowlist of acceptable client app versions. Out of scope for this stack.

## 7. Electron fuse decisions

Wired via `@electron/fuses` package-time hook (Phase 4 implementation). Verified post-build with `npx @electron/fuses read --app <Nautilo.app>`.

| Fuse | Decision | Rationale |
|---|---|---|
| `RunAsNode` | **Disabled** | Electron has no legitimate need to run as plain Node in production. Disabling closes one of the most-cited Electron post-exploitation paths. |
| `EnableNodeOptionsEnvironmentVariable` | **Disabled** | `NODE_OPTIONS` lets an attacker who controls env load arbitrary scripts. Production binary should never honor it. |
| `EnableNodeCliInspectArguments` | **Disabled** | `--inspect` / `--inspect-brk` would expose a debugger port. Dev builds opt back in via the `--remote-debugging-port` flag for the smoke harness; that's a Chromium DevTools Protocol channel, not Node inspect. |
| `EnableCookieEncryption` | **Enabled** | Defense-in-depth. Cookies aren't load-bearing for our auth (Logto session is in-memory access tokens + safeStorage refresh) but enabling is free. |
| `EnableEmbeddedAsarIntegrityValidation` | **Enabled** | Pairs with `electron-builder.yml`'s `asarIntegrity: true` (already on at line 28). At runtime, Electron verifies the embedded ASAR signature before loading; tampered builds fail to start. |
| `OnlyLoadAppFromAsar` | **Deferred** | Vendored Bun plus first-run/onboarding assets may live outside the ASAR (e.g. under `extraResources`). This fuse blocks loading from outside ASAR. Re-evaluate when packaging can consolidate paths or accept the restriction. Workbench static is **not** a desktop-bundle concern under D134. |

## 8. Canonical release-mode signal

**Pinned**: `app.isPackaged`. NOT `process.env.NODE_ENV`.

Rationale: `app.isPackaged` is set by Electron itself based on whether the app was built into an ASAR + launched via the packaged binary. It cannot be spoofed by an attacker who controls the environment. `NODE_ENV` is a string that any parent process can set.

**Audit of current code**:

- Historical `electron/server.ts` packaged-server lifecycle was deleted by D134; no server spawn path remains in desktop.
- `electron/menu.ts:153` — `const isDev = !app.isPackaged` ✓
- `electron/main.ts:2284, 2288` — log-level branching ✓
- `electron/main.ts:2371` — boot mode resolution ✓
- `electron/relay.ts` resolves Electron's `app.isPackaged` through `resolveElectronIsPackaged()` during relay startup and passes that exact value to its sandbox-envelope dispatch gate. The direct handler option remains injectable only for focused tests; runtime production refusal is therefore based on Electron's unspoofable packaging state, not `NODE_ENV`.

New code MUST use `app.isPackaged` unless an equivalent inline justification is recorded here.

## 8b. Preload surface contract (P4.2)

The four preload bundles each expose a deliberately narrow API on `window.<scoped-namespace>`. The renderer never receives raw `ipcRenderer`. Every channel name passed to `ipcRenderer.invoke()` in a preload MUST have a matching `ipcMain.handle()` registration; the IPC parity test (`tests/unit/ipc-parity.test.ts`, P4.8) enforces this.

| Preload bundle | Allowed window | Exposes | Notes |
|---|---|---|---|
| `electron/preload.ts` | `mainWindow` (Workbench) | `window.nautiloDesktop` (`auth`, `currentFolder`, `genieWorkspace`, `fs`, `media`, `menu`, `logger`, `onboarding`, `relayStatus`, …) | Module-level handlers in `main.ts` lines 988–1300 are gated by `assertMainWindowSender(e)` — sender-id check defends against a future XSS in any non-main window gaining access to `ipcRenderer` and re-invoking these channels. |
| `electron/preload-first-run.ts` | First-run picker | `window.nautiloFirstRun` — `getConnectTargets`, `commit`, `confirmDowngrade`, `acceptIdentity`, `abortAttempt`, `onConnectionPresentation`, `cancel` | Handlers registered scoped via per-window closure (`first-run:*` channels in `showFirstRunPicker`). Each handler enforces `_e.sender.id === win.webContents.id` directly; presentation is a renderer-safe push subscription. |
| `electron/preload-onboarding.ts` | Onboarding wizard | `window.nautiloOnboarding` — `get-server-url`, `complete`, `cancel`, `load-existing-profile`, `get-voices`, `preview-voice`, `generate-soul`, `generate-avatar`, `put-profile`, `get-config-flags` | Same per-window scoping as first-run. Human account setup (handle / PIN / recovery codes) belongs to invite/admin/account-security surfaces, not this Genie wizard. |
| (no preload — auth window) | Auth window | NONE — Logto OIDC origin is treated as untrusted | Defence-in-depth: even if Logto's hosted form is compromised, there is no IPC surface to attack. See `electron/auth/auth-window.ts:75-83`. |

### Canonical exposed surface (enforced by P5 smoke harness)

Both the `tests/unit/ipc-parity.test.ts` static-text check (P4.8) and `scripts/smoke-packaged.ts` (P5.1+P5.5, runtime CDP eval) treat this list as the contract. If the preload bundles change, both the doc here AND the smoke harness's `NAUTILO_DESKTOP_SURFACE` / `NAUTILO_FIRST_RUN_SURFACE` constants must update — the smoke fails closed otherwise.

**`window.nautiloDesktop`** (Workbench, from `electron/preload.ts`):

```
miniAppRecovery, documentMutations, isDesktop, embeddedBrowserGuestPreloadPath,
auth, shellStateOnBoot, coldBoot, platform, electronVersion, getVersion,
workbench, openFolder, pickFiles, currentFolder, genieWorkspace,
workspace,                       // DEPRECATED alias (D079 P1) — remove after Phase 4
servers, activeSession, updates, notifications, browserControl, browserResearch, passwords,
toolRuntimes, googleWorkspace, terminal, desktopFilesystemGrants,
workstationProfiles, uncontainedHostCommands, githubCli, structuredSsh, computerUse, workstationShell, codexConnection, remoteControl,
ordinaryChat, encryptionRecovery,
relayStatus, relayIdentity, binaryRead, mediaProxy, mediaExport, fs, media, systemPermissions, menu, logger, onboarding,
deepLink
```

**`window.nautiloFirstRun`** (first-run picker, from `electron/preload-first-run.ts`):

```
getConnectTargets, commit, confirmDowngrade, acceptIdentity,
abortAttempt, onConnectionPresentation, cancel
```

**`window.nautiloOnboarding`** (onboarding wizard, from `electron/preload-onboarding.ts`, D091):

```
getServerUrl, complete, cancel,
loadExistingProfile, getConfigFlags,
getVoices, previewVoice,
generateSoul, generateAvatar, putProfile
```

All `nautiloOnboarding` API-proxy methods return `IpcResult<T> = {ok:true,data:T} | {ok:false,error:string}`. The smoke harness does not currently assert this surface (the wizard window only opens during the onboarding flow); the static `ipc-parity` test still covers the channel names.

### Sender-id gate policy (P4.2)

`assertMainWindowSender(e)` is called at the top of every privileged module-level handler:

- **File IO**: `fs:readDir`, `fs:watchRoot`, `fs:unwatchRoot`, `fs:readFile`, `fs:stat`, `fs:openPath`, plus D431's `binaryRead:open`, `binaryRead:read`, and `binaryRead:close`. (Path-containment via `assertPathInAllowedRoot` is the primary defence; sender-id is defence-in-depth.)
- **Auth/tokens**: `auth:status`, `auth:getAccessToken`, `auth:signIn`, `auth:signOut`.
- **System dialogs**: `dialog:openFolder`, `dialog:pickFiles`, `currentFolder:pickFolder`, `currentFolder:setPath`, `currentFolder:pickAndCommit`, deprecated `workspace:*` aliases.
- **Media preview/import + export**: `mediaProxy:*` gives the main Workbench
  revocable opaque preview/import capabilities; it never exposes host paths,
  bearer tokens, or FFmpeg arguments. `mediaExport:*` starts or cancels
  host-owned rendering, optional Workspace publication, and explicit project
  promotion. Every handler is sender-gated, and main retains source resolution,
  process, publication, and cleanup authority.
- **Media + system shell**: `media:getMicStatus`, `media:askMic`, `shell:openSystemMicSettings`.

`binaryRead:*` returns a structured `{ ok, data | error: { code } }` result,
never an IPC-cloned `Error`. Codes are sanitized and carry no local path,
filename, byte, hash, or underlying OS error detail. A single sender binding
closes sessions on top-level navigation or renderer destruction and is retired
when the sender becomes idle.

Trivial / non-privileged read handlers (`app:getVersion`, `relay:getStatus`, `currentFolder:getPath`, `currentFolder:listRecent`, `currentFolder:validate`, `genieWorkspace:getRoot`, `workspace:getPath`, `workspace:listRecent`) are intentionally NOT gated — they leak no privileged state and gating them produces no security benefit, only call-site noise.

When mainWindow has not yet been created (handlers register at module load, before `createWindow`), `assertMainWindowSender` throws `ipc-denied: mainWindow not ready`. This is the safe default — no legitimate caller should fire these before mainWindow exists.

## 8c. Token & relay-token lifecycle (P4.7)

| Concern | Decision | Implementation |
|---|---|---|
| **At-rest storage** | macOS Keychain / libsecret via Electron `safeStorage` | `auth/token-store.ts` writes `<userData>/nautilo-auth-v1-enc` (header `nautilo-auth-v1-enc` + safeStorage-encrypted JSON). `auth/relay-pair.ts` writes `<userData>/relay-token-<scope>.json` with safeStorage-encrypted body when keychain available, plain body otherwise. |
| **Sign-out clears access/refresh tokens** | YES | `handleSignOut()` calls `clearTokens()` first thing. |
| **Sign-out clears relay token** | YES (P4.7 — was a gap) | `handleSignOut()` calls `clearRelayToken(resolvedServerUrl)` and `stopRelay()` before clearing Logto cookies. Closes the impersonation window where the next OS user could reuse the on-disk relay token. |
| **4401 re-pair behavior** | Auto-clear + re-pair | `bootRelayIfPossible()` (`main.ts`) catches "Invalid or missing relay token" responses, calls `clearRelayToken(serverUrl)`, then re-mints via `pairRelay()` with a fresh access token. |
| **Token rotation** | Logto access tokens rotate per-issue; refresh-on-near-expiry handled by `auth/refresh.ts`. Relay tokens are long-lived; rotation is server-driven (relay can revoke; renderer triggers a re-pair via the 4401 path). | Document; no action required this stack. |
| **Local "forget this server" affordance** | NOT SHIPPED — follow-up | `handleSignOut()` is the closest thing today; explicit "remove server pairing" UI is a Workbench / first-run polish task. Tracked as a future item, not blocking D103. |
| **Log redaction** | Bearer tokens logged prefix-only (`token.slice(0, 8) + …`); never full body | `electron/main.ts:2121` is the canonical pattern. Sweep via `rg "Bearer [A-Za-z0-9_-]{15,}|token: ?[\"'\`][A-Za-z0-9_-]{15,}" apps/desktop/electron/` returns zero matches as of the P4.7 commit. |
| **Crash-dump redaction** | Crash dumps stay LOCAL (no upload) | `crashReporter` at `main.ts:130` has `uploadToServer: false`. When upload wires up (separate issue), redaction is mandatory. |

## 8d. Persisted state inventory (P4d.3 audit)

Every file the desktop writes to disk, where it lives, what it contains, and which threat tier it sits in. All `<userData>` paths are platform-resolved via `app.getPath("userData")` (macOS: `~/Library/Application Support/Nautilo/`, Linux: `~/.config/Nautilo/`, Windows: `%APPDATA%\Nautilo\`). `~/.nautilo/...` paths are cross-process state shared with CLI and server tooling (see `electron/paths.ts` family B).

| File | Shape | Encryption | Writer | Sensitivity |
|---|---|---|---|---|
| `<userData>/config.json` | Pairing / server-target fields as implemented (evolving toward explicit multi-target storage per **D133**); current schema accepts only `{ mode: "connect", serverUrl }` | plaintext, mode 0600 | `electron/config.ts` `saveConfig()` (atomic temp+rename) | Low — URLs are mildly personal but not secrets. 0600 matches D063 smoke-token convention. Legacy `mode: "local"` / packaged-local configs are rejected by the parser and rerun the picker. |
| `<userData>/nautilo-auth-v1-enc` | OIDC token bundle (access + refresh) | safeStorage-encrypted (header `nautilo-auth-v1-enc`); plaintext fallback (header `nautilo-auth-v1-pt`, mode 0600) ONLY when `safeStorage.isEncryptionAvailable()` returns false (libsecret-less Linux) | `electron/auth/token-store.ts` (DI-pure) via `electron/auth/token-store-electron.ts` | High — bearers. Plaintext fallback is the one known plaintext-secret risk; gated by platform capability and documented at write time in M055. |
| `<userData>/relay-token-<scope>.json` | M056 long-lived relay token + scope | safeStorage-encrypted preferred; plaintext fallback by same pattern as auth bundle | `electron/auth/relay-pair.ts` | High — relay bearer; scope-bound. Cleared on sign-out by `handleSignOut()` per §8c. |
| `<userData>/window-state.json` | `{ x, y, width, height }` | plaintext | `main.ts` `saveWindowState()` (debounced) | None. |
| `<userData>/current-folder.json` | path string | plaintext | `electron/recent-current-folders.ts` | Low — local fs path. |
| `<userData>/genie-workspace.json` | Genie workspace root path | plaintext | `electron/default-genie-workspace.ts` | Low. |
| `~/.nautilo/recent-current-folders.json` | recent-folders list | plaintext | legacy shared location | Low. |
| `~/.nautilo/posture.json` | security-posture sidecar | plaintext | Server/operator-owned legacy sidecar; desktop no longer provisions it after D134 | Low — operator policy, not secrets. |
| `~/.nautilo/session.json` | session token (legacy) | plaintext | reader at `main.ts:1595` (whoami bootstrap) | **M072 done** — treat as transitional/inert; Logto tokens live in `nautilo-auth-v1-enc`. |
| `~/.nautilo/certs/ca.crt` | local development CA cert (PEM) | plaintext (public cert; key is not stored desktop-side) | external (CLI / nautilo-server bootstrap) — desktop reads only | None — the cert is public; the key never leaves the server side. |

**No sensitive data co-locates with `config.json`.** safeStorage is correctly applied to the two files that hold bearers. Plaintext-fallback for libsecret-less Linux is a documented existing trade-off (mode 0600), not a P4d regression.

**Compatibility note — `/api/setup/status` viewer payload.** The desktop consumes
this surface narrowly: `mapSetupStatusToServerClaimState` reads `serverRole` /
`genieCustomized` / `byokConfigured` / `setupState` only, to derive a 4-value
`ServerClaimState`. The first-run picker does not need onboarding-only flags.
The mapper's `_exhaustive: never` guard on `setupState` catches non-additive
schema changes at compile time.

**Compatibility note — per-instance auth-bundle scoping.** The relay token is
scoped per instance (`relay-token-<scope>.json`). Authentication storage and
server-switching behavior must preserve the same rule: credentials for one
server must never become credentials for another server.

## 9. ASAR integrity decision

**Enabled.** Currently set in `electron-builder.yml:28` (`asarIntegrity: true`).

Verification:

```bash
# `@electron/asar` 4.x dropped the `verify` subcommand. Runtime ASAR
# integrity is enforced by Electron itself when the
# `EmbeddedAsarIntegrityValidation` fuse is on; check the fuse posture
# of the packaged app instead:
npx @electron/fuses read --app <Nautilo.app>
# Expect: "EnableEmbeddedAsarIntegrityValidation is Enabled"
```

Phase 4 wires this into the smoke harness. Tamper test (Phase 4): edit a byte inside `app.asar` with a hex editor, re-run verify, confirm non-zero exit and the runtime refuses to launch.

`asarIntegrity: true` only verifies at build time that the ASAR's hash is recorded in the binary's Mach-O header (macOS) / PE resource (Windows). The runtime check requires the `EnableEmbeddedAsarIntegrityValidation` fuse (§7), which we enable.

## 10. Boot-sequence diagram

```
                            app.whenReady()
                                  │
                                  ▼
                     setupLogging() + setupLocalCATrust()
                                  │
                                  ▼
                       Migrate legacy current-folder
                                  │
                                  ▼
            Resolve current-folder + Genie workspace root
                                  │
                                  ▼
        ┌────────────── boot mode resolution ──────────────┐
        │                                                  │
        ▼                                                  ▼
  dev-from-source                         packaged / NAUTILO_CONNECT_SERVER_URL
   serverUrl from                         │
   resolveDev*                            ▼
   (Vite + dev APIs)              first-run OR persisted pairing
                                  yields paired serverUrl
                                  (D133: may switch among N)
                                  │
                                  ▼
                      loadBootSetupStatus(serverUrl)
                       (GET /api/setup/status; guest)
                                  │
                                  ▼
                       resolveLogtoConfig(serverUrl)
                       (GET /health; cache config)
                                  │
                                  ▼
                  Silent token refresh if persisted + expiring
                                  │
                                  ▼
                       probeServerState(serverUrl)
                       (mapSetupStatusToServerClaimState)
                                  │
                                  ▼
                  Optional: showOnboardingWizard(serverUrl)
                                  │
                                  ▼
                       resolvedServerUrl = serverUrl
                       ipcMain.handle("onboarding:open", ...)
                                  │
                                  ▼
                       createWindow(<pairedServerUrl>/)
                       BrowserWindow loads URL
                       (sandbox + contextIsolation + preload)
                                  │
                                  ▼
                       Tray, menu, IPC ready
                       boot() returns
```

## 11. Findings — Phase 1 audit against the lock

Every deviation between this lock and the current code, tagged with the phase that closes the gap. **Each row is a real bug or an observation, not a "should review" placeholder.**

| File:line | Finding | Owner phase |
|---|---|---|
| `electron/main.ts:1393-1430` (mainWindow) | No `setWindowOpenHandler`, no `will-navigate` — § 6 navigation containment is unenforced. Auth window does this correctly; main does not. | ✓ closed by **P4.5** — `attachNavigationGuards(mainWindow, { allowedOrigins: [Workbench origin] })` covers `setWindowOpenHandler`, `will-navigate`, `will-frame-navigate`, plus diagnostic `did-fail-load`. External links → `shell.openExternal`. |
| `electron/main.ts:1690-1709` (first-run window) | No `setWindowOpenHandler`. Less critical than mainWindow because preload is narrow, but defense-in-depth says wire it. | ✓ closed by **P4.5** — `attachNavigationGuards(win, { allowedOrigins: [] })`; first-run is a `file://` SPA with IPC-only data path, no legitimate top-level navigation. |
| `electron/main.ts:1979` (onboarding window) | No `setWindowOpenHandler`. Same posture as first-run. | ✓ closed by **P4.5** — `attachNavigationGuards(win, { allowedOrigins: [] })`; same posture. API fetches go via the CSP-overridden `fetch()` which is not a navigation event. |
| `electron/main.ts:1640-1665` (`setupLocalCATrust`) | Trusts ANY cert for `localhost` / `127.0.0.1` / `.local` when `~/.nautilo/certs/ca.crt` exists. Production should verify chain anchors to that pinned CA, not trust unconditionally. | ✓ closed by **P4.6** — `chainAnchorsTo()` walks the Electron Certificate `issuerCert` chain and verifies signatures against the pinned CA's public key via `node:crypto.X509Certificate.verify()`. **connect** + packaged + non-local hostname → reject early; default-fail on every error path. Boot mode plumbed via `currentBootMode`. |
| `electron/main.ts:153-162` (`loadBootSetupStatus`) | Fetches `/api/setup/status` but does not version-gate **connect** origin trust before granting preload. § 6 control #2 currently a gap. | **P4** (separate from .5/.6 — defer to a follow-up if scope tight) |
| `electron-builder.yml` | No `@electron/fuses` afterPack hook. § 7 fuses unenforced. | ✓ closed by **P4.3** — `@electron/fuses@^2.1.1` added to devDeps; `scripts/flip-fuses.ts` flips RunAsNode / NodeOptions / NodeCliInspect to false and CookieEncryption / EmbeddedAsarIntegrityValidation to true (OnlyLoadAppFromAsar deferred per §7); `scripts/after-pack.cjs` resolves the per-platform bundle path and invokes the script via Bun; wired via `afterPack: ./scripts/after-pack.cjs` in `electron-builder.yml`. Runtime verification deferred to a packaged-build smoke (`npx @electron/fuses read --app …`) in P5. |
| `scripts/build-electron.ts` | (Historical) Workbench `dist/` staging for smoke/dev vs server `NAUTILO_WORKBENCH_DIST` mount. | **Superseded by D134 framing (2026-05-12)** — production **connect** loads Workbench from the paired server’s `/`; the operator’s server package owns static assets. A desktop build step that copies `apps/workbench/dist` may still exist for harnesses or transitional tooling; it is **not** the shipped-to-users production contract. Server-side `@fastify/static` mount when `NAUTILO_WORKBENCH_DIST` is set (`packages/server/src/app.ts`, `ef8ea575`) remains the operator-side mechanism. |
| `electron-builder.yml:13-26` | No win/linux targets; no exclude rules for tests/docs/tsconfig; no `copyright` field. | ✓ closed by **P2.2** — `win.target: nsis`, `linux.target: AppImage`, `copyright`, and `files`-excludes for tests/docs/tsconfigs. |
| `package.json:scripts` | No `package:mac` / `package:linux` / `package:win` aliases. Milestone test command (`pnpm package:mac`) does not work. | ✓ closed by **P2.3** + audit pass — `package:mac` / `package:linux` / `package:win` / `package:dev` are the canonical scripts. Legacy `pack` and `dist` aliases dropped (no external CI/docs referenced them; `package:*` is the single source of truth). |
| `assets/` | Empty. No `icon.icns`, no `icon.ico`, no `icon.png`, no tray asset (README claims `iconTemplate.png` exists but it does not). | ✓ closed by **P3.2 + P3.3** (`f3331768`) — `apps/desktop/scripts/generate-icons.ts` derives `icon.icns` / `.ico` / `.png` (multi-res containers via png2icons) and `iconTemplate.png` + `@2x.png` (alpha-thresholded silhouette via sharp) from `<repo>/assets/brand/nautilo-logo_v1_logo_only_transparent.png`. Wired as the first step of `package:mac/linux/win/dev` so packaging never goes stale on a master swap. |
| `electron-builder.yml:22-25` | `extendInfo` declares `NSMicrophoneUsageDescription` only; missing `CFBundleShortVersionString`, `CFBundleVersion`, `NSHumanReadableCopyright`, `LSMinimumSystemVersion`. | ✓ closed by **P3.5** — `NSHumanReadableCopyright` and `LSMinimumSystemVersion: "11.0"` added to `mac.extendInfo`. `CFBundleShortVersionString` / `CFBundleVersion` are read by electron-builder from the package version, which release CI derives from the GitHub Release tag. |
| `app.setAboutPanelOptions` | Not wired — macOS About menu shows raw bundle name. | ✓ closed by **P3.7** — wired before `app.whenReady()` with `applicationName: "Nautilo"`, `applicationVersion: app.getVersion()`, `copyright: "Copyright © 2026 Nautilo"`, and `iconPath: assets/icon.png`. |
| `electron/boot-setup-status.ts:9-15` | `mapSetupStatusToServerClaimState` emits 2 of 4 declared `ServerClaimState` values. Renderer cannot distinguish `claimed-needs-auth` / `server-needs-keys` / authenticated-with-viewer. | **P4c** |
| `electron/main.ts` (entire boot flow) | Path resolution sweep — verify every `path.join`/`__dirname`/`app.getPath()` use is canonical; verify no `localhost:3000`/`localhost:3001` literals leak into packaged paths. | ✓ closed by **P4b** (`f1efc3c0` + `6b4fc2a2` + `3f48bd5a` re-verify 2026-05-12) — full sweep across `apps/desktop/electron/**`, `first-run/**`, `onboarding/**` found zero actionable findings; only `:3001` match in `electron/preflight.ts:31` is a JSDoc string illustrating a user-typed URL. All `app.getPath()` calls use canonical names. All `path.join`/`__dirname` usage is cross-OS-safe. **D134:** bundling `bin/nautilo-server` in the desktop `.app` is **N/A** — the packaged product is a connect client; see PACKAGE-MANIFEST.md. |
| `electron/main.ts` log lines (~100+ matches) | Audit pass for token-shaped substrings in logs. The diagnostic prefix-only pattern at `main.ts:2526` is the desired form. | ✓ closed by **P4.7** — `handleSignOut()` now clears the relay token + stops the relay alongside Logto access/refresh tokens; log-redaction sweep confirmed prefix-only via `rg "Bearer [A-Za-z0-9_-]{15,}\|token: ?[\"'\`][A-Za-z0-9_-]{15,}" apps/desktop/electron/` → 0 matches. Lifecycle policy documented in §8c. |
| `tests/unit/` (no parity test exists) | `MenuAction` union string list is duplicated in `electron/menu.ts:20`, `electron/preload.ts:9`, and `apps/workbench/src/lib/desktop.ts`. Drift caught by code review only; no static check. | ✓ closed by **P4.8** — `tests/unit/ipc-parity.test.ts` asserts every preload `ipcRenderer.invoke` channel has a matching `ipcMain.handle` in `main.ts`; soft-snapshot of preload channel-set size catches wholesale drops. (`MenuAction` string-union drift across the three files remains a separate, narrower concern; if it bites we can add a similar text-parity check.) |
| `README.md:15` | "Chat with Jeannie works identically..." — Stack 6 owns the rename. Out of scope here, but rebase will need to touch this line. | (Stack 6 rebase) |
| First-run UX `/health` probe | `first-run:probe-url` calls `probeUrl()` at `main.ts:1721` which probes `/health`. § 6 wants `/api/setup/status` so the picker can branch on `ServerClaimState`. | ✓ closed by **P4d.1+P4d.2** — new `first-run:probe-state` IPC channel calls `probeServerClaimStateForUrl()` (P4c export); preload bridges via `window.nautiloFirstRun.probeServerState`; first-run picker renders state-specific copy under the URL input for all 4 ServerClaimState values. Network-layer `first-run:probe-url` retained for TLS/timeout signaling — the state probe is additive. (Commits `4f63bad0` + `d11d5fab`.) |
| `mapSetupStatusToServerClaimState` | Mapper collapsed 3 of 4 `setupState` values into `ready`; renderer cannot distinguish unclaimed / claim-pending / authenticated. | ✓ closed by **P4c** (`65da825c`) — mapper emits all 4 values; `_exhaustive: never` guard against Stack 1 schema drift; `probeServerClaimStateForUrl` exported for first-run wiring; `main.ts:probeServerState` consumer rewritten as exhaustive switch with matching `_exhaustive: never`. Local shadow `type ServerClaimState` in `main.ts` removed in follow-up `d0c4352d` — single source of truth in `electron/boot-setup-status.ts`. |
| `first-run/index.tsx` cancel handler | Cancel quits the app rather than returning to mode selection. | Documented as intentional (matches onboarding-wizard cancel semantics; explicit terminal user choice). Not changed. |
| `createWindow` show-timing | `createWindow` does not set `show: false` + `ready-to-show` gate. Single-frame risk of unauthed-workbench flash on the happy path; legitimate sign-in screen on the unhappy path. P4d audit (commit `4f63bad0` notes) confirmed the structural risk; real verification needs a packaged build. | **Deferred to P5** smoke harness (will exercise on real packaged DMG). Fix when verified, not speculatively. |
| `electron/main.ts` first-run commit (caught by 2026-05-12 milestone smoke) | URL persistence stored the user-typed host verbatim. `127.0.0.1` and `localhost` are separate origins for OIDC redirect URI allowlisting, cookies, and `/api/setup/status`'s self-declared `serverUrl`. Pasting the wrong loopback form makes Logto reject the redirect with `invalid_redirect_uri`. | ✓ closed by **P4d.8** (`012569ea` + `f5e78864`) — `apps/desktop/electron/url-canonical.ts` `canonicalizeServerUrl(input, serverDeclared)` rewrites loopback↔loopback drift; first-run:commit probes `/api/setup/status`, learns the server-declared host, canonicalizes BEFORE `saveConfig`. 13 unit tests cover loopback-rewrite, non-loopback-leave-alone, malformed-declared-fallback, trailing-slash strip, and path preservation. |
| `electron/main.ts:556` `resolveLogtoConfig` (caught by 2026-05-12 milestone smoke) | Called once at boot. If the `/health` probe fails (server temporarily down, HTTPS/HTTP mismatch, port collision, mid-rebuild), `logtoConfig` stays `null` for the lifetime of the process. Sign-in then throws a stale auth-config error (historical message: missing Logto readiness) even after the server has been healthy for hours. Only a full Electron-app restart recovered. | ✓ closed by **P4d.9** (`f5e78864`) — new `auth:reprobe-server` IPC + `nautiloDesktop.auth.reprobeServer()` preload bridge calls `resolveLogtoConfig(resolvedServerUrl)` on demand. Idempotent (existing function overwrites on success, leaves old config on failure). Workbench renderer hook-up — calling `reprobeServer` on `disconnected → connected` transitions — is owned by Stacks 2/3 and tracked separately. |

## 11b. Audit pass — bugs caught after initial close-out

| File:line | Finding | Resolution |
|---|---|---|
| `electron/main.ts:1773-1806` (`chainAnchorsTo`) | **Silent-fail bug.** `createPublicKey(caPem)` rejects `BEGIN CERTIFICATE` PEM bodies (it expects SPKI/PKCS1 public-key PEM). The `try { caKey = createPublicKey(...) } catch { return false }` block swallowed the rejection, so the chain check **always** returned false when the local-CA path was exercised — operator-CA-rooted lab certs were silently rejected by the `certificate-error` handler instead of being accepted. Reproduced with a Node one-liner: `createPublicKey(certPem)` → `error:0680009B:asn1 encoding routines::too long`. | ✓ fixed in commit `4ac04b8a` — extract public key via `new X509Certificate(certPem).publicKey` (canonical pattern; verified `cert.verify(cert.publicKey) === true` against a self-signed test cert). Renamed the parameter `caPublicKeyPem` → `caCertificatePem` to make the input format unambiguous. Added a defensive code comment citing the failure mode so future edits don't regress. |
| `package.json:scripts` | Duplicate paths: `pack` ≈ `package:dev` (both: vendor:bun + build + electron-builder --dir); `dist` ≈ `package:mac/linux/win` (electron-builder defaults to current OS, ambiguous). Subagent C kept them as "deprecation aliases" but no external CI/docs reference them (`rg "(bun \|pnpm )?run (pack\|dist)\b"` → 0 matches outside `package.json`). | ✓ removed both. `package:mac/linux/win/dev` is the single canonical surface. README updated. |

## 11c. Deferred follow-ups (post-omnibus, tracked)

Items observed during the milestone build/launch verification on 2026-05-12. None block the omnibus PR; each is small enough to land as its own follow-up commit.

| ID | Observation | Proposed fix | Size |
|---|---|---|---|
| **F-1: Two Keychain prompts on first launch** | First boot triggers two macOS Keychain prompts: (1) Chromium asking for the app-scoped cookie/encryption key (forced by `EnableCookieEncryption` fuse, see §7) and (2) Electron `safeStorage` asking for the app master key (triggered by `loadTokens()` in the early boot path before sign-in). The first prompt is unavoidable given our fuse posture; the second is gratuitous on a first-run flow where the user hasn't signed in yet and there's nothing to decrypt. | Defer the `safeStorage` probe until after sign-in. Today the boot path calls `loadTokens()` early; lazy-load it on first auth-state read instead. Single-digit lines of code change in `electron/main.ts`. Verify by reinstalling on a clean account and confirming only one prompt appears until the user reaches the OIDC redirect. | ~5–10 LOC, `electron/main.ts` only. |
| **F-2: Default Electron menu visible during first-run** | The custom application menu (`createApplicationMenu` in `electron/menu.ts`) is only installed inside `boot()` after `createWindow(workbenchUrl)` (line 2846). During the first-run picker window (and during the onboarding flow), `Menu.setApplicationMenu` has not been called, so macOS shows Electron's default menu (no "Nautilo" app menu, no File / Edit / View / Window / Help built by us). | Move the initial `rebuildApplicationMenu()` call to immediately after `app.whenReady()` so the custom menu is in place before the first-run window shows. The menu builder already tolerates `mainWindow === null` (window-scoped clicks short-circuit via `sendAction`'s `isDestroyed` guard). After the main window opens, the existing rebuild calls keep things in sync. | ~3 LOC in `electron/main.ts` boot entry; no menu.ts changes. |
| **F-3: safeStorage plaintext-fallback is operator-invisible** | On Linux without libsecret/D-Bus (minimal server images, headless, some WSL setups), both `electron/auth/token-store.ts` and `electron/auth/relay-pair.ts` silently fall back to chmod-600 plaintext writes. The auth writer at least emits a `auth.token_store.unencrypted_fallback` warn; the relay writer (`relay-pair.ts:121-159`) makes the same decision **without any log line**. Operator has no way to know their tokens are at rest in plaintext. | Add a parallel warn in the relay writer; surface fallback selection to the renderer so the workbench can show a "tokens stored unencrypted" banner. Tracked as D126 Phase 13. Bundled here because the change is small and aligned with F-1's `safeStorage` boot-order work. | ~10 LOC across `relay-pair.ts` + 1 IPC channel for the renderer banner. |

These observations remain recorded here until the corresponding rows are
resolved or deliberately retired. Public contributors do not need a separate
planning repository to understand them.

## 12. Living-document discipline

When a code change interacts with anything in §§ 1–10:

1. If the change brings code closer to the lock, update the corresponding row in §11 to "✓ closed in <commit>". Do not delete the row — it's audit history.
2. If the change requires the lock itself to evolve (e.g., new mode added, new fuse decision, new privileged origin), update the affected section AND add a dated note at the top of this file.
3. If the change adds a new BrowserWindow, the §5 threat model row is mandatory in the same commit. CI does not enforce this, but code review must.

Reviewers: when reviewing PRs touching `apps/desktop/`, scan §11 for newly-introduced findings or rows that should be marked closed. The document is the contract; the code is the implementation.
