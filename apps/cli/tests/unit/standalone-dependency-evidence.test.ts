import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createStandaloneDependencyEvidence } from "../../src/lib/standalone-dependency-evidence.ts";

function write(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

describe("standalone dependency evidence", () => {
  test("derives a deterministic exact compiler closure with license evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-dependency-evidence-"));
    try {
      writeFileSync(join(root, "LICENSE"), "MIT fixture\n");
      write(join(root, "apps/cli/package.json"), JSON.stringify({
        name: "@nautilo/cli", version: "1.2.3", license: "SEE LICENSE IN ../../LICENSE",
      }));
      write(join(root, "apps/cli/src/index.ts"), "export {};\n");
      write(join(root, "packages/config/package.json"), JSON.stringify({
        name: "@nautilo/config", version: "1.2.3",
      }));
      write(join(root, "packages/config/src/index.ts"), "export {};\n");
      write(join(root, "node_modules/example/package.json"), JSON.stringify({
        name: "example", version: "4.5.6", license: "Apache-2.0",
      }));
      write(join(root, "node_modules/example/index.js"), "module.exports = {};\n");
      const metafileBytes = Buffer.from(JSON.stringify({
        inputs: {
          "node_modules/example/index.js": {},
          "packages/config/src/index.ts": {},
          "apps/cli/src/index.ts": {},
        },
        outputs: { "dist/nautilo": {} },
      }));

      const evidence = createStandaloneDependencyEvidence({
        metafileBytes,
        monorepoRoot: root,
        source: "a".repeat(40),
        platform: "darwin-arm64",
        version: "1.2.3",
        archiveSha256: "b".repeat(64),
      });

      expect(evidence.licenses.componentCount).toBe(3);
      expect(evidence.licenses.components.map(({ name }) => name)).toEqual([
        "@nautilo/cli", "@nautilo/config", "example",
      ]);
      expect(evidence.licenses.components.find(({ name }) => name === "@nautilo/config")?.declaredLicense).toBe("MIT");
      expect(evidence.sbom.bomFormat).toBe("CycloneDX");
      expect(evidence.sbom.components.find(({ name }) => name === "example")?.licenses[0].license.expression).toBe("Apache-2.0");
      expect(evidence.sbom.metadata.properties).toContainEqual({
        name: "ai.nautilo.archive.sha256", value: "b".repeat(64),
      });
      const absoluteMetafile = Buffer.from(JSON.stringify({
        inputs: {
          [resolve(root, "node_modules/example/index.js")]: { imports: [{ path: resolve(root, "apps/cli/src/index.ts") }] },
          [resolve(root, "packages/config/src/index.ts")]: {},
          [resolve(root, "apps/cli/src/index.ts")]: {},
        },
        outputs: { "/unrelated/temporary/output": {} },
      }));
      const absoluteEvidence = createStandaloneDependencyEvidence({
        metafileBytes: absoluteMetafile,
        monorepoRoot: root,
        source: "a".repeat(40),
        platform: "darwin-arm64",
        version: "1.2.3",
        archiveSha256: "b".repeat(64),
      });
      expect(absoluteEvidence).toEqual(evidence);

      const overriddenEvidence = createStandaloneDependencyEvidence({
        metafileBytes,
        monorepoRoot: root,
        source: "a".repeat(40),
        platform: "darwin-arm64",
        version: "1.2.3",
        archiveSha256: "b".repeat(64),
        compilerInputSha256Overrides: { "apps/cli/src/index.ts": "c".repeat(64) },
      });
      expect(overriddenEvidence.licenses.compilerClosureSha256).not.toBe(evidence.licenses.compilerClosureSha256);
      expect(() => createStandaloneDependencyEvidence({
        metafileBytes,
        monorepoRoot: root,
        source: "a".repeat(40),
        platform: "darwin-arm64",
        version: "1.2.3",
        archiveSha256: "b".repeat(64),
        compilerInputSha256Overrides: { "apps/cli/src/missing.ts": "c".repeat(64) },
      })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed for external dependencies without declared licenses", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-dependency-license-"));
    try {
      writeFileSync(join(root, "LICENSE"), "MIT fixture\n");
      write(join(root, "apps/cli/package.json"), JSON.stringify({
        name: "@nautilo/cli", version: "1.2.3", license: "MIT",
      }));
      write(join(root, "apps/cli/src/index.ts"), "export {};\n");
      write(join(root, "node_modules/unlicensed/package.json"), JSON.stringify({
        name: "unlicensed", version: "1.0.0",
      }));
      write(join(root, "node_modules/unlicensed/index.js"), "module.exports = {};\n");
      const metafileBytes = Buffer.from(JSON.stringify({
        inputs: {
          "apps/cli/src/index.ts": {},
          "node_modules/unlicensed/index.js": {},
        },
        outputs: { "dist/nautilo": {} },
      }));
      expect(() => createStandaloneDependencyEvidence({
        metafileBytes,
        monorepoRoot: root,
        source: "a".repeat(40),
        platform: "darwin-arm64",
        version: "1.2.3",
        archiveSha256: "b".repeat(64),
      })).toThrow(/external dependency has no declared license/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
