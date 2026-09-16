import {
  agentCryptoRuntimeSigners,
  and,
  asc,
  cryptoDomains,
  cryptoObjects,
  eq,
  namespaceCryptoBindings,
  namespaceCryptoHeads,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
} from "@nautilo/db";
import type {
  AgentRuntimeSignerPublication,
  HistoricalCommitterResolver,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import type {
  MemoryNativeNamespaceAccessEntryV1,
} from "@nautilo/lattice-crypto/wire";
import {
  verifyCommonObjectAccessManifest,
  verifyNamespaceBinding,
} from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  parseNamespaceBindingV2,
  parseGrantV2,
} from "@nautilo/lattice-crypto/wire";

import {
  agentMemoryExactAccessRequestDigest,
  readPreparedAgentMemoryExactAccessSnapshot,
  type AgentMemoryExactAccessBindingFact,
  type AgentMemoryExactAccessCryptoCompletionPort,
  type AgentMemoryExactAccessCryptoObservation,
  type AgentMemoryExactAccessCryptoReceipt,
  type PreparedAgentMemoryExactAccess,
} from "../../memory/agent-memory-exact-access.ts";
import {
  type VerifiedAgentMemoryCryptoRevisionContent,
  type VerifiedAgentMemoryCryptoRevisionReader,
} from "../../memory/agent-memory-session-content.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  type AtomicMemoryCryptoCompletionPort,
  type MemoryCryptoRevisionReference,
  type PreparedMemoryCryptoRevision,
  type VerifiedMemoryCryptoRevision,
} from "../../memory/memory-repository.ts";
import {
  readPreparedMemoryCryptoRevisionSnapshot,
} from "../../memory/memory-prepared-revision.ts";
import {
  AgentRuntimeSignerHistoryInvalidError,
  authenticateHistoricalAgentRuntimeSignerPublication,
  type ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../storage/agent-runtime-signer-history.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
} from "../storage/postgres-record-codecs.ts";
import {
  verifyStoredObjectAccessManifestChainV5,
  type ResolveLiveShadowAgentObjectSigner,
} from "../storage/postgres-object-access-manifest-v5.ts";

const MAX_NAMESPACES = 256;
const MEMORY_OBJECT_ID = /^memory:v1:[0-9a-f]{64}$/;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function stringsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function oneOrNull(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} is not unique`);
  return rows[0] ?? null;
}

function rowString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new TypeError(`Memory crypto column ${field} must be text`);
  }
  return value;
}

function rowCounter(row: DatabaseRow, field: string): number {
  const value = row[field];
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
    throw new TypeError(`Memory crypto column ${field} must be a safe counter`);
  }
  return normalized;
}

function rowBoolean(row: DatabaseRow, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new TypeError(`Memory crypto column ${field} must be boolean`);
  }
  return value;
}

function rowBytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Memory crypto column ${field} must be bytea`);
  }
  return Uint8Array.from(value);
}

export class MemoryCryptoCompletionConflictError extends Error {
  readonly code = "memory_crypto_completion_conflict" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MemoryCryptoCompletionConflictError";
  }
}

function conflict(message: string, cause?: unknown): never {
  throw new MemoryCryptoCompletionConflictError(message, cause);
}

type ExactEnvelope = Readonly<{
  namespaceId: string;
  keyGeneration: number;
  bindingRevisionAtWrap: number;
  envelopeHash: Uint8Array;
  envelopeBytes: Uint8Array;
}>;

type MemoryPublicationBytes = Readonly<{
  objectId: string;
  payloadBytes: Uint8Array;
  payloadHash: Uint8Array;
  genesisManifestBytes: Uint8Array;
  genesisManifestHash: Uint8Array;
  envelopes: readonly ExactEnvelope[];
  requiredNamespaceIds: readonly string[];
}>;

type ExactMemoryPublication = MemoryPublicationBytes & Readonly<{
  memoryId: string;
  contentRevision: number;
  authority: ReturnType<
    typeof readPreparedMemoryCryptoRevisionSnapshot
  >["access"]["authority"];
}>;

type DurableMemoryPublication = Readonly<{
  objectId: string;
  payloadBytes: Uint8Array;
  payloadHash: Uint8Array;
  genesisManifestBytes: Uint8Array;
  genesisManifestHash: Uint8Array;
  genesisEnvelopes: readonly ExactEnvelope[];
  genesisRequiredNamespaceIds: readonly string[];
  accessRevision: number;
  accessManifestBytes: Uint8Array;
  accessManifestHash: Uint8Array;
  envelopes: readonly ExactEnvelope[];
  requiredNamespaceIds: readonly string[];
  signerPublicKey: Uint8Array;
  signerAuthorizationBytes?: Uint8Array;
  signerIssuingPublicKey?: Uint8Array;
  signerEvidence: readonly Readonly<{
    kind: "agent_runtime_publication" | "processor_authorization";
    evidenceBytes: Uint8Array;
  }>[];
}>;

function wipeDurableMemoryPublication(
  durable: DurableMemoryPublication,
): void {
  durable.payloadBytes.fill(0);
  durable.payloadHash.fill(0);
  durable.genesisManifestBytes.fill(0);
  durable.genesisManifestHash.fill(0);
  durable.genesisEnvelopes.forEach((entry) => {
    entry.envelopeHash.fill(0);
    entry.envelopeBytes.fill(0);
  });
  durable.accessManifestBytes.fill(0);
  durable.accessManifestHash.fill(0);
  durable.envelopes.forEach((entry) => {
    entry.envelopeHash.fill(0);
    entry.envelopeBytes.fill(0);
  });
  durable.signerPublicKey.fill(0);
  durable.signerAuthorizationBytes?.fill(0);
  durable.signerIssuingPublicKey?.fill(0);
  durable.signerEvidence.forEach((entry) => entry.evidenceBytes.fill(0));
}

