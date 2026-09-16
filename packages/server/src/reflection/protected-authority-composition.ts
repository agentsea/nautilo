import {attachReflectionSemanticRecovery, assertReflectionSemanticRecoverySource} from "./attach-semantic-recovery";
import {createHash, randomUUID} from "node:crypto";
import {actors, and, or, asc, desc, isNull, gt, reflectionRecordSemanticWork, reflectionRecordPublications, reflectionRecordPayloadRepresentations, reflectionRecords, inArray, isNotNull, backgroundCryptoAuthorizationRequests, createPostgresJsBridgeConnection, eq,
  type DirectDatabase, type PostgresJsBridgeConnection} from "@nautilo/db";
import {ClassifiedDataOperationError, classifyDataOperationFailure, fallbackEligible, type DataOperationFailureClass} from "@nautilo/lattice-bridge";
import {LatticeCrypto, ProcessorTransformRecipientRegistry, type ProcessorTransformRecipientAttempt} from "@nautilo/lattice-crypto";
import {decodeAnyBackgroundProcessorWorkDescriptorV2, encodeBackgroundWorkDescriptorV2, REFLECTION_BACKGROUND_MAX_CIPHERTEXT_BYTES_V2,
  REFLECTION_BACKGROUND_MAX_PLAINTEXT_BYTES_V2, REFLECTION_SEMANTIC_MAX_PLAINTEXT_BYTES_V2, REFLECTION_SEMANTIC_MAX_CIPHERTEXT_BYTES_V2, reflectionAuthorityReconciliationFingerprintV2, type BackgroundReflectionWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {PostgresDomainKeyAuthorityRepository, PostgresJournalCryptoTombstoneRepository, PostgresHumanDeviceSignerHistory,
  createPostgresForegroundAgentSignerResolver, verifyConversationProductPostgresHandle,
  createPostgresReflectionAuthorityObjectPort, createPostgresReflectionSemanticObjectPort, withPostgresReflectionSemanticSourcePlan, validatePostgresReflectionSemanticPlan, type ReflectionSemanticOperationPort, cryptoTypedDb, executeTypedCryptoQuery,
  verifyCryptoPostgresHandle, withVerifiedCryptoPostgresTransaction, type CryptoPostgresHandle, withCurrentReflectionAuthority, withPostgresReflectionAuthoritySourcePlan,
  validatePostgresReflectionAuthorityReprojection, validatePostgresReflectionAuthorityRecovery, validatePostgresReflectionSemanticRecovery,
  readPostgresReflectionAuthoritySavedOutput, type WithCurrentProcessorPublicationAuthority} from "@nautilo/lattice-bridge/server";
import {BackgroundAuthorizationProcessorCredentialClaimPort, PostgresBackgroundAuthorizationRepository,
  REFLECTION_SEMANTIC_RUNTIME_POLICY_V1, advanceBackgroundAuthorizationGeneration,
  cancelBackgroundAuthorizationRequest, claimBackgroundAuthorizationRequest, completeBackgroundAuthorizationRequest,
  BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
  createBackgroundAuthorizationRequestV2, prepareProcessorRecipient, BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
  CanonicalRoomNamespaceSourceAuthority, createCanonicalRecordAccessAudience,
  type BackgroundAuthorizationRecord} from "@nautilo/runtime";
import {PostgresAuthorityProjectionStore,
  PostgresRecordProductStore,
  PostgresSemanticWorkStore, createHmacRecordSemanticCommitmentPort,
  createHmacAuthorityProjectionCheckpointPort, readAuthorityReconciliationContinuation, sealedAuthorityReconciliationContinuation,
  reconcileRecordAuthority, verifyRecordProductPostgresHandle,
  type ProtectedAuthorityRepublisherPort, type ClaimedProtectedRecordPublication, type RecordProductPostgresHandle, type RecordProductPostgresExecutor, type ProtectedRecordRetirement} from "@nautilo/reflection-bridge/server";
import type {DurableSleepClaim, DurableSleepReadinessResult} from "@nautilo/reflection/durable";
import {createHumanProductTransactionContext} from "../routes/human-message-product-store";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest();
const unavailable = {status: "unavailable", reason: "authorization_unavailable"} as const;
function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") Object.values(value).forEach(wipe);
}

type SemanticDescriptor = Extract<BackgroundReflectionWorkDescriptorV2, {workKind: "reflection.organization" | "reflection.dependency_rewrite" | "reflection.search_projection"}>;

const semanticWorkId = (workKind: string, recordRef: string, claimGeneration: number) => {
    const digest = hash(["reflection-semantic/v2", workKind, recordRef, claimGeneration]);
    try {return `reflection-semantic:${digest.toString("hex")}`;} finally {digest.fill(0);}
  };
async function obsoleteSemanticWork(product: RecordProductPostgresExecutor, descriptor: SemanticDescriptor): Promise<boolean> {
  const work = reflectionRecordSemanticWork;
  const rows = await executeTypedCryptoQuery(product, cryptoTypedDb.select({generation: work.generation,
    completed_generation: work.completedGeneration, state: work.state}).from(work)
    .where(eq(work.recordId, descriptor.source.recordRef)).limit(2).for("update"));
  const row = rows[0];
  // Missing metadata is not proof that an independently signed object is orphaned.
  return rows.length === 1 && row !== undefined && (row.generation > descriptor.source.claimGeneration
    || row.completed_generation >= descriptor.source.claimGeneration
    || row.generation === descriptor.source.claimGeneration && (row.state === "complete" || row.state === "quarantined"));
}

/** Cancels obsolete work only after the same request lock proves no transform committed. */
export async function settleUnusedReflectionSemanticRequest(input: {
  product: RecordProductPostgresHandle; restricted: CryptoPostgresHandle; requestId: string; now: number;
}): Promise<boolean> {
  const expected = await new PostgresBackgroundAuthorizationRepository(input.restricted).get(input.requestId);
  if (expected?.descriptorBytes == null) {wipe(expected); return false;}
  let descriptor: ReturnType<typeof decodeAnyBackgroundProcessorWorkDescriptorV2> | undefined;
  try {
    descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(expected.descriptorBytes);
    if (!("namespaceRequirements" in descriptor) || descriptor.source.kind !== "reflection_semantic"
      || descriptor.requestId !== expected.snapshot.requestId || descriptor.workId !== expected.snapshot.workId
      || descriptor.workId !== semanticWorkId(descriptor.workKind, descriptor.source.recordRef, descriptor.source.claimGeneration)
      || !["awaiting_recipient", "awaiting_device", "grant_ready", "claimed", "running"].includes(expected.snapshot.state)) return false;
    const semantic = descriptor as SemanticDescriptor;
    return await input.product.transaction(async product => {
      if (!await obsoleteSemanticWork(product, semantic)) return false;
      return withVerifiedCryptoPostgresTransaction(input.restricted, async restricted => {
        const table = backgroundCryptoAuthorizationRequests;
        const markers = await executeTypedCryptoQuery(restricted, cryptoTypedDb.select({
          claim: table.transformCommitClaimId, descriptor: table.transformCommitDescriptorHash,
          generation: table.transformCommitRecipientGeneration, count: table.transformCommitOutputCount, committed: table.transformCommittedAt,
        }).from(table).where(eq(table.requestId, input.requestId)).limit(2).for("update"));
        if (markers.length !== 1 || Object.values(markers[0]!).some(value => value !== null)) return false;
        const repository = new PostgresBackgroundAuthorizationRepository(restricted);
        const current = await repository.get(input.requestId);
        try {
          if (current === null || current.snapshot.requestRevision !== expected.snapshot.requestRevision
            || current.descriptorBytes === null || !Buffer.from(current.descriptorBytes).equals(expected.descriptorBytes!)) return false;
          const result = await repository.compareAndSwap({expectedRequestRevision: current.snapshot.requestRevision,
            next: {...current, snapshot: cancelBackgroundAuthorizationRequest(current.snapshot, "superseded", input.now), finishedAt: input.now}});
          try {return result.status === "updated";} finally {wipe(result);}
        } finally {wipe(current);}
      });
    }, {isolationLevel: "serializable"});
  } finally {wipe(descriptor); wipe(expected);}
}

