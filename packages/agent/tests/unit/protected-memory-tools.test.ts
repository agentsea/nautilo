import { afterEach, describe, expect, test } from "bun:test";
import {
  StrictShadowEnforcementError,
  type StrictShadowBoundaryDecision,
  type ProtectedAgentMemoryRepository,
  type ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import type {
  MemoryAccessEnvelope,
  NamespaceMemoryEnvelope,
} from "@nautilo/trust";
import { createManageMemoryTool } from "../../src/tools/memory/manage-memory";
import { createSearchMemoryTool } from "../../src/tools/memory/search-memory";
import {
  _resetAuthoredMemorySemanticChangeSinkForTests,
  installAuthoredMemorySemanticChangeSink,
  type AuthoredMemorySemanticChange,
} from "../../src/store/authored-memory-semantic-change";

function namespaceEnvelope(): NamespaceMemoryEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: "user-alice",
    actorId: "actor-alice",
    agentId: "agent-genie",
    roomId: "room-ab",
    readableNamespaces: ["namespace-ab", "namespace-abc"],
    mutableNamespaces: ["namespace-ab", "namespace-abc"],
    writableNamespaces: ["namespace-ab"],
    toolPolicy: {},
  };
}

function repository(overrides: Partial<ProtectedAgentMemoryRepository> = {}): ProtectedAgentMemoryRepository {
  return {
    search: async () => ({ status: "success", value: [] }),
    save: async () => ({ status: "success", value: { id: "memory-1", action: "created" } }),
    replace: async () => ({ status: "success", value: undefined }),
    setTier: async () => ({ status: "success", value: undefined }),
    ...overrides,
  };
}

