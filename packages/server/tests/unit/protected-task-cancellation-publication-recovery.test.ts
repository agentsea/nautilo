import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { protectedTaskRunOutputBindings, tasks, taskRunResultCryptoRevisions,
  protectedTaskRunOutputBindingId, protectedTaskRunResultObjectId, protectedTaskRunResultOperationId } from "@nautilo/db";
import type { DirectDatabase, ProtectedTaskCancellationOutputIntent,
  TaskRunResultCryptoRevision } from "@nautilo/db";
import { fingerprintTaskContentAuthorityV1, deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type { VerifiedStagedTaskCancellationPublication } from "@nautilo/lattice-bridge/server";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  attachBackgroundAuthorizationRecipient, claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3, markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning, completeBackgroundAuthorizationRequest, type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import { protectedTaskCancellationIdempotencyKey } from "../../src/routes/protected-task-cancellation-plan";
import { createProtectedTaskCancellationPublicationRecovery } from "../../src/routes/protected-task-cancellation-publication-recovery";
import type { VerifyStagedCancellationSettlement } from "../../src/routes/protected-task-cancellation-settlement";

type Input = Parameters<typeof createProtectedTaskCancellationPublicationRecovery>[0];
type ReadDependencies = Required<NonNullable<Parameters<typeof createProtectedTaskCancellationPublicationRecovery>[1]>>;
type Dependencies = { -readonly [K in keyof ReadDependencies]: ReadDependencies[K] };
const START = 1_700_100_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const NAMESPACE = "40000000-0000-4000-8000-000000000004";
const HUMAN = "50000000-0000-4000-8000-000000000005";
const REQUEST = `task-run-cancellation-result-authorization:${RUN}`;
const database = Object.freeze({}) as unknown as DirectDatabase;
const publicKey = Buffer.alloc(65, 7).toString("base64url");

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function runningRecord(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const responseBytes = new Uint8Array([4, 5, 6]);
  const descriptorDigest = digest(descriptorBytes);
  const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId: REQUEST,
    workId: RUN,
    namespaceId: NAMESPACE,
    now: START,
  });
  const waiting = attachBackgroundAuthorizationRecipient(initial, {
    recipientGeneration: 0,
    recipientKeyId: "published-result-recipient",
    recipientPublicKey: publicKey,
    descriptorDigest,
    expiresAt: START + 60_000,
    now: START + 1,
  });
  const ready = markBackgroundAuthorizationGrantReady(waiting, {
    kind: "runtime",
    requestId: REQUEST,
    descriptorDigest,
    recipientKeyId: "published-result-recipient",
    recipientPublicKey: publicKey,
    expiresAt: START + 60_000,
    responseDigest: digest(responseBytes),
    credentialDigest: "cd".repeat(32),
    issuingHumanId: HUMAN,
    issuingDeviceId: "published-result-device",
    recipientGeneration: 0,
    now: START + 2,
  });
  const claimed = claimBackgroundAuthorizationRequest(
    ready,
    "published-result-claim",
    START + 3,
    START + 30_000,
  );
  return {
    snapshot: markBackgroundAuthorizationRunning(claimed, START + 4),
    workIdentityHash: new Uint8Array(32).fill(9),
    idempotencyKey: protectedTaskCancellationIdempotencyKey(intent),
    workKind: "task.cancel_result",
    purpose: "task.cancel_result",
    domainId: "published-result-domain",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    descriptorBytes,
    acceptedMaterial: {
      responseBytes,
      credentialId: "published-result-credential",
      issuingDeviceAuthorizationRevision: 7,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(2),
      authorizationExpiresAt: START + 60_000,
    },
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: NAMESPACE,
        domainId: "published-result-domain",
        operations: ["encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 5,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "published-result-domain",
        expectedEpoch: 3,
        expectedAuthorizationRevision: 8,
      }],
    },
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
}

