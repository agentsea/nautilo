import { expect, test } from "bun:test";
import type { CodexUsageSnapshot } from "../../src/schema/codex";

test("D453 usage snapshot type requires a safe projection", () => {
  const rateLimitsOnly: CodexUsageSnapshot = {
    schemaVersion: 1,
    rateLimits: {
      primary: null,
      secondary: null,
      plan: null,
      credits: null,
      spendControl: null,
      reached: null,
      observedAt: "2026-07-27T10:00:00.000Z",
      freshness: "live",
    },
  };
  // @ts-expect-error A version marker alone is not a persistence-safe snapshot.
  const emptySnapshot: CodexUsageSnapshot = { schemaVersion: 1 };
  void emptySnapshot;
  expect(rateLimitsOnly.schemaVersion).toBe(1);
});
