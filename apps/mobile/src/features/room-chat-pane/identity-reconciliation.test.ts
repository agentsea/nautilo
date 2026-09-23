import { describe, expect, test } from "bun:test";

import { decideIdentityReconciliation } from "./identity-reconciliation";

describe("Room identity reconciliation", () => {
  test("reconciles once when verified identity first becomes available", () => {
    expect(decideIdentityReconciliation(null, "server:user:room")).toEqual({
      nextScope: "server:user:room",
      shouldReconcile: true,
    });
    expect(decideIdentityReconciliation("server:user:room", "server:user:room")).toEqual({
      nextScope: "server:user:room",
      shouldReconcile: false,
    });
  });

  test("identity loss invalidates the receipt so relogin reconciles again", () => {
    const signedOut = decideIdentityReconciliation("server:user:room", null);
    expect(signedOut).toEqual({ nextScope: null, shouldReconcile: false });
    expect(decideIdentityReconciliation(signedOut.nextScope, "server:user:room").shouldReconcile)
      .toBe(true);
  });
});
