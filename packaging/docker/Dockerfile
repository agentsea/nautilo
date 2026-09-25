# syntax=docker/dockerfile:1.7
# Nautilo server container image.
#
# Build shape (after the bundle fallback was triggered by argon2's
# native addon — see commit history for the trail):
#
#   Stage 1  manifests        → only package.json + bun.lock + every
#                              workspace package.json. Cache-stable as
#                              long as the dep graph is unchanged.
#   Stage 2  deps             → `bun install` WITH postinstalls so
#                              native bindings (argon2, ...) compile
#                              for linux/<arch> against the bun image's
#                              glibc. Requires python3+make+g++. Desktop-only
#                              native deps (node-pty, electron) are NOT built
#                              here — their trusted-dependency entries are
#                              stripped in the manifests stage so the install
#                              needs no outbound network.
#                              No `bun build` — runtime executes TS
#                              source directly via bun, which is the
#                              robust path for native + dynamic-require
#                              deps.
#   Stage 3  workbench-build  → derives node_modules from `deps` (one
#                              install). Copies only the source the
#                              workbench Vite bundle reads. Outputs the
#                              static SPA bundle.
#   Stage 4  mobile-web-build → derives the Expo static web export from `deps`.
#   Stage 5  runtime          → digest-pinned oven/bun:1.3.14 base (same glibc + bun
#                              version as deps → ABI match for the
#                              compiled .node files). Copies the
#                              minimum source tree the server entry
#                              point + its workspace-closure actually
#                              needs, plus `node_modules`, plus the
#                              workbench dist + migrations.
#
# DB bootstrap on first boot goes through `ensure-database.ts`'s
# container branch (NAUTILO_DB_BOOTSTRAP=container in the entrypoint):
# reads DB_DIRECT_CONNECTION, runs migrations against the in-compose
# app Postgres at /srv/migrations, never spawns host docker compose,
# never waits for a host-side Neon proxy (compose's depends_on already
# gates startup behind in-cluster app-postgres).
#
# Layering preserves the build cache across
# source-only edits. Layer ordering is dep-manifests → install →
# source. Postinstalls run ONCE in the deps stage, against an
# apt-installed build toolchain; the workbench-build stage derives its
# node_modules from deps. BuildKit cache mounts (bun + apt + node-gyp)
# make re-installs network-free and make argon2 native rebuilds skip
# the node-headers redownload. The runtime stage copies only the
# transitive workspace closure of `@nautilo/server-bin` — see
# packages/server/tests/unit/docker-runtime-closure.test.ts for the
# guardrail that pins the contract.
#
# Cache budget on incremental rebuilds:
#   - source-only edit:      ~30–60 s (manifests + deps layers hit)
#   - lockfile edit:         ~2–3 min (manifests miss, install hits bun cache)
#   - cold:                  comparable to the original build (~10 min) — irreducible
#
# BuildKit IS REQUIRED. Building with DOCKER_BUILDKIT=0 will fail at
# the first `--mount=type=cache` directive. BuildKit is default on
# Docker 23+ and Docker Desktop; if you see a "the --mount option
# requires BuildKit" error, run with `DOCKER_BUILDKIT=1 docker build
# ...` or upgrade Docker.

# ─── Stage 1: manifests ──────────────────────────────────────────────────────
# Just the package manifests — this layer is cache-stable as long as
# the dep graph is unchanged. Source edits don't reach here.
#
# IMPORTANT: every manifest must land at its workspace-relative path
# inside /repo, otherwise bun can't resolve `workspace:*` ranges. Do
# NOT collapse this block to `COPY apps/*/package.json apps/` or
# similar — the glob flattens the destination path. And do NOT do
# `COPY apps apps` + rely on `.dockerignore` to filter, because that
# re-introduces the source-edit cache-bust this stage is built to
# avoid.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS manifests
WORKDIR /repo
COPY package.json bun.lock ./
# Root `patchedDependencies` are install inputs just like the lockfile. Keep the
# exact pinned patches in this cache-stable stage so frozen installs can apply them.
COPY patches/@expo%2Fplist@0.8.1.patch \
     patches/@expo%2Fplist@0.8.1.patch
COPY patches/@assistant-ui%2Freact-lexical@0.2.4.patch \
     patches/@assistant-ui%2Freact-lexical@0.2.4.patch
COPY patches/@oomol-lab%2Fconnector@1.1.0.patch \
     patches/@oomol-lab%2Fconnector@1.1.0.patch
COPY patches/@langchain%2Flanggraph@1.2.9.patch \
     patches/@langchain%2Flanggraph@1.2.9.patch
