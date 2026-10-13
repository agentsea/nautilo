import { isDeepStrictEqual } from "node:util";
import { domainForegroundAuthoritySetDigest, type DomainForegroundAuthorityEntry,
  type LatticeCrypto } from "@nautilo/lattice-crypto";
import { ProtectedCheckpointCryptoError } from "@nautilo/lattice-bridge";
import { createDomainCompressedLiveShadowSessionCapability,
  destroyDomainCompressedLiveShadowSessionCapability,
  withDomainCompressedLiveShadowSessionCapabilityEntries,
  type DomainForegroundNamespaceAuthorityInspectionV2, type LiveShadowRecipientRegistry,
  type RuntimeLiveShadowForegroundAuthorizationScope } from "@nautilo/lattice-bridge/server";
import { createForegroundAgentEntityCryptoGateway, createForegroundEntityCheckpointAuthorization } from "./foreground-agent-entity-crypto-gateway";
import { createDomainForegroundReadAuthority,
  DomainForegroundReadUnavailable as CheckpointReadUnavailable,
  type DomainForegroundReadBinding, type DomainForegroundReadSnapshot } from "./foreground-domain-read-authority";
export type CheckpointReadBinding = DomainForegroundReadBinding;

export type ForegroundCheckpointReadBinding = CheckpointReadBinding;

export type CheckpointReadLocator = Readonly<{
  checkpointThreadId: string;
  topLevelRoomId: string;
  namespaceId: string;
}>;

export type ForegroundCheckpointReadLocator = Readonly<{
  reviewTurnId: string;
  turnId: string;
  generationId: string;
  accessScope: string;
  firstMessageId: number;
  threadId: string;
  laneKey: string;
  createdAt: Date;
  checkpointThreadId: string;
  sessionId: string;
  roomId: string;
  topLevelRoomId: string;
  agentId: string;
  namespaceId: string;
  entrypointId: "foreground.main" | "foreground.fork";
}>;

/** Owned public authority bytes; the service wipes each returned snapshot. */
export type ForegroundCheckpointReadSnapshot = Readonly<{
  policyRevision: number;
  agentAuthorizationRevision: number;
  committerDeviceId: string;
  committerDeviceSigningKeyGeneration: number;
  committerDeviceSigningPublicKey: Uint8Array;
  hostAuthorizationRevision: number;
  room: Omit<DomainForegroundNamespaceAuthorityInspectionV2, "status">;
  domains: readonly DomainForegroundAuthorityEntry[];
}>;

/** Owned public authority bytes; the service wipes each returned snapshot. */
export type CheckpointReadSnapshot = DomainForegroundReadSnapshot;

type CheckpointAuthorization = ReturnType<typeof createForegroundEntityCheckpointAuthorization>;

export function createCheckpointReadAuthority<Locator extends CheckpointReadLocator, Checkpoint,
  Snapshot extends CheckpointReadSnapshot = CheckpointReadSnapshot>(input:
  Omit<Parameters<typeof createDomainForegroundReadAuthority<Locator, Checkpoint, Snapshot>>[0], "withAuthority">
  & Readonly<{ withCheckpoint: Parameters<typeof createDomainForegroundReadAuthority<Locator, Checkpoint, Snapshot>>[0]["withAuthority"] }>) {
  return createDomainForegroundReadAuthority<Locator, Checkpoint, Snapshot>({
    ...input, withAuthority: input.withCheckpoint,
  });
}
function wipeOnAbort(signal: AbortSignal, wipe: () => void): () => void {
  signal.addEventListener("abort", wipe, { once: true });
  if (signal.aborted) wipe();
  return () => signal.removeEventListener("abort", wipe);
}
type ForegroundCheckpointBrokerSnapshot = CheckpointReadSnapshot & Readonly<{
  agentAuthorizationRevision: number;
}>;

/**
 * Foreground adapter for the generic one-use checkpoint custody. Namespace-key
 * access and the entity gateway remain private to this compatibility wrapper.
 */
