import {createPostgresCurrentProcessorJournalObjectVerifier, isCurrentCommonManifest} from "../storage/postgres-current-processor-reconciliation-input.ts";
import type {VerifyProcessorTransformV5Input} from "../storage/postgres-processor-transform-object-port.ts";
import {
  and,
  asc,
  backgroundCryptoAuthorizationRequests,
  cryptoObjects,
  eq,
  humanCryptoDevices,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  processorCryptoSignerAuthorizations,
  sql,
} from "@nautilo/db";
import {
  assertPortableId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeBackgroundWorkDescriptorV1,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV4,
  verifyObjectAccessManifestV4,
  type BackgroundWorkDescriptorV1,
  type ProcessorSignerAuthorizationV1,
  type VerifiedObjectAccessManifestV4,
} from "@nautilo/lattice-crypto/wire";

import {readProcessorSignerAuthorizationVersion, destroyVerifiedProcessorSignerAuthorizationV2} from "@nautilo/lattice-crypto/background";
import {loadVerifiedCurrentProcessorSignerAuthorization, destroyVerifiedCurrentProcessorSignerEvidence} from "../storage/postgres-current-processor-signer-authorization.ts";
import type {
  ProtectedJournalProcessorObjectVerifierPort,
  VerifiedProtectedJournalProcessorObject,
} from "./protected-journal-agent-content-opener.ts";
import {
  withVerifiedCryptoPostgresTransaction,
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
  type CryptoPostgresExecutor,
} from "../storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
} from "../storage/postgres-record-codecs.ts";

const HASH_BYTES = 32;
const SIGNING_PUBLIC_KEY_BYTES = 32;
const MAXIMUM_ENVELOPES_PER_MANIFEST = 256;
const ACCEPTED_REQUEST_STATES = new Set([
  "running",
  "publication_reconciliation",
  "completed",
]);
const JOURNAL_WORK_KINDS = new Set([
  "stenographer.extraction",
  "stenographer.historical",
  "stenographer.compaction",
  "stenographer.rebuild",
]);

function requiredString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `Protected journal crypto column ${field} must be nonempty text`,
    );
  }
  return value;
}

function requiredCounter(row: DatabaseRow, field: string): number {
  const value = row[field];
  let counter: number;
  if (typeof value === "bigint") {
    counter = value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : Number.NaN;
  } else if (
    typeof value === "string"
    && /^(0|[1-9][0-9]*)$/u.test(value)
  ) {
    counter = Number(value);
  } else {
    counter = typeof value === "number" ? value : Number.NaN;
  }
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TypeError(
      `Protected journal crypto column ${field} must be a safe counter`,
    );
  }
  return counter;
}

function requiredBytes(
  row: DatabaseRow,
  field: string,
  exactLength?: number,
): Uint8Array {
  const value = row[field];
  if (
    !(value instanceof Uint8Array)
    || (exactLength !== undefined && value.length !== exactLength)
  ) {
    throw new TypeError(
      `Protected journal crypto column ${field} must be bytea${
        exactLength === undefined ? "" : `(${exactLength})`
      }`,
    );
  }
  return new Uint8Array(value);
}

function nullableBytes(
  row: DatabaseRow,
  field: string,
  exactLength: number,
): Uint8Array | null {
  return row[field] === null
    ? null
    : requiredBytes(row, field, exactLength);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function sameOptionalBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameBytes(left, right);
}

function exactOne(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new TypeError(
      `Protected journal ${label} provenance must have exactly one row`,
    );
  }
  return rows[0];
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new TypeError(`Protected journal object ${message}`);
  }
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertObjectStorageRows(
  crypto: LatticeCrypto,
  requestedObjectId: string,
  row: DatabaseRow,
): Readonly<{
  payloadBytes: Uint8Array;
  payloadHash: Uint8Array;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  previousManifestHash: Uint8Array | null;
  accessRevision: number;
}> {
  const objectId = requiredString(row, "object_id");
  const objectPayloadHash = requiredBytes(
    row,
    "object_payload_hash",
    HASH_BYTES,
  );
  const payloadBytes = requiredBytes(row, "payload_bytes");
  const headAccessRevision = requiredCounter(row, "head_access_revision");
  const headManifestHash = requiredBytes(
    row,
    "head_manifest_hash",
    HASH_BYTES,
  );
  const manifestObjectId = requiredString(row, "manifest_object_id");
  const manifestAccessRevision = requiredCounter(
    row,
    "manifest_access_revision",
  );
  const manifestHash = requiredBytes(row, "manifest_hash", HASH_BYTES);
  const previousManifestHash = nullableBytes(
    row,
    "previous_manifest_hash",
    HASH_BYTES,
  );
  const manifestPayloadHash = requiredBytes(
    row,
    "manifest_payload_hash",
    HASH_BYTES,
  );
  const manifestBytes = requiredBytes(row, "manifest_bytes");
  const calculatedPayloadHash = crypto.hash(payloadBytes);
  const calculatedManifestHash = crypto.hash(manifestBytes);
  try {
    invariant(objectId === requestedObjectId, "object row was substituted");
    invariant(
      manifestObjectId === requestedObjectId,
      "manifest object was substituted",
    );
    invariant(
      headAccessRevision === manifestAccessRevision,
      "access head revision does not match its manifest",
    );
    invariant(
      sameBytes(headManifestHash, manifestHash),
      "access head hash does not match its manifest",
    );
    invariant(
      sameBytes(calculatedManifestHash, manifestHash),
      "manifest hash is invalid",
    );
    invariant(
      sameBytes(objectPayloadHash, manifestPayloadHash)
      && sameBytes(calculatedPayloadHash, objectPayloadHash),
      "payload hash is invalid",
    );
    if (manifestAccessRevision === 0) {
      invariant(
        previousManifestHash === null,
        "genesis manifest has a previous hash",
      );
    } else {
      invariant(
        previousManifestHash !== null,
        "non-genesis manifest is missing its previous hash",
      );
    }
    return Object.freeze({
      payloadBytes,
      payloadHash: objectPayloadHash.slice(),
      manifestBytes,
      manifestHash,
      previousManifestHash: previousManifestHash?.slice() ?? null,
      accessRevision: manifestAccessRevision,
    });
  } catch (error) {
    payloadBytes.fill(0);
    manifestBytes.fill(0);
    manifestHash.fill(0);
    throw error;
  } finally {
    objectPayloadHash.fill(0);
    headManifestHash.fill(0);
    previousManifestHash?.fill(0);
    manifestPayloadHash.fill(0);
    calculatedPayloadHash.fill(0);
    calculatedManifestHash.fill(0);
  }
}