/** Metadata-only release of a question which has not entered protected execution. */
export async function releaseWaitingReflectionSemanticRequest(input: Readonly<{
  product: RecordProductPostgresHandle; restricted: CryptoPostgresHandle;
  claim: DurableSleepClaim; stage: "organization" | "search_projection";
  failure?: DataOperationFailureClass; now: number;
}>): Promise<readonly {requestId: string; recipientGeneration: number}[] | null> {
  if (input.failure !== undefined && !fallbackEligible(input.failure)) return null;
  const workKind = input.stage === "search_projection" ? "reflection.search_projection"
    : input.claim.changeReason === "dependency_lost" ? "reflection.dependency_rewrite" : "reflection.organization";
  const workId = semanticWorkId(workKind, input.claim.recordRef, input.claim.generation);
  return input.product.transaction(async product => {
    const work = reflectionRecordSemanticWork;
    const current = await executeTypedCryptoQuery(product, cryptoTypedDb.select({recordId: work.recordId}).from(work).where(and(
      eq(work.recordId, input.claim.recordRef), eq(work.generation, input.claim.generation),
      eq(work.claimGeneration, input.claim.generation), eq(work.leaseToken, input.claim.leaseToken),
      eq(work.state, "claimed"), gt(work.leaseExpiresAt, new Date(input.now)),
    )).for("update"));
    if (current.length !== 1) return null;
    return withVerifiedCryptoPostgresTransaction(input.restricted, async restricted => {
      const table = backgroundCryptoAuthorizationRequests;
      const rows = await executeTypedCryptoQuery(restricted, cryptoTypedDb.select({requestId: table.requestId,
        state: table.state, committed: table.transformCommittedAt, commitClaim: table.transformCommitClaimId,
        commitDescriptor: table.transformCommitDescriptorHash, commitGeneration: table.transformCommitRecipientGeneration, commitCount: table.transformCommitOutputCount,
      }).from(table).where(and(eq(table.processorKind, "reflection"), eq(table.workId, workId), or(
        inArray(table.state, ["awaiting_recipient", "awaiting_device", "grant_ready", "claimed", "running", "publication_reconciliation"]),
        isNotNull(table.transformCommittedAt), isNotNull(table.transformCommitClaimId), isNotNull(table.transformCommitDescriptorHash),
        isNotNull(table.transformCommitRecipientGeneration), isNotNull(table.transformCommitOutputCount),
      )))
        .orderBy(asc(table.requestId)).limit(BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH).for("update"));
      if (rows.some(row => [row.transform_committed_at, row.transform_commit_claim_id, row.transform_commit_descriptor_hash,
        row.transform_commit_recipient_generation, row.transform_commit_output_count].some(value => value !== null)
        || !["awaiting_recipient", "awaiting_device", "cancelled"].includes(row.state))) return null;
      const waiting = rows.filter(row => row.state !== "cancelled");
      if (waiting.length === 0 && input.failure === undefined) return null;
      const repository = new PostgresBackgroundAuthorizationRepository(restricted);
      const released: {requestId: string; recipientGeneration: number}[] = [];
      for (const row of waiting) {
        const request = await repository.get(row.request_id);
        try {
          if (request === null || !await repository.cancelUnconsumedProcessorRequest({expected: request, now: input.now, reason: "superseded"})) {
            // All cancellations roll back together; a contested attempt keeps its owner.
            throw new ClassifiedDataOperationError("stale", "Reflection pending grant changed before fallback");
          }
          released.push({requestId: row.request_id, recipientGeneration: request.snapshot.recipientGeneration});
        } finally {wipe(request);}
      }
      // A full page is only progress, never proof that every attempt was unused.
      // Cancelled uncommitted rows leave this scan; the next poll drains the rest.
      return rows.length === BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH ? null : released;
    });
  }, {isolationLevel: "read committed"});
}

/** Settle a lost reply from durable product evidence, not a crypto marker alone. */
export async function readReflectionSemanticSettlement(product: RecordProductPostgresExecutor,
  descriptor: SemanticDescriptor, outputCount: number): Promise<"completed" | "superseded" | "pending"> {
  if (outputCount !== 0 && outputCount !== 1 || outputCount > descriptor.outputSlots.length) return "pending";
  const work = reflectionRecordSemanticWork;
  const [row] = await executeTypedCryptoQuery(product, cryptoTypedDb.select({generation: work.generation,
    completedGeneration: work.completedGeneration, stage: work.stage}).from(work).where(eq(work.recordId, descriptor.source.recordRef)));
  if (row === undefined) return "pending";
  if (outputCount !== 0) {
    if (row.completed_generation < descriptor.source.claimGeneration) return "pending";
    const receipt = reflectionRecordPublications;
    const attached = await executeTypedCryptoQuery(product, cryptoTypedDb.select({publicationId: receipt.publicationId}).from(receipt)
      .where(and(eq(receipt.representation, "protected"), eq(receipt.state, "complete"),
        eq(receipt.cryptoObjectId, descriptor.outputSlots[0]!.objectId))).limit(2));
    return attached.length === 1 ? "completed" : "pending";
  }
  if (row.completed_generation >= descriptor.source.claimGeneration
    || descriptor.workKind === "reflection.search_projection" && row.generation === descriptor.source.claimGeneration && row.stage === "organization") return "completed";
  return row.generation > descriptor.source.claimGeneration ? "superseded" : "pending";
}

/** Old product-attached receipts and their source acknowledgement converge atomically. */
export async function completeAttachedReflectionSemanticPublication(input: Readonly<{
  product: RecordProductPostgresHandle; item: ClaimedProtectedRecordPublication;
  sourceRecordRef: string; claimGeneration: number; commitmentKey: Uint8Array;
}>): Promise<boolean> {
  return input.product.transaction(async tx => {
    const handle = await verifyRecordProductPostgresHandle({query: tx.query.bind(tx), transaction: use => use(tx)});
    const work = new PostgresSemanticWorkStore({handle, commitments: createHmacRecordSemanticCommitmentPort(input.commitmentKey)});
    const store = new PostgresRecordProductStore(handle, work);
    const result = await store.completeProtected({idempotencyKey: input.item.idempotencyKey,
      recordId: input.item.recordId, leaseToken: input.item.leaseToken});
    if (result !== "complete" && result !== "replayed") return false;
    await work.completeVerifiedGeneration({recordRef: input.sourceRecordRef, generation: input.claimGeneration});
    return true;
  }, {isolationLevel: "read committed"});
}

/** Receipt hints select a candidate; only independently verified output ownership authorizes retirement. */
export async function retireObsoleteReflectionSemanticHint(input: {
  product: RecordProductPostgresHandle;
  receipt: {publicationId: string; recordId: string; objectId: string; requestCommitment: Uint8Array};
  verifySavedOutput(): Promise<{originalDescriptor: SemanticDescriptor; binding: {objectId: string}} | null>;
  retire(objectId: string): Promise<void>;
  settleRetiredRequest(requestId: string): Promise<void>;
  now: number;
}): Promise<string | null> {
  const saved = await input.verifySavedOutput();
  if (saved === null) return null;
  try {
    const descriptor = saved.originalDescriptor;
    if (saved.binding.objectId !== input.receipt.objectId || descriptor.outputSlots.length !== 1
      || descriptor.outputSlots[0]!.objectId !== input.receipt.objectId
      || descriptor.workId !== semanticWorkId(descriptor.workKind, descriptor.source.recordRef, descriptor.source.claimGeneration)) return null;
    return await input.product.transaction(async product => {
      if (!await obsoleteSemanticWork(product, descriptor)) return null;
      const representations = reflectionRecordPayloadRepresentations, publications = reflectionRecordPublications;
      const attached = await executeTypedCryptoQuery(product, cryptoTypedDb.select({record_id: representations.recordId}).from(representations)
        .where(eq(representations.cryptoObjectId, input.receipt.objectId)).limit(1));
      if (attached.length !== 0) return null;
      // A hint may point at another receipt's real output. Its canonical owner
      // retains cleanup authority even if that output has no visible head yet.
      const owned = await executeTypedCryptoQuery(product, cryptoTypedDb.select({publication_id: publications.publicationId}).from(publications)
        .where(eq(publications.cryptoObjectId, input.receipt.objectId)).limit(1));
      if (owned.length !== 0) return null;
      const rows = await executeTypedCryptoQuery(product, cryptoTypedDb.select({record_id: publications.recordId,
        hint: publications.reservedCryptoObjectId, object_id: publications.cryptoObjectId, state: publications.state,
        commitment: publications.requestCommitment, retired_at: publications.cryptoRetiredAt}).from(publications)
        .where(eq(publications.publicationId, input.receipt.publicationId)).limit(2).for("update"));
      const row = rows[0];
      if (rows.length !== 1 || row === undefined || row.record_id !== input.receipt.recordId || row.reserved_crypto_object_id !== input.receipt.objectId
        || row.crypto_object_id !== null || row.crypto_retired_at !== null || !["quarantined", "retry_exhausted", "blocked"].includes(row.state)
        || !(row.request_commitment instanceof Uint8Array) || !Buffer.from(row.request_commitment).equals(input.receipt.requestCommitment)) return null;
      await input.retire(input.receipt.objectId);
      // Keep the receipt retryable until the original authorization is terminal.
      await input.settleRetiredRequest(descriptor.requestId);
      await executeTypedCryptoQuery(product, cryptoTypedDb.update(publications).set({cryptoRetiredAt: new Date(input.now), updatedAt: new Date(input.now)})
        .where(eq(publications.publicationId, input.receipt.publicationId)));
      return descriptor.requestId;
    }, {isolationLevel: "serializable"});
  } finally {wipe(saved);}
}

