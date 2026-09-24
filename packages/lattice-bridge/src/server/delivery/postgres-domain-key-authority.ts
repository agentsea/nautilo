import { randomUUID } from "node:crypto";
import {
  actors,
  and,
  asc,
  cryptoDeliveryOperations,
  cryptoDomains,
  desc,
  domainKeyEnvelopeAcknowledgements,
  domainKeyHeads,
  domainKeyPublicationOperations,
  domainKeyRecipientEnvelopes,
  domainKeyRecipientRequests,
  eq,
  gt,
  humanCryptoCustodies,
  humanCryptoDeviceGroupHeads,
  humanCryptoDevices,
  humanCryptoRecoveryKeys,
  inArray,
  isNotNull,
  isNull,
  lte,
  namespaceDomainKeyBindings,
  namespaceDomainKeyHeads,
  or,
  roomMembers,
  rooms,
  sql,
  moderationAccessAllowedSql,
  moderationEffectiveHumanActorIdsSql,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  domainForegroundNamespaceBindingSetDigest,
  namespaceGeneration,
  namespaceId,
  participantDigest,
  verifyDomainKeyAcknowledgement,
  verifyDomainKeyAccessRequest,
  verifyDomainKeyHead,
  verifyDomainKeyRecipientAuthorization,
  verifyDomainKeyRecipientEnvelope,
  withOpenedDomainNamespaceBundle,
  LatticeCrypto,
  LATTICE_LIMITS,
  type DomainKeyClass,
  type DomainForegroundAuthorityEntry,
} from "@nautilo/lattice-crypto";
import {
  destroyDomainKeyAcknowledgementV2,
  destroyDomainKeyAccessRequestV2,
  destroyDomainKeyHeadV2,
  destroyDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyRecipientEnvelopeV2,
  destroyDomainNamespaceBundleBindingV2,
  verifyDomainNamespaceBundleBindingV2,
} from "@nautilo/lattice-crypto/wire";

import {
  inspectNamespaceProductAuthoritySnapshot,
  type SharedAgentNamespaceWriteAuthorityResult,
  type NamespaceProductAuthoritySnapshot,
} from "./postgres-namespace-product-authority.ts";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresExecutor,
} from "../storage/postgres-lattice-storage.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
} from "../message/postgres-conversation-product-store.ts";
import type { DatabaseScalar } from "../storage/postgres-record-codecs.ts";

export const DOMAIN_KEY_AUTHORITY_OPERATION_TTL_MS = 30_000;
const FOREGROUND_AUTHORITY_NAMESPACE_QUERY_BATCH = 16_000;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export async function resolveAdditionalDevicePersonalAuthorityAnchor(
  product: PostgresJsBridgeConnection,
  humanActorId: string,
): Promise<Readonly<{ roomId: string; namespaceId: string }> | null> {
  const rows = await executeTypedCryptoQuery(
    product,
    cryptoTypedDb.select({
      id: rooms.id,
      namespace_id: rooms.namespaceId,
    }).from(rooms)
      .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
      .innerJoin(actors, and(
        eq(actors.id, roomMembers.actorId),
        eq(actors.kind, "agent"),
      ))
      .innerJoin(
        cryptoDomains,
        eq(cryptoDomains.participants, [humanActorId]),
      )
      .innerJoin(domainKeyHeads, eq(domainKeyHeads.domainId, cryptoDomains.id))
      .where(and(
        eq(rooms.humanActorIds, [humanActorId]),
        isNull(rooms.parentRoomId),
        isNull(rooms.archivedAt),
      ))
      .orderBy(asc(rooms.id))
      .limit(1),
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const roomId = row.id;
  const namespaceId = row["namespace_id"];
  if (typeof roomId !== "string" || typeof namespaceId !== "string") {
    throw new TypeError("Additional-device personal authority anchor is invalid");
  }
  return Object.freeze({ roomId, namespaceId });
}

type KeyClass = DomainKeyClass;

async function lockAuthorityCoordinate(
  transaction: CryptoPostgresExecutor,
  coordinates: readonly string[],
): Promise<void> {
  await transaction.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    [`m301:${JSON.stringify(coordinates)}`],
  );
}

async function expirePendingRecipientRequests(
  transaction: CryptoPostgresExecutor,
  input: Readonly<{
    domainId: string;
    keyClass: KeyClass;
    now: Date;
  }>,
): Promise<void> {
  await executeTypedCryptoQuery(
    transaction,
    cryptoTypedDb.update(domainKeyRecipientRequests).set({
      state: "expired",
      failureCode: "request_expired",
      updatedAt: input.now,
      terminalAt: input.now,
    }).where(and(
      eq(domainKeyRecipientRequests.domainId, input.domainId),
      eq(domainKeyRecipientRequests.keyClass, input.keyClass),
      eq(domainKeyRecipientRequests.state, "pending"),
      lte(domainKeyRecipientRequests.deadlineAt, input.now),
    )),
  );
}

export type DomainKeyAuthorityUnavailableReason =
  | "domain_unavailable"
  | "device_unavailable"
  | "authority_inconsistent"
  | "head_unavailable"
  | "recipient_unavailable"
  | "recipient_sync_required"
  | "request_unavailable"
  | "bundle_unavailable";

export type PendingDomainKeySourceCoordinate = Readonly<{
  namespaceId: string;
  keyClass: DomainKeyClass;
}>;

export type DomainKeyAuthorityHeadPlan =
  | Readonly<{
      status: "create_required";
      domainId: string;
      participantDigest: Uint8Array;
      participantCount: number;
      keyClass: KeyClass;
      domainKeyGeneration: number;
      authorizationRevision: number;
      previousHeadDigest: Uint8Array | null;
      issuerHumanId: string;
      issuerDeviceId: string;
      issuerDeviceSigningGeneration: number;
      issuerSigningPublicKey: Uint8Array;
      recipientEncryptionPublicKey: Uint8Array;
      recipientPublicKeyDigest: Uint8Array;
      recoveryKeyId: string;
      recoveryKeyGeneration: number;
      recoveryPublicKey: Uint8Array;
      recoveryPublicKeyDigest: Uint8Array;
      issuedAt: number;
      deadlineAt: number;
    }>
  | Readonly<{
      status: "ready";
      domainId: string;
      participantDigest: Uint8Array;
      participantCount: number;
      keyClass: KeyClass;
      domainKeyGeneration: number;
      authorizationRevision: number;
      headDigest: Uint8Array;
      headBytes: Uint8Array;
      issuerSigningPublicKey: Uint8Array;
      recipientDeviceSigningGeneration: number;
      recipientDeviceRevision: number;
      recipientEnvelope: null | Readonly<{
        envelopeBytes: Uint8Array;
        envelopeDigest: Uint8Array;
        issuerSigningPublicKey: Uint8Array;
      }>;
    }>
  | Readonly<{
      status: "unavailable";
      reason: DomainKeyAuthorityUnavailableReason;
    }>;

export type DomainKeyAuthorityPublicationResult = Readonly<{
  status: "published" | "replayed";
  operationId: string;
  domainId: string;
  keyClass: KeyClass;
  domainKeyGeneration: number;
  authorizationRevision: number;
  headDigest: Uint8Array;
  envelopeDigest: Uint8Array;
  recoveryEnvelopeDigest: Uint8Array;
}>;

export type DomainKeyRecipientRequestResult = Readonly<{
  status: "requested" | "replayed" | "already_delivered";
  requestId: string;
  requestDigest: Uint8Array;
}>;

export interface PendingDomainKeyRecipientRequest {
  readonly requestId: string;
  readonly requestBytes: Uint8Array;
  readonly requestDigest: Uint8Array;
  readonly domainId: string;
  readonly keyClass: KeyClass;
  readonly domainKeyGeneration: number;
  readonly authorizationRevision: number;
  readonly headDigest: Uint8Array;
  readonly recipientHumanId: string;
  readonly recipientDeviceId: string;
  readonly recipientDeviceGeneration: number;
  readonly recipientSigningPublicKey: Uint8Array;
  readonly recipientEncryptionPublicKey: Uint8Array;
  readonly recipientPublicKeyDigest: Uint8Array;
}

export type DomainKeyRecipientFulfilmentResult = Readonly<{
  status: "fulfilled" | "replayed" | "lost_race";
  requestId: string;
  envelopeDigest: Uint8Array;
  authorizationDigest: Uint8Array;
}>;

export type DomainKeyEnvelopeFetchResult =
  | Readonly<{
      status: "ready";
      requestDigest: Uint8Array | null;
      envelopeBytes: Uint8Array;
      envelopeDigest: Uint8Array;
      issuerSigningPublicKey: Uint8Array;
    }>
  | Readonly<{
      status: "pending" | "unavailable";
    }>;

export type DomainKeyEnvelopeAcknowledgementResult = Readonly<{
  status: "acknowledged" | "replayed";
  acknowledgementDigest: Uint8Array;
}>;

export type DomainForegroundAuthorityInspectionV2 =
  | Readonly<{
      status: "ready";
      committerDeviceId: string;
      committerDeviceSigningGeneration: number;
      hostAuthorizationRevision: number;
      domains: readonly DomainForegroundAuthorityEntry[];
    }>
  | Readonly<{
      status: "unavailable";
      reason: "recipient_sync_required";
      requiredNamespaceIds: readonly string[];
    }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "namespace_set_invalid"
        | "device_unavailable"
        | "namespace_bundle_unavailable"
        | "authority_inconsistent";
    }>;

export type DomainForegroundNamespaceAuthorityInspectionV2 = Readonly<{
  status: "ready";
  namespaceId: string;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  namespaceHeadDigest: Uint8Array;
  namespacePublicationDigest: Uint8Array;
  namespacePublicationSetDigest: Uint8Array;
  namespaceAudienceFingerprint: Uint8Array;
  domainId: string;
  domainKeyGeneration: number;
  domainAuthorizationRevision: number;
  domainHeadDigest: Uint8Array;
  bundleRevision: number;
  bundleDigest: Uint8Array;
}>;

export type DomainRetainedNamespaceGenerationAuthorityV2 = Readonly<{
  status: "ready";
  namespaceId: string;
  keyClass: KeyClass;
  generation: number;
  accessRevision: number;
  /**
   * Signed retained-set commitment from the binding whose current generation
   * is exactly `generation`. This is historical evidence, never the current
   * Namespace head relabelled with an older coordinate.
   */
  headDigest: Uint8Array;
  committerDeviceId: string;
  committerDeviceSigningPublicKey: Uint8Array;
}>;

export type DomainNamespaceGenerationAuthorityMetadataV2 = Readonly<{
  status: "ready";
  namespaceId: string;
  currentGeneration: number;
  retainedGenerations: readonly Readonly<{
    generation: number;
    accessRevision: number;
    headDigest: Uint8Array;
    publicationDigest: Uint8Array;
    publicationSetDigest: Uint8Array;
    audienceFingerprint: Uint8Array;
  }>[];
}>;

function verifiedNamespaceBindingMetadata(input: Readonly<{
  crypto: LatticeCrypto;
  serverId: string;
  namespaceId: string;
  keyClass: KeyClass;
  generation: number;
  accessRevision: number;
  row: Readonly<{
    binding_bytes: Uint8Array;
    binding_digest: Uint8Array;
    signing_public_key: Uint8Array;
  }>;
}>): Readonly<{ retainedAuthoritySetDigest: Uint8Array }> | null {
  const bindingBytes = copyBytes(input.row.binding_bytes);
  const bindingDigest = copyBytes(input.row.binding_digest);
  const signingPublicKey = copyBytes(input.row.signing_public_key);
  const binding = verifyDomainNamespaceBundleBindingV2(input.crypto, {
    bindingBytes, expectedBindingDigest: bindingDigest,
    issuerSigningPublicKey: signingPublicKey,
  });
  try {
    if (binding === null || binding.serverId !== input.serverId
      || binding.namespaceId !== input.namespaceId
      || binding.keyClass !== input.keyClass
      || binding.namespaceCurrentGeneration !== input.generation
      || binding.namespaceAccessRevision !== input.accessRevision) return null;
    return Object.freeze({
      retainedAuthoritySetDigest: binding.retainedAuthoritySetDigest.slice(),
    });
  } finally {
    if (binding !== null) destroyDomainNamespaceBundleBindingV2(binding);
    wipe([bindingBytes, bindingDigest, signingPublicKey]);
  }
}

export type DomainNamespaceBundlePlan =
  | Readonly<{
      status: "create_required";
      domainId: string;
      participantDigest: Uint8Array;
      participantCount: number;
      keyClass: KeyClass;
      domainKeyGeneration: number;
      domainAuthorizationRevision: number;
      domainHeadDigest: Uint8Array;
      namespaceId: string;
      namespaceAccessRevision: number;
      namespaceCurrentGeneration: 0;
      bundleRevision: 1;
      retainedGenerationCount: 1;
      previousBindingDigest: null;
      issuerHumanId: string;
      issuerDeviceId: string;
      issuerDeviceSigningGeneration: number;
      issuerSigningPublicKey: Uint8Array;
    }>
  | Readonly<{
      status: "replace_required";
      domainId: string;
      participantDigest: Uint8Array;
      participantCount: number;
      keyClass: KeyClass;
      domainKeyGeneration: number;
      domainAuthorizationRevision: number;
      domainHeadDigest: Uint8Array;
      namespaceId: string;
      namespaceAccessRevision: number;
      namespaceCurrentGeneration: number;
      bundleRevision: number;
      retainedGenerationCount: number;
      advanceGeneration: boolean;
      previousBindingDigest: Uint8Array;
      sourceBindingBytes: Uint8Array;
      sourceBindingDigest: Uint8Array;
      sourceIssuerSigningPublicKey: Uint8Array;
      sourceEnvelopeBytes: Uint8Array;
      sourceEnvelopeDigest: Uint8Array;
      sourceEnvelopeIssuerSigningPublicKey: Uint8Array;
      sourceRecipientDeviceSigningGeneration: number;
      issuerHumanId: string;
      issuerDeviceId: string;
      issuerDeviceSigningGeneration: number;
      issuerSigningPublicKey: Uint8Array;
    }>
  | Readonly<{
      status: "ready";
      domainId: string;
      keyClass: KeyClass;
      bindingBytes: Uint8Array;
      bindingDigest: Uint8Array;
      issuerSigningPublicKey: Uint8Array;
    }>
  | Readonly<{
      status: "unavailable";
      reason: DomainKeyAuthorityUnavailableReason;
    }>;

export type DomainNamespaceBundlePublicationResult = Readonly<{
  status: "published" | "replayed";
  operationId: string;
  namespaceId: string;
  domainId: string;
  keyClass: KeyClass;
  bindingDigest: Uint8Array;
}>;

type ProductSnapshot = ReturnType<
  typeof inspectNamespaceProductAuthoritySnapshot
>;

type DomainContext = Readonly<{
  domainId: string;
  participantDigest: Uint8Array;
  participantCount: number;
}>;

type Device = Readonly<{
  humanId: string;
  deviceId: string;
  deviceGeneration: number;
  revision: number;
  signingPublicKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  encryptionPublicKeyDigest: Uint8Array;
}>;

type Recipient = Readonly<{
  humanId: string;
  kind: "device" | "recovery";
  keyId: string;
  generation: number;
  publicKey: Uint8Array;
  publicKeyDigest: Uint8Array;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function wipe(values: readonly (Uint8Array | null | undefined)[]): void {
  values.forEach((value) => value?.fill(0));
}

function copyBytes(value: DatabaseScalar): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError("Expected bytea");
  return new Uint8Array(value);
}

function requiredText(value: DatabaseScalar): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError("Expected text");
  }
  return value;
}

function requiredTextArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("Expected text array");
  const entries = value as readonly unknown[];
  if (entries.some((entry) => typeof entry !== "string")) {
    throw new TypeError("Expected text array");
  }
  return entries as readonly string[];
}

function requiredCounter(value: DatabaseScalar): number {
  const number = typeof value === "bigint" ? Number(value)
    : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || (number as number) < 0) {
    throw new TypeError("Expected safe counter");
  }
  return number as number;
}

function nullableBytes(value: DatabaseScalar): Uint8Array | null {
  return value === null ? null : copyBytes(value);
}

function scalarBytesEqual(value: DatabaseScalar, expected: Uint8Array): boolean {
  const bytes = copyBytes(value);
  try {
    return sameBytes(bytes, expected);
  } finally {
    bytes.fill(0);
  }
}

function keyClass(value: string): KeyClass {
  if (value !== "human" && value !== "ai") {
    throw new TypeError("Domain key class is invalid");
  }
  return value;
}

async function loadDomain(
  executor: CryptoPostgresExecutor,
  snapshot: ProductSnapshot,
): Promise<DomainContext | null> {
  const digest = participantDigest(snapshot.participantHumanIds);
  try {
    const rows = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        domain_id: cryptoDomains.id,
        participant_digest: cryptoDomains.participantDigest,
        participants: cryptoDomains.participants,
      }).from(cryptoDomains).where(and(
        eq(cryptoDomains.participantDigest, digest),
        eq(cryptoDomains.participants, [...snapshot.participantHumanIds]),
      )).limit(2).for("share"),
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new TypeError("Crypto Domain is ambiguous");
    const row = rows[0]!;
    const storedDigest = copyBytes(row.participant_digest);
    try {
      if (!sameBytes(storedDigest, digest)) {
        throw new TypeError("Crypto Domain participant digest disagrees");
      }
      return Object.freeze({
        domainId: requiredText(row.id),
        participantDigest: storedDigest.slice(),
        participantCount: snapshot.participantHumanIds.length,
      });
    } finally {
      storedDigest.fill(0);
    }
  } finally {
    digest.fill(0);
  }
}