COPY apps/cli/package.json                       apps/cli/package.json
COPY apps/desktop/package.json                   apps/desktop/package.json
COPY apps/mobile/package.json                    apps/mobile/package.json
COPY apps/workbench/package.json                 apps/workbench/package.json
COPY bin/nautilo-dev/package.json                bin/nautilo-dev/package.json
COPY bin/nautilo-local/package.json              bin/nautilo-local/package.json
COPY bin/nautilo-relay/package.json              bin/nautilo-relay/package.json
COPY bin/nautilo-reset-pin/package.json          bin/nautilo-reset-pin/package.json
COPY bin/nautilo-server/package.json             bin/nautilo-server/package.json
COPY bin/nautilo-smoke/package.json              bin/nautilo-smoke/package.json
COPY packages/acp-host/package.json              packages/acp-host/package.json
COPY packages/agent/package.json                 packages/agent/package.json
COPY packages/api-client/package.json            packages/api-client/package.json
COPY packages/attachments/package.json           packages/attachments/package.json
COPY packages/avatar/package.json                packages/avatar/package.json
COPY packages/browser-document-viewer/package.json packages/browser-document-viewer/package.json
COPY packages/catalog/package.json               packages/catalog/package.json
COPY packages/claude-agent-sdk-host/package.json packages/claude-agent-sdk-host/package.json
COPY packages/cli-auth/package.json              packages/cli-auth/package.json
COPY packages/cloudconvert/package.json          packages/cloudconvert/package.json
COPY packages/codex-app-server/package.json      packages/codex-app-server/package.json
COPY packages/codex-app-server-host/package.json packages/codex-app-server-host/package.json
COPY packages/compose-lifecycle/package.json     packages/compose-lifecycle/package.json
COPY packages/computer-use-contracts/package.json packages/computer-use-contracts/package.json
COPY packages/computer-use-host/package.json     packages/computer-use-host/package.json
COPY packages/computer-use-host-protocol/package.json packages/computer-use-host-protocol/package.json
COPY packages/config/package.json                packages/config/package.json
COPY packages/config-guard/package.json          packages/config-guard/package.json
COPY packages/db/package.json                    packages/db/package.json
COPY packages/event-feed/package.json            packages/event-feed/package.json
COPY packages/deploy-config/package.json         packages/deploy-config/package.json
COPY packages/fonts/package.json                 packages/fonts/package.json
COPY packages/generated-media-ui/package.json   packages/generated-media-ui/package.json
COPY packages/genie-customization-ui/package.json packages/genie-customization-ui/package.json
COPY packages/hosting/package.json               packages/hosting/package.json
COPY packages/instance-discovery/package.json    packages/instance-discovery/package.json
COPY packages/lattice-bridge/package.json        packages/lattice-bridge/package.json
COPY packages/lattice-crypto/package.json        packages/lattice-crypto/package.json
COPY packages/loffice/package.json               packages/loffice/package.json
COPY packages/logger/package.json                packages/logger/package.json
COPY packages/mcp-client/package.json            packages/mcp-client/package.json
COPY packages/message-invariants/package.json    packages/message-invariants/package.json
COPY packages/model-capabilities/package.json    packages/model-capabilities/package.json
COPY packages/operator-secrets/package.json      packages/operator-secrets/package.json
COPY packages/office-core/package.json           packages/office-core/package.json
COPY packages/office-docs/package.json           packages/office-docs/package.json
COPY packages/office-board/package.json          packages/office-board/package.json
COPY packages/office-slides/package.json         packages/office-slides/package.json
COPY packages/office-sheets/package.json         packages/office-sheets/package.json
COPY packages/profile-portability/package.json   packages/profile-portability/package.json
COPY packages/query-invariants/package.json      packages/query-invariants/package.json
COPY packages/railway-hosting/package.json       packages/railway-hosting/package.json
COPY packages/realtime-client/package.json       packages/realtime-client/package.json
COPY packages/relay/package.json                 packages/relay/package.json
COPY packages/reflection/package.json            packages/reflection/package.json
COPY packages/reflection-bridge/package.json     packages/reflection-bridge/package.json
COPY packages/runtime/package.json               packages/runtime/package.json
COPY packages/sandbox/package.json               packages/sandbox/package.json
COPY packages/security/package.json              packages/security/package.json
COPY packages/server/package.json                packages/server/package.json
COPY packages/smoke-runner/package.json          packages/smoke-runner/package.json
COPY packages/trust/package.json                 packages/trust/package.json
COPY packages/types/package.json                 packages/types/package.json
COPY packages/vault/package.json                 packages/vault/package.json
COPY packages/desktop-filesystem-grants/package.json  packages/desktop-filesystem-grants/package.json
COPY packages/document-mutations/package.json      packages/document-mutations/package.json
COPY packages/encryption-invariants/package.json   packages/encryption-invariants/package.json
COPY packages/workstation-profiles/package.json  packages/workstation-profiles/package.json
COPY packages/voice/package.json                 packages/voice/package.json
COPY packages/voice-catalog-ui/package.json      packages/voice-catalog-ui/package.json
COPY packages/workbench-components/package.json  packages/workbench-components/package.json
COPY packages/writer-proposal-core/package.json  packages/writer-proposal-core/package.json
COPY packages/first-party-apps/board/package.json \
     packages/first-party-apps/board/package.json
COPY packages/first-party-apps/writer/package.json \
     packages/first-party-apps/writer/package.json
COPY packages/first-party-apps/writer/bun.lock \
     packages/first-party-apps/writer/bun.lock
COPY packages/first-party-apps/video/package.json \
     packages/first-party-apps/video/package.json
COPY packages/first-party-apps/video/bun.lock \
     packages/first-party-apps/video/bun.lock
COPY packages/first-party-apps/design/package.json \
     packages/first-party-apps/design/package.json
COPY packages/first-party-apps/design/bun.lock \
     packages/first-party-apps/design/bun.lock
COPY dev/tools/electron-debug/package.json       dev/tools/electron-debug/package.json
COPY dev/tools/genie-lab/package.json            dev/tools/genie-lab/package.json
COPY dev/tools/nautilo-backup/package.json       dev/tools/nautilo-backup/package.json
COPY dev/tools/nautilo-db/package.json           dev/tools/nautilo-db/package.json
COPY dev/tools/nautilo-server-logs/package.json  dev/tools/nautilo-server-logs/package.json
COPY dev/tools/png-to-svg/package.json           dev/tools/png-to-svg/package.json
COPY dev/tools/security-smoke/package.json       dev/tools/security-smoke/package.json
COPY deploy/compose-driver/package.json          deploy/compose-driver/package.json