const intent: ProtectedTaskCancellationOutputIntent = {
  taskId: TASK, taskRunId: RUN, requesterUserId: "requester", agentId: "agent",
  contentNamespaceId: NAMESPACE, representation: "protected", resultRevision: 2,
  resultOperationId: `task-run-cancelled-result:${RUN}`,
  resultObjectId: deriveTaskContentCryptoObjectIdV1({
    kind: "run_result", taskId: TASK, taskRunId: RUN, contentRevision: 2,
  }),
  policyRevision: 5, taskStatus: "cancelled", runStatus: "cancelled",
  terminalAt: new Date(START - 1),
};
const fingerprint = fingerprintTaskContentAuthorityV1({
  authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
  requesterHumanId: HUMAN, namespaceId: NAMESPACE, domainId: "published-result-domain",
  expectedAccessRevision: 4, expectedPolicyRevision: 5,
});

function fixture() {
  const calls: string[] = [];
  const row = runningRecord();
  const ledger: TaskRunResultCryptoRevision = {
    sequence: 1, taskId: TASK, taskRunId: RUN, contentNamespaceId: NAMESPACE,
    resultRevision: 2, operationId: intent.resultOperationId,
    requestDigest: new Uint8Array(32).fill(8), authorityFingerprint: fingerprint,
    requesterHumanId: HUMAN, anchorNamespaceId: NAMESPACE,
    cryptoObjectId: intent.resultObjectId, representation: "protected", payloadVersion: 1,
    historicalRepair: null, cryptoAccessRevision: 0, requiredNamespaceFingerprint: new Uint8Array(32).fill(5),
    completion: "pending", disposition: "active", attemptCount: 0,
    nextAttemptAt: new Date(START), leaseToken: null, leaseExpiresAt: null,
    failureCode: null, cryptoCompletedAt: null, createdAt: new Date(START), updatedAt: new Date(START),
  };
  const reservation = { intent: { ...intent }, ledger };
  const scopedRestricted = {} as Input["restricted"];
  const scopedProduct = {} as Input["restricted"];
  const transaction = {} as Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];
  let held = false;
  let verified = true;
  let staged: VerifiedStagedTaskCancellationPublication | null = null;
  let publicationPresent = false;
  let settlementVerifier: VerifyStagedCancellationSettlement | undefined;
  let settlementProof: Parameters<VerifyStagedCancellationSettlement>[0] | undefined;
  let beforeSettlement: (() => void) | undefined;
  let settlementResult: Awaited<ReturnType<VerifyStagedCancellationSettlement>> | undefined;
  let rejectCommitPhase = 0;
  let phase = 0;
  const cleanup: string[] = [];
  let selected: Awaited<ReturnType<Dependencies["read"]>> = { status: "found", reservation };
  const input: Input = { db: database, restricted: {} as Input["restricted"],
    crypto: new LatticeCrypto(), serverScope: "http://localhost", now: () => START + 90_000,
    settle: async (_coordinates, verifyStaged, context) => {
      expect(held).toBe(true);
      await context.db.transaction(async tx => { expect(tx).toBe(transaction); });
      expect(context.restricted).toBe(scopedRestricted);
      beforeSettlement?.();
      settlementVerifier = verifyStaged;
      settlementResult = await verifyStaged(settlementProof ?? { intent: reservation.intent,
        currentPolicyRevision: _coordinates.currentPolicyRevision!, requesterHumanId: HUMAN,
        authorityFingerprint: ledger.authorityFingerprint, cryptoAccessRevision: 0,
        requiredNamespaceFingerprint: ledger.requiredNamespaceFingerprint });
      context.deferRecipientCleanup(() => { expect(held).toBe(false); cleanup.push("released"); });
      calls.push("settle"); return true;
    } };
  const deps: Dependencies = {
    readPolicy: async () => ({ mode: reservation.intent.representation === "dual"
      ? "shadow_encryption" : "encrypted_only", shadowBehavior: "strict", revision: 5,
      shadowEncryptionStartedAt: new Date(START), updatedAt: new Date(START) }),
    read: async () => selected,
    resolveHuman: async () => ({ id: HUMAN, displayName: "Requester", trustState: "trusted" }),
    resolveRoom: async () => ({ roomId: "room", namespaceId: NAMESPACE }),
    productContext: (async () => ({ handle: {}, canonicalRunner: {} })) as unknown as Dependencies["productContext"],
    validateIntent: async () => { calls.push("intent"); return true; },
    cryptoHandle: async () => ({} as never),
    productHandle: async connection => { expect(held).toBe(true); expect(connection).toBe(scopedProduct); return {} as never; },
    withAuthority: async operation => {
      expect(held).toBe(false);
      held = true;
      phase += 1;
      try {
        if (!await operation.validateCurrentTaskRun({} as never, transaction, {} as never)) return null;
        const result = await operation.use({ sourceRoomId: "room", sourceNamespaceId: NAMESPACE,
          facts: [{ namespaceId: NAMESPACE, domainId: row.domainId,
            expectedAccessRevision: 4, expectedPolicyRevision: operation.expectedPolicyRevision,
            expectedDomainEpoch: 3, expectedAuthorizationRevision: 8 }] },
        scopedProduct, transaction, scopedRestricted);
        if (phase === rejectCommitPhase) throw new Error("outer transaction commit rejected");
        return result;
      } finally { held = false; }
    },
    authorizationRepository: async connection => { expect(held).toBe(true); expect(connection).toBe(scopedRestricted); return { get: async () => row }; },
    inspectStaged: async () => staged,
    hasCryptoPublication: async () => publicationPresent,
    reserveStaged: async value => value.product.reserveRevision({} as never),
    reservationProduct: options => ({ reserveRevision: async () => {
      expect(held).toBe(true);
      calls.push("reserve");
      expect(await options.resolveAuthority({ requesterHumanId: HUMAN, namespaceId: NAMESPACE })).not.toBeNull();
      calls.push("held-authority");
      await options.assertReservationCurrent({ kind: "run_result", taskId: TASK,
        taskRunId: RUN, contentRevision: 2 });
      selected = { status: "found", reservation };
      return { status: "reserved", state: {} as never };
    } }),
    repository: async options => {
      expect(held).toBe(true);
      return { reconcileCoordinate: async operation => {
        expect(held).toBe(true);
        expect(operation.operationId).toBe(intent.resultOperationId);
        expect(operation.coordinate).toEqual({ kind: "run_result", taskId: TASK,
          taskRunId: RUN, contentRevision: 2 });
        calls.push("reconcile");
        expect(await options.resolveAuthority({ requesterHumanId: HUMAN, namespaceId: NAMESPACE })).not.toBeNull();
        ledger.leaseToken = options.reservation.ledger.leaseToken = operation.leaseToken;
        ledger.leaseExpiresAt = options.reservation.ledger.leaseExpiresAt = new Date(START + 120_000);
        calls.push("verify");
        if (!verified) return "pending";
        if (options.reservation.ledger.disposition !== "mapped") await operation.publishProduct?.();
        calls.push("map");
        if (options.reservation.ledger.disposition !== "mapped") {
          selected = { status: "found", reservation: { intent: reservation.intent,
            ledger: { ...ledger, disposition: "mapped", completion: "complete",
              cryptoCompletedAt: new Date(START + 90_000) } } };
        }
        return "mapped";
      } };
    },
    publishProduct: async (db, publication, assertCurrent) => {
      expect(held).toBe(true);
      expect(publication.intent).toEqual(reservation.intent);
      expect(publication.requestDigest).toEqual(ledger.requestDigest);
      expect(publication.prepared).toEqual({ operationId: intent.resultOperationId,
        resultRevision: 2, resultObjectId: intent.resultObjectId,
        requesterHumanId: HUMAN, authorityFingerprint: fingerprint });
      await db.transaction(async tx => {
        expect(tx).toBe(transaction);
        expect(await assertCurrent(tx)).toBe(true);
      });
      calls.push("product");
      return { status: "written" };
    },
    settle: input.settle,
  };
  return { input, deps, calls, row, ledger, reservation, transaction,
    select: (value: typeof selected) => { selected = value; },
    missingCrypto: () => { verified = false; },
    stage: () => {
      staged = { intent: { ...reservation.intent, terminalAt: new Date(intent.terminalAt) }, requestId: REQUEST,
        recipientGeneration: 0, claimId: "published-result-claim",
        authorizationDigest: new Uint8Array(32).fill(6),
        genesisManifestHash: ledger.requestDigest.slice(),
        authorityFingerprint: ledger.authorityFingerprint.slice(),
      } as VerifiedStagedTaskCancellationPublication;
      publicationPresent = true;
      selected = { status: "missing", intent: { ...reservation.intent, terminalAt: new Date(intent.terminalAt) } };
    },
    publication: (present: boolean) => { publicationPresent = present; },
    clearStage: () => { staged = null; },
    settlementVerifier: () => settlementVerifier,
    settlementResult: () => settlementResult,
    checkSettlement: (proof: Parameters<VerifyStagedCancellationSettlement>[0], before?: () => void) => {
      settlementProof = proof; beforeSettlement = before;
    },
    cleanup, phase: () => phase,
    rejectCommit: (selectedPhase: number) => { rejectCommitPhase = selectedPhase; },
  };
}