function processorAuthorizationIdFromManifest(
  manifestBytes: Uint8Array,
): string {
  const manifest = decodeObjectAccessManifestV4(manifestBytes);
  try {
    invariant(
      manifest.signer.kind === "processor_invocation",
      "manifest was not signed by a processor invocation",
    );
    return manifest.signer.signerAuthorizationId;
  } finally {
    manifest.payloadHash.fill(0);
    manifest.previousManifestHash?.fill(0);
    manifest.envelopeHashes.forEach((hash) => hash.fill(0));
    if (manifest.signer.kind === "processor_invocation") {
      manifest.signer.workDescriptorHash.fill(0);
    }
    manifest.signerAuthorizationHash?.fill(0);
    manifest.signature.fill(0);
  }
}

function assertAuthorizationRow(
  crypto: LatticeCrypto,
  row: DatabaseRow,
  authorization: ProcessorSignerAuthorizationV1,
  authorizationHash: Uint8Array,
): Readonly<{
  requestId: string;
  recipientGeneration: number;
  descriptorBytes: Uint8Array;
}> {
  const rowAuthorizationHash = requiredBytes(
    row,
    "authorization_hash",
    HASH_BYTES,
  );
  const rowCredentialHash = requiredBytes(
    row,
    "credential_hash",
    HASH_BYTES,
  );
  const rowIssuerHash = requiredBytes(
    row,
    "issuer_signing_public_key_hash",
    HASH_BYTES,
  );
  const rowSignerPublicKey = requiredBytes(
    row,
    "signer_public_key",
    SIGNING_PUBLIC_KEY_BYTES,
  );
  const rowDescriptorHash = requiredBytes(
    row,
    "work_descriptor_hash",
    HASH_BYTES,
  );
  const rowDescriptorBytes = requiredBytes(row, "work_descriptor_bytes");
  const calculatedDescriptorHash = crypto.hash(rowDescriptorBytes);
  try {
    invariant(
      requiredString(row, "authorization_id") === authorization.id,
      "signer authorization id row was substituted",
    );
    invariant(
      requiredString(row, "processor_kind")
          === authorization.processorKind
        && requiredCounter(row, "processor_version")
          === authorization.processorVersion,
      "signer authorization processor row was substituted",
    );
    invariant(
      requiredString(row, "work_id") === authorization.workId,
      "signer authorization work row was substituted",
    );
    invariant(
      requiredString(row, "namespace_id") === authorization.namespaceId
        && requiredString(row, "domain_id") === authorization.domainId,
      "signer authorization scope row was substituted",
    );
    invariant(
      requiredCounter(row, "domain_epoch") === authorization.domainEpoch
        && requiredCounter(row, "namespace_access_revision")
          === authorization.namespaceAccessRevision
        && requiredCounter(row, "policy_revision")
          === authorization.policyRevision
        && requiredCounter(row, "processor_authorization_revision")
          === authorization.processorAuthorizationRevision,
      "signer authorization revision row was substituted",
    );
    invariant(
      requiredString(row, "issuing_human_id")
          === authorization.issuingHumanId
        && requiredString(row, "issuing_device_id")
          === authorization.issuingDeviceId
        && requiredCounter(row, "issuing_device_authorization_revision")
          === authorization.issuingDeviceAuthorizationRevision,
      "signer authorization issuer row was substituted",
    );
    invariant(
      sameBytes(
        rowIssuerHash,
        authorization.issuerSigningPublicKeyHash,
      ),
      "signer authorization issuer key hash row was substituted",
    );
    invariant(
      requiredString(row, "signer_key_id")
          === authorization.signer.signerKeyId
        && sameBytes(rowSignerPublicKey, authorization.signerPublicKey),
      "signer authorization key row was substituted",
    );
    invariant(
      sameBytes(rowAuthorizationHash, authorizationHash),
      "signer authorization hash row was substituted",
    );
    invariant(
      sameBytes(rowCredentialHash, authorization.credentialHash),
      "signer authorization credential row was substituted",
    );
    invariant(
      sameBytes(rowDescriptorHash, calculatedDescriptorHash)
        && sameBytes(
          rowDescriptorHash,
          authorization.workDescriptorHash,
        ),
      "durable work descriptor evidence was substituted",
    );
    invariant(
      requiredCounter(row, "issued_at_ms") === authorization.issuedAt
        && requiredCounter(row, "expires_at_ms") === authorization.expiresAt,
      "signer authorization lifetime row was substituted",
    );
    return Object.freeze({
      requestId: requiredString(row, "request_id"),
      recipientGeneration: requiredCounter(row, "recipient_generation"),
      descriptorBytes: rowDescriptorBytes.slice(),
    });
  } finally {
    rowAuthorizationHash.fill(0);
    rowCredentialHash.fill(0);
    rowIssuerHash.fill(0);
    rowSignerPublicKey.fill(0);
    rowDescriptorHash.fill(0);
    rowDescriptorBytes.fill(0);
    calculatedDescriptorHash.fill(0);
  }
}

