// M118: stage-shape regression guard.
//
// Asserts the Dockerfile keeps the M118 stages plus the build-time auth
// contract artifact stage and isolated vendored-binary stages:
//   manifests → deps → workbench-build + auth-contract + binary vendors → runtime
// And that the BuildKit cache mounts are wired on the install / apt
// `RUN` directives that need them. And that the pre-M118 cache-busting
// `COPY . .` is gone from the manifests / deps stages.
//
// Also guards `.dockerignore` against over-aggressive entries that would
// silently break the workbench Vite build or strip runtime assets.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const DOCKERFILE_PATH = join(REPO_ROOT, "packaging/docker/Dockerfile");
const DOCKERIGNORE_PATH = join(REPO_ROOT, ".dockerignore");
// Roots in which workspace `package.json` files live. MUST match the
// `workspaces` glob in the root `package.json` — bun's
// `--frozen-lockfile` install fails fast if any workspace manifest
// referenced by `bun.lock` is missing from the build context.
const WORKSPACE_PARENTS = [
  "packages",
  "apps",
  "bin",
  "dev/tools",
  "deploy",
] as const;

/** Exact workspace manifests below the one-level workspace parents. */
const EXPLICIT_WORKSPACE_MANIFESTS = [
  "packages/first-party-apps/board/package.json",
] as const;

/** First-party mini-apps with app-local installs — manifest + lock only in `manifests`. */
const FIRST_PARTY_APP_INSTALL_INPUTS = [
  "packages/first-party-apps/writer/package.json",
  "packages/first-party-apps/writer/bun.lock",
  "packages/first-party-apps/video/package.json",
  "packages/first-party-apps/video/bun.lock",
  "packages/first-party-apps/design/package.json",
  "packages/first-party-apps/design/bun.lock",
] as const;

/** Root Bun patched dependencies required by every frozen root install. */
const ROOT_PATCHED_DEPENDENCY_INPUTS = Object.values(
  (
    JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      patchedDependencies?: Record<string, string>;
    }
  ).patchedDependencies ?? {},
);

/** Audited source closure for `deploy/contracts/generate-auth-contract.ts`. */
const AUTH_CONTRACT_COPY_CLOSURE = [
  "deploy/contracts/generate-auth-contract.ts",
  "deploy/contracts/auth.ts",
  "deploy/dependency-pins.ts",
  "bin/nautilo-local/src/bootstrap-logto.ts",
  "bin/nautilo-local/src/logto-hosted-auth-branding.ts",
  "bin/nautilo-local/src/logto-forgot-password-relay.ts",
  "packages/config",
  "packages/config-guard",
  "packages/logger",
  "packages/types",
] as const;

/** Audited import closure for `dev/scripts/vendor-officecli.ts`. */
const OFFICECLI_VENDOR_COPY_CLOSURE = [
  "dev/scripts/vendor-officecli.ts",
  "packages/config/src/vendored-binary-fetch.ts",
  "packages/config/src/vendored-binary.ts",
  "packages/config/src/officecli/provisioning.ts",
  "packages/config/src/officecli/capacity.ts",
  "packages/config/src/officecli/run.ts",
  "packages/server/vendor/officecli/manifest.json",
] as const;

/** Audited import closure for the server-only agent-browser vendor script. */
const AGENT_BROWSER_VENDOR_COPY_CLOSURE = [
  "dev/scripts/vendor-agent-browser.ts",
  "packages/config/src/vendored-binary-fetch.ts",
  "packages/config/src/vendored-binary.ts",
  "packages/server/vendor/agent-browser/manifest.json",
] as const;

/** Turbo 2.9.7 default monorepo cache dir (repo root `.turbo/cache`). */
const TURBO_BUILD_CACHE_MOUNT = "/repo/.turbo/cache";

/** Vite 6.4.2 default cache dir for `@nautilo/workbench` (`node_modules/.vite`). */
const VITE_BUILD_CACHE_MOUNT = "/repo/apps/workbench/node_modules/.vite";
/** Metro's verified default disk cache location for the Expo web export. */
const METRO_BUILD_CACHE_MOUNT = "/tmp/metro-cache";

/** Workbench Vite bundle imports Writer preview helpers from first-party source. */
const WORKBENCH_BUILD_WRITER_INPUT = "packages/first-party-apps/writer" as const;
/** Workbench Vite bundle imports Video document and generation helpers directly. */
const WORKBENCH_BUILD_VIDEO_INPUT = "packages/first-party-apps/video" as const;
/** Workbench imports the shared workstation access-grant contracts. */
const WORKBENCH_BUILD_DESKTOP_FILESYSTEM_GRANTS_INPUT = "packages/desktop-filesystem-grants" as const;
/** Workbench desktop helpers import the shared document mutation contracts. */
const WORKBENCH_BUILD_DOCUMENT_MUTATIONS_INPUT = "packages/document-mutations" as const;
/** Workbench pulls api-client, which imports profile-portability types. */
const WORKBENCH_BUILD_PROFILE_PORTABILITY_INPUT = "packages/profile-portability" as const;
/** Workbench's Lattice dev dependency adds lattice-crypto's build task to Turbo's closure. */
const WORKBENCH_BUILD_LATTICE_CRYPTO_INPUT =
  "packages/lattice-crypto" as const;
/** Exact browser-safe Desktop source closure imported by Workbench. */
const WORKBENCH_BUILD_DESKTOP_CONNECTION_INPUTS = [
  "apps/desktop/electron/server-target.ts",
  "apps/desktop/electron/connection-attempt.ts",
  "apps/desktop/electron/connection-presentation.ts",
  "apps/desktop/electron/connection-support-receipt.ts",
] as const;
/** Workbench's browser viewer policy package must be present in a clean image build. */
const WORKBENCH_BUILD_BROWSER_DOCUMENT_VIEWER_INPUT =
  "packages/browser-document-viewer" as const;
const WORKBENCH_PACKAGE_JSON = join(REPO_ROOT, "apps/workbench/package.json");
/** Canonical repository-level artwork imported by the maintenance applying gate. */
const WORKBENCH_BUILD_MAINTENANCE_BRAND_ASSET =
  "assets/brand/nautilo-logo_v1_logo_only_transparent.png" as const;
