import {and, asc, backgroundCryptoAuthorizationRequests, eq, or, inArray, reflectionRecordPublications, objectCryptoAccessHeads, objectCryptoNamespaceEnvelopes,
  processorCryptoSignerAuthorizations, type PostgresJsBridgeConnection} from "@nautilo/db";
import type {LatticeCrypto} from "@nautilo/lattice-crypto";
import {decodeAnyBackgroundProcessorWorkDescriptorV2, encodeBackgroundWorkDescriptorV2,
  reflectionAuthorityReconciliationFingerprintV2, type BackgroundReflectionWorkDescriptorV2,
  type ReflectionAuthorityReconciliationBindingV2, type ReflectionSemanticReconciliationBindingV2, type BackgroundReflectionSemanticWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {decodeEncryptedPayloadV2, decodeObjectAccessManifestV5} from "@nautilo/lattice-crypto/wire";
import {readVerifiedDeviceWrappedAgentObject} from "../memory/postgres-memory-crypto-completion.ts";
import {destroyVerifiedCurrentProcessorSignerEvidence, loadVerifiedCurrentProcessorSignerAuthorization} from "../storage/postgres-current-processor-signer-authorization.ts";
import {assertVerifiedCryptoPostgresHandle, cryptoTypedDb, executeTypedCryptoQuery, verifyCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction, type CryptoPostgresHandle} from "../storage/postgres-lattice-storage.ts";
import {ClassifiedDataOperationError} from "../../transition/encryption-data-operation-owner.ts";
import {validatePostgresReflectionAuthorityReprojection} from "./postgres-authority-plan.ts";
import {validatePostgresReflectionSemanticPlan} from "./postgres-semantic-plan.ts";

export interface PostgresReflectionAuthoritySavedOutput {
  readonly originalDescriptor: Extract<BackgroundReflectionWorkDescriptorV2, {workKind: "reflection.authority_reproject"}>;
  readonly binding: ReflectionAuthorityReconciliationBindingV2;
}
export interface PostgresReflectionSemanticSavedOutput {
  readonly originalDescriptor: BackgroundReflectionSemanticWorkDescriptorV2;
  readonly binding: ReflectionSemanticReconciliationBindingV2;
}
export interface PostgresRetiredReflectionSemanticOutput {
  readonly retired: true;
  readonly originalDescriptor: BackgroundReflectionSemanticWorkDescriptorV2;
  readonly binding: {readonly objectId: string};
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const sameStrings = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") Object.values(value).forEach(wipe);
}
function requireIntegrity(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ClassifiedDataOperationError("integrity", `Reflection saved output: ${message}`);
}

/** Detached public metadata; callers own and should wipe the returned byte arrays. */
type SavedOutputInput = Readonly<{handle: CryptoPostgresHandle; crypto: LatticeCrypto; objectId: string}>;
export function readPostgresReflectionAuthoritySavedOutput(input: SavedOutputInput & Readonly<{semanticRecordRef: string; semanticRequestCommitment: Uint8Array; allowRetired: true}>): Promise<PostgresReflectionSemanticSavedOutput | PostgresRetiredReflectionSemanticOutput | null>;
export function readPostgresReflectionAuthoritySavedOutput(input: SavedOutputInput & Readonly<{semanticRecordRef: string; semanticRequestCommitment: Uint8Array}>): Promise<PostgresReflectionSemanticSavedOutput | null>;
export function readPostgresReflectionAuthoritySavedOutput(input: SavedOutputInput): Promise<PostgresReflectionAuthoritySavedOutput | null>;
export async function readPostgresReflectionAuthoritySavedOutput(input: SavedOutputInput & Readonly<{semanticRecordRef?: string; semanticRequestCommitment?: Uint8Array; allowRetired?: true}>): Promise<PostgresReflectionAuthoritySavedOutput | PostgresReflectionSemanticSavedOutput | PostgresRetiredReflectionSemanticOutput | null> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  return withVerifiedCryptoPostgresTransaction(input.handle, async handle => {
    const inventory = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({namespace_id: objectCryptoNamespaceEnvelopes.namespaceId})
      .from(objectCryptoAccessHeads).innerJoin(objectCryptoNamespaceEnvelopes, and(
        eq(objectCryptoNamespaceEnvelopes.objectId, objectCryptoAccessHeads.objectId),
        eq(objectCryptoNamespaceEnvelopes.accessRevision, objectCryptoAccessHeads.accessRevision)))
      .where(eq(objectCryptoAccessHeads.objectId, input.objectId)).orderBy(asc(objectCryptoNamespaceEnvelopes.namespaceId)).limit(257));
    requireIntegrity(inventory.length <= 256, "envelope inventory exceeds the per-object bound");
    const namespaces = inventory.map(entry => entry.namespace_id);
    const saved = await readVerifiedDeviceWrappedAgentObject({handle, crypto: input.crypto, objectId: input.objectId,
      expectedObjectType: "nautilo.reflection.record.v1", expectedNamespaceIds: namespaces,
      resolveHistoricalAgentSignerAuthority: () => null});
    if (saved === null) { requireIntegrity(namespaces.length === 0, "current envelope inventory changed"); return null; }
    let result: PostgresReflectionAuthoritySavedOutput | PostgresReflectionSemanticSavedOutput | undefined;
    let originalDescriptor: PostgresReflectionAuthoritySavedOutput["originalDescriptor"] | BackgroundReflectionSemanticWorkDescriptorV2 | undefined;
    let retained = false;
    try {
      const retired = input.allowRetired === true && input.semanticRecordRef !== undefined && saved.accessRevision === 1 && namespaces.length === 0;
      requireIntegrity(retired || saved.accessRevision === 0 && namespaces.length > 0, "output has been retired or changed");
      const originalNamespaces = retired ? (await executeTypedCryptoQuery(handle, cryptoTypedDb.select({namespace_id: objectCryptoNamespaceEnvelopes.namespaceId})
        .from(objectCryptoNamespaceEnvelopes).where(and(eq(objectCryptoNamespaceEnvelopes.objectId, input.objectId), eq(objectCryptoNamespaceEnvelopes.accessRevision, 0)))
        .orderBy(asc(objectCryptoNamespaceEnvelopes.namespaceId)).limit(257))).map(entry => entry.namespace_id) : namespaces;
      requireIntegrity(originalNamespaces.length > 0 && originalNamespaces.length <= 256, "original envelope inventory is invalid");
      const manifest = decodeObjectAccessManifestV5(saved.accessManifestBytes);
      try {
        requireIntegrity(manifest.signer.kind === "processor_invocation" && manifest.signer.processorKind === "reflection" && manifest.signerAuthorizationHash !== null, "named Reflection signer required");
        const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({authorization_bytes: processorCryptoSignerAuthorizations.authorizationBytes})
          .from(processorCryptoSignerAuthorizations).where(and(
            eq(processorCryptoSignerAuthorizations.authorizationId, manifest.signer.signerAuthorizationId),
            eq(processorCryptoSignerAuthorizations.authorizationHash, manifest.signerAuthorizationHash),
            eq(processorCryptoSignerAuthorizations.formatVersion, 2))).limit(2));
        requireIntegrity(rows.length === 1 && rows[0]?.authorization_bytes instanceof Uint8Array, "original signer certificate unavailable");
        const evidence = await loadVerifiedCurrentProcessorSignerAuthorization(handle, input.crypto, rows[0].authorization_bytes);
        try {
          const d = decodeAnyBackgroundProcessorWorkDescriptorV2(evidence.certificate.descriptorBytes);
          if (!("namespaceRequirements" in d) || (input.semanticRecordRef === undefined
            ? d.workKind !== "reflection.authority_reproject"
            : d.source.kind !== "reflection_semantic" || d.workKind === "reflection.search_projection")) {
            wipe(d); requireIntegrity(false, "original named Reflection publication descriptor required");
          }
          if (d.workKind !== "reflection.authority_reproject" && d.workKind !== "reflection.organization" && d.workKind !== "reflection.dependency_rewrite") {
            wipe(d); requireIntegrity(false, "original publication kind is invalid");
          }
          originalDescriptor = d;
          requireIntegrity((d.source.kind === "reflection_semantic" || d.inputBindings.length === 1)
            && d.outputSlots.length === 1, "original operation must publish exactly one Record");
          const slot = d.outputSlots[0]!;
          requireIntegrity(slot.objectId === input.objectId && slot.objectType === "nautilo.reflection.record.v1"
            && sameStrings(slot.namespaceIds, originalNamespaces), "original output slot conflicts");
          requireIntegrity(saved.namespaceEnvelopes.every(entry => {
            const authority = d.namespaceRequirements.find(value => value.authority.namespaceId === entry.namespaceId)?.authority;
            return authority !== undefined && entry.keyGeneration === authority.namespaceKeyGeneration
              && entry.bindingRevisionAtWrap === authority.namespaceAccessRevision;
          }), "original Namespace wrapping revision conflicts");
          const descriptorBytes = encodeBackgroundWorkDescriptorV2(d);
          try {
            requireIntegrity(same(descriptorBytes, evidence.certificate.descriptorBytes), "original descriptor is not canonical");
            const table = backgroundCryptoAuthorizationRequests;
            const requests = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
              request_id: table.requestId, format_version: table.formatVersion, descriptor_bytes: table.descriptorBytes,
              descriptor_hash: table.descriptorHash, recipient_generation: table.recipientGeneration,
              transform_commit_claim_id: table.transformCommitClaimId, transform_commit_descriptor_hash: table.transformCommitDescriptorHash,
              transform_commit_recipient_generation: table.transformCommitRecipientGeneration,
              transform_commit_output_count: table.transformCommitOutputCount, transform_committed_at: table.transformCommittedAt,
            }).from(table).where(eq(table.requestId, d.requestId)).limit(2));
            const request = requests[0];
            const committedAt = request?.transform_committed_at == null ? NaN : new Date(request.transform_committed_at).getTime();
            requireIntegrity(requests.length === 1 && request !== undefined && request.request_id === d.requestId && request.format_version === 2
              && request.recipient_generation === d.recipientGeneration && request.descriptor_bytes instanceof Uint8Array
              && same(request.descriptor_bytes, descriptorBytes) && request.descriptor_hash instanceof Uint8Array
              && same(request.descriptor_hash, evidence.certificate.descriptorHash)
              && typeof request.transform_commit_claim_id === "string" && request.transform_commit_claim_id.length > 0
              && request.transform_commit_descriptor_hash instanceof Uint8Array
              && same(request.transform_commit_descriptor_hash, evidence.certificate.descriptorHash)
              && request.transform_commit_recipient_generation === d.recipientGeneration && request.transform_commit_output_count === 1
              && Number.isSafeInteger(committedAt) && committedAt >= d.issuedAt && committedAt < d.expiresAt,
            "original atomic transform marker unavailable or conflicting");
            const payload = decodeEncryptedPayloadV2(saved.payloadBytes);
            try {requireIntegrity(payload.context.objectId === slot.objectId && payload.context.objectType === slot.objectType
              && payload.context.createdAt === slot.createdAt && payload.context.keyClass === "ai", "original payload context conflicts");}
            finally {wipe(payload);}
            if (retired) {
              requireIntegrity(d.source.kind === "reflection_semantic", "retirement requires semantic output ownership");
              retained = true;
              return {retired: true, originalDescriptor: d as BackgroundReflectionSemanticWorkDescriptorV2, binding: {objectId: slot.objectId}};
            }
            const proof = {
              publicationId: d.requestId, objectId: slot.objectId, objectType: slot.objectType,
              attachmentPlanHash: input.crypto.hash(descriptorBytes), createdAt: slot.createdAt, payloadHash: Uint8Array.from(saved.payloadHash),
              namespaceEnvelopes: [...saved.namespaceEnvelopes].sort((a, b) => a.namespaceId < b.namespaceId ? -1 : a.namespaceId > b.namespaceId ? 1 : 0)
                .map(entry => ({namespaceId: entry.namespaceId, envelopeHash: input.crypto.hash(entry.envelopeBytes)})),
            };
            if (d.workKind !== "reflection.authority_reproject") {
              requireIntegrity(input.semanticRecordRef !== undefined, "semantic Record receipt is required");
              requireIntegrity(input.semanticRequestCommitment instanceof Uint8Array && input.semanticRequestCommitment.length === 32, "exact semantic receipt commitment is required");
              const attachmentBytes = new Uint8Array(descriptorBytes.length + input.semanticRequestCommitment.length);
              attachmentBytes.set(descriptorBytes); attachmentBytes.set(input.semanticRequestCommitment, descriptorBytes.length);
              proof.attachmentPlanHash.fill(0);
              try {proof.attachmentPlanHash = input.crypto.hash(attachmentBytes);} finally {attachmentBytes.fill(0);}
              result = {originalDescriptor: d, binding: {...proof,
                kind: "semantic", recordRef: input.semanticRecordRef, representationGeneration: 1,
                sourceRecordRef: d.source.recordRef, claimGeneration: d.source.claimGeneration}};
            } else {
              requireIntegrity(d.workKind === "reflection.authority_reproject", "authority source required");
              result = {originalDescriptor: d, binding: {...proof,
                recordRef: d.source.recordRef, sourceChangeGeneration: d.source.sourceChangeGeneration,
                expectedProjectionGeneration: d.source.projectionGeneration, previousRepresentationGeneration: d.source.expectedRepresentationGeneration,
                representationGeneration: d.source.targetRepresentationGeneration, previousObjectId: d.inputBindings[0]!.objectId}};
            }
            const fingerprint = reflectionAuthorityReconciliationFingerprintV2(input.crypto, result.binding); fingerprint.fill(0);
            retained = true;
            return result;
          } finally {descriptorBytes.fill(0);}
        } finally {destroyVerifiedCurrentProcessorSignerEvidence(evidence);}
      } finally {wipe(manifest);}
    } finally {wipe(saved); if (!retained) {wipe(result); wipe(originalDescriptor);}}
  });
}

