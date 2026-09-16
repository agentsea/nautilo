import type {
  ProtectedCheckpointNamespaceSessionContentExecutor,
} from "@nautilo/lattice-bridge";
import type {
  ConversationProtectedAgentContentAuthorityPort,
} from "@nautilo/lattice-bridge/server";

import type {
  ForegroundAuthorizationSessionRegistry,
  ForegroundAuthorizationView,
} from "../protected-execution/foreground-authorization-session";

type ForegroundConversationAuthorityRegistry = Pick<
  ForegroundAuthorizationSessionRegistry,
  "leaseOperation" | "executeCheckpointNamespace"
>;

class ProtectedConversationAuthorityCallbackFailure extends Error {
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super("Protected conversation authority callback failed", { cause });
    this.name = "ProtectedConversationAuthorityCallbackFailure";
    this.cause = cause;
  }
}

function unavailableReason(
  reason: string,
): "authorization_unavailable" | "content_unavailable" | "content_invalid" {
  if (reason === "content_invalid") return "content_invalid";
  if (reason === "content_unavailable" || reason === "execution_failed") {
    return "content_unavailable";
  }
  return "authorization_unavailable";
}

/**
 * Binds the Bridge-owned message opener to one exact foreground authorization
 * view. Each bounded transcript batch leases one decrypt operation; Namespace
 * material and opened message payloads remain inside that lease callback.
 */
export function createForegroundConversationAgentContentAuthority(
  input: Readonly<{
    registry: ForegroundConversationAuthorityRegistry;
    authorization: ForegroundAuthorizationView;
    namespaceContentPort:
      ProtectedCheckpointNamespaceSessionContentExecutor;
  }>,
): ConversationProtectedAgentContentAuthorityPort {
  return Object.freeze({
    execute: async <Value>(request: Parameters<
      ConversationProtectedAgentContentAuthorityPort["execute"]
    >[0]) => {
      if (request.authorizationSession !== input.authorization) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      const leased = input.registry.leaseOperation({
        view: input.authorization,
        entrypointId: request.entrypointId,
        operation: "decrypt",
        namespaceId: request.namespaceId,
        domainId: request.domainId,
      });
      if (leased.status === "unavailable") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }

      let executed;
      try {
        executed = await input.registry.executeCheckpointNamespace(
          leased.lease,
          {
            contentPort: input.namespaceContentPort,
            expectedAccessRevision: request.expectedAccessRevision,
            expectedPolicyRevision: request.expectedPolicyRevision,
            ...(request.signal === undefined
              ? {}
              : { signal: request.signal }),
            execute: async (material, context) => {
              try {
                context.assertActive();
                const value = await request.execute(Object.freeze({
                  material,
                  signal: context.signal,
                  assertActive: context.assertActive,
                }));
                context.assertActive();
                return value;
              } catch (cause) {
                throw new ProtectedConversationAuthorityCallbackFailure(
                  cause,
                );
              }
            },
          },
        );
      } catch (cause) {
        if (
          cause instanceof ProtectedConversationAuthorityCallbackFailure
        ) {
          throw cause.cause;
        }
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
      if (executed.status === "unavailable") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: unavailableReason(executed.reason),
        });
      }
      return Object.freeze({
        status: "executed" as const,
        value: executed.value as Value,
      });
    },
  });
}
