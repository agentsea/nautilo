import {
  and,
  asc,
  cryptoObjects,
  eq,
  lt,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  objectAccessManifestSigningBytesV5,
} from "@nautilo/lattice-crypto/wire";

import {
  deriveMemoryCryptoObjectIdV1,
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  type AtomicMemoryCryptoCompletionPort,
  type MemoryCryptoRevisionReference,
  type PreparedMemoryCryptoRevision,
  type VerifiedMemoryCryptoRevision,
} from "../../memory/memory-repository.ts";
import type { HumanMemoryRepairAttestationV1 } from
  "../../memory/human-memory-repair-attestation.ts";
import {
  readPreparedHumanMemoryUpdateSnapshot,
  type HumanMemoryPreparedAuthorityContext,
  type HumanMemoryProductAllocationCertificate,
} from "./human-memory-prepared-update.ts";
import { humanMemoryPreparedAuthorizationError } from
  "./human-memory-prepared-route-error.ts";
import { fingerprintHumanMemoryExactAccessTarget } from "./human-memory-exact-access.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";
import type {
  ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../storage/agent-runtime-signer-history.ts";
import type {
  ResolveForegroundAgentAcceptedExecutionEvidence,
} from "../message/postgres-foreground-agent-signer.ts";
import {
  destroyVerifiedStoredObjectAccessManifestChainV5,
  verifyStoredObjectAccessManifestChainV5,
} from "../storage/postgres-object-access-manifest-v5.ts";

type ExactEnvelope = Readonly<{
  namespaceId: string;
  keyGeneration: number;
  bindingRevisionAtWrap: number;
  envelopeHash: Uint8Array;
  envelopeBytes: Uint8Array;
}>;

type ExactStoredPublication = Readonly<{
  expectedHumanId: string;
  memoryId: string;
  contentRevision: number;
  objectId: string;
  requiredNamespaceIds: readonly string[];
  payloadBytes: Uint8Array;
  payloadHash: Uint8Array;
  genesisManifestBytes: Uint8Array;
  genesisManifestHash: Uint8Array;
  envelopes: readonly ExactEnvelope[];
}>;

type ExactPublication = ExactStoredPublication & Readonly<{
  preparedAuthority: HumanMemoryPreparedAuthorityContext;
  productAllocation: HumanMemoryProductAllocationCertificate;
}>;

type DurablePublication = Readonly<{
  objectId: string;
  payloadBytes: Uint8Array;
  payloadHash: Uint8Array;
  currentAccessRevision: number;
  currentManifestBytes: Uint8Array;
  currentManifestHash: Uint8Array;
  envelopes: readonly ExactEnvelope[];
  requiredNamespaceIds: readonly string[];
  head: "active" | "tombstone";
  humanId: string | null;
  committerDeviceId: string;
  hostAuthorizationRevision: number;
  signerEvidence: readonly (
    | Readonly<{
      kind: "agent_runtime_publication" | "processor_authorization";
      evidenceBytes: Uint8Array;
    }>
    | Readonly<{
      kind: "human_device";
      subjectHumanId: string;
      committerDeviceId: string;
      hostAuthorizationRevision: number;
      signingPublicKey: Uint8Array;
    }>
    | Readonly<{
      kind: "evidence_issuer_human_device";
      subjectHumanId: string;
      deviceId: string;
      hostAuthorizationRevision: number;
      signingPublicKey: Uint8Array;
    }>
    | Readonly<{
      kind: "foreground_agent_accepted_execution";
      planBytes: Uint8Array;
      planDigest: Uint8Array;
    }>
  )[];
}>;

export interface StoredHumanMemorySignerContext {
  readonly purpose: "verify-stored-human-memory-revision";
  readonly memoryId: string;
  readonly contentRevision: number;
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopes: HumanMemoryPreparedAuthorityContext["envelopes"];
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
}

export interface StoredHumanMemorySignerAuthority
  extends StoredHumanMemorySignerContext {
  readonly humanId: string;
  readonly committerSigningPublicKey: Uint8Array;
}

/**
 * A non-null result authenticates the retained exact Human→device signing key
 * at the stored host-authorization revision. It does not grant current write.
 */
export type ResolveStoredHumanMemorySignerAuthority = (
  context: StoredHumanMemorySignerContext,
) => Promise<StoredHumanMemorySignerAuthority | null>;

export interface CurrentHumanMemoryWriteAuthorizationContext
  extends Omit<HumanMemoryPreparedAuthorityContext, "purpose"> {
  readonly purpose:
    | "authorize-current-human-memory-create-persistence"
    | "authorize-current-human-memory-update-persistence";
  readonly productAllocation: HumanMemoryProductAllocationCertificate;
}

export interface CurrentHumanMemoryWriteAuthorization
  extends CurrentHumanMemoryWriteAuthorizationContext {
  readonly sourceAuthorized: boolean;
  readonly targetAuthorized: boolean;
  readonly currentHostAuthorizationRevision: number;
  readonly committerSigningPublicKey: Uint8Array;
}

/**
 * A non-null result proves both exact Human/device signer ownership and fresh
 * authorization for the canonical source Memory revision and every envelope
 * in the complete target set. The adapter compares every supplied coordinate
 * plus both source/target booleans before any insert.
 */
export type ResolveCurrentHumanMemoryWriteAuthorization = (
  context: CurrentHumanMemoryWriteAuthorizationContext,
) => Promise<CurrentHumanMemoryWriteAuthorization | null>;

export class HumanMemoryCryptoCompletionConflictError extends Error {
  readonly code = "human_memory_crypto_completion_conflict" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HumanMemoryCryptoCompletionConflictError";
  }
}

function conflict(message: string, cause?: unknown): never {
  throw new HumanMemoryCryptoCompletionConflictError(message, cause);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function wipeByteArrays(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) wipeByteArrays(child, seen);
}

function stringsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function oneOrNull(rows: readonly DatabaseRow[], label: string): DatabaseRow | null {
  if (rows.length > 1) conflict(`${label} is not unique`);
  return rows[0] ?? null;
}

function rowString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") conflict(`${field} must be text`);
  return value;
}

function rowCounter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    conflict(`${field} must be a safe counter`);
  }
  return value as number;
}

function rowBytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) conflict(`${field} must be bytea`);
  return Uint8Array.from(value);
}

function rowNullableBytes(row: DatabaseRow, field: string): Uint8Array | null {
  return row[field] === null ? null : rowBytes(row, field);
}

