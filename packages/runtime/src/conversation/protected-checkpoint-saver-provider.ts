import {
  createEncryptedCheckpointSaver,
  type CheckpointCellCrypto,
  type CreateEncryptedCheckpointSaverOptions,
} from "@nautilo/agent";
import {
  ProtectedCheckpointCryptoError,
  createProtectedCheckpointCellCrypto,
  type ProtectedAgentRuntimeForegroundEntrypointId,
  type ProtectedCheckpointCellAuthorityPort,
  type ProtectedCheckpointNamespaceSessionContentExecutor,
} from "@nautilo/lattice-bridge";

import {
  type ForegroundAuthorizationView,
  ForegroundAuthorizationSessionRegistry,
} from "../protected-execution/foreground-authorization-session";
import {
  __assertProtectedTestShadowAuthority,
  type ProtectedTestShadowAuthority,
} from "./conversation-composition";
import type {
  ProtectedCheckpointExecutionKind,
  ProtectedCheckpointInvocation,
  ProtectedConversationCheckpointSaverProvider,
} from "./conversation-execution-services";

type DedicatedCheckpointPool =
  CreateEncryptedCheckpointSaverOptions["dedicatedPool"];
type ProtectedCheckpointCryptoEngine =
  Parameters<typeof createProtectedCheckpointCellCrypto>[0]["crypto"];

function createLazyInvocationPool(input: Readonly<{
  invocation: ProtectedCheckpointInvocation;
  createDedicatedPool(
    invocation: ProtectedCheckpointInvocation,
  ): DedicatedCheckpointPool;
  ownedPools: WeakSet<object>;
}>): DedicatedCheckpointPool {
  let pool: DedicatedCheckpointPool | null = null;
  let ended = false;

  const open = (): DedicatedCheckpointPool => {
    if (ended) {
      throw new Error("Protected checkpoint invocation pool is closed");
    }
    if (pool !== null) return pool;
    const created = input.createDedicatedPool(input.invocation);
    if (
      typeof created !== "object"
      || created === null
      || typeof created.connect !== "function"
      || typeof created.end !== "function"
      || input.ownedPools.has(created)
    ) {
      throw new TypeError(
        "Protected checkpoint invocation requires a fresh dedicated pool",
      );
    }
    input.ownedPools.add(created);
    pool = created;
    return created;
  };

  return Object.freeze({
    connect: () => open().connect(),
    end: async () => {
      if (ended) return;
      ended = true;
      if (pool !== null) await pool.end();
    },
  }) as unknown as DedicatedCheckpointPool;
}

const entrypointByKind = Object.freeze({
  "foreground.main": "foreground.main",
  "foreground.fork": "foreground.fork",
  "subagent.scope": "subagent.scope",
  "resume.approval": "resume.approval",
  "resume.approval_ask": "resume.approval_ask",
  "resume.identity": "resume.identity",
} satisfies Record<
  ProtectedCheckpointExecutionKind,
  ProtectedAgentRuntimeForegroundEntrypointId
>);

function unavailable(
  reason: string,
  code:
    | "authorization_unavailable"
    | "content_invalid"
    | "content_unavailable" = "authorization_unavailable",
): ProtectedCheckpointCryptoError {
  return new ProtectedCheckpointCryptoError(
    code,
    `protected checkpoint authority is unavailable: ${reason}`,
  );
}

class ProtectedCheckpointCallbackFailure extends Error {
  declare readonly cause: Error;

  constructor(cause: unknown) {
    const error = cause instanceof Error
      ? cause
      : new Error("protected checkpoint callback rejected", { cause });
    super("protected checkpoint callback failed", { cause: error });
    this.name = "ProtectedCheckpointCallbackFailure";
    this.cause = error;
  }
}

