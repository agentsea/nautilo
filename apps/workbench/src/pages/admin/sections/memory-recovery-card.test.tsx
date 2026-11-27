import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CapabilitySlug, MemoryAdminStatus, ReflectionAdminStatus, StenographerAdminStatus } from "@nautilo/types";

let capabilities = new Set<CapabilitySlug>();
const receipt = { requestId: "11111111-1111-4111-8111-111111111111", observedThrough: "2026-11-27T10:00:00Z",
  stenographer: { state: "assessed" as const, queued: 2, held: 0 }, reflection: { state: "assessed" as const, queued: 8, held: 1 },
  memory: { state: "assessed" as const, queued: 1, held: 0 } };
const recover = mock(async (_id: string) => receipt);
const latest = mock(async (): Promise<{ run: typeof receipt | null }> => ({ run: null }));
const getStenographer = mock(async (): Promise<StenographerAdminStatus> => stenographerFixture());
const getReflection = mock(async (): Promise<ReflectionAdminStatus> => reflectionFixture());
const getMemory = mock(async (): Promise<MemoryAdminStatus> => memoryFixture());
mock.module("../../../hooks/use-can", () => ({ useCan: () => (capability: CapabilitySlug) => capabilities.has(capability) }));
mock.module("../../../lib/api", () => ({ apiClient: { admin: {
  memoryRecovery: { latest, run: recover }, stenographerStatus: { get: getStenographer }, reflectionStatus: { get: getReflection }, memoryStatus: { get: getMemory },
} } }));

const { MemoryRecoveryCard, summarizeMemory, summarizeReflection, summarizeStenographer } = await import("./memory-recovery-card");

function stenographerFixture(): StenographerAdminStatus {
  return {
    generatedAt: "2026-11-27T10:00:00.000Z", window: { since: "2026-11-26T10:00:00.000Z", until: "2026-11-27T10:00:00.000Z" }, health: "delayed",
    current: { eligibleRooms: 4, caughtUpRooms: 2, accumulatingRooms: 0, processingRooms: 1, retryingRooms: 1, dueRooms: 0, staleLeases: 0, oldestOverdueMs: 1000, rebuildingRooms: 0, historicalPendingRooms: 0, historicalCompletedRooms: 0 },
    last24h: { completedExtractionBatches: 1, extractionBatchesWithErrors: 0, retriedExtractionBatches: 1, zeroEventExtractionBatches: 0, eventsWritten: 1, extractionDurationP50Ms: 1, extractionDurationP95Ms: 1 },
    journal: { projectedBodyCodePointsP50: 1, projectedBodyCodePointsP95: 1, projectedBodyCodePointsMax: 1 },
    compaction: { awaitingRooms: 0, processingRooms: 0, retryingRooms: 0, staleLeases: 0, oldestOverdueMs: 0, lastCompletedAt: null }, recentFailures: [],
  };
}

function reflectionFixture(): ReflectionAdminStatus {
  const distribution = { samples: 0, p50Ms: 0, p90Ms: 0, maximumMs: 0 };
  const latency = { endToEnd: distribution, queue: distribution, candidate: distribution, model: distribution, publication: distribution };
  return {
    generatedAt: "2026-11-27T10:00:00.000Z", window: { since: "2026-11-26T10:00:00.000Z", until: "2026-11-27T10:00:00.000Z" }, health: "healthy",
    scheduler: { state: "cooldown", pauseReason: null, recoveryIntervalMs: 15_000, nextEligiblePollAt: null, lastPoll: null,
      window: { polls: 0, admitted: 0, completed: 0, created: 0 }, backlog: { size: 0, oldestAgeMs: 0 }, latency: { sameRoom: latency, crossRoom: latency }, amplification: "normal" },
    current: { totalRecords: 0, backlog: 0, due: 0, claimed: 0, checkpointed: 0, deferred: 0, complete: 0, quarantined: 0, recoveryEligible: 0, maximumRecoveryRound: 0, staleLeases: 0, oldestOverdueMs: 0, maximumAttempts: 0, currentParentViolations: 0 },
    stages: { authorityProjection: 0, searchProjection: 0, organization: 0 }, projections: { availableRecords: 0, current: 0, pending: 0, incompatible: 0 },
    last24h: { completedWork: 0, syntheticParentsCreated: 0 }, lastCompletedAt: null, nextRecoveryAt: null, currentFailures: [],
  };
}