/** Reuses the product owner's retirement fence while its receipt lock stays held across crypto retirement. */
export async function retireReflectionProductReceipt(input: {
  product: RecordProductPostgresHandle; retirement: ProtectedRecordRetirement; retire(objectId: string): Promise<void>;
}): Promise<boolean> {
  const ineligible = new Error("Protected Record retirement is no longer eligible");
  try {
    return await input.product.transaction(async product => {
      // The existing owner takes its advisory and receipt locks in canonical
      // order. Its retirement write stays uncommitted through the checks below.
      const held = await verifyRecordProductPostgresHandle({query: product.query.bind(product), transaction: use => use(product)});
      const result = await new PostgresRecordProductStore(held).completeProtectedRetirement(input.retirement);
      if (result === "conflict") return false;
      const publications = reflectionRecordPublications;
      const rows = await executeTypedCryptoQuery(product, cryptoTypedDb.select({state: publications.state, disposition: reflectionRecords.disposition})
        .from(publications).leftJoin(reflectionRecords, eq(reflectionRecords.recordId, publications.recordId))
        .where(and(eq(publications.publicationId, input.retirement.idempotencyKey), eq(publications.recordId, input.retirement.recordId),
          eq(publications.cryptoObjectId, input.retirement.cryptoObjectId))).limit(2));
      const row = rows[0];
      if (rows.length !== 1 || row === undefined || (row.disposition !== "purged" && !["blocked", "quarantined", "retry_exhausted"].includes(row.state))) throw ineligible;
      const foreign = await executeTypedCryptoQuery(product, cryptoTypedDb.select({record_id: reflectionRecordPayloadRepresentations.recordId})
        .from(reflectionRecordPayloadRepresentations).where(eq(reflectionRecordPayloadRepresentations.cryptoObjectId, input.retirement.cryptoObjectId)).limit(2));
      if (foreign.some(value => value.record_id !== input.retirement.recordId)) throw ineligible;
      // Crypto-then-product failure replays the already signed tombstone safely.
      await input.retire(input.retirement.cryptoObjectId); return true;
    }, {isolationLevel: "serializable"});
  } catch (error) {if (error === ineligible) return false; throw error;}
}