const WORKBENCH_BUILD_MAINTENANCE_BRAND_COPY =
  `COPY ${WORKBENCH_BUILD_MAINTENANCE_BRAND_ASSET} ${WORKBENCH_BUILD_MAINTENANCE_BRAND_ASSET}` as const;

/** Writer first-party app manifest — source of `file:` dependency declarations. */
const WRITER_APP_PACKAGE_JSON = join(
  REPO_ROOT,
  "packages/first-party-apps/writer/package.json",
);

/** Runtime overlay target for Writer app-local `file:` packages after deps copy. */
const WRITER_RUNTIME_FILE_DEP_OVERLAY_PREFIX =
  "./repo/packages/first-party-apps/writer/node_modules/" as const;
const VIDEO_APP_PACKAGE_JSON = join(
  REPO_ROOT,
  "packages/first-party-apps/video/package.json",
);

/** Stable deps artifacts copied wholesale into runtime `/srv/repo`. */
const RUNTIME_DEPS_NODE_MODULES_COPY =
  "COPY --from=runtime-deps /repo/node_modules ./repo/node_modules" as const;

/** Derived workbench SPA bundle served at NAUTILO_WORKBENCH_DIST. */
const RUNTIME_WORKBENCH_DIST_COPY =
  "COPY --from=workbench-build /repo/apps/workbench/dist ./workbench" as const;
/** Derived Expo web payload served at NAUTILO_MOBILE_WEB_DIST. */
const RUNTIME_MOBILE_WEB_DIST_COPY =
  "COPY --from=mobile-web-build /repo/apps/mobile/dist ./mobile-web" as const;

/** Audited workspace source closure for the Expo Mobile Web export. */
const MOBILE_WEB_BUILD_COPY_CLOSURE = [
  "tsconfig.base.json",
  "apps/mobile",
  "dev/fixtures/assistant-response-gfm-table.ts",
  "packages/api-client",
  "packages/browser-document-viewer",
  "packages/config",
  "packages/config-guard",
  "packages/lattice-crypto",
  "packages/logger",
  "packages/profile-portability",
  "packages/realtime-client",
  "packages/types",
  "packages/writer-proposal-core",
] as const;

/** Build-time auth contract consumed by release preflight. */
const RUNTIME_AUTH_CONTRACT_COPY =
  "COPY --from=auth-contract /out/auth-contract.json ./contracts/auth-contract.json" as const;

/** First mutable context source copy in the runtime assembly block. */
const RUNTIME_FIRST_MUTABLE_CONTEXT_COPY =
  "COPY tsconfig.base.json ./repo/tsconfig.base.json" as const;

/** Build orchestration is not an install input and must not bust `bun install`. */
const MANIFESTS_EXCLUDED_NON_INSTALL_INPUTS = [
  "turbo.json",
  "dev/scripts/install-first-party-apps.ts",
] as const;

/** Last filesystem-producing step before metadata directives. */
const RUNTIME_ENTRYPOINT_CHMOD = "RUN chmod +x ./entrypoint.sh" as const;

/** First runtime metadata directive after filesystem assembly. */
const RUNTIME_FIRST_METADATA_DIRECTIVE = 'ARG NAUTILO_DEPLOYMENT_ID=""' as const;

function runtimeDirectiveIndex(stageBody: string, needle: string): number {
  const idx = stageBody.indexOf(needle);
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx;
}

type Stage = { name: string; from: string; body: string };

function parseStages(dockerfile: string): Stage[] {
  const lines = dockerfile.split("\n");
  const stages: Stage[] = [];
  let current: Stage | null = null;
  const fromRe = /^FROM\s+(?:--platform=\S+\s+)?(\S+)\s+AS\s+(\S+)\s*$/i;
  for (const raw of lines) {
    const line = raw;
    const m = fromRe.exec(line.trim());
    if (m) {
      if (current) stages.push(current);
      current = { name: m[2]!, from: m[1]!, body: "" };
      continue;
    }
    if (current) current.body += line + "\n";
  }
  if (current) stages.push(current);
  return stages;
}

/** Collect the first source token from each context `COPY` in a stage body. */
function collectContextCopySources(stageBody: string): string[] {
  const sources: string[] = [];
  const copyRe = /^\s*COPY\s+(?:--[^\s]+\s+)*(\S+)/gm;
  let hit: RegExpExecArray | null;
  while ((hit = copyRe.exec(stageBody))) {
    const src = hit[1]!;
    if (src.startsWith("--from=")) continue;
    sources.push(src);
  }
  return sources;
}

function stageContainsCopySource(stageBody: string, required: string): boolean {
  return collectContextCopySources(stageBody).some(
    (src) => src === required || src.startsWith(`${required}/`),
  );
}

