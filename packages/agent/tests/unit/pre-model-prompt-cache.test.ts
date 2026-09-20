import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { setConfigOverrides } from "@nautilo/config";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { SECURITY_SCAN_INITIAL_LANES } from "@nautilo/types";
import { preModelNode } from "../../src/nodes/pre-model";
import { browserDecisionHandoffMessage, browserDecisionPlanSchema } from "../../src/graph/browser-decision";
import { createFileTool } from "../../src/tools/file/file-tool";
import { buildFileEditsBlock, buildTwoPathBlock, HTML_WORKSPACE_RICH_ARTIFACT_PROMPT } from "../../src/prompts/templates";
import { SECURITY_RESEARCH_WORKFLOW } from "../../src/tools/security/research-protocol";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import { registerAllTools } from "../../src/tools/register-all";
import {
  resetConnectedWebAccountReadToolRuntimeForTests,
  setConnectedWebAccountReadToolRuntime,
} from "../../src/tools/connected-web-accounts/runtime";

beforeAll(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
});

afterEach(() => resetConnectedWebAccountReadToolRuntimeForTests());

function stateFor(model: string, overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    messages: [new HumanMessage("hello")],
    threadId: 0,
    langgraphThreadId: "",
    model,
    userId: "owner-1",
    personaId: "owner",
    voiceMode: false,
    source: "tui",
    assistantName: "Genie",
    soulFile: "",
    memoryBrief: "",
    memoryDelta: "",
    currentThreadId: "",
    preparedMessages: [],
    toolNames: [],
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "agent-genie",
    roomId: "",
    roomRoster: [],
    approvalDenied: false,
    turnId: "",
    explicitlySelected: false,
    currentFolder: "",
    currentFolderRelayId: "",
    workspacePath: "",
    activeMiniApp: null,
    artifactRefs: [],
    userTimezone: "UTC",
    previousUserMessageAt: null,
    securityAuditClientMeta: null,
    toolWhitelist: undefined,
    activatedToolNames: [],
    relayCapabilities: undefined,
    subagentDepth: 0,
    subagentMaxDepth: MAX_SUBAGENT_DEPTH,
    suppressToolLifecycleEvents: false,
    subagentRun: false,
    taskRun: false,
    skills: [],
    engagedSkillNames: [],
    awaitResponse: false,
    awaitRoomId: "",
    awaitFromUserIds: [],
    awaitTaskId: "",
    awaitTaskRunId: "",
    awaitOwnerId: "",
    ...overrides,
  };
}

async function systemMessageFor(state: NautiloState): Promise<SystemMessage> {
  const patch = await preModelNode(state);
  const first = patch.preparedMessages?.[0];
  if (!(first instanceof SystemMessage)) {
    throw new Error(`Expected a leading SystemMessage, received ${first?.constructor.name ?? "nothing"}.`);
  }
  return first;
}

function expectCachedStablePrefix(message: SystemMessage): {
  stable: string;
  volatile: string;
} {
  expect(Array.isArray(message.content)).toBe(true);
  const blocks = message.content as Array<Record<string, unknown>>;
  expect(blocks.length).toBeGreaterThanOrEqual(1);
  expect(blocks[0]).toEqual({
    type: "text",
    text: expect.any(String),
    cache_control: { type: "ephemeral" },
  });
  for (const block of blocks.slice(1)) {
    expect(block).toEqual({ type: "text", text: expect.any(String) });
  }
  const textOf = (block: Record<string, unknown> | undefined): string =>
    typeof block?.["text"] === "string" ? block["text"] : "";
  return {
    stable: textOf(blocks[0]),
    volatile: blocks.slice(1).map(textOf).join(""),
  };
}

