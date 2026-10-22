import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { protectedTaskRunResultObjectId, protectedTaskRunWakeJobId,
  tasks, taskRuns, jobs, protectedTaskRunOutputBindings, protectedTaskWakeContinuationReceipts,
  withCurrentProtectedTaskWakeContinuation, protectedTaskSemanticAuthorityRequirementsDigest,
  type ProtectedTaskWakeContinuationReceipt, type DirectDatabase, type PostgresJsBridgeConnection } from "@nautilo/db";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import type { TaskOutputNamespaceAuthority } from "@nautilo/lattice-bridge/server";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { attachBackgroundAuthorizationRecipient, InMemoryBackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import { verifyProtectedTaskWakeCheckpointIntegrity } from "../../src/routes/protected-task-wake-checkpoint-integrity";
import { createProtectedTaskOutputReadPlan } from "../../src/routes/protected-task-output-read-plan";
import { createProtectedTaskOutputReadPreparation } from "../../src/routes/protected-task-output-read-preparation";
import type { ProtectedTaskOutputReadAuthorityPort } from "../../src/routes/protected-task-output-read-authority";
import type { ProtectedTaskOutputReadIntent } from "../../src/routes/protected-task-output-read-product";

const NOW = 1_805_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000001";
const USER = "30000000-0000-4000-8000-000000000001";
const HUMAN = "40000000-0000-4000-8000-000000000001";
const PRIVATE = "80000000-0000-4000-8000-000000000001";
const DESTINATION = "90000000-0000-4000-8000-000000000001";
const ROOM = "60000000-0000-4000-8000-000000000001";
const SESSION = "70000000-0000-4000-8000-000000000001";
type Overrides = NonNullable<Parameters<typeof createProtectedTaskOutputReadPreparation>[1]>;
const EXTRA = "a0000000-0000-4000-8000-000000000001";
function fixture(wake = false) {
  let continuation: ProtectedTaskWakeContinuationReceipt | undefined;
  let checkpointTx: Parameters<typeof withCurrentProtectedTaskWakeContinuation>[0] | undefined;
  let mode: "plaintext_only" | "encrypted_only" | "shadow_encryption" = "encrypted_only";
  let policy = 7;
  let at = NOW;
  let denied = false;
  let commitFails = false;
  let notificationFails = false;
  let physicalChanged = false;
  const events: string[] = [];
  const notifications: string[] = [];
  const deleted: Array<readonly [string, number]> = [];
  const repository = new InMemoryBackgroundAuthorizationRepository();
  const intent = (): ProtectedTaskOutputReadIntent => ({ requesterUserId: USER, requesterHumanId: HUMAN,
    agentId: "agent", contentNamespaceId: PRIVATE, representation: "protected",
    expectedPolicyRevision: policy, acceptedPolicyRevision: 7, initialState: wake ? "wake_queued" : "raw_unpublished",
    ...(continuation === undefined ? {} : { continuation }),
    result: { taskId: TASK, taskRunId: RUN, terminalStatus: "completed", contentRevision: 1,
      objectId: protectedTaskRunResultObjectId(TASK, RUN), cryptoAccessRevision: 0,
      genesisManifestHash: new Uint8Array(32).fill(1), signerAgentId: "agent" },
    invocation: wake ? { kind: "wake", bindingId: `task-run-output:${RUN}`, operationId: `task-run-delivery-wake:${RUN}`,
      roomId: ROOM, sessionId: SESSION, jobId: protectedTaskRunWakeJobId(RUN), reference: {
        kind: "protected_task_delivery_v1", taskId: TASK, taskRunId: RUN, bindingId: `task-run-output:${RUN}`,
        resultObjectId: protectedTaskRunResultObjectId(TASK, RUN), wakeOperationId: `task-run-delivery-wake:${RUN}`,
      } } : { kind: "raw", bindingId: `task-run-output:${RUN}`,
      operationId: `task-run-delivery-message:${RUN}`, roomId: ROOM, sessionId: SESSION } });
  const authority = (): TaskOutputNamespaceAuthority => {
    const source = { namespaceId: PRIVATE, domainId: "domain", expectedAccessRevision: 1,
      expectedPolicyRevision: policy, expectedDomainEpoch: 2, expectedAuthorizationRevision: 3 };
    const target = { ...source, namespaceId: DESTINATION };
    const extra = { ...source, namespaceId: EXTRA };
    return { sourceRoomId: ROOM, sourceNamespaceId: PRIVATE, facts: [source, target, ...(continuation === undefined ? [] : [extra])],
      ...(continuation === undefined ? {} : { additionalMutationFact: { destination: {
        roomId: continuation.destinationRoomId, namespaceId: EXTRA,
        semanticDigest: Buffer.from(continuation.requiredAuthorityDigest).toString("hex"),
      }, namespace: extra } }), resultFact: source, foregroundFacts: [target] };
  };
  const port = { withPlanning: async (operation: Parameters<ProtectedTaskOutputReadAuthorityPort["withPlanning"]>[0]) => {
    events.push("held");
    if (denied) return null;
    const value = await operation.use({ namespaceAuthority: authority(),
      occurrence: {} as never }, {} as never, {} as never, {} as never);
    events.push("committed");
    if (commitFails) throw new Error("product commit failed");
    return value;
  } } as ProtectedTaskOutputReadAuthorityPort;
  const owner = { runMutation: async (operation: Parameters<EncryptionDataOperationOwner["runMutation"]>[0]) => {
    const use = mode === "plaintext_only" ? operation.ordinary
      : mode === "encrypted_only" ? operation.protected : operation.dual;
    if (use === undefined) throw new Error("unsupported mode");
    return use({ revalidationToken: "fixture" } as never);
  } } as EncryptionDataOperationOwner;
  const overrides: Overrides = {
    requester: async () => { events.push("requester"); return USER; },
    coordinates: async () => ({ taskId: TASK, taskRunId: RUN, kind: "raw" }),
    readIntent: async (_tx, _coordinates, options) => {
      events.push(options?.ensureDestinationSession === true ? "ensure-session" : "read-session"); return intent();
    },
    productContext: async () => ({ canonicalRunner: { transaction: async (use: (tx: unknown) => Promise<unknown>) => {
      const value = await use({}); events.push("session-committed"); return value;
    } } }) as never,
    repository: async () => repository,
    verifyCheckpoint: receipt => verifyProtectedTaskWakeCheckpointIntegrity(receipt, async ({ logicalThreadId }) => {
      expect(events.at(-1)).toBe("held");
      if (continuation === undefined) throw new Error("Missing continuation");
      expect(logicalThreadId).toBe(continuation.checkpointThreadId);
      return { contract: continuation.checkpointContract,
        expectedCheckpointCount: physicalChanged ? 0 : continuation.expectedCheckpointCount,
        checkpointOrderedDigest: Uint8Array.from(continuation.checkpointOrderedDigest),
        expectedBlobCount: continuation.expectedBlobCount, blobOrderedDigest: Uint8Array.from(continuation.blobOrderedDigest),
        expectedPendingWriteCount: continuation.expectedPendingWriteCount,
        pendingWriteOrderedDigest: Uint8Array.from(continuation.pendingWriteOrderedDigest) };
    }),
    withContinuation: async (_tx, coordinates, use) => {
      expect(events.at(-1)).toBe("held");
      if (checkpointTx === undefined) throw new Error("missing checkpoint fixture");
      return withCurrentProtectedTaskWakeContinuation(checkpointTx, coordinates, use);
    },
  };
  const preparation = createProtectedTaskOutputReadPreparation({ db: {} as DirectDatabase, owner,
    authority: port, recipients: { delete: (id: string, generation: number) => {
      expect(events.at(-1)).toBe("committed"); deleted.push([id, generation]);
    } } as never, recipientTtlMs: 60_000,
    authorizationRequested: async userId => {
      expect(events.at(-1)).toBe("committed");
      notifications.push(userId);
      if (notificationFails) throw new Error("notification unavailable");
    }, crypto: new LatticeCrypto(),
    restricted: () => ({} as PostgresJsBridgeConnection), now: () => at }, overrides);
  return { preparation, repository, events, deleted, notifications,
    changePhysical: () => { physicalChanged = true; },
    plan: () => createProtectedTaskOutputReadPlan({ intent: intent(), authority: authority(), crypto: new LatticeCrypto(), now: at, recipientTtlMs: 60_000 }),
    setContinuation: (receipt: ProtectedTaskWakeContinuationReceipt, tx: NonNullable<typeof checkpointTx>) => {
      continuation = receipt; checkpointTx = tx;
    }, setMode: (value: typeof mode) => { mode = value; },
    setPolicy: (value: number) => { policy = value; }, setNow: (value: number) => { at = value; },
    deny: () => { denied = true; }, failCommit: () => { commitFails = true; }, allowCommit: () => { commitFails = false; },
    failNotification: () => { notificationFails = true; } };
}
const coordinates = { taskId: TASK, taskRunId: RUN, kind: "raw" as const };
async function prepare(f: ReturnType<typeof fixture>) {
  const result = await f.preparation.prepare(coordinates);
  if (result.status !== "created" && result.status !== "exact_replay") throw new Error(result.status);
  const record = await f.repository.get(result.plan.initialRecord.snapshot.requestId);
  if (record === null) throw new Error("request missing");
  return record as BackgroundAuthorizationTaskRuntimeRecordV3;
}

test("Plain exits before any product discovery, Session allocation or crypto request", async () => {
  const f = fixture(); f.setMode("plaintext_only");
  expect(await f.preparation.prepare(coordinates)).toEqual({ status: "inactive" });
  expect(f.events).toEqual([]);
  expect(f.notifications).toEqual([]);
});
test("commits the canonical Session before preparing the held combined result-read request", async () => {
  const f = fixture(); const record = await prepare(f);
  expect(f.events).toEqual(["requester", "ensure-session", "session-committed", "held", "committed"]);
  expect(record.workKind).toBe("task.deliver_result");
  expect(record.snapshot.namespaceId).toBe(PRIVATE);
  expect(record.authoritySet.namespaceRequirements.map(n => n.operations)).toEqual([["decrypt"], ["encrypt"]]);
  expect(f.notifications).toEqual([USER]);
  expect((await f.preparation.prepare(coordinates)).status).toBe("exact_replay");
  expect(f.notifications).toEqual([USER]);
  expect((await f.repository.get(record.snapshot.requestId))?.snapshot.requestRevision).toBe(0);
});
test("denied current output authority cannot create a request", async () => {
  const f = fixture(); f.deny();
  expect(await f.preparation.prepare(coordinates)).toEqual({ status: "not_ready" });
  expect(await f.repository.get(`task-run-delivery-result-authorization:${RUN}`)).toBeNull();
  expect(f.notifications).toEqual([]);
});
test("refreshes an unclaimed compatible policy without changing stable output identity", async () => {
  const f = fixture(); const first = await prepare(f); f.setPolicy(8);
  expect((await f.preparation.prepare(coordinates)).status).toBe("exact_replay");
  const later = await f.repository.get(first.snapshot.requestId);
  expect(later?.expectedPolicyRevision).toBe(8);
  expect(later?.idempotencyKey).toBe(first.idempotencyKey);
  expect(later?.snapshot.recipientGeneration).toBe(1);
  expect(f.deleted).toEqual([[first.snapshot.requestId, 0]]);
  expect(f.notifications).toEqual([USER, USER]);
});
test("rejects a substituted replacement without publishing an authorization hint", async () => {
  const f = fixture(); await prepare(f); f.notifications.length = 0; f.setPolicy(8);
  f.repository.replaceUnclaimedTaskOutputReadAuthority = async input => ({
    status: "replaced",
    record: { ...input.replacement, workIdentityHash: new Uint8Array(32).fill(9) },
  });
  expect(await f.preparation.prepare(coordinates)).toEqual({ status: "conflict" });
  expect(f.notifications).toEqual([]);
});
test("incompatible representation waits with no recipient rotation", async () => {
  const f = fixture(); const first = await prepare(f); f.setMode("shadow_encryption");
  expect(await f.preparation.prepare(coordinates)).toEqual({ status: "not_ready" });
  expect(await f.repository.get(first.snapshot.requestId)).toEqual(first);
  expect(f.deleted).toEqual([]);
  expect(f.notifications).toEqual([USER]);
});
test("renews expired unclaimed recipient only after held authority commits", async () => {
  const f = fixture(); const first = await prepare(f);
  const waiting = { ...first, snapshot: (attachBackgroundAuthorizationRecipient(first.snapshot,
    { recipientGeneration: 0, descriptorDigest: "a".repeat(64), recipientKeyId: "recipient",
      recipientPublicKey: Buffer.alloc(65, 1).toString("base64url"), expiresAt: NOW + 100, now: NOW + 1 }) as
      BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"]), descriptorBytes: new Uint8Array([1]) };
  // Descriptor digest must match the exact bytes admitted to ordinary CAS.
  const { createHash } = await import("node:crypto");
  waiting.snapshot = { ...waiting.snapshot, descriptorDigest: createHash("sha256").update(waiting.descriptorBytes).digest("hex") };
  expect((await f.repository.compareAndSwap({ expectedRequestRevision: first.snapshot.requestRevision, next: waiting })).status).toBe("updated");
  f.setNow(NOW + 101);
  expect((await f.preparation.prepare(coordinates)).status).toBe("exact_replay");
  expect((await f.repository.get(first.snapshot.requestId))?.snapshot.recipient).toBeNull();
  expect(f.deleted).toEqual([[first.snapshot.requestId, 0]]);
  expect(f.notifications).toEqual([USER, USER]);
});
test("failed product commit retains recipient custody for exact durable recovery", async () => {
  const f = fixture(); await prepare(f); f.setPolicy(8); f.failCommit();
  const settled = await Promise.allSettled([f.preparation.prepare(coordinates)]);
  expect(settled[0]?.status).toBe("rejected"); expect(f.deleted).toEqual([]);
  expect(f.notifications).toEqual([USER]);
});

test("notification failure cannot change a committed output preparation", async () => {
  const f = fixture(); f.failNotification();
  expect((await f.preparation.prepare(coordinates)).status).toBe("created");
  expect(f.notifications).toEqual([USER]);
});
test("device resolution rereads an existing Session and rejects a substituted selected record", async () => {
  const f = fixture(); const first = await prepare(f); f.events.length = 0;
  expect(await f.preparation.resolvePlan(first)).not.toBeNull();
  expect(f.events).toContain("read-session"); expect(f.events).not.toContain("ensure-session");
  const forged = { ...first, workIdentityHash: new Uint8Array(32).fill(2) };
  expect(await f.preparation.resolvePlan(forged)).toBeNull();
});

function checkpointFixture() {
  const jobId = protectedTaskRunWakeJobId(RUN);
  const semanticAuthorityRequirements = [{ namespaceId: DESTINATION, operations: ["decrypt"] as const },
    { namespaceId: EXTRA, operations: ["encrypt"] as const }];
  const receipt: ProtectedTaskWakeContinuationReceipt = { taskId: TASK, taskRunId: RUN, wakeJobId: jobId,
    bindingId: `task-run-output:${RUN}`, wakeOperationId: `task-run-delivery-wake:${RUN}`,
    segment: 1, priorRecipientGeneration: 0, wakeAuthorizationRequestId: `task-wake-authorization:${jobId}`,
    additionalAuthorizationRequestId: "projection:authorization", interruptId: "projection:interrupt", operationId: "projection:operation",
    requestDigest: new Uint8Array(32).fill(1), semanticAuthorityRequirements,
    requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(semanticAuthorityRequirements),
    retainedSourceNamespaceIds: [DESTINATION], sourceEnvelopeDigest: new Uint8Array(32).fill(2),
    initialPolicyRevision: 7, initialAgentAuthorizationRevision: 3, destinationRoomId: ROOM, destinationNamespaceId: EXTRA,
    destinationAuthorityDigest: new Uint8Array(32).fill(3), checkpointThreadId: `protected-task-wake:${jobId}`, checkpointContract: "encrypted_langgraph_v1",
    expectedCheckpointCount: 1, checkpointOrderedDigest: new Uint8Array(32).fill(4), expectedBlobCount: 0,
    blobOrderedDigest: new Uint8Array(32).fill(5), expectedPendingWriteCount: 0,
    pendingWriteOrderedDigest: new Uint8Array(32).fill(6), sealedAt: new Date(NOW) };
  const job = { id: jobId, ownerId: USER, requestorId: USER, roomId: ROOM, laneKey: `room:${ROOM}`, type: "foreground",
    status: "queued", startedAt: null, completedAt: null, result: null, message: null, metadata: {},
    input: { kind: "protected_task_delivery_v1", taskId: TASK, taskRunId: RUN, bindingId: receipt.bindingId,
      resultObjectId: protectedTaskRunResultObjectId(TASK, RUN), wakeOperationId: receipt.wakeOperationId } };
  const rows = new Map<unknown, unknown[]>([
    [tasks, [{ id: TASK, ownerId: USER, requestorId: USER, contentRepresentation: "protected", contentNamespaceId: PRIVATE,
      contentRevision: 1, cryptoMappingState: "verified", cryptoObjectId: "definition" }]],
    [taskRuns, [{ id: RUN, taskId: TASK, status: "completed", completedAt: new Date(NOW), resultRepresentation: "protected",
      resultCryptoMappingState: "verified", resultRevision: 1, resultCryptoObjectId: job.input.resultObjectId, resultContentNamespaceId: PRIVATE }]],
    [protectedTaskRunOutputBindings, [{ taskRunId: RUN, bindingId: receipt.bindingId, wakeOperationId: receipt.wakeOperationId,
      wakeJobId: jobId, wakeScheduledAt: new Date(NOW), completedAt: new Date(NOW), resultObjectId: job.input.resultObjectId,
      destinationRoomId: ROOM, destinationNamespaceId: DESTINATION }]],
    [jobs, [job]], [protectedTaskWakeContinuationReceipts, [receipt]],
  ]);
  let receiptQueries = 0;
  const tx = { select() {
    let table: unknown;
    let priorQuery = false;
    const query = { from(value: unknown) { table = value; priorQuery = table === protectedTaskWakeContinuationReceipts && ++receiptQueries % 3 === 0; return query; }, where: () => query, orderBy: () => query, limit: () => query,
      for: () => Promise.resolve(priorQuery ? [] : rows.get(table) ?? []),
      then: (resolve: (result: unknown[]) => unknown) => Promise.resolve(priorQuery ? [] : rows.get(table) ?? []).then(resolve) };
    return query;
  } } as unknown as Parameters<typeof withCurrentProtectedTaskWakeContinuation>[0];
  return { receipt, tx, job };
}
async function runningWake(f: ReturnType<typeof fixture>) {
  const initial = f.plan().initialRecord;
  const descriptorBytes = new Uint8Array([1]); const responseBytes = new Uint8Array([2]);
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const running: BackgroundAuthorizationTaskRuntimeRecordV3 = { ...initial, descriptorBytes,
    acceptedMaterial: { responseBytes, credentialId: "wake:credential", issuingDeviceAuthorizationRevision: 1,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(3), authorizationExpiresAt: NOW + 1000 },
    snapshot: { ...initial.snapshot, state: "running", requestRevision: 4, descriptorDigest: digest(descriptorBytes),
      recipient: { recipientKeyId: "wake:recipient", recipientPublicKey: Buffer.alloc(65, 1).toString("base64url"), expiresAt: NOW + 1000 },
      acceptedResponse: { kind: "runtime", responseDigest: digest(responseBytes), credentialDigest: "ab".repeat(32),
        issuingHumanId: HUMAN, issuingDeviceId: "wake:device", recipientGeneration: 0, acceptedAt: NOW },
      claimId: "wake:claim", claimExpiresAt: NOW + 1000 } };
  await f.repository.create(running);
  return running;
}
test("queued wake rotates only through genuine sealed proof and cleans custody after committed authority", async () => {
  const f = fixture(true); const original = await runningWake(f); const checkpoint = checkpointFixture();
  f.setContinuation(checkpoint.receipt, checkpoint.tx);
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
  const next = await f.repository.get(original.snapshot.requestId);
  expect(next?.snapshot.state).toBe("awaiting_recipient"); expect(next?.snapshot.recipientGeneration).toBe(1);
  expect(next?.idempotencyKey).toBe(original.idempotencyKey);
  expect(f.deleted).toEqual([[original.snapshot.requestId, 0]]);
  expect(f.notifications).toEqual([USER]);
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
  expect((await f.repository.get(original.snapshot.requestId))?.snapshot.recipientGeneration).toBe(1);
  expect(f.notifications).toEqual([USER]);
});
test("parked wake partial crypto commit retains custody until a subsequent exact current replay", async () => {
  const f = fixture(true); const original = await runningWake(f); const checkpoint = checkpointFixture();
  f.setContinuation(checkpoint.receipt, checkpoint.tx); f.failCommit();
  expect((await Promise.allSettled([f.preparation.prepare({ ...coordinates, kind: "wake" })]))[0]?.status).toBe("rejected");
  expect(f.deleted).toEqual([]);
  expect((await f.repository.get(original.snapshot.requestId))?.snapshot.recipientGeneration).toBe(1);
  expect(f.notifications).toEqual([]);
  f.allowCommit();
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
  expect((await f.repository.get(original.snapshot.requestId))?.snapshot.recipientGeneration).toBe(1);
  expect(f.deleted).toEqual([[original.snapshot.requestId, 0]]);
  expect(f.notifications).toEqual([]);
});
test("running wake or missing prior authorization never obtains a replacement from receipt metadata alone", async () => {
  const f = fixture(true); const original = await runningWake(f); const checkpoint = checkpointFixture();
  checkpoint.job.status = "running";
  f.setContinuation(checkpoint.receipt, checkpoint.tx);
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("conflict");
  expect(await f.repository.get(original.snapshot.requestId)).toEqual(original); expect(f.deleted).toEqual([]);
  const missing = fixture(true); missing.setContinuation(checkpoint.receipt, checkpoint.tx);
  expect((await missing.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("not_ready");
});

test("a queued resumed recipient renews under the same live receipt without replaying wake effects", async () => {
  const f = fixture(true); const original = await runningWake(f); const checkpoint = checkpointFixture();
  f.setContinuation(checkpoint.receipt, checkpoint.tx);
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
  const parked = await f.repository.get(original.snapshot.requestId) as BackgroundAuthorizationTaskRuntimeRecordV3;
  const descriptorBytes = new Uint8Array([1]);
  const waiting = { ...parked, descriptorBytes, snapshot: attachBackgroundAuthorizationRecipient(parked.snapshot,
    { recipientGeneration: 1, descriptorDigest: createHash("sha256").update(descriptorBytes).digest("hex"),
      recipientKeyId: "renewed-recipient", recipientPublicKey: Buffer.alloc(65, 1).toString("base64url"),
      expiresAt: NOW + 100, now: NOW + 1 }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] };
  expect((await f.repository.compareAndSwap({ expectedRequestRevision: parked.snapshot.requestRevision, next: waiting })).status).toBe("updated");
  f.setNow(NOW + 101);
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
  const renewed = await f.repository.get(original.snapshot.requestId);
  expect(renewed?.snapshot.state).toBe("awaiting_recipient");
  expect(renewed?.snapshot.recipientGeneration).toBe(2);
  expect(renewed?.idempotencyKey).toBe(original.idempotencyKey);
  expect(f.deleted.at(-1)).toEqual([original.snapshot.requestId, 1]);
  expect(f.notifications).toEqual([USER, USER]);
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
  expect((await f.repository.get(original.snapshot.requestId))?.snapshot.recipientGeneration).toBe(2);
  expect(f.notifications).toEqual([USER, USER]);
});

test("missing physical checkpoint proof cannot rotate a parked grant or admit its exact replay", async () => {
  for (const alreadyRotated of [false, true]) {
    const f = fixture(true); const original = await runningWake(f); const checkpoint = checkpointFixture();
    f.setContinuation(checkpoint.receipt, checkpoint.tx);
    if (alreadyRotated) expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
    const before = await f.repository.get(original.snapshot.requestId);
    const deletes = f.deleted.length;
    f.changePhysical();
    expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("conflict");
    expect(await f.repository.get(original.snapshot.requestId)).toEqual(before);
    expect(f.deleted).toHaveLength(deletes);
  }
});

test("queued continuation refreshes compatible policy under the same receipt before new custody", async () => {
  const f = fixture(true); const original = await runningWake(f); const checkpoint = checkpointFixture();
  f.setPolicy(8); // Current grant may already have advanced beyond the original capsule policy.
  f.setContinuation(checkpoint.receipt, checkpoint.tx);
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
  const parked = await f.repository.get(original.snapshot.requestId);
  expect(parked?.expectedPolicyRevision).toBe(8);
  f.setPolicy(9);
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
  const renewed = await f.repository.get(original.snapshot.requestId);
  expect(renewed?.expectedPolicyRevision).toBe(9);
  expect(renewed?.snapshot.recipientGeneration).toBe(2);
  expect(renewed?.idempotencyKey).toBe(original.idempotencyKey);
  expect(renewed?.snapshot.state).toBe("awaiting_recipient");
  expect(f.deleted.at(-1)).toEqual([original.snapshot.requestId, 1]);
  expect((await f.preparation.prepare({ ...coordinates, kind: "wake" })).status).toBe("exact_replay");
  expect((await f.repository.get(original.snapshot.requestId))?.snapshot.recipientGeneration).toBe(2);
});
