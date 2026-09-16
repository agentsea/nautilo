import { expect, spyOn, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { fromRuntimeConfig } from "@nautilo/config";
import * as db from "@nautilo/db";
import type { NautiloState } from "../../src/agent/state";
import { agentNode } from "../../src/nodes/agent";
import { registerAllTools } from "../../src/tools/register-all";
import * as invocation from "../../src/utils/chat-model-invocation";
import { runTransientProtectedModelDispatch } from "../../src/runtime/protected-runtime-dispatch";
import { describeResearchContextMessage } from "../../src/tools/security/research-context";

test("only a successful actual provider input produces content-free presentation metadata through protected dispatch", async () => {
  const key = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "unit-test-no-network";
  const refresh = spyOn(db, "kickServerModelConfigRefresh").mockImplementation(() => {});
  const row = spyOn(db, "getCachedServerModelConfigRow").mockReturnValue(null);
  const catalog = new ToolCatalog(); registerAllTools(catalog, { officeCliAvailable: () => false }); initToolCatalog(catalog);
  const source = new ToolMessage({ id: "source", name: "file", tool_call_id: "read", status: "success", content: "Exact source β\n".repeat(3000) });
  const state = { messages: [new HumanMessage("Audit the authorized source."), new AIMessage({ id: "read-call", content: "", tool_calls: [{ id: "read", name: "file", args: { command: "read", path: "auth.js", zone: "current" } }] }), source],
    preparedMessages: [], soulFile: "", skills: [], memoryBrief: "", userId: "owner", personaId: "owner", actorRole: "owner", agentId: "agent", roomId: "", turnId: "turn",
    model: "openai:gpt-5.6-sol", modelFallbackMode: "none", subagentDepth: 1, subagentRun: true, taskRun: true,
    currentTaskId: "11111111-1111-4111-8111-111111111111", currentTaskRunId: "22222222-2222-4222-8222-222222222222", toolWhitelist: ["file", "security_scan"],
    activatedToolNames: ["file", "security_scan"], activatedToolLeases: [], engagedSkillNames: [], relayCapabilities: {}, requiredHostRelays: {}, memoryAccessEnvelope: null,
    researchContextPresentation: null, researchContextRecovery: null,
  } as unknown as NautiloState;
  const sourceRef = describeResearchContextMessage(state, 2)!.ref;
  let reject = false;
  let smaller = false;
  let auditWait = true;
  const provider = spyOn(invocation, "invokeChatModelWithFallback").mockImplementation(async (messages, _tools, model, _user, _agent, _lane, _config, options) => {
    expect(model).toBe(state.model!);
    expect(options?.modelFallbackMode).toBe("none");
    // The first scoped turn receives the workload policy before start has set
    // researchWorkEnabled. A different subagent retains its normal policy.
    expect(options?.firstProgressTimeoutMs).toBe(auditWait ? fromRuntimeConfig().nautilo_research_first_progress_timeout_ms : undefined);
    expect(options?.providerTimeoutMs).toBeUndefined();
    expect(JSON.stringify(messages)).toContain("transient protected instructions");
    if (reject) throw new Error("cancelled-before-success");
    if (smaller) {
      const projected = await options?.recoverContext?.({ messages, modelId: model, contextWindowTokens: 8000,
        maxMessageTokens: 5000, estimatedMessageTokens: 5000, source: "provider" });
      expect(projected).toBeDefined();
      expect(projected!.find((message) => message.id === source.id)?.content).not.toBe(source.content);
    }
    return { modelUsed: model, response: new AIMessage({ content: "Preserve the inspected work before continuing." }) };
  });
  const dispatch = () => runTransientProtectedModelDispatch({ checkpointState: state,
    configuration: { formatVersion: 1, soulFile: "transient protected instructions", memoryBrief: "private runtime memory", skills: [], commands: [], onboardingAnswers: [] },
    prepareModelInput: (transient) => ({ preparedMessages: [new SystemMessage(transient.soulFile), ...state.messages] }), invokeModel: agentNode });
  try {
    const full = await dispatch();
    expect(full.researchContextPresentation?.messageRefs).toContain(sourceRef);
    expect(JSON.stringify(full.researchContextPresentation)).not.toContain("transient protected instructions");
    expect(JSON.stringify(full.researchContextPresentation)).not.toContain("Exact source");
    expect(full).not.toHaveProperty("preparedMessages");
    smaller = true;
    const actual = await dispatch();
    expect(actual.researchContextPresentation?.messageRefs).not.toContain(sourceRef);
    expect(actual.researchContextRecovery?.pendingRefs).toContain(sourceRef);
    reject = true;
    expect(await dispatch().catch((error: unknown) => error)).toEqual(new Error("cancelled-before-success"));
    expect(state.researchContextPresentation).toBeNull();
    expect(state.messages[2]?.content).toBe(source.content);
    auditWait = false; smaller = false; reject = false;
    state.toolWhitelist = ["file"];
    await dispatch();
  } finally {
    provider.mockRestore(); refresh.mockRestore(); row.mockRestore(); clearToolCatalog();
    if (key === undefined) delete process.env["OPENAI_API_KEY"]; else process.env["OPENAI_API_KEY"] = key;
  }
});
