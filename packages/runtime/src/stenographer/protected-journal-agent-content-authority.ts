import type {
  ProtectedCheckpointNamespaceSessionContentExecutor,
} from "@nautilo/lattice-bridge";
import type {
  ProtectedJournalAgentContentAuthorityPort,
} from "@nautilo/lattice-bridge/server";

import type {
  ForegroundAuthorizationSessionRegistry,
  ForegroundAuthorizationView,
} from "../protected-execution/foreground-authorization-session";

type ForegroundJournalAuthorityRegistry = Pick<
  ForegroundAuthorizationSessionRegistry,
  "leaseOperation" | "executeCheckpointNamespace"
>;

class ProtectedJournalAuthorityCallbackFailure extends Error {
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super("Protected journal authority callback failed", { cause });
    this.name = "ProtectedJournalAuthorityCallbackFailure";
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
 * Binds one journal opener to one exact Wave 9 foreground Agent view. The
 * bridge retains Namespace material; Runtime receives only decoded journal
 * payloads inside the one leased callback.
 */
export function createForegroundJournalAgentContentAuthority(
  input: Readonly<{
    registry: ForegroundJournalAuthorityRegistry;
    authorization: ForegroundAuthorizationView;
    namespaceContentPort:
      ProtectedCheckpointNamespaceSessionContentExecutor;
  }>,
): ProtectedJournalAgentContentAuthorityPort {
  return Object.freeze({
    execute: async <Value>(request: Parameters<
      ProtectedJournalAgentContentAuthorityPort["execute"]
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

      try {
        const executed = await input.registry.executeCheckpointNamespace(
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
                throw new ProtectedJournalAuthorityCallbackFailure(cause);
              }
            },
          },
        );
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
      } catch (cause) {
        if (cause instanceof ProtectedJournalAuthorityCallbackFailure) {
          throw cause.cause;
        }
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
    },
  });
}
