import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import { LatticeCrypto, type DomainForegroundSecretEntry } from "@nautilo/lattice-crypto";
import type { LiveShadowAgentPublishedMessage, LiveShadowAgentTurnSession } from "@nautilo/lattice-bridge/server";
import type { ServerEvent } from "@nautilo/types";
import { protectedTaskSemanticAuthorityRequirementsDigest } from "@nautilo/db";
import { eventBus, type ProtectedTaskWakeExecutionCandidate, type ProtectedTaskWakeExecutionCustody,
  type ProtectedTaskWakeParkRequest } from "@nautilo/runtime";
import { withWakeEvidence } from "../../../lattice-bridge/tests/fixtures/task-wake-foreground-evidence.ts";
import { getCurrentLiveShadowTurnContext,
  getCurrentProtectedTaskWakeForegroundContext } from "../../../runtime/src/conversation/live-shadow-turn-context.ts";
import { createProtectedTaskWakeForegroundPublication,
  type ProtectedTaskWakePublication, type ProtectedTaskWakeForegroundPublicationInput,
  type ProtectedTaskWakeAdditionalProjectionAuthority,
  type ProtectedTaskWakeForegroundContext, type ProtectedTaskWakePublicationLifecycle,
  type ProtectedTaskWakeForegroundPublicationDependencies } from "../../src/routes/protected-task-wake-foreground-publication";

const USER = "60000000-0000-4000-8000-000000000001";
const SESSION_OWNER = "70000000-0000-4000-8000-000000000001";
const AGENT = "80000000-0000-4000-8000-000000000001";
const NS = "90000000-0000-4000-8000-000000000001";
const EXTRA_NS = "90000000-0000-4000-8000-000000000002";
const EXTRA_ROOM = "70000000-0000-4000-8000-000000000002";
const domain = { domainId: "wake-domain", sourceNamespaceId: NS, keyClass: "ai",
  participantCount: 1, participantDigest: new Uint8Array(32).fill(1), domainKeyGeneration: 1,
  authorizationRevision: 2, headDigest: new Uint8Array(32).fill(2), domainKey: new Uint8Array(32).fill(7),
} as DomainForegroundSecretEntry;

