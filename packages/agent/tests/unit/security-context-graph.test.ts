import { expect, spyOn, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import * as db from "@nautilo/db";
import type { PolicyResolver } from "@nautilo/trust";
import { securityScanToolResultSchema, type SecurityScanRelayRequest } from "@nautilo/types";
import { createNautiloGraph } from "../../src/agent/graph";
import type { NautiloState } from "../../src/agent/state";
import { agentNode } from "../../src/nodes/agent";
import { runTransientProtectedModelDispatch } from "../../src/runtime/protected-runtime-dispatch";
import * as preModel from "../../src/nodes/pre-model";
import * as invocation from "../../src/utils/chat-model-invocation";
import { registerAllTools } from "../../src/tools/register-all";
import { setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { budgetResearchContext, currentResearchContextRecovery } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextMessage } from "../../src/tools/security/research-context";

/** Production graph, agent node, both output preflights, admission and protected tool node.
 * Only prompt assembly and model generation are substituted; no network or database. */
test("research recovery survives an actual graph checkpoint and restart through normal protected tool execution", async () => {
  const savedKey = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "graph-test-only";
  const catalog = new ToolCatalog(); registerAllTools(catalog, { officeCliAvailable: () => false }); initToolCatalog(catalog);
  setRelayRegistry(null);
  const refresh = spyOn(db, "kickServerModelConfigRefresh").mockImplementation(() => {});
  const configRow = spyOn(db, "getCachedServerModelConfigRow").mockReturnValue(null);
  let preparations = 0;
  let pauseAt = 2;
  let providerCalls = 0;
  let selectedModel: string | undefined;
  let current: NautiloState | undefined;
  const prepared = spyOn(preModel, "preModelNode").mockImplementation(async (state) => {
    preparations++;
    if (preparations >= pauseAt) throw new Error("qualification-pause-after-protected-tool");
    const budgeted = budgetResearchContext(state, [new SystemMessage("Review the authorized code and consolidate preserved research."), ...state.messages], 4000);
    current = { ...state, researchContextRecovery: budgeted.recovery, researchContextPageBytes: budgeted.pageBytes };
    return { messages: state.messages, preparedMessages: budgeted.messages, researchContextRecovery: budgeted.recovery, researchContextPageBytes: budgeted.pageBytes };
  });
  const provider = spyOn(invocation, "invokeChatModelWithFallback").mockImplementation(async (_messages, tools, model, _userId, _agentId, _laneKey, _config, options) => {
    providerCalls++; selectedModel = model;
    expect(options?.modelFallbackMode).toBe("none");
    expect(tools.map((tool) => tool.name)).toContain("security_scan");
    if (!current?.researchContextRecovery) throw new Error("Expected persisted recovery before provider call");
    if (providerCalls === 2 || providerCalls === 4) {
      return { modelUsed: model, response: new AIMessage({ id: "ai:model-checkpoint", content: "Save the inspected page before requesting another.", tool_calls: [{
        id: "save-page-checkpoint", name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry: {
          kind: "checkpoint", summary: "Inspected the first retained authorization-source page; its source bytes and outstanding references remain preserved.",
          nextWork: "Read the exact continuation of the original source; investigate the queued delivery and revocation paths.", openRecordIds: [], evidenceRefs: [],
        } },
      }] }) };
    }
    const contextRef = describeResearchContextMessage(current, 2)!.ref;
    const prior = [...current.messages].reverse().find((message) => ToolMessage.isInstance(message) && message.name === "security_scan"
      && typeof message.content === "string" && (JSON.parse(message.content) as { operation?: string }).operation === "context");
    const previous = prior && typeof prior.content === "string" ? JSON.parse(prior.content) as { result?: { nextCursor?: string } } : undefined;
    return { modelUsed: model, response: new AIMessage({ id: `ai:model-recovery-${providerCalls}`, content: "Read the retained source page and preserve its material conclusions.", tool_calls: [{
      id: `recover-${providerCalls}`, name: "security_scan", args: { version: "security-scan-v1", operation: "context", contextRef,
        ...(previous?.result?.nextCursor ? { contextCursor: previous.result.nextCursor } : {}) },
    }] }) };
  });
  let protectedCalls = 0;
  let protectedResults = 0;
  const saver = new MemorySaver();
  const policy = { checkToolAccess: async () => ({ type: "allow" as const }) } as unknown as PolicyResolver;
  const makeGraph = () => createNautiloGraph(saver, policy, { liveShadowToolBoundaryForState: () => ({
    protectAssistantToolCall: async (message) => { protectedCalls++; return message; },
    protectToolResult: async (message) => { protectedResults++; return message; },
  }) });
  const config = { configurable: { thread_id: "security-research-restart" } };
  const original = new ToolMessage({ id: "tm:huge-source", name: "file", tool_call_id: "huge-source", content: "substantive authorization source\n".repeat(15000) });
  const input = {
    messages: [new HumanMessage("Audit the complete authorized source."), new AIMessage({ id: "ai:huge-source", content: "Inspect source.", tool_calls: [{ id: "huge-source", name: "file", args: { command: "grep", pattern: "authorize" } }] }), original],
    userId: "owner", personaId: "owner", agentId: "agent", roomId: "", turnId: "turn", actorRole: "owner", model: "openai:gpt-5.6-sol", modelFallbackMode: "none",
    currentTaskId: "11111111-1111-4111-8111-111111111111", currentTaskRunId: "22222222-2222-4222-8222-222222222222", subagentRun: true, subagentDepth: 1, taskRun: true,
    toolWhitelist: ["file", "security_scan"], activatedToolNames: ["file", "security_scan"], relayCapabilities: { canReadWorkspace: true },
    requiredHostRelays: {}, verifiedOrdinaryOrigin: null, currentFolder: "/qualification/source", workspacePath: "/qualification/workspace",
    taskReportBackContinuation: { status: "available", relayId: "qualification-relay", relaySessionId: "qualification-session",
      desktopSessionId: "qualification-desktop", pairingGeneration: "qualification-pairing", currentFolder: "/qualification/source", workspacePath: "/qualification/workspace" },
  };
  try {
    const graph = makeGraph();
    const firstPause = await graph.invoke(input, config).catch((error: unknown) => error);
    expect(firstPause).toBeInstanceOf(Error);
    expect((firstPause as Error).message).toBe("qualification-pause-after-protected-tool");
    const first = (await graph.getState(config))!.values as unknown as NautiloState;
    expect(first.messages[2]?.content).toBe(original.content);
    expect(first.researchContextRecovery).not.toBeNull();
    expect(first.researchContextPageBytes).toBeGreaterThan(0);
    expect(currentResearchContextRecovery(first)).not.toBeNull();
    expect(first.messages.filter((message) => ToolMessage.isInstance(message) && message.name === "security_scan")).toHaveLength(1);
    const firstPage = JSON.parse(first.messages.at(-1)!.content as string) as { result: { endByte: number } };
    let checkpointWrites = 0;
    setRelayRegistry({
      findByCapabilityForUser: () => ["qualification-relay"], getUserId: () => "owner", isRelayHeartbeatFresh: () => true,
      getRelaySessionId: () => "qualification-session", getDesktopSessionId: () => "qualification-desktop", getPairingGeneration: () => "qualification-pairing",
      getCapabilities: () => ({ canReadWorkspace: true, currentFolderRoot: "/qualification/source", workspaceRoot: "/qualification/workspace" }),
      dispatch: async (_relayId: string, request: Record<string, unknown>) => {
        const args = request["args"] as SecurityScanRelayRequest;
        expect(args.operation.operation).toBe("record");
        if (args.operation.operation !== "record") throw new Error("Only the fixture checkpoint can reach this Desktop backend");
        expect(args.trustedContext).toMatchObject({ taskId: input.currentTaskId, taskRunId: input.currentTaskRunId, toolCallId: "save-page-checkpoint", modelId: input.model });
        checkpointWrites++;
        const author = { taskId: input.currentTaskId, taskRunId: input.currentTaskRunId, modelId: input.model };
        return { status: "ok", result: securityScanToolResultSchema.parse({ ok: true, operation: "record", result: { codeEvidence: [], record: {
          id: "checkpoint_recovered_page", revision: 1, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
          createdBy: author, updatedBy: author, entry: args.operation.entry,
        } } }) };
      },
    } as unknown as ToolRelayRegistry);
    pauseAt = 4;
    const restarted = makeGraph();
    const secondPause = await restarted.invoke(null, config).catch((error: unknown) => error);
    expect(secondPause).toBeInstanceOf(Error);
    expect((secondPause as Error).message).toBe("qualification-pause-after-protected-tool");
    const second = (await restarted.getState(config))!.values as unknown as NautiloState;
    expect(second.messages[2]?.content).toBe(original.content);
    expect(currentResearchContextRecovery(second)).not.toBeNull();
    expect(second.messages.filter((message) => ToolMessage.isInstance(message) && message.name === "security_scan")).toHaveLength(2);
    expect(JSON.parse(second.messages.at(-1)!.content as string)).toMatchObject({ ok: true, operation: "record", result: { record: { entry: { kind: "checkpoint" } } } });
    expect(checkpointWrites).toBe(1);
    // Disconnect the fake Desktop. Historical reads remain server-local and
    // resume exact bytes after the accepted, separately checkpointed model note.
    setRelayRegistry(null);
    pauseAt = 6;
    const afterCheckpoint = makeGraph();
    const thirdPause = await afterCheckpoint.invoke(null, config).catch((error: unknown) => error);
    expect(thirdPause).toBeInstanceOf(Error);
    expect((thirdPause as Error).message).toBe("qualification-pause-after-protected-tool");
    const third = (await afterCheckpoint.getState(config))!.values as unknown as NautiloState;
    expect(third.messages[2]?.content).toBe(original.content);
    expect(currentResearchContextRecovery(third)).not.toBeNull();
    const contextPages = third.messages.filter((message) => ToolMessage.isInstance(message) && message.name === "security_scan" && typeof message.content === "string" && (JSON.parse(message.content) as { operation?: string }).operation === "context");
    expect(contextPages).toHaveLength(2);
    const secondPage = JSON.parse(contextPages[1]!.content as string) as { result: { startByte: number } };
    expect(secondPage.result.startByte).toBe(firstPage.result.endByte);
    expect(providerCalls).toBe(3);
    expect(selectedModel).toBe(input.model);
    expect(protectedCalls).toBe(3);
    expect(protectedResults).toBe(3);
    expect(checkpointWrites).toBe(1);
    // Strict transient Runtime dispatch must carry pre_model's newly-created
    // recovery state through agentNode while keeping decrypted prompt fields out.
    const protectedResult = await runTransientProtectedModelDispatch({
      checkpointState: { ...first, soulFile: "", skills: [], memoryBrief: "", preparedMessages: [], researchContextRecovery: null, researchContextPageBytes: null },
      configuration: { formatVersion: 1, soulFile: "private runtime configuration", memoryBrief: "private memory brief", skills: [], commands: [], onboardingAnswers: [] },
      prepareModelInput: (state) => {
        const budgeted = budgetResearchContext(state, [new SystemMessage("Authorized protected research."), ...state.messages], 4000);
        current = { ...state, researchContextRecovery: budgeted.recovery, researchContextPageBytes: budgeted.pageBytes };
        return { messages: state.messages, preparedMessages: budgeted.messages, researchContextRecovery: budgeted.recovery, researchContextPageBytes: budgeted.pageBytes };
      },
      invokeModel: agentNode,
    });
    expect(protectedResult.researchContextRecovery).not.toBeNull();
    expect(protectedResult.researchContextPageBytes).toBeGreaterThan(0);
    expect(protectedResult.messages?.[2]?.content).toBe(original.content);
    expect(protectedResult).not.toHaveProperty("preparedMessages");
    expect(protectedResult).not.toHaveProperty("soulFile");
    expect(protectedResult).not.toHaveProperty("memoryBrief");
    expect(providerCalls).toBe(4);

  } finally {
    provider.mockRestore(); prepared.mockRestore(); refresh.mockRestore(); configRow.mockRestore(); clearToolCatalog(); setRelayRegistry(null);
    if (savedKey === undefined) delete process.env["OPENAI_API_KEY"]; else process.env["OPENAI_API_KEY"] = savedKey;
  }
});
