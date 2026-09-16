import type {
  AgentMemoryEmbedding,
  ProtectedAgentBackgroundMemoryWorkInput,
  ProtectedAgentBackgroundMemoryWorkOutput,
  ProtectedAgentMemoryEmbeddingPort,
  ProtectedAgentMemoryRepository,
  ProtectedMemoryAuthority,
  ProtectedMemoryOpenedItem,
  ProtectedMemoryResult,
} from "@nautilo/lattice-bridge";

const MAX_INPUTS = 64;
const MAX_OUTPUTS = 16;
const MAX_SEARCH_LIMIT = 64;

export type ProtectedBackgroundMemoryCandidateMetadata = Readonly<{
  memoryId: string;
  /** Exact product content revision whose disclosed embedding is authorized. */
  contentRevision: number;
  cryptoAccessRevision: number;
  importance: number;
  tier: number;
  createdAt: number;
  /** Product-authorized disclosed embedding for this exact input revision. */
  embedding: AgentMemoryEmbedding;
}>;

export type ProtectedBackgroundMemoryOutputSlot = Readonly<{
  action: "create" | "replace";
  publicationIdempotencyId: string;
  memoryId: string;
  expectedContentRevision: number;
  expectedCryptoAccessRevision: number;
  nextContentRevision: number;
  requiredNamespaceIds: readonly string[];
  createdAt: number;
}>;

export type ProtectedBackgroundMemoryTierSlot = Readonly<{
  operationIdempotencyId: string;
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  action: "promote" | "demote";
  expectedTier: 1 | 2;
  nextTier: 1 | 2 | 3;
  requiredNamespaceIds: readonly string[];
}>;

export type ProtectedBackgroundMemoryStaging = Readonly<{
  repository: ProtectedAgentMemoryRepository;
  outputs(): readonly ProtectedAgentBackgroundMemoryWorkOutput[];
}>;

function unavailable<Value>(
  reason: "authorization_required" | "embedding_unavailable"
    | "incomplete_access_set" | "stale_revision",
): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function exactAuthority(
  left: ProtectedMemoryAuthority,
  right: ProtectedMemoryAuthority,
): boolean {
  if (
    left.mode !== right.mode
    || left.subjectUserId !== right.subjectUserId
    || left.agentId !== right.agentId
  ) return false;
  if (left.mode === "scope" && right.mode === "scope") {
    return left.scopeId === right.scopeId
      && left.originWritableNamespaceId === right.originWritableNamespaceId;
  }
  return left.mode === "namespace" && right.mode === "namespace"
    && left.writableNamespaceId === right.writableNamespaceId
    && JSON.stringify(left.readableNamespaceIds)
      === JSON.stringify(right.readableNamespaceIds)
    && JSON.stringify(left.mutableNamespaceIds)
      === JSON.stringify(right.mutableNamespaceIds);
}

