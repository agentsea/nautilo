import { rejects } from "node:assert/strict";
import { afterEach, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { Command, MemorySaver, entrypoint } from "@langchain/langgraph";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { resolveInstance } from "@nautilo/config";
import type { PolicyResolver } from "@nautilo/trust";
import type { RelayLocalExecutionBinding } from "@nautilo/relay";
import type { NautiloState } from "../../src/agent/state";
import { createPostModelNode, type PostModelDeps } from "../../src/nodes/post-model";
import { createToolsNode } from "../../src/nodes/tools";
import { setAgentEventSink } from "../../src/runtime-hooks";
import { runWithCapabilityFundingSession, type CapabilityFundingSession } from "../../src/runtime/capability-funding";
import type { ForegroundChatFundingSession } from "../../src/runtime/foreground-chat-funding";
import { runWithLocalExecutionDelegation, type DelegatedLocalExecutionAdmission, type DelegatedLocalExecutionPort } from "../../src/runtime/local-execution-delegation";
import { setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { createExecCommandTool, createWriteStdinTool } from "../../src/tools/local-execution/local-execution";

afterEach(() => { setRelayRegistry(null); setAgentEventSink(null); clearToolCatalog(); });

function fixture() {
  const catalog = new ToolCatalog();
  for (const factory of [createExecCommandTool, createWriteStdinTool]) {
    catalog.register({ name: factory().name, factory, exposure: "core", category: "development", trustTier: "admin",
      impact: "destructive", executor: "cloud", resultScanPolicy: "never", requiresApproval: true,
      approvalLevel: "prove_it", requiredCapabilities: ["use_workstation"] });
  }
  initToolCatalog(catalog);
  const signal = new AbortController().signal;
  let generation = "generation";
  let source: DelegatedLocalExecutionAdmission = { taskId: "task", taskRunId: "run", signal,
    delegation: { version: 1, humanUserId: "human", agentId: "agent", sourceRoomId: "source-room",
      sourceConversationId: "source-thread", rootTaskId: "task", projectGrantId: "project", ceiling: "basic", profile: null,
      target: { instanceId: resolveInstance().instanceId, relayId: "relay", pairingGeneration: "raw-pairing",
        serverOrigin: "https://server.example", serverFingerprint: "fingerprint" } } };
  const port: DelegatedLocalExecutionPort = { get taskId() { return source.taskId; },
    get taskRunId() { return source.taskRunId; }, signal,
    withAdmission: async (_operation, work) => work({ ...source, delegation: structuredClone(source.delegation) }) };
  const sent: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  let binding: RelayLocalExecutionBinding | undefined;
  setRelayRegistry({
    findByCapabilityForUser: (_capability, userId) => userId === "human" ? ["relay"] : [],
    getCapabilities: () => ({ profile: "desktop-agent", canExecuteLocal: true, canDelegateLocalExecution: true,
      localExecution: { version: 1, generation, pipe: true, pty: true, capacity: 1 } }),
    getUserId: () => "human", getDesktopSessionId: () => "desktop", getProtocolVersion: () => 28,
    getPairingGeneration: () => "raw-pairing", getLocalExecutionPairingGeneration: () => "opaque-pairing",
    getLocalExecutionBinding: (_relayId: string, id: string) => binding?.executionId === id ? binding : null,
    dispatch: async (_relayId, request) => {
      sent.push(request); if (request.localExecutionBinding?.operation === "start") binding = request.localExecutionBinding;
      return { status: "ok", result: { session_id: binding?.executionId, state: "running" } };
    },
  } as ToolRelayRegistry);
  const state = { currentFolder: "", messages: [], approvedToolCalls: [{ id: "call", name: "exec_command", args: { cmd: "printf fixture" }, type: "tool_call" }],
    actorRole: "owner", userId: "agent-owner", causalHumanUserId: "human", personaId: "agent-owner", turnId: "turn",
    agentId: "agent", roomId: "task-room", currentThreadId: "task-thread", langgraphThreadId: "task-thread",
    currentTaskId: "task", currentTaskRunId: "run", activatedToolNames: [], activatedToolLeases: [], engagedSkillNames: [],
    memoryAccessEnvelope: null, relayCapabilities: { canExecuteLocal: true, canDelegateLocalExecution: true },
    trustedExecutionEntrypoint: "background.task", delegatedLocalExecutionBindings: {}, requiredHostRelays: {},
  } as unknown as NautiloState;
  state.messages = [new AIMessage({ content: "", tool_calls: state.approvedToolCalls })];
  const tools = createToolsNode({ delegatedLocalExecutionPortForState: () => port });
  return { state, port, sent, tools, catalog,
    changeGeneration() { generation = "new-generation"; },
    changeProject() { source = { ...source, delegation: { ...source.delegation, projectGrantId: "replacement-project" } }; },
    nextRun() { source = { ...source, taskRunId: "next-run" }; },
  };
}

function makeMockResolver(): PolicyResolver {
  return {
    resolveContext: async () => ({
      laneKey: "", actorId: "", agentId: "", roomId: "", roomType: "", graphThreadId: "",
      actorLabel: "", actorFederatedId: "", agentFederatedId: "",
      speakerTrust: "verified" as const,
      laneScope: "private" as const, actorRole: "owner",
      memoryAccess: { ownerId: "", actorId: "", agentId: "", roomId: "", readableNamespaces: [],
        mutableNamespaces: [], writableNamespaces: [], toolPolicy: {} },
    }),
    buildEnvelope: async () => ({
      toolPolicy: {} as Record<string, "allow" | "read_only" | "require_prove_it" | "forbidden">,
      ownerId: "", actorId: "", agentId: "", roomId: "", readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
    }),
    checkToolAccess: async (_actor, call) => call.name === "ordinary_action"
      ? { type: "require_approval" as const, route: { type: "prove_it" as const, approvers: [] } }
      : { type: "allow" as const },
    routeApproval: async () => ({ type: "prove_it" as const, approvers: [] }),
  };
}


async function park(f: ReturnType<typeof fixture>, suppliedPort: () => DelegatedLocalExecutionPort | undefined = () => f.port,
  overrides: Partial<PostModelDeps> = {}) {
  const node = createPostModelNode(makeMockResolver(), {
    delegatedLocalExecutionPortForState: suppliedPort,
    matchCommandApproval: async () => null,
    createCommandApproval: async () => ({ id: "approval", created: true }),
    ...overrides,
  });
  const workflow = entrypoint({ name: "delegated-approval", checkpointer: new MemorySaver() }, async () => node(f.state));
  const config = { configurable: { thread_id: "delegated-approval" } };
  const pending = await workflow.invoke({}, config);
  return { pending, resume: (verb = "once") => workflow.invoke(new Command({ resume: { approved: true, verb } }), config) };
}

test("one-time approval checkpoints the original Task authority and resumes the same run", async () => {
  const f = fixture(); const flow = await park(f);
  expect(flow.pending).toMatchObject({ __interrupt__: [{ value: { type: "approval_ask" } }] });
  expect(f.sent).toHaveLength(0);
  const result = await flow.resume();
  expect(result.delegatedLocalExecutionBindings?.["call"]).toMatchObject({ version: 4, authority: { taskId: "task", taskRunId: "run" } });
  await f.tools({ ...f.state, ...result });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]?.localExecutionBinding).toMatchObject({ version: 4, owner: { pairingGeneration: "opaque-pairing" },
    authority: { delegation: { target: { pairingGeneration: "raw-pairing" } } } });
  expect(f.sent[0]?.uncontainedHostCommandsSession).toBeUndefined();
});

