import {randomUUID} from "node:crypto";
import {and, asc, backgroundCryptoAuthorizationRequests, eq, gt, inArray, sql, type PostgresJsBridgeConnection} from "@nautilo/db";
import {type LatticeCrypto, type ProcessorTransformRecipientRegistry} from "@nautilo/lattice-crypto";
import {decodeBackgroundProcessorWorkDescriptorV2, ProcessorReconciliationIntegrityErrorV2,
  type ProcessorPublicationReconciliationBindingV2} from "@nautilo/lattice-crypto/background";
import {decodeEncryptedPayloadV2, encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2} from "@nautilo/lattice-crypto/wire";
import {decodeStenographerOutputRepairPlan, encodeStenographerOutputRepairPlan,
  type StenographerOutputRepairPlan} from "@nautilo/lattice-bridge";
import {
  attachPostgresStenographerOutputRepair, buildStenographerOutputRepairPlan,
  createPostgresCurrentProcessorReconciliationObjectVerifier, createPostgresCurrentProcessorTransformObjectPort,
  createPostgresProcessorTransformObjectPort, cryptoTypedDb, executeTypedCryptoQuery,
  listPostgresStenographerFallbackCandidates, selectPostgresStenographerFallback,
  validatePostgresStenographerOutputRepairPlan, withPostgresStenographerOutputRepairSources,
  type ConversationProductCanonicalTransactionRunner, type ConversationProductPostgresHandle, type CryptoPostgresHandle, type PostgresDomainKeyAuthorityRepository,
  type PostgresStenographerFallbackCandidateCursor, type ProcessorTransformCommitVerifierPort,
  type ProtectedJournalProcessorObjectVerifierPort, type WithCurrentProcessorPublicationAuthority,
  type StenographerPreparedOperation, type StenographerOperationOutcome,
} from "@nautilo/lattice-bridge/server";
import {
  allocateCurrentStenographerOutputRepairPlan, BackgroundAuthorizationProcessorCredentialClaimPort,
  BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH, cancelBackgroundAuthorizationRequest,
  createCurrentStenographerOutputRepairRecord, currentStenographerOutputRepairDescriptor,
  createCurrentStenographerReconciliationRecord, currentStenographerReconciliationDescriptor,
  createProtectedStenographerPublicationFence, exactCommitProof, exactVerifiedObject, receiptMatches,
  type BackgroundAuthorizationRecord, type BackgroundAuthorizationRepository,
  type CurrentProtectedStenographerAuthority, type PostgresProtectedJournalPublicationRepository,
  type ProtectedJournalPublicationRecord, type PostgresProtectedStenographerWorkRepository, type ProtectedStenographerBackgroundCoordinator,
  type ProtectedStenographerBackgroundCoordinatorOptions,
} from "@nautilo/runtime";

const activeStates = ["awaiting_recipient", "awaiting_device", "grant_ready", "claimed", "running", "publication_reconciliation"] as const;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const wipeAuthority = (authority: CurrentProtectedStenographerAuthority) => Object.values(authority.namespace)
  .forEach(value => {if (value instanceof Uint8Array) value.fill(0);});
const waiting = (): StenographerOperationOutcome => ({status: "waiting", processed: true, reason: "device"});
const unavailable = (): StenographerPreparedOperation => ({publish: () => Promise.resolve({status: "unavailable", processed: false})});

type Ciphertext = Readonly<{payloadBytes: Uint8Array; namespaceEnvelopeBytes: Uint8Array}>;
export type PreparedStenographerRepairReconciliation = Readonly<{
  status: "ready"; original: BackgroundAuthorizationRecord; receipt: ProtectedJournalPublicationRecord;
  plan: StenographerOutputRepairPlan; binding: ProcessorPublicationReconciliationBindingV2;
}>;

