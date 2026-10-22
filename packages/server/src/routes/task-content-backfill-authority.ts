import {
  and, eq, humanCryptoCustodies, humanCryptoDeviceGroupHeads,
  humanCryptoDevices, lockCurrentTaskContentBackfillClaim,
  rooms,
  type DirectDatabase, type PostgresJsBridgeConnection,
  type TaskContentBackfillClaim,
} from "@nautilo/db";
import {
  ClassifiedDataOperationError,
  type EncryptionDataOperationOwner, type TaskContentAuthorityV1,
} from "@nautilo/lattice-bridge";
import {
  cryptoTypedDb, executeTypedCryptoQuery, readCryptoStorageInteger, PostgresDeviceAdmissionRepository,
  PostgresDomainKeyAuthorityRepository, PostgresNamespaceProductAuthority,
  verifyCryptoPostgresHandle,
  type DomainForegroundNamespaceAuthorityInspectionV2,
  type NamespaceProductAuthoritySnapshot,
} from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { CurrentDeviceAdmission } from "../auth/device-admission-gate";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import { createProtectedTaskRequesterPrivateRoomResolver } from
  "./protected-task-requester-private-room";
import { readTaskContentBackfillSource } from "./task-content-backfill-source";

export type TaskContentBackfillSubject = Readonly<{
  userId: string;
  humanActorId: string;
  admission: CurrentDeviceAdmission;
}>;

export type HeldTaskContentBackfillAuthority = Readonly<{
  claim: TaskContentBackfillClaim;
  source: NonNullable<Awaited<ReturnType<typeof readTaskContentBackfillSource>>>;
  authority: TaskContentAuthorityV1;
  namespace: DomainForegroundNamespaceAuthorityInspectionV2;
  signingPublicKey: Uint8Array;
  hostAuthorizationRevision: number;
  admissionExpiresAt: number;
  roomId: string;
  product: PostgresJsBridgeConnection;
  restricted: PostgresJsBridgeConnection;
  transaction: CanonicalTranscriptTx;
  assertCurrent(): void;
  isCurrentProductTransaction(transaction: Pick<PostgresJsBridgeConnection, "query">): boolean;
}>;

