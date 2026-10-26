# Nautilo Desktop — Production architecture lock

> Maintained by the Desktop contributors. Package manifests and implementation tests establish the current runtime contract.
>
> **Audience**: anyone shipping changes to `apps/desktop/`. The README explains how to run dev mode; this document is the **production contract** every change must respect. If a code change appears to violate something here, either the change needs revision or this document needs revision — never silently diverge.
>
> **For build/package/smoke commands**, see the [Desktop README](README.md),
> [package manifest](PACKAGE-MANIFEST.md), [packaging and artifact trust](PACKAGING.md), and
> the scripts in `apps/desktop/package.json`. Public installation guidance lives
> at [Nautilo.ai](https://nautilo.ai/docs/use/install-and-connect).

## Architecture (connect-to-server)

**Binding contract (connect-to-server architecture):** The packaged Electron app is a **connect-to-server client**. It does not bundle, spawn, or manage `nautilo-server`, Postgres, Logto, Docker, or database migrations. The shipped `.app` contains Electron main + preload bundles, the first-run picker UI, the onboarding wizard UI, brand assets, and a **vendored Bun runtime** used only where IPC tooling shells out to Bun. On macOS it also contains the first-party signed Computer Use Host, its qualified CUA driver, the narrow screen-recording permission helper, and the window-presence helper used by the floating companion; Electron attests and brokers those artifacts but does not own CUA semantics. End users always pair with an operator-owned Nautilo server URL; the Workbench SPA is loaded from that server’s `<serverUrl>/` route (static assets live in the **server** package, not the desktop bundle).

**Multi-instance:** The client is not welded to one server for life; it pairs to **N** servers and switches between them. That product shape is a load-bearing reason the retired “bundle/spawn a child server inside the desktop app” path was the wrong architecture.

**Authoritative references** (read before contradicting this file):
- [Package manifest](PACKAGE-MANIFEST.md)
- [Packaging and artifact trust](PACKAGING.md)
- [Repository working rules](../../AGENTS.md)

The historical **packaged-local** experiment (Electron spawning `bin/nautilo-server`, dynamic loopback port via child stdout, Workbench from `extraResources`, `NAUTILO_DESKTOP_MODE=local`, etc.) is **retired**. The client connects to an operator-owned server instead.

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
4. Packaged app → persisted pairing / first-run flow yields **connect** against the chosen server URL(s); pairing supports multiple saved servers

## 2. Port policy per mode

| Mode | Port / URL | Source of truth | Why |
|---|---|---|---|
| dev-from-source | predictable defaults (e.g. workbench + server ports from `@nautilo/config` `resolveInstance()`) | `@nautilo/config` | Developers want stable URLs across `bun run` invocations on the dev machine |
| **connect** | whatever the paired server advertises (any host/port/path prefix the operator chose) | URL captured at pairing time (first-run picker / persisted targets; multiple saved servers) | The desktop app is a client; it does not open listen ports for Workbench in production |

**Rule:** packaged **connect** code paths MUST NOT bake in dev-only literals like `localhost:3000` / `localhost:3001` as implicit production defaults. Any URL constructed in main / preload / renderer for the main window should derive from the resolved `serverUrl` for the active pairing (including when multiple servers are configured).

## 3. Workbench-loading decision

**Decision:** In **connect** mode, the **paired Nautilo server** serves the Workbench SPA at `/` and APIs under `/api/*` on the same origin. The desktop `BrowserWindow` loads `win.loadURL(<pairedServerUrl>/)` (exact URL comes from first-run / persisted pairing). Workbench static assets are built and deployed **with the server operator’s deployment**, not inside the Electron `.app` resource layout.

The alternative considered historically was a custom `nautilo://` protocol for static assets with HTTP only for `/api/*`. Single-origin via the real server URL remains the contract because:

1. One origin for UI + API avoids a large class of CSP/CORS mistakes at the renderer boundary.
2. A custom protocol split adds renderer complexity (relative URLs differ across schemes) for limited gain when the product already trusts an explicit user-chosen HTTPS (or loopback lab) base URL.
3. When the hosted “cloud” product exists, it is also single-origin HTTPS by definition; the renderer model stays aligned.

**Operator note:** Lab setups may still use HTTP or loopback; trust and certificate handling follow §5–§6 and the TLS pinning / CA-trust helpers in main — those paths exist for **whatever origin the user paired**, not because the desktop spawns a child server.

**Implementation owner:** Server packaging — static mount + `NAUTILO_WORKBENCH_DIST` (or equivalent deployment wiring) on the server side. Desktop packaging does **not** ship `dist/workbench/` as a load-bearing production artifact.

## 4. Update model

**Decision:** `electron-updater` with signed channels for the **Electron shell** (main, preload, picker/onboarding file bundles, vendored Bun, brand assets).

- `electron-updater@6.8.9` is already a runtime dep.
- Update metadata, installer archives, and blockmaps are published to the stable feed configured in `electron-builder.yml`.
- Signed artifact publication and updater verification follow [packaging and artifact trust](PACKAGING.md).
- The ordinary `desktop-vX.Y.Z` GitHub Release is the stable identity. Unsigned
  `desktop-vX.Y.Z-rc.N` prereleases are build QA only, not an updater channel.

**Workbench / API surface:** Workbench HTML/JS/CSS ships with the **paired server** deployment. Server operators version and roll that independently of the desktop build. The desktop must still enforce **API / protocol compatibility** against that server (§6) so a new Workbench cannot assume IPC or OIDC behavior the old shell does not provide — but that is a contract check, not “ship Workbench inside the `.app`”.

**REJECTED — treating the server’s web UI as silently updatable without compatibility thought.** Teams should still coordinate server + desktop rollouts when IPC or auth flows change; auto-updating only one side is how production incidents happen.

## 5. Per-origin threat model

Every origin a `BrowserWindow` may load is enumerated below with its preload assignment, allowed-URL policy, and trust posture. New windows added to the codebase MUST be added to this table.

| Origin | Preload | Allowed-URL policy | Trust posture |
|---|---|---|---|
| `http://<vite-host>:<port>` (dev workbench) | `preload.js` (full) | dev-only mode | Developer toolchain trusted; never ships to end users |
| `http://<server-host>:<port>` (dev server API + dev-served workbench) | `preload.js` (full) | dev-only mode | Same as above |
| `https?://<paired-host>` (connect — production or lab URL from pairing) | `preload.js` (full) | exact match against the active paired base URL (per-target list) | **Trusted by explicit user/org pairing + version-compat check** (§6) |
| `https?://<paired-host>/companion` | `preload-companion.js` (display/input only) | Exact companion document plus same-origin visual/code assets; API requests, sockets, subframes and navigation denied | Sandboxed ephemeral session; no authentication tokens, general Desktop bridge or media capture. The authenticated Workbench owns Room admission and operations. |
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
2. **Server compatibility**: server reachability alone does not establish compatibility with the privileged preload. Preserve the boot flow's server identity and readiness checks; changes to server APIs or preload capabilities require corresponding compatibility qualification.
3. **Navigation containment**: a Workbench document MUST NOT navigate to a different origin while retaining its preload. `attachNavigationGuards` enforces the allowed origins for Workbench and local windows; the auth window has its own navigation policy.

New hosted connection modes require explicit origin, certificate, and client-compatibility policies before receiving privileged preload access.

## 7. Electron fuse decisions

Wired via the `@electron/fuses` package-time hook. Verify each built artifact with `npx @electron/fuses read --app <Nautilo.app>`.

| Fuse | Decision | Rationale |
|---|---|---|
| `RunAsNode` | **Disabled** | Electron has no legitimate need to run as plain Node in production. Disabling closes one of the most-cited Electron post-exploitation paths. |
| `EnableNodeOptionsEnvironmentVariable` | **Disabled** | `NODE_OPTIONS` lets an attacker who controls env load arbitrary scripts. Production binary should never honor it. |
| `EnableNodeCliInspectArguments` | **Disabled** | `--inspect` / `--inspect-brk` would expose a debugger port. Dev builds opt back in via the `--remote-debugging-port` flag for the smoke harness; that's a Chromium DevTools Protocol channel, not Node inspect. |
| `EnableCookieEncryption` | **Enabled** | Defense-in-depth. Cookies aren't load-bearing for our auth (Logto session is in-memory access tokens + safeStorage refresh) but enabling is free. |
| `EnableEmbeddedAsarIntegrityValidation` | **Enabled** | Pairs with `electron-builder.yml`'s `asarIntegrity: true` (already on at line 28). At runtime, Electron verifies the embedded ASAR signature before loading; tampered builds fail to start. |
| `OnlyLoadAppFromAsar` | **Deferred** | Vendored Bun plus first-run/onboarding assets may live outside the ASAR (e.g. under `extraResources`). This fuse blocks loading from outside ASAR. Re-evaluate when packaging can consolidate paths or accept the restriction. Workbench static is **not** a desktop-bundle concern in connect mode. |

## 8. Canonical release-mode signal

**Pinned**: `app.isPackaged`. NOT `process.env.NODE_ENV`.

Rationale: `app.isPackaged` is set by Electron itself based on whether the app was built into an ASAR + launched via the packaged binary. It cannot be spoofed by an attacker who controls the environment. `NODE_ENV` is a string that any parent process can set.

**Implementation owners**:

- Historical `electron/server.ts` packaged-server lifecycle was removed with the connect-to-server architecture; no server spawn path remains in desktop.
- `electron/menu.ts:153` — `const isDev = !app.isPackaged` ✓
- `electron/main.ts:2284, 2288` — log-level branching ✓
- `electron/main.ts:2371` — boot mode resolution ✓
- `electron/relay.ts` resolves Electron's `app.isPackaged` through `resolveElectronIsPackaged()` during relay startup and passes that exact value to its sandbox-envelope dispatch gate. The direct handler option remains injectable only for focused tests; runtime production refusal is therefore based on Electron's unspoofable packaging state, not `NODE_ENV`.

New code MUST use `app.isPackaged` unless an equivalent inline justification is recorded here.

## 8b. Preload surface contract

The preload bundles each expose a deliberately narrow API on `window.<scoped-namespace>`. The renderer never receives raw `ipcRenderer`. Every channel name passed to `ipcRenderer.invoke()` in a preload MUST have a matching `ipcMain.handle()` registration; the IPC parity test (`tests/unit/ipc-parity.test.ts`) enforces this.

| Preload bundle | Allowed window | Exposes | Notes |
|---|---|---|---|
| `electron/preload.ts` | `mainWindow` (Workbench) | `window.nautiloDesktop` (`auth`, `currentFolder`, `genieWorkspace`, `fs`, `media`, `menu`, `logger`, `onboarding`, `relayStatus`, …) | Module-level handlers in `main.ts` lines 988–1300 are gated by `assertMainWindowSender(e)` — sender-id check defends against a future XSS in any non-main window gaining access to `ipcRenderer` and re-invoking these channels. |
| `electron/preload-companion.ts` | Floating companion | `window.nautiloCompanion` — `getState`, `command`, `subscribe` | Exact child sender and main-frame checks; commands require the active binding generation. The owner API remains on the Workbench preload. |
| `electron/preload-first-run.ts` | First-run picker | `window.nautiloFirstRun` — `getConnectTargets`, `commit`, `confirmDowngrade`, `acceptIdentity`, `abortAttempt`, `onConnectionPresentation`, `cancel` | Handlers registered scoped via per-window closure (`first-run:*` channels in `showFirstRunPicker`). Each handler enforces `_e.sender.id === win.webContents.id` directly; presentation is a renderer-safe push subscription. |
| `electron/preload-onboarding.ts` | Onboarding wizard | `window.nautiloOnboarding` — `get-server-url`, `complete`, `cancel`, `load-existing-profile`, `get-voices`, `preview-voice`, `generate-soul`, `generate-avatar`, `put-profile`, `get-config-flags` | Same per-window scoping as first-run. Human account setup (handle / PIN / recovery codes) belongs to invite/admin/account-security surfaces, not this Genie wizard. |
| (no preload — auth window) | Auth window | NONE — Logto OIDC origin is treated as untrusted | Defence-in-depth: even if Logto's hosted form is compromised, there is no IPC surface to attack. See `electron/auth/auth-window.ts:75-83`. |

### Canonical exposed surface

Both the `tests/unit/ipc-parity.test.ts` static-text check and `scripts/smoke-packaged.ts` (runtime CDP evaluation) treat this list as the contract. If the preload bundles change, both the doc here AND the smoke harness's `NAUTILO_DESKTOP_SURFACE` / `NAUTILO_FIRST_RUN_SURFACE` constants must update — the smoke fails closed otherwise.

**`window.nautiloDesktop`** (Workbench, from `electron/preload.ts`):

```
companion, miniAppRecovery, documentMutations, isDesktop, embeddedBrowserGuestPreloadPath,
auth, shellStateOnBoot, coldBoot, platform, electronVersion, getVersion,
workbench, openFolder, pickFiles, currentFolder, genieWorkspace,
workspace,                       // DEPRECATED alias for currentFolder
servers, activeSession, updates, notifications, browserControl, browserResearch, passwords,
toolRuntimes, googleWorkspace, chatGPT, terminal, desktopFilesystemGrants,
workstationProfiles, uncontainedHostCommands, githubCli, structuredSsh, computerUse, workstationShell, codexConnection, hermesConnection, readyToWork, remoteControl,
ordinaryChat, foregroundShadow, encryptionRecovery,
relayStatus, relayIdentity, binaryRead, mediaProxy, mediaExport, fs, media, systemPermissions, menu, logger, onboarding,
deepLink
```

**`window.nautiloDesktop.chatGPT`** (authenticated Workbench enrollment):

```
prepare, receive, cancel
```

These methods prepare, receive or cancel a one-use browser callback. The listener
belongs to the initiating authenticated session and sender; navigation, a changed
server authority or authentication generation cancels it. Remote enrollment
requires HTTPS. The server owns token exchange and custody; this bridge returns
the callback and does not expose saved subscription tokens.

**`window.nautiloDesktop.companion`** (authenticated Workbench owner):

```
enable, pickFiles, disable, publish, onAction, onClosed
```

Only the current Workbench main frame can invoke owner operations. File picking,
disabling and snapshot publication require the active binding generation.

**`window.nautiloCompanion`** (isolated companion child):

```
getState, command, subscribe
```

The child receives admitted display state and sends typed input commands. It
cannot access `nautiloDesktop`, credentials, network APIs or microphone capture.
See [Floating Genie](../../docs/floating-genie.md) for lifecycle and cancellation.

**`window.nautiloFirstRun`** (first-run picker, from `electron/preload-first-run.ts`):

```
getConnectTargets, commit, confirmDowngrade, acceptIdentity,
abortAttempt, onConnectionPresentation, cancel
```

**`window.nautiloOnboarding`** (onboarding wizard, from `electron/preload-onboarding.ts`):

```
getServerUrl, complete, cancel,
loadExistingProfile, getConfigFlags,
getVoices, previewVoice,
generateSoul, generateAvatar, putProfile
```

All `nautiloOnboarding` API-proxy methods return `IpcResult<T> = {ok:true,data:T} | {ok:false,error:string}`. The smoke harness does not currently assert this surface (the wizard window only opens during the onboarding flow); the static `ipc-parity` test still covers the channel names.

### Sender-id gate policy

`assertMainWindowSender(e)` is called at the top of every privileged module-level handler:

- **File IO**: `fs:readDir`, `fs:watchRoot`, `fs:unwatchRoot`, `fs:readFile`, `fs:stat`, `fs:openPath`, plus `binaryRead:open`, `binaryRead:read`, and `binaryRead:close`. (Path-containment via `assertPathInAllowedRoot` is the primary defence; sender-id is defence-in-depth.)
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

## 8c. Token & relay-token lifecycle

| Concern | Decision | Implementation |
|---|---|---|
| **At-rest storage** | macOS Keychain / libsecret via Electron `safeStorage` | `auth/token-store.ts` writes `<userData>/nautilo-auth-v1-enc` (header `nautilo-auth-v1-enc` + safeStorage-encrypted JSON). `auth/relay-pair.ts` writes `<userData>/relay-token-<scope>.json` with safeStorage-encrypted body when keychain available, plain body otherwise. |
| **Sign-out clears access/refresh tokens** | YES | `handleSignOut()` calls `clearTokens()` first thing. |
| **Sign-out clears relay token** | YES | `handleSignOut()` calls `clearRelayToken(resolvedServerUrl)` and `stopRelay()` before clearing Logto cookies. Closes the impersonation window where the next OS user could reuse the on-disk relay token. |
| **4401 re-pair behavior** | Auto-clear + re-pair | `bootRelayIfPossible()` (`main.ts`) catches "Invalid or missing relay token" responses, calls `clearRelayToken(serverUrl)`, then re-mints via `pairRelay()` with a fresh access token. |
| **Token rotation** | Logto access tokens rotate per-issue; refresh-on-near-expiry handled by `auth/refresh.ts`. Relay tokens are long-lived; rotation is server-driven (relay can revoke; renderer triggers a re-pair via the 4401 path). | `auth/refresh.ts` and the server pairing protocol. |
| **Local "forget this server" affordance** | NOT SHIPPED — follow-up | `handleSignOut()` is the closest thing today; explicit "remove server pairing" UI is a Workbench / first-run polish task. Tracked as a future improvement. |
| **Log redaction** | Never log complete bearer tokens | Review authentication and relay diagnostics when changing token handling. |
| **Crash-dump redaction** | Crash dumps stay LOCAL (no upload) | `crashReporter` at `main.ts:130` has `uploadToServer: false`. When upload wires up (separate issue), redaction is mandatory. |

## 8d. Persisted state inventory

Every file the desktop writes to disk, where it lives, what it contains, and which threat tier it sits in. All `<userData>` paths are platform-resolved via `app.getPath("userData")` (macOS: `~/Library/Application Support/Nautilo/`, Linux: `~/.config/Nautilo/`, Windows: `%APPDATA%\Nautilo\`). `~/.nautilo/...` paths are cross-process state shared with CLI and server tooling (see `electron/paths.ts` family B).

| File | Shape | Encryption | Writer | Sensitivity |
|---|---|---|---|---|
| `<userData>/config.json` | Pairing / server-target fields as implemented (multi-target pairing); current schema accepts only `{ mode: "connect", serverUrl }` | plaintext, mode 0600 | `electron/config.ts` `saveConfig()` (atomic temp+rename) | Low — URLs are mildly personal but not secrets. Mode 0600 restricts access to the local user. Legacy `mode: "local"` / packaged-local configs are rejected by the parser and rerun the picker. |
| `<userData>/nautilo-auth-v1-enc` | OIDC token bundle (access + refresh) | safeStorage-encrypted (header `nautilo-auth-v1-enc`); plaintext fallback (header `nautilo-auth-v1-pt`, mode 0600) ONLY when `safeStorage.isEncryptionAvailable()` returns false (libsecret-less Linux) | `electron/auth/token-store.ts` (DI-pure) via `electron/auth/token-store-electron.ts` | High — bearers. Plaintext fallback is the one known plaintext-secret risk; gated by platform capability and documented at write time. |
| `<userData>/relay-token-<scope>.json` | Long-lived relay token + scope | safeStorage-encrypted preferred; plaintext fallback by same pattern as auth bundle | `electron/auth/relay-pair.ts` | High — relay bearer; scope-bound. Cleared on sign-out by `handleSignOut()` per §8c. |
| `<userData>/companion-layout.json` | View, dock, bubble appearance and window bounds | plaintext, mode 0600 | `electron/companion-window.ts` | Layout only; no messages, drafts, credentials or identity binding. |
| `<userData>/window-state.json` | `{ x, y, width, height }` | plaintext | `main.ts` `saveWindowState()` (debounced) | None. |
| `<userData>/current-folder.json` | path string | plaintext | `electron/recent-current-folders.ts` | Low — local fs path. |
| `<userData>/genie-workspace.json` | Genie workspace root path | plaintext | `electron/default-genie-workspace.ts` | Low. |
| `~/.nautilo/recent-current-folders.json` | recent-folders list | plaintext | legacy shared location | Low. |
| `~/.nautilo/posture.json` | security-posture sidecar | plaintext | Server/operator-owned legacy sidecar; desktop no longer provisions it after the connect-to-server transition | Low — operator policy, not secrets. |
| `~/.nautilo/session.json` | session token (legacy) | plaintext | reader at `main.ts:1595` (whoami bootstrap) | treat as transitional/inert; Logto tokens live in `nautilo-auth-v1-enc`. |
| `~/.nautilo/certs/ca.crt` | local development CA cert (PEM) | plaintext (public cert; key is not stored desktop-side) | external (CLI / nautilo-server bootstrap) — desktop reads only | None — the cert is public; the key never leaves the server side. |

**No sensitive data co-locates with `config.json`.** safeStorage is correctly applied to the two files that hold bearers. Plaintext-fallback for libsecret-less Linux is a documented existing trade-off (mode 0600).

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

For a disposable packaged test copy, modify an `app.asar` byte and confirm that runtime integrity enforcement refuses to launch it.

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
                                  (may switch among saved servers)
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

## 11. Packaging compatibility and release acceptance

Desktop requires macOS 13 (Ventura) or later. Keep
`mac.extendInfo.LSMinimumSystemVersion` in `electron-builder.yml` aligned with
the highest minimum required by the application and its always-required
embedded runtimes. Bundled Bun establishes the current macOS 13 floor; exact
runtime versions are recorded in `package.json`, `bun.lock`, and the root
`THIRD_PARTY_NOTICES.md`.

The bundled `gog` helper used for Google Workspace requires macOS 15 or later.
On macOS 13 and 14, Desktop remains supported: its runtime readiness probe
rejects the incompatible helper, omits the Google Workspace capability, and
reports the helper as unavailable without preventing application startup.

A source update is separate from a signed artifact and installed adoption.
Release acceptance should exercise first-run and sign-in, application menus,
Keychain prompts, navigation containment, local certificate handling, the
preload contract, and native tool execution on the packaged application.
On Linux, qualify the token-storage behavior both with and without an available
secret service; a plaintext fallback must remain visible to the operator.

## 12. Maintaining this contract

Update the affected contract sections when runtime ownership, a privileged
origin, preload capability, packaging requirement, or persistence boundary
changes. New windows need a corresponding threat-model entry in section 5.
Keep requirements and verification commands here; use source and tests to
establish the current implementation rather than retaining historical closure
receipts or phase tracking.