test.each(["protected", "dual"] as const)("recovers exact %s cancellation after grant expiry using borrowed product transaction", async representation => {
  const f = fixture();
  f.reservation.intent.representation = representation;
  f.ledger.representation = representation;
  expect(f.row.acceptedMaterial!.authorizationExpiresAt).toBeLessThan(f.input.now!());
  const result = await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)({ taskId: TASK, taskRunId: RUN });
  expect(result).toBe("mapped");
  expect(f.calls).toEqual(["intent", "reconcile", "verify", "product", "map", "intent", "settle"]);
});

test("missing ciphertext stays pending without product replay or settlement", async () => {
  const f = fixture(); f.missingCrypto();
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)({ taskId: TASK, taskRunId: RUN })).toBe("pending");
  expect(f.calls).not.toContain("product");
  expect(f.calls).not.toContain("settle");
});

test("only absent reservation permits fresh preparation", async () => {
  const f = fixture();
  f.select({ status: "missing", intent: f.reservation.intent });
  const recover = createProtectedTaskCancellationPublicationRecovery(f.input, f.deps);
  expect(await recover({ taskId: TASK, taskRunId: RUN })).toBe("missing");
  f.select({ status: "invalid" });
  expect(await recover({ taskId: TASK, taskRunId: RUN })).toBe("pending");
  expect(f.calls).toEqual([]);
});