function exactPreparedPublication(
  crypto: LatticeCrypto,
  revision: PreparedMemoryCryptoRevision,
): ExactMemoryPublication {
  const snapshot = readPreparedMemoryCryptoRevisionSnapshot(revision);
  const payloadBytes = snapshot.object.payloadBytes.ciphertext.slice();
  const payload = decodeEncryptedPayloadV2(payloadBytes);
  const payloadHash = crypto.hash(payloadBytes);
  const genesis = decodeObjectAccessManifestV5(
    snapshot.access.manifestBytes,
  );
  const envelopes = snapshot.access.envelopeBytes.map((envelopeBytes) => {
    const bytes = envelopeBytes.slice();
    const decoded = decodeNamespaceObjectEnvelopeV2(bytes);
    return Object.freeze({
      namespaceId: decoded.context.namespaceId,
      keyGeneration: decoded.context.keyGeneration,
      bindingRevisionAtWrap: decoded.context.bindingRevisionAtWrap,
      envelopeHash: crypto.hash(bytes),
      envelopeBytes: bytes,
    });
  });
  const namespaceIds = envelopes.map((entry) => entry.namespaceId).sort();
  const requiredNamespaceIds = [...snapshot.requiredNamespaceIds];
  const authorityNamespaceIds = snapshot.access.authority.namespaceRequirements
    .map((entry) => entry.namespaceId);
  const bindingNamespaceIds = snapshot.access.authority.namespaceBindings
    .map((entry) => entry.namespaceId);
  const authorityEnvelopeIds = snapshot.access.authority.envelopes
    .map((entry) => entry.namespaceId);
  const envelopeByNamespace = new Map<string, ExactEnvelope>(
    envelopes.map((entry) => [entry.namespaceId, entry]),
  );
  const requirementsByNamespace = new Map<string, typeof snapshot.access.authority.namespaceRequirements[number]>(
    snapshot.access.authority.namespaceRequirements.map((entry) => [
      entry.namespaceId,
      entry,
    ]),
  );
  const domainIds = [...new Set(
    snapshot.access.authority.namespaceRequirements.map((entry) => entry.domainId),
  )].sort();
  if (
    revision.objectId !== snapshot.objectId
    || revision.objectId !== snapshot.object.objectId
    || revision.objectId !== deriveMemoryCryptoObjectIdV1(revision)
    || payload.context.objectId !== revision.objectId
    || payload.context.objectType !== MEMORY_OBJECT_TYPE
    || payload.context.keyClass !== "ai"
    || genesis.objectId !== revision.objectId
    || genesis.accessRevision !== 0
    || genesis.previousManifestHash !== null
    || !bytesEqual(genesis.payloadHash, payloadHash)
    || genesis.envelopeHashes.length !== envelopes.length
    || genesis.envelopeHashes.some((hash, index) =>
      !bytesEqual(hash, envelopes[index]!.envelopeHash)
    )
    || snapshot.access.authority.purpose
      !== "persist-agent-object-access-genesis-set"
    || snapshot.access.authority.objectId !== revision.objectId
    || !bytesEqual(snapshot.access.authority.payloadHash, payloadHash)
    || genesis.signer.kind !== "agent_runtime"
    || snapshot.access.authority.agentId !== genesis.signer.agentId
    || snapshot.access.authority.runtimeGeneration
      !== genesis.signer.runtimeGeneration
    || snapshot.access.authority.signerKeyId !== genesis.signer.signerKeyId
    || snapshot.access.authority.agentAuthorizationRevision
      !== genesis.hostAuthorizationRevision
    || !bytesEqual(crypto.hash(snapshot.access.manifestBytes), snapshot.access.manifestHash)
    || !stringsEqual(namespaceIds, requiredNamespaceIds)
    || !stringsEqual(authorityNamespaceIds, requiredNamespaceIds)
    || !stringsEqual(bindingNamespaceIds, requiredNamespaceIds)
    || !stringsEqual(authorityEnvelopeIds, requiredNamespaceIds)
    || new Set(requiredNamespaceIds).size !== requiredNamespaceIds.length
    || requiredNamespaceIds.length < 1
    || requiredNamespaceIds.length > MAX_NAMESPACES
    || snapshot.access.authority.envelopes.some((entry) => {
      const envelope = envelopeByNamespace.get(entry.namespaceId);
      const requirement = requirementsByNamespace.get(entry.namespaceId);
      return envelope === undefined
        || requirement === undefined
        || entry.objectId !== revision.objectId
        || entry.keyClass !== "ai"
        || entry.keyGeneration !== envelope.keyGeneration
        || entry.bindingRevisionAtWrap !== envelope.bindingRevisionAtWrap
        || requirement.expectedAccessRevision
          !== envelope.bindingRevisionAtWrap
        || !bytesEqual(envelope.envelopeHash, entry.envelopeHash);
    })
    || snapshot.access.authority.namespaceBindings.some((binding) => {
      const requirement = requirementsByNamespace.get(binding.namespaceId);
      return requirement === undefined
        || !requirement.operations.includes("encrypt")
        || binding.domainId !== requirement.domainId
        || binding.expectedAccessRevision
          !== requirement.expectedAccessRevision
        || binding.expectedPolicyRevision
          !== requirement.expectedPolicyRevision;
    })
    || !stringsEqual(
      domainIds,
      snapshot.access.authority.domainRequirements
        .map((entry) => entry.domainId),
    )
  ) {
    conflict("Prepared Memory crypto publication is internally inconsistent");
  }
  return Object.freeze({
    memoryId: revision.memoryId,
    contentRevision: revision.contentRevision,
    objectId: revision.objectId,
    payloadBytes,
    payloadHash,
    genesisManifestBytes: snapshot.access.manifestBytes.slice(),
    genesisManifestHash: snapshot.access.manifestHash.slice(),
    envelopes: Object.freeze(envelopes),
    requiredNamespaceIds: Object.freeze(requiredNamespaceIds),
    authority: snapshot.access.authority,
  });
}

function publicationFromRow(row: DatabaseRow): AgentRuntimeSignerPublication {
  const publication = decodeAgentRuntimeSignerPublicationV1(
    rowBytes(row, "publication_bytes"),
  );
  if (
    publication.agentId !== rowString(row, "agent_id")
    || publication.runtimeGeneration !== rowCounter(row, "runtime_generation")
    || publication.authorizationRevision
      !== rowCounter(row, "authorization_revision")
    || publication.transitionKind !== rowString(row, "transition_kind")
    || publication.operationId !== rowString(row, "operation_id")
    || publication.signerKeyId !== rowString(row, "signer_key_id")
    || !bytesEqual(
      publication.signerPublicKey,
      rowBytes(row, "signer_public_key"),
    )
  ) {
    throw new AgentRuntimeSignerHistoryInvalidError(
      "Agent Runtime signer publication columns conflict",
    );
  }
  return publication;
}

async function readHistoricalPublication(input: Readonly<{
  executor: CryptoPostgresExecutor;
  crypto: LatticeCrypto;
  agentId: string;
  runtimeGeneration: number;
  signerKeyId: string;
  resolveHistoricalAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
}>): Promise<AgentRuntimeSignerPublication> {
  const rows = await executeTypedCryptoQuery(
    input.executor,
    cryptoTypedDb.select({
      agent_id: agentCryptoRuntimeSigners.agentId,
      runtime_generation: agentCryptoRuntimeSigners.runtimeGeneration,
      authorization_revision: agentCryptoRuntimeSigners.authorizationRevision,
      transition_kind: agentCryptoRuntimeSigners.transitionKind,
      operation_id: agentCryptoRuntimeSigners.operationId,
      signer_key_id: agentCryptoRuntimeSigners.signerKeyId,
      signer_public_key: agentCryptoRuntimeSigners.signerPublicKey,
      publication_bytes: agentCryptoRuntimeSigners.publicationBytes,
    }).from(agentCryptoRuntimeSigners)
      .where(and(
        eq(agentCryptoRuntimeSigners.agentId, input.agentId),
        eq(
          agentCryptoRuntimeSigners.runtimeGeneration,
          input.runtimeGeneration,
        ),
      ))
      .limit(2),
  );
  const row = oneOrNull(rows, "Memory Agent Runtime signer publication");
  if (row === null) {
    throw new AgentRuntimeSignerHistoryInvalidError(
      "Memory Agent Runtime signer publication history is missing",
    );
  }
  const publication = publicationFromRow(row);
  const authenticated = await authenticateHistoricalAgentRuntimeSignerPublication({
    crypto: input.crypto,
    publication,
    resolveHistoricalManagerAuthority: input.resolveHistoricalAuthority,
  });
  if (
    authenticated.agentId !== input.agentId
    || authenticated.runtimeGeneration !== input.runtimeGeneration
    || authenticated.signerKeyId !== input.signerKeyId
  ) {
    throw new AgentRuntimeSignerHistoryInvalidError(
      "Memory manifest signer conflicts with authenticated Runtime history",
    );
  }
  return authenticated;
}

