import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { actors, encryptionTransitionPolicy, jobs, protectedTaskRunOutputBindings,
  protectedTaskRunResultOperationId, protectedTaskSemanticAuthorityRequirementsDigest,
  roomMembers, rooms, sessions, taskRunResultCryptoRevisions,
  taskRuns, tasks, protectedTaskWakeContinuationReceipts } from "@nautilo/db";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { DomainForegroundSecretEntry } from "@nautilo/lattice-crypto";
import { withTaskRuntimeRunResultReadEvidenceV1 } from "../../../lattice-crypto/src/background/task-runtime-run-result-read-evidence-v1";
import { withTaskRuntimeWakeForegroundEvidenceV1 } from "../../../lattice-crypto/src/background/task-runtime-wake-foreground-evidence-v1";
import { withWakeEvidence } from "../../../lattice-bridge/tests/fixtures/task-wake-foreground-evidence";
import { createProtectedTaskWakeLifecycle } from "../../src/routes/protected-task-wake-lifecycle";
import { createProtectedTaskOutputReadProductProofLoader,
  createProtectedTaskWakeParkedProductProofLoader,
  createProtectedTaskWakeParkingProductProofLoader,
  createProtectedTaskWakeSettledProductProofLoader } from "../../src/routes/protected-task-output-read-product";
import type { ProtectedTaskOutputReadAuthorityPort, ProtectedTaskOutputReadCurrentAuthority } from "../../src/routes/protected-task-output-read-authority";
import type { ProtectedTaskWakePublication } from "../../src/routes/protected-task-wake-foreground-publication";

const USER = "60000000-0000-4000-8000-000000000001";
const HUMAN = "60000000-0000-4000-8000-000000000002";
const AGENT = "80000000-0000-4000-8000-000000000001";
const NS = "90000000-0000-4000-8000-000000000001";
const DESTINATION_NS = "90000000-0000-4000-8000-000000000002";
const DESTINATION_ROOM = "70000000-0000-4000-8000-000000000002";
const OWNER = "70000000-0000-4000-8000-000000000001";
const bytes = () => new Uint8Array(32).fill(7);
const domain = { domainId: "wake-domain", sourceNamespaceId: NS, keyClass: "ai",
  participantCount: 1, participantDigest: bytes(), domainKeyGeneration: 1,
  authorizationRevision: 2, headDigest: bytes(), domainKey: bytes() } as DomainForegroundSecretEntry;

async function fixture(use: (f: ReturnType<typeof make>) => Promise<void>) {
  const now = Date.now();
  await withWakeEvidence({ now, domain, namespaceId: NS, accessRevision: 3, policyRevision: 7,
    signerAgentId: AGENT, execute: (wake, read) => withTaskRuntimeRunResultReadEvidenceV1({
      now: () => now, signal: new AbortController().signal,
      evidence: { ...read, requesterHumanId: HUMAN },
      execute: evidence => withTaskRuntimeWakeForegroundEvidenceV1({ readEvidence: evidence,
        committerDeviceId: wake.committerDeviceId, committerDeviceSigningGeneration: 1,
        committerDeviceSigningPublicKeyHash: bytes(), namespaceRequirements: wake.namespaceRequirements,
        domainRequirements: wake.domainRequirements,
        execute: wakeEvidence => use(make({ evidence, wakeEvidence, now })),
      }),
    }),
  });
}

