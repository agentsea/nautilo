# Desktop package — runtime path lookup (STACK-4 Phase 2)

## ASAR inventory policy

Electron Builder may add the production dependency closure to `app.asar` even
though `electron-builder.yml` names only Nautilo's `dist` and `assets` trees.
Every package therefore runs `scripts/verify-package-inventory.ts` from the
`afterPack` hook before signing. The archive may contain only `package.json`,
`dist/`, `assets/`, and the production `node_modules/` closure. It must retain
`dist/main.js` and must not contain source maps, test payloads, environment
files, repository-private paths, private keys, or signing material.

Run the same check against any unpacked candidate with:

```bash
bun run --cwd apps/desktop verify:package-inventory -- \
  release/mac-arm64/Nautilo.app/Contents/Resources/app.asar
```

The inventory is a content-policy check, not a frozen size threshold. Release
work may keep iterating; every newly produced package must independently pass.

## Architecture (connect-to-server)

**Binding contract:** The packaged app is a **connect-to-server client** (see
[`PRODUCTION.md`](PRODUCTION.md), [`PACKAGING.md`](PACKAGING.md), and
[repository working rules](../../AGENTS.md)).
It does **not** ship `nautilo-server`, Postgres, Logto, Docker, DB migrations,
native server addons, or Workbench static under `dist/workbench/` as a
production load-bearing path — the paired **server** deployment serves
Workbench at `<serverUrl>/`.

**Verification state:** Phase 4b path sweep complete 2026-05-11; manifest reframed 2026-05-12 for D134. Each row tagged below.

## Workbench / server static serving (Stack 1)

| Topic | Status |
| --- | --- |
| Fastify root mount for the Vite workbench `dist/` on the **server** | **verified ✓ 2026-05-12** — `packages/server/src/app.ts` mounts `@fastify/static` at `/` when `NAUTILO_WORKBENCH_DIST` points at a valid directory with `index.html`; SPA fallback + `/api/*` guards as in commit `ef8ea575`. This is **operator-side** packaging, not a row in the desktop `.app` inventory. |

## What is in the shipped `.app` (D134 inventory)

End-user production (`connect`): **Electron main bundle**, **preload bundles** (Workbench + first-run + onboarding), **first-run picker** static UI, **onboarding wizard** static UI, **brand/tray assets**, and **vendored Bun** (IPC tooling shells out to Bun only). macOS additionally carries the first-party signed Computer Use Host, the qualified CUA driver, and the narrow screen-recording permission helper. Electron attests the immutable resources and brokers private inherited-pipe traffic; the Host owns CUA process supervision and provider parsing. No bundled `nautilo-server` binary tree, no `extraResources: dist/server`, no Docker Compose, no migrations, no Argon2 (or other server-native) artifacts in the desktop bundle, and no production reliance on `apps/desktop/dist/workbench/**` — that tree, if present in a dev/smoke build, is not the architecture-of-record for shipped users.

## Path matrix