function authenticateAccessManifest(
  crypto: LatticeCrypto,
  publication: AgentRuntimeSignerPublication,
  publicationState: Readonly<{
    manifestBytes: Uint8Array;
    manifestHash: Uint8Array;
  }>,
): void {
  const resolve = (principal: Readonly<{
    agentId: string;
    runtimeGeneration: number;
    signerKeyId: string;
  }>) =>
    principal.agentId === publication.agentId
        && principal.runtimeGeneration === publication.runtimeGeneration
        && principal.signerKeyId === publication.signerKeyId
      ? publication.signerPublicKey
      : null;
  const genesis = verifyCommonObjectAccessManifest(crypto, {
    manifestBytes: publicationState.manifestBytes,
    resolveHistoricalHumanDeviceSigningPublicKey: () => null,
    resolveAgentRuntimeSignerPublicKey: resolve,
    resolveProcessorSignerAuthorizationBytes: () => null,
    resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
  });
  if (!bytesEqual(
    genesis.manifestHash,
    publicationState.manifestHash,
  )) {
    conflict("Memory access manifest hashes conflict with authenticated bytes");
  }
}

function decodeEnvelopeInventory(input: Readonly<{
  crypto: LatticeCrypto;
  objectId: string;
  manifest: ReturnType<typeof decodeObjectAccessManifestV5>;
  rows: readonly DatabaseRow[];
}>): readonly ExactEnvelope[] {
  if (input.rows.length > MAX_NAMESPACES) {
    conflict("Memory crypto Namespace envelope inventory is unbounded");
  }
  return Object.freeze(input.rows.map((row, ordinal) => {
    const envelopeBytes = rowBytes(row, "envelope_bytes");
    const decoded = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    const envelopeHash = input.crypto.hash(envelopeBytes);
    if (
      rowCounter(row, "ordinal") !== ordinal
      || decoded.context.objectId !== input.objectId
      || decoded.context.namespaceId !== rowString(row, "namespace_id")
      || decoded.context.keyClass !== "ai"
      || !bytesEqual(envelopeHash, rowBytes(row, "envelope_hash"))
      || !bytesEqual(envelopeHash, input.manifest.envelopeHashes[ordinal]!)
    ) conflict("Memory crypto Namespace envelope inventory conflicts");
    return Object.freeze({
      namespaceId: decoded.context.namespaceId,
      keyGeneration: decoded.context.keyGeneration,
      bindingRevisionAtWrap: decoded.context.bindingRevisionAtWrap,
      envelopeHash,
      envelopeBytes,
    });
  }));
}

async function readDurablePublication(input: Readonly<{
  executor: CryptoPostgresExecutor;
  crypto: LatticeCrypto;
  objectId: string;
  resolveHistoricalAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  resolveLiveShadowAgentSigner?: ResolveLiveShadowAgentObjectSigner | undefined;
  expectedObjectType?: string;
}>): Promise<DurableMemoryPublication | "absent"> {
  const [objectRows, headRows] = await Promise.all([
      executeTypedCryptoQuery(
        input.executor,
        cryptoTypedDb.select({
          object_id: cryptoObjects.objectId,
          payload_hash: cryptoObjects.payloadHash,
          payload_bytes: cryptoObjects.payloadBytes,
        }).from(cryptoObjects)
          .where(eq(cryptoObjects.objectId, input.objectId))
          .limit(2),
      ),
      executeTypedCryptoQuery(
        input.executor,
        cryptoTypedDb.select({
          object_id: objectCryptoAccessHeads.objectId,
          access_revision: objectCryptoAccessHeads.accessRevision,
          manifest_hash: objectCryptoAccessHeads.manifestHash,
        }).from(objectCryptoAccessHeads)
          .where(eq(objectCryptoAccessHeads.objectId, input.objectId))
          .limit(2)
          .for("update"),
      ),
    ]);
  const object = oneOrNull(objectRows, "Memory crypto object");
  const head = oneOrNull(headRows, "Memory crypto access head");
  if (object === null && head === null) return "absent";
  if (object === null || head === null) {
    conflict("Memory crypto publication has partial durable state");
  }
  const headRevision = rowCounter(head, "access_revision");
  const [manifestRows, envelopeRows, genesisRows, genesisEnvelopeRows] =
    await Promise.all([
    executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        object_id: objectCryptoAccessManifests.objectId,
        access_revision: objectCryptoAccessManifests.accessRevision,
        manifest_hash: objectCryptoAccessManifests.manifestHash,
        previous_manifest_hash:
          objectCryptoAccessManifests.previousManifestHash,
        payload_hash: objectCryptoAccessManifests.payloadHash,
        manifest_bytes: objectCryptoAccessManifests.manifestBytes,
      }).from(objectCryptoAccessManifests)
        .where(and(
          eq(objectCryptoAccessManifests.objectId, input.objectId),
          eq(objectCryptoAccessManifests.accessRevision, headRevision),
        ))
        .limit(2),
    ),
    executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
        ordinal: objectCryptoNamespaceEnvelopes.ordinal,
        envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
        envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
      }).from(objectCryptoNamespaceEnvelopes)
        .where(and(
          eq(objectCryptoNamespaceEnvelopes.objectId, input.objectId),
          eq(objectCryptoNamespaceEnvelopes.accessRevision, headRevision),
        ))
        .orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal))
        .limit(257),
    ),
    executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        object_id: objectCryptoAccessManifests.objectId,
        access_revision: objectCryptoAccessManifests.accessRevision,
        manifest_hash: objectCryptoAccessManifests.manifestHash,
        previous_manifest_hash:
          objectCryptoAccessManifests.previousManifestHash,
        payload_hash: objectCryptoAccessManifests.payloadHash,
        manifest_bytes: objectCryptoAccessManifests.manifestBytes,
      }).from(objectCryptoAccessManifests)
        .where(and(
          eq(objectCryptoAccessManifests.objectId, input.objectId),
          eq(objectCryptoAccessManifests.accessRevision, 0),
        ))
        .limit(2),
    ),
    executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
        ordinal: objectCryptoNamespaceEnvelopes.ordinal,
        envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
        envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
      }).from(objectCryptoNamespaceEnvelopes)
        .where(and(
          eq(objectCryptoNamespaceEnvelopes.objectId, input.objectId),
          eq(objectCryptoNamespaceEnvelopes.accessRevision, 0),
        ))
        .orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal))
        .limit(257),
    ),
  ]);
  const manifestRow = oneOrNull(manifestRows, "Memory crypto access manifest");
  const genesisRow = oneOrNull(genesisRows, "Memory crypto genesis manifest");
  if (
    manifestRow === null
    || genesisRow === null
    || envelopeRows.length > MAX_NAMESPACES
    || genesisEnvelopeRows.length < 1
    || genesisEnvelopeRows.length > MAX_NAMESPACES
  ) conflict("Memory crypto publication has partial durable access state");
  const payloadBytes = rowBytes(object, "payload_bytes");
  const payloadHash = input.crypto.hash(payloadBytes);
  const accessManifestBytes = rowBytes(manifestRow, "manifest_bytes");
  const accessManifestHash = rowBytes(manifestRow, "manifest_hash");
  const manifest = decodeObjectAccessManifestV5(accessManifestBytes);
  const envelopes = decodeEnvelopeInventory({
    crypto: input.crypto,
    objectId: input.objectId,
    manifest,
    rows: envelopeRows,
  });
  const genesisManifestBytes = rowBytes(genesisRow, "manifest_bytes");
  const genesisManifestHash = rowBytes(genesisRow, "manifest_hash");
  const genesis = decodeObjectAccessManifestV5(genesisManifestBytes);
  const genesisEnvelopes = decodeEnvelopeInventory({
    crypto: input.crypto,
    objectId: input.objectId,
    manifest: genesis,
    rows: genesisEnvelopeRows,
  });
  const requiredNamespaceIds = envelopes.map((entry) => entry.namespaceId)
    .sort();
  const genesisRequiredNamespaceIds = genesisEnvelopes
    .map((entry) => entry.namespaceId).sort();
  const headHash = rowBytes(head, "manifest_hash");
  const verifiedChain = await verifyStoredObjectAccessManifestChainV5({
    executor: input.executor,
    crypto: input.crypto,
    objectId: input.objectId,
    headAccessRevision: headRevision,
    expectedPayloadHash: payloadHash,
    expectedHeadManifestHash: headHash,
    resolveHistoricalAgentManagerAuthority:
      input.resolveHistoricalAuthority,
    resolveLiveShadowAgentSigner: input.resolveLiveShadowAgentSigner,
  });
  if (
    rowString(object, "object_id") !== input.objectId
    || !bytesEqual(rowBytes(object, "payload_hash"), payloadHash)
    || rowString(head, "object_id") !== input.objectId
    || rowString(manifestRow, "object_id") !== input.objectId
    || rowCounter(manifestRow, "access_revision") !== headRevision
    || !bytesEqual(rowBytes(manifestRow, "payload_hash"), payloadHash)
    || !bytesEqual(input.crypto.hash(accessManifestBytes), accessManifestHash)
    || !bytesEqual(headHash, accessManifestHash)
    || manifest.objectId !== input.objectId
    || manifest.accessRevision !== headRevision
    || (headRevision === 0) !== (manifest.previousManifestHash === null)
    || !bytesEqual(manifest.payloadHash, payloadHash)
    || manifest.envelopeHashes.length !== envelopes.length
    || new Set(requiredNamespaceIds).size !== requiredNamespaceIds.length
    || rowString(genesisRow, "object_id") !== input.objectId
    || rowCounter(genesisRow, "access_revision") !== 0
    || genesis.previousManifestHash !== null
    || !bytesEqual(rowBytes(genesisRow, "payload_hash"), payloadHash)
    || !bytesEqual(input.crypto.hash(genesisManifestBytes), genesisManifestHash)
    || genesis.objectId !== input.objectId
    || genesis.accessRevision !== 0
    || !bytesEqual(genesis.payloadHash, payloadHash)
    || genesis.envelopeHashes.length !== genesisEnvelopes.length
    || new Set(genesisRequiredNamespaceIds).size
      !== genesisRequiredNamespaceIds.length
  ) conflict("Memory crypto durable publication coordinates conflict");
  const payload = decodeEncryptedPayloadV2(payloadBytes);
  if (
    payload.context.objectId !== input.objectId
    || payload.context.objectType
      !== (input.expectedObjectType ?? MEMORY_OBJECT_TYPE)
    || payload.context.keyClass !== "ai"
  ) conflict("Memory crypto durable payload coordinates conflict");
  return Object.freeze({
    objectId: input.objectId,
    payloadBytes,
    payloadHash,
    genesisManifestBytes,
    genesisManifestHash,
    genesisEnvelopes,
    genesisRequiredNamespaceIds: Object.freeze(genesisRequiredNamespaceIds),
    envelopes: Object.freeze(envelopes),
    requiredNamespaceIds: Object.freeze(requiredNamespaceIds),
    accessRevision: headRevision,
    accessManifestBytes,
    accessManifestHash,
    signerPublicKey: verifiedChain.headSignerPublicKey,
    ...(verifiedChain.headSignerAuthorizationBytes === undefined ? {} : {
      signerAuthorizationBytes:
        verifiedChain.headSignerAuthorizationBytes,
    }),
    ...(verifiedChain.headSignerIssuingPublicKey === undefined ? {} : {
      signerIssuingPublicKey: verifiedChain.headSignerIssuingPublicKey,
    }),
    signerEvidence: verifiedChain.signerEvidence,
  });
}