describe(" OpenRouter Claude prompt caching", () => {
  test.each(["openrouter:deepseek/deepseek-v4.1-flash", "anthropic:claude-sonnet-4-6"])(
    "%s retains delegated provenance after verification without changing the leading system prompt", async (model) => {
      const observation = { version: 1 as const, snapshot: "Draft prepared", refs: {}, pageUrl: "https://example.test/",
        browserSessionId: "test-browser", observationId: "after-edit" };
      const messages = [new HumanMessage("Prepare a draft without saving."),
        new AIMessage({ content: "", tool_calls: [{ id: "last-observation", name: "browser_snapshot", args: {} }] }),
        new ToolMessage({ name: "browser_snapshot", tool_call_id: "last-observation", content: JSON.stringify(observation) })];
      const handoff = browserDecisionHandoffMessage(messages, {
        turnId: "delegated-turn", modelId: "openrouter:typesafe/jev-1.13", phase: "handoff", reason: "completion_ready",
        plan: browserDecisionPlanSchema.parse({ goal: "Prepare the draft" }), pending: null, observation,
        lastAction: { toolCallId: "edit", description: "Fill the requested field", beforeObservationId: "before-edit", execution: "executed" },
      });
      const source = stateFor(model, { turnId: "delegated-turn", messages: [...messages, handoff], browserDecision: null });
      const before = await preModelNode(source);
      const verified = await preModelNode({ ...source, promptTimeReference: before.promptTimeReference ?? null,
        messages: [...source.messages,
          new AIMessage({ content: "", tool_calls: [{ id: "verify", name: "browser_read_page", args: {} }] }),
          new ToolMessage({ name: "browser_read_page", tool_call_id: "verify", content: "Draft verified; no saved receipt." })] });
      expect(verified.preparedMessages?.[0]?.content).toEqual(before.preparedMessages?.[0]?.content);
      expect(JSON.stringify(verified.preparedMessages?.[0]?.content)).not.toContain("Runtime browser supervision");
      const receipt = verified.preparedMessages?.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === "last-observation");
      expect(receipt?.content).toContain('"handoffReason":"completion_ready"');
      expect(receipt?.content).toContain('"decisionModelId":"openrouter:typesafe/jev-1.13"');
      expect(verified.preparedMessages?.at(-1)?.content).toBe("Draft verified; no saved receipt.");
      expect(source.messages.at(-1)).toBe(handoff);
    },
  );

  test("OpenAI handoffs preserve the preceding prompt and their instruction role", async () => {
    const state = stateFor("openai:gpt-5.6-sol", {
      turnId: "browser-turn",
      messages: [
        new HumanMessage("Adjust the equipment control and verify the saved value."),
        new AIMessage({ content: "", tool_calls: [{ id: "observe", name: "browser_snapshot", args: {} }] }),
        new ToolMessage({ name: "browser_snapshot", tool_call_id: "observe", content: "Current control value: 6" }),
      ],
    });
    const before = await preModelNode(state);
    const original = JSON.stringify(state.messages);
    const handoff = new SystemMessage({ id: "handoff", content: "Routine browser control returned: inspect fresh evidence and revise the plan." });
    const after = await preModelNode({ ...state, promptTimeReference: before.promptTimeReference ?? null,
      messages: [...state.messages, handoff] });
    expect(after.preparedMessages?.slice(0, -1).map(message => message.content))
      .toEqual(before.preparedMessages?.map(message => message.content));
    expect(after.preparedMessages?.at(-1)).toBeInstanceOf(SystemMessage);
    expect(after.preparedMessages?.at(-1)?.content).toBe(handoff.content);
    expect(JSON.stringify(state.messages)).toBe(original);
    expect(after.preparedStableSystemPrefixLength).toBe(before.preparedStableSystemPrefixLength);
  });

  test.each(["anthropic:claude-sonnet-4-6", "openrouter:anthropic/claude-sonnet-4.6"])(
    "%s retains later instructions in its required leading system prompt", async (model) => {
      const handoffText = "Routine browser control returned: inspect fresh evidence.";
      const patch = await preModelNode(stateFor(model, {
        messages: [new HumanMessage("Continue the browser task."), new SystemMessage(handoffText)],
      }));
      expect(patch.preparedMessages?.filter(message => SystemMessage.isInstance(message))).toHaveLength(1);
      expect(JSON.stringify(patch.preparedMessages?.[0]?.content)).toContain(handoffText);
    },
  );

  test("resumed state retains authored Soul and Skill bodies", async () => {
    const state = stateFor("openai:gpt-5.6-luna", {
      soulFile: "STALE_SOUL_SECRET",
      skills: [{
        id: "skill-1",
        name: "authored",
        description: "description",
        body: "STALE_SKILL_SECRET",
        requiresTools: [],
      }],
      engagedSkillNames: ["authored"],
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "call-authored",
            name: "view_skill",
            args: { name: "authored" },
          }],
        }),
        new ToolMessage({
          name: "view_skill",
          tool_call_id: "call-authored",
          content: "## Skill: authored\n\nSTALE_ENGAGED_SKILL_SECRET",
        }),
        new HumanMessage("hello"),
      ],
    });
    const patch = await preModelNode(
      state,
      undefined,
      undefined,
      undefined,
      true,
    );
    const serializedPrompt = JSON.stringify(patch.preparedMessages);
    expect(serializedPrompt).toContain("STALE_SOUL_SECRET");
    expect(serializedPrompt).toContain("STALE_SKILL_SECRET");
    expect(serializedPrompt).toContain("STALE_ENGAGED_SKILL_SECRET");
    expect(JSON.stringify(patch.messages)).toContain(
      "STALE_ENGAGED_SKILL_SECRET",
    );
  });

  test("keeps current Reflection Memory reconstruction outside the content-free boundary", async () => {
    const first = await preModelNode(
      stateFor("openai:gpt-5.6-luna", {
        memoryBrief: "first private Reflection brief",
        memoryDelta: "first private Reflection delta",
      }),
    );
    const second = await preModelNode(
      stateFor("openai:gpt-5.6-luna", {
        memoryBrief: "different private Reflection brief",
        memoryDelta: "different private Reflection delta",
      }),
    );
    const firstSystem = first.preparedMessages?.[0];
    const secondSystem = second.preparedMessages?.[0];
    expect(firstSystem).toBeInstanceOf(SystemMessage);
    expect(secondSystem).toBeInstanceOf(SystemMessage);
    expect(typeof firstSystem?.content).toBe("string");
    expect(typeof secondSystem?.content).toBe("string");

    const firstBoundary = first.preparedStableSystemPrefixLength;
    const secondBoundary = second.preparedStableSystemPrefixLength;
    expect(firstBoundary).toBeGreaterThan(0);
    expect(secondBoundary).toBe(firstBoundary);
    const firstText = firstSystem?.content as string;
    const secondText = secondSystem?.content as string;
    expect(firstText.slice(0, firstBoundary)).toBe(secondText.slice(0, secondBoundary));
    expect(firstText.slice(0, firstBoundary)).not.toContain("private Reflection");
    expect(firstText.slice(firstBoundary)).toContain("first private Reflection brief");
    expect(firstText.slice(firstBoundary)).toContain("first private Reflection delta");
    expect(secondText.slice(secondBoundary)).toContain("different private Reflection brief");
    expect(secondText.slice(secondBoundary)).toContain("different private Reflection delta");
  });

  test("marks the exact stable block for direct Anthropic", async () => {
    const message = await systemMessageFor(stateFor("anthropic:claude-sonnet-4-6"));
    const content = expectCachedStablePrefix(message);

    expect(content.stable.length).toBeGreaterThan(0);
    expect(content.volatile).toContain("## Current time");
  });

  test("gives OpenRouter-routed Claude the identical stable cache block", async () => {
    const direct = expectCachedStablePrefix(
      await systemMessageFor(stateFor("anthropic:claude-sonnet-4-6", { memoryBrief: "direct turn" })),
    );
    const routed = expectCachedStablePrefix(
      await systemMessageFor(stateFor("openrouter:anthropic/claude-sonnet-4.6", { memoryBrief: "routed turn" })),
    );

    expect(routed.stable).toBe(direct.stable);
    expect(direct.volatile).toContain("direct turn");
    expect(routed.volatile).toContain("routed turn");
  });

  test("leaves a non-Anthropic OpenRouter route as one unmarked string", async () => {
    const message = await systemMessageFor(stateFor("openrouter:openai/gpt-5.6-sol"));

    expect(typeof message.content).toBe("string");
    expect(message.content).not.toContain("cache_control");
  });

  test("does not extend the marker to an unqualified Venice Claude route", async () => {
    const message = await systemMessageFor(stateFor("venice:claude-sonnet-4-6"));

    expect(typeof message.content).toBe("string");
    expect(message.content).not.toContain("cache_control");
  });
});

