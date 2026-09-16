import { acquireEncryptionConsumptionFence, actors, and, eq,
  type PostgresJsBridgeConnection } from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { decodeAnyBackgroundProcessorWorkDescriptorV2, encodeBackgroundWorkDescriptorV2,
  type BackgroundAuthorizationIssuerV2, type BackgroundReflectionWorkDescriptorV2 } from "@nautilo/lattice-crypto/background";
import { PostgresNamespaceProductAuthority } from "../delivery/postgres-namespace-product-authority.ts";
import { PostgresDomainKeyAuthorityRepository } from "../delivery/postgres-domain-key-authority.ts";
import { PostgresDeviceAdmissionRepository, type CurrentDeviceAdmissionAuthority } from "../device/postgres-device-admission-repository.ts";
import { verifyCryptoPostgresHandle } from "../storage/postgres-lattice-storage.ts";
import type { ConversationProductCanonicalTransactionRunner } from "../message/postgres-conversation-product-store.ts";
import { matchesStenographerRequestAdmission, type StenographerRequestAdmission } from "./current-stenographer-authority.ts";

type CurrentNamespace = Extract<Awaited<ReturnType<
  PostgresDomainKeyAuthorityRepository["inspectForegroundNamespaceAuthority"]>>, {status: "ready"}>;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);

export function matchesCurrentReflectionAuthority(input: Readonly<{
  crypto: LatticeCrypto; serverScope: string; descriptor: BackgroundReflectionWorkDescriptorV2;
  issuer: BackgroundAuthorizationIssuerV2; device: CurrentDeviceAdmissionAuthority;
  namespaces: readonly CurrentNamespace[]; policyRevision: number; now: number;
  admission?: StenographerRequestAdmission;
}>): boolean {
  const {descriptor: d, issuer: i, device: v} = input;
  if (input.now < d.notBefore || input.now >= d.expiresAt || d.policyRevision !== input.policyRevision
    || i.humanId !== v.humanActorId || i.deviceId !== v.deviceId
    || i.deviceGeneration !== v.deviceGeneration || i.serverInstanceId !== v.serverInstanceId
    || i.lineageGeneration !== v.lineageGeneration || i.epoch !== v.epoch
    || i.securityRevision !== v.securityRevision || !same(i.headDigest, v.headDigest)
    || !same(i.signingPublicKeyHash, input.crypto.hash(v.signingPublicKey))
    || input.namespaces.length !== d.namespaceRequirements.length) return false;
  const namespaces = new Map(input.namespaces.map(entry => [entry.namespaceId, entry]));
  if (namespaces.size !== input.namespaces.length) return false;
  for (const {authority: scope} of d.namespaceRequirements) {
    const n = namespaces.get(scope.namespaceId);
    if (n === undefined || scope.serverId !== input.serverScope
      || scope.namespaceAccessRevision !== n.namespaceAccessRevision
      || scope.namespaceKeyGeneration !== n.namespaceKeyGeneration
      || !same(scope.namespaceHeadDigest, n.namespaceHeadDigest)
      || scope.domainId !== n.domainId || scope.domainKeyGeneration !== n.domainKeyGeneration
      || scope.domainAuthorizationRevision !== n.domainAuthorizationRevision
      || !same(scope.domainHeadDigest, n.domainHeadDigest)
      || scope.bundleRevision !== n.bundleRevision || !same(scope.bundleDigest, n.bundleDigest)) return false;
  }
  return input.admission === undefined || matchesStenographerRequestAdmission(input.admission, v, input.now);
}

function inTransaction(connection: Pick<PostgresJsBridgeConnection, "query">): PostgresJsBridgeConnection {
  return {query: connection.query.bind(connection), transaction: use => use(connection), transactionOnce: use => use(connection)};
}

/** One complete Human/device authority under policy -> all Rooms -> membership
 * -> restricted locks. Product validation must fence the exact Record source,
 * exposure and output/retirement receipt, using the supplied transaction.
 */