export type VerifiedDeviceWrappedAgentObject = Readonly<{
  objectId: string;
  accessRevision: number;
  payloadBytes: Uint8Array;
  payloadHash: Uint8Array;
  accessManifestBytes: Uint8Array;
  accessManifestHash: Uint8Array;
  nativeEntries?: readonly MemoryNativeNamespaceAccessEntryV1[];
  namespaceEnvelopes: readonly Readonly<{
    namespaceId: string;
    keyGeneration: number;
    bindingRevisionAtWrap: number;
    envelopeBytes: Uint8Array;
  }>[];
}>;

/** Authenticate a generic common-v5 Runtime object before returning bytes. */
export async function readVerifiedDeviceWrappedAgentObject(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  objectId: string;
  expectedObjectType: string;
  expectedAccessRevision?: number;
  expectedNamespaceIds: readonly string[];
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  resolveLiveShadowAgentSigner?: ResolveLiveShadowAgentObjectSigner | undefined;
  resolveNativeNamespaceEntries?: ((input: readonly Readonly<{
    namespaceId: string;
    generation: number;
    accessRevision: number;
    envelopeHash: Uint8Array;
  }>[]) => Promise<readonly MemoryNativeNamespaceAccessEntryV1[] | null>) | undefined;
}>): Promise<VerifiedDeviceWrappedAgentObject | null> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  return withVerifiedCryptoPostgresTransaction(input.handle, async (executor) => {
    const durable = await readDurablePublication({
      executor,
      crypto: input.crypto,
      objectId: input.objectId,
      expectedObjectType: input.expectedObjectType,
      resolveHistoricalAuthority: input.resolveHistoricalAgentSignerAuthority,
      resolveLiveShadowAgentSigner: input.resolveLiveShadowAgentSigner,
    });
    if (durable === "absent") return null;
    try {
      if (
        (input.expectedAccessRevision !== undefined
          && durable.accessRevision !== input.expectedAccessRevision)
        || !stringsEqual(
          durable.requiredNamespaceIds,
          [...input.expectedNamespaceIds].sort(),
        )
      ) return null;
      const coordinates = durable.envelopes.map((entry) => Object.freeze({
        namespaceId: entry.namespaceId,
        generation: entry.keyGeneration,
        accessRevision: entry.bindingRevisionAtWrap,
        envelopeHash: entry.envelopeHash.slice(),
      }));
      const nativeResolver = input.resolveNativeNamespaceEntries;
      const nativeEntries = nativeResolver === undefined
        ? undefined
        : await nativeResolver(coordinates);
      if (nativeResolver !== undefined) {
        if (nativeEntries === null || nativeEntries === undefined
          || nativeEntries.length !== coordinates.length
          || nativeEntries.some((entry, index) => {
          const coordinate = coordinates[index]!;
          return entry.namespaceId !== coordinate.namespaceId
            || entry.keyGeneration !== coordinate.generation
            || entry.namespaceAccessRevision !== coordinate.accessRevision
            || !bytesEqual(entry.envelopeHash, coordinate.envelopeHash);
          })) return null;
      }
      const verifiedNativeEntries = nativeEntries ?? undefined;
      return Object.freeze({
        objectId: durable.objectId,
        accessRevision: durable.accessRevision,
        payloadBytes: durable.payloadBytes.slice(),
        payloadHash: durable.payloadHash.slice(),
        accessManifestBytes: durable.accessManifestBytes.slice(),
        accessManifestHash: durable.accessManifestHash.slice(),
        ...(verifiedNativeEntries === undefined ? {} : {
          nativeEntries: Object.freeze(verifiedNativeEntries),
        }),
        namespaceEnvelopes: Object.freeze(durable.envelopes.map((entry) =>
          Object.freeze({
            namespaceId: entry.namespaceId,
            keyGeneration: entry.keyGeneration,
            bindingRevisionAtWrap: entry.bindingRevisionAtWrap,
            envelopeBytes: entry.envelopeBytes.slice(),
          })
        )),
      });
    } finally {
      wipeDurableMemoryPublication(durable);
    }
  });
}

