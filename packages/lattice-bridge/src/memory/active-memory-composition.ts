import type { ProtectedAgentRuntimeForegroundEntrypointId } from "../invocation/protected-agent-runtime.ts";
import {
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  deriveMemoryCryptoObjectIdV1,
  type PreparedMemoryCryptoRevision,
} from "./memory-repository.ts";
import type { MemoryPayloadV1 } from "./memory-payload-v1.ts";
import { commitMemoryMutationV1 } from "./memory-mutation-commitment.ts";
import {
  type ProtectedAgentMemoryRepository,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryOpenedItem,
  type ProtectedMemoryResult,
  type ProtectedMemoryUnavailableReason,
} from "./active-memory-repository.ts";
import {
  ClassifiedDataOperationError,
  type EncryptionDataOperationOwner,
} from "../transition/encryption-data-operation-owner.ts";

const MAX_SEARCH_RESULTS = 64;
const MAX_QUERY_BYTES = 4 * 1024;
const MAX_TYPE_BYTES = 256;
const MAX_CONTENT_BYTES = 64 * 1024;
const EMBEDDING_DIMENSIONS = 1536;
const encoder = new TextEncoder();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export type AgentMemoryEmbedding = Readonly<{
  vector: readonly number[];
  provider: string;
  canonicalModel: string;
  dimensions: typeof EMBEDDING_DIMENSIONS;
  contractVersion: number;
}>;

export interface ProtectedAgentMemoryEmbeddingPort {
  embed(
    input: Readonly<{
      purpose: "memory.content_embedding" | "memory.query_embedding";
      plaintext: string;
      signal?: AbortSignal;
    }>,
  ): Promise<ProtectedMemoryResult<AgentMemoryEmbedding>>;
}

export type ProtectedMemoryCandidate = Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  cryptoObjectId: string;
  readNamespaceId: string;
  requiredNamespaceIds: readonly string[];
  importance: number;
  tier: number;
  score: number;
  createdAt: Date;
}>;

/** One exact authorized semantic-save identity selected before any repair. */
export type ProtectedMemorySaveCandidateSelection = Readonly<{
  memoryId: string;
  contentRevision: number;
  score: number;
  repairRequired: boolean;
  repair: Readonly<{
    id: string;
    type: null;
    importance: number;
    tier: number;
    createdAt: Date;
    score: number;
    representation: "structural";
  }>;
}>;

export type ProtectedMemoryMutationPlan = Readonly<{
  operationId: string;
  action: "created" | "updated";
  mutationKind: "save" | "replace" | "background";
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  /** Product access revision that was current when this update was reserved. */
  expectedPriorAccessRevision: number;
  cryptoObjectId: string;
  requiredNamespaceIds: readonly string[];
  /** Opaque product reservation binding; it never contains plaintext. */
  reservationDigest: Uint8Array;
  mutationCommitment: Uint8Array;
  importance: number;
  createdAt: number;
  similarity?: number;
}>;

export type ProtectedMemoryMutationTarget = Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  cryptoObjectId: string;
  requiredNamespaceIds: readonly string[];
}>;

export type ProtectedMemoryReplacementPlan = ProtectedMemoryMutationPlan &
  Readonly<{
    action: "updated";
    previous: ProtectedMemoryMutationTarget;
  }>;

export type ForegroundMemoryMutationReplay = Readonly<{
  mutationKind: "save" | "replace" | "promote" | "demote";
  memoryId: string;
  action: "created" | "updated";
  similarity?: number;
  fallbackReason?: "encryption_pending" | "target_encryption_not_ready";
}>;

export interface ProtectedAgentMemoryProductPort {
  replayCompleted(
    input: Readonly<{
      operationId: string;
      authority: ProtectedMemoryAuthority;
      mutationKind: ForegroundMemoryMutationReplay["mutationKind"];
      memoryId?: string;
      importance?: number;
      mutationCommitment?: Uint8Array;
      signal?: AbortSignal;
    }>,
  ): Promise<ProtectedMemoryResult<ForegroundMemoryMutationReplay | null>>;

  searchCandidates(
    input: Readonly<{
      authority: ProtectedMemoryAuthority;
      embedding: AgentMemoryEmbedding;
      limit: number;
      includeArchive: boolean;
      signal?: AbortSignal;
    }>,
  ): Promise<ProtectedMemoryResult<readonly ProtectedMemoryCandidate[]>>;