function assertAcceptedRequest(
  crypto: LatticeCrypto,
  row: DatabaseRow,
  descriptorBytes: Uint8Array,
  descriptor: BackgroundWorkDescriptorV1,
  authorization: ProcessorSignerAuthorizationV1,
  requestLink: Readonly<{
    requestId: string;
    recipientGeneration: number;
  }>,
): void {
  const rowDescriptorHash = requiredBytes(
    row,
    "descriptor_hash",
    HASH_BYTES,
  );
  const rowDescriptorBytes = requiredBytes(row, "descriptor_bytes");
  const rowCredentialHash = requiredBytes(
    row,
    "credential_hash",
    HASH_BYTES,
  );
  const rowIssuerHash = requiredBytes(
    row,
    "issuer_signing_public_key_hash",
    HASH_BYTES,
  );
  const calculatedDescriptorHash = crypto.hash(descriptorBytes);
  try {
    invariant(
      sameBytes(rowDescriptorHash, calculatedDescriptorHash)
        && sameBytes(rowDescriptorBytes, descriptorBytes)
        && sameBytes(
          calculatedDescriptorHash,
          authorization.workDescriptorHash,
        ),
      "work descriptor hash is invalid",
    );
    invariant(
      requiredString(row, "request_id") === requestLink.requestId
        && descriptor.requestId === requestLink.requestId,
      "accepted request id was substituted",
    );
    invariant(
      requiredCounter(row, "recipient_generation")
          === requestLink.recipientGeneration
        && descriptor.recipientGeneration === requestLink.recipientGeneration,
      "accepted request recipient generation was substituted",
    );
    invariant(
      ACCEPTED_REQUEST_STATES.has(requiredString(row, "state"))
        && requiredString(row, "accepted_response_kind") === "processor"
        && requiredString(row, "credential_subject_kind") === "processor",
      "does not have accepted processor authorization",
    );
    invariant(
      requiredString(row, "work_id") === descriptor.workId
        && requiredString(row, "work_kind") === descriptor.workKind
        && requiredString(row, "purpose") === descriptor.purpose,
      "accepted request work row was substituted",
    );
    invariant(
      requiredString(row, "namespace_id") === descriptor.namespaceId
        && requiredString(row, "domain_id") === descriptor.domainId,
      "accepted request scope row was substituted",
    );
    invariant(
      requiredString(row, "processor_kind") === "stenographer"
        && requiredCounter(row, "processor_version") === 1
        && requiredCounter(row, "processor_authorization_revision")
          === authorization.processorAuthorizationRevision,
      "accepted request processor row was substituted",
    );
    invariant(
      requiredCounter(row, "expected_domain_epoch")
          === descriptor.expectedDomainEpoch
        && requiredCounter(row, "expected_namespace_access_revision")
          === descriptor.expectedNamespaceAccessRevision
        && requiredCounter(row, "expected_policy_revision")
          === descriptor.expectedPolicyRevision,
      "accepted request revision row was substituted",
    );
    invariant(
      sameBytes(rowCredentialHash, authorization.credentialHash),
      "accepted request credential row was substituted",
    );
    invariant(
      requiredString(row, "issuing_human_id")
          === authorization.issuingHumanId
        && requiredString(row, "issuing_device_id")
          === authorization.issuingDeviceId
        && requiredCounter(row, "issuing_device_authorization_revision")
          === authorization.issuingDeviceAuthorizationRevision
        && sameBytes(
          rowIssuerHash,
          authorization.issuerSigningPublicKeyHash,
        ),
      "accepted request issuer row was substituted",
    );
  } finally {
    rowDescriptorHash.fill(0);
    rowDescriptorBytes.fill(0);
    rowCredentialHash.fill(0);
    rowIssuerHash.fill(0);
    calculatedDescriptorHash.fill(0);
  }
}