function durableMatchesExpected(
  durable: DurableMemoryPublication,
  expected: ExactMemoryPublication,
): boolean {
  return durable.accessRevision === 0
    && durable.objectId === expected.objectId
    && bytesEqual(durable.payloadBytes, expected.payloadBytes)
    && bytesEqual(durable.payloadHash, expected.payloadHash)
    && bytesEqual(
      durable.genesisManifestBytes,
      expected.genesisManifestBytes,
    )
    && bytesEqual(
      durable.genesisManifestHash,
      expected.genesisManifestHash,
    )
    && stringsEqual(
      durable.genesisRequiredNamespaceIds,
      expected.requiredNamespaceIds,
    )
    && durable.genesisEnvelopes.length === expected.envelopes.length
    && durable.genesisEnvelopes.every((envelope, index) => {
      const intended = expected.envelopes[index]!;
      return envelope.namespaceId === intended.namespaceId
        && envelope.keyGeneration === intended.keyGeneration
        && envelope.bindingRevisionAtWrap === intended.bindingRevisionAtWrap
        && bytesEqual(envelope.envelopeHash, intended.envelopeHash)
        && bytesEqual(envelope.envelopeBytes, intended.envelopeBytes);
    });
}

async function assertCurrentAuthority(
  executor: CryptoPostgresExecutor,
  crypto: LatticeCrypto,
  expected: ExactMemoryPublication,
): Promise<void> {
  const authority = expected.authority;
  const requiredNamespaceIds: readonly string[] = expected.requiredNamespaceIds;
  const requiredDomainIds: readonly string[] = authority.domainRequirements.map(
    (entry) => entry.domainId,
  );
  const [grantRows, namespaceRows, domainRows, runtimeRows] = await Promise.all([
    executor.query(
      `SELECT grant_id, grant_bytes, consumed
         FROM crypto_grants
        WHERE grant_id = $1
        LIMIT 2
        FOR SHARE`,
      [authority.grantId],
    ),
    executor.query(
      `SELECT namespace_id, access_revision, binding_hash,
              domain_id, domain_epoch, writes_paused
         FROM namespace_crypto_heads
        WHERE namespace_id = ANY($1::text[])
        ORDER BY namespace_id
        LIMIT 257
        FOR SHARE`,
      [requiredNamespaceIds],
    ),
    executor.query(
      `SELECT id, epoch
         FROM crypto_domains
        WHERE id = ANY($1::text[])
        ORDER BY id
        LIMIT 257
        FOR SHARE`,
      [requiredDomainIds],
    ),
    executor.query(
      `SELECT agent_id, authorization_revision, runtime_generation
         FROM agent_crypto_runtime_states
        WHERE agent_id = $1
        LIMIT 2
        FOR SHARE`,
      [authority.agentId],
    ),
  ]);
  const grantRow = oneOrNull(grantRows, "Memory current Grant");
  const runtimeRow = oneOrNull(runtimeRows, "Memory current Agent Runtime");
  if (grantRow === null || runtimeRow === null) {
    conflict("Memory crypto current Grant or Runtime authority is missing");
  }
  const grantBytes = rowBytes(grantRow, "grant_bytes");
  const grant = parseGrantV2(grantBytes);
  const domainsById = new Map(
    authority.domainRequirements.map((entry) => [entry.domainId, entry] as const),
  );
  if (
    grant === null
    || rowString(grantRow, "grant_id") !== authority.grantId
    || grant.id !== authority.grantId
    || !bytesEqual(crypto.hash(grantBytes), authority.grantHash)
    || grant.recipientAgentId !== authority.agentId
    || !stringsEqual(grant.scope, authority.grantScope)
    || !stringsEqual(grant.operations, authority.grantOperations)
    || grant.coveredDomains.length !== domainsById.size
    || grant.coveredDomains.some((domain) => {
      const requirement = domainsById.get(domain.domainId);
      return requirement === undefined
        || domain.domainEpoch !== requirement.expectedEpoch
        || domain.agentAuthorizationRevision
          !== requirement.expectedAgentAuthorizationRevision;
    })
    || (
      authority.grantUseStatus === "reusable"
        ? grant.singleUse || rowBoolean(grantRow, "consumed")
        : !grant.singleUse || !rowBoolean(grantRow, "consumed")
    )
    || rowString(runtimeRow, "agent_id") !== authority.agentId
    || rowCounter(runtimeRow, "authorization_revision")
      !== authority.agentAuthorizationRevision
    || rowCounter(runtimeRow, "runtime_generation")
      !== authority.runtimeGeneration
  ) conflict("Memory crypto current Grant or Runtime authority is stale");
  if (
    namespaceRows.length !== authority.namespaceBindings.length
    || domainRows.length !== authority.domainRequirements.length
  ) conflict("Memory crypto current Namespace or Domain set is partial or extra");
  const bindings = new Map(
    authority.namespaceBindings.map((entry) => [entry.namespaceId, entry] as const),
  );
  for (const row of namespaceRows) {
    const namespaceId = rowString(row, "namespace_id");
    const binding = bindings.get(namespaceId);
    if (
      binding === undefined
      || rowCounter(row, "access_revision") !== binding.expectedAccessRevision
      || !bytesEqual(rowBytes(row, "binding_hash"), binding.bindingHash)
      || rowString(row, "domain_id") !== binding.domainId
      || rowBoolean(row, "writes_paused")
    ) conflict("Memory crypto current Namespace binding head is stale");
  }
  for (const row of domainRows) {
    const domainId = rowString(row, "id");
    const requirement = domainsById.get(domainId);
    if (
      requirement === undefined
      || rowCounter(row, "epoch") !== requirement.expectedEpoch
    ) conflict("Memory crypto current Domain head is stale");
  }
}

async function insertExactPublication(
  executor: CryptoPostgresExecutor,
  expected: ExactMemoryPublication,
): Promise<void> {
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(cryptoObjects).values({
      objectId: expected.objectId,
      payloadHash: expected.payloadHash,
      payloadBytes: expected.payloadBytes,
    }),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoAccessManifests).values({
      objectId: expected.objectId,
      accessRevision: 0,
      manifestHash: expected.genesisManifestHash,
      previousManifestHash: null,
      payloadHash: expected.payloadHash,
      manifestBytes: expected.genesisManifestBytes,
    }),
  );
  for (const [ordinal, envelope] of expected.envelopes.entries()) {
    await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values({
        objectId: expected.objectId,
        accessRevision: 0,
        namespaceId: envelope.namespaceId,
        ordinal,
        envelopeHash: envelope.envelopeHash,
        envelopeBytes: envelope.envelopeBytes,
      }),
    );
  }
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoAccessHeads).values({
      objectId: expected.objectId,
      accessRevision: 0,
      manifestHash: expected.genesisManifestHash,
    }),
  );
}