test("caller-funded Task execution retains its payer fence while using exact delegated local authority", async () => {
  const f = fixture();
  const capability: CapabilityFundingSession = {
    humanUserId: "human",
    parentFundingKind: "personal",
    async resolveModel() { throw new Error("unused"); },
    async openModel() { throw new Error("unused"); },
    async openService() { throw new Error("unused"); },
  };
  const funding: ForegroundChatFundingSession = {
    kind: "personal",
    capabilityFunding: capability,
    async runAttempt() { throw new Error("provider attempt is outside this node test"); },
    async recheckAttempt() {},
  };
  const flow = await runWithCapabilityFundingSession(capability, () => park(f, () => f.port, {
    foregroundChatFundingSession: funding,
  }));
  expect(flow.pending).toMatchObject({ __interrupt__: [{ value: { type: "approval_ask" } }] });
  const approved = await runWithCapabilityFundingSession(capability, () => flow.resume());
  expect(approved.delegatedLocalExecutionBindings?.["call"]).toMatchObject({
    authority: { taskId: "task", taskRunId: "run" },
  });
  const tools = createToolsNode({
    personalFunding: true,
    delegatedLocalExecutionPortForState: () => f.port,
  });
  await runWithCapabilityFundingSession(capability, () => tools({ ...f.state, ...approved }));
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]?.localExecutionBinding).toMatchObject({
    authority: { delegation: { humanUserId: "human", projectGrantId: "project" } },
  });
});

