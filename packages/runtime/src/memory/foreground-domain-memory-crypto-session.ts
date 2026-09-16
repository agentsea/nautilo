import {
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  commitMemoryMutationV1,
  createForegroundAgentObjectRepairer,
  decodeMemoryPayloadV1,
  deriveMemoryCryptoObjectIdV1,
  encodeMemoryPayloadV1,
  type AtomicMemoryCryptoCompletionPort,
  type ForegroundAgentEntityCryptoInvocation,
  type MemoryPayloadV1,
  type PreparedDeviceWrappedAgentObject,
  type PreparedMemoryCryptoRevision,
  type ProtectedAgentMemoryCryptoSessionPort,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryCandidate,
  type ProtectedMemoryMutationTarget,
  type ProtectedMemoryResult,
  type ProtectedMemorySessionOpenedItem,
  type VerifiedForegroundAgentObject,
} from "@nautilo/lattice-bridge";
import type { AgentRuntimeKeyGeneration, LatticeCrypto } from
  "@nautilo/lattice-crypto";

type EntrypointId = Parameters<
  ProtectedAgentMemoryCryptoSessionPort["openMany"]
>[0]["entrypointId"];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** Current-Domain foreground Memory crypto plus its factory-bound completion. */
export function createForegroundDomainMemoryCryptoSession(input: Readonly<{
  subjectUserId: string;
  agentId: string;
  entrypointId: EntrypointId;
  crypto: LatticeCrypto;
  entities: Pick<
    ForegroundAgentEntityCryptoInvocation,
    "signal" | "use" | "useCurrentSet"
  >;
  publication: Readonly<{
    /** Accepted foreground invocation authorizing the cryptographic write. */
    authorizationOperationId: string;
    grantId: string;
    grantDigest: Uint8Array;
    recipientKeyId: string;
    runtime: AgentRuntimeKeyGeneration;
    signerKeyId: string;
    signerPublicKey: Uint8Array;
    agentAuthorizationRevision: number;
  }>;
  persist(prepared: PreparedDeviceWrappedAgentObject): Promise<
    "created" | "duplicate" | "stale"
  >;
  read(request: Readonly<{
    objectId: string;
    expectedObjectType: string;
    expectedAccessRevision?: number;
    expectedNamespaceIds: readonly string[];
  }>): Promise<VerifiedForegroundAgentObject | null>;
}>): Readonly<{
  session: ProtectedAgentMemoryCryptoSessionPort;
  completion: Pick<AtomicMemoryCryptoCompletionPort, "complete">;
  /** Transient verified bytes for the policy-permitted ordinary Shadow sibling. */
  readPreparedPayload(revision: PreparedMemoryCryptoRevision): MemoryPayloadV1;
}> {
  const owned = new WeakMap<PreparedMemoryCryptoRevision, MemoryPayloadV1>();
  const cancelled = (signal?: AbortSignal): boolean =>
    input.entities.signal.aborted || signal?.aborted === true;
  const bound = (request: Readonly<{
    entrypointId: EntrypointId;
    agentId: string;
    authority: ProtectedMemoryAuthority;
  }>): request is typeof request & Readonly<{
    authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }>;
  }> => request.entrypointId === input.entrypointId
    && request.agentId === input.agentId
    && namespaceAuthority(request.authority, input.subjectUserId, input.agentId);

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
    const objects = createForegroundAgentObjectRepairer({
      crypto: input.crypto,
      entities: input.entities,
      publication: {
        operationId: `memory-open:${target.cryptoObjectId}`,
        ...input.publication,
      },
      persist: input.persist,
      read: input.read,
    });
    const result = await objects.protect({
      source: {
        objectId: target.cryptoObjectId,
        objectType: MEMORY_OBJECT_TYPE,
        existingObjectId: target.cryptoObjectId,
        expectedAccessRevision: target.cryptoAccessRevision,
        createdAt: 0,
        namespaceIds: target.requiredNamespaceIds,
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
      if (request.candidates.some((candidate) => {
        const ids = canonicalTarget(candidate);
        return ids === null
          || !ids.includes(candidate.readNamespaceId)
          || !request.authority.readableNamespaceIds.includes(candidate.readNamespaceId);
      })) return unavailable("incomplete_access_set");
      const values: ProtectedMemorySessionOpenedItem[] = [];
      for (const candidate of request.candidates) {
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
      const targetIds = canonicalTarget({
        memoryId: request.plan.memoryId,
        contentRevision: request.plan.contentRevision,
        cryptoAccessRevision: request.plan.cryptoAccessRevision,
        cryptoObjectId: request.plan.cryptoObjectId,
        requiredNamespaceIds: request.plan.requiredNamespaceIds,
      });
      if (
        targetIds === null
        || request.plan.mutationKind !== (
          request.content.kind === "complete" ? "save" : "replace"
        )
        || !targetIds.every((id) => request.authority.mutableNamespaceIds.includes(id))
      ) return unavailable("incomplete_access_set");
      const mutationCommitment = commitMemoryMutationV1(
        request.content.kind === "complete"
          ? { kind: "save", payload: request.content.payload }
          : { kind: "replace", content: request.content.content },
      );
      if (!exactBytes(mutationCommitment, request.plan.mutationCommitment)) {
        return unavailable("integrity_failure");
      }
      let payload = request.content.kind === "complete" ? request.content.payload : null;
      if (request.content.kind === "replacement") {
        const previousIds = canonicalTarget(request.content.previous);
        if (
          previousIds === null
          || !exactIds(previousIds, targetIds)
          || !previousIds.some((id) =>
            request.authority.readableNamespaceIds.includes(id)
          )
        ) {
          return unavailable("incomplete_access_set");
        }
        const previous = await open(request.content.previous, request.signal);
        if (previous.status === "unavailable") return previous;
        payload = Object.freeze({
          formatVersion: 1 as const,
          type: previous.value.type,
          content: request.content.content,
        });
      }
      if (payload === null) return unavailable("integrity_failure");
      const plaintextBytes = encodeMemoryPayloadV1(payload);
      try {
        const objects = createForegroundAgentObjectRepairer({
          crypto: input.crypto,
          entities: input.entities,
          publication: {
            operationId: input.publication.authorizationOperationId,
            ...input.publication,
          },
          persist: input.persist,
          read: input.read,
        });
        const result = await objects.protect({
          source: {
            objectId: request.plan.cryptoObjectId,
            objectType: MEMORY_OBJECT_TYPE,
            existingObjectId: null,
            expectedAccessRevision: request.plan.cryptoAccessRevision,
            createdAt: request.plan.createdAt,
            namespaceIds: targetIds,
            plaintextBytes,
          },
          decode: decodeMemoryPayloadV1,
        });
        if (cancelled(request.signal)) return unavailable("authorization_required");
        if (result.status !== "verified") return mappedFailure(result);
        const prepared = Object.freeze({
          memoryId: request.plan.memoryId,
          contentRevision: request.plan.contentRevision,
          objectId: request.plan.cryptoObjectId,
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
        || !ids.every((id) => request.authority.mutableNamespaceIds.includes(id))
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
