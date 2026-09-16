import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  EMPTY_REFLECTION_SEMANTIC_LATENCY,
  type CapabilitySlug,
  type ReflectionAdminStatus,
} from "@nautilo/types";

let capabilities = new Set<CapabilitySlug>();
let load: () => Promise<ReflectionAdminStatus>;
let passiveRecallEnabled = true;
let reflectionSleepEnabled = false;
const saveContext = mock(async (input: {
  readonly passiveRecallEnabled?: boolean;
  readonly reflectionSleepEnabled?: boolean;
}) => {
  passiveRecallEnabled = input.passiveRecallEnabled ?? passiveRecallEnabled;
  reflectionSleepEnabled = input.reflectionSleepEnabled ?? reflectionSleepEnabled;
  return {
    recentConversationLimit: 50,
    minimumFullTurns: 1,
    maxRoomContextPercent: 50,
    stenographerPriorConversationLimit: 10,
    passiveRecallEnabled,
    reflectionSleepEnabled,
  };
});

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (capability: CapabilitySlug) => capabilities.has(capability),
}));
mock.module("../../../lib/api", () => ({
  apiClient: { admin: {
    reflectionStatus: { get: () => load() },
    serverContext: {
      get: async () => ({
        recentConversationLimit: 50,
        minimumFullTurns: 1,
        maxRoomContextPercent: 50,
        stenographerPriorConversationLimit: 10,
        passiveRecallEnabled,
        reflectionSleepEnabled,
      }),
      set: saveContext,
    },
  } },
}));

const { ReflectionHealthCard } = await import("./reflection-health-card");

function fixture(health: ReflectionAdminStatus["health"] = "healthy"): ReflectionAdminStatus {
  return {
    generatedAt: "2026-08-14T12:00:00.000Z",
    window: { since: "2026-08-13T12:00:00.000Z", until: "2026-08-14T12:00:00.000Z" },
    health,
    scheduler: {
      state: "cooldown", pauseReason: null, recoveryIntervalMs: 15_000,
      nextEligiblePollAt: "2026-08-14T12:00:15.000Z",
      lastPoll: {
        elapsedMs: 120, claims: 2, databaseWork: 6, modelCalls: 1,
        modelFailures: 0, authorityElapsedMs: 10, searchProjectionElapsedMs: 20,
        candidateElapsedMs: 30, modelElapsedMs: 50, publicationElapsedMs: 10,
        deterministicNoChanges: 0,
        sameRoomPlans: 1,
        crossRoomPlans: 1,
        sameRoomCompletions: 1,
        crossRoomCompletions: 1,
        candidatesOpened: 3,
        unsupportedAuthorityShapes: 0,
        stalePlans: 0,
        capacityOutcomes: 0,
        noEffectiveAudience: 0,
        protectedExecutionUnavailable: 0,
      },
      window: { polls: 2, admitted: 2, completed: 2, created: 1 },
      backlog: { size: 1, oldestAgeMs: 0 },
      latency: {
        ...EMPTY_REFLECTION_SEMANTIC_LATENCY,
        sameRoom: {
          ...EMPTY_REFLECTION_SEMANTIC_LATENCY.sameRoom,
          endToEnd: { samples: 3, p50Ms: 800, p90Ms: 1_200, maximumMs: 2_000 },
        },
      },
      amplification: "normal",
    },
    current: {
      totalRecords: 8, backlog: 1, due: 0, claimed: 1, checkpointed: 0,
      deferred: 0, complete: 7, quarantined: 0, recoveryEligible: 0,
      maximumRecoveryRound: 0, staleLeases: 0,
      oldestOverdueMs: 0, maximumAttempts: 1, currentParentViolations: 0,
    },
    stages: { authorityProjection: 1, searchProjection: 0, organization: 7 },
    projections: { availableRecords: 8, current: 7, pending: 1, incompatible: 0 },
    last24h: { completedWork: 7, syntheticParentsCreated: 2 },
    lastCompletedAt: "2026-08-14T11:59:00.000Z",
    nextRecoveryAt: null,
    currentFailures: [],
  };
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  capabilities = new Set(["read_server_settings"]);
  load = async () => fixture();
  passiveRecallEnabled = true;
  reflectionSleepEnabled = false;
  saveContext.mockClear();
});

