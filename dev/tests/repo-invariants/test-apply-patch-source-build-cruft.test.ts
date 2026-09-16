import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function expectNoRuntimeFallback(path: string, options: { readonly forbidFetch?: boolean } = {}): void {
  const text = source(path);
  expect(text, `${path} must not consult ambient PATH`).not.toMatch(/process\.env(?:\.PATH|\[\s*["']PATH["']\s*\])/);
  expect(text, `${path} must not compile Rust at runtime`).not.toMatch(
    /(?:cargo\s+build|(?:spawn|spawnSync|execFile|execFileSync)\(\s*["'](?:cargo|rustc|rustup)["'])/i,
  );
  if (options.forbidFetch) {
    expect(text, `${path} must not fetch a runtime from the network`).not.toMatch(/\bfetch\s*\(/);
  }
}

describe("D448 source-build release boundary", () => {
  test("deletes the retired publication entrypoints and candidate workflows", () => {
    for (const path of [
      ".github/workflows/build-apply-patch-runtimes.yml",
      ".github/workflows/build-apply-patch-darwin-runtimes.yml",
      "dev/scripts/vendor-apply-patch.ts",
      "dev/scripts/apply-patch/verification.ts",
      "dev/scripts/apply-patch/verification.test.ts",
      "dev/tests/repo-invariants/test-apply-patch-runtime-workflow.test.ts",
      "dev/tests/repo-invariants/test-apply-patch-darwin-runtime-workflow.test.ts",
    ]) {
      expect(existsSync(join(repoRoot, path)), `${path} is retired and must remain absent`).toBe(false);
    }
  });

  test("does not expose server apply-patch build or publication commands", () => {
    const scripts = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
    expect(scripts.scripts["apply-patch:build"]).toBeUndefined();
    expect(scripts.scripts["apply-patch:vendor"]).toBeUndefined();
    expect(scripts.scripts["apply-patch:verify"]).toBeUndefined();
  });

  test("keeps release URLs, tokens, pending slots, and candidate commands out of surviving apply-patch build surfaces", () => {
    for (const path of [
      "package.json",
      "packaging/docker/Dockerfile",
      "apps/desktop/package.json",
      "apps/desktop/scripts/build-apply-patch.ts",
      "apps/desktop/electron/apply-patch-runtime.ts",
      "apps/desktop/electron/tool-runtimes-manifest.ts",
      "apps/desktop/electron-builder.yml",
    ]) {
      const text = source(path);
      expect(text, `${path} must not restore a pending release slot`).not.toContain("pending-build");
      expect(text, `${path} must not restore a candidate build command`).not.toMatch(/build-candidate/i);
      expect(text, `${path} must not restore the vendor/import script`).not.toMatch(/vendor-apply-patch/i);
      expect(text, `${path} must not restore apply-patch release/download URLs`).not.toMatch(/(?:https?:\/\/[^\s"']*apply[-_]?patch|apply[-_]?patch[^\n]*https?:\/\/)/i);
      expect(text, `${path} must not restore an apply-patch release-token secret`).not.toMatch(/apply[-_]?patch[^\n]*(?:release[-_]?token|token[-_]?release)/i);
    }
  });

  test("Desktop invocation resolves recorded bytes without PATH, Cargo, or network fallbacks", () => {
    for (const path of [
      "packages/agent/src/tools/apply-patch/process-wrapper.ts",
      "apps/desktop/electron/apply-patch-runtime.ts",
      "apps/desktop/electron/apply-patch-dispatch.ts",
      "apps/desktop/electron/relay.ts",
    ]) {
      expectNoRuntimeFallback(path);
    }
    for (const path of [
      "packages/agent/src/tools/apply-patch/process-wrapper.ts",
      "apps/desktop/electron/apply-patch-runtime.ts",
      "apps/desktop/electron/apply-patch-dispatch.ts",
    ]) {
      expectNoRuntimeFallback(path, { forbidFetch: true });
    }
  });

  test("keeps server apply-patch runtime and vendor surfaces absent", () => {
    for (const path of [
      "dev/scripts/apply-patch/server/build.ts",
      "packages/config/src/apply-patch/runtime.ts",
      "packages/agent/src/tools/apply-patch/server-runtime-adapter.ts",
      "packages/server/vendor/apply-patch/manifest.json",
      "dev/scripts/vendor-ripgrep.ts",
      "packages/config/src/ripgrep.ts",
      "packages/server/vendor/ripgrep/manifest.json",
    ]) {
      expect(existsSync(join(repoRoot, path)), `${path} must remain absent`).toBe(false);
    }
  });
});
