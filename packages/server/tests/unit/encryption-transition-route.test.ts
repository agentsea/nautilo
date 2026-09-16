import { describe, expect, test } from "bun:test";

import {
  EncryptionTransitionPolicyConflictError,
  MaintenanceTransitionError,
  UnsupportedEncryptionTransitionStateError,
  type EncryptionTransitionFamilyDashboard,
  type LiveShadowEncryptionTransitionPolicy,
  type LiveShadowTurnDashboard,
} from "@nautilo/db";
import {
  DISABLE_SHADOW_ENCRYPTION_CONFIRMATION,
  ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
  ENABLE_FULL_ENCRYPTION_CONFIRMATION,
  ENABLE_STRICT_SHADOW_CONFIRMATION,
  USE_FALLBACK_SHADOW_CONFIRMATION,
} from "@nautilo/api-client";
import {
  encryptionTransitionRoutes,
  type EncryptionTransitionRouteDeps,
} from "../../src/routes/encryption-transition";

type Handler = (
  request: {
    sessionUserId?: string;
    body?: unknown;
    ip: string;
    headers: Record<string, string>;
  },
  reply: {
    code(status: number): unknown;
    send(body: unknown): unknown;
  },
) => Promise<unknown>;

function routeHarness(deps: EncryptionTransitionRouteDeps) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) { handlers.set(`GET ${path}`, handler); },
    post(path: string, handler: Handler) { handlers.set(`POST ${path}`, handler); },
  };
  encryptionTransitionRoutes(app as never, {
    maintenanceController: {
      enterDraining: async () => ({ operationId: "full-transition-test" }),
      complete: async () => undefined,
    },
    getExecutableActivity: async () => ({
      runningForegroundJobs: 0,
      runningBackgroundJobs: 0,
      queuedTurns: 0,
      bufferedLanes: 0,
      acceptedWork: 0,
      runningTaskRuns: 0,
      claimedTasks: 0,
    }),
    flushPendingBroadcasts: async () => undefined,
    reconcileObservationAdmissions: async () => 0,
    reconcileHistoryReadAdmissions: async () => 0,
    getLiveTurnDashboard: async () => liveTurns,
    getHumanPeerLiveDashboard: async () => ({
      eligibleWrites: 3n,
      publishedWrites: 2n,
      pendingWrites: 1n,
      fallbackWrites: 0n,
      failedWrites: 0n,
      recipientReadAttempts: 4n,
      recipientReadVerified: 3n,
      recipientReadFallback: 1n,
    }),
    getSharedAgentLiveDashboard: async () => ({
      eligibleWrites: 4n, publishedWrites: 3n, pendingWrites: 1n,
      fallbackWrites: 0n, failedWrites: 0n, recipientReadAttempts: 6n,
      recipientReadVerified: 5n, recipientReadFallback: 1n,
      participantHumanOpportunities: 8n,
      protectedParticipantHumanOpportunities: 6n,
      plaintextParticipantHumanOpportunities: 2n,
      protectedRecipientDeviceOpportunities: 7n,
      planningUnavailable: 3n, planningDeviceUnavailable: 1n,
      planningNamespaceUnavailable: 1n, planningRecipientSyncRequired: 1n,
      agentRecipientReadAttempts: 5n, agentRecipientReadVerified: 4n,
      agentRecipientReadFallback: 1n,
      conductorAwaitingUser: 1n, conductorNotSelected: 1n,
      conductorSelected: 1n, conductorUnavailable: 0n,
      conductorInvocationsEligible: 3n,
      conductorInvocationsAwaitingAuthorization: 0n,
      conductorAuthorizationEstablished: 2n,
      conductorAuthorizationReused: 1n,
      conductorCurrentInputVerified: 3n,
      conductorRouteDeterministic: 2n,
      conductorRouteFloorManager: 1n,
      conductorHistoryNotRequested: 2n,
      conductorHistoryVerified: 1n,
      conductorHistoryUnavailable: 0n,
      conductorVerifiedWake: 2n,
      conductorVerifiedAwaitingUser: 0n,
      conductorVerifiedSilent: 1n,
      conductorFallback: 0n,
      conductorSelectedAgentExecutions: 3n,
      conductorFallbackReasons: [],
      executionsAwaitingAuthorization: 1n, executionsAuthorized: 0n,
      executionsRunning: 0n, executionsCompleted: 0n,
      executionsFallback: 0n, executionsFailed: 0n,
      protectedExecutionInputs: 2n,
      resumeExecutions: 2n, resumesAwaitingAuthorization: 1n,
      resumesAuthorized: 0n, resumesRunning: 0n, resumesCompleted: 1n,
      resumesFallback: 0n, resumesFailed: 0n,
      authorizationEstablished: 1n, authorizationReused: 1n,
      authorizationUnavailable: 0n, authorizationExpired: 0n,
      authorizationRevoked: 0n, streamStarted: 2n, streamCompleted: 2n,
      assistantPublished: 2n, toolResultsPublished: 1n,
    }),
    getDomainKeyCatchUpDashboard: async () => ({
      requested: 9n,
      waiting: 2n,
      delivered: 5n,
      acknowledged: 4n,
      stale: 1n,
      expired: 1n,
      unrecoverable: 0n,
      humanDomainHeads: 3n,
      aiDomainHeads: 3n,
      humanNamespaceBundles: 7n,
      aiNamespaceBundles: 6n,
      humanNamespaceBundleAdvances: 2n,
      aiNamespaceBundleAdvances: 1n,
    }),
    getHistoryReadActivity: async () => ({
      pagesAttempted: 2n,
      pagesPending: 0n,
      selectedRows: 12n,
      eligibleRows: 4n,
      pendingEligibleRows: 0n,
    }),
    getStrictShadowBoundaryHealth: async () => [],
    publishPolicyChanged: () => undefined,
    ...deps,
  });
  return async (
    method: "GET" | "POST",
    request: Parameters<Handler>[0],
    path = "/api/admin/encryption-transition",
  ) => {
    let status = 200;
    let body: unknown;
    const reply = {
      code(next: number) { status = next; return this; },
      send(next: unknown) { body = next; return next; },
    };
    await handlers.get(`${method} ${path}`)!(request, reply);
    return { status, body };
  };
}

