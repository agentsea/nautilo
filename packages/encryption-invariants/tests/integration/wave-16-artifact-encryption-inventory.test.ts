import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  ARTIFACT_ENCRYPTION_SURFACES,
  validateArtifactEncryptionInventory,
} from "../../src/node/artifact-encryption-inventory.ts";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Wave 16/17 Artifact encryption inventory", () => {
  test("keeps the dormant Human lifecycle explicit and ordinary consumers legacy", () => {
    expect(validateArtifactEncryptionInventory(repositoryRoot)).toEqual([]);
    expect(
      ARTIFACT_ENCRYPTION_SURFACES
        .filter((surface) => surface.implementationState === "protected")
        .map((surface) => surface.id),
    ).toEqual([
      "artifact.schema.product",
      "artifact.crypto.blob",
      "artifact.crypto.control",
      "artifact.blob.filesystem",
      "artifact.repository.shadow",
      "artifact.crypto.human-publication",
      "artifact.crypto.human-access",
      "artifact.client.human",
      "artifact.route.human-dormant",
      "artifact.viewer.human-dormant",
    ]);
    expect(
      ARTIFACT_ENCRYPTION_SURFACES
        .filter((surface) => surface.implementationState === "legacy_only")
        .map((surface) => surface.id),
    ).toContain("artifact.route.server");
  });

  test("fails when a protected semantic anchor is removed or moved", () => {
    const first = ARTIFACT_ENCRYPTION_SURFACES[0];
    expect(validateArtifactEncryptionInventory(repositoryRoot, [{
      ...first,
      implementationAnchors: [{
        sourcePath: first.sourcePath,
        anchor: "missing-protected-artifact-anchor",
      }],
    }])).toEqual([
      `missing Artifact implementation anchor: ${first.sourcePath}#missing-protected-artifact-anchor`,
    ]);
  });
});