function make(input: Pick<ProtectedTaskWakePublication, "evidence" | "wakeEvidence"> & { now: number }) {
  const { evidence, wakeEvidence, now } = input;
  const { namespace, ...result } = evidence.result;
  const invocation = wakeEvidence.invocation;
  const terminalAt = new Date(now - 3_000);
  const createdAt = new Date(now - 2_000);
  const fingerprint = bytes();
  const binding = { taskRunId: result.taskRunId, bindingId: invocation.bindingId,
    deliveryMode: "wake", destinationRoomId: invocation.roomId, destinationNamespaceId: NS,
    resultRevision: 1, resultOperationId: protectedTaskRunResultOperationId(result.taskRunId),
    resultObjectId: result.objectId, resultTerminalAt: terminalAt, resultAttachedAt: terminalAt,
    acceptedPolicyRevision: 6, acceptedAt: new Date(now - 4_000), messageOperationId: null,
    messageId: null, messagePublishedAt: null, wakeOperationId: invocation.operationId,
    wakeJobId: invocation.jobId, wakeScheduledAt: createdAt, completedAt: createdAt };
  const task = { id: result.taskId, ownerId: USER, requestorId: USER, requesterUserId: USER,
    agentId: AGENT, callingRoomId: invocation.roomId, resultDelivery: "wake", status: "completed",
    cancelledAt: null, contentRepresentation: "protected", representation: "protected",
    contentNamespaceId: namespace.namespaceId, contentRevision: 1, cryptoObjectId: "definition",
    cryptoAccessRevision: 0, cryptoRequiredNamespaceFingerprint: fingerprint, cryptoMappingState: "verified",
    promptIsEmpty: true, expectedOutputIsNull: true, lastErrorIsNull: true };
  const run = { id: result.taskRunId, taskId: result.taskId, status: "completed", completedAt: terminalAt,
    resultRepresentation: "protected", representation: "protected", resultRevision: 1, revision: 1,
    resultContentNamespaceId: namespace.namespaceId, contentNamespaceId: namespace.namespaceId,
    resultCryptoObjectId: result.objectId, objectId: result.objectId, resultCryptoAccessRevision: 0, accessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: fingerprint, requiredNamespaceFingerprint: fingerprint,
    resultCryptoMappingState: "verified", mappingState: "verified", resultTextIsNull: true,
    resultTextIsCancelled: false, lastErrorIsNull: true };
  const ledger = { taskId: result.taskId, taskRunId: result.taskRunId, revision: 1,
    operationId: binding.resultOperationId, requestDigest: result.genesisManifestHash, requesterHumanId: HUMAN,
    contentNamespaceId: namespace.namespaceId, anchorNamespaceId: namespace.namespaceId, objectId: result.objectId,
    representation: "protected", payloadVersion: 1, accessRevision: 0, requiredNamespaceFingerprint: fingerprint,
    completion: "complete", disposition: "mapped", nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null,
    failureCode: null, cryptoCompletedAt: terminalAt };
  let job = { id: invocation.jobId, ownerId: USER, requestorId: USER, roomId: invocation.roomId,
    laneKey: `room:${invocation.roomId}`, type: "foreground", status: "queued", input: invocation.reference,
    result: null, message: null, metadata: {},
    resultIsNull: true, messageIsNull: true, metadataIsEmpty: true, createdAt,
    startedAt: null as Date | null, completedAt: null as Date | null };
  let held = false;
  let continuation: typeof protectedTaskWakeContinuationReceipts.$inferSelect | undefined;
  let denyDomain = false;
  let expired = false;
  let rejectCommit = false;
  let pauseCommit: (() => Promise<void>) | undefined;
  let loseResponse = false;
  const events: string[] = [];
  const signal = new AbortController().signal;
  const publication = { ...input, signal,
    plan: { intent: { requesterUserId: USER, requesterHumanId: HUMAN, agentId: AGENT,
      contentNamespaceId: namespace.namespaceId, representation: "protected", expectedPolicyRevision: 7,
      acceptedPolicyRevision: 6, result, invocation, initialState: "wake_queued" } },
    record: { workKind: "task.delivery_wake", purpose: "task.delivery_wake", expectedPolicyRevision: 7,
      descriptorBytes: bytes(), authoritySet: { namespaceRequirements: [], domainRequirements: [] },
      snapshot: { requestId: evidence.requestId, workId: invocation.jobId, recipientGeneration: 1,
        descriptorDigest: "digest", recipient: { recipientKeyId: "recipient", recipientPublicKey: "public" },
        acceptedResponse: { kind: "runtime", responseDigest: "response", issuingHumanId: HUMAN, issuingDeviceId: "wake-device" } },
      acceptedMaterial: { credentialId: evidence.requestId, responseBytes: bytes(), authorizationExpiresAt: now + 60_000,
        issuingDeviceAuthorizationRevision: 1, issuerSigningPublicKeyHash: bytes() } },
    assertCurrentClaim: async () => { if (expired) throw new Error("claim expired"); },
  } as unknown as ProtectedTaskWakePublication;
  const product = {} as PostgresJsBridgeConnection;
  const authority: ProtectedTaskOutputReadAuthorityPort = {
    withPlanning: async () => { throw new Error("unexpected planning"); },
    withDiscovery: async () => { throw new Error("unexpected discovery"); },
    withBound: async () => { throw new Error("unexpected binding"); },
    withWakeWriter: async operation => {
      if (held) throw new Error("recursive product authority");
      if (job.status !== "running" || denyDomain) return null;
      return authority.withAccepted({ ...operation,
        use: async (current, scopedProduct, scopedRestricted, transaction) => operation.use({
          product: scopedProduct, restricted: scopedRestricted, transaction,
          assertCurrent: async () => {
            if (!held || denyDomain || job.status !== "running") throw new Error("writer authority unavailable");
          },
        } as never, current),
      });
    },
    withAccepted: async operation => {
      if (held) throw new Error("recursive product authority");
      if (denyDomain) return null;
      held = true;
      const local = { ...job };
      let live = true;
      const tableRows = new Map<unknown, unknown[]>([
        [tasks, [task]], [taskRuns, [run]], [protectedTaskRunOutputBindings, [binding]],
        [protectedTaskWakeContinuationReceipts, continuation === undefined ? [] : [continuation]],
        [encryptionTransitionPolicy, [{ mode: "encrypted_only", revision: 7 }]],
        [taskRunResultCryptoRevisions, [ledger]], [jobs, [local]],
        [rooms, [{ id: invocation.roomId, ownerId: OWNER, namespaceId: NS, graphThreadId: "thread", archivedAt: null }]],
        [roomMembers, [{ kind: "user", ownerId: USER, agentId: null }, { kind: "user", ownerId: OWNER, agentId: null },
          { kind: "agent", ownerId: OWNER, agentId: AGENT }]],
        [sessions, [{ id: invocation.sessionId, ownerId: OWNER, agentId: AGENT, roomId: invocation.roomId,
          threadId: `room:${invocation.roomId}:bot:${AGENT}`, personaId: "owner" }]],
      ]);
      const tx = { select() {
        let table: unknown;
        let priorSegment: number | undefined;
        const execute = async () => { if (!live) throw new Error("escaped transaction");
          const rows = tableRows.get(table); if (rows === undefined) throw new Error("unexpected table");
          return rows.filter(row => table !== protectedTaskWakeContinuationReceipts
            || priorSegment === undefined
            || (row as typeof protectedTaskWakeContinuationReceipts.$inferSelect).segment < priorSegment)
            .map(row => ({ ...row as object })); };
        const query = { from(value: unknown) { table = value; return query; },
          where: (condition: SQL) => {
            if (table === protectedTaskWakeContinuationReceipts) {
              const compiled = new PgDialect().sqlToQuery(condition);
              const parameter = /"segment" < \$(\d+)/u.exec(compiled.sql)?.[1];
              if (parameter !== undefined) {
                const cutoff: unknown = compiled.params[Number(parameter) - 1];
                if (typeof cutoff !== "number") throw new Error("Invalid prior receipt cutoff");
                priorSegment = cutoff;
              }
            }
            return query;
          },
          innerJoin: (_table: typeof actors) => query, limit: () => query, orderBy: () => query, for: () => execute(),
          then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => execute().then(resolve, reject) };
        return query;
      }, update(table: unknown) {
        expect(table).toBe(jobs);
        let values: Record<string, unknown>;
        const query = { set(value: Record<string, unknown>) { values = value; return query; }, where: () => query,
          returning: async () => { if (!live) throw new Error("escaped transaction"); Object.assign(local, values); events.push(`write:${local.status}`); return [{ ...local }]; } };
        return query;
      }, insert(table: unknown) {
        expect(table).toBe(protectedTaskWakeContinuationReceipts);
        let values: typeof protectedTaskWakeContinuationReceipts.$inferInsert;
        const query = { values(value: typeof protectedTaskWakeContinuationReceipts.$inferInsert) { values = value; return query; },
          onConflictDoNothing: () => query,
          returning: async () => {
            if (!live) throw new Error("escaped transaction");
            if (continuation !== undefined) return [];
            const inserted = { ...values } as typeof protectedTaskWakeContinuationReceipts.$inferSelect;
            tableRows.set(protectedTaskWakeContinuationReceipts, [inserted]);
            return [inserted];
          } };
        return query;
      } } as unknown as CanonicalTranscriptTx;
      const loader = operation.parkedReceipt !== undefined
        ? createProtectedTaskWakeParkedProductProofLoader(operation.intent, operation.parkedReceipt)
        : operation.settledReceipt !== undefined
          ? createProtectedTaskWakeSettledProductProofLoader(operation.intent, operation.settledReceipt)
          : operation.parkCapture !== undefined
            ? createProtectedTaskWakeParkingProductProofLoader(operation.intent)
            : createProtectedTaskOutputReadProductProofLoader(operation.intent);
      const validate = async () => await loader.validateCurrentTaskRun(product, tx)
        && await loader.validateCurrentForeground(product, tx, { destinationRoomId: invocation.roomId,
          destinationNamespaceId: NS, foregroundNamespaceIds: [NS] });
      try {
        if (!await validate()) return null;
        await operation.validateBeforeCommit();
        const current = { occurrence: { requesterHumanId: HUMAN, result: evidence.result, invocation } } as ProtectedTaskOutputReadCurrentAuthority;
        const value = await operation.use(current, product, product, tx);
        if (!await validate()) throw new Error("post-operation proof rejected");
        operation.settlementCapture?.(loader);
        operation.parkCapture?.(loader);
        await operation.validateBeforeCommit();
        await pauseCommit?.();
        if (rejectCommit) throw new Error("product commit rejected");
        job = local;
        continuation = (tableRows.get(protectedTaskWakeContinuationReceipts) as
          (typeof protectedTaskWakeContinuationReceipts.$inferSelect)[])[0];
        events.push(`commit:${job.status}`);
        if (loseResponse) throw new Error("product response lost after commit");
        return value;
      } finally { loader.reset(); live = false; held = false; }
    },
  };
  return { publication, authority, events,
    create: () => createProtectedTaskWakeLifecycle({ publication, authority, restricted: product }),
    state: () => job.status, held: () => held, expire: () => { expired = true; },
    deny: () => { denyDomain = true; }, rejectCommit: () => { rejectCommit = true; },
    loseResponse: () => { loseResponse = true; }, continuation: () => continuation,
    holdCommit: (gate: () => Promise<void>) => { pauseCommit = gate; },
  };
}