function sortedHashes(hashes: readonly Uint8Array[]): readonly Uint8Array[] {
  return [...hashes].sort((left, right) => Buffer.compare(left, right));
}

function exactPrepared(
  revision: PreparedMemoryCryptoRevision,
): ExactPublication {
  const snapshot = readPreparedHumanMemoryUpdateSnapshot(revision);
  if (snapshot.productAllocation === null) {
    conflict("Prepared Human Memory is missing its product allocation");
  }
  if (
    revision.memoryId !== snapshot.authority.memoryId
    || revision.contentRevision !== snapshot.authority.nextContentRevision
    || revision.objectId !== snapshot.authority.objectId
    || revision.objectId !== deriveMemoryCryptoObjectIdV1(revision)
    || !stringsEqual(
      revision.requiredNamespaceIds,
      snapshot.envelopes.map((entry) => entry.namespaceId),
    )
  ) conflict("Prepared Human Memory handle coordinates disagree");
  return Object.freeze({
    expectedHumanId: snapshot.authority.expectedHumanId,
    preparedAuthority: snapshot.authority,
    productAllocation: snapshot.productAllocation,
    memoryId: revision.memoryId,
    contentRevision: revision.contentRevision,
    objectId: revision.objectId,
    requiredNamespaceIds: Object.freeze([...revision.requiredNamespaceIds]),
    payloadBytes: snapshot.payloadBytes.slice(),
    payloadHash: snapshot.payloadHash.slice(),
    genesisManifestBytes: snapshot.genesisManifestBytes.slice(),
    genesisManifestHash: snapshot.genesisManifestHash.slice(),
    envelopes: Object.freeze(snapshot.envelopes.map((entry) => Object.freeze({
      ...entry,
      envelopeHash: entry.envelopeHash.slice(),
      envelopeBytes: entry.envelopeBytes.slice(),
    }))),
  });
}

function authorityContextMatches(
  actual: CurrentHumanMemoryWriteAuthorization,
  expected: CurrentHumanMemoryWriteAuthorizationContext,
): boolean {
  return actual.purpose === expected.purpose
    && actual.expectedHumanId === expected.expectedHumanId
    && actual.operationId === expected.operationId
    && actual.memoryId === expected.memoryId
    && actual.expectedContentRevision === expected.expectedContentRevision
    && actual.nextContentRevision === expected.nextContentRevision
    && actual.objectId === expected.objectId
    && bytesEqual(actual.payloadHash, expected.payloadHash)
    && actual.committerDeviceId === expected.committerDeviceId
    && actual.hostAuthorizationRevision === expected.hostAuthorizationRevision
    && actual.productAllocation.operationId
      === expected.productAllocation.operationId
    && actual.productAllocation.memoryId === expected.productAllocation.memoryId
    && actual.productAllocation.expectedContentRevision
      === expected.productAllocation.expectedContentRevision
    && actual.productAllocation.nextContentRevision
      === expected.productAllocation.nextContentRevision
    && actual.productAllocation.objectId === expected.productAllocation.objectId
    && actual.productAllocation.anchorNamespaceId
      === expected.productAllocation.anchorNamespaceId
    && actual.productAllocation.expectedAccessRevision
      === expected.productAllocation.expectedAccessRevision
    && bytesEqual(
      actual.productAllocation.requiredNamespaceFingerprint,
      expected.productAllocation.requiredNamespaceFingerprint,
    )
    && bytesEqual(
      actual.productAllocation.operationRequestDigest,
      expected.productAllocation.operationRequestDigest,
    )
    && bytesEqual(
      actual.productAllocation.allocationRequestDigest,
      expected.productAllocation.allocationRequestDigest,
    )
    && actual.envelopes.length === expected.envelopes.length
    && actual.envelopes.every((entry, index) => {
      const intended = expected.envelopes[index]!;
      return entry.objectId === intended.objectId
        && entry.namespaceId === intended.namespaceId
        && entry.keyClass === intended.keyClass
        && entry.keyGeneration === intended.keyGeneration
        && entry.bindingRevisionAtWrap === intended.bindingRevisionAtWrap
        && bytesEqual(entry.envelopeHash, intended.envelopeHash);
    });
}

async function assertCurrentAuthority(
  crypto: LatticeCrypto,
  expected: ExactPublication,
  resolve: ResolveCurrentHumanMemoryWriteAuthorization,
): Promise<void> {
  const context: CurrentHumanMemoryWriteAuthorizationContext = Object.freeze({
    ...expected.preparedAuthority,
    purpose: expected.preparedAuthority.purpose
        === "authenticate-human-memory-prepared-create"
      ? "authorize-current-human-memory-create-persistence"
      : "authorize-current-human-memory-update-persistence",
    productAllocation: expected.productAllocation,
  });
  const authority = await resolve(context);
  if (authority === null) {
    conflict("Current Human Memory write authority is unavailable or stale");
  }
  const publicKey = authority.committerSigningPublicKey.slice();
  authority.committerSigningPublicKey.fill(0);
  let genesis: ReturnType<typeof decodeObjectAccessManifestV5> | undefined;
  let genesisSigningBytes: Uint8Array | undefined;
  try {
    genesis = decodeObjectAccessManifestV5(expected.genesisManifestBytes);
    genesisSigningBytes = objectAccessManifestSigningBytesV5({
      objectId: genesis.objectId,
      payloadHash: genesis.payloadHash,
      accessRevision: genesis.accessRevision,
      previousManifestHash: genesis.previousManifestHash,
      envelopeHashes: genesis.envelopeHashes,
      signer: genesis.signer,
      signerAuthorizationHash: genesis.signerAuthorizationHash,
      hostAuthorizationRevision: genesis.hostAuthorizationRevision,
    });
    if (
      !authorityContextMatches(authority, context)
      || !authority.sourceAuthorized
      || !authority.targetAuthorized
      || genesis.signer.kind !== "human_device"
      || genesis.signer.subjectHumanId !== context.expectedHumanId
      || genesis.signer.committerDeviceId !== context.committerDeviceId
      || authority.currentHostAuthorizationRevision
        !== context.hostAuthorizationRevision
      || !crypto.verify(publicKey, genesisSigningBytes, genesis.signature)
    ) conflict("Current Human Memory write authority is unavailable or stale");
  } finally {
    publicKey.fill(0);
    genesisSigningBytes?.fill(0);
    wipeByteArrays(genesis);
  }
}