describe("M118 Dockerfile stage shape", () => {
  const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
  const stages = parseStages(dockerfile);
  const byName = new Map(stages.map((s) => [s.name, s] as const));

  test("has the named build and runtime stages", () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        "agent-browser-vendor",
        "auth-contract",
        "deps",
        "manifests",
        "mobile-web-build",
        "officecli-vendor",
        "pg16-client",
        "runtime",
        "runtime-deps",
        "wafflebase-board-build",
        "wafflebase-sheets-build",
        "wafflebase-slides-build",
        "workbench-build",
      ],
    );
  });

  test("manifests stage has no `COPY . .`", () => {
    const m = byName.get("manifests");
    expect(m).toBeDefined();
    expect(/^\s*COPY\s+\.\s+\.\s*$/m.test(m!.body)).toBe(false);
  });

  test("manifests stage includes every pinned Bun patch required by the root install", () => {
    const manifests = byName.get("manifests");
    expect(manifests).toBeDefined();
    expect(ROOT_PATCHED_DEPENDENCY_INPUTS.length).toBeGreaterThan(0);
    for (const patch of ROOT_PATCHED_DEPENDENCY_INPUTS) {
      expect(stageContainsCopySource(manifests!.body, patch)).toBe(true);
    }
  });

  test("deps stage has no `COPY . .`", () => {
    const d = byName.get("deps");
    expect(d).toBeDefined();
    expect(/^\s*COPY\s+\.\s+\.\s*$/m.test(d!.body)).toBe(false);
  });

  test("deps flattens prepared manifests onto the same pinned base", () => {
    const d = byName.get("deps");
    expect(d?.from).toBe(byName.get("manifests")?.from);
    expect(d!.body).toContain("COPY --from=manifests /repo/ /repo/");
  });

  test("runtime dependency stage consumes the generated production projection", () => {
    const runtimeDeps = byName.get("runtime-deps");
    expect(runtimeDeps?.from).toBe(
      "oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
    );
    expect(runtimeDeps!.body).toContain("COPY packaging/docker/runtime-install/ ./");
    expect(runtimeDeps!.body).toContain("--production");
    expect(runtimeDeps!.body).toContain("--frozen-lockfile");
    expect(runtimeDeps!.body).not.toContain("--filter @nautilo/server-bin");
    expect(runtimeDeps!.body).not.toMatch(/^\s*COPY\s+\.\s+\.\s*$/m);
  });

  test("manifests stage excludes files that do not affect the root dependency install", () => {
    const manifests = byName.get("manifests");
    expect(manifests).toBeDefined();
    for (const excluded of MANIFESTS_EXCLUDED_NON_INSTALL_INPUTS) {
      expect(stageContainsCopySource(manifests!.body, excluded)).toBe(false);
    }
  });

  test("workbench-build stage derives from deps", () => {
    const w = byName.get("workbench-build");
    expect(w?.from).toBe("deps");
  });

  test("mobile-web-build derives from deps with only its audited source closure", () => {
    const mobile = byName.get("mobile-web-build");
    expect(mobile?.from).toBe("deps");
    expect(mobile).toBeDefined();
    const copied = collectContextCopySources(mobile!.body).sort();
    expect(copied).toEqual([...MOBILE_WEB_BUILD_COPY_CLOSURE].sort());
    expect(mobile!.body).not.toMatch(/^\s*COPY\s+\.\s+\.\s*$/m);
    expect(mobile!.body).not.toMatch(/^\s*COPY\s+packages\s+packages\s*$/m);
    expect(mobile!.body).not.toMatch(/\bbun\s+install\b/);
    expect(mobile!.body).not.toMatch(
      /^\s*(?:ARG|ENV)\s+.*(?:DB_|SECRET|TOKEN|ANDROID_HOME|XCODE)/im,
    );
    expect(mobile!.body).not.toMatch(/^\s*COPY\s+.*\.env(?:\s|$)/im);
  });

  test("mobile-web-build runs the validated export with only Metro's grounded cache", () => {
    const mobile = byName.get("mobile-web-build");
    expect(mobile).toBeDefined();
    const runBlocks = collectRunBlocks(mobile!.body);
    expect(runBlocks).toHaveLength(1);
    expect(runBlocks[0]).toContain("bun run --cwd apps/mobile export:web");
    expect(runBlocks[0]).toContain(
      `--mount=type=cache,target=${METRO_BUILD_CACHE_MOUNT},sharing=locked`,
    );
    expect(runBlocks[0]).not.toContain("/root/.bun/install/cache");
  });

  test("first-party app installation materializes Writer file dependencies after root install", () => {
    const d = byName.get("deps");
    expect(d).toBeDefined();
    const rootInstall = d!.body.indexOf("bun install --frozen-lockfile --linker=hoisted");
    const firstPartyInstall = d!.body.indexOf("bun dev/scripts/install-first-party-apps.ts");

    expect(rootInstall).toBeGreaterThanOrEqual(0);
    expect(firstPartyInstall).toBeGreaterThan(rootInstall);

    for (const dep of collectWriterFileDependencies()) {
      const sourceCopy = d!.body.indexOf(`COPY ${dep.sourceRepoPath} ${dep.sourceRepoPath}`);
      expect(sourceCopy).toBeGreaterThan(rootInstall);
      expect(sourceCopy).toBeLessThan(firstPartyInstall);
    }
  });

  test("copies the first-party app installer only after the root dependency install", () => {
    const d = byName.get("deps");
    expect(d).toBeDefined();
    const rootInstall = d!.body.indexOf("bun install --frozen-lockfile --linker=hoisted");
    const installerCopy = d!.body.indexOf(
      "COPY dev/scripts/install-first-party-apps.ts dev/scripts/install-first-party-apps.ts",
    );
    const firstPartyInstall = d!.body.indexOf("bun dev/scripts/install-first-party-apps.ts");

    expect(rootInstall).toBeGreaterThanOrEqual(0);
    expect(installerCopy).toBeGreaterThan(rootInstall);
    expect(firstPartyInstall).toBeGreaterThan(installerCopy);
  });

  test("every `bun install` RUN is preceded on the same RUN by a --mount=type=cache", () => {
    // Collect each multi-line `RUN ...` block; check the ones that invoke
    // `bun install` have at least one `--mount=type=cache,...` directive
    // in the same logical RUN (line continuations with trailing `\`).
    const runBlocks = collectRunBlocks(dockerfile);
    const installBlocks = runBlocks.filter((b) => /\bbun\s+install\b/.test(b));
    expect(installBlocks.length).toBeGreaterThanOrEqual(1);
    for (const block of installBlocks) {
      expect(block).toMatch(/--mount=type=cache/);
    }
  });

  test("every `apt-get update` RUN is preceded on the same RUN by a --mount=type=cache", () => {
    const runBlocks = collectRunBlocks(dockerfile);
    const aptBlocks = runBlocks.filter((b) => /\bapt-get\s+update\b/.test(b));
    expect(aptBlocks.length).toBeGreaterThanOrEqual(1);
    for (const block of aptBlocks) {
      expect(block).toMatch(/--mount=type=cache/);
    }
  });

  test("syntax directive enables BuildKit dockerfile features", () => {
    expect(/^#\s*syntax=docker\/dockerfile:1\./m.test(dockerfile)).toBe(true);
  });

  test("manifests stage COPYs every workspace package.json on disk", () => {
    // `bun install --frozen-lockfile` walks `bun.lock`'s workspace entries
    // and fails fast if any referenced workspace manifest is missing from
    // the build context. Enumerate every package.json the workspaces glob
    // would pick up and assert the Dockerfile copies each one.
    const onDisk: string[] = [...EXPLICIT_WORKSPACE_MANIFESTS];
    for (const parent of WORKSPACE_PARENTS) {
      const parentAbs = join(REPO_ROOT, parent);
      if (!existsSync(parentAbs)) continue;
      for (const sub of readdirSync(parentAbs)) {
        const pj = join(parentAbs, sub, "package.json");
        if (existsSync(pj)) onDisk.push(`${parent}/${sub}/package.json`);
      }
    }
    const m = byName.get("manifests");
    expect(m).toBeDefined();
    // Collect every `COPY <src> <dst>` in the manifests stage where the
    // src ends with `package.json`.
    const copyRe = /^\s*COPY\s+(?:--[^\s]+\s+)*(\S+package\.json)\s+/gm;
    const copied = new Set<string>();
    let hit: RegExpExecArray | null;
    while ((hit = copyRe.exec(m!.body))) {
      copied.add(hit[1]!);
    }
    const missing = onDisk.filter((p) => !copied.has(p)).sort();
    expect(missing).toEqual([]);
  });

  test("Sheets stage builds by default and retains the explicit opt-out", () => {
    const sheets = byName.get("wafflebase-sheets-build");
    expect(sheets?.from).toBe("deps");
    expect(sheets!.body).toContain("ARG NAUTILO_WAFFLEBASE_SHEETS=1");
    expect(sheets!.body).toContain("0) mkdir -p /out");
    expect(sheets!.body).toContain(
      "1) bun packaging/wafflebase/artifacts.mjs /out/spreadsheet/engine",
    );
    for (const source of [
      // deps rewrites this manifest for installation; provenance needs the original.
      "package.json",
      "packages/office-core",
      "packages/office-sheets",
      "packaging/wafflebase/artifacts.mjs",
      "packages/first-party-apps/spreadsheet",
    ]) {
      expect(stageContainsCopySource(sheets!.body, source)).toBe(true);
    }
    expect(sheets!.body).not.toMatch(/^\s*COPY\s+packages\s+/m);
    expect(sheets!.body).not.toMatch(
      /^\s*COPY\s+packages\/first-party-apps\s+/m,
    );
  });

  test("runtime stage includes explicit default mini-app assets and only optional Sheets output", () => {
    const runtime = byName.get("runtime");
    expect(runtime).toBeDefined();
    const requiredSources = [
      "packages/first-party-apps/writer",
      "packages/first-party-apps/video",
      "packages/first-party-apps/design",
    ] as const;
    const hostContract =
      "COPY packages/first-party-apps/spreadsheet/src/live-tool-contract.ts";
    const optionalSheets =
      "COPY --from=wafflebase-sheets-build /out/ ./repo/packages/first-party-apps/";
    const designDependencies =
      "COPY --from=deps /repo/packages/first-party-apps/design/node_modules";
    const writerDependencies =
      "COPY --from=deps /repo/packages/first-party-apps/writer/node_modules";
    const videoDependencies =
      "COPY --from=deps /repo/packages/first-party-apps/video/node_modules";
    const writerFileDeps = collectWriterFileDependencies();

    for (const source of requiredSources) {
      expect(stageContainsCopySource(runtime!.body, source)).toBe(true);
    }
    expect(runtime!.body).toContain(hostContract);
    expect(runtime!.body).toContain(optionalSheets);
    expect(runtime!.body).not.toMatch(
      /^\s*COPY\s+packages\/first-party-apps\s+/m,
    );
    expect(runtime!.body).not.toMatch(
      /^\s*COPY\s+packages\/first-party-apps\/spreadsheet(?:\s|\/engine)/m,
    );
    expect(runtime!.body).toContain(designDependencies);
    expect(runtime!.body).toContain(writerDependencies);
    expect(runtime!.body).toContain(videoDependencies);
    expect(runtime!.body).not.toContain("spreadsheet-lite");
    expect(runtime!.body).not.toContain("fortune-sheet");
    for (const dep of writerFileDeps) {
      expect(runtimeWriterFileDependencyOverlayIndex(runtime!.body, dep)).toBeGreaterThanOrEqual(0);
    }

    for (const source of requiredSources) {
      expect(runtime!.body.indexOf(`COPY ${source}`)).toBeLessThan(
        runtime!.body.indexOf(designDependencies),
      );
      expect(runtime!.body.indexOf(`COPY ${source}`)).toBeLessThan(
        runtime!.body.indexOf(writerDependencies),
      );
      expect(runtime!.body.indexOf(`COPY ${source}`)).toBeLessThan(
        runtime!.body.indexOf(videoDependencies),
      );
    }
    const lastWriterOverlay = Math.max(
      ...writerFileDeps.map((dep) =>
        runtimeWriterFileDependencyOverlayIndex(runtime!.body, dep),
      ),
    );
    expect(runtime!.body.indexOf(writerDependencies)).toBeLessThan(lastWriterOverlay);
  });

  test("Writer file: dependencies in package.json are explicitly materialized in runtime node_modules", () => {
    const runtime = byName.get("runtime");
    expect(runtime).toBeDefined();
    const writerDependencies =
      "COPY --from=deps /repo/packages/first-party-apps/writer/node_modules";
    const writerNodeModulesCopy = runtime!.body.indexOf(writerDependencies);
    expect(writerNodeModulesCopy).toBeGreaterThanOrEqual(0);

    const fileDeps = collectWriterFileDependencies();
    expect(fileDeps.length).toBeGreaterThanOrEqual(1);

    for (const dep of fileDeps) {
      const overlayCopy = runtimeWriterFileDependencyOverlayIndex(runtime!.body, dep);
      expect(overlayCopy).toBeGreaterThan(writerNodeModulesCopy);
    }
  });

  test("Video source and its app-local dependencies ship in the runtime image", () => {
    const runtime = byName.get("runtime");
    expect(runtime).toBeDefined();
    const pkg = JSON.parse(readFileSync(VIDEO_APP_PACKAGE_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@nautilo/types"]).toBe("file:../../types");

    const sourceCopy = "COPY packages/first-party-apps/video ./repo/packages/first-party-apps/video";
    const dependenciesCopy = "COPY --from=deps /repo/packages/first-party-apps/video/node_modules";
    const typesOverlay = [
      "COPY packages/types \\",
      "./repo/packages/first-party-apps/video/node_modules/@nautilo/types",
    ];
    expect(runtime!.body).toContain(sourceCopy);
    expect(runtime!.body).toContain(dependenciesCopy);
    for (const fragment of typesOverlay) expect(runtime!.body).toContain(fragment);
    expect(runtime!.body.indexOf(sourceCopy)).toBeLessThan(runtime!.body.indexOf(dependenciesCopy));
    expect(runtime!.body.indexOf(dependenciesCopy)).toBeLessThan(runtime!.body.lastIndexOf(typesOverlay[1]!));
    const deps = byName.get("deps")!;
    const installIndex = deps.body.indexOf("bun dev/scripts/install-first-party-apps.ts");
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      if (!spec.startsWith("file:")) continue;
      const source = relative(REPO_ROOT, resolve(VIDEO_APP_PACKAGE_JSON, "..", spec.slice(5)));
      const materializeIndex = deps.body.indexOf(`COPY ${source} ${source}`);
      expect(materializeIndex).toBeGreaterThanOrEqual(0);
      expect(materializeIndex).toBeLessThan(installIndex);
      const overlay = `./repo/packages/first-party-apps/video/node_modules/${name}`;
      expect(stageContainsCopySource(runtime!.body, source)).toBe(true);
      expect(runtime!.body.lastIndexOf(overlay)).toBeGreaterThan(runtime!.body.indexOf(dependenciesCopy));
    }
  });

  test("builds and retains a preflight-readable auth contract", () => {
    const authContract = byName.get("auth-contract");
    const runtime = byName.get("runtime");
    expect(authContract).toBeDefined();
    expect(runtime).toBeDefined();
    expect(authContract!.body).toMatch(
      /\bbun\s+deploy\/contracts\/generate-auth-contract\.ts\b/,
    );
    expect(runtime!.body).toMatch(
      /^\s*COPY\s+--from=auth-contract\s+\/out\/auth-contract\.json\s+\.\/contracts\/auth-contract\.json\s*$/m,
    );
  });

  // D402: desktop-only node-pty has no linux prebuild; if left in
  // trustedDependencies, bun runs `node-gyp rebuild` and the image
  // build dies with exit 127. Manifests-stage rewrite must drop it
  // (and still strip postinstall) without blanket ignore-scripts.
  test("manifests stage strips node-pty from trustedDependencies before install", () => {
    const m = byName.get("manifests");
    expect(m).toBeDefined();
    const runBlocks = collectRunBlocks(m!.body);
    const rewrite = runBlocks.find(
      (b) =>
        /delete p\.scripts\.postinstall/.test(b) &&
        /trustedDependencies/.test(b) &&
        /node-pty/.test(b),
    );
    expect(rewrite).toBeDefined();
    // The RUN itself must not pass ignore-scripts to bun install
    // (argon2 native builds must still run). Comment text may mention
    // the anti-pattern; only the executable RUN matters.
    expect(rewrite!).not.toMatch(/bun\s+install[^\n]*--ignore-scripts/);
  });
});

