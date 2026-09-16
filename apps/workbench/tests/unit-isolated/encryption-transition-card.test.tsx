import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CapabilitySlug,
  StenographerProtectionStatus,
} from "@nautilo/types";
import {
  DISABLE_SHADOW_ENCRYPTION_CONFIRMATION,
  ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
  ENABLE_STRICT_SHADOW_CONFIRMATION,
  ENABLE_FULL_ENCRYPTION_CONFIRMATION,
  USE_FALLBACK_SHADOW_CONFIRMATION,
  encryptionTransitionUpdateRequestSchema,
  type EncryptionTransitionStatus,
} from "@nautilo/api-client/browser";

let capabilities: CapabilitySlug[] = [
  "read_server_settings",
  "manage_server_settings",
];
let current: EncryptionTransitionStatus;
let updateFailure: Error | null = null;
let refreshFailure: Error | null = null;
const get = mock(async () => {
  if (refreshFailure) throw refreshFailure;
  return current;
});
const getProtection = mock(async (): Promise<StenographerProtectionStatus> => ({
  dtoVersion: 1,
  generatedAt: "2026-08-14T06:01:00.000Z",
  window: {
    since: "2026-08-13T06:01:00.000Z",
    until: "2026-08-14T06:01:00.000Z",
  },
  queue: {
    current: {
      awaitingRecipient: "0",
      waitingForDevice: "0",
      grantReady: "0",
      claimed: "0",
      running: "0",
      publicationReconciliation: "0",
      oldestWaitingAt: null,
    },
    last24h: {
      protectedCompleted: "0",
      outputRepairCompleted: "0",
      cancelled: "0",
      terminalFailures: "0",
    },
  },
  authorityWait: {
    extractionRooms: "0",
    compactionRooms: "0",
    oldestAt: null,
  },
  plaintextFallback: {
    missingProtection: {
      extractionBatches: "0",
      compactionRollups: "0",
      oldestAt: null,
    },
    last24h: {
      extraction: { device: "0", authority: "0" },
      compaction: { device: "0", authority: "0" },
    },
  },
}));
function liveTurnMetrics(): EncryptionTransitionStatus["liveTurns"] {
  return {
    scope: "live_new_browser_private_room_turns",
    completeRoundTrip: { verified: "2", eligible: "3", percent: 66.66 },
    pending: {
      turns: "1",
      oldestPendingAt: "2026-08-14T06:00:30.000Z",
    },
    stages: [
      "browser_human_prepare",
      "server_human_open_parity",
      "human_durable_mapping",
      "agent_protected_input",
      "agent_stream_frame_chain",
      "browser_stream_frame_chain",
      "assistant_tool_call_boundary",
      "tool_result_boundary",
      "transcript_durable_mappings",
      "browser_durable_transcript_parity",
      "browser_terminal_acknowledgement",
    ].map((stage) => ({
      stage,
      verified: "2",
      eligible: "3",
      percent: 66.66,
    })) as EncryptionTransitionStatus["liveTurns"]["stages"],
    entities: [
      { entity: "human_message", verified: "2", eligible: "2", percent: 100 },
      { entity: "final_agent_message", verified: "2", eligible: "2", percent: 100 },
      { entity: "tool_call", verified: "3", eligible: "3", percent: 100 },
      { entity: "tool_result", verified: "3", eligible: "3", percent: 100 },
    ],
    fallbacks: [{
      stage: "plan",
      reason: "namespace_unavailable",
      count: "1",
    }, {
      stage: "session_establishment",
      reason: "protected_unavailable",
      count: "2",
    }, {
      stage: "session_reuse",
      reason: "stale_authority",
      count: "3",
    }],
  };
}
const humanPeerLive: EncryptionTransitionStatus["humanPeerLive"] = {
  scope: "browser_human_only_live_messages",
  writes: {
    published: "2", eligible: "3", pending: "1", fallback: "0", failed: "1",
    percent: 66.66,
  },
  recipientReads: {
    verified: "3", attempted: "4", fallback: "1", percent: 75,
  },
};
const domainKeyAuthority: EncryptionTransitionStatus["domainKeyAuthority"] = {
  scope: "domain_key_v2",
  catchUp: {
    requested: "9", waiting: "2", delivered: "5", acknowledged: "4",
    stale: "1", expired: "1", unrecoverable: "0",
  },
  authority: {
    humanDomainHeads: "3", aiDomainHeads: "3",
    humanNamespaceBundles: "7", aiNamespaceBundles: "6",
    humanNamespaceBundleAdvances: "2", aiNamespaceBundleAdvances: "1",
  },
};
const coverageReadiness: EncryptionTransitionStatus["coverageReadiness"] = {
  registered: "122", protected: "35", unsupported: "37", unexercised: "50",
};
const runtimeHealth: EncryptionTransitionStatus["runtimeHealth"] = {
  policyRevision: 3,
  verified: "1", waitingForAuthority: "0", repairing: "0",
  unsupported: "1", failed: "0", unexercised: "120",
  lastObservedAt: "2026-08-14T06:01:00.000Z",
  boundaries: [{
    boundaryId: "conversation.write.foreground",
    family: "message",
    operation: "write",
    actorClass: "human",
    state: "verified",
    reason: "none",
    occurrenceCount: "2",
    lastObservedAt: "2026-08-14T06:01:00.000Z",
  }],
};
const sharedAgentLive: EncryptionTransitionStatus["sharedAgentLive"] = {
  scope: "browser_multi_human_single_agent_live_messages",
  writes: {
    published: "3", eligible: "4", pending: "1", fallback: "0", failed: "0", percent: 75,
  },
  recipientReads: {
    verified: "5", attempted: "6", fallback: "1", percent: 83.33,
  },
  recipientCoverage: {
    totalHumans: "8", protectedHumans: "6", plaintextOnlyHumans: "2",
    protectedDevices: "7",
  },
  planningFallbacks: {
    unavailable: "3", deviceUnavailable: "1", namespaceUnavailable: "1",
    recipientSyncRequired: "1",
  },
  agentRecipientReads: {
    verified: "4", attempted: "5", fallback: "1", percent: 80,
  },
  conductor: {
    awaitingUser: "1", notSelected: "1", selected: "1", unavailable: "0",
    eligible: "3", awaitingAuthorization: "0",
    authorizationEstablished: "2", authorizationReused: "1",
    currentInputVerified: "3", deterministic: "2", floorManager: "1",
    historyNotRequested: "2", historyVerified: "1",
    historyUnavailable: "0", verifiedWake: "2",
    verifiedAwaitingUser: "0", verifiedSilent: "1", fallback: "0",
    selectedAgentExecutions: "3",
    fallbackReasons: [],
  },
  executions: {
    awaitingAuthorization: "1", authorized: "0", running: "0",
    completed: "0", fallback: "0", failed: "0", protectedInputs: "2",
  },
  resumes: {
    attempted: "2", awaitingAuthorization: "1", authorized: "0",
    running: "0", completed: "1", fallback: "0", failed: "0",
  },
  authorization: {
    established: "1", reused: "1", unavailable: "0", expired: "0",
    revoked: "0",
  },
  outputStages: {
    streamStarted: "2", streamCompleted: "2", assistantPublished: "2",
    toolResultsPublished: "1",
  },
};
const update = mock(async (input: {
  requestVersion: 2;
  expectedRevision: number;
  targetMode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  targetShadowBehavior: "fallback" | "strict";
  confirmation: string;
}) => {
  encryptionTransitionUpdateRequestSchema.parse(input);
  if (updateFailure !== null) throw updateFailure;
  current = {
    ...current,
    policy: {
      ...current.policy,
      mode: input.targetMode,
      shadowBehavior: input.targetShadowBehavior,
      revision: input.expectedRevision + 1,
      shadowEncryptionStartedAt: input.targetMode === "shadow_encryption"
        ? "2027-01-01T00:00:00.000Z"
        : null,
    },
    observationPressure: {
      retainedRows: "42",
      capacityRows: "10000",
      pendingAdmissions: "7",
      admissionCapacity: "10000",
      maximumRetentionMs: 2_592_000_000,
    },
    coverageReadiness,
    runtimeHealth,
    domainKeyAuthority,
    liveTurns: liveTurnMetrics(),
    humanPeerLive,
    sharedAgentLive,
    historyReads: {
      scope: "browser_room_history_shadow_reads",
      pagesAttempted: "2",
      pagesPending: "0",
      selected: "12",
      verified: "3",
      eligible: "4",
      pending: "0",
      unavailable: "1",
      percent: 75,
      outcomes: [{
        operation: "read",
        outcome: "verified",
        reason: "none",
        count: "3",
      }, {
        operation: "read",
        outcome: "failed",
        reason: "parity_mismatch",
        count: "1",
      }],
    },
  };
  return current;
});

