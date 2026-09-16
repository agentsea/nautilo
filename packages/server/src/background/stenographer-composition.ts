import {createHash, randomUUID} from "node:crypto";
import {
  actors, and, asc, desc, backgroundCryptoAuthorizationRequests, createPostgresJsBridgeConnection, eq, getEncryptionTransitionPolicy,
  inArray, isNotNull, isNull, lte, gt, or, roomJournalState, rooms,
  type DirectDatabase, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {LatticeCrypto, ProcessorTransformRecipientRegistry, type ProcessorTransformCapability, type ProcessorTransformInput} from "@nautilo/lattice-crypto";
import {ProcessorReconciliationIntegrityErrorV2, inspectBackgroundAuthorizationResponseV2, decodeBackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {ClassifiedDataOperationError} from "@nautilo/lattice-bridge";
import {
  createPostgresStenographerAuthorizationWaitPort, createPostgresCurrentProcessorReconciliationObjectVerifier, createPostgresCurrentProcessorTransformObjectPort, createPostgresForegroundAgentSignerResolver,
  cryptoTypedDb, executeTypedCryptoQuery, PostgresDomainKeyAuthorityRepository, PostgresHumanDeviceSignerHistory,
  PostgresJournalCryptoTombstoneRepository, PostgresProcessorTransformCommitVerifier,
  PostgresProtectedJournalProcessorObjectVerifier, StenographerAuthorizationWaitingError,
  verifyCryptoPostgresHandle, verifyConversationProductPostgresHandle, verifyStoredObjectAccessManifestChainV5, withCurrentStenographerAuthority,
  withVerifiedStenographerOrdinarySiblings,
  type StenographerIntentAdapter, type StenographerOperationOutcome, type StenographerPreparedOperation,
  type CurrentProcessorHeldAuthority, type WithCurrentProcessorPublicationAuthority,
} from "@nautilo/lattice-bridge/server";
import {
  BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH, BackgroundAuthorizationProcessorCredentialClaimPort,
  cancelBackgroundAuthorizationRequest, receiptMatches,
  assertCancelledProtectedStenographerWorkIdentity, assertCancelledProtectedStenographerFallbackCoordinates, decodeProtectedJournalAttachmentPlanV1, prepareCurrentStenographerReconciliation,
  createCurrentStenographerReconciliationRecord, currentStenographerReconciliationDescriptor,
  assertCurrentStenographerReconciliationOutputs, attachmentInput,
  type PreparedCurrentStenographerReconciliation,
  candidateRoomIds, compactionCandidateRooms, coordinateProtectedJournalRebuild,
  createCurrentProtectedStenographerAuthorizationRecord, createCurrentProtectedStenographerDescriptorFactory,
  createPostgresProtectedStenographerPublicationReconciler, createProtectedStenographerBackgroundExecutionPort,
  createProtectedStenographerCompactionPublicationAdapter, createProtectedStenographerExtractionPublicationAdapter,
  createProtectedStenographerPublicationFence, createRoomSideModelInvoker, historicalCandidateRoomIds, failExtraction,
  initializeHistoricalBackfills, PostgresBackgroundAuthorizationRepository, PostgresProtectedJournalPublicationRepository,
  PostgresProtectedJournalRebuildRepository, PostgresProtectedStenographerWorkRecovery,
  PostgresProtectedStenographerWorkRepository, ProtectedStenographerBackgroundCoordinator,
  recoverProtectedStenographerExecutionWork, runProtectedStenographerCompaction, runProtectedStenographerExtraction,
  type BackgroundAuthorizationRecord, type BackgroundAuthorizationRepository, type ProtectedStenographerBackgroundCoordinatorOptions, type CurrentProtectedStenographerAuthority,
  type ProtectedStenographerCompactionWork, type ProtectedStenographerExtractionWork,
  type ProtectedStenographerRecoveredWork, type ProtectedStenographerDurableWorkRecoveryPort, type StenographerCandidatePort,
} from "@nautilo/runtime";
import type {ProtectedStenographerRecordCommitmentPort, RecordSemanticCommitmentPort} from "@nautilo/reflection-bridge/server";
import {createProductionStenographerOutputRepair} from "./stenographer-output-repair-composition";
import {createHumanProductTransactionContext} from "../routes/human-message-product-store";

const activeStates = ["awaiting_recipient", "awaiting_device", "grant_ready", "claimed", "running", "publication_reconciliation"] as const;
const unavailable = (): StenographerOperationOutcome => ({status: "unavailable", processed: false});
const completed = (): StenographerOperationOutcome => ({status: "completed", processed: true});
const prepared = (result: StenographerOperationOutcome): StenographerPreparedOperation => ({publish: () => Promise.resolve(result)});

/** Only absent custody is an availability condition; inconsistent authority is not fallback. */
export function assertStenographerNamespaceWaitingReason(reason: string): void {
  if (reason === "namespace_bundle_unavailable") return;
  throw new ClassifiedDataOperationError(reason === "authority_inconsistent" ? "integrity" : "authority",
    "Stenographer Namespace authority cannot be admitted");
}

/** Resume only a retained terminal handoff; the release owner supplies its policy/claim fence. */
export async function prepareCancelledStenographerFallback(input: Readonly<{
  repository: Pick<BackgroundAuthorizationRepository, "getByIdempotencyKey" | "cancelUnconsumedProcessorRequest">;
  idempotencyKey: string;
  work: ProtectedStenographerRecoveredWork;
  signal: AbortSignal;
  now(): number;
  recovery: ProtectedStenographerDurableWorkRecoveryPort;
  release(claim: ProtectedStenographerRecoveredWork["claim"], cancel: () => Promise<boolean>): Promise<boolean>;
  released(record: BackgroundAuthorizationRecord): void;
}>): Promise<StenographerAuthorizationWaitingError | null> {
  input.signal.throwIfAborted();
  const existing = await input.repository.getByIdempotencyKey?.(input.idempotencyKey);
  input.signal.throwIfAborted();
  if (existing === undefined || existing === null) return null;
  if (existing.idempotencyKey !== input.idempotencyKey) {
    throw new ClassifiedDataOperationError("integrity", "Cancelled Stenographer idempotency identity changed");
  }
  let work = input.work;
  if (work.claim.kind === "compaction" && existing.snapshot.state === "cancelled") {
    // Unlike an extraction batch, compaction creation time lives in the durable
    // request. Recover it through its existing metadata owner before hashing.
    const recovered = await input.recovery.recoverExact({record: existing, descriptor: null, now: new Date(input.now())});
    input.signal.throwIfAborted();
    if (recovered.status !== "recovered") {
      return new StenographerAuthorizationWaitingError("device", () => Promise.resolve(false));
    }
    work = recovered.work;
  }
  if (work.claim.kind === "compaction") assertCancelledProtectedStenographerFallbackCoordinates({record: existing, work});
  else assertCancelledProtectedStenographerWorkIdentity({record: existing, work});
  // Cancellation removed recipient authority. Reuse only product metadata;
  // this branch cannot create a grant, decrypt input, or invoke a model.
  return new StenographerAuthorizationWaitingError("device", async () => {
    input.signal.throwIfAborted();
    if (input.repository.cancelUnconsumedProcessorRequest === undefined) return false;
    const released = await input.release(work.claim, () =>
      input.repository.cancelUnconsumedProcessorRequest!({expected: existing, now: input.now()}));
    if (released) input.released(existing);
    return released;
  });
}

/** Refresh only an unconsumed execution plan, while retaining its product lease and execution budget. */
export async function refreshCurrentStenographerPlan(input: Readonly<{
  record: BackgroundAuthorizationRecord;
  repository: BackgroundAuthorizationRepository;
  recovery: ProtectedStenographerDurableWorkRecoveryPort;
  resolveAuthority(): Promise<CurrentProtectedStenographerAuthority | null>;
  hasPublication(): Promise<boolean>;
  fallback(record: BackgroundAuthorizationRecord, work: ProtectedStenographerRecoveredWork): Promise<boolean>;
  retire(record: BackgroundAuthorizationRecord): Promise<boolean>;
  supersede(work: ProtectedStenographerRecoveredWork, policyRevision: number, commit: () => Promise<boolean>): Promise<boolean>;
  discardRecipient(record: BackgroundAuthorizationRecord): void;
  now(): number;
  signal: AbortSignal;
}>): Promise<BackgroundAuthorizationRecord | null> {
  const {record} = input;
  input.signal.throwIfAborted();
  if (!["awaiting_recipient", "awaiting_device", "grant_ready", "claimed"].includes(record.snapshot.state)) return record;
  // Reserved/committed output remains owned by publication reconciliation, even
  // when a process died between the crypto and product transactions.
  if (await input.hasPublication()) return record;
  const descriptor = record.descriptorBytes === null ? null : decodeBackgroundProcessorWorkDescriptorV2(record.descriptorBytes);
  if (record.descriptorBytes !== null && createHash("sha256").update(record.descriptorBytes).digest("hex") !== record.snapshot.descriptorDigest) {
    throw new ClassifiedDataOperationError("integrity", "Current execution descriptor digest changed");
  }
  const at = input.now();
  const recovered = await input.recovery.recoverExact({record, descriptor, now: new Date(at)});
  input.signal.throwIfAborted();
  if (recovered.status === "leased") throw new StenographerAuthorizationWaitingError("device", () => Promise.resolve(false));
  if (recovered.status !== "recovered") {await input.retire(record); return null;}
  const authority = await input.resolveAuthority();
  if (authority === null) throw new StenographerAuthorizationWaitingError("authority", () => input.fallback(record, recovered.work));
  try {
    const initial = createCurrentProtectedStenographerAuthorizationRecord({requestId: randomUUID(), work: recovered.work,
      authority, now: record.snapshot.createdAt});
    const successor: BackgroundAuthorizationRecord = {...initial, snapshot: {...initial.snapshot, updatedAt: at,
      retryCount: record.snapshot.retryCount, lastRetryReason: record.snapshot.lastRetryReason,
      nextAttemptAt: record.snapshot.lastRetryReason === null ? null : Math.max(at, record.snapshot.nextAttemptAt ?? at)}};
    if (record.idempotencyKey === successor.idempotencyKey
      && Buffer.from(successor.workIdentityHash).equals(Buffer.from(record.workIdentityHash))) return record;
    const supersede = input.repository.supersedeUnstartedProcessorRequest?.bind(input.repository);
    if (supersede === undefined) return null;
    let winner: BackgroundAuthorizationRecord | null = null;
    const replaced = await input.supersede(recovered.work, authority.policyRevision, async () => {
      input.signal.throwIfAborted();
      const result = await supersede({expected: record, successor, now: at});
      if (result.status === "stale") return false;
      winner = result.record;
      return true;
    });
    if (!replaced) return null;
    input.discardRecipient(record);
    return winner;
  } finally {
    Object.values(authority.namespace).forEach(value => {if (value instanceof Uint8Array) value.fill(0);});
  }
}

/** A repair attempt owns no new publication: a superseded attempt is cancelled, never promoted to completed. */
export async function cancelObsoleteStenographerReconciliations(input: Readonly<{
  original: BackgroundAuthorizationRecord;
  records: readonly BackgroundAuthorizationRecord[];
  repository: Pick<BackgroundAuthorizationRepository, "compareAndSwap">;
  keepIdempotencyKey?: string;
  now: number;
  discardRecipient(requestId: string, generation: number): void;
}>): Promise<boolean> {
  let settled = true;
  for (const record of input.records) {
    if (record.snapshot.formatVersion !== 2 || record.snapshot.credentialSubject.kind !== "processor"
      || record.workKind !== "stenographer.publication_reconcile"
      || record.snapshot.workId !== `reconcile:${input.original.snapshot.requestId}`
      || record.snapshot.namespaceId !== input.original.snapshot.namespaceId) {
      throw new ClassifiedDataOperationError("integrity", "Reconciliation cleanup identity changed");
    }
    if (record.idempotencyKey === input.keepIdempotencyKey
      || !activeStates.some(state => state === record.snapshot.state)) continue;
    const result = await input.repository.compareAndSwap({expectedRequestRevision: record.snapshot.requestRevision,
      next: {...record, snapshot: cancelBackgroundAuthorizationRequest(record.snapshot, "superseded", input.now), finishedAt: input.now}});
    if (result.status === "updated") input.discardRecipient(record.snapshot.requestId, record.snapshot.recipientGeneration);
    else settled = false;
  }
  return settled;
}

/** One process owns recipients; all work, response, source and publication facts remain durable. */
export async function createProductionProtectedStenographerComposition(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  recordCommitment: ProtectedStenographerRecordCommitmentPort;
  semanticCommitments?: RecordSemanticCommitmentPort;
  resolveModelId(): string;
  authorizationRequested?(record: BackgroundAuthorizationRecord): Promise<void>;
  now?(): Date;
}>, dependencies: Readonly<{
  repository?: BackgroundAuthorizationRepository;
  coordinator?: (options: ProtectedStenographerBackgroundCoordinatorOptions) => Pick<ProtectedStenographerBackgroundCoordinator, "prepareRecipient" | "run">;
}> = {}): Promise<Readonly<{adapter: StenographerIntentAdapter; dualAdapter: StenographerIntentAdapter; candidates: StenographerCandidatePort; dispose(): Promise<void>}>> {
  const now = input.now ?? (() => new Date());
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  const requests = dependencies.repository ?? new PostgresBackgroundAuthorizationRepository(handle);
  const createCoordinator = dependencies.coordinator ?? ((options: ProtectedStenographerBackgroundCoordinatorOptions) => new ProtectedStenographerBackgroundCoordinator(options));
  const domains = new PostgresDomainKeyAuthorityRepository(input.restricted, input.crypto, input.serverScope);
  const recipients = new ProcessorTransformRecipientRegistry({crypto: input.crypto, now: () => now().getTime()});
  const claims = new BackgroundAuthorizationProcessorCredentialClaimPort(requests);
  const authorizationWait = createPostgresStenographerAuthorizationWaitPort(input.db);
  const activeRuns = new Set<Promise<unknown>>();
  let disposed = false;
  const assertActive = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (disposed) throw new Error("Protected Stenographer composition is disposed");
  };
  const runTracked = async <Value>(run: () => Promise<Value>): Promise<Value> => {
    assertActive();
    const pending = run(); activeRuns.add(pending);
    try {return await pending;} finally {activeRuns.delete(pending);}
  };
  const room = async (roomId: string) => {
    const [value] = await input.db.select({id: rooms.id, namespaceId: rooms.namespaceId, ownerId: rooms.ownerId})
      .from(rooms).where(eq(rooms.id, roomId)).limit(1);
    return value ?? null;
  };
  const authority = async (roomId: string, namespaceId: string): Promise<CurrentProtectedStenographerAuthority | null> => {
    const policy = await getEncryptionTransitionPolicy(input.db);
    const value = await domains.inspectForegroundNamespaceAuthority({namespaceId, keyClass: "ai"});
    if (value.status !== "ready") {
      assertStenographerNamespaceWaitingReason(value.reason);
      return null;
    }
    try {
      return {policyRevision: policy.revision, namespace: {serverId: input.serverScope, roomId, namespaceId,
        namespaceAccessRevision: value.namespaceAccessRevision, namespaceKeyGeneration: value.namespaceKeyGeneration,
        namespaceHeadDigest: new Uint8Array(value.namespaceHeadDigest), domainId: value.domainId,
        domainKeyGeneration: value.domainKeyGeneration, domainAuthorizationRevision: value.domainAuthorizationRevision,
        domainHeadDigest: new Uint8Array(value.domainHeadDigest), bundleRevision: value.bundleRevision,
        bundleDigest: new Uint8Array(value.bundleDigest)}};
    } finally {Object.values(value).forEach((field) => {if (field instanceof Uint8Array) field.fill(0);});}
  };

  // Read only queue coordinates here. Accepted ciphertext is loaded through the repository once an exact intent is selected.
  const activeRequest = async (namespaceId: string, workKind: BackgroundAuthorizationRecord["workKind"]) => {
    const t = backgroundCryptoAuthorizationRequests;
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({request_id: t.requestId}).from(t)
      .where(and(eq(t.formatVersion, 2), eq(t.credentialSubjectKind, "processor"),
        eq(t.namespaceId, namespaceId), eq(t.workKind, workKind), inArray(t.state, activeStates)))
      .orderBy(asc(t.createdAt), asc(t.requestId)).limit(2));
    if (rows.length > 1) throw new ClassifiedDataOperationError("integrity", "Multiple active Stenographer requests for one work lane");
    return rows[0] === undefined ? null : requests.get(rows[0].request_id);
  };
  const retainedFallbackRequest = async (namespaceId: string, workKind: BackgroundAuthorizationRecord["workKind"], workId: string) => {
    const t = backgroundCryptoAuthorizationRequests;
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({request_id: t.requestId}).from(t)
      .where(and(eq(t.formatVersion, 2), eq(t.credentialSubjectKind, "processor"),
        eq(t.namespaceId, namespaceId), eq(t.workKind, workKind), eq(t.workId, workId),
        eq(t.state, "cancelled"), eq(t.terminalReason, "cancelled")))
      .orderBy(desc(t.updatedAt), desc(t.requestId)).limit(1));
    return rows[0] === undefined ? null : requests.get(rows[0].request_id);
  };
  const reconciliationRequests = async (namespaceId: string, originalRequestId?: string) => {
    const t = backgroundCryptoAuthorizationRequests;
    const records: BackgroundAuthorizationRecord[] = [];
    let after: string | undefined;
    for (;;) {
      const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({request_id: t.requestId}).from(t)
        .where(and(eq(t.formatVersion, 2), eq(t.credentialSubjectKind, "processor"),
          eq(t.namespaceId, namespaceId), eq(t.workKind, "stenographer.publication_reconcile"),
          inArray(t.state, activeStates), ...(originalRequestId === undefined ? [] : [eq(t.workId, `reconcile:${originalRequestId}`)]),
          ...(after === undefined ? [] : [gt(t.requestId, after)])))
        .orderBy(asc(t.requestId)).limit(BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH));
      for (const row of rows) {const record = await requests.get(row.request_id); if (record !== null) records.push(record);}
      if (rows.length < BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH) return records;
      after = rows.at(-1)!.request_id;
    }
  };
  const cancelReconciliations = async (original: BackgroundAuthorizationRecord, keepIdempotencyKey?: string) =>
    cancelObsoleteStenographerReconciliations({original,
      records: await reconciliationRequests(original.snapshot.namespaceId, original.snapshot.requestId), repository: requests,
      ...(keepIdempotencyKey === undefined ? {} : {keepIdempotencyKey}), now: now().getTime(),
      discardRecipient: (requestId, generation) => {recipients.delete(requestId, generation);}});
  const dueRooms = async (workKinds: readonly BackgroundAuthorizationRecord["workKind"][], at: Date): Promise<readonly string[]> => {
    const t = backgroundCryptoAuthorizationRequests;
    const namespaces = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({namespace_id: t.namespaceId, request_id: t.requestId}).from(t)
        .where(and(eq(t.formatVersion, 2), eq(t.credentialSubjectKind, "processor"),
          inArray(t.workKind, [...workKinds, "stenographer.publication_reconcile"]), lte(t.createdAt, at),
          ...(after === undefined ? [] : [gt(t.requestId, after)]), or(
          inArray(t.state, ["awaiting_device", "grant_ready"]),
          and(inArray(t.state, ["awaiting_recipient", "publication_reconciliation"]),
            or(isNull(t.nextAttemptAt), lte(t.nextAttemptAt, at))),
          and(inArray(t.state, ["claimed", "running"]), lte(t.claimExpiresAt, at)),
        )))
        .orderBy(asc(t.requestId)).limit(BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH));
      for (const row of rows) namespaces.add(row.namespace_id);
      if (rows.length < BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH) break;
      const next = rows.at(-1)!.request_id;
      if (after !== undefined && next <= after) throw new Error("Background candidate continuation did not advance");
      after = next;
    }
    if (namespaces.size === 0) return [];
    return (await input.db.select({id: rooms.id}).from(rooms).where(inArray(rooms.namespaceId, [...namespaces]))).map((row) => row.id);
  };
  const candidates: StenographerCandidatePort = {
    extraction: async ({lane, now: at}) => {
      assertActive();
      const normal = lane === "live" ? await candidateRoomIds(input.db, at) : await historicalCandidateRoomIds(input.db, at);
      return [...new Set([...await dueRooms([lane === "live" ? "stenographer.extraction" : "stenographer.historical"], at), ...normal])];
    },
    initializeHistorical: ({now: at}) => {assertActive(); return initializeHistoricalBackfills({db: input.db, now: at});},
    compaction: async ({now: at}) => {
      assertActive();
      return [...new Set([...await dueRooms(["stenographer.compaction"], at), ...(await compactionCandidateRooms(input.db, at)).map((row) => row.roomId)])];
    },
  };

  type PublicationPort = Pick<PostgresProtectedJournalPublicationRepository,
    "reserveCurrentSourceAndClaim" | "markCryptoCommitted" | "attach">;
  type DecoratePublication = (repository: PostgresProtectedJournalPublicationRepository,
    capability: ProcessorTransformCapability, record: BackgroundAuthorizationRecord,
    withValidatedAuthority: (validateProduct: (product: PostgresJsBridgeConnection) => Promise<boolean>, validatePublication?: (product: PostgresJsBridgeConnection) => Promise<boolean>) => WithCurrentProcessorPublicationAuthority,
    signal: AbortSignal) => PublicationPort;
  const protectedPublication: DecoratePublication = (repository) => repository;
  const dualPublication: DecoratePublication = (repository, capability, record, withValidatedAuthority, signal) => ({
    reserveCurrentSourceAndClaim: repository.reserveCurrentSourceAndClaim.bind(repository),
    markCryptoCommitted: repository.markCryptoCommitted.bind(repository),
    attach: async request => {
      if (record.acceptedMaterial === null) throw new Error("Stenographer attachment grant is unavailable");
      const receipt = await repository.get(request.publicationId);
      if (receipt === null || !receiptMatches(record, receipt)) throw new Error("Stenographer attachment receipt changed");
      const context = inspectBackgroundAuthorizationResponseV2(record.acceptedMaterial.responseBytes);
      return withVerifiedStenographerOrdinarySiblings({capability, context, signal,
        withCurrentAuthority: withValidatedAuthority(product => repository.validateCurrentReconciliationSource(
          product, {...request, now: now()}, receipt),
          product => repository.validateCurrentPublicationReceipt(product, request.publicationId, receipt)),
        attach: (held, outputs) => repository.attachWithOrdinarySiblings(held.product!, {...request, now: now()}, outputs),
      });
    },
  });
  type ReconciliationAttachment = (repository: PostgresProtectedJournalPublicationRepository,
    held: CurrentProcessorHeldAuthority, plan: PreparedCurrentStenographerReconciliation,
    leaseToken: string, outputs: readonly ProcessorTransformInput[], at: Date) => Promise<void>;
  const attachReconciled = (ordinary: readonly ProcessorTransformInput[] | undefined,
    repository: PostgresProtectedJournalPublicationRepository, held: CurrentProcessorHeldAuthority,
    plan: PreparedCurrentStenographerReconciliation, leaseToken: string, at: Date) => {
    if (held.product === undefined) throw new Error("Reconciliation requires the held product transaction");
    return repository.attachCurrentReconciliation(held.product,
      attachmentInput(plan.receipt, plan.recovered, leaseToken, at), plan.receipt, ordinary).then(result => {
        if (result.status !== "attached" && result.status !== "duplicate") throw new Error("Reconciliation product attachment changed");
      });
  };
  const protectedReconciliation: ReconciliationAttachment = (repository, held, plan, leaseToken, _outputs, at) =>
    attachReconciled(undefined, repository, held, plan, leaseToken, at);
  const dualReconciliation: ReconciliationAttachment = (repository, held, plan, leaseToken, outputs, at) =>
    attachReconciled(outputs, repository, held, plan, leaseToken, at);
  const services = async (roomId: string, modelId: string, decorate: DecoratePublication = protectedPublication,
    reconcileAttachment: ReconciliationAttachment = protectedReconciliation, signal?: AbortSignal) => {
    const currentRoom = await room(roomId);
    if (currentRoom === null) return null;
    const product = await createHumanProductTransactionContext(currentRoom.ownerId, input.db);
    const work = new PostgresProtectedStenographerWorkRepository(product.handle);
    const publications = new PostgresProtectedJournalPublicationRepository(product.handle, input.recordCommitment, input.semanticCommitments);
    const recovery = new PostgresProtectedStenographerWorkRecovery(product.handle, {
      repository: work, resolveCompactionModelId: async ({record}) => {
        const receipt = await publications.get(record.snapshot.requestId);
        if (receipt !== null) {
          const plan = decodeProtectedJournalAttachmentPlanV1(receipt.attachmentPlanBytes);
          if (plan.kind === "rollup") return plan.rollup!.modelId;
        }
        return modelId;
      },
    });
    const resolveAuthority = (record: BackgroundAuthorizationRecord) => authority(roomId, record.snapshot.namespaceId);
    const reconciliation = createPostgresProtectedStenographerPublicationReconciler({repository: publications, recovery,
      reconcileCurrent: record => runCommittedReconciliation(record),
      resolveCurrentAuthority: resolveAuthority, committedTransforms: new PostgresProcessorTransformCommitVerifier(handle, input.crypto),
      publicationFence: createProtectedStenographerPublicationFence(requests),
      verifiedObjects: new PostgresProtectedJournalProcessorObjectVerifier(input.crypto, handle, request => verifyV5Input(request)), now, leaseToken: () => randomUUID()});
    const signerHistory = new PostgresHumanDeviceSignerHistory({handle, crypto: input.crypto});
    const foregroundSigner = createPostgresForegroundAgentSignerResolver({product: product.handle, crypto: input.crypto});
    const withValidatedAuthority = (validateProduct?: (product: PostgresJsBridgeConnection) => Promise<boolean>, validatePublication?: (product: PostgresJsBridgeConnection) => Promise<boolean>): WithCurrentProcessorPublicationAuthority => async ({context, signal, use}) => {
      if (!("authority" in context.descriptor)) return null;
      const [human] = await input.db.select({ownerId: actors.ownerId}).from(actors)
        .where(and(eq(actors.id, context.issuer.humanId), eq(actors.kind, "user"))).limit(1);
      if (human?.ownerId === undefined || human.ownerId === null) return null;
      const issuerProduct = await createHumanProductTransactionContext(human.ownerId, input.db);
      return withCurrentStenographerAuthority({runner: issuerProduct.canonicalRunner, restricted: input.restricted,
        crypto: input.crypto, serverScope: input.serverScope, descriptor: context.descriptor, issuer: context.issuer,
        now: () => now().getTime(), ...(signal === undefined ? {} : {signal}),
        ...(validateProduct === undefined ? {} : {validateProduct}),
        ...(validatePublication === undefined ? {} : {validatePublication}),
        use: (held, product, restricted) => use({executor: restricted, issuerSigningPublicKey: held.device.signingPublicKey, product})});
    };
    const withCurrentAuthority = withValidatedAuthority();
    const verifyV5Input: NonNullable<Parameters<typeof createPostgresCurrentProcessorTransformObjectPort>[0]["verifyV5Input"]> =
      request => verifyStoredObjectAccessManifestChainV5({...request,
        resolveHistoricalAgentManagerAuthority: signerHistory.resolveAgentRuntimeSignerManager,
        resolveLiveShadowAgentSigner: foregroundSigner});
    const runCommittedReconciliation = async (original: BackgroundAuthorizationRecord): Promise<"completed" | "pending" | "stale"> => {
      let reconciliationLease: string | undefined;
      try {
      const operationSignal = signal ?? new AbortController().signal;
      const loadPlan = async () => prepareCurrentStenographerReconciliation({original, publications,
        recovery, fence: createProtectedStenographerPublicationFence(requests),
        committedTransforms: new PostgresProcessorTransformCommitVerifier(handle, input.crypto),
        verifiedObjects: createPostgresCurrentProcessorReconciliationObjectVerifier({handle, crypto: input.crypto,
          original: {requestId: original.snapshot.requestId, recipientGeneration: original.snapshot.recipientGeneration,
            descriptorHash: Uint8Array.from(Buffer.from(original.snapshot.descriptorDigest!, "hex"))}, verifyV5Input}),
        now: now(), signal: operationSignal});
      const planned = await loadPlan();
      if (planned.status !== "ready") {
        if (planned.status !== "pending" && !await cancelReconciliations(original)) return "pending";
        return planned.status;
      }
      const currentAuthority = await resolveAuthority(original);
      if (currentAuthority === null) return "pending";
      let fresh: BackgroundAuthorizationRecord;
      try {
        const candidate = createCurrentStenographerReconciliationRecord({crypto: input.crypto, prepared: planned,
          authority: currentAuthority, requestId: randomUUID(), now: now().getTime()});
        if (!await cancelReconciliations(original, candidate.idempotencyKey)) return "pending";
        fresh = await requests.getByIdempotencyKey?.(candidate.idempotencyKey) ?? (await requests.create(candidate)).record;
      } finally {Object.values(currentAuthority.namespace).forEach(value => {if (value instanceof Uint8Array) value.fill(0);});}
      // A concurrent attachment may settle the original while this exact request is inserted.
      const afterCreate = await publications.get(original.snapshot.requestId);
      if (afterCreate === null || !receiptMatches(original, afterCreate)) throw new ProcessorReconciliationIntegrityErrorV2("Reconciliation original receipt changed");
      if (afterCreate.state !== "reserved" && afterCreate.state !== "crypto_committed") {
        if (!await cancelReconciliations(original)) return "pending";
        return afterCreate.state === "attached" ? "completed" : "stale";
      }
      const freshCoordinator = createCoordinator({repository: requests, recipients,
        descriptors: {create: async ({record, attempt}) => {
          const plan = await loadPlan();
          if (plan.status !== "ready") throw new StenographerAuthorizationWaitingError("authority");
          const authority = await resolveAuthority(original);
          if (authority === null) throw new StenographerAuthorizationWaitingError("authority");
          try {return currentStenographerReconciliationDescriptor({crypto: input.crypto, prepared: plan, authority, record, attempt, now: now().getTime()});}
          finally {Object.values(authority.namespace).forEach(value => {if (value instanceof Uint8Array) value.fill(0);});}
        }},
        ...(input.authorizationRequested === undefined ? {} : {authorizationRequested: input.authorizationRequested}),
        transformMaterial: {loadAccepted: async record => {
          const plan = await loadPlan();
          const durable = await requests.get(record.snapshot.requestId);
          try {
          if (plan.status !== "ready") throw new StenographerAuthorizationWaitingError("authority");
          if (durable?.acceptedMaterial == null || durable.snapshot.requestRevision !== record.snapshot.requestRevision) return {status: "integrity_failure"};
          const leaseToken = randomUUID();
          const claimed = await publications.claim({publicationId: plan.receipt.publicationId, leaseToken, now: now()});
          if (claimed.status !== "claimed" || claimed.record === undefined) throw new StenographerAuthorizationWaitingError("authority");
          reconciliationLease = leaseToken;
          if (claimed.record.state === "reserved") {
            const marked = await publications.markCryptoCommitted({publicationId: plan.receipt.publicationId,
              leaseToken, descriptorHash: plan.receipt.descriptorHash, attachmentPlanHash: plan.receipt.attachmentPlanHash,
              outputObjectIds: plan.binding.outputs.map(output => output.objectId), now: now()});
            if (marked.status !== "committed" && marked.status !== "duplicate") throw new Error("Reconciliation receipt could not confirm its commit");
          }
          const resolver: WithCurrentProcessorPublicationAuthority = async ({context, signal, use}) => {
      if (!("authority" in context.descriptor)) return null;
            const [human] = await input.db.select({ownerId: actors.ownerId}).from(actors)
              .where(and(eq(actors.id, context.issuer.humanId), eq(actors.kind, "user"))).limit(1);
            if (human?.ownerId == null) return null;
            const issuerProduct = await createHumanProductTransactionContext(human.ownerId, input.db);
            return withCurrentStenographerAuthority({runner: issuerProduct.canonicalRunner, restricted: input.restricted,
              crypto: input.crypto, serverScope: input.serverScope, descriptor: context.descriptor, issuer: context.issuer,
              now: () => now().getTime(), ...(signal === undefined ? {} : {signal}),
              validatePublication: product => publications.validateCurrentPublicationReceipt(product, plan.receipt.publicationId, plan.receipt),
              validateProduct: product => publications.validateCurrentReconciliationSource(product,
                attachmentInput(plan.receipt, plan.recovered, leaseToken, now()), plan.receipt),
              use: (held, product, restricted) => use({executor: restricted, issuerSigningPublicKey: held.device.signingPublicKey, product})});
          };
            const port = createPostgresCurrentProcessorTransformObjectPort({handle, crypto: input.crypto, resolveLiveShadowAgentSigner: foregroundSigner,
              responseBytes: durable.acceptedMaterial.responseBytes, domainKeys: domains, withCurrentAuthority: resolver, verifyV5Input,
              reconciliation: {binding: plan.binding, attach: async ({held, outputs, signal, authorizedAt}) => {
                signal.throwIfAborted();
                assertCurrentStenographerReconciliationOutputs(plan, outputs);
                await reconcileAttachment(publications, held, plan, leaseToken, outputs, new Date(authorizedAt));
                signal.throwIfAborted();
              }}});
            if (port.reconciliationObjects === undefined) throw new Error("Current reconciliation object port is unavailable");
            return {status: "loaded", material: {formatVersion: 2, binding: plan.binding, claims,
              resolveCurrentIssuer: port.resolveCurrentIssuer, objects: port.reconciliationObjects}};
          } finally {
            durable?.descriptorBytes?.fill(0); durable?.workIdentityHash.fill(0);
            durable?.acceptedMaterial?.responseBytes.fill(0); durable?.acceptedMaterial?.issuerSigningPublicKeyHash.fill(0);
          }
        }},
        execution: {executeWork: () => {throw new Error("Reconciliation cannot execute a model");},
          reconcilePublication: async () => {
            const receipt = await publications.get(original.snapshot.requestId);
            if (receipt !== null && !receiptMatches(original, receipt)) throw new ProcessorReconciliationIntegrityErrorV2("Reconciliation original receipt changed");
            return receipt?.state === "attached" ? "completed" : "not_started";
          }},
        now: () => now().getTime(), recipientKeyId: () => randomUUID(), claimId: () => randomUUID(),
        nextAttemptAt: (_record, _reason, at) => at,
      });
      if (fresh.snapshot.state === "awaiting_device" || fresh.snapshot.state === "awaiting_recipient") {
        const result = await freshCoordinator.prepareRecipient(fresh.snapshot.requestId);
        if (result.status === "device_authorization_required") {result.descriptorBytes.fill(0); result.descriptorHash.fill(0);}
        fresh = await requests.get(fresh.snapshot.requestId) ?? fresh;
      }
      if (fresh.snapshot.state === "cancelled" || fresh.snapshot.state === "terminal_failure") return "stale";
      if ((fresh.snapshot.state === "running" || fresh.snapshot.state === "claimed")
        && fresh.snapshot.claimExpiresAt !== null && fresh.snapshot.claimExpiresAt > now().getTime()) return "pending";
      const result = await freshCoordinator.run(fresh.snapshot.requestId, operationSignal);
      return result.status === "completed" ? "completed" : result.status === "terminal" ? "stale" : "pending";
      } catch (cause) {
        if (!(cause instanceof ProcessorReconciliationIntegrityErrorV2)
          && !(cause instanceof ClassifiedDataOperationError && cause.failureClass === "integrity")) throw cause;
        const leaseToken = reconciliationLease ?? randomUUID();
        const claimed = await publications.claim({publicationId: original.snapshot.requestId, leaseToken, now: now()});
        if (claimed.status !== "claimed") return "pending";
        await publications.fail({publicationId: original.snapshot.requestId, leaseToken, failureCode: "integrity_failure", now: now()});
        return await cancelReconciliations(original) ? "stale" : "pending";
      }
    };
    const execution = createProtectedStenographerBackgroundExecutionPort({reconciliation,
      executeWork: async ({record, capability, signal}) => {
        const recovered = await recoverProtectedStenographerExecutionWork({record, recovery, now: now()});
        if (recovered.status !== "recovered") return {status: "rejected", reason: "stale_work"};
        const publication = decorate(publications, capability, record, withValidatedAuthority, signal);
        const leaseToken = randomUUID();
        const invokeModel = createRoomSideModelInvoker({modelId, userId: recovered.claim.ownerId, roomId,
          laneKey: `stenographer:${record.workKind}`, callType: recovered.claim.kind === "extraction" ? "room_stenographer" : "room_event_compaction",
          operationId: recovered.claim.workId});
        if (recovered.claim.kind === "extraction") {
          return runProtectedStenographerExtraction({capability, work: recovered.work as ProtectedStenographerExtractionWork,
            signal, invokeModel,
            resolveParticipantDisplays: async (participantIds, operationSignal) => {
              operationSignal.throwIfAborted();
              if (participantIds.length === 0) return [];
              const rows = await input.db.select({id: actors.id, name: actors.displayName})
                .from(actors).where(inArray(actors.id, [...participantIds]));
              operationSignal.throwIfAborted();
              return rows.map((actor) => ({participantId: actor.id,
                displayLabel: actor.name?.trim() || "Unknown participant"}));
            },
            publication: createProtectedStenographerExtractionPublicationAdapter({repository: publication,
              work: recovered.claim, publicationLeaseToken: leaseToken, now})});
        }
        return runProtectedStenographerCompaction({capability, work: recovered.work as ProtectedStenographerCompactionWork,
          signal, invokeModel, publication: createProtectedStenographerCompactionPublicationAdapter({repository: publication,
            work: recovered.claim, publicationLeaseToken: leaseToken, now})});
      }});
    const coordinator = createCoordinator({repository: requests, recipients,
      descriptors: createCurrentProtectedStenographerDescriptorFactory({crypto: input.crypto, recovery,
        resolveCurrentAuthority: resolveAuthority, now: () => now().getTime()}),
      ...(input.authorizationRequested === undefined ? {} : {authorizationRequested: input.authorizationRequested}),
      transformMaterial: {loadAccepted: async (record) => {
        const durable = await requests.get(record.snapshot.requestId);
        try {
          if (durable?.snapshot.formatVersion !== 2
            || durable.snapshot.credentialSubject.kind !== "processor"
            || durable.acceptedMaterial === null
            || durable.snapshot.requestRevision !== record.snapshot.requestRevision) return {status: "integrity_failure"};
          const port = createPostgresCurrentProcessorTransformObjectPort({handle, crypto: input.crypto, resolveLiveShadowAgentSigner: foregroundSigner,
            responseBytes: durable.acceptedMaterial.responseBytes, domainKeys: domains, withCurrentAuthority,
            verifyV5Input: (request) => verifyStoredObjectAccessManifestChainV5({...request,
              resolveHistoricalAgentManagerAuthority: signerHistory.resolveAgentRuntimeSignerManager,
              resolveLiveShadowAgentSigner: foregroundSigner})});
          return {status: "loaded", material: {formatVersion: 2, claims, ...port}};
        } finally {
          durable?.descriptorBytes?.fill(0); durable?.workIdentityHash.fill(0);
          durable?.acceptedMaterial?.responseBytes.fill(0);
          durable?.acceptedMaterial?.issuerSigningPublicKeyHash.fill(0);
        }
      }}, execution, now: () => now().getTime(), recipientKeyId: () => randomUUID(), claimId: () => randomUUID(),
      nextAttemptAt: (_record, _reason, at) => at});
    const cleanupSettledReconciliations = async () => {
      const related = await reconciliationRequests(currentRoom.namespaceId);
      const originalIds = new Set(related.map(record => record.snapshot.workId));
      for (const workId of originalIds) {
        if (!workId.startsWith("reconcile:")) throw new ClassifiedDataOperationError("integrity", "Reconciliation work identity changed");
        const original = await requests.get(workId.slice("reconcile:".length));
        if (original === null) throw new ClassifiedDataOperationError("integrity", "Reconciliation original request is missing");
        const receipt = await publications.get(original.snapshot.requestId);
        if (receipt === null || !receiptMatches(original, receipt)) throw new ClassifiedDataOperationError("integrity", "Reconciliation original receipt changed");
        if ((receipt.state === "reserved" || receipt.state === "crypto_committed")
          && activeStates.some(state => state === original.snapshot.state)) continue;
        if (!await cancelReconciliations(original)) return false;
      }
      return true;
    };
    return {room: currentRoom, work, publications, product, coordinator, recovery, cleanupSettledReconciliations,
      withValidatedAuthority, verifyV5Input, foregroundSigner};
  };

  const prepareRequest = async (roomId: string, workKind: BackgroundAuthorizationRecord["workKind"], modelId: string,
    at: Date, signal: AbortSignal, decorate: DecoratePublication, reconcileAttachment: ReconciliationAttachment): Promise<StenographerPreparedOperation> => {
    assertActive(signal);
    const scope = await services(roomId, modelId, decorate, reconcileAttachment, signal);
    if (scope === null) return prepared(unavailable());
    if (!await scope.cleanupSettledReconciliations()) return prepared(unavailable());
    // Resume accepted or awaiting requests before attempting to claim an already leased product batch.
    const waitLane = workKind === "stenographer.compaction" ? "compaction"
      : workKind === "stenographer.rebuild" ? "rebuild" : workKind === "stenographer.historical" ? "historical" : "live";
    let record = await activeRequest(scope.room.namespaceId, workKind);
    if (record === null) {
      const currentAuthority = await authority(roomId, scope.room.namespaceId);
      if (currentAuthority === null) {
        await authorizationWait.waiting({roomId, lane: waitLane, now: at});
        throw new StenographerAuthorizationWaitingError("authority");
      }
      await authorizationWait.clear({roomId, lane: waitLane});
      try {
        const claimed = workKind === "stenographer.compaction" ? await scope.work.claimCompaction({roomId, now: at})
          : workKind === "stenographer.rebuild" ? await (async () => {
            const [state] = await input.db.select({generation: roomJournalState.rebuildGeneration, target: roomJournalState.rebuildTargetMessageId})
              .from(roomJournalState).where(eq(roomJournalState.roomId, roomId)).limit(1);
            return state?.target === null || state?.target === undefined ? null
              : scope.work.claimRebuildExtraction({roomId, rebuildGeneration: state.generation, targetMessageId: state.target, now: at});
          })() : await scope.work.claimExtraction({roomId, lane: workKind === "stenographer.historical" ? "historical" : "live", now: at});
        if (claimed?.status === "completed") return prepared(completed());
        if (claimed?.status !== "claimed") {
          if (claimed?.status === "blocked") {
            if (claimed.reason === "protected_source_unavailable") {
              await authorizationWait.waiting({roomId, lane: waitLane, now: at});
              throw new StenographerAuthorizationWaitingError("authority");
            }
            throw new ClassifiedDataOperationError(claimed.reason === "invalid_metadata" ? "integrity" : "unsupported",
              "Protected Stenographer source cannot be represented safely");
          }
          return prepared(unavailable());
        }
        let recovered: ProtectedStenographerRecoveredWork = claimed.claim.kind === "extraction"
          ? {claim: claimed.claim, compactionModelId: null} : {claim: claimed.claim, compactionModelId: modelId};
        const retained = await retainedFallbackRequest(scope.room.namespaceId, workKind, claimed.claim.workId);
        if (retained !== null && recovered.claim.kind === "compaction") {
          const exact = await scope.recovery.recoverExact({record: retained, descriptor: null, now: at});
          if (exact.status !== "recovered") throw new StenographerAuthorizationWaitingError("device", () => Promise.resolve(false));
          recovered = exact.work;
        }
        record = createCurrentProtectedStenographerAuthorizationRecord({requestId: randomUUID(),
          work: recovered, authority: currentAuthority, now: retained?.snapshot.createdAt ?? at.getTime()});
        const expectedPolicyRevision = currentAuthority.policyRevision;
        const existingPlan = await requests.getByIdempotencyKey?.(record.idempotencyKey);
        if (existingPlan !== undefined && existingPlan !== null
          && (existingPlan.snapshot.state === "completed" || existingPlan.snapshot.state === "terminal_failure"
            || existingPlan.snapshot.state === "cancelled" && existingPlan.snapshot.terminalReason !== "cancelled")) {
          // A consumed terminal identity cannot receive another model execution
          // or borrow the unconsumed ordinary fallback cancellation path.
          if (existingPlan.idempotencyKey !== record.idempotencyKey
            || existingPlan.workIdentityHash.length !== record.workIdentityHash.length
            || !existingPlan.workIdentityHash.every((byte, i) => byte === record!.workIdentityHash[i])) {
            throw new ClassifiedDataOperationError("integrity", "Terminal Stenographer work identity changed");
          }
          if (existingPlan.snapshot.state === "completed") return prepared(unavailable());
          if (recovered.claim.kind === "extraction") await failExtraction({db: input.db,
            claim: {roomId, batchId: recovered.claim.sourceBatchId, leaseToken: recovered.claim.leaseToken},
            errorCode: "lease_lost", modelId, now: at});
          return prepared({status: "failed", processed: true});
        }
        const cancelledHandoff = await prepareCancelledStenographerFallback({repository: requests,
          idempotencyKey: retained?.idempotencyKey ?? record.idempotencyKey, work: recovered, signal, now: () => now().getTime(), recovery: scope.recovery,
          release: (claim, cancel) => scope.work.releaseUnstartedClaimForFallback(claim, {
            canonical: scope.product.canonicalRunner, expectedPolicyRevision, cancel}),
          released: (existing) => {recipients.delete(existing.snapshot.requestId, existing.snapshot.recipientGeneration);},
        });
        if (cancelledHandoff !== null) throw cancelledHandoff;
        const created = await requests.create(record);
        record = created.record;
      } finally {
        Object.values(currentAuthority.namespace).forEach((value) => {if (value instanceof Uint8Array) value.fill(0);});
      }
    }
    record = await refreshCurrentStenographerPlan({record, repository: requests, recovery: scope.recovery,
      resolveAuthority: () => authority(roomId, scope.room.namespaceId),
      hasPublication: async () => await scope.publications.get(record!.snapshot.requestId) !== null,
      fallback: async (expected, recovered) => {
        assertActive(signal);
        const policy = await getEncryptionTransitionPolicy(input.db);
        const released = await scope.work.releaseUnstartedClaimForFallback(recovered.claim, {
          canonical: scope.product.canonicalRunner, expectedPolicyRevision: policy.revision,
          cancel: () => requests.cancelUnconsumedProcessorRequest?.({expected, now: now().getTime()}) ?? Promise.resolve(false)});
        if (released) recipients.delete(expected.snapshot.requestId, expected.snapshot.recipientGeneration);
        return released;
      },
      retire: expected => scope.work.retireObsoleteUnstartedRequest({roomId, namespaceId: scope.room.namespaceId,
        workId: expected.snapshot.workId, canonical: scope.product.canonicalRunner,
        retire: async () => {
          const retired = await requests.cancelUnconsumedProcessorRequest?.({expected, reason: "superseded", now: now().getTime()}) ?? false;
          if (retired) recipients.delete(expected.snapshot.requestId, expected.snapshot.recipientGeneration);
          return retired;
        }}),
      supersede: (work, expectedPolicyRevision, supersede) => scope.work.supersedeUnstartedClaim(work.claim, {
        canonical: scope.product.canonicalRunner, expectedPolicyRevision, now: now(), supersede}),
      discardRecipient: existing => {recipients.delete(existing.snapshot.requestId, existing.snapshot.recipientGeneration);},
      now: () => now().getTime(), signal});
    if (record === null) return prepared(unavailable());
    await authorizationWait.clear({roomId, lane: waitLane});
    assertActive(signal);
    if (record.snapshot.state === "awaiting_recipient" || record.snapshot.state === "awaiting_device") {
      const result = await scope.coordinator.prepareRecipient(record.snapshot.requestId);
      if (result.status === "device_authorization_required") {result.descriptorBytes.fill(0); result.descriptorHash.fill(0);}
      record = await requests.get(record.snapshot.requestId);
      if (record === null) return prepared(unavailable());
    }
    const state = record.snapshot.state;
    if (state === "cancelled" || state === "terminal_failure" || state === "completed") return prepared(unavailable());
    if ((state === "claimed" || state === "running")
      && record.snapshot.claimExpiresAt !== null && record.snapshot.claimExpiresAt > now().getTime()) {
      return prepared(unavailable());
    }
    if (!["grant_ready", "publication_reconciliation", "running", "claimed"].includes(state)) {
      const expected = record;
      throw new StenographerAuthorizationWaitingError("device", async () => {
        assertActive(signal);
        if (requests.cancelUnconsumedProcessorRequest === undefined || expected.descriptorBytes === null) return false;
        const recovered = await recoverProtectedStenographerExecutionWork({record: expected, recovery: scope.recovery, now: now()});
        if (recovered.status !== "recovered") return false;
        const released = await scope.work.releaseUnstartedClaimForFallback(recovered.claim, {
          canonical: scope.product.canonicalRunner, expectedPolicyRevision: expected.expectedPolicyRevision,
          cancel: () => requests.cancelUnconsumedProcessorRequest!({expected, now: now().getTime()}),
        });
        if (released) recipients.delete(expected.snapshot.requestId, expected.snapshot.recipientGeneration);
        return released;
      });
    }
    const requestId = record.snapshot.requestId;
    return {publish: () => runTracked(async () => {
      assertActive(signal);
      const result = await scope.coordinator.run(requestId, signal);
      if (result.status === "completed") return completed();
      if (result.status === "reconciliation_pending") return {status: "waiting", processed: true, reason: "publication_reconciliation"};
      if (result.status === "retry_scheduled" || result.status === "not_ready") return {status: "waiting", processed: true, reason: "device"};
      if (result.status === "terminal") return {status: "failed", processed: true};
      return unavailable();
    })};
  };

  const outputRepair = createProductionStenographerOutputRepair({crypto: input.crypto, handle, requests, recipients, domains,
    discovery: await verifyConversationProductPostgresHandle(createPostgresJsBridgeConnection(input.db)),
    committedTransforms: new PostgresProcessorTransformCommitVerifier(handle, input.crypto),
    scope: (roomId, signal) => services(roomId, input.resolveModelId(), dualPublication, dualReconciliation, signal),
    authority, createCoordinator, now, track: runTracked,
    ...(input.authorizationRequested === undefined ? {} : {authorizationRequested: input.authorizationRequested})});
  const adapterFor = (decorate: DecoratePublication, reconcileAttachment: ReconciliationAttachment,
    repair?: typeof outputRepair.prepareNext): StenographerIntentAdapter => ({
    ...(repair === undefined ? {} : {prepareNextOutputRepair: (request: Parameters<typeof repair>[0]) => {
      assertActive(request.signal); return repair(request);
    }}),
    prepareExtraction: ({roomId, lane, modelId, now: at, signal}) => prepareRequest(roomId,
      lane === "rebuild" ? "stenographer.rebuild" : lane === "historical" ? "stenographer.historical" : "stenographer.extraction", modelId, at, signal, decorate, reconcileAttachment),
    prepareCompaction: ({roomId, modelId, now: at, signal}) => prepareRequest(roomId, "stenographer.compaction", modelId, at, signal, decorate, reconcileAttachment),
    prepareNextRebuild: async ({signal}) => {
      assertActive(signal);
      const [state] = await input.db.select({roomId: roomJournalState.roomId, generation: roomJournalState.rebuildGeneration,
        target: roomJournalState.rebuildTargetMessageId}).from(roomJournalState)
        .where(isNotNull(roomJournalState.rebuildRequestedAt)).orderBy(asc(roomJournalState.rebuildRequestedAt), asc(roomJournalState.roomId)).limit(1);
      if (state === undefined) return prepared(unavailable());
      if (state.target !== null) return prepared({status: "prepared_rebuild", processed: true, roomId: state.roomId});
      const scope = await services(state.roomId, input.resolveModelId());
      if (scope === null) return prepared(unavailable());
      return {publish: () => runTracked(async () => {
        assertActive(signal);
        const result = await coordinateProtectedJournalRebuild({roomId: state.roomId, rebuildGeneration: state.generation,
          ports: {rebuilds: new PostgresProtectedJournalRebuildRepository(scope.product.handle), publications: scope.publications,
            crypto: {tombstoneObjects: (request) => new PostgresJournalCryptoTombstoneRepository({handle, crypto: input.crypto})
              .tombstoneObjects({...request, signal: AbortSignal.any([signal, request.signal])})},
            now, leaseToken: () => randomUUID()}});
        return result.status === "prepared" ? {status: "prepared_rebuild", processed: true, roomId: state.roomId}
          : result.status === "completed" ? completed() : {status: "waiting", processed: true, reason: "publication_reconciliation"};
      })};
    },
    // The retained converter has no current Domain-key authorization adapter yet.
    // Report no processed work so unrelated due extraction/compaction can continue.
    prepareLegacyConversion: ({signal}) => {assertActive(signal); return Promise.resolve(prepared(unavailable()));},
  });
  return Object.freeze({adapter: adapterFor(protectedPublication, protectedReconciliation), dualAdapter: adapterFor(dualPublication, dualReconciliation, outputRepair.prepareNext), candidates, dispose: async () => {
    disposed = true; recipients.close(); await Promise.allSettled([...activeRuns]);
  }});
}