test("adopts a verified stage once inside held authority and recovers after grant pruning", async () => {
  const f = fixture();
  f.stage();
  f.deps.authorizationRepository = async () => ({ get: async () => null });
  expect(f.row.acceptedMaterial!.authorizationExpiresAt).toBeLessThan(f.input.now!());
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
    { taskId: TASK, taskRunId: RUN })).toBe("mapped");
  expect(f.calls.filter(call => call === "reserve")).toHaveLength(1);
  expect(f.calls.indexOf("intent")).toBeLessThan(f.calls.indexOf("reserve"));
  expect(f.calls.indexOf("reserve")).toBeLessThan(f.calls.indexOf("reconcile"));
  expect(f.calls).toContain("held-authority");
  expect(f.settlementResult()).toEqual({ requestId: REQUEST, recipientGeneration: 0 });
});

test.each(["intent", "requester", "authority", "namespace", "access", "stage"])(
  "staged settlement verifier rejects mismatched %s proof without product authority nesting", async mismatch => {
    const f = fixture(); f.stage();
    const proof = {
      currentPolicyRevision: 5,
      intent: mismatch === "intent" ? { ...f.reservation.intent, policyRevision: 6 } : f.reservation.intent,
      requesterHumanId: mismatch === "requester" ? "foreign" : HUMAN,
      authorityFingerprint: mismatch === "authority" ? new Uint8Array(32) : f.ledger.authorityFingerprint,
      cryptoAccessRevision: mismatch === "access" ? 1 : 0,
      requiredNamespaceFingerprint: mismatch === "namespace"
        ? new Uint8Array(32) : f.ledger.requiredNamespaceFingerprint,
    };
    f.checkSettlement(proof, mismatch === "stage" ? f.clearStage : undefined);
    expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
      { taskId: TASK, taskRunId: RUN })).toBe("mapped");
    expect(f.settlementResult()).toBeNull();
    expect(await f.settlementVerifier()!(proof)).toBeNull();
  },
);

