import {describe, expect, test} from "bun:test";
import {LatticeCrypto, ProcessorTransformRecipientRegistry, accessRevision, encryptObjectPayload, namespaceGeneration,
  namespaceId, objectId, unixTimestamp, wrapObjectDekForNamespace} from "@nautilo/lattice-crypto";
import {createBackgroundAuthorizationResponseV2, verifyBackgroundAuthorizationResponseV2,
  type BackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {decodeBackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2} from "@nautilo/lattice-crypto/wire";
import {encodeStenographerOutputRepairPlan, type StenographerOutputRepairPlan} from "@nautilo/lattice-bridge";
import {bindConversationProductCanonicalTransactionRunner, verifyConversationProductPostgresHandle, verifyCryptoPostgresHandle,
  PostgresDomainKeyAuthorityRepository, type VerifiedProtectedJournalProcessorObject} from "@nautilo/lattice-bridge/server";
import {BackgroundAuthorizationProcessorCredentialClaimPort, InMemoryBackgroundAuthorizationRepository,
  ProtectedStenographerBackgroundCoordinator, PostgresProtectedJournalPublicationRepository, createCurrentStenographerOutputRepairRecord,
  claimBackgroundAuthorizationRequest, markBackgroundAuthorizationRunning, cancelBackgroundAuthorizationRequest,
  currentStenographerOutputRepairDescriptor, createCurrentStenographerReconciliationRecord,
  currentStenographerReconciliationDescriptor, type BackgroundAuthorizationRecord, type ProtectedJournalPublicationRecord,
  type CurrentProtectedStenographerAuthority} from "@nautilo/runtime";
import {createProductionStenographerOutputRepair, prepareStenographerRepairReconciliation} from "../../src/background/stenographer-output-repair-composition";

import {type PostgresJsBridgeConnection, type PostgresJsBridgeRow} from "@nautilo/db";
import {createHmacProtectedStenographerRecordCommitmentPort} from "@nautilo/reflection-bridge/server";

const NOW = Date.parse("2026-09-10T09:00:00.000Z");
const ROOM = "10000000-0000-4000-8000-000000000001";
const NAMESPACE = "20000000-0000-4000-8000-000000000001";
const BATCH = "30000000-0000-4000-8000-000000000001";
const EVENT = "40000000-0000-4000-8000-000000000001";
const EXISTING = "40000000-0000-4000-8000-000000000002";

async function fixture(mixed = false) {
  const crypto = new LatticeCrypto(); const namespaceKey = crypto.randomBytes(32);
  const ids = mixed ? [EXISTING, EVENT] : [EVENT];
  const outputs = ids.map(id => ({logicalId: id, objectId: `repair/${id}`, objectType: "nautilo.reflection.record.v1" as const,
    createdAt: NOW, disposition: id === EXISTING ? "existing" as const : "create" as const,
    representationGeneration: 1, ordinaryRepresentationGeneration: 2}));
  const plan: StenographerOutputRepairPlan = {version: 2, binding: {receipt: {kind: "extraction", id: BATCH,
    roomId: ROOM, namespaceId: NAMESPACE, rebuildGeneration: 4, fallbackReason: "device",
    ordinaryOutputFingerprint: new Uint8Array(32).fill(7)}, outputs}, snapshot: {roomId: ROOM, namespaceId: NAMESPACE,
    rebuildGeneration: 4, rollup: null, events: outputs.map((output, index) => ({kind: "event", rebuildGeneration: 4, status: "active",
      binding: {eventId: output.logicalId, roomId: ROOM, namespaceId: NAMESPACE, sequence: 21 + index, kind: "fact",
        supersedesEventId: null, resolvesEventId: null, sourceMessageIds: [7], sourceBatchId: BATCH,
        batchLocalOrdinal: index, extractorVersion: "m219-v1", createdAt: new Date(NOW).toISOString()},
      payload: {kind: "reflection_record", recordId: output.logicalId, lifecycle: "current", structuralHeight: 0,
        processingGeneration: 2, ordinaryRepresentationGeneration: 2, protectedMapping: output.disposition === "create"
          ? {status: "missing"} : {status: "mapped", representationGeneration: 1, cryptoObjectId: output.objectId}}}))}};
  const authority: CurrentProtectedStenographerAuthority = {policyRevision: 8, namespace: {serverId: "server", roomId: ROOM,
    namespaceId: NAMESPACE, namespaceAccessRevision: 2, namespaceKeyGeneration: 1, namespaceHeadDigest: new Uint8Array(32).fill(2),
    domainId: "domain", domainKeyGeneration: 3, domainAuthorizationRevision: 4, domainHeadDigest: new Uint8Array(32).fill(3),
    bundleRevision: 5, bundleDigest: new Uint8Array(32).fill(4)}};
  const initial = createCurrentStenographerOutputRepairRecord({crypto, plan, authority, requestId: "repair-original", now: NOW});
  const keys = await crypto.generateEncryptionKeyPair();
  const descriptor = currentStenographerOutputRepairDescriptor({crypto, plan, authority, record: initial, now: NOW,
    attempt: {requestId: initial.snapshot.requestId, workId: initial.snapshot.workId, namespaceId: NAMESPACE,
      recipientGeneration: 0, recipientKeyId: "original-key", recipientPublicKey: keys.publicKey, expiresAt: NOW + 300_000}});
  keys.privateKey.fill(0);
  const original: BackgroundAuthorizationRecord = {...initial, descriptorBytes: descriptor.descriptorBytes,
    snapshot: {...initial.snapshot, descriptorDigest: Buffer.from(descriptor.descriptorHash).toString("hex"), state: "publication_reconciliation"}};
  const bytes = encodeStenographerOutputRepairPlan(plan);
  const receipt: ProtectedJournalPublicationRecord = {publicationId: original.snapshot.requestId, requestId: original.snapshot.requestId,
    workId: original.snapshot.workId, roomId: ROOM, namespaceIdAtAllocation: NAMESPACE, sourceBatchId: BATCH, rebuildGeneration: 4,
    workIdentityHash: original.workIdentityHash, descriptorHash: descriptor.descriptorHash, attachmentPlanHash: crypto.hash(bytes),
    attachmentPlanBytes: bytes, attachmentPlanVersion: 2, outputObjectCount: 1, state: "reserved", leaseToken: null, leaseExpiresAt: null,
    retryCount: 0, maximumAttempts: 8, failureCode: null, lastFailureAt: null, cryptoCommittedAt: null, attachedAt: null,
    tombstoneRequestedAt: null, tombstonedAt: null, lastAuditedAt: null, createdAt: new Date(NOW), updatedAt: new Date(NOW)};
  const objects = new Map(outputs.map((output, index) => {
    const encrypted = encryptObjectPayload(crypto, {objectId: objectId(output.objectId), objectType: output.objectType,
      keyClass: "ai", createdAt: unixTimestamp(NOW)}, new Uint8Array([index + 1]));
    const envelope = wrapObjectDekForNamespace(crypto, namespaceKey, {objectId: objectId(output.objectId), namespaceId: namespaceId(NAMESPACE),
      keyClass: "ai", keyGeneration: namespaceGeneration(1), bindingRevisionAtWrap: accessRevision(2)}, encrypted.dek);
    encrypted.dek.fill(0);
    return [output.objectId, {payload: encrypted.payload, envelope}] as const;
  }));
  let reads = 0; let proofPresent = true;
  const ciphertext = (id: string) => {reads++; const item = objects.get(id)!;
    return {payloadBytes: encodeEncryptedPayloadV2(item.payload), namespaceEnvelopeBytes: encodeNamespaceObjectEnvelopeV2(item.envelope)};};
  const options: Parameters<typeof prepareStenographerRepairReconciliation>[0] = {crypto, original, receipt,
    committedTransforms: {verifyCommit: () => Promise.resolve(proofPresent ? {requestId: original.snapshot.requestId,
      workId: original.snapshot.workId, namespaceId: NAMESPACE, descriptorHash: descriptor.descriptorHash.slice(), recipientGeneration: 0,
      claimId: "original-claim", outputObjectCount: 1, outputObjectIds: [outputs.at(-1)!.objectId],
      authorizedOutputObjectIds: [outputs.at(-1)!.objectId]} : null)},
    createdObjects: {verify: ({objectId}) => Promise.resolve({...ciphertext(objectId), objectId, namespaceId: NAMESPACE,
      domainId: "domain", workId: original.snapshot.workId, rebuildGeneration: 4, outputOrdinal: 0,
      authorizedOutputObjectIds: [outputs.at(-1)!.objectId], publisherNamespaceAccessRevision: 2} satisfies VerifiedProtectedJournalProcessorObject)},
    readExisting: id => Promise.resolve(ciphertext(id)), signal: new AbortController().signal};
  return {crypto, authority, plan, original, receipt, options, objects, namespaceKey,
    reads: () => reads, proofPresent: (value: boolean) => {proofPresent = value;}};
}

describe("production output repair restart proof", () => {
  test.each([false, true])("restart binds exact committed missing objects and the complete mixed inventory (%s)", async mixed => {
    const f = await fixture(mixed);
    const prepared = await prepareStenographerRepairReconciliation(f.options);
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Fixture is not ready");
    expect(prepared.binding.outputs.map(output => output.objectId)).toEqual(f.plan.binding.outputs.map(output => output.objectId));
    expect(prepared.original.snapshot.requestId).toBe("repair-original");
    expect(f.reads()).toBe(mixed ? 2 : 1);
  });
  test("a reserved plan without commit proof never reads an output or schedules a replay", async () => {
    const f = await fixture(); f.proofPresent(false);
    expect(await prepareStenographerRepairReconciliation(f.options)).toEqual({status: "not_started"});
    expect(f.reads()).toBe(0);
  });
  test("a committed receipt with missing marker is integrity failure, not retry permission", async () => {
    const f = await fixture(); f.proofPresent(false);
    const error = await prepareStenographerRepairReconciliation({...f.options, receipt: {...f.receipt, state: "crypto_committed"}}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error); expect(f.reads()).toBe(0);
  });
  test("a substituted original signer fails before a fresh grant can be created", async () => {
    const f = await fixture();
    const error = await prepareStenographerRepairReconciliation({...f.options,
      createdObjects: {verify: async request => {
        const original = await f.options.createdObjects.verify(request);
        return original === null ? null : {...original, workId: "other-work"};
      }}}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
  });
  test("a fresh current grant completes committed mixed output after restart without the old grant, encryption, or model", async () => {
    const f = await fixture(true);
    const prepared = await prepareStenographerRepairReconciliation(f.options);
    if (prepared.status !== "ready") throw new Error("Expected committed outputs");
    const now = NOW + 400_000;
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const record = createCurrentStenographerReconciliationRecord({crypto: f.crypto, prepared, authority: f.authority,
      requestId: "fresh-repair-reconciliation", now});
    await repository.create(record);
    const recipients = new ProcessorTransformRecipientRegistry({crypto: f.crypto, now: () => now});
    const device = f.crypto.generateSigningKeyPair(); let attachments = 0; let models = 0;
    const coordinator = new ProtectedStenographerBackgroundCoordinator({repository, recipients,
      descriptors: {create: ({record, attempt}) => Promise.resolve(currentStenographerReconciliationDescriptor({crypto: f.crypto,
        prepared, authority: f.authority, record, attempt, now}))},
      transformMaterial: {loadAccepted: () => Promise.resolve({status: "loaded", material: {formatVersion: 2, binding: prepared.binding,
        claims: new BackgroundAuthorizationProcessorCredentialClaimPort(repository), resolveCurrentIssuer: () => device.publicKey,
        objects: {openInput: ({objectId}) => Promise.resolve(structuredClone(f.objects.get(objectId)!)),
          withNamespaceKey: (_request, use) => Promise.resolve(use(f.namespaceKey)),
          attach: async ({outputs, authorizeCommit}) => {
            await authorizeCommit(); expect(outputs.map(output => [...output.plaintext])).toEqual([[1], [2]]); attachments++;
          }}}})}, execution: {executeWork: () => {models++; throw new Error("Repair cannot run a model");},
        reconcilePublication: () => Promise.resolve(attachments > 0 ? "completed" : "not_started")},
      now: () => now, recipientKeyId: () => "fresh-key", claimId: () => "fresh-claim", nextAttemptAt: (_record, _reason, at) => at});
    try {
      expect((await coordinator.prepareRecipient(record.snapshot.requestId)).status).toBe("device_authorization_required");
      const pending = (await repository.get(record.snapshot.requestId))!;
      const descriptor: BackgroundProcessorWorkDescriptorV2 = decodeBackgroundProcessorWorkDescriptorV2(pending.descriptorBytes!);
      expect(descriptor.outputSlots).toEqual([]); expect(descriptor.inputBindings).toHaveLength(2);
      const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, {credentialId: "fresh-credential",
        descriptorBytes: pending.descriptorBytes!, issuerSigningPrivateKey: device.privateKey, domainKey: new Uint8Array(32).fill(4),
        issuer: {humanId: "human", deviceId: "device", deviceGeneration: 1, serverInstanceId: "instance", lineageGeneration: 1,
          epoch: 1, securityRevision: 1, headDigest: new Uint8Array(32).fill(7), signingPublicKeyHash: f.crypto.hash(device.publicKey)}});
      const verified = await verifyBackgroundAuthorizationResponseV2(f.crypto, {responseBytes, now, resolveCurrentIssuer: () => device.publicKey});
      expect((await repository.acceptVerifiedResponse({response: {...verified, formatVersion: 2, kind: "processor"}, acceptedAt: now})).status).toBe("accepted");
      expect((await coordinator.run(record.snapshot.requestId, new AbortController().signal)).status).toBe("completed");
      expect(attachments).toBe(1); expect(models).toBe(0);
      expect((await coordinator.run(record.snapshot.requestId, new AbortController().signal)).status).toBe("not_ready");
      expect(attachments).toBe(1);
    } finally {recipients.close(); device.privateKey.fill(0); f.namespaceKey.fill(0);}
  });
});


test("production polling fences a crash before reservation before replacing rotated authority", async () => {
  const f = await fixture(); let now = NOW; let authorityReads = 0; let retirements = 0;
  const transitions: string[] = []; const ids = new Set<string>();
  class Requests extends InMemoryBackgroundAuthorizationRepository {
    override async create(record: BackgroundAuthorizationRecord) {ids.add(record.snapshot.requestId); return super.create(record);}
    override async compareAndSwap(input: Parameters<InMemoryBackgroundAuthorizationRepository["compareAndSwap"]>[0]) {
      const result = await super.compareAndSwap(input);
      if (result.status === "updated") transitions.push(input.next.snapshot.state);
      return result;
    }
    async cancelUnconsumedProcessorRequest({expected}: {expected: BackgroundAuthorizationRecord}) {
      expect(expected.snapshot.state).not.toBe("running");
      return (await this.compareAndSwap({expectedRequestRevision: expected.snapshot.requestRevision,
        next: {...expected, snapshot: cancelBackgroundAuthorizationRequest(expected.snapshot, "superseded", now), finishedAt: now}})).status === "updated";
    }
  }
  const requests = new Requests(); const recipients = new ProcessorTransformRecipientRegistry({crypto: f.crypto, now: () => now});
  const device = f.crypto.generateSigningKeyPair();
  const initial = createCurrentStenographerOutputRepairRecord({crypto: f.crypto, plan: f.plan, authority: f.authority,
    requestId: "old-repair", now});
  await requests.create(initial);
  const originalCoordinator = new ProtectedStenographerBackgroundCoordinator({repository: requests, recipients,
    descriptors: {create: ({record, attempt}) => Promise.resolve(currentStenographerOutputRepairDescriptor({crypto: f.crypto,
      plan: f.plan, authority: f.authority, record, attempt, now}))},
    transformMaterial: {loadAccepted: () => {throw new Error("No transform is expected");}},
    execution: {executeWork: () => {throw new Error("No model is expected");}, reconcilePublication: () => Promise.resolve("not_started")},
    now: () => now, recipientKeyId: () => "old-key", claimId: () => "old-claim", nextAttemptAt: (_record, _reason, at) => at});
  const approve = async (id: string) => {
    const record = (await requests.get(id))!;
    const responseBytes = await createBackgroundAuthorizationResponseV2(f.crypto, {credentialId: `credential-${id}`,
      descriptorBytes: record.descriptorBytes!, issuerSigningPrivateKey: device.privateKey, domainKey: new Uint8Array(32).fill(4),
      issuer: {humanId: "human", deviceId: "device", deviceGeneration: 1, serverInstanceId: "instance", lineageGeneration: 1,
        epoch: 1, securityRevision: 1, headDigest: new Uint8Array(32).fill(7), signingPublicKeyHash: f.crypto.hash(device.publicKey)}});
    const response = await verifyBackgroundAuthorizationResponseV2(f.crypto, {responseBytes, now, resolveCurrentIssuer: () => device.publicKey});
    expect((await requests.acceptVerifiedResponse({response: {...response, formatVersion: 2, kind: "processor"}, acceptedAt: now})).status).toBe("accepted");
  };
  await originalCoordinator.prepareRecipient(initial.snapshot.requestId); await approve(initial.snapshot.requestId);
  const accepted = (await requests.get(initial.snapshot.requestId))!;
  const claimed = {...accepted, snapshot: claimBackgroundAuthorizationRequest(accepted.snapshot, "old-claim", now + 1, now + 10)};
  await requests.compareAndSwap({expectedRequestRevision: accepted.snapshot.requestRevision, next: claimed});
  await requests.compareAndSwap({expectedRequestRevision: claimed.snapshot.requestRevision,
    next: {...claimed, snapshot: markBackgroundAuthorizationRunning(claimed.snapshot, now + 2)}});
  now += 11; transitions.length = 0;
  const sqlCalls: string[] = [];
  const connection = (role: string): PostgresJsBridgeConnection => {
    const query: PostgresJsBridgeConnection["query"] = async <Row extends PostgresJsBridgeRow>(sql: string, parameters: readonly unknown[] = []) => {
      sqlCalls.push(sql); let rows: readonly PostgresJsBridgeRow[] = [];
      if (sql.includes("current_user::text")) rows = [{current_user: role, session_user: role}];
      else if (sql.includes("background_crypto_authorization_requests")) {
        const active = (await Promise.all([...ids].map(id => requests.get(id)))).filter(record => record !== null
          && !["cancelled", "completed", "terminal_failure"].includes(record.snapshot.state));
        const after = parameters.find(value => value === "old-repair");
        rows = active.filter(record => after === undefined || record!.snapshot.requestId > String(after))
          .map(record => ({request_id: record!.snapshot.requestId}));
      } else if (sql.includes('from "room_journal_batches"')) rows = [{id: BATCH, room_id: ROOM, namespace_id: NAMESPACE,
        status: "completed", observation_publication_version: 2, operation_count: 1, extractor_version: "m219-v1",
        ordinary_fallback_reason: "device", ordinary_fallback_rebuild_generation: 4,
        ordinary_output_fingerprint: new Uint8Array(32).fill(7), completed_at: new Date(NOW).toISOString()}];
      else if (sql.includes('from "room_journal_state"')) rows = [{namespace_id: NAMESPACE, rebuild_generation: 4,
        rebuild_requested_at: null, rebuild_target_message_id: null}];
      else if (sql.includes('from "room_events"')) rows = [{event_id: EVENT, room_id: ROOM, sequence: 21, kind: "fact", status: "active",
        supersedes_event_id: null, resolves_event_id: null, source_message_ids: [7], source_batch_id: BATCH, batch_local_ordinal: 0,
        extractor_version: "m219-v1", projection_kind: "native", record_id: EVENT, event_crypto_object_id: null,
        created_at: new Date(NOW).toISOString(), record_lifecycle: "current", record_structural_height: 0, record_processing_generation: 2,
        record_producer_policy_version: "m219-v1", record_payload_version: 1, record_disposition: "available", record_created_at: new Date(NOW).toISOString(),
        ordinary_created_at: new Date(NOW).toISOString(), ordinary_head_generation: 2, ordinary_representation_generation: 2, ordinary_representation_payload_version: 1,
        ordinary_representation_crypto_object_id: null, ordinary_publication_id: "ordinary:event", protected_head_generation: null,
        protected_representation_generation: null, protected_representation_payload_version: null, protected_record_crypto_object_id: null,
        protected_publication_id: null}];
      return rows as readonly Row[];
    };
    const executor = {query}; return {...executor, transaction: use => use(executor), transactionOnce: use => use(executor)};
  };
  const restricted = connection("nautilo_crypto"); const handle = await verifyCryptoPostgresHandle(restricted);
  const product = await verifyConversationProductPostgresHandle(connection("nautilo"));
  const canonicalRunner = bindConversationProductCanonicalTransactionRunner(product, {transaction: () => {throw new Error("Fixture retirement owns its product lock");}});
  const currentAuthority = {...f.authority, policyRevision: f.authority.policyRevision + 1};
  const repair = createProductionStenographerOutputRepair({crypto: f.crypto, handle, discovery: product, requests, recipients,
    domains: new PostgresDomainKeyAuthorityRepository(restricted, f.crypto, "server"),
    committedTransforms: {verifyCommit: () => {throw new Error("A missing reservation cannot have committed repair ciphertext");}},
    scope: () => Promise.resolve({room: {id: ROOM, namespaceId: NAMESPACE}, product: {handle: product, canonicalRunner},
      publications: new PostgresProtectedJournalPublicationRepository(product, createHmacProtectedStenographerRecordCommitmentPort(new Uint8Array(32).fill(7))),
      work: {retireObsoleteUnstartedRequest: async ({retire}) => {retirements++; return retire();}},
      foregroundSigner: () => {throw new Error("No signer reads expected");},
      verifyV5Input: () => {throw new Error("No ciphertext reads expected");}, withValidatedAuthority: () => {throw new Error("No body access expected");}}),
    authority: () => {authorityReads++; return Promise.resolve(structuredClone(currentAuthority));},
    createCoordinator: options => new ProtectedStenographerBackgroundCoordinator(options), now: () => new Date(now), track: run => run()});
  try {
    const first = await repair.prepareNext({now: new Date(now), signal: new AbortController().signal});
    expect(authorityReads).toBe(0); expect(retirements).toBe(0);
    expect((await requests.get(initial.snapshot.requestId))!.snapshot.state).toBe("running");
    await first.publish({revalidationToken: 1});
    expect(transitions.slice(0, 2)).toEqual(["publication_reconciliation", "awaiting_recipient"]);
    expect((await requests.get(initial.snapshot.requestId))!.snapshot.retryCount).toBe(1);
    await repair.prepareNext({now: new Date(now), signal: new AbortController().signal});
    expect((await requests.get(initial.snapshot.requestId))!.snapshot.state).toBe("cancelled");
    const replacementId = [...ids].find(id => id !== initial.snapshot.requestId)!;
    const replacement = (await requests.get(replacementId))!;
    expect(replacement.snapshot.state).toBe("awaiting_device");
    expect(decodeBackgroundProcessorWorkDescriptorV2(replacement.descriptorBytes!).policyRevision).toBe(currentAuthority.policyRevision);
    await approve(replacementId);
    expect((await requests.get(replacementId))!.snapshot.state).toBe("grant_ready");
    expect(retirements).toBe(1);
    expect(sqlCalls.some(sql => /^\s*(?:insert|update|delete)\b/iu.test(sql))).toBe(false);
  } finally {recipients.close(); device.privateKey.fill(0);}
});
