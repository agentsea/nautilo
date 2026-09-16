import { afterEach, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, clearToolCatalog, initToolCatalog, type ToolContext } from "@nautilo/catalog";
import { z } from "zod";
import type { NautiloState } from "../../src/agent/state";
import { toolsNode } from "../../src/nodes/tools";

afterEach(() => {
  clearToolCatalog();
});

function state(actorRole: "owner" | "guest"): NautiloState {
  const call = { id: "call-core", name: "core_fixture", args: {}, type: "tool_call" as const };
  return {
    messages: [new AIMessage({ content: "", tool_calls: [call] })],
    approvedToolCalls: [call],
    actorRole,
    userId: "owner",
    personaId: "owner",
    turnId: "resume-turn",
    agentId: "agent",
    roomId: "room",
    activatedToolNames: ["legacy_deferred"],
    activatedToolLeases: [],
    activationLeasesInitialized: false,
    engagedSkillNames: [],
    memoryAccessEnvelope: null,
    relayCapabilities: {},
  } as unknown as NautiloState;
}

function registerFixture(onContext: (context: ToolContext | undefined) => void): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "core_fixture",
    exposure: "core",
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    factory: (context) => {
      onContext(context);
      return new DynamicStructuredTool({
        name: "core_fixture",
        description: "D447 tools-node fixture",
        schema: z.object({}),
        func: async () => "ok",
      });
    },
  });
  catalog.register({
    name: "legacy_deferred",
    exposure: "discoverable",
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    factory: () => new DynamicStructuredTool({
      name: "legacy_deferred",
      description: "D447 deferred fixture",
      schema: z.object({}),
      func: async () => "ok",
    }),
  });
  initToolCatalog(catalog);
}

describe("D447 tools-node activation state", () => {
  test("passes actor-safe activation names to selected tool factories", async () => {
    let factoryContext: ToolContext | undefined;
    registerFixture((context) => {
      factoryContext = context;
    });

    await toolsNode(state("guest"));

    expect(factoryContext?.["activatedToolNames"]).toEqual([]);
  });

  test("an approval resume preserves an unmigrated legacy sentinel", async () => {
    registerFixture(() => {});

    const patch = await toolsNode(state("owner"));

    expect(patch.activatedToolNames).toEqual(["legacy_deferred"]);
    expect(patch.activatedToolLeases).toEqual([]);
    expect(patch.activationLeasesInitialized).toBe(false);
  });
});