function memoryFixture(): MemoryAdminStatus {
  return {
    generatedAt: "2026-11-27T10:00:00.000Z", window: { since: "2026-11-26T10:00:00.000Z", until: "2026-11-27T10:00:00.000Z" }, enabled: true,
    model: { id: "test:model", provider: "test", source: "server", available: true }, encryption: { mode: "ordinary", available: true }, trackedSince: "2026-11-26T10:00:00.000Z", health: "healthy",
    current: { accumulating: 0, due: 0, processing: 0, retrying: 0, blocked: 0, caughtUp: 3, safelyRetryable: 0, oldestOverdueMs: null },
    lastSuccessfulReviewAt: "2026-11-27T09:00:00.000Z", lastAttemptAt: "2026-11-27T09:00:00.000Z",
    last24h: { completedReviews: 1, noChangeReviews: 0, created: 1, replaced: 0, promoted: 0, demoted: 0, failures: 0, lastReviewDurationMs: 1 }, recentFailures: [], followUpPending: 0, exitFlush: "not_scheduled",
  };
}

beforeEach(() => {
  reapplyHappyDomGlobals(); cleanup(); capabilities = new Set(["read_server_settings"]);
  recover.mockClear(); latest.mockClear(); latest.mockImplementation(async () => ({ run: null }));
  getStenographer.mockClear(); getReflection.mockClear(); getMemory.mockClear();
  getStenographer.mockImplementation(async () => stenographerFixture());
  getReflection.mockImplementation(async () => reflectionFixture());
  getMemory.mockImplementation(async () => memoryFixture());
});
afterEach(cleanup);
const show = () => render(<MemoryRouter><MemoryRecoveryCard /></MemoryRouter>);