async function loadOrCreateDomain(
  executor: CryptoPostgresExecutor,
  snapshot: ProductSnapshot,
  createDomainId: () => string,
): Promise<DomainContext> {
  const digest = participantDigest(snapshot.participantHumanIds);
  try {
    // Every Domain creator in the restricted store uses the same digest lock.
    // Exact participants remain the authority, so even a digest collision can
    // create a distinct random Domain id rather than aliasing another roster.
    await executor.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(encode($1::bytea, 'hex'), 0)
       )`,
      [digest],
    );
    const existing = await loadDomain(executor, snapshot);
    if (existing !== null) return existing;
    const domainId = createDomainId();
    await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.insert(cryptoDomains).values({
        id: domainId,
        participantDigest: digest,
        participants: [...snapshot.participantHumanIds],
        epoch: 0,
        authorizationRevision: 0,
        // V2 Domain authority is independent from provider/MLS state. The
        // exact canonical participant array above is the roster authority;
        // this non-secret marker prevents inventing a provider snapshot.
        rosterBytes: Uint8Array.of(2),
      }),
    );
    return Object.freeze({
      domainId,
      participantDigest: digest.slice(),
      participantCount: snapshot.participantHumanIds.length,
    });
  } finally {
    digest.fill(0);
  }
}

function currentHumanDeviceMembershipHead() {
  return and(
    eq(humanCryptoDevices.membershipState, "current"),
    eq(
      humanCryptoDevices.membershipServerInstanceId,
      humanCryptoDeviceGroupHeads.serverInstanceId,
    ),
    eq(
      humanCryptoDevices.membershipLineageGeneration,
      humanCryptoDeviceGroupHeads.lineageGeneration,
    ),
    eq(humanCryptoDevices.membershipEpoch, humanCryptoDeviceGroupHeads.epoch),
    eq(
      humanCryptoDevices.membershipSecurityRevision,
      humanCryptoDeviceGroupHeads.securityRevision,
    ),
    eq(
      humanCryptoDevices.membershipHeadDigest,
      humanCryptoDeviceGroupHeads.headDigest,
    ),
  );
}

async function loadDevice(
  executor: CryptoPostgresExecutor,
  crypto: Pick<LatticeCrypto, "hash">,
  deviceId: string,
  expectedHumanId?: string,
): Promise<Device | null> {
  const rows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      human_id: humanCryptoDevices.humanId,
      device_id: humanCryptoDevices.deviceId,
      device_generation: humanCryptoDevices.deviceGeneration,
      revision: humanCryptoDevices.revision,
      signing_public_key: humanCryptoDevices.signingPublicKey,
      encryption_public_key: humanCryptoDevices.encryptionPublicKey,
    }).from(humanCryptoDevices).innerJoin(
      humanCryptoDeviceGroupHeads,
      eq(humanCryptoDeviceGroupHeads.humanId, humanCryptoDevices.humanId),
    ).where(and(
      eq(humanCryptoDevices.deviceId, deviceId),
      eq(humanCryptoDevices.state, "active"),
      currentHumanDeviceMembershipHead(),
    )).for("share"),
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new TypeError("Crypto device is ambiguous");
  const row = rows[0]!;
  const humanId = requiredText(row.human_id);
  if (expectedHumanId !== undefined && humanId !== expectedHumanId) return null;
  const encryptionPublicKey = copyBytes(row.encryption_public_key);
  return Object.freeze({
    humanId,
    deviceId: requiredText(row.device_id),
    deviceGeneration: requiredCounter(row.device_generation),
    revision: requiredCounter(row.revision),
    signingPublicKey: copyBytes(row.signing_public_key),
    encryptionPublicKey,
    encryptionPublicKeyDigest: crypto.hash(encryptionPublicKey),
  });
}

function destroyDevice(device: Device | null): void {
  device?.signingPublicKey.fill(0);
  device?.encryptionPublicKey.fill(0);
  device?.encryptionPublicKeyDigest.fill(0);
}

async function loadCurrentRecoveryRecipient(
  executor: CryptoPostgresExecutor,
  humanId: string,
): Promise<Recipient | null> {
  const rows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      recovery_key_id: humanCryptoRecoveryKeys.recoveryKeyId,
      generation: humanCryptoRecoveryKeys.generation,
      public_key: humanCryptoRecoveryKeys.publicKey,
      public_key_digest: humanCryptoRecoveryKeys.publicKeyDigest,
    }).from(humanCryptoRecoveryKeys).where(and(
      eq(humanCryptoRecoveryKeys.humanId, humanId),
      eq(humanCryptoRecoveryKeys.state, "current"),
    )).limit(2).for("share"),
  );
  if (rows.length !== 1) return null;
  return Object.freeze({
    humanId,
    kind: "recovery" as const,
    keyId: requiredText(rows[0]!.recovery_key_id),
    generation: requiredCounter(rows[0]!.generation),
    publicKey: copyBytes(rows[0]!.public_key),
    publicKeyDigest: copyBytes(rows[0]!.public_key_digest),
  });
}

function deviceRecipient(device: Device): Recipient {
  return Object.freeze({
    humanId: device.humanId,
    kind: "device" as const,
    keyId: device.deviceId,
    generation: device.deviceGeneration,
    publicKey: device.encryptionPublicKey.slice(),
    publicKeyDigest: device.encryptionPublicKeyDigest.slice(),
  });
}

function destroyRecipient(recipient: Recipient | null): void {
  recipient?.publicKey.fill(0);
  recipient?.publicKeyDigest.fill(0);
}

async function loadSigningPublicKey(
  executor: CryptoPostgresExecutor,
  deviceId: string,
  generation: number,
): Promise<Uint8Array | null> {
  const rows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      signing_public_key: humanCryptoDevices.signingPublicKey,
    }).from(humanCryptoDevices).where(and(
      eq(humanCryptoDevices.deviceId, deviceId),
      eq(humanCryptoDevices.deviceGeneration, generation),
    )).limit(2),
  );
  return rows.length === 1 ? copyBytes(rows[0]!.signing_public_key) : null;
}

function headCoordinatesMatch(
  head: ReturnType<typeof verifyDomainKeyHead> & object,
  input: Readonly<{
    serverId: string;
    domain: DomainContext;
    keyClass: KeyClass;
    issuer: Device;
    operationId: string;
  }>,
): boolean {
  return head.serverId === input.serverId
    && head.cryptoDomainId === input.domain.domainId
    && sameBytes(head.participantDigest, input.domain.participantDigest)
    && head.participantCount === input.domain.participantCount
    && head.keyClass === input.keyClass
    && Number.isSafeInteger(head.domainKeyGeneration)
    && head.domainKeyGeneration >= 1
    && Number.isSafeInteger(head.authorizationRevision)
    && head.authorizationRevision >= 1
    && (head.domainKeyGeneration === 1
      ? head.authorizationRevision === 1
        && head.previousHeadDigest === null
      : head.previousHeadDigest !== null)
    && head.publicationOperationId === input.operationId
    && head.issuerHumanId === input.issuer.humanId
    && head.issuerDeviceId === input.issuer.deviceId
    && head.issuerDeviceSigningGeneration === input.issuer.deviceGeneration;
}

function envelopeCoordinatesMatch(
  envelope: ReturnType<typeof verifyDomainKeyRecipientEnvelope> & object,
  input: Readonly<{
    serverId: string;
    domain: DomainContext;
    keyClass: KeyClass;
    headDigest: Uint8Array;
    headGeneration: number;
    authorizationRevision: number;
    target: Recipient;
    issuer: Device;
  }>,
): boolean {
  return envelope.serverId === input.serverId
    && envelope.cryptoDomainId === input.domain.domainId
    && sameBytes(envelope.participantDigest, input.domain.participantDigest)
    && envelope.participantCount === input.domain.participantCount
    && envelope.keyClass === input.keyClass
    && envelope.domainKeyGeneration === input.headGeneration
    && envelope.authorizationRevision === input.authorizationRevision
    && sameBytes(envelope.headDigest, input.headDigest)
    && envelope.recipientHumanId === input.target.humanId
    && envelope.recipientKind === input.target.kind
    && envelope.recipientKeyId === input.target.keyId
    && envelope.recipientKeyGeneration === input.target.generation
    && sameBytes(
      envelope.recipientPublicKeyDigest,
      input.target.publicKeyDigest,
    )
    && envelope.issuerHumanId === input.issuer.humanId
    && envelope.issuerDeviceId === input.issuer.deviceId
    && envelope.issuerDeviceSigningGeneration === input.issuer.deviceGeneration;
}

function destroyDomain(domain: DomainContext | null): void {
  domain?.participantDigest.fill(0);
}

/**
 * M301's restricted V2 store. It performs only exact Domain, recipient, and
 * Namespace operations; product membership remains held by the opaque Room
 * snapshot for the complete callback lifetime.
 */
export class PostgresDomainKeyAuthorityRepository {
  constructor(
    private readonly restricted: PostgresJsBridgeConnection,
    private readonly crypto: LatticeCrypto,
    private readonly serverId: string,
    private readonly createDomainId: () => string = () =>
      `domain-v2:${randomUUID()}`,
  ) {}

  async inspectForegroundAuthority(input: Readonly<{
    namespaceIds: readonly string[];
    keyClass: KeyClass;
    subjectHumanId: string;
    deviceId: string;
  }>): Promise<DomainForegroundAuthorityInspectionV2> {
    return this.#inspectForegroundAuthority(input, true);
  }

  /** Fresh signing evidence for a read-only foreground authorization. */
  async inspectForegroundDeviceSigningAuthority(input: Readonly<{
    userId: string;
    subjectHumanId: string;
    deviceId: string;
    generation: number;
    revision: number;
  }>): Promise<Uint8Array | null> {
    return this.restricted.transactionOnce(async (transaction) => {
      const rows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({ signing_public_key: humanCryptoDevices.signingPublicKey })
          .from(humanCryptoDevices)
          .innerJoin(humanCryptoCustodies,
            eq(humanCryptoCustodies.humanId, humanCryptoDevices.humanId))
          .innerJoin(humanCryptoDeviceGroupHeads,
            eq(humanCryptoDeviceGroupHeads.humanId, humanCryptoDevices.humanId))
          .where(and(
            eq(humanCryptoDevices.userId, input.userId),
            eq(humanCryptoDevices.humanId, input.subjectHumanId),
            eq(humanCryptoDevices.deviceId, input.deviceId),
            eq(humanCryptoDevices.deviceGeneration, input.generation),
            eq(humanCryptoDevices.revision, input.revision),
            eq(humanCryptoDevices.state, "active"),
            eq(humanCryptoCustodies.state, "active"),
            currentHumanDeviceMembershipHead(),
          )).for("share"),
      );
      return rows.length === 1 ? copyBytes(rows[0]!.signing_public_key) : null;
    });
  }

  async #inspectForegroundAuthority(input: Readonly<{
    namespaceIds: readonly string[];
    keyClass: KeyClass;
    subjectHumanId: string;
    deviceId: string;
  }>, requireRecipient: boolean): Promise<DomainForegroundAuthorityInspectionV2> {
    const namespaceIds = [...new Set(input.namespaceIds)].sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))
    );
    if (
      namespaceIds.length < 1
      || namespaceIds.length !== input.namespaceIds.length
      || namespaceIds.length > LATTICE_LIMITS.agentGrantNamespaces
    ) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "namespace_set_invalid",
      });
    }
    return this.restricted.transactionOnce(async (transaction) => {
      const deviceRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          device_id: humanCryptoDevices.deviceId,
          device_generation: humanCryptoDevices.deviceGeneration,
          revision: humanCryptoDevices.revision,
        }).from(humanCryptoDevices).innerJoin(
          humanCryptoCustodies,
          eq(humanCryptoCustodies.humanId, humanCryptoDevices.humanId),
        ).innerJoin(
          humanCryptoDeviceGroupHeads,
          eq(humanCryptoDeviceGroupHeads.humanId, humanCryptoDevices.humanId),
        ).where(and(
          eq(humanCryptoDevices.deviceId, input.deviceId),
          eq(humanCryptoDevices.humanId, input.subjectHumanId),
          eq(humanCryptoDevices.state, "active"),
          currentHumanDeviceMembershipHead(),
          eq(humanCryptoCustodies.state, "active"),
        )).for("share"),
      );
      if (deviceRows.length !== 1) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "device_unavailable",
        });
      }
      const device = deviceRows[0]!;
      const rows: Array<{
        namespace_id: string;
        domain_id: string;
        domain_key_generation: number;
        domain_authorization_revision: number;
        domain_head_digest: Uint8Array;
        binding_digest: Uint8Array;
      }> = [];
      for (
        let offset = 0;
        offset < namespaceIds.length;
        offset += FOREGROUND_AUTHORITY_NAMESPACE_QUERY_BATCH
      ) {
        const batch = namespaceIds.slice(
          offset,
          offset + FOREGROUND_AUTHORITY_NAMESPACE_QUERY_BATCH,
        );
        rows.push(...await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            namespace_id: namespaceDomainKeyHeads.namespaceId,
            domain_id: namespaceDomainKeyHeads.domainId,
            domain_key_generation: namespaceDomainKeyHeads.domainKeyGeneration,
            domain_authorization_revision:
              namespaceDomainKeyHeads.domainAuthorizationRevision,
            domain_head_digest: namespaceDomainKeyHeads.domainHeadDigest,
            binding_digest: namespaceDomainKeyHeads.bindingDigest,
          }).from(namespaceDomainKeyHeads).where(and(
            inArray(namespaceDomainKeyHeads.namespaceId, batch),
            eq(namespaceDomainKeyHeads.keyClass, input.keyClass),
          )).orderBy(asc(namespaceDomainKeyHeads.namespaceId)).for("share"),
        ));
      }
      if (rows.length !== namespaceIds.length) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "namespace_bundle_unavailable",
        });
      }
      const grouped = new Map<string, Array<{
        namespaceId: string;
        bindingDigest: Uint8Array;
        domainKeyGeneration: number;
        authorizationRevision: number;
        headDigest: Uint8Array;
      }>>();
      try {
        const remainingNamespaces = new Set(namespaceIds);
        for (const row of rows) {
          const namespaceId = requiredText(row.namespace_id);
          const domainId = requiredText(row.domain_id);
          if (!remainingNamespaces.delete(namespaceId)) {
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent",
            });
          }
          const entry = {
            namespaceId,
            bindingDigest: copyBytes(row.binding_digest),
            domainKeyGeneration: requiredCounter(row.domain_key_generation),
            authorizationRevision:
              requiredCounter(row.domain_authorization_revision),
            headDigest: copyBytes(row.domain_head_digest),
          };
          const current = grouped.get(domainId);
          if (current === undefined) grouped.set(domainId, [entry]);
          else current.push(entry);
        }
        if (remainingNamespaces.size !== 0) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "authority_inconsistent",
          });
        }
        const domainIds = [...grouped.keys()].sort((left, right) =>
          Buffer.from(left).compare(Buffer.from(right))
        );
        if (domainIds.length > LATTICE_LIMITS.agentGrantDomains) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "namespace_set_invalid" as const,
          });
        }
        const headRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_id: domainKeyHeads.domainId,
            participant_digest: domainKeyHeads.participantDigest,
            participant_count: domainKeyHeads.participantCount,
            domain_key_generation: domainKeyHeads.domainKeyGeneration,
            authorization_revision: domainKeyHeads.authorizationRevision,
            head_digest: domainKeyHeads.headDigest,
          }).from(domainKeyHeads).where(and(
            inArray(domainKeyHeads.domainId, domainIds),
            eq(domainKeyHeads.keyClass, input.keyClass),
          )).orderBy(asc(domainKeyHeads.domainId)).for("share"),
        );
        if (headRows.length !== domainIds.length) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "authority_inconsistent",
          });
        }
        const headsByDomain = new Map<string, (typeof headRows)[number]>();
        for (const head of headRows) {
          const domainId = requiredText(head.domain_id);
          if (!grouped.has(domainId) || headsByDomain.has(domainId)) {
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent",
            });
          }
          headsByDomain.set(domainId, head);
        }
        const recipientRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_id: domainKeyRecipientEnvelopes.domainId,
          }).from(domainKeyRecipientEnvelopes).innerJoin(
            domainKeyHeads,
            and(
              eq(
                domainKeyHeads.domainId,
                domainKeyRecipientEnvelopes.domainId,
              ),
              eq(
                domainKeyHeads.keyClass,
                domainKeyRecipientEnvelopes.keyClass,
              ),
              eq(
                domainKeyHeads.domainKeyGeneration,
                domainKeyRecipientEnvelopes.domainKeyGeneration,
              ),
              eq(
                domainKeyHeads.authorizationRevision,
                domainKeyRecipientEnvelopes.authorizationRevision,
              ),
              eq(
                domainKeyHeads.headDigest,
                domainKeyRecipientEnvelopes.headDigest,
              ),
            ),
          ).where(and(
            inArray(domainKeyRecipientEnvelopes.domainId, domainIds),
            eq(domainKeyRecipientEnvelopes.keyClass, input.keyClass),
            eq(
              domainKeyRecipientEnvelopes.recipientHumanId,
              input.subjectHumanId,
            ),
            eq(domainKeyRecipientEnvelopes.recipientKind, "device"),
            eq(domainKeyRecipientEnvelopes.recipientKeyId, input.deviceId),
            eq(
              domainKeyRecipientEnvelopes.recipientKeyGeneration,
              requiredCounter(device.device_generation),
            ),
          )).orderBy(asc(domainKeyRecipientEnvelopes.domainId)),
        );
        const recipientCounts = new Map<string, number>();
        for (const row of recipientRows) {
          const domainId = requiredText(row.domain_id);
          if (!grouped.has(domainId)) {
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent",
            });
          }
          recipientCounts.set(domainId, (recipientCounts.get(domainId) ?? 0) + 1);
        }
        const domains: DomainForegroundAuthorityEntry[] = [];
        const missingRecipientNamespaceIds: string[] = [];
        for (const [domainId, entries] of grouped) {
          const first = entries[0]!;
          const head = headsByDomain.get(domainId);
          if (head === undefined) {
            domains.forEach((entry) => wipe([
              entry.participantDigest,
              entry.headDigest,
              entry.activeNamespaceBindingSetDigest,
            ]));
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent",
            });
          }
          const participantDigest = copyBytes(head.participant_digest);
          const headDigest = copyBytes(head.head_digest);
          const participantCount = requiredCounter(head.participant_count);
          const domainKeyGeneration = requiredCounter(
            head.domain_key_generation,
          );
          const currentAuthorizationRevision = requiredCounter(
            head.authorization_revision,
          );
          if (entries.some((entry) =>
            entry.domainKeyGeneration !== domainKeyGeneration
            || entry.authorizationRevision !== first.authorizationRevision
            || entry.authorizationRevision !== currentAuthorizationRevision
            || !sameBytes(entry.headDigest, headDigest)
          )) {
            wipe([participantDigest, headDigest]);
            domains.forEach((entry) => wipe([
              entry.participantDigest,
              entry.headDigest,
              entry.activeNamespaceBindingSetDigest,
            ]));
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent",
            });
          }
          const recipientCount = recipientCounts.get(domainId) ?? 0;
          if (recipientCount > 1 || (requireRecipient && recipientCount === 0)) {
            if (recipientCount > 1) {
              wipe([participantDigest, headDigest]);
              domains.forEach((entry) => wipe([
                entry.participantDigest,
                entry.headDigest,
                entry.activeNamespaceBindingSetDigest,
              ]));
              return Object.freeze({
                status: "unavailable" as const,
                reason: "authority_inconsistent",
              });
            }
            missingRecipientNamespaceIds.push(
              ...entries.map((entry) => entry.namespaceId),
            );
            wipe([participantDigest, headDigest]);
            continue;
          }
          const bindingSetDigest = domainForegroundNamespaceBindingSetDigest(
            this.crypto,
            entries.map((entry) => ({
              namespaceId: entry.namespaceId,
              bindingDigest: entry.bindingDigest,
            })),
          );
          domains.push(Object.freeze({
            domainId,
            sourceNamespaceId: first.namespaceId,
            participantDigest,
            participantCount,
            keyClass: "ai" as const,
            domainKeyGeneration,
            authorizationRevision: authorizationRevision(
              currentAuthorizationRevision,
            ),
            headDigest,
            activeNamespaceBindingSetDigest: bindingSetDigest,
            activeNamespaceBindingCount: entries.length,
          }));
        }
        domains.sort((left, right) =>
          Buffer.from(left.domainId).compare(Buffer.from(right.domainId))
        );
        if (missingRecipientNamespaceIds.length > 0) {
          domains.forEach((entry) => wipe([
            entry.participantDigest,
            entry.headDigest,
            entry.activeNamespaceBindingSetDigest,
          ]));
          return Object.freeze({
            status: "unavailable" as const,
            reason: "recipient_sync_required" as const,
            requiredNamespaceIds: Object.freeze(
              missingRecipientNamespaceIds.sort((left, right) =>
                Buffer.from(left).compare(Buffer.from(right))
              ),
            ),
          });
        }
        return Object.freeze({
          status: "ready" as const,
          committerDeviceId: requiredText(device.device_id),
          committerDeviceSigningGeneration:
            requiredCounter(device.device_generation),
          hostAuthorizationRevision: requiredCounter(device.revision),
          domains: Object.freeze(domains),
        });
      } finally {
        for (const entries of grouped.values()) {
          entries.forEach((entry) => wipe([
            entry.bindingDigest,
            entry.headDigest,
          ]));
        }
      }
    });
  }

  async inspectForegroundNamespaceAuthority(input: Readonly<{
    namespaceId: string;
    keyClass: KeyClass;
  }>): Promise<
    | DomainForegroundNamespaceAuthorityInspectionV2
    | Readonly<{ status: "unavailable"; reason: string }>
  > {
    return this.restricted.transactionOnce(async (transaction) => {
      const rows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          namespace_id: namespaceDomainKeyHeads.namespaceId,
          namespace_access_revision:
            namespaceDomainKeyHeads.namespaceAccessRevision,
          namespace_current_generation:
            namespaceDomainKeyHeads.namespaceCurrentGeneration,
          domain_id: namespaceDomainKeyHeads.domainId,
          domain_key_generation: namespaceDomainKeyHeads.domainKeyGeneration,
          domain_authorization_revision:
            namespaceDomainKeyHeads.domainAuthorizationRevision,
          domain_head_digest: namespaceDomainKeyHeads.domainHeadDigest,
          bundle_revision: namespaceDomainKeyHeads.bundleRevision,
          retained_generation_count:
            namespaceDomainKeyHeads.retainedGenerationCount,
          retained_authority_set_digest:
            namespaceDomainKeyHeads.retainedAuthoritySetDigest,
          binding_digest: namespaceDomainKeyHeads.bindingDigest,
        }).from(namespaceDomainKeyHeads).where(and(
          eq(namespaceDomainKeyHeads.namespaceId, input.namespaceId),
          eq(namespaceDomainKeyHeads.keyClass, input.keyClass),
        )).limit(2).for("share"),
      );
      if (rows.length !== 1) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "namespace_bundle_unavailable",
        });
      }
      const row = rows[0]!;
      const namespaceAccessRevision = requiredCounter(
        row.namespace_access_revision,
      );
      const retainedDigest = copyBytes(row.retained_authority_set_digest);
      const domainHeadDigest = copyBytes(row.domain_head_digest);
      const bundleDigest = copyBytes(row.binding_digest);
      const bundleRevision = requiredCounter(row.bundle_revision);
      try {
        const namespaceKeyGeneration = requiredCounter(
          row.namespace_current_generation,
        );
        const retainedGenerationCount = requiredCounter(
          row.retained_generation_count,
        );
        if (
          bundleRevision < 1
          || requiredText(row.namespace_id) !== input.namespaceId
          || retainedGenerationCount !== namespaceKeyGeneration + 1
        ) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "authority_inconsistent",
          });
        }
        return Object.freeze({
          status: "ready" as const,
          namespaceId: input.namespaceId,
          namespaceAccessRevision,
          namespaceKeyGeneration,
          // Foreground Message formats predate native V2 and require four
          // stable Namespace authority digests. The V2 retained-set digest is
          // the authenticated, per-generation-prefix commitment that replaces
          // all four V1 publication coordinates without reading V1 tables.
          namespaceHeadDigest: retainedDigest.slice(),
          namespacePublicationDigest: retainedDigest.slice(),
          namespacePublicationSetDigest: retainedDigest.slice(),
          namespaceAudienceFingerprint: retainedDigest.slice(),
          domainId: requiredText(row.domain_id),
          domainKeyGeneration: requiredCounter(row.domain_key_generation),
          domainAuthorizationRevision:
            requiredCounter(row.domain_authorization_revision),
          domainHeadDigest: domainHeadDigest.slice(),
          bundleRevision,
          bundleDigest: bundleDigest.slice(),
        });
      } finally {
        wipe([retainedDigest, domainHeadDigest, bundleDigest]);
      }
    });
  }

  async inspectRetainedNamespaceGenerationAuthority(input: Readonly<{
    namespaceId: string;
    keyClass: KeyClass;
    generation: number;
    accessRevision: number;
    subjectHumanId: string;
    readerDeviceId: string;
    committerHumanId: string;
    committerDeviceId: string;
    committerHostAuthorizationRevision: number;
  }>): Promise<
    | DomainRetainedNamespaceGenerationAuthorityV2
    | Readonly<{ status: "unavailable"; reason: string }>
  > {
    namespaceGeneration(input.generation);
    authorizationRevision(input.accessRevision);
    authorizationRevision(input.committerHostAuthorizationRevision);
    humanId(input.subjectHumanId);
    cryptoDeviceId(input.readerDeviceId);
    humanId(input.committerHumanId);
    cryptoDeviceId(input.committerDeviceId);
    return this.restricted.transactionOnce(async (transaction) => {
      const readerRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({ device_id: humanCryptoDevices.deviceId })
          .from(humanCryptoDevices)
          .innerJoin(humanCryptoCustodies, eq(
            humanCryptoCustodies.humanId,
            humanCryptoDevices.humanId,
          ))
          .where(and(
            eq(humanCryptoDevices.deviceId, input.readerDeviceId),
            eq(humanCryptoDevices.humanId, input.subjectHumanId),
            eq(humanCryptoDevices.state, "active"),
            eq(humanCryptoCustodies.state, "active"),
          )).for("share", {
            of: [humanCryptoDevices, humanCryptoCustodies],
          }),
      );
      if (readerRows.length !== 1) {
        return Object.freeze({ status: "unavailable" as const, reason: "device_unavailable" });
      }
      const committerRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          device_id: humanCryptoDevices.deviceId,
          signing_public_key: humanCryptoDevices.signingPublicKey,
          revision: humanCryptoDevices.revision,
          state: humanCryptoDevices.state,
        }).from(humanCryptoDevices).where(and(
          eq(humanCryptoDevices.deviceId, input.committerDeviceId),
          eq(humanCryptoDevices.humanId, input.committerHumanId),
          inArray(humanCryptoDevices.state, ["active", "revoked"]),
        )),
      );
      if (committerRows.length !== 1
        || requiredCounter(committerRows[0]!.revision)
          < input.committerHostAuthorizationRevision) {
        return Object.freeze({ status: "unavailable" as const, reason: "committer_unavailable" });
      }
      const rows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          binding_bytes: namespaceDomainKeyBindings.bindingBytes,
          binding_digest: namespaceDomainKeyBindings.bindingDigest,
          signing_public_key: humanCryptoDevices.signingPublicKey,
        }).from(namespaceDomainKeyBindings).innerJoin(
          humanCryptoDevices,
          and(
            eq(humanCryptoDevices.deviceId, namespaceDomainKeyBindings.issuerDeviceId),
            eq(humanCryptoDevices.humanId, namespaceDomainKeyBindings.issuerHumanId),
          ),
        ).where(and(
          eq(namespaceDomainKeyBindings.namespaceId, input.namespaceId),
          eq(namespaceDomainKeyBindings.keyClass, input.keyClass),
          eq(namespaceDomainKeyBindings.namespaceCurrentGeneration, input.generation),
          eq(namespaceDomainKeyBindings.namespaceAccessRevision, input.accessRevision),
          inArray(namespaceDomainKeyBindings.state, ["active", "stale"]),
        // Recipient/domain catch-up may publish several bindings at the same
        // retained generation and access revision. The newest signed binding
        // is the canonical retained evidence for that exact coordinate.
        )).orderBy(desc(namespaceDomainKeyBindings.bundleRevision)).limit(1),
      );
      if (rows.length !== 1) {
        return Object.freeze({ status: "unavailable" as const, reason: "binding_unavailable" });
      }
      const row = rows[0]!;
      const binding = verifiedNamespaceBindingMetadata({
        crypto: this.crypto, serverId: this.serverId,
        namespaceId: input.namespaceId, keyClass: input.keyClass,
        generation: input.generation, accessRevision: input.accessRevision,
        row,
      });
      if (binding === null) {
        return Object.freeze({ status: "unavailable" as const, reason: "binding_invalid" });
      }
      return Object.freeze({
        status: "ready" as const,
        namespaceId: input.namespaceId,
        keyClass: input.keyClass,
        generation: input.generation,
        accessRevision: input.accessRevision,
        headDigest: binding.retainedAuthoritySetDigest,
        committerDeviceId: requiredText(committerRows[0]!.device_id),
        committerDeviceSigningPublicKey:
          copyBytes(committerRows[0]!.signing_public_key),
      });
    });
  }

  /**
   * Trusted-server-only public metadata inspection. The caller must establish
   * product Namespace authority before exporting any returned descriptor.
   * Exact historical envelope coordinates may be sparse; the canonical
   * current coordinate is always derived from the head in this transaction.
   */
  async inspectNamespaceGenerationAuthorityMetadata(input: Readonly<{
    namespaceId: string;
    keyClass: KeyClass;
    requested: readonly Readonly<{
      generation: number;
      accessRevision: number;
    }>[];
  }>): Promise<
    | DomainNamespaceGenerationAuthorityMetadataV2
    | Readonly<{ status: "unavailable"; reason: string }>
  > {
    namespaceId(input.namespaceId);
    const requested = input.requested.map((entry) => Object.freeze({
      generation: Number(namespaceGeneration(entry.generation)),
      accessRevision: Number(accessRevision(entry.accessRevision)),
    })).sort((left, right) => left.generation - right.generation
      || left.accessRevision - right.accessRevision);
    if (requested.some((entry, index) => index > 0
      && entry.generation === requested[index - 1]!.generation
      && entry.accessRevision === requested[index - 1]!.accessRevision)) {
      return Object.freeze({ status: "unavailable" as const, reason: "authority_invalid" });
    }
    return this.restricted.transactionOnce(async (transaction) => {
      const heads = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          namespace_current_generation: namespaceDomainKeyHeads.namespaceCurrentGeneration,
          namespace_access_revision: namespaceDomainKeyHeads.namespaceAccessRevision,
          binding_digest: namespaceDomainKeyHeads.bindingDigest,
        }).from(namespaceDomainKeyHeads).where(and(
          eq(namespaceDomainKeyHeads.namespaceId, input.namespaceId),
          eq(namespaceDomainKeyHeads.keyClass, input.keyClass),
        )).limit(2).for("share"),
      );
      if (heads.length !== 1) {
        return Object.freeze({ status: "unavailable" as const, reason: "namespace_bundle_unavailable" });
      }
      const current = Object.freeze({
        generation: requiredCounter(heads[0]!.namespace_current_generation),
        accessRevision: requiredCounter(heads[0]!.namespace_access_revision),
      });
      const coordinates = [...requested];
      if (!coordinates.some((entry) => entry.generation === current.generation
        && entry.accessRevision === current.accessRevision)) coordinates.push(current);
      const rows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.selectDistinctOn([
          namespaceDomainKeyBindings.namespaceCurrentGeneration,
          namespaceDomainKeyBindings.namespaceAccessRevision,
        ], {
          binding_bytes: namespaceDomainKeyBindings.bindingBytes,
          binding_digest: namespaceDomainKeyBindings.bindingDigest,
          namespace_current_generation: namespaceDomainKeyBindings.namespaceCurrentGeneration,
          namespace_access_revision: namespaceDomainKeyBindings.namespaceAccessRevision,
          bundle_revision: namespaceDomainKeyBindings.bundleRevision,
          signing_public_key: humanCryptoDevices.signingPublicKey,
        }).from(namespaceDomainKeyBindings).innerJoin(
          humanCryptoDevices,
          and(
            eq(humanCryptoDevices.deviceId, namespaceDomainKeyBindings.issuerDeviceId),
            eq(humanCryptoDevices.humanId, namespaceDomainKeyBindings.issuerHumanId),
          ),
        ).where(and(
          eq(namespaceDomainKeyBindings.namespaceId, input.namespaceId),
          eq(namespaceDomainKeyBindings.keyClass, input.keyClass),
          or(...coordinates.map((entry) => and(
            eq(namespaceDomainKeyBindings.namespaceCurrentGeneration, entry.generation),
            eq(namespaceDomainKeyBindings.namespaceAccessRevision, entry.accessRevision),
          ))),
          inArray(namespaceDomainKeyBindings.state, ["active", "stale"]),
        )).orderBy(namespaceDomainKeyBindings.namespaceCurrentGeneration,
          namespaceDomainKeyBindings.namespaceAccessRevision,
          desc(namespaceDomainKeyBindings.bundleRevision)),
      );
      const descriptors: DomainNamespaceGenerationAuthorityMetadataV2["retainedGenerations"][number][] = [];
      const fail = (reason: string) => {
        descriptors.forEach((entry) => wipe([
          entry.headDigest, entry.publicationDigest,
          entry.publicationSetDigest, entry.audienceFingerprint,
        ]));
        return Object.freeze({ status: "unavailable" as const, reason });
      };
      for (const coordinate of coordinates.sort((left, right) =>
        left.generation - right.generation || left.accessRevision - right.accessRevision
      )) {
        const row = rows.find((candidate) =>
          requiredCounter(candidate.namespace_current_generation) === coordinate.generation
          && requiredCounter(candidate.namespace_access_revision) === coordinate.accessRevision
        );
        if (row === undefined) {
          return fail("binding_unavailable");
        }
        const binding = verifiedNamespaceBindingMetadata({
          crypto: this.crypto, serverId: this.serverId,
          namespaceId: input.namespaceId, keyClass: input.keyClass,
          generation: coordinate.generation,
          accessRevision: coordinate.accessRevision,
          row,
        });
        if (binding === null) return fail("binding_invalid");
        const digest = binding.retainedAuthoritySetDigest;
        descriptors.push(Object.freeze({
          generation: coordinate.generation,
          accessRevision: coordinate.accessRevision,
          headDigest: digest.slice(),
          publicationDigest: digest.slice(),
          publicationSetDigest: digest.slice(),
          audienceFingerprint: digest,
        }));
      }
      const currentRow = rows.find((candidate) =>
        requiredCounter(candidate.namespace_current_generation) === current.generation
        && requiredCounter(candidate.namespace_access_revision) === current.accessRevision
      );
      const headBindingDigest = copyBytes(heads[0]!.binding_digest);
      const currentBindingDigest = currentRow === undefined
        ? null : copyBytes(currentRow.binding_digest);
      const currentConsistent = currentBindingDigest !== null
        && sameBytes(headBindingDigest, currentBindingDigest);
      wipe([headBindingDigest, ...(currentBindingDigest === null ? [] : [currentBindingDigest])]);
      if (!currentConsistent) {
        return fail("authority_inconsistent");
      }
      return Object.freeze({ status: "ready" as const,
        namespaceId: input.namespaceId, currentGeneration: current.generation,
        retainedGenerations: Object.freeze(descriptors) });
    });
  }

  /**
   * Adapt V2 Domain authority to the durable Shared-Agent write-plan shape.
   * Room membership remains held by the caller's opaque product snapshot;
   * only current, active recipient envelopes count as protected coverage.
   */
  async inspectSharedAgentWriteAuthority(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    deviceId: string;
    keyClass?: KeyClass;
  }>): Promise<SharedAgentNamespaceWriteAuthorityResult> {
    return this.#inspectMessageAuthority(input, true);
  }

  /** Disclosure authority permits an admitted reader to request its missing
   * Domain envelope through native custody. Envelope presence is a write
   * prerequisite, not a prerequisite for learning authenticated read coordinates.
   */
  async inspectMessageReadAuthority(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    deviceId: string;
    keyClass: KeyClass;
  }>): Promise<SharedAgentNamespaceWriteAuthorityResult> {
    return this.#inspectMessageAuthority(input, false);
  }

  async #inspectMessageAuthority(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    deviceId: string;
    keyClass?: KeyClass;
  }>, requireRecipient: boolean): Promise<SharedAgentNamespaceWriteAuthorityResult> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    const keyClass = input.keyClass ?? "ai";
    const namespaceAuthority = await this.inspectForegroundNamespaceAuthority({
      namespaceId: snapshot.namespaceId,
      keyClass,
    });
    if (namespaceAuthority.status !== "ready") {
      snapshot.audienceFingerprint.fill(0);
      return Object.freeze({
        status: "unavailable" as const,
        reason: "namespace_unavailable" as const,
      });
    }
    const foreground = await this.#inspectForegroundAuthority({
      namespaceIds: [snapshot.namespaceId],
      keyClass,
      subjectHumanId: snapshot.subjectHumanId,
      deviceId: input.deviceId,
    }, requireRecipient);
    const destroyForeground = (): void => {
      if (foreground.status !== "ready") return;
      foreground.domains.forEach((entry) => wipe([
        entry.participantDigest,
        entry.headDigest,
        entry.activeNamespaceBindingSetDigest,
      ]));
    };
    const destroyNamespace = (): void => wipe([
      namespaceAuthority.namespaceHeadDigest,
      namespaceAuthority.namespacePublicationDigest,
      namespaceAuthority.namespacePublicationSetDigest,
      namespaceAuthority.namespaceAudienceFingerprint,
      namespaceAuthority.domainHeadDigest,
      namespaceAuthority.bundleDigest,
    ]);
    try {
      if (foreground.status !== "ready") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: foreground.reason === "device_unavailable"
            ? "device_unavailable" as const
            : foreground.reason === "recipient_sync_required"
            ? "recipient_sync_required" as const
            : "namespace_unavailable" as const,
        });
      }
      const domain = foreground.domains[0];
      const expectedParticipantDigest = participantDigest(
        snapshot.participantHumanIds,
      );
      try {
        if (
          foreground.domains.length !== 1
          || domain === undefined
          || namespaceAuthority.namespaceId !== snapshot.namespaceId
          || namespaceAuthority.namespaceAccessRevision
            !== snapshot.accessRevision
          || namespaceAuthority.domainId !== domain.domainId
          || namespaceAuthority.domainKeyGeneration
            !== domain.domainKeyGeneration
          || namespaceAuthority.domainAuthorizationRevision
            !== domain.authorizationRevision
          || !sameBytes(namespaceAuthority.domainHeadDigest, domain.headDigest)
          || domain.participantCount !== snapshot.participantHumanIds.length
          || !sameBytes(domain.participantDigest, expectedParticipantDigest)
        ) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "namespace_unavailable" as const,
          });
        }
      } finally {
        expectedParticipantDigest.fill(0);
      }

      return await this.restricted.transactionOnce(async (transaction) => {
        const deviceRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            device_id: humanCryptoDevices.deviceId,
            human_id: humanCryptoDevices.humanId,
            device_generation: humanCryptoDevices.deviceGeneration,
            revision: humanCryptoDevices.revision,
            signing_public_key: humanCryptoDevices.signingPublicKey,
          }).from(humanCryptoDevices).innerJoin(
            humanCryptoCustodies,
            eq(humanCryptoCustodies.humanId, humanCryptoDevices.humanId),
          ).innerJoin(
            humanCryptoDeviceGroupHeads,
            eq(humanCryptoDeviceGroupHeads.humanId, humanCryptoDevices.humanId),
          ).where(and(
            eq(humanCryptoDevices.deviceId, input.deviceId),
            eq(humanCryptoDevices.humanId, snapshot.subjectHumanId),
            eq(humanCryptoDevices.state, "active"),
            currentHumanDeviceMembershipHead(),
            eq(humanCryptoCustodies.state, "active"),
          )).for("share"),
        );
        if (deviceRows.length !== 1) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "device_unavailable" as const,
          });
        }
        const envelopeRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            recipient_human_id: domainKeyRecipientEnvelopes.recipientHumanId,
            recipient_kind: domainKeyRecipientEnvelopes.recipientKind,
            recipient_key_id: domainKeyRecipientEnvelopes.recipientKeyId,
            recipient_key_generation:
              domainKeyRecipientEnvelopes.recipientKeyGeneration,
          }).from(domainKeyRecipientEnvelopes).where(and(
            eq(domainKeyRecipientEnvelopes.domainId, domain.domainId),
            eq(domainKeyRecipientEnvelopes.keyClass, keyClass),
            eq(
              domainKeyRecipientEnvelopes.domainKeyGeneration,
              domain.domainKeyGeneration,
            ),
            eq(
              domainKeyRecipientEnvelopes.authorizationRevision,
              domain.authorizationRevision,
            ),
            eq(domainKeyRecipientEnvelopes.headDigest, domain.headDigest),
            inArray(
              domainKeyRecipientEnvelopes.recipientHumanId,
              snapshot.participantHumanIds,
            ),
          )),
        );
        const activeDeviceRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            human_id: humanCryptoDevices.humanId,
            device_id: humanCryptoDevices.deviceId,
            generation: humanCryptoDevices.deviceGeneration,
          }).from(humanCryptoDevices).innerJoin(
            humanCryptoCustodies,
            eq(humanCryptoCustodies.humanId, humanCryptoDevices.humanId),
          ).innerJoin(
            humanCryptoDeviceGroupHeads,
            eq(humanCryptoDeviceGroupHeads.humanId, humanCryptoDevices.humanId),
          ).where(and(
            inArray(humanCryptoDevices.humanId, snapshot.participantHumanIds),
            eq(humanCryptoDevices.state, "active"),
            currentHumanDeviceMembershipHead(),
            eq(humanCryptoCustodies.state, "active"),
          )),
        );
        const recoveryRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            human_id: humanCryptoRecoveryKeys.humanId,
            key_id: humanCryptoRecoveryKeys.recoveryKeyId,
            generation: humanCryptoRecoveryKeys.generation,
          }).from(humanCryptoRecoveryKeys).innerJoin(
            humanCryptoCustodies,
            eq(humanCryptoCustodies.humanId, humanCryptoRecoveryKeys.humanId),
          ).where(and(
            inArray(
              humanCryptoRecoveryKeys.humanId,
              snapshot.participantHumanIds,
            ),
            eq(humanCryptoRecoveryKeys.state, "current"),
            eq(humanCryptoCustodies.state, "active"),
          )),
        );
        const activeDevices = new Set(activeDeviceRows.map((row) => [
          requiredText(row.human_id),
          requiredText(row.device_id),
          requiredCounter(row.device_generation),
        ].join("\0")));
        const currentRecoveries = new Set(recoveryRows.map((row) => [
          requiredText(row.human_id),
          requiredText(row.recovery_key_id),
          requiredCounter(row.generation),
        ].join("\0")));
        const representedHumans = new Set<string>();
        let protectedRecipientDeviceCount = 0;
        let invokingDeviceRepresented = false;
        for (const row of envelopeRows) {
          const human = requiredText(row.recipient_human_id);
          const kind = requiredText(row.recipient_kind);
          const keyId = requiredText(row.recipient_key_id);
          const generation = requiredCounter(row.recipient_key_generation);
          const coordinate = [human, keyId, generation].join("\0");
          if (kind === "device" && activeDevices.has(coordinate)) {
            representedHumans.add(human);
            protectedRecipientDeviceCount += 1;
            if (keyId === input.deviceId) invokingDeviceRepresented = true;
          } else if (kind === "recovery" && currentRecoveries.has(coordinate)) {
            representedHumans.add(human);
          }
        }
        if (requireRecipient && !invokingDeviceRepresented) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "recipient_sync_required" as const,
          });
        }
        const device = deviceRows[0]!;
        return Object.freeze({
          status: "ready" as const,
          subjectHumanId: snapshot.subjectHumanId,
          committerDeviceId: cryptoDeviceId(requiredText(device.device_id)),
          committerDeviceSigningKeyGeneration:
            requiredCounter(device.device_generation),
          committerDeviceRevision: requiredCounter(device.revision),
          committerDeviceSigningPublicKey:
            copyBytes(device.signing_public_key),
          namespaceId: snapshot.namespaceId,
          namespaceAccessRevision: snapshot.accessRevision,
          namespaceKeyGeneration: namespaceGeneration(
            namespaceAuthority.namespaceKeyGeneration,
          ),
          namespaceHeadDigest: namespaceAuthority.namespaceHeadDigest.slice(),
          namespacePublicationDigest:
            namespaceAuthority.namespacePublicationDigest.slice(),
          namespacePublicationSetDigest:
            namespaceAuthority.namespacePublicationSetDigest.slice(),
          namespaceAudienceFingerprint:
            namespaceAuthority.namespaceAudienceFingerprint.slice(),
          participantHumanCount: snapshot.participantHumanIds.length,
          protectedParticipantHumanCount: representedHumans.size,
          plaintextParticipantHumanCount:
            snapshot.participantHumanIds.length - representedHumans.size,
          protectedRecipientDeviceCount,
        });
      });
    } finally {
      snapshot.audienceFingerprint.fill(0);
      destroyNamespace();
      destroyForeground();
    }
  }

  async withOpenedForegroundNamespaceKey<Value>(input: Readonly<{
    authority: Omit<DomainForegroundNamespaceAuthorityInspectionV2, "status">;
    domainKey: Uint8Array;
    /** Defaults to the current head; reads may request a retained generation. */
    keyGeneration?: number;
    /** Exact revision at which the object's DEK was wrapped. */
    accessRevision?: number;
    use(key: Uint8Array): Value | Promise<Value>;
    onDiagnostic?: (stage: string) => void;
  }>): Promise<Value | null> {
    const rows = await executeTypedCryptoQuery(
      this.restricted,
      cryptoTypedDb.select({
        binding_bytes: namespaceDomainKeyBindings.bindingBytes,
        binding_digest: namespaceDomainKeyBindings.bindingDigest,
        issuer_signing_public_key: humanCryptoDevices.signingPublicKey,
      }).from(namespaceDomainKeyHeads).innerJoin(
        namespaceDomainKeyBindings,
        eq(
          namespaceDomainKeyBindings.operationId,
          namespaceDomainKeyHeads.bindingOperationId,
        ),
      ).innerJoin(
        humanCryptoDevices,
        eq(
          humanCryptoDevices.deviceId,
          namespaceDomainKeyBindings.issuerDeviceId,
        ),
      ).where(and(
        eq(namespaceDomainKeyHeads.namespaceId, input.authority.namespaceId),
        eq(namespaceDomainKeyHeads.keyClass, "ai"),
        eq(namespaceDomainKeyHeads.domainId, input.authority.domainId),
        eq(
          namespaceDomainKeyHeads.domainKeyGeneration,
          input.authority.domainKeyGeneration,
        ),
        eq(
          namespaceDomainKeyHeads.domainAuthorizationRevision,
          input.authority.domainAuthorizationRevision,
        ),
        eq(
          namespaceDomainKeyHeads.bindingDigest,
          input.authority.bundleDigest,
        ),
      )).limit(2),
    );
    if (rows.length !== 1) {
      input.onDiagnostic?.("binding_absent");
      return null;
    }
    const row = rows[0]!;
    const bindingBytes = copyBytes(row.binding_bytes);
    const bindingDigest = copyBytes(row.binding_digest);
    const signingPublicKey = copyBytes(row.signing_public_key);
    const binding = verifyDomainNamespaceBundleBindingV2(this.crypto, {
      bindingBytes,
      issuerSigningPublicKey: signingPublicKey,
      expectedBindingDigest: bindingDigest,
    });
    if (binding === null) {
      input.onDiagnostic?.("binding_invalid");
      wipe([bindingBytes, bindingDigest, signingPublicKey]);
      return null;
    }
    try {
      if (
        binding.cryptoDomainId !== input.authority.domainId
        || binding.keyClass !== "ai"
        || binding.domainKeyGeneration
          !== input.authority.domainKeyGeneration
        || binding.domainAuthorizationRevision
          !== input.authority.domainAuthorizationRevision
        || !sameBytes(
          binding.domainHeadDigest,
          input.authority.domainHeadDigest,
        )
        || binding.namespaceId !== input.authority.namespaceId
        || binding.namespaceAccessRevision
          !== input.authority.namespaceAccessRevision
        || binding.namespaceCurrentGeneration
          !== input.authority.namespaceKeyGeneration
        || binding.bundleRevision !== input.authority.bundleRevision
      ) {
        input.onDiagnostic?.("binding_stale");
        return null;
      }
      const opened = await withOpenedDomainNamespaceBundle(this.crypto, {
        bindingBytes,
        expectedBindingDigest: bindingDigest,
        issuerSigningPublicKey: signingPublicKey,
        domainKey: input.domainKey,
        current: {
          serverId: binding.serverId,
          cryptoDomainId: binding.cryptoDomainId,
          participantDigest: binding.participantDigest,
          participantCount: binding.participantCount,
          keyClass: binding.keyClass,
          domainKeyGeneration: binding.domainKeyGeneration,
          domainAuthorizationRevision: binding.domainAuthorizationRevision,
          domainHeadDigest: binding.domainHeadDigest,
          namespaceId: binding.namespaceId,
          namespaceAccessRevision: binding.namespaceAccessRevision,
          namespaceCurrentGeneration: binding.namespaceCurrentGeneration,
          bundleRevision: binding.bundleRevision,
          retainedAuthoritySetDigest: binding.retainedAuthoritySetDigest,
        },
        operation: async (retained) => {
          const expectedGeneration = input.keyGeneration
            ?? input.authority.namespaceKeyGeneration;
          const expectedAccessRevision = input.accessRevision
            ?? input.authority.namespaceAccessRevision;
          const current = retained.find((entry) =>
            entry.generation === expectedGeneration
            && entry.accessRevision === expectedAccessRevision
          );
          if (
            current === undefined
            || !sameBytes(
              binding.retainedAuthoritySetDigest,
              input.authority.namespaceHeadDigest,
            )
          ) {
            input.onDiagnostic?.("generation_absent");
            return null;
          }
          return input.use(current.generationKey);
        },
      });
      if (opened.status !== "opened") {
        input.onDiagnostic?.(`bundle_${opened.reason}`);
        return null;
      }
      return opened.value;
    } finally {
      destroyDomainNamespaceBundleBindingV2(binding);
      wipe([bindingBytes, bindingDigest, signingPublicKey]);
    }
  }

  async planHead(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    keyClass: KeyClass;
    clientDeviceId: string;
    now: number;
  }>): Promise<DomainKeyAuthorityHeadPlan> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    return this.restricted.transactionOnce(async (transaction) => {
      const device = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        snapshot.subjectHumanId,
      );
      let domain: DomainContext | null = null;
      try {
        if (device === null) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "device_unavailable" as const,
          });
        }
        domain = await loadOrCreateDomain(
          transaction,
          snapshot,
          this.createDomainId,
        );
        const rows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            participant_digest: domainKeyHeads.participantDigest,
            participant_count: domainKeyHeads.participantCount,
            domain_key_generation: domainKeyHeads.domainKeyGeneration,
            authorization_revision: domainKeyHeads.authorizationRevision,
            head_digest: domainKeyHeads.headDigest,
            head_bytes: domainKeyHeads.headBytes,
            issuer_device_id: domainKeyHeads.issuerDeviceId,
            issuer_device_signing_generation:
              domainKeyHeads.issuerDeviceSigningGeneration,
          }).from(domainKeyHeads).where(and(
            eq(domainKeyHeads.domainId, domain.domainId),
            eq(domainKeyHeads.keyClass, input.keyClass),
          )).limit(2).for("share"),
        );
        if (rows.length === 0) {
          const recoveryRecipient = await loadCurrentRecoveryRecipient(
            transaction,
            device.humanId,
          );
          try {
            if (recoveryRecipient === null) {
              return Object.freeze({
                status: "unavailable" as const,
                reason: "recipient_unavailable" as const,
              });
            }
            return Object.freeze({
              status: "create_required" as const,
              domainId: domain.domainId,
              participantDigest: domain.participantDigest.slice(),
              participantCount: domain.participantCount,
              keyClass: input.keyClass,
              domainKeyGeneration: 1 as const,
              authorizationRevision: 1 as const,
              previousHeadDigest: null,
              issuerHumanId: device.humanId,
              issuerDeviceId: device.deviceId,
              issuerDeviceSigningGeneration: device.deviceGeneration,
              issuerSigningPublicKey: device.signingPublicKey.slice(),
              recipientEncryptionPublicKey: device.encryptionPublicKey.slice(),
              recipientPublicKeyDigest:
                device.encryptionPublicKeyDigest.slice(),
              recoveryKeyId: recoveryRecipient.keyId,
              recoveryKeyGeneration: recoveryRecipient.generation,
              recoveryPublicKey: recoveryRecipient.publicKey.slice(),
              recoveryPublicKeyDigest:
                recoveryRecipient.publicKeyDigest.slice(),
              issuedAt: input.now,
              deadlineAt: input.now + DOMAIN_KEY_AUTHORITY_OPERATION_TTL_MS,
            });
          } finally {
            destroyRecipient(recoveryRecipient);
          }
        }
        if (rows.length !== 1) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "authority_inconsistent" as const,
          });
        }
        const row = rows[0]!;
        const participantDigest = copyBytes(row.participant_digest);
        const headDigest = copyBytes(row.head_digest);
        const headBytes = copyBytes(row.head_bytes);
        const issuerPublicKey = await loadSigningPublicKey(
          transaction,
          requiredText(row.issuer_device_id),
          requiredCounter(row.issuer_device_signing_generation),
        );
        try {
          if (issuerPublicKey === null) {
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent" as const,
            });
          }
          const validHead = verifyDomainKeyHead(this.crypto, {
            headBytes,
            issuerSigningPublicKey: issuerPublicKey,
            expectedHeadDigest: headDigest,
          });
          if (
            validHead === null
            || !sameBytes(participantDigest, domain.participantDigest)
            || requiredCounter(row.participant_count) !== domain.participantCount
            || validHead.serverId !== this.serverId
            || validHead.cryptoDomainId !== domain.domainId
            || validHead.keyClass !== input.keyClass
          ) {
            if (validHead !== null) destroyDomainKeyHeadV2(validHead);
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent" as const,
            });
          }
          destroyDomainKeyHeadV2(validHead);
          const generation = requiredCounter(row.domain_key_generation);
          const currentAuthorization = requiredCounter(
            row.authorization_revision,
          );
          const revokedRecipients = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              device_id: humanCryptoDevices.deviceId,
            }).from(domainKeyRecipientEnvelopes).innerJoin(
              humanCryptoDevices,
              and(
                eq(
                  humanCryptoDevices.deviceId,
                  domainKeyRecipientEnvelopes.recipientKeyId,
                ),
                eq(
                  humanCryptoDevices.deviceGeneration,
                  domainKeyRecipientEnvelopes.recipientKeyGeneration,
                ),
              ),
            ).where(and(
              eq(domainKeyRecipientEnvelopes.domainId, domain.domainId),
              eq(domainKeyRecipientEnvelopes.keyClass, input.keyClass),
              eq(domainKeyRecipientEnvelopes.domainKeyGeneration, generation),
              eq(
                domainKeyRecipientEnvelopes.authorizationRevision,
                currentAuthorization,
              ),
              eq(domainKeyRecipientEnvelopes.recipientKind, "device"),
              eq(humanCryptoDevices.state, "revoked"),
            )).limit(1),
          );
          if (revokedRecipients.length > 0) {
            const recoveryRecipient = await loadCurrentRecoveryRecipient(
              transaction,
              device.humanId,
            );
            try {
              if (recoveryRecipient === null) {
                return Object.freeze({
                  status: "unavailable" as const,
                  reason: "recipient_unavailable" as const,
                });
              }
              return Object.freeze({
                status: "create_required" as const,
                domainId: domain.domainId,
                participantDigest: domain.participantDigest.slice(),
                participantCount: domain.participantCount,
                keyClass: input.keyClass,
                domainKeyGeneration: generation + 1,
                authorizationRevision: currentAuthorization + 1,
                previousHeadDigest: headDigest.slice(),
                issuerHumanId: device.humanId,
                issuerDeviceId: device.deviceId,
                issuerDeviceSigningGeneration: device.deviceGeneration,
                issuerSigningPublicKey: device.signingPublicKey.slice(),
                recipientEncryptionPublicKey:
                  device.encryptionPublicKey.slice(),
                recipientPublicKeyDigest:
                  device.encryptionPublicKeyDigest.slice(),
                recoveryKeyId: recoveryRecipient.keyId,
                recoveryKeyGeneration: recoveryRecipient.generation,
                recoveryPublicKey: recoveryRecipient.publicKey.slice(),
                recoveryPublicKeyDigest:
                  recoveryRecipient.publicKeyDigest.slice(),
                issuedAt: input.now,
                deadlineAt: input.now + DOMAIN_KEY_AUTHORITY_OPERATION_TTL_MS,
              });
            } finally {
              destroyRecipient(recoveryRecipient);
            }
          }
          const envelopeRows = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              envelope_bytes: domainKeyRecipientEnvelopes.envelopeBytes,
              envelope_digest: domainKeyRecipientEnvelopes.envelopeDigest,
              issuer_device_id: domainKeyRecipientEnvelopes.issuerDeviceId,
              issuer_device_signing_generation:
                domainKeyRecipientEnvelopes.issuerDeviceSigningGeneration,
            }).from(domainKeyRecipientEnvelopes).where(and(
              eq(domainKeyRecipientEnvelopes.domainId, domain.domainId),
              eq(domainKeyRecipientEnvelopes.keyClass, input.keyClass),
              eq(
                domainKeyRecipientEnvelopes.domainKeyGeneration,
                generation,
              ),
              eq(
                domainKeyRecipientEnvelopes.authorizationRevision,
                currentAuthorization,
              ),
              eq(domainKeyRecipientEnvelopes.recipientKind, "device"),
              eq(domainKeyRecipientEnvelopes.recipientKeyId, device.deviceId),
              eq(
                domainKeyRecipientEnvelopes.recipientKeyGeneration,
                device.deviceGeneration,
              ),
            )).limit(2),
          );
          if (envelopeRows.length > 1) {
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent" as const,
            });
          }
          let recipientEnvelope: Extract<
            DomainKeyAuthorityHeadPlan,
            { status: "ready" }
          >["recipientEnvelope"] = null;
          if (envelopeRows.length === 1) {
            const envelopeRow = envelopeRows[0]!;
            const envelopeIssuerPublicKey = await loadSigningPublicKey(
              transaction,
              requiredText(envelopeRow.issuer_device_id),
              requiredCounter(
                envelopeRow.issuer_device_signing_generation,
              ),
            );
            if (envelopeIssuerPublicKey === null) {
              return Object.freeze({
                status: "unavailable" as const,
                reason: "authority_inconsistent" as const,
              });
            }
            recipientEnvelope = Object.freeze({
              envelopeBytes: copyBytes(envelopeRow.envelope_bytes),
              envelopeDigest: copyBytes(envelopeRow.envelope_digest),
              issuerSigningPublicKey: envelopeIssuerPublicKey,
            });
          }
          return Object.freeze({
            status: "ready" as const,
            domainId: domain.domainId,
            participantDigest: domain.participantDigest.slice(),
            participantCount: domain.participantCount,
            keyClass: input.keyClass,
            domainKeyGeneration: generation,
            authorizationRevision: currentAuthorization,
            headDigest: headDigest.slice(),
            headBytes: headBytes.slice(),
            issuerSigningPublicKey: new Uint8Array(issuerPublicKey),
            recipientDeviceSigningGeneration: device.deviceGeneration,
            recipientDeviceRevision: device.revision,
            recipientEnvelope,
          });
        } finally {
          participantDigest.fill(0);
          headDigest.fill(0);
          headBytes.fill(0);
          issuerPublicKey?.fill(0);
        }
      } finally {
        destroyDomain(domain);
        destroyDevice(device);
        snapshot.audienceFingerprint.fill(0);
      }
    });
  }

  async publishHead(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    keyClass: KeyClass;
    clientDeviceId: string;
    operationId: string;
    idempotencyKey: string;
    headBytes: Uint8Array;
    envelopeBytes: Uint8Array;
    authorizationBytes: Uint8Array;
    recoveryEnvelopeBytes: Uint8Array;
    recoveryAuthorizationBytes: Uint8Array;
    now: number;
  }>): Promise<DomainKeyAuthorityPublicationResult | null> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    return this.restricted.transactionOnce(async (transaction) => {
      const domain = await loadDomain(transaction, snapshot);
      const issuer = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        snapshot.subjectHumanId,
      );
      const recoveryRecipient = await loadCurrentRecoveryRecipient(
        transaction,
        snapshot.subjectHumanId,
      );
      const issuerRecipient = issuer === null ? null : deviceRecipient(issuer);
      let head: ReturnType<typeof verifyDomainKeyHead> | null = null;
      let envelope: ReturnType<typeof verifyDomainKeyRecipientEnvelope> | null = null;
      let recoveryEnvelope: ReturnType<
        typeof verifyDomainKeyRecipientEnvelope
      > | null = null;
      let authorization: ReturnType<
        typeof verifyDomainKeyRecipientAuthorization
      > | null = null;
      let recoveryAuthorization: ReturnType<
        typeof verifyDomainKeyRecipientAuthorization
      > | null = null;
      try {
        if (
          domain === null
          || issuer === null
          || issuerRecipient === null
          || recoveryRecipient === null
        ) return null;
        head = verifyDomainKeyHead(this.crypto, {
          headBytes: input.headBytes,
          issuerSigningPublicKey: issuer.signingPublicKey,
          now: input.now,
        });
        if (
          head === null
          || !headCoordinatesMatch(head, {
            serverId: this.serverId,
            domain,
            keyClass: input.keyClass,
            issuer,
            operationId: input.operationId,
          })
        ) return null;
        const headDigest = this.crypto.hash(input.headBytes);
        try {
          envelope = verifyDomainKeyRecipientEnvelope(this.crypto, {
            envelopeBytes: input.envelopeBytes,
            issuerSigningPublicKey: issuer.signingPublicKey,
          });
          if (
            envelope === null
            || !envelopeCoordinatesMatch(envelope, {
              serverId: this.serverId,
              domain,
              keyClass: input.keyClass,
              headDigest,
              headGeneration: head.domainKeyGeneration,
              authorizationRevision: head.authorizationRevision,
              target: issuerRecipient,
              issuer,
            })
          ) return null;
          authorization = verifyDomainKeyRecipientAuthorization(
            this.crypto,
            {
              authorizationBytes: input.authorizationBytes,
              issuerSigningPublicKey: issuer.signingPublicKey,
              now: input.now,
            },
          );
          if (
            authorization === null
            || authorization.authorizationOperationId !== input.operationId
            || authorization.reason !== "head_establishment"
            || authorization.requestDigest !== null
            || authorization.issuerHumanId !== issuer.humanId
            || authorization.issuerDeviceId !== issuer.deviceId
            || authorization.issuerDeviceSigningGeneration
              !== issuer.deviceGeneration
            || !sameBytes(authorization.envelopeBytes, input.envelopeBytes)
          ) return null;
          recoveryEnvelope = verifyDomainKeyRecipientEnvelope(this.crypto, {
            envelopeBytes: input.recoveryEnvelopeBytes,
            issuerSigningPublicKey: issuer.signingPublicKey,
          });
          if (
            recoveryEnvelope === null
            || !envelopeCoordinatesMatch(recoveryEnvelope, {
              serverId: this.serverId,
              domain,
              keyClass: input.keyClass,
              headDigest,
              headGeneration: head.domainKeyGeneration,
              authorizationRevision: head.authorizationRevision,
              target: recoveryRecipient,
              issuer,
            })
          ) return null;
          recoveryAuthorization = verifyDomainKeyRecipientAuthorization(
            this.crypto,
            {
              authorizationBytes: input.recoveryAuthorizationBytes,
              issuerSigningPublicKey: issuer.signingPublicKey,
              now: input.now,
            },
          );
          if (
            recoveryAuthorization === null
            || recoveryAuthorization.authorizationOperationId
              !== input.operationId
            || recoveryAuthorization.reason !== "head_establishment"
            || recoveryAuthorization.requestDigest !== null
            || recoveryAuthorization.issuerHumanId !== issuer.humanId
            || recoveryAuthorization.issuerDeviceId !== issuer.deviceId
            || recoveryAuthorization.issuerDeviceSigningGeneration
              !== issuer.deviceGeneration
            || !sameBytes(
              recoveryAuthorization.envelopeBytes,
              input.recoveryEnvelopeBytes,
            )
          ) return null;
          const envelopeDigest = this.crypto.hash(input.envelopeBytes);
          const authorizationDigest = this.crypto.hash(input.authorizationBytes);
          const recoveryEnvelopeDigest = this.crypto.hash(
            input.recoveryEnvelopeBytes,
          );
          const recoveryAuthorizationDigest = this.crypto.hash(
            input.recoveryAuthorizationBytes,
          );
          const now = new Date(input.now);
          const deadline = new Date(head.deadlineAt);
          try {
            await lockAuthorityCoordinate(transaction, [
              "head",
              domain.domainId,
              input.keyClass,
            ]);
            const existing = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.select({
                operation_id: domainKeyPublicationOperations.operationId,
                idempotency_key: domainKeyPublicationOperations.idempotencyKey,
                head_digest: domainKeyPublicationOperations.headDigest,
                state: domainKeyPublicationOperations.state,
              }).from(domainKeyPublicationOperations).where(
                eq(
                  domainKeyPublicationOperations.idempotencyKey,
                  input.idempotencyKey,
                ),
              ).limit(2).for("update"),
            );
            if (existing.length > 0) {
              if (
                existing.length !== 1
                || requiredText(existing[0]!.operation_id) !== input.operationId
                || requiredText(existing[0]!.state) !== "active"
                || !scalarBytesEqual(existing[0]!.head_digest, headDigest)
              ) return null;
              const replayEnvelopes = await executeTypedCryptoQuery(
                transaction,
                cryptoTypedDb.select({
                  recipient_kind: domainKeyRecipientEnvelopes.recipientKind,
                  recipient_key_id: domainKeyRecipientEnvelopes.recipientKeyId,
                  recipient_key_generation:
                    domainKeyRecipientEnvelopes.recipientKeyGeneration,
                  envelope_digest: domainKeyRecipientEnvelopes.envelopeDigest,
                  authorization_digest:
                    domainKeyRecipientEnvelopes.authorizationDigest,
                }).from(domainKeyRecipientEnvelopes).where(and(
                  eq(domainKeyRecipientEnvelopes.domainId, domain.domainId),
                  eq(domainKeyRecipientEnvelopes.keyClass, input.keyClass),
                  eq(
                    domainKeyRecipientEnvelopes.domainKeyGeneration,
                    head.domainKeyGeneration,
                  ),
                  eq(
                    domainKeyRecipientEnvelopes.authorizationRevision,
                    head.authorizationRevision,
                  ),
                  inArray(
                    domainKeyRecipientEnvelopes.recipientKind,
                    ["device", "recovery"],
                  ),
                  inArray(
                    domainKeyRecipientEnvelopes.recipientKeyId,
                    [issuerRecipient.keyId, recoveryRecipient.keyId],
                  ),
                )).limit(3),
              );
              const deviceReplay = replayEnvelopes.find((row) =>
                requiredText(row.recipient_kind) === issuerRecipient.kind
                && requiredText(row.recipient_key_id) === issuerRecipient.keyId
                && requiredCounter(row.recipient_key_generation)
                  === issuerRecipient.generation
              );
              const recoveryReplay = replayEnvelopes.find((row) =>
                requiredText(row.recipient_kind) === recoveryRecipient.kind
                && requiredText(row.recipient_key_id) === recoveryRecipient.keyId
                && requiredCounter(row.recipient_key_generation)
                  === recoveryRecipient.generation
              );
              if (
                replayEnvelopes.length !== 2
                || deviceReplay === undefined
                || recoveryReplay === undefined
                || !scalarBytesEqual(
                  deviceReplay.envelope_digest,
                  envelopeDigest,
                )
                || !scalarBytesEqual(
                  deviceReplay.authorization_digest,
                  authorizationDigest,
                )
                || !scalarBytesEqual(
                  recoveryReplay.envelope_digest,
                  recoveryEnvelopeDigest,
                )
                || !scalarBytesEqual(
                  recoveryReplay.authorization_digest,
                  recoveryAuthorizationDigest,
                )
              ) return null;
              return Object.freeze({
                status: "replayed" as const,
                operationId: input.operationId,
                domainId: domain.domainId,
                keyClass: input.keyClass,
                domainKeyGeneration: head.domainKeyGeneration,
                authorizationRevision: head.authorizationRevision,
                headDigest: headDigest.slice(),
                envelopeDigest: envelopeDigest.slice(),
                recoveryEnvelopeDigest: recoveryEnvelopeDigest.slice(),
              });
            }
            const activeHeads = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.select({
                head_digest: domainKeyHeads.headDigest,
                domain_key_generation: domainKeyHeads.domainKeyGeneration,
                authorization_revision: domainKeyHeads.authorizationRevision,
              }).from(domainKeyHeads).where(and(
                eq(domainKeyHeads.domainId, domain.domainId),
                eq(domainKeyHeads.keyClass, input.keyClass),
              )).limit(2).for("update"),
            );
            if (activeHeads.length > 1) return null;
            const activeHead = activeHeads[0];
            if (activeHead === undefined) {
              if (
                head.domainKeyGeneration !== 1
                || head.authorizationRevision !== 1
                || head.previousHeadDigest !== null
              ) return null;
            } else if (
              head.domainKeyGeneration
                !== requiredCounter(activeHead.domain_key_generation) + 1
              || head.authorizationRevision
                !== requiredCounter(activeHead.authorization_revision) + 1
              || head.previousHeadDigest === null
              || !scalarBytesEqual(
                activeHead.head_digest,
                head.previousHeadDigest,
              )
            ) return null;
            await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.insert(domainKeyPublicationOperations).values({
                operationId: input.operationId,
                idempotencyKey: input.idempotencyKey,
                domainId: domain.domainId,
                keyClass: input.keyClass,
                participantDigest: domain.participantDigest,
                participantCount: domain.participantCount,
                domainKeyGeneration: head.domainKeyGeneration,
                authorizationRevision: head.authorizationRevision,
                expectedPreviousHeadDigest: head.previousHeadDigest,
                headDigest,
                headBytes: input.headBytes,
                issuerHumanId: issuer.humanId,
                issuerDeviceId: issuer.deviceId,
                issuerDeviceSigningGeneration: issuer.deviceGeneration,
                state: "reserved",
                failureCode: null,
                createdAt: now,
                updatedAt: now,
                deadlineAt: deadline,
                activatedAt: null,
                terminalAt: null,
              }),
            );
            const headValues = {
                domainId: domain.domainId,
                keyClass: input.keyClass,
                participantDigest: domain.participantDigest,
                participantCount: domain.participantCount,
                domainKeyGeneration: head.domainKeyGeneration,
                authorizationRevision: head.authorizationRevision,
                headDigest,
                previousHeadDigest: head.previousHeadDigest,
                headBytes: input.headBytes,
                publicationOperationId: input.operationId,
                issuerHumanId: issuer.humanId,
                issuerDeviceId: issuer.deviceId,
                issuerDeviceSigningGeneration: issuer.deviceGeneration,
                activatedAt: now,
              };
            if (activeHead === undefined) {
              await executeTypedCryptoQuery(
                transaction,
                cryptoTypedDb.insert(domainKeyHeads).values(headValues),
              );
            } else {
              const advanced = await executeTypedCryptoQuery(
                transaction,
                cryptoTypedDb.update(domainKeyHeads).set(headValues).where(and(
                  eq(domainKeyHeads.domainId, domain.domainId),
                  eq(domainKeyHeads.keyClass, input.keyClass),
                  eq(
                    domainKeyHeads.domainKeyGeneration,
                    requiredCounter(activeHead.domain_key_generation),
                  ),
                  eq(
                    domainKeyHeads.authorizationRevision,
                    requiredCounter(activeHead.authorization_revision),
                  ),
                  eq(domainKeyHeads.headDigest, activeHead.head_digest),
                )).returning({ domainId: domainKeyHeads.domainId }),
              );
              if (advanced.length !== 1) return null;
            }
            await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.insert(domainKeyRecipientEnvelopes).values({
                domainId: domain.domainId,
                keyClass: input.keyClass,
                domainKeyGeneration: head.domainKeyGeneration,
                authorizationRevision: head.authorizationRevision,
                headDigest,
                recipientHumanId: issuer.humanId,
                recipientKind: "device",
                recipientKeyId: issuer.deviceId,
                recipientKeyGeneration: issuer.deviceGeneration,
                recipientPublicKeyDigest: issuer.encryptionPublicKeyDigest,
                envelopeDigest,
                envelopeBytes: input.envelopeBytes,
                authorizationDigest,
                authorizationBytes: input.authorizationBytes,
                sourceRequestId: null,
                issuerHumanId: issuer.humanId,
                issuerDeviceId: issuer.deviceId,
                issuerDeviceSigningGeneration: issuer.deviceGeneration,
                createdAt: now,
              }),
            );
            await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.insert(domainKeyRecipientEnvelopes).values({
                domainId: domain.domainId,
                keyClass: input.keyClass,
                domainKeyGeneration: head.domainKeyGeneration,
                authorizationRevision: head.authorizationRevision,
                headDigest,
                recipientHumanId: recoveryRecipient.humanId,
                recipientKind: recoveryRecipient.kind,
                recipientKeyId: recoveryRecipient.keyId,
                recipientKeyGeneration: recoveryRecipient.generation,
                recipientPublicKeyDigest: recoveryRecipient.publicKeyDigest,
                envelopeDigest: recoveryEnvelopeDigest,
                envelopeBytes: input.recoveryEnvelopeBytes,
                authorizationDigest: recoveryAuthorizationDigest,
                authorizationBytes: input.recoveryAuthorizationBytes,
                sourceRequestId: null,
                issuerHumanId: issuer.humanId,
                issuerDeviceId: issuer.deviceId,
                issuerDeviceSigningGeneration: issuer.deviceGeneration,
                createdAt: now,
              }),
            );
            await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.update(domainKeyRecipientRequests).set({
                state: "stale",
                failureCode: "head_advanced",
                updatedAt: now,
                terminalAt: now,
              }).where(and(
                eq(domainKeyRecipientRequests.domainId, domain.domainId),
                eq(domainKeyRecipientRequests.keyClass, input.keyClass),
                eq(domainKeyRecipientRequests.state, "pending"),
                lte(
                  domainKeyRecipientRequests.domainKeyGeneration,
                  head.domainKeyGeneration - 1,
                ),
              )),
            );
            await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.update(domainKeyPublicationOperations).set({
                state: "active",
                updatedAt: now,
                activatedAt: now,
                terminalAt: now,
              }).where(and(
                eq(domainKeyPublicationOperations.operationId, input.operationId),
                eq(domainKeyPublicationOperations.state, "reserved"),
              )),
            );
            return Object.freeze({
              status: "published" as const,
              operationId: input.operationId,
              domainId: domain.domainId,
              keyClass: input.keyClass,
              domainKeyGeneration: head.domainKeyGeneration,
              authorizationRevision: head.authorizationRevision,
              headDigest: headDigest.slice(),
              envelopeDigest: envelopeDigest.slice(),
              recoveryEnvelopeDigest: recoveryEnvelopeDigest.slice(),
            });
          } finally {
            envelopeDigest.fill(0);
            authorizationDigest.fill(0);
            recoveryEnvelopeDigest.fill(0);
            recoveryAuthorizationDigest.fill(0);
          }
        } finally {
          headDigest.fill(0);
        }
      } finally {
        if (head !== null) destroyDomainKeyHeadV2(head);
        if (envelope !== null) destroyDomainKeyRecipientEnvelopeV2(envelope);
        if (recoveryEnvelope !== null) {
          destroyDomainKeyRecipientEnvelopeV2(recoveryEnvelope);
        }
        if (authorization !== null) {
          destroyDomainKeyRecipientAuthorizationV2(authorization);
        }
        if (recoveryAuthorization !== null) {
          destroyDomainKeyRecipientAuthorizationV2(recoveryAuthorization);
        }
        destroyDomain(domain);
        destroyRecipient(issuerRecipient);
        destroyRecipient(recoveryRecipient);
        destroyDevice(issuer);
        snapshot.audienceFingerprint.fill(0);
      }
    });
  }

  async requestRecipient(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    keyClass: KeyClass;
    clientDeviceId: string;
    requestId: string;
    idempotencyKey: string;
    requestBytes: Uint8Array;
    now: number;
  }>): Promise<DomainKeyRecipientRequestResult | null> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    return this.restricted.transactionOnce(async (transaction) => {
      const domain = await loadDomain(transaction, snapshot);
      const target = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        snapshot.subjectHumanId,
      );
      let request: ReturnType<typeof verifyDomainKeyAccessRequest> | null = null;
      try {
        if (domain === null || target === null) return null;
        const heads = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_key_generation: domainKeyHeads.domainKeyGeneration,
            authorization_revision: domainKeyHeads.authorizationRevision,
            head_digest: domainKeyHeads.headDigest,
          }).from(domainKeyHeads).where(and(
            eq(domainKeyHeads.domainId, domain.domainId),
            eq(domainKeyHeads.keyClass, input.keyClass),
          )).limit(2).for("share"),
        );
        if (heads.length !== 1) return null;
        const head = heads[0]!;
        const headDigest = copyBytes(head.head_digest);
        try {
          request = verifyDomainKeyAccessRequest(this.crypto, {
            bytes: input.requestBytes,
            signingPublicKey: target.signingPublicKey,
            now: input.now,
          });
          if (
            request === null
            || request.requestId !== input.requestId
            || request.serverId !== this.serverId
            || request.cryptoDomainId !== domain.domainId
            || !sameBytes(request.participantDigest, domain.participantDigest)
            || request.participantCount !== domain.participantCount
            || request.keyClass !== input.keyClass
            || request.domainKeyGeneration
              !== requiredCounter(head.domain_key_generation)
            || request.authorizationRevision
              !== requiredCounter(head.authorization_revision)
            || !sameBytes(request.headDigest, headDigest)
            || request.humanId !== target.humanId
            || request.recipientKeyId !== target.deviceId
            || request.recipientKeyGeneration !== target.deviceGeneration
            || !sameBytes(
              request.recipientPublicKeyDigest,
              target.encryptionPublicKeyDigest,
            )
            || request.deviceId !== target.deviceId
            || request.deviceSigningKeyGeneration !== target.deviceGeneration
          ) return null;
          const requestDigest = this.crypto.hash(input.requestBytes);
          try {
            const now = new Date(input.now);
            await lockAuthorityCoordinate(transaction, [
              "recipient",
              domain.domainId,
              input.keyClass,
              String(request.domainKeyGeneration),
              String(request.authorizationRevision),
              target.deviceId,
              String(target.deviceGeneration),
            ]);
            await expirePendingRecipientRequests(transaction, {
              domainId: domain.domainId,
              keyClass: input.keyClass,
              now,
            });
            const delivered = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.select({
                envelope_digest: domainKeyRecipientEnvelopes.envelopeDigest,
              }).from(domainKeyRecipientEnvelopes).where(and(
                eq(domainKeyRecipientEnvelopes.domainId, domain.domainId),
                eq(domainKeyRecipientEnvelopes.keyClass, input.keyClass),
                eq(
                  domainKeyRecipientEnvelopes.domainKeyGeneration,
                  request.domainKeyGeneration,
                ),
                eq(
                  domainKeyRecipientEnvelopes.authorizationRevision,
                  request.authorizationRevision,
                ),
                eq(domainKeyRecipientEnvelopes.recipientKind, "device"),
                eq(domainKeyRecipientEnvelopes.recipientKeyId, target.deviceId),
                eq(
                  domainKeyRecipientEnvelopes.recipientKeyGeneration,
                  target.deviceGeneration,
                ),
              )).limit(1),
            );
            if (delivered.length === 1) {
              return Object.freeze({
                status: "already_delivered" as const,
                requestId: input.requestId,
                requestDigest: requestDigest.slice(),
              });
            }
            const pendingTarget = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.select({
                request_id: domainKeyRecipientRequests.requestId,
                request_digest: domainKeyRecipientRequests.requestDigest,
              }).from(domainKeyRecipientRequests).where(and(
                eq(domainKeyRecipientRequests.domainId, domain.domainId),
                eq(domainKeyRecipientRequests.keyClass, input.keyClass),
                eq(
                  domainKeyRecipientRequests.domainKeyGeneration,
                  request.domainKeyGeneration,
                ),
                eq(
                  domainKeyRecipientRequests.authorizationRevision,
                  request.authorizationRevision,
                ),
                eq(domainKeyRecipientRequests.recipientKind, "device"),
                eq(domainKeyRecipientRequests.recipientKeyId, target.deviceId),
                eq(
                  domainKeyRecipientRequests.recipientKeyGeneration,
                  target.deviceGeneration,
                ),
                eq(domainKeyRecipientRequests.state, "pending"),
              )).limit(2).for("update"),
            );
            if (pendingTarget.length > 0) {
              if (pendingTarget.length !== 1) return null;
              return Object.freeze({
                status: "replayed" as const,
                requestId: requiredText(pendingTarget[0]!.request_id),
                requestDigest: copyBytes(pendingTarget[0]!.request_digest),
              });
            }
            const existing = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.select({
                request_id: domainKeyRecipientRequests.requestId,
                request_digest: domainKeyRecipientRequests.requestDigest,
              }).from(domainKeyRecipientRequests).where(
                eq(domainKeyRecipientRequests.idempotencyKey, input.idempotencyKey),
              ).limit(2).for("update"),
            );
            if (existing.length > 0) {
              if (
                existing.length !== 1
                || requiredText(existing[0]!.request_id) !== input.requestId
                || !scalarBytesEqual(
                  existing[0]!.request_digest,
                  requestDigest,
                )
              ) return null;
              return Object.freeze({
                status: "replayed" as const,
                requestId: input.requestId,
                requestDigest: requestDigest.slice(),
              });
            }
            await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.insert(domainKeyRecipientRequests).values({
                requestId: input.requestId,
                idempotencyKey: input.idempotencyKey,
                domainId: domain.domainId,
                keyClass: input.keyClass,
                domainKeyGeneration: request.domainKeyGeneration,
                authorizationRevision: request.authorizationRevision,
                headDigest,
                recipientHumanId: target.humanId,
                recipientKind: "device",
                recipientKeyId: target.deviceId,
                recipientKeyGeneration: target.deviceGeneration,
                recipientPublicKeyDigest: target.encryptionPublicKeyDigest,
                requestDigest,
                requestBytes: input.requestBytes,
                state: "pending",
                fulfillmentAuthorizationDigest: null,
                fulfillmentEnvelopeDigest: null,
                failureCode: null,
                createdAt: now,
                updatedAt: now,
                deadlineAt: new Date(request.expiresAt),
                fulfilledAt: null,
                terminalAt: null,
              }),
            );
            return Object.freeze({
              status: "requested" as const,
              requestId: input.requestId,
              requestDigest: requestDigest.slice(),
            });
          } finally {
            requestDigest.fill(0);
          }
        } finally {
          headDigest.fill(0);
        }
      } finally {
        if (request !== null) destroyDomainKeyAccessRequestV2(request);
        destroyDomain(domain);
        destroyDevice(target);
        snapshot.audienceFingerprint.fill(0);
      }
    });
  }

  /**
   * Return a bounded, content-free list of Namespace coordinates for which
   * this exact current device can make Domain delivery progress. Besides
   * durable recipient requests, this includes stale Namespace bundles that a
   * still-authorized Room member can repair using its retained source Domain
   * envelope. Current-Domain request discovery is deliberately derived from
   * the Room participant set rather than the (possibly stale) bundle.
   */
  async listPendingSourceCoordinates(input: Readonly<{
    product: PostgresJsBridgeConnection;
    humanId: string;
    clientDeviceId: string;
    limit?: number;
    now: number;
  }>): Promise<readonly PendingDomainKeySourceCoordinate[] | null> {
    const limit = input.limit ?? 16;
    if (!PORTABLE_ID.test(input.humanId)
      || !PORTABLE_ID.test(input.clientDeviceId)) {
      throw new TypeError("Domain key pending source identity is invalid");
    }
    if (!Number.isSafeInteger(input.now) || input.now < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
      throw new RangeError("Domain key pending source bounds are invalid");
    }
    type ProductRoom = Readonly<{
      roomId: string;
      namespaceId: string;
      accessRevision: number;
      participantHumanIds: readonly string[];
    }>;
    const captureProductRooms = (): Promise<readonly ProductRoom[] | null> =>
      input.product.transactionOnce(async (transaction) => {
        const roomRows = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({
            room_id: rooms.id,
            namespace_id: rooms.namespaceId,
            namespace_access_revision: rooms.namespaceAccessRevision,
            stored_human_actor_ids: rooms.humanActorIds,
            effective_human_actor_ids: moderationEffectiveHumanActorIdsSql(sql`${rooms.humanActorIds}`, sql`${rooms.id}`).as("effective_human_actor_ids"),
          }).from(rooms)
            .innerJoin(roomMembers, and(
              eq(roomMembers.roomId, rooms.id),
              eq(roomMembers.actorId, input.humanId),
            ))
            .innerJoin(actors, and(
              eq(actors.id, roomMembers.actorId),
              eq(actors.kind, "user"),
            ))
            .where(and(
              isNull(rooms.archivedAt),
              isNull(rooms.parentRoomId),
              isNotNull(rooms.namespaceId),
              moderationAccessAllowedSql(sql`${actors.ownerId}`, sql`${rooms.id}`),
            ))
            .orderBy(asc(rooms.namespaceId))
            .limit(FOREGROUND_AUTHORITY_NAMESPACE_QUERY_BATCH + 1),
        );
        if (roomRows.length > FOREGROUND_AUTHORITY_NAMESPACE_QUERY_BATCH) {
          return null;
        }
        const roomIds = roomRows.map((row) => requiredText(row.id));
        const memberRows = roomIds.length === 0 ? []
          : await executeTypedConversationProductQuery(
            transaction,
            conversationProductTypedDb.select({
              room_id: roomMembers.roomId,
              actor_id: roomMembers.actorId,
              actor_kind: actors.kind,
            }).from(roomMembers).innerJoin(
              actors,
              eq(actors.id, roomMembers.actorId),
            ).where(inArray(roomMembers.roomId, roomIds)).orderBy(
              asc(roomMembers.roomId),
              asc(roomMembers.actorId),
            ),
          );
        const canonicalHumanActors = new Map<string, string[]>();
        for (const row of memberRows) {
          if (requiredText(row.kind) !== "user") continue;
          const roomId = requiredText(row.room_id);
          const actorId = requiredText(row.actor_id);
          const current = canonicalHumanActors.get(roomId);
          if (current === undefined) canonicalHumanActors.set(roomId, [actorId]);
          else current.push(actorId);
        }
        const roomsByNamespace = new Map<string, ProductRoom>();
        for (const row of roomRows) {
          const roomId = requiredText(row.id);
          const stored = requiredTextArray(row.human_actor_ids);
          const canonical = canonicalHumanActors.get(roomId) ?? [];
          if (stored.length !== canonical.length
            || stored.some((value, index) => value !== canonical[index])) {
            return null;
          }
          const effective = requiredTextArray(row.effective_human_actor_ids);
          if (!effective.includes(input.humanId) || effective.some(id => !canonical.includes(id))) return null;
          const room = Object.freeze({
            roomId,
            namespaceId: requiredText(row.namespace_id),
            accessRevision: requiredCounter(row.namespace_access_revision),
            participantHumanIds: Object.freeze([...effective]),
          });
          if (roomsByNamespace.has(room.namespaceId)) return null;
          roomsByNamespace.set(room.namespaceId, room);
        }
        return Object.freeze([...roomsByNamespace.values()]);
      }, { isolationLevel: "serializable" });
    const sameProductRooms = (
      left: readonly ProductRoom[],
      right: readonly ProductRoom[],
    ): boolean => left.length === right.length && left.every((room, index) => {
      const other = right[index];
      return other !== undefined
        && room.roomId === other.roomId
        && room.namespaceId === other.namespaceId
        && room.accessRevision === other.accessRevision
        && room.participantHumanIds.length === other.participantHumanIds.length
        && room.participantHumanIds.every((human, humanIndex) =>
          human === other.participantHumanIds[humanIndex]
        );
    });
    return this.restricted.transactionOnce(async (transaction) => {
      const source = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        input.humanId,
      );
      try {
        if (source === null) return Object.freeze([]);
        const productRooms = await captureProductRooms();
        if (productRooms === null) return null;
        if (productRooms.length === 0) {
          return Object.freeze([]);
        }
        const participantSets = productRooms.map((room) =>
          [...room.participantHumanIds]
        );
        const namespaceIds = productRooms.map((room) => room.namespaceId);
        const requestedRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.selectDistinctOn([
            cryptoDomains.participants,
            domainKeyRecipientRequests.keyClass,
          ], {
            domain_participants: cryptoDomains.participants,
            key_class: domainKeyRecipientRequests.keyClass,
          }).from(domainKeyRecipientRequests).innerJoin(
            cryptoDomains,
            and(
              eq(
                cryptoDomains.id,
                domainKeyRecipientRequests.domainId,
              ),
            ),
          ).innerJoin(
            domainKeyRecipientEnvelopes,
            and(
              eq(
                domainKeyRecipientEnvelopes.domainId,
                domainKeyRecipientRequests.domainId,
              ),
              eq(
                domainKeyRecipientEnvelopes.keyClass,
                domainKeyRecipientRequests.keyClass,
              ),
              eq(
                domainKeyRecipientEnvelopes.domainKeyGeneration,
                domainKeyRecipientRequests.domainKeyGeneration,
              ),
              eq(
                domainKeyRecipientEnvelopes.authorizationRevision,
                domainKeyRecipientRequests.authorizationRevision,
              ),
              eq(
                domainKeyRecipientEnvelopes.headDigest,
                domainKeyRecipientRequests.headDigest,
              ),
              eq(domainKeyRecipientEnvelopes.recipientKind, "device"),
              eq(
                domainKeyRecipientEnvelopes.recipientKeyId,
                source.deviceId,
              ),
              eq(
                domainKeyRecipientEnvelopes.recipientKeyGeneration,
                source.deviceGeneration,
              ),
            ),
          ).where(and(
            eq(domainKeyRecipientRequests.state, "pending"),
            gt(domainKeyRecipientRequests.deadlineAt, new Date(input.now)),
            inArray(cryptoDomains.participants, participantSets),
          )).orderBy(
            cryptoDomains.participants,
            domainKeyRecipientRequests.keyClass,
          ),
        );
        const namespaceBundleRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.selectDistinctOn([
            namespaceDomainKeyHeads.namespaceId,
            namespaceDomainKeyHeads.keyClass,
          ], {
            namespace_id: namespaceDomainKeyHeads.namespaceId,
            key_class: namespaceDomainKeyHeads.keyClass,
            domain_id: namespaceDomainKeyHeads.domainId,
            domain_key_generation: namespaceDomainKeyHeads.domainKeyGeneration,
            authorization_revision:
              namespaceDomainKeyHeads.domainAuthorizationRevision,
            head_digest: namespaceDomainKeyHeads.domainHeadDigest,
            namespace_access_revision:
              namespaceDomainKeyHeads.namespaceAccessRevision,
          }).from(namespaceDomainKeyHeads).innerJoin(
            domainKeyRecipientEnvelopes,
            and(
              eq(domainKeyRecipientEnvelopes.domainId,
                namespaceDomainKeyHeads.domainId),
              eq(domainKeyRecipientEnvelopes.keyClass,
                namespaceDomainKeyHeads.keyClass),
              eq(domainKeyRecipientEnvelopes.domainKeyGeneration,
                namespaceDomainKeyHeads.domainKeyGeneration),
              eq(domainKeyRecipientEnvelopes.authorizationRevision,
                namespaceDomainKeyHeads.domainAuthorizationRevision),
              eq(domainKeyRecipientEnvelopes.headDigest,
                namespaceDomainKeyHeads.domainHeadDigest),
              eq(domainKeyRecipientEnvelopes.recipientKind, "device"),
              eq(domainKeyRecipientEnvelopes.recipientKeyId, source.deviceId),
              eq(domainKeyRecipientEnvelopes.recipientKeyGeneration,
                source.deviceGeneration),
            ),
          ).where(and(
            inArray(namespaceDomainKeyHeads.namespaceId, namespaceIds),
          )).orderBy(
            namespaceDomainKeyHeads.namespaceId,
            namespaceDomainKeyHeads.keyClass,
          ),
        );
        const currentHeadRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.selectDistinctOn([
            cryptoDomains.participants,
            domainKeyHeads.keyClass,
          ], {
            domain_participants: cryptoDomains.participants,
            key_class: domainKeyHeads.keyClass,
            domain_id: domainKeyHeads.domainId,
            domain_key_generation: domainKeyHeads.domainKeyGeneration,
            authorization_revision: domainKeyHeads.authorizationRevision,
            head_digest: domainKeyHeads.headDigest,
          }).from(cryptoDomains).innerJoin(
            domainKeyHeads,
            eq(domainKeyHeads.domainId, cryptoDomains.id),
          ).where(inArray(cryptoDomains.participants, participantSets)).orderBy(
            cryptoDomains.participants,
            domainKeyHeads.keyClass,
          ),
        );
        const participantsKey = (value: DatabaseScalar): string => {
          if (!Array.isArray(value)
            || value.some((entry) => typeof entry !== "string")) {
            throw new TypeError("Expected Domain participant set");
          }
          return JSON.stringify(value);
        };
        const roomsByParticipants = new Map<string, ProductRoom[]>();
        for (const room of productRooms) {
          const key = JSON.stringify(room.participantHumanIds);
          const current = roomsByParticipants.get(key);
          if (current === undefined) roomsByParticipants.set(key, [room]);
          else current.push(room);
        }
        const currentHeads = new Map<string, (typeof currentHeadRows)[number]>();
        for (const row of currentHeadRows) {
          const id = `${participantsKey(
            row.participants,
          )}:${
            keyClass(requiredText(row.key_class))
          }`;
          if (currentHeads.has(id)) return Object.freeze([]);
          currentHeads.set(id, row);
        }
        const requestedCoordinates: PendingDomainKeySourceCoordinate[] = [];
        for (const row of requestedRows) {
          const rooms = roomsByParticipants.get(
            participantsKey(row.participants),
          ) ?? [];
          for (const room of rooms) requestedCoordinates.push(Object.freeze({
            namespaceId: room.namespaceId,
            keyClass: keyClass(requiredText(row.key_class)),
          }));
        }
        requestedCoordinates.sort((left, right) =>
          left.namespaceId.localeCompare(right.namespaceId)
          || left.keyClass.localeCompare(right.keyClass)
        );
        const staleBundleCoordinates: PendingDomainKeySourceCoordinate[] = [];
        const roomsByNamespace = new Map(productRooms.map((room) =>
          [room.namespaceId, room] as const
        ));
        for (const row of namespaceBundleRows) {
          const room = roomsByNamespace.get(requiredText(row.namespace_id));
          if (room === undefined) continue;
          const rowKeyClass = keyClass(requiredText(row.key_class));
          const current = currentHeads.get(
            `${JSON.stringify(room.participantHumanIds)}:${rowKeyClass}`,
          );
          if (current === undefined
            || requiredText(row.domain_id) !== requiredText(current.domain_id)
            || requiredCounter(row.domain_key_generation)
              !== requiredCounter(current.domain_key_generation)
            || requiredCounter(row.domain_authorization_revision)
              !== requiredCounter(current.authorization_revision)
            || !sameBytes(
              copyBytes(row.domain_head_digest),
              copyBytes(current.head_digest),
            )
            || requiredCounter(row.namespace_access_revision)
              !== room.accessRevision) {
            staleBundleCoordinates.push(Object.freeze({
              namespaceId: room.namespaceId,
              keyClass: rowKeyClass,
            }));
          }
        }
        staleBundleCoordinates.sort((left, right) =>
          left.namespaceId.localeCompare(right.namespaceId)
          || left.keyClass.localeCompare(right.keyClass)
        );
        const coordinates = new Map<string, PendingDomainKeySourceCoordinate>();
        // Requests take precedence so a source cannot be starved of current
        // Domain delivery work by a full page of stale-bundle repairs.
        for (const coordinate of [
          ...requestedCoordinates,
          ...staleBundleCoordinates,
        ]) {
          const id = `${coordinate.namespaceId}:${coordinate.keyClass}`;
          if (!coordinates.has(id)) coordinates.set(id, coordinate);
          if (coordinates.size === limit) break;
        }
        const currentProductRooms = await captureProductRooms();
        // A raced or incomplete product snapshot is retryable, not proof that
        // the source has no durable catch-up or retained-history work.
        return currentProductRooms !== null
            && sameProductRooms(productRooms, currentProductRooms)
          ? Object.freeze([...coordinates.values()])
          : null;
      } finally {
        destroyDevice(source);
      }
    });
  }

  async listPendingRequests(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    keyClass: KeyClass;
    clientDeviceId: string;
    limit?: number;
    now: number;
  }>): Promise<readonly PendingDomainKeyRecipientRequest[] | null> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    const limit = input.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
      throw new RangeError("Domain key pending request limit is invalid");
    }
    return this.restricted.transactionOnce(async (transaction) => {
      const domain = await loadDomain(transaction, snapshot);
      const source = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        snapshot.subjectHumanId,
      );
      try {
        if (domain === null || source === null) return null;
        await expirePendingRecipientRequests(transaction, {
          domainId: domain.domainId,
          keyClass: input.keyClass,
          now: new Date(input.now),
        });
        const sourceEnvelopes = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            envelope_digest: domainKeyRecipientEnvelopes.envelopeDigest,
          }).from(domainKeyRecipientEnvelopes).where(and(
            eq(domainKeyRecipientEnvelopes.domainId, domain.domainId),
            eq(domainKeyRecipientEnvelopes.keyClass, input.keyClass),
            eq(domainKeyRecipientEnvelopes.recipientKind, "device"),
            eq(domainKeyRecipientEnvelopes.recipientKeyId, source.deviceId),
            eq(
              domainKeyRecipientEnvelopes.recipientKeyGeneration,
              source.deviceGeneration,
            ),
          )).limit(1),
        );
        let selfRecoveryOnly = false;
        if (sourceEnvelopes.length !== 1) {
          const recovery = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              operation_id: cryptoDeliveryOperations.operationId,
            }).from(cryptoDeliveryOperations).where(and(
              eq(cryptoDeliveryOperations.kind, "device_recovery"),
              eq(cryptoDeliveryOperations.state, "active"),
              eq(cryptoDeliveryOperations.humanId, source.humanId),
              eq(cryptoDeliveryOperations.targetDeviceId, source.deviceId),
            )).orderBy(desc(cryptoDeliveryOperations.terminalAt)).limit(1),
          );
          if (recovery.length !== 1) return Object.freeze([]);
          selfRecoveryOnly = true;
        }
        const rows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            request_id: domainKeyRecipientRequests.requestId,
            request_bytes: domainKeyRecipientRequests.requestBytes,
            request_digest: domainKeyRecipientRequests.requestDigest,
            domain_id: domainKeyRecipientRequests.domainId,
            key_class: domainKeyRecipientRequests.keyClass,
            domain_key_generation:
              domainKeyRecipientRequests.domainKeyGeneration,
            authorization_revision:
              domainKeyRecipientRequests.authorizationRevision,
            head_digest: domainKeyRecipientRequests.headDigest,
            recipient_human_id: domainKeyRecipientRequests.recipientHumanId,
            recipient_key_id: domainKeyRecipientRequests.recipientKeyId,
            recipient_key_generation:
              domainKeyRecipientRequests.recipientKeyGeneration,
            recipient_public_key_digest:
              domainKeyRecipientRequests.recipientPublicKeyDigest,
            recipient_encryption_public_key:
              humanCryptoDevices.encryptionPublicKey,
            recipient_signing_public_key: humanCryptoDevices.signingPublicKey,
          }).from(domainKeyRecipientRequests).innerJoin(
            humanCryptoDevices,
            and(
              eq(
                humanCryptoDevices.deviceId,
                domainKeyRecipientRequests.recipientKeyId,
              ),
              eq(humanCryptoDevices.state, "active"),
            ),
          ).where(and(
            eq(domainKeyRecipientRequests.domainId, domain.domainId),
            eq(domainKeyRecipientRequests.keyClass, input.keyClass),
            eq(domainKeyRecipientRequests.state, "pending"),
            ...(selfRecoveryOnly
              ? [
                  eq(
                    domainKeyRecipientRequests.recipientHumanId,
                    source.humanId,
                  ),
                  eq(
                    domainKeyRecipientRequests.recipientKeyId,
                    source.deviceId,
                  ),
                ]
              : []),
          )).orderBy(domainKeyRecipientRequests.createdAt).limit(limit),
        );
        return Object.freeze(rows.map((row) => Object.freeze({
          requestId: requiredText(row.request_id),
          requestBytes: copyBytes(row.request_bytes),
          requestDigest: copyBytes(row.request_digest),
          domainId: requiredText(row.domain_id),
          keyClass: keyClass(requiredText(row.key_class)),
          domainKeyGeneration: requiredCounter(row.domain_key_generation),
          authorizationRevision: requiredCounter(row.authorization_revision),
          headDigest: copyBytes(row.head_digest),
          recipientHumanId: requiredText(row.recipient_human_id),
          recipientDeviceId: requiredText(row.recipient_key_id),
          recipientDeviceGeneration: requiredCounter(
            row.recipient_key_generation,
          ),
          recipientSigningPublicKey: copyBytes(
            row.signing_public_key,
          ),
          recipientEncryptionPublicKey: copyBytes(
            row.encryption_public_key,
          ),
          recipientPublicKeyDigest: copyBytes(row.recipient_public_key_digest),
        })));
      } finally {
        destroyDomain(domain);
        destroyDevice(source);
        snapshot.audienceFingerprint.fill(0);
      }
    });
  }

  async fulfilRecipientRequest(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    keyClass: KeyClass;
    clientDeviceId: string;
    requestId: string;
    authorizationBytes: Uint8Array;
    now: number;
  }>): Promise<DomainKeyRecipientFulfilmentResult | null> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    return this.restricted.transactionOnce(async (transaction) => {
      const domain = await loadDomain(transaction, snapshot);
      const source = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        snapshot.subjectHumanId,
      );
      let authorization: ReturnType<
        typeof verifyDomainKeyRecipientAuthorization
      > | null = null;
      let envelope: ReturnType<typeof verifyDomainKeyRecipientEnvelope> | null = null;
      try {
        if (domain === null || source === null) return null;
        await expirePendingRecipientRequests(transaction, {
          domainId: domain.domainId,
          keyClass: input.keyClass,
          now: new Date(input.now),
        });
        const requests = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            request_id: domainKeyRecipientRequests.requestId,
            request_digest: domainKeyRecipientRequests.requestDigest,
            domain_key_generation:
              domainKeyRecipientRequests.domainKeyGeneration,
            authorization_revision:
              domainKeyRecipientRequests.authorizationRevision,
            head_digest: domainKeyRecipientRequests.headDigest,
            recipient_human_id: domainKeyRecipientRequests.recipientHumanId,
            recipient_key_id: domainKeyRecipientRequests.recipientKeyId,
            recipient_key_generation:
              domainKeyRecipientRequests.recipientKeyGeneration,
            recipient_public_key_digest:
              domainKeyRecipientRequests.recipientPublicKeyDigest,
            state: domainKeyRecipientRequests.state,
            fulfillment_authorization_digest:
              domainKeyRecipientRequests.fulfillmentAuthorizationDigest,
            fulfillment_envelope_digest:
              domainKeyRecipientRequests.fulfillmentEnvelopeDigest,
          }).from(domainKeyRecipientRequests).where(and(
            eq(domainKeyRecipientRequests.requestId, input.requestId),
            eq(domainKeyRecipientRequests.domainId, domain.domainId),
            eq(domainKeyRecipientRequests.keyClass, input.keyClass),
          )).limit(2).for("update"),
        );
        if (requests.length !== 1) return null;
        const request = requests[0]!;
        const requestDigest = copyBytes(request.request_digest);
        const headDigest = copyBytes(request.head_digest);
        const target = await loadDevice(
          transaction,
          this.crypto,
          requiredText(request.recipient_key_id),
          requiredText(request.recipient_human_id),
        );
        const targetRecipient = target === null ? null : deviceRecipient(target);
        try {
          if (
            target === null
            || targetRecipient === null
            || target.deviceGeneration
              !== requiredCounter(request.recipient_key_generation)
            || !scalarBytesEqual(
              request.recipient_public_key_digest,
              target.encryptionPublicKeyDigest,
            )
          ) return null;
          authorization = verifyDomainKeyRecipientAuthorization(
            this.crypto,
            {
              authorizationBytes: input.authorizationBytes,
              issuerSigningPublicKey: source.signingPublicKey,
              now: input.now,
            },
          );
          if (
            authorization === null
            || authorization.authorizationOperationId !== input.requestId
            || authorization.reason !== "catch_up"
            || authorization.requestDigest === null
            || !sameBytes(authorization.requestDigest, requestDigest)
            || authorization.issuerHumanId !== source.humanId
            || authorization.issuerDeviceId !== source.deviceId
            || authorization.issuerDeviceSigningGeneration
              !== source.deviceGeneration
          ) return null;
          envelope = verifyDomainKeyRecipientEnvelope(this.crypto, {
            envelopeBytes: authorization.envelopeBytes,
            issuerSigningPublicKey: source.signingPublicKey,
          });
          if (
            envelope === null
            || !envelopeCoordinatesMatch(envelope, {
              serverId: this.serverId,
              domain,
              keyClass: input.keyClass,
              headDigest,
              headGeneration: requiredCounter(request.domain_key_generation),
              authorizationRevision:
                requiredCounter(request.authorization_revision),
              target: targetRecipient,
              issuer: source,
            })
          ) return null;
          const envelopeDigest = this.crypto.hash(authorization.envelopeBytes);
          const authorizationDigest = this.crypto.hash(input.authorizationBytes);
          try {
            const state = requiredText(request.state);
            if (state === "fulfilled") {
              const currentEnvelope = nullableBytes(
                request.fulfillment_envelope_digest,
              );
              const currentAuthorization = nullableBytes(
                request.fulfillment_authorization_digest,
              );
              try {
                if (
                  currentEnvelope !== null
                  && currentAuthorization !== null
                  && sameBytes(currentEnvelope, envelopeDigest)
                  && sameBytes(currentAuthorization, authorizationDigest)
                ) {
                  return Object.freeze({
                    status: "replayed" as const,
                    requestId: input.requestId,
                    envelopeDigest: envelopeDigest.slice(),
                    authorizationDigest: authorizationDigest.slice(),
                  });
                }
                return Object.freeze({
                  status: "lost_race" as const,
                  requestId: input.requestId,
                  envelopeDigest: envelopeDigest.slice(),
                  authorizationDigest: authorizationDigest.slice(),
                });
              } finally {
                currentEnvelope?.fill(0);
                currentAuthorization?.fill(0);
              }
            }
            if (state !== "pending") return null;
            const now = new Date(input.now);
            await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.insert(domainKeyRecipientEnvelopes).values({
                domainId: domain.domainId,
                keyClass: input.keyClass,
                domainKeyGeneration:
                  requiredCounter(request.domain_key_generation),
                authorizationRevision:
                  requiredCounter(request.authorization_revision),
                headDigest,
                recipientHumanId: target.humanId,
                recipientKind: "device",
                recipientKeyId: target.deviceId,
                recipientKeyGeneration: target.deviceGeneration,
                recipientPublicKeyDigest: target.encryptionPublicKeyDigest,
                envelopeDigest,
                envelopeBytes: authorization.envelopeBytes,
                authorizationDigest,
                authorizationBytes: input.authorizationBytes,
                sourceRequestId: input.requestId,
                issuerHumanId: source.humanId,
                issuerDeviceId: source.deviceId,
                issuerDeviceSigningGeneration: source.deviceGeneration,
                createdAt: now,
              }).onConflictDoNothing(),
            );
            const updated = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.update(domainKeyRecipientRequests).set({
                state: "fulfilled",
                fulfillmentAuthorizationDigest: authorizationDigest,
                fulfillmentEnvelopeDigest: envelopeDigest,
                updatedAt: now,
                fulfilledAt: now,
                terminalAt: now,
              }).where(and(
                eq(domainKeyRecipientRequests.requestId, input.requestId),
                eq(domainKeyRecipientRequests.state, "pending"),
              )).returning({ request_id: domainKeyRecipientRequests.requestId }),
            );
            return Object.freeze({
              status: updated.length === 1 ? "fulfilled" as const : "lost_race" as const,
              requestId: input.requestId,
              envelopeDigest: envelopeDigest.slice(),
              authorizationDigest: authorizationDigest.slice(),
            });
          } finally {
            envelopeDigest.fill(0);
            authorizationDigest.fill(0);
          }
        } finally {
          requestDigest.fill(0);
          headDigest.fill(0);
          destroyRecipient(targetRecipient);
          destroyDevice(target);
        }
      } finally {
        if (authorization !== null) {
          destroyDomainKeyRecipientAuthorizationV2(authorization);
        }
        if (envelope !== null) destroyDomainKeyRecipientEnvelopeV2(envelope);
        destroyDomain(domain);
        destroyDevice(source);
        snapshot.audienceFingerprint.fill(0);
      }
    });
  }

  async fetchEnvelope(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    keyClass: KeyClass;
    clientDeviceId: string;
    recipientKind?: "device" | "recovery";
    recoveryKeyId?: string;
    recoveryKeyGeneration?: number;
    now: number;
  }>): Promise<DomainKeyEnvelopeFetchResult | null> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    return this.restricted.transactionOnce(async (transaction) => {
      const domain = await loadDomain(transaction, snapshot);
      const target = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        snapshot.subjectHumanId,
      );
      let recipient: Recipient | null = null;
      try {
        if (domain === null || target === null) return null;
        if (input.recipientKind === "recovery") {
          recipient = await loadCurrentRecoveryRecipient(
            transaction,
            snapshot.subjectHumanId,
          );
          if (
            recipient === null
            || recipient.keyId !== input.recoveryKeyId
            || recipient.generation !== input.recoveryKeyGeneration
          ) return null;
        } else {
          recipient = deviceRecipient(target);
        }
        await expirePendingRecipientRequests(transaction, {
          domainId: domain.domainId,
          keyClass: input.keyClass,
          now: new Date(input.now),
        });
        const rows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            envelope_bytes: domainKeyRecipientEnvelopes.envelopeBytes,
            envelope_digest: domainKeyRecipientEnvelopes.envelopeDigest,
            source_request_id: domainKeyRecipientEnvelopes.sourceRequestId,
            issuer_device_id: domainKeyRecipientEnvelopes.issuerDeviceId,
            issuer_device_signing_generation:
              domainKeyRecipientEnvelopes.issuerDeviceSigningGeneration,
          }).from(domainKeyRecipientEnvelopes).innerJoin(
            domainKeyHeads,
            and(
              eq(domainKeyHeads.domainId, domainKeyRecipientEnvelopes.domainId),
              eq(domainKeyHeads.keyClass, domainKeyRecipientEnvelopes.keyClass),
              eq(
                domainKeyHeads.domainKeyGeneration,
                domainKeyRecipientEnvelopes.domainKeyGeneration,
              ),
              eq(
                domainKeyHeads.authorizationRevision,
                domainKeyRecipientEnvelopes.authorizationRevision,
              ),
            ),
          ).where(and(
            eq(domainKeyRecipientEnvelopes.domainId, domain.domainId),
            eq(domainKeyRecipientEnvelopes.keyClass, input.keyClass),
            eq(domainKeyRecipientEnvelopes.recipientKind, recipient.kind),
            eq(domainKeyRecipientEnvelopes.recipientKeyId, recipient.keyId),
            eq(
              domainKeyRecipientEnvelopes.recipientKeyGeneration,
              recipient.generation,
            ),
          )).limit(2),
        );
        if (rows.length === 0 && recipient.kind === "device") {
          const pending = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({ request_id: domainKeyRecipientRequests.requestId })
              .from(domainKeyRecipientRequests).where(and(
                eq(domainKeyRecipientRequests.domainId, domain.domainId),
                eq(domainKeyRecipientRequests.keyClass, input.keyClass),
                eq(domainKeyRecipientRequests.recipientKeyId, target.deviceId),
                eq(domainKeyRecipientRequests.state, "pending"),
              )).limit(1),
          );
          return Object.freeze({
            status: pending.length === 1 ? "pending" as const : "unavailable" as const,
          });
        }
        if (rows.length === 0) {
          return Object.freeze({ status: "unavailable" as const });
        }
        if (rows.length !== 1) return null;
        const row = rows[0]!;
        const issuerPublicKey = await loadSigningPublicKey(
          transaction,
          requiredText(row.issuer_device_id),
          requiredCounter(row.issuer_device_signing_generation),
        );
        if (issuerPublicKey === null) return null;
        const requestId = row.source_request_id === null
          ? null
          : requiredText(row.source_request_id);
        let requestDigest: Uint8Array | null = null;
        if (requestId !== null) {
          const requestRows = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({ request_digest: domainKeyRecipientRequests.requestDigest })
              .from(domainKeyRecipientRequests)
              .where(eq(domainKeyRecipientRequests.requestId, requestId))
              .limit(1),
          );
          requestDigest = requestRows.length === 1
            ? copyBytes(requestRows[0]!.request_digest)
            : null;
        }
        return Object.freeze({
          status: "ready" as const,
          requestDigest,
          envelopeBytes: copyBytes(row.envelope_bytes),
          envelopeDigest: copyBytes(row.envelope_digest),
          issuerSigningPublicKey: issuerPublicKey,
        });
      } finally {
        destroyRecipient(recipient);
        destroyDomain(domain);
        destroyDevice(target);
        snapshot.audienceFingerprint.fill(0);
      }
    });
  }

  async acknowledgeEnvelope(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    keyClass: KeyClass;
    clientDeviceId: string;
    acknowledgementBytes: Uint8Array;
    now: number;
  }>): Promise<DomainKeyEnvelopeAcknowledgementResult | null> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    return this.restricted.transactionOnce(async (transaction) => {
      const domain = await loadDomain(transaction, snapshot);
      const target = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        snapshot.subjectHumanId,
      );
      let acknowledgement: ReturnType<
        typeof verifyDomainKeyAcknowledgement
      > | null = null;
      try {
        if (domain === null || target === null) return null;
        acknowledgement = verifyDomainKeyAcknowledgement(this.crypto, {
          bytes: input.acknowledgementBytes,
          signingPublicKey: target.signingPublicKey,
          now: input.now,
        });
        if (
          acknowledgement === null
          || acknowledgement.serverId !== this.serverId
          || acknowledgement.cryptoDomainId !== domain.domainId
          || !sameBytes(
            acknowledgement.participantDigest,
            domain.participantDigest,
          )
          || acknowledgement.participantCount !== domain.participantCount
          || acknowledgement.keyClass !== input.keyClass
          || acknowledgement.humanId !== target.humanId
          || acknowledgement.recipientKeyId !== target.deviceId
          || acknowledgement.recipientKeyGeneration !== target.deviceGeneration
          || acknowledgement.deviceId !== target.deviceId
          || acknowledgement.deviceSigningKeyGeneration !== target.deviceGeneration
          || acknowledgement.processedDeviceRevision !== target.revision
        ) return null;
        const envelopes = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            envelope_digest: domainKeyRecipientEnvelopes.envelopeDigest,
          }).from(domainKeyRecipientEnvelopes).where(and(
            eq(domainKeyRecipientEnvelopes.domainId, domain.domainId),
            eq(domainKeyRecipientEnvelopes.keyClass, input.keyClass),
            eq(
              domainKeyRecipientEnvelopes.domainKeyGeneration,
              acknowledgement.domainKeyGeneration,
            ),
            eq(
              domainKeyRecipientEnvelopes.authorizationRevision,
              acknowledgement.authorizationRevision,
            ),
            eq(domainKeyRecipientEnvelopes.recipientKeyId, target.deviceId),
            eq(
              domainKeyRecipientEnvelopes.recipientKeyGeneration,
              target.deviceGeneration,
            ),
          )).limit(2),
        );
        if (
          envelopes.length !== 1
          || !scalarBytesEqual(
            envelopes[0]!.envelope_digest,
            acknowledgement.envelopeDigest,
          )
        ) return null;
        const acknowledgementDigest = this.crypto.hash(
          input.acknowledgementBytes,
        );
        try {
          const existing = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              acknowledgement_digest:
                domainKeyEnvelopeAcknowledgements.acknowledgementDigest,
            }).from(domainKeyEnvelopeAcknowledgements).where(
              eq(
                domainKeyEnvelopeAcknowledgements.acknowledgementId,
                acknowledgement.acknowledgementId,
              ),
            ).limit(2),
          );
          if (existing.length > 0) {
            if (
              existing.length !== 1
              || !scalarBytesEqual(
                existing[0]!.acknowledgement_digest,
                acknowledgementDigest,
              )
            ) return null;
            return Object.freeze({
              status: "replayed" as const,
              acknowledgementDigest: acknowledgementDigest.slice(),
            });
          }
          const inserted = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.insert(domainKeyEnvelopeAcknowledgements).values({
              acknowledgementId: acknowledgement.acknowledgementId,
              domainId: domain.domainId,
              keyClass: input.keyClass,
              domainKeyGeneration: acknowledgement.domainKeyGeneration,
              authorizationRevision: acknowledgement.authorizationRevision,
              recipientKind: "device",
              recipientKeyId: target.deviceId,
              recipientKeyGeneration: target.deviceGeneration,
              recipientDeviceId: target.deviceId,
              recipientDeviceRevision: target.revision,
              requestDigest: acknowledgement.requestDigest,
              envelopeDigest: acknowledgement.envelopeDigest,
              acknowledgementDigest,
              acknowledgementBytes: input.acknowledgementBytes,
              createdAt: new Date(input.now),
            }).onConflictDoNothing().returning({
              acknowledgement_digest:
                domainKeyEnvelopeAcknowledgements.acknowledgementDigest,
            }),
          );
          if (inserted.length === 0) {
            const collidedId = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.select({ acknowledgement_digest:
                domainKeyEnvelopeAcknowledgements.acknowledgementDigest,
              }).from(domainKeyEnvelopeAcknowledgements).where(eq(
                domainKeyEnvelopeAcknowledgements.acknowledgementId,
                acknowledgement.acknowledgementId,
              )).limit(2),
            );
            if (collidedId.length > 0) {
              if (collidedId.length !== 1 || !scalarBytesEqual(
                collidedId[0]!.acknowledgement_digest,
                acknowledgementDigest,
              )) return null;
              return Object.freeze({ status: "replayed" as const,
                acknowledgementDigest: acknowledgementDigest.slice() });
            }
            const semantic = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.select({ acknowledgement_digest:
                domainKeyEnvelopeAcknowledgements.acknowledgementDigest,
              }).from(domainKeyEnvelopeAcknowledgements).where(and(
                eq(domainKeyEnvelopeAcknowledgements.envelopeDigest,
                  acknowledgement.envelopeDigest),
                eq(domainKeyEnvelopeAcknowledgements.recipientDeviceId,
                  target.deviceId),
                eq(domainKeyEnvelopeAcknowledgements.recipientDeviceRevision,
                  target.revision),
              )).limit(2),
            );
            if (semantic.length !== 1) return null;
            return Object.freeze({ status: "replayed" as const,
              acknowledgementDigest: copyBytes(
                semantic[0]!.acknowledgement_digest,
              ) });
          }
          if (inserted.length !== 1 || !scalarBytesEqual(
            inserted[0]!.acknowledgement_digest,
            acknowledgementDigest,
          )) return null;
          return Object.freeze({
            status: "acknowledged" as const,
            acknowledgementDigest: acknowledgementDigest.slice(),
          });
        } finally {
          acknowledgementDigest.fill(0);
        }
      } finally {
        if (acknowledgement !== null) {
          destroyDomainKeyAcknowledgementV2(acknowledgement);
        }
        destroyDomain(domain);
        destroyDevice(target);
        snapshot.audienceFingerprint.fill(0);
      }
    });
  }

  async planNamespaceBundle(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    keyClass: KeyClass;
    clientDeviceId: string;
  }>): Promise<DomainNamespaceBundlePlan> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    return this.restricted.transactionOnce(async (transaction) => {
      const domain = await loadDomain(transaction, snapshot);
      const issuer = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        snapshot.subjectHumanId,
      );
      try {
        if (domain === null) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "domain_unavailable" as const,
          });
        }
        if (issuer === null) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "device_unavailable" as const,
          });
        }
        const heads = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_key_generation: domainKeyHeads.domainKeyGeneration,
            authorization_revision: domainKeyHeads.authorizationRevision,
            head_digest: domainKeyHeads.headDigest,
          }).from(domainKeyHeads).where(and(
            eq(domainKeyHeads.domainId, domain.domainId),
            eq(domainKeyHeads.keyClass, input.keyClass),
          )).limit(2).for("share"),
        );
        if (heads.length !== 1) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "head_unavailable" as const,
          });
        }
        const head = heads[0]!;
        const bundleRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_id: namespaceDomainKeyHeads.domainId,
            domain_key_generation:
              namespaceDomainKeyHeads.domainKeyGeneration,
            domain_authorization_revision:
              namespaceDomainKeyHeads.domainAuthorizationRevision,
            domain_head_digest: namespaceDomainKeyHeads.domainHeadDigest,
            namespace_access_revision:
              namespaceDomainKeyHeads.namespaceAccessRevision,
            namespace_current_generation:
              namespaceDomainKeyHeads.namespaceCurrentGeneration,
            retained_generation_count:
              namespaceDomainKeyHeads.retainedGenerationCount,
            retained_authority_set_digest:
              namespaceDomainKeyHeads.retainedAuthoritySetDigest,
            bundle_revision: namespaceDomainKeyHeads.bundleRevision,
            binding_digest: namespaceDomainKeyHeads.bindingDigest,
            binding_bytes: namespaceDomainKeyBindings.bindingBytes,
            issuer_device_id: namespaceDomainKeyBindings.issuerDeviceId,
            issuer_device_signing_generation:
              namespaceDomainKeyBindings.issuerDeviceSigningGeneration,
          }).from(namespaceDomainKeyHeads).innerJoin(
            namespaceDomainKeyBindings,
            eq(
              namespaceDomainKeyBindings.operationId,
              namespaceDomainKeyHeads.bindingOperationId,
            ),
          ).where(and(
            eq(namespaceDomainKeyHeads.namespaceId, snapshot.namespaceId),
            eq(namespaceDomainKeyHeads.keyClass, input.keyClass),
          )).limit(2).for("share"),
        );
        if (bundleRows.length === 0) {
          return Object.freeze({
            status: "create_required" as const,
            domainId: domain.domainId,
            participantDigest: domain.participantDigest.slice(),
            participantCount: domain.participantCount,
            keyClass: input.keyClass,
            domainKeyGeneration: requiredCounter(head.domain_key_generation),
            domainAuthorizationRevision:
              requiredCounter(head.authorization_revision),
            domainHeadDigest: copyBytes(head.head_digest),
            namespaceId: snapshot.namespaceId,
            namespaceAccessRevision: snapshot.accessRevision,
            namespaceCurrentGeneration: 0 as const,
            bundleRevision: 1 as const,
            retainedGenerationCount: 1 as const,
            previousBindingDigest: null,
            issuerHumanId: issuer.humanId,
            issuerDeviceId: issuer.deviceId,
            issuerDeviceSigningGeneration: issuer.deviceGeneration,
            issuerSigningPublicKey: issuer.signingPublicKey.slice(),
          });
        }
        if (bundleRows.length !== 1) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "authority_inconsistent" as const,
          });
        }
        const bundle = bundleRows[0]!;
        const currentDomainHeadDigest = copyBytes(head.head_digest);
        const bundleDomainHeadDigest = copyBytes(bundle.domain_head_digest);
        const currentBundle = requiredText(bundle.domain_id) === domain.domainId
          && requiredCounter(bundle.domain_key_generation)
            === requiredCounter(head.domain_key_generation)
          && requiredCounter(bundle.domain_authorization_revision)
            === requiredCounter(head.authorization_revision)
          && sameBytes(bundleDomainHeadDigest, currentDomainHeadDigest)
          && requiredCounter(bundle.namespace_access_revision)
            === snapshot.accessRevision
          && requiredCounter(bundle.retained_generation_count)
            === requiredCounter(bundle.namespace_current_generation) + 1;
        currentDomainHeadDigest.fill(0);
        bundleDomainHeadDigest.fill(0);
        if (!currentBundle) {
          const previousBindingDigest = copyBytes(bundle.binding_digest);
          const previousBundleRevision = requiredCounter(
            bundle.bundle_revision,
          );
          const previousGeneration = requiredCounter(
            bundle.namespace_current_generation,
          );
          const previousRetainedCount = requiredCounter(
            bundle.retained_generation_count,
          );
          const previousAccessRevision = requiredCounter(
            bundle.namespace_access_revision,
          );
          if (
            previousAccessRevision > snapshot.accessRevision
            || previousRetainedCount !== previousGeneration + 1
          ) {
            previousBindingDigest.fill(0);
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent" as const,
            });
          }
          const sourceBindingSigningPublicKey = await loadSigningPublicKey(
            transaction,
            requiredText(bundle.issuer_device_id),
            requiredCounter(bundle.issuer_device_signing_generation),
          );
          const sourceEnvelopeRows = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              envelope_bytes: domainKeyRecipientEnvelopes.envelopeBytes,
              envelope_digest: domainKeyRecipientEnvelopes.envelopeDigest,
              recipient_key_generation:
                domainKeyRecipientEnvelopes.recipientKeyGeneration,
              issuer_device_id: domainKeyRecipientEnvelopes.issuerDeviceId,
              issuer_device_signing_generation:
                domainKeyRecipientEnvelopes.issuerDeviceSigningGeneration,
            }).from(domainKeyRecipientEnvelopes).where(and(
              eq(
                domainKeyRecipientEnvelopes.domainId,
                requiredText(bundle.domain_id),
              ),
              eq(domainKeyRecipientEnvelopes.keyClass, input.keyClass),
              eq(
                domainKeyRecipientEnvelopes.domainKeyGeneration,
                requiredCounter(bundle.domain_key_generation),
              ),
              eq(
                domainKeyRecipientEnvelopes.authorizationRevision,
                requiredCounter(bundle.domain_authorization_revision),
              ),
              eq(
                domainKeyRecipientEnvelopes.headDigest,
                bundle.domain_head_digest,
              ),
              eq(
                domainKeyRecipientEnvelopes.recipientHumanId,
                issuer.humanId,
              ),
              eq(domainKeyRecipientEnvelopes.recipientKind, "device"),
              eq(
                domainKeyRecipientEnvelopes.recipientKeyId,
                issuer.deviceId,
              ),
              eq(
                domainKeyRecipientEnvelopes.recipientKeyGeneration,
                issuer.deviceGeneration,
              ),
            )).limit(2),
          );
          if (
            sourceBindingSigningPublicKey === null
            || sourceEnvelopeRows.length !== 1
          ) {
            previousBindingDigest.fill(0);
            sourceBindingSigningPublicKey?.fill(0);
            return Object.freeze({
              status: "unavailable" as const,
              reason: "recipient_sync_required" as const,
            });
          }
          const sourceEnvelope = sourceEnvelopeRows[0]!;
          const sourceEnvelopeSigningPublicKey = await loadSigningPublicKey(
            transaction,
            requiredText(sourceEnvelope.issuer_device_id),
            requiredCounter(
              sourceEnvelope.issuer_device_signing_generation,
            ),
          );
          if (sourceEnvelopeSigningPublicKey === null) {
            previousBindingDigest.fill(0);
            sourceBindingSigningPublicKey.fill(0);
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authority_inconsistent" as const,
            });
          }
          // Any authority transition that makes the current V2 binding stale
          // advances the Namespace key. This deliberately includes device
          // authorization changes: merely rewrapping an already-known content
          // key would not revoke a removed device's future access.
          const advanceGeneration = true;
          return Object.freeze({
            status: "replace_required" as const,
            domainId: domain.domainId,
            participantDigest: domain.participantDigest.slice(),
            participantCount: domain.participantCount,
            keyClass: input.keyClass,
            domainKeyGeneration: requiredCounter(head.domain_key_generation),
            domainAuthorizationRevision:
              requiredCounter(head.authorization_revision),
            domainHeadDigest: copyBytes(head.head_digest),
            namespaceId: snapshot.namespaceId,
            namespaceAccessRevision: snapshot.accessRevision,
            namespaceCurrentGeneration: previousGeneration
              + (advanceGeneration ? 1 : 0),
            bundleRevision: previousBundleRevision + 1,
            retainedGenerationCount: previousRetainedCount
              + (advanceGeneration ? 1 : 0),
            advanceGeneration,
            previousBindingDigest,
            sourceBindingBytes: copyBytes(bundle.binding_bytes),
            sourceBindingDigest: copyBytes(bundle.binding_digest),
            sourceIssuerSigningPublicKey: sourceBindingSigningPublicKey,
            sourceEnvelopeBytes: copyBytes(sourceEnvelope.envelope_bytes),
            sourceEnvelopeDigest: copyBytes(sourceEnvelope.envelope_digest),
            sourceEnvelopeIssuerSigningPublicKey:
              sourceEnvelopeSigningPublicKey,
            sourceRecipientDeviceSigningGeneration: requiredCounter(
              sourceEnvelope.recipient_key_generation,
            ),
            issuerHumanId: issuer.humanId,
            issuerDeviceId: issuer.deviceId,
            issuerDeviceSigningGeneration: issuer.deviceGeneration,
            issuerSigningPublicKey: issuer.signingPublicKey.slice(),
          });
        }
        const signingPublicKey = await loadSigningPublicKey(
          transaction,
          requiredText(bundle.issuer_device_id),
          requiredCounter(bundle.issuer_device_signing_generation),
        );
        if (signingPublicKey === null) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "authority_inconsistent" as const,
          });
        }
        return Object.freeze({
          status: "ready" as const,
          domainId: domain.domainId,
          keyClass: input.keyClass,
          bindingBytes: copyBytes(bundle.binding_bytes),
          bindingDigest: copyBytes(bundle.binding_digest),
          issuerSigningPublicKey: signingPublicKey,
        });
      } finally {
        destroyDomain(domain);
        destroyDevice(issuer);
        snapshot.audienceFingerprint.fill(0);
      }
    });
  }

  async publishNamespaceBundle(input: Readonly<{
    authority: NamespaceProductAuthoritySnapshot;
    keyClass: KeyClass;
    clientDeviceId: string;
    operationId: string;
    idempotencyKey: string;
    bindingBytes: Uint8Array;
    now: number;
  }>): Promise<DomainNamespaceBundlePublicationResult | null> {
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    return this.restricted.transactionOnce(async (transaction) => {
      const domain = await loadDomain(transaction, snapshot);
      const issuer = await loadDevice(
        transaction,
        this.crypto,
        input.clientDeviceId,
        snapshot.subjectHumanId,
      );
      let binding: ReturnType<typeof verifyDomainNamespaceBundleBindingV2> | null = null;
      try {
        if (domain === null || issuer === null) return null;
        binding = verifyDomainNamespaceBundleBindingV2(this.crypto, {
          bindingBytes: input.bindingBytes,
          issuerSigningPublicKey: issuer.signingPublicKey,
        });
        if (binding === null) return null;
        const bindingDigest = this.crypto.hash(input.bindingBytes);
        if (
          binding.operationId !== input.operationId
          || binding.serverId !== this.serverId
          || binding.cryptoDomainId !== domain.domainId
          || !sameBytes(binding.participantDigest, domain.participantDigest)
          || binding.participantCount !== domain.participantCount
          || binding.keyClass !== input.keyClass
          || binding.namespaceId !== snapshot.namespaceId
          || binding.namespaceAccessRevision !== snapshot.accessRevision
          || binding.issuerHumanId !== issuer.humanId
          || binding.issuerDeviceId !== issuer.deviceId
          || binding.issuerDeviceSigningGeneration !== issuer.deviceGeneration
        ) return null;
        const heads = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_key_generation: domainKeyHeads.domainKeyGeneration,
            authorization_revision: domainKeyHeads.authorizationRevision,
            head_digest: domainKeyHeads.headDigest,
          }).from(domainKeyHeads).where(and(
            eq(domainKeyHeads.domainId, domain.domainId),
            eq(domainKeyHeads.keyClass, input.keyClass),
          )).for("share"),
        );
        if (heads.length !== 1) return null;
        const head = heads[0]!;
        const headDigest = copyBytes(head.head_digest);
        try {
          if (
            binding.domainKeyGeneration
              !== requiredCounter(head.domain_key_generation)
            || binding.domainAuthorizationRevision
              !== requiredCounter(head.authorization_revision)
            || !sameBytes(binding.domainHeadDigest, headDigest)
          ) {
            return null;
          }
          const existing = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              operation_id: namespaceDomainKeyBindings.operationId,
              binding_digest: namespaceDomainKeyBindings.bindingDigest,
              state: namespaceDomainKeyBindings.state,
            }).from(namespaceDomainKeyBindings).where(
              eq(namespaceDomainKeyBindings.idempotencyKey, input.idempotencyKey),
            ).for("update"),
          );
          if (existing.length > 0) {
            if (
              existing.length !== 1
              || requiredText(existing[0]!.operation_id) !== input.operationId
              || requiredText(existing[0]!.state) !== "active"
              || !scalarBytesEqual(
                existing[0]!.binding_digest,
                bindingDigest,
              )
            ) return null;
            return Object.freeze({
              status: "replayed" as const,
              operationId: input.operationId,
              namespaceId: snapshot.namespaceId,
              domainId: domain.domainId,
              keyClass: input.keyClass,
              bindingDigest: bindingDigest.slice(),
            });
          }
          await lockAuthorityCoordinate(transaction, [
            "namespace_bundle",
            snapshot.namespaceId,
            input.keyClass,
          ]);
          const activeHeads = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              binding_digest: namespaceDomainKeyHeads.bindingDigest,
              bundle_revision: namespaceDomainKeyHeads.bundleRevision,
              domain_id: namespaceDomainKeyHeads.domainId,
              domain_key_generation:
                namespaceDomainKeyHeads.domainKeyGeneration,
              domain_authorization_revision:
                namespaceDomainKeyHeads.domainAuthorizationRevision,
              domain_head_digest: namespaceDomainKeyHeads.domainHeadDigest,
              namespace_access_revision:
                namespaceDomainKeyHeads.namespaceAccessRevision,
              namespace_current_generation:
                namespaceDomainKeyHeads.namespaceCurrentGeneration,
              retained_generation_count:
                namespaceDomainKeyHeads.retainedGenerationCount,
              retained_authority_set_digest:
                namespaceDomainKeyHeads.retainedAuthoritySetDigest,
            }).from(namespaceDomainKeyHeads).where(and(
              eq(namespaceDomainKeyHeads.namespaceId, snapshot.namespaceId),
              eq(namespaceDomainKeyHeads.keyClass, input.keyClass),
            )).for("update"),
          );
          const initial = activeHeads.length === 0;
          if (initial) {
            if (
              binding.bundleRevision !== 1
              || binding.previousBindingDigest !== null
              || binding.namespaceCurrentGeneration !== 0
              || binding.retainedGenerationCount !== 1
            ) return null;
          } else {
            if (activeHeads.length !== 1) return null;
            const active = activeHeads[0]!;
            const authorityDidNotAdvance =
              requiredText(active.domain_id) === domain.domainId
              && requiredCounter(active.domain_key_generation)
                === binding.domainKeyGeneration
              && requiredCounter(active.domain_authorization_revision)
                === binding.domainAuthorizationRevision
              && scalarBytesEqual(
                active.domain_head_digest,
                binding.domainHeadDigest,
              )
              && requiredCounter(active.namespace_access_revision)
                === binding.namespaceAccessRevision;
            if (
              binding.previousBindingDigest === null
              || binding.bundleRevision
                  !== requiredCounter(active.bundle_revision) + 1
              || !scalarBytesEqual(
                active.binding_digest,
                  binding.previousBindingDigest,
                )
              || authorityDidNotAdvance
              || binding.namespaceCurrentGeneration
                !== requiredCounter(active.namespace_current_generation) + 1
              || binding.retainedGenerationCount
                !== requiredCounter(active.retained_generation_count) + 1
              || scalarBytesEqual(
                active.retained_authority_set_digest,
                binding.retainedAuthoritySetDigest,
              )
            ) return null;
          }
          const now = new Date(input.now);
          const deadline = new Date(
            input.now + DOMAIN_KEY_AUTHORITY_OPERATION_TTL_MS,
          );
          await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.insert(namespaceDomainKeyBindings).values({
              operationId: input.operationId,
              idempotencyKey: input.idempotencyKey,
              namespaceId: snapshot.namespaceId,
              domainId: domain.domainId,
              keyClass: input.keyClass,
              domainKeyGeneration: binding.domainKeyGeneration,
              domainAuthorizationRevision: binding.domainAuthorizationRevision,
              domainHeadDigest: binding.domainHeadDigest,
              namespaceAccessRevision: binding.namespaceAccessRevision,
              namespaceCurrentGeneration: binding.namespaceCurrentGeneration,
              bundleRevision: binding.bundleRevision,
              retainedGenerationCount: binding.retainedGenerationCount,
              retainedAuthoritySetDigest: binding.retainedAuthoritySetDigest,
              previousBindingDigest: binding.previousBindingDigest,
              bindingDigest,
              plaintextDigest: binding.plaintextDigest,
              ciphertextDigest: binding.ciphertextDigest,
              bindingBytes: input.bindingBytes,
              issuerHumanId: issuer.humanId,
              issuerDeviceId: issuer.deviceId,
              issuerDeviceSigningGeneration: issuer.deviceGeneration,
              state: "reserved",
              failureCode: null,
              createdAt: now,
              updatedAt: now,
              deadlineAt: deadline,
              activatedAt: null,
              terminalAt: null,
            }),
          );
          const headValues = {
              namespaceId: snapshot.namespaceId,
              keyClass: input.keyClass,
              domainId: domain.domainId,
              domainKeyGeneration: binding.domainKeyGeneration,
              domainAuthorizationRevision: binding.domainAuthorizationRevision,
              domainHeadDigest: binding.domainHeadDigest,
              namespaceAccessRevision: binding.namespaceAccessRevision,
              namespaceCurrentGeneration: binding.namespaceCurrentGeneration,
              bundleRevision: binding.bundleRevision,
              retainedGenerationCount: binding.retainedGenerationCount,
              retainedAuthoritySetDigest: binding.retainedAuthoritySetDigest,
              bindingDigest,
              bindingOperationId: input.operationId,
              activatedAt: now,
          };
          if (initial) {
            await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.insert(namespaceDomainKeyHeads).values(headValues),
            );
          } else {
            const advanced = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.update(namespaceDomainKeyHeads).set(headValues)
                .where(and(
                  eq(namespaceDomainKeyHeads.namespaceId, snapshot.namespaceId),
                  eq(namespaceDomainKeyHeads.keyClass, input.keyClass),
                  eq(
                    namespaceDomainKeyHeads.bindingDigest,
                    binding.previousBindingDigest!,
                  ),
                )).returning({
                  binding_digest: namespaceDomainKeyHeads.bindingDigest,
                }),
            );
            if (
              advanced.length !== 1
              || !scalarBytesEqual(
                advanced[0]!.binding_digest,
                bindingDigest,
              )
            ) return null;
          }
          await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.update(namespaceDomainKeyBindings).set({
              state: "active",
              updatedAt: now,
              activatedAt: now,
              terminalAt: now,
            }).where(and(
              eq(namespaceDomainKeyBindings.operationId, input.operationId),
              eq(namespaceDomainKeyBindings.state, "reserved"),
            )),
          );
          return Object.freeze({
            status: "published" as const,
            operationId: input.operationId,
            namespaceId: snapshot.namespaceId,
            domainId: domain.domainId,
            keyClass: input.keyClass,
            bindingDigest: bindingDigest.slice(),
          });
        } finally {
          headDigest.fill(0);
          bindingDigest.fill(0);
        }
      } catch {
        return null;
      } finally {
        if (binding !== null) destroyDomainNamespaceBundleBindingV2(binding);
        destroyDomain(domain);
        destroyDevice(issuer);
        snapshot.audienceFingerprint.fill(0);
      }
    });
  }
}

export function createPostgresDomainKeyAuthorityRepositoryFactory(
  restricted: PostgresJsBridgeConnection,
): (serverId: string) => PostgresDomainKeyAuthorityRepository {
  const crypto = new LatticeCrypto();
  return (serverId) =>
    new PostgresDomainKeyAuthorityRepository(restricted, crypto, serverId);
}
