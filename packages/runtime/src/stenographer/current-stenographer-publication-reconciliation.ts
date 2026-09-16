import {createHash} from "node:crypto";
import type {LatticeCrypto, ProcessorTransformInput, ProcessorTransformRecipientAttempt} from "@nautilo/lattice-crypto";
import {ProcessorReconciliationIntegrityErrorV2, decodeBackgroundProcessorWorkDescriptorV2, encodeBackgroundWorkDescriptorV2,
  publicationReconciliationFingerprintV2, type BackgroundProcessorWorkDescriptorV2,
  type ProcessorPublicationReconciliationBindingV2} from "@nautilo/lattice-crypto/background";
import {decodeEncryptedPayloadV2} from "@nautilo/lattice-crypto/wire";
import {assertRoomEventRollupPayloadBindingV1, decodeRoomEventRollupPayloadV1} from "@nautilo/lattice-bridge";
import {assertStenographerRecordPayloadBinding, decodeDurableRecordEnvelope} from "@nautilo/reflection-bridge/server";
import type {ProcessorTransformCommitVerifierPort, ProtectedJournalProcessorObjectVerifierPort} from "@nautilo/lattice-bridge/server";
import {createBackgroundAuthorizationRequestV2} from "../protected-execution/background-authorization/lifecycle";
import {parseBackgroundAuthorizationRecord, type BackgroundAuthorizationRecord} from "../protected-execution/background-authorization/repository";
import {decodeProtectedJournalAttachmentPlanV1} from "./protected-journal-output-planner";
import type {ProtectedJournalPublicationRecord} from "./protected-publication-repository";
import {ProtectedStenographerWorkCompositionError, recoverProtectedStenographerExecutionWork, type CurrentProtectedStenographerAuthority,
  type ProtectedStenographerDurableWorkRecoveryPort, type ProtectedStenographerRecoveredExecutionWork} from "./protected-stenographer-work-composition";
import {receiptMatches, expectedOutputObjectIds, recoveredOutputObjectIds, exactVerifiedObject, exactCommitProof,
  wipeVerified, type ProtectedStenographerPublicationFencePort,
  type ProtectedStenographerPublicationReconciliationRepository} from "./protected-stenographer-publication-reconciliation";

const hash = (bytes: Uint8Array) => Uint8Array.from(createHash("sha256").update(bytes).digest());
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);
export type PreparedCurrentStenographerReconciliation = Readonly<{
  status: "ready";
  original: BackgroundAuthorizationRecord;
  receipt: ProtectedJournalPublicationRecord;
  recovered: Extract<ProtectedStenographerRecoveredExecutionWork, {status: "recovered"}>;
  binding: ProcessorPublicationReconciliationBindingV2;
}>;

