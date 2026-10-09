import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type LatticeCrypto,
  type ResolveHistoricalAgentRuntimeSignerPublicationManager,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";

import {
  MEMORY_OBJECT_TYPE,
  deriveMemoryCryptoObjectIdV1,
} from "../memory/memory-repository.ts";
import {
  createAgentObjectProtector,
  type AgentObjectProtectionResult,
  type AgentObjectProtectionSource,
  type VerifiedAgentObject,
} from "./agent-object-protector.ts";
import type { AgentEntityCryptoInvocation } from "./agent-entity-crypto.ts";
import {
  prepareTaskRuntimeAgentObject,
  type PreparedTaskRuntimeAgentObject,
  type TaskRuntimeAgentObjectNamespaceMaterial,
} from "./task-runtime-agent-object-crypto.ts";

export type TaskRuntimeAgentMemoryObjectProtectionRequest<Value> = Readonly<{
  memoryId: string;
  contentRevision: number;
  operationId: string;
  source: AgentObjectProtectionSource;
  decode(plaintextBytes: Uint8Array): Value;
}>;

export interface TaskRuntimeAgentObjectRepairer {
  protect<Value>(
    request: TaskRuntimeAgentMemoryObjectProtectionRequest<Value>,
  ): Promise<AgentObjectProtectionResult<Value>>;
}

function unavailable(): AgentObjectProtectionResult<never> {
  return Object.freeze({
    status: "waiting_for_authority" as const,
    reason: "authorization_cancelled",
  });
}

function active(evidence: TaskRuntimeExecutionEvidence): boolean {
  try {
    assertAuthenticTaskRuntimeExecutionEvidence(evidence);
    return true;
  } catch {
    return false;
  }
}

/** Task-evidence adapter over the family-neutral Agent object protector. */
export function createTaskRuntimeAgentObjectRepairer(input: Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidence;
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
}>): TaskRuntimeAgentObjectRepairer {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  if (
    input.runtime.agentId !== input.evidence.result.signerAgentId
    || input.signerPublication.agentId !== input.evidence.result.signerAgentId
  ) throw new TypeError(
    "Task Runtime Agent object repair Agent disagrees with execution evidence",
  );

  return Object.freeze({
    protect: async <Value>(
      request: TaskRuntimeAgentMemoryObjectProtectionRequest<Value>,
    ): Promise<AgentObjectProtectionResult<Value>> => {
      if (!active(input.evidence) || input.entities.signal.aborted) {
        return unavailable();
      }
      const memoryId = request.memoryId;
      const contentRevision = request.contentRevision;
      const operationId = request.operationId;
      let expectedObjectId: string;
      try {
        expectedObjectId = deriveMemoryCryptoObjectIdV1({
          memoryId,
          contentRevision,
        });
      } catch {
        return Object.freeze({
          status: "failed" as const,
          reason: "entity_coordinate_invalid",
        });
      }
      if (
        operationId.length === 0
        || request.source.objectType !== MEMORY_OBJECT_TYPE
        || request.source.objectId !== expectedObjectId
        || (
          request.source.existingObjectId !== null
          && request.source.existingObjectId !== expectedObjectId
        )
      ) return Object.freeze({
        status: "failed" as const,
        reason: "entity_coordinate_invalid",
      });

      const plaintextBytes = request.source.plaintextBytes?.slice() ?? null;
      const source: AgentObjectProtectionSource = Object.freeze({
        objectId: expectedObjectId,
        objectType: MEMORY_OBJECT_TYPE,
        existingObjectId: request.source.existingObjectId,
        ...(request.source.expectedAccessRevision === undefined
          ? {}
          : { expectedAccessRevision: request.source.expectedAccessRevision }),
        createdAt: request.source.createdAt,
        namespaceIds: Object.freeze([...request.source.namespaceIds]),
        plaintextBytes,
      });
      try {
        const protector = createAgentObjectProtector({
          crypto: input.crypto,
          entities: input.entities,
          read: input.read,
          prepareAndPersist: async ({ source, opened }) => {
            assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
            const namespaceSet: TaskRuntimeAgentObjectNamespaceMaterial[] =
              opened.map(item => ({
                namespaceId: item.authority.namespaceId,
                accessRevision: item.authority.namespaceAccessRevision,
                keyGeneration: item.authority.namespaceKeyGeneration,
                domainId: item.authority.domainId,
                domainKeyGeneration: item.authority.domainKeyGeneration,
                domainAuthorizationRevision:
                  item.authority.domainAuthorizationRevision,
                domainHeadDigest: item.authority.domainHeadDigest,
                headDigest: item.authority.namespaceHeadDigest,
                publicationDigest: item.authority.namespacePublicationDigest,
                publicationSetDigest:
                  item.authority.namespacePublicationSetDigest,
                audienceFingerprint:
                  item.authority.namespaceAudienceFingerprint,
                key: item.namespaceKey,
              }));
            const prepared = prepareTaskRuntimeAgentObject({
              crypto: input.crypto,
              evidence: input.evidence,
              objectId: expectedObjectId,
              objectType: MEMORY_OBJECT_TYPE,
              plaintextBytes: source.plaintextBytes,
              createdAt: source.createdAt,
              namespaceSet,
              operationId,
              runtime: input.runtime,
              signerPublication: input.signerPublication,
              resolveHistoricalSignerPublicationManager:
                input.resolveHistoricalSignerPublicationManager,
              agentAuthorizationRevision: input.agentAuthorizationRevision,
            });
            assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
            return input.persist({
              memoryId,
              contentRevision,
              operationId,
              prepared,
              evidence: input.evidence,
            });
          },
        });
        const result = await protector.protect<Value>({
          operationId,
          source,
          decode: request.decode,
        });
        return active(input.evidence) ? result : unavailable();
      } finally {
        plaintextBytes?.fill(0);
      }
    },
  });
}