/** A duplicate crypto completion is not fresh consent to disclose content to
 * the embedding provider. Recheck exact current signer authority on every try. */
export async function assertPreparedHumanMemoryCurrentWriteAuthority(input: Readonly<{
  crypto: LatticeCrypto;
  prepared: PreparedMemoryCryptoRevision;
  resolve: ResolveCurrentHumanMemoryWriteAuthorization;
}>): Promise<void> {
  const expected = exactPrepared(input.prepared);
  try {
    try {
      await assertCurrentAuthority(input.crypto, expected, input.resolve);
    } catch (error) {
      if (!(error instanceof HumanMemoryCryptoCompletionConflictError)) {
        throw error;
      }
      throw humanMemoryPreparedAuthorizationError(
        "Current Human Memory write authority is unavailable or stale",
      );
    }
  } finally {
    wipeByteArrays(expected);
  }
}

async function readDurable(input: Readonly<{
  executor: CryptoPostgresExecutor;
  crypto: LatticeCrypto;
  reference: Pick<MemoryCryptoRevisionReference, "memoryId" | "contentRevision" | "objectId">;
  resolveStoredSigner: ResolveStoredHumanMemorySignerAuthority;
  collectHumanSignerEvidence?: boolean;
  resolveHistoricalAgentSignerAuthority?:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority | undefined;
  resolveForegroundAgentAcceptedExecutionEvidence?:
    ResolveForegroundAgentAcceptedExecutionEvidence | undefined;
}>): Promise<DurablePublication | "absent"> {
  const [objects, manifestRows, envelopeRows] = await Promise.all([
    executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        object_id: cryptoObjects.objectId,
        payload_hash: cryptoObjects.payloadHash,
        payload_bytes: cryptoObjects.payloadBytes,
      }).from(cryptoObjects)
        .where(eq(cryptoObjects.objectId, input.reference.objectId))
        .limit(2),
    ),
    input.executor.query(
      `SELECT m.object_id, m.access_revision, m.manifest_hash,
              m.previous_manifest_hash, m.payload_hash, m.manifest_bytes
         FROM object_crypto_access_heads h
         JOIN object_crypto_access_manifests m
           ON m.object_id = h.object_id
          AND m.access_revision = h.access_revision
          AND m.manifest_hash = h.manifest_hash
        WHERE h.object_id = $1
        LIMIT 2
        FOR UPDATE OF h`,
      [input.reference.objectId],
    ),
    executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
        ordinal: objectCryptoNamespaceEnvelopes.ordinal,
        envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
        envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
      }).from(objectCryptoNamespaceEnvelopes)
        .innerJoin(objectCryptoAccessHeads, and(
          eq(
            objectCryptoAccessHeads.objectId,
            objectCryptoNamespaceEnvelopes.objectId,
          ),
          eq(
            objectCryptoAccessHeads.accessRevision,
            objectCryptoNamespaceEnvelopes.accessRevision,
          ),
        ))
        .where(eq(
          objectCryptoNamespaceEnvelopes.objectId,
          input.reference.objectId,
        ))
        .orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal))
        .limit(257),
    ),
  ]);
  const objectRow = oneOrNull(objects, "Human Memory crypto object");
  const manifestRow = oneOrNull(manifestRows, "Human Memory current manifest");
  if (
    objectRow === null && manifestRow === null && envelopeRows.length === 0
  ) return "absent";
  if (
    objectRow === null || manifestRow === null || envelopeRows.length > 256
  ) conflict("Human Memory crypto publication has partial durable state");
  const payloadBytes = rowBytes(objectRow, "payload_bytes");
  const payloadHash = input.crypto.hash(payloadBytes);
  const currentManifestBytes = rowBytes(manifestRow, "manifest_bytes");
  const currentManifestHash = rowBytes(manifestRow, "manifest_hash");
  const currentManifest = decodeObjectAccessManifestV5(currentManifestBytes);
  const currentAccessRevision = rowCounter(manifestRow, "access_revision");
  const exactEnvelopeRows = envelopeRows;
  if (exactEnvelopeRows.length > 256) {
    conflict("Human Memory durable Namespace inventory is oversized");
  }
  const envelopes = exactEnvelopeRows.map((row, ordinal) => {
    const envelopeBytes = rowBytes(row, "envelope_bytes");
    const decoded = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    const envelopeHash = input.crypto.hash(envelopeBytes);
    if (
      rowCounter(row, "ordinal") !== ordinal
      || rowString(row, "namespace_id") !== decoded.context.namespaceId
      || decoded.context.objectId !== input.reference.objectId
      || decoded.context.keyClass !== "ai"
      || !bytesEqual(rowBytes(row, "envelope_hash"), envelopeHash)
    ) conflict("Human Memory durable Namespace envelope disagrees");
    return Object.freeze({
      namespaceId: decoded.context.namespaceId,
      keyGeneration: decoded.context.keyGeneration,
      bindingRevisionAtWrap: decoded.context.bindingRevisionAtWrap,
      envelopeHash,
      envelopeBytes,
    });
  }).sort((left, right) => left.namespaceId < right.namespaceId ? -1 : 1);
  // Storage ordinals authenticate the stored inventory; they are not Namespace
  // order. Agent publications use manifest hash order, which is independent of
  // Namespace IDs. Expose the same canonical Namespace set for either author.
  const requiredNamespaceIds = envelopes.map((entry) => entry.namespaceId);
  const head = "active" as const;
  const durableWithoutHuman = Object.freeze({
    objectId: input.reference.objectId,
    requiredNamespaceIds: Object.freeze(requiredNamespaceIds),
    payloadBytes,
    payloadHash,
    currentAccessRevision,
    currentManifestBytes,
    currentManifestHash,
    envelopes: Object.freeze(envelopes),
    head,
  });
  const payload = decodeEncryptedPayloadV2(payloadBytes);
  if (
    rowString(objectRow, "object_id") !== input.reference.objectId
    || !bytesEqual(rowBytes(objectRow, "payload_hash"), payloadHash)
    || payload.context.objectId !== input.reference.objectId
    || payload.context.objectType !== MEMORY_OBJECT_TYPE
    || payload.context.keyClass !== "ai"
    || currentManifest.objectId !== input.reference.objectId
    || currentManifest.accessRevision !== currentAccessRevision
    || rowString(manifestRow, "object_id") !== input.reference.objectId
    || !bytesEqual(currentManifest.payloadHash, payloadHash)
    || !bytesEqual(
      input.crypto.hash(currentManifestBytes),
      currentManifestHash,
    )
    || !bytesEqual(rowBytes(manifestRow, "manifest_hash"), currentManifestHash)
    || !bytesEqual(rowBytes(manifestRow, "payload_hash"), payloadHash)
    || (currentAccessRevision === 0)
      !== (rowNullableBytes(manifestRow, "previous_manifest_hash") === null)
    || (currentManifest.previousManifestHash === null)
      !== (currentAccessRevision === 0)
    || (currentManifest.previousManifestHash !== null
      && !bytesEqual(
        currentManifest.previousManifestHash,
        rowBytes(manifestRow, "previous_manifest_hash"),
      ))
    || new Set(requiredNamespaceIds).size !== requiredNamespaceIds.length
    || currentManifest.envelopeHashes.length !== envelopes.length
    || currentManifest.envelopeHashes.some((hash, index) =>
      !bytesEqual(hash, sortedHashes(
        envelopes.map((entry) => entry.envelopeHash),
      )[index]!)
    )
  ) conflict("Human Memory durable publication coordinates disagree");
  const humanSignerEvidence = new Map<string, Readonly<{
    kind: "human_device";
    subjectHumanId: string;
    committerDeviceId: string;
    hostAuthorizationRevision: number;
    signingPublicKey: Uint8Array;
  }>>();
  const issuerEvidence = new Map<string, Readonly<{
    kind: "evidence_issuer_human_device";
    subjectHumanId: string;
    deviceId: string;
    hostAuthorizationRevision: number;
    signingPublicKey: Uint8Array;
  }>>();
  const historicalAgentAuthority = input.resolveHistoricalAgentSignerAuthority;
  const foregroundAgentEvidence = new Map<string, Readonly<{
    kind: "foreground_agent_accepted_execution";
    planBytes: Uint8Array;
    planDigest: Uint8Array;
  }>>();
  const verifiedChain = await verifyStoredObjectAccessManifestChainV5({
    executor: input.executor,
    crypto: input.crypto,
    objectId: input.reference.objectId,
    headAccessRevision: currentAccessRevision,
    expectedPayloadHash: payloadHash,
    expectedHeadManifestHash: currentManifestHash,
    resolveHistoricalAgentManagerAuthority: async (context) => {
      const authority = await historicalAgentAuthority?.(context) ?? null;
      if (authority !== null) {
        const evidenceKey = `${authority.managerHumanId}\0${authority.managerDeviceId}\0${authority.managerAuthorizationRevision}`;
        if (!issuerEvidence.has(evidenceKey)) {
          issuerEvidence.set(evidenceKey, Object.freeze({
            kind: "evidence_issuer_human_device" as const,
            subjectHumanId: authority.managerHumanId,
            deviceId: authority.managerDeviceId,
            hostAuthorizationRevision: authority.managerAuthorizationRevision,
            signingPublicKey: authority.managerSigningPublicKey.slice(),
          }));
        }
      }
      return authority;
    },
    resolveLiveShadowAgentSigner: async (principal) => {
      const evidence = await input.resolveForegroundAgentAcceptedExecutionEvidence?.(
        principal,
      ) ?? null;
      if (evidence === null) return null;
      try {
        const identity = `${principal.agentId}\0${principal.runtimeGeneration}\0${principal.signerKeyId}`;
        const retained = foregroundAgentEvidence.get(identity);
        if (retained !== undefined
          && (!bytesEqual(retained.planDigest, evidence.planDigest)
            || !bytesEqual(retained.planBytes, evidence.planBytes))) {
          conflict("Stored foreground Memory signer evidence collided");
        }
        if (retained === undefined) foregroundAgentEvidence.set(identity, Object.freeze({
          kind: "foreground_agent_accepted_execution" as const,
          planBytes: evidence.planBytes.slice(),
          planDigest: evidence.planDigest.slice(),
        }));
        return evidence.signerPublicKey.slice();
      } finally {
        evidence.signerPublicKey.fill(0);
        evidence.planBytes.fill(0);
        evidence.planDigest.fill(0);
      }
    },
    resolveHistoricalHumanDeviceSigningPublicKey: async (context) => {
        const legacy = await input.resolveStoredSigner({
          purpose: "verify-stored-human-memory-revision",
          memoryId: input.reference.memoryId,
          contentRevision: input.reference.contentRevision,
          objectId: input.reference.objectId,
          payloadHash,
          envelopes: Object.freeze(envelopes.map((entry) => Object.freeze({
            objectId: input.reference.objectId,
            namespaceId: entry.namespaceId,
            keyClass: "ai" as const,
            keyGeneration: entry.keyGeneration,
            bindingRevisionAtWrap: entry.bindingRevisionAtWrap,
            envelopeHash: entry.envelopeHash,
          }))),
          committerDeviceId: context.committerDeviceId,
          hostAuthorizationRevision: context.hostAuthorizationRevision,
        });
        if (legacy === null || legacy.humanId !== context.subjectHumanId) {
          legacy?.committerSigningPublicKey.fill(0);
          return null;
        }
        const key = legacy.committerSigningPublicKey.slice();
        const evidenceKey = `${context.subjectHumanId}\0${context.committerDeviceId}\0${context.hostAuthorizationRevision}`;
        const current = humanSignerEvidence.get(evidenceKey);
        if (current !== undefined && !bytesEqual(current.signingPublicKey, key)) {
          key.fill(0);
          legacy.committerSigningPublicKey.fill(0);
          conflict("Stored Human Memory signer authority collided");
        }
        if (current === undefined) {
          humanSignerEvidence.set(evidenceKey, Object.freeze({
            kind: "human_device" as const,
            subjectHumanId: context.subjectHumanId,
            committerDeviceId: context.committerDeviceId,
            hostAuthorizationRevision: context.hostAuthorizationRevision,
            signingPublicKey: key.slice(),
          }));
        }
        legacy.committerSigningPublicKey.fill(0);
        return key;
      },
  }).catch((error) => {
    humanSignerEvidence.forEach((entry) => entry.signingPublicKey.fill(0));
    issuerEvidence.forEach((entry) => entry.signingPublicKey.fill(0));
    foregroundAgentEvidence.forEach((entry) => {
      entry.planBytes.fill(0);
      entry.planDigest.fill(0);
    });
    throw error;
  });
  try {
    for (const entry of verifiedChain.signerEvidence) {
      if (entry.issuer === undefined) continue;
      const evidenceKey = `${entry.issuer.subjectHumanId}\0${entry.issuer.deviceId}\0${entry.issuer.hostAuthorizationRevision}`;
      if (!issuerEvidence.has(evidenceKey)) {
        issuerEvidence.set(evidenceKey, Object.freeze({
          kind: "evidence_issuer_human_device" as const,
          subjectHumanId: entry.issuer.subjectHumanId,
          deviceId: entry.issuer.deviceId,
          hostAuthorizationRevision: entry.issuer.hostAuthorizationRevision,
          signingPublicKey: entry.issuer.signingPublicKey.slice(),
        }));
      }
    }
    return Object.freeze({
      ...durableWithoutHuman,
      humanId: verifiedChain.genesisHumanId,
      committerDeviceId: currentManifest.signer.kind === "human_device"
        ? currentManifest.signer.committerDeviceId
        : "",
      hostAuthorizationRevision: currentManifest.hostAuthorizationRevision,
      signerEvidence: Object.freeze([
        ...verifiedChain.signerEvidence.map((entry) => Object.freeze({
          kind: entry.kind,
          evidenceBytes: entry.evidenceBytes.slice(),
        })),
        ...(input.collectHumanSignerEvidence === true
          ? [
            ...humanSignerEvidence.values(),
            ...issuerEvidence.values(),
            ...foregroundAgentEvidence.values(),
          ].map((entry) => Object.freeze({
              ...entry,
              ...(entry.kind === "foreground_agent_accepted_execution"
                ? {
                  planBytes: entry.planBytes.slice(),
                  planDigest: entry.planDigest.slice(),
                }
                : { signingPublicKey: entry.signingPublicKey.slice() }),
            }))
          : []),
      ]),
    });
  } finally {
    destroyVerifiedStoredObjectAccessManifestChainV5(verifiedChain);
    humanSignerEvidence.forEach((entry) => entry.signingPublicKey.fill(0));
    issuerEvidence.forEach((entry) => entry.signingPublicKey.fill(0));
    foregroundAgentEvidence.forEach((entry) => {
      entry.planBytes.fill(0);
      entry.planDigest.fill(0);
    });
  }
}