/** Read only immutable signer metadata before taking any crypto object-head lock. */
async function readOriginalDescriptorSeed(handle: CryptoPostgresHandle, crypto: LatticeCrypto, requestId: string): Promise<BackgroundReflectionWorkDescriptorV2 | null> {
  const certificate = processorCryptoSignerAuthorizations;
  const request = backgroundCryptoAuthorizationRequests;
  const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({authorization_bytes: certificate.authorizationBytes})
    .from(certificate).innerJoin(request, and(eq(request.requestId, certificate.requestId),
      eq(request.transformCommitRecipientGeneration, certificate.recipientGeneration),
      eq(request.transformCommitDescriptorHash, certificate.workDescriptorHash)))
    .where(and(eq(certificate.requestId, requestId), eq(certificate.formatVersion, 2))).limit(2));
  if (rows.length !== 1 || !(rows[0]?.authorization_bytes instanceof Uint8Array)) return null;
  const evidence = await loadVerifiedCurrentProcessorSignerAuthorization(handle, crypto, rows[0].authorization_bytes);
  try {
    const d = decodeAnyBackgroundProcessorWorkDescriptorV2(evidence.certificate.descriptorBytes);
    if (!("namespaceRequirements" in d) || (d.workKind !== "reflection.authority_reproject" && d.source.kind !== "reflection_semantic") || d.requestId !== requestId) {wipe(d); return null;}
    return d;
  } finally {destroyVerifiedCurrentProcessorSignerEvidence(evidence);}
}