function parkInput(f: ReturnType<typeof make>) {
  const requirements = [
    { namespaceId: NS, operations: ["decrypt"] as const },
    { namespaceId: DESTINATION_NS, operations: ["encrypt"] as const },
  ];
  return Object.freeze({
    request: Object.freeze({
      interruptId: "projection:interrupt",
      additionalAuthorizationRequestId: "projection:authorization",
      effectDisposition: "not_started_v1" as const,
      operationId: "projection:operation",
      requestDigest: new Uint8Array(32).fill(1),
      requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(requirements),
      semanticAuthorityRequirements: requirements,
      checkpointBinding: Object.freeze({ retainedSourceNamespaceIds: [NS],
        sourceEnvelopeDigest: new Uint8Array(32).fill(2), initialPolicyRevision: 7,
        initialAgentAuthorizationRevision: 4 }),
      checkpointThreadId: `protected-task-wake:${f.publication.wakeEvidence.workId}`,
      checkpoint: Object.freeze({ contract: "encrypted_langgraph_v1" as const,
        expectedCheckpointCount: 1, checkpointOrderedDigest: new Uint8Array(32).fill(3),
        expectedBlobCount: 2, blobOrderedDigest: new Uint8Array(32).fill(4),
        expectedPendingWriteCount: 0, pendingWriteOrderedDigest: new Uint8Array(32).fill(5) }),
    }),
    destination: Object.freeze({ destinationRoomId: DESTINATION_ROOM,
      namespaceId: DESTINATION_NS, destinationAuthorityDigest: new Uint8Array(32).fill(6) }),
  });
}

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

