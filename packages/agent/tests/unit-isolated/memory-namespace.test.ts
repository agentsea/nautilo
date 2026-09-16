import { describe, test, expect, mock, beforeAll } from "bun:test";
import { assertNamespaceWriteAccess } from "../../src/store/memory-write-access";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { ToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";

// ---------------------------------------------------------------------------
// 1. Pure logic: assertNamespaceWriteAccess
// ---------------------------------------------------------------------------

describe("assertNamespaceWriteAccess", () => {
  test("allows when mutableNamespaceIds is undefined (backward compat)", () => {
    expect(() =>
      assertNamespaceWriteAccess(["ns-private"], undefined, "mem-1"),
    ).not.toThrow();
  });

  test("allows when mutableNamespaceIds is empty (backward compat)", () => {
    expect(() =>
      assertNamespaceWriteAccess(["ns-private"], [], "mem-1"),
    ).not.toThrow();
  });

  test("allows when memory namespaces overlap mutable set (including partial)", () => {
    expect(() =>
      assertNamespaceWriteAccess(
        ["ns-private", "ns-other"],
        ["ns-private", "ns-shared"],
        "mem-1",
      ),
    ).not.toThrow();
  });

  test("throws when non-empty mutable set has no overlap with memory namespaces", () => {
    expect(() =>
      assertNamespaceWriteAccess(["ns-private"], ["ns-shared"], "mem-1"),
    ).toThrow("namespace you cannot write to");
  });

  test("throws when memory has empty namespace set but mutable set is non-empty", () => {
    expect(() =>
      assertNamespaceWriteAccess([], ["ns-private"], "mem-1"),
    ).toThrow("no namespace attachments");
  });

  test("M082: memory only in NS_family is mutable when mutableNamespaces include NS_alone and NS_family", () => {
    expect(() =>
      assertNamespaceWriteAccess(
        ["ns-family"],
        ["ns-alone", "ns-family"],
        "mem-1",
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Tool context wiring: search_memory
// ---------------------------------------------------------------------------

describe("search_memory tool — envelope wiring", () => {
  test("passes readableNamespaces from envelope to searchMemory", async () => {
    const capturedArgs: Record<string, unknown>[] = [];

    mock.module("../../src/store/memory-store", () => ({
      searchMemory: async (opts: Record<string, unknown>) => {
        capturedArgs.push(opts);
        return [];
      },
      assertNamespaceWriteAccess,
    }));

    const { createSearchMemoryTool } = await import(
      "../../src/tools/memory/search-memory"
    );

    const envelope: MemoryAccessEnvelope = {
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-test",
      roomId: "",
      readableNamespaces: ["ns-a", "ns-b"],
      mutableNamespaces: ["ns-a", "ns-b"],
      writableNamespaces: ["ns-a"],
      toolPolicy: {},
    };

    const tool = createSearchMemoryTool({
      memoryAccessEnvelope: envelope,
    });

    await tool.invoke({ query: "test query" });

    expect(capturedArgs).toHaveLength(1);
    const call = capturedArgs[0]!;
    expect(call["namespaceIds"]).toEqual(["ns-a", "ns-b"]);
    expect(call["agentId"]).toBe("agent-test");
    expect(call["ownerId"]).toBeUndefined();
  });

  test("passes empty namespaceIds when no envelope", async () => {
    const capturedArgs: Record<string, unknown>[] = [];

    mock.module("../../src/store/memory-store", () => ({
      searchMemory: async (opts: Record<string, unknown>) => {
        capturedArgs.push(opts);
        return [];
      },
      assertNamespaceWriteAccess,
    }));

    const { createSearchMemoryTool } = await import(
      "../../src/tools/memory/search-memory"
    );

    const tool = createSearchMemoryTool({});

    await tool.invoke({ query: "test query" });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]!["namespaceIds"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Tool context wiring: manage_memory save
// ---------------------------------------------------------------------------

describe("manage_memory tool — envelope wiring", () => {
  test("passes first writableNamespace as namespaceId on save", async () => {
    const capturedArgs: Record<string, unknown>[] = [];

    mock.module("../../src/store/memory-store", () => ({
      saveMemory: async (opts: Record<string, unknown>) => {
        capturedArgs.push(opts);
        return { id: "new-mem", action: "created" };
      },
      replaceMemory: async () => {},
      demoteMemory: async () => {},
      promoteMemory: async () => {},
      assertNamespaceWriteAccess,
    }));

    const { createManageMemoryTool } = await import(
      "../../src/tools/memory/manage-memory"
    );

    const envelope: MemoryAccessEnvelope = {
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-test",
      roomId: "",
      readableNamespaces: ["ns-a", "ns-b"],
      mutableNamespaces: ["ns-a", "ns-b"],
      writableNamespaces: ["ns-a"],
      toolPolicy: {},
    };

    const tool = createManageMemoryTool({
      memoryAccessEnvelope: envelope,
    });

    await tool.invoke({ action: "save", content: "Test fact", type: "fact" });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]!["namespaceId"]).toBe("ns-a");
  });

  test("M125 Phase 2.7 — fails closed when no envelope (no silent bootstrap-owned write)", async () => {
    const capturedArgs: Record<string, unknown>[] = [];

    mock.module("../../src/store/memory-store", () => ({
      saveMemory: async (opts: Record<string, unknown>) => {
        capturedArgs.push(opts);
        return { id: "new-mem", action: "created" };
      },
      replaceMemory: async () => {},
      demoteMemory: async () => {},
      promoteMemory: async () => {},
      assertNamespaceWriteAccess,
    }));

    const { createManageMemoryTool } = await import(
      "../../src/tools/memory/manage-memory"
    );

    const tool = createManageMemoryTool({});

    const result = await tool.invoke({
      action: "save",
      content: "No envelope fact",
      type: "fact",
    });

    // Pre-M125 this silently borrowed `getBootstrapDefaultAgentId()` and
    // wrote a memory row into the first claimer's `agent_id` partition.
    // Post-M125 it must surface a tool error and not call `saveMemory`.
    expect(typeof result).toBe("string");
    expect(String(result)).toContain("manage_memory unavailable");
    expect(capturedArgs).toHaveLength(0);
  });

  test("passes mutableNamespaces to replaceMemory", async () => {
    let capturedMutable: string[] | undefined;

    mock.module("../../src/store/memory-store", () => ({
      saveMemory: async () => ({ id: "x", action: "created" as const }),
      replaceMemory: async (
        _id: string,
        _content: string,
        mutable?: string[],
      ) => {
        capturedMutable = mutable;
      },
      demoteMemory: async () => {},
      promoteMemory: async () => {},
      assertNamespaceWriteAccess,
    }));

    const { createManageMemoryTool } = await import(
      "../../src/tools/memory/manage-memory"
    );

    const envelope: MemoryAccessEnvelope = {
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-test",
      roomId: "",
      readableNamespaces: ["ns-a"],
      mutableNamespaces: ["ns-a"],
      writableNamespaces: ["ns-a"],
      toolPolicy: {},
    };

    const tool = createManageMemoryTool({
      memoryAccessEnvelope: envelope,
    });

    await tool.invoke({ action: "replace", memory_id: "mem-1", content: "updated" });

    expect(capturedMutable).toEqual(["ns-a"]);
  });

  test("passes mutableNamespaces to demoteMemory", async () => {
    let capturedMutable: string[] | undefined;

    mock.module("../../src/store/memory-store", () => ({
      saveMemory: async () => ({ id: "x", action: "created" as const }),
      replaceMemory: async () => {},
      demoteMemory: async (_id: string, mutable?: string[]) => {
        capturedMutable = mutable;
      },
      promoteMemory: async () => {},
      assertNamespaceWriteAccess,
    }));

    const { createManageMemoryTool } = await import(
      "../../src/tools/memory/manage-memory"
    );

    const envelope: MemoryAccessEnvelope = {
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-test",
      roomId: "",
      readableNamespaces: ["ns-a", "ns-b"],
      mutableNamespaces: ["ns-a", "ns-b"],
      writableNamespaces: ["ns-a"],
      toolPolicy: {},
    };

    const tool = createManageMemoryTool({
      memoryAccessEnvelope: envelope,
    });

    await tool.invoke({ action: "remove", memory_id: "mem-1" });

    expect(capturedMutable).toEqual(["ns-a", "ns-b"]);
  });
});

// ---------------------------------------------------------------------------
// 3b. M044 — writableNamespaces[0] stability across the Room-derived
//     rewrite. manage_memory's default save target is
//     writableNamespaces[0]; migration 0016 reuses the owner's pre-M044
//     `scope='private'` Namespace row IN PLACE as the private Room's
//     Namespace, so the UUID doesn't change. This test pins the
//     behavioral invariant: when a Room-derived envelope carries the
//     same namespace UUID as the pre-M044 private NS, saveMemory
//     receives that identical UUID and no pre-existing memory row
//     becomes unreachable.
// ---------------------------------------------------------------------------

describe("M044 — writableNamespaces[0] stability", () => {
  test("save routes to the Room's NS when envelope.writableNamespaces[0] = privateRoomNs (same UUID as pre-M044 private NS)", async () => {
    let capturedNamespaceId: string | undefined;
    mock.module("../../src/store/memory-store", () => ({
      saveMemory: async (opts: Record<string, unknown>) => {
        capturedNamespaceId = opts["namespaceId"] as string | undefined;
        return { id: "mem-new", action: "created" as const };
      },
      replaceMemory: async () => {},
      demoteMemory: async () => {},
      promoteMemory: async () => {},
      assertNamespaceWriteAccess,
    }));

    const { createManageMemoryTool } = await import(
      "../../src/tools/memory/manage-memory"
    );

    // The UUID here is the pre-M044 `scope='private'` NS, which
    // migration 0016 reuses in place as the Room's NS. A post-M044
    // envelope for the owner-in-private-Room path carries exactly
    // this same UUID as writableNamespaces[0].
    const PRIVATE_ROOM_NS = "11111111-1111-1111-1111-111111111111";

    const envelope: MemoryAccessEnvelope = {
      ownerId: "owner-1",
      actorId: "actor-owner",
      agentId: "agent-test",
      roomId: "room-private",
      readableNamespaces: [PRIVATE_ROOM_NS],
      mutableNamespaces: [PRIVATE_ROOM_NS],
      writableNamespaces: [PRIVATE_ROOM_NS],
      toolPolicy: {},
    };

    const tool = createManageMemoryTool({
      memoryAccessEnvelope: envelope,
    });

    await tool.invoke({ action: "save", content: "Stability test", type: "fact" });

    // The default save target is writableNamespaces[0] — under M044
    // that's the Room's NS. The test uses the pre-M044 private NS
    // UUID so this assertion doubles as the migration-stability pin:
    // if migration 0016 ever stops reusing the row in place, the
    // UUID changes here and existing memories become orphans.
    expect(capturedNamespaceId).toBe(PRIVATE_ROOM_NS);
  });
});

// ---------------------------------------------------------------------------
// 4. Catalog: tools are filtered by actor role and trust tier
// ---------------------------------------------------------------------------

describe("catalog — tool filtering", () => {
  let catalog: ToolCatalog;

  beforeAll(() => {
    catalog = new ToolCatalog();
    registerAllTools(catalog);
  });

  test("admin actor with all-allow policy gets all cloud tools", () => {
    const entries = catalog.query({});
    const allAllow: Record<string, string> = {};
    for (const e of entries) allAllow[e.name] = "allow";
    const tools = catalog.getToolsForActor({}, allAllow);
    expect(tools.length).toBeGreaterThan(10);
  });

  test("without toolPolicy tier does not gate cloud tools (M133)", () => {
    const tools = catalog.getToolsForActor({});
    const names = tools.map((t) => t.name);
    expect(names).toContain("discover_tools");
    expect(names).toContain("search_memory");
    // run_shell is relay-gated, not tier-gated
    expect(names).not.toContain("run_shell");
  });
});
