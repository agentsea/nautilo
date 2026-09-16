# @nautilo/desktop

Electron desktop app — wraps the workbench (`apps/workbench/`) in a native window with secure IPC, system tray, and macOS packaging.

> **Production contract**: see [`PRODUCTION.md`](./PRODUCTION.md). Anything shipping into a packaged build is governed by that document — modes, port policy, threat model, fuse decisions, audit findings.

## Development

**Desktop-only** (connect picker, per-profile):

```bash
# From monorepo root:
bun run desktop <profile>

# Or from this directory:
bun run dev
```

Builds the Electron bundle and runs in connect mode. A profile with a committed
server reconnects directly; a new profile opens the server picker. Set
`NAUTILO_FORCE_FIRST_RUN=1` only when deliberately retesting the picker.
Isolated per `(instance, profile)` — you can run 2–3 desktop instances at once
against any server.

**Full local stack** (infra + workbench build + server + Electron):

```bash
bun run dev-stack --electron
```

Electron always loads through the connect bootstrap shell at `serverUrl/`
(dev included). Chat with Genie works identically to the browser.

## Architecture

The Electron window always loads the workbench via HTTP(S), never from `file://`. The workbench uses relative URLs (`/api/*`, `/ws`) that require a server origin.

### Logto password sign-in (D112 Phase 15)

When `/api/setup/status` reports `claimed-needs-auth`, the renderer shows the workbench first-run gate — including the **Password** and **Device flow** tabs — which call `POST /api/auth/logto-password-login` on loopback. No extra Electron IPC was added for password entry.

### Server pairing

