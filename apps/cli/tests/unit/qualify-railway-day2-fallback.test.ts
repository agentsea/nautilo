import { describe, expect, test } from "bun:test";

import { shouldInjectRailwayCandidateFailure } from "../../scripts/qualify-railway-day2-fallback";
import type { RailwayMaintenanceState } from "../../src/lib/railway-maintenance-state";

function candidate(): RailwayMaintenanceState {
  return {
    sourceLaunchId: "launch-1",
    sourceManagedWorkbenchHostname: "nautilo.example.test",
    candidateUpgrade: { stage: "complete" },
    postUpgradeSourceState: {},
  } as unknown as RailwayMaintenanceState;
}

describe("Railway Day Two fallback qualification injection", () => {
  test("admits only the exact receipt-owned candidate readiness request", () => {
    const state = candidate();
    expect(shouldInjectRailwayCandidateFailure({ state, expectedLaunchId: "launch-1",
      requestUrl: "https://nautilo.example.test/health/ready" })).toBe(true);
    for (const requestUrl of [
      "http://nautilo.example.test/health/ready",
      "https://other.example.test/health/ready",
      "https://nautilo.example.test/health",
      "https://nautilo.example.test/health/ready?again=1",
    ]) {
      expect(shouldInjectRailwayCandidateFailure({ state, expectedLaunchId: "launch-1", requestUrl })).toBe(false);
    }
    expect(shouldInjectRailwayCandidateFailure({ state, expectedLaunchId: "launch-2",
      requestUrl: "https://nautilo.example.test/health/ready" })).toBe(false);
  });

  test("cannot inject after fallback or replacement preparation begins", () => {
    const fallback = { ...candidate(), fallbackDecision: { reason: "candidate-verification" } } as unknown as RailwayMaintenanceState;
    const replacement = { ...candidate(), restoreTargetPreparation: {} } as unknown as RailwayMaintenanceState;
    const requestUrl = "https://nautilo.example.test/health/ready";
    expect(shouldInjectRailwayCandidateFailure({ state: fallback, expectedLaunchId: "launch-1", requestUrl })).toBe(false);
    expect(shouldInjectRailwayCandidateFailure({ state: replacement, expectedLaunchId: "launch-1", requestUrl })).toBe(false);
  });
});
