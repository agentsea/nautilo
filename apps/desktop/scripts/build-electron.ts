#!/usr/bin/env bun
/**
 * Build the Electron main + preload bundles with build-time constants
 * injected (the git SHA shown in the About dialog).
 *
 * Written as a dedicated script because shell-interpolating `git rev-parse`
 * into an esbuild --define value requires gnarly quote-escaping in
 * package.json. A tiny script is clearer than a fragile one-liner.
 *
 * Invoked from package.json `build:electron`.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  formatOnboardingPaletteCssBlock,
  formatSemanticSetupPaletteCssBlock,
} from "@nautilo/config/design-tokens";

/** Marker in `onboarding/index.html` replaced with palette CSS at build time. */
const ONBOARDING_PALETTE_MARKER = "/* __NAUTILO_ONBOARDING_PALETTE__ */";
const FIRST_RUN_PALETTE_MARKER = "/* __NAUTILO_SEMANTIC_SETUP_PALETTE__ */";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");

/**
 * Short git SHA for the current HEAD. Falls back to "unknown" when we
 * aren't in a git work tree (tarball installs, CI without git, etc.)
 * so the build never fails on missing metadata.
 */
function gitShortSha(): string {
  try {
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: desktopRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

const sha = gitShortSha();
process.stderr.write(`[build-electron] injecting __NAUTILO_SHA__="${sha}"\n`);

const sharedOptions = {
  bundle: true,
  platform: "node" as const,
  format: "cjs" as const,
  target: "node22",
  // Native addons — esbuild cannot bundle their `.node` binaries, so keep
  // them external and resolve from node_modules at runtime (asarUnpack'd in
  // the packaged app). `argon2` is imported by the trust package; bundling
  // it makes its native loader resolve relative to dist/main.js instead of
  // its installed module directory.
  // Sharp dynamically loads its platform-specific @img native addon and
  // libvips package. It must stay external so those runtime resolves start at
  // its unpacked node_modules directory inside the packaged app.
  external: ["electron", "node-pty", "argon2", "sharp"],
  define: {
    __NAUTILO_SHA__: JSON.stringify(sha),
    __NAUTILO_OPENMLS_WASM_GLUE__: JSON.stringify(
      "./openmls-wasm/openmls_wasm.js",
    ),
  },
  logLevel: "warning" as const,
  // The `[empty-import-meta]` warning is the smoke signal that a
  // CJS-bundled source uses `import.meta` (which esbuild empties → runtime
  // crash, as in the historical configuration-load bug). Make it a hard build ERROR so it can
  // never ship silently again. The main bundle defines `import.meta.*` away
  // via mainProcessImportMetaShim below; any remaining occurrence (esp. in a
  // sandboxed preload) fails the build.
  logOverride: { "empty-import-meta": "error" } as const,
};

// fix — MAIN-PROCESS-ONLY import.meta shim.
//
// The main bundle is CJS (`format: "cjs"` above), where esbuild leaves
// `import.meta.url` / `import.meta.dirname` EMPTY (the [empty-import-meta]
// warnings). Three bundled sources use them:
//   - electron/terminal-host.ts:31  `createRequire(import.meta.url)` —
//     MODULE-SCOPE, so dist/main.js crashed at load (ERR_INVALID_ARG_VALUE).
//   - packages/config/src/host-port-liveness.ts:9  (lazy, inside a fn)
//   - packages/config/src/workbench-dist.ts:15     (lazy, inside a fn)
// The shared `packages/config` sources can't just switch to __filename —
// they also run under Bun/ESM in the server + tests where __filename does
// not exist. So the shim lives at the electron build boundary instead.
//
// CRITICAL SCOPING RULE: this shim must apply to dist/main.js ONLY. The
// preload bundles run SANDBOXED (main.ts webPreferences `sandbox: true`),
// where Electron's polyfilled `require('url')` has no `pathToFileURL` —
// a banner referencing it throws on preload line 1, which silently kills
// the contextBridge and strands the renderer at the "Starting…" spinner.
// (That exact regression shipped locally on 2026-07-05; do not re-widen
// this to sharedOptions.) The preloads never use import.meta — verify with:
//   rg -c "__nautiloImportMetaUrl" dist/preload*.js   # must be 0
const mainProcessImportMetaShim = {
  define: {
    ...sharedOptions.define,
    __NAUTILO_OPENMLS_WASM_BYTES__: "__nautiloOpenMlsWasmBytes",
    "import.meta.url": "__nautiloImportMetaUrl",
    "import.meta.dirname": "__dirname",
  },
  banner: {
    js: "const __nautiloImportMetaUrl = require('url').pathToFileURL(__filename).href; " +
      "const __nautiloOpenMlsWasmBytes = require('fs').readFileSync(" +
      "require('path').join(__dirname, 'openmls-wasm/openmls_wasm_bg.wasm'));",
  },
};

await Promise.all([
  build({
    ...sharedOptions,
    ...mainProcessImportMetaShim,
    entryPoints: [resolve(desktopRoot, "electron/main.ts")],
    outfile: resolve(desktopRoot, "dist/main.js"),
  }),
  build({
    ...sharedOptions,
    entryPoints: [resolve(desktopRoot, "electron/preload.ts")],
    outfile: resolve(desktopRoot, "dist/preload.js"),
  }),
  build({
    ...sharedOptions,
    entryPoints: [resolve(desktopRoot, "electron/preload-companion.ts")],
    outfile: resolve(desktopRoot, "dist/preload-companion.js"),
  }),
  // First-run picker preload with a dedicated, minimal API surface.
  build({
    ...sharedOptions,
    entryPoints: [resolve(desktopRoot, "electron/preload-first-run.ts")],
    outfile: resolve(desktopRoot, "dist/preload-first-run.js"),
  }),
  // Embedded-browser guest <webview> preload for the
  // password autofill layer. Runs SANDBOXED inside the webview guest (same
  // sandbox posture as the other preloads) — must not carry the main-only
  // import.meta shim; the integrity loop below enforces that.
  build({
    ...sharedOptions,
    entryPoints: [resolve(desktopRoot, "electron/passwords/guest-preload.ts")],
    outfile: resolve(desktopRoot, "dist/guest-preload.js"),
  }),
  // First-run picker renderer (React 19 + iife bundle for
  // file:// page, sandboxed in its own BrowserWindow).
  build({
    bundle: true,
    format: "iife" as const,
    target: "chrome130",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: {
      __NAUTILO_SHA__: JSON.stringify(sha),
    },
    logLevel: "warning" as const,
    entryPoints: [resolve(desktopRoot, "first-run/index.tsx")],
    outfile: resolve(desktopRoot, "dist/first-run/index.js"),
  }),
  // onboarding wizard preload (separate surface from
  // first-run; Phase 2 extends this to ~11 channels for API proxy).
  build({
    ...sharedOptions,
    entryPoints: [resolve(desktopRoot, "electron/preload-onboarding.ts")],
    outfile: resolve(desktopRoot, "dist/preload-onboarding.js"),
  }),
  // onboarding wizard renderer (React 19 + Three.js
  // orb, iife bundle for file:// page, sandboxed BrowserWindow).
  // Bundle size note: Three.js full-package import adds ~600 KB
  // min; we start with the easy-import variant and measure after
  // Phase 1 before deciding whether to subpath-tighten for Phase 2.
  build({
    bundle: true,
    format: "iife" as const,
    target: "chrome130",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: {
      __NAUTILO_SHA__: JSON.stringify(sha),
    },
    logLevel: "warning" as const,
    entryPoints: [resolve(desktopRoot, "onboarding/index.tsx")],
    outfile: resolve(desktopRoot, "dist/onboarding/index.js"),
  }),
]);

// Preload integrity guard (the primary preload guard).
//
// The import.meta shim (mainProcessImportMetaShim) is main-process-ONLY.
// Preloads run sandboxed (main.ts webPreferences `sandbox: true`), where the
// shim's `require('url').pathToFileURL(__filename)` banner throws on line 1
// and silently kills the contextBridge → renderer stuck at "Starting…" (the
// 2026-07-05 regression from widening the shim to sharedOptions). Fail the
// build if any preload bundle contains the shim identifier. This catches the
// scoping mistake at build time, and is stricter than R2's CI boot smoke —
// which only exercises whichever window it drives (first-run by default), so
// a main-window-only preload regression could slip past R2 but not this.
// (A bare `import.meta` in a CJS preload is separately caught by the R4
// `logOverride: empty-import-meta → error` gate, so it is not re-checked here.)
for (const preloadRel of [
  "dist/preload.js",
  "dist/preload-companion.js",
  "dist/preload-first-run.js",
  "dist/preload-onboarding.js",
  // The embedded-browser guest preload is sandboxed too.
  "dist/guest-preload.js",
]) {
  const preloadSrc = readFileSync(resolve(desktopRoot, preloadRel), "utf-8");
  if (preloadSrc.includes("__nautiloImportMetaUrl")) {
    throw new Error(
      `[build-electron] preload-integrity: ${preloadRel} contains the ` +
        `main-only import.meta shim (__nautiloImportMetaUrl). It runs sandboxed ` +
        `and will crash at load. The shim must stay on the dist/main.js build ` +
        `ONLY — never widen mainProcessImportMetaShim into sharedOptions.`,
    );
  }
}

// First-run HTML with canonical semantic palette injection.
const firstRunDistDir = resolve(desktopRoot, "dist/first-run");
mkdirSync(firstRunDistDir, { recursive: true });
const firstRunHtmlSrc = resolve(desktopRoot, "first-run/index.html");
const firstRunHtmlRaw = readFileSync(firstRunHtmlSrc, "utf-8");
if (!firstRunHtmlRaw.includes(FIRST_RUN_PALETTE_MARKER)) {
  throw new Error(
    `[build-electron] first-run/index.html missing palette marker ${FIRST_RUN_PALETTE_MARKER}`,
  );
}
writeFileSync(
  resolve(firstRunDistDir, "index.html"),
  firstRunHtmlRaw.replace(
    FIRST_RUN_PALETTE_MARKER,
    formatSemanticSetupPaletteCssBlock(),
  ),
);

// onboarding HTML with build-time palette injection.
const onboardingDistDir = resolve(desktopRoot, "dist/onboarding");
mkdirSync(onboardingDistDir, { recursive: true });
const onboardingHtmlSrc = resolve(desktopRoot, "onboarding/index.html");
const onboardingHtmlRaw = readFileSync(onboardingHtmlSrc, "utf-8");
if (!onboardingHtmlRaw.includes(ONBOARDING_PALETTE_MARKER)) {
  throw new Error(
    `[build-electron] onboarding/index.html missing palette marker ${ONBOARDING_PALETTE_MARKER}`,
  );
}
writeFileSync(
  resolve(onboardingDistDir, "index.html"),
  onboardingHtmlRaw.replace(
    ONBOARDING_PALETTE_MARKER,
    formatOnboardingPaletteCssBlock(),
  ),
);

copyFileSync(
  resolve(desktopRoot, "electron/bootstrap.html"),
  resolve(desktopRoot, "dist/bootstrap.html"),
);

copyFileSync(
  resolve(desktopRoot, "electron/cold-boot-picker.html"),
  resolve(desktopRoot, "dist/cold-boot-picker.html"),
);

copyFileSync(
  resolve(desktopRoot, "electron/browser-control-provider.js"),
  resolve(desktopRoot, "dist/browser-control-provider.js"),
);

const openMlsDistDir = resolve(desktopRoot, "dist/openmls-wasm");
const openMlsVendorDir = resolve(
  desktopRoot,
  "../../packages/lattice-crypto/vendor/openmls-wasm",
);
mkdirSync(openMlsDistDir, { recursive: true });
writeFileSync(
  resolve(openMlsDistDir, "package.json"),
  JSON.stringify({ type: "module" }),
);
for (const filename of ["openmls_wasm.js", "openmls_wasm_bg.wasm"]) {
  copyFileSync(
    resolve(openMlsVendorDir, filename),
    resolve(openMlsDistDir, filename),
  );
}

process.stderr.write("[build-electron] done\n");