/**
 * Acquires the product Room union before authenticating the crypto object head.
 * The restricted executor is borrowed: nested readers join its transaction.
 * Call before the current Human Namespace owner; never from publication callbacks.
 */
export async function validatePostgresReflectionAuthorityRecovery(input: Readonly<{
  product: Pick<PostgresJsBridgeConnection, "query">;
  restricted: Pick<PostgresJsBridgeConnection, "query">;
  crypto: LatticeCrypto;
  descriptorB: BackgroundReflectionWorkDescriptorV2;
}>): Promise<boolean> {
  const bytes = encodeBackgroundWorkDescriptorV2(input.descriptorB);
  let d: ReturnType<typeof decodeAnyBackgroundProcessorWorkDescriptorV2>;
  try {d = decodeAnyBackgroundProcessorWorkDescriptorV2(bytes);} finally {bytes.fill(0);}
  try {
    if (!("namespaceRequirements" in d) || d.workKind !== "reflection.publication_reconcile" || d.inputBindings.length === 0 || d.outputSlots.length !== 0) return false;
    const objectId = d.inputBindings[0]!.objectId;
    if (d.inputBindings.some(entry => entry.objectId !== objectId)) return false;
    const handle = await verifyCryptoPostgresHandle({query: (statement, parameters) => input.restricted.query(statement, parameters),
      transaction: callback => callback(input.restricted)});
    const seed = await readOriginalDescriptorSeed(handle, input.crypto, d.source.publicationId);
    if (seed === null) return false;
    try {
      if (seed.workKind !== "reflection.authority_reproject" || seed.source.recordRef !== d.source.recordRef || seed.source.targetRepresentationGeneration !== d.source.representationGeneration
        || seed.outputSlots.length !== 1 || seed.outputSlots[0]!.objectId !== objectId
        || !await validatePostgresReflectionAuthorityReprojection({product: input.product, restricted: input.restricted, crypto: input.crypto, descriptor: seed})) return false;
      const saved = await readPostgresReflectionAuthoritySavedOutput({handle, crypto: input.crypto, objectId});
      if (saved === null) return false;
      try {
        const original = saved.originalDescriptor;
        const originalBytes = encodeBackgroundWorkDescriptorV2(original);
        const seedBytes = encodeBackgroundWorkDescriptorV2(seed);
        try {if (!same(originalBytes, seedBytes)) return false;}
        finally {originalBytes.fill(0); seedBytes.fill(0);}
        const namespaces = saved.binding.namespaceEnvelopes.map(entry => entry.namespaceId);
        const fingerprint = reflectionAuthorityReconciliationFingerprintV2(input.crypto, saved.binding);
        try {
          return d.source.publicationId === saved.binding.publicationId && d.source.recordRef === saved.binding.recordRef
            && d.source.representationGeneration === saved.binding.representationGeneration && same(d.source.fingerprint, fingerprint)
            && sameStrings(d.inputBindings.map(entry => entry.namespaceId), namespaces)
            && sameStrings(d.namespaceRequirements.map(entry => entry.authority.namespaceId), namespaces)
            && d.namespaceRequirements.every(entry => {
              const authority = original.namespaceRequirements.find(value => value.authority.namespaceId === entry.authority.namespaceId)?.authority;
              return authority !== undefined && authority.roomId === entry.authority.roomId && authority.serverId === entry.authority.serverId;
            });
        } finally {fingerprint.fill(0);}
      } finally {wipe(saved);}
    } finally {wipe(seed);}
  } finally {wipe(d);}
}