for (const terminal of ["completed", "failed"] as const) test(`canonical queued start, ${terminal} settlement and fresh terminal reproof`, () => fixture(async f => {
  const lifecycle = await f.create(); expect(lifecycle).not.toBeNull(); if (lifecycle === null) return;
  expect(f.state()).toBe("queued");
  expect(await lifecycle.start(lifecycle.scheduling.jobId)).toEqual({ status: "started" });
  expect(f.state()).toBe("running");
  expect(await lifecycle.loadCurrentResult()).toEqual({ requesterHumanId: HUMAN, result: f.publication.evidence.result,
    invocation: f.publication.wakeEvidence.invocation });
  let assertLater: (() => Promise<void>) | undefined;
  await lifecycle.withCurrentFacts({ publication: f.publication, scheduling: lifecycle.scheduling,
    signal: f.publication.signal, use: async (_tx, current) => { expect(f.held()).toBe(true); assertLater = current; return true; } });
  await assertLater?.(); expect(f.held()).toBe(false);
  expect(await lifecycle.withCurrentWriter({ signer: {} as never, resolveHistoricalSignerPublicationManager: () => null,
    use: async () => { expect(f.held()).toBe(true); return "written"; } })).toBe("written");
  expect(await lifecycle.settle(lifecycle.scheduling.jobId, terminal)).toEqual({ kind: "transitioned", status: terminal });
  expect(f.state()).toBe(terminal);
  await lifecycle.assertCurrent(); expect(await lifecycle.loadCurrentResult()).not.toBeNull();
  expect(await lifecycle.settle(lifecycle.scheduling.jobId, terminal)).toEqual({ kind: "existing_terminal", status: terminal });
  expect(await lifecycle.withCurrentWriter({ signer: {} as never, resolveHistoricalSignerPublicationManager: () => null,
    use: async () => { throw new Error("terminal write prohibited"); } })).toBeNull();
  expect(await f.create()).toBeNull();
  lifecycle.dispose(); await rejects(lifecycle.assertCurrent());
}));

