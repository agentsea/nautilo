import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CapabilitySlug, MemoryAdminStatus, MemoryRecoveryRun, ReflectionAdminStatus, StenographerAdminStatus } from "@nautilo/types";

let capabilities = new Set<CapabilitySlug>();
let operatorId = "first-operator";
const receipt: MemoryRecoveryRun = { requestId: "11111111-1111-4111-8111-111111111111", observedThrough: "2026-11-27T10:00:00Z",
  stenographer: { state: "assessed" as const, queued: 2, held: 0 }, reflection: { state: "assessed" as const, queued: 8, held: 1 },
  memory: { state: "assessed" as const, queued: 1, held: 0 } };
const recover = mock(async (_id: string) => receipt);
const latest = mock(async (): Promise<{ run: MemoryRecoveryRun | null }> => ({ run: null }));
const getStenographer = mock(async (): Promise<StenographerAdminStatus> => stenographerFixture());
const getReflection = mock(async (): Promise<ReflectionAdminStatus> => reflectionFixture());
const getMemory = mock(async (): Promise<MemoryAdminStatus> => memoryFixture());
mock.module("../../../hooks/use-can", () => ({ useCan: () => (capability: CapabilitySlug) => capabilities.has(capability) }));
mock.module("../../../hooks/use-auth", () => ({ useAuth: () => ({ viewer: { sessionUserId: operatorId } }) }));
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
  sessionStorage.clear(); operatorId = "first-operator";
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

  test("a confirmed partial failure lets the next operator authorize all current failures", async () => {
    capabilities.add("manage_server_operations");
    const partial: MemoryRecoveryRun = { ...receipt, reflection: { state: "unavailable" } };
    latest.mockResolvedValueOnce({ run: partial }).mockResolvedValueOnce({ run: receipt });
    const view = show();
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("Assessment incomplete. Earlier batches may already be queued."));
    fireEvent.click(view.getByRole("button", { name: "Recover all memory" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("8 queued · 1 held"));
    expect(recover.mock.calls).toHaveLength(1);
    expect(recover.mock.calls[0]![0]).not.toBe(partial.requestId);
  });

  test("an in-progress request resumes its original snapshot", async () => {
    capabilities.add("manage_server_operations");
    latest.mockResolvedValueOnce({ run: { ...receipt, reflection: { state: "unavailable" }, memory: null } });
    const view = show();
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("Request in progress"));
    fireEvent.click(view.getByRole("button", { name: "Recover all memory" }));
    await waitFor(() => expect(recover.mock.calls).toEqual([[receipt.requestId]]));
  });

  test("waits for the last receipt before allowing a fresh authorization", async () => {
    capabilities.add("manage_server_operations");
    latest.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const view = show();
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("last recovery request"));
    const action = view.getByRole("button", { name: "Recover all memory" });
    fireEvent.click(action);
    expect(recover).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(action.hasAttribute("disabled")).toBe(false));
  });

  test("one operator click covers every processor and retries a lost response with the same request", async () => {
    capabilities.add("manage_server_operations");
    recover.mockRejectedValueOnce(new Error("disconnected"));
    let view = show();
    await waitFor(() => expect(view.getByTestId("memory-recovery-summary")).toBeTruthy());
    expect(recover).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Recover all memory" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("same request"));
    view.unmount();
    view = show();
    await waitFor(() => expect(view.getByRole("button", { name: "Recover all memory" }).hasAttribute("disabled")).toBe(false));
    latest.mockImplementation(async () => ({ run: receipt }));
    fireEvent.click(view.getByRole("button", { name: "Recover all memory" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("8 queued · 1 held at request"));
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover.mock.calls[0]?.[0]).toBe(recover.mock.calls[1]?.[0]);
  });

  test("an unconfirmed request belongs to the operator who sent it", async () => {
    capabilities.add("manage_server_operations");
    recover.mockRejectedValueOnce(new Error("disconnected"));
    const first = show();
    await waitFor(() => expect(first.getByTestId("memory-recovery-summary")).toBeTruthy());
    fireEvent.click(first.getByRole("button", { name: "Recover all memory" }));
    await waitFor(() => expect(first.getByRole("alert").textContent).toContain("same request"));
    first.unmount();
    operatorId = "second-operator";
    latest.mockResolvedValueOnce({ run: { ...receipt, reflection: { state: "unavailable" } } });
    const second = show();
    await waitFor(() => expect(second.getByRole("status").textContent).toContain("Assessment incomplete. Earlier batches may already be queued."));
    expect(second.queryByRole("alert")).toBeNull();
    fireEvent.click(second.getByRole("button", { name: "Recover all memory" }));
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    expect(recover.mock.calls[1]![0]).not.toBe(recover.mock.calls[0]![0]);
    expect(recover.mock.calls[1]![0]).not.toBe(receipt.requestId);
  });

  test("reports retired summaries independently of newly queued source work", async () => {
    latest.mockImplementation(async () => ({ run: {
      ...receipt,
      reflection: { state: "assessed", queued: 3, held: 2, derivedRepair: { retired: 4, sourcesQueued: 3 } },
    } }));
    const view = show();
    await waitFor(() => expect(view.getByRole("status").textContent).toContain(
      "3 queued · 2 held at request. Generated summaries retired: 4. Source records queued for rebuilding: 3.",
    ));
  });

  test("reports generated summaries as queued for reassessment, not already repaired", async () => {
    latest.mockImplementation(async () => ({ run: {
      ...receipt,
      reflection: {
        state: "assessed",
        queued: 37,
        held: 0,
        derivedRepair: { retired: 0, sourcesQueued: 0, summariesQueued: 37 },
      },
    } }));
    const view = show();
    await waitFor(() => expect(view.getByRole("status").textContent).toContain(
      "37 queued · 0 held at request. Generated summaries queued for reassessment: 37.",
    ));
    expect(view.getByRole("status").textContent).not.toContain("retired");
    expect(view.getByRole("status").textContent).not.toContain("rebuilding");
  });

  test("explains quarantines even after provider holds have cleared", () => {
    const summary = summarizeReflection({ ...reflectionFixture(),
      current: { ...reflectionFixture().current, quarantined: 5 },
      quarantinedByReason: { invalidSelection: 0, missingAuthority: 1, stalePlan: 2, unavailableSource: 2 },
    });
    expect(summary.state).toBe("needs_attention");
    expect(summary.detail).toContain("1 missing current access evidence");
    expect(summary.detail).toContain("2 with outdated publication plans");
    expect(summary.detail).toContain("one fresh model attempt per eligible job");
    expect(summary.detail).toContain("2 missing a publication source");
  });

  test("resolved historical failures do not keep the recovery indicators red", () => {
    expect(summarizeStenographer({ ...stenographerFixture(), unresolvedProviderOutcomes: 0,
      recentFailures: [{ stage: "extraction", errorCode: "provider_outcome_unknown", occurredAt: receipt.observedThrough, attemptCount: 1, modelId: null }] }).state).toBe("catching_up");
    expect(summarizeMemory({ ...memoryFixture(), recentFailures: [{ phase: "model", code: "provider_outcome_unknown",
      occurredAt: receipt.observedThrough, nextRetryAt: null, retryable: false }] }).state).toBe("healthy");
  });

  test("asks the operator to authorize changed compaction inputs", () => {
    const summary = summarizeStenographer({
      ...stenographerFixture(),
      staleAuthorizedSourceRooms: 2,
    });
    expect(summary.state).toBe("needs_attention");
    expect(summary.detail).toBe(
      "2 Rooms need a fresh Journal compaction check. The inputs or funding evidence changed. Use Recover all memory to authorize eligible inputs.",
    );
  });

  test("refreshes all processor summaries", async () => {
    const view = show();
    await waitFor(() => expect(getMemory).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getMemory).toHaveBeenCalledTimes(2));
    expect(getStenographer).toHaveBeenCalledTimes(2);
    expect(getStenographer).toHaveBeenLastCalledWith({
      includeRecovery: true,
      includeRecoverySources: true,
    });
    expect(getReflection).toHaveBeenCalledTimes(2);
  });

  test("waits for slow diagnostics to settle before scheduling the next poll", async () => {
    jest.useFakeTimers();
    try {
      latest.mockResolvedValue({ run: receipt });
      const view = show();
      await act(async () => {});
      const slow = Promise.withResolvers<MemoryAdminStatus>();
      getMemory.mockImplementationOnce(() => slow.promise);
      await act(async () => jest.advanceTimersByTime(10_000));
      expect(getMemory).toHaveBeenCalledTimes(2);
      await act(async () => jest.advanceTimersByTime(30_000));
      expect(getMemory).toHaveBeenCalledTimes(2);
      await act(async () => slow.resolve({ ...memoryFixture(), enabled: false }));
      expect(view.getByText("Paused")).toBeTruthy();
      await act(async () => jest.advanceTimersByTime(9_999));
      expect(getMemory).toHaveBeenCalledTimes(2);
      await act(async () => jest.advanceTimersByTime(1));
      expect(getMemory).toHaveBeenCalledTimes(3);
      await act(async () => jest.advanceTimersByTime(10_000));
      expect(getMemory).toHaveBeenCalledTimes(4);
      view.unmount();
      await act(async () => jest.advanceTimersByTime(10_000));
      expect(getMemory).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  test("polls while current processor work is still live without a recovery receipt", async () => {
    jest.useFakeTimers();
    try {
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "healthy",
        current: {
          ...stenographerFixture().current,
          caughtUpRooms: 4,
          processingRooms: 0,
          retryingRooms: 0,
        },
      }));
      getMemory.mockImplementation(async () => ({
        ...memoryFixture(),
        health: "degraded",
        current: { ...memoryFixture().current, processing: 1, blocked: 1 },
      }));
      const view = show();
      await act(async () => {});
      expect(view.getAllByText("Needs attention")).toHaveLength(1);
      expect(latest).toHaveBeenCalledTimes(1);
      await act(async () => jest.advanceTimersByTime(10_000));
      await act(async () => {});
      expect(latest).toHaveBeenCalledTimes(2);
      expect(getStenographer).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("stops polling a settled receipt when current processors are idle", async () => {
    jest.useFakeTimers();
    try {
      latest.mockResolvedValue({ run: receipt });
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "healthy",
        current: {
          ...stenographerFixture().current,
          caughtUpRooms: 4,
          processingRooms: 0,
          retryingRooms: 0,
        },
      }));
      getReflection.mockImplementation(async () => ({
        ...reflectionFixture(),
        health: "degraded",
        unresolvedProviderOutcomes: 1,
        current: {
          ...reflectionFixture().current,
          backlog: 7,
          quarantined: 7,
          recoveryEligible: 0,
        },
      }));
      const view = show();
      await act(async () => {});
      expect(view.getAllByText("Needs attention")).toHaveLength(1);
      expect(latest).toHaveBeenCalledTimes(1);
      expect(getStenographer).toHaveBeenCalledTimes(1);
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(latest).toHaveBeenCalledTimes(1);
      expect(getStenographer).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ["disabled", { enabled: false }],
    ["without a model", { model: { ...memoryFixture().model, available: false } }],
    ["without encryption access", { encryption: { ...memoryFixture().encryption, available: false } }],
  ])("does not poll queued Memory work while %s", async (_label, override) => {
    jest.useFakeTimers();
    try {
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "healthy",
        current: {
          ...stenographerFixture().current,
          caughtUpRooms: 4,
          processingRooms: 0,
          retryingRooms: 0,
        },
      }));
      getMemory.mockImplementation(async () => ({
        ...memoryFixture(),
        ...override,
        current: { ...memoryFixture().current, due: 2, retrying: 1 },
        followUpPending: 1,
      }));
      const view = show();
      await act(async () => {});
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(getMemory).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("keeps polling an in-flight Memory review after automatic admission is disabled", async () => {
    jest.useFakeTimers();
    try {
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "healthy",
        current: {
          ...stenographerFixture().current,
          caughtUpRooms: 4,
          processingRooms: 0,
          retryingRooms: 0,
        },
      }));
      getMemory.mockImplementation(async () => ({
        ...memoryFixture(),
        enabled: false,
        current: { ...memoryFixture().current, due: 2, processing: 1, retrying: 1 },
        followUpPending: 1,
      }));
      const view = show();
      await act(async () => {});
      for (let poll = 0; poll < 5; poll += 1) {
        await act(async () => jest.advanceTimersByTime(10_000));
        await act(async () => {});
      }
      expect(getMemory).toHaveBeenCalledTimes(6);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("rests after three stable polls when Stenographer due work is held", async () => {
    jest.useFakeTimers();
    try {
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "degraded",
        unresolvedProviderOutcomes: 2,
        current: {
          ...stenographerFixture().current,
          caughtUpRooms: 2,
          processingRooms: 0,
          retryingRooms: 0,
          dueRooms: 1,
          rebuildingRooms: 1,
          historicalPendingRooms: 1,
        },
        compaction: { ...stenographerFixture().compaction, awaitingRooms: 1 },
      }));
      const view = show();
      await act(async () => {});
      for (let poll = 0; poll < 3; poll += 1) {
        await act(async () => jest.advanceTimersByTime(10_000));
        await act(async () => {});
      }
      expect(getStenographer).toHaveBeenCalledTimes(4);
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(getStenographer).toHaveBeenCalledTimes(4);
      expect(view.getAllByText("Needs attention")).toHaveLength(1);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("keeps polling healthy Stenographer due work beyond the hold observation limit", async () => {
    jest.useFakeTimers();
    try {
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "delayed",
        unresolvedProviderOutcomes: 0,
        current: {
          ...stenographerFixture().current,
          processingRooms: 0,
          retryingRooms: 0,
          dueRooms: 1,
        },
      }));
      const view = show();
      await act(async () => {});
      for (let poll = 0; poll < 5; poll += 1) {
        await act(async () => jest.advanceTimersByTime(10_000));
        await act(async () => {});
      }
      expect(getStenographer).toHaveBeenCalledTimes(6);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("keeps polling an active worker even when another Stenographer room is held", async () => {
    jest.useFakeTimers();
    try {
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "degraded",
        unresolvedProviderOutcomes: 1,
        current: {
          ...stenographerFixture().current,
          processingRooms: 1,
          retryingRooms: 0,
          dueRooms: 1,
        },
      }));
      const view = show();
      await act(async () => {});
      for (let poll = 0; poll < 5; poll += 1) {
        await act(async () => jest.advanceTimersByTime(10_000));
        await act(async () => {});
      }
      expect(getStenographer).toHaveBeenCalledTimes(6);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("polls scheduler-admitted deferred Reflection work", async () => {
    jest.useFakeTimers();
    try {
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "healthy",
        current: {
          ...stenographerFixture().current,
          caughtUpRooms: 4,
          processingRooms: 0,
          retryingRooms: 0,
        },
      }));
      getReflection.mockImplementation(async () => ({
        ...reflectionFixture(),
        scheduler: {
          ...reflectionFixture().scheduler,
          nextEligiblePollAt: "2026-11-27T10:00:15.000Z",
        },
        current: { ...reflectionFixture().current, backlog: 1, deferred: 1 },
      }));
      const view = show();
      await act(async () => {});
      await act(async () => jest.advanceTimersByTime(10_000));
      await act(async () => {});
      expect(getReflection).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("does not poll paused Reflection counters without another live lane", async () => {
    jest.useFakeTimers();
    try {
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "healthy",
        current: {
          ...stenographerFixture().current,
          caughtUpRooms: 4,
          processingRooms: 0,
          retryingRooms: 0,
        },
      }));
      getReflection.mockImplementation(async () => ({
        ...reflectionFixture(),
        scheduler: {
          ...reflectionFixture().scheduler,
          state: "pressure_paused",
          pauseReason: "repeated_failure",
        },
        current: {
          ...reflectionFixture().current,
          backlog: 4,
          due: 1,
          deferred: 1,
          quarantined: 1,
          recoveryEligible: 1,
        },
        projections: { ...reflectionFixture().projections, pending: 1 },
      }));
      const view = show();
      await act(async () => {});
      expect(view.getByText("Paused")).toBeTruthy();
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(getReflection).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("keeps polling a pending admission even when another lane is unavailable", async () => {
    jest.useFakeTimers();
    try {
      latest.mockResolvedValue({
        run: { ...receipt, reflection: { state: "unavailable" }, memory: null },
      });
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "healthy",
        current: {
          ...stenographerFixture().current,
          caughtUpRooms: 4,
          processingRooms: 0,
          retryingRooms: 0,
        },
      }));
      const view = show();
      await act(async () => {});
      expect(latest).toHaveBeenCalledTimes(1);
      await act(async () => jest.advanceTimersByTime(10_000));
      await act(async () => {});
      await act(async () => jest.advanceTimersByTime(10_000));
      await act(async () => {});
      expect(latest).toHaveBeenCalledTimes(3);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("bounds receipt retries when a previously pending admission becomes stale", async () => {
    jest.useFakeTimers();
    try {
      const unavailable = new Error("receipt temporarily unavailable");
      latest.mockResolvedValueOnce({
        run: { ...receipt, reflection: { state: "unavailable" }, memory: null },
      }).mockRejectedValue(unavailable);
      getStenographer.mockImplementation(async () => ({
        ...stenographerFixture(),
        health: "healthy",
        current: {
          ...stenographerFixture().current,
          caughtUpRooms: 4,
          processingRooms: 0,
          retryingRooms: 0,
        },
      }));
      const view = show();
      await act(async () => {});
      expect(latest).toHaveBeenCalledTimes(1);
      // One pending-admission poll discovers the receipt can no longer be read.
      await act(async () => jest.advanceTimersByTime(10_000));
      await act(async () => {});
      for (let retry = 0; retry < 3; retry += 1) {
        await act(async () => jest.advanceTimersByTime(10_000));
        await act(async () => {});
      }
      expect(latest).toHaveBeenCalledTimes(5);
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(latest).toHaveBeenCalledTimes(5);
      expect(view.getByRole("status").textContent).toContain("Request in progress");
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("retries temporary refresh errors only three times after live status becomes stale", async () => {
    jest.useFakeTimers();
    try {
      const unavailable = new Error("temporarily unavailable");
      latest.mockResolvedValueOnce({ run: null }).mockRejectedValue(unavailable);
      getStenographer.mockImplementationOnce(async () => stenographerFixture())
        .mockRejectedValue(unavailable);
      getReflection.mockImplementationOnce(async () => reflectionFixture())
        .mockRejectedValue(unavailable);
      getMemory.mockImplementationOnce(async () => memoryFixture())
        .mockRejectedValue(unavailable);
      const view = show();
      await act(async () => {});
      expect(latest).toHaveBeenCalledTimes(1);
      // The first poll discovers that the previous active counters are stale.
      await act(async () => jest.advanceTimersByTime(10_000));
      await act(async () => {});
      for (let retry = 0; retry < 3; retry += 1) {
        await act(async () => jest.advanceTimersByTime(10_000));
        await act(async () => {});
      }
      expect(latest).toHaveBeenCalledTimes(5);
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(latest).toHaveBeenCalledTimes(5);
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  test("never clears current unknown outcomes and distinguishes pauses from attention", () => {
    expect(summarizeStenographer({ ...stenographerFixture(), recentFailures: [{ stage: "extraction", errorCode: "provider_outcome_unknown", occurredAt: "2026-11-27T10:00:00.000Z", attemptCount: 1, modelId: "test:model" }] }).state).toBe("needs_attention");
    expect(summarizeMemory({ ...memoryFixture(), current: { ...memoryFixture().current, blocked: 1 }, recentFailures: [{ phase: "model", code: "provider_outcome_unknown", occurredAt: "2026-11-27T10:00:00.000Z", nextRetryAt: null, retryable: false }] }).state).toBe("needs_attention");
    expect(summarizeStenographer({ ...stenographerFixture(), unresolvedProviderOutcomes: 1 }).state).toBe("needs_attention");
    expect(summarizeReflection({ ...reflectionFixture(), unresolvedProviderOutcomes: 1 }).state).toBe("needs_attention");
    expect(summarizeMemory({ ...memoryFixture(), enabled: false }).state).toBe("paused");
    expect(summarizeReflection({ ...reflectionFixture(), scheduler: { ...reflectionFixture().scheduler, state: "pressure_paused", pauseReason: "repeated_failure" } }).state).toBe("paused");
  });

  test("retains the canonical Reflection hold count when its detailed evidence is unavailable", async () => {
    getReflection.mockImplementation(async () => ({ ...reflectionFixture(), unresolvedProviderOutcomes: 3 }));
    const view = show();
    await waitFor(() => expect(view.getByText(/3 Reflection jobs are held pending provider reconciliation/)).toBeTruthy());
    expect(view.getByText("Detailed recovery evidence is unavailable.")).toBeTruthy();
    expect(view.queryByText(/unknown provider outcome/)).toBeNull();
  });

  test("distinguishes settled success with no durable result from an unknown provider outcome", async () => {
    getReflection.mockImplementationOnce(async () => ({
      ...reflectionFixture(),
      unresolvedProviderOutcomes: 3,
      providerSucceededResultMissing: 2,
      resumedFromSavedProposal: 4,
      quarantinedByReason: { invalidSelection: 37, missingAuthority: 4 },
      last24h: { completedWork: 6, syntheticParentsCreated: 0 },
    }));
    const view = show();
    await waitFor(() => expect(view.getByText(/2 jobs have a successful provider call and a missing result/)).toBeTruthy());
    expect(view.getByText(/1 job has an unknown provider outcome/)).toBeTruthy();
    expect(view.getByText(/Automatic retries are on hold/)).toBeTruthy();
    expect(view.getByText(/4 resumed from a saved proposal. Completed in the past 24 hours: 6/)).toBeTruthy();
    expect(view.getByText(/37 with invalid source links · 4 missing current access evidence/)).toBeTruthy();
  });

  test("requires read permission before requesting status", () => {
    capabilities.clear();
    const view = show();
    expect(view.queryByTestId("memory-recovery-card")).toBeNull();
    expect(getMemory).not.toHaveBeenCalled();
  });
});