export async function withCurrentReflectionAuthority<Value>(input: Readonly<{
  runner: ConversationProductCanonicalTransactionRunner; restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto; serverScope: string; descriptor: BackgroundReflectionWorkDescriptorV2;
  issuer: BackgroundAuthorizationIssuerV2; admission?: StenographerRequestAdmission;
  now(): number; signal?: AbortSignal;
  validateProduct(product: PostgresJsBridgeConnection): Promise<boolean>;
  use(authority: Readonly<{device: CurrentDeviceAdmissionAuthority; namespaces: readonly CurrentNamespace[];
    policyRevision: number; ordinarySiblingAllowed: boolean}>, product: PostgresJsBridgeConnection, restricted: PostgresJsBridgeConnection): Promise<Value>;
}>): Promise<Value | null> {
  const decoded = decodeAnyBackgroundProcessorWorkDescriptorV2(encodeBackgroundWorkDescriptorV2(input.descriptor));
  if (decoded.subject.processorKind !== "reflection") throw new TypeError("Reflection descriptor required");
  const descriptor = decoded as BackgroundReflectionWorkDescriptorV2;
  const issuer = {...input.issuer, headDigest: Uint8Array.from(input.issuer.headDigest), signingPublicKeyHash: Uint8Array.from(input.issuer.signingPublicKeyHash)};
  const admission = input.admission === undefined ? undefined : {...input.admission, headDigest: Uint8Array.from(input.admission.headDigest)};
  const owned: Uint8Array[] = [];
  const retain = (value: object) => { for (const field of Object.values(value)) if (field instanceof Uint8Array) owned.push(field); };
  try {
    input.signal?.throwIfAborted();
    return await input.runner.transaction(async (tx, executor) => {
      const policy = await acquireEncryptionConsumptionFence(tx);
      if (policy.mode === "plaintext_only" || policy.revision !== descriptor.policyRevision) return null;
      const [human] = await tx.select({userId: actors.ownerId}).from(actors)
        .where(and(eq(actors.id, issuer.humanId), eq(actors.kind, "user")));
      if (human?.userId === null || human?.userId === undefined) return null;
      const product = inTransaction(executor);
      if (!await input.validateProduct(product)) return null;
      input.signal?.throwIfAborted();
      return new PostgresNamespaceProductAuthority(product).withCurrentHumanNamespaceSet({
        subjectUserId: human.userId, subjectHumanId: issuer.humanId,
        coordinates: descriptor.namespaceRequirements.map(({authority}) => ({roomId: authority.roomId, namespaceId: authority.namespaceId})),
        use: async entries => {
          input.signal?.throwIfAborted();
          return input.restricted.transactionOnce(async restrictedTx => {
            const restricted = inTransaction(restrictedTx);
            const domains = new PostgresDomainKeyAuthorityRepository(restricted, input.crypto, input.serverScope);
            const device = await new PostgresDeviceAdmissionRepository(await verifyCryptoPostgresHandle(restricted), input.crypto)
              .currentAuthorityForDelegation({userId: human.userId, humanActorId: issuer.humanId, deviceId: issuer.deviceId});
            if (device === null) return null;
            retain(device);
            const namespaces: CurrentNamespace[] = [];
            for (const entry of entries) {
              input.signal?.throwIfAborted();
              const writer = await domains.inspectSharedAgentWriteAuthority({authority: entry.authority, deviceId: issuer.deviceId, keyClass: "ai"});
              if (writer.status !== "ready") return null;
              retain(writer);
              const namespace = await domains.inspectForegroundNamespaceAuthority({namespaceId: entry.namespaceId, keyClass: "ai"});
              if (namespace.status !== "ready") return null;
              retain(namespace);
              if (writer.committerDeviceSigningKeyGeneration !== device.deviceGeneration
                || !same(writer.committerDeviceSigningPublicKey, device.signingPublicKey)
                || writer.namespaceAccessRevision !== namespace.namespaceAccessRevision
                || writer.namespaceKeyGeneration !== namespace.namespaceKeyGeneration
                || !same(writer.namespaceHeadDigest, namespace.namespaceHeadDigest)) return null;
              namespaces.push(namespace);
            }
            if (!matchesCurrentReflectionAuthority({crypto: input.crypto, serverScope: input.serverScope,
              descriptor, issuer, device, namespaces, policyRevision: policy.revision, now: input.now(),
              ...(admission === undefined ? {} : {admission})})) return null;
            const result = await input.use({device, namespaces, policyRevision: policy.revision, ordinarySiblingAllowed: policy.mode === "shadow_encryption"}, product, restricted);
            input.signal?.throwIfAborted();
            if (input.now() >= descriptor.expiresAt || (admission !== undefined && input.now() >= admission.expiresAt)) {
              throw new Error("Background authority expired before commit");
            }
            return result;
          }, {isolationLevel: "read committed"});
        },
      });
    }, {isolationLevel: "read committed"});
  } finally {
    owned.forEach(bytes => bytes.fill(0));
    issuer.headDigest.fill(0); issuer.signingPublicKeyHash.fill(0); admission?.headDigest.fill(0);
    for (const {authority} of descriptor.namespaceRequirements) {
      authority.namespaceHeadDigest.fill(0); authority.domainHeadDigest.fill(0); authority.bundleDigest.fill(0);
    }
    descriptor.source.fingerprint.fill(0); descriptor.recipientPublicKey.fill(0);
  }
}