On first launch the packaged app opens the server picker. The selected server
persists in `<userData>/config.json` (see [Config location](#config-location)
below), and the picker is skipped on subsequent launches. The packaged app is
a client: it does not bundle or start a Nautilo server.

| Choice | What it does | When to use it |
|------|-------------|---------------|
| **Discovered server** | Selects a Nautilo server found during the bounded local-network scan. | A server on the same LAN |
| **Server URL** | Connects to a server URL entered by the user and verifies its setup state before saving it. | Localhost, homelab, team, or remote server |

Hosted-product availability is tracked on the
[public release-status page](https://nautilo.ai/product-release-status).

### Local Network server discovery (macOS)

The server picker performs one fresh bounded Bonjour browse for `_nautilo._tcp`
when it opens and another fresh bounded browse each time you choose **Retry
local scan**. Packaged macOS builds declare this picker-initiated Local Network
use in their shared `Info.plist`; signed and unsigned packages use the same
declaration. Discovery is optional: entering a server URL manually, including
`localhost` or another loopback URL, continues to work when a scan returns no
additional servers or cannot complete.

If you expected a LAN server, confirm Nautilo is enabled under **System Settings → Privacy & Security → Local Network**, then use **Retry local scan**. macOS has no manual **Add App** control for this permission; a newly packaged build must make the declared request before it can appear. An empty or failed Bonjour browse is not treated as proof of the current permission state. No sandbox entitlement is required or added.

An ad-hoc package can prove the final plist, bundle identity, executable UUID,
and signature structure without launching the app. Prompt, allow, deny, and
prior-denial recovery acceptance requires a stable Developer-ID build in a
snapshot-revert VM or disposable macOS user so the evidence does not modify the
installed Nautilo app, its profile, or the operator's existing TCC state.

`NAUTILO_PROFILE` isolates Electron user data; it does not choose a Nautilo
server instance or clone a database. Pair it with `NAUTILO_CONNECT_SERVER_URL`
when running multiple clients or worktrees. Stop only the Electron process you
started; server and Compose shutdown remain separate `nautilo-dev` operations.

### Dev-mode workflow (unpackaged)

There is no Vite dev server. Running from source is `bun run desktop <profile>`
(connect picker via `NAUTILO_FORCE_FIRST_RUN=1`) or `bun run dev-stack --electron`
for the full stack. Dev connects to the server via `NAUTILO_CONNECT_SERVER_URL`
(or the localhost default from `@nautilo/config`) through the bootstrap shell —
Electron never loads a separate workbench port.

### macOS permissions in a development instance

`--instance` selects the Nautilo server/data root; macOS permissions belong to
the Electron host application, not to that instance. Include `--electron` when
starting the stack if you need to grant or inspect Accessibility, Screen
Recording, or Microphone access:

```bash
bun run dev-stack \
  --instance desktop-permissions \
  --electron
```

In the Desktop window, open **Settings → Desktop permissions**. Use
the action on the relevant row to request access or open the exact macOS
Privacy & Security pane. Computer Use also links to this same Settings card
when a required permission is missing. Restart only the development Electron
process when a row says a restart is required.

Source Electron and the signed `/Applications/Nautilo.app` are separate macOS
TCC identities. Granting one does not grant the other. The setup reminder
preference is intentionally shared across Nautilo development profiles on the
same macOS account; disabling automatic setup does not change or cache the real
macOS permission state. Use **Run guided setup** in the Settings card to reopen
the required two-step flow at any time.

### Config location

```
macOS     ~/Library/Application Support/Nautilo/config.json
Linux     ~/.config/Nautilo/config.json
Windows   %USERPROFILE%\AppData\Roaming\Nautilo\config.json
```

Schema (version 1):

```jsonc
{
  "version": 1,
  "mode": "local" | "connect" | "cloud",
  "serverUrl": "https://..."   // required when mode === "connect"
}
```

Delete the file to re-trigger the picker. Schema-version mismatches auto-invalidate.

### Env-var overrides

| Variable | Effect |
|---------|--------|
| `NAUTILO_CONNECT_SERVER_URL` | Skip picker + local server; point directly at this URL. |
| `NAUTILO_FORCE_FIRST_RUN=1` | Force the first-run picker to appear even if config exists. |

`NAUTILO_FORCE_FIRST_RUN=1` is the developer-facing way to re-test the first-run picker UX (mode selection, URL probe, `/api/setup/status` claim-state messaging) without nuking `<userData>` between iterations — set it in front of `bun run dev`, `bun run package:dev`, or the launched `.app` and the picker will re-appear regardless of any persisted `config.json`. The persisted config is left untouched; if the user cancels, the previous mode/URL is still loadable on the next launch without the env var.

## Bundled runtime (D057 2a.2)

Packaged builds ship the Bun runtime inside the `.app` at `Contents/Resources/bun/<arch>/bun`. Produced at build time by `scripts/vendor-bun.ts` (runs automatically from `bun run package:mac` / `package:linux` / `package:win` / `package:dev`; idempotent, cached by version).

Pinned Bun version: see `scripts/vendor-bun.ts` `BUN_VERSION`. Keep in sync with the root monorepo's toolchain version.

Bundled binaries + license live under `vendor/bun/` (gitignored). `electron-builder.yml` copies them via `extraResources`.

### Security

Non-negotiable defaults — the renderer is fully sandboxed:

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- All IPC through `contextBridge.exposeInMainWorld()` in the preload script

### Desktop Detection

The preload exposes `window.nautiloDesktop` via contextBridge. The workbench detects this at runtime:

```ts
const isDesktop = typeof window !== "undefined" && "nautiloDesktop" in window;
```

No build-time flags. The browser version works unchanged.

## Build

```bash
bun run build:electron   # Compile main.ts + preload.ts → dist/
bun run package:dev      # Unpackaged test build (current OS)
bun run package:mac      # Full DMG build (macOS)
bun run package:linux    # Full AppImage (Linux)
bun run package:win      # Full NSIS installer (Windows)
```

## File Structure

```
electron/
  main.ts       — Main process: BrowserWindow, tray, IPC handlers
  preload.ts    — contextBridge.exposeInMainWorld("nautiloDesktop", ...)
  types.d.ts    — Window interface augmentation for nautiloDesktop
assets/
  iconTemplate.png    — macOS tray icon (auto dark/light)
  iconTemplate@2x.png — Retina variant
```

## Building and checking packages

Contributor packages use ad-hoc macOS signatures without release credentials.
Official Desktop releases are operated outside this source tree. See
[packaging and artifact trust](PACKAGING.md) for build defaults, helper identities
and artifact verification, and [release channels](../../RELEASE.md) for download
and updater contracts.

| Command in `apps/desktop` | Output |
| --- | --- |
| `bun run package:dev` | Local app directory under `release/` for the build architecture. |
| `bun run package:mac` | Ad-hoc universal macOS DMG, ZIP and updater metadata. |
| `bun run package:linux` | Linux AppImage; native qualification is separate. |
| `bun run package:win` | Windows installer; native qualification is separate. |

After building, run `bun run smoke`, `bun run smoke:ports` and `bun run smoke:paths`.
Use absolute `SMOKE_APP_PATH` and `APP_PATH` for a non-default app directory.
The [contributor packaging workflow](../../.github/workflows/desktop-package.yml)
also exercises the macOS build and smoke checks without publishing assets.
These checks cover package behavior; live pairing, authentication and native
permission acceptance require an isolated test environment.
