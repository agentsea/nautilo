# OfficeCLI binary provisioning and checksum policy

**Status:** Shipped. Binary is **provisioned at build/dev-start, never committed
to git** (M203). Runtime + provisioning helpers live in `@nautilo/config/officecli`.

OfficeCLI is the headless `.docx/.xlsx/.pptx` engine behind the `officecli` agent
tool (D372/D391/D396) and the Writer `import-docx` / `export-docx` app tools. This
document describes how the pinned binary is provisioned and integrity-checked.

## Decision summary

| Topic | Decision |
|---|---|
| **Where binaries live** | `packages/server/vendor/officecli/<platform-key>/officecli` (`.exe` on Windows) |
| **Committed to git?** | **No** (M203). A `.gitignore` in that tree ignores `*/officecli` + `*/officecli.exe`. Only `manifest.json`, `.version`, and `SHA256SUMS` are tracked. |
| **How it gets there** | Provisioned by `dev/scripts/vendor-officecli.ts <platform-key>` — fetch + verify sha256 + install. dev-stack runs this for the host key at start; Docker runs it for `linux-x64` at build. |
| **Manifest** | `packages/server/vendor/officecli/manifest.json` — local pin (per-platform sha256 + `url` for the vendor script). |
| **Integrity** | sha256 hex (lowercase, 64 chars) of raw binary bytes; optional `sizeMin` guard (~1MB). |
| **Version pin** | Semver in `manifest.officecli.version`; `.version` stamp file drives idempotent vendor-script / dev-stack-preflight freshness. |
| **Runtime resolution** | `resolveVendoredOfficeCliOrNull()` (vendored binary by default; `OFFICECLI_PATH` override) / `resolveOfficeCliOrNull()` / `officeCliAvailable()` in `@nautilo/config/officecli`. |
| **Tool gating** | The `officecli` agent tool + `import-docx` / `export-docx` app tools are registered only when `officeCliAvailable()` is true. On a host with no usable binary the tools are simply not offered (rather than always-failing). |
| **Failure mode** | Provisioning is **non-fatal** in dev-stack (a failure hides the tools, the server still boots). Runtime integrity (`verifyOfficeCliOnce`) fails closed: linux/win refuse a sha mismatch; darwin tolerates the codesign drift. |

Desktop and Server must pin the same OfficeCLI release. Update
`apps/desktop/vendor/tool-runtimes.manifest.json` and
`packages/server/vendor/officecli/manifest.json` together, retaining identical
URLs and SHA-256 digests for their shared macOS artifacts. Refresh the server
`.version`, the upstream `SHA256SUMS` record, and `THIRD_PARTY_NOTICES.md` in
the same change. The Desktop manifest suite checks this parity.

## Module home

The canonical module is **`@nautilo/config/officecli`**
(`packages/config/src/officecli/provisioning.ts` + `run.ts` + `generate.ts`).
It is a node-only subpath (imports `node:child_process` / `node:fs`) — do NOT add
it to the config barrel (`src/index.ts`), which must stay browser-safe.

> Historical note: this doc previously pointed at
> `packages/server/src/officecli-provisioning.ts`. That module was relocated to
> `@nautilo/config/officecli` (D396 Wave 2a) so both `@nautilo/agent` and
> `@nautilo/server` can import it without flipping the server→agent dependency
> edge.

## File layout

```
packages/server/vendor/officecli/
  .gitignore             # M203 — ignores */officecli + */officecli.exe (binaries never committed)
  manifest.json          # pinned version + per-platform sha256 + url (tracked)
  .version               # copy of manifest.officecli.version (freshness stamp; tracked)
  SHA256SUMS             # provenance record (tracked)
  <platform-key>/officecli   # provisioned at build/dev-start; git-ignored
```

Platform keys match `detectOfficeCliPlatformKey()`: `darwin-arm64`, `darwin-x64`,
`linux-arm64`, `linux-x64`, `win-x64`.

## Manifest format

Template: `dev/scripts/officecli/manifest.template.json`.

```json
{
  "officecli": {
    "version": "1.0.148",
    "source": "https://github.com/iOfficeAI/OfficeCLI",
    "license": "Apache-2.0",
    "binaryName": "officecli",
    "artifacts": {
      "linux-x64": {
        "sha256": "<64-char-lowercase-hex>",
        "sizeMin": 1000000,
        "url": "https://…upstream-release-url…"
      }
    }
  }
}
```

- **`sha256`** — required; verified on fetch and by `verifyOfficeCliOnce()`.
- **`sizeMin`** — optional truncation guard.
- **`url`** — upstream release URL the vendor script downloads from.
- **`binaryName`** — per-artifact override (`officecli.exe` on `win-x64`).

## How the binary is provisioned

### Dev (`bun run dev-stack`)

`bin/nautilo-dev/src/lib/officecli-preflight.ts` → `ensureOfficeCliProvisioned(repoRoot)`
runs **before the server child starts** so the freshly-started server can resolve
the binary. It is:

- **Idempotent / cached** — a `.version` stamp matching the manifest + a present,
  big-enough binary is a no-op (mirrors `apps/desktop/scripts/vendor-agent-browser.ts`
  `isFresh()`).