function borrow(
  transaction: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  const useBorrowed: PostgresJsBridgeConnection["transaction"] =
    use => use(transaction);
  return Object.freeze({
    query: transaction.query.bind(transaction),
    transaction: useBorrowed,
    transactionOnce: useBorrowed,
  });
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function readNamespace(transaction: CanonicalTranscriptTx, roomId: string) {
  const rows = await transaction.select({
    namespaceId: rooms.namespaceId, accessRevision: rooms.namespaceAccessRevision,
  }).from(rooms).where(eq(rooms.id, roomId)).limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** Lock current membership/custody before any canonical source or publication lock. */
export async function withCurrentTaskContentBackfillDevice<Value>(input: Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  subject: TaskContentBackfillSubject;
  now(): number;
  use(current: Readonly<{
    restricted: PostgresJsBridgeConnection;
    signingPublicKey: Uint8Array;
    hostAuthorizationRevision: number;
  }>): Promise<Value>;
}>): Promise<Value | null> {
  const { subject } = input;
  if (subject.admission.expiresAt <= input.now()) return null;
  return input.restricted.transactionOnce(async transaction => {
    const rows = await executeTypedCryptoQuery(transaction,
      cryptoTypedDb.select({ revision: humanCryptoDevices.revision })
        .from(humanCryptoDevices)
        .innerJoin(humanCryptoCustodies,
          eq(humanCryptoCustodies.humanId, humanCryptoDevices.humanId))
        .innerJoin(humanCryptoDeviceGroupHeads,
          eq(humanCryptoDeviceGroupHeads.humanId, humanCryptoDevices.humanId))
        .where(and(
          eq(humanCryptoDevices.humanId, subject.humanActorId),
          eq(humanCryptoDevices.humanActorId, subject.humanActorId),
          eq(humanCryptoDevices.userId, subject.userId),
          eq(humanCryptoDevices.deviceId, subject.admission.deviceId),
          eq(humanCryptoDevices.state, "active"),
          eq(humanCryptoCustodies.state, "active"),
        )).limit(2).for("share", {
          of: [humanCryptoDevices, humanCryptoCustodies, humanCryptoDeviceGroupHeads],
        }));
    if (rows.length !== 1) return null;
    let revision: number;
    try { revision = readCryptoStorageInteger(rows[0]!, "revision"); }
    catch { return null; }
    if (revision < 1) return null;
    const restricted = borrow(transaction);
    const current = await new PostgresDeviceAdmissionRepository(
      await verifyCryptoPostgresHandle(restricted), input.crypto,
    ).currentAuthorityForDelegation({
      userId: subject.userId, humanActorId: subject.humanActorId,
      deviceId: subject.admission.deviceId,
    });
    if (current === null) return null;
    try {
      const admitted = subject.admission;
      if (admitted.expiresAt <= input.now()
        || admitted.deviceGeneration !== current.deviceGeneration
        || admitted.serverInstanceId !== current.serverInstanceId
        || admitted.lineageGeneration !== current.lineageGeneration
        || admitted.epoch !== current.epoch
        || admitted.securityRevision !== current.securityRevision
        || !equal(admitted.headDigest, current.headDigest)) return null;
      return await input.use({ restricted,
        signingPublicKey: current.signingPublicKey,
        hostAuthorizationRevision: revision });
    } finally {
      current.signingPublicKey.fill(0);
      current.headDigest.fill(0);
    }
  }, { isolationLevel: "read committed" });
}

type BackfillDomainAuthority = Pick<PostgresDomainKeyAuthorityRepository,
  "inspectForegroundNamespaceAuthority" | "inspectMessageReadAuthority" | "inspectSharedAgentWriteAuthority">;

async function inspectCurrentBackfillNamespace(input: Readonly<{
  repository: BackfillDomainAuthority;
  productAuthority: NamespaceProductAuthoritySnapshot;
  subject: TaskContentBackfillSubject;
  signingPublicKey: Uint8Array;
  hostAuthorizationRevision: number;
  namespaceId: string;
  purpose: "read" | "write";
}>): Promise<DomainForegroundNamespaceAuthorityInspectionV2 | null> {
  const read = await input.repository.inspectMessageReadAuthority({
    authority: input.productAuthority, deviceId: input.subject.admission.deviceId, keyClass: "ai",
  });
  if (read.status !== "ready") return null;
  const proofs = [read];
  let namespace: DomainForegroundNamespaceAuthorityInspectionV2 | null = null;
  let retained = false;
  try {
    if (input.purpose === "write") {
      const write = await input.repository.inspectSharedAgentWriteAuthority({
        authority: input.productAuthority, deviceId: input.subject.admission.deviceId, keyClass: "ai",
      });
      if (write.status !== "ready") return null;
      proofs.push(write);
    }
    const inspected = await input.repository.inspectForegroundNamespaceAuthority({
      namespaceId: input.namespaceId, keyClass: "ai",
    });
    if (inspected.status !== "ready") return null;
    namespace = inspected;
    for (const proof of proofs) {
      if (proof.subjectHumanId !== input.subject.humanActorId
        || proof.committerDeviceId !== input.subject.admission.deviceId
        || proof.committerDeviceSigningKeyGeneration !== input.subject.admission.deviceGeneration
        || proof.committerDeviceRevision !== input.hostAuthorizationRevision
        || !equal(proof.committerDeviceSigningPublicKey, input.signingPublicKey)
        || proof.namespaceId !== input.namespaceId
        || proof.namespaceAccessRevision !== namespace.namespaceAccessRevision
        || proof.namespaceKeyGeneration !== namespace.namespaceKeyGeneration
        || !equal(proof.namespaceHeadDigest, namespace.namespaceHeadDigest)
        || !equal(proof.namespacePublicationDigest, namespace.namespacePublicationDigest)
        || !equal(proof.namespacePublicationSetDigest, namespace.namespacePublicationSetDigest)
        || !equal(proof.namespaceAudienceFingerprint, namespace.namespaceAudienceFingerprint)) return null;
    }
    retained = true;
    return namespace;
  } finally {
    for (const proof of [...proofs, ...(!retained && namespace !== null ? [namespace] : [])]) {
      for (const value of Object.values(proof)) if (value instanceof Uint8Array) value.fill(0);
    }
  }
}

type Dependencies = Readonly<{
  withDevice: typeof withCurrentTaskContentBackfillDevice;
  context: typeof createHumanProductTransactionContext;
  lockClaim: typeof lockCurrentTaskContentBackfillClaim;
  readSource: typeof readTaskContentBackfillSource;
  privateRoom: typeof createProtectedTaskRequesterPrivateRoomResolver;
  namespace(product: PostgresJsBridgeConnection):
    Pick<PostgresNamespaceProductAuthority, "withCurrentPrivateRoom">;
  readNamespace: typeof readNamespace;
  domain(restricted: PostgresJsBridgeConnection): BackfillDomainAuthority;
}>;

/** Historical source and mapping borrow one live, device-bound Lattice authority. */
export function createTaskContentBackfillAuthority(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  owner: EncryptionDataOperationOwner;
  now?: () => number;
}>, overrides: Partial<Dependencies> = {}) {
  const now = input.now ?? Date.now;
  const dependencies: Dependencies = {
    withDevice: withCurrentTaskContentBackfillDevice, context: createHumanProductTransactionContext,
    lockClaim: lockCurrentTaskContentBackfillClaim,
    readSource: readTaskContentBackfillSource,
    privateRoom: createProtectedTaskRequesterPrivateRoomResolver,
    namespace: product => new PostgresNamespaceProductAuthority(product),
    readNamespace,
    domain: restricted => new PostgresDomainKeyAuthorityRepository(
      restricted, input.crypto, input.serverScope,
    ),
    ...overrides,
  };
  return Object.freeze({
    async withCurrent<Value>(operation: Readonly<{
      subject: TaskContentBackfillSubject;
      claimId: string;
      /** Durable staged recovery needs current read authority, not recipient key custody. */
      purpose?: "read" | "write";
      use(current: HeldTaskContentBackfillAuthority): Promise<Value>;
    }>): Promise<Value | null> {
      const purpose = operation.purpose ?? "write";
      if (purpose !== "write" && purpose !== "read") throw new TypeError("Historical Task repair purpose is invalid");
      const subject = Object.freeze({ ...operation.subject,
        admission: Object.freeze({ ...operation.subject.admission,
          headDigest: Uint8Array.from(operation.subject.admission.headDigest) }),
      });
      try {
        return await input.owner.runMutation({
          ordinary: () => Promise.resolve(null),
          protected: () => Promise.resolve(null),
          dual: async () => dependencies.withDevice({
            restricted: input.restricted, crypto: input.crypto, subject, now,
            use: async device => {
              const context = await dependencies.context(subject.userId, input.db);
              return context.canonicalRunner.transaction(async (transaction, executor) => {
                const claim = await dependencies.lockClaim(transaction, {
                  humanActorId: subject.humanActorId,
                  deviceId: subject.admission.deviceId,
                  claimId: operation.claimId, now: new Date(now()),
                });
                if (claim === null || claim.requesterUserId !== subject.userId) return null;
                const source = await dependencies.readSource(transaction, claim);
                if (source === null) return null;
                const resolveRoom = dependencies.privateRoom(transaction);
                const expectedNamespace = source.contentNamespaceId ?? undefined;
                const room = await resolveRoom(subject.userId, source.agentId, expectedNamespace);
                if (room === null) return null;
                const product = borrow(executor);
                return dependencies.namespace(product).withCurrentPrivateRoom({
                  subjectUserId: subject.userId, subjectHumanId: subject.humanActorId,
                  roomId: room.roomId, namespaceId: room.namespaceId,
                  use: async productAuthority => {
                    // Membership locks are held; revalidate the pinned Human-private Room and Namespace.
                    const exactRoom = await resolveRoom(subject.userId, source.agentId, room.namespaceId);
                    if (exactRoom?.roomId !== room.roomId) return null;
                    const namespace = await inspectCurrentBackfillNamespace({
                      repository: dependencies.domain(device.restricted), productAuthority, subject,
                      signingPublicKey: device.signingPublicKey,
                      hostAuthorizationRevision: device.hostAuthorizationRevision,
                      namespaceId: room.namespaceId, purpose,
                    });
                    if (namespace === null) return null;
                    const productNamespace = await dependencies.readNamespace(transaction, room.roomId);
                    if (productNamespace === null
                      || productNamespace.namespaceId !== namespace.namespaceId
                      || productNamespace.accessRevision !== namespace.namespaceAccessRevision) {
                      for (const value of Object.values(namespace)) {
                        if (value instanceof Uint8Array) value.fill(0);
                      }
                      return null;
                    }
                    let active = true;
                    const assertCurrent = () => {
                      if (!active || subject.admission.expiresAt <= now()
                        || claim.expiresAt.getTime() <= now()) {
                        throw new ClassifiedDataOperationError(
                          "authority", "Historical Task repair authority is no longer active",
                        );
                      }
                    };
                    try {
                      assertCurrent();
                      const result = await operation.use(Object.freeze({
                        claim, source, namespace,
                        authority: Object.freeze({
                          authorityVersion: 1 as const,
                          kind: "requester_private_namespace" as const, keyClass: "ai" as const,
                          requesterHumanId: subject.humanActorId,
                          namespaceId: room.namespaceId, domainId: namespace.domainId,
                          expectedAccessRevision: namespace.namespaceAccessRevision,
                          expectedPolicyRevision: claim.policyRevision,
                        }),
                        signingPublicKey: device.signingPublicKey,
                        hostAuthorizationRevision: device.hostAuthorizationRevision,
                        admissionExpiresAt: subject.admission.expiresAt,
                        roomId: room.roomId,
                        isCurrentProductTransaction: candidate => active && candidate === executor,
                        product, restricted: device.restricted, transaction, assertCurrent,
                      }));
                      assertCurrent();
                      return result;
                    } finally {
                      active = false;
                      for (const value of Object.values(namespace)) {
                        if (value instanceof Uint8Array) value.fill(0);
                      }
                    }
                  },
                });
              }, { isolationLevel: "read committed" });
            },
          }),
        });
      } finally { subject.admission.headDigest.fill(0); }
    },
  });
}