test.each(["bare", "invalid"])("%s staged custody fences fresh preparation", async kind => {
  const f = fixture();
  f.select({ status: "missing", intent: f.reservation.intent });
  f.publication(true);
  if (kind === "invalid") f.deps.inspectStaged = async () => { throw new Error("staging receipt conflict"); };
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
    { taskId: TASK, taskRunId: RUN })).toBe("pending");
  expect(f.calls).not.toContain("reserve");
  expect(f.calls).not.toContain("reconcile");
});

test.each(["operation", "object", "namespace", "requester", "fingerprint", "kind", "idempotency", "policy", "unclaimed"])(
  "refuses mismatched %s proof before reconciliation", async mismatch => {
    const f = fixture();
    if (mismatch === "operation") f.ledger.operationId = "foreign";
    if (mismatch === "object") f.ledger.cryptoObjectId = "foreign";
    if (mismatch === "namespace") f.ledger.anchorNamespaceId = "foreign";
    if (mismatch === "requester") f.ledger.requesterHumanId = "foreign";
    if (mismatch === "fingerprint") f.ledger.authorityFingerprint = new Uint8Array(32);
    const changed = { ...f.row, ...(mismatch === "kind" ? { purpose: "task.execute" } : {}),
      ...(mismatch === "idempotency" ? { idempotencyKey: "foreign" } : {}),
      ...(mismatch === "policy" ? { expectedPolicyRevision: 6 } : {}) };
    if (mismatch === "unclaimed") changed.snapshot = { ...f.row.snapshot, state: "grant_ready",
      claimId: null, claimExpiresAt: null };
    f.deps.authorizationRepository = async () => ({ get: async () => changed as typeof f.row });
    let result: unknown;
    try { result = await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)({ taskId: TASK, taskRunId: RUN }); }
    catch { result = "pending"; }
    expect(result).toBe("pending");
    expect(f.calls).not.toContain("reconcile");
  },
);

test("mapped replay settles without a product callback", async () => {
  const f = fixture(); f.ledger.disposition = "mapped"; f.ledger.completion = "complete"; f.ledger.cryptoCompletedAt = new Date(START);
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)({ taskId: TASK, taskRunId: RUN })).toBe("mapped");
  expect(f.calls).not.toContain("product");
  expect(f.calls).toContain("settle");
});

test("mapped complete recovery permits exact terminal attachment after authorization pruning", async () => {
  const f = fixture(); f.stage();
  f.ledger.disposition = "mapped"; f.ledger.completion = "complete";
  f.ledger.cryptoCompletedAt = new Date(START);
  f.select({ status: "found", reservation: f.reservation });
  f.deps.authorizationRepository = async () => ({ get: async () => null });
  const attachmentModes: boolean[] = [];
  f.deps.validateIntent = async input => {
    attachmentModes.push(input.allowTerminalResultAttachment === true);
    return input.allowTerminalResultAttachment === true;
  };
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
    { taskId: TASK, taskRunId: RUN })).toBe("mapped");
  expect(attachmentModes.length).toBeGreaterThan(0);
  expect(attachmentModes.every(Boolean)).toBe(true);
  expect(f.calls).not.toContain("product");
});

test("active recovery never enables terminal attachment replay", async () => {
  const f = fixture(); f.stage();
  f.select({ status: "found", reservation: f.reservation });
  const attachmentModes: boolean[] = [];
  f.deps.validateIntent = async input => {
    attachmentModes.push(input.allowTerminalResultAttachment === true);
    return input.allowTerminalResultAttachment === true;
  };
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
    { taskId: TASK, taskRunId: RUN })).toBe("pending");
  expect(attachmentModes).toEqual([false]);
  expect(f.calls).not.toContain("reconcile");
});

