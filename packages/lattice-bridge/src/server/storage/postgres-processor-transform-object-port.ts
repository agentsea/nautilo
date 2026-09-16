import {
  LatticeCrypto,
  assertPortableId,
  verifyBindingEnvelopePair,
  verifyAgentObjectAccessManifest,
  type ProcessorTransformObjectPort,
  type CommonObjectAccessManifest,
} from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1,
  decodeBackgroundWorkDescriptorV1,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV2OrV3,
  decodeObjectAccessManifestV4,
  decodeObjectAccessManifestV5,
  OBJECT_ACCESS_MANIFEST_DOMAIN_V4,
  OBJECT_ACCESS_MANIFEST_DOMAIN_V5,
  readProcessorSignerAuthorizationVersionV2,
  decodeProcessorSignerAuthorizationV1,
  objectAccessManifestSigningBytesV2,
  parseNamespaceBindingV2,
  parseNamespaceKeyringEnvelopeV2,
  verifyHistoricalProcessorSignerAuthorizationV1,
  verifyObjectAccessManifestV4,
  type BackgroundWorkDescriptorV1,
  type ObjectAccessManifestV2,
  type ObjectAccessManifestV2OrV3,
  type ObjectAccessManifestV3,
  type ObjectAccessManifestV4,
  type ProcessorSignerAuthorizationV1,
} from "@nautilo/lattice-crypto/wire";
import {
  and,
  agentCryptoRuntimeSigners,
  asc,
  backgroundCryptoAuthorizationRequests,
  cryptoObjects,
  eq,
  namespaceCryptoBindings,
  namespaceCryptoHeads,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  processorCryptoSignerAuthorizations,
  sql,
} from "@nautilo/db";
import {
  authenticateHistoricalAgentRuntimeSignerPublication,
} from "./agent-runtime-signer-history.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "./postgres-lattice-storage.ts";
import type {
  DatabaseRow,
} from "./postgres-record-codecs.ts";
import {loadVerifiedCurrentProcessorSignerAuthorization, destroyVerifiedCurrentProcessorSignerEvidence} from "./postgres-current-processor-signer-authorization.ts";
import {destroyVerifiedStoredObjectAccessManifestChainV5,
  type verifyStoredObjectAccessManifestChainV5,
  type VerifiedStoredObjectAccessManifestChainV5, type ResolveLiveShadowAgentObjectSigner} from "./postgres-object-access-manifest-v5.ts";
import {ClassifiedDataOperationError} from "../../transition/encryption-data-operation-owner.ts";

export type VerifyProcessorTransformV5Input = (input: Pick<
  Parameters<typeof verifyStoredObjectAccessManifestChainV5>[0],
  "executor" | "crypto" | "objectId" | "headAccessRevision" | "expectedPayloadHash" | "expectedHeadManifestHash"
>) => Promise<VerifiedStoredObjectAccessManifestChainV5>;

type PublicationOutput = Parameters<
  ProcessorTransformObjectPort["publishOutputs"]
>[0]["outputs"][number];

export type ExactOutput = Readonly<{
  readonly objectId: string;
  readonly payloadBytes: Uint8Array;
  readonly payloadHash: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  readonly envelopeHash: Uint8Array;
  readonly namespaceId: string;
  readonly manifestBytes: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly tombstoneManifestBytes: Uint8Array;
  readonly tombstoneManifestHash: Uint8Array;
}>;

/** Same immutable output publication, with the existing per-object Namespace set. */
export type ExactNamespaceSetOutput = Omit<ExactOutput, "namespaceId" | "envelopeBytes" | "envelopeHash"> & Readonly<{
  namespaceEnvelopes: readonly Readonly<{
    namespaceId: string; envelopeBytes: Uint8Array; envelopeHash: Uint8Array;
  }>[];
}>;

function namespaceSet(output: ExactOutput | ExactNamespaceSetOutput) {
  const entries = "namespaceEnvelopes" in output ? output.namespaceEnvelopes : [output];
  if (entries.length < 1 || entries.length > 256
    || entries.some((entry, index) => index > 0 && entries[index - 1]!.namespaceId >= entry.namespaceId)) {
    throw new TypeError("Processor output requires a canonical exact Namespace set");
  }
  // Manifest ordinals follow canonical ciphertext-hash order, while caller
  // authority inventories retain canonical Namespace order.
  return [...entries].sort((left, right) => Buffer.compare(left.envelopeHash, right.envelopeHash));
}

type ExistingOutputState = "absent" | "exact";

const MAXIMUM_OUTPUTS = 256;

function aborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Processor transform operation aborted");
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function nullableBytesEqual(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && bytesEqual(left, right);
}

function rowString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new ClassifiedDataOperationError("integrity", `Processor transform column ${name} must be text`);
  }
  return value;
}