  selectSaveCandidate(
    input: Readonly<{
      authority: ProtectedMemoryAuthority;
      embedding: AgentMemoryEmbedding;
      signal?: AbortSignal;
    }>,
  ): Promise<
    ProtectedMemoryResult<ProtectedMemorySaveCandidateSelection | null>
  >;

  planSave(
    input: Readonly<{
      operationId: string;
      authority: ProtectedMemoryAuthority;
      embedding: AgentMemoryEmbedding;
      selectedCandidate: ProtectedMemorySaveCandidateSelection | null;
      importance: number;
      mutationCommitment: Uint8Array;
      signal?: AbortSignal;
    }>,
  ): Promise<ProtectedMemoryResult<ProtectedMemoryMutationPlan>>;

  planReplace(
    input: Readonly<{
      operationId: string;
      authority: ProtectedMemoryAuthority;
      memoryId: string;
      embedding: AgentMemoryEmbedding;
      mutationCommitment: Uint8Array;
      signal?: AbortSignal;
    }>,
  ): Promise<ProtectedMemoryResult<ProtectedMemoryReplacementPlan>>;

  publishPrepared(
    input: Readonly<{
      authority: ProtectedMemoryAuthority;
      plan: ProtectedMemoryMutationPlan;
      prepared: PreparedMemoryCryptoRevision;
      embedding: AgentMemoryEmbedding;
      signal?: AbortSignal;
    }>,
  ): Promise<"published" | "replayed" | "stale" | "deleted">;

  resolveTierTarget(
    input: Readonly<{
      operationId: string;
      authority: ProtectedMemoryAuthority;
      memoryId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<ProtectedMemoryResult<ProtectedMemoryMutationTarget>>;

  commitTier(
    input: Readonly<{
      operationId: string;
      authority: ProtectedMemoryAuthority;
      target: ProtectedMemoryMutationTarget;
      action: "promote" | "demote";
      signal?: AbortSignal;
    }>,
  ): Promise<"applied" | "replayed" | "stale" | "deleted">;
}

export type ProtectedMemorySessionOpenedItem = Readonly<{
  memoryId: string;
  contentRevision: number;
  type: string;
  content: string;
}>;

export interface ProtectedAgentMemoryCryptoSessionPort {
  openMany(
    input: Readonly<{
      entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
      agentId: string;
      authority: ProtectedMemoryAuthority;
      candidates: readonly ProtectedMemoryCandidate[];
      signal?: AbortSignal;
    }>,
  ): Promise<
    ProtectedMemoryResult<readonly ProtectedMemorySessionOpenedItem[]>
  >;

  prepare(
    input: Readonly<{
      entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
      agentId: string;
      authority: ProtectedMemoryAuthority;
      plan: ProtectedMemoryMutationPlan;
      content:
        | Readonly<{ kind: "complete"; payload: MemoryPayloadV1 }>
        | Readonly<{
            kind: "replacement";
            previous: ProtectedMemoryMutationTarget;
            content: string;
          }>;
      signal?: AbortSignal;
    }>,
  ): Promise<ProtectedMemoryResult<PreparedMemoryCryptoRevision>>;

  authorizeCommit<Value>(
    input: Readonly<{
      entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
      agentId: string;
      authority: ProtectedMemoryAuthority;
      target: ProtectedMemoryMutationTarget;
      operation: "publish" | "replace" | "set-tier";
      signal?: AbortSignal;
      commit: () => Value | PromiseLike<Value>;
    }>,
  ): Promise<ProtectedMemoryResult<Value>>;
}

function unavailable<Value>(
  reason: ProtectedMemoryUnavailableReason,
): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function successResult<Value>(value: Value): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "success", value });
}

class AgentMemoryDataOperationError extends ClassifiedDataOperationError {
  constructor(
    failureClass: ConstructorParameters<typeof ClassifiedDataOperationError>[0],
    readonly reason: ProtectedMemoryUnavailableReason,
  ) {
    super(failureClass, `Agent Memory is unavailable (${reason})`);
  }
}