describe("MemoryRecoveryCard", () => {
  test("shows a server-wide read-only summary without Room, job, or model controls", async () => {
    const view = show();
    await waitFor(() => expect(view.getByTestId("memory-recovery-summary")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Recover all memory" })).toBeNull();
    expect(view.queryByLabelText("Room ID")).toBeNull();
    expect(view.queryByRole("button", { name: /retry|run|preview/i })).toBeNull();
    expect(view.queryByRole("combobox")).toBeNull();
    expect(view.getByText("Catching up")).toBeTruthy();
    expect(view.getByText("Waiting")).toBeTruthy();
    expect(view.getByText("Healthy")).toBeTruthy();
    expect(view.getByRole("link", { name: "Server Models" }).getAttribute("href")).toBe("/admin#models");
    expect(view.getByRole("link", { name: "View Stenographer details" }).getAttribute("href")).toBe("/admin#stenographer");
  });

  test("keeps available processors visible when one status read fails", async () => {
    getReflection.mockRejectedValueOnce(new Error("unavailable"));
    const view = show();
    await waitFor(() => expect(view.getByTestId("memory-recovery-summary")).toBeTruthy());
    expect(view.getByText("Journal or compaction work is queued, retrying, or processing automatically.")).toBeTruthy();
    expect(view.getByText("Tracked Memory review work is caught up.")).toBeTruthy();
    expect(view.getByText(/current recovery outcome is unknown/)).toBeTruthy();
    expect(view.getAllByText("Needs attention")).toHaveLength(1);
  });

  test("one operator click covers every processor and retries a lost response with the same request", async () => {
    capabilities.add("manage_server_operations");
    recover.mockRejectedValueOnce(new Error("disconnected"));
    const view = show();
    await waitFor(() => expect(view.getByTestId("memory-recovery-summary")).toBeTruthy());
    expect(recover).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Recover all memory" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("same request"));
    latest.mockImplementation(async () => ({ run: receipt }));
    fireEvent.click(view.getByRole("button", { name: "Recover all memory" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("8 queued · 1 held at request"));
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover.mock.calls[0]?.[0]).toBe(recover.mock.calls[1]?.[0]);
  });

  test("resolved historical failures do not keep the recovery indicators red", () => {
    expect(summarizeStenographer({ ...stenographerFixture(), unresolvedProviderOutcomes: 0,
      recentFailures: [{ stage: "extraction", errorCode: "provider_outcome_unknown", occurredAt: receipt.observedThrough, attemptCount: 1, modelId: null }] }).state).toBe("catching_up");
    expect(summarizeMemory({ ...memoryFixture(), recentFailures: [{ phase: "model", code: "provider_outcome_unknown",
      occurredAt: receipt.observedThrough, nextRetryAt: null, retryable: false }] }).state).toBe("healthy");
  });

  test("refreshes all processor summaries", async () => {
    const view = show();
    await waitFor(() => expect(getMemory).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getMemory).toHaveBeenCalledTimes(2));
    expect(getStenographer).toHaveBeenCalledTimes(2);
    expect(getReflection).toHaveBeenCalledTimes(2);
  });

  test("never clears current unknown outcomes and distinguishes pauses from attention", () => {
    expect(summarizeStenographer({ ...stenographerFixture(), recentFailures: [{ stage: "extraction", errorCode: "provider_outcome_unknown", occurredAt: "2026-11-27T10:00:00.000Z", attemptCount: 1, modelId: "test:model" }] }).state).toBe("needs_attention");
    expect(summarizeMemory({ ...memoryFixture(), current: { ...memoryFixture().current, blocked: 1 }, recentFailures: [{ phase: "model", code: "provider_outcome_unknown", occurredAt: "2026-11-27T10:00:00.000Z", nextRetryAt: null, retryable: false }] }).state).toBe("needs_attention");
    expect(summarizeStenographer({ ...stenographerFixture(), unresolvedProviderOutcomes: 1 }).state).toBe("needs_attention");
    expect(summarizeReflection({ ...reflectionFixture(), unresolvedProviderOutcomes: 1 }).state).toBe("needs_attention");
    expect(summarizeMemory({ ...memoryFixture(), enabled: false }).state).toBe("paused");
    expect(summarizeReflection({ ...reflectionFixture(), scheduler: { ...reflectionFixture().scheduler, state: "pressure_paused", pauseReason: "repeated_failure" } }).state).toBe("paused");
  });

  test("distinguishes settled success with no durable result from an unknown provider outcome", async () => {
    getReflection.mockImplementationOnce(async () => ({
      ...reflectionFixture(),
      unresolvedProviderOutcomes: 3,
      providerSucceededResultMissing: 2,
      resumedFromSavedProposal: 4,
      last24h: { completedWork: 6, syntheticParentsCreated: 0 },
    }));
    const view = show();
    await waitFor(() => expect(view.getByText(/2 jobs have a successful provider call and a missing result/)).toBeTruthy());
    expect(view.getByText(/1 job has an unknown provider outcome/)).toBeTruthy();
    expect(view.getByText(/Automatic retries are on hold/)).toBeTruthy();
    expect(view.getByText(/4 resumed from a saved proposal. Completed in the past 24 hours: 6/)).toBeTruthy();
    expect(view.getByText(/Held work is excluded/)).toBeTruthy();
  });

  test("requires read permission before requesting status", () => {
    capabilities.clear();
    const view = show();
    expect(view.queryByTestId("memory-recovery-card")).toBeNull();
    expect(getMemory).not.toHaveBeenCalled();
  });
});