function rowCounter(row: DatabaseRow, name: string): number {
  const value = row[name];
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new ClassifiedDataOperationError("integrity",
      `Processor transform column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function rowInstant(row: DatabaseRow, name: string): number {
  const raw = row[name];
  const value = typeof raw === "string" ? new Date(raw) : raw;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ClassifiedDataOperationError("integrity",
      `Processor transform column ${name} must be an instant`,
    );
  }
  return value.getTime();
}

function rowBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new ClassifiedDataOperationError("integrity", `Processor transform column ${name} must be bytea`);
  }
  return new Uint8Array(value);
}

function rowNullableBytes(
  row: DatabaseRow,
  name: string,
): Uint8Array | null {
  return row[name] === null ? null : rowBytes(row, name);
}

function oneOrNull(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow | null {
  if (rows.length > 1) {
    throw new ClassifiedDataOperationError("integrity", `${label} returned more than one durable row`);
  }
  return rows[0] ?? null;
}

function hash(crypto: LatticeCrypto, bytes: Uint8Array): Uint8Array {
  const digest = crypto.hash(bytes);
  if (!(digest instanceof Uint8Array) || digest.length !== 32) {
    throw new TypeError("Lattice crypto hash must return exactly 32 bytes");
  }
  return digest.slice();
}

export function exactManifestForStoredBytes(
  manifestBytes: Uint8Array,
):
  | Readonly<{ readonly version: 2 | 3; readonly manifest: ObjectAccessManifestV2OrV3 }>
  | Readonly<{ readonly version: 4; readonly manifest: ObjectAccessManifestV4 }>
  | Readonly<{ readonly version: 5; readonly manifest: CommonObjectAccessManifest }> {
  const hasDomain = (domain: string) => {
    const bytes = new TextEncoder().encode(domain);
    return manifestBytes.length >= bytes.length + 4
      && new DataView(manifestBytes.buffer, manifestBytes.byteOffset, manifestBytes.byteLength).getUint32(0) === bytes.length
      && bytes.every((byte, index) => byte === manifestBytes[index + 4]);
  };
  if (hasDomain(OBJECT_ACCESS_MANIFEST_DOMAIN_V4)) return Object.freeze({version: 4, manifest: decodeObjectAccessManifestV4(manifestBytes)});
  if (hasDomain(OBJECT_ACCESS_MANIFEST_DOMAIN_V5)) return Object.freeze({version: 5, manifest: decodeObjectAccessManifestV5(manifestBytes)});
  const manifest = decodeObjectAccessManifestV2OrV3(manifestBytes);
  return Object.freeze({version: manifest.formatVersion, manifest});
}

async function loadHistoricalHumanManifestSigner(
  executor: CryptoPostgresExecutor,
  crypto: LatticeCrypto,
  manifest: ObjectAccessManifestV2,
): Promise<void> {
  const rows = await executor.query(
    `SELECT device_id, human_id, signing_public_key, state, revision
       FROM human_crypto_devices
      WHERE device_id = $1
      LIMIT 2
      FOR SHARE`,
    [manifest.committerDeviceId],
  );
  const row = oneOrNull(rows, "Human object manifest signer history");
  if (
    row === null
    || rowString(row, "device_id") !== manifest.committerDeviceId
    || (rowString(row, "state") !== "active"
      && rowString(row, "state") !== "revoked")
    || rowCounter(row, "revision") < manifest.hostAuthorizationRevision
  ) {
    throw new Error(
      "Human object manifest signer history is unavailable",
    );
  }
  const publicKey = rowBytes(row, "signing_public_key");
  const signingBytes = objectAccessManifestSigningBytesV2(manifest);
  try {
    if (!crypto.verify(publicKey, signingBytes, manifest.signature)) {
      throw new Error("Human object access manifest signature is invalid");
    }
  } finally {
    publicKey.fill(0);
    signingBytes.fill(0);
  }
}

async function authenticateHistoricalAgentManifest(
  executor: CryptoPostgresExecutor,
  crypto: LatticeCrypto,
  manifest: ObjectAccessManifestV3,
  manifestBytes: Uint8Array,
): Promise<void> {
  const publicationRows = await executeTypedCryptoQuery(executor,
    cryptoTypedDb.select({
      agent_id: agentCryptoRuntimeSigners.agentId,
      runtime_generation: agentCryptoRuntimeSigners.runtimeGeneration,
      authorization_revision: agentCryptoRuntimeSigners.authorizationRevision,
      transition_kind: agentCryptoRuntimeSigners.transitionKind,
      operation_id: agentCryptoRuntimeSigners.operationId,
      signer_key_id: agentCryptoRuntimeSigners.signerKeyId,
      signer_public_key: agentCryptoRuntimeSigners.signerPublicKey,
      publication_bytes: agentCryptoRuntimeSigners.publicationBytes,
    }).from(agentCryptoRuntimeSigners).where(and(
      eq(agentCryptoRuntimeSigners.agentId, manifest.signer.agentId),
      eq(agentCryptoRuntimeSigners.runtimeGeneration, manifest.signer.runtimeGeneration),
    )).limit(2),
  );
  const publicationRow = oneOrNull(
    publicationRows,
    "Agent Runtime signer publication history",
  );
  if (publicationRow === null) {
    throw new Error(
      "Agent Runtime signer publication history is unavailable",
    );
  }
  const publication = decodeAgentRuntimeSignerPublicationV1(
    rowBytes(publicationRow, "publication_bytes"),
  );
  if (
    rowString(publicationRow, "agent_id") !== publication.agentId
    || rowCounter(publicationRow, "runtime_generation")
      !== publication.runtimeGeneration
    || rowCounter(publicationRow, "authorization_revision")
      !== publication.authorizationRevision
    || rowString(publicationRow, "transition_kind")
      !== publication.transitionKind
    || rowString(publicationRow, "operation_id") !== publication.operationId
    || rowString(publicationRow, "signer_key_id") !== publication.signerKeyId
    || !bytesEqual(
      rowBytes(publicationRow, "signer_public_key"),
      publication.signerPublicKey,
    )
  ) {
    throw new Error(
      "Agent Runtime signer publication history has conflicting durable columns",
    );
  }
  const managerRows = await executor.query(
    `SELECT device_id, human_id, signing_public_key, state, revision
       FROM human_crypto_devices
      WHERE device_id = $1
      LIMIT 2
      FOR SHARE`,
    [publication.managerDeviceId],
  );
  const manager = oneOrNull(
    managerRows,
    "Agent Runtime signer manager history",
  );
  if (
    manager === null
    || rowString(manager, "device_id") !== publication.managerDeviceId
    || rowString(manager, "human_id") !== publication.managerHumanId
    || (rowString(manager, "state") !== "active"
      && rowString(manager, "state") !== "revoked")
    || rowCounter(manager, "revision")
      < publication.managerAuthorizationRevision
  ) {
    throw new Error(
      "Agent Runtime signer manager history is unavailable",
    );
  }
  const managerPublicKey = rowBytes(manager, "signing_public_key");
  try {
    if (
      !bytesEqual(
        hash(crypto, managerPublicKey),
        publication.managerSigningPublicKeyHash,
      )
    ) {
      throw new Error(
        "Agent Runtime signer manager key conflicts with publication history",
      );
    }
    const authenticated =
      await authenticateHistoricalAgentRuntimeSignerPublication({
        crypto,
        publication,
        resolveHistoricalManagerAuthority: (context) =>
          context.managerDeviceId === publication.managerDeviceId
              && context.managerHumanId === publication.managerHumanId
            ? {
              ...context,
              managerSigningPublicKey: managerPublicKey,
            }
            : null,
      });
    if (
      authenticated.agentId !== manifest.signer.agentId
      || authenticated.runtimeGeneration
        !== manifest.signer.runtimeGeneration
      || authenticated.signerKeyId !== manifest.signer.signerKeyId
      || authenticated.authorizationRevision
        !== manifest.hostAuthorizationRevision
    ) {
      throw new Error(
        "Agent object manifest signer does not match authenticated history",
      );
    }
    verifyAgentObjectAccessManifest(crypto, {
      manifestBytes,
      resolveSignerPublicKey: (principal) =>
        principal.agentId === authenticated.agentId
            && principal.runtimeGeneration
              === authenticated.runtimeGeneration
            && principal.signerKeyId === authenticated.signerKeyId
          ? authenticated.signerPublicKey
          : null,
    });
  } finally {
    managerPublicKey.fill(0);
  }
}

function assertRequestCoordinates(
  row: DatabaseRow,
  descriptor: BackgroundWorkDescriptorV1,
  descriptorHash: Uint8Array,
  idempotencyId: string,
  claimId: string,
): void {
  if (
    rowString(row, "request_id") !== descriptor.requestId
    || rowString(row, "idempotency_key") !== idempotencyId
    || descriptor.idempotencyId !== idempotencyId
    || rowString(row, "claim_id") !== claimId
    || rowCounter(row, "recipient_generation")
      !== descriptor.recipientGeneration
    || rowString(row, "work_id") !== descriptor.workId
    || rowString(row, "namespace_id") !== descriptor.namespaceId
    || rowString(row, "domain_id") !== descriptor.domainId
    || rowCounter(row, "expected_domain_epoch")
      !== descriptor.expectedDomainEpoch
    || rowCounter(row, "expected_namespace_access_revision")
      !== descriptor.expectedNamespaceAccessRevision
    || rowCounter(row, "expected_policy_revision")
      !== descriptor.expectedPolicyRevision
    || descriptor.subject.kind !== "processor"
    || rowCounter(row, "processor_authorization_revision")
      !== descriptor.subject.authorizationRevision
    || !bytesEqual(rowBytes(row, "descriptor_hash"), descriptorHash)
  ) {
    throw new Error(
      "Processor transform durable request does not match its descriptor",
    );
  }
  if (rowString(row, "state") !== "running") {
    throw new Error("Processor transform durable request is not publishable");
  }
}

function assertExistingTransformCommit(
  row: DatabaseRow,
  descriptor: BackgroundWorkDescriptorV1,
  descriptorHash: Uint8Array,
  claimId: string,
  outputCount: number,
): "absent" | "exact" {
  const values = [
    row["transform_commit_claim_id"],
    row["transform_commit_descriptor_hash"],
    row["transform_commit_recipient_generation"],
    row["transform_commit_output_count"],
    row["transform_committed_at"],
  ];
  if (values.every((value) => value === null)) return "absent";
  if (
    values.some((value) => value === null)
    || rowString(row, "transform_commit_claim_id") !== claimId
    || !bytesEqual(
      rowBytes(row, "transform_commit_descriptor_hash"),
      descriptorHash,
    )
    || rowCounter(row, "transform_commit_recipient_generation")
      !== descriptor.recipientGeneration
    || rowCounter(row, "transform_commit_output_count") !== outputCount
  ) {
    throw new Error(
      "Processor transform commit marker conflicts with the exact publication",
    );
  }
  rowInstant(row, "transform_committed_at");
  return "exact";
}

function assertAuthorizationCoordinates(
  descriptor: BackgroundWorkDescriptorV1,
  descriptorHash: Uint8Array,
  authorization: ProcessorSignerAuthorizationV1,
  credentialHash: Uint8Array,
): void {
  if (
    authorization.workId !== descriptor.workId
    || authorization.namespaceId !== descriptor.namespaceId
    || authorization.domainId !== descriptor.domainId
    || authorization.domainEpoch !== descriptor.expectedDomainEpoch
    || authorization.namespaceAccessRevision
      !== descriptor.expectedNamespaceAccessRevision
    || authorization.policyRevision !== descriptor.expectedPolicyRevision
    || descriptor.subject.kind !== "processor"
    || authorization.processorKind !== descriptor.subject.processorKind
    || authorization.processorVersion !== descriptor.subject.processorVersion
    || authorization.processorAuthorizationRevision
      !== descriptor.subject.authorizationRevision
    || !bytesEqual(
      authorization.workDescriptorHash,
      descriptorHash,
    )
  ) {
    throw new Error(
      "Processor signer authorization does not match the work descriptor",
    );
  }
  if (
    !bytesEqual(authorization.credentialHash, credentialHash)
    || authorization.maxOutputObjects
      !== descriptor.maximumOutputObjectCount
    || authorization.maxOutputPlaintextBytes
      !== descriptor.maximumPlaintextBytes
    || authorization.maxOutputCiphertextBytes
      !== descriptor.maximumCiphertextBytes
    || authorization.outputObjectIds.length
      !== descriptor.outputObjectIds.length
    || authorization.outputObjectIds.some(
      (id, index) => id !== descriptor.outputObjectIds[index],
    )
  ) {
    throw new Error(
      "Processor signer authorization output boundary does not match",
    );
  }
}

function signerAuthorityContextMatches(
  context: Readonly<{
    readonly issuingHumanId: string;
    readonly issuingDeviceId: string;
    readonly issuingDeviceAuthorizationRevision: number;
  }>,
  authorization: ProcessorSignerAuthorizationV1,
): boolean {
  return context.issuingHumanId === authorization.issuingHumanId
    && context.issuingDeviceId === authorization.issuingDeviceId
    && context.issuingDeviceAuthorizationRevision
      === authorization.issuingDeviceAuthorizationRevision;
}

function assertSignerEvidenceRow(
  crypto: LatticeCrypto,
  row: DatabaseRow,
  authorization: ProcessorSignerAuthorizationV1,
  authorizationBytes: Uint8Array,
  authorizationHash: Uint8Array,
): void {
  const workDescriptorHash = rowBytes(row, "work_descriptor_hash");
  const workDescriptorBytes = rowBytes(row, "work_descriptor_bytes");
  const calculatedWorkDescriptorHash = hash(crypto, workDescriptorBytes);
  try {
    if (
      rowString(row, "authorization_id") !== authorization.id
    || rowString(row, "processor_kind") !== authorization.processorKind
    || rowCounter(row, "processor_version") !== authorization.processorVersion
    || rowString(row, "work_id") !== authorization.workId
    || rowString(row, "namespace_id") !== authorization.namespaceId
    || rowString(row, "domain_id") !== authorization.domainId
    || rowCounter(row, "domain_epoch") !== authorization.domainEpoch
    || rowCounter(row, "namespace_access_revision")
      !== authorization.namespaceAccessRevision
    || rowCounter(row, "policy_revision") !== authorization.policyRevision
    || rowCounter(row, "processor_authorization_revision")
      !== authorization.processorAuthorizationRevision
    || rowString(row, "issuing_human_id") !== authorization.issuingHumanId
    || rowString(row, "issuing_device_id") !== authorization.issuingDeviceId
    || rowCounter(row, "issuing_device_authorization_revision")
      !== authorization.issuingDeviceAuthorizationRevision
    || !bytesEqual(
      rowBytes(row, "issuer_signing_public_key_hash"),
      authorization.issuerSigningPublicKeyHash,
    )
    || rowString(row, "signer_key_id")
      !== authorization.signer.signerKeyId
    || !bytesEqual(
      rowBytes(row, "signer_public_key"),
      authorization.signerPublicKey,
    )
    || !bytesEqual(
      rowBytes(row, "credential_hash"),
      authorization.credentialHash,
    )
    || !bytesEqual(rowBytes(row, "authorization_hash"), authorizationHash)
      || !bytesEqual(
        workDescriptorHash,
        authorization.workDescriptorHash,
      )
      || !bytesEqual(workDescriptorHash, calculatedWorkDescriptorHash)
      || !bytesEqual(
        rowBytes(row, "authorization_bytes"),
        authorizationBytes,
      )
    ) {
      throw new Error(
        "Processor signer authorization evidence has conflicting durable bytes",
      );
    }
  } finally {
    workDescriptorHash.fill(0);
    workDescriptorBytes.fill(0);
    calculatedWorkDescriptorHash.fill(0);
  }
}

export async function loadVerifiedProcessorSignerAuthorization(
  executor: CryptoPostgresExecutor,
  crypto: LatticeCrypto,
  bytes: Uint8Array,
): Promise<Readonly<{
  readonly authorization: ProcessorSignerAuthorizationV1;
  readonly authorizationHash: Uint8Array;
  readonly authorizationBytes: Uint8Array;
  readonly issuerPublicKey: Uint8Array;
  readonly requestId: string;
  readonly recipientGeneration: number;
}>> {
  const authorization = decodeProcessorSignerAuthorizationV1(bytes);
  const authorizationHash = hash(crypto, bytes);
  const evidenceRows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      authorization_id: processorCryptoSignerAuthorizations.authorizationId,
      request_id: processorCryptoSignerAuthorizations.requestId,
      recipient_generation:
        processorCryptoSignerAuthorizations.recipientGeneration,
      processor_kind: processorCryptoSignerAuthorizations.processorKind,
      processor_version: processorCryptoSignerAuthorizations.processorVersion,
      authorization_hash:
        processorCryptoSignerAuthorizations.authorizationHash,
      authorization_bytes:
        processorCryptoSignerAuthorizations.authorizationBytes,
      issuing_human_id:
        processorCryptoSignerAuthorizations.issuingHumanId,
      issuing_device_id:
        processorCryptoSignerAuthorizations.issuingDeviceId,
      issuing_device_authorization_revision:
        processorCryptoSignerAuthorizations.issuingDeviceAuthorizationRevision,
      issuer_signing_public_key_hash:
        processorCryptoSignerAuthorizations.issuerSigningPublicKeyHash,
      signer_key_id: processorCryptoSignerAuthorizations.signerKeyId,
      signer_public_key: processorCryptoSignerAuthorizations.signerPublicKey,
      work_descriptor_hash:
        processorCryptoSignerAuthorizations.workDescriptorHash,
      work_descriptor_bytes:
        processorCryptoSignerAuthorizations.workDescriptorBytes,
      work_id: processorCryptoSignerAuthorizations.workId,
      namespace_id: processorCryptoSignerAuthorizations.namespaceId,
      domain_id: processorCryptoSignerAuthorizations.domainId,
      domain_epoch: processorCryptoSignerAuthorizations.domainEpoch,
      namespace_access_revision:
        processorCryptoSignerAuthorizations.namespaceAccessRevision,
      policy_revision: processorCryptoSignerAuthorizations.policyRevision,
      processor_authorization_revision:
        processorCryptoSignerAuthorizations.processorAuthorizationRevision,
      credential_hash: processorCryptoSignerAuthorizations.credentialHash,
    }).from(processorCryptoSignerAuthorizations).where(eq(
      processorCryptoSignerAuthorizations.authorizationId,
      authorization.id,
    )).limit(2),
  );
  const evidence = oneOrNull(
    evidenceRows,
    "Processor signer authorization lookup",
  );
  if (evidence === null) {
    throw new Error("Processor signer authorization evidence is unavailable");
  }
  assertSignerEvidenceRow(
    crypto,
    evidence,
    authorization,
    bytes,
    authorizationHash,
  );
  const deviceRows = await executor.query(
    `SELECT device_id, human_id, signing_public_key, state, revision
       FROM human_crypto_devices
      WHERE device_id = $1
      LIMIT 2
      FOR SHARE`,
    [authorization.issuingDeviceId],
  );
  const device = oneOrNull(deviceRows, "Processor signer issuing device");
  if (
    device === null
    || rowString(device, "device_id") !== authorization.issuingDeviceId
    || rowString(device, "human_id") !== authorization.issuingHumanId
    || (rowString(device, "state") !== "active"
      && rowString(device, "state") !== "revoked")
    || rowCounter(device, "revision")
      < authorization.issuingDeviceAuthorizationRevision
  ) {
    throw new Error(
      "Processor signer authorization issuing device history is unavailable",
    );
  }
  const publicKey = rowBytes(device, "signing_public_key");
  const verified = verifyHistoricalProcessorSignerAuthorizationV1(crypto, {
    authorizationBytes: bytes,
    resolveHistoricalIssuingDevicePublicKey: (context) =>
      signerAuthorityContextMatches(context, authorization)
        ? publicKey
        : null,
  });
  if (!bytesEqual(verified.authorizationHash, authorizationHash)) {
    throw new Error("Processor signer authorization hash is inconsistent");
  }
  return Object.freeze({
    authorization,
    authorizationHash,
    authorizationBytes: bytes.slice(),
    issuerPublicKey: publicKey,
    requestId: rowString(evidence, "request_id"),
    recipientGeneration: rowCounter(evidence, "recipient_generation"),
  });
}

function validateExactOutput(
  crypto: LatticeCrypto,
  descriptor: BackgroundWorkDescriptorV1,
  authorization: ProcessorSignerAuthorizationV1,
  authorizationHash: Uint8Array,
  issuerPublicKey: Uint8Array,
  output: PublicationOutput,
  index: number,
): ExactOutput {
  const expectedObjectId = descriptor.outputObjectIds[index];
  const metadata = descriptor.outputObjectMetadata[index];
  if (
    expectedObjectId === undefined
    || metadata === undefined
    || output.objectId !== expectedObjectId
    || metadata.objectId !== expectedObjectId
  ) {
    throw new Error(
      "Processor transform outputs must be an ordered prefix of authorized slots",
    );
  }
  const outputAuthorization = decodeProcessorSignerAuthorizationV1(
    output.signerAuthorizationBytes,
  );
  if (
    outputAuthorization.id !== authorization.id
    || !bytesEqual(
      hash(crypto, output.signerAuthorizationBytes),
      authorizationHash,
    )
  ) {
    throw new Error(
      "Processor transform output signer authorization is substituted",
    );
  }
  const payload = decodeEncryptedPayloadV2(output.payloadBytes);
  const envelope = decodeNamespaceObjectEnvelopeV2(output.envelopeBytes);
  if (
    payload.context.objectId !== output.objectId
    || payload.context.keyClass !== "ai"
    || payload.context.objectType !== metadata.objectType
    || payload.context.createdAt !== metadata.createdAt
  ) {
    throw new Error(
      "Processor transform output payload does not match its descriptor",
    );
  }
  if (
    envelope.context.objectId !== output.objectId
    || envelope.context.namespaceId !== descriptor.namespaceId
    || envelope.context.keyClass !== "ai"
    || envelope.context.bindingRevisionAtWrap
      !== descriptor.expectedNamespaceAccessRevision
  ) {
    throw new Error(
      "Processor transform output envelope does not match its descriptor",
    );
  }
  const payloadHash = hash(crypto, output.payloadBytes);
  const envelopeHash = hash(crypto, output.envelopeBytes);
  const verified = verifyObjectAccessManifestV4(crypto, {
    manifestBytes: output.manifestBytes,
    resolveAgentRuntimeSignerPublicKey: () => null,
    resolveProcessorSignerAuthorizationBytes: (evidence) =>
      evidence.authorizationId === authorization.id
        && bytesEqual(evidence.authorizationHash, authorizationHash)
        ? output.signerAuthorizationBytes
        : null,
    resolveHistoricalIssuingDevicePublicKey: (context) =>
      signerAuthorityContextMatches(context, authorization)
        ? issuerPublicKey
        : null,
  });
  const manifest = verified.manifest;
  if (
    manifest.signer.kind !== "processor_invocation"
    || manifest.objectId !== output.objectId
    || manifest.accessRevision !== 0
    || manifest.previousManifestHash !== null
    || !bytesEqual(manifest.payloadHash, payloadHash)
    || manifest.envelopeHashes.length !== 1
    || !bytesEqual(manifest.envelopeHashes[0]!, envelopeHash)
    || manifest.hostAuthorizationRevision
      !== authorization.processorAuthorizationRevision
  ) {
    throw new Error(
      "Processor transform output manifest has conflicting coordinates",
    );
  }
  const verifiedTombstone = verifyObjectAccessManifestV4(crypto, {
    manifestBytes: output.tombstoneManifestBytes,
    resolveAgentRuntimeSignerPublicKey: () => null,
    resolveProcessorSignerAuthorizationBytes: (evidence) =>
      evidence.authorizationId === authorization.id
        && bytesEqual(evidence.authorizationHash, authorizationHash)
        ? output.signerAuthorizationBytes
        : null,
    resolveHistoricalIssuingDevicePublicKey: (context) =>
      signerAuthorityContextMatches(context, authorization)
        ? issuerPublicKey
        : null,
  });
  const tombstone = verifiedTombstone.manifest;
  if (
    tombstone.signer.kind !== "processor_invocation"
    || tombstone.objectId !== output.objectId
    || tombstone.accessRevision !== 1
    || tombstone.previousManifestHash === null
    || !bytesEqual(tombstone.previousManifestHash, verified.manifestHash)
    || !bytesEqual(tombstone.payloadHash, payloadHash)
    || tombstone.envelopeHashes.length !== 0
    || tombstone.hostAuthorizationRevision
      !== manifest.hostAuthorizationRevision
    || tombstone.signer.signerAuthorizationId
      !== manifest.signer.signerAuthorizationId
    || tombstone.signer.signerKeyId !== manifest.signer.signerKeyId
    || !bytesEqual(
      tombstone.signer.workDescriptorHash,
      manifest.signer.workDescriptorHash,
    )
    || tombstone.signerAuthorizationHash === null
    || manifest.signerAuthorizationHash === null
    || !bytesEqual(
      tombstone.signerAuthorizationHash,
      manifest.signerAuthorizationHash,
    )
  ) {
    throw new Error(
      "Processor transform output tombstone has conflicting coordinates",
    );
  }
  return Object.freeze({
    objectId: output.objectId,
    payloadBytes: output.payloadBytes,
    payloadHash,
    envelopeBytes: output.envelopeBytes,
    envelopeHash,
    namespaceId: descriptor.namespaceId,
    manifestBytes: output.manifestBytes,
    manifestHash: verified.manifestHash,
    tombstoneManifestBytes: output.tombstoneManifestBytes,
    tombstoneManifestHash: verifiedTombstone.manifestHash,
  });
}

export async function readExistingOutput(
  executor: CryptoPostgresExecutor,
  expected: ExactOutput | ExactNamespaceSetOutput,
): Promise<ExistingOutputState> {
  const expectedEnvelopes = namespaceSet(expected);
  const objectRows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      object_id: cryptoObjects.objectId,
      payload_hash: cryptoObjects.payloadHash,
      payload_bytes: cryptoObjects.payloadBytes,
    }).from(cryptoObjects).where(eq(cryptoObjects.objectId, expected.objectId))
      .limit(2),
  );
  const accessRows = await executor.query(
    `SELECT h.object_id, h.access_revision, h.manifest_hash,
            m.previous_manifest_hash, m.payload_hash, m.manifest_bytes
       FROM object_crypto_access_heads h
       JOIN object_crypto_access_manifests m
         ON m.object_id = h.object_id
        AND m.access_revision = h.access_revision
        AND m.manifest_hash = h.manifest_hash
      WHERE h.object_id = $1
      LIMIT 2
      FOR UPDATE OF h`,
    [expected.objectId],
  );
  const envelopeRows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
      ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes).where(and(
      eq(objectCryptoNamespaceEnvelopes.objectId, expected.objectId),
      eq(objectCryptoNamespaceEnvelopes.accessRevision, 0),
    )).orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal)).limit(expectedEnvelopes.length + 1),
  );
  const tombstoneRows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      object_id: objectCryptoAccessManifests.objectId,
      access_revision: objectCryptoAccessManifests.accessRevision,
      manifest_hash: objectCryptoAccessManifests.manifestHash,
      previous_manifest_hash: objectCryptoAccessManifests.previousManifestHash,
      payload_hash: objectCryptoAccessManifests.payloadHash,
      manifest_bytes: objectCryptoAccessManifests.manifestBytes,
    }).from(objectCryptoAccessManifests).where(and(
      eq(objectCryptoAccessManifests.objectId, expected.objectId),
      eq(objectCryptoAccessManifests.accessRevision, 1),
    )).limit(2),
  );
  const object = oneOrNull(objectRows, "Processor output object lookup");
  const access = oneOrNull(accessRows, "Processor output access lookup");
  const tombstone = oneOrNull(
    tombstoneRows,
    "Processor output tombstone lookup",
  );
  if (
    object === null
    && access === null
    && envelopeRows.length === 0
    && tombstone === null
  ) {
    return "absent";
  }
  if (
    object === null
    || access === null
    || envelopeRows.length !== expectedEnvelopes.length
    || tombstone === null
  ) {
    throw new Error(
      "Processor transform output has partial durable publication state",
    );
  }
  const exact = rowString(object, "object_id") === expected.objectId
    && bytesEqual(rowBytes(object, "payload_hash"), expected.payloadHash)
    && bytesEqual(rowBytes(object, "payload_bytes"), expected.payloadBytes)
    && rowString(access, "object_id") === expected.objectId
    && rowCounter(access, "access_revision") === 0
    && bytesEqual(rowBytes(access, "manifest_hash"), expected.manifestHash)
    && rowNullableBytes(access, "previous_manifest_hash") === null
    && bytesEqual(rowBytes(access, "payload_hash"), expected.payloadHash)
    && bytesEqual(
      rowBytes(access, "manifest_bytes"),
      expected.manifestBytes,
    )
    && envelopeRows.every((envelope, index) => {
      const intended = expectedEnvelopes[index]!;
      return rowString(envelope, "namespace_id") === intended.namespaceId
        && rowCounter(envelope, "ordinal") === index
        && bytesEqual(rowBytes(envelope, "envelope_hash"), intended.envelopeHash)
        && bytesEqual(rowBytes(envelope, "envelope_bytes"), intended.envelopeBytes);
    })
    && rowString(tombstone, "object_id") === expected.objectId
    && rowCounter(tombstone, "access_revision") === 1
    && bytesEqual(
      rowBytes(tombstone, "manifest_hash"),
      expected.tombstoneManifestHash,
    )
    && bytesEqual(
      rowBytes(tombstone, "previous_manifest_hash"),
      expected.manifestHash,
    )
    && bytesEqual(
      rowBytes(tombstone, "payload_hash"),
      expected.payloadHash,
    )
    && bytesEqual(
      rowBytes(tombstone, "manifest_bytes"),
      expected.tombstoneManifestBytes,
    );
  if (!exact) {
    throw new Error(
      "Processor transform output conflicts with durable publication state",
    );
  }
  return "exact";
}

export async function insertExactOutput(
  executor: CryptoPostgresExecutor,
  output: ExactOutput | ExactNamespaceSetOutput,
): Promise<void> {
  const envelopes = namespaceSet(output);
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(cryptoObjects).values({
      objectId: output.objectId,
      payloadHash: output.payloadHash,
      payloadBytes: output.payloadBytes,
    }),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoAccessManifests).values({
      objectId: output.objectId,
      accessRevision: 0,
      manifestHash: output.manifestHash,
      previousManifestHash: null,
      payloadHash: output.payloadHash,
      manifestBytes: output.manifestBytes,
    }),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoAccessManifests).values({
      objectId: output.objectId,
      accessRevision: 1,
      manifestHash: output.tombstoneManifestHash,
      previousManifestHash: output.manifestHash,
      payloadHash: output.payloadHash,
      manifestBytes: output.tombstoneManifestBytes,
    }),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values(envelopes.map((entry, ordinal) => ({
      objectId: output.objectId,
      accessRevision: 0,
      namespaceId: entry.namespaceId,
      ordinal,
      envelopeHash: entry.envelopeHash,
      envelopeBytes: entry.envelopeBytes,
    }))),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoAccessHeads).values({
      objectId: output.objectId,
      accessRevision: 0,
      manifestHash: output.manifestHash,
    }),
  );
}

export class PostgresProcessorTransformObjectPort
  implements ProcessorTransformObjectPort {
  readonly #handle: CryptoPostgresHandle;
  readonly #crypto: LatticeCrypto;
  readonly #verifyV5Input: VerifyProcessorTransformV5Input | undefined;
  readonly #resolveLiveShadowAgentSigner: ResolveLiveShadowAgentObjectSigner | undefined;

  constructor(input: Readonly<{
    readonly handle: CryptoPostgresHandle;
    readonly crypto: LatticeCrypto;
    readonly verifyV5Input?: VerifyProcessorTransformV5Input;
    readonly resolveLiveShadowAgentSigner?: ResolveLiveShadowAgentObjectSigner;
  }>) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    if (!(input.crypto instanceof LatticeCrypto)) {
      throw new TypeError(
        "Processor transform object port requires LatticeCrypto",
      );
    }
    this.#handle = input.handle;
    this.#crypto = input.crypto;
    this.#verifyV5Input = input.verifyV5Input;
    this.#resolveLiveShadowAgentSigner = input.resolveLiveShadowAgentSigner;
  }

  async loadNamespaceKeyring(input: Readonly<{
    readonly namespaceId: string;
    readonly signal: AbortSignal;
  }>) {
    aborted(input.signal);
    assertPortableId("Processor Namespace id", input.namespaceId);
    const rows = await executeTypedCryptoQuery(
      this.#handle,
      cryptoTypedDb.select({
        namespace_id: namespaceCryptoHeads.namespaceId,
        access_revision: namespaceCryptoHeads.accessRevision,
        binding_hash: namespaceCryptoHeads.bindingHash,
        domain_id: namespaceCryptoHeads.domainId,
        domain_epoch: namespaceCryptoHeads.domainEpoch,
        signed_binding_bytes: namespaceCryptoBindings.signedBindingBytes,
        human_keyring_envelope_bytes:
          namespaceCryptoBindings.humanKeyringEnvelopeBytes,
        ai_keyring_envelope_bytes:
          namespaceCryptoBindings.aiKeyringEnvelopeBytes,
      }).from(namespaceCryptoHeads).innerJoin(
        namespaceCryptoBindings,
        and(
          eq(
            namespaceCryptoBindings.namespaceId,
            namespaceCryptoHeads.namespaceId,
          ),
          eq(
            namespaceCryptoBindings.revision,
            namespaceCryptoHeads.accessRevision,
          ),
          eq(
            namespaceCryptoBindings.bindingHash,
            namespaceCryptoHeads.bindingHash,
          ),
        ),
      ).where(eq(namespaceCryptoHeads.namespaceId, input.namespaceId)).limit(2),
    );
    aborted(input.signal);
    const row = oneOrNull(rows, "Processor Namespace keyring lookup");
    if (row === null) {
      throw new Error("Processor Namespace keyring is unavailable");
    }
    const bindingBytes = rowBytes(row, "signed_binding_bytes");
    const binding = parseNamespaceBindingV2(bindingBytes);
    const human = parseNamespaceKeyringEnvelopeV2(
      rowBytes(row, "human_keyring_envelope_bytes"),
    );
    const ai = parseNamespaceKeyringEnvelopeV2(
      rowBytes(row, "ai_keyring_envelope_bytes"),
    );
    if (
      rowString(row, "namespace_id") !== input.namespaceId
      || binding.namespaceId !== input.namespaceId
      || rowCounter(row, "access_revision") !== binding.accessRevision
      || rowString(row, "domain_id") !== binding.domainId
      || rowCounter(row, "domain_epoch") !== binding.domainEpoch
      || !bytesEqual(rowBytes(row, "binding_hash"), hash(this.#crypto, bindingBytes))
      || !verifyBindingEnvelopePair(binding, human, ai)
    ) {
      throw new Error(
        "Processor Namespace head does not match its exact binding",
      );
    }
    return Object.freeze({ envelope: ai });
  }

  async openInput(input: Readonly<{
    readonly objectId: string;
    readonly signal: AbortSignal;
  }>) {
    aborted(input.signal);
    assertPortableId("Processor transform input object id", input.objectId);
    return this.#handle.transaction(async (transaction) => {
      aborted(input.signal);
      const objectRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          object_id: cryptoObjects.objectId,
          payload_hash: cryptoObjects.payloadHash,
          payload_bytes: cryptoObjects.payloadBytes,
        }).from(cryptoObjects).where(eq(cryptoObjects.objectId, input.objectId))
          .limit(2),
      );
      const accessRows = await transaction.query(
        `SELECT h.object_id, h.access_revision, h.manifest_hash,
                m.previous_manifest_hash, m.payload_hash, m.manifest_bytes
           FROM object_crypto_access_heads h
           JOIN object_crypto_access_manifests m
             ON m.object_id = h.object_id
            AND m.access_revision = h.access_revision
            AND m.manifest_hash = h.manifest_hash
          WHERE h.object_id = $1
          LIMIT 2
          FOR SHARE OF h`,
        [input.objectId],
      );
      const object = oneOrNull(objectRows, "Processor input object lookup");
      const access = oneOrNull(accessRows, "Processor input access lookup");
      if (object === null || access === null) {
        throw new ClassifiedDataOperationError("integrity", "Processor transform input object is unavailable");
      }
      const revision = rowCounter(access, "access_revision");
      const envelopeRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
          ordinal: objectCryptoNamespaceEnvelopes.ordinal,
          envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
          envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
        }).from(objectCryptoNamespaceEnvelopes).where(and(
          eq(objectCryptoNamespaceEnvelopes.objectId, input.objectId),
          eq(objectCryptoNamespaceEnvelopes.accessRevision, revision),
        )).orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal)).limit(2),
      );
      if (envelopeRows.length !== 1) {
        throw new ClassifiedDataOperationError("integrity",
          "Processor transform input requires one exact Namespace envelope",
        );
      }
      const payloadBytes = rowBytes(object, "payload_bytes");
      const manifestBytes = rowBytes(access, "manifest_bytes");
      const envelopeBytes = rowBytes(envelopeRows[0]!, "envelope_bytes");
      let decoded: ReturnType<typeof exactManifestForStoredBytes>;
      try {decoded = exactManifestForStoredBytes(manifestBytes);}
      catch (cause) {throw new ClassifiedDataOperationError("integrity", "Processor input manifest encoding is invalid", {cause});}
      const manifest = decoded.manifest;
      const payloadHash = hash(this.#crypto, payloadBytes);
      const envelopeHash = hash(this.#crypto, envelopeBytes);
      if (
        rowString(object, "object_id") !== input.objectId
        || !bytesEqual(rowBytes(object, "payload_hash"), payloadHash)
        || rowString(access, "object_id") !== input.objectId
        || manifest.objectId !== input.objectId
        || manifest.accessRevision !== revision
        || !bytesEqual(manifest.payloadHash, payloadHash)
        || !bytesEqual(
          rowBytes(access, "manifest_hash"),
          hash(this.#crypto, manifestBytes),
        )
        || !nullableBytesEqual(
          rowNullableBytes(access, "previous_manifest_hash"),
          manifest.previousManifestHash,
        )
        || !bytesEqual(rowBytes(access, "payload_hash"), payloadHash)
        || manifest.envelopeHashes.length !== 1
        || !bytesEqual(manifest.envelopeHashes[0]!, envelopeHash)
        || rowCounter(envelopeRows[0]!, "ordinal") !== 0
        || !bytesEqual(
          rowBytes(envelopeRows[0]!, "envelope_hash"),
          envelopeHash,
        )
      ) {
        throw new ClassifiedDataOperationError("integrity",
          "Processor transform input durable hashes or coordinates conflict",
        );
      }
      if (decoded.version === 5) {
        if (this.#verifyV5Input === undefined) throw new ClassifiedDataOperationError("unsupported", "Current V5 processor input verification is unavailable");
        const verified = await this.#verifyV5Input({executor: transaction, crypto: this.#crypto,
          objectId: input.objectId, headAccessRevision: revision, expectedPayloadHash: payloadHash,
          expectedHeadManifestHash: hash(this.#crypto, manifestBytes)});
        try {
          if (verified.objectId !== input.objectId || verified.headManifest.accessRevision !== revision
            || !bytesEqual(verified.payloadHash, payloadHash)
            || !bytesEqual(verified.headManifestBytes, manifestBytes)
            || !bytesEqual(verified.headManifestHash, hash(this.#crypto, manifestBytes))) {
            throw new ClassifiedDataOperationError("integrity", "Current V5 input verification returned a substituted head");
          }
        } finally {destroyVerifiedStoredObjectAccessManifestChainV5(verified);}
      } else if (decoded.version === 4) {
        if (decoded.manifest.signer.kind !== "processor_invocation") {
          throw new Error(
            "Processor transform Agent-signed v4 input is unsupported",
          );
        }
        const signerBytes = await this.#loadSignerAuthorizationBytes(transaction, decoded.manifest.signer.signerAuthorizationId);
        let signerVersion: ReturnType<typeof readProcessorSignerAuthorizationVersionV2>;
        try {signerVersion = readProcessorSignerAuthorizationVersionV2(signerBytes);}
        catch (cause) {throw new ClassifiedDataOperationError("integrity", "Stored processor signer format is invalid", {cause});}
        if (signerVersion === 2) {
          const current = await loadVerifiedCurrentProcessorSignerAuthorization(transaction, this.#crypto, signerBytes);
          try {
            try {
            verifyObjectAccessManifestV4(this.#crypto, {
              manifestBytes, resolveAgentRuntimeSignerPublicKey: () => null,
              resolveProcessorSignerAuthorizationBytes: (evidence) =>
                evidence.authorizationId === current.certificate.credentialId
                  && bytesEqual(evidence.authorizationHash, current.authorizationHash) ? current.authorizationBytes : null,
              resolveHistoricalIssuingDevicePublicKey: () => null,
              resolveHistoricalCurrentIssuer: () => current.issuerPublicKey,
            });
            } catch (cause) {throw new ClassifiedDataOperationError("integrity", "Current V4 input signature is invalid", {cause});}
          } finally {destroyVerifiedCurrentProcessorSignerEvidence(current);}
        } else {
        const verifiedAuthorization =
          await loadVerifiedProcessorSignerAuthorization(
          transaction,
          this.#crypto,
          signerBytes,
        );
        try {
        verifyObjectAccessManifestV4(this.#crypto, {
          manifestBytes,
          resolveAgentRuntimeSignerPublicKey: () => null,
          resolveProcessorSignerAuthorizationBytes: (evidence) =>
            evidence.authorizationId
                === verifiedAuthorization.authorization.id
              && bytesEqual(
                evidence.authorizationHash,
                verifiedAuthorization.authorizationHash,
              )
              ? verifiedAuthorization.authorizationBytes
              : null,
          resolveHistoricalIssuingDevicePublicKey: () =>
            verifiedAuthorization.issuerPublicKey,
        });
        } catch (cause) {throw new ClassifiedDataOperationError("integrity", "Historical V4 input signature is invalid", {cause});}
        }
      } else if (decoded.manifest.formatVersion === 2) {
        await loadHistoricalHumanManifestSigner(
          transaction,
          this.#crypto,
          decoded.manifest,
        );
      } else {
        const signer = decoded.manifest.signer;
        const foregroundKey = await this.#resolveLiveShadowAgentSigner?.(signer) ?? null;
        if (foregroundKey !== null) {
          try {
            verifyAgentObjectAccessManifest(this.#crypto, {manifestBytes,
              resolveSignerPublicKey: principal => principal.agentId === signer.agentId
                && principal.runtimeGeneration === signer.runtimeGeneration
                && principal.signerKeyId === signer.signerKeyId ? foregroundKey : null});
          } finally {foregroundKey.fill(0);}
        } else {
          await authenticateHistoricalAgentManifest(transaction, this.#crypto, decoded.manifest, manifestBytes);
        }
      }
      aborted(input.signal);
      let payload: ReturnType<typeof decodeEncryptedPayloadV2>;
      let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2>;
      try {
        payload = decodeEncryptedPayloadV2(payloadBytes);
        envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
      } catch (cause) {throw new ClassifiedDataOperationError("integrity", "Processor input payload or envelope encoding is invalid", {cause});}
      if (
        payload.context.objectId !== input.objectId
        || envelope.context.objectId !== input.objectId
        || envelope.context.namespaceId
          !== rowString(envelopeRows[0]!, "namespace_id")
      ) {
        throw new ClassifiedDataOperationError("integrity",
          "Processor transform input payload or envelope is substituted",
        );
      }
      return Object.freeze({ payload, envelope });
    });
  }

  async #loadSignerAuthorizationBytes(
    executor: CryptoPostgresExecutor,
    authorizationId: string,
  ): Promise<Uint8Array> {
    const rows = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        authorization_bytes:
          processorCryptoSignerAuthorizations.authorizationBytes,
      }).from(processorCryptoSignerAuthorizations).where(eq(
        processorCryptoSignerAuthorizations.authorizationId,
        authorizationId,
      )).limit(2),
    );
    const row = oneOrNull(rows, "Processor signer authorization bytes");
    if (row === null) {
      throw new ClassifiedDataOperationError("integrity", "Processor signer authorization evidence is unavailable");
    }
    return rowBytes(row, "authorization_bytes");
  }

  async publishOutputs(input: Parameters<
    ProcessorTransformObjectPort["publishOutputs"]
  >[0]): Promise<void> {
    aborted(input.signal);
    assertPortableId(
      "Processor transform idempotency id",
      input.idempotencyId,
    );
    assertPortableId("Processor transform claim id", input.claimId);
    if (
      !Array.isArray(input.outputs)
      || input.outputs.length > MAXIMUM_OUTPUTS
      || !Number.isSafeInteger(input.authorityCheckedAt)
      || input.authorityCheckedAt < 0
    ) {
      throw new TypeError("Processor transform publication input is invalid");
    }
    await this.#handle.transactionOnce(async (transaction) => {
      aborted(input.signal);
      await transaction.query(
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      );
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 241))`,
        [input.idempotencyId],
      );
      const requestRows = await transaction.query(
        `SELECT request_id, idempotency_key, work_id, namespace_id, domain_id,
                expected_domain_epoch, expected_namespace_access_revision,
                expected_policy_revision, processor_authorization_revision,
                credential_hash, descriptor_hash, descriptor_bytes, state,
                recipient_generation, claim_id, claim_expires_at,
                transform_commit_claim_id, transform_commit_descriptor_hash,
                transform_commit_recipient_generation,
                transform_commit_output_count, transform_committed_at
           FROM background_crypto_authorization_requests
          WHERE idempotency_key = $1
          LIMIT 2
          FOR UPDATE`,
        [input.idempotencyId],
      );
      const request = oneOrNull(
        requestRows,
        "Processor transform durable request lookup",
      );
      if (request === null) {
        throw new Error("Processor transform durable request is unavailable");
      }
      const descriptorBytes = rowBytes(request, "descriptor_bytes");
      const descriptor = decodeBackgroundWorkDescriptorV1(descriptorBytes);
      const descriptorHash = hash(this.#crypto, descriptorBytes);
      assertRequestCoordinates(
        request,
        descriptor,
        descriptorHash,
        input.idempotencyId,
        input.claimId,
      );
      const existingTransformCommit = assertExistingTransformCommit(
        request,
        descriptor,
        descriptorHash,
        input.claimId,
        input.outputs.length,
      );
      if (
        input.outputs.length > descriptor.outputObjectIds.length
        || input.outputs.some(
          (output, index) =>
            output.objectId !== descriptor.outputObjectIds[index],
        )
      ) {
        throw new Error(
          "Processor transform outputs must be an ordered prefix of authorized slots",
        );
      }
      const uniqueAuthorizationBytes = input.outputs[0]
        ?.signerAuthorizationBytes;
      if (
        uniqueAuthorizationBytes !== undefined
        && input.outputs.some(
          (output) =>
            !bytesEqual(
              output.signerAuthorizationBytes,
              uniqueAuthorizationBytes,
            ),
        )
      ) {
        throw new Error(
          "Processor transform outputs use different signer authorizations",
        );
      }
      let verifiedAuthorization:
        Awaited<
          ReturnType<typeof loadVerifiedProcessorSignerAuthorization>
        >
        | null = null;
      let issuerKey: Uint8Array | null = null;
      const exactOutputs: ExactOutput[] = [];
      if (uniqueAuthorizationBytes !== undefined) {
        verifiedAuthorization =
          await loadVerifiedProcessorSignerAuthorization(
          transaction,
          this.#crypto,
          uniqueAuthorizationBytes,
        );
        assertAuthorizationCoordinates(
          descriptor,
          descriptorHash,
          verifiedAuthorization.authorization,
          rowBytes(request, "credential_hash"),
        );
        if (
          verifiedAuthorization.requestId !== descriptor.requestId
          || verifiedAuthorization.recipientGeneration
            !== descriptor.recipientGeneration
        ) {
          throw new Error(
            "Processor signer authorization evidence does not match its recipient attempt",
          );
        }
        issuerKey = verifiedAuthorization.issuerPublicKey;
        exactOutputs.push(
          ...input.outputs.map((output, index) =>
            validateExactOutput(
              this.#crypto,
              descriptor,
              verifiedAuthorization!.authorization,
              verifiedAuthorization!.authorizationHash,
              issuerKey!,
              output,
              index,
            )
          ),
        );
      }
      const namespaceRows = await transaction.query(
        `SELECT namespace_id, access_revision, domain_id, domain_epoch
           FROM namespace_crypto_heads
          WHERE namespace_id = $1
          LIMIT 2
          FOR SHARE`,
        [descriptor.namespaceId],
      );
      const namespace = oneOrNull(
        namespaceRows,
        "Processor publication Namespace head",
      );
      if (
        namespace === null
        || rowString(namespace, "namespace_id") !== descriptor.namespaceId
        || rowCounter(namespace, "access_revision")
          !== descriptor.expectedNamespaceAccessRevision
        || rowString(namespace, "domain_id") !== descriptor.domainId
        || rowCounter(namespace, "domain_epoch")
          !== descriptor.expectedDomainEpoch
      ) {
        throw new Error(
          "Processor publication Namespace authority is stale",
        );
      }
      for (const outputObjectId of descriptor.outputObjectIds) {
        await transaction.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 242))`,
          [outputObjectId],
        );
      }
      const existing: ExistingOutputState[] = [];
      for (const output of exactOutputs) {
        existing.push(await readExistingOutput(transaction, output));
      }
      if (
        existing.some((state) => state === "absent")
        && existing.some((state) => state === "exact")
      ) {
        throw new Error(
          "Processor transform output has partial durable prefix state",
        );
      }
      for (
        const unusedObjectId of descriptor.outputObjectIds.slice(
          input.outputs.length,
        )
      ) {
        const rows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({ object_id: cryptoObjects.objectId })
            .from(cryptoObjects)
            .where(eq(cryptoObjects.objectId, unusedObjectId))
            .limit(2),
        );
        if (oneOrNull(rows, "Processor unused output lookup") !== null) {
          throw new Error(
            "Processor transform replay conflicts with a different durable output prefix",
          );
        }
      }
      aborted(input.signal);
      const committedAt = await input.authorizeCommit();
      if (
        !Number.isSafeInteger(committedAt)
        || committedAt < input.authorityCheckedAt
      ) {
        throw new Error(
          "Processor transform commit authorization is invalid or older than its audit check",
        );
      }
      if (committedAt >= rowInstant(request, "claim_expires_at")) {
        throw new Error(
          "Processor transform durable claim expired before commit",
        );
      }
      aborted(input.signal);
      if (!existing.every((state) => state === "exact")) {
        for (const output of exactOutputs) {
          aborted(input.signal);
          await insertExactOutput(transaction, output);
        }
      }
      if (existingTransformCommit === "absent") {
        const commitRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(backgroundCryptoAuthorizationRequests).set({
            transformCommitClaimId: input.claimId,
            transformCommitDescriptorHash: descriptorHash,
            transformCommitRecipientGeneration:
              descriptor.recipientGeneration,
            transformCommitOutputCount: input.outputs.length,
            transformCommittedAt: new Date(committedAt),
          }).where(and(
            eq(
              backgroundCryptoAuthorizationRequests.requestId,
              descriptor.requestId,
            ),
            eq(backgroundCryptoAuthorizationRequests.state, "running"),
            eq(backgroundCryptoAuthorizationRequests.claimId, input.claimId),
            eq(
              backgroundCryptoAuthorizationRequests.descriptorHash,
              descriptorHash,
            ),
            eq(
              backgroundCryptoAuthorizationRequests.recipientGeneration,
              descriptor.recipientGeneration,
            ),
            sql`${backgroundCryptoAuthorizationRequests.transformCommittedAt}
              is null`,
          )).returning({
            request_id: backgroundCryptoAuthorizationRequests.requestId,
          }),
        );
        if (
          oneOrNull(
            commitRows,
            "Processor transform durable commit marker",
          ) === null
        ) {
          throw new Error(
            "Processor transform durable commit marker was not stored",
          );
        }
      }
      aborted(input.signal);
    });
  }
}

export function createPostgresProcessorTransformObjectPort(
  input: Readonly<{
    readonly handle: CryptoPostgresHandle;
    readonly crypto: LatticeCrypto;
    readonly verifyV5Input?: VerifyProcessorTransformV5Input;
    readonly resolveLiveShadowAgentSigner?: ResolveLiveShadowAgentObjectSigner;
  }>,
): ProcessorTransformObjectPort {
  return new PostgresProcessorTransformObjectPort(input);
}