function validEmbedding(value: AgentMemoryEmbedding): boolean {
  return value.dimensions === 1536
    && value.vector.length === 1536
    && value.vector.every(Number.isFinite)
    && value.provider.length > 0
    && value.canonicalModel.length > 0
    && Number.isSafeInteger(value.contractVersion)
    && value.contractVersion > 0;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function canonicalIds(value: readonly string[]): readonly string[] | null {
  if (value.length < 1 || new Set(value).size !== value.length) return null;
  const sorted = [...value].sort();
  return sorted.every((entry, index) => entry === value[index])
    ? Object.freeze(sorted)
    : null;
}

/**
 * One-run, plaintext-free-at-rest Memory repository for the background model.
 * It can read only bridge-opened inputs and can stage only signed output slots.
 * Exact signed content/tier actions are staged; scope seed mutations fail
 * closed and scope-origin writes stay bound to their signed origin inventory.
 */
export function createProtectedBackgroundMemoryStaging(input: Readonly<{
  authority: ProtectedMemoryAuthority;
  inputs: readonly ProtectedAgentBackgroundMemoryWorkInput[];
  candidateMetadata:
    readonly ProtectedBackgroundMemoryCandidateMetadata[];
  outputSlots: readonly ProtectedBackgroundMemoryOutputSlot[];
  tierSlots: readonly ProtectedBackgroundMemoryTierSlot[];
  embedding: ProtectedAgentMemoryEmbeddingPort;
  signal?: AbortSignal;
}>): ProtectedBackgroundMemoryStaging {
  if (
    input.inputs.length > MAX_INPUTS
    || input.outputSlots.length > MAX_OUTPUTS
    || input.tierSlots.length > MAX_OUTPUTS
    || input.candidateMetadata.length > MAX_INPUTS
  ) throw new TypeError("Protected background Memory inventory is invalid");
  if (input.authority.mode === "namespace") {
    const readableNamespaceIds = canonicalIds(
      input.authority.readableNamespaceIds,
    );
    const mutableNamespaceIds = canonicalIds(
      input.authority.mutableNamespaceIds,
    );
    if (
      readableNamespaceIds === null
      || mutableNamespaceIds === null
      || mutableNamespaceIds.some((namespaceId) =>
        !readableNamespaceIds.includes(namespaceId)
      )
      || (
        input.authority.writableNamespaceId !== null
        && !mutableNamespaceIds.includes(input.authority.writableNamespaceId)
      )
    ) throw new TypeError("Protected background Memory authority is invalid");
  }
  const memoryInputs = input.inputs.filter((entry) =>
    entry.productKind === "memory"
  );
  const scopeOriginNamespaceId = input.authority.mode === "scope"
    ? input.authority.originWritableNamespaceId
    : null;
  const metadata = new Map(
    input.candidateMetadata.map((entry) => [entry.memoryId, entry]),
  );
  if (
    metadata.size !== input.candidateMetadata.length
    || memoryInputs.some((entry) =>
      metadata.get(entry.productId)?.contentRevision !== entry.productRevision
      || metadata.get(entry.productId)?.cryptoAccessRevision
        !== entry.cryptoAccessRevision
    )
    || input.candidateMetadata.some((entry) =>
      !Number.isSafeInteger(entry.contentRevision)
      || entry.contentRevision < 1
      || !Number.isSafeInteger(entry.cryptoAccessRevision)
      || entry.cryptoAccessRevision < 0
    )
    || input.candidateMetadata.some((entry) =>
      !validEmbedding(entry.embedding)
    )
    || input.outputSlots.some((slot) =>
      canonicalIds(slot.requiredNamespaceIds) === null
      || (slot.action === "create"
        ? slot.expectedContentRevision !== 0
          || slot.expectedCryptoAccessRevision !== 0
          || slot.nextContentRevision !== 1
        : slot.expectedContentRevision < 1
          || slot.nextContentRevision !== slot.expectedContentRevision + 1)
    )
    || input.tierSlots.some((slot) =>
      canonicalIds(slot.requiredNamespaceIds) === null
      || !Number.isSafeInteger(slot.contentRevision)
      || slot.contentRevision < 1
      || !Number.isSafeInteger(slot.cryptoAccessRevision)
      || slot.cryptoAccessRevision < 0
    )
    || memoryInputs.some((entry) => input.authority.mode === "scope"
      ? entry.accessKind === "namespace"
      : entry.accessKind !== "namespace")
    || (scopeOriginNamespaceId !== null && (
      input.outputSlots.some((slot) =>
        slot.requiredNamespaceIds.length !== 1
        || slot.requiredNamespaceIds[0]
          !== scopeOriginNamespaceId
      )
      || input.tierSlots.some((slot) =>
        slot.requiredNamespaceIds.length !== 1
        || slot.requiredNamespaceIds[0]
          !== scopeOriginNamespaceId
      )
    ))
  ) throw new TypeError("Protected background Memory inventory is incomplete");
  const staged = new Map<string, ProtectedAgentBackgroundMemoryWorkOutput>();
  const stagedMemoryIds = new Set<string>();

  async function embed(
    purpose: "memory.content_embedding" | "memory.query_embedding",
    plaintext: string,
  ): Promise<AgentMemoryEmbedding | null> {
    const result = await input.embedding.embed({
      purpose,
      plaintext,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return result.status === "success" && validEmbedding(result.value)
      ? result.value
      : null;
  }

  function nextCreationSlot(): ProtectedBackgroundMemoryOutputSlot | null {
    return input.outputSlots.find((slot) =>
      slot.expectedContentRevision === 0
      && slot.action === "create"
      && slot.nextContentRevision === 1
      && !staged.has(slot.publicationIdempotencyId)
    ) ?? null;
  }

  function replacementSlot(
    memoryId: string,
    currentRevision: number,
  ): ProtectedBackgroundMemoryOutputSlot | null {
    return input.outputSlots.find((slot) =>
      slot.memoryId === memoryId
      && slot.action === "replace"
      && slot.expectedContentRevision === currentRevision
      && slot.nextContentRevision === currentRevision + 1
      && !staged.has(slot.publicationIdempotencyId)
    ) ?? null;
  }

  async function stage(inputValue: Readonly<{
    slot: ProtectedBackgroundMemoryOutputSlot;
    type: string;
    content: string;
    importance: number;
  }>): Promise<boolean> {
    if (stagedMemoryIds.has(inputValue.slot.memoryId)) return false;
    const embedding = await embed("memory.content_embedding", inputValue.content);
    if (embedding === null) return false;
    staged.set(inputValue.slot.publicationIdempotencyId, Object.freeze({
      kind: "content_revision" as const,
      publicationIdempotencyId:
        inputValue.slot.publicationIdempotencyId,
      memoryId: inputValue.slot.memoryId,
      payload: Object.freeze({
        formatVersion: 1,
        type: inputValue.type,
        content: inputValue.content,
      }),
      embedding,
      importance: inputValue.importance,
    }));
    stagedMemoryIds.add(inputValue.slot.memoryId);
    return true;
  }

  const repository: ProtectedAgentMemoryRepository = Object.freeze({
    async search(
      request: Parameters<ProtectedAgentMemoryRepository["search"]>[0],
    ) {
      if (
        !exactAuthority(request.authority, input.authority)
        || request.mode !== "vector"
      ) return unavailable<readonly ProtectedMemoryOpenedItem[]>(
        "authorization_required",
      );
      if (
        !Number.isSafeInteger(request.limit)
        || request.limit < 1
        || request.limit > MAX_SEARCH_LIMIT
      ) return unavailable<readonly ProtectedMemoryOpenedItem[]>(
        "incomplete_access_set",
      );
      const query = await embed("memory.query_embedding", request.query);
      if (query === null) {
        return unavailable<readonly ProtectedMemoryOpenedItem[]>(
          "embedding_unavailable",
        );
      }
      const opened: ProtectedMemoryOpenedItem[] = [];
      for (const memory of memoryInputs) {
        if (memory.productKind !== "memory") continue;
        const facts = metadata.get(memory.productId)!;
        if (!request.includeArchive && facts.tier === 3) continue;
        opened.push(Object.freeze({
          id: memory.productId,
          type: memory.payload.type,
          content: memory.payload.content,
          importance: facts.importance,
          tier: facts.tier,
          score: cosine(query.vector, facts.embedding.vector),
          createdAt: new Date(facts.createdAt),
        }));
      }
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze(opened.sort((left, right) =>
          right.score - left.score || left.id.localeCompare(right.id)
        ).slice(0, request.limit)),
      });
    },

    async save(
      request: Parameters<ProtectedAgentMemoryRepository["save"]>[0],
    ) {
      if (!exactAuthority(request.authority, input.authority)) {
        return unavailable<Readonly<{
          id: string;
          action: "created" | "updated";
          similarity?: number;
        }>>("authorization_required");
      }
      const slot = nextCreationSlot();
      if (slot === null) {
        return unavailable<Readonly<{
          id: string;
          action: "created" | "updated";
          similarity?: number;
        }>>("incomplete_access_set");
      }
      const importance = request.importance ?? 0.5;
      if (
        !Number.isFinite(importance)
        || importance < 0
        || importance > 1
        || !await stage({
          slot,
          type: request.type,
          content: request.content,
          importance,
        })
      ) {
        return unavailable<Readonly<{
          id: string;
          action: "created" | "updated";
          similarity?: number;
        }>>("embedding_unavailable");
      }
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({ id: slot.memoryId, action: "created" as const }),
      });
    },

    async replace(
      request: Parameters<ProtectedAgentMemoryRepository["replace"]>[0],
    ) {
      if (!exactAuthority(request.authority, input.authority)) {
        return unavailable<void>("authorization_required");
      }
      const current = memoryInputs.find((entry) =>
        entry.productKind === "memory" && entry.productId === request.memoryId
      );
      if (current === undefined || current.productKind !== "memory") {
        return unavailable<void>("stale_revision");
      }
      if (
        input.authority.mode === "scope"
        && current.accessKind !== "scope_origin"
      ) return unavailable<void>("authorization_required");
      const slot = replacementSlot(
        current.productId,
        current.productRevision,
      );
      if (slot === null) return unavailable<void>("incomplete_access_set");
      const facts = metadata.get(current.productId)!;
      if (!await stage({
        slot,
        type: current.payload.type,
        content: request.content,
        importance: facts.importance,
      })) return unavailable<void>("embedding_unavailable");
      return Object.freeze({ status: "success" as const, value: undefined });
    },

    setTier(
      request: Parameters<ProtectedAgentMemoryRepository["setTier"]>[0],
    ) {
      if (!exactAuthority(request.authority, input.authority)) {
        return Promise.resolve(unavailable<void>("authorization_required"));
      }
      const current = memoryInputs.find((entry) =>
        entry.productKind === "memory" && entry.productId === request.memoryId
      );
      if (
        current === undefined
        || current.productKind !== "memory"
        || stagedMemoryIds.has(request.memoryId)
        || (input.authority.mode === "scope"
          && current.accessKind !== "scope_origin")
      ) return Promise.resolve(unavailable<void>("authorization_required"));
      const slot = input.tierSlots.find((entry) =>
        entry.memoryId === request.memoryId
        && entry.contentRevision === current.productRevision
        && entry.cryptoAccessRevision === current.cryptoAccessRevision
        && entry.action === request.action
      );
      if (slot === undefined) {
        return Promise.resolve(unavailable<void>("incomplete_access_set"));
      }
      staged.set(slot.operationIdempotencyId, Object.freeze({
        kind: "tier_transition" as const,
        operationIdempotencyId: slot.operationIdempotencyId,
        memoryId: slot.memoryId,
        action: slot.action,
      }));
      stagedMemoryIds.add(slot.memoryId);
      return Promise.resolve(Object.freeze({
        status: "success" as const,
        value: undefined,
      }));
    },
  });

  return Object.freeze({
    repository,
    outputs: () => Object.freeze([
      ...input.outputSlots.map((slot) => slot.publicationIdempotencyId),
      ...input.tierSlots.map((slot) => slot.operationIdempotencyId),
    ].flatMap((operationId) => {
      const value = staged.get(operationId);
      return value === undefined ? [] : [value];
    })),
  });
}