/** Metadata/ciphertext proof only: the original attempt can never be executed here. */
export async function prepareCurrentStenographerReconciliation(input: Readonly<{
  original: BackgroundAuthorizationRecord;
  publications: Pick<ProtectedStenographerPublicationReconciliationRepository, "get">;
  recovery: ProtectedStenographerDurableWorkRecoveryPort;
  fence: ProtectedStenographerPublicationFencePort;
  committedTransforms: ProcessorTransformCommitVerifierPort;
  verifiedObjects: ProtectedJournalProcessorObjectVerifierPort;
  now: Date;
  signal: AbortSignal;
}>): Promise<PreparedCurrentStenographerReconciliation | Readonly<{status: "pending" | "completed" | "stale"}>> {
  const record = input.original;
  input.signal.throwIfAborted();
  if (record.snapshot.formatVersion !== 2 || record.snapshot.credentialSubject.kind !== "processor"
    || record.workKind === "stenographer.publication_reconcile"
    || record.descriptorBytes === null) return {status: "stale"};
  if (record.snapshot.state === "running") {
    if (await input.fence.fence({record, now: input.now}) !== "fenced") return {status: "pending"};
  } else if (record.snapshot.state !== "publication_reconciliation" && record.snapshot.state !== "completed") return {status: "pending"};
  const receipt = await input.publications.get(record.snapshot.requestId);
  if (receipt === null) return {status: "pending"};
  if (!receiptMatches(record, receipt)) throw new ProcessorReconciliationIntegrityErrorV2("Reconciliation original receipt conflicts");
  if (receipt.state === "attached") return {status: "completed"};
  if (receipt.state !== "reserved" && receipt.state !== "crypto_committed") return {status: "stale"};
  const descriptor = decodeBackgroundProcessorWorkDescriptorV2(record.descriptorBytes);
  const ids = expectedOutputObjectIds(receipt);
  const authorizedIds = descriptor.outputSlots.map(output => output.objectId);
  const proof = await input.committedTransforms.verifyCommit({requestId: record.snapshot.requestId,
    workId: record.snapshot.workId, namespaceId: record.snapshot.namespaceId, descriptorHash: receipt.descriptorHash,
    recipientGeneration: record.snapshot.recipientGeneration, signal: input.signal});
  // A reserved plan contains no model result. Absence is never permission to rerun.
  if (proof === null) {
    if (receipt.state === "crypto_committed") throw new ProcessorReconciliationIntegrityErrorV2("Committed reconciliation marker is missing");
    return {status: "pending"};
  }
  try {
    if (!exactCommitProof(proof, record, receipt, ids, authorizedIds)) throw new ProcessorReconciliationIntegrityErrorV2("Reconciliation commit proof conflicts");
  } finally {proof.descriptorHash.fill(0);}
  let recovered: ProtectedStenographerRecoveredExecutionWork;
  try {recovered = await recoverProtectedStenographerExecutionWork({record, recovery: input.recovery, now: input.now});}
  catch (cause) {
    if (!(cause instanceof ProtectedStenographerWorkCompositionError)) throw cause;
    if (cause.reason === "stale_work" || cause.reason === "stale_authority") return {status: "stale"};
    throw new ProcessorReconciliationIntegrityErrorV2("Reconciliation durable source evidence conflicts");
  }
  if (recovered.status !== "recovered") return {status: recovered.status === "leased" ? "pending" : "stale"};
  if (recovered.work.roomId !== receipt.roomId || recovered.work.namespaceId !== receipt.namespaceIdAtAllocation
    || recovered.work.rebuildGeneration !== receipt.rebuildGeneration
    || !same(recovered.work.workIdentityHash, receipt.workIdentityHash)
    || !same(recovered.work.descriptorHash, receipt.descriptorHash)
    || recoveredOutputObjectIds(recovered).some((id, index) => id !== authorizedIds[index])) return {status: "stale"};
  const outputs: ProcessorPublicationReconciliationBindingV2["outputs"][number][] = [];
  for (const [index, objectId] of ids.entries()) {
    input.signal.throwIfAborted();
    const verified = await input.verifiedObjects.verify({objectId, signal: input.signal});
    try {
      if (verified === null || !exactVerifiedObject(verified, {objectId, outputOrdinal: index,
        authorizedOutputObjectIds: authorizedIds, record, receipt})) throw new ProcessorReconciliationIntegrityErrorV2("Reconciliation output evidence conflicts");
      const payload = decodeEncryptedPayloadV2(verified.payloadBytes);
      const slot = descriptor.outputSlots[index]!;
      if (payload.context.objectId !== objectId || payload.context.objectType !== slot.objectType
        || payload.context.createdAt !== slot.createdAt || payload.context.keyClass !== "ai") throw new ProcessorReconciliationIntegrityErrorV2("Reconciliation payload coordinates conflict");
      outputs.push({objectId, objectType: slot.objectType, createdAt: slot.createdAt,
        payloadHash: hash(verified.payloadBytes), envelopeHash: hash(verified.namespaceEnvelopeBytes)});
    } finally {wipeVerified(verified);}
  }
  input.signal.throwIfAborted();
  return {status: "ready", original: record, receipt, recovered, binding: {
    originalRequestId: record.snapshot.requestId, originalWorkId: record.snapshot.workId,
    originalRecipientGeneration: record.snapshot.recipientGeneration,
    originalDescriptorHash: Uint8Array.from(receipt.descriptorHash), attachmentPlanHash: Uint8Array.from(receipt.attachmentPlanHash), outputs,
  }};
}