describe("M209 Dockerfile cache-topology guards", () => {
  const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
  const stages = parseStages(dockerfile);
  const byName = new Map(stages.map((s) => [s.name, s] as const));

  test("manifests stage copies only first-party app manifests and locks, not app source trees", () => {
    const manifests = byName.get("manifests");
    expect(manifests).toBeDefined();
    expect(manifests!.body).not.toMatch(
      /^\s*COPY\s+packages\/first-party-apps\s+packages\/first-party-apps\s*$/m,
    );
    for (const input of FIRST_PARTY_APP_INSTALL_INPUTS) {
      expect(manifests!.body).toContain(input);
    }
    const copied = collectContextCopySources(manifests!.body);
    const firstPartyCopies = copied.filter((src) => src.startsWith("packages/first-party-apps/"));
    expect(firstPartyCopies.sort()).toEqual(
      [...FIRST_PARTY_APP_INSTALL_INPUTS, ...EXPLICIT_WORKSPACE_MANIFESTS].sort(),
    );
  });

  test("auth-contract stage rejects broad `COPY . .` and copies the audited generator closure", () => {
    const authContract = byName.get("auth-contract");
    expect(authContract).toBeDefined();
    expect(/^\s*COPY\s+\.\s+\.\s*$/m.test(authContract!.body)).toBe(false);
    for (const required of AUTH_CONTRACT_COPY_CLOSURE) {
      expect(stageContainsCopySource(authContract!.body, required)).toBe(true);
    }
  });

  test("officecli-vendor stage is isolated from deps and copies only the audited vendor closure", () => {
    const vendor = byName.get("officecli-vendor");
    expect(vendor).toBeDefined();
    expect(vendor!.from).toBe("deps");
    for (const required of OFFICECLI_VENDOR_COPY_CLOSURE) {
      expect(stageContainsCopySource(vendor!.body, required)).toBe(true);
    }
    const runBlocks = collectRunBlocks(vendor!.body);
    const vendorRun = runBlocks.find((b) =>
      /\bbun\s+dev\/scripts\/vendor-officecli\.ts\b/.test(b),
    );
    expect(vendorRun).toBeDefined();
    expect(vendorRun!).toMatch(/\bTARGETARCH\b/);
    expect(vendorRun!).toMatch(/OFFICECLI_ARCH="linux-x64"/);
    expect(vendorRun!).toMatch(/arm64.*linux-arm64/s);
  });

  test("runtime copies OfficeCLI from officecli-vendor and does not re-download in mutable layers", () => {
    const runtime = byName.get("runtime");
    expect(runtime).toBeDefined();
    expect(runtime!.body).toMatch(
      /^\s*COPY\s+--from=officecli-vendor\s+\/repo\/packages\/server\/vendor\/officecli\s+/m,
    );
    expect(runtime!.body).not.toMatch(/\bbun\s+.*vendor-officecli\.ts\b/);
    expect(runtime!.body).not.toMatch(
      /^\s*COPY\s+dev\/scripts\/vendor-officecli\.ts\s+/m,
    );
    const serverSourceCopy = runtime!.body.indexOf(
      "COPY packages/server              ./repo/packages/server",
    );
    const officecliCopy = runtime!.body.indexOf(
      "COPY --from=officecli-vendor /repo/packages/server/vendor/officecli",
    );
    expect(serverSourceCopy).toBeGreaterThanOrEqual(0);
    expect(officecliCopy).toBeGreaterThan(serverSourceCopy);
  });

  test("agent-browser-vendor stage is isolated and maps both server image architectures", () => {
    const vendor = byName.get("agent-browser-vendor");
    expect(vendor).toBeDefined();
    expect(vendor!.from).toBe("deps");
    for (const required of AGENT_BROWSER_VENDOR_COPY_CLOSURE) {
      expect(stageContainsCopySource(vendor!.body, required)).toBe(true);
    }
    const runBlocks = collectRunBlocks(vendor!.body);
    const vendorRun = runBlocks.find((block) =>
      /\bbun\s+dev\/scripts\/vendor-agent-browser\.ts\b/.test(block),
    );
    expect(vendorRun).toBeDefined();
    expect(vendorRun!).toMatch(/\bTARGETARCH\b/);
    expect(vendorRun!).toMatch(/AGENT_BROWSER_ARCH="linux-x64"/);
    expect(vendorRun!).toMatch(/arm64.*linux-arm64/s);
  });

  test("runtime copies agent-browser from its isolated vendor stage", () => {
    const runtime = byName.get("runtime");
    expect(runtime).toBeDefined();
    expect(runtime!.body).toMatch(
      /^\s*COPY\s+--from=agent-browser-vendor\s+\/repo\/packages\/server\/vendor\/agent-browser\s+/m,
    );
    expect(runtime!.body).not.toMatch(/\bbun\s+.*vendor-agent-browser\.ts\b/);
  });

  test("server image has no apply-patch or ripgrep build stage or payload", () => {
    expect(byName.has("apply-patch-rust-build")).toBe(false);
    expect(byName.has("apply-patch-package")).toBe(false);
    expect(byName.has("ripgrep-vendor")).toBe(false);
    expect(dockerfile).not.toMatch(/packages\/server\/vendor\/(?:apply-patch|ripgrep)/);
    expect(dockerfile).not.toMatch(/dev\/scripts\/(?:vendor-ripgrep|apply-patch\/server\/build)\.ts/);
    expect(dockerfile).not.toMatch(/legal\/apply-patch/);
    const dockerignore = readFileSync(DOCKERIGNORE_PATH, "utf8");
    expect(dockerignore).toContain("packages/server/vendor/apply-patch/");
    expect(dockerignore).toContain("packages/server/vendor/ripgrep/");
  });

  test("runtime places stable deps node_modules before derived workbench and auth-contract copies", () => {
    const runtime = byName.get("runtime");
    expect(runtime).toBeDefined();
    const nodeModules = runtimeDirectiveIndex(runtime!.body, RUNTIME_DEPS_NODE_MODULES_COPY);
    const workbenchDist = runtimeDirectiveIndex(runtime!.body, RUNTIME_WORKBENCH_DIST_COPY);
    const mobileWebDist = runtimeDirectiveIndex(runtime!.body, RUNTIME_MOBILE_WEB_DIST_COPY);
    const authContract = runtimeDirectiveIndex(runtime!.body, RUNTIME_AUTH_CONTRACT_COPY);
    const firstMutable = runtimeDirectiveIndex(
      runtime!.body,
      RUNTIME_FIRST_MUTABLE_CONTEXT_COPY,
    );

    expect(nodeModules).toBeLessThan(firstMutable);
    expect(nodeModules).toBeLessThan(workbenchDist);
    expect(nodeModules).toBeLessThan(mobileWebDist);
    expect(nodeModules).toBeLessThan(authContract);
  });

  test("runtime places derived workbench and auth-contract after mutable assembly and before metadata", () => {
    const runtime = byName.get("runtime");
    expect(runtime).toBeDefined();
    const entrypointChmod = runtimeDirectiveIndex(runtime!.body, RUNTIME_ENTRYPOINT_CHMOD);
    const workbenchDist = runtimeDirectiveIndex(runtime!.body, RUNTIME_WORKBENCH_DIST_COPY);
    const mobileWebDist = runtimeDirectiveIndex(runtime!.body, RUNTIME_MOBILE_WEB_DIST_COPY);
    const authContract = runtimeDirectiveIndex(runtime!.body, RUNTIME_AUTH_CONTRACT_COPY);
    const firstMetadata = runtimeDirectiveIndex(
      runtime!.body,
      RUNTIME_FIRST_METADATA_DIRECTIVE,
    );
    const serverSourceCopy = runtime!.body.indexOf(
      "COPY packages/server              ./repo/packages/server",
    );

    expect(serverSourceCopy).toBeGreaterThanOrEqual(0);
    expect(serverSourceCopy).toBeLessThan(entrypointChmod);
    expect(entrypointChmod).toBeLessThan(workbenchDist);
    expect(entrypointChmod).toBeLessThan(mobileWebDist);
    expect(entrypointChmod).toBeLessThan(authContract);
    expect(workbenchDist).toBeLessThan(firstMetadata);
    expect(mobileWebDist).toBeLessThan(firstMetadata);
    expect(authContract).toBeLessThan(firstMetadata);
  });

  test("workbench build keeps the turbo filter and mounts Turbo/Vite compiler caches", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    expect(workbench!.body).toMatch(
      /^\s*COPY\s+tsconfig\.base\.json\s+nautilo\.config\.ts\s+turbo\.json\s+\.\/\s*$/m,
    );
    const runBlocks = collectRunBlocks(workbench!.body);
    const buildRun = runBlocks.find((b) =>
      /\bbunx\s+turbo\s+run\s+build\b/.test(b),
    );
    expect(buildRun).toBeDefined();
    expect(buildRun!).toMatch(/--filter=@nautilo\/workbench\b/);
    expect(buildRun!).toMatch(
      new RegExp(`--mount=type=cache,target=${TURBO_BUILD_CACHE_MOUNT.replace(/\//g, "\\/")},sharing=locked`),
    );
    expect(buildRun!).toMatch(
      new RegExp(`--mount=type=cache,target=${VITE_BUILD_CACHE_MOUNT.replace(/\//g, "\\/")},sharing=locked`),
    );
  });

  test("workbench-build copies every direct workspace package dependency before Turbo", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    const manifest = JSON.parse(readFileSync(WORKBENCH_PACKAGE_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const workspaceDirsByName = new Map<string, string>();
    for (const entry of readdirSync(join(REPO_ROOT, "packages"))) {
      const packageJson = join(REPO_ROOT, "packages", entry, "package.json");
      if (!existsSync(packageJson)) continue;
      const packageManifest = JSON.parse(readFileSync(packageJson, "utf8")) as {
        name?: string;
      };
      if (packageManifest.name) {
        workspaceDirsByName.set(packageManifest.name, `packages/${entry}`);
      }
    }
    const required = Object.entries(manifest.dependencies ?? {})
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => workspaceDirsByName.get(name))
      .filter((dir): dir is string => dir !== undefined)
      .sort();
    const missing = required.filter(
      (dir) => !stageContainsCopySource(workbench!.body, dir),
    );

    expect(missing).toEqual([]);
  });

  test("runtime copies Turbo configuration after stable installed dependencies", () => {
    const runtime = byName.get("runtime");
    expect(runtime).toBeDefined();
    const nodeModules = runtimeDirectiveIndex(runtime!.body, RUNTIME_DEPS_NODE_MODULES_COPY);
    const turboConfig = runtimeDirectiveIndex(runtime!.body, "COPY turbo.json         ./repo/turbo.json");

    expect(nodeModules).toBeLessThan(turboConfig);
  });

  test("workbench-build explicitly copies required first-party source before Turbo and does not broad-copy first-party-apps", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    expect(stageContainsCopySource(workbench!.body, WORKBENCH_BUILD_WRITER_INPUT)).toBe(true);
    expect(stageContainsCopySource(workbench!.body, WORKBENCH_BUILD_VIDEO_INPUT)).toBe(true);
    expect(workbench!.body).not.toMatch(
      /^\s*COPY\s+packages\/first-party-apps\s+packages\/first-party-apps\s*$/m,
    );
    const copied = collectContextCopySources(workbench!.body);
    const firstPartyCopies = copied.filter((src) => src.startsWith("packages/first-party-apps/"));
    expect(firstPartyCopies).toEqual([
      WORKBENCH_BUILD_WRITER_INPUT,
      WORKBENCH_BUILD_VIDEO_INPUT,
    ]);

    const writerCopy = workbench!.body.indexOf(
      `COPY ${WORKBENCH_BUILD_WRITER_INPUT} ${WORKBENCH_BUILD_WRITER_INPUT}`,
    );
    const videoCopy = workbench!.body.indexOf(
      `COPY ${WORKBENCH_BUILD_VIDEO_INPUT} ${WORKBENCH_BUILD_VIDEO_INPUT}`,
    );
    const turboBuild = workbench!.body.indexOf("bunx turbo run build --filter=@nautilo/workbench");
    expect(writerCopy).toBeGreaterThanOrEqual(0);
    expect(videoCopy).toBeGreaterThanOrEqual(0);
    expect(turboBuild).toBeGreaterThan(writerCopy);
    expect(turboBuild).toBeGreaterThan(videoCopy);
  });

  test("workbench-build includes desktop-filesystem-grants before Turbo", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    expect(
      stageContainsCopySource(workbench!.body, WORKBENCH_BUILD_DESKTOP_FILESYSTEM_GRANTS_INPUT),
    ).toBe(true);
  });

  test("workbench-build includes document-mutations before Turbo", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    expect(
      stageContainsCopySource(workbench!.body, WORKBENCH_BUILD_DOCUMENT_MUTATIONS_INPUT),
    ).toBe(true);
    expect(
      workbench!.body.indexOf(WORKBENCH_BUILD_DOCUMENT_MUTATIONS_INPUT),
    ).toBeLessThan(workbench!.body.indexOf("bunx turbo run build --filter=@nautilo/workbench"));
  });

  test("workbench-build includes profile-portability before Turbo", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    expect(
      stageContainsCopySource(workbench!.body, WORKBENCH_BUILD_PROFILE_PORTABILITY_INPUT),
    ).toBe(true);
  });

  test("workbench-build includes lattice-crypto before Turbo", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    expect(
      stageContainsCopySource(
        workbench!.body,
        WORKBENCH_BUILD_LATTICE_CRYPTO_INPUT,
      ),
    ).toBe(true);
    expect(
      workbench!.body.indexOf(WORKBENCH_BUILD_LATTICE_CRYPTO_INPUT),
    ).toBeLessThan(
      workbench!.body.indexOf(
        "bunx turbo run build --filter=@nautilo/workbench",
      ),
    );
  });

  test("workbench-build includes the exact browser-safe Desktop connection presentation closure", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    for (const input of WORKBENCH_BUILD_DESKTOP_CONNECTION_INPUTS) {
      expect(stageContainsCopySource(workbench!.body, input)).toBe(true);
      expect(workbench!.body.indexOf(input)).toBeLessThan(
        workbench!.body.indexOf("bunx turbo run build --filter=@nautilo/workbench"),
      );
    }
  });

  test("workbench-build includes browser-document-viewer before Turbo", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    expect(
      stageContainsCopySource(workbench!.body, WORKBENCH_BUILD_BROWSER_DOCUMENT_VIEWER_INPUT),
    ).toBe(true);
    expect(
      workbench!.body.indexOf(WORKBENCH_BUILD_BROWSER_DOCUMENT_VIEWER_INPUT),
    ).toBeLessThan(workbench!.body.indexOf("bunx turbo run build --filter=@nautilo/workbench"));
  });

  test("runtime copies only the Mobile static dist and declares its mount env", () => {
    const runtime = byName.get("runtime");
    expect(runtime).toBeDefined();
    const mobileStageCopies = runtime!.body.match(/COPY --from=mobile-web-build[^\n]*/g) ?? [];
    expect(mobileStageCopies).toEqual([RUNTIME_MOBILE_WEB_DIST_COPY]);
    expect(runtime!.body).toContain("ENV NAUTILO_MOBILE_WEB_DIST=/srv/mobile-web");
  });

  test("workbench-build includes the maintenance brand artwork before Turbo", () => {
    const workbench = byName.get("workbench-build");
    expect(workbench).toBeDefined();
    expect(workbench!.body).toContain(WORKBENCH_BUILD_MAINTENANCE_BRAND_COPY);
    expect(workbench!.body.indexOf(WORKBENCH_BUILD_MAINTENANCE_BRAND_COPY)).toBeLessThan(
      workbench!.body.indexOf("bunx turbo run build --filter=@nautilo/workbench"),
    );
  });
});