# Prep the root package.json BEFORE `bun install`, two surgical edits:
#
#  1. Delete the root `postinstall` — it runs `lefthook install` (dev git hooks;
#     no .git dir in this container, .dockerignore excluded it) which has no
#     runtime role and would fail the build.
#
#  2. Drop `electron` + `node-pty` from `trustedDependencies` so bun does NOT
#     run their lifecycle scripts. Both are desktop/relay-only deps the server
#     never loads (the `terminal` tool is executor:"relay"; node-pty runs on the
#     relay). node-pty ships darwin/win32 prebuilds only → on linux its install
#     falls through to `node-gyp rebuild` (node-gyp not on PATH → exit 127);
#     electron's postinstall downloads its ~100MB binary. Both fetch over HTTPS
#     and also fail behind a TLS-intercepting proxy ("unable to get local issuer
#     certificate"), and are pure waste in the server image regardless. Do NOT
#     `--ignore-scripts` — argon2 + other needed native postinstalls must still
#     run. Host `bun install` is unaffected (this edit only happens in-image;
#     root package.json still trusts both for desktop dev).
RUN /usr/local/bin/bun -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.scripts.postinstall;if(Array.isArray(p.trustedDependencies))p.trustedDependencies=p.trustedDependencies.filter((d)=>d!=="electron"&&d!=="node-pty");fs.writeFileSync("package.json",JSON.stringify(p,null,2))'

# ─── Stage 2: deps (native postinstalls run here) ────────────────────────────
# Builds against the manifests-only tree. This stage caches the entire
# node_modules tree across builds — source edits don't bust it because
# no source has been COPYed into the image yet.
#
# BuildKit cache mounts:
#   - /var/cache/apt + /var/lib/apt/lists → apt's package cache.
#   - /root/.bun/install/cache → bun's tarball cache. Without this,
#     every re-install re-downloads every tarball.
#   - /root/.cache/node-gyp → node-gyp's headers/binaries cache.
#     Without this, argon2 redownloads node headers on every native
#     build.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
WORKDIR /repo
# Preserve the exact prepared manifests in one layer. Inheriting their many
# individual COPY layers exhausts overlay depth in the Workbench build stage.
COPY --from=manifests /repo/ /repo/
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++

# Real install. Native deps that ship bundled prebuilds (argon2, etc.) link
# with no network; the desktop-only `node-pty` + `electron` build scripts are
# skipped in the manifests stage (removed from `trustedDependencies` in-image),
# so this stage needs NO outbound network — important behind a TLS-intercepting
# proxy where node-gyp header + Electron binary downloads fail cert validation
# ("unable to get local issuer certificate"). The server never loads node-pty
# (terminal is executor:"relay") or Electron, so not building them is correct.
#
# --linker=hoisted: pin the flat node_modules layout. bun's isolated linker
# (which this repo's workspace graph now resolves to) leaves packages only under
# node_modules/.bun/<pkg>@<ver> without the top-level / per-workspace links the
# runtime needs, so the server crashes at boot with
# `Cannot find package 'dotenv' from bin/nautilo-server/src/index.ts`. The
# runtime stage copies node_modules wholesale + runs TS source directly, so it
# requires the hoisted (flat) layout the known-good image shipped.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    --mount=type=cache,target=/root/.cache/node-gyp,sharing=locked \
    bun install --frozen-lockfile --linker=hoisted

# App installation is deliberately after the root install: changing the
# installer script must not invalidate the expensive dependency layer.
COPY dev/scripts/install-first-party-apps.ts dev/scripts/install-first-party-apps.ts

# Writer's app-local `file:` dependencies snapshot these packages. Materialize
# their source only after the cache-stable root install, before installing the
# apps. Otherwise Bun creates empty nested dependencies from the manifests-only
# package directories and Writer cannot be seeded at server startup.
COPY packages/types packages/types
COPY packages/writer-proposal-core packages/writer-proposal-core
COPY packages/generated-media-ui packages/generated-media-ui

# Writer's owned engine must be compiled before the standalone app install
# snapshots its file dependencies. These are normal workspace builds; retain
# their complete dist (including dynamically loaded spell dictionaries).
COPY turbo.json turbo.json
COPY packages/office-core packages/office-core
COPY packages/office-docs packages/office-docs
RUN bunx turbo run build --filter=@nautilo/office-docs...