/** Wires the existing semantic worker to Lattice's deterministic authority operation. */
export async function createProductionReflectionAuthorityMaintenance(input: Readonly<{
  db: DirectDatabase; restricted: PostgresJsBridgeConnection; crypto: LatticeCrypto; serverScope: string;
  namespaceReadinessRequested?(coordinate: Readonly<{roomId: string; namespaceId: string}>): Promise<void>;
  commitmentKey: Uint8Array; authorizationRequested?(record: BackgroundAuthorizationRecord): Promise<void>; now?(): number;
}>) {
  const now = input.now ?? Date.now;
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  const productConnection = createPostgresJsBridgeConnection(input.db);
  const productHandle = await verifyRecordProductPostgresHandle(productConnection);
  const projections = new PostgresAuthorityProjectionStore(productHandle);
  const signerHistory = new PostgresHumanDeviceSignerHistory({handle, crypto: input.crypto});
  const foregroundSigner = createPostgresForegroundAgentSignerResolver({
    product: await verifyConversationProductPostgresHandle(productConnection), crypto: input.crypto});
  const commitments = createHmacAuthorityProjectionCheckpointPort(input.commitmentKey);
  const requests = new PostgresBackgroundAuthorizationRepository(handle);
  const recipients = new ProcessorTransformRecipientRegistry({crypto: input.crypto, now});
  const claims = new BackgroundAuthorizationProcessorCredentialClaimPort(requests);
  const domains = new PostgresDomainKeyAuthorityRepository(input.restricted, input.crypto, input.serverScope);
  const tombstones = new PostgresJournalCryptoTombstoneRepository({handle, crypto: input.crypto});
  const shutdown = new AbortController();
  let recoveryCursor: string | undefined;
  let unusedSemanticCursor: string | undefined;
  let completedSemanticCursor: string | undefined;
  let semanticRetirementCursor: string | undefined;
  const waiting = (): DurableSleepReadinessResult => ({status: "waiting",
    retryAt: now() + REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.scanIntervalMilliseconds});

  const withCurrentAuthority: WithCurrentProcessorPublicationAuthority = async ({context, signal, use}) => {
    if (!("namespaceRequirements" in context.descriptor)) return null;
    const [human] = await input.db.select({ownerId: actors.ownerId}).from(actors)
      .where(and(eq(actors.id, context.issuer.humanId), eq(actors.kind, "user"))).limit(1);
    if (human?.ownerId === null || human?.ownerId === undefined) return null;
    const product = await createHumanProductTransactionContext(human.ownerId, input.db);
    const descriptor = context.descriptor;
    return withCurrentReflectionAuthority({runner: product.canonicalRunner, restricted: input.restricted,
      crypto: input.crypto, serverScope: input.serverScope, descriptor, issuer: context.issuer, now,
      ...(signal === undefined ? {} : {signal}),
      validateProduct: async connection => descriptor.workKind === "reflection.publication_reconcile"
        ? await validatePostgresReflectionAuthorityRecovery({product: connection, restricted: input.restricted, crypto: input.crypto, descriptorB: descriptor})
          || await validatePostgresReflectionSemanticRecovery({product: connection, restricted: input.restricted, crypto: input.crypto, descriptorB: descriptor})
        : descriptor.source.kind === "reflection_semantic"
          ? validatePostgresReflectionSemanticPlan({product: connection, restricted: input.restricted, crypto: input.crypto, descriptor})
          : validatePostgresReflectionAuthorityReprojection({product: connection, restricted: input.restricted, crypto: input.crypto, descriptor}),
      use: (authority, connection, restricted) => use({executor: restricted, product: connection,
        issuerSigningPublicKey: authority.device.signingPublicKey, ordinarySiblingAllowed: authority.ordinarySiblingAllowed})});
  };
  const retire = async (objectId: string, signal: AbortSignal) => {
    await tombstones.tombstoneObjects({objectIds: [objectId], signal});
  };
  const retryExpired = async (record: BackgroundAuthorizationRecord) => {
    const at = now();
    const next = {...record, snapshot: advanceBackgroundAuthorizationGeneration(record.snapshot,
      {reason: "attempt_expired", now: at, nextAttemptAt: at}), descriptorBytes: null, acceptedMaterial: null};
    const result = await requests.compareAndSwap({expectedRequestRevision: record.snapshot.requestRevision, next});
    try {
      if (result.status === "updated") recipients.delete(record.snapshot.requestId, record.snapshot.recipientGeneration);
      return {status: result.status === "updated" ? "retry_scheduled" : "stale"} as const;
    } finally {wipe(result);}
  };

  const finishRequest = async (requestId: string): Promise<boolean> => {
    const latest = await requests.get(requestId);
    if (latest === null) return false;
    try {
      if (latest.snapshot.state === "completed") return true;
      if (latest.snapshot.state !== "running" && latest.snapshot.state !== "publication_reconciliation") return false;
      const result = await requests.compareAndSwap({expectedRequestRevision: latest.snapshot.requestRevision,
        next: {...latest, snapshot: completeBackgroundAuthorizationRequest(latest.snapshot, now()), finishedAt: now()}});
      try {
        if (result.status === "updated") {recipients.delete(requestId, latest.snapshot.recipientGeneration); return true;}
        const after = await requests.get(requestId);
        try {return after?.snapshot.state === "completed";} finally {wipe(after);}
      } finally {wipe(result);}
    } finally {wipe(latest);}
  };

  const cancelCommittedRequest = async (requestId: string): Promise<boolean> => {
    const current = await requests.get(requestId);
    if (current === null) return false;
    try {
      if (current.snapshot.state === "cancelled") return true;
      if (!["running", "publication_reconciliation"].includes(current.snapshot.state)) return false;
      const result = await requests.compareAndSwap({expectedRequestRevision: current.snapshot.requestRevision,
        next: {...current, snapshot: cancelBackgroundAuthorizationRequest(current.snapshot, "superseded", now()), finishedAt: now()}});
      try {if (result.status !== "updated") return false;
        recipients.delete(requestId, current.snapshot.recipientGeneration); return true;
      } finally {wipe(result);}
    } finally {wipe(current);}
  };

  const prepareExactRequest = async (operation: Readonly<{
    workId: string; identity: Buffer; policyRevision: number;
    namespaceRequirements: BackgroundReflectionWorkDescriptorV2["namespaceRequirements"];
    workKind: BackgroundReflectionWorkDescriptorV2["workKind"];
    purpose: BackgroundReflectionWorkDescriptorV2["purpose"];
    createDescriptor(record: BackgroundAuthorizationRecord, attempt: ProcessorTransformRecipientAttempt,
      requestId: string, anchor: BackgroundReflectionWorkDescriptorV2["namespaceRequirements"][number]["authority"]): Promise<BackgroundReflectionWorkDescriptorV2>;
  }>, signal: AbortSignal) => {
    const {workId, identity, policyRevision, namespaceRequirements} = operation;
        const requestId = `reflection:${identity.toString("hex")}`;
        const anchor = namespaceRequirements[0]!.authority;
        let existing = await requests.get(requestId);
        if (existing === null) {
        try { existing = (await requests.create({
          snapshot: createBackgroundAuthorizationRequestV2({requestId, workId, namespaceId: anchor.namespaceId,
            credentialSubject: {kind: "processor", processorKind: "reflection", processorVersion: 1}, now: now()}),
          workIdentityHash: identity, idempotencyKey: requestId,
          workKind: operation.workKind,
          purpose: operation.purpose,
          domainId: anchor.domainId, processorAuthorizationRevision: null, expectedDomainEpoch: null,
          expectedNamespaceAccessRevision: anchor.namespaceAccessRevision, expectedPolicyRevision: policyRevision,
          descriptorBytes: null, acceptedMaterial: null, finishedAt: null,
        })).record;
        } catch (error) {
          // Another worker can prepare the same immutable work identity first.
          existing = await requests.get(requestId);
          if (existing === null) throw error;
        }
        }
        if (!Buffer.from(existing.workIdentityHash).equals(identity)) {
          wipe(existing); identity.fill(0);
          throw new Error("Reflection authorization work identity conflict");
        }
        identity.fill(0);
        try {
        // Supersede unconsumed descriptions for this same product work after
        // policy or signed authority changes; live execution stays fenced.
        let olderCursor: string | undefined;
        for (;;) {
        signal.throwIfAborted();
        const older = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({request_id: backgroundCryptoAuthorizationRequests.requestId})
          .from(backgroundCryptoAuthorizationRequests).where(and(eq(backgroundCryptoAuthorizationRequests.workId, workId),
            eq(backgroundCryptoAuthorizationRequests.processorKind, "reflection"),
            ...(olderCursor === undefined ? [] : [gt(backgroundCryptoAuthorizationRequests.requestId, olderCursor)]),
            inArray(backgroundCryptoAuthorizationRequests.state, ["awaiting_recipient", "awaiting_device", "grant_ready"])))
          .orderBy(asc(backgroundCryptoAuthorizationRequests.requestId)).limit(BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH));
        for (const row of older) {
          if (row.request_id === requestId) continue;
          const old = await requests.get(row.request_id);
          if (old === null) continue;
          try {
            if (!["awaiting_recipient", "awaiting_device", "grant_ready"].includes(old.snapshot.state)) continue;
            if (await requests.cancelUnconsumedProcessorRequest({expected: old, now: now(), reason: "superseded"})) {
              recipients.delete(old.snapshot.requestId, old.snapshot.recipientGeneration);
            }
          } finally {wipe(old);}
        }
        if (older.length < BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH) break;
        olderCursor = older.at(-1)!.request_id;
        }
        if (["cancelled", "terminal_failure", "completed"].includes(existing.snapshot.state)) {
          throw new ClassifiedDataOperationError("unsupported", "Reflection authorization is terminal");
        }
        let current = existing;
        if (current.snapshot.recipient !== null && now() >= current.snapshot.recipient.expiresAt
          && ["grant_ready", "claimed", "running"].includes(current.snapshot.state)) {
          await retryExpired(current);
          current = (await requests.get(requestId))!;
          wipe(existing); existing = current;
        }
        await prepareProcessorRecipient(requestId, {repository: requests, recipients, now, retryExpired,
          recipientKeyId: record => `reflection-recipient:${record.snapshot.requestId.slice("reflection:".length)}:${record.snapshot.recipientGeneration}`,
          ...(input.authorizationRequested === undefined ? {} : {authorizationRequested: input.authorizationRequested}),
          descriptors: {create: async ({record, attempt}) => {
            const descriptor = await operation.createDescriptor(record, attempt, requestId, anchor);
            const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
            return {descriptorBytes, descriptorHash: input.crypto.hash(descriptorBytes)};
          }}});
        return await requests.get(requestId);
        } finally {wipe(existing);}
  };

  const reproject = async (request: Parameters<ProtectedAuthorityRepublisherPort["republishExact"]>[0], signal: AbortSignal):
    ReturnType<ProtectedAuthorityRepublisherPort["republishExact"]> => {
    signal.throwIfAborted();
    const workDigest = hash(["reflection-authority/v2", request.recordRef, request.sourceChangeGeneration,
      request.expectedProjectionGeneration, request.expectedRepresentationGeneration, request.targetRepresentationGeneration]);
    const workId = `reflection-authority:${workDigest.toString("hex")}`;
    const objectId = `${workId}:record`;
    workDigest.fill(0);
    const saved = await readPostgresReflectionAuthoritySavedOutput({handle, crypto: input.crypto, objectId});
    try {
    const prepared = await withPostgresReflectionAuthoritySourcePlan({db: input.db, restricted: input.restricted,
      crypto: input.crypto, serverScope: input.serverScope,
      ...(input.namespaceReadinessRequested === undefined ? {} : {namespaceReadinessRequested: input.namespaceReadinessRequested}),
      coordinates: {...request, exactAccessNamespaceIds: [...request.exactAccessNamespaceIds].sort()},
      use: async ({plan, namespaces: currentNamespaces, policyRevision, product}) => {
        signal.throwIfAborted();
        const namespaces = saved === null ? currentNamespaces
          : currentNamespaces.filter(authority => saved.binding.namespaceEnvelopes.some(entry => entry.namespaceId === authority.namespaceId));
        const namespaceRequirements = namespaces.map(authority => ({authority,
          operations: [ ...(saved !== null || authority.namespaceId === plan.sourceNamespaceId ? ["decrypt" as const] : []),
            ...(saved === null && plan.exactAccessNamespaceIds.includes(authority.namespaceId) ? ["encrypt" as const] : []) ]}));
        const fingerprint = saved === null ? plan.fingerprint : reflectionAuthorityReconciliationFingerprintV2(input.crypto, saved.binding);
        const identity = hash([workId, saved === null ? "reproject" : "reconcile", Array.from(fingerprint), policyRevision, namespaceRequirements]);
        return prepareExactRequest({workId, identity, policyRevision, namespaceRequirements,
          workKind: saved === null ? "reflection.authority_reproject" : "reflection.publication_reconcile",
          purpose: saved === null ? "record.reproject" : "record.reconcile",
          createDescriptor: async (record, attempt, requestId, anchor) => {
            const descriptor: BackgroundReflectionWorkDescriptorV2 = {
              formatVersion: 2, requestId, workId,
              recipientGeneration: attempt.recipientGeneration, anchorNamespaceId: anchor.namespaceId, anchorDomainId: anchor.domainId,
              subject: {kind: "processor", processorKind: "reflection", processorVersion: 1},
              namespaceRequirements, policyRevision,
              ...(saved === null ? {
                workKind: "reflection.authority_reproject" as const, purpose: "record.reproject" as const,
                operations: ["decrypt", "encrypt"] as const,
                source: {kind: "reflection_authority" as const, recordRef: request.recordRef, sourceChangeGeneration: request.sourceChangeGeneration,
                  projectionGeneration: request.expectedProjectionGeneration, expectedRepresentationGeneration: request.expectedRepresentationGeneration,
                  targetRepresentationGeneration: request.targetRepresentationGeneration, fingerprint},
                inputBindings: [{objectId: plan.sourceObjectId, namespaceId: plan.sourceNamespaceId}],
                outputSlots: [{objectId, objectType: "nautilo.reflection.record.v1" as const, createdAt: record.snapshot.createdAt,
                  namespaceIds: plan.exactAccessNamespaceIds}],
              } : {
                workKind: "reflection.publication_reconcile" as const, purpose: "record.reconcile" as const,
                operations: ["decrypt"] as const,
                source: {kind: "reflection_publication" as const, publicationId: saved.binding.publicationId,
                  recordRef: saved.binding.recordRef, representationGeneration: saved.binding.representationGeneration, fingerprint},
                inputBindings: saved.binding.namespaceEnvelopes.map(entry => ({objectId, namespaceId: entry.namespaceId})),
                outputSlots: [],
              }),
              maximumPlaintextBytes: REFLECTION_BACKGROUND_MAX_PLAINTEXT_BYTES_V2,
              maximumCiphertextBytes: REFLECTION_BACKGROUND_MAX_CIPHERTEXT_BYTES_V2,
              recipientKeyId: attempt.recipientKeyId, recipientPublicKey: attempt.recipientPublicKey,
              issuedAt: now(), notBefore: now(), expiresAt: attempt.expiresAt, idempotencyId: record.idempotencyKey,
            };
            if (saved !== null && !await validatePostgresReflectionAuthorityRecovery({product, restricted: input.restricted,
              crypto: input.crypto, descriptorB: descriptor})) throw new Error("Reflection saved output is stale");
            return descriptor;
          }}, signal);
      }});
    try {
    if (prepared === null || prepared.acceptedMaterial === null || prepared.snapshot.state !== "grant_ready"
      || prepared.snapshot.recipient === null || !recipients.hasAttempt({requestId: prepared.snapshot.requestId,
        recipientGeneration: prepared.snapshot.recipientGeneration, recipientKeyId: prepared.snapshot.recipient.recipientKeyId})) return unavailable;
    const at = now();
    const deadline = Math.min(prepared.snapshot.recipient.expiresAt,
      at + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS);
    if (deadline <= at) return unavailable;
    const claimId = randomUUID();
    const claimed = await requests.compareAndSwap({expectedRequestRevision: prepared.snapshot.requestRevision,
      next: {...prepared, snapshot: claimBackgroundAuthorizationRequest(prepared.snapshot, claimId, at, deadline)}});
    const claimUpdated = claimed.status === "updated";
    wipe(claimed);
    if (!claimUpdated) return unavailable;
    let attachment: "applied" | "stale" | "blocked" | undefined;
    const storage = createPostgresReflectionAuthorityObjectPort({handle, crypto: input.crypto,
      responseBytes: prepared.acceptedMaterial.responseBytes, claimId, domainKeys: domains, withCurrentAuthority,
      attach: async operation => {
        if (operation.held.product === undefined) throw new Error("Reflection attachment requires held product authority");
        const connection = operation.held.product;
        const bound = await verifyRecordProductPostgresHandle({query: connection.query.bind(connection),
          transaction: use => use(connection)});
        attachment = await request.attach({cryptoObjectId: operation.objectId, authorizeCommit: operation.authorizeCommit,
          projections: new PostgresAuthorityProjectionStore(bound)});
      }});
    try {
      const result = await recipients.runCurrentReflectionAuthority({requestId: prepared.snapshot.requestId,
        recipientGeneration: prepared.snapshot.recipientGeneration, recipientKeyId: prepared.snapshot.recipient.recipientKeyId,
        claimId, responseBytes: prepared.acceptedMaterial.responseBytes, claims, reflectionObjects: storage.objects,
        resolveCurrentIssuer: storage.resolveCurrentIssuer, signal, deadlineAt: deadline,
        ...(saved === null ? {} : {reconciliationBinding: saved.binding})});
      if (result.status !== "executed" || attachment === undefined) return unavailable;
      if (attachment !== "applied") return {status: "published", cryptoObjectId: objectId, attachment};
      if (!await finishRequest(prepared.snapshot.requestId)) return unavailable;
      if (saved !== null && !await finishRequest(saved.originalDescriptor.requestId)) return unavailable;
      return {status: "published", cryptoObjectId: objectId, attachment};
    } finally {storage.dispose();}
    } finally {wipe(prepared);}
    } finally {wipe(saved);}
  };

  const readPendingInputBindings: NonNullable<ReflectionSemanticOperationPort["readPendingInputBindings"]> = async operation => {
    operation.signal?.throwIfAborted();
    const table = backgroundCryptoAuthorizationRequests;
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({descriptorBytes: table.descriptorBytes}).from(table)
      .where(and(eq(table.workId, semanticWorkId(operation.workKind, operation.recordRef, operation.claimGeneration)),
        eq(table.processorKind, "reflection"), isNotNull(table.descriptorBytes), isNull(table.transformCommittedAt)))
      .orderBy(desc(table.createdAt), desc(table.requestId)).limit(1));
    operation.signal?.throwIfAborted();
    const bytes = rows[0]?.descriptor_bytes;
    if (!(bytes instanceof Uint8Array)) return [];
    const descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(bytes);
    try {
      if (!("namespaceRequirements" in descriptor) || (descriptor.workKind !== "reflection.search_projection" && descriptor.workKind !== "reflection.organization" && descriptor.workKind !== "reflection.dependency_rewrite")
        || descriptor.workKind !== operation.workKind || descriptor.source.recordRef !== operation.recordRef
        || descriptor.source.claimGeneration !== operation.claimGeneration) return [];
      return descriptor.inputBindings.map(binding => ({...binding}));
    } finally {wipe(descriptor);}
  };

  const runSemantic: ReflectionSemanticOperationPort["runSemantic"] = async operation => {
    const signal = operation.signal === undefined ? shutdown.signal : AbortSignal.any([operation.signal, shutdown.signal]);
    signal.throwIfAborted();
    const coordinates = {...operation.coordinates, workKind: operation.workKind};
    const workId = semanticWorkId(operation.workKind, coordinates.recordRef, coordinates.claimGeneration);
    const objectId = coordinates.outputNamespaceIds.length === 0 ? undefined : `${workId}:record`;
    // A persisted model result belongs to output recovery. Never call the model
    // again merely because the product attachment or request reply was lost.
    const table = backgroundCryptoAuthorizationRequests;
    const saved = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({requestId: table.requestId,
      outputCount: table.transformCommitOutputCount, claimExpiresAt: table.claimExpiresAt,
    }).from(table).where(and(eq(table.workId, workId), eq(table.processorKind, "reflection"), isNotNull(table.transformCommittedAt)))
      .orderBy(desc(table.transformCommitOutputCount), desc(table.createdAt), desc(table.requestId)).limit(1));
    const committed = saved[0];
    // A saved object is replayed by publication recovery. A zero-output marker
    // alone is not a product receipt: the separate product transaction may have
    // rolled back. After its lease ends, a still-incomplete source can request
    // a fresh attempt; there is no durable model output to regenerate.
    let abandonedEmptyRequest: string | undefined;
    if (committed !== undefined) {
      if (committed.transform_commit_output_count !== 0) return {status: "reconciliation_required"};
      const rows = await executeTypedCryptoQuery(productHandle, cryptoTypedDb.select({
        completedGeneration: reflectionRecordSemanticWork.completedGeneration,
      }).from(reflectionRecordSemanticWork).where(eq(reflectionRecordSemanticWork.recordId, coordinates.recordRef)));
      if ((rows[0]?.completed_generation ?? 0) >= coordinates.claimGeneration) {
        await finishRequest(committed.request_id); return {status: "executed"};
      }
      if (committed.claim_expires_at !== null && new Date(committed.claim_expires_at).getTime() > now()) return {status: "waiting"};
      if (!await cancelCommittedRequest(committed.request_id)) return {status: "waiting"};
      abandonedEmptyRequest = committed.request_id;
    }
    const kind = operation.workKind === "reflection.search_projection"
      ? {workKind: "reflection.search_projection", purpose: "record.search_projection"} as const
      : operation.workKind === "reflection.organization"
        ? {workKind: "reflection.organization", purpose: "record.organize"} as const
        : {workKind: "reflection.dependency_rewrite", purpose: "record.dependency_rewrite"} as const;
    const prepared = await withPostgresReflectionSemanticSourcePlan({
      db: input.db, restricted: input.restricted, crypto: input.crypto, serverScope: input.serverScope, coordinates, reportKeyWait: true,
      ...(input.namespaceReadinessRequested === undefined ? {} : {namespaceReadinessRequested: input.namespaceReadinessRequested}),
      use: async ({plan, namespaces, policyRevision}) => {
        const namespaceRequirements = namespaces.map(authority => ({authority, operations: [
          ...(coordinates.inputBindings.some(binding => binding.namespaceId === authority.namespaceId) ? ["decrypt" as const] : []),
          ...(coordinates.outputNamespaceIds.includes(authority.namespaceId) ? ["encrypt" as const] : []),
        ]}));
        const identity = hash([workId, Array.from(plan.fingerprint), policyRevision, namespaceRequirements,
          ...(abandonedEmptyRequest === undefined ? [] : ["uncommitted-empty-retry", abandonedEmptyRequest])]);
        return prepareExactRequest({workId, identity, policyRevision, namespaceRequirements, ...kind,
          createDescriptor: (record, attempt, requestId, anchor) => Promise.resolve({
            formatVersion: 2, requestId, workId,
            ...kind,
            recipientGeneration: attempt.recipientGeneration, anchorNamespaceId: anchor.namespaceId, anchorDomainId: anchor.domainId,
            subject: {kind: "processor", processorKind: "reflection", processorVersion: 1},
            namespaceRequirements, policyRevision,
            operations: objectId === undefined ? ["decrypt"] : ["decrypt", "encrypt"],
            source: {kind: "reflection_semantic", recordRef: coordinates.recordRef, claimGeneration: coordinates.claimGeneration,
              fingerprint: plan.fingerprint},
            inputBindings: coordinates.inputBindings,
            outputSlots: objectId === undefined ? [] : [{objectId, objectType: "nautilo.reflection.record.v1", createdAt: record.snapshot.createdAt,
              namespaceIds: coordinates.outputNamespaceIds}],
            maximumPlaintextBytes: REFLECTION_SEMANTIC_MAX_PLAINTEXT_BYTES_V2,
            maximumCiphertextBytes: REFLECTION_SEMANTIC_MAX_CIPHERTEXT_BYTES_V2,
            recipientKeyId: attempt.recipientKeyId, recipientPublicKey: attempt.recipientPublicKey,
            issuedAt: now(), notBefore: now(), expiresAt: attempt.expiresAt, idempotencyId: record.idempotencyKey,
          }),
        }, signal);
      },
    });
    try {
      if (prepared === null || prepared.acceptedMaterial === null || prepared.snapshot.state !== "grant_ready"
        || prepared.snapshot.recipient === null || !recipients.hasAttempt({requestId: prepared.snapshot.requestId,
          recipientGeneration: prepared.snapshot.recipientGeneration, recipientKeyId: prepared.snapshot.recipient.recipientKeyId})) return {status: "waiting"};
      const at = now();
      const deadline = Math.min(prepared.snapshot.recipient.expiresAt, at + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS);
      if (deadline <= at) return {status: "waiting"};
      const claimId = randomUUID();
      const claimed = await requests.compareAndSwap({expectedRequestRevision: prepared.snapshot.requestRevision,
        next: {...prepared, snapshot: claimBackgroundAuthorizationRequest(prepared.snapshot, claimId, at, deadline)}});
      const updated = claimed.status === "updated";
      wipe(claimed);
      if (!updated) return {status: "waiting"};
      const storage = createPostgresReflectionSemanticObjectPort({handle, crypto: input.crypto,
        responseBytes: prepared.acceptedMaterial.responseBytes, claimId, domainKeys: domains, withCurrentAuthority,
        resolveHistoricalAgentSignerAuthority: signerHistory.resolveAgentRuntimeSignerManager,
        resolveLiveShadowAgentSigner: foregroundSigner,
        validateInput: operation.validateInput, validateOutput: operation.validateOutput, attach: operation.attach});
      try {
        const result = await recipients.runCurrentReflectionSemantic({requestId: prepared.snapshot.requestId,
          recipientGeneration: prepared.snapshot.recipientGeneration, recipientKeyId: prepared.snapshot.recipient.recipientKeyId,
          claimId, responseBytes: prepared.acceptedMaterial.responseBytes, claims, semanticObjects: storage.objects,
          resolveCurrentIssuer: storage.resolveCurrentIssuer, signal, deadlineAt: deadline,
          execute: (opened, executionSignal, assertCurrent) => operation.execute(opened, objectId, executionSignal, assertCurrent)});
        if (result.status !== "executed") return {status: "waiting"};
        return {status: await finishRequest(prepared.snapshot.requestId) ? "executed" : "reconciliation_required"};
      } finally {storage.dispose();}
    } finally {
      const requestId = prepared?.snapshot.requestId;
      wipe(prepared);
      if (requestId !== undefined) try {await settleUnusedSemantic(requestId);} catch (error) {
        console.warn("[reflection] closed semantic request settlement failed", {failureClass: classifyDataOperationFailure(error)});
      }
    }
  };

  const settleAttachedRequests = async (recordRef: string, sourceChangeGeneration: number) => {
    const receipt = await projections.readProtectedReconciliation({recordRef, sourceChangeGeneration});
    if (receipt?.state !== "complete" || receipt.targetRepresentationGeneration === null || receipt.targetCryptoObjectId === null) return;
    const digest = hash(["reflection-authority/v2", recordRef, sourceChangeGeneration,
      receipt.expectedProjectionGeneration, receipt.targetRepresentationGeneration - 1, receipt.targetRepresentationGeneration]);
    const workId = `reflection-authority:${digest.toString("hex")}`;
    digest.fill(0);
    if (receipt.targetCryptoObjectId !== `${workId}:record`) return;
    const table = backgroundCryptoAuthorizationRequests;
    let cursor: string | undefined;
    for (;;) {
    shutdown.signal.throwIfAborted();
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({request_id: table.requestId}).from(table)
      .where(and(...(cursor === undefined ? [] : [gt(table.requestId, cursor)]), eq(table.workId, workId), eq(table.processorKind, "reflection"),
        inArray(table.state, ["running", "publication_reconciliation"])))
      .orderBy(asc(table.requestId)).limit(BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH));
    for (const row of rows) await finishRequest(row.request_id);
    if (rows.length < BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH) break;
    cursor = rows.at(-1)!.request_id;
    }
  };

  const recoverSavedPage = async (limit: number, signal: AbortSignal) => {
    const table = backgroundCryptoAuthorizationRequests;
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({request_id: table.requestId}).from(table)
      .where(and(eq(table.processorKind, "reflection"), eq(table.workKind, "reflection.authority_reproject"),
        or(and(isNotNull(table.transformCommittedAt), inArray(table.state, ["running", "publication_reconciliation", "cancelled", "terminal_failure"])),
          inArray(table.state, ["awaiting_recipient", "awaiting_device", "grant_ready"])),
        ...(recoveryCursor === undefined ? [] : [gt(table.requestId, recoveryCursor)])))
      .orderBy(asc(table.requestId)).limit(limit));
    recoveryCursor = rows.length === limit ? rows.at(-1)!.request_id : undefined;
    for (const row of rows) {
      signal.throwIfAborted();
      let record: BackgroundAuthorizationRecord | null = null;
      let descriptor: ReturnType<typeof decodeAnyBackgroundProcessorWorkDescriptorV2> | undefined;
      try {
      record = await requests.get(row.request_id);
      if (record?.descriptorBytes == null) continue;
      descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(record.descriptorBytes);
        if (!("namespaceRequirements" in descriptor) || descriptor.workKind !== "reflection.authority_reproject") continue;
        const receipt = await projections.readProtectedReconciliation({recordRef: descriptor.source.recordRef,
          sourceChangeGeneration: descriptor.source.sourceChangeGeneration});
        if (receipt?.state === "complete" && receipt.targetCryptoObjectId === descriptor.outputSlots[0]!.objectId) {
          await finishRequest(row.request_id); continue;
        }
        if (receipt?.state === "quarantined"
          && ["awaiting_recipient", "awaiting_device", "grant_ready"].includes(record.snapshot.state)) {
          if (await requests.cancelUnconsumedProcessorRequest({expected: record, now: now(), reason: "superseded"})) {
            recipients.delete(row.request_id, record.snapshot.recipientGeneration);
          }
          continue;
        }
        if (receipt?.state === "quarantined" && receipt.targetCryptoRetiredAt !== null) {
          if (record.snapshot.state === "running" || record.snapshot.state === "publication_reconciliation") {
            const cancelled = await requests.compareAndSwap({expectedRequestRevision: record.snapshot.requestRevision,
              next: {...record, snapshot: cancelBackgroundAuthorizationRequest(record.snapshot, "superseded", now()), finishedAt: now()}});
            if (cancelled.status === "updated") recipients.delete(row.request_id, record.snapshot.recipientGeneration);
          }
          continue;
        }
        const saved = await readPostgresReflectionAuthoritySavedOutput({handle, crypto: input.crypto, objectId: descriptor.outputSlots[0]!.objectId});
        try {
          if (saved !== null) await projections.quarantineUnattachedProtectedTarget({
            recordRef: saved.binding.recordRef, sourceChangeGeneration: saved.binding.sourceChangeGeneration,
            expectedProjectionGeneration: saved.binding.expectedProjectionGeneration,
            targetRepresentationGeneration: saved.binding.representationGeneration, targetCryptoObjectId: saved.binding.objectId,
          });
        } finally {wipe(saved);}
      } catch (error) {
        signal.throwIfAborted();
        console.warn("[reflection] saved authority recovery failed", {failureClass: classifyDataOperationFailure(error)});
      } finally {wipe(descriptor); wipe(record);}
    }
  };

  const publicationReceipts = new PostgresRecordProductStore(productHandle);
  const settleUnusedSemantic = async (requestId: string) => {
    if (await settleUnusedReflectionSemanticRequest({product: productHandle, restricted: handle, requestId, now: now()})) {
      const current = await requests.get(requestId);
      try {if (current !== null) recipients.delete(requestId, current.snapshot.recipientGeneration);} finally {wipe(current);}
    }
  };
  const settleUnusedSemanticPage = async (limit: number, signal: AbortSignal) => {
    const table = backgroundCryptoAuthorizationRequests;
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({request_id: table.requestId}).from(table)
      .where(and(eq(table.processorKind, "reflection"), inArray(table.workKind, ["reflection.organization", "reflection.dependency_rewrite", "reflection.search_projection"]),
        inArray(table.state, ["awaiting_device", "grant_ready", "claimed", "running"]), isNull(table.transformCommittedAt),
        ...(unusedSemanticCursor === undefined ? [] : [gt(table.requestId, unusedSemanticCursor)])))
      .orderBy(asc(table.requestId)).limit(limit));
    unusedSemanticCursor = rows.length === limit ? rows.at(-1)!.request_id : undefined;
    for (const row of rows) {
      signal.throwIfAborted();
      try {await settleUnusedSemantic(row.request_id);} catch (error) {
        signal.throwIfAborted(); console.warn("[reflection] unused semantic request settlement failed", {failureClass: classifyDataOperationFailure(error)});
      }
    }
  };
  const settleCompletedSemanticPage = async (limit: number, signal: AbortSignal) => {
    const table = backgroundCryptoAuthorizationRequests;
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({requestId: table.requestId, descriptorBytes: table.descriptorBytes, outputCount: table.transformCommitOutputCount})
      .from(table).where(and(eq(table.processorKind, "reflection"),
        inArray(table.workKind, ["reflection.organization", "reflection.dependency_rewrite", "reflection.search_projection"]),
        inArray(table.state, ["running", "publication_reconciliation"]), isNotNull(table.transformCommittedAt),
        ...(completedSemanticCursor === undefined ? [] : [gt(table.requestId, completedSemanticCursor)])))
      .orderBy(asc(table.requestId)).limit(limit));
    completedSemanticCursor = rows.length === limit ? rows.at(-1)!.request_id : undefined;
    for (const row of rows) {
      signal.throwIfAborted();
      if (!(row.descriptor_bytes instanceof Uint8Array)) continue;
      let descriptor: ReturnType<typeof decodeAnyBackgroundProcessorWorkDescriptorV2> | undefined;
      try {
        descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(row.descriptor_bytes);
        if (!("namespaceRequirements" in descriptor)
          || (descriptor.workKind !== "reflection.search_projection" && descriptor.workKind !== "reflection.organization" && descriptor.workKind !== "reflection.dependency_rewrite")
          || descriptor.requestId !== row.request_id) continue;
        const settlement = await readReflectionSemanticSettlement(productHandle, descriptor, row.transform_commit_output_count ?? -1);
        if (settlement === "completed") await finishRequest(row.request_id);
        else if (settlement === "superseded") await cancelCommittedRequest(row.request_id);
      } catch (error) {
        signal.throwIfAborted(); console.warn("[reflection] completed semantic request settlement failed", {failureClass: classifyDataOperationFailure(error)});
      } finally {wipe(descriptor);}
    }
  };
  const retireSemanticHintsPage = async (limit: number, signal: AbortSignal) => {
    const table = reflectionRecordPublications;
    const rows = await executeTypedCryptoQuery(productHandle, cryptoTypedDb.select({publication_id: table.publicationId, record_id: table.recordId,
      object_id: table.reservedCryptoObjectId, commitment: table.requestCommitment}).from(table)
      .where(and(eq(table.representation, "protected"), inArray(table.state, ["blocked", "quarantined", "retry_exhausted"]),
        isNull(table.cryptoObjectId), isNotNull(table.reservedCryptoObjectId), isNull(table.cryptoRetiredAt),
        ...(semanticRetirementCursor === undefined ? [] : [gt(table.publicationId, semanticRetirementCursor)])))
      .orderBy(asc(table.publicationId)).limit(limit));
    semanticRetirementCursor = rows.length === limit ? rows.at(-1)!.publication_id : undefined;
    for (const row of rows) {
      signal.throwIfAborted();
      try {
        if (row.reserved_crypto_object_id === null || !(row.request_commitment instanceof Uint8Array)) continue;
        const objectId = row.reserved_crypto_object_id;
        await retireObsoleteReflectionSemanticHint({product: productHandle,
          receipt: {publicationId: row.publication_id, recordId: row.record_id, objectId, requestCommitment: row.request_commitment}, now: now(),
          verifySavedOutput: () => readPostgresReflectionAuthoritySavedOutput({handle, crypto: input.crypto, objectId,
            semanticRecordRef: row.record_id, semanticRequestCommitment: row.request_commitment, allowRetired: true}),
          retire: objectId => retire(objectId, signal),
          settleRetiredRequest: async requestId => {
            const original = await requests.get(requestId);
            try {
              if (original === null) throw new Error("Retired semantic output authorization is absent");
              if (["completed", "cancelled", "terminal_failure"].includes(original.snapshot.state)) return;
              if (!["running", "publication_reconciliation"].includes(original.snapshot.state)) throw new Error("Retired semantic output authorization changed");
              const cancelled = await requests.compareAndSwap({expectedRequestRevision: original.snapshot.requestRevision,
                next: {...original, snapshot: cancelBackgroundAuthorizationRequest(original.snapshot, "superseded", now()), finishedAt: now()}});
              try {
                if (cancelled.status !== "updated") throw new Error("Retired semantic output authorization changed");
                recipients.delete(requestId, original.snapshot.recipientGeneration);
              } finally {wipe(cancelled);}
            } finally {wipe(original);}
          }});
      } catch (error) {
        signal.throwIfAborted(); console.warn("[reflection] semantic hint retirement failed", {failureClass: classifyDataOperationFailure(error)});
      } finally {row.request_commitment.fill(0);}
    }
  };
  const recoverSemanticPublication = async (item: ClaimedProtectedRecordPublication, signal: AbortSignal): Promise<boolean> => {
    const objectId = item.cryptoObjectId ?? item.reservedCryptoObjectId;
    if (objectId === undefined || item.replay === undefined) return false;
    const saved = await readPostgresReflectionAuthoritySavedOutput({handle, crypto: input.crypto, objectId, semanticRecordRef: item.recordId, semanticRequestCommitment: item.replay.requestCommitment});
    if (saved === null) return false;
    try {
      if (item.state === "product_attached") {
        if (!await completeAttachedReflectionSemanticPublication({product: productHandle, item,
          sourceRecordRef: saved.binding.sourceRecordRef, claimGeneration: saved.binding.claimGeneration, commitmentKey: input.commitmentKey})) return false;
        await finishRequest(saved.originalDescriptor.requestId);
        return true;
      }
      await assertReflectionSemanticRecoverySource({handle: productHandle, binding: saved.binding});
      const original = saved.originalDescriptor;
      const prepared = await withPostgresReflectionSemanticSourcePlan({db: input.db, restricted: input.restricted,
        crypto: input.crypto, serverScope: input.serverScope,
        coordinates: {recordRef: original.source.recordRef, claimGeneration: original.source.claimGeneration,
          workKind: original.workKind, inputBindings: original.inputBindings, outputNamespaceIds: original.outputSlots.flatMap(slot => slot.namespaceIds)},
        ...(input.namespaceReadinessRequested === undefined ? {} : {namespaceReadinessRequested: input.namespaceReadinessRequested}),
        use: async ({namespaces, policyRevision, product}) => {
          if (!await validatePostgresReflectionSemanticPlan({product, restricted: input.restricted, crypto: input.crypto, descriptor: original})) return null;
          const namespaceRequirements = namespaces.filter(authority => saved.binding.namespaceEnvelopes.some(entry => entry.namespaceId === authority.namespaceId))
            .map(authority => ({authority, operations: ["decrypt" as const]}));
          const fingerprint = reflectionAuthorityReconciliationFingerprintV2(input.crypto, saved.binding);
          try {
            const workId = `${original.workId}:reconcile`;
            return await prepareExactRequest({workId, identity: hash([workId, Array.from(fingerprint), policyRevision, namespaceRequirements]),
              policyRevision, namespaceRequirements, workKind: "reflection.publication_reconcile", purpose: "record.reconcile",
              createDescriptor: (record, attempt, requestId, anchor) => Promise.resolve({
                formatVersion: 2, requestId, workId, recipientGeneration: attempt.recipientGeneration,
                anchorNamespaceId: anchor.namespaceId, anchorDomainId: anchor.domainId,
                subject: {kind: "processor", processorKind: "reflection", processorVersion: 1},
                namespaceRequirements, policyRevision, workKind: "reflection.publication_reconcile", purpose: "record.reconcile", operations: ["decrypt"],
                source: {kind: "reflection_publication", publicationId: saved.binding.publicationId, recordRef: item.recordId, representationGeneration: 1, fingerprint},
                inputBindings: saved.binding.namespaceEnvelopes.map(entry => ({objectId, namespaceId: entry.namespaceId})), outputSlots: [],
                maximumPlaintextBytes: REFLECTION_BACKGROUND_MAX_PLAINTEXT_BYTES_V2, maximumCiphertextBytes: REFLECTION_BACKGROUND_MAX_CIPHERTEXT_BYTES_V2,
                recipientKeyId: attempt.recipientKeyId, recipientPublicKey: attempt.recipientPublicKey,
                issuedAt: now(), notBefore: now(), expiresAt: attempt.expiresAt, idempotencyId: record.idempotencyKey,
              }),
            }, signal);
          } finally {fingerprint.fill(0);}
        },
      });
      try {
        if (prepared === null || prepared.acceptedMaterial === null || prepared.snapshot.state !== "grant_ready" || prepared.snapshot.recipient === null
          || !recipients.hasAttempt({requestId: prepared.snapshot.requestId, recipientGeneration: prepared.snapshot.recipientGeneration,
            recipientKeyId: prepared.snapshot.recipient.recipientKeyId})) return false;
        const at = now();
        const deadline = Math.min(prepared.snapshot.recipient.expiresAt, at + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS);
        if (deadline <= at) return false;
        const claimId = randomUUID();
        const claimed = await requests.compareAndSwap({expectedRequestRevision: prepared.snapshot.requestRevision,
          next: {...prepared, snapshot: claimBackgroundAuthorizationRequest(prepared.snapshot, claimId, at, deadline)}});
        const updated = claimed.status === "updated";
        wipe(claimed);
        if (!updated) return false;
        let attachment: "completed" | "quarantined" | undefined;
        const storage = createPostgresReflectionAuthorityObjectPort({handle, crypto: input.crypto, responseBytes: prepared.acceptedMaterial.responseBytes,
          claimId, domainKeys: domains, withCurrentAuthority,
          attach: async operation => {
            attachment = await attachReflectionSemanticRecovery({held: operation.held, item, binding: saved.binding, plaintext: operation.plaintext,
              commitmentKey: input.commitmentKey, authorizeCommit: operation.authorizeCommit, signal: operation.signal});
          },
        });
        try {
          const result = await recipients.runCurrentReflectionAuthority({requestId: prepared.snapshot.requestId,
            recipientGeneration: prepared.snapshot.recipientGeneration, recipientKeyId: prepared.snapshot.recipient.recipientKeyId,
            claimId, responseBytes: prepared.acceptedMaterial.responseBytes, claims, reflectionObjects: storage.objects,
            resolveCurrentIssuer: storage.resolveCurrentIssuer, reconciliationBinding: saved.binding, signal, deadlineAt: deadline});
          if (result.status !== "executed" || attachment === undefined) return false;
          await finishRequest(prepared.snapshot.requestId);
          if (attachment === "completed") await finishRequest(original.requestId);
          return true;
        } finally {storage.dispose();}
      } finally {wipe(prepared);}
    } finally {wipe(saved);}
  };
  const recoverSemanticPage = async (limit: number, signal: AbortSignal) => {
    const due = await publicationReceipts.claimDueProtected(limit, {requireReservedOutput: true});
    for (const item of due) {
      try {
        signal.throwIfAborted();
        if (await recoverSemanticPublication(item, signal)) continue;
        await publicationReceipts.failProtected({idempotencyKey: item.idempotencyKey, recordId: item.recordId,
          leaseToken: item.leaseToken, failureCode: "authorization_unavailable", terminal: false});
      } catch (error) {
        signal.throwIfAborted();
        const failureClass = classifyDataOperationFailure(error);
        console.warn("[reflection] saved semantic publication recovery failed", {failureClass});
        await publicationReceipts.failProtected({idempotencyKey: item.idempotencyKey, recordId: item.recordId,
          leaseToken: item.leaseToken, failureCode: failureClass === "integrity" ? "integrity_failure"
            : failureClass === "stale" ? "mapping_conflict" : "authorization_unavailable",
          terminal: failureClass === "integrity" || failureClass === "stale"});
      } finally {item.replay?.requestCommitment.fill(0);}
    }
  };

  return Object.freeze({
    runSemantic,
    async releaseWaitingSemantic(claim: DurableSleepClaim, stage: "organization" | "search_projection", failure?: DataOperationFailureClass) {
      const released = await releaseWaitingReflectionSemanticRequest({product: productHandle, restricted: handle, claim, stage,
        ...(failure === undefined ? {} : {failure}), now: now()});
      if (released === null) return false;
      for (const request of released) recipients.delete(request.requestId, request.recipientGeneration);
      return true;
    },
    readPendingInputBindings,
    async maintain(operation: Readonly<{limit: number; signal?: AbortSignal}>) {
      const signal = operation.signal === undefined ? shutdown.signal : AbortSignal.any([operation.signal, shutdown.signal]);
      signal.throwIfAborted();
      if (!Number.isSafeInteger(operation.limit) || operation.limit < 1 || operation.limit > BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH) {
        throw new RangeError("Reflection maintenance requires the existing bounded worker page");
      }
      recipients.sweep();
      await recoverSavedPage(operation.limit, signal);
      await recoverSemanticPage(operation.limit, signal);
      await settleUnusedSemanticPage(operation.limit, signal);
      await settleCompletedSemanticPage(operation.limit, signal);
      await retireSemanticHintsPage(operation.limit, signal);
      const productRetirements = await publicationReceipts.listDueProtectedRetirements(operation.limit);
      for (const retirement of productRetirements) {
        signal.throwIfAborted();
        try {await retireReflectionProductReceipt({product: productHandle, retirement, retire: objectId => retire(objectId, signal)});} catch (error) {
          signal.throwIfAborted(); console.warn("[reflection] semantic product retirement failed", {failureClass: classifyDataOperationFailure(error)});
        }
      }
      // Existing receipt scans and product unreachable fences own all cleanup.
      // This is one bounded page of the existing semantic worker's poll.
      const former = await projections.listDueProtectedRetirements(operation.limit);
      for (const entry of former) {
        signal.throwIfAborted();
        try {
        await settleAttachedRequests(entry.recordRef, entry.sourceChangeGeneration);
        await projections.withProtectedRetirementFence({recordRef: entry.recordRef, sourceChangeGeneration: entry.sourceChangeGeneration,
          cryptoObjectId: entry.formerCryptoObjectId, kind: "former"}, () => retire(entry.formerCryptoObjectId, signal));
        } catch (error) {
          signal.throwIfAborted();
          console.warn("[reflection] former authority retirement failed", {failureClass: classifyDataOperationFailure(error)});
        }
      }
      const remaining = operation.limit - former.length;
      const targets = remaining === 0 ? [] : await projections.listDueProtectedTargetRetirements(remaining);
      for (const entry of targets) {
        signal.throwIfAborted();
        try {
          await projections.withProtectedRetirementFence({recordRef: entry.recordRef, sourceChangeGeneration: entry.sourceChangeGeneration,
            cryptoObjectId: entry.targetCryptoObjectId, kind: "target"}, () => retire(entry.targetCryptoObjectId, signal));
        } catch (error) {
          signal.throwIfAborted();
          console.warn("[reflection] orphan authority retirement failed", {failureClass: classifyDataOperationFailure(error)});
        }
      }
      await requests.pruneTerminal({now: now(), limit: Math.min(operation.limit, BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH)});
    },
    async ensureAuthority(claim: DurableSleepClaim, callerSignal?: AbortSignal): Promise<DurableSleepReadinessResult> {
      const signal = callerSignal === undefined ? shutdown.signal : AbortSignal.any([callerSignal, shutdown.signal]);
      signal.throwIfAborted();
      let current = await projections.readCurrent(claim.recordRef);
      if (current === null) {
        const bootstrapped = await projections.bootstrapNativeStenographerAuthority(claim.recordRef);
        if (bootstrapped === "unavailable" || bootstrapped === "conflict") return {status: "unavailable", failureCode: "authority_unavailable"};
        current = await projections.readCurrent(claim.recordRef);
      }
      if (current === null) return {status: "unavailable", failureCode: "authority_unavailable"};
      if (current.protectedAuthorityCurrent && current.processingState === "current" && current.recordDisposition === "available") {
        await settleAttachedRequests(claim.recordRef, current.sourceChangeGeneration);
        return {status: "ready"};
      }
      const [lease] = current.processingState === "current" ? []
        : await projections.claimDueReconciliations(1, {recordRef: claim.recordRef, sourceChangeGeneration: current.sourceChangeGeneration});
      if (current.processingState !== "current" && lease === undefined) return waiting();
      const continuation = lease === undefined ? undefined : readAuthorityReconciliationContinuation(lease, commitments);
      try {
        const result = await reconcileRecordAuthority({recordRef: claim.recordRef, sourceChangeGeneration: current.sourceChangeGeneration,
          workBindingRef: `semantic:${claim.recordRef}:${claim.generation}`, maxOperations: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
          ...(continuation === undefined ? {} : {continuation})}, {
          selection: {selectedRepresentation: "protected", migrationGeneration: 1},
          sourceAuthority: new CanonicalRoomNamespaceSourceAuthority(), accessAudiences: createCanonicalRecordAccessAudience({db: input.db}),
          projections, commitments,
          protectedRepublisher: {republishExact: request => reproject(request, signal), retire: objectId => retire(objectId, signal)},
        });
        if (lease !== undefined && result.status === "paused") {
          const sealedCheckpoint = sealedAuthorityReconciliationContinuation({...lease, continuation: result.continuation}, commitments);
          try {
            await projections.deferReconciliation({...lease, sealedCheckpoint,
              nextAttemptAt: new Date(now() + REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.scanIntervalMilliseconds), terminal: false});
          } finally {sealedCheckpoint.fill(0);}
        } else if (lease !== undefined && (result.status === "stale" || result.status === "blocked")) {
          await projections.deferReconciliation({...lease, failureCode: "mapping_conflict", terminal: true, nextAttemptAt: new Date(now())});
        }
        return result.status === "applied" ? {status: "ready"} : result.status === "paused" ? waiting()
          : {status: "unavailable", failureCode: "authority_unavailable"};
      } catch (error) {
        const failureClass = classifyDataOperationFailure(error);
        const terminal = failureClass === "integrity" || failureClass === "unsupported";
        const failureCode = failureClass === "integrity" ? "integrity_failure" as const
          : failureClass === "authority" || failureClass === "key_waiting" ? "authorization_unavailable" as const
          : failureClass === "stale" || failureClass === "unsupported" ? "mapping_conflict" as const
          : "storage_transient" as const;
        if (lease !== undefined) await projections.deferReconciliation({...lease, failureCode, terminal,
          nextAttemptAt: new Date(now() + REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.scanIntervalMilliseconds)});
        throw error;
      } finally {lease?.sealedCheckpoint?.fill(0);}

    },
    dispose() {shutdown.abort(new Error("Reflection authority maintenance stopped")); recipients.close(); return Promise.resolve();},
  });
}
