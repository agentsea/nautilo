import { describe, expect, test } from "bun:test";

import {
  SEMANTIC_VERSION,
  semanticVersionCompatibility,
} from "../../src/versions";

describe("semantic version compatibility", () => {
  test("supports explicit v1.0 legacy reads and current v1.1 only", () => {
    expect(SEMANTIC_VERSION).toEqual({ major: 1, minor: 1 });
    expect(semanticVersionCompatibility({ major: 1, minor: 0 }, 1))
      .toEqual({ compatible: true });
    expect(semanticVersionCompatibility({ major: 1, minor: 1 }, 1))
      .toEqual({ compatible: true });
    expect(semanticVersionCompatibility({ major: 1, minor: 2 }, 1))
      .toEqual({ compatible: false, reason: "unknown-minor" });
  });
});
