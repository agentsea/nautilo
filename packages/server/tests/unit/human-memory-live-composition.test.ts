import { describe, expect, mock, test } from "bun:test";
import type { LiveShadowEncryptionTransitionPolicy } from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { createProductionHumanMemoryRouteFactory } from "../../src/routes/human-memory-live-composition";
import type { ProtectedMemoryRouteAuthority, ProtectedMemoryRoutePorts } from "../../src/routes/protected-memory-composition";

const envelope: MemoryAccessEnvelope = {
  ownerId: "user", actorId: "actor", agentId: "context-agent", roomId: "room",
  readableNamespaces: ["a"], mutableNamespaces: ["a"], writableNamespaces: ["a"], toolPolicy: {},
};
const authority: ProtectedMemoryRouteAuthority = {
  userId: "user", actorId: "actor", agentId: null, memoryMode: "namespace",
  readableNamespaceIds: ["a"], mutableNamespaceIds: ["a"], writableNamespaceIds: ["a"],
  sourceRoomId: "room", scopeId: null, originWritableNamespaceId: null,
};
function policy(mode: LiveShadowEncryptionTransitionPolicy["mode"], revision = 1): LiveShadowEncryptionTransitionPolicy {
  return { mode, revision, shadowBehavior: "strict", shadowEncryptionStartedAt: null,
    updatedAt: new Date("2026-09-07T00:00:00Z") };
}
function ports(): ProtectedMemoryRoutePorts {
  const unavailable = async () => ({ dtoVersion: 1 as const, status: "unavailable" as const,
    reason: "authorization_required" as const });
  return { planCreate: unavailable, createPrepared: unavailable, list: unavailable,
    detail: unavailable, search: unavailable, brief: unavailable, updatePrepared: unavailable,
    archive: unavailable, restore: unavailable, transitionTier: unavailable,
    planAccess: unavailable, commitAccess: unavailable };
}

describe("live Human Memory request composition", () => {
  test("only an editable Fallback Shadow detail advertises signed ordinary publication", async () => {
    for (const mode of ["encrypted_only", "shadow_encryption"] as const) {
      for (const shadowBehavior of ["strict", "fallback"] as const) {
        for (const canEdit of [true, false]) {
          const factory = createProductionHumanMemoryRouteFactory({
            loadPolicy: async () => ({ ...policy(mode, 7), shadowBehavior }),
            assemble: async () => ({ ...ports(), detail: async () => ({
              dtoVersion: 1 as const, memoryMode: "namespace" as const,
              actionAuthority: { canEdit, canArchive: canEdit, canManageAccess: canEdit },
              memory: { dtoVersion: 1 as const,
                projection: { memoryId: "memory", contentRevision: 1, cryptoAccessRevision: 0,
                  importance: 0.5, tier: 1, createdAt: "2026-09-07T00:00:00Z",
                  updatedAt: "2026-09-07T00:00:00Z", namespaceIds: ["a"],
                  requiredNamespaceIds: ["a"], readAuthorities: [] },
                protectedPayload: { status: "unavailable" as const,
                  reason: "encryption_pending" as const },
              },
            }) }), wakeRecovery: () => {},
          });
          const resolved = await factory(authority, envelope);
          const response = await resolved!.detail({ authority, memoryId: "memory", canManageMemories: true });
          const allowed = mode === "shadow_encryption" && shadowBehavior === "fallback" && canEdit;
          expect("ordinaryFallbackAuthorization" in response).toBe(allowed);
          if (allowed) expect(response).toMatchObject({ ordinaryFallbackAuthorization: { policyRevision: 7 } });
        }
      }
    }
  });

  test("plaintext avoids all crypto service assembly", async () => {
    const assemble = mock(async () => { throw new Error("Must not acquire crypto handles"); });
    const factory = createProductionHumanMemoryRouteFactory({ loadPolicy: async () => policy("plaintext_only"),
      assemble, wakeRecovery: () => {} });
    expect(await factory(authority, envelope)).toBeNull();
    expect(assemble).not.toHaveBeenCalled();
  });

  test("re-resolves policy and builds separate authority for every account request", async () => {
    let current = policy("encrypted_only");
    const assemble = mock(async (request: unknown) => { void request; return ports(); });
    const factory = createProductionHumanMemoryRouteFactory({ loadPolicy: async () => current,
      assemble, wakeRecovery: () => {} });
    const first = await factory(authority, envelope);
    current = { ...policy("shadow_encryption", 2), shadowBehavior: "fallback" };
    const second = await factory({ ...authority, userId: "other", actorId: "other-actor" },
      { ...envelope, ownerId: "other", actorId: "other-actor" });
    expect(first).not.toBe(second);
    expect(assemble).toHaveBeenCalledTimes(2);
    expect(assemble.mock.calls[0]?.[0]).toMatchObject({ policy: { mode: "encrypted_only", revision: 1 },
      authority: { userId: "user", agentId: null } });
    expect(assemble.mock.calls[1]?.[0]).toMatchObject({ policy: { mode: "shadow_encryption", revision: 2 },
      authority: { userId: "other", agentId: null } });
  });

  test("scope and missing authority do not acquire a fabricated Human or Agent grant", async () => {
    const assemble = mock(async () => ports());
    const factory = createProductionHumanMemoryRouteFactory({ loadPolicy: async () => policy("encrypted_only"),
      assemble, wakeRecovery: () => {} });
    expect(await factory(authority, null)).toBeNull();
    expect(await factory({ ...authority, memoryMode: "scope", scopeId: "scope" }, envelope)).toBeNull();
    expect(await factory({ ...authority, agentId: "context-agent" }, envelope)).toBeNull();
    expect(await factory({ ...authority, userId: "substituted" }, envelope)
      .catch((error: unknown) => error)).toBeInstanceOf(TypeError);
    expect(assemble).not.toHaveBeenCalled();
  });
});
