import { describe, expect, test } from "bun:test";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";

import { createWorkbenchMemoryReadOperations } from "./memory-read-operations";

function operations(
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only",
  calls: string[],
  custody = true,
) {
  const item = { id: "memory-1", type: "fact", content: "value", importance: 1,
    tier: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    namespaceIds: [] };
  const owner = bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({ policy: { mode, shadowBehavior: "fallback" }, revalidationToken: 1 }),
    revalidate: async () => {},
  } });
  return createWorkbenchMemoryReadOperations({ owner,
    ordinary: {
      list: async () => { calls.push("ordinary:list"); return { items: [item], nextCursor: null, memoryMode: "namespace" }; },
      detail: async () => { calls.push("ordinary:detail"); return { memory: { ...item, demotedAt: null, demotedFrom: null }, memoryMode: "namespace",
        accessContext: { roomId: "library-room", label: "Personal library" } }; },
      search: async () => { calls.push("ordinary:search"); return { results: [item] }; },
      brief: async () => { calls.push("ordinary:brief"); return { brief: "ordinary brief" }; },
      archive: async () => { calls.push("ordinary:archive"); },
    },
    protected: () => {
      calls.push("custody");
      if (!custody) return undefined;
      return {
        list: async () => { calls.push("protected:list"); return { items: [], nextCursor: null, memoryMode: "namespace" }; },
        detail: async () => { throw new Error("unused"); },
        search: async () => ({ items: [], memoryMode: "namespace", queryDisclosure: "embedding_provider" }),
        brief: async () => ({ brief: "protected brief", memoryMode: "namespace" }),
        update: async () => { throw new Error("unused"); }, archive: async () => {
          calls.push("protected:archive"); return { status: "archived", memoryId: "memory-1", tier: 3 };
        },
        restore: async () => { throw new Error("unused"); }, transitionTier: async () => { throw new Error("unused"); },
        deleteAuthorizedView: async () => { throw new Error("unused"); }, grantUser: async () => { throw new Error("unused"); },
        revokeUser: async () => { throw new Error("unused"); }, makePrivate: async () => { throw new Error("unused"); },
        retryPendingMutations: async () => {},
      };
    } });
}

describe("Workbench Memory read facade", () => {
  test("preserves the ordinary detail's server-authored access context", async () => {
    const calls: string[] = [];
    const detail = await operations("plaintext_only", calls).detail("memory-1");
    expect(detail.accessContext).toEqual({ roomId: "library-room", label: "Personal library" });
    expect(calls).toEqual(["ordinary:detail"]);
  });
  test("Plain list never instantiates protected custody", async () => {
    const calls: string[] = [];
    expect((await operations("plaintext_only", calls).list({})).items).toHaveLength(1);
    expect(calls).toEqual(["ordinary:list"]);
  });

  test("Full list never invokes the ordinary loader", async () => {
    const calls: string[] = [];
    await operations("encrypted_only", calls).list({});
    expect(calls).toEqual(["custody", "protected:list"]);
  });

  test("the same archive call stays policy-free and lazy", async () => {
    const plainCalls: string[] = [];
    await operations("plaintext_only", plainCalls).archive("memory-1");
    expect(plainCalls).toEqual(["ordinary:archive"]);

    const fullCalls: string[] = [];
    await operations("encrypted_only", fullCalls).archive("memory-1");
    expect(fullCalls).toEqual(["custody", "protected:archive"]);
  });

  test("Fallback read does not change subsequent protected action semantics", async () => {
    const calls: string[] = [];
    const detail = await operations("shadow_encryption", calls, false).detail("memory-1");
    expect(detail.memory.content).toBe("value");
    expect(detail.actions).toMatchObject({
      deletion: "authorized_view",
      canChangeTier: true,
      canEditContent: true,
    });
    expect(calls).toEqual(["custody", "ordinary:detail"]);
  });
});