/** Prove only committed ciphertext. This path has no ordinary loader or model callback. */
export async function prepareStenographerRepairReconciliation(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">; original: BackgroundAuthorizationRecord; receipt: ProtectedJournalPublicationRecord;
  committedTransforms: ProcessorTransformCommitVerifierPort; createdObjects: ProtectedJournalProcessorObjectVerifierPort;
  readExisting(objectId: string, signal: AbortSignal): Promise<Ciphertext>;
  signal: AbortSignal;
}>): Promise<PreparedStenographerRepairReconciliation | Readonly<{status: "not_started" | "completed" | "stale"}>> {
  const {original, receipt} = input;
  input.signal.throwIfAborted();
  if (original.workKind !== "stenographer.output_repair" || original.descriptorBytes === null
    || receipt.attachmentPlanVersion !== 2 || !receiptMatches(original, receipt)) {
    throw new ProcessorReconciliationIntegrityErrorV2("Repair reconciliation receipt differs from original work");
  }
  if (receipt.state === "attached") return {status: "completed"};
  if (receipt.state !== "reserved" && receipt.state !== "crypto_committed") return {status: "stale"};
  const plan = decodeStenographerOutputRepairPlan(receipt.attachmentPlanBytes);
  const descriptor = decodeBackgroundProcessorWorkDescriptorV2(original.descriptorBytes);
  const expected = createCurrentStenographerOutputRepairRecord({crypto: input.crypto, plan,
    authority: {namespace: descriptor.authority, policyRevision: descriptor.policyRevision},
    requestId: original.snapshot.requestId, now: original.snapshot.createdAt});
  if (!same(expected.workIdentityHash, original.workIdentityHash) || expected.idempotencyKey !== original.idempotencyKey
    || expected.snapshot.workId !== original.snapshot.workId) {
    throw new ProcessorReconciliationIntegrityErrorV2("Repair reconciliation plan identity changed");
  }
  const created = plan.binding.outputs.filter(output => output.disposition === "create");
  const createdIds = created.map(output => output.objectId);
  const authorizedIds = descriptor.outputSlots.map(output => output.objectId);
  const proof = await input.committedTransforms.verifyCommit({requestId: original.snapshot.requestId,
    workId: original.snapshot.workId, namespaceId: original.snapshot.namespaceId, descriptorHash: receipt.descriptorHash,
    recipientGeneration: original.snapshot.recipientGeneration, signal: input.signal});
  if (proof === null) {
    if (receipt.state === "crypto_committed") throw new ProcessorReconciliationIntegrityErrorV2("Repair commit proof disappeared");
    return {status: "not_started"};
  }
  try {
    if (createdIds.length !== receipt.outputObjectCount || !exactCommitProof(proof, original, receipt, createdIds, authorizedIds)) {
      throw new ProcessorReconciliationIntegrityErrorV2("Repair commit proof differs from exact missing outputs");
    }
  } finally {proof.descriptorHash.fill(0);}
  const outputs: ProcessorPublicationReconciliationBindingV2["outputs"][number][] = [];
  for (const output of plan.binding.outputs) {
    input.signal.throwIfAborted();
    const verified = output.disposition === "create"
      ? await input.createdObjects.verify({objectId: output.objectId, signal: input.signal}) : null;
    if (output.disposition === "create" && verified === null) throw new ProcessorReconciliationIntegrityErrorV2("Committed repair output is missing");
    const stored = verified ?? await input.readExisting(output.objectId, input.signal);
    try {
      if (verified !== null && !exactVerifiedObject(verified,
        {objectId: output.objectId, outputOrdinal: createdIds.indexOf(output.objectId), authorizedOutputObjectIds: authorizedIds,
          record: original, receipt})) throw new ProcessorReconciliationIntegrityErrorV2("Repair output original signer differs");
      const payload = decodeEncryptedPayloadV2(stored.payloadBytes);
      if (payload.context.objectId !== output.objectId || payload.context.objectType !== output.objectType
        || payload.context.createdAt !== output.createdAt || payload.context.keyClass !== "ai") {
        throw new ProcessorReconciliationIntegrityErrorV2("Repair output payload coordinates changed");
      }
      payload.ciphertext.fill(0);
      outputs.push({objectId: output.objectId, objectType: output.objectType, createdAt: output.createdAt,
        payloadHash: input.crypto.hash(stored.payloadBytes), envelopeHash: input.crypto.hash(stored.namespaceEnvelopeBytes)});
    } finally {stored.payloadBytes.fill(0); stored.namespaceEnvelopeBytes.fill(0);}
  }
  return {status: "ready", original, receipt, plan, binding: {originalRequestId: original.snapshot.requestId,
    originalWorkId: original.snapshot.workId, originalRecipientGeneration: original.snapshot.recipientGeneration,
    originalDescriptorHash: receipt.descriptorHash.slice(), attachmentPlanHash: receipt.attachmentPlanHash.slice(), outputs}};
}