test("commit rejection retains running state and cannot mint terminal replay authority", () => fixture(async f => {
  const lifecycle = await f.create(); if (lifecycle === null) throw new Error("missing lifecycle");
  await lifecycle.start(lifecycle.scheduling.jobId); f.rejectCommit();
  await rejects(lifecycle.settle(lifecycle.scheduling.jobId, "completed"), /product commit rejected/);
  expect(f.state()).toBe("running");
  expect(f.events).not.toContain("commit:completed");
  lifecycle.dispose();
}));

test("committed park returns the Job to queued with an opaque reproof and closes writer and settlement", () => fixture(async f => {
  const lifecycle = await f.create(); if (lifecycle === null) throw new Error("missing lifecycle");
  expect(await lifecycle.start(lifecycle.scheduling.jobId)).toEqual({ status: "started" });
  const parked = await lifecycle.park(parkInput(f));
  expect(parked.status).toBe("parked");
  expect(parked.receipt).toBeDefined();
  expect(Object.keys(parked.receipt ?? {})).toEqual([]);
  expect(f.state()).toBe("queued");
  expect(f.continuation()).toMatchObject({ wakeJobId: lifecycle.scheduling.jobId,
    checkpointThreadId: `protected-task-wake:${lifecycle.scheduling.jobId}`,
    destinationNamespaceId: DESTINATION_NS });
  await lifecycle.assertCurrent();
  expect(await lifecycle.withCurrentWriter({ signer: {} as never,
    resolveHistoricalSignerPublicationManager: () => null,
    use: async () => { throw new Error("parked writer must not run"); } })).toBeNull();
  expect(await lifecycle.settle(lifecycle.scheduling.jobId, "completed")).toEqual({ kind: "rejected" });
  expect(await lifecycle.park(parkInput(f))).toEqual({ status: "stale" });
  lifecycle.dispose();
}));

test("park commit failure rolls back the running Job and cannot mint a reproof", () => fixture(async f => {
  const lifecycle = await f.create(); if (lifecycle === null) throw new Error("missing lifecycle");
  await lifecycle.start(lifecycle.scheduling.jobId); f.rejectCommit();
  await rejects(lifecycle.park(parkInput(f)), /product commit rejected/);
  expect(f.state()).toBe("running");
  expect(f.continuation()).toBeUndefined();
  expect(f.events.filter(event => event === "commit:queued")).toHaveLength(1);
  lifecycle.dispose();
}));

test("lost response after committed park cannot reopen writer or terminal settlement", () => fixture(async f => {
  const lifecycle = await f.create(); if (lifecycle === null) throw new Error("missing lifecycle");
  await lifecycle.start(lifecycle.scheduling.jobId); f.loseResponse();
  await rejects(lifecycle.park(parkInput(f)), /response lost/);
  expect(f.state()).toBe("queued");
  expect(f.continuation()).toBeDefined();
  expect(await lifecycle.withCurrentWriter({ signer: {} as never,
    resolveHistoricalSignerPublicationManager: () => null,
    use: async () => { throw new Error("writer must remain closed"); } })).toBeNull();
  expect(await lifecycle.settle(lifecycle.scheduling.jobId, "completed")).toEqual({ kind: "rejected" });
  await rejects(lifecycle.assertCurrent());
  lifecycle.dispose();
}));