test.each(["active", "incomplete"])(
  "terminal attachment recovery rejects a fresh %s ledger under held authority", async drift => {
    const f = fixture(); f.stage();
    const mapped = { ...f.ledger, disposition: "mapped" as const,
      completion: "complete" as const, cryptoCompletedAt: new Date(START) };
    const changed = { ...mapped,
      ...(drift === "active" ? { disposition: "active" as const }
        : { completion: "pending" as const }) };
    let reads = 0;
    f.deps.read = async () => ({ status: "found", reservation: {
      intent: f.reservation.intent, ledger: ++reads === 1 ? mapped : changed,
    } });
    f.deps.validateIntent = async input => input.allowTerminalResultAttachment === true;
    expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
      { taskId: TASK, taskRunId: RUN })).toBe("pending");
    expect(f.calls).not.toContain("reconcile");
    expect(f.calls).not.toContain("settle");
  },
);

test("archive-first authority denial prevents publication and settlement", async () => {
  const f = fixture();
  f.deps.withAuthority = async () => null;
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)({ taskId: TASK, taskRunId: RUN })).toBe("pending");
  expect(f.calls).not.toContain("product");
  expect(f.calls).not.toContain("reconcile");
  expect(f.calls).not.toContain("settle");
});

test("archive between phases leaves committed mapping pending without settling custody", async () => {
  const f = fixture();
  const original = f.deps.withAuthority;
  let entries = 0;
  f.deps.withAuthority = operation => ++entries === 1 ? original(operation) : Promise.resolve(null);
  const recover = createProtectedTaskCancellationPublicationRecovery(f.input, f.deps);
  expect(await recover({ taskId: TASK, taskRunId: RUN })).toBe("pending");
  expect(entries).toBe(2);
  expect(f.calls).toContain("map");
  expect(f.calls).not.toContain("settle");
  expect(f.cleanup).toEqual([]);
  f.deps.withAuthority = original;
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
    { taskId: TASK, taskRunId: RUN })).toBe("mapped");
  expect(f.cleanup).toEqual(["released"]);
});

test.each([1, 2])("outer phase %s commit rejection never deletes recipient custody", async phase => {
  const f = fixture();
  f.rejectCommit(phase);
  await rejects(createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
    { taskId: TASK, taskRunId: RUN }), "outer transaction commit rejected");
  expect(f.phase()).toBe(phase);
  expect(f.cleanup).toEqual([]);
  if (phase === 1) expect(f.calls).not.toContain("settle");
  else expect(f.calls).toContain("settle");
});


test.each(["completed", "finished"])("active ledger rejects %s authorization", async state => {
  const f = fixture();
  const record = state === "completed"
    ? { ...f.row, snapshot: completeBackgroundAuthorizationRequest(f.row.snapshot, START + 10), finishedAt: START + 10 }
    : { ...f.row, finishedAt: START + 10 };
  f.deps.authorizationRepository = async () => ({ get: async () => record });
  const recovery = createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)({ taskId: TASK, taskRunId: RUN });
  if (state === "finished") await rejects(recovery, "Finished timestamp/state mismatch");
  else expect(await recovery).toBe("pending");
  expect(f.calls).not.toContain("reconcile");
});

test("exact completed authorization permits mapped replay only", async () => {
  const f = fixture(); f.ledger.disposition = "mapped"; f.ledger.completion = "complete"; f.ledger.cryptoCompletedAt = new Date(START);
  const record = { ...f.row, snapshot: completeBackgroundAuthorizationRequest(f.row.snapshot, START + 10), finishedAt: START + 10 };
  f.deps.authorizationRepository = async () => ({ get: async () => record });
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)({ taskId: TASK, taskRunId: RUN })).toBe("mapped");
  expect(f.calls).not.toContain("product");
});

test.each(["digest", "lease"])("rejects changed %s at product callback after verification", async changed => {
  const f = fixture();
  let reads = 0;
  f.deps.read = async () => {
    reads += 1;
    const ledger = reads < 3 ? f.ledger : { ...f.ledger,
      ...(changed === "digest" ? { requestDigest: new Uint8Array(32).fill(9) }
        : { leaseToken: "10000000-0000-4000-8000-000000000099" }) };
    return { status: "found", reservation: { intent: f.reservation.intent, ledger } };
  };
  await rejects(createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)({ taskId: TASK, taskRunId: RUN }), "authority changed");
  expect(f.calls).not.toContain("product");
  expect(f.calls).not.toContain("settle");
});


