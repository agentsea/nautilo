import { afterEach, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { PolicyResolver } from "@nautilo/trust";
import { z } from "zod";
import { createNautiloGraph } from "../../src/agent/graph";
import { __setStubModelForTests } from "../../src/providers/universal";
import type { ChatModel } from "../../src/providers/types";

afterEach(() => { __setStubModelForTests(null); clearToolCatalog(); delete process.env["NAUTILO_TEST_MODE"]; });

test("the production graph repairs malformed arguments without executing them or replaying a valid sibling", async () => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  const executions: string[] = [];
  const catalog = new ToolCatalog();
  catalog.register({ name: "fixture_research", category: "development", trustTier: "guest", impact: "read-only", exposure: "core",
    factory: () => new DynamicStructuredTool({ name: "fixture_research", description: "Source evidence fixture", schema: z.object({ value: z.string() }),
      func: async (input) => { const { value } = z.object({ value: z.string() }).parse(input); executions.push(value); return `Evidence:${value}`; } }),
  });
  initToolCatalog(catalog);
  const policy: PolicyResolver = {
    resolveContext: async () => { throw new Error("Unexpected context resolution"); },
    buildEnvelope: async () => { throw new Error("Unexpected envelope construction"); },
    checkToolAccess: async () => ({ type: "allow" }),
    routeApproval: async () => ({ type: "prove_it", approvers: [] }),
  };
  let turns = 0;
  const model: ChatModel = { bindTools() { return model; }, async invoke(messages: BaseMessage[]) {
    turns++;
    if (turns === 1) return new AIMessage({ content: "", tool_calls: [{ id: "valid", name: "fixture_research", args: { value: "first" } }],
      invalid_tool_calls: [{ id: "broken", name: "fixture_research", args: '{"value":', error: "Malformed args.", type: "invalid_tool_call" }] });
    if (turns === 2) {
      const replies = messages.filter((message) => ToolMessage.isInstance(message));
      expect(replies.filter((message) => message.tool_call_id === "valid")).toHaveLength(1);
      expect(replies.find((message) => message.tool_call_id === "broken")?.content).toContain("MALFORMED_TOOL_ARGUMENTS");
      return new AIMessage({ content: "", tool_calls: [{ id: "repaired", name: "fixture_research", args: { value: "second" } }] });
    }
    if (turns === 3) return new AIMessage("Research complete.");
    throw new Error("Unexpected extra model turn");
  } };
  __setStubModelForTests(model);
  await createNautiloGraph(undefined, policy).invoke({ messages: [new HumanMessage("Investigate both source paths.")],
    model: "openai:gpt-5.5-2026-04-23", userId: "owner", actorRole: "owner",
    memoryAccessEnvelope: { ownerId: "owner", actorId: "actor", agentId: "agent", roomId: "room", readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: { fixture_research: "allow" } },
  });
  expect(executions).toEqual(["first", "second"]);
  expect(turns).toBe(3);
});
