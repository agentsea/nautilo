import { acquireEncryptionConsumptionFence, actors, and, eq,
  type PostgresJsBridgeConnection } from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { decodeBackgroundProcessorWorkDescriptorV2, encodeBackgroundWorkDescriptorV2,
  type BackgroundAuthorizationIssuerV2, type BackgroundProcessorWorkDescriptorV2 } from "@nautilo/lattice-crypto/background";
import { PostgresNamespaceProductAuthority } from "../delivery/postgres-namespace-product-authority.ts";
import { PostgresDomainKeyAuthorityRepository } from "../delivery/postgres-domain-key-authority.ts";
import { PostgresDeviceAdmissionRepository,
  type CurrentDeviceAdmissionAuthority } from "../device/postgres-device-admission-repository.ts";
import { verifyCryptoPostgresHandle } from "../storage/postgres-lattice-storage.ts";
import type { ConversationProductCanonicalTransactionRunner } from "../message/postgres-conversation-product-store.ts";

type CurrentNamespace = Extract<Awaited<ReturnType<
  PostgresDomainKeyAuthorityRepository["inspectForegroundNamespaceAuthority"]>>, {status: "ready"}>;

/** Already authenticated by the HTTP admission gate, then rechecked under locks.
 * An execution with an accepted signed grant no longer needs the original bearer.
 */