| Caller | Symbol | Resolved path (packaged macOS) | Resolved path (packaged Win) | electron-builder rule | D134 / P4b verification |
| --- | --- | --- | --- | --- | --- |
| historical `electron/server.ts` | `getServerBinPath()` | _(would have been)_ `Contents/Resources/bin/nautilo-server/...` | _(would have been)_ `resources\bin\nautilo-server\...` | **N/A under D134** | Desktop does **not** bundle or spawn `nautilo-server`; no production requirement to ship this path. Historical “fix by adding `extraResources` for `bin/nautilo-server`” is **disposition: retired** — wrong product shape vs multi-instance **D133**. |
| `electron-builder.yml` | vendored Bun resource | `Contents/Resources/bun/<arch>/bun` | `resources\bun\<arch>\bun` | `extraResources` → `bun/**` | **verified ✓ 2026-05-11** — `electron-builder.yml` ships `vendor/bun → bun`; currently retained for desktop IPC/tooling that shells out to Bun. It is no longer used to spawn a bundled server. |
| `electron/main.ts` | main window preload | Inside app asar: `dist/preload.js` (via `__dirname` at runtime) | Same (asar) | `files` → `dist/**/*` | **verified ✓ 2026-05-11** — `path.join(__dirname, "preload.js")`; `dist/preload.js` from `scripts/build-electron.ts` and `files: dist/**/*`. |
| `electron/main.ts` | main bundle | `dist/main.js` (asar) | same | `files` → `dist/**/*` | **verified ✓ 2026-05-11** — `scripts/build-electron.ts` outputs `dist/main.js`; `package.json#main`. |
| `electron/main.ts` | first-run window | `dist/preload-first-run.js`, `dist/first-run/index.html` | same | `files` → `dist/**/*` | **verified ✓ 2026-05-11** — paths joined in `main.ts`; built by `scripts/build-electron.ts`. |
| `electron/main.ts` | onboarding window | `dist/preload-onboarding.js`, `dist/onboarding/index.html` | same | `files` → `dist/**/*` | **verified ✓ 2026-05-11** — same pattern as first-run. |
| `electron/main.ts` | workbench `loadURL` | **`https?://<paired-server>/…`** (Workbench + API on server origin) | same | **not** `dist/workbench` for production | **D134** — `workbenchUrl` comes from persisted pairing / first-run; server operator serves `/`. Desktop may still contain a `dist/workbench/` copy from dev/smoke builds; it is **not** the shipped production contract. |
| `electron/main.ts` | managed Computer Use Host seed | `Contents/Resources/tools-computer-use-host/{nautilo-computer-use-host,manifest.json}` | **N/A** | `mac.extraResources` → `tools-computer-use-host` | **verified ✓ D516 / 2026-09-01** — `createManagedComputerUseHostRuntime()` admits the bundled manifest and executable, stages an immutable managed copy below `app.getPath("userData")/computer-use-host`, and brokers it over inherited pipes. Linux/Windows package rules deliberately exclude this macOS-only runtime. |
| `electron/main.ts` | qualified CUA driver | `Contents/Resources/tools-cua/{cua-driver,manifest.json,LICENSE,PROVENANCE.md}` | **N/A** | `mac.extraResources` → `tools-cua` | **verified ✓ D516 / 2026-09-01** — `resolveBundledCuaDriverPath()` returns this exact packaged file only for a packaged Darwin app. Electron provides the attested path to the Host; neither Electron nor the Host uses a PATH or download fallback. |
| `electron/screen-recording-permission.ts` | screen-recording permission helper | `Contents/Resources/tools-permissions/nautilo-screen-recording-permission` | **N/A** | `mac.extraResources` → `tools-permissions` | **verified ✓ D516 / 2026-09-01** — source-built universal helper invokes the narrow native permission API. It is not downloaded at runtime and does not grant a renderer-selected executable path. |
| `electron/main.ts` | tray template icon | `…/assets/iconTemplate.png` (`path.join` `__dirname/../assets/…`) | same | `files` → `assets/**/*` | **verified ✓ 2026-05-11** — `electron-builder.yml` ships `assets/**/*`; template PNGs present on disk. |
| `electron/main.ts` | `app.getPath("userData")` / logs | OS userData dir (not inside .app) | same | n/a | **verified ✓ 2026-05-11** — `app.setName("Nautilo")` before readers; no mutable files beside the bundle. |
| historical `bin/nautilo-server` child | stdout ready line | `NAUTILO_SERVER_READY <url>` | same | n/a | **N/A under D134** — child-process “spawn server, read sentinel” is not the production boot path. **Disposition:** historical context only; desktop connect clients do not rely on this lifecycle. |

## Greppable anchors

- `process.resourcesPath` — vendored Bun plus the macOS Computer Use Host and CUA resources (`electron-builder.yml` `extraResources`).
- `__dirname` — preload, first-run, onboarding, tray asset joins (`main.ts`).
- `__dirname` / `../assets` — template PNG path beside compiled main.
- `app.getPath("userData")` — on-disk state outside the bundle.
- `app.getPath("crashDumps")` — native crash `.dmp` output path.

## Dev-only env (2.6)

| Variable | Where set | Packaged `main.ts` path | P4b verification |
| --- | --- | --- | --- |
| `NAUTILO_HOST` | `package.json` `dev` script default | **Not referenced** in `main.ts` boot — dev script only | **verified ✓ 2026-05-11** — `rg NAUTILO_HOST apps/desktop/electron/` returns no main-process consumers. |
| `VITE_NAUTILO_SERVER_URL`, `NAUTILO_WAIT_*` | _(removed)_ | **Not referenced** in packaged boot | **removed M167** — `dev:all` script and these env vars deleted; single-origin server serves workbench at `/`; no longer referenced anywhere. |

## Manual smoke tests (P4b.5 / P4b.6)

| Test | P4b status | Owner |
| --- | --- | --- |
| Spaces-in-path install (`/tmp/dir with spaces/Nautilo.app`) (P4b.5) | **deferred ✓ 2026-05-11** to P5 smoke harness | `scripts/smoke-paths.sh` |
| Moved-`.app` translocation (`/Applications/` → `~/Desktop/`) (P4b.6) | **deferred ✓ 2026-05-11** to P5 smoke harness | `scripts/smoke-paths.sh` |

Both require a packaged build artifact + GUI; not runnable headlessly inside a narrow agent scope. Recorded “deferred” so the smoke harness keeps them in scope.

---

_Phase 4b verification: path joins and dev-env rows verified ✓ on 2026-05-11. **D134 (2026-05-12):** server-bin and workbench-in-desktop rows are explicitly **N/A / retired** as production requirements; Workbench serving is operator-side via paired server URL._