describe("protected Memory Agent tool composition", () => {
  afterEach(() => {
    _resetAuthoredMemorySemanticChangeSinkForTests();
  });

  test("binds protected mutations to the stable tool-call operation id", async () => {
    const operationIds: string[] = [];
    const tool = createManageMemoryTool({
      memoryAccessEnvelope: namespaceEnvelope(),
      protectedMemoryRepository: repository({
        save: async (input) => {
          operationIds.push(input.operationId);
          return {
            status: "success",
            value: { id: "memory-1", action: "created" },
          };
        },
      }),
    });
    const config = {
      configurable: { memoryToolMutationRequestId: "tool-call-1" },
    };

    await tool.invoke({ action: "save", type: "fact", content: "one" }, config);
    await tool.invoke({ action: "save", type: "fact", content: "one" }, config);

    expect(operationIds).toHaveLength(2);
    expect(operationIds[0]).toBe(operationIds[1]);
    expect(operationIds[0]).toMatch(/^memory:v1:[0-9a-f]{64}$/);
    expect(operationIds[0]).not.toContain("one");
  });

  test("routes semantic search through the injected repository with exact authority", async () => {
    const authorities: ProtectedMemoryAuthority[] = [];
    const tool = createSearchMemoryTool({
      memoryAccessEnvelope: namespaceEnvelope(),
      protectedMemoryRepository: repository({
        search: async (input) => {
          authorities.push(input.authority);
          expect(input.mode).toBe("vector");
          return { status: "success", value: [{
            id: "memory-1",
            type: "fact",
            content: "Opened only inside the authorized Agent runtime",
            importance: 0.6,
            tier: 2,
            score: 0.9,
            createdAt: new Date(0),
          }] };
        },
      }),
    });

    const output = await tool.invoke({ query: "authorized" });

    expect(authorities).toEqual([{
      mode: "namespace",
      subjectUserId: "user-alice",
      agentId: "agent-genie",
      readableNamespaceIds: ["namespace-ab", "namespace-abc"],
      mutableNamespaceIds: ["namespace-ab", "namespace-abc"],
      writableNamespaceId: "namespace-ab",
    }]);
    expect(String(output)).toContain("Opened only inside the authorized Agent runtime");
  });

  test("uses the structural repository when the superseded search port is also present", async () => {
    let legacySearches = 0;
    let repositorySearches = 0;
    const tool = createSearchMemoryTool({
      memoryAccessEnvelope: namespaceEnvelope(),
      protectedMemorySearch: {
        search: async () => {
          legacySearches += 1;
          return { status: "success", value: [{
            id: "memory-foreground",
            type: "fact",
            content: "Must not win",
            importance: 0.7,
            tier: 1,
            score: 0.95,
            createdAt: new Date(0),
          }] };
        },
      },
      protectedMemoryRepository: repository({
        search: async () => {
          repositorySearches += 1;
          return { status: "success", value: [{
            id: "memory-repository",
            type: "fact",
            content: "Reopened through structural repository",
            importance: 0.7,
            tier: 1,
            score: 0.95,
            createdAt: new Date(0),
          }] };
        },
      }),
    });

    expect(String(await tool.invoke({ query: "foreground" })))
      .toContain("Reopened through structural repository");
    expect(repositorySearches).toBe(1);
    expect(legacySearches).toBe(0);
  });

  test("does not swallow Strict Shadow enforcement from protected search", async () => {
    const decision: StrictShadowBoundaryDecision = {
      boundaryId: "conversation.read.foreground_memory",
      family: "memory",
      operation: "read_repair",
      actorClass: "agent",
      state: "failed",
      reason: "integrity_failure",
      retryable: false,
      policyRevision: 9,
    };
    const tool = createSearchMemoryTool({
      memoryAccessEnvelope: namespaceEnvelope(),
      protectedMemorySearch: {
        search: async () => {
          throw new StrictShadowEnforcementError(decision);
        },
      },
    });

    expect(tool.invoke({ query: "strict" })).rejects.toMatchObject({
      code: "strict_shadow_protected_content_required",
      decision,
    });
  });

  test.each(["save", "replace", "promote", "remove"] as const)(
    "does not turn a withheld protected %s into successful tool text",
    async (action) => {
      const decision: StrictShadowBoundaryDecision = {
        boundaryId: "memory.foreground.mutation",
        family: "memory",
        operation: action,
        actorClass: "agent",
        state: "waiting_for_authority",
        reason: "domain_authority_converging",
        retryable: true,
        policyRevision: 9,
      };
      const failure = new StrictShadowEnforcementError(decision);
      const fail = async () => { throw failure; };
      const tool = createManageMemoryTool({
        memoryAccessEnvelope: namespaceEnvelope(),
        protectedMemoryRepository: repository({
          save: fail, replace: fail, setTier: fail,
        }),
      });
      const result: unknown = await tool.invoke({
        action, type: "fact", content: "confidential", memory_id: "memory-1",
      }, {
        configurable: { memoryToolMutationRequestId: "withheld-call" },
      }).then(() => null, (error: unknown) => error);
      expect(result).toBe(failure);
    },
  );

  test("does not swallow cancellation during a protected mutation", async () => {
    const controller = new AbortController();
    const failure = new Error("cancelled protected mutation");
    const tool = createManageMemoryTool({
      memoryAccessEnvelope: namespaceEnvelope(),
      protectedMemoryRepository: repository({
        save: async () => {
          controller.abort(failure);
          throw failure;
        },
      }),
    });
    const result: unknown = await tool.invoke({
      action: "save", type: "fact", content: "confidential",
    }, {
      signal: controller.signal,
      configurable: { memoryToolMutationRequestId: "cancelled-call" },
    }).then(() => null, (error: unknown) => error);
    expect(result).toBe(failure);
  });

  test("propagates foreground cancellation through protected search", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const tool = createSearchMemoryTool({
      memoryAccessEnvelope: namespaceEnvelope(),
      protectedMemorySearch: {
        search: async (input) => {
          capturedSignal = input.signal;
          controller.abort(new Error("cancelled foreground search"));
          throw controller.signal.reason;
        },
      },
    });

    expect(tool.invoke(
      { query: "cancelled" },
      { signal: controller.signal },
    )).rejects.toThrow("cancelled foreground search");
    expect(capturedSignal).toBe(controller.signal);
  });

  test("leaves protected invalidation delivery with the canonical publication receipt", async () => {
    const changes: AuthoredMemorySemanticChange[] = [];
    installAuthoredMemorySemanticChangeSink(async (change) => {
      changes.push(change);
    });
    const tool = createManageMemoryTool({
      memoryAccessEnvelope: namespaceEnvelope(),
      protectedMemoryRepository: repository({
        save: async () => ({
          status: "success",
          value: { id: "memory-updated", action: "updated" },
        }),
      }),
    });
    const config = {
      configurable: { memoryToolMutationRequestId: "tool-call-replay" },
    };

    await tool.invoke({ action: "save", type: "fact", content: "updated" }, config);
    await tool.invoke({ action: "save", type: "fact", content: "updated" }, config);

    expect(changes).toEqual([]);
  });

  test.each(["save", "replace", "promote", "remove"] as const)(
    "reports committed %s with follow-up pending without misreporting save failure",
    async (action) => {
      const tool = createManageMemoryTool({
        memoryAccessEnvelope: namespaceEnvelope(),
        protectedMemoryRepository: repository({
          save: async () => ({ status: "success", value: { id: "saved", action: "created" }, followUpPending: true }),
          replace: async () => ({ status: "success", value: undefined, followUpPending: true }),
          setTier: async () => ({ status: "success", value: undefined, followUpPending: true }),
        }),
      });
      const message = await tool.invoke({ action, content: "committed", memory_id: "saved", type: "fact" },
        { configurable: { memoryToolMutationRequestId: "effect-pending" } });
      expect(message).toContain("Follow-up processing pending.");
      expect(message).not.toContain("failed");
    },
  );

  test("fails closed when protected scope origin was not explicitly inherited", async () => {
    const scope = {
      memoryMode: "scope",
      ownerId: "user-alice",
      actorId: "actor-alice",
      agentId: "agent-genie",
      roomId: "room-ab",
      scopeId: "scope-1",
      toolPolicy: {},
    } satisfies MemoryAccessEnvelope;
    const tool = createManageMemoryTool({
      memoryAccessEnvelope: scope,
      protectedMemoryRepository: repository(),
    });

    expect(tool.invoke({
      action: "save",
      content: "must not guess an origin",
      type: "fact",
    })).rejects.toMatchObject({ reason: "authorization_required" });
  });

  test("surfaces typed protected failures instead of pretending no results", async () => {
    const tool = createSearchMemoryTool({
      memoryAccessEnvelope: namespaceEnvelope(),
      protectedMemoryRepository: repository({
        search: async () => ({
          status: "unavailable",
          reason: "integrity_failure",
        }),
      }),
    });

    expect(tool.invoke({ query: "anything" }))
      .rejects.toMatchObject({ reason: "integrity_failure" });
  });

  test("does not select the first of multiple ordinary write targets", async () => {
    const envelope = namespaceEnvelope();
    envelope.writableNamespaces = ["namespace-ab", "namespace-other"];
    const tool = createManageMemoryTool({
      memoryAccessEnvelope: envelope,
      protectedMemoryRepository: repository(),
    });

    expect(tool.invoke({
      action: "save",
      content: "must not use an unordered first target",
      type: "fact",
    })).rejects.toMatchObject({ reason: "authorization_required" });
  });

  test.each(["save", "replace", "promote", "remove"] as const)(
    "does not label an unexpected protected %s failure as a successful tool result",
    async (action) => {
      const failure = new Error("synthetic publication database failure");
      const fail = async (): Promise<never> => { throw failure; };
      const tool = createManageMemoryTool({
        memoryAccessEnvelope: namespaceEnvelope(),
        protectedMemoryRepository: repository({ save: fail, replace: fail, setTier: fail }),
      });
      const result = await tool.invoke({
        action, content: "not committed", type: "fact", memory_id: "memory-1",
      }, { configurable: { memoryToolMutationRequestId: "failed-memory" } })
        .then(() => undefined, (error: unknown) => error);
      expect(result).toBe(failure);
    },
  );

  test.each(["save", "replace", "promote", "remove"] as const)(
    "reports typed unavailable %s as an error without semantic-change effects",
    async (action) => {
      const changes: AuthoredMemorySemanticChange[] = [];
      installAuthoredMemorySemanticChangeSink(async (change) => { changes.push(change); });
      const unavailable = async () => ({ status: "unavailable" as const, reason: "encryption_pending" as const });
      const tool = createManageMemoryTool({
        memoryAccessEnvelope: namespaceEnvelope(),
        protectedMemoryRepository: repository({ save: unavailable, replace: unavailable, setTier: unavailable }),
      });
      const outcome: unknown = await tool.invoke({
        action, content: "not committed", type: "fact", memory_id: "memory-1",
      }, { configurable: { memoryToolMutationRequestId: "pending-memory" } })
        .then(() => null, (error: unknown) => error);
      expect(outcome).toMatchObject({ name: "ProtectedMemoryToolUnavailableError", reason: "encryption_pending" });
      expect(changes).toEqual([]);
    },
  );
});