function assertDescriptorBoundary(
  descriptor: BackgroundWorkDescriptorV1,
  authorization: ProcessorSignerAuthorizationV1,
  objectId: string,
  requestLink: Readonly<{
    requestId: string;
    recipientGeneration: number;
  }>,
): Readonly<{
  outputOrdinal: number;
  rebuildGeneration: number;
}> {
  invariant(
    descriptor.requestId === requestLink.requestId
      && descriptor.recipientGeneration === requestLink.recipientGeneration,
    "descriptor request coordinates were substituted",
  );
  invariant(
    JOURNAL_WORK_KINDS.has(descriptor.workKind)
      && descriptor.source.kind === "journal_range",
    "descriptor is not journal work",
  );
  invariant(
    descriptor.subject.kind === "processor"
      && descriptor.subject.processorKind === "stenographer"
      && descriptor.subject.processorVersion === 1,
    "descriptor subject is not the Stenographer processor",
  );
  invariant(
    descriptor.subject.authorizationRevision
      === authorization.processorAuthorizationRevision,
    "descriptor processor authorization revision was substituted",
  );
  invariant(
    descriptor.workId === authorization.workId
      && descriptor.namespaceId === authorization.namespaceId
      && descriptor.domainId === authorization.domainId,
    "descriptor authorization scope does not match",
  );
  invariant(
    descriptor.expectedDomainEpoch === authorization.domainEpoch
      && descriptor.expectedNamespaceAccessRevision
        === authorization.namespaceAccessRevision
      && descriptor.expectedPolicyRevision === authorization.policyRevision,
    "descriptor authorization revisions do not match",
  );
  invariant(
    descriptor.operations.includes("encrypt"),
    "descriptor does not authorize encryption",
  );
  invariant(
    descriptor.outputObjectIds.length >= 1
      && descriptor.outputObjectIds.length <= 5
      && descriptor.maximumOutputObjectCount
        === descriptor.outputObjectIds.length
      && descriptor.outputObjectMetadata.length
        === descriptor.outputObjectIds.length
      && descriptor.outputObjectMetadata.every(
        (metadata, index) =>
          metadata.objectId === descriptor.outputObjectIds[index],
      ),
    "descriptor output slots are invalid",
  );
  invariant(
    sameStringList(
      descriptor.outputObjectIds,
      authorization.outputObjectIds,
    )
      && authorization.maxOutputObjects
        === descriptor.maximumOutputObjectCount
      && authorization.maxOutputPlaintextBytes
        === descriptor.maximumPlaintextBytes
      && authorization.maxOutputCiphertextBytes
        === descriptor.maximumCiphertextBytes,
    "descriptor output boundary does not match signer authorization",
  );
  const outputOrdinal = descriptor.outputObjectIds.findIndex(
    (candidate) => candidate === objectId,
  );
  invariant(outputOrdinal >= 0, "is outside the descriptor output slots");
  return Object.freeze({
    outputOrdinal,
    rebuildGeneration: descriptor.source.rebuildGeneration,
  });
}

function assertPayloadBoundary(
  payloadBytes: Uint8Array,
  descriptor: Readonly<{outputObjectMetadata: readonly Readonly<{objectId: string; objectType: string; createdAt: number}>[]}>,
  outputOrdinal: number,
): void {
  const payload = decodeEncryptedPayloadV2(payloadBytes);
  try {
    const metadata = descriptor.outputObjectMetadata[outputOrdinal];
    invariant(metadata !== undefined, "output metadata is absent");
    invariant(
      payload.context.objectId === metadata.objectId
        && payload.context.keyClass === "ai"
        && payload.context.objectType === metadata.objectType
        && payload.context.createdAt === metadata.createdAt,
      "encrypted payload binding was substituted",
    );
  } finally {
    payload.ciphertext.fill(0);
  }
}

function assertEnvelopeBoundary(
  crypto: LatticeCrypto,
  rows: readonly DatabaseRow[],
  input: Readonly<{
    objectId: string;
    accessRevision: number;
    namespaceId: string;
    namespaceAccessRevision: number;
    manifestEnvelopeHashes: readonly Uint8Array[];
  }>,
): Uint8Array {
  invariant(
    rows.length > 0 && rows.length <= MAXIMUM_ENVELOPES_PER_MANIFEST,
    "envelope collection is missing or over limit",
  );
  const hashes: Uint8Array[] = [];
  let selected: Uint8Array | undefined;
  try {
    rows.forEach((row, ordinal) => {
      invariant(
        requiredString(row, "object_id") === input.objectId
          && requiredCounter(row, "access_revision")
            === input.accessRevision
          && requiredCounter(row, "ordinal") === ordinal,
        "envelope row coordinates were substituted",
      );
      const namespaceId = requiredString(row, "namespace_id");
      const envelopeHash = requiredBytes(row, "envelope_hash", HASH_BYTES);
      const envelopeBytes = requiredBytes(row, "envelope_bytes");
      const calculatedHash = crypto.hash(envelopeBytes);
      try {
        invariant(
          sameBytes(envelopeHash, calculatedHash),
          "envelope hash is invalid",
        );
        const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
        try {
          invariant(
            envelope.context.objectId === input.objectId
              && envelope.context.namespaceId === namespaceId
              && envelope.context.keyClass === "ai",
            "envelope binding was substituted",
          );
          if (namespaceId === input.namespaceId) {
            invariant(
              envelope.context.bindingRevisionAtWrap
                === input.namespaceAccessRevision,
              "envelope Namespace access revision was substituted",
            );
            invariant(
              selected === undefined,
              "has duplicate envelopes for its Namespace",
            );
            selected = envelopeBytes.slice();
          }
        } finally {
          envelope.wrappedDek.fill(0);
        }
        hashes.push(envelopeHash.slice());
      } finally {
        envelopeHash.fill(0);
        calculatedHash.fill(0);
        envelopeBytes.fill(0);
      }
    });
    hashes.sort((left, right) => {
      for (let index = 0; index < left.length; index += 1) {
        const difference = left[index]! - right[index]!;
        if (difference !== 0) return difference;
      }
      return 0;
    });
    invariant(
      hashes.length === input.manifestEnvelopeHashes.length
        && hashes.every(
          (hash, index) =>
            sameBytes(hash, input.manifestEnvelopeHashes[index]!),
        ),
      "manifest envelope inventory was substituted",
    );
    invariant(selected !== undefined, "Namespace envelope is unavailable");
    return selected;
  } catch (error) {
    selected?.fill(0);
    throw error;
  } finally {
    hashes.forEach((hash) => hash.fill(0));
  }
}