describe("M118 .dockerignore conservative guard", () => {
  const ignore = readFileSync(DOCKERIGNORE_PATH, "utf8");
  const lines = ignore
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  test("does NOT exclude apps/ wholesale", () => {
    // Forbid `apps/*`, `apps/`, or `apps` at the root (workbench build needs it).
    for (const l of lines) {
      expect(l).not.toMatch(/^apps\/?\*?$/);
    }
  });

  test("does NOT exclude packages/fonts/assets/", () => {
    for (const l of lines) {
      expect(l).not.toMatch(/^packages\/fonts\/assets\/?/);
    }
  });

  test("does NOT exclude shared root brand assets", () => {
    const forbidden = new Set([
      "assets/",
      "assets/*",
      "assets/**",
      "assets/brand/",
      "assets/brand/*",
      "assets/brand/**",
      "assets/brand/*.png",
      WORKBENCH_BUILD_MAINTENANCE_BRAND_ASSET,
    ]);
    for (const l of lines) {
      expect(forbidden.has(l)).toBe(false);
    }
  });

  test("does NOT blanket-exclude native/ (only native/**/.build/)", () => {
    for (const l of lines) {
      expect(l).not.toMatch(/^native\/?\*?$/);
    }
  });

  test("excludes packaged desktop release artifacts from the build context", () => {
    expect(lines).toContain("apps/desktop/release/");
  });


});