function durableMatches(durable: DurablePublication, expected: ExactStoredPublication): boolean {
  return durable.humanId === expected.expectedHumanId
    && durable.head === "active"
    && durable.currentAccessRevision === 0
    && durable.objectId === expected.objectId
    && stringsEqual(durable.requiredNamespaceIds, expected.requiredNamespaceIds)
    && bytesEqual(durable.payloadBytes, expected.payloadBytes)
    && bytesEqual(durable.payloadHash, expected.payloadHash)
    && bytesEqual(durable.currentManifestBytes, expected.genesisManifestBytes)
    && bytesEqual(durable.currentManifestHash, expected.genesisManifestHash)
    && durable.envelopes.length === expected.envelopes.length
    && durable.envelopes.every((entry, index) => {
      const intended = expected.envelopes[index]!;
      return entry.namespaceId === intended.namespaceId
        && entry.keyGeneration === intended.keyGeneration
        && entry.bindingRevisionAtWrap === intended.bindingRevisionAtWrap
        && bytesEqual(entry.envelopeHash, intended.envelopeHash)
        && bytesEqual(entry.envelopeBytes, intended.envelopeBytes);
    });
}

function hashMatches(
  crypto: LatticeCrypto,
  bytes: Uint8Array,
  expected: Uint8Array,
): boolean {
  const digest = crypto.hash(bytes);
  try {
    return bytesEqual(digest, expected);
  } finally {
    digest.fill(0);
  }
}