function wipeVerifiedManifest(
  verified: VerifiedObjectAccessManifestV4 | undefined,
): void {
  if (verified === undefined) return;
  verified.manifestBytes.fill(0);
  verified.manifestHash.fill(0);
  verified.manifest.payloadHash.fill(0);
  verified.manifest.previousManifestHash?.fill(0);
  verified.manifest.envelopeHashes.forEach((hash) => hash.fill(0));
  if (verified.manifest.signer.kind === "processor_invocation") {
    verified.manifest.signer.workDescriptorHash.fill(0);
  }
  verified.manifest.signerAuthorizationHash?.fill(0);
  verified.manifest.signature.fill(0);
  const authorization = verified.signerAuthorization;
  if (authorization === null) return;
  authorization.authorizationBytes.fill(0);
  authorization.authorizationHash.fill(0);
  authorization.authorization.issuerSigningPublicKeyHash.fill(0);
  authorization.authorization.signer.workDescriptorHash.fill(0);
  authorization.authorization.signerPublicKey.fill(0);
  authorization.authorization.workDescriptorHash.fill(0);
  authorization.authorization.credentialHash.fill(0);
  authorization.authorization.signature.fill(0);
}

/**
 * Authenticates a persisted Wave-10 processor object using only the
 * `nautilo_crypto` credential boundary. Missing object is the sole nullable
 * result; incomplete or substituted provenance is an integrity failure.
 */