for (const reason of ["claim", "domain"] as const) test(`${reason} loss prevents start, content and settlement`, () => fixture(async f => {
  const lifecycle = await f.create(); if (lifecycle === null) throw new Error("missing lifecycle");
  if (reason === "claim") f.expire(); else f.deny();
  if (reason === "claim") await rejects(lifecycle.start(lifecycle.scheduling.jobId));
  else expect(await lifecycle.start(lifecycle.scheduling.jobId)).toEqual({ status: "stale" });
  expect(f.state()).toBe("queued");
  await rejects(lifecycle.assertCurrent());
  expect(await lifecycle.settle(lifecycle.scheduling.jobId, "completed")).toEqual({ kind: "rejected" });
  lifecycle.dispose();
}));

test("parallel start cannot run twice and fresh readers wait for committed transition", () => fixture(async f => {
  const lifecycle = await f.create(); if (lifecycle === null) throw new Error("missing lifecycle");
  const gate = deferred(); f.holdCommit(() => gate.promise);
  const first = lifecycle.start(lifecycle.scheduling.jobId);
  expect(await lifecycle.start(lifecycle.scheduling.jobId)).toEqual({ status: "stale" });
  let readDone = false; const reading = lifecycle.loadCurrentResult().then(result => { readDone = true; return result; });
  await Promise.resolve(); expect(readDone).toBe(false); expect(f.state()).toBe("queued");
  gate.resolve(); expect(await first).toEqual({ status: "started" }); expect(await reading).not.toBeNull();
  expect(f.events.filter(value => value === "write:running")).toHaveLength(1);
  lifecycle.dispose();
}));

test("context borrows only the live transaction and rejects a substituted publication", () => fixture(async f => {
  const lifecycle = await f.create(); if (lifecycle === null) throw new Error("missing lifecycle");
  await lifecycle.start(lifecycle.scheduling.jobId);
  let escaped: CanonicalTranscriptTx | undefined;
  expect(await lifecycle.withCurrentFacts({ publication: f.publication, scheduling: lifecycle.scheduling,
    signal: f.publication.signal, use: async tx => { escaped = tx; return "current"; } })).toBe("current");
  if (escaped === undefined) throw new Error("missing transaction");
  await rejects(Promise.resolve(escaped.select().from(tasks)), /escaped transaction/);
  expect(await lifecycle.withCurrentFacts({ publication: { ...f.publication }, scheduling: lifecycle.scheduling,
    signal: f.publication.signal, use: async () => { throw new Error("must not run"); } })).toBeNull();
  lifecycle.dispose();
}));

test("nested wake reads revalidate the held writer and reject its escaped async scope", () => fixture(async f => {
  const lifecycle = await f.create(); if (lifecycle === null) throw new Error("missing lifecycle");
  await lifecycle.start(lifecycle.scheduling.jobId);
  const gate = deferred();
  let escaped: Promise<void> | undefined;
  expect(await lifecycle.withCurrentWriter({ signer: {} as never, resolveHistoricalSignerPublicationManager: () => null,
    use: async () => {
      expect(f.held()).toBe(true);
      await lifecycle.assertCurrent();
      expect(await lifecycle.loadCurrentResult()).toEqual({ requesterHumanId: HUMAN,
        result: f.publication.evidence.result, invocation: f.publication.wakeEvidence.invocation });
      escaped = gate.promise.then(() => lifecycle.assertCurrent());
      return "verified";
    },
  })).toBe("verified");
  expect(f.held()).toBe(false);
  if (escaped === undefined) throw new Error("missing escaped scope");
  const denied = rejects(escaped);
  gate.resolve(); await denied;
  await lifecycle.assertCurrent();
  lifecycle.dispose();
}));

test("claim loss inside the borrowed wake writer rejects nested content reads", () => fixture(async f => {
  const lifecycle = await f.create(); if (lifecycle === null) throw new Error("missing lifecycle");
  await lifecycle.start(lifecycle.scheduling.jobId);
  await rejects(lifecycle.withCurrentWriter({ signer: {} as never, resolveHistoricalSignerPublicationManager: () => null,
    use: async () => { f.expire(); await lifecycle.loadCurrentResult(); },
  }), /claim expired/);
  lifecycle.dispose();
}));