export interface StenographerRequestAdmission {
  readonly userId: string;
  readonly humanActorId: string;
  readonly deviceId: string;
  readonly deviceGeneration: number;
  readonly serverInstanceId: string;
  readonly lineageGeneration: number;
  readonly epoch: number;
  readonly securityRevision: number;
  readonly headDigest: Uint8Array;
  readonly expiresAt: number;
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function matchesStenographerRequestAdmission(
  a: StenographerRequestAdmission, v: CurrentDeviceAdmissionAuthority, now: number,
): boolean {
  return a.expiresAt > now && a.userId === v.userId && a.humanActorId === v.humanActorId
    && a.deviceId === v.deviceId && a.deviceGeneration === v.deviceGeneration
    && a.serverInstanceId === v.serverInstanceId && a.lineageGeneration === v.lineageGeneration
    && a.epoch === v.epoch && a.securityRevision === v.securityRevision && same(a.headDigest, v.headDigest);
}

export function matchesCurrentStenographerAuthority(input: Readonly<{
  crypto: LatticeCrypto;
  serverScope: string;
  descriptor: BackgroundProcessorWorkDescriptorV2;
  issuer: BackgroundAuthorizationIssuerV2;
  device: CurrentDeviceAdmissionAuthority;
  namespace: CurrentNamespace;
  policyRevision: number;
  now: number;
  admission?: StenographerRequestAdmission;
}>): boolean {
  const {descriptor: d, issuer: i, device: v, namespace: n, admission: a} = input;
  const scope = d.authority;
  if (input.now < d.notBefore || input.now >= d.expiresAt
    || scope.serverId !== input.serverScope || d.policyRevision !== input.policyRevision
    || d.anchorNamespaceId !== scope.namespaceId || d.anchorDomainId !== scope.domainId
    || d.inputBindings.some((binding) => binding.namespaceId !== d.anchorNamespaceId)
    || d.outputSlots.some((slot) => slot.namespaceIds.length !== 1
      || slot.namespaceIds[0] !== d.anchorNamespaceId)
    || i.humanId !== v.humanActorId || i.deviceId !== v.deviceId
    || i.deviceGeneration !== v.deviceGeneration || i.serverInstanceId !== v.serverInstanceId
    || i.lineageGeneration !== v.lineageGeneration || i.epoch !== v.epoch
    || i.securityRevision !== v.securityRevision || !same(i.headDigest, v.headDigest)
    || !same(i.signingPublicKeyHash, input.crypto.hash(v.signingPublicKey))
    || scope.namespaceId !== n.namespaceId || scope.namespaceAccessRevision !== n.namespaceAccessRevision
    || scope.namespaceKeyGeneration !== n.namespaceKeyGeneration || !same(scope.namespaceHeadDigest, n.namespaceHeadDigest)
    || scope.domainId !== n.domainId || scope.domainKeyGeneration !== n.domainKeyGeneration
    || scope.domainAuthorizationRevision !== n.domainAuthorizationRevision || !same(scope.domainHeadDigest, n.domainHeadDigest)
    || scope.bundleRevision !== n.bundleRevision || !same(scope.bundleDigest, n.bundleDigest)) return false;
  return a === undefined || matchesStenographerRequestAdmission(a, v, input.now);
}

function inTransaction(connection: Pick<PostgresJsBridgeConnection, "query">): PostgresJsBridgeConnection {
  return {query: connection.query.bind(connection), transaction: use => use(connection),
    transactionOnce: use => use(connection)};
}

/** Existing policy -> Room/membership -> restricted authority lock order.
 * The callback must use the supplied connections for an atomic acceptance or
 * publication check. It must not open a second product transaction or call a model.
 * Exact source/claim freshness remains the Stenographer product CAS's responsibility.
 */
export async function withCurrentStenographerAuthority<Value>(input: Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  descriptor: BackgroundProcessorWorkDescriptorV2;
  issuer: BackgroundAuthorizationIssuerV2;
  admission?: StenographerRequestAdmission;
  now(): number;
  signal?: AbortSignal;
  /** Receipt-only validation before Namespace locks parent -> source Rooms.
   * Must not lock Room, journal state or source rows in this phase. */
  validatePublication?: (product: PostgresJsBridgeConnection) => Promise<boolean>;
  /** Other source metadata is locked after Room authority, before restricted authority. */
  validateProduct?: (product: PostgresJsBridgeConnection) => Promise<boolean>;
  use(authority: Readonly<{device: CurrentDeviceAdmissionAuthority; namespace: CurrentNamespace;
    policyRevision: number}>, product: PostgresJsBridgeConnection,
    restricted: PostgresJsBridgeConnection): Promise<Value>;
}>): Promise<Value | null> {
  // Own the signed coordinates across asynchronous transaction boundaries.
  const descriptor = decodeBackgroundProcessorWorkDescriptorV2(encodeBackgroundWorkDescriptorV2(input.descriptor));
  const issuer = {...input.issuer, headDigest: Uint8Array.from(input.issuer.headDigest),
    signingPublicKeyHash: Uint8Array.from(input.issuer.signingPublicKeyHash)};
  const admission = input.admission === undefined ? undefined
    : {...input.admission, headDigest: Uint8Array.from(input.admission.headDigest)};
  try {
    input.signal?.throwIfAborted();
    return await input.runner.transaction(async (tx, executor) => {
      const policy = await acquireEncryptionConsumptionFence(tx);
      if (policy.mode === "plaintext_only" || policy.revision !== descriptor.policyRevision
        || (descriptor.workKind === "stenographer.output_repair" && policy.mode !== "shadow_encryption")) return null;
      // Resolve the lookup coordinate without taking the Actor lock before the
      // Room. The namespace authority locks Room -> Actor and rechecks this owner.
      const [human] = await tx.select({userId: actors.ownerId}).from(actors)
        .where(and(eq(actors.id, issuer.humanId), eq(actors.kind, "user")));
      if (human?.userId === null || human?.userId === undefined) return null;
      const product = inTransaction(executor);
      // Lock only the receipt here. Namespace authority must acquire parent
      // before subthread Rooms; remaining source locks belong after that step.
      if (input.validatePublication !== undefined && !await input.validatePublication(product)) return null;
      return new PostgresNamespaceProductAuthority(product).withCurrentReadableNamespace({
        subjectUserId: human.userId, subjectHumanId: issuer.humanId,
        sourceRoomId: descriptor.authority.roomId, namespaceId: descriptor.anchorNamespaceId, keyClass: "ai",
        use: async snapshot => {
          if (input.validateProduct !== undefined && !await input.validateProduct(product)) return null;
          return input.restricted.transactionOnce(async restrictedTx => {
          const restricted = inTransaction(restrictedTx);
          const domains = new PostgresDomainKeyAuthorityRepository(restricted, input.crypto, input.serverScope);
          const owned: Uint8Array[] = [];
          const retain = (value: object) => {
            for (const field of Object.values(value)) if (field instanceof Uint8Array) owned.push(field);
          };
          try {
            // This existing authority owner verifies the live Domain head,
            // participant set and device recipient; it does not require an Agent identity.
            const writer = await domains.inspectSharedAgentWriteAuthority({
              authority: snapshot, deviceId: issuer.deviceId, keyClass: "ai",
            });
            if (writer.status !== "ready") return null;
            retain(writer);
            const namespace = await domains.inspectForegroundNamespaceAuthority({
              namespaceId: descriptor.anchorNamespaceId, keyClass: "ai",
            });
            if (namespace.status !== "ready") return null;
            retain(namespace);
            const device = await new PostgresDeviceAdmissionRepository(
              await verifyCryptoPostgresHandle(restricted), input.crypto,
            ).currentAuthorityForDelegation({userId: human.userId, humanActorId: issuer.humanId,
              deviceId: issuer.deviceId});
            if (device === null) return null;
            retain(device);
            if (writer.committerDeviceSigningKeyGeneration !== device.deviceGeneration
              || !same(writer.committerDeviceSigningPublicKey, device.signingPublicKey)
              || writer.namespaceAccessRevision !== namespace.namespaceAccessRevision
              || writer.namespaceKeyGeneration !== namespace.namespaceKeyGeneration
              || !same(writer.namespaceHeadDigest, namespace.namespaceHeadDigest)
              || !matchesCurrentStenographerAuthority({crypto: input.crypto, serverScope: input.serverScope,
                descriptor, issuer, device, namespace, policyRevision: policy.revision, now: input.now(),
                ...(admission === undefined ? {} : {admission})})) return null;
            input.signal?.throwIfAborted();
            const result = await input.use({device, namespace, policyRevision: policy.revision}, product, restricted);
            input.signal?.throwIfAborted();
            if (input.now() >= descriptor.expiresAt || (admission !== undefined && input.now() >= admission.expiresAt)) {
              throw new Error("Background authority expired before commit");
            }
            return result;
          } finally { owned.forEach(bytes => bytes.fill(0)); }
        }, {isolationLevel: "read committed"});
        },
      });
    }, {isolationLevel: "read committed"});
  } finally {
    issuer.headDigest.fill(0); issuer.signingPublicKeyHash.fill(0); admission?.headDigest.fill(0);
    descriptor.authority.namespaceHeadDigest.fill(0); descriptor.authority.domainHeadDigest.fill(0);
    descriptor.authority.bundleDigest.fill(0); descriptor.source.fingerprint.fill(0); descriptor.recipientPublicKey.fill(0);
  }
}
