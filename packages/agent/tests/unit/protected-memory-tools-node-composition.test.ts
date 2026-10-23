import * as logger from "@nautilo/logger";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  ToolCatalog,
  clearToolCatalog,
  initToolCatalog,
  type ToolContext,
} from "@nautilo/catalog";
import type { ProtectedAgentMemoryRepository } from "@nautilo/lattice-bridge";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryScopeLifecyclePort,
} from "../../src/tools/memory/protected-memory-ports";
import { z } from "zod";

import type { NautiloState } from "../../src/agent/state";
import {
  __mintProtectedMemoryToolsNodeTestAuthorityForTesting,
  createToolsNode,
  createProtectedMemoryTestToolsNode,
  setRelayRegistry,
  toolsNode,
  type ToolRelayRegistry,
} from "../../src/nodes/tools";
import { createProtectedMemoryTestProjectionPreflightNode } from "../../src/nodes/projection-preflight";
import { setAgentEventSink } from "../../src/runtime-hooks";

afterEach(() => {
  clearToolCatalog();
  setAgentEventSink(null);
  setRelayRegistry(null);
});

function state(
  name = "protected_memory_fixture",
  args: Record<string, unknown> = {},
): NautiloState {
  const call = {
    id: "call-protected-memory",
    name,
    args,
    type: "tool_call" as const,
  };
  return {
    messages: [new AIMessage({ content: "", tool_calls: [call] })],
    approvedToolCalls: [call],
    actorRole: "owner",
    userId: "11111111-1111-4111-8111-111111111111",
    personaId: "11111111-1111-4111-8111-111111111111",
    turnId: "turn-protected-memory",
    agentId: "22222222-2222-4222-8222-222222222222",
    roomId: "room-protected-memory",
    activatedToolNames: [],
    activatedToolLeases: [],
    activationLeasesInitialized: false,
    engagedSkillNames: [],
    memoryAccessEnvelope: null,
    relayCapabilities: {},
  } as unknown as NautiloState;
}

function repository(): ProtectedAgentMemoryRepository {
  return Object.freeze({
    search: async () => ({ status: "success" as const, value: [] }),
    save: async () => ({
      status: "success" as const,
      value: { id: "memory-protected", action: "created" as const },
    }),
    replace: async () => ({ status: "success" as const, value: undefined }),
    setTier: async () => ({ status: "success" as const, value: undefined }),
  });
}

function accessPort(): ProtectedAgentMemoryAccessPort {
  return Object.freeze({
    change: async (input: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0]) => ({ status: "success" as const, value: {
      status: "updated" as const,
      memoryId: input.memoryId,
    } }),
  });
}

function projectionPort(): ProtectedAgentMemoryProjectionPort {
  return Object.freeze({
    prepare: async () => ({ status: "unavailable" as const,
      reason: "authorization_required" as const }),
    publish: async () => ({ status: "unavailable" as const,
      reason: "authorization_required" as const }),
  });
}

function scopePort(): ProtectedAgentMemoryScopeLifecyclePort {
  return Object.freeze({
    create: async () => ({ status: "unavailable" as const,
      reason: "authorization_required" as const }),
    attachSeed: async () => ({ status: "unavailable" as const,
      reason: "authorization_required" as const }),
    close: async () => ({ status: "unavailable" as const,
      reason: "authorization_required" as const }),
  });
}

function registerFixture(onContext: (context: ToolContext | undefined) => void): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "protected_memory_fixture",
    exposure: "core",
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    factory: (context) => {
      onContext(context);
      return new DynamicStructuredTool({
        name: "protected_memory_fixture",
        description: "Protected Memory composition fixture",
        schema: z.object({}),
        func: async () => "ok",
      });
    },
  });
  initToolCatalog(catalog);
}

function registerRejectingFixture(message: string): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "protected_memory_fixture",
    exposure: "core",
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    factory: () => new DynamicStructuredTool({
      name: "protected_memory_fixture",
      description: "Rejecting protected Memory composition fixture",
      schema: z.object({}),
      func: async () => {
        throw new Error(message);
      },
    }),
  });
  initToolCatalog(catalog);
}