async function rejects(operation: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}


test("default reservation reader uses lifecycle metadata and re-reads under held authority", async () => {
  const f = fixture();
  const tables: unknown[] = [];
  const select = () => ({ from: (table: unknown) => {
    tables.push(table);
    const rows = table === taskRunResultCryptoRevisions ? [{ ...f.ledger,
      ...(f.calls.includes("map") ? { disposition: "mapped", completion: "complete",
        cryptoCompletedAt: new Date(START + 90_000) } : {}) }]
      : table === tasks ? [{ ownerId: intent.requesterUserId, requestorId: intent.requesterUserId,
        agentId: intent.agentId, contentNamespaceId: NAMESPACE, contentRepresentation: "protected",
        cancelledAt: intent.terminalAt, status: "cancelled" }]
      : table === protectedTaskRunOutputBindings ? [{ resultRevision: 2,
        resultTerminalAt: intent.terminalAt, resultOperationId: intent.resultOperationId,
        resultObjectId: intent.resultObjectId, acceptedPolicyRevision: intent.policyRevision }] : [];
    return { where: () => ({ limit: () => Promise.resolve(rows) }) };
  } });
  Object.assign(f.transaction, { select });
  const { read: _read, ...deps } = f.deps;
  expect(await createProtectedTaskCancellationPublicationRecovery({ ...f.input,
    db: { select } as unknown as DirectDatabase }, deps)({ taskId: TASK, taskRunId: RUN })).toBe("mapped");
  expect(tables).toEqual(Array.from({ length: 5 }, () => [tasks,
    protectedTaskRunOutputBindings, taskRunResultCryptoRevisions]).flat());
});

test("default reader leaves a fresh stopped Task without binding eligible for preparation", async () => {
  const f = fixture();
  const tables: unknown[] = [];
  const select = () => ({ from: (table: unknown) => {
    tables.push(table);
    const rows = table === tasks ? [{ ownerId: intent.requesterUserId,
      requestorId: intent.requesterUserId, agentId: intent.agentId,
      contentNamespaceId: NAMESPACE, contentRepresentation: "protected",
      cancelledAt: intent.terminalAt, status: "cancelled" }] : [];
    return { where: () => ({ limit: () => Promise.resolve(rows) }) };
  } });
  const { read: _read, ...deps } = f.deps;
  expect(await createProtectedTaskCancellationPublicationRecovery({ ...f.input,
    db: { select } as unknown as DirectDatabase }, deps)({ taskId: TASK, taskRunId: RUN })).toBe("missing");
  expect(tables).toEqual([tasks, protectedTaskRunOutputBindings, taskRunResultCryptoRevisions]);
  expect(f.calls).toEqual([]);
});

test.each(["untouched", "ledger", "crypto", "binding", "operation", "object", "terminal", "attached", "message", "wake", "completed", "policy"])(
  "default reader permits only untouched execution binding without cancellation custody: %s", async scenario => {
    const f = fixture();
    const binding = { taskRunId: RUN, bindingId: protectedTaskRunOutputBindingId(RUN),
      resultRevision: 1, resultOperationId: protectedTaskRunResultOperationId(RUN),
      resultObjectId: protectedTaskRunResultObjectId(TASK, RUN), acceptedPolicyRevision: 5,
      resultTerminalAt: null, resultAttachedAt: null, messageId: null, messagePublishedAt: null,
      wakeJobId: null, wakeScheduledAt: null, completedAt: null };
    const drift: Record<string, unknown> = scenario === "binding" ? { bindingId: "foreign" }
      : scenario === "operation" ? { resultOperationId: "foreign" }
      : scenario === "object" ? { resultObjectId: "foreign" }
      : scenario === "terminal" ? { resultTerminalAt: intent.terminalAt }
      : scenario === "attached" ? { resultAttachedAt: intent.terminalAt }
      : scenario === "message" ? { messageId: 7, messagePublishedAt: intent.terminalAt }
      : scenario === "wake" ? { wakeJobId: "foreign", wakeScheduledAt: intent.terminalAt }
      : scenario === "completed" ? { completedAt: intent.terminalAt }
      : scenario === "policy" ? { acceptedPolicyRevision: 0 } : {};
    const select = () => ({ from: (table: unknown) => {
      const rows = table === tasks ? [{ ownerId: intent.requesterUserId, requestorId: intent.requesterUserId,
        agentId: intent.agentId, contentNamespaceId: NAMESPACE, contentRepresentation: "protected",
        cancelledAt: intent.terminalAt, status: "cancelled" }]
        : table === protectedTaskRunOutputBindings ? [{ ...binding, ...drift }]
        : table === taskRunResultCryptoRevisions && scenario === "ledger" ? [f.ledger] : [];
      return { where: () => ({ limit: () => Promise.resolve(rows) }) };
    } });
    const { read: _read, ...deps } = f.deps;
    f.publication(scenario === "crypto");
    expect(await createProtectedTaskCancellationPublicationRecovery({ ...f.input,
      db: { select } as unknown as DirectDatabase }, deps)({ taskId: TASK, taskRunId: RUN }))
      .toBe(scenario === "untouched" ? "missing" : "pending");
    expect(f.calls).toEqual([]);
  },
);


