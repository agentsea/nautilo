import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  COMMON_PROTECTED_CONTENT_AI_BOUNDARIES,
  OBJECT_ACCESS_CODEC_CONSUMERS,
  validateCommonProtectedContentInventory,
} from "../../src/node/common-protected-content-inventory.ts";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Wave 18 common protected-content inventory", () => {
  test("keeps Memory and Artifact v5 AI-only while other codec owners stay explicit", () => {
    expect(validateCommonProtectedContentInventory(repositoryRoot)).toEqual([]);
    expect(new Set(OBJECT_ACCESS_CODEC_CONSUMERS.map(({ family }) => family)))
      .toEqual(new Set([
        "common_v5",
        "conversation_v2_v3",
        "journal_v4",
        "reflection_v3",
      ]));
  });

  test("keeps v5 routes absent from the production app assembly", () => {
    const app = readFileSync(
      resolve(repositoryRoot, "packages/server/src/app.ts"),
      "utf8",
    );
    expect(app).not.toContain("protectedArtifactRoutes(");
    expect(app).not.toContain("protectedMemoryRoutes(");
    expect(app).not.toContain("protectedMemoryExactAccessRoutes(");
    expect(app).not.toContain("createProtectedArtifactTestComposition(");
    expect(app).not.toContain("createProtectedMemoryTestShadowComposition(");
    expect(app).not.toContain("createProtectedMemoryExactAccessTestComposition(");
  });

  test("rejects a missing Memory verifier call even while its import remains", () => {
    const root = mkdtempSync(join(tmpdir(), "protected-content-inventory-"));
    const consumer = OBJECT_ACCESS_CODEC_CONSUMERS.find(entry => entry.id === "memory.human.client")!;
    const paths = new Set([
      ...OBJECT_ACCESS_CODEC_CONSUMERS.map(entry => entry.sourcePath),
      ...COMMON_PROTECTED_CONTENT_AI_BOUNDARIES.map(entry => entry.sourcePath),
      "packages/server/src/app.ts",
    ]);
    try {
      for (const path of paths) {
        let source = readFileSync(resolve(repositoryRoot, path), "utf8");
        if (path === consumer.sourcePath) {
          expect(source).toContain(consumer.anchor);
          source = source.replace(consumer.anchor, "operation: taskResolvers => removedVerifier(");
          expect(source).toContain("verifyCommonObjectAccessManifestChain");
        }
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source);
      }
      expect(validateCommonProtectedContentInventory(root)).toEqual([
        `moved object-access codec consumer: ${consumer.sourcePath}#${consumer.anchor}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
