import { expect, spyOn, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { fromRuntimeConfig } from "@nautilo/config";
import * as db from "@nautilo/db";
import type { NautiloState } from "../../src/agent/state";
import { agentNode } from "../../src/nodes/agent";
import * as invocation from "../../src/utils/chat-model-invocation";
import * as models from "../../src/providers/models";
import { taskReadResponseByteBudget, pendingTaskReadPages } from "../../src/utils/history-manager";
import { runTransientProtectedModelDispatch } from "../../src/runtime/protected-runtime-dispatch";
import { createNautiloToolInvocationSession, createServerToolInvocationContext } from "../../src/tools/invocation-service";
import { readTaskSection } from "../../src/tools/tasks/read";
import { pageSchema, projectOversizedTaskRead, taskReadPageFingerprint } from "../../src/tools/tasks/read-projection";

test("protected model output carries task paging debt and actual smaller-model budget into parallel tool factories", async () => {
  const savedKey = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "test-only-no-network";
  const refresh = spyOn(db, "kickServerModelConfigRefresh").mockImplementation(() => {});
  const configRow = spyOn(db, "getCachedServerModelConfigRow").mockReturnValue(null);
  const modelUsed = "anthropic:claude-sonnet-4-6";
  const actualContextTokens = 16_000;
  const limits = spyOn(models, "resolveModelExecutionLimits").mockImplementation(async (modelId) => ({
    modelId, catalogVersion: null, contextTokens: modelId === modelUsed ? actualContextTokens : 1_000_000,
    maxOutputTokens: 4000, contextSource: "override", outputSource: "override",
  }));
  const captured: Array<Record<string, unknown>> = [];
  const catalog = new ToolCatalog();
  catalog.register({ name: "task", exposure: "core", category: "documents", trustTier: "standard", impact: "read-only", executor: "cloud", resultScanPolicy: "never",
    factory: (context) => {
      if (context?.["taskReadMaxResponseBytes"] !== undefined) captured.push(context);
      return new DynamicStructuredTool({ name: "task", description: "Read a saved task", schema: z.object({ command: z.literal("read"), taskId: z.string(), continueRead: z.boolean().optional() }), func: async (input: { taskId: string }) => input.taskId === "invalid-cursor" || input.taskId === "no-budget"
        ? JSON.stringify({ version: "task-read-v1", kind: "error", code: input.taskId === "invalid-cursor" ? "task_read_cursor_invalid" : "task_read_budget_unavailable", message: "Select an available bounded page." })
        : JSON.stringify({ resultText: "The successful report describes error handling and recovery." }) });
    },
  });
  initToolCatalog(catalog);
  const args = { command: "read" as const, taskId: "child-task", runId: "child-run", readSection: "result" as const };
  const run = { id: "child-run", status: "completed", modelId: modelUsed, resultText: "Retained exact report. ".repeat(3000), lastError: null, startedAt: null, completedAt: null, graphThreadId: "child-thread" };
  const page = pageSchema.parse(JSON.parse(await readTaskSection(args, { ownerId: "owner", agentId: "agent", maxResponseBytes: 20_000 }, { task: { id: "child-task", status: "completed" }, runs: [run] }, [run])));
  const original = new ToolMessage({ id: "task-page", name: "task", tool_call_id: "prior-read", content: JSON.stringify(page), status: "success" });
  const canonical: BaseMessage[] = [new HumanMessage("Inspect the child's complete report."), new AIMessage({ content: "", tool_calls: [{ id: "prior-read", name: "task", args }] }), original];
  const calls = ["left", "right"].map((id) => ({ id, name: "task", args: { command: "read", taskId: "child-task", continueRead: true } }));
  const response = new AIMessage({ content: "Recover the omitted report input.", tool_calls: calls });
  const fraction = fromRuntimeConfig().nautilo_token_budget_fraction;
  let expectedBudget = 0;
  let initialBudget = 0;
  const provider = spyOn(invocation, "invokeChatModelWithFallback").mockImplementation(async (messages, tools) => {
    expect(JSON.stringify(messages)).toContain("private runtime-only configuration");
    expect(JSON.stringify(messages)).not.toContain(page.text);
    expectedBudget = taskReadResponseByteBudget({ modelId: modelUsed, tokenBudgetFraction: fraction },
      Math.floor(actualContextTokens * fraction) - invocation.estimateBoundToolTokens(tools), [...messages, response]);
    return { modelUsed, response };
  });
  const checkpoint = { messages: canonical, preparedMessages: [], soulFile: "", memoryBrief: "", skills: [], userId: "owner", personaId: "owner", agentId: "agent", roomId: "", turnId: "turn", actorRole: "owner",
    model: "openai:gpt-5.6-sol", subagentDepth: 1, subagentRun: false, toolWhitelist: ["task"], activatedToolNames: ["task"], activatedToolLeases: [], engagedSkillNames: [], relayCapabilities: {},
    taskReadPageBytes: null, taskReadPendingPages: [], requiredHostRelays: {}, verifiedOrdinaryOrigin: null, memoryAccessEnvelope: null,
  } as unknown as NautiloState;
  try {
    const output = await runTransientProtectedModelDispatch({ checkpointState: checkpoint,
      configuration: { formatVersion: 1, soulFile: "private runtime-only configuration", memoryBrief: "private memory", skills: [], commands: [], onboardingAnswers: [] },
      prepareModelInput: (state) => {
        const replay = projectOversizedTaskRead(page, args, 4000)!;
        const prepared = [new SystemMessage(state.soulFile), ...canonical.slice(0, -1), new ToolMessage({ ...original, content: JSON.stringify(replay) })];
        initialBudget = taskReadResponseByteBudget({ modelId: state.model ?? "openai:gpt-5.6-sol", tokenBudgetFraction: fraction }, 500_000, prepared);
        return { preparedMessages: prepared, messages: canonical, taskReadPageBytes: initialBudget,
          taskReadPendingPages: pendingTaskReadPages(canonical, prepared) };
      }, invokeModel: agentNode,
    });
    expect(output.taskReadPageBytes).toBe(expectedBudget);
    expect(expectedBudget).toBeGreaterThan(0);
    expect(expectedBudget).toBeLessThan(initialBudget);
    expect(output.taskReadPendingPages).toEqual([{ fingerprint: taskReadPageFingerprint(original.content as string)!,
      taskId: page.taskId, runId: page.runId, readSection: page.readSection, sourceVersion: page.sourceVersion,
      startByte: page.startByte, endByte: page.endByte, resolvedSelection: page.resolvedSelection }]);
    expect(output.messages?.[2]?.content).toBe(original.content);
    expect(output).not.toHaveProperty("preparedMessages");
    expect(output).not.toHaveProperty("soulFile");
    expect(output).not.toHaveProperty("memoryBrief");
    const actualState = { ...checkpoint, ...output };
    const session = createNautiloToolInvocationSession(createServerToolInvocationContext(actualState, () => ({ status: "allowed" })));
    const receipts = await Promise.all(calls.map((call) => session.invoke({ callId: call.id, toolName: "task", args: call.args, authorityRef: "admitted-test" })));
    expect(receipts.every((receipt) => receipt.status === "success")).toBe(true);
    expect(receipts.every((receipt) => typeof receipt.content === "string" && receipt.content.includes("error handling"))).toBe(true);
    expect(captured).toHaveLength(2);
    for (const context of captured) {
      expect(context["taskReadMaxResponseBytes"]).toBe(Math.floor(expectedBudget / 2));
      expect(context["taskReadPendingPages"]).toEqual(output.taskReadPendingPages);
      expect(context["taskReadMessages"]).toEqual(output.messages);
      expect(JSON.stringify(context)).not.toContain("private runtime-only configuration");
    }
    for (const taskId of ["invalid-cursor", "no-budget"]) {
      const rejected = await session.invoke({ callId: `typed-${taskId}`, toolName: "task", args: { command: "read", taskId }, authorityRef: "admitted-test" });
      expect(rejected.status).toBe("error");
      expect(rejected.additionalKwargs?.["nautilo_tool_status"]).toBe("error");
      if (typeof rejected.content !== "string") throw new Error("Expected exact typed read-error text");
      expect(JSON.parse(rejected.content)).toMatchObject({ version: "task-read-v1", kind: "error",
        code: taskId === "invalid-cursor" ? "task_read_cursor_invalid" : "task_read_budget_unavailable" });
    }
  } finally { provider.mockRestore(); limits.mockRestore(); refresh.mockRestore(); configRow.mockRestore(); clearToolCatalog();
    if (savedKey === undefined) delete process.env["OPENAI_API_KEY"]; else process.env["OPENAI_API_KEY"] = savedKey;
  }
});