describe(" connected website prompt inventory", () => {
  test("injects the authorized account outside the stable prompt cache", async () => {
    setConnectedWebAccountReadToolRuntime({
      listAvailable: async () => [{
        label: "console.nebius.com",
        service: "Nebius Cloud",
        origin: "https://console.nebius.com",
        status: "connected",
      }],
      read: async () => ({ ok: false, code: "unavailable", recovery: "none" }),
    });

    const message = await systemMessageFor(stateFor("anthropic:claude-sonnet-4-6", {
      roomId: "room-personal",
      memoryAccessEnvelope: {} as never,
    }));
    const content = expectCachedStablePrefix(message);

    expect(content.stable).not.toContain("console.nebius.com");
    expect(content.volatile).toContain("### Connected websites");
    expect(content.volatile).toContain("console.nebius.com");
    expect(content.volatile).toContain("read_connected_web_account");
    expect(content.volatile).toContain("run_website_task");
    expect(content.volatile).toContain("without a second authorization");
  });
});


test("research history projects checkpointed cycles without replacing the canonical graph messages", async () => {
  const author = { taskId: "10000000-0000-4000-8000-000000000001",
    taskRunId: "10000000-0000-4000-8000-000000000002", modelId: null };
  const original = [new HumanMessage("Audit the complete requested scope."),
    new AIMessage({ content: "", tool_calls: [{ id: "old-source", name: "file", args: { command: "read", path: "auth.ts" } }] }),
    new ToolMessage({ name: "file", tool_call_id: "old-source", content: JSON.stringify({ content: "source".repeat(150000) }) }),
    new AIMessage({ content: "", tool_calls: [{ id: "saved-checkpoint", name: "security_scan",
      args: { version: "security-scan-v1", operation: "record", action: "append", entry: { kind: "checkpoint" } } }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: "saved-checkpoint", content: JSON.stringify({
      ok: true, operation: "record", result: { record: { id: "checkpoint-one", revision: 1,
        createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z", createdBy: author, updatedBy: author,
        entry: { kind: "checkpoint", summary: "Auth inspected; source notes saved.",
          nextWork: "Trace the importer.", openRecordIds: ["importer-review"], evidenceRefs: [] } }, codeEvidence: [] },
    }) })];
  setConfigOverrides({ nautilo_token_budget_fraction: 0.1 });
  try {
    const patch = await preModelNode(stateFor("anthropic:claude-sonnet-4-6", {
      messages: original, subagentRun: true, taskRun: true, toolWhitelist: ["security_scan", "file"],
    }));
    expect(patch.messages).toBe(original);
    expect(patch.messages).toHaveLength(5);
    expect(patch.preparedMessages?.some((message) => ToolMessage.isInstance(message)
      && message.tool_call_id === "old-source")).toBe(false);
    expect(patch.preparedMessages?.some((message) => ToolMessage.isInstance(message)
      && message.tool_call_id === "saved-checkpoint")).toBe(true);
    const prepared = JSON.stringify(patch.preparedMessages);
    expect(prepared).toContain("[RESEARCH RELOAD]");
    expect(prepared).toContain("recordIds");
    expect(prepared).not.toContain("[MEMORY SAVE]");

    // A fresh oversized receipt can activate recovery while the earlier
    // checkpoint still supplies RESEARCH RELOAD guidance. Both instructions
    // must agree that nextWork/file reads wait for recovery to finish.
    const freshSource = new ToolMessage({ name: "file", tool_call_id: "fresh-source",
      content: JSON.stringify({ content: "unconsolidated source".repeat(30_000) }) });
    const recoveringMessages = [...original,
      new AIMessage({ content: "Inspect the pending importer.", tool_calls: [{ id: "fresh-source", name: "file",
        args: { command: "read", path: "importer.ts", zone: "current" } }] }), freshSource];
    const recovering = await preModelNode(stateFor("anthropic:claude-sonnet-4-6", {
      messages: recoveringMessages, subagentRun: true, taskRun: true, toolWhitelist: ["security_scan", "file"],
      currentTaskId: author.taskId, currentTaskRunId: author.taskRunId,
    }));
    expect(recovering.messages).toBe(recoveringMessages);
    expect(recovering.researchContextRecovery).not.toBeNull();
    const recoveryPrompt = JSON.stringify(recovering.preparedMessages);
    expect(recoveryPrompt).toContain("[RESEARCH RELOAD]");
    expect(recoveryPrompt).toContain("[RESEARCH CONTEXT RECOVERY]");
    expect(recoveryPrompt).toContain("follow its requiredAction and allowed operations first");
    expect(recoveryPrompt).toContain("Reconcile its nextWork and openRecordIds with the active workspace objective");
    expect(recoveryPrompt).toContain("During active context recovery, follow its requiredAction and allowed operations first");
    expect(recoveryPrompt).toContain("without workspace instructions, continue the original research brief");
    expect(recoveryPrompt).not.toContain("Re-read cited source windows when needed;");
  } finally { setConfigOverrides({}); }
});

test("final research synthesis discloses budget-based conclusion projection without rewriting canonical pages", async () => {
  const author = { taskId: "10000000-0000-4000-8000-000000000001",
    taskRunId: "10000000-0000-4000-8000-000000000002", modelId: null };
  const page = (id: string, final: boolean, offset = 0) => [
    new AIMessage({ content: "", tool_calls: [{ id, name: "security_scan",
      args: { version: "security-scan-v1", operation: "results", category: "all", finalize: true } }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: id, content: JSON.stringify({
      ok: true, operation: "results", result: {
        version: "security-scan-v1", status: { version: "security-scan-v1", scanId: "scan_test", state: "completed",
          phase: null, terminalState: "completed", mode: "deep_research", modelId: "openai:test", modelState: "completed",
          completedSteps: 2, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [] },
        observations: [], codeEvidence: [], nextCursor: final ? null : "next", reportReady: final,
        records: final ? [] : Array.from({ length: 24 }, (_, index) => ({
          id: `finding-${offset + index}`, revision: 1, createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z",
          createdBy: author, updatedBy: author, entry: { kind: "finding", title: `Export authority ${index}`,
            summary: "The worker trusts stale project authority. ".repeat(40), confidence: "high",
            impact: "A former member can retrieve private documents. ".repeat(35),
            exploitPreconditions: "An export was queued before access was revoked. ".repeat(35),
            evidenceRefs: [{ kind: "code_evidence", id: "code-auth" }], counterevidenceRefs: [] },
        })),
      },
    }) }),
  ];
  const original = [new HumanMessage("Synthesize the complete audit."),
    ...Array.from({ length: 10 }, (_, index) => page(`earlier-conclusions-${index}`, false, index * 24)).flat(),
    ...page("final-page", true)];
  const canonical = JSON.stringify(original);
  setConfigOverrides({ nautilo_token_budget_fraction: 0.1 });
  try {
    const patch = await preModelNode(stateFor("anthropic:claude-sonnet-4-6", {
      messages: original, subagentRun: true, taskRun: true, toolWhitelist: ["security_scan", "file"],
    }));
    expect(patch.messages).toBe(original);
    expect(JSON.stringify(original)).toBe(canonical);
    const prepared = JSON.stringify(patch.preparedMessages);
    expect(prepared.includes("[FINAL RESEARCH CONTEXT]")).toBe(true);
    expect(prepared).toContain("Label the final prose an overview");
    expect(prepared).toContain("Never infer severity counts");
    expect(prepared).toContain("complete accepted review log is appended");
    expect(prepared).toContain("finding-239");
    expect(prepared).toContain("recordIds");
    expect(prepared).toContain("fullConclusionsOutsideWindow");
    expect(prepared).toContain("status, reportReady and nextCursor under finalPage");
    expect(prepared).toContain("recordIds:[one needed id], limit:1, finalize:false");
    expect(prepared).toContain("Do not replay the oversized full page");
  } finally { setConfigOverrides({}); }
});


describe("restricted security Task system workflow", () => {
  beforeAll(async () => { await activateModelCatalogForTests(["openrouter:z-ai/glm-5.3"]); });
  afterAll(() => resetRuntimeModelCatalog());
  const systemText = (message: SystemMessage) => typeof message.content === "string" ? message.content
    : message.content.map((part) => typeof part === "string" ? part
      : part.type === "text" && typeof part["text"] === "string" ? part["text"] : "").join("");

  for (const model of ["openrouter:z-ai/glm-5.3", "anthropic:claude-sonnet-4-6", "openrouter:anthropic/claude-sonnet-4.6"]) {
    test(`${model} receives workflow in the leading system message without changing canonical source or the stable prefix`, async () => {
      const original = [new HumanMessage("Investigate the complete requested scope."),
        new AIMessage({ content: "", tool_calls: [{ id: "source-window", name: "file", args: { command: "read", path: "src/entry.js" } }] }),
        new ToolMessage({ name: "file", tool_call_id: "source-window", content: JSON.stringify({ content: "export function allowed(principal) { return principal.active; }" }) })];
      const canonical = JSON.stringify(original);
      const shared = { messages: original, taskRun: true, toolWhitelist: ["security_scan", "file"] };
      const baseline = await preModelNode(stateFor(model, { ...shared, subagentRun: false }));
      const patch = await preModelNode(stateFor(model, { ...shared, subagentRun: true }));
      const leading = patch.preparedMessages?.[0];
      const baselineLeading = baseline.preparedMessages?.[0];
      expect(leading).toBeInstanceOf(SystemMessage);
      expect(baselineLeading).toBeInstanceOf(SystemMessage);
      const text = systemText(leading as SystemMessage);
      const baselineText = systemText(baselineLeading as SystemMessage);
      expect(text.split(SECURITY_RESEARCH_WORKFLOW)).toHaveLength(2);
      expect(baselineText.includes(SECURITY_RESEARCH_WORKFLOW)).toBe(false);
      const boundary = patch.preparedStableSystemPrefixLength!;
      expect(boundary).toBe(baseline.preparedStableSystemPrefixLength!);
      expect(text.slice(0, boundary)).toBe(baselineText.slice(0, boundary));
      expect(text.indexOf(SECURITY_RESEARCH_WORKFLOW)).toBeGreaterThanOrEqual(boundary);
      if (model.includes("anthropic")) {
        const blocks = expectCachedStablePrefix(leading as SystemMessage);
        expect(blocks.stable).toBe(expectCachedStablePrefix(baselineLeading as SystemMessage).stable);
        expect(blocks.volatile.includes(SECURITY_RESEARCH_WORKFLOW)).toBe(true);
      }
      expect(patch.messages).toBe(original);
      expect(JSON.stringify(original)).toBe(canonical);
      const source = patch.preparedMessages?.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === "source-window");
      expect(source?.content).toBe(original[2]!.content);
      expect(patch.preparedMessages?.slice(1).some((message) => typeof message.content === "string"
        && message.content.includes(SECURITY_RESEARCH_WORKFLOW))).toBe(false);
    });
  }

  test("file prompt guidance matches the existing research read-only schema without changing ordinary write-capable Tasks", async () => {
    for (const research of [true, false]) {
      const state = stateFor("openrouter:z-ai/glm-5.3", {
        subagentRun: true, taskRun: true, toolWhitelist: research ? ["file", "security_scan"] : ["file"],
        currentFolder: "/authorized/source", workspacePath: "/authorized/workspace",
        messages: [new HumanMessage("Inspect the authorized source."),
          new AIMessage({ content: "", tool_calls: [{ id: "read-source", name: "file", args: { command: "read", zone: "current", path: "src/auth.js" } }] }),
          new ToolMessage({ name: "file", tool_call_id: "read-source", status: "success", content: "Exact source and provenance remain available." })],
      });
      const canonical = JSON.stringify(state.messages);
      const tool = createFileTool(state);
      expect(tool.schema.safeParse({ command: "read", zone: "current", path: "src/auth.js" }).success).toBe(true);
      expect(tool.schema.safeParse({ command: "write", zone: "workspace", path: "report.html", content: "<html></html>" }).success).toBe(!research);
      const patch = await preModelNode(state);
      const text = systemText(patch.preparedMessages![0] as SystemMessage);
      expect(patch.toolNames).toContain("file");
      expect(text).toContain(tool.description);
      expect(text).toContain(buildTwoPathBlock({ currentFolder: state.currentFolder, workspacePath: state.workspacePath, securityResearchReadOnly: research }));
      if (research) {
        expect(text).toContain(state.currentFolder);
        expect(text).not.toContain("**YOUR WORKSPACE**");
        expect(text).not.toContain("Always read/write-accessible");
        expect(text).not.toContain('If they give you an absolute path, use `zone="absolute"`');
      } else {
        expect(text).toContain(buildTwoPathBlock({ currentFolder: state.currentFolder, workspacePath: state.workspacePath }));
      }
      for (const zone of ["workspace", "absolute"]) {
        expect(tool.schema.safeParse({ command: "read", zone, path: "src/auth.js" }).success).toBe(!research);
      }
      expect(text.includes(buildFileEditsBlock())).toBe(!research);
      expect(text.includes(HTML_WORKSPACE_RICH_ARTIFACT_PROMPT)).toBe(!research);
      expect(patch.preparedMessages?.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === "read-source")?.content).toBe(state.messages[2]!.content);
      expect(JSON.stringify(state.messages)).toBe(canonical);
    }
  });

  for (const [label, overrides] of [
    ["ordinary Room", { subagentRun: false, taskRun: false }],
    ["ordinary Room with security tool", { subagentRun: false, taskRun: false, toolWhitelist: ["security_scan", "file"] }],
    ["nonsecurity Task", { subagentRun: true, taskRun: true, toolWhitelist: ["file"] }],
  ] as const) {
    test(`${label} does not receive the security workflow`, async () => {
      const original = [new HumanMessage("Complete the requested work.")];
      const canonical = JSON.stringify(original);
      const patch = await preModelNode(stateFor("anthropic:claude-sonnet-4-6", {
        ...overrides, toolWhitelist: "toolWhitelist" in overrides ? [...overrides.toolWhitelist] : undefined, messages: original,
      }));
      expect(patch.preparedMessages?.[0]).toBeInstanceOf(SystemMessage);
      expect(systemText(patch.preparedMessages![0] as SystemMessage).includes(SECURITY_RESEARCH_WORKFLOW)).toBe(false);
      expect(JSON.stringify(original)).toBe(canonical);
      expect(patch.messages).toEqual(original);
    });
  }
});


