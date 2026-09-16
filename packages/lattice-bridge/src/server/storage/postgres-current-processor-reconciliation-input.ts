import {and, cryptoObjects, eq, objectCryptoAccessManifests, processorCryptoSignerAuthorizations, sql} from "@nautilo/db";
import {verifyCommonObjectAccessManifest, assertPortableId, type LatticeCrypto, type CommonObjectAccessManifest, type VerifiedCommonObjectAccessManifest} from "@nautilo/lattice-crypto";
import {destroyVerifiedProcessorSignerAuthorizationV2, ProcessorReconciliationIntegrityErrorV2} from "@nautilo/lattice-crypto/background";
import {
  encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2,
  verifyObjectAccessManifestV4, type ObjectAccessManifestV4, type VerifiedObjectAccessManifestV4,
} from "@nautilo/lattice-crypto/wire";
import type {ProtectedJournalProcessorObjectVerifierPort, VerifiedProtectedJournalProcessorObject} from "../journal/protected-journal-agent-content-opener.ts";
import {destroyVerifiedCurrentProcessorSignerEvidence, loadVerifiedCurrentProcessorSignerAuthorization} from "./postgres-current-processor-signer-authorization.ts";
import {
  assertVerifiedCryptoPostgresHandle, cryptoTypedDb, executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction, type CryptoPostgresHandle,
} from "./postgres-lattice-storage.ts";
import {createPostgresProcessorTransformObjectPort, exactManifestForStoredBytes, type VerifyProcessorTransformV5Input} from "./postgres-processor-transform-object-port.ts";
import type {DatabaseRow} from "./postgres-record-codecs.ts";

const JOURNAL_PUBLICATION_KINDS = new Set([
  "stenographer.extraction", "stenographer.historical", "stenographer.compaction", "stenographer.rebuild",
  "stenographer.output_repair",
]);

function requireIntegrity(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ProcessorReconciliationIntegrityErrorV2(message);
}

function bytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  requireIntegrity(value instanceof Uint8Array, `Journal reconciliation ${name} is missing`);
  return new Uint8Array(value);
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isZero(value: unknown): boolean {
  return value === 0 || value === 0n || value === "0";
}

function wipeManifest(manifest: ObjectAccessManifestV4 | CommonObjectAccessManifest): void {
  manifest.payloadHash.fill(0);
  manifest.previousManifestHash?.fill(0);
  manifest.envelopeHashes.forEach(hash => hash.fill(0));
  manifest.signerAuthorizationHash?.fill(0);
  manifest.signature.fill(0);
  if (manifest.signer.kind === "processor_invocation") manifest.signer.workDescriptorHash.fill(0);
}

/**
 * Bind original publication provenance to its authenticated genesis, then lend
 * the existing object reader the current head. A Namespace rewrap may advance
 * that head without changing the original processor's immutable output.
 * Neither the old private grant nor an ordinary Journal body is needed here.
 */
type CurrentJournalObjectReaderInput = Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  verifyV5Input?: VerifyProcessorTransformV5Input;
}>;
type OriginalPublicationBinding = Readonly<{requestId: string; recipientGeneration: number; descriptorHash: Uint8Array}>;

export function createPostgresCurrentProcessorReconciliationObjectVerifier(
  input: CurrentJournalObjectReaderInput & Readonly<{original: OriginalPublicationBinding}>,
): ProtectedJournalProcessorObjectVerifierPort {
  if (input.original === undefined) throw new TypeError("Original Journal reconciliation binding is required");
  return currentJournalObjectReader(input);
}

/** Historical Journal consumption derives provenance from authenticated genesis. */
export function createPostgresCurrentProcessorJournalObjectVerifier(
  input: CurrentJournalObjectReaderInput,
): ProtectedJournalProcessorObjectVerifierPort {
  return currentJournalObjectReader(input);
}

export function isCurrentCommonManifest(bytes: Uint8Array): boolean {
  const parsed = exactManifestForStoredBytes(bytes);
  const wipe = (value: unknown): void => {
    if (value instanceof Uint8Array) value.fill(0);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(wipe);
  };
  try {return parsed.version === 5;} finally {wipe(parsed.manifest);}
}