function assertReference(reference: MemoryCryptoRevisionReference): void {
  if (
    reference.objectId !== deriveMemoryCryptoObjectIdV1(reference)
    || !Number.isSafeInteger(reference.expectedAccessRevision)
    || reference.expectedAccessRevision < 0
    || !(reference.expectedActiveNamespaceFingerprint instanceof Uint8Array)
    || reference.expectedActiveNamespaceFingerprint.length !== 32
  ) {
    throw new TypeError("Memory crypto revision reference is invalid");
  }
}

type PostgresMemoryCryptoCompletionDependencies = Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
}>;

export type PostgresMemoryCryptoCompletion =
  & AtomicMemoryCryptoCompletionPort
  & VerifiedAgentMemoryCryptoRevisionReader;

async function readActiveDurablePublication(
  input: PostgresMemoryCryptoCompletionDependencies,
  reference: MemoryCryptoRevisionReference,
): Promise<DurableMemoryPublication | null> {
  assertReference(reference);
  return withVerifiedCryptoPostgresTransaction(
    input.handle,
    async (scopedHandle) => {
      const durable = await readDurablePublication({
        executor: scopedHandle,
        crypto: input.crypto,
        objectId: reference.objectId,
        resolveHistoricalAuthority:
          input.resolveHistoricalAgentSignerAuthority,
      });
      if (durable === "absent") return null;
      if (!bytesEqual(
        fingerprintRequiredMemoryNamespaces(durable.requiredNamespaceIds),
        reference.expectedActiveNamespaceFingerprint,
      ) || durable.accessRevision !== reference.expectedAccessRevision) return null;
      return durable;
    },
  );
}

export function createPostgresMemoryCryptoCompletion(
  input: PostgresMemoryCryptoCompletionDependencies,
): PostgresMemoryCryptoCompletion {
  assertVerifiedCryptoPostgresHandle(input.handle);
  if (typeof input.resolveHistoricalAgentSignerAuthority !== "function") {
    throw new TypeError(
      "Memory crypto completion historical Agent signer resolver is required",
    );
  }
  return Object.freeze({
    async complete(
      revision: PreparedMemoryCryptoRevision,
    ): Promise<"created" | "duplicate"> {
      const expected = exactPreparedPublication(input.crypto, revision);
      return withVerifiedCryptoPostgresTransaction(
        input.handle,
        async (scopedHandle) => {
          await scopedHandle.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
            [expected.objectId],
          );
          const durable = await readDurablePublication({
            executor: scopedHandle,
            crypto: input.crypto,
            objectId: expected.objectId,
            resolveHistoricalAuthority:
              input.resolveHistoricalAgentSignerAuthority,
          });
          if (durable !== "absent") {
            if (!durableMatchesExpected(durable, expected)) {
              conflict("Memory crypto completion conflicts with durable bytes");
            }
            return "duplicate";
          }
          const publication = await readHistoricalPublication({
            executor: scopedHandle,
            crypto: input.crypto,
            agentId: expected.authority.agentId,
            runtimeGeneration: expected.authority.runtimeGeneration,
            signerKeyId: expected.authority.signerKeyId,
            resolveHistoricalAuthority:
              input.resolveHistoricalAgentSignerAuthority,
          });
          authenticateAccessManifest(input.crypto, publication, {
            manifestBytes: expected.genesisManifestBytes,
            manifestHash: expected.genesisManifestHash,
          });
          await assertCurrentAuthority(scopedHandle, input.crypto, expected);
          await insertExactPublication(scopedHandle, expected);
          const persisted = await readDurablePublication({
            executor: scopedHandle,
            crypto: input.crypto,
            objectId: expected.objectId,
            resolveHistoricalAuthority:
              input.resolveHistoricalAgentSignerAuthority,
          });
          if (
            persisted === "absent"
            || persisted.accessRevision !== 0
            || !durableMatchesExpected(persisted, expected)
          ) conflict("Memory crypto transaction did not persist the exact publication");
          return "created";
        },
      );
    },

    async verify(
      reference: MemoryCryptoRevisionReference,
    ): Promise<VerifiedMemoryCryptoRevision | null> {
      const durable = await readActiveDurablePublication(input, reference);
      return durable === null ? null : Object.freeze({
        memoryId: reference.memoryId,
        contentRevision: reference.contentRevision,
        objectId: reference.objectId,
        objectType: MEMORY_OBJECT_TYPE,
        payloadVersion: MEMORY_PAYLOAD_VERSION,
        requiredNamespaceIds: durable.requiredNamespaceIds,
        accessSignerEvidence: Object.freeze(durable.signerEvidence.map(
          (entry) => Object.freeze({
            kind: entry.kind,
            evidenceBytes: entry.evidenceBytes.slice(),
          }),
        )),
      });
    },

    async read(
      reference: MemoryCryptoRevisionReference,
    ): Promise<VerifiedAgentMemoryCryptoRevisionContent | null> {
      const durable = await readActiveDurablePublication(input, reference);
      return durable === null ? null : Object.freeze({
        memoryId: reference.memoryId,
        contentRevision: reference.contentRevision,
        objectId: reference.objectId,
        accessRevision: durable.accessRevision,
        accessManifestBytes: durable.accessManifestBytes,
        accessManifestHash: durable.accessManifestHash,
        accessManifestSignerPublicKey:
          durable.signerPublicKey.slice(),
        ...(durable.signerAuthorizationBytes === undefined ? {} : {
          accessManifestSignerAuthorizationBytes:
            durable.signerAuthorizationBytes.slice(),
        }),
        ...(durable.signerIssuingPublicKey === undefined ? {} : {
          accessManifestSignerIssuingPublicKey:
            durable.signerIssuingPublicKey.slice(),
        }),
        accessSignerEvidence: Object.freeze(durable.signerEvidence.map(
          (entry) => Object.freeze({
            kind: entry.kind,
            evidenceBytes: entry.evidenceBytes.slice(),
          }),
        )),
        requiredNamespaceIds: durable.requiredNamespaceIds,
        payloadBytes: durable.payloadBytes,
        namespaceEnvelopes: Object.freeze(durable.envelopes.map((envelope) =>
          Object.freeze({
            namespaceId: envelope.namespaceId,
            envelopeBytes: envelope.envelopeBytes,
          })
        )),
      });
    },

  });
}

export type ResolveAgentMemoryExactAccessPolicyRevision = (
  binding: AgentMemoryExactAccessBindingFact,
) => Promise<number | null>;

async function agentAccessBindingsCurrent(input: Readonly<{
  executor: CryptoPostgresExecutor;
  bindings: readonly AgentMemoryExactAccessBindingFact[];
  resolvePolicyRevision: ResolveAgentMemoryExactAccessPolicyRevision;
}>): Promise<boolean> {
  for (const binding of input.bindings) {
    const rows = await executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        namespace_id: namespaceCryptoHeads.namespaceId,
        access_revision: namespaceCryptoHeads.accessRevision,
        binding_hash: namespaceCryptoHeads.bindingHash,
        domain_id: namespaceCryptoHeads.domainId,
        writes_paused: cryptoDomains.writesPaused,
      }).from(namespaceCryptoHeads)
        .innerJoin(
          cryptoDomains,
          eq(cryptoDomains.id, namespaceCryptoHeads.domainId),
        )
        .where(eq(namespaceCryptoHeads.namespaceId, binding.namespaceId))
        .limit(2),
    );
    if (rows.length !== 1) return false;
    const row = rows[0]!;
    if (
      rowString(row, "namespace_id") !== binding.namespaceId
      || rowCounter(row, "access_revision") !== binding.expectedAccessRevision
      || rowString(row, "domain_id") !== binding.domainId
      || !bytesEqual(rowBytes(row, "binding_hash"), binding.bindingHash)
      || rowBoolean(row, "writes_paused")
      || await input.resolvePolicyRevision(binding)
        !== binding.expectedPolicyRevision
    ) return false;
  }
  return true;
}