- **Non-fatal** — an unsupported platform, missing manifest, or failed download
  logs a warning and returns `false`; dev-stack still boots and the `officecli`
  tool self-gates via `officeCliAvailable()`.
- Provisions only the **host** platform key.

**Desktop Electron (`bun run dev-stack --electron`)** — M206 adds a separate,
fail-closed preflight via `ensureDesktopOfficeCliProvisioned(repoRoot)` that runs
**after the server is healthy and before Electron starts**. It provisions
`apps/desktop/vendor/officecli` (darwin-arm64 + darwin-x64) through
`apps/desktop/scripts/vendor-officecli.ts` (`bun run vendor:officecli` from
`apps/desktop`). A fresh stamp + both binaries is a no-op; a provisioning failure
aborts Electron launch (exit 1) rather than starting the relay without OfficeCLI.
Server-side provisioning above is unchanged and still non-fatal.

### Docker (build time)

`packaging/docker/Dockerfile` vendors the OfficeCLI binary matching the image's
`TARGETARCH` (arm64 → `linux-arm64`, amd64/other → `linux-x64`) via
`bun dev/scripts/vendor-officecli.ts <key>`. This keeps the vendored binary's
platform key aligned with the container's runtime arch so `officeCliAvailable()`
finds it and the `officecli` tool registers (an arm64 image that vendored
`linux-x64` would hide the tool). The image ships a verified binary; nothing
depends on a committed one. (Fuller multi-arch story: ISSUE-M201.)

### Manual

```bash
bun run officecli:vendor <platform-key>   # fetch + verify + install (e.g. linux-x64)
bun run officecli:verify                  # verify the vendored tree, print OFFICECLI_PATH
```

## Environment variables

| Variable | Role |
|---|---|
| `OFFICECLI_PATH` | Operator override — an explicit binary path (wins over the vendored binary). Must exist + be executable. |
| `OFFICECLI_VENDOR_ROOT` | Override the vendor directory (absolute or repo-relative). Default: `packages/server/vendor/officecli`. |
| `OFFICECLI_SKIP_UPDATE` | Forced to `1` by `buildOfficeCliEnv()` — pinned bytes must not self-mutate. |

## Zone routing (M203)

The `officecli` tool supports `zone: "workspace" | "current" | "absolute" | "home"
| "scratch"`. The binary **always runs server-side**; for `current` / `absolute`
the relay is used only as the byte-I/O transport (the same M174 `selectFileBackend`
seam the unified `file` tool uses):

1. Read the input bytes from the user's machine via `RelayFileBackend.readFile`.
2. Run OfficeCLI on the server against a staged temp copy.
3. Write the produced bytes back via `RelayFileBackend.writeFileAtomic` (with a
   `RelayFsChangeEvent` for the `current` zone so open editors / the Files tab
   refresh).

`current` / `absolute` writes require a connected v2 relay. In-place overwrite =
omit `out` or pass `out === path`; a distinct `out` writes a new file
(zero-clobber on the input). No relay ⇒ a clear "connect your desktop relay"
error, never a silent server-local write. There is no new relay execution class
and no desktop bundling of OfficeCLI. Workspace zone follows the same rule
(`out` omitted/`out === path` → update existing artifact; else mint new).

## TypeScript API (`@nautilo/config/officecli`)

- `parseOfficeCliManifest` / `loadOfficeCliManifest` — validate manifest JSON
- `detectOfficeCliPlatformKey` — host → artifact key
- `resolveOfficeCliVendorRoot` — vendor dir from env + repo root
- `resolveVendoredOfficeCliPath` — expected binary path
- `resolveVendoredOfficeCliOrNull` / `resolveOfficeCliOrNull` / `officeCliAvailable`
  — non-throwing availability probes (used by tool registration + the tool factory)
- `verifyOfficeCliBinary` / `checkOfficeCliProvisioning` — sha256 + size + exec checks
- `verifyOfficeCliOnce` — cached runtime integrity gate (darwin codesign-drift tolerant)
- `sha256HexOfBytes` / `sha256HexOfFile` — digest helpers

## Failure modes

| Condition | Error / behavior | Operator action |
|---|---|---|
| No manifest | `OfficeCliManifestError` (scripts) / preflight skips | Restore `manifest.json` |
| Unsupported host | `PLATFORM_UNSUPPORTED` / preflight skips | Use a supported arch |
| Binary missing | tools hidden (not registered) | `bun run officecli:vendor <key>` or run dev-stack |
| Not executable (unix) | `BINARY_NOT_EXECUTABLE` | `chmod +x` |
| Size below `sizeMin` | `SIZE_TOO_SMALL` | Re-vendor; likely truncated |
| sha256 mismatch | `CHECKSUM_MISMATCH` (linux/win refuse; darwin tolerates codesign drift) | Re-vendor / update manifest |

## Out of scope

- Docker multi-arch / `TARGETARCH`-aware vendoring → ISSUE-M201.
- Rewriting git history to purge the previously-committed ~33 MB blob (it remains
  in history; only the working-tree copy is removed + ignored going forward).