async function insertExact(
  executor: CryptoPostgresExecutor,
  expected: ExactStoredPublication,
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
  // The persisted ordinal follows the signed manifest's hash order, including
  // Human publications subsequently read by the Agent completion owner.
  const storageEnvelopes = [...expected.envelopes].sort((left, right) =>
    Buffer.compare(left.envelopeHash, right.envelopeHash)
  );
  for (const [ordinal, envelope] of storageEnvelopes.entries()) {
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
    || !(reference.expectedActiveNamespaceFingerprint instanceof Uint8Array)
    || reference.expectedActiveNamespaceFingerprint.length !== 32
  ) throw new TypeError("Human Memory crypto reference is invalid");
}

export type VerifiedHumanMemoryCryptoRevisionContent = Readonly<{
  memoryId: string;
  contentRevision: number;
  objectId: string;
  accessRevision: number;
  requiredNamespaceIds: readonly string[];
  payloadBytes: Uint8Array;
  accessManifestBytes: Uint8Array;
  /** Revisions 0..N-1, in order, for authenticating an arbitrary head N. */
  accessManifestProofBytes: readonly Uint8Array[];
  accessSignerEvidence: DurablePublication["signerEvidence"];
  namespaceEnvelopes: readonly Readonly<{
    namespaceId: string;
    envelopeBytes: Uint8Array;
  }>[];
}>;

/**
 * Restricted-role authenticated ciphertext reader. Every returned byte array
 * is a detached caller-owned copy and must be wiped by the caller.
 */
export interface PostgresHumanMemoryCryptoCompletion
  extends AtomicMemoryCryptoCompletionPort {
  read(
    reference: MemoryCryptoRevisionReference,
  ): Promise<VerifiedHumanMemoryCryptoRevisionContent | null>;
}

export type HumanMemoryRepresentationRepairCryptoInput = Readonly<{
  attestation: HumanMemoryRepairAttestationV1;
  payloadBytes: Uint8Array;
  accessManifestBytes: Uint8Array;
  namespaceEnvelopes: readonly Readonly<{
    namespaceId: string;
    envelopeBytes: Uint8Array;
  }>[];
  committerSigningPublicKey: Uint8Array;
}>;

export interface PostgresHumanMemoryRepresentationRepairCrypto {
  complete(input: HumanMemoryRepresentationRepairCryptoInput): Promise<
    "created" | "duplicate"
  >;
  verify(attestation: HumanMemoryRepairAttestationV1): Promise<boolean>;
}