async function agentAccessHistoricalWrapsAuthentic(input: Readonly<{
  executor: CryptoPostgresExecutor;
  crypto: LatticeCrypto;
  bindings: readonly AgentMemoryExactAccessBindingFact[];
  envelopes: readonly Readonly<{
    namespaceId: string;
    keyGeneration: number;
    bindingRevisionAtWrap: number;
    envelopeHash: Uint8Array;
  }>[];
  requireCurrentWrap: ReadonlySet<string>;
  resolveHistoricalCommitter: HistoricalCommitterResolver;
}>): Promise<boolean> {
  if (input.bindings.length !== input.envelopes.length) return false;
  for (let index = 0; index < input.bindings.length; index += 1) {
    const binding = input.bindings[index]!;
    const envelope = input.envelopes[index]!;
    if (
      envelope.namespaceId !== binding.namespaceId
      || envelope.bindingRevisionAtWrap > binding.expectedAccessRevision
      || (input.requireCurrentWrap.has(binding.namespaceId)
        && envelope.bindingRevisionAtWrap !== binding.expectedAccessRevision)
    ) return false;
    const rows = await executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        namespace_id: namespaceCryptoBindings.namespaceId,
        revision: namespaceCryptoBindings.revision,
        binding_hash: namespaceCryptoBindings.bindingHash,
        signed_binding_bytes: namespaceCryptoBindings.signedBindingBytes,
      }).from(namespaceCryptoBindings)
        .where(and(
          eq(namespaceCryptoBindings.namespaceId, binding.namespaceId),
          eq(
            namespaceCryptoBindings.revision,
            envelope.bindingRevisionAtWrap,
          ),
        ))
        .limit(2),
    );
    if (rows.length !== 1) return false;
    const row = rows[0]!;
    const signedBindingBytes = rowBytes(row, "signed_binding_bytes");
    try {
      const parsed = parseNamespaceBindingV2(signedBindingBytes);
      if (
        rowString(row, "namespace_id") !== binding.namespaceId
        || rowCounter(row, "revision") !== envelope.bindingRevisionAtWrap
        || !bytesEqual(
          rowBytes(row, "binding_hash"),
          input.crypto.hash(signedBindingBytes),
        )
        || parsed.namespaceId !== binding.namespaceId
        || parsed.domainId !== binding.domainId
        || parsed.accessRevision !== envelope.bindingRevisionAtWrap
        || parsed.aiCurrentGeneration !== envelope.keyGeneration
      ) return false;
      verifyNamespaceBinding({
        crypto: input.crypto,
        binding: parsed,
        resolveHistoricalCommitter: input.resolveHistoricalCommitter,
      });
    } catch {
      return false;
    } finally {
      signedBindingBytes.fill(0);
    }
  }
  return true;
}

function exactAgentAccessCurrent(
  durable: DurableMemoryPublication,
  prepared: ReturnType<typeof readPreparedAgentMemoryExactAccessSnapshot>,
): boolean {
  const authority = prepared.prepared.authority;
  const currentEnvelopeByNamespace = new Map(
    authority.currentEnvelopes.map((entry) => [entry.namespaceId, entry]),
  );
  return durable.objectId === prepared.plan.cryptoObjectId
    && durable.accessRevision === prepared.plan.expectedCryptoAccessRevision
    && bytesEqual(durable.payloadHash, prepared.prepared.manifest.payloadHash)
    && prepared.prepared.manifest.previousManifestHash !== null
    && bytesEqual(
      durable.accessManifestHash,
      prepared.prepared.manifest.previousManifestHash,
    )
    && stringsEqual(
      durable.requiredNamespaceIds,
      prepared.plan.currentNamespaceIds,
    )
    && durable.envelopes.length === authority.currentEnvelopes.length
    && durable.envelopes.every((entry) => {
      const expected = currentEnvelopeByNamespace.get(entry.namespaceId);
      return expected !== undefined
        && entry.keyGeneration === expected.keyGeneration
        && entry.bindingRevisionAtWrap === expected.bindingRevisionAtWrap
        && bytesEqual(entry.envelopeHash, expected.envelopeHash);
    });
}

function exactAgentAccessTarget(
  durable: DurableMemoryPublication,
  prepared: ReturnType<typeof readPreparedAgentMemoryExactAccessSnapshot>,
): boolean {
  return durable.accessRevision === prepared.plan.nextCryptoAccessRevision
    && bytesEqual(durable.accessManifestHash, prepared.prepared.manifestHash)
    && bytesEqual(
      durable.accessManifestBytes,
      prepared.prepared.manifestBytes,
    )
    && stringsEqual(
      durable.requiredNamespaceIds,
      prepared.plan.targetNamespaceIds,
    )
    && durable.envelopes.length === prepared.prepared.envelopeBytes.length
    && durable.envelopes.every((entry, index) =>
      bytesEqual(entry.envelopeBytes, prepared.prepared.envelopeBytes[index]!)
    );
}

/**
 * Restricted-role persistence for an Agent v3 exact access update. The
 * caller must invoke this only inside the foreground content port's second
 * live Grant + Runtime authorization callback.
 */
