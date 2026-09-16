import { describe, expect, mock, test } from "bun:test";
import { withHumanMemoryMutationEffects } from "../../src/routes/human-memory-mutation-effects";
import type { ProtectedMemoryRoutePorts, ProtectedMemoryRouteAuthority } from "../../src/routes/protected-memory-composition";

const authority: ProtectedMemoryRouteAuthority = {
  userId: "human", actorId: "human-actor", agentId: null, memoryMode: "namespace",
  readableNamespaceIds: ["namespace"], mutableNamespaceIds: ["namespace"],
  writableNamespaceIds: ["namespace"], scopeId: null, originWritableNamespaceId: null,
  sourceRoomId: "room",
};
const request = { authority, operationId: "archive:1", memoryId: "memory",
  expectedContentRevision: 2, expectedCryptoAccessRevision: 0, expectedTier: 1 as const };
const unavailable = async () => ({ dtoVersion: 1 as const, status: "unavailable" as const,
  reason: "authorization_required" as const });
function ports(): ProtectedMemoryRoutePorts {
  return {
    planCreate: unavailable, createPrepared: unavailable, updatePrepared: unavailable,
    list: unavailable, detail: unavailable, search: unavailable, brief: unavailable,
    transitionTier: unavailable, restore: unavailable, planAccess: unavailable, commitAccess: unavailable,
    archive: async (value) => ({ operation: "archive", operationId: value.operationId,
      memoryId: value.memoryId, response: { operationId: value.operationId,
        status: "archived", contentRevision: value.expectedContentRevision,
        cryptoAccessRevision: value.expectedCryptoAccessRevision,
        previousTier: value.expectedTier, nextTier: 3 } }),
  };
}

describe("Human Memory post-commit effects", () => {
  test("a committed ordinary fallback still delivers its semantic follow-up", async () => {
    const underlying = ports();
    underlying.commitAccess = async () => ({ dtoVersion: 1, status: "ordinary_fallback",
      operationId: "access:1", memoryId: request.memoryId, cryptoAccessRevision: 0,
      requiredNamespaceIds: [], reason: "target_encryption_not_ready" });
    const deliver = mock(async () => "pending" as const);
    const wake = mock(() => {});
    const wrapped = withHumanMemoryMutationEffects({ ports: underlying, deliver, wakeRecovery: wake });
    const result = await wrapped.commitAccess({ authority, memoryId: request.memoryId,
      prepared: { operationId: "access:1" } as Parameters<typeof wrapped.commitAccess>[0]["prepared"] });
    expect(result).toMatchObject({ status: "ordinary_fallback",
      reason: "target_encryption_not_ready", followUpPending: true });
    expect(deliver).toHaveBeenCalledWith({ authority, memoryId: request.memoryId, operationId: "access:1" });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("preserves the approved embedding disclosure descriptor", () => {
    const embeddingConfiguration = { provider: "openai" as const,
      model: "text-embedding-3-small", dimensions: 1536 as const };
    const wrapped = withHumanMemoryMutationEffects({
      ports: { ...ports(), embeddingConfiguration },
      deliver: async () => "pending", wakeRecovery: () => {},
    });
    expect(wrapped.embeddingConfiguration).toEqual(embeddingConfiguration);
  });

  test("returns the successful exact receipt even if notification or its wake fails", async () => {
    const underlying = ports();
    const publish = mock(underlying.archive);
    underlying.archive = publish;
    const deliver = mock(async () => { throw new Error("connection lost after commit"); });
    const wake = mock(() => { throw new Error("wake failed"); });
    const wrapped = withHumanMemoryMutationEffects({ ports: underlying, deliver, wakeRecovery: wake });
    const result = await wrapped.archive(request);
    expect(result).toMatchObject({ operationId: request.operationId,
      response: { status: "archived" }, followUpPending: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(request);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("replays reconcile the effect without changing the original mutation outcome", async () => {
    const underlying = ports();
    const original = await underlying.archive(request);
    if ("dtoVersion" in original) throw new Error("Expected successful fixture");
    underlying.archive = async () => ({ ...original,
      response: { ...original.response, status: "replayed" } });
    const deliver = mock(async () => "acknowledged" as const);
    const wake = mock(() => {});
    const result = await withHumanMemoryMutationEffects({ ports: underlying, deliver,
      wakeRecovery: wake }).archive(request);
    expect(result).toMatchObject({ response: { status: "replayed" } });
    expect(result).not.toHaveProperty("followUpPending");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();
  });

  test("unavailable mutation and reads do not attempt delivery", async () => {
    const underlying = ports();
    underlying.archive = unavailable;
    const deliver = mock(async () => "pending" as const);
    const wake = mock(() => {});
    const wrapped = withHumanMemoryMutationEffects({ ports: underlying, deliver, wakeRecovery: wake });
    expect(await wrapped.archive(request)).toMatchObject({ reason: "authorization_required" });
    await wrapped.detail({ authority, memoryId: request.memoryId, canManageMemories: true });
    expect(deliver).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });
});