describe("ReflectionHealthCard", () => {
  test("is hidden without settings-read authority", () => {
    capabilities.clear();
    const view = render(<MemoryRouter><ReflectionHealthCard /></MemoryRouter>);
    expect(view.queryByTestId("reflection-health-card")).toBeNull();
  });

  test("shows durable work, projections, completions, and parent creation", async () => {
    const view = render(<MemoryRouter><ReflectionHealthCard /></MemoryRouter>);
    await waitFor(() => expect(view.getByTestId("reflection-health-pill").textContent).toBe("healthy"));
    expect(view.getByText("8")).toBeTruthy();
    expect(view.getByText(/Completed work 7 · synthetic parents 2/u)).toBeTruthy();
    expect(view.getByText(/Current 7 \/ 8 · pending 1 · incompatible 0/u)).toBeTruthy();
    expect(view.getByText("Multiple current parents")).toBeTruthy();
    expect(view.getByTestId("reflection-scheduler-status").textContent)
      .toContain("cooldown");
    expect(view.getByText(/2 polls · 2 admitted · 2 completed · 1 created/u)).toBeTruthy();
    expect(view.getByText(/1 model attempts · 0 provider failures/u)).toBeTruthy();
    expect(view.getByText(/Stages: authority 10 ms · search 20 ms · candidates 30 ms/u))
      .toBeTruthy();
    expect(view.getByText(/3 samples · end-to-end p50 800 ms · p90 1.2 s/u))
      .toBeTruthy();
  });

  test("shows a content-free scheduler pressure pause", async () => {
    load = async () => ({
      ...fixture("degraded"),
      scheduler: {
        ...fixture().scheduler,
        state: "pressure_paused",
        pauseReason: "recursive_amplification",
        amplification: "pressure",
      },
    });
    const view = render(<MemoryRouter><ReflectionHealthCard /></MemoryRouter>);
    await waitFor(() => expect(view.getByTestId("reflection-scheduler-status").textContent)
      .toContain("pressure paused · recursive amplification"));
  });

  test("labels protected PR1 authority without claiming model Reflection", async () => {
    load = async () => ({
      ...fixture(),
      protectedAuthority: {
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
      },
    });
    const view = render(<MemoryRouter><ReflectionHealthCard /></MemoryRouter>);
    const authority = await waitFor(() =>
      view.getByTestId("reflection-protected-authority-status")
    );
    expect(authority.textContent).toContain("Protected authority maintenance");
    expect(authority.textContent).toContain("ordinary fallback is not a protected success");
    expect(authority.textContent).toContain("offline device from unavailable keys");
    expect(authority.textContent).toContain("9,007,199,254,740,993");
    expect(authority.textContent).not.toContain("model result");
  });

  test("renders current typed failures without content", async () => {
    load = async () => ({
      ...fixture("degraded"),
      currentFailures: [{
        stage: "organization", errorCode: "invalid_model_output",
        occurredAt: "2026-08-14T11:58:00.000Z", attemptCount: 3,
      }],
    });
    const view = render(<MemoryRouter><ReflectionHealthCard /></MemoryRouter>);
    await waitFor(() => expect(view.getByTestId("reflection-health-pill").textContent).toBe("degraded"));
    expect(view.getByTestId("reflection-current-failures").textContent)
      .toContain("invalid model output");
  });

  test("disables only passive foreground recall from the Reflection status card", async () => {
    capabilities.add("manage_server_operations");
    const view = render(<MemoryRouter><ReflectionHealthCard /></MemoryRouter>);
    const toggle = await waitFor(() => view.getByTestId("passive-recall-switch"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(saveContext).toHaveBeenCalledWith({
        passiveRecallEnabled: false,
      });
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
    expect(view.getByText(/explicit recall, and background Reflection \/ Sleep continue/u))
      .toBeTruthy();
  });

  test("enables background Sleep independently and explains the default-on rollout", async () => {
    capabilities.add("manage_server_operations");
    const view = render(<MemoryRouter><ReflectionHealthCard /></MemoryRouter>);
    const toggle = await waitFor(() => view.getByTestId("reflection-sleep-switch"));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(saveContext).toHaveBeenCalledWith({ reflectionSleepEnabled: true });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
    expect(view.getByText(/on by default for new servers/u)).toBeTruthy();
    expect(view.getByText(/Existing servers keep their persisted selection/u)).toBeTruthy();
    expect(view.getByText(/preserves the durable backlog/u)).toBeTruthy();
  });
});