export interface StenographerOutputRepairScope {
  readonly room: Readonly<{id: string; namespaceId: string}>;
  readonly product: Readonly<{handle: ConversationProductPostgresHandle; canonicalRunner: ConversationProductCanonicalTransactionRunner}>;
  readonly work: Pick<PostgresProtectedStenographerWorkRepository, "retireObsoleteUnstartedRequest">;
  readonly publications: PostgresProtectedJournalPublicationRepository;
  readonly foregroundSigner: NonNullable<Parameters<typeof createPostgresCurrentProcessorTransformObjectPort>[0]["resolveLiveShadowAgentSigner"]>;
  readonly verifyV5Input: NonNullable<Parameters<typeof createPostgresCurrentProcessorTransformObjectPort>[0]["verifyV5Input"]>;
  withValidatedAuthority(validateProduct: (product: PostgresJsBridgeConnection) => Promise<boolean>): WithCurrentProcessorPublicationAuthority;
}

/** Scheduled only through Lattice's dual adapter; all bodies remain inside current device authority. */
export function createProductionStenographerOutputRepair(input: Readonly<{
  crypto: LatticeCrypto; handle: CryptoPostgresHandle; discovery: ConversationProductPostgresHandle;
  requests: BackgroundAuthorizationRepository; recipients: ProcessorTransformRecipientRegistry;
  domains: PostgresDomainKeyAuthorityRepository; committedTransforms: ProcessorTransformCommitVerifierPort;
  scope(roomId: string, signal: AbortSignal): Promise<StenographerOutputRepairScope | null>;
  authority(roomId: string, namespaceId: string): Promise<CurrentProtectedStenographerAuthority | null>;
  createCoordinator(options: ProtectedStenographerBackgroundCoordinatorOptions): Pick<ProtectedStenographerBackgroundCoordinator, "prepareRecipient" | "run">;
  authorizationRequested?(record: BackgroundAuthorizationRecord): Promise<void>;
  now(): Date;
  track<Value>(run: () => Promise<Value>): Promise<Value>;
}>): Readonly<{prepareNext(input: Readonly<{now: Date; signal: AbortSignal}>): Promise<StenographerPreparedOperation>}> {
  const claims = new BackgroundAuthorizationProcessorCredentialClaimPort(input.requests);
  let queueAfter: string | undefined;
  let discoveryAfter: PostgresStenographerFallbackCandidateCursor | undefined;
  const records = async (workKind: "stenographer.output_repair" | "stenographer.publication_reconcile",
    filter: Readonly<{workId?: string; prefix?: string; after?: string}> = {}) => {
    const table = backgroundCryptoAuthorizationRequests;
    const rows = await executeTypedCryptoQuery(input.handle, cryptoTypedDb.select({request_id: table.requestId}).from(table)
      .where(and(eq(table.formatVersion, 2), eq(table.credentialSubjectKind, "processor"),
        eq(table.workKind, workKind), inArray(table.state, activeStates),
        ...(filter.workId === undefined ? [] : [eq(table.workId, filter.workId)]),
        ...(filter.prefix === undefined ? [] : [sql`${table.workId} like ${`${filter.prefix}%`}`]),
        ...(filter.after === undefined ? [] : [gt(table.requestId, filter.after)])))
      .orderBy(asc(table.requestId)).limit(BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH));
    const result: BackgroundAuthorizationRecord[] = [];
    for (const row of rows) {const record = await input.requests.get(row.request_id); if (record !== null) result.push(record);}
    return {records: result, continuation: rows.length < BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH ? undefined : rows.at(-1)!.request_id};
  };
  const cancel = async (scope: StenographerOutputRepairScope, record: BackgroundAuthorizationRecord) => {
    const now = input.now().getTime();
    const abandonedReconciliation = record.workKind === "stenographer.publication_reconcile"
      && (record.snapshot.state === "publication_reconciliation" || (record.snapshot.state === "running" && (record.snapshot.claimExpiresAt ?? Infinity) <= now));
    const abandonedRepair = record.workKind === "stenographer.output_repair" && record.snapshot.state === "publication_reconciliation";
    if (!abandonedReconciliation && !abandonedRepair && !["awaiting_recipient", "awaiting_device", "grant_ready", "claimed"].includes(record.snapshot.state)) return false;
    if (record.workKind === "stenographer.output_repair") {
      return scope.work.retireObsoleteUnstartedRequest({roomId: scope.room.id, namespaceId: scope.room.namespaceId,
        workId: record.snapshot.workId, canonical: scope.product.canonicalRunner, retire: async () => {
          const retired = await input.requests.cancelUnconsumedProcessorRequest?.({expected: record, reason: "superseded", now}) ?? false;
          if (retired) input.recipients.delete(record.snapshot.requestId, record.snapshot.recipientGeneration);
          return retired;
        }});
    }
    const result = await input.requests.compareAndSwap({expectedRequestRevision: record.snapshot.requestRevision,
      next: {...record, snapshot: cancelBackgroundAuthorizationRequest(record.snapshot, "superseded", now), finishedAt: now}});
    if (result.status !== "updated") return false;
    input.recipients.delete(record.snapshot.requestId, record.snapshot.recipientGeneration);
    return true;
  };
  const obtain = async (candidate: BackgroundAuthorizationRecord) => {
    const old = await input.requests.getByIdempotencyKey?.(candidate.idempotencyKey);
    if (old !== undefined && old !== null) {
      if (!same(old.workIdentityHash, candidate.workIdentityHash) || old.workKind !== candidate.workKind
        || old.snapshot.workId !== candidate.snapshot.workId) throw new ProcessorReconciliationIntegrityErrorV2("Repair queue identity differs");
      return old;
    }
    try {return (await input.requests.create(candidate)).record;}
    catch (cause) {
      const winner = await input.requests.getByIdempotencyKey?.(candidate.idempotencyKey);
      if (winner === undefined || winner === null || !same(winner.workIdentityHash, candidate.workIdentityHash)) throw cause;
      return winner;
    }
  };
  const coordinatorBase = () => ({repository: input.requests, recipients: input.recipients,
    ...(input.authorizationRequested === undefined ? {} : {authorizationRequested: input.authorizationRequested}),
    now: () => input.now().getTime(), recipientKeyId: () => randomUUID(), claimId: () => randomUUID(),
    nextAttemptAt: (_record: BackgroundAuthorizationRecord, _reason: unknown, now: number) => now});
  const prepareCoordinator = async (coordinator: Pick<ProtectedStenographerBackgroundCoordinator, "prepareRecipient" | "run">,
    record: BackgroundAuthorizationRecord) => {
    if (record.snapshot.state === "awaiting_recipient" || record.snapshot.state === "awaiting_device") {
      const result = await coordinator.prepareRecipient(record.snapshot.requestId);
      if (result.status === "device_authorization_required") {result.descriptorBytes.fill(0); result.descriptorHash.fill(0);}
      return await input.requests.get(record.snapshot.requestId) ?? record;
    }
    return record;
  };
  const runnable = (record: BackgroundAuthorizationRecord) => record.snapshot.state === "grant_ready"
    || record.snapshot.state === "publication_reconciliation"
    || ((record.snapshot.state === "running" || record.snapshot.state === "claimed")
      && (record.snapshot.claimExpiresAt ?? Number.POSITIVE_INFINITY) <= input.now().getTime());

  const reconcile = async (scope: StenographerOutputRepairScope, original: BackgroundAuthorizationRecord,
    signal: AbortSignal): Promise<"completed" | "pending" | "stale" | "not_started"> => {
    if (original.snapshot.state === "running"
      && await createProtectedStenographerPublicationFence(input.requests).fence({record: original, now: input.now()}) !== "fenced") return "pending";
    const load = async () => {
      const receipt = await scope.publications.get(original.snapshot.requestId);
      if (receipt === null) return {status: "not_started" as const};
      if (receipt.state === "superseded" && receipt.failureCode === "crypto_publication_failed"
        && receipt.cryptoCommittedAt === null && receipt.attachedAt === null) return {status: "not_started" as const};
      return prepareStenographerRepairReconciliation({crypto: input.crypto, original, receipt,
        committedTransforms: input.committedTransforms,
        createdObjects: createPostgresCurrentProcessorReconciliationObjectVerifier({handle: input.handle, crypto: input.crypto,
          original: {requestId: original.snapshot.requestId, recipientGeneration: original.snapshot.recipientGeneration,
            descriptorHash: receipt.descriptorHash}, verifyV5Input: scope.verifyV5Input}),
        readExisting: async (objectId, signal) => {
          const opened = await createPostgresProcessorTransformObjectPort({handle: input.handle, crypto: input.crypto, resolveLiveShadowAgentSigner: scope.foregroundSigner,
            verifyV5Input: scope.verifyV5Input}).openInput({objectId, signal});
          try {return {payloadBytes: encodeEncryptedPayloadV2(opened.payload), namespaceEnvelopeBytes: encodeNamespaceObjectEnvelopeV2(opened.envelope)};}
          finally {opened.payload.ciphertext.fill(0); opened.envelope.wrappedDek.fill(0);}
        }, signal});
    };
    const prepared = await load();
    if (prepared.status === "not_started") {
      const receipt = await scope.publications.get(original.snapshot.requestId);
      if (receipt === null || (receipt.state === "superseded" && receipt.failureCode === "crypto_publication_failed")) return "not_started";
      const leaseToken = randomUUID();
      const claim = await scope.publications.claim({publicationId: receipt.publicationId, leaseToken, now: input.now()});
      if (claim.status !== "claimed") return "pending";
      // Recheck after taking the receipt lease. The original processor was fenced above.
      const current = await load();
      if (current.status !== "not_started") return "pending";
      const abandoned = await scope.publications.abandonReserved({publicationId: receipt.publicationId,
        leaseToken, descriptorHash: receipt.descriptorHash, now: input.now()});
      return abandoned.status === "abandoned" || abandoned.status === "duplicate" ? "not_started" : "pending";
    }
    if (prepared.status !== "ready") return prepared.status;
    const authority = await input.authority(scope.room.id, scope.room.namespaceId);
    if (authority === null) return "pending";
    let record: BackgroundAuthorizationRecord;
    try {
      const candidate = createCurrentStenographerReconciliationRecord({crypto: input.crypto, prepared, authority,
        requestId: randomUUID(), now: input.now().getTime()});
      for (const stale of (await records("stenographer.publication_reconcile", {workId: candidate.snapshot.workId})).records) {
        if (stale.idempotencyKey !== candidate.idempotencyKey && !await cancel(scope, stale)) return "pending";
      }
      record = await obtain(candidate);
    } finally {wipeAuthority(authority);}
    const coordinator = input.createCoordinator({...coordinatorBase(),
      descriptors: {create: async ({record, attempt}) => {
        const prepared = await load(); const authority = await input.authority(scope.room.id, scope.room.namespaceId);
        if (prepared.status !== "ready" || authority === null) throw new Error("Repair reconciliation source or authority changed");
        try {return currentStenographerReconciliationDescriptor({crypto: input.crypto, prepared, authority, record, attempt, now: input.now().getTime()});}
        finally {wipeAuthority(authority);}
      }}, transformMaterial: {loadAccepted: async record => {
        const prepared = await load();
        if (prepared.status !== "ready" || record.acceptedMaterial === null) return {status: "integrity_failure"};
        const leaseToken = randomUUID();
        const claim = await scope.publications.claim({publicationId: original.snapshot.requestId, leaseToken, now: input.now()});
        if (claim.status !== "claimed") throw new Error("Repair reconciliation lease is unavailable");
        const port = createPostgresCurrentProcessorTransformObjectPort({handle: input.handle, crypto: input.crypto, resolveLiveShadowAgentSigner: scope.foregroundSigner,
          responseBytes: record.acceptedMaterial.responseBytes, domainKeys: input.domains, verifyV5Input: scope.verifyV5Input,
          withCurrentAuthority: scope.withValidatedAuthority(transaction => validatePostgresStenographerOutputRepairPlan({transaction, plan: prepared.plan})),
          reconciliation: {binding: prepared.binding, attach: async ({held, outputs, signal, authorizedAt}) => {
            if (held.product === undefined) throw new Error("Repair reconciliation requires current product authority");
            await scope.publications.completeOutputRepairWithinTransaction(held.product, {publicationId: original.snapshot.requestId,
              leaseToken, expected: prepared.receipt, now: new Date(authorizedAt),
              attach: () => attachPostgresStenographerOutputRepair({transaction: held.product!, plan: prepared.plan, outputs,
                publicationId: original.snapshot.requestId, requestCommitment: prepared.receipt.attachmentPlanHash,
                publicationBindingRef: original.snapshot.requestId, signal})});
          }}});
        if (port.reconciliationObjects === undefined) throw new Error("Repair reconciliation port unavailable");
        return {status: "loaded", material: {formatVersion: 2, binding: prepared.binding, claims,
          objects: port.reconciliationObjects, resolveCurrentIssuer: port.resolveCurrentIssuer}};
      }}, execution: {executeWork: () => {throw new Error("Repair reconciliation cannot run a model");},
        reconcilePublication: async () => (await scope.publications.get(original.snapshot.requestId))?.state === "attached" ? "completed" : "not_started"}});
    record = await prepareCoordinator(coordinator, record);
    if (!runnable(record)) return record.snapshot.state === "completed" ? "completed" : "pending";
    const result = await coordinator.run(record.snapshot.requestId, signal);
    return result.status === "completed" ? "completed" : result.status === "terminal" ? "stale" : "pending";
  };

  const prepareRecord = async (scope: StenographerOutputRepairScope, record: BackgroundAuthorizationRecord,
    plan: StenographerOutputRepairPlan | null, signal: AbortSignal): Promise<StenographerPreparedOperation | null> => {
    const coordinator = input.createCoordinator({...coordinatorBase(),
      descriptors: {create: async ({record, attempt}) => {
        const authority = await input.authority(scope.room.id, scope.room.namespaceId);
        if (plan === null || authority === null) throw new Error("Repair plan is unavailable");
        try {return currentStenographerOutputRepairDescriptor({crypto: input.crypto, plan, authority, record, attempt, now: input.now().getTime()});}
        finally {wipeAuthority(authority);}
      }}, transformMaterial: {loadAccepted: async record => {
        const durable = await input.requests.get(record.snapshot.requestId);
        if (plan === null || durable?.acceptedMaterial == null || durable.snapshot.requestRevision !== record.snapshot.requestRevision) return {status: "integrity_failure"};
        const exactPlan = plan;
        const bytes = encodeStenographerOutputRepairPlan(exactPlan); const hash = input.crypto.hash(bytes);
        const leaseToken = randomUUID(); let receipt: ProtectedJournalPublicationRecord | undefined;
        const port = createPostgresCurrentProcessorTransformObjectPort({handle: input.handle, crypto: input.crypto, resolveLiveShadowAgentSigner: scope.foregroundSigner,
          responseBytes: durable.acceptedMaterial.responseBytes, domainKeys: input.domains, verifyV5Input: scope.verifyV5Input,
          withCurrentAuthority: scope.withValidatedAuthority(transaction => validatePostgresStenographerOutputRepairPlan({transaction, plan: exactPlan})),
          outputRepair: {binding: exactPlan.binding,
            withOrdinaryOutputs: async ({held, signal}, use) => {
              if (held.product === undefined) throw new Error("Repair requires current product authority");
              receipt = await scope.publications.reserveOutputRepairWithinTransaction(held.product, {publicationId: record.snapshot.requestId,
                requestId: record.snapshot.requestId, workId: record.snapshot.workId, workIdentityHash: record.workIdentityHash,
                descriptorHash: Uint8Array.from(Buffer.from(record.snapshot.descriptorDigest!, "hex")), attachmentPlanBytes: bytes,
                attachmentPlanHash: hash, leaseToken, now: input.now()});
              await withPostgresStenographerOutputRepairSources({transaction: held.product, plan: exactPlan, signal,
                use: sources => use(sources.map((source, i) => ({logicalId: source.logicalId,
                  objectId: exactPlan.binding.outputs[i]!.objectId, fingerprintCreatedAt: source.fingerprintCreatedAt, plaintext: source.plaintextBytes!})))});
            }, attach: async ({held, outputs, signal, authorizedAt}) => {
              if (held.product === undefined || receipt === undefined) throw new Error("Repair publication reservation is missing");
              await scope.publications.completeOutputRepairWithinTransaction(held.product, {publicationId: record.snapshot.requestId,
                leaseToken, expected: receipt, now: new Date(authorizedAt), attach: () => attachPostgresStenographerOutputRepair({
                  transaction: held.product!, plan: exactPlan, outputs, publicationId: record.snapshot.requestId,
                  requestCommitment: hash, publicationBindingRef: record.snapshot.requestId, signal})});
            }}});
        if (port.outputRepairObjects === undefined) throw new Error("Output repair object port unavailable");
        return {status: "loaded", material: {formatVersion: 2, repairBinding: exactPlan.binding, claims,
          objects: port.outputRepairObjects, resolveCurrentIssuer: port.resolveCurrentIssuer}};
      }}, execution: {executeWork: () => {throw new Error("Output repair cannot run a model");},
        reconcilePublication: async record => {
          return reconcile(scope, record, signal);
        }}});
    record = await prepareCoordinator(coordinator, record);
    if (!runnable(record)) return null;
    const requestId = record.snapshot.requestId;
    return {publish: () => input.track(async () => {
      signal.throwIfAborted();
      const result = await coordinator.run(requestId, signal);
      return result.status === "completed" ? {status: "completed", processed: true}
        : result.status === "terminal" ? {status: "failed", processed: true} : waiting();
    })};
  };

  return {prepareNext: async ({signal}) => {
    signal.throwIfAborted();
    const queuePage = await records("stenographer.output_repair", {...(queueAfter === undefined ? {} : {after: queueAfter})});
    const queued = queuePage.records;
    queueAfter = queuePage.continuation;
    let awaitingDevice = false;
    const seen = new Set<string>();
    for (const record of queued) {
      const parts = /^repair:(extraction|compaction):([0-9a-f-]+):[0-9a-f]{64}$/u.exec(record.snapshot.workId);
      if (parts === null) throw new Error("Durable output repair work identity is invalid");
      const kind = parts[1] as "extraction" | "compaction"; const id = parts[2]!;
      // The plan's Room is available in the descriptor once recipient preparation
      // completed; before then exact receipt selection resolves it through discovery.
      if (record.descriptorBytes === null) continue;
      seen.add(`${kind}:${id}`);
      const descriptor = decodeBackgroundProcessorWorkDescriptorV2(record.descriptorBytes);
      const scope = await input.scope(descriptor.authority.roomId, signal);
      if (scope === null) continue;
      const receipt = await scope.publications.get(record.snapshot.requestId);
      // An expired publisher must lose its old execution authority before a
      // metadata replan can retire it, including a crash before reservation.
      if (receipt === null && (record.snapshot.state === "running" || record.snapshot.state === "publication_reconciliation")) {
        const recovery = await prepareRecord(scope, record, null, signal);
        if (recovery !== null) {queueAfter = record.snapshot.requestId; return recovery;}
        continue;
      }
      let plan: StenographerOutputRepairPlan | null = null;
      const abandoned = receipt?.state === "superseded" && receipt.failureCode === "crypto_publication_failed"
        && receipt.cryptoCommittedAt === null && receipt.attachedAt === null;
      if (receipt !== null && !abandoned) plan = decodeStenographerOutputRepairPlan(receipt.attachmentPlanBytes);
      else {
        const selection = await selectPostgresStenographerFallback({product: scope.product.handle, receipt: {kind, id}});
        if (selection.status !== "ready") {await cancel(scope, record); continue;}
        const authority = await input.authority(scope.room.id, scope.room.namespaceId);
        if (selection.status === "ready" && authority !== null) {
          try {
            const seed = buildStenographerOutputRepairPlan({selection, objectIdForMissing: (_id, i) => `repair-unallocated:${i}`});
            if (seed !== null) plan = allocateCurrentStenographerOutputRepairPlan({crypto: input.crypto, plan: seed, authority});
            else {await cancel(scope, record); continue;}
            if (plan !== null) {
              const candidate = createCurrentStenographerOutputRepairRecord({crypto: input.crypto, plan, authority,
                requestId: record.snapshot.requestId, now: record.snapshot.createdAt});
              if (!same(candidate.workIdentityHash, record.workIdentityHash)) {await cancel(scope, record); seen.delete(`${kind}:${id}`); continue;}
            }
          } finally {wipeAuthority(authority);}
        }
        if (plan === null) continue;
      }
      const prepared = await prepareRecord(scope, record, plan, signal);
      if (prepared !== null) {queueAfter = record.snapshot.requestId; return prepared;}
      awaitingDevice = true;
    }
    {
      const page = await listPostgresStenographerFallbackCandidates({product: input.discovery,
        limit: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH, ...(discoveryAfter === undefined ? {} : {after: discoveryAfter})});
      for (const candidate of page.candidates) {
        discoveryAfter = {createdAt: candidate.createdAt, kind: candidate.kind, id: candidate.id};
        if (seen.has(`${candidate.kind}:${candidate.id}`)) continue;
        const scope = await input.scope(candidate.roomId, signal); if (scope === null) continue;
        const selection = await selectPostgresStenographerFallback({product: scope.product.handle, receipt: candidate});
        if (selection.status !== "ready") continue;
        const authority = await input.authority(candidate.roomId, candidate.namespaceId); if (authority === null) continue;
        try {
          const seed = buildStenographerOutputRepairPlan({selection, objectIdForMissing: (_id, i) => `repair-unallocated:${i}`});
          if (seed === null) continue;
          const plan = allocateCurrentStenographerOutputRepairPlan({crypto: input.crypto, plan: seed, authority});
          const next = createCurrentStenographerOutputRepairRecord({crypto: input.crypto, plan, authority,
            requestId: randomUUID(), now: input.now().getTime()});
          const prior = await records("stenographer.output_repair", {prefix: `repair:${candidate.kind}:${candidate.id}:`});
          let blocked = prior.continuation !== undefined;
          for (const old of prior.records) {
            if (old.idempotencyKey !== next.idempotencyKey && !await cancel(scope, old)) blocked = true;
          }
          if (blocked) continue;
          const record = await obtain(next);
          const prepared = await prepareRecord(scope, record, plan, signal);
          if (prepared !== null) return prepared;
          awaitingDevice = true;
        } finally {wipeAuthority(authority);}
      }
      discoveryAfter = page.continuation ?? undefined;
      return awaitingDevice ? {publish: () => Promise.resolve(waiting())} : unavailable();
    }
  }};
}
