import { describe, expect, test } from "bun:test";

import {
  MemoryMutationAuthorityError,
  type ForegroundMemoryOrdinaryFallbackInput,
} from "@nautilo/agent";
import type {
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";

import {
  createProtectedTaskMemoryOrdinaryFallback,
} from "../../src/routes/protected-task-memory-ordinary-fallback";

const USER = "10000000-0000-4000-8000-000000000001";
const AGENT = "10000000-0000-4000-8000-000000000002";
const MEMORY = "20000000-0000-4000-8000-000000000001";
const NAMESPACE = "30000000-0000-4000-8000-000000000001";
const OTHER_NAMESPACE = "30000000-0000-4000-8000-000000000002";
const SCOPE = "40000000-0000-4000-8000-000000000001";

const namespaceAuthority: ProtectedMemoryAuthority = Object.freeze({
  mode: "namespace",
  subjectUserId: USER,
  agentId: AGENT,
  readableNamespaceIds: Object.freeze([NAMESPACE]),
  mutableNamespaceIds: Object.freeze([NAMESPACE]),
  writableNamespaceId: NAMESPACE,
});

const scopeAuthority: ProtectedMemoryAuthority = Object.freeze({
  mode: "scope",
  subjectUserId: USER,
  agentId: AGENT,
  scopeId: SCOPE,
  originWritableNamespaceId: NAMESPACE,
});

function request(authority: ProtectedMemoryAuthority) {
  return {
    authority,
    plan: {
      operationId: "memory.operation.1",
      memoryId: MEMORY,
      contentRevision: 1,
      expectedPriorAccessRevision: 0,
      requiredNamespaceIds: [NAMESPACE],
      reservationDigest: new Uint8Array(32).fill(2),
      cryptoObjectId: "urn:nautilo:memory:reserved",
      action: "created",
      importance: 0.8,
    },
    embedding: {
      vector: new Array<number>(1536).fill(0.2),
      provider: "openai",
      canonicalModel: "text-embedding-3-small",
      dimensions: 1536,
      contractVersion: 1,
    },
    content: {
      kind: "complete",
      payload: { version: 1, type: "fact", content: "ordinary body" },
    },
    reason: "encryption_pending",
  } as const;
}

function fixture(
  commitResult: Error | Readonly<{
    id: string;
    action: "created" | "updated";
  }> = { id: MEMORY, action: "created" },
) {
  const events: string[] = [];
  let mutation: ForegroundMemoryOrdinaryFallbackInput | null = null;
  const fallback = createProtectedTaskMemoryOrdinaryFallback({
    current: {} as never,
    policy: {
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 7,
    },
    agentId: AGENT,
  }, {
    withCurrent: async (_current, authority, use) => {
      expect(authority.agentId).toBe(AGENT);
      events.push("owner");
      return use({} as never);
    },
    commit: async (_transaction, input) => {
      events.push("mutation");
      mutation = input;
      if (commitResult instanceof Error) throw commitResult;
      return commitResult;
    },
  });
  return { fallback, events, mutation: () => mutation };
}

describe("protected Task ordinary Memory fallback", () => {
  test("publishes a Namespace creation through the held Task owner", async () => {
    const value = fixture();
    expect(await value.fallback(request(namespaceAuthority) as never))
      .toEqual({
        status: "success",
        value: { id: MEMORY, action: "created" },
        fallbackReason: "encryption_pending",
      });
    expect(value.events).toEqual(["owner", "mutation"]);
    expect(value.mutation()).toMatchObject({
      agentId: AGENT,
      memoryId: MEMORY,
      namespaceId: NAMESPACE,
      expectedNamespaceIds: [NAMESPACE],
      expectedDedupId: null,
      action: "save",
      content: "ordinary body",
    });
    expect(value.mutation()?.scope).toBeUndefined();
  });

  test("publishes a Scope creation with its exact origin coordinates", async () => {
    const value = fixture();
    expect((await value.fallback(request(scopeAuthority) as never)).status)
      .toBe("success");
    expect(value.mutation()).toMatchObject({
      scope: {
        subjectUserId: USER,
        scopeId: SCOPE,
        originWritableNamespaceId: NAMESPACE,
      },
    });
    expect(value.mutation()?.namespaceId).toBeUndefined();
  });

  test("carries the complete reserved audience for a Wide update", async () => {
    const value = fixture({ id: MEMORY, action: "updated" });
    const authority: ProtectedMemoryAuthority = Object.freeze({
      mode: "namespace",
      subjectUserId: USER,
      agentId: AGENT,
      readableNamespaceIds: Object.freeze([NAMESPACE, OTHER_NAMESPACE]),
      mutableNamespaceIds: Object.freeze([NAMESPACE, OTHER_NAMESPACE]),
      writableNamespaceId: null,
    });
    const wide = request(authority);
    expect((await value.fallback({
      ...wide,
      plan: {
        ...wide.plan,
        action: "updated",
        contentRevision: 2,
        requiredNamespaceIds: [NAMESPACE, OTHER_NAMESPACE],
      },
    } as never)).status).toBe("success");
    expect(value.mutation()).toMatchObject({
      expectedDedupId: MEMORY,
      expectedNamespaceIds: [NAMESPACE, OTHER_NAMESPACE],
    });
    expect(value.mutation()?.namespaceId).toBeUndefined();
  });

  test("rejects incomplete audience authority and maps a stale atomic commit", async () => {
    const denied = fixture();
    const incomplete = request({
      ...namespaceAuthority,
      mutableNamespaceIds: [OTHER_NAMESPACE],
    });
    expect(await denied.fallback(incomplete as never)).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(denied.events).toEqual([]);

    const widenedScope = fixture();
    const scopeRequest = request(scopeAuthority);
    expect(await widenedScope.fallback({
      ...scopeRequest,
      plan: {
        ...scopeRequest.plan,
        requiredNamespaceIds: [NAMESPACE, OTHER_NAMESPACE],
      },
    } as never)).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(widenedScope.events).toEqual([]);

    const stale = fixture(new MemoryMutationAuthorityError("source_changed"));
    expect(await stale.fallback(request(scopeAuthority) as never)).toEqual({
      status: "unavailable",
      reason: "stale_revision",
    });
    expect(stale.events).toEqual(["owner", "mutation"]);
  });

  test("maps unavailable current Task authority without running the mutation", async () => {
    const events: string[] = [];
    const fallback = createProtectedTaskMemoryOrdinaryFallback({
      current: {} as never,
      policy: {
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 7,
      },
      agentId: AGENT,
    }, {
      withCurrent: async () => {
        events.push("owner");
        return null;
      },
      commit: async () => {
        events.push("mutation");
        throw new Error("mutation must remain inside current authority");
      },
    });
    expect(await fallback(request(namespaceAuthority) as never)).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(events).toEqual(["owner"]);
  });

  test("does not construct fallback for Full or Strict publication", () => {
    const create = (
      mode: "shadow_encryption" | "encrypted_only",
      shadowBehavior: "fallback" | "strict",
    ) => createProtectedTaskMemoryOrdinaryFallback({
      current: {} as never,
      policy: { mode, shadowBehavior, revision: 7 },
      agentId: AGENT,
    }, {
      withCurrent: () => { throw new Error("owner must not be opened"); },
    });
    expect(() => create("encrypted_only", "fallback"))
      .toThrow("fallback is unavailable");
    expect(() => create("shadow_encryption", "strict"))
      .toThrow("fallback is unavailable");
  });
});
