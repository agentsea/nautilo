import {
  createTaskRuntimeAgentObjectRepairer,
  type AgentEntityCryptoInvocation,
  type AtomicMemoryCryptoCompletionPort,
  type MemoryPayloadV1,
  type PreparedTaskRuntimeAgentObject,
  type PreparedMemoryCryptoRevision,
  type ProtectedAgentMemoryCryptoSessionPort,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryMutationTarget,
  type ProtectedMemoryResult,
  type VerifiedAgentObject,
} from "@nautilo/lattice-bridge";
import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type LatticeCrypto,
  type ResolveHistoricalAgentRuntimeSignerPublicationManager,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";

import {
  createDomainMemoryCryptoSession,
  type DomainMemoryScopeBinding,
} from
  "./domain-memory-crypto-session.ts";

export interface TaskRuntimeDomainMemoryCryptoSessionInput {
  scopeBinding?: DomainMemoryScopeBinding;
  subjectUserId: string;
  agentId: string;
  evidence: TaskRuntimeExecutionEvidence;
  crypto: LatticeCrypto;
  entities: Pick<
    AgentEntityCryptoInvocation,
    "signal" | "use" | "useCurrentSet"
  >;
  runtime: AgentRuntimeKeyGeneration;
  signerPublication: AgentRuntimeSignerPublication;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManager;
  agentAuthorizationRevision: number;
  persist(request: Readonly<{
    memoryId: string;
    contentRevision: number;
    operationId: string;
    prepared: PreparedTaskRuntimeAgentObject;
    evidence: TaskRuntimeExecutionEvidence;
  }>): Promise<"created" | "duplicate" | "stale">;
  read(request: Readonly<{
    objectId: string;
    expectedObjectType: string;
    expectedAccessRevision?: number;
    expectedNamespaceIds: readonly string[];
  }>): Promise<VerifiedAgentObject | null>;
}

function active(evidence: TaskRuntimeExecutionEvidence): boolean {
  try {
    assertAuthenticTaskRuntimeExecutionEvidence(evidence);
    return true;
  } catch {
    return false;
  }
}

function unavailable<Value>(): ProtectedMemoryResult<Value> {
  return Object.freeze({
    status: "unavailable" as const,
    reason: "authorization_required" as const,
  });
}

/** Native protected Task wrapper for one fixed Memory authority. */
export function createTaskRuntimeDomainMemoryCryptoSession(
  input: Readonly<TaskRuntimeDomainMemoryCryptoSessionInput>,
): Readonly<{
  session: ProtectedAgentMemoryCryptoSessionPort;
  completion: Pick<AtomicMemoryCryptoCompletionPort, "complete">;
  /** Verified bytes for a centrally policy-authorized ordinary Shadow sibling. */
  readPreparedPayload(revision: PreparedMemoryCryptoRevision): MemoryPayloadV1;
}> {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  if (
    input.evidence.result.signerAgentId !== input.agentId
    || input.runtime.agentId !== input.agentId
    || input.signerPublication.agentId !== input.agentId
  ) throw new TypeError(
    "Task Memory Agent does not match execution evidence",
  );

  const domain = createDomainMemoryCryptoSession({
    subjectUserId: input.subjectUserId,
    agentId: input.agentId,
    entrypointId: "subagent.scope",
    entities: input.entities,
    objects: createTaskRuntimeAgentObjectRepairer({
      crypto: input.crypto,
      evidence: input.evidence,
      entities: input.entities,
      runtime: input.runtime,
      signerPublication: input.signerPublication,
      resolveHistoricalSignerPublicationManager:
        input.resolveHistoricalSignerPublicationManager,
      agentAuthorizationRevision: input.agentAuthorizationRevision,
      persist: input.persist,
      read: input.read,
    }),
    prepareOperationId: planOperationId => planOperationId,
    ...(input.scopeBinding === undefined
      ? {}
      : { scopeBinding: input.scopeBinding }),
  });

  return Object.freeze({
    session: Object.freeze({
      async openMany(request: Parameters<
        ProtectedAgentMemoryCryptoSessionPort["openMany"]
      >[0]): ReturnType<ProtectedAgentMemoryCryptoSessionPort["openMany"]> {
        if (!active(input.evidence)) return unavailable();
        const result = await domain.session.openMany(request);
        return active(input.evidence) ? result : unavailable();
      },

      async prepare(request: Parameters<
        ProtectedAgentMemoryCryptoSessionPort["prepare"]
      >[0]): ReturnType<ProtectedAgentMemoryCryptoSessionPort["prepare"]> {
        if (!active(input.evidence)) return unavailable();
        const result = await domain.session.prepare(request);
        return active(input.evidence) ? result : unavailable();
      },

      async authorizeCommit<Value>(request: Readonly<{
        entrypointId: Parameters<
          ProtectedAgentMemoryCryptoSessionPort["openMany"]
        >[0]["entrypointId"];
        agentId: string;
        authority: ProtectedMemoryAuthority;
        target: ProtectedMemoryMutationTarget;
        operation: "publish" | "replace" | "set-tier";
        signal?: AbortSignal;
        commit: () => Value | PromiseLike<Value>;
      }>): Promise<ProtectedMemoryResult<Value>> {
        if (!active(input.evidence)) return unavailable();
        let completed: Readonly<{ value: Value }> | null = null;
        const getCompleted = (): Readonly<{ value: Value }> | null => completed;
        try {
          const result = await domain.session.authorizeCommit({
            ...request,
            commit: async () => {
              const value = await request.commit();
              completed = Object.freeze({ value });
              return value;
            },
          });
          const observed = getCompleted();
          // A completed callback value reports the observed semantic outcome.
          // It grants no authority for more work or automatic replay.
          return observed === null
            ? (active(input.evidence) ? result : unavailable())
            : Object.freeze({
              status: "success" as const,
              value: observed.value,
            });
        } catch (error) {
          const observed = getCompleted();
          if (observed !== null) return Object.freeze({
            status: "success" as const,
            value: observed.value,
          });
          // No returned receipt means the outcome stays unknown to this
          // adapter; preserve the error and never retry the semantic commit.
          throw error;
        }
      },
    }),
    readPreparedPayload(revision: PreparedMemoryCryptoRevision): MemoryPayloadV1 {
      assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
      input.entities.signal.throwIfAborted();
      return domain.readPreparedPayload(revision);
    },
    completion: Object.freeze({
      complete: (revision: PreparedMemoryCryptoRevision) =>
        active(input.evidence)
          ? domain.completion.complete(revision)
          : Promise.reject(new TypeError(
            "Task Memory execution evidence is not active",
          )),
    }),
  });
}