async function fixture(
  use: (f: Awaited<ReturnType<typeof make>>) => Promise<void>,
  representation: "protected" | "dual" = "protected",
) {
  const controller = new AbortController();
  try { await withWakeEvidence({ now: Date.now(), signal: controller.signal, domain, namespaceId: NS,
    accessRevision: 3, policyRevision: 7, signerAgentId: AGENT,
    execute: async (wakeEvidence, evidence) => use(await make({ wakeEvidence, evidence, controller,
      representation })),
  }); } catch (error) {
    if (!controller.signal.aborted || !(error instanceof TypeError)
      || error.message !== "Task wake foreground evidence is not active") throw error;
  }
}
async function make({ wakeEvidence, evidence, controller, representation }: {
  wakeEvidence: ProtectedTaskWakePublication["wakeEvidence"];
  evidence: ProtectedTaskWakePublication["evidence"]; controller: AbortController;
  representation: "protected" | "dual";
}) {
  const { namespace, ...result } = evidence.result;
  const publication = { wakeEvidence, evidence, signal: controller.signal,
    assertCurrentClaim: async () => { events.push("claim"); },
    partitions: { resultDomains: [domain], foregroundDomains: [domain],
      foregroundNamespaceRequirements: wakeEvidence.namespaceRequirements },
    plan: { intent: { requesterUserId: USER, requesterHumanId: wakeEvidence.requesterHumanId,
      agentId: AGENT, contentNamespaceId: namespace.namespaceId, representation,
      expectedPolicyRevision: 7, acceptedPolicyRevision: 6, initialState: "wake_queued",
      result, invocation: wakeEvidence.invocation } },
    record: { workKind: "task.delivery_wake", purpose: "task.delivery_wake",
      snapshot: { state: "running", requestId: wakeEvidence.requestId, workId: wakeEvidence.workId,
        claimId: wakeEvidence.claimId } },
  } as unknown as ProtectedTaskWakePublication;
  const scheduling = { taskId: result.taskId, taskRunId: result.taskRunId, jobId: wakeEvidence.workId,
    ownerId: USER, requestorId: USER, sessionOwnerId: SESSION_OWNER, agentId: AGENT,
    roomId: wakeEvidence.sourceRoomId, namespaceId: NS, sessionId: wakeEvidence.episodeId,
    graphThreadId: "wake-thread", laneKey: `room:${wakeEvidence.sourceRoomId}`, jobState: "queued" as const,
    reference: wakeEvidence.invocation.reference };
  const context = { actorRole: "member", roomRoster: [
    { kind: "user", userId: USER, actorId: wakeEvidence.requesterHumanId }, { kind: "agent", agentId: AGENT }],
    memoryAccessEnvelope: { ownerId: USER, actorId: wakeEvidence.requesterHumanId, agentId: AGENT,
      roomId: wakeEvidence.sourceRoomId, memoryMode: "namespace", readableNamespaces: [NS],
      mutableNamespaces: [NS], writableNamespaces: [NS], toolPolicy: {} },
    subthread: null, fundingSession: null, resultMessagePublished: false,
    checkpointBinding: { retainedSourceNamespaceIds: [NS], sourceEnvelopeDigest: new Uint8Array(32).fill(7),
      initialPolicyRevision: 7,
      initialAgentAuthorizationRevision: 7 },
    enforcementPolicy: { mode: representation === "protected" ? "encrypted_only" : "shadow_encryption",
      shadowBehavior: representation === "protected" ? "strict" : "fallback", revision: 7 },
    dataOperationPolicy: { resolve: async () => { throw new Error("unexpected policy call"); },
      revalidate: async () => undefined },
  } as unknown as ProtectedTaskWakeForegroundContext;
  const events: string[] = [];
  let candidate: ProtectedTaskWakeExecutionCandidate | undefined;
  let deny = false;
  let stale = false;
  let failed = false;
  let failAfterTurn = false;
  let captureProjection = false;
  let sessionPublishMessage: LiveShadowAgentTurnSession["publishMessage"] =
    async () => { throw new Error("unexpected session publication"); };
  const diagnostics: string[] = [];
  let captureMutation: ((capture: ProtectedTaskWakeAdditionalProjectionAuthority) =>
    ProtectedTaskWakeAdditionalProjectionAuthority) | undefined;
  let parkCalls = 0;
  const requirements = Object.freeze([
    Object.freeze({ namespaceId: NS, operations: ["decrypt"] as const }),
    Object.freeze({ namespaceId: EXTRA_NS, operations: ["encrypt"] as const }),
  ]);
  const capture = (): ProtectedTaskWakeAdditionalProjectionAuthority => {
    const value = Object.freeze({
      plan: Object.freeze({ planVersion: 1 as const, kind: "additional_authority_v1" as const,
        operationId: "projection:operation", authorizationRequestId: "projection:authorization",
        effectDisposition: "not_started_v1" as const, requestDigest: new Uint8Array(32).fill(8),
        semanticAuthorityRequirements: requirements }),
      destination: Object.freeze({ destinationRoomId: EXTRA_ROOM, namespaceId: EXTRA_NS,
        destinationAuthorityDigest: new Uint8Array(32).fill(9) }),
      sourceEnvelopeDigest: Uint8Array.from(context.checkpointBinding.sourceEnvelopeDigest),
      checkpointBinding: context.checkpointBinding,
    });
    return captureMutation?.(value) ?? value;
  };
  const lifecycle: ProtectedTaskWakePublicationLifecycle = { scheduling,
    assertCurrent: async () => { events.push("current"); if (deny) throw new Error("authority denied"); },
    loadCurrentResult: async () => null,
    start: async jobId => { expect(jobId).toBe(scheduling.jobId); events.push("start");
      return { status: stale ? "stale" : "started" }; },
    settle: async (jobId, requested) => { expect(jobId).toBe(scheduling.jobId); events.push(`settle:${requested}`);
      return failed ? { kind: "rejected" } : { kind: "transitioned", status: requested }; },
    withCurrentWriter: async () => { throw new Error("test session has no durable sinks"); },
    withProjectionDestination: async () => null,
    park: async () => {
      parkCalls += 1;
      return { status: "parked", receipt: Object.freeze({}) as never };
    },
  };
  const input: ProtectedTaskWakeForegroundPublicationInput = { crypto: new LatticeCrypto(),
    restricted: {} as never, serverScope: "wake-test", executor: async function* () {},
    onDiagnostic: (stage, error) => diagnostics.push(
      `${stage}:${error instanceof Error ? error.message : String(error)}`,
    ),
    owner: { runMutation: async operation => {
      events.push("policy");
      if (deny) throw new Error("Plain policy unavailable");
      return representation === "protected"
        ? operation.protected!({ revalidationToken: 7 })
        : operation.dual!({ revalidationToken: 7 });
    } } as ProtectedTaskWakeForegroundPublicationInput["owner"],
    createLifecycle: async () => { events.push("lifecycle"); return lifecycle; },
    withForegroundContext: async operation => { events.push("context"); return operation.use(context); },
    createProtectedServices: async () => { throw new Error("unexpected production services"); },
    jobManager: { adoptProtectedTaskWakeJob: async operation => {
      expect(operation.scheduling).toEqual(scheduling); expect(operation.reference).toEqual(wakeEvidence.invocation.reference);
      candidate = operation.candidate; events.push("adopt");
      return { status: "adopted", jobId: scheduling.jobId };
    } },
  };
  const deps: ProtectedTaskWakeForegroundPublicationDependencies = {
    withSession: async (operation, invoke) => {
      events.push("session"); await operation.assertCurrent();
      if (captureProjection) operation.onAdditionalProjectionAuthority?.(capture());
      const { enforcementPolicy: _policy, dataOperationPolicy: _binding, ...facts } = context;
      try {
        const value = await invoke({ authorizationDeadlineAt: wakeEvidence.expiresAt,
          authorizationSignal: controller.signal, checkpoint: {},
          publishMessage: request => sessionPublishMessage(request) } as LiveShadowAgentTurnSession,
        { ...facts, evidence: wakeEvidence, scheduling, result: { formatVersion: 1, resultText: "Private result", lastError: null } });
        if (failAfterTurn) throw new Error("post-turn proof changed");
        return value;
      } finally { events.push("session.closed"); }
    },
  };
  const publish = () => createProtectedTaskWakeForegroundPublication(input, deps)(publication);
  const waitForAdoption = async () => { for (let n = 0; n < 20 && candidate === undefined; n++) await Promise.resolve();
    if (candidate === undefined) throw new Error("candidate missing"); return candidate; };
  return { publication, input, deps, publish, events, controller, scheduling, waitForAdoption,
    diagnostics,
    deny: () => { deny = true; }, stale: () => { stale = true; }, failSettlement: () => { failed = true; },
    failAfterTurn: () => { failAfterTurn = true; },
    publishMessage: (publish: LiveShadowAgentTurnSession["publishMessage"]) => {
      sessionPublishMessage = publish;
    },
    captureProjection: (mutate?: typeof captureMutation) => { captureProjection = true; captureMutation = mutate; },
    parkCalls: () => parkCalls,
    parkRequest: (changes: Partial<ProtectedTaskWakeParkRequest> = {}): ProtectedTaskWakeParkRequest => ({
      interruptId: "projection:interrupt", additionalAuthorizationRequestId: "projection:authorization",
      effectDisposition: "not_started_v1", operationId: "projection:operation",
      requestDigest: new Uint8Array(32).fill(8),
      requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(requirements),
      semanticAuthorityRequirements: requirements,
      checkpointBinding: context.checkpointBinding,
      checkpointThreadId: `protected-task-wake:${scheduling.jobId}`,
      checkpoint: { contract: "encrypted_langgraph_v1", expectedCheckpointCount: 1,
        checkpointOrderedDigest: new Uint8Array(32).fill(4), expectedBlobCount: 1,
        blobOrderedDigest: new Uint8Array(32).fill(5), expectedPendingWriteCount: 0,
        pendingWriteOrderedDigest: new Uint8Array(32).fill(6) }, ...changes,
    }),
  };
}

