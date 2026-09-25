import {
  withTaskRuntimeCheckpointNamespace,
  type LatticeCrypto,
  type TaskRuntimeCheckpointIdentity,
  type TaskRuntimeExecutionEvidence,
  type TaskRuntimeResultNamespaceSource,
} from "@nautilo/lattice-crypto";

import {
  createProtectedCheckpointCellCrypto,
  type ProtectedCheckpointCellAuthorityPort,
  type ProtectedCheckpointCellCrypto,
  type ProtectedCheckpointEntrypointId,
  type ProtectedCheckpointInvocationScope,
  type ProtectedCheckpointNamespaceOperationContext,
} from "./protected-checkpoint-cell-crypto.ts";
import type { ProtectedGrantOperation } from
  "../invocation/protected-grant-invocation.ts";

export type TaskRuntimeCheckpointCellIdentity =
  TaskRuntimeCheckpointIdentity & Readonly<{ graphThreadId: string }>;

export type TaskRuntimeCheckpointCellCrypto = Readonly<{
  crypto: ProtectedCheckpointCellCrypto;
  scope: ProtectedCheckpointInvocationScope;
}>;

/** Task-owned cell authority. Foreground session and grant registries are absent. */
export function createTaskRuntimeCheckpointCellCrypto(input: Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidence;
  identity: TaskRuntimeCheckpointCellIdentity;
  namespace: TaskRuntimeResultNamespaceSource;
  signal: AbortSignal;
  now(): number;
  assertCurrentTaskAuthority(): Promise<void>;
}>): TaskRuntimeCheckpointCellCrypto {
  if (typeof input.identity.graphThreadId !== "string"
    || input.identity.graphThreadId.length === 0
    || !(input.signal instanceof AbortSignal)) {
    throw new TypeError("Task checkpoint graph identity is invalid");
  }
  const authorizationSession = Object.freeze({});
  const scope: ProtectedCheckpointInvocationScope = Object.freeze({
    logicalThreadId: input.identity.graphThreadId,
    namespaceId: input.identity.namespaceId,
    keyClass: "ai",
    expectedAccessRevision: input.identity.expectedAccessRevision,
    expectedPolicyRevision: input.identity.expectedPolicyRevision,
    authorizationSession,
  });
  const authority: ProtectedCheckpointCellAuthorityPort = Object.freeze({
    execute: async <Value>(request: Readonly<{
      authorizationSession: unknown;
      entrypointId: ProtectedCheckpointEntrypointId;
      operation: ProtectedGrantOperation;
      namespaceId: string;
      domainId: string;
      expectedAccessRevision: number;
      expectedPolicyRevision: number;
      execute(context: ProtectedCheckpointNamespaceOperationContext): Promise<Value>;
    }>): Promise<Value> => {
      if (request.entrypointId !== "task.execute"
        || request.authorizationSession !== authorizationSession
        || request.namespaceId !== input.identity.namespaceId
        || request.domainId !== input.identity.domainId
        || request.expectedAccessRevision
          !== input.identity.expectedAccessRevision
        || request.expectedPolicyRevision
          !== input.identity.expectedPolicyRevision
        || (request.operation !== "decrypt" && request.operation !== "encrypt")) {
        throw new TypeError("Task checkpoint operation identity was substituted");
      }
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(input.signal.reason);
      if (input.signal.aborted) forwardAbort();
      else input.signal.addEventListener("abort", forwardAbort, { once: true });
      try {
        return await withTaskRuntimeCheckpointNamespace({
          crypto: input.crypto,
          evidence: input.evidence,
          identity: input.identity,
          namespace: input.namespace,
          signal: controller.signal,
          assertCurrentTaskAuthority: input.assertCurrentTaskAuthority,
          execute: (material, assertCommitAllowed, assertActive) =>
            request.execute(Object.freeze({
              signal: controller.signal,
              assertActive,
              assertCommitAllowed,
              remainingMs: () => input.evidence.expiresAt - input.now(),
              material: Object.freeze({
                namespaceId: material.namespaceId,
                domainId: material.domainId,
                accessRevision: material.accessRevision,
                agentAuthorizationRevision: material.policyRevision,
                currentGeneration: material.currentGeneration,
                generations: material.generations,
              }),
            })),
        });
      } finally {
        input.signal.removeEventListener("abort", forwardAbort);
        controller.abort();
      }
    },
  });
  return Object.freeze({
    crypto: createProtectedCheckpointCellCrypto({
      crypto: input.crypto,
      authority,
      domainId: input.identity.domainId,
      entrypointId: "task.execute",
    }),
    scope,
  });
}