/** Fresh output-only grant; the original semantic inputs still fence current authority. */
export async function validatePostgresReflectionSemanticRecovery(input: Readonly<{
  product: Pick<PostgresJsBridgeConnection, "query">;
  restricted: Pick<PostgresJsBridgeConnection, "query">;
  crypto: LatticeCrypto;
  descriptorB: BackgroundReflectionWorkDescriptorV2;
}>): Promise<boolean> {
  const bytes = encodeBackgroundWorkDescriptorV2(input.descriptorB);
  const d = decodeAnyBackgroundProcessorWorkDescriptorV2(bytes);
  bytes.fill(0);
  try {
    if (!("namespaceRequirements" in d) || d.workKind !== "reflection.publication_reconcile" || d.inputBindings.length === 0 || d.outputSlots.length !== 0) return false;
    const objectId = d.inputBindings[0]!.objectId;
    if (d.inputBindings.some(entry => entry.objectId !== objectId)) return false;
    const handle = await verifyCryptoPostgresHandle({query: (statement, parameters) => input.restricted.query(statement, parameters),
      transaction: callback => callback(input.restricted)});
    const seed = await readOriginalDescriptorSeed(handle, input.crypto, d.source.publicationId);
    if (seed === null) return false;
    try {
      if ((seed.workKind !== "reflection.organization" && seed.workKind !== "reflection.dependency_rewrite")
        || d.source.representationGeneration !== 1 || seed.outputSlots.length !== 1 || seed.outputSlots[0]!.objectId !== objectId
        || !await validatePostgresReflectionSemanticPlan({product: input.product, restricted: input.restricted, crypto: input.crypto, descriptor: seed})) return false;
      const receipts = reflectionRecordPublications;
      const matching = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({requestCommitment: receipts.requestCommitment})
        .from(receipts).where(and(eq(receipts.recordId, d.source.recordRef), eq(receipts.representation, "protected"),
          inArray(receipts.state, ["reserved", "crypto_complete", "product_attached", "complete"]),
          or(eq(receipts.reservedCryptoObjectId, objectId), eq(receipts.cryptoObjectId, objectId)))).limit(2));
      const receiptCommitment = matching[0]?.request_commitment;
      if (matching.length !== 1 || !(receiptCommitment instanceof Uint8Array) || receiptCommitment.length !== 32) return false;
      const saved = await readPostgresReflectionAuthoritySavedOutput({handle, crypto: input.crypto, objectId,
        semanticRecordRef: d.source.recordRef, semanticRequestCommitment: receiptCommitment});
      if (saved === null) return false;
      try {
        const originalBytes = encodeBackgroundWorkDescriptorV2(saved.originalDescriptor);
        const seedBytes = encodeBackgroundWorkDescriptorV2(seed);
        try {if (!same(originalBytes, seedBytes)) return false;}
        finally {originalBytes.fill(0); seedBytes.fill(0);}
        const namespaces = saved.binding.namespaceEnvelopes.map(entry => entry.namespaceId);
        const fingerprint = reflectionAuthorityReconciliationFingerprintV2(input.crypto, saved.binding);
        try {
          return d.source.publicationId === saved.binding.publicationId && same(d.source.fingerprint, fingerprint)
            && sameStrings(d.inputBindings.map(entry => entry.namespaceId), namespaces)
            && sameStrings(d.namespaceRequirements.map(entry => entry.authority.namespaceId), namespaces)
            && d.namespaceRequirements.every(entry => {
              const authority = seed.namespaceRequirements.find(value => value.authority.namespaceId === entry.authority.namespaceId)?.authority;
              return authority !== undefined && authority.roomId === entry.authority.roomId && authority.serverId === entry.authority.serverId;
            });
        } finally {fingerprint.fill(0);}
      } finally {wipe(saved);}
    } finally {wipe(seed);}
  } finally {wipe(d);}
}
