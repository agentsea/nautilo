import {
  agentId,
  agentRuntimeSignerPublicationMatchesRuntime,
  type HistoricalCommitterResolver,
  type LatticeCrypto,
  type LatticeStorage,
  type ResolveCurrentAgentObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import {
  parseGrantV2,
  type HistoricalAgentRuntimeCommitterResolverV1,
} from "@nautilo/lattice-crypto/wire";

import {
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS,
  withProtectedAgentRuntimeGeneration,
  type ProtectedAgentRuntimeForegroundEntrypointId,
} from "../invocation/protected-agent-runtime.ts";
import {
  executeProtectedGrantSessionCapabilityOperation,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthorityPort,
  type ProtectedInvocationCapability,
} from "../invocation/protected-grant-invocation.ts";
import {
  withProtectedCurrentNamespaceKeyring,
} from "../invocation/protected-namespace-keyring.ts";
import type {
  PreparedConversationCryptoRevision,
} from "./conversation-repository.ts";
import {
  prepareAgentConversationCryptoRevision,
} from "./agent-conversation-crypto.ts";
import type {
  MessagePayloadV2,
} from "./message-payload-v2.ts";

const protectedForegroundEntrypoints = new Set<string>(
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS,
);

export type ProtectedAgentConversationPreparationUnavailableReason =
  | "authorization_unavailable"
  | "content_unavailable"
  | "content_invalid"
  | "signing_capability_unavailable";

export type ProtectedAgentConversationPreparationResult =
  | Readonly<{
      status: "prepared";
      revision: PreparedConversationCryptoRevision;
    }>
  | Readonly<{
      status: "unavailable";
      reason: ProtectedAgentConversationPreparationUnavailableReason;
    }>;

export type ProtectedAgentConversationPreparationInput = Readonly<{
    capability: ProtectedInvocationCapability;
    entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    namespaceId: string;
    domainId: string;
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
    agentId: string;
    objectId: string;
    payload: MessagePayloadV2;
    createdAt: number;
    signal?: AbortSignal;
  }>;

export interface ProtectedAgentConversationSessionCryptoPreparer {
  prepare(
    input: ProtectedAgentConversationPreparationInput,
  ): Promise<ProtectedAgentConversationPreparationResult>;
}

function unavailable(
  reason: ProtectedAgentConversationPreparationUnavailableReason,
): ProtectedAgentConversationPreparationResult {
  return Object.freeze({ status: "unavailable", reason });
}

function portableText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && new TextEncoder().encode(value).length <= 4_096;
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/**
 * Prepare one opaque Agent conversation crypto revision under one reusable
 * foreground Grant operation. Domain, Namespace, Runtime, and signer
 * authority must all agree while their keys are live; every borrowed secret
 * is wiped by its owning coordinator before the opaque revision is returned.
 */
export function createProtectedAgentConversationSessionCryptoPreparer(
  input: Readonly<{
    crypto: LatticeCrypto;
    storage: Pick<
      LatticeStorage,
      | "getGrant"
      | "consumeGrant"
      | "getNamespaceHead"
      | "getBinding"
      | "getAgentRuntimeAtomicState"
      | "getAgentRuntimeSignerPublication"
    >;
    authority: ProtectedGrantAuthorityPort;
    resolveHistoricalNamespaceCommitter: HistoricalCommitterResolver;
    resolveHistoricalRuntimeCommitter:
      HistoricalAgentRuntimeCommitterResolverV1;
    resolveCurrentObjectAuthorization:
      ResolveCurrentAgentObjectAccessGenesisAuthorization;
  }>,
): ProtectedAgentConversationSessionCryptoPreparer {
  return Object.freeze({
    async prepare(
      request: ProtectedAgentConversationPreparationInput,
    ): Promise<ProtectedAgentConversationPreparationResult> {
      if (
        request.signal?.aborted === true
        || !protectedForegroundEntrypoints.has(request.entrypointId)
      ) {
        return unavailable("authorization_unavailable");
      }
      if (
        !portableText(request.namespaceId)
        || !portableText(request.domainId)
        || !portableText(request.agentId)
        || !portableText(request.objectId)
        || !validCounter(request.expectedAccessRevision)
        || !validCounter(request.expectedPolicyRevision)
        || !validCounter(request.createdAt)
        || request.payload.role === "user"
      ) {
        return unavailable("content_invalid");
      }
      const capability = inspectProtectedInvocationCapability(
        request.capability,
      );
      if (
        capability === null
        || capability.recipientAgentId !== request.agentId
      ) {
        return unavailable("authorization_unavailable");
      }

      try {
        const granted =
          await executeProtectedGrantSessionCapabilityOperation({
            capability: request.capability,
            crypto: input.crypto,
            storage: input.storage,
            operation: "encrypt",
            namespaceId: request.namespaceId,
            domainId: request.domainId,
            authority: input.authority,
            execute: (opened) =>
              withProtectedCurrentNamespaceKeyring({
                crypto: input.crypto,
                storage: input.storage,
                authority: input.authority,
                resolveHistoricalCommitter:
                  input.resolveHistoricalNamespaceCommitter,
                capability,
                opened,
                operation: "encrypt",
                namespaceId: request.namespaceId,
                domainId: request.domainId,
                expectedAccessRevision: request.expectedAccessRevision,
                expectedPolicyRevision: request.expectedPolicyRevision,
                ...(request.signal === undefined
                  ? {}
                  : { signal: request.signal }),
                execute: async (namespace, assertCurrentAuthority) => {
                  const grantRecord = await input.storage.getGrant(
                    capability.grantId,
                  );
                  const grant = grantRecord === null
                    ? null
                    : parseGrantV2(grantRecord.grantBytes);
                  if (
                    grantRecord === null
                    || grant === null
                    || grantRecord.consumed
                    || grant.id !== capability.grantId
                    || grant.singleUse
                  ) {
                    return unavailable("authorization_unavailable");
                  }

                  const runtime =
                    await withProtectedAgentRuntimeGeneration({
                      crypto: input.crypto,
                      storage: input.storage,
                      opened,
                      agentId: agentId(request.agentId),
                      resolveHistoricalCommitter:
                        input.resolveHistoricalRuntimeCommitter,
                      execute: async (runtimeGeneration) => {
                        const publication =
                          await input.storage
                            .getAgentRuntimeSignerPublication(
                              request.agentId,
                              runtimeGeneration.generation,
                            );
                        let signerMatches = false;
                        try {
                          signerMatches = publication !== null
                            && publication.authorizationRevision
                              === request.expectedPolicyRevision
                            && agentRuntimeSignerPublicationMatchesRuntime(
                              input.crypto,
                              runtimeGeneration,
                              publication,
                            );
                        } catch {
                          signerMatches = false;
                        }
                        if (publication === null || !signerMatches) {
                          return unavailable(
                            "signing_capability_unavailable",
                          );
                        }
                        const currentNamespaceKeys =
                          namespace.generations.filter((generation) =>
                            generation.generation
                              === namespace.currentGeneration
                          );
                        if (currentNamespaceKeys.length !== 1) {
                          return unavailable("content_invalid");
                        }
                        await assertCurrentAuthority();
                        let revision: PreparedConversationCryptoRevision;
                        try {
                          revision =
                            prepareAgentConversationCryptoRevision({
                              crypto: input.crypto,
                              objectId: request.objectId,
                              payload: request.payload,
                              createdAt: request.createdAt,
                              namespace: {
                                namespaceId: namespace.namespaceId,
                                accessRevision: namespace.accessRevision,
                                bindingHash: namespace.bindingHash,
                                domainId: namespace.domainId,
                                domainEpoch: namespace.domainEpoch,
                                keyGeneration:
                                  namespace.currentGeneration,
                                aiKey: currentNamespaceKeys[0]!.key,
                              },
                              grant: {
                                grantId: grant.id,
                                grantHash:
                                  input.crypto.hash(
                                    grantRecord.grantBytes,
                                  ),
                                useStatus: "reusable",
                              },
                              runtime: runtimeGeneration,
                              signerPublication: publication,
                              resolveCurrentAuthorization:
                                input.resolveCurrentObjectAuthorization,
                            });
                        } catch {
                          return unavailable("content_invalid");
                        }
                        return Object.freeze({
                          status: "prepared" as const,
                          revision,
                        });
                      },
                    });
                  if (runtime.status === "unavailable") {
                    return unavailable(
                      "signing_capability_unavailable",
                    );
                  }
                  return runtime.value;
                },
              }),
          });
        if (granted.status === "unavailable") {
          return unavailable("authorization_unavailable");
        }
        const namespace = granted.value;
        if (namespace.status === "unavailable") {
          return unavailable(
            namespace.reason === "namespace_invalid"
              ? "content_invalid"
              : namespace.reason === "namespace_unavailable"
                ? "content_unavailable"
                : "authorization_unavailable",
          );
        }
        return namespace.value;
      } catch {
        return unavailable("content_unavailable");
      }
    },
  });
}