export class PostgresProtectedJournalProcessorObjectVerifier
  implements ProtectedJournalProcessorObjectVerifierPort {
  readonly #crypto: LatticeCrypto;
  readonly #handle: CryptoPostgresHandle;

  constructor(crypto: LatticeCrypto, handle: CryptoPostgresHandle, private readonly verifyV5Input?: VerifyProcessorTransformV5Input) {
    assertVerifiedCryptoPostgresHandle(handle);
    this.#crypto = crypto;
    this.#handle = handle;
  }

  async verify(input: Readonly<{
    readonly objectId: string;
    readonly signal: AbortSignal;
  }>): Promise<VerifiedProtectedJournalProcessorObject | null> {
    input.signal.throwIfAborted();
    assertPortableId("Protected journal crypto object id", input.objectId);
    let candidate: VerifiedProtectedJournalProcessorObject | null = null;
    const discard = () => {candidate?.payloadBytes.fill(0); candidate?.namespaceEnvelopeBytes.fill(0); candidate = null;};
    try {
    const verified = await withVerifiedCryptoPostgresTransaction(this.#handle, async (transaction) => {
      discard();
      await transaction.query(
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY",
      );
      const objectRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          object_id: cryptoObjects.objectId,
          object_payload_hash: sql<Uint8Array>`${cryptoObjects.payloadHash}`
            .as("object_payload_hash"),
          payload_bytes: cryptoObjects.payloadBytes,
          head_access_revision: sql<number | null>`${
            objectCryptoAccessHeads.accessRevision
          }`.as("head_access_revision"),
          head_manifest_hash: sql<Uint8Array | null>`${
            objectCryptoAccessHeads.manifestHash
          }`.as("head_manifest_hash"),
          manifest_object_id: sql<string | null>`${
            objectCryptoAccessManifests.objectId
          }`.as("manifest_object_id"),
          manifest_access_revision: sql<number | null>`${
            objectCryptoAccessManifests.accessRevision
          }`.as("manifest_access_revision"),
          manifest_hash: objectCryptoAccessManifests.manifestHash,
          previous_manifest_hash:
            objectCryptoAccessManifests.previousManifestHash,
          manifest_payload_hash: sql<Uint8Array | null>`${
            objectCryptoAccessManifests.payloadHash
          }`.as("manifest_payload_hash"),
          manifest_bytes: objectCryptoAccessManifests.manifestBytes,
        }).from(cryptoObjects).leftJoin(
          objectCryptoAccessHeads,
          eq(objectCryptoAccessHeads.objectId, cryptoObjects.objectId),
        ).leftJoin(
          objectCryptoAccessManifests,
          and(
            eq(
              objectCryptoAccessManifests.objectId,
              objectCryptoAccessHeads.objectId,
            ),
            eq(
              objectCryptoAccessManifests.accessRevision,
              objectCryptoAccessHeads.accessRevision,
            ),
            eq(
              objectCryptoAccessManifests.manifestHash,
              objectCryptoAccessHeads.manifestHash,
            ),
          ),
        ).where(eq(cryptoObjects.objectId, input.objectId)).limit(2),
      );
    input.signal.throwIfAborted();
    if (objectRows.length === 0) return null;
    const stored = assertObjectStorageRows(
      this.#crypto,
      input.objectId,
      exactOne(objectRows, "object/head/manifest"),
    );
    let verifiedManifest: VerifiedObjectAccessManifestV4 | undefined;
    let descriptorBytes: Uint8Array | undefined;
    let payloadResult: Uint8Array | undefined;
    let envelopeResult: Uint8Array | undefined;
    try {
      if (isCurrentCommonManifest(stored.manifestBytes)) {
        candidate = await createPostgresCurrentProcessorJournalObjectVerifier({handle: transaction, crypto: this.#crypto,
          ...(this.verifyV5Input === undefined ? {} : {verifyV5Input: this.verifyV5Input})}).verify(input);
        return candidate;
      }
      const signerAuthorizationId = processorAuthorizationIdFromManifest(
        stored.manifestBytes,
      );
      const authorizationRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          authorization_id:
            processorCryptoSignerAuthorizations.authorizationId,
          request_id: processorCryptoSignerAuthorizations.requestId,
          recipient_generation:
            processorCryptoSignerAuthorizations.recipientGeneration,
          processor_kind:
            processorCryptoSignerAuthorizations.processorKind,
          processor_version:
            processorCryptoSignerAuthorizations.processorVersion,
          work_id: processorCryptoSignerAuthorizations.workId,
          namespace_id: processorCryptoSignerAuthorizations.namespaceId,
          domain_id: processorCryptoSignerAuthorizations.domainId,
          domain_epoch: processorCryptoSignerAuthorizations.domainEpoch,
          namespace_access_revision:
            processorCryptoSignerAuthorizations.namespaceAccessRevision,
          policy_revision:
            processorCryptoSignerAuthorizations.policyRevision,
          processor_authorization_revision:
            processorCryptoSignerAuthorizations
              .processorAuthorizationRevision,
          issuing_human_id:
            processorCryptoSignerAuthorizations.issuingHumanId,
          issuing_device_id:
            processorCryptoSignerAuthorizations.issuingDeviceId,
          issuing_device_authorization_revision:
            processorCryptoSignerAuthorizations
              .issuingDeviceAuthorizationRevision,
          issuer_signing_public_key_hash:
            processorCryptoSignerAuthorizations.issuerSigningPublicKeyHash,
          signer_key_id: processorCryptoSignerAuthorizations.signerKeyId,
          signer_public_key:
            processorCryptoSignerAuthorizations.signerPublicKey,
          work_descriptor_hash:
            processorCryptoSignerAuthorizations.workDescriptorHash,
          work_descriptor_bytes:
            processorCryptoSignerAuthorizations.workDescriptorBytes,
          authorization_hash:
            processorCryptoSignerAuthorizations.authorizationHash,
          credential_hash:
            processorCryptoSignerAuthorizations.credentialHash,
          authorization_bytes:
            processorCryptoSignerAuthorizations.authorizationBytes,
          issued_at_ms: sql<number>`floor(extract(epoch from ${
            processorCryptoSignerAuthorizations.issuedAt
          }) * 1000)::bigint`.as("issued_at_ms"),
          expires_at_ms: sql<number>`floor(extract(epoch from ${
            processorCryptoSignerAuthorizations.expiresAt
          }) * 1000)::bigint`.as("expires_at_ms"),
        }).from(processorCryptoSignerAuthorizations).where(eq(
          processorCryptoSignerAuthorizations.authorizationId,
          signerAuthorizationId,
        )).limit(2),
      );
      input.signal.throwIfAborted();
      const authorizationRow = exactOne(
        authorizationRows,
        "processor signer authorization",
      );
      const authorizationBytes = requiredBytes(
        authorizationRow,
        "authorization_bytes",
      );
      if (readProcessorSignerAuthorizationVersion(authorizationBytes) === 2) {
        try {
          candidate = await verifyCurrentJournalObject(transaction, this.#crypto, stored, authorizationBytes, input.objectId, input.signal);
          return candidate;
        } finally {authorizationBytes.fill(0);}
      }
      const storedAuthorizationHash = requiredBytes(
        authorizationRow,
        "authorization_hash",
        HASH_BYTES,
      );
      const issuingDeviceId = requiredString(
        authorizationRow,
        "issuing_device_id",
      );
      const requestId = requiredString(authorizationRow, "request_id");

      const deviceRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          device_id: humanCryptoDevices.deviceId,
          human_id: humanCryptoDevices.humanId,
          signing_public_key: humanCryptoDevices.signingPublicKey,
          revision: humanCryptoDevices.revision,
        }).from(humanCryptoDevices).where(eq(
          humanCryptoDevices.deviceId,
          issuingDeviceId,
        )).limit(2),
      );
      input.signal.throwIfAborted();
      const deviceRow = exactOne(deviceRows, "historical issuing device");
      const historicalPublicKey = requiredBytes(
        deviceRow,
        "signing_public_key",
        SIGNING_PUBLIC_KEY_BYTES,
      );
      try {
        verifiedManifest = verifyObjectAccessManifestV4(this.#crypto, {
          manifestBytes: stored.manifestBytes,
          resolveAgentRuntimeSignerPublicKey: () => null,
          resolveProcessorSignerAuthorizationBytes: (evidence) => {
            invariant(
              evidence.authorizationId
                  === requiredString(authorizationRow, "authorization_id")
                && sameBytes(
                  evidence.authorizationHash,
                  storedAuthorizationHash,
                )
                && evidence.signer.signerKeyId
                  === requiredString(authorizationRow, "signer_key_id")
                && evidence.objectId === input.objectId,
              "manifest signer authorization evidence was substituted",
            );
            return authorizationBytes;
          },
          resolveHistoricalIssuingDevicePublicKey: (context) => {
            invariant(
              context.issuingDeviceId
                  === requiredString(deviceRow, "device_id")
                && context.issuingHumanId
                  === requiredString(deviceRow, "human_id")
                && requiredCounter(deviceRow, "revision")
                  >= context.issuingDeviceAuthorizationRevision,
              "historical issuing device row was substituted",
            );
            return historicalPublicKey;
          },
        });
      } finally {
        authorizationBytes.fill(0);
        storedAuthorizationHash.fill(0);
        historicalPublicKey.fill(0);
      }
      invariant(
        verifiedManifest.manifest.objectId === input.objectId
          && verifiedManifest.manifest.accessRevision
            === stored.accessRevision
          && sameBytes(
            verifiedManifest.manifest.payloadHash,
            stored.payloadHash,
          )
          && sameOptionalBytes(
            verifiedManifest.manifest.previousManifestHash,
            stored.previousManifestHash,
          )
          && sameBytes(
            verifiedManifest.manifestHash,
            stored.manifestHash,
          ),
        "verified manifest does not match the canonical head",
      );
      const signerAuthorization = verifiedManifest.signerAuthorization;
      invariant(
        signerAuthorization !== null,
        "manifest lacks verified processor signer authorization",
      );
      const authorization = signerAuthorization.authorization;
      const requestLink = assertAuthorizationRow(
        this.#crypto,
        authorizationRow,
        authorization,
        signerAuthorization.authorizationHash,
      );
      descriptorBytes = requestLink.descriptorBytes;
      const descriptor = decodeBackgroundWorkDescriptorV1(descriptorBytes);
      try {
        const requestRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            request_id: backgroundCryptoAuthorizationRequests.requestId,
            work_id: backgroundCryptoAuthorizationRequests.workId,
            work_kind: backgroundCryptoAuthorizationRequests.workKind,
            purpose: backgroundCryptoAuthorizationRequests.purpose,
            namespace_id:
              backgroundCryptoAuthorizationRequests.namespaceId,
            domain_id: backgroundCryptoAuthorizationRequests.domainId,
            credential_subject_kind:
              backgroundCryptoAuthorizationRequests.credentialSubjectKind,
            processor_kind:
              backgroundCryptoAuthorizationRequests.processorKind,
            processor_version:
              backgroundCryptoAuthorizationRequests.processorVersion,
            processor_authorization_revision:
              backgroundCryptoAuthorizationRequests
                .processorAuthorizationRevision,
            expected_domain_epoch:
              backgroundCryptoAuthorizationRequests.expectedDomainEpoch,
            expected_namespace_access_revision:
              backgroundCryptoAuthorizationRequests
                .expectedNamespaceAccessRevision,
            expected_policy_revision:
              backgroundCryptoAuthorizationRequests.expectedPolicyRevision,
            recipient_generation:
              backgroundCryptoAuthorizationRequests.recipientGeneration,
            descriptor_hash:
              backgroundCryptoAuthorizationRequests.descriptorHash,
            descriptor_bytes:
              backgroundCryptoAuthorizationRequests.descriptorBytes,
            accepted_response_kind:
              backgroundCryptoAuthorizationRequests.acceptedResponseKind,
            credential_hash:
              backgroundCryptoAuthorizationRequests.credentialHash,
            issuing_human_id:
              backgroundCryptoAuthorizationRequests.issuingHumanId,
            issuing_device_id:
              backgroundCryptoAuthorizationRequests.issuingDeviceId,
            issuing_device_authorization_revision:
              backgroundCryptoAuthorizationRequests
                .issuingDeviceAuthorizationRevision,
            issuer_signing_public_key_hash:
              backgroundCryptoAuthorizationRequests
                .issuerSigningPublicKeyHash,
            state: backgroundCryptoAuthorizationRequests.state,
          }).from(backgroundCryptoAuthorizationRequests).where(eq(
            backgroundCryptoAuthorizationRequests.requestId,
            requestId,
          )).limit(2),
        );
        input.signal.throwIfAborted();
        invariant(
          requestRows.length <= 1,
          "has ambiguous accepted request audit evidence",
        );
        if (requestRows[0] !== undefined) {
          assertAcceptedRequest(
            this.#crypto,
            requestRows[0],
            descriptorBytes,
            descriptor,
            authorization,
            requestLink,
          );
        }
        const boundary = assertDescriptorBoundary(
          descriptor,
          authorization,
          input.objectId,
          requestLink,
        );
        assertPayloadBoundary(
          stored.payloadBytes,
          descriptor,
          boundary.outputOrdinal,
        );
        const envelopeRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            object_id: objectCryptoNamespaceEnvelopes.objectId,
            access_revision:
              objectCryptoNamespaceEnvelopes.accessRevision,
            namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
            ordinal: objectCryptoNamespaceEnvelopes.ordinal,
            envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
            envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
          }).from(objectCryptoNamespaceEnvelopes).where(and(
            eq(objectCryptoNamespaceEnvelopes.objectId, input.objectId),
            eq(
              objectCryptoNamespaceEnvelopes.accessRevision,
              stored.accessRevision,
            ),
          )).orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal)).limit(
            MAXIMUM_ENVELOPES_PER_MANIFEST + 1,
          ),
        );
        input.signal.throwIfAborted();
        envelopeResult = assertEnvelopeBoundary(
          this.#crypto,
          envelopeRows,
          {
            objectId: input.objectId,
            accessRevision: stored.accessRevision,
            namespaceId: descriptor.namespaceId,
            namespaceAccessRevision:
              descriptor.expectedNamespaceAccessRevision,
            manifestEnvelopeHashes:
              verifiedManifest.manifest.envelopeHashes,
          },
        );
        payloadResult = stored.payloadBytes.slice();
        const result = Object.freeze({
          objectId: input.objectId,
          namespaceId: descriptor.namespaceId,
          domainId: descriptor.domainId,
          workId: descriptor.workId,
          rebuildGeneration: boundary.rebuildGeneration,
          outputOrdinal: boundary.outputOrdinal,
          authorizedOutputObjectIds: Object.freeze([
            ...descriptor.outputObjectIds,
          ]),
          publisherNamespaceAccessRevision:
            descriptor.expectedNamespaceAccessRevision,
          payloadBytes: payloadResult,
          namespaceEnvelopeBytes: envelopeResult,
        });
        payloadResult = undefined;
        envelopeResult = undefined;
        candidate = result;
        return result;
      } finally {
        descriptor.source.fingerprint.fill(0);
        descriptor.recipientPublicKey.fill(0);
      }
    } finally {
      stored.payloadBytes.fill(0);
      stored.payloadHash.fill(0);
      stored.manifestBytes.fill(0);
      stored.manifestHash.fill(0);
      stored.previousManifestHash?.fill(0);
      descriptorBytes?.fill(0);
      payloadResult?.fill(0);
      envelopeResult?.fill(0);
      wipeVerifiedManifest(verifiedManifest);
    }
    });
    input.signal.throwIfAborted();
    candidate = null;
    return verified;
    } finally {discard();}
  }
}