export function createPostgresAgentMemoryExactAccessCryptoCompletion(
  input: PostgresMemoryCryptoCompletionDependencies & Readonly<{
    resolveHistoricalNamespaceCommitter: HistoricalCommitterResolver;
    resolvePolicyRevision: ResolveAgentMemoryExactAccessPolicyRevision;
  }>,
): AgentMemoryExactAccessCryptoCompletionPort {
  assertVerifiedCryptoPostgresHandle(input.handle);
  return Object.freeze({
    async observe(
      objectId: string,
    ): Promise<AgentMemoryExactAccessCryptoObservation> {
      if (!MEMORY_OBJECT_ID.test(objectId)) {
        throw new TypeError("Agent Memory exact-access object id is invalid");
      }
      return withVerifiedCryptoPostgresTransaction(
        input.handle,
        async (executor) => {
          const durable = await readDurablePublication({
            executor,
            crypto: input.crypto,
            objectId,
            resolveHistoricalAuthority:
              input.resolveHistoricalAgentSignerAuthority,
          });
          if (durable === "absent") {
            return Object.freeze({ status: "absent" as const });
          }
          try {
            return Object.freeze({
              status: "active" as const,
              objectId: durable.objectId,
              accessRevision: durable.accessRevision,
              manifestHash: durable.accessManifestHash.slice(),
              namespaceIds: Object.freeze([...durable.requiredNamespaceIds]),
            });
          } finally {
            wipeDurableMemoryPublication(durable);
          }
        },
      );
    },

    async complete(
      preparedHandle: PreparedAgentMemoryExactAccess,
    ): Promise<AgentMemoryExactAccessCryptoReceipt> {
      const prepared = readPreparedAgentMemoryExactAccessSnapshot(
        preparedHandle,
      );
      const requestDigest = agentMemoryExactAccessRequestDigest(preparedHandle);
      return withVerifiedCryptoPostgresTransaction(
        input.handle,
        async (executor) => {
          const durable = await readDurablePublication({
            executor,
            crypto: input.crypto,
            objectId: prepared.plan.cryptoObjectId,
            resolveHistoricalAuthority:
              input.resolveHistoricalAgentSignerAuthority,
          });
          if (durable === "absent") {
            conflict("Agent Memory exact-access crypto object is absent");
          }
          let status: "applied" | "duplicate";
          if (exactAgentAccessTarget(durable, prepared)) {
            status = "duplicate";
          } else {
            if (!exactAgentAccessCurrent(durable, prepared)) {
              conflict("Agent Memory exact-access crypto head is stale");
            }
            const authority = prepared.prepared.authority;
            const added = new Set(authority.addedNamespaceIds);
            if (
              !await agentAccessBindingsCurrent({
                executor,
                bindings: prepared.plan.currentBindings,
                resolvePolicyRevision: input.resolvePolicyRevision,
              })
              || !await agentAccessBindingsCurrent({
                executor,
                bindings: prepared.plan.targetBindings,
                resolvePolicyRevision: input.resolvePolicyRevision,
              })
              || !await agentAccessHistoricalWrapsAuthentic({
                executor,
                crypto: input.crypto,
                bindings: prepared.plan.currentBindings,
                envelopes: authority.currentEnvelopes,
                requireCurrentWrap: new Set(),
                resolveHistoricalCommitter:
                  input.resolveHistoricalNamespaceCommitter,
              })
              || !await agentAccessHistoricalWrapsAuthentic({
                executor,
                crypto: input.crypto,
                bindings: prepared.plan.targetBindings,
                envelopes: authority.targetEnvelopes,
                requireCurrentWrap: added,
                resolveHistoricalCommitter:
                  input.resolveHistoricalNamespaceCommitter,
              })
            ) conflict("Agent Memory exact-access binding authority is stale");
            const manifest = decodeObjectAccessManifestV5(
              prepared.prepared.manifestBytes,
            );
            if (
              manifest.objectId !== prepared.plan.cryptoObjectId
              || manifest.accessRevision
                !== prepared.plan.nextCryptoAccessRevision
              || manifest.previousManifestHash === null
              || !bytesEqual(
                manifest.previousManifestHash,
                durable.accessManifestHash,
              )
              || !bytesEqual(manifest.payloadHash, durable.payloadHash)
              || !bytesEqual(
                input.crypto.hash(prepared.prepared.manifestBytes),
                prepared.prepared.manifestHash,
              )
              || manifest.envelopeHashes.length
                !== prepared.prepared.envelopeBytes.length
              || manifest.signer.kind !== "agent_runtime"
              || manifest.signer.agentId !== authority.agentId
              || manifest.signer.runtimeGeneration
                !== authority.runtimeGeneration
              || manifest.signer.signerKeyId !== authority.signerKeyId
              || manifest.hostAuthorizationRevision
                !== authority.agentAuthorizationRevision
            ) conflict("Agent Memory exact-access prepared manifest is invalid");
            const publication = await readHistoricalPublication({
              executor,
              crypto: input.crypto,
              agentId: authority.agentId,
              runtimeGeneration: authority.runtimeGeneration,
              signerKeyId: authority.signerKeyId,
              resolveHistoricalAuthority:
                input.resolveHistoricalAgentSignerAuthority,
            });
            authenticateAccessManifest(input.crypto, publication, {
              manifestBytes: prepared.prepared.manifestBytes,
              manifestHash: prepared.prepared.manifestHash,
            });
            await executeTypedCryptoQuery(
              executor,
              cryptoTypedDb.insert(objectCryptoAccessManifests).values({
                objectId: prepared.plan.cryptoObjectId,
                accessRevision: prepared.plan.nextCryptoAccessRevision,
                manifestHash: prepared.prepared.manifestHash,
                previousManifestHash: durable.accessManifestHash,
                payloadHash: durable.payloadHash,
                manifestBytes: prepared.prepared.manifestBytes,
              }),
            );
            const targetEnvelopeByNamespace = new Map(
              authority.targetEnvelopes.map((entry) =>
                [entry.namespaceId, entry] as const
              ),
            );
            if (
              targetEnvelopeByNamespace.size
                !== authority.targetEnvelopes.length
            ) conflict("Agent Memory exact-access target envelope set is invalid");
            for (const [ordinal, bytes] of
              prepared.prepared.envelopeBytes.entries()) {
              const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
              const expected = targetEnvelopeByNamespace.get(
                envelope.context.namespaceId,
              );
              const hash = input.crypto.hash(bytes);
              if (
                expected === undefined
                || envelope.context.objectId !== prepared.plan.cryptoObjectId
                || envelope.context.namespaceId !== expected.namespaceId
                || envelope.context.keyClass !== "ai"
                || envelope.context.keyGeneration !== expected.keyGeneration
                || envelope.context.bindingRevisionAtWrap
                  !== expected.bindingRevisionAtWrap
                || !bytesEqual(hash, expected.envelopeHash)
                || !bytesEqual(hash, manifest.envelopeHashes[ordinal]!)
              ) conflict("Agent Memory exact-access target envelope is invalid");
              await executeTypedCryptoQuery(
                executor,
                cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values({
                  objectId: prepared.plan.cryptoObjectId,
                  accessRevision: prepared.plan.nextCryptoAccessRevision,
                  namespaceId: expected.namespaceId,
                  ordinal,
                  envelopeHash: hash,
                  envelopeBytes: bytes,
                }),
              );
            }
            const advanced = await executeTypedCryptoQuery(
              executor,
              cryptoTypedDb.update(objectCryptoAccessHeads).set({
                accessRevision: prepared.plan.nextCryptoAccessRevision,
                manifestHash: prepared.prepared.manifestHash,
              }).where(and(
                eq(
                  objectCryptoAccessHeads.objectId,
                  prepared.plan.cryptoObjectId,
                ),
                eq(
                  objectCryptoAccessHeads.accessRevision,
                  prepared.plan.expectedCryptoAccessRevision,
                ),
                eq(
                  objectCryptoAccessHeads.manifestHash,
                  durable.accessManifestHash,
                ),
              )).returning({ object_id: objectCryptoAccessHeads.objectId }),
            );
            if (advanced.length !== 1) {
              conflict("Agent Memory exact-access head CAS failed");
            }
            status = "applied";
          }
          const verified = await readDurablePublication({
            executor,
            crypto: input.crypto,
            objectId: prepared.plan.cryptoObjectId,
            resolveHistoricalAuthority:
              input.resolveHistoricalAgentSignerAuthority,
          });
          if (
            verified === "absent"
            || !exactAgentAccessTarget(verified, prepared)
          ) conflict("Agent Memory exact-access receipt is not durable");
          return Object.freeze({
            operationId: prepared.plan.operationId,
            memoryId: prepared.plan.memoryId,
            objectId: prepared.plan.cryptoObjectId,
            expectedContentRevision: prepared.plan.expectedContentRevision,
            expectedAccessRevision:
              prepared.plan.expectedCryptoAccessRevision,
            resultAccessRevision: prepared.plan.nextCryptoAccessRevision,
            currentManifestHash:
              prepared.prepared.manifest.previousManifestHash!.slice(),
            resultManifestHash: prepared.prepared.manifestHash.slice(),
            targetRequiredNamespaceFingerprint:
              prepared.plan.targetRequiredNamespaceFingerprint.slice(),
            requestDigest,
            currentNamespaceIds: prepared.plan.currentNamespaceIds,
            targetNamespaceIds: prepared.plan.targetNamespaceIds,
            status,
          });
        },
      );
    },
  });
}