# First-party mini-app dependencies are intentionally app-local because
# installed app source is built from its own folder. Keep each app's dependency
# tree beside its seeded source so `scanInstalledApps` reports dependency-backed
# first-party apps as ready in clean containers.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun dev/scripts/install-first-party-apps.ts \
 && find /repo/packages/first-party-apps -type f -name '*.map' -delete \
 && find /repo/packages/first-party-apps/*/node_modules -type d \
      \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name benchmark -o -name benchmarks -o -name example -o -name examples -o -name .turbo \) \
      ! -exec test -f '{}/package.json' ';' \
      -prune -exec rm -rf '{}' +

# ─── Stage 2b: production server dependency closure ────────────────────────
# The full `deps` tree above is intentionally available to the Workbench build
# and first-party app installers. It is not a valid runtime payload: copying it
# would ship every desktop/mobile/dev dependency. The generated projection is
# the deterministic runtime install boundary.
# This stage consumes the generated dependency projection: production workspace
# edges only, projected manifests without dev inputs, reviewed root overrides,
# and a dedicated frozen lockfile. The invariant suite reconstructs the
# projection and rejects drift.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS runtime-deps
WORKDIR /repo
COPY packaging/docker/runtime-install/ ./
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    --mount=type=cache,target=/root/.cache/node-gyp,sharing=locked \
    bun install --frozen-lockfile --production --linker=hoisted \
 && find /repo/node_modules /repo/bin /repo/packages -type f -name '*.map' -delete \
 && find /repo/node_modules /repo/bin /repo/packages -type d \
      \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name benchmark -o -name benchmarks -o -name example -o -name examples -o -name .turbo \) \
      ! -exec test -f '{}/package.json' ';' \
      -prune -exec rm -rf '{}' +

# ─── Stage 3: workbench static bundle ────────────────────────────────────────
# Derives node_modules from `deps` (one install). Copies the source
# tree the Vite build actually reads — the workbench app plus every
# workspace package in its transitive closure. Conservative: keep this
# list aligned with `apps/workbench/package.json` workspace deps + their
# transitive workspace closure.
#
# Use turbo (not `bun run --filter`) so the `^build` dep edge fires —
# `@nautilo/workbench` imports `@nautilo/workbench-components/dist/runtime.js`
# which only exists after that package's tsup build runs.
FROM deps AS workbench-build
WORKDIR /repo
COPY tsconfig.base.json nautilo.config.ts turbo.json ./
# Canonical shared brand artwork imported by the maintenance applying gate.
# Keep this scoped to the Workbench build so unrelated brand assets do not
# invalidate dependency or runtime-source layers.
COPY assets/brand/nautilo-logo_v1_logo_only_transparent.png assets/brand/nautilo-logo_v1_logo_only_transparent.png
COPY apps/workbench                apps/workbench
# Browser-safe connection presentation contracts imported directly by the
# Workbench Desktop surface. Keep this exact closure narrow: it is build input,
# not Desktop runtime content in the server image.
COPY apps/desktop/electron/server-target.ts apps/desktop/electron/server-target.ts
COPY apps/desktop/electron/connection-attempt.ts apps/desktop/electron/connection-attempt.ts
COPY apps/desktop/electron/connection-presentation.ts apps/desktop/electron/connection-presentation.ts
COPY apps/desktop/electron/connection-support-receipt.ts apps/desktop/electron/connection-support-receipt.ts
COPY apps/desktop/electron/ready-to-work-contract.ts apps/desktop/electron/ready-to-work-contract.ts
COPY apps/desktop/electron/mini-app-draft-recovery-contract.ts apps/desktop/electron/mini-app-draft-recovery-contract.ts
COPY apps/desktop/electron/companion-contract.ts apps/desktop/electron/companion-contract.ts
COPY packages/api-client           packages/api-client
COPY packages/attachments          packages/attachments
COPY packages/computer-use-contracts packages/computer-use-contracts
COPY packages/computer-use-host-protocol packages/computer-use-host-protocol
COPY packages/config               packages/config
COPY packages/config-guard         packages/config-guard
COPY packages/genie-customization-ui packages/genie-customization-ui
COPY packages/generated-media-ui   packages/generated-media-ui
COPY packages/lattice-bridge       packages/lattice-bridge
COPY packages/logger               packages/logger
COPY packages/lattice-crypto       packages/lattice-crypto
COPY packages/model-capabilities   packages/model-capabilities
# Transitive via @nautilo/api-client (profile-bundle types). Source must be
# present for tsc during the workbench Vite build — package.json alone (manifests)
# is not enough.
COPY packages/profile-portability  packages/profile-portability
COPY packages/realtime-client      packages/realtime-client
COPY packages/security             packages/security
COPY packages/types                packages/types
COPY packages/vault                packages/vault
COPY packages/voice-catalog-ui     packages/voice-catalog-ui
COPY packages/workbench-components packages/workbench-components
COPY packages/browser-document-viewer packages/browser-document-viewer
COPY packages/desktop-filesystem-grants   packages/desktop-filesystem-grants
COPY packages/document-mutations   packages/document-mutations
COPY packages/workstation-profiles   packages/workstation-profiles
COPY packages/writer-proposal-core packages/writer-proposal-core
# First-party helpers imported directly by Workbench source. Scoped here (not
# manifests/deps) so first-party source edits bust only workbench-build.
COPY packages/first-party-apps/writer packages/first-party-apps/writer
COPY packages/first-party-apps/video packages/first-party-apps/video
RUN --mount=type=cache,target=/repo/.turbo/cache,sharing=locked \
    --mount=type=cache,target=/repo/apps/workbench/node_modules/.vite,sharing=locked \
    bunx turbo run build --filter=@nautilo/workbench
# Output: apps/workbench/dist/

# ─── Stage 4: Mobile Web static export ──────────────────────────────────────
# Expo/Metro reads the app source directly and follows workspace imports via
# the hoisted dependency tree inherited from `deps`. Keep this closure scoped
# to the Mobile app and its actual workspace import graph; it never belongs in
# the runtime payload.
FROM deps AS mobile-web-build
WORKDIR /repo
COPY tsconfig.base.json tsconfig.base.json
COPY apps/mobile apps/mobile
COPY dev/fixtures/assistant-response-gfm-table.ts dev/fixtures/assistant-response-gfm-table.ts
COPY packages/api-client packages/api-client
COPY packages/browser-document-viewer packages/browser-document-viewer
COPY packages/config packages/config
COPY packages/config-guard packages/config-guard
COPY packages/lattice-crypto packages/lattice-crypto
COPY packages/logger packages/logger
COPY packages/profile-portability packages/profile-portability
COPY packages/realtime-client packages/realtime-client
COPY packages/types packages/types
COPY packages/writer-proposal-core packages/writer-proposal-core
# Metro's default cache location is /tmp/metro-cache. Retain it only as a
# BuildKit cache: output is always written fresh into apps/mobile/dist.
RUN --mount=type=cache,target=/tmp/metro-cache,sharing=locked \
    bun run --cwd apps/mobile export:web
# Output: apps/mobile/dist/

# ─── Build-time auth contract ────────────────────────────────────────────────
# The release preflight reads this JSON directly from the incoming image; it
# never needs to start the server container. The generator imports the
# bootstrap's exported desired-state constants and writes no runtime IDs,
# endpoints, or secret values. Source copies are limited to the generator's
# audited import closure so unrelated context edits do not bust this layer.
FROM deps AS auth-contract
WORKDIR /repo
COPY deploy/contracts/generate-auth-contract.ts deploy/contracts/generate-auth-contract.ts
COPY deploy/contracts/auth.ts                       deploy/contracts/auth.ts
COPY deploy/dependency-pins.ts                      deploy/dependency-pins.ts
COPY bin/nautilo-local/src/bootstrap-logto.ts       bin/nautilo-local/src/bootstrap-logto.ts
COPY bin/nautilo-local/src/logto-hosted-auth-branding.ts \
     bin/nautilo-local/src/logto-hosted-auth-branding.ts
COPY bin/nautilo-local/src/logto-forgot-password-relay.ts \
     bin/nautilo-local/src/logto-forgot-password-relay.ts
COPY packages/config                                packages/config
COPY packages/config-guard                          packages/config-guard
COPY packages/logger                                packages/logger
COPY packages/types                                 packages/types
RUN bun deploy/contracts/generate-auth-contract.ts

# ─── OfficeCLI vendor (architecture-keyed, source-edit stable) ───────────────
# Isolate the network fetch from mutable runtime source copies. Keyed by the
# vendor script, its config import closure, manifest.json, and TARGETARCH.
FROM deps AS officecli-vendor
WORKDIR /repo
COPY dev/scripts/vendor-officecli.ts                dev/scripts/vendor-officecli.ts
COPY packages/config/src/vendored-binary-fetch.ts   packages/config/src/vendored-binary-fetch.ts
COPY packages/config/src/vendored-binary.ts         packages/config/src/vendored-binary.ts
COPY packages/config/src/officecli/provisioning.ts  packages/config/src/officecli/provisioning.ts
COPY packages/config/src/officecli/capacity.ts      packages/config/src/officecli/capacity.ts
COPY packages/config/src/officecli/run.ts           packages/config/src/officecli/run.ts
COPY packages/server/vendor/officecli/manifest.json \
     packages/server/vendor/officecli/manifest.json
ARG TARGETARCH
RUN OFFICECLI_ARCH="linux-x64"; \
    if [ "$TARGETARCH" = "arm64" ]; then OFFICECLI_ARCH="linux-arm64"; fi; \
    bun dev/scripts/vendor-officecli.ts "$OFFICECLI_ARCH"

# ─── agent-browser vendor (architecture-keyed, source-edit stable) ──────────
# The Browser Use connected-account control lane may attach this CLI to a
# provider-owned remote CDP endpoint. Fetch the Linux binary independently of
# Desktop's Electron-only vendor cache and only from the pinned manifest.
FROM deps AS agent-browser-vendor
WORKDIR /repo
COPY dev/scripts/vendor-agent-browser.ts           dev/scripts/vendor-agent-browser.ts
COPY packages/config/src/vendored-binary-fetch.ts  packages/config/src/vendored-binary-fetch.ts
COPY packages/config/src/vendored-binary.ts        packages/config/src/vendored-binary.ts
COPY packages/server/vendor/agent-browser/manifest.json \
     packages/server/vendor/agent-browser/manifest.json
ARG TARGETARCH
RUN AGENT_BROWSER_ARCH="linux-x64"; \
    if [ "$TARGETARCH" = "arm64" ]; then AGENT_BROWSER_ARCH="linux-arm64"; fi; \
    bun dev/scripts/vendor-agent-browser.ts "$AGENT_BROWSER_ARCH"

# The portable restore must talk to both topology-owned database majors. A
# PG17 client cannot restore its output into Logto's PG16 server because it
# emits PG17-only session settings such as transaction_timeout.
FROM postgres@sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b AS pg16-client

# ─── Nautilo Office Sheets artifact ────────────────────────────────────────
# Build the owned office workspace closure and include compiled app artifacts
# by default. An explicit build opt-out leaves `/out` empty.
FROM deps AS wafflebase-sheets-build
WORKDIR /repo
# Fingerprint the original build input, not deps' install-only manifest rewrite.
COPY package.json ./
ARG NAUTILO_WAFFLEBASE_SHEETS=1
COPY turbo.json tsconfig.base.json ./
COPY packages/office-core packages/office-core
COPY packages/office-sheets packages/office-sheets
COPY packaging/wafflebase/artifacts.mjs packaging/wafflebase/upstream.json packaging/wafflebase/
COPY packages/first-party-apps/spreadsheet packages/first-party-apps/spreadsheet
RUN \
    case "$NAUTILO_WAFFLEBASE_SHEETS" in \
      0) mkdir -p /out ;; \
      1) bun packaging/wafflebase/artifacts.mjs /out/spreadsheet/engine \
         && mkdir -p /out/spreadsheet \
         && cp -a packages/first-party-apps/spreadsheet/. /out/spreadsheet/ ;; \
      *) echo "NAUTILO_WAFFLEBASE_SHEETS must be 0 or 1" >&2; exit 64 ;; \
    esac

# ─── Nautilo Office Slides artifact ─────────────────────────────────────────
# Build the owned office workspace closure and include compiled app artifacts
# by default. An explicit build opt-out leaves `/out` empty.
FROM deps AS wafflebase-slides-build
WORKDIR /repo
COPY package.json ./
ARG NAUTILO_WAFFLEBASE_SLIDES=1
COPY turbo.json tsconfig.base.json ./
COPY packages/office-core packages/office-core
COPY packages/office-docs packages/office-docs
COPY packages/office-slides packages/office-slides
COPY packaging/wafflebase/slides-artifacts.mjs packaging/wafflebase/upstream.json packaging/wafflebase/
COPY packages/first-party-apps/presentation packages/first-party-apps/presentation
RUN \
    case "$NAUTILO_WAFFLEBASE_SLIDES" in \
      0) mkdir -p /out ;; \
      1) bun packaging/wafflebase/slides-artifacts.mjs /out/presentation/engine \
         && cp -a packages/first-party-apps/presentation/. /out/presentation/ ;; \
      *) echo "NAUTILO_WAFFLEBASE_SLIDES must be 0 or 1" >&2; exit 64 ;; \
    esac

# ─── Nautilo Office Board artifact ──────────────────────────────────────────
# Build the complete owned Board closure for every server image. Human app
# enablement remains persisted runtime state and is intentionally not a build
# selection.
FROM deps AS wafflebase-board-build
WORKDIR /repo
COPY package.json ./
COPY turbo.json tsconfig.base.json ./
COPY packages/office-core packages/office-core
COPY packages/office-docs packages/office-docs
COPY packages/office-slides packages/office-slides
COPY packages/office-board packages/office-board
COPY packaging/wafflebase/slides-artifacts.mjs packaging/wafflebase/board-artifacts.ts packaging/wafflebase/upstream.json packaging/wafflebase/
COPY packages/first-party-apps/board packages/first-party-apps/board
RUN mkdir -p /out/board \
 && cp -a packages/first-party-apps/board/. /out/board/ \
 && rm -rf /out/board/engine \
 && bun packaging/wafflebase/board-artifacts.ts /out/board/engine

# ─── Stage 4: runtime ────────────────────────────────────────────────────────
# Same base as deps so the compiled .node files are ABI-compatible.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS runtime
COPY --from=pg16-client /usr/lib/postgresql/16/bin/pg_dump /usr/local/bin/pg_dump16
COPY --from=pg16-client /usr/lib/postgresql/16/bin/pg_restore /usr/local/bin/pg_restore16
COPY --from=pg16-client /usr/lib/postgresql/16/bin/psql /usr/local/bin/psql16
COPY packaging/docker/server-security-package-floors.txt /tmp/server-security-package-floors.txt
COPY packaging/docker/check-security-package-floors.sh /tmp/check-security-package-floors.sh
# tini/ca-certificates: process reaping and TLS roots. The health probe uses
# Bun's built-in fetch so curl and its unused native dependency chain stay out.
# libicu: OfficeCLI is a self-contained .NET binary that requires ICU for
# globalization; without it every officecli invocation FailFasts with
# "Couldn't find a valid ICU package installed on the system". Install the
# runtime ICU lib version-agnostically (highest available libicuNN) so it
# survives Debian base-image bumps rather than pinning e.g. libicu76.
# chromium-headless-shell: OfficeCLI's screenshot renderer requires a browser.
# OfficeCLI probes the canonical Chromium executable name, so expose the
# smaller headless-only package there instead of installing the full browser.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && ICU_PKG="$(apt-cache search --names-only '^libicu[0-9]+$' | sort -V | tail -n1 | cut -d' ' -f1)" \
 && if [ -z "$ICU_PKG" ]; then echo "no libicuNN package found in apt lists" >&2; exit 1; fi \
 && apt-get install -y --no-install-recommends tini ca-certificates chromium-headless-shell postgresql-client-17 tar "$ICU_PKG" \
 && install -m 0755 /usr/lib/postgresql/17/bin/pg_dump /usr/local/bin/pg_dump \
 && install -m 0755 /usr/lib/postgresql/17/bin/pg_restore /usr/local/bin/pg_restore \
 && install -m 0755 /usr/lib/postgresql/17/bin/psql /usr/local/bin/psql \
 && apt-get purge -y postgresql-client-17 postgresql-client-common perl libperl5.40 perl-modules-5.40 \
 && for package in postgresql-client-17 postgresql-client-common perl libperl5.40 perl-modules-5.40; do \
      if dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii'; then \
        echo "unexpected maintenance build dependency retained: $package" >&2; exit 1; \
      fi; \
    done \
 && pg_dump --version \
 && pg_restore --version \
 && psql --version \
 && pg_dump16 --version | grep -F '16.' \
 && pg_restore16 --version | grep -F '16.' \
 && psql16 --version | grep -F '16.' \
 && ln -s /usr/bin/chromium-headless-shell /usr/bin/chromium \
 && sh /tmp/check-security-package-floors.sh /tmp/server-security-package-floors.txt \
 && rm /tmp/check-security-package-floors.sh /tmp/server-security-package-floors.txt

WORKDIR /srv
# Artifact bytes are persisted to the `app_artifacts` named volume
# mounted at /var/lib/nautilo/artifacts (NAUTILO_ARTIFACTS_ROOT in the
# deploy compose template). This runtime stage runs as root (no USER
# directive), so the root-owned volume mountpoint is writable as-is — no
# mkdir/chown needed here.

# node_modules carry the compiled native addons (argon2 .node files)
# and the hoisted workspace symlinks, so they MUST come from the
# production-filtered runtime-deps stage (where postinstalls ran against this
# image's libc/ABI). Root manifests come from runtime-deps too — `bun.lock` is
# immutable from the build context's perspective once the lockfile is frozen,
# and keeping the three artifacts together makes runtime-deps the canonical
# "runtime install completed" boundary. Placed immediately after WORKDIR so
# source-only / derived-output edits do not re-copy this stable tree,
# preserving the cache topology.
COPY --from=runtime-deps /repo/package.json ./repo/package.json
COPY --from=runtime-deps /repo/bun.lock     ./repo/bun.lock
COPY --from=runtime-deps /repo/node_modules ./repo/node_modules
# Repo-root files the manifests stage doesn't carry (they aren't part
# of the install closure, so they live outside the deps stage's
# filesystem). Pull them from the build context instead.
COPY tsconfig.base.json ./repo/tsconfig.base.json
COPY nautilo.config.ts  ./repo/nautilo.config.ts
COPY turbo.json         ./repo/turbo.json

# Server source comes from the build CONTEXT, not from `deps`.
# Rationale: source is never copied into `deps` (that would invalidate
# the install layer's downstream — workbench-build's Vite cache —
# whenever any source file changes). Pulling source per-package from
# the context here gives Docker a per-path content hash, so a
# source-only edit in (say) `apps/desktop/` doesn't bust any of these
# `packages/*` COPY layers, and an edit in `packages/agent/` only
# busts the `packages/agent` COPY. That's the actual cache topology
# the incremental build budget assumes.
#
# Do NOT switch any of these to `COPY packages ./repo/packages` —
# that re-introduces the 6 dropped workspace packages and silently
# makes the runtime image grow. The closure-guard test at
# `packages/server/tests/unit/docker-runtime-closure.test.ts` fails
# if either (a) the runtime stage drops a package the server
# transitively imports, or (b) the runtime stage adds a package not
# in the closure.

# bin/: only nautilo-server is in the runtime closure. The other five
# (dev, local, relay, reset-pin, smoke) are dev / operator / desktop
# tools the container never executes.
COPY bin/nautilo-server ./repo/bin/nautilo-server

# packages/: the transitive workspace-package closure of
# `@nautilo/server-bin`.
# Update this list whenever a server-side package adds a workspace dep
# on a package not yet listed; the closure-guard test will fail at PR
# time if you forget.
COPY packages/acp-host            ./repo/packages/acp-host
COPY packages/agent               ./repo/packages/agent
COPY packages/api-client          ./repo/packages/api-client
COPY packages/attachments         ./repo/packages/attachments
COPY packages/catalog             ./repo/packages/catalog
COPY packages/cloudconvert        ./repo/packages/cloudconvert
COPY packages/computer-use-contracts ./repo/packages/computer-use-contracts
COPY packages/computer-use-host-protocol ./repo/packages/computer-use-host-protocol
COPY packages/config              ./repo/packages/config
COPY packages/config-guard        ./repo/packages/config-guard
COPY packages/db                  ./repo/packages/db
COPY packages/event-feed          ./repo/packages/event-feed
COPY packages/document-mutations  ./repo/packages/document-mutations
COPY packages/encryption-invariants ./repo/packages/encryption-invariants
COPY packages/fonts               ./repo/packages/fonts
COPY packages/lattice-bridge      ./repo/packages/lattice-bridge
# Runtime-only Lattice crypto surface. Exclude its Rust/WASM builder, mutation
# tooling, playground, and build inputs; runtime loads the reviewed vendored
# WASM artifact lazily from vendor/openmls-wasm.
COPY packages/lattice-crypto/package.json ./repo/packages/lattice-crypto/package.json
COPY packages/lattice-crypto/src          ./repo/packages/lattice-crypto/src
COPY packages/lattice-crypto/vendor       ./repo/packages/lattice-crypto/vendor
COPY packages/lattice-crypto/LICENSE.lattice-lab \
     packages/lattice-crypto/NOTICE \
     packages/lattice-crypto/THIRD_PARTY_NOTICES.md \
     packages/lattice-crypto/THIRD_PARTY_NOTICES.cargo.md \
     ./repo/packages/lattice-crypto/
COPY packages/loffice             ./repo/packages/loffice
COPY packages/logger              ./repo/packages/logger
COPY packages/mcp-client          ./repo/packages/mcp-client
COPY packages/message-invariants  ./repo/packages/message-invariants
COPY packages/model-capabilities  ./repo/packages/model-capabilities
COPY packages/operator-secrets    ./repo/packages/operator-secrets
COPY packages/profile-portability ./repo/packages/profile-portability
COPY packages/relay               ./repo/packages/relay
COPY packages/reflection          ./repo/packages/reflection
COPY packages/reflection-bridge   ./repo/packages/reflection-bridge
COPY packages/runtime             ./repo/packages/runtime
COPY packages/sandbox             ./repo/packages/sandbox
COPY packages/security            ./repo/packages/security
COPY packages/server              ./repo/packages/server
# OfficeCLI binary vendored in the dedicated officecli-vendor stage.
COPY --from=officecli-vendor /repo/packages/server/vendor/officecli \
     ./repo/packages/server/vendor/officecli
# Raw CDP attachment tooling for the future Browser Use connected-account lane.
# The server creates no browser here and does not expose this binary to agents.
COPY --from=agent-browser-vendor /repo/packages/server/vendor/agent-browser \
     ./repo/packages/server/vendor/agent-browser
COPY THIRD_PARTY_NOTICES.md ./legal/THIRD_PARTY_NOTICES.md
COPY packages/trust               ./repo/packages/trust
COPY packages/types               ./repo/packages/types
COPY packages/vault               ./repo/packages/vault
COPY packages/desktop-filesystem-grants  ./repo/packages/desktop-filesystem-grants
COPY packages/workstation-profiles  ./repo/packages/workstation-profiles
COPY packages/voice               ./repo/packages/voice
COPY packages/writer-proposal-core ./repo/packages/writer-proposal-core
COPY --from=deps /repo/packages/office-core/dist ./repo/packages/office-core/dist
COPY packages/office-core/LICENSE packages/office-core/NOTICE.md ./repo/packages/office-core/
COPY --from=deps /repo/packages/office-docs/dist ./repo/packages/office-docs/dist
COPY packages/office-docs/LICENSE packages/office-docs/NOTICE.md packages/office-docs/DICTIONARY-LICENSE.txt ./repo/packages/office-docs/

# Source copies above carry repository manifests intended for local
# development. Overlay the installed projection so the image keeps both its
# generated manifests and workspace-local node_modules links when two
# workspaces require incompatible versions of the same package.
COPY --from=runtime-deps /repo/bin/nautilo-server ./repo/bin/nautilo-server
COPY --from=runtime-deps /repo/packages ./repo/packages

# Non-workspace first-party runtime assets consumed by server startup seeding
# (mini-app registry). Keep the default image explicit: only shipped apps
# are copied from context. The Sheets stage contributes its reviewed artifact
# closure unless the build explicitly opts out. Restore app-local dependency
# trees after source copies because source overlay would otherwise empty them.
COPY packages/first-party-apps/writer ./repo/packages/first-party-apps/writer
COPY packages/first-party-apps/video ./repo/packages/first-party-apps/video
COPY packages/first-party-apps/design ./repo/packages/first-party-apps/design
# Host declaration only; this adds no installable app or engine to default builds.
COPY packages/first-party-apps/spreadsheet/src/live-tool-contract.ts \
     ./repo/packages/first-party-apps/spreadsheet/src/live-tool-contract.ts
COPY --from=wafflebase-sheets-build /out/ ./repo/packages/first-party-apps/
COPY packages/first-party-apps/presentation/src/live-tool-contract.ts \
     ./repo/packages/first-party-apps/presentation/src/live-tool-contract.ts
COPY --from=wafflebase-slides-build /out/ ./repo/packages/first-party-apps/
COPY --from=wafflebase-board-build /out/ ./repo/packages/first-party-apps/
COPY --from=deps /repo/packages/first-party-apps/design/node_modules \
     ./repo/packages/first-party-apps/design/node_modules
COPY --from=deps /repo/packages/first-party-apps/writer/node_modules \
     ./repo/packages/first-party-apps/writer/node_modules
COPY --from=deps /repo/packages/first-party-apps/video/node_modules \
     ./repo/packages/first-party-apps/video/node_modules
# The generic Writer node_modules copy does not retain the source files of its
# local `file:` packages in the final image. Restore those snapshots explicitly
# so seeding can dereference Writer's dependency tree at startup.
COPY packages/types \
     ./repo/packages/first-party-apps/writer/node_modules/@nautilo/types
COPY packages/writer-proposal-core \
     ./repo/packages/first-party-apps/writer/node_modules/@nautilo/writer-proposal-core
COPY packages/office-core \
     ./repo/packages/first-party-apps/writer/node_modules/@nautilo/office-core
COPY packages/office-docs \
     ./repo/packages/first-party-apps/writer/node_modules/@nautilo/office-docs
COPY --from=deps /repo/packages/office-core/dist \
     ./repo/packages/first-party-apps/writer/node_modules/@nautilo/office-core/dist
COPY --from=deps /repo/packages/office-docs/dist \
     ./repo/packages/first-party-apps/writer/node_modules/@nautilo/office-docs/dist
# Video imports the same app-local `file:` snapshot of shared public types.
COPY packages/types \
     ./repo/packages/first-party-apps/video/node_modules/@nautilo/types
COPY packages/generated-media-ui \
     ./repo/packages/first-party-apps/video/node_modules/@nautilo/generated-media-ui

# Migrations resolved by ensure-database.ts's container branch via
# NAUTILO_MIGRATIONS_DIR (default /srv/migrations from the entrypoint).
COPY packages/db/src/migrations ./migrations

COPY packaging/docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Workbench dist served by the server when NAUTILO_WORKBENCH_DIST is set.
# Placed after mutable runtime assembly so workbench-only edits do not
# invalidate the server source / first-party / migration layers.
COPY --from=workbench-build /repo/apps/workbench/dist ./workbench

# Expo's optional Mobile Web export is a static payload only. It shares the
# server origin under /mobile but never adds Mobile dependencies to runtime.
COPY --from=mobile-web-build /repo/apps/mobile/dist ./mobile-web

# Versioned, secret-free desired Logto state for release preflight inspection.
COPY --from=auth-contract /out/auth-contract.json ./contracts/auth-contract.json

ARG NAUTILO_SOURCE_SHA
RUN printf '%s' "$NAUTILO_SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$'
LABEL org.opencontainers.image.revision="${NAUTILO_SOURCE_SHA}" \
      org.opencontainers.image.source="https://github.com/agentsea/nautilo"

ARG NAUTILO_DEPLOYMENT_ID=""
ENV NAUTILO_DEPLOYMENT_ID=${NAUTILO_DEPLOYMENT_ID}
ENV NAUTILO_HOST=0.0.0.0
ENV NAUTILO_PORT=3001
ENV NAUTILO_WORKBENCH_DIST=/srv/workbench
ENV NAUTILO_MOBILE_WEB_DIST=/srv/mobile-web
ENV NAUTILO_MIGRATIONS_DIR=/srv/migrations
EXPOSE 3001

# Plain HTTP because the deploy stack sets NAUTILO_DISABLE_TLS=1 in the
# compose env, which disables the LAN-host TLS branch of @nautilo/config's
# effectiveServerScheme. The host port-forward is the trust boundary.
HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=5 \
  CMD bun -e 'const response = await fetch(`http://localhost:${process.env.NAUTILO_PORT}/health`); if (!response.ok) process.exit(1)'

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/srv/entrypoint.sh"]
