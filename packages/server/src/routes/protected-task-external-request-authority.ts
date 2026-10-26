import {
  createPostgresJsBridgeConnection, getEncryptionTransitionPolicy,
  type DirectDatabase, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import {
  inspectDomainKeyV2CryptoAuthority, PostgresDomainKeyAuthorityRepository,
  PostgresNamespaceProductAuthority,
} from "@nautilo/lattice-bridge/server";
import { envelopeReadableNamespaces, getPolicyResolver } from "@nautilo/trust";
import type { LiveShadowMessageClientSessionInspector } from "./live-shadow-message";
import { createProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";
import { wipeDomainForegroundReadSnapshot, type DomainForegroundReadBinding,
  type DomainForegroundReadSnapshot } from "./foreground-domain-read-authority";
import type { ProtectedTaskExternalRequestIdentity } from "./protected-task-external-requests";

type Inspect = (binding: DomainForegroundReadBinding, identity: ProtectedTaskExternalRequestIdentity)
  => Promise<DomainForegroundReadSnapshot | null>;

/** Current reader authority only. The live registry independently proves the original execution. */
export function createProtectedTaskExternalRequestAuthority(input: Readonly<{
  db: DirectDatabase; restricted: PostgresJsBridgeConnection; crypto: LatticeCrypto;
  serverScope: string; owner: EncryptionDataOperationOwner;
  clientSessions: LiveShadowMessageClientSessionInspector;
}>, overrides: Partial<Readonly<{
  resolveSourceRoom: ReturnType<typeof createProtectedTaskRequesterPrivateRoomResolver>;
  readPolicy: typeof getEncryptionTransitionPolicy;
  inspect: Inspect;
}>> = {}): Inspect {
  const resolveSourceRoom = overrides.resolveSourceRoom ?? createProtectedTaskRequesterPrivateRoomResolver(input.db);
  const readPolicy = overrides.readPolicy ?? getEncryptionTransitionPolicy;
  const sessionCurrent = (binding: DomainForegroundReadBinding) => {
    const session = input.clientSessions.inspect({ clientActionSessionId: binding.clientActionSessionId,
      actorId: binding.humanActorId });
    return session?.initiatingClientSurface === "workbench.browser"
      || session?.initiatingClientSurface === "workbench.desktop";
  };
  const inspect: Inspect = overrides.inspect ?? (async (binding, identity) => {
    const repository = new PostgresDomainKeyAuthorityRepository(input.restricted, input.crypto, input.serverScope);
    const policy = await readPolicy(input.db);
    if (policy.mode === "plaintext_only") return null;
    const inspected = await inspectDomainKeyV2CryptoAuthority({
      productAuthority: new PostgresNamespaceProductAuthority(createPostgresJsBridgeConnection(input.db)),
      repository, exactNamespaceOnly: true,
      planInput: { authority: { userId: binding.userId, humanActorId: binding.humanActorId }, clientDeviceId: binding.clientDeviceId },
      product: { roomId: identity.sourceRoomId, namespaceId: identity.namespaceId, agentId: identity.agentId },
      topLevelRoomId: identity.sourceRoomId,
      resolveReadableNamespaces: async coordinates => {
        const resolver = getPolicyResolver();
        if (resolver === null) throw new Error("Protected Task request policy unavailable");
        const envelope = await resolver.buildEnvelope(coordinates.humanActorId,
          `task:${identity.taskId}`, coordinates.agentId, coordinates.roomId);
        if (envelope.ownerId !== binding.userId || envelope.actorId !== binding.humanActorId) {
          throw new Error("Protected Task request viewer changed");
        }
        return envelopeReadableNamespaces(envelope);
      },
    });
    if (inspected.status !== "ready") return null;
    const authority = inspected.authority;
    let transferred = false;
    let signingKey: Uint8Array | null = null;
    try {
      signingKey = await repository.inspectForegroundDeviceSigningAuthority({ userId: binding.userId,
        subjectHumanId: binding.humanActorId, deviceId: binding.clientDeviceId,
        generation: authority.committerDeviceSigningKeyGeneration, revision: authority.hostAuthorizationRevision });
      if (signingKey === null || (await readPolicy(input.db)).revision !== policy.revision) return null;
      transferred = true;
      return { policyRevision: policy.revision, namespaceAuthority: authority.room,
        domains: authority.domains, committerDeviceId: authority.committerDeviceId,
        committerDeviceSigningKeyGeneration: authority.committerDeviceSigningKeyGeneration,
        hostAuthorizationRevision: authority.hostAuthorizationRevision, committerDeviceSigningPublicKey: signingKey };
    } finally {
      if (!transferred) {
        signingKey?.fill(0);
        for (const value of Object.values(authority.room)) if (value instanceof Uint8Array) value.fill(0);
        for (const domain of authority.domains) {
          domain.participantDigest.fill(0); domain.headDigest.fill(0); domain.activeNamespaceBindingSetDigest.fill(0);
        }
      }
    }
  });
  return async (binding, identity) => {
    if (binding.userId !== identity.requestorId || binding.humanActorId !== identity.humanActorId
      || !sessionCurrent(binding)) return null;
    let owned: DomainForegroundReadSnapshot | null = null;
    let transferred = false;
    try {
      const current = async () => {
        const source = await resolveSourceRoom(identity.requestorId, identity.agentId, identity.namespaceId);
        if (source === null || source.roomId !== identity.sourceRoomId || source.namespaceId !== identity.namespaceId) return null;
        owned = await inspect(binding, identity);
        if (owned === null || !sessionCurrent(binding) || owned.committerDeviceId !== binding.clientDeviceId
          || owned.namespaceAuthority.namespaceId !== identity.namespaceId) return null;
        return owned;
      };
      const result = await input.owner.selectReadMetadata({ ordinary: () => Promise.resolve(null), fallback: current, protected: current });
      transferred = result !== null;
      return result;
    } finally { if (owned !== null && !transferred) wipeDomainForegroundReadSnapshot(owned); }
  };
}
