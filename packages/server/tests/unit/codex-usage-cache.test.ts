import { describe, expect, test } from "bun:test";
import type { CodexUsageSnapshot } from "@nautilo/db";
import {
  CODEX_USAGE_LIVE_MAX_AGE_MS,
  CODEX_USAGE_STALE_MAX_AGE_MS,
  CodexUsageCache,
  requestedUsageRefreshFailure,
  withCodexUsageFreshness,
} from "../../src/codex/usage-cache";
import { CodexAdminControlFailure } from "../../src/codex/admin-control-plane";

const identity = {
  userId: "owner-1",
  profileId: "profile-1",
  profileGeneration: 3,
  accountGeneration: 4,
  expectedRevision: 5,
};
const observedAt = new Date("2026-08-01T10:00:00.000Z");
const usage = {
  summary: {
    lifetimeTokens: "10",
    peakDailyTokens: null,
    longestRunningTurnSec: null,
    currentStreakDays: null,
    longestStreakDays: null,
  },
  daily: [{ startDate: "2026-08-01", tokens: "10" }],
  observedAt: "2026-08-01T10:00:00.000Z",
  freshness: "live" as const,
};
const rateLimits = {
  primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null },
  secondary: null,
  plan: "pro" as const,
  credits: null,
  spendControl: null,
  reached: null,
  observedAt: "2026-08-01T10:00:00.000Z",
  freshness: "live" as const,
};

describe("CodexUsageCache", () => {
  test("singleflights exact owner/profile/generation/revision reads and persists both safe halves once", async () => {
    let usageReads = 0;
    let rateReads = 0;
    let writes = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const cache = new CodexUsageCache({ now: () => observedAt });
    const ports = {
      readUsage: async () => { usageReads += 1; await held; return usage; },
      readRateLimits: async () => { rateReads += 1; await held; return rateLimits; },
      persist: async ({ patch }: { patch: object }) => {
        writes += 1;
        return { patch };
      },
    };
    const first = cache.refresh(identity, ports);
    const second = cache.refresh(identity, ports);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(usageReads).toBe(1);
    expect(rateReads).toBe(1);
    expect(writes).toBe(1);
    expect(one).toEqual(two);
    expect(one.patch).toEqual({ usage, rateLimits });
  });

  test("does not share a stale optimistic revision with a newer revision", async () => {
    let writes = 0;
    const cache = new CodexUsageCache({ now: () => observedAt });
    const ports = {
      readUsage: async () => usage,
      readRateLimits: async () => rateLimits,
      persist: async () => ({ revision: ++writes }),
    };
    await Promise.all([
      cache.refresh(identity, ports),
      cache.refresh({ ...identity, expectedRevision: identity.expectedRevision + 1 }, ports),
    ]);
    expect(writes).toBe(2);
  });

  test("persists a successful half without erasing the unavailable half and preserves requested capability failure", async () => {
    const unsupported = new CodexAdminControlFailure("CODEX_CAPABILITY_UNAVAILABLE");
    const cache = new CodexUsageCache({ now: () => observedAt });
    let saved: unknown;
    const outcome = await cache.refresh(identity, {
      readUsage: async () => { throw unsupported; },
      readRateLimits: async () => rateLimits,
      persist: async ({ patch }) => {
        saved = patch;
        return { id: "profile-1" };
      },
    });
    expect(saved).toEqual({ rateLimits });
    expect(outcome.usageError).toBe(unsupported);
    expect(requestedUsageRefreshFailure(outcome, "usage")).toBe(unsupported);
    expect(requestedUsageRefreshFailure(outcome, "rateLimits")).toBeNull();
  });

  test("only lowers freshness as the local safe snapshot ages", () => {
    const snapshot: CodexUsageSnapshot = { schemaVersion: 1, usage, rateLimits };
    expect(withCodexUsageFreshness(snapshot, observedAt, new Date(observedAt.getTime() + CODEX_USAGE_LIVE_MAX_AGE_MS)).usage?.freshness).toBe("live");
    expect(withCodexUsageFreshness(snapshot, observedAt, new Date(observedAt.getTime() + CODEX_USAGE_LIVE_MAX_AGE_MS + 1)).usage?.freshness).toBe("cached");
    expect(withCodexUsageFreshness(snapshot, observedAt, new Date(observedAt.getTime() + CODEX_USAGE_STALE_MAX_AGE_MS + 1)).rateLimits?.freshness).toBe("stale");
    expect(withCodexUsageFreshness({ ...usage, freshness: "stale" }, observedAt, observedAt).freshness).toBe("stale");
  });
});
