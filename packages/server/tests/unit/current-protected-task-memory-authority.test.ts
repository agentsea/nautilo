import { describe, expect, test } from "bun:test";

import {
  requireHeldProtectedTaskMemoryWriterAuthority,
  type HeldProtectedTaskMemoryAuthority,
} from "../../src/routes/current-protected-task-memory-authority";

describe("current protected Task Memory authority", () => {
  test("does not trust a public-shape assertion as held authority", () => {
    let assertionUses = 0;
    const fabricated = Object.freeze({
      policy: Object.freeze({
        mode: "encrypted_only",
        shadowBehavior: "strict",
        revision: 1,
      }),
      currentRuntime: Object.freeze({}),
      assertCurrent: async () => {
        assertionUses += 1;
      },
    }) as unknown as HeldProtectedTaskMemoryAuthority;

    expect(() => requireHeldProtectedTaskMemoryWriterAuthority(fabricated))
      .toThrow("Task Memory authority is not active");
    expect(assertionUses).toBe(0);
  });
});
