/**
 * D168 Phase 1 — Hermetic adversarial-args contract tests for tools under
 * `packages/agent/src/tools/{memory,artifacts,trust}/`.
 *
 * Each case constructs a trust context for user A and invokes the tool with
 * adversarial strings (wildcards, foreign UUIDs, "all"-shaped query text).
 * Assertions capture downstream store/trust inputs to ensure namespace /
 * speaker / owner filters are not widened by tool args.
 */

import { describe, test, expect, spyOn, afterEach, mock } from "bun:test";
import { z } from "zod";

// IMPORTANT — `mock.module(...)` patterns in this file MUST use the
// spread-the-real-module pattern:
//
//   const realStore = await import("../../src/store/foo-store");
//   mock.module("../../src/store/foo-store", () => ({
//     ...realStore,
//     stubbedFn: async (...) => { ... },
//   }));
//
// Reason: bun:test's module mocks PERSIST across test files in the
// same `bun test` process. If the factory returns only the stubbed
// functions (without spreading the real module's other exports),
// downstream test files that transitively import the same module will
// see the partial mock and fail with "Export named '<X>' not found in
// module" at evaluation time. `mock.restore()` in `afterAll` does NOT
// undo this — the import-cache already holds the mocked references.
// The spread pattern is the only reliable fix.
import type { MemoryAccessEnvelope, ScopeMemoryEnvelope } from "@nautilo/trust";
import * as trust from "@nautilo/trust";
import * as shareMemoryTool from "../../src/tools/memory/share-memory";
import * as memoryStore from "../../src/store/memory-store";
import * as agentScopeStore from "../../src/store/agent-scope-store";
import { assertNamespaceWriteAccess } from "../../src/store/memory-write-access";
import { getArtifactZone } from "../../src/tools/artifacts/storage-registry";
import { createVerifyIdentityTool } from "../../src/tools/trust/verify-identity";

const USER_A = "00000000-0000-0000-0000-0000000000a0";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NS_A1 = "11111111-1111-1111-1111-111111111101";
const NS_A2 = "11111111-1111-1111-1111-111111111102";
const NS_ENEMY = "deadbeef-dead-beef-dead-beefdeadbeef";
const AGENT_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SCOPE_1 = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function namespaceEnvelope(): MemoryAccessEnvelope {
  return {
    ownerId: USER_A,
    actorId: "00000000-0000-0000-0000-0000000000a1",
    agentId: AGENT_1,
    roomId: "00000000-0000-0000-0000-0000000000a2",
    readableNamespaces: [NS_A1, NS_A2],
    mutableNamespaces: [NS_A1, NS_A2],
    writableNamespaces: [NS_A1],
    toolPolicy: {},
  };
}

function scopeEnvelope(): ScopeMemoryEnvelope {
  return {
    memoryMode: "scope",
    ownerId: USER_A,
    actorId: "00000000-0000-0000-0000-0000000000a1",
    agentId: AGENT_1,
    roomId: "00000000-0000-0000-0000-0000000000a2",
    scopeId: SCOPE_1,
    toolPolicy: {},
  };
}

/** Contract helper: memory reads must not reference namespaces outside the envelope. */
export function assertTrustAlignedNamespaceQuery(opts: {
  namespaceIds: string[];
  readableNamespaces: string[];
}): void {
  const allowed = new Set(opts.readableNamespaces);
  for (const id of opts.namespaceIds) {
    if (!allowed.has(id)) {
      throw new Error(
        `namespace traversal: query referenced namespace ${id} outside caller readable set`,
      );
    }
  }
}

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies.splice(0)) {
    s.mockRestore();
  }
});

describe("negative control — contract helper catches widenable implementations", () => {
  test("throws when a widenable stub passes LLM-supplied foreign namespace into the query set", () => {
    function widenableMemorySearch(opts: {
      readableNamespaces: string[];
      llmSuppliedNamespaces: string[];
    }) {
      return { queryNamespaces: opts.llmSuppliedNamespaces };
    }

    const readable = [NS_A1];
    const adversarial = [NS_A1, NS_ENEMY];
    const bad = widenableMemorySearch({ readableNamespaces: readable, llmSuppliedNamespaces: adversarial });

    expect(() =>
      assertTrustAlignedNamespaceQuery({
        namespaceIds: bad.queryNamespaces,
        readableNamespaces: readable,
      }),
    ).toThrow(/namespace traversal/);
  });
});