export function currentStenographerReconciliationIdentity(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">; prepared: Pick<PreparedCurrentStenographerReconciliation, "original" | "receipt" | "binding">;
  authority: CurrentProtectedStenographerAuthority;
}>): Readonly<{workId: string; idempotencyKey: string; fingerprint: Uint8Array; workIdentityHash: Uint8Array}> {
  const fingerprint = publicationReconciliationFingerprintV2(input.crypto, input.prepared.binding);
  // Authority refresh gets its own request; original signed work is never rewritten.
  const authorityBytes = new TextEncoder().encode(JSON.stringify([input.authority.policyRevision, (Object.keys(input.authority.namespace) as (keyof CurrentProtectedStenographerAuthority["namespace"])[]).sort().map(key => {const value = input.authority.namespace[key]; return [key, value instanceof Uint8Array ? [...value] : value];})]));
  const authorityHash = hash(authorityBytes); authorityBytes.fill(0);
  try {
    const identity = hash(new TextEncoder().encode(`${Buffer.from(fingerprint).toString("hex")}:${Buffer.from(authorityHash).toString("hex")}`));
    try {return {workId: `reconcile:${input.prepared.original.snapshot.requestId}`,
      idempotencyKey: `stenographer-reconcile:${Buffer.from(identity).toString("hex")}`, fingerprint, workIdentityHash: Uint8Array.from(identity)};}
    finally {identity.fill(0);}
  } finally {authorityHash.fill(0);}
}

export function createCurrentStenographerReconciliationRecord(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">; prepared: Pick<PreparedCurrentStenographerReconciliation, "original" | "receipt" | "binding">;
  authority: CurrentProtectedStenographerAuthority; requestId: string; now: number;
}>): BackgroundAuthorizationRecord {
  const identity = currentStenographerReconciliationIdentity(input);
  const a = input.authority;
  if (a.namespace.roomId !== input.prepared.receipt.roomId || a.namespace.namespaceId !== input.prepared.receipt.namespaceIdAtAllocation) {
    throw new Error("Reconciliation current Room or Namespace changed");
  }
  return parseBackgroundAuthorizationRecord({snapshot: createBackgroundAuthorizationRequestV2({
    requestId: input.requestId, workId: identity.workId, namespaceId: a.namespace.namespaceId,
    credentialSubject: {kind: "processor", processorKind: "stenographer", processorVersion: 1}, now: input.now}),
    workIdentityHash: identity.workIdentityHash, idempotencyKey: identity.idempotencyKey,
    workKind: "stenographer.publication_reconcile", purpose: "journal.reconcile", domainId: a.namespace.domainId,
    processorAuthorizationRevision: null, expectedDomainEpoch: null,
    expectedNamespaceAccessRevision: a.namespace.namespaceAccessRevision, expectedPolicyRevision: a.policyRevision,
    descriptorBytes: null, acceptedMaterial: null, finishedAt: null});
}