async function dispatch(f: Awaited<ReturnType<typeof make>>,
  effect?: (custody: ProtectedTaskWakeExecutionCustody) => Promise<boolean | void>) {
  const candidate = await f.waitForAdoption();
  try {
    await candidate.run(async (transient, signal, custody) => {
      expect(transient["requestorId"]).toBe(USER);
      expect(transient["ownerId"]).toBe(USER);
      expect(transient["message"]).toBe("");
      expect(transient["taskId"]).toBeUndefined();
      expect(transient["causalHumanUserId"]).toBeUndefined();
      expect(signal).toBe(f.controller.signal);
      const current = getCurrentProtectedTaskWakeForegroundContext();
      expect(current?.scheduling.sessionOwnerId).toBe(SESSION_OWNER);
      expect(current?.result.resultText).toBe("Private result");
      if ((await candidate.start(f.scheduling.jobId)).status !== "started") return;
      f.events.push("model");
      if (await effect?.(custody) === true) return;
      const settled = await candidate.settle(f.scheduling.jobId, "completed");
      if (settled.kind === "rejected") throw new Error("settlement rejected");
    });
  } finally { candidate.onIneligible(); }
}

function committedMessage(
  f: Awaited<ReturnType<typeof make>>,
  changes: Readonly<{
    roomId?: string;
    representationMode?: "shadow_encryption" | "full_encryption";
  }> = {},
): LiveShadowAgentPublishedMessage {
  const roomId = changes.roomId ?? f.scheduling.roomId;
  return {
    representationMode: changes.representationMode ?? "full_encryption",
    reservation: {
      messageId: 42,
      transcriptOrdinal: 2,
      authorRole: "assistant",
    } as LiveShadowAgentPublishedMessage["reservation"],
    policyRevision: 7,
    ordinaryPayloadBytes: new TextEncoder().encode("private reply"),
    openedPayload: { role: "assistant", content: "private reply" },
    protectedMessage: {
      dtoVersion: 2,
      projection: {
        messageId: "42",
        sessionId: f.publication.wakeEvidence.episodeId,
        roomId,
        namespaceId: NS,
        role: "assistant",
        createdAt: "2027-01-15T08:00:00.000Z",
        editRevision: 0,
        authorAgentId: AGENT,
      },
      protectedPayload: {
        status: "encrypted",
        cryptoObjectId: "message:certified-task:42",
        payloadVersion: 2,
        keyClass: "ai",
        encryptedPayloadBytesBase64url: "AQ",
        accessManifestBytesBase64url: "Ag",
        namespaceEnvelopeBytesBase64url: "Aw",
      },
    },
    durableEventDigest: new Uint8Array(32).fill(3),
    streamEvidence: null,
  };
}