function registerMalformedFileFixture(executor: "cloud" | "relay"): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "file",
    exposure: "core",
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    executor,
    resultScanPolicy: "never",
    factory: () => new DynamicStructuredTool({
      name: "file",
      description: "Malformed file command fixture",
      schema: z.object({ command: z.literal("read") }),
      func: async () => "unreachable",
    }),
  });
  initToolCatalog(catalog);
}

function malformedFileState(command: string, suppressToolLifecycleEvents: boolean): NautiloState {
  return {
    ...state("file", { command }),
    requiredHostRelays: { "call-protected-memory": "relay-probe" },
    verifiedOrdinaryOrigin: {
      kind: "paired_mobile",
      serverInstanceId: "server-probe",
      serverBindingGeneration: 1,
      userId: "11111111-1111-4111-8111-111111111111",
      actorId: "11111111-1111-4111-8111-111111111111",
      controllerInstallationId: "controller-probe",
      installationGeneration: 1,
      requestId: "request-probe",
    },
    suppressToolLifecycleEvents,
  } as unknown as NautiloState;
}

function failingRelayRegistry(): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => ["relay-probe"],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
      allowedRoots: ["/tmp"],
      securityLevel: "standard",
    }),
    dispatch: async () => ({ status: "error", error: "relay unavailable" }),
    register: async () => undefined,
    unregister: async () => undefined,
    updatePresence: () => undefined,
    resolveDispatch: () => undefined,
    cancelDispatch: () => undefined,
    listConnected: async () => ["relay-probe"],
    findByCapability: () => ["relay-probe"],
    start: () => undefined,
    stop: () => undefined,
  } as unknown as ToolRelayRegistry;
}

