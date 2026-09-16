import { describe, expect, test } from "bun:test";
import { buildConnectedWebReadTask } from "../../src/connected-web-accounts/read-operation-admission-runtime";
import type { ConnectedWebOperationToolActorContext, ConnectedWebOperationToolInput } from "@nautilo/agent";
import type { ConnectedWebOperation } from "../../src/connected-web-accounts/store";
import {
  createConnectedWebOperationManagementServerRuntime,
  type ConnectedWebOperationManagementRuntimeOptions,
} from "../../src/connected-web-accounts/operation-management-runtime";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-03T12:00:00.000Z");

function operation(input: Partial<ConnectedWebOperation> = {}): ConnectedWebOperation {
  return {
    id: OPERATION_ID,
    ownerUserId: OWNER,
    accountId: ACCOUNT,
    initiatingAgentId: AGENT,
    initiatingRoomId: ROOM,
    initiatingThreadId: "thread-d568",
    initiatingLane: "lane-d568",
    deliveryId: "initial-delivery-d568",
    requestDigest: "a".repeat(64),
    sealedIntent: "sealed-intent-not-visible",
    actionOperationId: null,
    effectIdempotencyKey: null,
    driver: "hosted",
    lifecycle: "running",
    controlEpoch: 7,
    controlLeaseToken: "66666666-6666-4666-8666-666666666666",
    controlLeaseExpiresAt: null,
    sealedProviderRefs: { version: 1, runRef: "sealed-old-run", sessionRef: "sealed-session", workspaceRef: "sealed-workspace" },
    eventCursor: 12,
    safeActivity: { version: 1, phase: "working", code: "provider_running", summary: "Browser agent is working." },
    wakeFingerprint: null,
    nextCheckAt: NOW,
    supervisorClaimOwner: null,
    supervisorClaimExpiresAt: null,
    wakeClaimOwner: null,
    wakeClaimExpiresAt: null,
    wakeAttempts: 0,
    wakeDeliveredAt: null,
    cumulativeCostUsdMicros: 1_000_000,
    remainingBudgetUsdMicros: 4_000_000,
    terminalReceipt: null,
    terminalAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

function actor(input: Partial<ConnectedWebOperationToolActorContext> = {}): ConnectedWebOperationToolActorContext {
  return {
    userId: OWNER,
    agentId: AGENT,
    roomId: ROOM,
    callingRoomId: null,
    memoryAccessEnvelope: { toolPolicy: { read_connected_web_account: "allow" } } as never,
    toolCallId: "management-delivery-d568",
    currentThreadId: "thread-d568",
    turnId: "turn-d568",
    laneKey: "lane-d568",
    ...input,
  };
}

function input(operationName: ConnectedWebOperationToolInput["operation"]): ConnectedWebOperationToolInput {
  const shared = { operationId: OPERATION_ID, expectedControlEpoch: 7 };
  switch (operationName) {
    case "check_later": return { operation: operationName, ...shared, dueAt: "2026-09-03T12:05:00.000Z" };
    case "steer": return { operation: operationName, ...shared, instruction: "Prioritize the requested comparison." };
    default: return { operation: operationName, ...shared };
  }
}

function runtime(
  current = operation(),
  overrides: Partial<ConnectedWebOperationManagementRuntimeOptions> = {},
  task = false,
) {
  const calls: {
    cancel: unknown[];
    poll: unknown[];
    queue: unknown[];
    create: unknown[];
    schedule: unknown[];
    rotate: unknown[];
    claim: unknown[];
    releaseClaim: unknown[];
  } = { cancel: [], poll: [], queue: [], create: [], schedule: [], rotate: [], claim: [], releaseClaim: [] };
  const base: ConnectedWebOperationManagementRuntimeOptions = {
    facts: {
      hasExactOwnedGenie: async () => true,
      isOwnersPersonalPrivateRoom: async () => true,
    },
    store: {
      getOperationForOwner: async () => current,
      scheduleOperationCheck: async (value) => { calls.schedule.push(value); return value.dueAt >= value.now; },
      rotateOperationProviderRunByControl: async (value) => { calls.rotate.push(value); return value.expectedControlEpoch + 1; },
      claimOperationForControl: async (value) => { calls.claim.push(value); return current.controlEpoch + 1; },
      releaseOperationClaim: async (value) => { calls.releaseClaim.push(value); return true; },
    },
    provider: {
      getHostedReadResult: async (runId) => ({ runId, status: "cancelled", totalCostUsd: "0" }),
      cancelHostedReadRun: async (runId) => {
        calls.cancel.push(runId);
        return { runId, status: "cancelled" };
      },
      pollHostedReadRun: async (runId) => {
        calls.poll.push(runId);
        return { runId, status: runId === "run-replacement" ? "running" : "cancelled" };
      },
      inspectHostedSessionQueue: async (sessionId) => {
        calls.queue.push(sessionId);
        return { inspected: true };
      },
      createHostedReadContinuationRun: async (value) => {
        calls.create.push(value);
        return { runId: "run-replacement", sessionId: "session-old", workspaceId: "workspace-replacement", status: "queued" };
      },
    },
    secrets: {
      unsealIntent: () => JSON.stringify({ version: 1, kind: task ? "run_website_task" : current.accountId === null ? "browse_web" : "read_connected_web_account", origin: "https://example.com", request: "Original private website task.", ...(current.accountId === null ? { targetUrl: "https://example.com" } : {}) }),
      unsealProviderReferences: () => ({ runId: "run-old", sessionId: "session-old", workspaceId: "workspace-old" }),
      sealProviderReferences: ({ coordinates }) => ({
        version: 1,
        runRef: `sealed:${coordinates.runId}`,
        sessionRef: `sealed:${coordinates.sessionId}`,
        workspaceRef: `sealed:${coordinates.workspaceId}`,
      }),
    },
    continuationModel: "approved-continuation-model",
    clock: { now: () => NOW },
  };
  return { subject: createConnectedWebOperationManagementServerRuntime({ ...base, ...overrides }), calls };
}

describe("D568 connected website operation management runtime", () => {
  test("task steering retains action scope and requires current task authority", async () => {
    const fixture = runtime(operation(), {}, true);
    const taskActor = actor({ memoryAccessEnvelope: { ownerId: OWNER, agentId: AGENT, roomId: ROOM, toolPolicy: { run_website_task: "allow" } } as never });
    expect(await fixture.subject.manage(taskActor, input("steer"))).toMatchObject({ ok: true, accepted: "steer" });
    const created = fixture.calls.create[0] as { task: string };
    expect(created.task).toContain("You may read and take actions");
    expect(created.task).toContain("check what already happened rather than repeating completed changes");
    expect(created.task).toContain("genuinely dangerous, irreversible, ambiguous");
    expect(created.task).toContain("Original private website task.");
    expect(created.task).not.toContain("Read only the already-connected");
    const denied = runtime(operation(), {}, true);
    expect(await denied.subject.manage(actor(), input("steer"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(denied.calls.create).toHaveLength(0);
    expect(denied.calls.cancel).toHaveLength(0);
  });
  test("steering settles cancelled-run spend before granting the replacement budget", async () => {
    const calls: { create: unknown[] } = { create: [] };
    // The provider must be asked for the cancelled run's terminal accounting.
    const options = { cancelHostedReadRun: async (runId: string) => ({ runId, status: "cancelled" as const }),
      pollHostedReadRun: async (runId: string) => ({ runId, status: runId === "replacement" ? "running" as const : "cancelled" as const }),
      inspectHostedSessionQueue: async () => ({}),
      getHostedReadResult: async (runId: string) => ({ runId, status: "cancelled" as const, totalCostUsd: "1.50" }),
      createHostedReadContinuationRun: async (value: { maxCostUsd: number }) => { calls.create.push(value); return { runId: "replacement", sessionId: "session-old", workspaceId: "workspace-old", status: "running" as const }; },
    };
    const steered = runtime(operation({ cumulativeCostUsdMicros: 0, remainingBudgetUsdMicros: 2_000_000 }), { provider: options });
    expect((await steered.subject.manage(actor(), input("steer"))).ok).toBe(true);
    expect(calls.create).toMatchObject([{ maxCostUsd: 0.5 }]);
    expect(steered.calls.rotate).toMatchObject([{ cumulativeCostUsdMicros: 1_500_000, remainingBudgetUsdMicros: 500_000 }]);
  });

  test("inspect reauthorizes the exact owner/Genie/Room/thread/lane and projects no durable coordinates", async () => {
    const { subject } = runtime();
    const result = await subject.manage(actor(), input("inspect"));
    expect(result).toEqual({
      ok: true,
      accepted: "inspect",
      operation: {
        operationId: OPERATION_ID,
        driver: "hosted",
        lifecycle: "running",
        controlEpoch: 7,
        activity: { phase: "working", code: "provider_running", summary: "Browser agent is working." },
        receipt: null,
        result: null,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/sealed|run-old|session-old|workspace-old|intent|cost|lease|cursor/iu);

    const foreign = await subject.manage(actor({ laneKey: "other-lane" }), input("inspect"));
    expect(foreign).toEqual({ ok: false, code: "forbidden", recovery: "none" });
    const background = await subject.manage(actor({ callingRoomId: "background-room" }), input("inspect"));
    expect(background).toEqual({ ok: false, code: "forbidden", recovery: "none" });
    const stale = await subject.manage(actor(), { ...input("inspect"), expectedControlEpoch: 6 });
    expect(stale).toEqual({ ok: false, code: "conflict", recovery: "none" });
  });

  test("inspect alone returns the exact authorized terminal text snapshot", async () => {
    const { subject } = runtime(operation({
      lifecycle: "terminal",
      terminalAt: NOW,
      terminalReceipt: { version: 1, outcome: "completed", code: "provider_completed", summary: "Connected website work completed." },
      terminalReadResult: {
        version: 1,
        account: { id: ACCOUNT, label: "Example", service: "example", origin: "https://example.com" },
        page: { ref: ACCOUNT, title: "Example", origin: "https://example.com" },
        read: { answer: "The requested answer.", facts: [{ label: "Status", value: "Ready" }], completeness: "complete", provenance: "authenticated_website", origin: "https://example.com" },
        cost: { currency: "USD", amountUsd: 0.01, state: "actual" },
        outputs: [], outputsTruncated: false,
      },
    }));
    const inspected = await subject.manage(actor(), input("inspect"));
    expect(inspected).toMatchObject({ ok: true, accepted: "inspect", operation: { lifecycle: "terminal", result: { status: "completed", read: { answer: "The requested answer." }, outputs: [], outputsTruncated: false } } });
    const stopped = await subject.manage(actor(), input("stop"));
    expect(stopped).toMatchObject({ ok: true, accepted: "stop", operation: { result: null } });
    const foreign = await subject.manage(actor({ agentId: "different-agent" }), input("inspect"));
    expect(foreign).toEqual({ ok: false, code: "forbidden", recovery: "none" });
  });

  test("check_later and continue only schedule existing nonterminal supervision", async () => {
    const { subject, calls } = runtime();
    const checked = await subject.manage(actor(), input("check_later"));
    expect(checked).toMatchObject({ ok: true, accepted: "check_later", operation: { driver: "checking", controlEpoch: 7 } });
    expect(calls.schedule[0]).toMatchObject({
      operationId: OPERATION_ID,
      expectedControlEpoch: 7,
      dueAt: new Date("2026-09-03T12:05:00.000Z"),
    });

    const { subject: continuation, calls: continuationCalls } = runtime();
    const continued = await continuation.manage(actor(), input("continue"));
    expect(continued).toMatchObject({ ok: true, accepted: "continue", operation: { driver: "checking" } });
    expect(continuationCalls.schedule[0]).toMatchObject({ dueAt: NOW });
  });

  test("stop requests idempotent hosted cancellation and schedules reconciliation without terminalizing", async () => {
    const { subject, calls } = runtime();
    const stopped = await subject.manage(actor(), input("stop"));
    expect(stopped).toMatchObject({
      ok: true,
      accepted: "stop",
      operation: { driver: "checking", lifecycle: "running", receipt: null },
    });
    expect(calls.cancel).toEqual(["run-old"]);
    expect(calls.schedule).toHaveLength(1);
    expect(calls.rotate).toHaveLength(0);
  });

  test("does not claim or persist a stop control for a missing provider run", async () => {
    const { subject, calls } = runtime(operation(), {
      provider: {
        cancelHostedReadRun: async () => ({ kind: "failure", code: "resource_not_found" }),
        pollHostedReadRun: async (runId) => ({ runId, status: "cancelled" }),
        inspectHostedSessionQueue: async () => ({ inspected: true }),
        getHostedReadResult: async (runId) => ({ runId, status: "cancelled", totalCostUsd: "0" }),
        createHostedReadContinuationRun: async () => ({ runId: "unused", sessionId: "unused", workspaceId: "unused", status: "queued" }),
      },
    });
    expect(await subject.manage(actor(), input("stop"))).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(calls.schedule).toHaveLength(0);
  });

  test("steer inspects the session, proves old cancellation, observes a same-session replacement, then fences rotation", async () => {
    const { subject, calls } = runtime();
    const result = await subject.manage(actor(), input("steer"));
    expect(result).toMatchObject({
      ok: true,
      accepted: "steer",
      operation: { driver: "hosted", lifecycle: "running", controlEpoch: 9, receipt: null },
    });
    expect(calls.queue).toEqual(["session-old"]);
    expect(calls.cancel).toEqual(["run-old"]);
    expect(calls.poll).toEqual(["run-old", "run-replacement"]);
    expect(calls.create[0]).toEqual({
      sessionId: "session-old",
      workspaceId: "workspace-old",
      task: `${buildConnectedWebReadTask({ origin: "https://example.com", request: { account: ACCOUNT, request: "Original private website task.", delivery: "text" } })}\n\n[Steering instruction]\nPrioritize the requested comparison.`,
      model: "approved-continuation-model",
      maxCostUsd: 4,
    });
    expect(calls.rotate[0]).toMatchObject({
      operationId: OPERATION_ID,
      ownerUserId: OWNER,
      expectedControlEpoch: 8,
      expectedRunRef: "sealed-old-run",
      expectedOpaqueExecutionRef: "run-old", opaqueExecutionRef: "run-replacement",
      cumulativeCostUsdMicros: 1_000_000,
      remainingBudgetUsdMicros: 4_000_000,
    });
    expect(JSON.stringify(result)).not.toMatch(/Original private|run-replacement|session-old|workspace-old|sealed/iu);
  });

  test("never steers or directly controls a possible external effect and cancels a replacement when its fenced CAS loses a race", async () => {
    const protectedOperation = operation({ actionOperationId: "77777777-7777-4777-8777-777777777777" });
    const protectedRun = runtime(protectedOperation);
    expect(await protectedRun.subject.manage(actor(), input("steer"))).toEqual({ ok: false, code: "conflict", recovery: "none" });
    expect(await protectedRun.subject.manage(actor(), input("take_control"))).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(protectedRun.calls.queue).toEqual([]);
    expect(protectedRun.calls.cancel).toEqual([]);

    const raced = runtime(operation(), {
      store: {
        getOperationForOwner: async () => operation(),
        scheduleOperationCheck: async () => true,
        rotateOperationProviderRunByControl: async () => null,
        claimOperationForControl: async () => 8,
        releaseOperationClaim: async () => true,
      },
    });
    expect(await raced.subject.manage(actor(), input("steer"))).toEqual({ ok: false, code: "conflict", recovery: "none" });
    expect(raced.calls.cancel).toEqual(["run-old", "run-replacement"]);
  });

  test("treats a missing old run as uncertainty and cancels every observable unrotated replacement", async () => {
    const missingCreates: string[] = [];
    const missing = runtime(operation(), {
      provider: {
        cancelHostedReadRun: async () => ({ kind: "failure", code: "resource_not_found" }),
        pollHostedReadRun: async () => ({ kind: "failure", code: "resource_not_found" }),
        inspectHostedSessionQueue: async () => ({ inspected: true }),
        getHostedReadResult: async (runId) => ({ runId, status: "cancelled", totalCostUsd: "0" }),
        createHostedReadContinuationRun: async () => {
          missingCreates.push("created");
          return { runId: "must-not-exist", sessionId: "session-old", workspaceId: "workspace", status: "queued" };
        },
      },
    });
    expect(await missing.subject.manage(actor(), input("steer"))).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(missingCreates).toEqual([]);
    expect(missing.calls.schedule).toHaveLength(1);

    const unobservedCancels: string[] = [];
    const unobserved = runtime(operation(), {
      provider: {
        cancelHostedReadRun: async (runId) => {
          unobservedCancels.push(runId);
          return { runId, status: "cancelled" };
        },
        pollHostedReadRun: async (runId) => runId === "run-old"
          ? { runId, status: "cancelled" }
          : { kind: "failure", code: "network_error" },
        inspectHostedSessionQueue: async () => ({ inspected: true }),
        getHostedReadResult: async (runId) => ({ runId, status: "cancelled", totalCostUsd: "0" }),
        createHostedReadContinuationRun: async () => ({ runId: "run-replacement", sessionId: "session-old", workspaceId: "workspace", status: "queued" }),
      },
    });
    expect(await unobserved.subject.manage(actor(), input("steer"))).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(unobservedCancels).toEqual(["run-old", "run-replacement"]);
  });

  test("direct lease controls fail honestly until a separately qualified direct authority exists", async () => {
    const { subject } = runtime();
    expect(await subject.manage(actor(), input("take_control"))).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(await subject.manage(actor(), input("release_control"))).toEqual({ ok: false, code: "unavailable", recovery: "none" });
  });

  test.each(["missing", "throws"])("keeps hosted work and its epoch intact when direct preflight %s", async (mode) => {
    const { subject, calls } = runtime(operation(), { direct: {
      preflight: async () => { if (mode === "throws") throw new Error("missing executable"); return false; },
      takeControl: async () => { throw new Error("must not acquire"); },
      release: async () => null,
    } });
    expect(await subject.manage(actor(), input("take_control"))).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(calls.cancel).toEqual([]);
    expect(calls.claim).toEqual([]);
    expect(calls.rotate).toEqual([]);
    expect(await subject.manage(actor(), input("inspect"))).toMatchObject({ ok: true, operation: { driver: "hosted", controlEpoch: 7 } });
  });

  test("takes control only after exact hosted cancellation and terminal proof, then passes no provider coordinates to direct runtime", async () => {
    const calls: string[] = [];
    const managed = runtime(operation(), {
      direct: {
        preflight: async () => { calls.push("preflight"); return true; },
        takeControl: async (_actor, input) => {
          calls.push(`take:${input.operationId}:${input.expectedControlEpoch}`);
          return {
            operationId: input.operationId, driver: "direct", lifecycle: "running", controlEpoch: 9,
            activity: { phase: "working", code: "direct", summary: "Direct control." }, receipt: null, result: null,
          };
        },
        release: async () => null,
      },
      provider: {
        cancelHostedReadRun: async (runId) => { calls.push(`cancel:${runId}`); return { runId, status: "cancelled" }; },
        pollHostedReadRun: async (runId) => { calls.push(`poll:${runId}`); return { runId, status: "cancelled" }; },
        inspectHostedSessionQueue: async () => ({ inspected: true }),
        getHostedReadResult: async (runId) => ({ runId, status: "cancelled", totalCostUsd: "0" }),
        createHostedReadContinuationRun: async () => ({ kind: "failure", code: "unused" }),
      },
    });
    const { subject } = managed;
    expect(await subject.manage(actor(), input("take_control"))).toMatchObject({ ok: true, accepted: "take_control", operation: { driver: "direct", controlEpoch: 9 } });
    expect(calls).toEqual(["preflight", "cancel:run-old", "poll:run-old", `take:${OPERATION_ID}:8`]);
    expect(managed.calls.claim[0]).toMatchObject({
      operationId: OPERATION_ID,
      ownerUserId: OWNER,
      expectedControlEpoch: 7,
      expectedRunRef: "sealed-old-run",
      leaseMs: 300_000,
    });
    expect(managed.calls.releaseClaim).toEqual([]);
  });

  test("does not take control when terminal proof fails, and release is delegated only for the current direct epoch", async () => {
    const calls: string[] = [];
    const direct = {
      preflight: async () => true,
      takeControl: async () => { calls.push("take"); return null; },
      release: async (_actor: ConnectedWebOperationToolActorContext, control: { operationId: string; expectedControlEpoch: number }) => {
        calls.push(`release:${control.expectedControlEpoch}`);
        return { operationId: control.operationId, driver: "checking" as const, lifecycle: "attention" as const, controlEpoch: 9,
          activity: { phase: "attention" as const, code: "released", summary: "Released." }, receipt: null, result: null };
      },
    };
    const failedRun = runtime(operation(), {
      direct,
      provider: {
        cancelHostedReadRun: async (runId) => ({ runId, status: "cancelled" }),
        pollHostedReadRun: async (runId) => ({ runId, status: "running" }),
        inspectHostedSessionQueue: async () => ({ inspected: true }),
        getHostedReadResult: async (runId) => ({ runId, status: "cancelled", totalCostUsd: "0" }),
        createHostedReadContinuationRun: async () => ({ kind: "failure", code: "unused" }),
      },
    });
    expect(await failedRun.subject.manage(actor(), input("take_control"))).toMatchObject({ ok: false, code: "unavailable" });
    expect(calls).toEqual([]);
    expect(failedRun.calls.releaseClaim[0]).toMatchObject({
      operationId: OPERATION_ID,
      expectedControlEpoch: 8,
      nextCheckAt: NOW,
    });
    const released = runtime(operation({ driver: "direct" }), { direct }).subject;
    expect(await released.manage(actor(), input("release_control"))).toMatchObject({ ok: true, accepted: "release_control", operation: { driver: "checking", controlEpoch: 9 } });
    expect(calls).toEqual(["release:7"]);
  });

  test("direct Stop delegates to the exact live lease and never calls hosted cancellation", async () => {
    const calls: string[] = [];
    const { subject, calls: hostedCalls } = runtime(operation({ driver: "direct" }), {
      direct: {
        preflight: async () => true,
        takeControl: async () => null,
        release: async () => null,
        stopOperation: async (_actor, control) => {
          calls.push(`stop:${control.operationId}:${control.expectedControlEpoch}`);
          return {
            operationId: control.operationId,
            driver: "checking",
            lifecycle: "attention",
            controlEpoch: 8,
            activity: { phase: "attention", code: "direct_browser_control_released", summary: "Connected website control ended." },
            receipt: null,
            result: null,
          };
        },
      },
    });

    expect(await subject.manage(actor(), input("stop"))).toMatchObject({
      ok: true,
      accepted: "stop",
      operation: { driver: "checking", lifecycle: "attention", controlEpoch: 8 },
    });
    expect(calls).toEqual([`stop:${OPERATION_ID}:7`]);
    expect(hostedCalls.cancel).toEqual([]);
    expect(hostedCalls.schedule).toEqual([]);
  });
});

describe("D585 public operation management", () => {
  test("public inspect and stop do not require private website authority", async () => {
    const fixture = runtime(operation({ accountId: null }), { facts: { canResearchPublic: async () => true, hasExactOwnedGenie: async () => false, isOwnersPersonalPrivateRoom: async () => false } });
    expect(await fixture.subject.manage(actor({ callingRoomId: "calling-room" }), { operation: "inspect", operationId: OPERATION_ID, expectedControlEpoch: 7 })).toMatchObject({ ok: true });
    expect(await fixture.subject.manage(actor(), { operation: "stop", operationId: OPERATION_ID, expectedControlEpoch: 7 })).toMatchObject({ ok: true });
    expect(fixture.calls.cancel).toEqual(["run-old"]);
  });
  test("public direct takeover rejects before interrupting useful work", async () => {
    const fixture = runtime(operation({ accountId: null }), { facts: { canResearchPublic: async () => true, hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => true } });
    expect(await fixture.subject.manage(actor(), { operation: "take_control", operationId: OPERATION_ID, expectedControlEpoch: 7 })).toMatchObject({ ok: false, code: "unavailable" });
    expect(fixture.calls.cancel).toHaveLength(0);
    expect(fixture.calls.create).toHaveLength(0);
  });
  test("public tool policy cannot supervise another mode's private account", async () => {
    const fixture = runtime(operation());
    expect(await fixture.subject.manage(actor({ memoryAccessEnvelope: { toolPolicy: { browse_web: "allow", read_connected_web_account: "forbidden" } } as never }), { operation: "inspect", operationId: OPERATION_ID, expectedControlEpoch: 7 })).toMatchObject({ ok: false });
    expect(fixture.calls.cancel).toHaveLength(0);
  });
});

test("immediate supervision remains admissible when wall time advances between calls", async () => {
  let tick = 0;
  const fixture = runtime(operation(), { clock: { now: () => new Date(NOW.getTime() + tick++) } });
  expect(await fixture.subject.manage(actor(), { operation: "continue", operationId: OPERATION_ID, expectedControlEpoch: 7 })).toMatchObject({ ok: true });
});