test("genuine wake keeps custody through FIFO dispatch, protected ALS and exact completed receipt", () => fixture(async f => {
  let finished = false;
  const pending = f.publish().then(() => { finished = true; });
  await f.waitForAdoption(); expect(finished).toBe(false); expect(f.events).not.toContain("session");
  await dispatch(f); await pending;
  expect(f.events.indexOf("policy")).toBeLessThan(f.events.indexOf("session"));
  expect(f.events.indexOf("start")).toBeLessThan(f.events.indexOf("model"));
  expect(f.events.indexOf("settle:completed")).toBeLessThan(f.events.indexOf("session.closed"));
  expect(getCurrentProtectedTaskWakeForegroundContext()).toBeUndefined();
}));

test("committed wake receipt emits the existing Full durable event without reclassifying notification failure", () => fixture(async f => {
  const receipt = committedMessage(f);
  f.publishMessage(async () => ({ status: "protected", value: receipt }));
  const emitted: ServerEvent[] = [];
  const capture = (event: ServerEvent) => { emitted.push(event); };
  const failNotification = () => { throw new Error("test notification failed"); };
  eventBus.on(capture);
  eventBus.on(failNotification);
  try {
    const pending = f.publish();
    await dispatch(f, async () => {
      const session = getCurrentLiveShadowTurnContext()?.session;
      expect(session?.authorizationSignal).toBe(f.controller.signal);
      const result = await session!.publishMessage({
        payload: { role: "assistant", content: "private reply" },
        stage: "assistant_message",
      });
      expect(result).toEqual({ status: "protected", value: receipt });
    });
    await pending;
  } finally {
    eventBus.off(capture);
    eventBus.off(failNotification);
  }
  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    type: "message.shadow_durable",
    wireVersion: 2,
    laneKey: f.scheduling.laneKey,
    operationId: f.publication.wakeEvidence.invocation.operationId,
    protectedMessage: receipt.protectedMessage,
  });
  expect(emitted[0]).not.toHaveProperty("ordinaryPayloadBytesBase64url");
  expect(f.events).toContain("settle:completed");
}));