for (const phaseModel of ["openai:gpt-5.6-sol", "anthropic:claude-sonnet-4-6"]) {
test(`${phaseModel}: pre-eviction phase rebuilds only tool guidance, preserves volatile context and permits notes before a later checkpoint`, async () => {
  const { captureResearchContextPresentation, isResearchPreEvictionConsolidating } = await import("../../src/tools/security/research-context-rollover");
  const { createSecurityScanTool, projectSecurityResearchConsolidationTools } = await import("../../src/tools/security/security-scan");
  const { createComputerHostContractTool } = await import("../../src/tools/computer/computer-host-contract");
  const { activeComputerUseModelGuidanceForBoundTools } = await import("../../src/config/computer-use-catalogue/host-tool-admission");
  const { estimateTokenCount } = await import("../../src/utils/history-manager");
  const { estimateBoundToolTokens } = await import("../../src/utils/chat-model-invocation");
  const models = await import("../../src/providers/models");
  const notifications = await import("../../src/notifications/session-notifications");
  const limits = spyOn(models, "resolveModelExecutionLimits").mockImplementation(async (modelId) => ({ modelId, catalogVersion: null,
    contextTokens: 49152, maxOutputTokens: 8192, contextSource: "override", outputSource: "override" }));
  const drain = spyOn(notifications, "drainSessionNotifications").mockResolvedValue([{ id: "notification", threadId: "thread", agentId: "agent-genie",
    kind: "reject", patchId: "patch", absolutePath: "/authorized/notification-marker.js", createdAt: new Date("2026-09-08"), drainedAt: null }]);
  const state = stateFor(phaseModel, { subagentRun: true, taskRun: true, toolWhitelist: ["file", "security_scan", "computer_observe"],
    activatedToolNames: ["file", "security_scan"], relayCapabilities: { canReadWorkspace: true, canUseComputer: true },
    currentTaskId: "11111111-1111-4111-8111-111111111111", currentTaskRunId: "22222222-2222-4222-8222-222222222222",
    currentFolder: "/authorized/source", workspacePath: "/authorized/workspace", soulFile: "VOLATILE_PROTECTED_CANARY", langgraphThreadId: "thread",
    messages: [new HumanMessage("Audit the source."), new AIMessage({ id: "read-old", content: "", tool_calls: [{ id: "old", name: "file", args: { command: "read", path: "auth.js", zone: "current" } }] }),
      new ToolMessage({ id: "old-receipt", name: "file", tool_call_id: "old", status: "success", content: "" })] });
  const text = (message: SystemMessage) => typeof message.content === "string" ? message.content
    : message.content.map((part) => typeof part === "string" ? part : part.type === "text" ? String(part["text"]) : "").join("");
  try {
    const baseline = await preModelNode(state);
    const fullTools = [createFileTool(state), createSecurityScanTool(), createComputerHostContractTool("computer_observe")];
    const computerGuidance = activeComputerUseModelGuidanceForBoundTools(fullTools);
    expect(computerGuidance).not.toBe("");
    expect(baseline.toolNames).toContain("computer_observe");
    expect(text(baseline.preparedMessages![0] as SystemMessage).split(computerGuidance)).toHaveLength(2);
    const fraction = (await import("@nautilo/config")).fromRuntimeConfig().nautilo_token_budget_fraction;
    const allowance = Math.floor(49152 * fraction) - estimateBoundToolTokens(fullTools);
    const source = "s".repeat(Math.max(1, allowance - estimateTokenCount(baseline.preparedMessages!) - 1000) * 4);
    state.messages[2] = new ToolMessage({ ...(state.messages[2] as ToolMessage), content: source });
    const prior = await preModelNode(state);
    expect(prior.researchContextRecovery).toBeNull();
    state.researchContextPresentation = captureResearchContextPresentation(state, prior.preparedMessages!);
    state.messages.push(new AIMessage({ id: "read-new", content: "", tool_calls: [{ id: "new", name: "file", args: { command: "read", path: "routes.js", zone: "current" } }] }),
      new ToolMessage({ id: "new-receipt", name: "file", tool_call_id: "new", status: "success", content: "UNSEEN\n".repeat(20000) }));
    const canonical = JSON.stringify(state.messages);
    const entered = await preModelNode(state);
    expect(entered.toolNames).toEqual(["security_scan"]);
    expect(isResearchPreEvictionConsolidating({ ...state, ...entered })).toBe(true);
    expect(entered.preparedMessages!.find((message) => message.id === "old-receipt")?.content).toBe(source);
    const system = text(entered.preparedMessages![0] as SystemMessage);
    expect(system.split("VOLATILE_PROTECTED_CANARY")).toHaveLength(2);
    expect(system).not.toContain(createFileTool(state).description);
    expect(system).not.toContain(computerGuidance);
    expect(system.slice(0, entered.preparedStableSystemPrefixLength)).toContain(createSecurityScanTool(true).description);
    expect(estimateTokenCount(entered.preparedMessages!)).toBeLessThanOrEqual(Math.floor(49152 * fraction) - estimateBoundToolTokens(projectSecurityResearchConsolidationTools(fullTools, true)));
    expect(JSON.stringify(state.messages)).toBe(canonical);
    expect(drain).not.toHaveBeenCalled();
    // A tighter provider allowance can exit the retained-workspace phase before
    // any checkpoint is accepted. The rebuilt full tool prefix must restore the
    // signed CUA guidance while preserving the already resolved volatile suffix.
    limits.mockImplementation(async (modelId) => ({ modelId, catalogVersion: null,
      contextTokens: 32768, maxOutputTokens: 8192, contextSource: "override", outputSource: "override" }));
    const resized = await preModelNode({ ...state, researchContextRecovery: entered.researchContextRecovery! });
    expect(isResearchPreEvictionConsolidating({ ...state, ...resized })).toBe(false);
    expect(resized.toolNames).toContain("computer_observe");
    const resizedSystem = text(resized.preparedMessages![0] as SystemMessage);
    expect(resizedSystem.slice(0, resized.preparedStableSystemPrefixLength).split(computerGuidance)).toHaveLength(2);
    expect(resizedSystem.split("VOLATILE_PROTECTED_CANARY")).toHaveLength(2);
    expect(estimateTokenCount(resized.preparedMessages!)).toBeLessThanOrEqual(Math.floor(32768 * fraction) - estimateBoundToolTokens(fullTools));
    expect(JSON.stringify(state.messages)).toBe(canonical);
    limits.mockImplementation(async (modelId) => ({ modelId, catalogVersion: null,
      contextTokens: 49152, maxOutputTokens: 8192, contextSource: "override", outputSource: "override" }));
    state.researchContextRecovery = entered.researchContextRecovery!;
    const author = { taskId: state.currentTaskId!, taskRunId: state.currentTaskRunId!, modelId: state.model! };
    const save = (kind: "evidence" | "checkpoint", accepted = true) => {
      const id = `save-${state.messages.length}`;
      const entry = kind === "checkpoint" ? { kind, summary: "Saved the inspected authentication behavior and its open checks.", nextWork: "Read the exact withheld routes next.", openRecordIds: [], evidenceRefs: [] }
        : { kind, summary: "Material analysis of authentication guards and unresolved entry paths. ".repeat(12), evidenceRefs: [] };
      state.messages.push(new AIMessage({ id, content: "", tool_calls: [{ id, name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry } }] }),
        new ToolMessage({ id: `receipt-${id}`, name: "security_scan", tool_call_id: id, status: accepted ? "success" : "error", content: JSON.stringify(accepted
          ? { ok: true, operation: "record", result: { codeEvidence: [], record: { id, revision: 1, entry, createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" } } }
          : { ok: false, operation: "record", error: { code: "invalid_request", message: "Correct the checkpoint fields." } }) }));
    };
    save("evidence");
    save("checkpoint", false);
    const correction = await preModelNode(state);
    expect(isResearchPreEvictionConsolidating({ ...state, ...correction })).toBe(true);
    expect(correction.preparedMessages!.find((message) => message.id === "old-receipt")?.content).toBe(source);
    expect(correction.preparedMessages!.at(-1)?.content).toContain("Correct the checkpoint fields");
    state.researchContextRecovery = correction.researchContextRecovery!;
    save("checkpoint");
    const after = await preModelNode(state);
    expect(after.toolNames).toContain("file");
    expect(isResearchPreEvictionConsolidating({ ...state, ...after })).toBe(false);
    expect(after.researchContextRecovery?.pendingRefs).toHaveLength(1);
    expect(text(after.preparedMessages![0] as SystemMessage)).toContain(createFileTool(state).description);
    await preModelNode(stateFor("openai:gpt-5.6-sol", { langgraphThreadId: "thread", messages: [new HumanMessage("Continue.")] }));
    expect(drain).toHaveBeenCalledTimes(1);
  } finally { limits.mockRestore(); drain.mockRestore(); }
});

}
