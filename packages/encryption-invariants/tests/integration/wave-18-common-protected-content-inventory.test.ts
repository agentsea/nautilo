import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
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
});
