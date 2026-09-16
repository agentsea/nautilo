import { expect, test } from "bun:test";
import { memoryAdminStatusSchema } from "../../src/memory-admin";

const status = {
  generatedAt: "2026-09-05T12:00:00Z", window: { since: "2026-09-04T12:00:00Z", until: "2026-09-05T12:00:00Z" },
  enabled: true, model: { id: null, provider: null, source: "conductor", available: false },
  encryption: { mode: "ordinary", available: true }, trackedSince: null, health: "unavailable",
  current: { accumulating: 0, due: 0, processing: 0, retrying: 0, blocked: 0, caughtUp: 0, safelyRetryable: 0, oldestOverdueMs: null },
  lastSuccessfulReviewAt: null, lastAttemptAt: null,
  last24h: { completedReviews: 0, noChangeReviews: 0, created: 0, replaced: 0, promoted: 0, demoted: 0, failures: null, lastReviewDurationMs: null },
  recentFailures: [], followUpPending: 0, exitFlush: "not_scheduled",
};

test("missing measurements remain distinct from observed zero", () => {
  const parsed = memoryAdminStatusSchema.parse(status);
  expect(parsed.last24h.completedReviews).toBe(0);
  expect(parsed.last24h.failures).toBeNull();
  expect(memoryAdminStatusSchema.safeParse({ ...status, last24h: {} }).success).toBe(false);
});

test("diagnostics reject content fields and arbitrary provider failure text", () => {
  expect(memoryAdminStatusSchema.safeParse({ ...status, roomLabel: "Private room" }).success).toBe(false);
  expect(memoryAdminStatusSchema.safeParse({ ...status, recentFailures: [{
    phase: "model", code: "provider body with private data", occurredAt: status.generatedAt,
    nextRetryAt: null, retryable: false,
  }] }).success).toBe(false);
});