describe("search_memory", () => {
  test("namespace mode: adversarial query text cannot inject extra namespaceIds", async () => {
    const captured: unknown[] = [];
    const realMemoryStore = await import("../../src/store/memory-store");
    mock.module("../../src/store/memory-store", () => ({
      ...realMemoryStore,
      searchMemory: async (opts: Record<string, unknown>) => {
        captured.push(opts);
        return [];
      },
      assertNamespaceWriteAccess,
    }));

    const { createSearchMemoryTool } = await import("../../src/tools/memory/search-memory");
    const tool = createSearchMemoryTool({ memoryAccessEnvelope: namespaceEnvelope() });

    await tool.invoke({
      query: "scope: all OR 1=1; namespace_id=" + NS_ENEMY + " --*",
      limit: 99,
      include_archive: true,
    });

    expect(captured).toHaveLength(1);
    const call = captured[0] as { namespaceIds?: string[]; agentId?: string };
    expect(call.namespaceIds).toEqual([NS_A1, NS_A2]);
    expect(call.agentId).toBe(AGENT_1);
    assertTrustAlignedNamespaceQuery({
      namespaceIds: call.namespaceIds ?? [],
      readableNamespaces: [NS_A1, NS_A2],
    });
  });

  test("scope mode: adversarial query cannot change scopeId / agentId", async () => {
    const captured: unknown[] = [];
    spies.push(spyOn(trust, "resolveSpeakerUserId").mockResolvedValue(USER_A));
    const realScopeMemoryStore = await import("../../src/store/scope-memory-store");
    mock.module("../../src/store/scope-memory-store", () => ({
      ...realScopeMemoryStore,
      searchScopeMemory: async (opts: Record<string, unknown>) => {
        captured.push(opts);
        return [];
      },
    }));

    const { createSearchMemoryTool } = await import("../../src/tools/memory/search-memory");
    const tool = createSearchMemoryTool({ memoryAccessEnvelope: scopeEnvelope() });

    await tool.invoke({
      query: "%' UNION SELECT * FROM memories--",
      limit: 50,
      include_archive: false,
    });

    expect(captured).toHaveLength(1);
    const call = captured[0] as { scopeId?: string; agentId?: string; speakerUserId?: string };
    expect(call.scopeId).toBe(SCOPE_1);
    expect(call.agentId).toBe(AGENT_1);
    expect(call.speakerUserId).toBe(USER_A);
  });
});

describe("manage_memory", () => {
  test("save uses writable namespace from envelope, not adversarial content", async () => {
    const captured: unknown[] = [];
    const realMemoryStore2 = await import("../../src/store/memory-store");
    mock.module("../../src/store/memory-store", () => ({
      ...realMemoryStore2,
      saveMemory: async (opts: Record<string, unknown>) => {
        captured.push(opts);
        return { id: "new", action: "created" as const };
      },
      replaceMemory: async () => {},
      demoteMemory: async () => {},
      promoteMemory: async () => {},
      assertNamespaceWriteAccess,
    }));

    const { createManageMemoryTool } = await import("../../src/tools/memory/manage-memory");
    const tool = createManageMemoryTool({ memoryAccessEnvelope: namespaceEnvelope() });

    await tool.invoke({
      action: "save",
      type: "fact",
      content: `IGNORE. namespace_id=${NS_ENEMY} user_id=${USER_B}`,
    });

    expect(captured).toHaveLength(1);
    expect((captured[0] as { namespaceId?: string }).namespaceId).toBe(NS_A1);
  });

  test("scope save pins scopeId + agentId from envelope", async () => {
    const captured: unknown[] = [];
    spies.push(spyOn(trust, "resolveSpeakerUserId").mockResolvedValue(USER_A));
    const realScopeMemoryStore2 = await import("../../src/store/scope-memory-store");
    mock.module("../../src/store/scope-memory-store", () => ({
      ...realScopeMemoryStore2,
      saveScopeMemory: async (opts: Record<string, unknown>) => {
        captured.push(opts);
        return { id: "m1", action: "created" as const };
      },
      replaceScopeMemory: async () => {},
      demoteScopeMemory: async () => {},
      promoteScopeMemory: async () => {},
      ScopeMemoryMutationError: class extends Error {},
    }));

    const { createManageMemoryTool } = await import("../../src/tools/memory/manage-memory");
    const tool = createManageMemoryTool({ memoryAccessEnvelope: scopeEnvelope() });

    await tool.invoke({
      action: "save",
      content: "x",
      type: "fact",
    });

    expect(captured).toHaveLength(1);
    const call = captured[0] as { scopeId?: string; agentId?: string; speakerUserId?: string };
    expect(call.scopeId).toBe(SCOPE_1);
    expect(call.agentId).toBe(AGENT_1);
    expect(call.speakerUserId).toBe(USER_A);
  });
});