describe("M209 .dockerignore safe reductions", () => {
  const ignore = readFileSync(DOCKERIGNORE_PATH, "utf8");
  const lines = ignore
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  test("excludes test trees, fixtures, and test source files from the build context", () => {
    expect(lines).toContain("**/tests/");
    expect(lines).toContain("**/fixtures/");
    expect(lines).toContain("**/*.test.ts");
    expect(lines).toContain("**/*.integration.test.ts");
  });

  test("does NOT blanket-exclude apps/, packages/, or dev/", () => {
    for (const l of lines) {
      expect(l).not.toMatch(/^apps\/?\*?$/);
      expect(l).not.toMatch(/^packages\/?\*?$/);
      expect(l).not.toMatch(/^dev\/?\*?$/);
      expect(l).not.toMatch(/^dev\/\*\*\/$/);
    }
  });

  test("preserves workbench, font assets, and Docker build inputs", () => {
    for (const l of lines) {
      expect(l).not.toMatch(/^apps\/workbench\/?/);
      expect(l).not.toMatch(/^packages\/fonts\/assets\/?/);
      expect(l).not.toMatch(/^packages\/first-party-apps\/?(?:\*|\*\*)?$/);
      expect(l).not.toMatch(/^deploy\/contracts\/?/);
      expect(l).not.toMatch(/^dev\/scripts\/install-first-party-apps\.ts$/);
    }
    expect(lines).toContain("packages/first-party-apps/spreadsheet/engine/");
    expect(lines).toContain(
      "packages/first-party-apps/spreadsheet/engine.staging-*/",
    );
    expect(lines).toContain(
      "packages/first-party-apps/spreadsheet/engine.previous-*/",
    );
  });
});

