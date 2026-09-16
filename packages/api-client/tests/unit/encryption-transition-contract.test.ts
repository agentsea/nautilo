import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NautiloApiClient } from "../../src/client";
import {
  encryptionTransitionStatusSchema,
  encryptionTransitionUpdateRequestSchema,
  ENABLE_FULL_ENCRYPTION_CONFIRMATION,
  type EncryptionTransitionStatus,
} from "../../src/schemas/encryption-transition";

const STATUS: EncryptionTransitionStatus = {
  dtoVersion: 2,
  policy: {
    mode: "shadow_encryption",
    shadowBehavior: "fallback",
    revision: 3,
    shadowEncryptionStartedAt: "2026-08-14T06:00:00.000Z",
    updatedAt: "2026-08-14T06:01:00.000Z",
  },
  coverageReadiness: {
    registered: "122", protected: "35", unsupported: "37", unexercised: "50",
  },
  runtimeHealth: {
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
  },
  observationPressure: {
    retainedRows: "42",
    capacityRows: "10000",
    pendingAdmissions: "7",
    admissionCapacity: "10000",
    maximumRetentionMs: 2_592_000_000,
  },
  domainKeyAuthority: {
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
  },
  liveTurns: {
    scope: "live_new_browser_private_room_turns",
    completeRoundTrip: { verified: "2", eligible: "3", percent: 66.66 },
    pending: { turns: "1", oldestPendingAt: "2026-08-14T06:00:30.000Z" },
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
    ].map((stage) => ({ stage, verified: "2", eligible: "3", percent: 66.66 })) as EncryptionTransitionStatus["liveTurns"]["stages"],
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
  },
  humanPeerLive: {
    scope: "browser_human_only_live_messages",
    writes: {
      published: "2", eligible: "3", pending: "1", fallback: "0", failed: "1",
      percent: 66.66,
    },
    recipientReads: {
      verified: "3", attempted: "4", fallback: "1", percent: 75,
    },
  },
  sharedAgentLive: {
    scope: "browser_multi_human_single_agent_live_messages",
    writes: {
      published: "3", eligible: "4", pending: "1", fallback: "0", failed: "0",
      percent: 75,
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
  },
  historyReads: {
    scope: "browser_room_history_shadow_reads",
    pagesAttempted: "0",
    pagesPending: "0",
    selected: "0",
    verified: "0",
    eligible: "0",
    pending: "0",
    unavailable: "0",
    percent: null,
    outcomes: [],
  },
  metrics: [
    {
      family: "message",
      attemptSuccess: { verified: "8", eligible: "10", percent: 80 },
      touchedCoverage: { verified: "8", total: "9", percent: 88.88 },
      storedCoverage: { verified: "40", total: "100", percent: 40 },
      pendingLifecycle: { operations: "1", oldestPendingAt: "2026-08-14T06:00:30.000Z" },
      attemptOutcomes: [
        {
          operation: "unsupported",
          outcome: "unavailable",
          reason: "unsupported_operation",
          count: "2",
        },
      ],
    },
    {
      family: "memory",
      attemptSuccess: { verified: "1", eligible: "2", percent: 50 },
      touchedCoverage: { verified: "1", total: "2", percent: 50 },
      storedCoverage: { verified: "5", total: "10", percent: 50 },
      pendingLifecycle: { operations: "0", oldestPendingAt: null },
      attemptOutcomes: [],
    },
    {
      family: "artifact",
      attemptSuccess: { verified: "0", eligible: "0", percent: null },
      touchedCoverage: { verified: "0", total: "0", percent: null },
      storedCoverage: { verified: "0", total: "0", percent: null },
      pendingLifecycle: { operations: "0", oldestPendingAt: null },
      attemptOutcomes: [],
    },
    {
      family: "record",
      attemptSuccess: { verified: "0", eligible: "0", percent: null },
      touchedCoverage: { verified: "0", total: "0", percent: null },
      storedCoverage: { verified: "0", total: "0", percent: null },
      pendingLifecycle: { operations: "0", oldestPendingAt: null },
      attemptOutcomes: [],
    },
    {
      family: "overall",
      attemptSuccess: { verified: "9", eligible: "12", percent: 75 },
      touchedCoverage: { verified: "9", total: "11", percent: 81.81 },
      storedCoverage: { verified: "45", total: "110", percent: 40.91 },
      pendingLifecycle: { operations: "1", oldestPendingAt: "2026-08-14T06:00:30.000Z" },
      attemptOutcomes: [],
    },
  ],
};

describe("M274 encryption transition API contract", () => {
  let realFetch: typeof fetch;

  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("keeps attempt success and stored coverage separate", () => {
    expect(encryptionTransitionStatusSchema.parse(STATUS)).toEqual(STATUS);
  });

  test("rejects future modes and confirmation shortcuts", () => {
    expect(encryptionTransitionUpdateRequestSchema.safeParse({
      requestVersion: 2,
      expectedRevision: 3,
      targetMode: "shadow_reads",
      targetShadowBehavior: "fallback",
      confirmation: "yes",
    }).success).toBeFalse();
  });

  test("Full requires its own consequences confirmation, not Shadow consent", () => {
    expect(ENABLE_FULL_ENCRYPTION_CONFIRMATION).toContain(
      "Custom Soul and authored Skills remain ordinary plaintext",
    );
    expect(ENABLE_FULL_ENCRYPTION_CONFIRMATION).toContain(
      "these are the only Full encryption exceptions",
    );
    expect(ENABLE_FULL_ENCRYPTION_CONFIRMATION).not.toContain("are omitted");
    const request = {
      requestVersion: 2,
      expectedRevision: 3,
      targetMode: "encrypted_only",
      targetShadowBehavior: "fallback",
      confirmation: ENABLE_FULL_ENCRYPTION_CONFIRMATION,
    };
    expect(encryptionTransitionUpdateRequestSchema.safeParse(request).success).toBeTrue();
    expect(encryptionTransitionUpdateRequestSchema.safeParse({
      ...request, confirmation: "yes",
    }).success).toBeFalse();
    expect(encryptionTransitionStatusSchema.parse({
      ...STATUS, policy: { ...STATUS.policy, mode: "encrypted_only" },
    }).policy.mode).toBe("encrypted_only");
  });

  test("GET and CAS update use the Admin transition endpoint", async () => {
    const requests: { method: string; body: unknown }[] = [];
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return new Response(JSON.stringify(STATUS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");
    expect(await client.admin.encryptionTransition.get()).toEqual(STATUS);
    expect(await client.admin.encryptionTransition.update({
      requestVersion: 2,
      expectedRevision: 3,
      targetMode: "plaintext_only",
      targetShadowBehavior: "fallback",
      confirmation: "Return to Plaintext only; protected shadows remain stored.",
    })).toEqual(STATUS);
    expect(requests).toEqual([
      { method: "GET", body: null },
      {
        method: "POST",
        body: {
          requestVersion: 2,
          expectedRevision: 3,
          targetMode: "plaintext_only",
          targetShadowBehavior: "fallback",
          confirmation: "Return to Plaintext only; protected shadows remain stored.",
        },
      },
    ]);
  });
});