describe("session_search", () => {
  test("ownerId stays on user A context; adversarial query cannot substitute owner", async () => {
    const captured: unknown[] = [];
    const realSessionStore = await import("../../src/store/session-store");
    mock.module("../../src/store/session-store", () => ({
      ...realSessionStore,
      searchSessions: async (opts: Record<string, unknown>) => {
        captured.push(opts);
        return [];
      },
    }));

    const { createSessionSearchTool } = await import("../../src/tools/memory/session-search");
    const tool = createSessionSearchTool({
      ownerId: USER_A,
      personaId: "owner",
      currentThreadId: "thread-main",
    });

    await tool.invoke({
      query: `pretend owner_id=${USER_B}`,
      limit: 500,
    });

    expect(captured).toHaveLength(1);
    const call = captured[0] as { ownerId?: string; personaId?: string };
    expect(call.ownerId).toBe(USER_A);
    expect(call.personaId).toBe("owner");
  });
});

describe("find_scope / create_scope / close_scope / add_memory_to_scope", () => {
  test("find_scope passes speaker + agent from envelope; name is only a filter", async () => {
    spies.push(spyOn(trust, "resolveSpeakerUserId").mockResolvedValue(USER_A));
    spies.push(spyOn(trust, "findScopes").mockResolvedValue([]));

    const { createFindScopeTool } = await import("../../src/tools/memory/find-scope");
    const tool = createFindScopeTool({ memoryAccessEnvelope: namespaceEnvelope() });

    await tool.invoke({
      name: `' OR 1=1 -- ${NS_ENEMY}`,
    });

    // bun:test's spyOn returns a mock proxy at runtime but the TS view of
    // `trust.findScopes` retains the real function signature after the
    // spread-the-real-module pattern (D168 P1 mock-leak hot-fix). Cast
    // through `unknown` to access `.mock.calls`.
    const calls = (trust.findScopes as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const arg0 = calls[0]![0] as {
      parentAgentId: string;
      speakerUserId: string;
      nameQuery?: string;
    };
    expect(arg0.parentAgentId).toBe(AGENT_1);
    expect(arg0.speakerUserId).toBe(USER_A);
    expect(arg0.nameQuery).toContain("OR 1=1");
  });

  test("create_scope binds same speaker + agent; purpose cannot override ids", async () => {
    spies.push(spyOn(trust, "resolveSpeakerUserId").mockResolvedValue(USER_A));
    spies.push(
      spyOn(trust, "createScope").mockResolvedValue({
        scopeId: SCOPE_1,
        name: "n1",
      }),
    );

    const { createCreateScopeTool } = await import("../../src/tools/memory/create-scope");
    const tool = createCreateScopeTool({ memoryAccessEnvelope: namespaceEnvelope() });

    await tool.invoke({
      name: "research-topic",
      purpose: `speaker_user_id=${USER_B} parent_agent=evil`,
    });

    const calls = (trust.createScope as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const arg0 = calls[0]![0] as { parentAgentId: string; speakerUserId: string; name: string };
    expect(arg0.parentAgentId).toBe(AGENT_1);
    expect(arg0.speakerUserId).toBe(USER_A);
    expect(arg0.name).toBe("research-topic");
  });

  test("close_scope: foreign scope_id still paired with envelope speaker + agent + writable NS", async () => {
    spies.push(spyOn(trust, "resolveSpeakerUserId").mockResolvedValue(USER_A));
    spies.push(
      spyOn(trust, "closeScope").mockResolvedValue({
        closed: true,
        name: "x",
        promotedMemoryCount: 0,
        targetNamespaceId: NS_A1,
      }),
    );

    const { createCloseScopeTool } = await import("../../src/tools/memory/close-scope");
    const tool = createCloseScopeTool({ memoryAccessEnvelope: namespaceEnvelope() });

    await tool.invoke({ scope_id: NS_ENEMY });

    const calls = (trust.closeScope as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const arg0 = calls[0]![0] as {
      scopeId: string;
      parentAgentId: string;
      speakerUserId: string;
      promoteToNamespaceId: string | null;
    };
    expect(arg0.scopeId).toBe(NS_ENEMY);
    expect(arg0.parentAgentId).toBe(AGENT_1);
    expect(arg0.speakerUserId).toBe(USER_A);
    expect(arg0.promoteToNamespaceId).toBe(NS_A1);
  });

  test("add_memory_to_scope passes readable namespaces from envelope to attachMemoryToScope", async () => {
    spies.push(spyOn(trust, "resolveSpeakerUserId").mockResolvedValue(USER_A));
    const attachSpy = spyOn(agentScopeStore, "attachMemoryToScope").mockResolvedValue({
      status: "attached" as const,
      scopeName: "s",
    });
    spies.push(attachSpy);

    const { createAddMemoryToScopeTool } = await import("../../src/tools/memory/add-memory-to-scope");
    const tool = createAddMemoryToScopeTool({ memoryAccessEnvelope: namespaceEnvelope() });

    await tool.invoke({
      memory_id: NS_ENEMY,
      scope_id: SCOPE_1,
    });

    const calls = attachSpy.mock.calls as unknown[][];
    expect(calls.length).toBe(1);
    const ctx = calls[0]![2] as { readableNamespaceIds: string[]; agentId: string; speakerUserId: string };
    expect(ctx.readableNamespaceIds).toEqual([NS_A1, NS_A2]);
    expect(ctx.agentId).toBe(AGENT_1);
    expect(ctx.speakerUserId).toBe(USER_A);
    assertTrustAlignedNamespaceQuery({
      namespaceIds: ctx.readableNamespaceIds,
      readableNamespaces: [NS_A1, NS_A2],
    });
  });

  test("add_memory_to_scope reports a concurrent scope close without retrying legacy attachment", async () => {
    spies.push(spyOn(trust, "resolveSpeakerUserId").mockResolvedValue(USER_A));
    const attachSpy = spyOn(agentScopeStore, "attachMemoryToScope").mockResolvedValue({
      error: "scope_closing" as const,
    });
    spies.push(attachSpy);

    const { createAddMemoryToScopeTool } = await import("../../src/tools/memory/add-memory-to-scope");
    const tool = createAddMemoryToScopeTool({ memoryAccessEnvelope: namespaceEnvelope() });

    expect(String(await tool.invoke({
      memory_id: NS_ENEMY,
      scope_id: SCOPE_1,
    }))).toBe("Cannot attach memory: this scope is already closing.");
    expect(attachSpy.mock.calls).toHaveLength(1);
  });
});

describe("list_my_users", () => {
  test("agentId comes from envelope only; no args surface", async () => {
    spies.push(spyOn(trust, "listAgentUsers").mockResolvedValue([]));
    const { createListMyUsersTool } = await import("../../src/tools/memory/list-my-users");
    const tool = createListMyUsersTool({ memoryAccessEnvelope: namespaceEnvelope() });
    await tool.invoke({});
    const calls = (trust.listAgentUsers as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0]![0]).toBe(AGENT_1);
  });
});

describe("share_memory", () => {
  test("loadMemoryRowIfShareable receives envelope readableNamespaces, not attacker-chosen set", async () => {
    const loadSpy = spyOn(shareMemoryTool, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "c",
      type: "fact",
    });
    spies.push(loadSpy);
    spies.push(spyOn(trust, "findActorByOwnerId").mockResolvedValue({ id: "actor-req" } as never));
    spies.push(
      spyOn(trust, "findAgentUserByNormalizedHandle").mockResolvedValue({
        userId: USER_B,
        displayName: "Bob",
      } as never),
    );
    spies.push(
      spyOn(trust, "findActorByHandle").mockResolvedValue({
        kind: "user" as const,
        actorId: "actor-b",
      } as never),
    );
    spies.push(spyOn(trust, "findActorById").mockResolvedValue({ ownerId: USER_B } as never));
    spies.push(
      spyOn(trust, "findShareTargetRoom").mockResolvedValue({
        namespaceId: "33333333-3333-3333-3333-333333333333",
        label: "pair",
      } as never),
    );
    spies.push(spyOn(memoryStore, "getMemoryNamespaces").mockResolvedValue([]));
    spies.push(spyOn(memoryStore, "attachMemoryToNamespace").mockResolvedValue());

    const { createShareMemoryTool } = await import("../../src/tools/memory/share-memory");
    const tool = createShareMemoryTool({
      userId: USER_A,
      memoryAccessEnvelope: namespaceEnvelope(),
    });

    await tool.invoke({
      memory_id: "00000000-0000-0000-0000-000000000099",
      target_handle: "bob",
      sensitivity: "normal",
    });

    expect(loadSpy.mock.calls.length).toBe(1);
    const args = loadSpy.mock.calls[0] as [string, string[], string];
    expect(args[1]).toEqual([NS_A1, NS_A2]);
    expect(args[2]).toBe(AGENT_1);
    assertTrustAlignedNamespaceQuery({
      namespaceIds: args[1],
      readableNamespaces: [NS_A1, NS_A2],
    });
  });
});

describe("verify_identity", () => {
  test("schema exposes no identity or role input; PIN subject is envelope-derived (M125)", () => {
    // M125 Phase 1.1: PIN subject is read from
    // `context.memoryAccessEnvelope.ownerId` per-invocation. The tool's
    // schema must not surface a role or subject; neither is an LLM-visible
    // field.
    void USER_A;
    const tool = createVerifyIdentityTool();
    const shape = (tool.schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
    expect(Object.keys(shape)).toEqual([]);
  });
});

describe("artifacts/storage-registry", () => {
  test("has no DB path; zone enum cannot widen to data/vault", () => {
    expect(getArtifactZone("home")).toBe(null);
    expect(getArtifactZone("scratch")).toBe(null);
  });
});