test("committed dual wake receipt emits the exact admitted ordinary sibling", () => fixture(async f => {
  const receipt = committedMessage(f, { representationMode: "shadow_encryption" });
  f.publishMessage(async () => ({ status: "protected", value: receipt }));
  const emitted: ServerEvent[] = [];
  const capture = (event: ServerEvent) => { emitted.push(event); };
  eventBus.on(capture);
  try {
    const pending = f.publish();
    await dispatch(f, async () => {
      const session = getCurrentLiveShadowTurnContext()?.session;
      expect(await session!.publishMessage({
        payload: { role: "assistant", content: "private reply" },
        stage: "assistant_message",
      })).toEqual({ status: "protected", value: receipt });
    });
    await pending;
  } finally {
    eventBus.off(capture);
  }
  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    type: "message.shadow_durable",
    wireVersion: 1,
    ordinaryPayloadBytesBase64url: "cHJpdmF0ZSByZXBseQ",
  });
}, "dual"));

for (const scenario of ["fallback", "wrong_room", "wrong_representation"] as const) {
  test(`wake committed notification ${scenario} preserves the session result without broadcasting`, () => fixture(async f => {
    const receipt = committedMessage(f, scenario === "wrong_room"
      ? { roomId: EXTRA_ROOM }
      : scenario === "wrong_representation"
        ? { representationMode: "shadow_encryption" }
        : {});
    const result = scenario === "fallback"
      ? { status: "ordinary_fallback" as const, stage: "assistant_message" as const,
        reason: "protected_unavailable" as const }
      : { status: "protected" as const, value: receipt };
    f.publishMessage(async () => result);
    const emitted: ServerEvent[] = [];
    const capture = (event: ServerEvent) => { emitted.push(event); };
    eventBus.on(capture);
    try {
      const pending = f.publish();
      await dispatch(f, async () => {
        const session = getCurrentLiveShadowTurnContext()?.session;
        expect(await session!.publishMessage({
          payload: { role: "assistant", content: "private reply" },
          stage: "assistant_message",
        })).toEqual(result);
      });
      await pending;
    } finally {
      eventBus.off(capture);
    }
    expect(emitted).toEqual([]);
    expect(f.events).toContain("settle:completed");
    if (scenario === "fallback") expect(f.diagnostics).toEqual([]);
    else expect(f.diagnostics[0]).toStartWith("assistant_message:");
  }));
}

test("queued authorization expiry releases without decryption, model or terminal Job write", () => fixture(async f => {
  const pending = f.publish(); const candidate = await f.waitForAdoption(); f.controller.abort();
  await rejects(pending, /custody ended/);
  await rejects(candidate.run(async () => { throw new Error("must not execute"); }));
  expect(f.events).not.toContain("session"); expect(f.events).not.toContain("start");
  expect(f.events.filter(e => e.startsWith("settle:"))).toEqual([]);
}));

for (const reason of ["stale", "settlement", "post_turn"] as const) test(`${reason} cannot complete the authorization`, () => fixture(async f => {
  if (reason === "stale") f.stale();
  if (reason === "settlement") f.failSettlement();
  if (reason === "post_turn") f.failAfterTurn();
  const pending = f.publish();
  await dispatch(f).catch(() => undefined);
  await rejects(pending, /custody ended/);
  if (reason === "stale") expect(f.events).not.toContain("model");
}));

test("running abort drains callback resources before releasing grant custody", () => fixture(async f => {
  const pending = f.publish(); let closed = false; void pending.catch(() => { closed = true; });
  let drain!: () => void; const drained = new Promise<void>(resolve => { drain = resolve; });
  let entered!: () => void; const modelEntered = new Promise<void>(resolve => { entered = resolve; });
  const running = dispatch(f, async () => { entered(); f.controller.abort(); await drained; });
  await Promise.race([
    modelEntered,
    running.then(() => { throw new Error("dispatch completed before entering the model effect"); }),
  ]);
  await Promise.resolve(); expect(closed).toBe(false);
  drain(); await running.catch(() => undefined); await rejects(pending);
  expect(f.events).toContain("session.closed");
}));

