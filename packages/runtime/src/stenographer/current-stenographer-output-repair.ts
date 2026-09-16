import type {LatticeCrypto, ProcessorTransformRecipientAttempt} from "@nautilo/lattice-crypto";
import {encodeBackgroundWorkDescriptorV2, outputRepairFingerprintV2} from "@nautilo/lattice-crypto/background";
import {decodeStenographerOutputRepairPlan, encodeStenographerOutputRepairPlan, type StenographerOutputRepairPlan} from "@nautilo/lattice-bridge";
import {createBackgroundAuthorizationRequestV2} from "../protected-execution/background-authorization/lifecycle";
import {parseBackgroundAuthorizationRecord, type BackgroundAuthorizationRecord} from "../protected-execution/background-authorization/repository";
import {PROTECTED_STENOGRAPHER_DESCRIPTOR_CIPHERTEXT_BUDGET, PROTECTED_STENOGRAPHER_DESCRIPTOR_PLAINTEXT_BUDGET,
  type CurrentProtectedStenographerAuthority} from "./protected-stenographer-work-composition";

type RepairIdentityInput = Readonly<{crypto: Pick<LatticeCrypto, "hash">; plan: StenographerOutputRepairPlan;
  authority: CurrentProtectedStenographerAuthority}>;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

/** The existing immutable publication plan is also the queue identity. */
function identity(input: RepairIdentityInput): Uint8Array {
  const {authority, plan} = input;
  if (authority.namespace.roomId !== plan.binding.receipt.roomId
    || authority.namespace.namespaceId !== plan.binding.receipt.namespaceId) throw new TypeError("Repair Room or Namespace changed");
  const bytes = encodeStenographerOutputRepairPlan(plan);
  const digest = input.crypto.hash(bytes);
  const coordinates = new TextEncoder().encode(JSON.stringify(["stenographer-output-repair-v2", hex(digest), authority.policyRevision,
    (Object.keys(authority.namespace) as (keyof typeof authority.namespace)[]).sort().map(key => {
      const value = authority.namespace[key]; return [key, value instanceof Uint8Array ? hex(value) : value];
    })]));
  try {return input.crypto.hash(coordinates);} finally {bytes.fill(0); digest.fill(0); coordinates.fill(0);}
}

/** Allocate only missing representations; repeats of the same metadata and authority coalesce. */
export function allocateCurrentStenographerOutputRepairPlan(input: RepairIdentityInput): StenographerOutputRepairPlan {
  const normalized = {...input.plan, binding: {...input.plan.binding, outputs: input.plan.binding.outputs.map((output, index) =>
    output.disposition === "existing" ? output : {...output, objectId: `repair-unallocated:${index}`})}};
  const seed = identity({...input, plan: normalized});
  let bytes: Uint8Array | undefined;
  try {
    bytes = encodeStenographerOutputRepairPlan({...normalized, binding: {...normalized.binding,
      outputs: normalized.binding.outputs.map((output, index) => output.disposition === "existing" ? output
        : {...output, objectId: `stenographer-repair:${hex(seed)}:${index}`})}});
    return decodeStenographerOutputRepairPlan(bytes);
  } finally {seed.fill(0); bytes?.fill(0);}
}

export function createCurrentStenographerOutputRepairRecord(input: RepairIdentityInput & Readonly<{
  requestId: string; now: number;
}>): BackgroundAuthorizationRecord {
  const workIdentityHash = identity(input);
  const {receipt} = input.plan.binding;
  try {
    return parseBackgroundAuthorizationRecord({snapshot: createBackgroundAuthorizationRequestV2({
      requestId: input.requestId, workId: `repair:${receipt.kind}:${receipt.id}:${hex(workIdentityHash)}`, namespaceId: receipt.namespaceId,
      credentialSubject: {kind: "processor", processorKind: "stenographer", processorVersion: 1}, now: input.now}),
      workIdentityHash, idempotencyKey: `stenographer-repair:${hex(workIdentityHash)}`, workKind: "stenographer.output_repair",
      purpose: "journal.repair", domainId: input.authority.namespace.domainId, processorAuthorizationRevision: null,
      expectedDomainEpoch: null, expectedNamespaceAccessRevision: input.authority.namespace.namespaceAccessRevision,
      expectedPolicyRevision: input.authority.policyRevision, descriptorBytes: null, acceptedMaterial: null, finishedAt: null});
  } finally {workIdentityHash.fill(0);}
}