export function currentStenographerReconciliationDescriptor(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">; prepared: Pick<PreparedCurrentStenographerReconciliation, "original" | "receipt" | "binding">;
  authority: CurrentProtectedStenographerAuthority; record: BackgroundAuthorizationRecord;
  attempt: ProcessorTransformRecipientAttempt; now: number;
}>): Readonly<{descriptorBytes: Uint8Array; descriptorHash: Uint8Array}> {
  const identity = currentStenographerReconciliationIdentity(input);
  const {record, authority, attempt} = input;
  try {
    if (attempt.requestId !== record.snapshot.requestId || attempt.workId !== record.snapshot.workId
      || attempt.namespaceId !== record.snapshot.namespaceId || attempt.recipientGeneration !== record.snapshot.recipientGeneration
      || record.workKind !== "stenographer.publication_reconcile" || record.idempotencyKey !== identity.idempotencyKey
      || record.snapshot.workId !== identity.workId || !same(record.workIdentityHash, identity.workIdentityHash)
      || record.expectedPolicyRevision !== authority.policyRevision || record.domainId !== authority.namespace.domainId
      || record.expectedNamespaceAccessRevision !== authority.namespace.namespaceAccessRevision) throw new Error("Reconciliation plan or authority changed");
    const original = decodeBackgroundProcessorWorkDescriptorV2(input.prepared.original.descriptorBytes!);
    const inputBindings = input.prepared.binding.outputs.map(output => ({
      objectId: output.objectId,
      namespaceId: authority.namespace.namespaceId,
    }));
    const descriptor: BackgroundProcessorWorkDescriptorV2 = {formatVersion: 2, requestId: record.snapshot.requestId,
      recipientGeneration: attempt.recipientGeneration, workId: identity.workId, workKind: "stenographer.publication_reconcile",
      anchorNamespaceId: authority.namespace.namespaceId, anchorDomainId: authority.namespace.domainId,
      subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
      operations: inputBindings.length > 0 ? ["decrypt"] : [], purpose: "journal.reconcile", authority: authority.namespace,
      policyRevision: authority.policyRevision,
      source: {...original.source, kind: "stenographer_work", fingerprint: identity.fingerprint},
      inputBindings, outputSlots: [],
      maximumPlaintextBytes: original.maximumPlaintextBytes, maximumCiphertextBytes: original.maximumCiphertextBytes,
      recipientKeyId: attempt.recipientKeyId, recipientPublicKey: attempt.recipientPublicKey,
      issuedAt: input.now, notBefore: input.now, expiresAt: attempt.expiresAt, idempotencyId: identity.idempotencyKey};
    const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
    return {descriptorBytes, descriptorHash: input.crypto.hash(descriptorBytes)};
  } finally {identity.fingerprint.fill(0); identity.workIdentityHash.fill(0);}
}

/** Authenticate the canonical retained result against the original product plan, without original input bodies. */
function assertOutputs(
  prepared: PreparedCurrentStenographerReconciliation, outputs: readonly ProcessorTransformInput[],
): void {
  const plan = decodeProtectedJournalAttachmentPlanV1(prepared.receipt.attachmentPlanBytes);
  if (outputs.length !== prepared.binding.outputs.length
    || outputs.some((output, index) => output.objectId !== prepared.binding.outputs[index]?.objectId)) throw new Error("Reconciliation plaintext inventory differs");
  if (plan.kind === "rollup") {
    const rollup = plan.rollup!;
    assertRoomEventRollupPayloadBindingV1(decodeRoomEventRollupPayloadV1(outputs[0]!.plaintext), {
      rollupId: rollup.rollupId, roomId: plan.roomId, namespaceId: plan.namespaceId,
      throughEventSequence: rollup.throughEventSequence, sourceEventCount: rollup.sourceEventCount,
      modelId: rollup.modelId, compactorVersion: rollup.compactorVersion, createdAt: rollup.createdAt,
    });
    return;
  }
  for (const [index, event] of plan.events.entries()) {
    const envelope = decodeDurableRecordEnvelope({recordRef: event.eventId, lifecycle: "current", structuralHeight: 0,
      processingGeneration: plan.rebuildGeneration + 1, payloadBytes: outputs[index]!.plaintext});
    assertStenographerRecordPayloadBinding(envelope, {eventId: event.eventId, roomId: plan.roomId,
      namespaceId: plan.namespaceId, kind: event.kind, status: event.status,
      sourceMessageIds: event.sourceMessageIds, extractorVersion: event.extractorVersion,
      publicationGeneration: plan.rebuildGeneration + 1});
  }
}

export function assertCurrentStenographerReconciliationOutputs(
  prepared: PreparedCurrentStenographerReconciliation, outputs: readonly ProcessorTransformInput[],
): void {
  try {assertOutputs(prepared, outputs);}
  catch (cause) {throw new ProcessorReconciliationIntegrityErrorV2("Reconciliation canonical output binding failed", {cause});}
}
