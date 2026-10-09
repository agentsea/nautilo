import {
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  commitMemoryMutationV1,
  decodeMemoryPayloadV1,
  deriveMemoryCryptoObjectIdV1,
  encodeMemoryPayloadV1,
  type AgentEntityCryptoInvocation,
  type AgentObjectProtectionResult,
  type AgentObjectProtectionSource,
  type AtomicMemoryCryptoCompletionPort,
  type MemoryPayloadV1,
  type PreparedMemoryCryptoRevision,
  type ProtectedAgentMemoryCryptoSessionPort,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryCandidate,
  type ProtectedMemoryMutationTarget,
  type ProtectedMemoryResult,
  type ProtectedMemorySessionOpenedItem,
} from "@nautilo/lattice-bridge";

type EntrypointId = Parameters<
  ProtectedAgentMemoryCryptoSessionPort["openMany"]
>[0]["entrypointId"];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type DomainMemoryObjectProtectionRequest<Value> = Readonly<{
  memoryId: string;
  contentRevision: number;
  operationId: string;
  source: AgentObjectProtectionSource;
  decode(plaintextBytes: Uint8Array): Value;
}>;

export interface DomainMemoryObjectProtector {
  protect<Value>(request: DomainMemoryObjectProtectionRequest<Value>): Promise<
    AgentObjectProtectionResult<Value>
  >;
}

export type DomainMemoryScopeBinding = Readonly<{
  scopeId: string;
  originWritableNamespaceId: string;
  readableNamespaceIds: readonly string[];
}>;