const request = { ip: "127.0.0.1", headers: {}, sessionUserId: "user-1" };
const policy: LiveShadowEncryptionTransitionPolicy = {
  mode: "plaintext_only",
  shadowBehavior: "fallback",
  revision: 2,
  shadowEncryptionStartedAt: null,
  updatedAt: new Date("2026-08-14T06:00:00.000Z"),
};
const dashboard: readonly EncryptionTransitionFamilyDashboard[] = [
  {
    family: "message",
    eligibleAttempts: 8n,
    verifiedAttempts: 6n,
    coveredObjects: 4n,
    totalObjects: 10n,
    touchedCoveredObjects: 3n,
    touchedObjects: 4n,
    pendingLifecycleOperations: 1n,
    oldestPendingAt: new Date("2026-08-14T06:00:30.000Z"),
    outcomes: [],
    historyReadOutcomes: [{
      operation: "read",
      outcome: "verified",
      reason: "none",
      count: 3n,
    }, {
      operation: "read",
      outcome: "failed",
      reason: "parity_mismatch",
      count: 1n,
    }],
  },
  {
    family: "memory",
    eligibleAttempts: 0n,
    verifiedAttempts: 0n,
    coveredObjects: 0n,
    totalObjects: 0n,
    touchedCoveredObjects: 0n,
    touchedObjects: 0n,
    pendingLifecycleOperations: 0n,
    oldestPendingAt: null,
    outcomes: [],
    historyReadOutcomes: [],
  },
  {
    family: "artifact",
    eligibleAttempts: 0n,
    verifiedAttempts: 0n,
    coveredObjects: 0n,
    totalObjects: 0n,
    touchedCoveredObjects: 0n,
    touchedObjects: 0n,
    pendingLifecycleOperations: 0n,
    oldestPendingAt: null,
    outcomes: [],
    historyReadOutcomes: [],
  },
  {
    family: "record",
    eligibleAttempts: 0n,
    verifiedAttempts: 0n,
    coveredObjects: 0n,
    totalObjects: 0n,
    touchedCoveredObjects: 0n,
    touchedObjects: 0n,
    pendingLifecycleOperations: 0n,
    oldestPendingAt: null,
    outcomes: [],
    historyReadOutcomes: [],
  },
  {
    family: "overall",
    eligibleAttempts: 8n,
    verifiedAttempts: 6n,
    coveredObjects: 4n,
    totalObjects: 10n,
    touchedCoveredObjects: 3n,
    touchedObjects: 4n,
    pendingLifecycleOperations: 1n,
    oldestPendingAt: new Date("2026-08-14T06:00:30.000Z"),
    outcomes: [],
    historyReadOutcomes: [],
  },
];
const pressure = {
  retainedRows: 42n,
  capacityRows: 10_000n,
  pendingAdmissions: 7n,
  admissionCapacity: 10_000n,
  maximumRetentionMs: 2_592_000_000,
};
const liveTurns: LiveShadowTurnDashboard = {
  eligibleTurns: 3n,
  completeRoundTrips: 2n,
  pendingTurns: 1n,
  oldestPendingAt: new Date("2026-08-14T06:00:30.000Z"),
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
  ].map((stage) => ({ stage, verified: 2n, eligible: 3n })) as
    LiveShadowTurnDashboard["stages"],
  entities: [
    { entity: "human_message", verified: 2n, eligible: 2n },
    { entity: "final_agent_message", verified: 2n, eligible: 2n },
    { entity: "tool_call", verified: 3n, eligible: 3n },
    { entity: "tool_result", verified: 3n, eligible: 3n },
  ],
  fallbacks: [{
    stage: "plan",
    reason: "namespace_unavailable",
    count: 1n,
  }],
};