mock.module("../../src/hooks/use-can", () => ({
  useCan: () => (capability: CapabilitySlug) =>
    capabilities.includes(capability),
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    admin: {
      encryptionTransition: {
        get,
        update,
      },
      stenographerStatus: {
        getProtection,
      },
    },
  },
}));

const { EncryptionTransitionCard } = await import("../../src/pages/admin/sections/encryption-transition-card");

function initialStatus(): EncryptionTransitionStatus {
  const metric = (
    family: "message" | "memory" | "artifact" | "record" | "overall",
  ) => ({
    family,
    attemptSuccess: { verified: "8", eligible: "10", percent: 80 },
    touchedCoverage: { verified: "7", total: "9", percent: 77.77 },
    storedCoverage: { verified: "40", total: "100", percent: 40 },
    pendingLifecycle: family === "artifact"
      ? { operations: "1", oldestPendingAt: "2026-08-14T06:00:30.000Z" }
      : { operations: "0", oldestPendingAt: null },
    attemptOutcomes: family === "artifact" ? [{
      operation: "unsupported" as const,
      outcome: "unavailable" as const,
      reason: "unsupported_operation" as const,
      count: "2",
    }] : [],
  });
  return {
    dtoVersion: 2,
    policy: {
      mode: "plaintext_only",
      shadowBehavior: "fallback",
      revision: 3,
      shadowEncryptionStartedAt: null,
      updatedAt: "2027-01-01T00:00:00.000Z",
    },
    coverageReadiness,
    runtimeHealth,
    observationPressure: {
      retainedRows: "42",
      capacityRows: "10000",
      pendingAdmissions: "7",
      admissionCapacity: "10000",
      maximumRetentionMs: 2_592_000_000,
    },
    domainKeyAuthority,
    liveTurns: liveTurnMetrics(),
    humanPeerLive,
    sharedAgentLive,
    historyReads: {
      scope: "browser_room_history_shadow_reads",
      pagesAttempted: "2",
      pagesPending: "0",
      selected: "12",
      verified: "3",
      eligible: "4",
      pending: "0",
      unavailable: "1",
      percent: 75,
      outcomes: [{
        operation: "read",
        outcome: "verified",
        reason: "none",
        count: "3",
      }, {
        operation: "read",
        outcome: "failed",
        reason: "parity_mismatch",
        count: "1",
      }],
    },
    metrics: [
      metric("message"), metric("memory"), metric("artifact"), metric("record"),
      metric("overall"),
    ],
  };
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  capabilities = ["read_server_settings", "manage_server_settings"];
  current = initialStatus();
  updateFailure = null;
  refreshFailure = null;
  get.mockClear();
  getProtection.mockClear();
  update.mockClear();
});