test("trusted additional-authority capture must match the exact park request before product park", () => fixture(async f => {
  f.captureProjection();
  const pending = f.publish();
  await dispatch(f, async custody => {
    expect(await custody.park(f.parkRequest({ operationId: "projection:substituted" })))
      .toEqual({ status: "stale" });
  });
  expect(await pending).toBeUndefined();
  expect(f.parkCalls()).toBe(0);
  expect(f.events).toContain("settle:completed");
}));

test("committed additional-authority park closes custody and returns parked without terminal settlement", () => fixture(async f => {
  f.captureProjection();
  const pending = f.publish();
  await dispatch(f, async custody => {
    expect(await custody.park(f.parkRequest())).toEqual({ status: "parked" });
    return true;
  });
  expect(await pending).toMatchObject({ status: "parked", receipt: {} });
  expect(f.parkCalls()).toBe(1);
  expect(f.events.filter(event => event.startsWith("settle:"))).toEqual([]);
  const candidate = await f.waitForAdoption();
  await rejects(candidate.run(async () => { throw new Error("parked custody reopened"); }));
}));

test("source checkpoint binding substitution is rejected without product park", () => fixture(async f => {
  f.captureProjection();
  const pending = f.publish();
  await dispatch(f, async custody => {
    const request = f.parkRequest();
    expect(await custody.park({ ...request, checkpointBinding: { ...request.checkpointBinding,
      sourceEnvelopeDigest: new Uint8Array(32) } })).toEqual({ status: "stale" });
  });
  await pending;
  expect(f.parkCalls()).toBe(0);
}));

test("abort after committed park releases custody without writing completion", () => fixture(async f => {
  f.captureProjection();
  const pending = f.publish();
  await dispatch(f, async custody => {
    expect(await custody.park(f.parkRequest())).toEqual({ status: "parked" });
    f.controller.abort();
    return true;
  }).catch(() => undefined);
  await rejects(pending, /custody ended/);
  expect(f.controller.signal.aborted).toBe(true);
  expect(f.parkCalls()).toBe(1);
  expect(f.events.filter(event => event.startsWith("settle:"))).toEqual([]);
}));

test("missing or forged wake evidence refuses before policy, queue, or read", () => fixture(async f => {
  for (const wakeEvidence of [undefined, { ...f.publication.wakeEvidence }]) {
    await rejects(createProtectedTaskWakeForegroundPublication(f.input, f.deps)({ ...f.publication, wakeEvidence } as ProtectedTaskWakePublication));
  }
  expect(f.events).toEqual([]);
}));

test("Plain policy refusal precedes all content and queue work", () => fixture(async f => {
  f.deny(); await rejects(f.publish(), /Plain policy/);
  expect(f.events).toEqual(["policy"]);
}));

test("substituted claim, result or invocation is denied before any content access", () => fixture(async f => {
  const { publication } = f;
  const invalid = [
    { ...publication, record: { ...publication.record,
      snapshot: { ...publication.record.snapshot, claimId: "different-claim" } } },
    { ...publication, plan: { ...publication.plan, intent: { ...publication.plan.intent,
      result: { ...publication.plan.intent.result, objectId: "different-result" } } } },
    { ...publication, plan: { ...publication.plan, intent: { ...publication.plan.intent,
      invocation: { ...publication.plan.intent.invocation, sessionId: "different-session" } } } },
  ];
  for (const changed of invalid) await rejects(createProtectedTaskWakeForegroundPublication(f.input, f.deps)(changed));
  expect(f.events).toEqual([]);
}));

test("authority revoked while queued denies dispatch before opening result custody", () => fixture(async f => {
  const pending = f.publish(); await f.waitForAdoption(); f.deny();
  await rejects(dispatch(f), /authority denied/);
  await rejects(pending, /custody ended/);
  expect(f.events).not.toContain("session");
  expect(f.events).not.toContain("model");
  expect(f.events.filter(event => event.startsWith("settle:"))).toEqual([]);
}));