test("project or execution generation changes during approval dispatch nothing", async () => {
  for (const change of ["changeProject", "changeGeneration"] as const) {
    const f = fixture(); const flow = await park(f);
    expect(flow.pending).toMatchObject({ __interrupt__: [{ value: { type: "approval_ask" } }] });
    f[change](); const result = await flow.resume();
    expect(result.approvedToolCalls).toEqual([]);
    await f.tools({ ...f.state, ...result });
    expect(f.sent).toHaveLength(0);
  }
});

test("an explicit absent source cannot borrow ambient Task authority", async () => {
  const f = fixture();
  const approvedFlow = await park(f);
  const approved = await approvedFlow.resume();
  await runWithLocalExecutionDelegation(f.port, async () => {
    await rejects(park(f, () => undefined), /Delegated Task approval source unavailable/);
    const tools = createToolsNode({ delegatedLocalExecutionPortForState: () => undefined });
    await tools({ ...f.state, ...approved });
  });
  expect(f.sent).toHaveLength(0);
});

test("a later recurrence cannot submit input through an earlier run's command pin", async () => {
  const f = fixture(); const flow = await park(f); const approved = await flow.resume();
  await f.tools({ ...f.state, ...approved }); expect(f.sent).toHaveLength(1);
  const pin = f.sent[0]!.localExecutionBinding!;
  f.nextRun();
  await f.tools({ ...f.state, ...approved, currentTaskRunId: "next-run",
    approvedToolCalls: [{ id: "call", name: "write_stdin", args: { session_id: pin.executionId, chars: "again" }, type: "tool_call" }] });
  expect(f.sent).toHaveLength(1);
});

test("delegated command approvals belong to the initiating Human rather than the Genie owner", async () => {
  const f = fixture(); const lookedUp: string[] = []; const createdFor: string[] = [];
  const flow = await park(f, () => f.port, {
    matchCommandApproval: async ({ userId }) => {
      lookedUp.push(userId);
      return userId === "agent-owner" ? { id: "other-human-rule", scope: "server" } : null;
    },
    createCommandApproval: async ({ userId }) => {
      createdFor.push(userId); return { id: "human-rule", created: true };
    },
  });
  expect(flow.pending).toMatchObject({ __interrupt__: [{ value: { type: "approval_ask" } }] });
  expect(lookedUp).toEqual(["human"]);
  await flow.resume("always");
  expect(createdFor).toEqual(["human"]);
  expect(f.sent).toHaveLength(0);
});

test("mixed local and ordinary Task calls share the requesting Human's approval ownership", async () => {
  const f = fixture();
  f.catalog.register({ name: "ordinary_action", factory: () => new DynamicStructuredTool({
    name: "ordinary_action", description: "Synthetic approval probe", schema: z.object({}), func: async () => "ok",
  }), category: "meta", trustTier: "standard", impact: "low", exposure: "core",
  requiresApproval: true, approvalLevel: "confirm" });
  f.state.approvedToolCalls.push({ id: "ordinary", name: "ordinary_action", args: {}, type: "tool_call" });
  f.state.messages = [new AIMessage({ content: "", tool_calls: f.state.approvedToolCalls })];
  const lookedUp: Array<{ userId: string; toolName: string }> = [];
  const created: Array<{ userId: string; toolName: string }> = [];
  const flow = await park(f, () => f.port, {
    matchCommandApproval: async ({ userId, toolName }) => {
      lookedUp.push({ userId, toolName });
      return userId === "agent-owner" ? { id: "other-human-rule", scope: "server" } : null;
    },
    createCommandApproval: async ({ userId, toolName }) => {
      created.push({ userId, toolName }); return { id: "human-rule", created: true };
    },
  });
  expect(flow.pending).toMatchObject({ __interrupt__: [{ value: { type: "approval_ask", userId: "human" } }] });
  expect(lookedUp.sort((a, b) => a.toolName.localeCompare(b.toolName))).toEqual([{ userId: "human", toolName: "exec_command" }, { userId: "human", toolName: "ordinary_action" }]);
  const approved = await flow.resume("always");
  expect(created.sort((a, b) => a.toolName.localeCompare(b.toolName))).toEqual([{ userId: "human", toolName: "exec_command" }, { userId: "human", toolName: "ordinary_action" }]);
  expect(approved.approvedToolCalls?.map(call => call.id).sort()).toEqual(["call", "ordinary"]);
  expect(f.sent).toHaveLength(0);
});


