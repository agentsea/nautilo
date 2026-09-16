import { describe, expect, test } from "bun:test";

import {
  activationExclusionLocator,
  isActivationSourceFileName,
  type ActivationReferenceExclusion,
  validateActivationExclusionShape,
} from "../../src/node/activation-inventory-decisions";

const validExclusion: ActivationReferenceExclusion = {
  path: "packages/example/config.ts",
  token: "encryption_mode",
  signature: "const mode = config.encryption_mode;",
  occurrence: 1,
  reason: "This exact occurrence is unrelated local storage metadata.",
};

describe("activation inventory decisions", () => {
  test.each([
    "source.cjs",
    "source.env",
    "source.example",
    "source.js",
    "source.json",
    "source.mjs",
    "source.py",
    "source.sh",
    "source.toml",
    "source.ts",
    "source.tsx",
    "source.yaml",
    "source.yml",
    ".env",
    ".env.production",
    "Caddyfile",
    "Caddyfile.production",
    "Containerfile",
    "Containerfile.production",
    "Dockerfile",
    "Dockerfile.production",
    "Procfile",
    "Procfile.production",
  ])("includes runtime/deployment source name %s", (fileName) => {
    expect(isActivationSourceFileName(fileName)).toBe(true);
  });

  test.each([
    "",
    ".environment",
    "Dockerfiles",
    "myDockerfile",
    "README.md",
    "asset.png",
  ])("rejects non-source name %s", (fileName) => {
    expect(isActivationSourceFileName(fileName)).toBe(false);
  });

  test("builds the exact occurrence-qualified exclusion locator", () => {
    expect(activationExclusionLocator(validExclusion)).toBe(
      "packages/example/config.ts#encryption_mode#const mode = config.encryption_mode;#1",
    );
  });

  test("accepts the exact descriptive boundary and canonical occurrence", () => {
    expect(validateActivationExclusionShape({
      ...validExclusion,
      reason: "abcdefghijkl",
    })).toEqual([]);
  });

  test.each([
    {
      patch: { reason: "abcdefghijk" },
      error:
        "activation exclusion packages/example/config.ts#encryption_mode has no descriptive reason",
    },
    {
      patch: { reason: " abcdefghijk " },
      error:
        "activation exclusion packages/example/config.ts#encryption_mode has no descriptive reason",
    },
    {
      patch: { signature: "" },
      error:
        "activation exclusion packages/example/config.ts#encryption_mode##1 has a non-canonical signature",
    },
    {
      patch: { signature: " const mode = config.encryption_mode;" },
      error:
        "activation exclusion packages/example/config.ts#encryption_mode# const mode = config.encryption_mode;#1 has a non-canonical signature",
    },
    {
      patch: { signature: "const mode = config.encryption_mode; " },
      error:
        "activation exclusion packages/example/config.ts#encryption_mode#const mode = config.encryption_mode; #1 has a non-canonical signature",
    },
    {
      patch: { occurrence: 0 },
      error:
        "activation exclusion packages/example/config.ts#encryption_mode#const mode = config.encryption_mode;#0 has an invalid occurrence",
    },
    {
      patch: { occurrence: 1.5 },
      error:
        "activation exclusion packages/example/config.ts#encryption_mode#const mode = config.encryption_mode;#1.5 has an invalid occurrence",
    },
  ])("rejects malformed exclusion shape %#", ({ patch, error }) => {
    expect(validateActivationExclusionShape({
      ...validExclusion,
      ...patch,
    })).toContain(error);
  });
});