describe("M274 Admin encryption transition route", () => {
  test("exposes only content-free policy and readiness to every signed-in Human", async () => {
    const call = routeHarness({
      getCapabilities: async () => [],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
    });
    const result = await call(
      "GET",
      request,
      "/api/encryption-transition/policy",
    );
    expect(result).toMatchObject({
      status: 200,
      body: {
        responseVersion: 1,
        policy: {
          mode: "plaintext_only",
          shadowBehavior: "fallback",
          revision: 2,
        },
        canManage: false,
      },
    });
    const policyBody = result.body as {
      coveragePreview?: Record<string, unknown>;
    };
    expect(typeof policyBody.coveragePreview?.["protected"]).toBe("string");
    expect(typeof policyBody.coveragePreview?.["unsupported"]).toBe("string");
    expect(typeof policyBody.coveragePreview?.["unexercised"]).toBe("string");
    const signedOut = await call(
      "GET",
      { ip: "127.0.0.1", headers: {} },
      "/api/encryption-transition/policy",
    );
    expect(signedOut).toEqual({
      status: 401,
      body: { error: "Authentication required" },
    });
  });

  test("reconciles expired admissions before dashboard totals and pressure", async () => {
    const shadowPolicy: LiveShadowEncryptionTransitionPolicy = {
      ...policy,
      mode: "shadow_encryption",
      revision: 3,
      shadowEncryptionStartedAt: new Date("2026-08-14T06:00:00.000Z"),
    };
    const calls: string[] = [];
    const call = routeHarness({
      getCapabilities: async () => ["read_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => shadowPolicy,
      reconcileObservationAdmissions: async () => {
        calls.push("reconcile-observation");
        return 1;
      },
      reconcileHistoryReadAdmissions: async () => {
        calls.push("reconcile-history");
        return 1;
      },
      getDashboard: async () => {
        calls.push("dashboard");
        return dashboard;
      },
      getObservationPressure: async () => {
        calls.push("pressure");
        return { ...pressure, pendingAdmissions: 0n };
      },
      now: () => new Date("2026-08-14T06:30:00.000Z"),
    });
    const result = await call("GET", request);
    expect(result.status).toBe(200);
    expect(calls.slice(0, 2)).toEqual([
      "reconcile-observation",
      "reconcile-history",
    ]);
    expect(new Set(calls.slice(2))).toEqual(new Set([
      "dashboard",
      "pressure",
    ]));
    expect(result.body).toMatchObject({ observationPressure: {
      pendingAdmissions: "0",
    } });
  });

  test("requires read/manage capabilities and exposes separate metrics", async () => {
    const denied = routeHarness({ getCapabilities: async () => [] });
    expect(await denied("GET", request)).toEqual({
      status: 403,
      body: { error: "admin only" },
    });
    const call = routeHarness({
      getCapabilities: async () => ["read_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      getDashboard: async () => dashboard,
      getObservationPressure: async () => pressure,
    });
    const result = await call("GET", request);
    expect(result.status).toBe(200);
    const body = result.body as {
      dtoVersion: number;
      policy: { mode: string; revision: number };
      metrics: unknown[];
    };
    expect(body.dtoVersion).toBe(2);
    expect(body.policy).toMatchObject({ mode: "plaintext_only", revision: 2 });
    expect(body).toMatchObject({
      observationPressure: {
        retainedRows: "42",
        capacityRows: "10000",
        pendingAdmissions: "7",
        admissionCapacity: "10000",
        maximumRetentionMs: 2_592_000_000,
      },
      liveTurns: {
        scope: "live_new_browser_private_room_turns",
        completeRoundTrip: { verified: "2", eligible: "3", percent: 66.66 },
      },
      domainKeyAuthority: {
        scope: "domain_key_v2",
        catchUp: {
          requested: "9",
          waiting: "2",
          delivered: "5",
          acknowledged: "4",
          stale: "1",
          expired: "1",
          unrecoverable: "0",
        },
        authority: {
          humanDomainHeads: "3",
          aiDomainHeads: "3",
          humanNamespaceBundles: "7",
          aiNamespaceBundles: "6",
          humanNamespaceBundleAdvances: "2",
          aiNamespaceBundleAdvances: "1",
        },
      },
      historyReads: {
        scope: "browser_room_history_shadow_reads",
        verified: "3",
        eligible: "4",
        unavailable: "1",
        percent: 75,
        outcomes: [
          { operation: "read", outcome: "verified", count: "3" },
          { operation: "read", outcome: "failed", count: "1" },
        ],
      },
    });
    expect(body.metrics[0]).toMatchObject({
      family: "message",
      attemptSuccess: { verified: "6", eligible: "8", percent: 75 },
      touchedCoverage: { verified: "3", total: "4", percent: 75 },
      storedCoverage: { verified: "4", total: "10", percent: 40 },
      pendingLifecycle: {
        operations: "1",
        oldestPendingAt: "2026-08-14T06:00:30.000Z",
      },
    });
  });

  test("uses exact CAS and audits a successful explicit transition", async () => {
    const inputs: unknown[] = [];
    const events: Record<string, unknown>[] = [];
    const publishedRevisions: number[] = [];
    const next = {
      mode: "shadow_encryption" as const,
      shadowBehavior: "fallback" as const,
      revision: 3,
      shadowEncryptionStartedAt: new Date("2026-08-14T06:05:00.000Z"),
      updatedAt: new Date("2026-08-14T06:05:00.000Z"),
    };
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      casPolicy: async (_db, input) => { inputs.push(input); return next; },
      getDashboard: async () => dashboard,
      getObservationPressure: async () => pressure,
      auditEvent: (_request, event) => { events.push(event); },
      publishPolicyChanged: (revision) => { publishedRevisions.push(revision); },
      now: () => new Date("2026-08-14T06:05:00.000Z"),
    });
    expect(await call("POST", {
      ...request,
      body: {
        requestVersion: 2,
        expectedRevision: 2,
        targetMode: "shadow_encryption",
        targetShadowBehavior: "fallback",
        confirmation: ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
      },
    })).toMatchObject({ status: 200, body: { policy: { revision: 3 } } });
    expect(inputs).toEqual([{
      expectedRevision: 2,
      targetMode: "shadow_encryption",
      targetShadowBehavior: "fallback",
      now: new Date("2026-08-14T06:05:00.000Z"),
    }]);
    expect(events).toEqual([{
      kind: "encryption_transition_policy_change_requested",
      actorId: "user-1",
      before: {
        mode: "plaintext_only",
        shadowBehavior: "fallback",
        revision: 2,
      },
      requested: {
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        expectedRevision: 2,
      },
    }]);
    expect(publishedRevisions).toEqual([3]);
  });

  test("publishes a committed revision before later dashboard assembly fails", async () => {
    const calls: string[] = [];
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      casPolicy: async () => {
        calls.push("cas");
        return { ...policy, mode: "shadow_encryption", revision: 3 };
      },
      publishPolicyChanged: (revision) => { calls.push(`publish-${revision}`); },
      getDashboard: async () => {
        calls.push("dashboard");
        throw new Error("dashboard unavailable");
      },
      auditEvent: () => undefined,
    });

    expect(call("POST", { ...request, body: {
      requestVersion: 2,
      expectedRevision: 2,
      targetMode: "shadow_encryption",
      targetShadowBehavior: "fallback",
      confirmation: ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
    } })).rejects.toThrow("dashboard unavailable");
    expect(calls).toEqual(["cas", "publish-3", "dashboard"]);
  });

  test("keeps the committed HTTP result when best-effort notification fails", async () => {
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      casPolicy: async () => ({
        ...policy,
        mode: "shadow_encryption",
        revision: 3,
      }),
      publishPolicyChanged: () => { throw new Error("websocket unavailable"); },
      getDashboard: async () => dashboard,
      getObservationPressure: async () => pressure,
      auditEvent: () => undefined,
    });

    expect(await call("POST", { ...request, body: {
      requestVersion: 2,
      expectedRevision: 2,
      targetMode: "shadow_encryption",
      targetShadowBehavior: "fallback",
      confirmation: ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
    } })).toMatchObject({
      status: 200,
      body: { policy: { revision: 3 } },
    });
  });

  test("Full transition uses explicit consent and the existing audited CAS owner", async () => {
    const inputs: unknown[] = [];
    const events: unknown[] = [];
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      casPolicy: async (_db, input) => {
        inputs.push(input);
        return { ...policy, mode: "encrypted_only", revision: 3 };
      },
      getDashboard: async () => dashboard,
      getObservationPressure: async () => pressure,
      auditEvent: (_request, event) => { events.push(event); },
    });
    const body = {
      requestVersion: 2, expectedRevision: 2,
      targetMode: "encrypted_only", targetShadowBehavior: "fallback",
      confirmation: ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
    };
    expect(await call("POST", { ...request, body })).toMatchObject({ status: 422 });
    expect(inputs).toHaveLength(0);
    expect(await call("POST", { ...request, body: {
      ...body, confirmation: ENABLE_FULL_ENCRYPTION_CONFIRMATION,
    } })).toMatchObject({ status: 200, body: { policy: { mode: "encrypted_only", revision: 3 } } });
    expect(inputs).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("Full entry rejects every busy work class without cancelling and releases the drain", async () => {
    const fields = [
      "runningForegroundJobs", "runningBackgroundJobs", "queuedTurns",
      "bufferedLanes", "acceptedWork", "runningTaskRuns", "claimedTasks",
    ] as const;
    for (const field of fields) {
      let completed = 0;
      let casCalls = 0;
      const activity = {
        runningForegroundJobs: 0, runningBackgroundJobs: 0, queuedTurns: 0,
        bufferedLanes: 0, acceptedWork: 0, runningTaskRuns: 0, claimedTasks: 0,
        [field]: 1,
      };
      const call = routeHarness({
        getCapabilities: async () => ["manage_server_settings"],
        getDb: () => ({}) as never,
        getPolicy: async () => policy,
        maintenanceController: {
          enterDraining: async () => ({ operationId: `drain-${field}` }),
          complete: async () => { completed += 1; },
        },
        getExecutableActivity: async () => activity,
        flushPendingBroadcasts: async () => {
          throw new Error("busy transitions must not flush or cancel work");
        },
        casPolicy: async () => { casCalls += 1; return policy; },
        auditEvent: () => undefined,
      });
      expect(await call("POST", { ...request, body: {
        requestVersion: 2, expectedRevision: 2,
        targetMode: "encrypted_only", targetShadowBehavior: "fallback",
        confirmation: ENABLE_FULL_ENCRYPTION_CONFIRMATION,
      } })).toEqual({ status: 409, body: {
        error: "encryption_transition_busy", retryable: true,
      } });
      expect({ completed, casCalls }).toEqual({ completed: 1, casCalls: 0 });
    }
  });

  test("Full entry drains pending broadcasts, rechecks racing work, and releases before CAS success returns", async () => {
    const calls: string[] = [];
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flush = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    let reads = 0;
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      maintenanceController: {
        enterDraining: async () => { calls.push("enter"); return { operationId: "drain-race" }; },
        complete: async () => { calls.push("complete"); },
      },
      getExecutableActivity: async () => {
        calls.push(`activity-${++reads}`);
        return {
          runningForegroundJobs: reads === 2 ? 1 : 0,
          runningBackgroundJobs: 0, queuedTurns: 0, bufferedLanes: 0,
          acceptedWork: 0, runningTaskRuns: 0, claimedTasks: 0,
        };
      },
      flushPendingBroadcasts: async () => {
        calls.push("flush-start");
        markFlushStarted();
        await flush;
        calls.push("flush-end");
      },
      casPolicy: async () => { calls.push("cas"); return { ...policy, mode: "encrypted_only", revision: 3 }; },
      auditEvent: () => undefined,
    });
    const resultPromise = call("POST", { ...request, body: {
      requestVersion: 2, expectedRevision: 2,
      targetMode: "encrypted_only", targetShadowBehavior: "fallback",
      confirmation: ENABLE_FULL_ENCRYPTION_CONFIRMATION,
    } });
    await flushStarted;
    expect(calls).toContain("flush-start");
    expect(calls).not.toContain("cas");
    releaseFlush();
    expect(await resultPromise).toMatchObject({ status: 409 });
    expect(calls).toEqual([
      "enter", "activity-1", "flush-start", "flush-end", "activity-2", "complete",
    ]);
  });

  test("Full acknowledgement waits for a registered protected publication to flush", async () => {
    const calls: string[] = [];
    let releasePublication!: () => void;
    let publicationRegistered!: () => void;
    const pendingPublication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const registered = new Promise<void>((resolve) => {
      publicationRegistered = resolve;
    });
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      maintenanceController: {
        enterDraining: async () => {
          calls.push("enter");
          return { operationId: "drain-protected-publication" };
        },
        complete: async () => { calls.push("complete"); },
      },
      getExecutableActivity: async () => {
        calls.push("activity");
        return {
          runningForegroundJobs: 0, runningBackgroundJobs: 0,
          queuedTurns: 0, bufferedLanes: 0, acceptedWork: 0,
          runningTaskRuns: 0, claimedTasks: 0,
        };
      },
      flushPendingBroadcasts: async () => {
        calls.push("protected-publication-registered");
        publicationRegistered();
        await pendingPublication;
        calls.push("protected-publication-flushed");
      },
      casPolicy: async () => {
        calls.push("cas");
        return { ...policy, mode: "encrypted_only", revision: 3 };
      },
      getDashboard: async () => dashboard,
      getObservationPressure: async () => pressure,
      auditEvent: () => undefined,
    });
    const response = call("POST", { ...request, body: {
      requestVersion: 2, expectedRevision: 2,
      targetMode: "encrypted_only", targetShadowBehavior: "fallback",
      confirmation: ENABLE_FULL_ENCRYPTION_CONFIRMATION,
    } });
    await registered;
    expect(calls).not.toContain("cas");
    releasePublication();
    expect(await response).toMatchObject({
      status: 200,
      body: { policy: { mode: "encrypted_only", revision: 3 } },
    });
    expect(calls).toEqual([
      "enter", "activity", "protected-publication-registered",
      "protected-publication-flushed", "activity", "cas", "complete",
    ]);
  });

  test("Full entry releases its drain when the policy CAS fails", async () => {
    const calls: string[] = [];
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      maintenanceController: {
        enterDraining: async () => ({ operationId: "drain-cas" }),
        complete: async () => { calls.push("complete"); },
      },
      casPolicy: async () => { calls.push("cas"); throw new EncryptionTransitionPolicyConflictError(2, 3); },
      publishPolicyChanged: () => { calls.push("publish"); },
      auditEvent: () => undefined,
    });
    expect(await call("POST", { ...request, body: {
      requestVersion: 2, expectedRevision: 2,
      targetMode: "encrypted_only", targetShadowBehavior: "fallback",
      confirmation: ENABLE_FULL_ENCRYPTION_CONFIRMATION,
    } })).toEqual({ status: 409, body: { error: "stale_revision", currentRevision: 3 } });
    expect(calls).toEqual(["cas", "complete"]);
  });

  test("Full entry reports a competing drain as retryable and fails if its lease cannot release", async () => {
    const body = {
      requestVersion: 2 as const, expectedRevision: 2,
      targetMode: "encrypted_only" as const, targetShadowBehavior: "fallback" as const,
      confirmation: ENABLE_FULL_ENCRYPTION_CONFIRMATION,
    };
    const competing = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      maintenanceController: {
        enterDraining: async () => {
          throw new MaintenanceTransitionError("another drain owns the lease", "in_progress");
        },
        complete: async () => undefined,
      },
    });
    expect(await competing("POST", { ...request, body })).toEqual({
      status: 409,
      body: { error: "encryption_transition_busy", retryable: true },
    });

    let casCalls = 0;
    const releaseFailure = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      maintenanceController: {
        enterDraining: async () => ({ operationId: "drain-release-error" }),
        complete: async () => { throw new Error("lease release unavailable"); },
      },
      casPolicy: async () => {
        casCalls += 1;
        return { ...policy, mode: "encrypted_only", revision: 3 };
      },
      auditEvent: () => undefined,
    });
    expect(releaseFailure("POST", { ...request, body }))
      .rejects.toThrow("lease release unavailable");
    expect(casCalls).toBe(1);
  });

  test("never mutates policy when the mandatory security audit cannot persist", async () => {
    let casCalls = 0;
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      casPolicy: async () => {
        casCalls += 1;
        return policy;
      },
      auditEvent: () => { throw new Error("audit volume unavailable"); },
    });
    expect(call("POST", {
      ...request,
      body: {
        requestVersion: 2,
        expectedRevision: 2,
        targetMode: "shadow_encryption",
        targetShadowBehavior: "fallback",
        confirmation: ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
      },
    })).rejects.toThrow("audit volume unavailable");
    expect(casCalls).toBe(0);
  });

  test("uses distinct exact confirmations for Strict enablement and rollback", async () => {
    let durable = {
      ...policy,
      mode: "shadow_encryption" as const,
      shadowEncryptionStartedAt: new Date("2026-08-14T06:00:00.000Z"),
    };
    const inputs: unknown[] = [];
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => durable,
      casPolicy: async (_db, input) => {
        inputs.push(input);
        durable = {
          ...durable,
          shadowBehavior: input.targetShadowBehavior,
          revision: durable.revision + 1,
          updatedAt: input.now ?? durable.updatedAt,
        };
        return durable;
      },
      getDashboard: async () => dashboard,
      getObservationPressure: async () => pressure,
      auditEvent: () => undefined,
      now: () => new Date("2026-08-14T06:05:00.000Z"),
    });
    expect((await call("POST", {
      ...request,
      body: {
        requestVersion: 2,
        expectedRevision: 2,
        targetMode: "shadow_encryption",
        targetShadowBehavior: "strict",
        confirmation: ENABLE_STRICT_SHADOW_CONFIRMATION,
      },
    })).status).toBe(200);
    expect((await call("POST", {
      ...request,
      body: {
        requestVersion: 2,
        expectedRevision: 3,
        targetMode: "shadow_encryption",
        targetShadowBehavior: "fallback",
        confirmation: USE_FALLBACK_SHADOW_CONFIRMATION,
      },
    })).status).toBe(200);
    expect(inputs).toHaveLength(2);
  });

  test("rejects future modes, bad confirmation, stale CAS, and unsupported durable state", async () => {
    const stale = routeHarness({
      getCapabilities: async () => ["read_server_settings", "manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => policy,
      casPolicy: async () => { throw new EncryptionTransitionPolicyConflictError(2, 3); },
      getDashboard: async () => dashboard,
    });
    expect((await stale("POST", {
      ...request,
      body: {
        requestVersion: 2,
        expectedRevision: 2,
        targetMode: "shadow_reads",
        targetShadowBehavior: "fallback",
        confirmation: "yes",
      },
    })).status).toBe(422);
    expect((await stale("POST", {
      ...request,
      body: {
        requestVersion: 2,
        expectedRevision: 2,
        targetMode: "plaintext_only",
        targetShadowBehavior: "fallback",
        confirmation: ENABLE_SHADOW_ENCRYPTION_CONFIRMATION,
      },
    })).status).toBe(422);
    expect(await stale("POST", {
      ...request,
      body: {
        requestVersion: 2,
        expectedRevision: 2,
        targetMode: "plaintext_only",
        targetShadowBehavior: "fallback",
        confirmation: DISABLE_SHADOW_ENCRYPTION_CONFIRMATION,
      },
    })).toEqual({
      status: 409,
      body: { error: "stale_revision", currentRevision: 3 },
    });
    const unsupported = routeHarness({
      getCapabilities: async () => ["read_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => {
        throw new UnsupportedEncryptionTransitionStateError("shadow_reads");
      },
    });
    expect(await unsupported("GET", request)).toEqual({
      status: 503,
      body: { error: "encryption_transition_unavailable" },
    });
  });

  test("consumes only authenticated one-shot Shadow observation admissions", async () => {
    const inputs: unknown[] = [];
    const observedAt = new Date("2026-08-14T06:06:00.000Z");
    const token = new Uint8Array(32).fill(0x41);
    const call = routeHarness({
      getDb: () => ({}) as never,
      consumeObservationAdmission: async (_db, input) => {
        inputs.push({ ...input, token: input.token.slice() });
        return { status: "accepted" };
      },
      now: () => observedAt,
    });
    const path = "/api/protected/shadow-attempts/observe";
    const body = {
      requestVersion: 2,
      observationTokenBase64url: Buffer.from(token).toString("base64url"),
      outcome: "unavailable",
      reason: "client_crypto_unavailable",
      latencyMs: 42,
    };
    expect(await call("POST", { ...request, body }, path)).toEqual({
      status: 200,
      body: { status: "accepted" },
    });
    expect(inputs).toEqual([{
      token,
      outcome: "unavailable",
      reason: "client_crypto_unavailable",
      observedAt,
    }]);
    expect((await call("POST", { ip: request.ip, headers: {}, body }, path)).status)
      .toBe(401);
    expect((await call("POST", {
      ...request,
      body: { ...body, outcome: "verified", reason: "none" },
    }, path)).status).toBe(422);

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const canonicalLast = body.observationTokenBase64url.at(-1)!;
    const alternateLast = [...alphabet].find((candidate) =>
      candidate !== canonicalLast
      && Buffer.from(
        body.observationTokenBase64url.slice(0, -1) + candidate,
        "base64url",
      ).equals(Buffer.from(token))
    )!;
    expect(await call("POST", {
      ...request,
      body: {
        ...body,
        observationTokenBase64url:
          body.observationTokenBase64url.slice(0, -1) + alternateLast,
      },
    }, path)).toEqual({
      status: 422,
      body: { error: "invalid_shadow_attempt_observation" },
    });
    expect(inputs).toHaveLength(1);

    const collision = routeHarness({
      getDb: () => ({}) as never,
      consumeObservationAdmission: async () => ({ status: "conflict" }),
    });
    expect(await collision("POST", { ...request, body }, path)).toEqual({
      status: 409,
      body: { error: "observation_admission_conflict" },
    });

    const unavailable = routeHarness({
      getDb: () => ({}) as never,
      consumeObservationAdmission: async () => ({ status: "unavailable" }),
    });
    expect(await unavailable("POST", { ...request, body }, path)).toEqual({
      status: 410,
      body: { error: "observation_admission_unavailable" },
    });

    const ignored = routeHarness({
      getDb: () => ({}) as never,
      consumeObservationAdmission: async () => {
        throw new Error("aggregate projection unavailable");
      },
    });
    expect(await ignored("POST", { ...request, body }, path)).toEqual({
      status: 503,
      body: { error: "observation_projection_unavailable" },
    });
  });
});