function exactRepresentationRepair(
  crypto: LatticeCrypto,
  input: HumanMemoryRepresentationRepairCryptoInput,
): ExactStoredPublication {
  const value = input.attestation;
  if (value.direction !== "ordinary_to_protected"
    || value.cryptoObjectId !== deriveMemoryCryptoObjectIdV1({
      memoryId: value.memoryId,
      contentRevision: value.targetContentRevision,
    })
    || input.namespaceEnvelopes.length !== value.namespaces.length
  ) conflict("Human Memory repair crypto coordinates disagree");
  const payloadHash = crypto.hash(input.payloadBytes);
  const manifestHash = crypto.hash(input.accessManifestBytes);
  let payload: ReturnType<typeof decodeEncryptedPayloadV2> | undefined;
  let manifest: ReturnType<typeof decodeObjectAccessManifestV5> | undefined;
  let signingBytes: Uint8Array | undefined;
  const envelopes: ExactEnvelope[] = [];
  try {
    payload = decodeEncryptedPayloadV2(Uint8Array.from(input.payloadBytes));
    manifest = decodeObjectAccessManifestV5(
      Uint8Array.from(input.accessManifestBytes),
    );
    signingBytes = objectAccessManifestSigningBytesV5({
      objectId: manifest.objectId,
      payloadHash: manifest.payloadHash,
      accessRevision: manifest.accessRevision,
      previousManifestHash: manifest.previousManifestHash,
      envelopeHashes: manifest.envelopeHashes,
      signer: manifest.signer,
      signerAuthorizationHash: manifest.signerAuthorizationHash,
      hostAuthorizationRevision: manifest.hostAuthorizationRevision,
    });
    for (const [index, supplied] of input.namespaceEnvelopes.entries()) {
      const authority = value.namespaces[index]!;
      const envelopeHash = crypto.hash(supplied.envelopeBytes);
      const envelope = decodeNamespaceObjectEnvelopeV2(
        Uint8Array.from(supplied.envelopeBytes),
      );
      try {
        if (supplied.namespaceId !== authority.namespaceId
          || envelope.context.namespaceId !== authority.namespaceId
          || envelope.context.objectId !== value.cryptoObjectId
          || envelope.context.keyClass !== "ai"
          || envelope.context.keyGeneration !== authority.namespaceKeyGeneration
          || envelope.context.bindingRevisionAtWrap
            !== authority.namespaceAccessRevision
          || !bytesEqual(envelopeHash, authority.envelopeHash)) {
          conflict("Human Memory repair Namespace envelope disagrees");
        }
        envelopes.push(Object.freeze({
          namespaceId: supplied.namespaceId,
          keyGeneration: envelope.context.keyGeneration,
          bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
          envelopeHash,
          envelopeBytes: Uint8Array.from(supplied.envelopeBytes),
        }));
      } finally {
        wipeByteArrays(envelope);
      }
    }
    const sortedEnvelopeHashes = sortedHashes(envelopes.map((entry) =>
      entry.envelopeHash
    ));
    if (!bytesEqual(payloadHash, value.payloadHash)
      || !bytesEqual(manifestHash, value.accessManifestHash)
      || payload.context.objectId !== value.cryptoObjectId
      || payload.context.objectType !== MEMORY_OBJECT_TYPE
      || payload.context.keyClass !== "ai"
      || manifest.objectId !== value.cryptoObjectId
      || manifest.accessRevision !== 0
      || manifest.previousManifestHash !== null
      || !bytesEqual(manifest.payloadHash, payloadHash)
      || manifest.signer.kind !== "human_device"
      || manifest.signer.subjectHumanId !== value.subjectHumanId
      || manifest.signer.committerDeviceId !== value.deviceId
      || manifest.hostAuthorizationRevision !== value.hostAuthorizationRevision
      || manifest.envelopeHashes.length !== sortedEnvelopeHashes.length
      || manifest.envelopeHashes.some((hash, index) =>
        !bytesEqual(hash, sortedEnvelopeHashes[index]!)
      )
      || !crypto.verify(input.committerSigningPublicKey,
        signingBytes, manifest.signature)) {
      conflict("Human Memory repair protected evidence disagrees");
    }
    const fingerprint = fingerprintHumanMemoryExactAccessTarget(
      value.namespaces.map((entry) => entry.namespaceId),
    );
    try {
      if (!bytesEqual(fingerprint, value.requiredNamespaceFingerprint)) {
        conflict("Human Memory repair audience disagrees");
      }
    } finally {
      fingerprint.fill(0);
    }
    return Object.freeze({
      expectedHumanId: value.subjectHumanId,
      memoryId: value.memoryId,
      contentRevision: value.targetContentRevision,
      objectId: value.cryptoObjectId,
      requiredNamespaceIds: Object.freeze(value.namespaces.map((entry) =>
        entry.namespaceId
      )),
      payloadBytes: Uint8Array.from(input.payloadBytes),
      payloadHash: payloadHash.slice(),
      genesisManifestBytes: Uint8Array.from(input.accessManifestBytes),
      genesisManifestHash: manifestHash.slice(),
      envelopes: Object.freeze(envelopes),
    });
  } catch (error) {
    envelopes.forEach((entry) => {
      entry.envelopeHash.fill(0);
      entry.envelopeBytes.fill(0);
    });
    throw error;
  } finally {
    payloadHash.fill(0);
    manifestHash.fill(0);
    signingBytes?.fill(0);
    wipeByteArrays(payload);
    wipeByteArrays(manifest);
  }
}