function operationUnavailable<Value>(
  error: ClassifiedDataOperationError,
): ProtectedMemoryResult<Value> | undefined {
  if (error instanceof AgentMemoryDataOperationError) {
    return unavailable(error.reason);
  }
  switch (error.failureClass) {
    case "stale": return unavailable("stale_revision");
    case "authority": return unavailable("authorization_required");
    case "integrity": return unavailable("integrity_failure");
    case "recoverable_availability":
    case "key_waiting": return unavailable("encryption_pending");
    case "cancelled":
    case "unknown":
    case "unsupported": return undefined;
  }
}

function portableText(value: unknown, maximumBytes = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    encoder.encode(value).length <= maximumBytes &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    encoder.encode(value).length <= maximumBytes
  );
}

function canonicalIds(value: readonly string[]): readonly string[] | null {
  if (value.length < 1 || value.length > 256) {
    return null;
  }
  if (value.some((entry) => !uuid(entry))) return null;
  const canonical = [...new Set<string>(value)].sort((left, right) =>
    left.localeCompare(right),
  );
  return canonical.length === value.length &&
    canonical.every((entry, index) => entry === value[index])
    ? Object.freeze(canonical)
    : null;
}

function canonicalAuthorityIds(
  value: readonly string[],
): readonly string[] | null {
  if (value.length < 1 || value.some((entry) => !uuid(entry))) return null;
  return value.some((entry, index) => index > 0 && value[index - 1]! >= entry)
    ? null
    : value;
}

function validAuthority(
  authority: ProtectedMemoryAuthority,
  subjectUserId: string,
  agentId: string,
): boolean {
  if (
    authority.subjectUserId !== subjectUserId ||
    authority.agentId !== agentId
  )
    return false;
  if (authority.mode === "scope") {
    return (
      portableText(authority.scopeId) &&
      portableText(authority.originWritableNamespaceId)
    );
  }
  return (
    canonicalAuthorityIds(authority.readableNamespaceIds) !== null &&
    canonicalAuthorityIds(authority.mutableNamespaceIds) !== null &&
    (authority.writableNamespaceId === null ||
      portableText(authority.writableNamespaceId))
  );
}

function validEmbedding(value: AgentMemoryEmbedding): boolean {
  return (
    portableText(value.provider) &&
    portableText(value.canonicalModel) &&
    value.dimensions === EMBEDDING_DIMENSIONS &&
    Number.isSafeInteger(value.contractVersion) &&
    value.contractVersion > 0 &&
    Array.isArray(value.vector) &&
    value.vector.length === EMBEDDING_DIMENSIONS &&
    value.vector.every((entry) => Number.isFinite(entry))
  );
}