test("ordinary-only approval batches use causal Human only with an exact live delegated Task port", async () => {
  for (const mode of ["exact", "absent", "wrong-task", "wrong-run", "wrong-human", "ambient-denied"] as const) {
    const f = fixture();
    f.catalog.register({ name: "ordinary_action", factory: () => new DynamicStructuredTool({
      name: "ordinary_action", description: "Synthetic approval probe", schema: z.object({}), func: async () => "ok",
    }), category: "meta", trustTier: "standard", impact: "low", exposure: "core", requiresApproval: true, approvalLevel: "confirm" });
    f.state.approvedToolCalls = [{ id: "ordinary", name: "ordinary_action", args: {}, type: "tool_call" }];
    f.state.messages = [new AIMessage({ content: "", tool_calls: f.state.approvedToolCalls })];
    if (mode === "wrong-human") f.state.causalHumanUserId = "other-human";
    const port: DelegatedLocalExecutionPort = mode === "wrong-task" ? { ...f.port, taskId: "other-task" }
      : mode === "wrong-run" ? { ...f.port, taskRunId: "other-run" } : f.port;
    const supplied = () => mode === "absent" || mode === "ambient-denied" ? undefined : port;
    const lookedUp: string[] = []; const saved: string[] = [];
    const work = () => park(f, supplied, {
      matchCommandApproval: async ({ userId }) => { lookedUp.push(userId); return null; },
      createCommandApproval: async ({ userId }) => { saved.push(userId); return { id: "rule", created: true }; },
    });
    if (mode === "wrong-task" || mode === "wrong-run" || mode === "wrong-human") {
      await rejects(work(), /Delegated Task approval source changed/);
      expect(lookedUp).toEqual([]); expect(saved).toEqual([]); continue;
    }
    if (mode === "ambient-denied") {
      await rejects(runWithLocalExecutionDelegation(f.port, work), /Delegated Task approval source unavailable/);
      expect(lookedUp).toEqual([]); expect(saved).toEqual([]); continue;
    }
    const flow = await work();
    const expected = mode === "exact" ? "human" : "agent-owner";
    expect(flow.pending).toMatchObject({ __interrupt__: [{ value: { type: "approval_ask", userId: expected } }] });
    expect(lookedUp).toEqual([expected]); await flow.resume("always"); expect(saved).toEqual([expected]);
  }
});

test("ordinary-only delegated PIN proof and enrollment use the exact requesting Human", async () => {
  const f = fixture();
  f.catalog.register({ name: "ordinary_action", factory: () => new DynamicStructuredTool({
    name: "ordinary_action", description: "Synthetic PIN probe", schema: z.object({}), func: async () => "ok",
  }), category: "meta", trustTier: "standard", impact: "destructive", exposure: "core", requiresApproval: true, approvalLevel: "prove_it" });
  f.state.approvedToolCalls = [{ id: "ordinary", name: "ordinary_action", args: {}, type: "tool_call" }];
  f.state.messages = [new AIMessage({ content: "", tool_calls: f.state.approvedToolCalls })];
  const checked: string[] = [];
  const flow = await park(f, () => f.port, { isPinEnrolled: async userId => { checked.push(userId); return false; } });
  expect(flow.pending).toMatchObject({ __interrupt__: [{ value: { type: "identity_challenge", userId: "human" } }] });
  expect(checked).toEqual(["human"]);
});