function unavailable<Value>(
  reason: "authorization_required" | "incomplete_access_set"
    | "integrity_failure" | "encryption_pending"
    | "target_encryption_not_ready",
): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function canonicalIds(ids: readonly string[]): readonly string[] | null {
  if (
    ids.length < 1
    || ids.some((id, index) =>
      !UUID.test(id) || (index > 0 && ids[index - 1]! >= id)
    )
  ) return null;
  return Object.freeze([...ids]);
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function namespaceAuthority(
  authority: ProtectedMemoryAuthority,
  subjectUserId: string,
  agentId: string,
): authority is Extract<ProtectedMemoryAuthority, { mode: "namespace" }> {
  return authority.mode === "namespace"
    && authority.subjectUserId === subjectUserId
    && authority.agentId === agentId
    && canonicalIds(authority.readableNamespaceIds) !== null
    && canonicalIds(authority.mutableNamespaceIds) !== null;
}

function snapshotScopeBinding(
  value: DomainMemoryScopeBinding,
): DomainMemoryScopeBinding {
  const readableNamespaceIds = canonicalIds(value.readableNamespaceIds);
  if (Object.keys(value).sort().join(",")
      !== "originWritableNamespaceId,readableNamespaceIds,scopeId"
    || !SCOPE_UUID.test(value.scopeId)
    || !SCOPE_UUID.test(value.originWritableNamespaceId)
    || readableNamespaceIds === null
    || readableNamespaceIds.some(id => !SCOPE_UUID.test(id))
    || !readableNamespaceIds.includes(value.originWritableNamespaceId)) {
    throw new TypeError("Scope Memory binding is invalid");
  }
  return Object.freeze({
    scopeId: value.scopeId,
    originWritableNamespaceId: value.originWritableNamespaceId,
    readableNamespaceIds,
  });
}

function mappedFailure<Value>(result: Readonly<{
  status: "waiting_for_authority" | "failed";
  reason: string;
}>): ProtectedMemoryResult<Value> {
  if (result.status === "waiting_for_authority") {
    return unavailable("authorization_required");
  }
  return unavailable(result.reason === "mapped_entity_crypto_incomplete"
    ? "encryption_pending"
    : "integrity_failure");
}

/** Current-Domain Memory crypto plus its factory-bound completion. */
export function createDomainMemoryCryptoSession(input: Readonly<{
  subjectUserId: string;
  agentId: string;
  entrypointId: EntrypointId;
  entities: Pick<
    AgentEntityCryptoInvocation,
    "signal" | "useCurrentSet"
  >;
  objects: DomainMemoryObjectProtector;
  prepareOperationId: string | ((planOperationId: string) => string);
  scopeBinding?: DomainMemoryScopeBinding;
}>): Readonly<{
  session: ProtectedAgentMemoryCryptoSessionPort;
  completion: Pick<AtomicMemoryCryptoCompletionPort, "complete">;
  /** Transient verified bytes for the policy-permitted ordinary Shadow sibling. */
  readPreparedPayload(revision: PreparedMemoryCryptoRevision): MemoryPayloadV1;
}> {
  const scopeBinding = input.scopeBinding === undefined
    ? null
    : snapshotScopeBinding(input.scopeBinding);
  const owned = new WeakMap<PreparedMemoryCryptoRevision, MemoryPayloadV1>();
  const cancelled = (signal?: AbortSignal): boolean =>
    input.entities.signal.aborted || signal?.aborted === true;
  const bound = (request: Readonly<{
    entrypointId: EntrypointId;
    agentId: string;
    authority: ProtectedMemoryAuthority;
  }>): boolean => request.entrypointId === input.entrypointId
    && request.agentId === input.agentId
    && (scopeBinding === null
      ? namespaceAuthority(
        request.authority,
        input.subjectUserId,
        input.agentId,
      )
      : request.authority.mode === "scope"
        && request.authority.subjectUserId === input.subjectUserId
        && request.authority.agentId === input.agentId
        && request.authority.scopeId === scopeBinding.scopeId
        && request.authority.originWritableNamespaceId
          === scopeBinding.originWritableNamespaceId);

  const readable = (
    authority: ProtectedMemoryAuthority,
    namespaceId: string,
  ): boolean => authority.mode === "namespace"
    ? authority.readableNamespaceIds.includes(namespaceId)
    : scopeBinding?.readableNamespaceIds.includes(namespaceId) === true;

  const mutable = (
    authority: ProtectedMemoryAuthority,
    namespaceIds: readonly string[],
  ): boolean => authority.mode === "namespace"
    ? namespaceIds.every((id) => authority.mutableNamespaceIds.includes(id))
    : scopeBinding !== null
      && exactIds(namespaceIds, [scopeBinding.originWritableNamespaceId]);

  const canonicalTarget = (
    target: ProtectedMemoryMutationTarget,
  ): readonly string[] | null => {
    const ids = canonicalIds(target.requiredNamespaceIds);
    let expectedObjectId: string;
    try {
      expectedObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: target.memoryId,
        contentRevision: target.contentRevision,
      });
    } catch {
      return null;
    }
    if (
      ids === null
      || target.contentRevision < 1
      || !Number.isSafeInteger(target.contentRevision)
      || target.cryptoAccessRevision < 0
      || !Number.isSafeInteger(target.cryptoAccessRevision)
      || target.cryptoObjectId !== expectedObjectId
    ) return null;
    return ids;
  };

  const open = async (
    target: ProtectedMemoryCandidate | ProtectedMemoryMutationTarget,
    signal?: AbortSignal,
  ): Promise<ProtectedMemoryResult<MemoryPayloadV1>> => {
    if (cancelled(signal)) return unavailable<MemoryPayloadV1>(
      "authorization_required",
    );
    const namespaceIds = canonicalTarget(target);
    if (namespaceIds === null) {
      return unavailable<MemoryPayloadV1>("incomplete_access_set");
    }
    const result = await input.objects.protect({
      memoryId: target.memoryId,
      contentRevision: target.contentRevision,
      operationId: `memory-open:${target.cryptoObjectId}`,
      source: {
        objectId: target.cryptoObjectId,
        objectType: MEMORY_OBJECT_TYPE,
        existingObjectId: target.cryptoObjectId,
        expectedAccessRevision: target.cryptoAccessRevision,
        createdAt: 0,
        namespaceIds,
        plaintextBytes: null,
      },
      decode: decodeMemoryPayloadV1,
    });
    if (cancelled(signal)) return unavailable<MemoryPayloadV1>(
      "authorization_required",
    );
    return result.status === "verified"
      ? Object.freeze({ status: "success" as const, value: result.value })
      : mappedFailure<MemoryPayloadV1>(result);
  };

  const session: ProtectedAgentMemoryCryptoSessionPort = Object.freeze({
    async openMany(request: Parameters<
      ProtectedAgentMemoryCryptoSessionPort["openMany"]
    >[0]): ReturnType<ProtectedAgentMemoryCryptoSessionPort["openMany"]> {
      if (!bound(request) || cancelled(request.signal)) {
        return unavailable("authorization_required");
      }
      if (request.candidates.length === 0) {
        return Object.freeze({ status: "success" as const, value: Object.freeze([]) });
      }
      const candidates: ProtectedMemoryCandidate[] = [];
      for (const candidate of request.candidates) {
        const ids = canonicalTarget(candidate);
        if (ids === null
          || !ids.includes(candidate.readNamespaceId)
          || !readable(request.authority, candidate.readNamespaceId)) {
          return unavailable("incomplete_access_set");
        }
        candidates.push(Object.freeze({
          ...candidate,
          requiredNamespaceIds: ids,
        }));
      }
      const values: ProtectedMemorySessionOpenedItem[] = [];
      for (const candidate of candidates) {
        const result = await open(candidate, request.signal);
        if (result.status === "unavailable") return result;
        values.push(Object.freeze({
          memoryId: candidate.memoryId,
          contentRevision: candidate.contentRevision,
          type: result.value.type,
          content: result.value.content,
        }));
      }
      return Object.freeze({ status: "success" as const, value: Object.freeze(values) });
    },

    async prepare(request: Parameters<
      ProtectedAgentMemoryCryptoSessionPort["prepare"]
    >[0]): ReturnType<ProtectedAgentMemoryCryptoSessionPort["prepare"]> {
      if (!bound(request) || cancelled(request.signal)) {
        return unavailable("authorization_required");
      }
      const plan = Object.freeze({
        operationId: request.plan.operationId,
        mutationKind: request.plan.mutationKind,
        memoryId: request.plan.memoryId,
        contentRevision: request.plan.contentRevision,
        cryptoAccessRevision: request.plan.cryptoAccessRevision,
        cryptoObjectId: request.plan.cryptoObjectId,
        requiredNamespaceIds: Object.freeze([
          ...request.plan.requiredNamespaceIds,
        ]),
        mutationCommitment: request.plan.mutationCommitment.slice(),
        createdAt: request.plan.createdAt,
      });
      const content = request.content.kind === "complete"
        ? Object.freeze({
          kind: "complete" as const,
          payload: Object.freeze({ ...request.content.payload }),
        })
        : Object.freeze({
          kind: "replacement" as const,
          previous: Object.freeze({
            ...request.content.previous,
            requiredNamespaceIds: Object.freeze([
              ...request.content.previous.requiredNamespaceIds,
            ]),
          }),
          content: request.content.content,
        });
      const targetIds = canonicalTarget({
        memoryId: plan.memoryId,
        contentRevision: plan.contentRevision,
        cryptoAccessRevision: plan.cryptoAccessRevision,
        cryptoObjectId: plan.cryptoObjectId,
        requiredNamespaceIds: plan.requiredNamespaceIds,
      });
      if (
        targetIds === null
        || plan.mutationKind !== (
          content.kind === "complete" ? "save" : "replace"
        )
        || !mutable(request.authority, targetIds)
      ) return unavailable("incomplete_access_set");
      const mutationCommitment = commitMemoryMutationV1(
        content.kind === "complete"
          ? { kind: "save", payload: content.payload }
          : { kind: "replace", content: content.content },
      );
      if (!exactBytes(mutationCommitment, plan.mutationCommitment)) {
        return unavailable("integrity_failure");
      }
      const prepareOperationId = typeof input.prepareOperationId === "string"
        ? input.prepareOperationId
        : input.prepareOperationId(plan.operationId);
      let payload = content.kind === "complete" ? content.payload : null;
      if (content.kind === "replacement") {
        const previousIds = canonicalTarget(content.previous);
        if (
          previousIds === null
          || !exactIds(previousIds, targetIds)
          || !previousIds.some((id) => readable(request.authority, id))
        ) {
          return unavailable("incomplete_access_set");
        }
        const previous = await open(content.previous, request.signal);
        if (previous.status === "unavailable") return previous;
        payload = Object.freeze({
          formatVersion: 1 as const,
          type: previous.value.type,
          content: content.content,
        });
      }
      if (payload === null) return unavailable("integrity_failure");
      const plaintextBytes = encodeMemoryPayloadV1(payload);
      try {
        const result = await input.objects.protect({
          memoryId: plan.memoryId,
          contentRevision: plan.contentRevision,
          operationId: prepareOperationId,
          source: {
            objectId: plan.cryptoObjectId,
            objectType: MEMORY_OBJECT_TYPE,
            existingObjectId: null,
            expectedAccessRevision: plan.cryptoAccessRevision,
            createdAt: plan.createdAt,
            namespaceIds: targetIds,
            plaintextBytes,
          },
          decode: decodeMemoryPayloadV1,
        });
        if (cancelled(request.signal)) return unavailable("authorization_required");
        if (result.status !== "verified") return mappedFailure(result);
        const prepared = Object.freeze({
          memoryId: plan.memoryId,
          contentRevision: plan.contentRevision,
          objectId: plan.cryptoObjectId,
          objectType: MEMORY_OBJECT_TYPE,
          payloadVersion: MEMORY_PAYLOAD_VERSION,
          requiredNamespaceIds: targetIds,
        });
        owned.set(prepared, Object.freeze({ ...result.value }));
        return Object.freeze({ status: "success" as const, value: prepared });
      } finally {
        plaintextBytes.fill(0);
      }
    },

    async authorizeCommit<Value>(request: Readonly<{
      entrypointId: EntrypointId;
      agentId: string;
      authority: ProtectedMemoryAuthority;
      target: ProtectedMemoryMutationTarget;
      operation: "publish" | "replace" | "set-tier";
      signal?: AbortSignal;
      commit: () => Value | PromiseLike<Value>;
    }>): Promise<ProtectedMemoryResult<Value>> {
      if (!bound(request) || cancelled(request.signal)) {
        return unavailable("authorization_required");
      }
      const ids = canonicalTarget(request.target);
      if (
        ids === null
        || !mutable(request.authority, ids)
      ) return unavailable("incomplete_access_set");
      const result = await input.entities.useCurrentSet({
        operations: ["encrypt"],
        namespaceIds: ids,
        execute: async (items) => {
          const liveIds = items.map((item) => item.authority.namespaceId).sort();
          if (!exactIds(liveIds, ids)) {
            throw new TypeError("Live Memory Namespace authority changed");
          }
          if (cancelled(request.signal)) {
            return { committed: false as const };
          }
          return {
            committed: true as const,
            value: await request.commit(),
          };
        },
      });
      if (result.status !== "executed") {
        return unavailable(result.reason === "content_unavailable"
          ? "target_encryption_not_ready"
          : "authorization_required");
      }
      if (!result.value.committed) return unavailable("authorization_required");
      return Object.freeze({ status: "success" as const, value: result.value.value });
    },
  });

  return Object.freeze({
    session,
    readPreparedPayload: (revision: PreparedMemoryCryptoRevision) => {
      const payload = owned.get(revision);
      if (payload === undefined) {
        throw new TypeError("Foreground Memory revision belongs to another crypto session");
      }
      return payload;
    },
    completion: Object.freeze({
      complete: (revision: PreparedMemoryCryptoRevision) => {
        if (!owned.has(revision)) {
          return Promise.reject(new TypeError(
            "Foreground Memory revision belongs to another crypto session",
          ));
        }
        return Promise.resolve("duplicate" as const);
      },
    }),
  });
}