function createForegroundCheckpointAuthority(input: Readonly<{
  registry: ForegroundAuthorizationSessionRegistry;
  authorization: ForegroundAuthorizationView;
  contentPort: ProtectedCheckpointNamespaceSessionContentExecutor;
}>): ProtectedCheckpointCellAuthorityPort {
  return Object.freeze({
    execute: async <Value>(request: Parameters<
      ProtectedCheckpointCellAuthorityPort["execute"]
    >[0]): Promise<Value> => {
      if (request.authorizationSession !== input.authorization) {
        throw unavailable("authorization_view_mismatch");
      }
      const leased = input.registry.leaseOperation({
        view: input.authorization,
        entrypointId: request.entrypointId,
        operation: request.operation,
        namespaceId: request.namespaceId,
        domainId: request.domainId,
      });
      if (leased.status === "unavailable") {
        throw unavailable(leased.reason);
      }
      let executed;
      try {
        executed = await input.registry.executeCheckpointNamespace(
          leased.lease,
          {
            contentPort: input.contentPort,
            expectedAccessRevision: request.expectedAccessRevision,
            expectedPolicyRevision: request.expectedPolicyRevision,
            execute: async (material, context) => {
              try {
                return await request.execute(Object.freeze({
                  ...context,
                  material,
                }));
              } catch (cause) {
                throw new ProtectedCheckpointCallbackFailure(cause);
              }
            },
          },
        );
      } catch (error) {
        if (error instanceof ProtectedCheckpointCallbackFailure) {
          throw error.cause;
        }
        if (error instanceof ProtectedCheckpointCryptoError) {
          throw error;
        }
        throw new ProtectedCheckpointCryptoError(
          "content_unavailable",
          "protected checkpoint Namespace content port failed",
          { cause: error },
        );
      }
      if (executed.status === "unavailable") {
        throw unavailable(
          executed.reason,
          executed.reason === "content_invalid"
            ? "content_invalid"
            : executed.reason === "content_unavailable"
              ? "content_unavailable"
              : "authorization_unavailable",
        );
      }
      return executed.value as Value;
    },
  });
}

/**
 * Dormant Wave-9 test composition. Every invocation gets a separately owned
 * lazily allocated pool/PostgresSaver, a fresh cell-crypto instance, and the
 * exact foreground root/child authority view supplied by that invocation. A
 * saver that fails before its first storage operation owns no physical pool.
 * The unforgeable test authority keeps production unable to construct this
 * provider.
 */
export function createProtectedTestCheckpointSaverProvider(input: Readonly<{
  authority: ProtectedTestShadowAuthority;
  crypto: ProtectedCheckpointCryptoEngine;
  registry: ForegroundAuthorizationSessionRegistry;
  namespaceContentPort: ProtectedCheckpointNamespaceSessionContentExecutor;
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  createDedicatedPool(
    invocation: ProtectedCheckpointInvocation,
  ): DedicatedCheckpointPool;
}>): ProtectedConversationCheckpointSaverProvider {
  __assertProtectedTestShadowAuthority(input.authority);
  const ownedPools = new WeakSet<object>();

  return Object.freeze({
    createForInvocation: (
      invocation: ProtectedCheckpointInvocation,
    ) => {
      const entrypointId = entrypointByKind[invocation.kind];
      const authority = createForegroundCheckpointAuthority({
        registry: input.registry,
        authorization: invocation.authorization,
        contentPort: input.namespaceContentPort,
      });
      const crypto: CheckpointCellCrypto =
        createProtectedCheckpointCellCrypto({
          crypto: input.crypto,
          authority,
          domainId: input.domainId,
          entrypointId,
        });
      const dedicatedPool = createLazyInvocationPool({
        invocation,
        createDedicatedPool: input.createDedicatedPool,
        ownedPools,
      });
      return createEncryptedCheckpointSaver({
        dedicatedPool,
        crypto,
        scope: {
          logicalThreadId: invocation.logicalThreadId,
          namespaceId: input.namespaceId,
          keyClass: "ai",
          expectedAccessRevision: input.expectedAccessRevision,
          expectedPolicyRevision: input.expectedPolicyRevision,
          authorizationSession: invocation.authorization,
        },
      });
    },
  });
}