describe("nonproduction protected Memory tools-node composition", () => {
  test("production composition forwards the invocation-bound repository", async () => {
    const protectedRepository = repository();
    let seenContext: ToolContext | undefined;
    registerFixture((context) => {
      seenContext = context;
    });
    const node = createToolsNode({
      protectedMemoryRepositoryForState: () => protectedRepository,
    });

    await node(state());

    expect(seenContext?.["protectedMemoryRepository"])
      .toBe(protectedRepository);
  });

  test("passes the exact repository through the real invocation path", async () => {
    const protectedRepository = repository();
    const access = accessPort();
    const projection = projectionPort();
    const scopeLifecycle = scopePort();
    let seenContext: ToolContext | undefined;
    registerFixture((context) => {
      seenContext = context;
    });
    const protectedToolsNode = createProtectedMemoryTestToolsNode({
      authority: __mintProtectedMemoryToolsNodeTestAuthorityForTesting(),
      repository: protectedRepository,
      access,
      projection,
      scopeLifecycle,
    });

    await protectedToolsNode(state());

    expect(seenContext?.["protectedMemoryRepository"]).toBe(protectedRepository);
    expect(seenContext?.["protectedMemoryAccessPort"]).toBe(access);
    expect(seenContext?.["protectedMemoryProjectionPort"]).toBe(projection);
    expect(seenContext?.["protectedMemoryScopeLifecyclePort"])
      .toBe(scopeLifecycle);
  });

  test("keeps the production graph tools node unprotected", async () => {
    let seenContext: ToolContext | undefined;
    registerFixture((context) => {
      seenContext = context;
    });

    await toolsNode(state());

    expect(seenContext?.["protectedMemoryRepository"]).toBeUndefined();
    expect(seenContext?.["protectedMemoryAccessPort"]).toBeUndefined();
    expect(seenContext?.["protectedMemoryProjectionPort"]).toBeUndefined();
    expect(seenContext?.["protectedMemoryScopeLifecyclePort"]).toBeUndefined();
  });

  test("forwards confidentiality only from trusted tools-node composition", async () => {
    let seenContext: ToolContext | undefined;
    registerFixture((context) => {
      seenContext = context;
    });

    await createToolsNode({ confidential: true })(state());
    expect(seenContext?.["confidential"]).toBe(true);

    seenContext = undefined;
    const forgedState = { ...state(), confidential: true } as unknown as NautiloState;
    await createToolsNode({})(forgedState);
    expect(seenContext?.["confidential"]).toBeUndefined();
  });

  test("closes thrown tool diagnostics only for trusted confidential composition", async () => {
    const canary = "provider-confidential-canary-98213";
    const rawKey = "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const rawError = `${canary} ${rawKey}`;
    const closedError = "Protected tool execution failed.";
    const warnings = spyOn(logger, "warn").mockImplementation(() => undefined);
    const telemetryErrors: string[] = [];
    setAgentEventSink({ emit: (event) => {
      if (event.type === "tool.end" && event.error !== undefined) {
        telemetryErrors.push(event.error);
      }
    } });

    try {
      registerRejectingFixture(rawError);
      const protectedResult = await createToolsNode({ confidential: true })(state());
      expect(protectedResult.messages?.at(-1)?.content).toBe(
        `Error executing protected_memory_fixture: ${closedError}`,
      );
      expect(telemetryErrors).toEqual([closedError]);
      expect(JSON.stringify(warnings.mock.calls)).toContain(closedError);
      expect(JSON.stringify({ protectedResult, telemetryErrors, warnings: warnings.mock.calls }))
        .not.toContain(canary);

      for (const forgedConfidentialState of [false, true]) {
        clearToolCatalog();
        registerRejectingFixture(rawError);
        warnings.mockClear();
        telemetryErrors.length = 0;
        const ordinaryState = forgedConfidentialState
          ? { ...state(), confidential: true } as unknown as NautiloState
          : state();
        const ordinaryResult = await createToolsNode({})(ordinaryState);
        const ordinarySinks = JSON.stringify({
          ordinaryResult,
          telemetryErrors,
          warnings: warnings.mock.calls,
        });
        expect(ordinarySinks).toContain(canary);
        expect(ordinarySinks).toContain("[REDACTED");
        expect(ordinarySinks).not.toContain(rawKey);
      }
    } finally {
      warnings.mockRestore();
    }
  });

  test("keeps unvalidated file commands and unknown tool names out of confidential diagnostics", async () => {
    const fileCanary = "private-command-canary-78431";
    const unknownCanary = "private-unknown-tool-canary-31947";
    const logs = spyOn(logger, "log").mockImplementation(() => undefined);
    const warnings = spyOn(logger, "warn").mockImplementation(() => undefined);
    const lifecycleEvents: string[] = [];
    setAgentEventSink({ emit: (event) => lifecycleEvents.push(event.type) });

    try {
      registerMalformedFileFixture("cloud");
      const protectedResult = await createToolsNode({ confidential: true })(
        malformedFileState(fileCanary, true),
      );
      const protectedDiagnostics = JSON.stringify({
        logs: logs.mock.calls,
        warnings: warnings.mock.calls,
        toolMessage: protectedResult.messages?.at(-1)?.content,
      });
      expect(protectedDiagnostics).toContain("Executing (cloud): file");
      expect(protectedDiagnostics).toContain("Tool file failed");
      expect(protectedDiagnostics).not.toContain(fileCanary);
      expect(lifecycleEvents).toEqual([]);

      clearToolCatalog();
      logs.mockClear();
      warnings.mockClear();
      registerMalformedFileFixture("cloud");
      const ordinaryResult = await createToolsNode({})(
        malformedFileState(fileCanary, false),
      );
      const ordinaryDiagnostics = JSON.stringify({
        logs: logs.mock.calls,
        warnings: warnings.mock.calls,
        toolMessage: ordinaryResult.messages?.at(-1)?.content,
      });
      expect(ordinaryDiagnostics).toContain(`file:${fileCanary}`);

      clearToolCatalog();
      logs.mockClear();
      warnings.mockClear();
      registerMalformedFileFixture("relay");
      setRelayRegistry(failingRelayRegistry());
      const relayResult = await createToolsNode({ confidential: true })(
        malformedFileState(fileCanary, true),
      );
      const relayDiagnostics = JSON.stringify({
        logs: logs.mock.calls,
        warnings: warnings.mock.calls,
        toolMessage: relayResult.messages?.at(-1)?.content,
      });
      expect(relayDiagnostics).toContain("Dispatching via relay (relay-probe): file");
      expect(relayDiagnostics).not.toContain(fileCanary);

      clearToolCatalog();
      logs.mockClear();
      warnings.mockClear();
      registerMalformedFileFixture("cloud");
      const unknownResult = await createToolsNode({ confidential: true })(
        state(unknownCanary),
      );
      const unknownDiagnostics = JSON.stringify({
        warnings: warnings.mock.calls,
        toolMessage: unknownResult.messages?.at(-1)?.content,
      });
      expect(unknownDiagnostics).toContain("Unknown tool: unknown_tool");
      expect(unknownDiagnostics).not.toContain(unknownCanary);
    } finally {
      logs.mockRestore();
      warnings.mockRestore();
    }
  });

  test("rejects a forged nonproduction authority", () => {
    const forged = {} as ReturnType<
      typeof __mintProtectedMemoryToolsNodeTestAuthorityForTesting
    >;
    expect(() => createProtectedMemoryTestToolsNode({
      authority: forged,
      repository: repository(),
    })).toThrow("recognized test authority");
    expect(() => createProtectedMemoryTestProjectionPreflightNode({
      authority: forged,
      projection: projectionPort(),
    })).toThrow("recognized test authority");
  });

  test("blocks unfinished Memory access and scope mutations instead of invoking legacy tools", async () => {
    const invoked: string[] = [];
    const catalog = new ToolCatalog();
    for (const name of [
      "share_memory",
      "create_scope",
      "add_memory_to_scope",
      "close_scope",
    ]) {
      catalog.register({
        name,
        exposure: "core",
        category: "knowledge",
        trustTier: "guest",
        impact: "read-only",
        factory: () => new DynamicStructuredTool({
          name,
          description: `Legacy ${name} fixture`,
          schema: z.object({}).passthrough(),
          func: async () => {
            invoked.push(name);
            return "legacy path ran";
          },
        }),
      });
    }
    initToolCatalog(catalog);
    const protectedToolsNode = createProtectedMemoryTestToolsNode({
      authority: __mintProtectedMemoryToolsNodeTestAuthorityForTesting(),
      repository: repository(),
    });

    for (const name of [
      "share_memory",
      "create_scope",
      "add_memory_to_scope",
      "close_scope",
    ]) {
      const output = await protectedToolsNode(state(name));
      expect(output.messages?.at(-1)?.content).toBe(
        "Error: encrypted Memory access-set support is not ready for this operation.",
      );
    }

    expect(invoked).toEqual([]);
  });

  test("unblocks only the operation whose exact protected port exists", async () => {
    const invoked: string[] = [];
    const catalog = new ToolCatalog();
    for (const name of ["share_memory", "create_scope"]) {
      catalog.register({
        name,
        exposure: "core",
        category: "knowledge",
        trustTier: "guest",
        impact: "read-only",
        factory: () => new DynamicStructuredTool({
          name,
          description: `Protected ${name} fixture`,
          schema: z.object({}).passthrough(),
          func: async () => {
            invoked.push(name);
            return "protected path ran";
          },
        }),
      });
    }
    initToolCatalog(catalog);
    const protectedToolsNode = createProtectedMemoryTestToolsNode({
      authority: __mintProtectedMemoryToolsNodeTestAuthorityForTesting(),
      repository: repository(),
      access: accessPort(),
    });

    expect((await protectedToolsNode(state("share_memory"))).messages?.at(-1)?.content)
      .toBe("protected path ran");
    expect((await protectedToolsNode(state("create_scope"))).messages?.at(-1)?.content)
      .toBe("Error: encrypted Memory access-set support is not ready for this operation.");
    expect(invoked).toEqual(["share_memory"]);
  });
});