function currentJournalObjectReader(input: CurrentJournalObjectReaderInput & Readonly<{original?: OriginalPublicationBinding}>): ProtectedJournalProcessorObjectVerifierPort {
  assertVerifiedCryptoPostgresHandle(input.handle);
  const {handle, crypto, verifyV5Input} = input;
  const original = input.original === undefined ? undefined : {...input.original,
    descriptorHash: Uint8Array.from(input.original.descriptorHash)};
  if (original !== undefined) {
    assertPortableId("Original Journal request", original.requestId);
    if (!Number.isSafeInteger(original.recipientGeneration) || original.recipientGeneration < 0
      || original.descriptorHash.length !== 32) throw new TypeError("Original Journal reconciliation binding is invalid");
  }
  return {verify: async ({objectId, signal}) => {
    assertPortableId("Journal reconciliation object", objectId);
    signal.throwIfAborted();
    let candidate: VerifiedProtectedJournalProcessorObject | undefined;
    const discardCandidate = () => {
      candidate?.payloadBytes.fill(0); candidate?.namespaceEnvelopeBytes.fill(0); candidate = undefined;
    };
    try {
    const result = await withVerifiedCryptoPostgresTransaction(handle, async scoped => {
      // A serialization retry must release the previous uncommitted result.
      discardCandidate();
      const rows = await executeTypedCryptoQuery(scoped, cryptoTypedDb.select({
        object_id: cryptoObjects.objectId,
        payload_hash: cryptoObjects.payloadHash,
        payload_bytes: cryptoObjects.payloadBytes,
        manifest_object_id: sql<string | null>`${objectCryptoAccessManifests.objectId}`.as("manifest_object_id"),
        manifest_access_revision: sql<number | null>`${objectCryptoAccessManifests.accessRevision}`.as("manifest_access_revision"),
        manifest_payload_hash: sql<Uint8Array | null>`${objectCryptoAccessManifests.payloadHash}`.as("manifest_payload_hash"),
        manifest_hash: objectCryptoAccessManifests.manifestHash,
        previous_manifest_hash: objectCryptoAccessManifests.previousManifestHash,
        manifest_bytes: objectCryptoAccessManifests.manifestBytes,
      }).from(cryptoObjects).leftJoin(objectCryptoAccessManifests, and(
        eq(objectCryptoAccessManifests.objectId, cryptoObjects.objectId),
        eq(objectCryptoAccessManifests.accessRevision, 0),
      )).where(eq(cryptoObjects.objectId, objectId)).limit(2));
      signal.throwIfAborted();
      if (rows.length === 0) return null;
      requireIntegrity(rows.length === 1 && rows[0] !== undefined, "Ambiguous original Journal object");
      const row = rows[0];
      const owned: Uint8Array[] = [];
      const copyColumn = (name: string): Uint8Array => {const value = bytes(row, name); owned.push(value); return value;};
      let decoded: ObjectAccessManifestV4 | CommonObjectAccessManifest | undefined;
      let verified: VerifiedObjectAccessManifestV4 | VerifiedCommonObjectAccessManifest | undefined;
      let evidence: Awaited<ReturnType<typeof loadVerifiedCurrentProcessorSignerAuthorization>> | undefined;
      let opened: Awaited<ReturnType<ReturnType<typeof createPostgresProcessorTransformObjectPort>["openInput"]>> | undefined;
      let payloadResult: Uint8Array | undefined;
      let envelopeResult: Uint8Array | undefined;
      try {
        requireIntegrity(row.object_id === objectId && row.manifest_object_id === objectId
          && isZero(row.manifest_access_revision)
          && row.previous_manifest_hash === null, "Original Journal genesis coordinates conflict");
        const payloadBytes = copyColumn("payload_bytes");
        const payloadHash = copyColumn("payload_hash");
        const manifestPayloadHash = copyColumn("manifest_payload_hash");
        const manifestBytes = copyColumn("manifest_bytes");
        const manifestHash = copyColumn("manifest_hash");
        const actualPayloadHash = crypto.hash(payloadBytes); owned.push(actualPayloadHash);
        const actualManifestHash = crypto.hash(manifestBytes); owned.push(actualManifestHash);
        requireIntegrity(same(payloadHash, actualPayloadHash) && same(manifestPayloadHash, payloadHash)
          && same(manifestHash, actualManifestHash), "Original Journal durable hashes conflict");
        try {
          const parsed = exactManifestForStoredBytes(manifestBytes);
          if (parsed.version !== 4 && parsed.version !== 5) throw new TypeError("Processor genesis manifest required");
          decoded = parsed.manifest;
        }
        catch {throw new ProcessorReconciliationIntegrityErrorV2("Original Journal genesis is not a supported processor manifest");}
        requireIntegrity(decoded.signer.kind === "processor_invocation", "Original Journal genesis has no processor signer");
        const authorizationRows = await executeTypedCryptoQuery(scoped, cryptoTypedDb.select({
          authorization_bytes: processorCryptoSignerAuthorizations.authorizationBytes,
        }).from(processorCryptoSignerAuthorizations).where(eq(
          processorCryptoSignerAuthorizations.authorizationId, decoded.signer.signerAuthorizationId,
        )).limit(2));
        signal.throwIfAborted();
        requireIntegrity(authorizationRows.length === 1 && authorizationRows[0] !== undefined,
          "Original Journal certificate is missing or ambiguous");
        const authorizationBytes = bytes(authorizationRows[0], "authorization_bytes"); owned.push(authorizationBytes);
        evidence = await loadVerifiedCurrentProcessorSignerAuthorization(scoped, crypto, authorizationBytes);
        signal.throwIfAborted();
        const certificate = evidence.certificate;
        const descriptor = certificate.descriptor;
        requireIntegrity("authority" in descriptor, "Journal reconciliation requires a Stenographer descriptor");
        requireIntegrity(original === undefined || (evidence.requestId === original.requestId && evidence.recipientGeneration === original.recipientGeneration
          && same(certificate.descriptorHash, original.descriptorHash)), "Original Journal request binding was substituted");
        const signerEvidence = evidence;
        try {
          const verification = {
            manifestBytes,
            resolveAgentRuntimeSignerPublicKey: () => null,
            resolveProcessorSignerAuthorizationBytes: (context: Parameters<Parameters<typeof verifyObjectAccessManifestV4>[1]["resolveProcessorSignerAuthorizationBytes"]>[0]) => context.authorizationId === certificate.credentialId
              && same(context.authorizationHash, signerEvidence.authorizationHash) ? signerEvidence.authorizationBytes : null,
            resolveHistoricalIssuingDevicePublicKey: () => null,
            resolveHistoricalCurrentIssuer: (context: Parameters<NonNullable<Parameters<typeof verifyObjectAccessManifestV4>[1]["resolveHistoricalCurrentIssuer"]>>[0]) => context.issuer.humanId === certificate.issuer.humanId
              && context.issuer.deviceId === certificate.issuer.deviceId
              && context.issuer.deviceGeneration === certificate.issuer.deviceGeneration
              && same(context.descriptorHash, certificate.descriptorHash) ? signerEvidence.issuerPublicKey : null,
          };
          verified = decoded.formatVersion === 5 ? verifyCommonObjectAccessManifest(crypto, {...verification,
            resolveHistoricalHumanDeviceSigningPublicKey: () => null, resolveHistoricalProcessorIssuingDevicePublicKey: () => null})
            : verifyObjectAccessManifestV4(crypto, verification);
        } catch {throw new ProcessorReconciliationIntegrityErrorV2("Original Journal genesis signature is invalid");}
        requireIntegrity(verified.currentSignerAuthorization !== null && verified.manifest.objectId === objectId
          && verified.manifest.accessRevision === 0 && verified.manifest.previousManifestHash === null
          && same(verified.manifestHash, manifestHash) && same(verified.manifest.payloadHash, payloadHash),
        "Original Journal authenticated genesis conflicts with storage");
        const outputOrdinal = descriptor.outputSlots.findIndex((slot) => slot.objectId === objectId);
        const slot = descriptor.outputSlots[outputOrdinal];
        requireIntegrity(slot !== undefined && JOURNAL_PUBLICATION_KINDS.has(descriptor.workKind),
          "Journal object is outside the original execution output slots");
        requireIntegrity(slot.namespaceIds.length === 1,
          "Journal object output Namespace set is invalid");
        opened = await createPostgresProcessorTransformObjectPort({handle: scoped, crypto,
          ...(verifyV5Input === undefined ? {} : {verifyV5Input})}).openInput({objectId, signal});
        signal.throwIfAborted();
        payloadResult = encodeEncryptedPayloadV2(opened.payload);
        envelopeResult = encodeNamespaceObjectEnvelopeV2(opened.envelope);
        const currentPayloadHash = crypto.hash(payloadResult); owned.push(currentPayloadHash);
        requireIntegrity(same(currentPayloadHash, payloadHash) && opened.payload.context.objectId === slot.objectId
          && opened.payload.context.objectType === slot.objectType && opened.payload.context.createdAt === slot.createdAt
          && opened.payload.context.keyClass === "ai" && opened.envelope.context.objectId === slot.objectId
          && opened.envelope.context.namespaceId === slot.namespaceIds[0] && opened.envelope.context.keyClass === "ai",
        "Current Journal payload or Namespace differs from the original output");
        const result = Object.freeze({objectId, namespaceId: slot.namespaceIds[0],
          domainId: descriptor.anchorDomainId, workId: descriptor.workId,
          rebuildGeneration: descriptor.source.rebuildGeneration, outputOrdinal,
          authorizedOutputObjectIds: Object.freeze(descriptor.outputSlots.map((output) => output.objectId)),
          publisherNamespaceAccessRevision: descriptor.authority.namespaceAccessRevision,
          payloadBytes: payloadResult, namespaceEnvelopeBytes: envelopeResult});
        candidate = result;
        payloadResult = undefined; envelopeResult = undefined;
        return result;
      } finally {
        owned.forEach(value => value.fill(0));
        payloadResult?.fill(0); envelopeResult?.fill(0);
        opened?.payload.ciphertext.fill(0); opened?.envelope.wrappedDek.fill(0);
        if (decoded) wipeManifest(decoded);
        if (verified) {
          if (verified.currentSignerAuthorization) destroyVerifiedProcessorSignerAuthorizationV2(verified.currentSignerAuthorization);
          wipeManifest(verified.manifest); verified.manifestBytes.fill(0); verified.manifestHash.fill(0);
        }
        if (evidence) destroyVerifiedCurrentProcessorSignerEvidence(evidence);
      }
    });
    signal.throwIfAborted();
    candidate = undefined;
    return result;
    } finally {discardCandidate();}
  }};
}