describe("EncryptionTransitionCard", () => {
  const choices = [
    { name: "No encryption", mode: "plaintext_only", behavior: "fallback" },
    { name: "Fallback Shadow mode", mode: "shadow_encryption", behavior: "fallback" },
    { name: "Strict Shadow mode", mode: "shadow_encryption", behavior: "strict" },
    { name: "Fully Encrypted mode", mode: "encrypted_only", behavior: "fallback" },
  ] as const;

  for (const source of choices) {
    for (const target of choices) {
      test(`${source.name} → ${target.name} uses the existing confirmed policy contract`, async () => {
        current = {
          ...current,
          policy: { ...current.policy, mode: source.mode, shadowBehavior: source.behavior },
        };
        const view = render(<EncryptionTransitionCard />);
        await waitFor(() => expect(view.getByRole<HTMLInputElement>("radio", {
          name: source.name,
        }).checked).toBe(true));
        expect(view.getAllByRole("radio")).toHaveLength(4);
        for (const radio of view.getAllByRole("radio")) {
          const descriptionId = radio.getAttribute("aria-describedby");
          expect(descriptionId).toBeTruthy();
          expect(document.getElementById(descriptionId!)?.textContent?.length).toBeGreaterThan(20);
        }
        expect(get).toHaveBeenCalledTimes(1);
        fireEvent.click(view.getByRole("radio", { name: target.name }));
        expect(update).not.toHaveBeenCalled();
        if (source === target) {
          expect(view.queryByRole("button", { name: "Confirm change" })).toBeNull();
          return;
        }
        const confirmation = target.mode === "plaintext_only"
          ? DISABLE_SHADOW_ENCRYPTION_CONFIRMATION
          : target.mode === "encrypted_only"
          ? ENABLE_FULL_ENCRYPTION_CONFIRMATION
          : target.behavior === "strict"
          ? ENABLE_STRICT_SHADOW_CONFIRMATION
          : source.mode === "shadow_encryption"
          ? USE_FALLBACK_SHADOW_CONFIRMATION
          : ENABLE_SHADOW_ENCRYPTION_CONFIRMATION;
        expect(view.getByText(confirmation)).toBeTruthy();
        if (target.behavior === "strict") {
          expect(view.getByText(/Readiness preview: 35 protected · 37 unsupported · 50 not yet classified/)).toBeTruthy();
        }
        fireEvent.click(view.getByRole("button", { name: "Confirm change" }));
        await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
        expect(update.mock.calls[0]?.[0]).toEqual({
          requestVersion: 2,
          expectedRevision: 3,
          targetMode: target.mode,
          targetShadowBehavior: target.mode === "encrypted_only" ? source.behavior : target.behavior,
          confirmation,
        });
        await waitFor(() => expect(view.queryByRole("button", { name: "Confirm change" })).toBeNull());
        expect(view.getByRole<HTMLInputElement>("radio", { name: target.name }).checked).toBe(true);
      });
    }
  }

  test("cancels a Shadow behavior change without submitting it", async () => {
    current.policy.mode = "shadow_encryption";
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByRole("radio", { name: "Strict Shadow mode" })).toBeTruthy());
    fireEvent.click(view.getByRole("radio", { name: "Strict Shadow mode" }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(update).not.toHaveBeenCalled();
    expect(view.getByRole<HTMLInputElement>("radio", { name: "Fallback Shadow mode" }).checked).toBe(true);
  });

  test("supports keyboard selection without immediately changing the policy", async () => {
    const view = render(<EncryptionTransitionCard />);
    const user = userEvent.setup({ document });
    await waitFor(() => expect(view.getByRole("radio", { name: "No encryption" })).toBeTruthy());
    view.getByRole("radio", { name: "No encryption" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(view.getByRole<HTMLInputElement>("radio", { name: "Fallback Shadow mode" }).checked).toBe(true);
    expect(update).not.toHaveBeenCalled();
    await user.keyboard("{ArrowRight}");
    expect(view.getByRole<HTMLInputElement>("radio", { name: "Strict Shadow mode" }).checked).toBe(true);
    expect(view.getByText(ENABLE_STRICT_SHADOW_CONFIRMATION)).toBeTruthy();
  });

  test("keeps diagnostics collapsed but available without changing policy", async () => {
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByText("Diagnostics Details")).toBeTruthy());
    const summary = view.getByText("Diagnostics Details");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    for (const name of ["Activity and coverage details", "Technical verification details"]) {
      const heading = view.getByText(name);
      expect(heading.tagName).toBe("H4");
      expect(heading.closest("details")).toBe(details);
    }
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(view.getByRole("rowheader", { name: "Browser Human Prepare" })).toBeTruthy();
    expect(view.getByText("Browser Human Prepare")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  test("does not turn absent activity into an encryption health claim", async () => {
    current = {
      ...current,
      runtimeHealth: { ...runtimeHealth, lastObservedAt: null },
      liveTurns: {
        ...current.liveTurns,
        completeRoundTrip: { verified: "0", eligible: "0", percent: null },
        pending: { turns: "0", oldestPendingAt: null },
        fallbacks: [],
      },
    };
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByText(/No eligible attempts yet — no health conclusion/)).toBeTruthy());
    expect(view.getByText(/No boundary activity in this policy revision — no health conclusion/)).toBeTruthy();
  });

  test("shows no mode choices until the first policy load succeeds", async () => {
    refreshFailure = new Error("Network unavailable");
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(view.queryAllByRole("radio")).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    refreshFailure = null;
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(view.getAllByRole("radio")).toHaveLength(4));
  });

  test("reports a stale revision and requires a fresh explicit retry", async () => {
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByRole("radio", { name: "Strict Shadow mode" })).toBeTruthy());
    fireEvent.click(view.getByRole("radio", { name: "Strict Shadow mode" }));
    current = { ...current, policy: { ...current.policy, revision: 4 } };
    updateFailure = new Error("encryption_transition_revision_conflict");
    fireEvent.click(view.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("revision_conflict"));
    expect(update.mock.calls[0]?.[0].expectedRevision).toBe(3);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenCalledTimes(1);
    updateFailure = null;
    fireEvent.click(view.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]?.[0].expectedRevision).toBe(4);
  });

  test("retains visible data when a diagnostic refresh fails and recovers on Retry", async () => {
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByRole("radio", { name: "No encryption" })).toBeTruthy());
    refreshFailure = new Error("Network unavailable");
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Network unavailable"));
    expect(view.getAllByRole("radio")).toHaveLength(4);
    refreshFailure = null;
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  });

  test("labels Full authentication and protected failures without claiming plaintext fallback", async () => {
    current = {
      ...initialStatus(),
      policy: { ...initialStatus().policy, mode: "encrypted_only" },
      humanPeerLive: {
        ...humanPeerLive,
        writes: { published: "0", eligible: "2", pending: "0",
          fallback: "0", failed: "2", percent: 0 },
      },
      sharedAgentLive: {
        ...sharedAgentLive,
        writes: { published: "0", eligible: "2", pending: "0",
          fallback: "0", failed: "2", percent: 0 },
      },
    };
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getAllByText(
      /2 protected failures · 0 ordinary fallbacks/u,
    ).length).toBeGreaterThanOrEqual(2));
    expect(view.getByText(/Human reads 5 \/ 6 authenticated/u)).toBeTruthy();
    expect(view.getByText(/1 tool-result rows/u)).toBeTruthy();
    expect(view.getByText(/12 rows selected/u)).toBeTruthy();
    expect(view.getByText(
      "Recipient coverage 6 / 8 protected · 2 not protected · 7 eligible devices",
    )).toBeTruthy();
    expect(view.queryByText(/2 plaintext-only/u)).toBeNull();
    expect(view.getByText(/terminal authentication all verify/u)).toBeTruthy();
    expect(view.queryByText(/2 plaintext fallbacks/u)).toBeNull();
  });

  test("names a terminal Record deadline without claiming an integrity or key failure", async () => {
    current = { ...current, runtimeHealth: { ...runtimeHealth, boundaries: [{
      ...runtimeHealth.boundaries[0], boundaryId: "conversation.read.foreground_records",
      family: "record", operation: "read", state: "failed", reason: "deadline_expired",
    }] } };
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByText(/Deadline Expired/)).toBeTruthy());
  });

  test("uses panel and inset surfaces rather than page-white diagnostic cards", async () => {
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByRole("radio", { name: "No encryption" })).toBeTruthy());
    expect(view.getByRole("radio", { name: "No encryption" }).closest("label")?.classList.contains("bg-background-panel")).toBe(true);
    expect(view.container.querySelectorAll(".bg-background")).toHaveLength(0);
    expect(view.getByText("Diagnostics Details").closest("details")?.classList.contains("bg-background-panel")).toBe(true);
  });

  test("names unsupported operation types without implying failed messages", async () => {
    current = { ...current, runtimeHealth: { ...runtimeHealth, boundaries: [
      ...runtimeHealth.boundaries,
      ...["artifact.api.workspace", "background.memory.review", "background.reflection.worker",
        "background.stenographer.worker", "background.task.observer", "future.unknown.path"].map((boundaryId) => ({
        ...runtimeHealth.boundaries[0], boundaryId, state: "unsupported" as const,
        reason: "unsupported_operation" as const,
      })),
    ] } };
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByText("Protected-operation checks")).toBeTruthy());
    for (const label of ["Workspace artifacts", "Automatic memory review", "Reflection processing",
      "Stenographer processing", "Task scheduling"]) {
      expect(view.getByText(label)).toBeTruthy();
    }
    expect(view.getAllByText("future.unknown.path").length).toBeGreaterThan(0);
    expect(view.getByText(/Counts operation types, not messages or failed jobs/)).toBeTruthy();
    expect(view.getByText(/Fallback Shadow permits plaintext at these checks/)).toBeTruthy();
    expect(view.queryByText("Strict registered boundaries")).toBeNull();
  });

  test("shows exact live-turn stages and requires an explicit confirmation", async () => {
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByRole("radio", { name: "No encryption" })).toBeTruthy());
    expect(view.getAllByRole("radio")).toHaveLength(4);
    expect(view.getByRole("radio", { name: "Fallback Shadow mode" })).toBeTruthy();
    expect(view.getByRole("radio", { name: "Strict Shadow mode" })).toBeTruthy();
    expect(view.getByRole("radio", { name: "Fully Encrypted mode" })).toBeTruthy();
    expect(view.getByText("New foreground messages")).toBeTruthy();
    expect(view.getByText("Foreground message history")).toBeTruthy();
    expect(view.getByText("V2 Domain key catch-up")).toBeTruthy();
    expect(view.getByText("4 / 9 requested deliveries acknowledged")).toBeTruthy();
    expect(view.getByText(
      "Membership advances: 2 Human + 1 AI bundle heads",
    )).toBeTruthy();
    expect(view.getByText(
      "2 waiting for an online authorized device · 5 delivered · 1 stale · 1 expired · 0 unrecoverable",
    )).toBeTruthy();
    expect(view.getByText("Technical verification details")).toBeTruthy();
    expect(view.getByText("Protected-operation check details")).toBeTruthy();
    expect(view.getByText("conversation.write.foreground")).toBeTruthy();
    expect(view.getByText("3 / 4 eligible protected reads verified (75%)"))
      .toBeTruthy();
    expect(view.getByText(
      "Recipient coverage 6 / 8 protected · 2 plaintext-only · 7 eligible devices",
    )).toBeTruthy();
    expect(view.getByText(
      "Protected planning unavailable 3 · device 1 · Namespace 1 · recipient sync 1",
    )).toBeTruthy();
    expect(view.getByText(
      "2 cumulative page checks · 12 rows selected · 0 eligible reads pending · 1 protected reads unavailable. Reloading a page checks its eligible rows again.",
    )).toBeTruthy();
    expect(view.getByText("Verified: 3, Parity Mismatch: 1")).toBeTruthy();
    expect(view.getByText("Browser Human Prepare")).toBeTruthy();
    expect(view.getAllByText("2 / 3 verified (66.66%)").length)
      .toBeGreaterThan(0);
    expect(view.getAllByText(/1 pending · oldest/u).length).toBeGreaterThan(0);
    expect(view.getByText(
      "Plan · Namespace Unavailable: 1, Session Establishment · Protected Unavailable: 2, Session Reuse · Stale Authority: 3",
    )).toBeTruthy();
    expect(view.queryByText("Whole-corpus coverage")).toBeNull();
    expect(view.getByText(/Auto-refreshes every 10 seconds · Last updated/u))
      .toBeTruthy();

    fireEvent.click(view.getByRole("radio", { name: "Fallback Shadow mode" }));
    expect(view.getByText(
      "Enable Shadow encryption; authorized readers may restore ordinary copies from protected content.",
    )).toBeTruthy();
    expect(update).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toEqual({
      requestVersion: 2,
      expectedRevision: 3,
      targetMode: "shadow_encryption",
      targetShadowBehavior: "fallback",
      confirmation: "Enable Shadow encryption; authorized readers may restore ordinary copies from protected content.",
    });
  });

  test("Full confirms consequences and keeps the four choices available", async () => {
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByRole("radio", { name: "Fully Encrypted mode" })).toBeTruthy());
    fireEvent.click(view.getByRole("radio", { name: "Fully Encrypted mode" }));
    expect(view.getByText(/Enable Full encryption for new supported content/)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 3, targetMode: "encrypted_only",
    });
    await waitFor(() => expect(view.getByText(/Fully Encrypted mode is active/)).toBeTruthy());
    expect(view.getAllByText(/Custom Soul and authored Skills/).length).toBeGreaterThan(0);
    expect(view.queryByText(/temporarily omitted/)).toBeNull();
    expect(view.getAllByRole("radio")).toHaveLength(4);
  });

  test("keeps a failed Full transition visible after refreshing unchanged status", async () => {
    updateFailure = new Error("encryption_transition_busy");
    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByRole("radio", { name: "Fully Encrypted mode" })).toBeTruthy());

    fireEvent.click(view.getByRole("radio", { name: "Fully Encrypted mode" }));
    fireEvent.click(view.getByRole("button", { name: "Confirm change" }));

    await waitFor(() => expect(view.getByRole("alert").textContent).toBe(
      "Encryption mode cannot change while work is active. Try again when current work has finished.",
    ));
    expect(current.policy.mode).toBe("plaintext_only");
    expect(view.getByRole<HTMLInputElement>("radio", { name: "Fully Encrypted mode" }).checked)
      .toBe(true);

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(current.policy.mode).toBe("plaintext_only");

    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole<HTMLInputElement>("radio", { name: "No encryption" }).checked)
      .toBe(true);
  });

  test("is read-only without manage permission and absent without read permission", async () => {
    capabilities = ["read_server_settings"];
    const readOnly = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(readOnly.getByText(/Read-only/)).toBeTruthy());
    const radio = readOnly.getByRole("radio", { name: "Fallback Shadow mode" });
    expect((radio.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    cleanup();

    capabilities = [];
    const absent = render(<EncryptionTransitionCard />);
    expect(absent.container.textContent).toBe("");
  });

  test("distinguishes a checked plaintext-only page from no read attempt", async () => {
    current = {
      ...initialStatus(),
      historyReads: {
        scope: "browser_room_history_shadow_reads",
        pagesAttempted: "1",
        pagesPending: "0",
        selected: "50",
        verified: "0",
        eligible: "0",
        pending: "0",
        unavailable: "0",
        percent: null,
        outcomes: [],
      },
    };

    const view = render(<EncryptionTransitionCard />);
    await waitFor(() => expect(view.getByText(
      "1 page checked · 50 messages loaded · no protected copies found",
    )).toBeTruthy());
    expect(view.queryByText("No Browser history page has been checked yet"))
      .toBeNull();
  });
});