export function createPostgresHumanMemoryCryptoCompletion(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  resolveCurrentWriteAuthorization: ResolveCurrentHumanMemoryWriteAuthorization;
  resolveStoredSignerAuthority: ResolveStoredHumanMemorySignerAuthority;
  resolveHistoricalAgentSignerAuthority?:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority | undefined;
  resolveForegroundAgentAcceptedExecutionEvidence?:
    ResolveForegroundAgentAcceptedExecutionEvidence | undefined;
}>): PostgresHumanMemoryCryptoCompletion {
  assertVerifiedCryptoPostgresHandle(input.handle);
  if (
    typeof input.resolveCurrentWriteAuthorization !== "function"
    || typeof input.resolveStoredSignerAuthority !== "function"
  ) throw new TypeError("Human Memory crypto authority resolvers are required");

  async function durableFor(reference: MemoryCryptoRevisionReference) {
    assertReference(reference);
    return withVerifiedCryptoPostgresTransaction(input.handle, (scopedHandle) =>
      readDurable({
        executor: scopedHandle,
        crypto: input.crypto,
        reference,
        resolveStoredSigner: input.resolveStoredSignerAuthority,
        resolveHistoricalAgentSignerAuthority:
          input.resolveHistoricalAgentSignerAuthority,
        resolveForegroundAgentAcceptedExecutionEvidence:
          input.resolveForegroundAgentAcceptedExecutionEvidence,
      })
    );
  }

  return Object.freeze({
    async complete(revision: PreparedMemoryCryptoRevision) {
      const expected = exactPrepared(revision);
      return withVerifiedCryptoPostgresTransaction(
        input.handle,
        async (scopedHandle) => {
          await scopedHandle.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [expected.objectId],
          );
          const reference = {
            memoryId: expected.memoryId,
            contentRevision: expected.contentRevision,
            objectId: expected.objectId,
          };
          const durable = await readDurable({
            executor: scopedHandle,
            crypto: input.crypto,
            reference,
            resolveStoredSigner: input.resolveStoredSignerAuthority,
            resolveHistoricalAgentSignerAuthority:
              input.resolveHistoricalAgentSignerAuthority,
            resolveForegroundAgentAcceptedExecutionEvidence:
              input.resolveForegroundAgentAcceptedExecutionEvidence,
          });
          if (durable !== "absent") {
            if (!durableMatches(durable, expected)) {
              conflict("Human Memory completion conflicts with durable state");
            }
            return "duplicate" as const;
          }
          await assertCurrentAuthority(
            input.crypto,
            expected,
            input.resolveCurrentWriteAuthorization,
          );
          await insertExact(scopedHandle, expected);
          const persisted = await readDurable({
            executor: scopedHandle,
            crypto: input.crypto,
            reference,
            resolveStoredSigner: input.resolveStoredSignerAuthority,
            resolveHistoricalAgentSignerAuthority:
              input.resolveHistoricalAgentSignerAuthority,
            resolveForegroundAgentAcceptedExecutionEvidence:
              input.resolveForegroundAgentAcceptedExecutionEvidence,
          });
          if (
            persisted === "absent"
            || persisted.head !== "active"
            || !durableMatches(persisted, expected)
          ) conflict("Human Memory exact crypto publication was not durable");
          return "created" as const;
        },
      );
    },

    async verify(reference: MemoryCryptoRevisionReference): Promise<VerifiedMemoryCryptoRevision | null> {
      const durable = await durableFor(reference);
      if (
        durable === "absent"
        || durable.head === "tombstone"
        || !bytesEqual(
          fingerprintHumanMemoryExactAccessTarget(durable.requiredNamespaceIds),
          reference.expectedActiveNamespaceFingerprint,
        )
      ) return null;
      return Object.freeze({
        memoryId: reference.memoryId,
        contentRevision: reference.contentRevision,
        objectId: reference.objectId,
        objectType: MEMORY_OBJECT_TYPE,
        payloadVersion: MEMORY_PAYLOAD_VERSION,
        requiredNamespaceIds: durable.requiredNamespaceIds,
      });
    },

    async read(reference: MemoryCryptoRevisionReference) {
      assertReference(reference);
      return withVerifiedCryptoPostgresTransaction(
        input.handle,
        async (executor) => {
          const durable = await readDurable({
            executor,
            crypto: input.crypto,
            reference,
            resolveStoredSigner: input.resolveStoredSignerAuthority,
            collectHumanSignerEvidence: true,
            resolveHistoricalAgentSignerAuthority:
              input.resolveHistoricalAgentSignerAuthority,
            resolveForegroundAgentAcceptedExecutionEvidence:
              input.resolveForegroundAgentAcceptedExecutionEvidence,
          });
          if (
            durable === "absent"
            || durable.head === "tombstone"
            || durable.currentAccessRevision > 256
            || !bytesEqual(
              fingerprintHumanMemoryExactAccessTarget(durable.requiredNamespaceIds),
              reference.expectedActiveNamespaceFingerprint,
            )
          ) return null;
          const proofRows = durable.currentAccessRevision === 0
            ? []
            : await executeTypedCryptoQuery(
                executor,
                cryptoTypedDb.select({
                  access_revision: objectCryptoAccessManifests.accessRevision,
                  manifest_bytes: objectCryptoAccessManifests.manifestBytes,
                }).from(objectCryptoAccessManifests)
                  .where(and(
                    eq(objectCryptoAccessManifests.objectId, durable.objectId),
                    lt(
                      objectCryptoAccessManifests.accessRevision,
                      durable.currentAccessRevision,
                    ),
                  ))
                  .orderBy(asc(objectCryptoAccessManifests.accessRevision))
                  .limit(256),
              );
          if (
            proofRows.length !== durable.currentAccessRevision
            || proofRows.some((row, index) =>
              rowCounter(row, "access_revision") !== index
            )
          ) conflict("Human Memory access-manifest proof is incomplete");
          return Object.freeze({
            memoryId: reference.memoryId,
            contentRevision: reference.contentRevision,
            objectId: reference.objectId,
            accessRevision: durable.currentAccessRevision,
            requiredNamespaceIds: Object.freeze([...durable.requiredNamespaceIds]),
            payloadBytes: durable.payloadBytes.slice(),
            accessManifestBytes: durable.currentManifestBytes.slice(),
            accessManifestProofBytes: Object.freeze(proofRows.map((row) =>
              rowBytes(row, "manifest_bytes")
            )),
            accessSignerEvidence: Object.freeze(durable.signerEvidence.map(
              (entry) => entry.kind === "human_device"
                ? Object.freeze({
                  ...entry,
                  signingPublicKey: entry.signingPublicKey.slice(),
                })
                : entry.kind === "evidence_issuer_human_device"
                ? Object.freeze({
                  ...entry,
                  signingPublicKey: entry.signingPublicKey.slice(),
                })
                : entry.kind === "foreground_agent_accepted_execution"
                ? Object.freeze({
                  ...entry,
                  planBytes: entry.planBytes.slice(),
                  planDigest: entry.planDigest.slice(),
                })
                : Object.freeze({
                  kind: entry.kind,
                  evidenceBytes: entry.evidenceBytes.slice(),
                }),
            )),
            namespaceEnvelopes: Object.freeze(durable.envelopes.map((entry) =>
              Object.freeze({
                namespaceId: entry.namespaceId,
                envelopeBytes: entry.envelopeBytes.slice(),
              })
            )),
          });
        },
      );
    },

  });
}