function collectRunBlocks(dockerfile: string): string[] {
  const out: string[] = [];
  const lines = dockerfile.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*RUN\b/.test(line)) {
      let block = line;
      while (block.trimEnd().endsWith("\\") && i + 1 < lines.length) {
        i++;
        block += "\n" + lines[i]!;
      }
      out.push(block);
    }
    i++;
  }
  return out;
}

type WriterFileDependency = {
  packageName: string;
  sourceRepoPath: string;
  runtimeOverlayDest: string;
};

/** Writer `file:` deps declared in package.json → repo source + runtime overlay path. */
function collectWriterFileDependencies(): WriterFileDependency[] {
  const pkg = JSON.parse(readFileSync(WRITER_APP_PACKAGE_JSON, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const writerDir = join(REPO_ROOT, "packages/first-party-apps/writer");
  const sections = [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ] as const;
  const fileDeps = new Map<string, WriterFileDependency>();
  for (const section of sections) {
    if (!section) continue;
    for (const [packageName, spec] of Object.entries(section)) {
      if (!spec.startsWith("file:")) continue;
      const resolvedSource = resolve(writerDir, spec.slice("file:".length));
      const sourceRepoPath = relative(REPO_ROOT, resolvedSource);
      fileDeps.set(packageName, {
        packageName,
        sourceRepoPath,
        runtimeOverlayDest: `${WRITER_RUNTIME_FILE_DEP_OVERLAY_PREFIX}${packageName}`,
      });
    }
  }
  return [...fileDeps.values()].sort((a, b) =>
    a.packageName.localeCompare(b.packageName),
  );
}

/** Index of the runtime overlay COPY for a Writer `file:` dependency, or -1. */
function runtimeWriterFileDependencyOverlayIndex(
  runtimeBody: string,
  dep: WriterFileDependency,
): number {
  const overlayRe = new RegExp(
    String.raw`^\s*COPY\s+${dep.sourceRepoPath.replace(/\//g, "\\/")}\s+\\\s*\n\s*${dep.runtimeOverlayDest.replace(/\//g, "\\/")}\s*$`,
    "gm",
  );
  const match = overlayRe.exec(runtimeBody);
  return match?.index ?? -1;
}
