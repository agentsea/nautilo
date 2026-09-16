import { describe, expect, test } from "bun:test";
import {
  NOTIFICATION_SUMMARY_FRESH_MS,
  aggregatePublicSummaries,
  isSummaryFresh,
  publicSummaryState,
  saturatingAdd,
  validateNotificationSummaryInput,
  type StoredNotificationSummary,
} from "../../electron/notification-summary";

const VALID = {
  epoch: "provider-1",
  generation: 1,
  generatedAt: "2026-08-04T12:00:00.000Z",
  unreadCount: 4,
  importantUnreadCount: 2,
};

describe("M240 notification summary validation", () => {
  test("accepts the exact content-free shape", () => {
    expect(validateNotificationSummaryInput(VALID)).toEqual(VALID);
  });

  test("rejects extra/missing keys and invalid values", () => {
    expect(validateNotificationSummaryInput({ ...VALID, roomId: "no" })).toBeNull();
    const { epoch: _epoch, ...missingEpoch } = VALID;
    expect(validateNotificationSummaryInput(missingEpoch as typeof VALID)).toBeNull();
    expect(validateNotificationSummaryInput({ ...VALID, epoch: " " })).toBeNull();
    expect(validateNotificationSummaryInput({ ...VALID, generation: 0 })).toBeNull();
    expect(validateNotificationSummaryInput({ ...VALID, generation: 1.5 })).toBeNull();
    expect(validateNotificationSummaryInput({ ...VALID, generatedAt: "never" })).toBeNull();
    expect(validateNotificationSummaryInput({ ...VALID, unreadCount: -1 })).toBeNull();
    expect(validateNotificationSummaryInput({
      ...VALID,
      unreadCount: 1,
      importantUnreadCount: 2,
    })).toBeNull();
  });
});
describe("M240 notification summary freshness and aggregation", () => {
  const stored: StoredNotificationSummary = {
    ...VALID,
    receivedAtMs: 1_000,
  };

  test("expires exactly at two minutes of main-owned receipt age", () => {
    expect(isSummaryFresh(stored, 1_000 + NOTIFICATION_SUMMARY_FRESH_MS - 1)).toBe(true);
    expect(isSummaryFresh(stored, 1_000 + NOTIFICATION_SUMMARY_FRESH_MS)).toBe(false);
    expect(isSummaryFresh(stored, 1_000 + NOTIFICATION_SUMMARY_FRESH_MS + 1)).toBe(false);
  });

  test("classifies unknown, fresh, and retained last-known stale values", () => {
    expect(publicSummaryState({
      summary: null,
      eligible: true,
      nowMs: 1_000,
    })).toEqual({ state: "unknown" });
    expect(publicSummaryState({
      summary: stored,
      eligible: true,
      nowMs: 1_001,
    })).toEqual({
      state: "fresh",
      unreadCount: 4,
      importantUnreadCount: 2,
    });
    expect(publicSummaryState({
      summary: stored,
      eligible: false,
      nowMs: 1_001,
    })).toEqual({
      state: "stale",
      unreadCount: 4,
      importantUnreadCount: 2,
    });
  });

  test("sums only fresh values and counts unavailable servers", () => {
    expect(aggregatePublicSummaries([
      { state: "fresh", unreadCount: 4, importantUnreadCount: 2 },
      { state: "fresh", unreadCount: 3, importantUnreadCount: 0 },
      { state: "stale", unreadCount: 99, importantUnreadCount: 99 },
      { state: "unknown" },
    ])).toEqual({
      unreadCount: 7,
      importantUnreadCount: 2,
      unavailableServerCount: 2,
    });
  });

  test("saturates aggregate arithmetic at Number.MAX_SAFE_INTEGER", () => {
    expect(saturatingAdd(Number.MAX_SAFE_INTEGER - 1, 20)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(aggregatePublicSummaries([
      {
        state: "fresh",
        unreadCount: Number.MAX_SAFE_INTEGER,
        importantUnreadCount: Number.MAX_SAFE_INTEGER,
      },
      { state: "fresh", unreadCount: 1, importantUnreadCount: 1 },
    ])).toEqual({
      unreadCount: Number.MAX_SAFE_INTEGER,
      importantUnreadCount: Number.MAX_SAFE_INTEGER,
      unavailableServerCount: 0,
    });
  });
});