function validImportance(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function allowedReadNamespace(
  authority: ProtectedMemoryAuthority,
  namespaceId: string,
): boolean {
  return authority.mode === "scope"
    ? uuid(namespaceId)
    : authority.readableNamespaceIds.includes(namespaceId);
}

function allowedMutationSet(
  authority: ProtectedMemoryAuthority,
  namespaceIds: readonly string[],
): boolean {
  const exact = canonicalIds(namespaceIds);
  if (exact === null) return false;
  if (authority.mode === "scope") {
    return (
      exact.length === 1 && exact[0] === authority.originWritableNamespaceId
    );
  }
  return exact.every((entry) => authority.mutableNamespaceIds.includes(entry));
}

function validCandidate(
  authority: ProtectedMemoryAuthority,
  candidate: ProtectedMemoryCandidate,
): boolean {
  return (
    uuid(candidate.memoryId) &&
    Number.isSafeInteger(candidate.contentRevision) &&
    candidate.contentRevision > 0 &&
    Number.isSafeInteger(candidate.cryptoAccessRevision) &&
    candidate.cryptoAccessRevision >= 0 &&
    portableText(candidate.cryptoObjectId) &&
    candidate.cryptoObjectId ===
      canonicalMemoryObjectId(candidate.memoryId, candidate.contentRevision) &&
    uuid(candidate.readNamespaceId) &&
    allowedReadNamespace(authority, candidate.readNamespaceId) &&
    canonicalIds(candidate.requiredNamespaceIds) !== null &&
    candidate.requiredNamespaceIds.includes(candidate.readNamespaceId) &&
    validImportance(candidate.importance) &&
    Number.isSafeInteger(candidate.tier) &&
    candidate.tier >= 1 &&
    candidate.tier <= 3 &&
    Number.isFinite(candidate.score) &&
    candidate.score >= -1 &&
    candidate.score <= 1 &&
    candidate.createdAt instanceof Date &&
    !Number.isNaN(candidate.createdAt.getTime())
  );
}

function canonicalMemoryObjectId(
  memoryId: string,
  contentRevision: number,
): string | null {
  try {
    return deriveMemoryCryptoObjectIdV1({ memoryId, contentRevision });
  } catch {
    return null;
  }
}

function validTarget(
  authority: ProtectedMemoryAuthority,
  target: ProtectedMemoryMutationTarget,
): boolean {
  return (
    uuid(target.memoryId) &&
    Number.isSafeInteger(target.contentRevision) &&
    target.contentRevision > 0 &&
    Number.isSafeInteger(target.cryptoAccessRevision) &&
    target.cryptoAccessRevision >= 0 &&
    target.cryptoObjectId ===
      canonicalMemoryObjectId(target.memoryId, target.contentRevision) &&
    allowedMutationSet(authority, target.requiredNamespaceIds)
  );
}

function validPlan(
  authority: ProtectedMemoryAuthority,
  plan: ProtectedMemoryMutationPlan,
): boolean {
  return (
    portableText(plan.operationId) &&
    (plan.action === "created" || plan.action === "updated") &&
    (plan.mutationKind === "save" ||
      plan.mutationKind === "replace" ||
      plan.mutationKind === "background") &&
    uuid(plan.memoryId) &&
    Number.isSafeInteger(plan.contentRevision) &&
    plan.contentRevision > 0 &&
    plan.cryptoAccessRevision === 0 &&
    Number.isSafeInteger(plan.expectedPriorAccessRevision) &&
    plan.expectedPriorAccessRevision >= 0 &&
    plan.cryptoObjectId ===
      canonicalMemoryObjectId(plan.memoryId, plan.contentRevision) &&
    allowedMutationSet(authority, plan.requiredNamespaceIds) &&
    plan.reservationDigest instanceof Uint8Array &&
    plan.reservationDigest.length === 32 &&
    plan.mutationCommitment instanceof Uint8Array &&
    plan.mutationCommitment.length === 32 &&
    validImportance(plan.importance) &&
    Number.isSafeInteger(plan.createdAt) &&
    plan.createdAt >= 0 &&
    (plan.similarity === undefined || Number.isFinite(plan.similarity))
  );
}

function preparedMatchesPlan(
  prepared: PreparedMemoryCryptoRevision,
  plan: ProtectedMemoryMutationPlan,
): boolean {
  return (
    prepared.memoryId === plan.memoryId &&
    prepared.contentRevision === plan.contentRevision &&
    prepared.objectId === plan.cryptoObjectId &&
    prepared.objectType === MEMORY_OBJECT_TYPE &&
    prepared.payloadVersion === MEMORY_PAYLOAD_VERSION &&
    prepared.requiredNamespaceIds.length === plan.requiredNamespaceIds.length &&
    prepared.requiredNamespaceIds.every(
      (entry, index) => entry === plan.requiredNamespaceIds[index],
    )
  );
}

function targetFromPlan(
  plan: ProtectedMemoryMutationPlan,
): ProtectedMemoryMutationTarget {
  return Object.freeze({
    memoryId: plan.memoryId,
    contentRevision: plan.contentRevision,
    cryptoAccessRevision: plan.cryptoAccessRevision,
    cryptoObjectId: plan.cryptoObjectId,
    requiredNamespaceIds: plan.requiredNamespaceIds,
  });
}

function mapCommitFailure(
  result: "stale" | "deleted",
): ProtectedMemoryUnavailableReason {
  return result === "deleted" ? "deleted" : "stale_revision";
}

export function createInvocationBoundProtectedAgentMemoryRepository(
  input: Readonly<{
    subjectUserId: string;
    agentId: string;
    entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    embedding: ProtectedAgentMemoryEmbeddingPort;
    product: ProtectedAgentMemoryProductPort;
    crypto: ProtectedAgentMemoryCryptoSessionPort;
    owner: EncryptionDataOperationOwner;
    loadExactOrdinary?(
      input: Readonly<{
        authority: ProtectedMemoryAuthority;
        candidates: readonly ProtectedMemoryCandidate[];
        signal?: AbortSignal;
      }>,
    ): Promise<
      ProtectedMemoryResult<readonly ProtectedMemorySessionOpenedItem[]>
    >;
    repairExactCandidate(
      input: Readonly<{
        operationId: string;
        authority: ProtectedMemoryAuthority;
        selection: ProtectedMemorySaveCandidateSelection;
        signal?: AbortSignal;
      }>,
    ): Promise<ProtectedMemoryResult<void>>;
    fallbackOrdinary(
      input: Readonly<{
        authority: ProtectedMemoryAuthority;
        plan: ProtectedMemoryMutationPlan;
        embedding: AgentMemoryEmbedding;
        content:
          | Readonly<{ kind: "complete"; payload: MemoryPayloadV1 }>
          | Readonly<{
              kind: "replacement";
              previous: ProtectedMemoryMutationTarget;
              content: string;
            }>;
        reason: "encryption_pending" | "target_encryption_not_ready";
      }>,
    ): Promise<
      ProtectedMemoryResult<
        Readonly<{
          id: string;
          action: "created" | "updated";
          similarity?: number;
        }>
      >
    >;
    signal?: AbortSignal;
  }>,
): ProtectedAgentMemoryRepository {
  async function embed(
    purpose: "memory.content_embedding" | "memory.query_embedding",
    plaintext: string,
  ): Promise<ProtectedMemoryResult<AgentMemoryEmbedding>> {
    if (input.signal?.aborted === true) {
      return unavailable("authorization_required");
    }
    const result = await input.embedding.embed({
      purpose,
      plaintext,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.status === "unavailable") return result;
    return validEmbedding(result.value)
      ? result
      : unavailable("embedding_unavailable");
  }

  async function prepareAndPublish(
    authority: ProtectedMemoryAuthority,
    plan: ProtectedMemoryMutationPlan,
    content:
      | Readonly<{ kind: "complete"; payload: MemoryPayloadV1 }>
      | Readonly<{
          kind: "replacement";
          previous: ProtectedMemoryMutationTarget;
          content: string;
        }>,
    embedding: AgentMemoryEmbedding,
    operation: "publish" | "replace",
  ): Promise<
    ProtectedMemoryResult<
      Readonly<{
        id: string;
        action: "created" | "updated";
        similarity?: number;
      }>
    >
  > {
    type PublicationResult = ProtectedMemoryResult<
      Readonly<{
        id: string;
        action: "created" | "updated";
        similarity?: number;
      }>
    >;
    if (!validPlan(authority, plan)) {
      return unavailable("incomplete_access_set");
    }
    type PublicationPlan =
      | Readonly<{
          representation: "protected";
          prepared: PreparedMemoryCryptoRevision;
        }>
      | Readonly<{
          representation: "ordinary";
          reason: "encryption_pending" | "target_encryption_not_ready";
        }>;
    let fallbackReason: "encryption_pending" | "target_encryption_not_ready" =
      "encryption_pending";
    const prepareProtected = async (): Promise<PublicationPlan> => {
      const prepared = await input.crypto.prepare({
        entrypointId: input.entrypointId,
        agentId: input.agentId,
        authority,
        plan,
        content,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (prepared.status === "unavailable") {
        if (
          prepared.reason === "encryption_pending" ||
          prepared.reason === "target_encryption_not_ready"
        )
          fallbackReason = prepared.reason;
        throw new AgentMemoryDataOperationError(
          prepared.reason === "encryption_pending" ||
            prepared.reason === "target_encryption_not_ready"
            ? "recoverable_availability"
            : prepared.reason === "authorization_required"
              ? "authority"
              : prepared.reason === "integrity_failure"
                ? "integrity"
                : "unknown",
          prepared.reason,
        );
      }
      if (!preparedMatchesPlan(prepared.value, plan)) {
        throw new ClassifiedDataOperationError(
          "integrity",
          "integrity_failure",
        );
      }
      return Object.freeze({
        representation: "protected" as const,
        prepared: prepared.value,
      });
    };
    async function publish(
      selected: PublicationPlan,
    ): Promise<PublicationResult> {
      if (selected.representation === "ordinary") {
        return input.fallbackOrdinary({
          authority,
          plan,
          embedding,
          content,
          reason: selected.reason,
        });
      }
      const committed = await input.crypto.authorizeCommit({
        entrypointId: input.entrypointId,
        agentId: input.agentId,
        authority,
        target: targetFromPlan(plan),
        operation,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        commit: () =>
          input.product.publishPrepared({
            authority,
            plan,
            prepared: selected.prepared,
            embedding,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }),
      });
      if (committed.status === "unavailable") return committed;
      if (committed.value === "stale" || committed.value === "deleted") {
        return unavailable(mapCommitFailure(committed.value));
      }
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          id: plan.memoryId,
          action: plan.action,
          ...(plan.similarity === undefined
            ? {}
            : { similarity: plan.similarity }),
        }),
      });
    }
    try {
      return await input.owner.mutate<PublicationPlan, PublicationResult>({
        protected: prepareProtected,
        dual: prepareProtected,
        ordinary: () =>
          Promise.resolve(Object.freeze({
            representation: "ordinary" as const,
            reason: fallbackReason,
          })),
        publish: (selected) => publish(selected),
      });
    } catch (error) {
      if (error instanceof ClassifiedDataOperationError) {
        const result = operationUnavailable<Readonly<{
          id: string; action: "created" | "updated"; similarity?: number;
        }>>(error);
        if (result !== undefined) return result;
      }
      throw error;
    }
  }

  async function repairSelectedCandidate(
    operationId: string,
    authority: ProtectedMemoryAuthority,
    selection: ProtectedMemorySaveCandidateSelection,
  ): Promise<ProtectedMemoryResult<void>> {
    if (!selection.repairRequired) return successResult(undefined);
    const repair = async (): Promise<void> => {
      const result = await input.repairExactCandidate({
        operationId,
        authority,
        selection,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (result.status === "success") return;
      throw new AgentMemoryDataOperationError(
        result.reason === "encryption_pending" ||
          result.reason === "target_encryption_not_ready"
          ? "recoverable_availability"
          : result.reason === "authorization_required"
            ? "authority"
            : result.reason === "integrity_failure"
              ? "integrity"
              : "unknown",
        result.reason,
      );
    };
    try {
      await input.owner.read<void, void, void>({
        protected: () => Promise.reject(
          new AgentMemoryDataOperationError(
            "recoverable_availability",
            "encryption_pending",
          ),
        ),
        repair: {
          forward: async () => {
            await repair();
          },
        },
        consumeOrdinary: () => undefined,
        consumeProtected: () => undefined,
      });
      return successResult(undefined);
    } catch (error) {
      if (error instanceof ClassifiedDataOperationError) {
        const result = operationUnavailable<void>(error);
        if (result !== undefined) return result;
      }
      throw error;
    }
  }

  const repository: ProtectedAgentMemoryRepository = {
    async search(request) {
      if (
        !validAuthority(
          request.authority,
          input.subjectUserId,
          input.agentId,
        ) ||
        request.mode !== "vector" ||
        !boundedText(request.query, MAX_QUERY_BYTES) ||
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > MAX_SEARCH_RESULTS
      )
        return unavailable("authorization_required");
      const embedded = await embed("memory.query_embedding", request.query);
      if (embedded.status === "unavailable") return embedded;
      const candidates = await input.product.searchCandidates({
        authority: request.authority,
        embedding: embedded.value,
        limit: request.limit,
        includeArchive: request.includeArchive,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (candidates.status === "unavailable") return candidates;
      if (
        candidates.value.length > request.limit ||
        new Set(candidates.value.map((entry) => entry.memoryId)).size !==
          candidates.value.length ||
        candidates.value.some(
          (entry) => !validCandidate(request.authority, entry),
        )
      )
        return unavailable("integrity_failure");
      if (candidates.value.length === 0) {
        return Object.freeze({ status: "success" as const, value: [] });
      }
      const loadProtected = async () => {
        const opened = await input.crypto.openMany({
          entrypointId: input.entrypointId,
          agentId: input.agentId,
          authority: request.authority,
          candidates: candidates.value,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (opened.status === "unavailable")
          throw new AgentMemoryDataOperationError(
            opened.reason === "encryption_pending" ||
              opened.reason === "target_encryption_not_ready"
              ? "recoverable_availability"
              : opened.reason === "authorization_required"
                ? "authority"
                : opened.reason === "integrity_failure"
                  ? "integrity"
                  : "unknown",
            opened.reason,
          );
        return opened.value;
      };
      let openedValue: readonly ProtectedMemorySessionOpenedItem[];
      try {
        openedValue = (
          await input.owner.read<
            readonly ProtectedMemorySessionOpenedItem[],
            readonly ProtectedMemorySessionOpenedItem[],
            readonly ProtectedMemorySessionOpenedItem[]
          >({
            protected: loadProtected,
            ...(input.loadExactOrdinary === undefined
              ? {}
              : {
                  ordinary: async () => {
                    const ordinary = await input.loadExactOrdinary!({
                      authority: request.authority,
                      candidates: candidates.value,
                      ...(input.signal === undefined
                        ? {}
                        : { signal: input.signal }),
                    });
                    if (ordinary.status === "unavailable")
                      throw new AgentMemoryDataOperationError(
                        ordinary.reason === "authorization_required"
                          ? "authority"
                          : ordinary.reason === "integrity_failure"
                            ? "integrity"
                            : "unknown",
                        ordinary.reason,
                      );
                    return ordinary.value;
                  },
                }),
            consumeOrdinary: (value) => value,
            consumeProtected: (value) => value,
          })
        ).value;
      } catch (error) {
        if (error instanceof ClassifiedDataOperationError) {
          const result = operationUnavailable<readonly ProtectedMemoryOpenedItem[]>(error);
          if (result !== undefined) return result;
        }
        throw error;
      }
      if (
        openedValue.length !== candidates.value.length ||
        openedValue.some((entry, index) => {
          const candidate = candidates.value[index];
          return (
            candidate === undefined ||
            entry.memoryId !== candidate.memoryId ||
            entry.contentRevision !== candidate.contentRevision ||
            !boundedText(entry.type, MAX_TYPE_BYTES) ||
            !boundedText(entry.content, MAX_CONTENT_BYTES)
          );
        })
      )
        return unavailable("integrity_failure");
      const value: ProtectedMemoryOpenedItem[] = openedValue.map(
        (entry, index) => {
          const candidate = candidates.value[index]!;
          return Object.freeze({
            id: entry.memoryId,
            type: entry.type,
            content: entry.content,
            importance: candidate.importance,
            tier: candidate.tier,
            score: candidate.score,
            createdAt: new Date(candidate.createdAt),
          });
        },
      );
      return Object.freeze({ status: "success" as const, value });
    },

    async save(request) {
      if (
        !validAuthority(
          request.authority,
          input.subjectUserId,
          input.agentId,
        ) ||
        !portableText(request.operationId, 128) ||
        !boundedText(request.type, MAX_TYPE_BYTES) ||
        !boundedText(request.content, MAX_CONTENT_BYTES) ||
        (request.importance !== undefined &&
          !validImportance(request.importance))
      )
        return unavailable("authorization_required");
      const mutationCommitment = commitMemoryMutationV1({
        kind: "save",
        payload: {
          formatVersion: 1,
          type: request.type,
          content: request.content,
        },
      });
      const replay = await input.product.replayCompleted({
        operationId: request.operationId,
        authority: request.authority,
        mutationKind: "save",
        importance: request.importance ?? 1,
        mutationCommitment,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (replay.status === "unavailable") return replay;
      if (replay.value !== null)
        return Object.freeze({
          status: "success" as const,
          ...(replay.value.fallbackReason === undefined
            ? {}
            : { fallbackReason: replay.value.fallbackReason }),
          value: Object.freeze({
            id: replay.value.memoryId,
            action: replay.value.action,
            ...(replay.value.similarity === undefined
              ? {}
              : { similarity: replay.value.similarity }),
          }),
        });
      const embedded = await embed("memory.content_embedding", request.content);
      if (embedded.status === "unavailable") return embedded;
      const selected = await input.product.selectSaveCandidate({
        authority: request.authority,
        embedding: embedded.value,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (selected.status === "unavailable") return selected;
      if (selected.value?.repairRequired === true) {
        const repaired = await repairSelectedCandidate(
          request.operationId,
          request.authority,
          selected.value,
        );
        if (repaired.status === "unavailable") return repaired;
      }
      const plan = await input.product.planSave({
        operationId: request.operationId,
        authority: request.authority,
        embedding: embedded.value,
        selectedCandidate: selected.value,
        importance: request.importance ?? 1,
        mutationCommitment,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (plan.status === "unavailable") return plan;
      if (
        plan.value.operationId !== request.operationId ||
        !sameBytes(plan.value.mutationCommitment, mutationCommitment)
      ) {
        return unavailable("integrity_failure");
      }
      return prepareAndPublish(
        request.authority,
        plan.value,
        Object.freeze({
          kind: "complete" as const,
          payload: Object.freeze({
            formatVersion: 1,
            type: request.type,
            content: request.content,
          }),
        }),
        embedded.value,
        "publish",
      );
    },

    async replace(request) {
      if (
        !validAuthority(
          request.authority,
          input.subjectUserId,
          input.agentId,
        ) ||
        !portableText(request.operationId, 128) ||
        !uuid(request.memoryId) ||
        !boundedText(request.content, MAX_CONTENT_BYTES)
      )
        return unavailable("authorization_required");
      const mutationCommitment = commitMemoryMutationV1({
        kind: "replace",
        content: request.content,
      });
      const replay = await input.product.replayCompleted({
        operationId: request.operationId,
        authority: request.authority,
        mutationKind: "replace",
        memoryId: request.memoryId,
        mutationCommitment,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (replay.status === "unavailable") return replay;
      if (replay.value !== null) {
        return Object.freeze({
          status: "success" as const,
          value: undefined,
          ...(replay.value.fallbackReason === undefined
            ? {}
            : { fallbackReason: replay.value.fallbackReason }),
        });
      }
      const embedded = await embed("memory.content_embedding", request.content);
      if (embedded.status === "unavailable") return embedded;
      const plan = await input.product.planReplace({
        operationId: request.operationId,
        authority: request.authority,
        memoryId: request.memoryId,
        embedding: embedded.value,
        mutationCommitment,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (plan.status === "unavailable") return plan;
      if (
        !validPlan(request.authority, plan.value) ||
        plan.value.operationId !== request.operationId ||
        !sameBytes(plan.value.mutationCommitment, mutationCommitment) ||
        plan.value.action !== "updated" ||
        !validTarget(request.authority, plan.value.previous) ||
        plan.value.previous.memoryId !== request.memoryId ||
        plan.value.memoryId !== request.memoryId ||
        plan.value.previous.contentRevision + 1 !== plan.value.contentRevision
      )
        return unavailable("stale_revision");
      const result = await prepareAndPublish(
        request.authority,
        plan.value,
        Object.freeze({
          kind: "replacement" as const,
          previous: plan.value.previous,
          content: request.content,
        }),
        embedded.value,
        "replace",
      );
      return result.status === "unavailable"
        ? result
        : Object.freeze({ status: "success" as const, value: undefined });
    },

    async setTier(request) {
      if (
        !validAuthority(
          request.authority,
          input.subjectUserId,
          input.agentId,
        ) ||
        !portableText(request.operationId, 128) ||
        !uuid(request.memoryId)
      )
        return unavailable("authorization_required");
      const replay = await input.product.replayCompleted({
        operationId: request.operationId,
        authority: request.authority,
        mutationKind: request.action,
        memoryId: request.memoryId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (replay.status === "unavailable") return replay;
      if (replay.value !== null) {
        return Object.freeze({ status: "success" as const, value: undefined });
      }
      const target = await input.product.resolveTierTarget({
        operationId: request.operationId,
        authority: request.authority,
        memoryId: request.memoryId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (target.status === "unavailable") return target;
      if (
        target.value.memoryId !== request.memoryId ||
        !validTarget(request.authority, target.value)
      )
        return unavailable("incomplete_access_set");
      const authorize = () =>
        input.crypto.authorizeCommit({
          entrypointId: input.entrypointId,
          agentId: input.agentId,
          authority: request.authority,
          target: target.value,
          operation: "set-tier",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          commit: () =>
            input.product.commitTier({
              operationId: request.operationId,
              authority: request.authority,
              target: target.value,
              action: request.action,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            }),
        });
      const committed = await input.owner.metadata(() => authorize());
      if (committed.status === "unavailable") return committed;
      if (committed.value === "stale" || committed.value === "deleted") {
        return unavailable(mapCommitFailure(committed.value));
      }
      return Object.freeze({ status: "success" as const, value: undefined });
    },
  };
  return Object.freeze(repository);
}