export function currentStenographerOutputRepairDescriptor(input: RepairIdentityInput & Readonly<{
  record: BackgroundAuthorizationRecord; attempt: ProcessorTransformRecipientAttempt; now: number;
}>): Readonly<{descriptorBytes: Uint8Array; descriptorHash: Uint8Array}> {
  const {record, attempt, authority, plan} = input;
  const expected = createCurrentStenographerOutputRepairRecord({...input, requestId: record.snapshot.requestId, now: record.snapshot.createdAt});
  const fingerprint = outputRepairFingerprintV2(input.crypto, plan.binding);
  try {
    if (record.snapshot.formatVersion !== 2 || record.snapshot.credentialSubject.kind !== "processor"
      || record.workKind !== expected.workKind || record.purpose !== expected.purpose
      || record.snapshot.workId !== expected.snapshot.workId || record.idempotencyKey !== expected.idempotencyKey
      || !same(record.workIdentityHash, expected.workIdentityHash) || record.domainId !== expected.domainId
      || record.expectedPolicyRevision !== expected.expectedPolicyRevision
      || record.expectedNamespaceAccessRevision !== expected.expectedNamespaceAccessRevision
      || attempt.requestId !== record.snapshot.requestId || attempt.workId !== record.snapshot.workId
      || attempt.namespaceId !== record.snapshot.namespaceId || attempt.recipientGeneration !== record.snapshot.recipientGeneration) {
      throw new TypeError("Repair plan or current authority changed");
    }
    const existingOutputs = plan.binding.outputs.filter(output => output.disposition === "existing");
    const createdOutputs = plan.binding.outputs.filter(output => output.disposition === "create");
    const descriptorBytes = encodeBackgroundWorkDescriptorV2({formatVersion: 2, requestId: record.snapshot.requestId,
      recipientGeneration: attempt.recipientGeneration, workId: record.snapshot.workId, workKind: "stenographer.output_repair",
      anchorNamespaceId: authority.namespace.namespaceId, anchorDomainId: authority.namespace.domainId,
      subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
      operations: [...(existingOutputs.length > 0 ? ["decrypt" as const] : []),
        ...(createdOutputs.length > 0 ? ["encrypt" as const] : [])],
      purpose: "journal.repair", authority: authority.namespace,
      policyRevision: authority.policyRevision, source: {kind: "stenographer_work", startSequence: 0, endSequence: 0,
        rebuildGeneration: plan.binding.receipt.rebuildGeneration, fingerprint},
      inputBindings: existingOutputs.map(output => ({objectId: output.objectId, namespaceId: authority.namespace.namespaceId})),
      outputSlots: createdOutputs.map(({objectId, objectType, createdAt}) => ({
        objectId, objectType, createdAt, namespaceIds: [authority.namespace.namespaceId],
      })),
      maximumPlaintextBytes: PROTECTED_STENOGRAPHER_DESCRIPTOR_PLAINTEXT_BUDGET,
      maximumCiphertextBytes: PROTECTED_STENOGRAPHER_DESCRIPTOR_CIPHERTEXT_BUDGET,
      recipientKeyId: attempt.recipientKeyId, recipientPublicKey: attempt.recipientPublicKey,
      issuedAt: input.now, notBefore: input.now, expiresAt: attempt.expiresAt, idempotencyId: record.idempotencyKey});
    return {descriptorBytes, descriptorHash: input.crypto.hash(descriptorBytes)};
  } finally {expected.workIdentityHash.fill(0); fingerprint.fill(0);}
}
