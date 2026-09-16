import { describe, expect, test } from "bun:test";

import { reflectionProtectedAuthorityStatusSchema } from "../../src/reflection-admin";

const fixture = {
  dtoVersion: 1,
  scope: "authority_maintenance_only",
  current: {
    awaitingRecipient: "1",
    awaitingEligibleDeviceAndKeys: "2",
    readyOrRunning: "3",
    reconciliationPending: "4",
    retirementPending: "5",
    verifiedAuthority: "9007199254740993",
    terminalOrStale: "6",
  },
  last24h: { verifiedAuthority: "7", terminalOrStale: "8" },
} as const;

describe("reflectionProtectedAuthorityStatusSchema", () => {
  test("preserves exact count strings beyond JavaScript's safe integer range", () => {
    expect(reflectionProtectedAuthorityStatusSchema.parse(fixture)).toEqual(fixture);
  });

  test("rejects model-result claims and malformed counts", () => {
    expect(reflectionProtectedAuthorityStatusSchema.safeParse({
      ...fixture,
      modelResults: "1",
    }).success).toBe(false);
    expect(reflectionProtectedAuthorityStatusSchema.safeParse({
      ...fixture,
      current: { ...fixture.current, awaitingRecipient: "01" },
    }).success).toBe(false);
  });
});