test.each(["protected", "dual"] as const)("incompatible mode waits and later compatible policy recovers the same %s staged bytes", async representation => {
  const f = fixture();
  f.reservation.intent.representation = representation;
  f.ledger.representation = representation;
  f.stage();
  const originalHash = f.ledger.requestDigest.slice();
  const originalAuthority = f.ledger.authorityFingerprint.slice();
  let mode: "plaintext_only" | "shadow_encryption" | "encrypted_only" = "plaintext_only";
  let revision = 6;
  f.deps.readPolicy = async () => ({ mode, revision, shadowBehavior: "strict",
    shadowEncryptionStartedAt: new Date(START), updatedAt: new Date(START) });
  f.deps.authorizationRepository = async () => ({ get: async () => null });
  const recover = createProtectedTaskCancellationPublicationRecovery(f.input, f.deps);
  expect(await recover({ taskId: TASK, taskRunId: RUN })).toBe("pending");
  mode = representation === "dual" ? "encrypted_only" : "shadow_encryption";
  expect(await recover({ taskId: TASK, taskRunId: RUN })).toBe("pending");
  expect(f.calls).toEqual([]);
  mode = representation === "dual" ? "shadow_encryption" : "encrypted_only"; revision = 7;
  expect(await recover({ taskId: TASK, taskRunId: RUN })).toBe("mapped");
  expect(f.ledger.requestDigest).toEqual(originalHash);
  expect(f.ledger.authorityFingerprint).toEqual(originalAuthority);
  expect(f.reservation.intent.policyRevision).toBe(5);
  expect(f.calls.filter(call => call === "reserve")).toHaveLength(1);
});

test("empty cancellation custody reaches preparation after a compatible policy revision", async () => {
  const f = fixture();
  f.select({ status: "missing", intent: f.reservation.intent });
  const original = await f.deps.readPolicy(database);
  f.deps.readPolicy = async () => ({ ...original, revision: 6 });
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
    { taskId: TASK, taskRunId: RUN })).toBe("missing");
  expect(f.calls).toEqual([]);
});

test("legacy reservation without staged provenance cannot cross a policy revision", async () => {
  const f = fixture();
  const original = await f.deps.readPolicy(database);
  f.deps.readPolicy = async () => ({ ...original, revision: 6 });
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
    { taskId: TASK, taskRunId: RUN })).toBe("pending");
  expect(f.calls).not.toContain("reconcile");
});

test("a policy race while acquiring authority remains pending without reconciliation", async () => {
  const f = fixture(); f.stage();
  const original = await f.deps.readPolicy(database);
  let revision = 5;
  f.deps.readPolicy = async () => ({ ...original, revision });
  f.deps.withAuthority = async () => { revision += 1; return null; };
  expect(await createProtectedTaskCancellationPublicationRecovery(f.input, f.deps)(
    { taskId: TASK, taskRunId: RUN })).toBe("pending");
  expect(f.calls).not.toContain("reserve");
  expect(f.calls).not.toContain("reconcile");
});