/** Raw repair persistence under a caller-held current Human/device/native-head
 * lease. This deliberately does not manufacture a semantic allocation or an
 * embedding request. */
export function createPostgresHumanMemoryRepresentationRepairCrypto(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  resolveStoredSignerAuthority: ResolveStoredHumanMemorySignerAuthority;
  resolveHistoricalAgentSignerAuthority?:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority | undefined;
  resolveForegroundAgentAcceptedExecutionEvidence?:
    ResolveForegroundAgentAcceptedExecutionEvidence | undefined;
  readCurrent?: PostgresHumanMemoryCryptoCompletion["read"] | undefined;
}>): PostgresHumanMemoryRepresentationRepairCrypto {
  assertVerifiedCryptoPostgresHandle(input.handle);
  const read = (executor: CryptoPostgresExecutor,
    reference: Pick<MemoryCryptoRevisionReference,
      "memoryId" | "contentRevision" | "objectId">) => readDurable({
      executor, crypto: input.crypto, reference,
      resolveStoredSigner: input.resolveStoredSignerAuthority,
      resolveHistoricalAgentSignerAuthority:
        input.resolveHistoricalAgentSignerAuthority,
      resolveForegroundAgentAcceptedExecutionEvidence:
        input.resolveForegroundAgentAcceptedExecutionEvidence,
    });
  return Object.freeze({
    async complete(repair: HumanMemoryRepresentationRepairCryptoInput) {
      const expected = exactRepresentationRepair(input.crypto, repair);
      try {
        return await withVerifiedCryptoPostgresTransaction(
          input.handle,
          async (executor) => {
            await executor.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
              [expected.objectId],
            );
            const reference = {
              memoryId: expected.memoryId,
              contentRevision: expected.contentRevision,
              objectId: expected.objectId,
            };
            const durable = await read(executor, reference);
            if (durable !== "absent") {
              if (!durableMatches(durable, expected)) {
                conflict("Human Memory repair conflicts with durable crypto");
              }
              return "duplicate" as const;
            }
            await insertExact(executor, expected);
            const persisted = await read(executor, reference);
            if (persisted === "absent" || !durableMatches(persisted, expected)) {
              conflict("Human Memory repair crypto publication was not durable");
            }
            return "created" as const;
          },
        );
      } finally {
        expected.payloadBytes.fill(0);
        expected.payloadHash.fill(0);
        expected.genesisManifestBytes.fill(0);
        expected.genesisManifestHash.fill(0);
        expected.envelopes.forEach((entry) => {
          entry.envelopeBytes.fill(0);
          entry.envelopeHash.fill(0);
        });
      }
    },
    async verify(value: HumanMemoryRepairAttestationV1) {
      if (value.direction !== "protected_to_ordinary") return false;
      const reference = Object.freeze({
        memoryId: value.memoryId,
        contentRevision: value.targetContentRevision,
        objectId: value.cryptoObjectId,
      });
      if (input.readCurrent !== undefined) {
        const durable = await input.readCurrent(Object.freeze({
          ...reference,
          expectedAccessRevision: value.expectedCryptoAccessRevision,
          expectedActiveNamespaceFingerprint:
            value.requiredNamespaceFingerprint,
        }));
        if (durable === null) return false;
        try {
          if (durable.accessRevision !== value.expectedCryptoAccessRevision
            || !stringsEqual(durable.requiredNamespaceIds,
              value.namespaces.map((entry) => entry.namespaceId))
            || !hashMatches(input.crypto, durable.payloadBytes, value.payloadHash)
            || !hashMatches(input.crypto, durable.accessManifestBytes,
              value.accessManifestHash)
            || durable.namespaceEnvelopes.length !== value.namespaces.length) {
            return false;
          }
          return durable.namespaceEnvelopes.every((entry, index) => {
            const authority = value.namespaces[index]!;
            const envelope = decodeNamespaceObjectEnvelopeV2(
              Uint8Array.from(entry.envelopeBytes),
            );
            const envelopeHash = input.crypto.hash(entry.envelopeBytes);
            try {
              return entry.namespaceId === authority.namespaceId
                && envelope.context.namespaceId === authority.namespaceId
                && envelope.context.objectId === value.cryptoObjectId
                && envelope.context.keyGeneration
                  === authority.namespaceKeyGeneration
                && envelope.context.bindingRevisionAtWrap
                  === authority.namespaceAccessRevision
                && bytesEqual(envelopeHash, authority.envelopeHash);
            } finally {
              envelopeHash.fill(0);
              wipeByteArrays(envelope);
            }
          });
        } finally {
          durable.payloadBytes.fill(0);
          durable.accessManifestBytes.fill(0);
          durable.accessManifestProofBytes.forEach((bytes) => bytes.fill(0));
          durable.namespaceEnvelopes.forEach((entry) =>
            entry.envelopeBytes.fill(0));
          durable.accessSignerEvidence.forEach((entry) => {
            if (entry.kind === "foreground_agent_accepted_execution") {
              entry.planBytes.fill(0);
              entry.planDigest.fill(0);
            } else if (entry.kind === "human_device"
              || entry.kind === "evidence_issuer_human_device") {
              entry.signingPublicKey.fill(0);
            } else {
              entry.evidenceBytes.fill(0);
            }
          });
        }
      }
      return withVerifiedCryptoPostgresTransaction(input.handle, async (executor) => {
        const durable = await read(executor, reference);
        if (durable === "absent" || durable.head !== "active"
          || durable.humanId !== value.subjectHumanId
          || durable.currentAccessRevision !== value.expectedCryptoAccessRevision
          || durable.objectId !== value.cryptoObjectId
          || !stringsEqual(durable.requiredNamespaceIds,
            value.namespaces.map((entry) => entry.namespaceId))
          || !bytesEqual(durable.payloadHash, value.payloadHash)
          || !bytesEqual(durable.currentManifestHash, value.accessManifestHash)
          || durable.envelopes.length !== value.namespaces.length) {
          return false;
        }
        return durable.envelopes.every((entry, index) => {
          const authority = value.namespaces[index]!;
          return entry.namespaceId === authority.namespaceId
            && entry.keyGeneration === authority.namespaceKeyGeneration
            && entry.bindingRevisionAtWrap === authority.namespaceAccessRevision
            && bytesEqual(entry.envelopeHash, authority.envelopeHash);
        });
      });
    },
  });
}