/** Current certificates retain their own exact descriptor; request retention is
 * not an authority dependency for reading a previously committed Journal. */
async function verifyCurrentJournalObject(
  executor: CryptoPostgresExecutor, crypto: LatticeCrypto,
  stored: ReturnType<typeof assertObjectStorageRows>, authorizationBytes: Uint8Array,
  objectId: string, signal: AbortSignal,
): Promise<VerifiedProtectedJournalProcessorObject> {
  const evidence = await loadVerifiedCurrentProcessorSignerAuthorization(executor, crypto, authorizationBytes);
  let verified: VerifiedObjectAccessManifestV4 | undefined;
  let envelopeBytes: Uint8Array | undefined;
  try {
    signal.throwIfAborted();
    const certificate = evidence.certificate;
    const descriptor = certificate.descriptor;
    invariant("authority" in descriptor, "Journal output requires a Stenographer descriptor");
    verified = verifyObjectAccessManifestV4(crypto, {
      manifestBytes: stored.manifestBytes,
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: context =>
        context.authorizationId === certificate.credentialId
          && sameBytes(context.authorizationHash, evidence.authorizationHash)
          ? evidence.authorizationBytes : null,
      resolveHistoricalIssuingDevicePublicKey: () => null,
      resolveHistoricalCurrentIssuer: context =>
        context.issuer.humanId === certificate.issuer.humanId
          && context.issuer.deviceId === certificate.issuer.deviceId
          && context.issuer.deviceGeneration === certificate.issuer.deviceGeneration
          && sameBytes(context.descriptorHash, certificate.descriptorHash)
          ? evidence.issuerPublicKey : null,
    });
    invariant(verified.currentSignerAuthorization !== null
      && verified.manifest.objectId === objectId
      && verified.manifest.accessRevision === stored.accessRevision
      && sameBytes(verified.manifestHash, stored.manifestHash)
      && sameBytes(verified.manifest.payloadHash, stored.payloadHash)
      && sameOptionalBytes(verified.manifest.previousManifestHash, stored.previousManifestHash),
      "current Journal manifest does not match its canonical head");
    const outputOrdinal = descriptor.outputSlots.findIndex((slot) => slot.objectId === objectId);
    invariant(outputOrdinal >= 0 && JOURNAL_WORK_KINDS.has(descriptor.workKind), "current Journal is outside authorized output slots");
    assertPayloadBoundary(stored.payloadBytes, {outputObjectMetadata: descriptor.outputSlots}, outputOrdinal);
    const slot = descriptor.outputSlots[outputOrdinal]!;
    invariant(slot.namespaceIds.length === 1, "current Journal output Namespace set is invalid");
    const envelopeRows = await executeTypedCryptoQuery(executor, cryptoTypedDb.select({
      object_id: objectCryptoNamespaceEnvelopes.objectId,
      access_revision: objectCryptoNamespaceEnvelopes.accessRevision,
      namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
      ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes).where(and(
      eq(objectCryptoNamespaceEnvelopes.objectId, objectId),
      eq(objectCryptoNamespaceEnvelopes.accessRevision, stored.accessRevision),
    )).orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal)).limit(MAXIMUM_ENVELOPES_PER_MANIFEST + 1));
    signal.throwIfAborted();
    envelopeBytes = assertEnvelopeBoundary(crypto, envelopeRows, {objectId, accessRevision: stored.accessRevision,
      namespaceId: slot.namespaceIds[0]!, namespaceAccessRevision: descriptor.authority.namespaceAccessRevision,
      manifestEnvelopeHashes: verified.manifest.envelopeHashes});
    const result = Object.freeze({objectId, namespaceId: slot.namespaceIds[0]!, domainId: descriptor.anchorDomainId,
      workId: descriptor.workId, rebuildGeneration: descriptor.source.rebuildGeneration, outputOrdinal,
      authorizedOutputObjectIds: Object.freeze(descriptor.outputSlots.map((output) => output.objectId)),
      publisherNamespaceAccessRevision: descriptor.authority.namespaceAccessRevision,
      payloadBytes: stored.payloadBytes.slice(), namespaceEnvelopeBytes: envelopeBytes});
    envelopeBytes = undefined;
    return result;
  } finally {
    envelopeBytes?.fill(0);
    if (verified?.currentSignerAuthorization) destroyVerifiedProcessorSignerAuthorizationV2(verified.currentSignerAuthorization);
    wipeVerifiedManifest(verified);
    destroyVerifiedCurrentProcessorSignerEvidence(evidence);
  }
}