export function createForegroundCheckpointReadAuthority(input: Readonly<{
  crypto: LatticeCrypto;
  recipients: LiveShadowRecipientRegistry;
  namespaceKeys: Parameters<typeof createForegroundAgentEntityCryptoGateway>[0]["namespaceKeys"];
  resolveCurrent(
    binding: ForegroundCheckpointReadBinding,
    locator: ForegroundCheckpointReadLocator,
  ): Promise<ForegroundCheckpointReadSnapshot | null>;
  now?: () => number;
}>) {
  return createCheckpointReadAuthority<
    ForegroundCheckpointReadLocator,
    CheckpointAuthorization,
    ForegroundCheckpointBrokerSnapshot
  >({
    crypto: input.crypto,
    recipients: input.recipients,
    ...(input.now === undefined ? {} : { now: input.now }),
    resolveCurrent: async (binding, locator) => {
      const snapshot = await input.resolveCurrent(binding, locator);
      return snapshot === null ? null : Object.freeze({
        policyRevision: snapshot.policyRevision,
        agentAuthorizationRevision: snapshot.agentAuthorizationRevision,
        committerDeviceId: snapshot.committerDeviceId,
        committerDeviceSigningKeyGeneration:
          snapshot.committerDeviceSigningKeyGeneration,
        committerDeviceSigningPublicKey:
          snapshot.committerDeviceSigningPublicKey,
        hostAuthorizationRevision: snapshot.hostAuthorizationRevision,
        namespaceAuthority: snapshot.room,
        domains: snapshot.domains,
      });
    },
    withCheckpoint: async (context, use) => {
      const { binding, locator, snapshot } = context;
      const scope: RuntimeLiveShadowForegroundAuthorizationScope = Object.freeze({
        subjectHumanId: binding.humanActorId,
        issuingDeviceId: binding.clientDeviceId,
        recipientKind: "nautilo_foreground_runtime",
        browserSessionId: binding.clientActionSessionId,
        topLevelRoomId: locator.topLevelRoomId,
        policyRevision: snapshot.policyRevision,
        hostAuthorizationRevision: snapshot.hostAuthorizationRevision,
        namespaceIds: [locator.namespaceId],
        grantDomainIds: snapshot.domains.map((domain) => domain.domainId),
        domainAuthoritySetDigest:
          domainForegroundAuthoritySetDigest(input.crypto, snapshot.domains),
      });
      try {
        const capability = createDomainCompressedLiveShadowSessionCapability({
          description: {
            ...scope,
            authorizationId: context.authorizationId,
            recipientKeyId: context.recipientKeyId,
            issuedAt: context.issuedAt,
            expiresAt: context.deadlineAt,
            authorizationDigest: context.authorizationDigest,
          },
          entries: context.domains.map((entry) => ({
            grantDomainId: entry.domainId,
            participantDigest: entry.participantDigest,
            domainKeyGeneration: entry.domainKeyGeneration,
            headDigest: entry.headDigest,
            authorizationRevision: entry.authorizationRevision,
            domainAiGrantKey: entry.domainKey,
          })),
        });
        context.domains.forEach((entry) => entry.domainKey.fill(0));
        const detachCapability = wipeOnAbort(context.signal,
          () => destroyDomainCompressedLiveShadowSessionCapability(capability));
        try {
          const gateway = createForegroundAgentEntityCryptoGateway({
            namespaceKeys: {
              inspectForegroundNamespaceAuthority: (request) =>
                input.namespaceKeys.inspectForegroundNamespaceAuthority(request),
              withOpenedForegroundNamespaceKey: (request) =>
                input.namespaceKeys.withOpenedForegroundNamespaceKey({
                  ...request,
                  use: async (key) => {
                    const detach = wipeOnAbort(context.signal, () => key.fill(0));
                    try { return await request.use(key); }
                    finally { detach(); key.fill(0); }
                  },
                }),
            },
            openCapabilityEntries: (value, consume) =>
              withDomainCompressedLiveShadowSessionCapabilityEntries(
                value,
                async (borrowed) => {
                  const detach = wipeOnAbort(context.signal,
                    () => borrowed.forEach(
                      (entry) => entry.domainAiGrantKey.fill(0),
                    ));
                  try { return await consume(borrowed); }
                  finally { detach(); }
                },
              ),
            authorizations: {
              execute: async (operation) => {
                if (context.signal.aborted
                  || operation.sessionReference !== context.authorizationId
                  || operation.scope !== scope
                  || operation.entrypointId !== locator.entrypointId
                  || !isDeepStrictEqual(operation.operations, ["decrypt"])) {
                  return { status: "unavailable", reason: "session_cancelled" };
                }
                const value = await operation.execute(capability, context.signal);
                return context.signal.aborted ? {
                  status: "unavailable", reason: "session_cancelled",
                } : value;
              },
            },
          });
          const result = await gateway.execute({
            sessionReference: context.authorizationId,
            scope,
            entrypointId: locator.entrypointId,
            operations: ["decrypt"],
            execute: ({ entities }) => {
              const authority = snapshot.namespaceAuthority;
              const checkpoint = createForegroundEntityCheckpointAuthorization({
                crypto: input.crypto,
                entities,
                namespaceId: authority.namespaceId,
                namespaceAccessRevision: authority.namespaceAccessRevision,
                namespaceKeyGeneration: authority.namespaceKeyGeneration,
                domainId: authority.domainId,
                agentAuthorizationRevision: snapshot.agentAuthorizationRevision,
                authorizationDeadlineAt: context.deadlineAt,
                entrypointId: locator.entrypointId,
              });
              const readCrypto: CheckpointAuthorization["crypto"] = {
                ...checkpoint.crypto,
                executeAuthorizedOperation: async (operation) => {
                  if (operation.operation !== "read"
                    || operation.scope.logicalThreadId
                      !== locator.checkpointThreadId) {
                    throw new ProtectedCheckpointCryptoError(
                      "authorization_unavailable",
                      "checkpoint read scope changed",
                    );
                  }
                  return checkpoint.crypto.executeAuthorizedOperation(operation);
                },
              };
              return use(Object.freeze({
                ...checkpoint,
                crypto: Object.freeze(readCrypto),
              }));
            },
          });
          if (result.status !== "executed") {
            throw new CheckpointReadUnavailable(
              "checkpoint read session was cancelled",
            );
          }
          return result.value;
        } finally {
          detachCapability();
          destroyDomainCompressedLiveShadowSessionCapability(capability);
        }
      } finally {
        scope.domainAuthoritySetDigest.fill(0);
      }
    },
  });
}
