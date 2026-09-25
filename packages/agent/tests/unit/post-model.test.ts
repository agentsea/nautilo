import { afterEach, describe, test, expect } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import {
  buildAskPayload,
  createPostModelNode,
  interruptToolEntry,
} from "../../src/nodes/post-model";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH, NautiloStateAnnotation } from "../../src/agent/state";
import type { PolicyResolver, ToolAccessDecision } from "@nautilo/trust";
import type { PostModelDeps } from "../../src/nodes/post-model";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";
import type { ProjectionSnapshot } from "../../src/tools/memory/projection-sharing";
import { setOrdinaryHostResolver } from "../../src/runtime/ordinary-host-resolver";

afterEach(() => {
  clearToolCatalog();
  setOrdinaryHostResolver(null);
});

// M037 — unit tests must never touch Postgres. These stubs replace the
// real DB command-approval engine. `NO_MATCH` makes every `ask`/`auto`
// candidate fall through to the interrupt; `ALWAYS_MATCH` simulates a
// standing rule matching every call.
const NO_MATCH: PostModelDeps = {
  matchCommandApproval: async () => null,
  createCommandApproval: async () => ({ id: "stub", created: true }),
};
const ALWAYS_MATCH: PostModelDeps = {
  matchCommandApproval: async () => ({ id: "rule-1", scope: "server" as const }),
  createCommandApproval: async () => ({ id: "stub", created: true }),
};

function makeState(messages: NautiloState["messages"]): NautiloState {
  return {
    messages,
    threadId: 0,
    langgraphThreadId: "",
    model: null,
    userId: "test-owner",
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
    agentId: "",
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
  };
}

function makeMockResolver(
  decisions: Record<string, ToolAccessDecision>,
): PolicyResolver {
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
    checkToolAccess: async (_actorId, tool) =>
      decisions[tool.name] ?? { type: "allow" as const },
    routeApproval: async () => ({ type: "prove_it" as const, approvers: [] }),
  };
}

function registerUnavailableResearchTool(): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "run_deep_research",
    isAvailable: () => false,
    unavailableReason: "Deep research requires Tavily. Configure it and retry. No research was started.",
    factory: () => new DynamicStructuredTool({
      name: "run_deep_research",
      description: "Test deep research tool",
      schema: z.object({}),
      func: async () => "must not run",
    }),
    category: "research",
    trustTier: "high",
    impact: "high",
    exposure: "core",
    requiresApproval: true,
    requiredCapabilities: ["use_research_tools"],
  });
  initToolCatalog(catalog);
}

// ===========================================================================
// Without resolver (fail-closed — rejects all tool calls)
// ===========================================================================

describe("postModelNode (no resolver)", () => {
  const node = createPostModelNode(null);

  test("rejects all tool calls when no resolver is present (fail-closed)", async () => {
    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [
        { id: "tc1", name: "search_memory", args: { query: "test" } },
        { id: "tc2", name: "transcribe_audio", args: { path: "/tmp/x.wav", zone: "workspace" } },
      ],
    });

    const result = await node(makeState([new HumanMessage("test"), aiMsg]));

    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.pendingApproval).toHaveLength(0);
  });

  test("returns empty for no tool calls", async () => {
    const aiMsg = new AIMessage({ content: "Just text" });
    const result = await node(makeState([new HumanMessage("test"), aiMsg]));

    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.pendingApproval).toHaveLength(0);
  });

  test("returns empty for non-AI last message", async () => {
    const result = await node(makeState([new HumanMessage("test")]));

    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.pendingApproval).toHaveLength(0);
  });

  test("returns empty for empty messages", async () => {
    const result = await node(makeState([]));

    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.pendingApproval).toHaveLength(0);
  });
});

describe("server prerequisite admission", () => {
  test("an authorized stale call receives actionable prerequisite recovery", async () => {
    registerUnavailableResearchTool();
    const call = { id: "research-unavailable", name: "run_deep_research", args: {}, type: "tool_call" as const };
    const result = await createPostModelNode(
      makeMockResolver({ run_deep_research: { type: "allow" } }),
      NO_MATCH,
    )(makeState([new AIMessage({ content: "", tool_calls: [call] })]));

    expect(result.approvedToolCalls).toEqual([]);
    const refusal = result.messages?.at(-1) as ToolMessage;
    expect(refusal.content).toContain("requires Tavily");
    expect(refusal.content).toContain("No research was started");
    expect(refusal.status).toBe("error");
  });

  test("a denied actor does not learn which server prerequisite is missing", async () => {
    registerUnavailableResearchTool();
    const call = { id: "research-denied", name: "run_deep_research", args: {}, type: "tool_call" as const };
    const result = await createPostModelNode(
      makeMockResolver({ run_deep_research: { type: "forbidden", reason: "actor denied" } }),
      NO_MATCH,
    )(makeState([new AIMessage({ content: "", tool_calls: [call] })]));

    const refusal = result.messages?.at(-1) as ToolMessage;
    expect(refusal.content).toContain("do not have permission");
    expect(refusal.content).not.toContain("Tavily");
    expect(refusal.status).toBe("error");
  });

  test("a whitelist denial takes precedence over prerequisite recovery", async () => {
    registerUnavailableResearchTool();
    const call = { id: "research-not-whitelisted", name: "run_deep_research", args: {}, type: "tool_call" as const };
    const state = makeState([new AIMessage({ content: "", tool_calls: [call] })]);
    state.toolWhitelist = [];
    const result = await createPostModelNode(
      makeMockResolver({ run_deep_research: { type: "allow" } }),
      NO_MATCH,
    )(state);

    const refusal = result.messages?.at(-1) as ToolMessage;
    expect(refusal.content).toContain("do not have permission");
    expect(refusal.content).not.toContain("Tavily");
    expect(refusal.status).toBe("error");
  });
});

describe("D563 run_shell long-wait approval intent", () => {
  test("rejects an invalid timeout reason before a prove_it interrupt", async () => {
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, NO_MATCH);
    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{
          id: "timeout-rejected",
          name: "run_shell",
          args: { command: "sudo apt update", timeout_seconds: 3600, timeout_reason: "   " },
        }],
      }),
    ]);

    const result = await node(state);
    expect(result.approvedToolCalls).toEqual([]);
    const refusal = result.messages?.at(-1) as ToolMessage;
    const refusalText = typeof refusal.content === "string"
      ? refusal.content
      : JSON.stringify(refusal.content);
    expect(refusalText).toContain("Pass a non-empty timeout_reason");
  });

  test("adds typed long-wait intent to ask and prove_it approval payloads", async () => {
    const tc = {
      id: "timeout-approved",
      name: "run_shell",
      args: {
        command: "bun test",
        timeout_seconds: 3600,
        timeout_reason: "slow",
      },
    };
    const expected = { timeoutSeconds: 3600, reason: "slow" };
    const entry = await interruptToolEntry(tc, makeState([]));
    expect(entry.runShellTimeout).toEqual(expected);
    expect(entry.args).not.toHaveProperty("timeout_reason");

    const payload = buildAskPayload([{
      tc,
      approval: {
        verb: "ask",
        reason: "Shell execution needs approval.",
        severity: "destructive-medium",
      },
    }], "test-owner");
    expect(payload.tools[0]?.runShellTimeout).toEqual(expected);
    expect(payload.tools[0]?.args).not.toHaveProperty("timeout_reason");
  });

  test("preserves the credential-redaction boundary for typed long-wait intent", async () => {
    const entry = await interruptToolEntry({
      id: "timeout-redaction",
      name: "run_shell",
      args: {
        command: "bun test",
        timeout_seconds: 3600,
        timeout_reason: "wait for Bearer Ab3_Cd4-Ef5_Gh6-Ij7_Kl8-Mn9_Op0-Qr1_St2",
      },
    }, makeState([]));
    expect(entry.runShellTimeout?.reason).toContain("Bearer [redacted]");
    expect(entry.runShellTimeout?.reason).not.toContain("Ab3_Cd4-Ef5_Gh6-Ij7_Kl8-Mn9_Op0-Qr1_St2");
  });
});

// ===========================================================================
// With resolver — policy-aware routing
// ===========================================================================

describe("postModelNode (with resolver)", () => {
  test("corrects scheduled requester self-contact before approval and preserves a sibling call", async () => {
    const call = { id: "self-reminder", name: "ask_peer", args: {
      peer_handle: "requester_example",
      message_to_peer: "Your reminder is due.",
      return_instructions: "Confirm delivery; no reply is needed.",
    } };
    const state = makeState([new AIMessage({ content: "", tool_calls: [
      call,
      { id: "read-sibling", name: "search_memory", args: { query: "context" } },
    ] })]);
    state.taskRun = true;
    state.subagentRun = true;
    state.trustedExecutionEntrypoint = "background.task";
    let checked = 0;
    const result = await createPostModelNode(makeMockResolver({
      ask_peer: { type: "require_approval", route: { type: "prove_it", approvers: ["test-owner"] } },
      search_memory: { type: "allow" },
    }), {
      ...NO_MATCH,
      isRedundantScheduledSelfContact: async (_state, candidate) => {
        checked += 1;
        return candidate.id === call.id;
      },
    })(state);

    expect(checked).toBe(1);
    expect(result.approvedToolCalls?.map((entry) => entry.id)).toEqual(["read-sibling"]);
    expect(result.approvalDenied).toBe(true);
    const correction = result.messages?.at(-1) as ToolMessage;
    expect(correction.tool_call_id).toBe(call.id);
    expect(correction.content).toContain("No separate message was sent");
    expect(correction.content).toContain("final answer");
    expect(correction.content).not.toContain("denied by owner");
  });

  test("approved tools go to approvedToolCalls", async () => {
    const resolver = makeMockResolver({
      search_memory: { type: "allow" },
      run_web_search: { type: "read_only" },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [
        { id: "tc1", name: "search_memory", args: {} },
        { id: "tc2", name: "run_web_search", args: {} },
      ],
    });

    const result = await node(makeState([aiMsg]));

    expect(result.approvedToolCalls).toHaveLength(2);
    expect(result.pendingApproval).toHaveLength(0);
  });

  test("D476: open-Room projection proves identity even when policy and workstation override allow it", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const resolver = makeMockResolver({ share_memory: { type: "allow" } });
    let workstationCalls = 0;
    const node = createPostModelNode(resolver, {
      ...NO_MATCH,
      resolveWorkstationApprovalOverride: () => {
        workstationCalls += 1;
        return { override: "auto", executionClass: "profile_bound_sandbox" };
      },
    });
    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{
        id: "project-open",
        name: "share_memory",
        args: {
          mode: "project",
          source_memory_ids: ["private-memory"],
          proposed_content: "Public-safe statement.",
          target_room_name: "pub-room",
        },
      }],
    });
    const state = makeState([aiMsg]);
    state.langgraphThreadId = "d476-open";
    state.activatedToolNames = ["share_memory"];
    state.projectionSnapshots = [{
      toolCallId: "project-open",
      requesterUserId: "test-owner",
      requesterActorId: "test-actor",
      agentId: "test-agent",
      sourceFingerprints: [{ id: "private-memory", contentHash: "hash" }],
      content: "Public-safe statement.",
      contentHash: "content-hash",
      destination: {
        roomId: "destination-room",
        namespaceId: "destination-namespace",
        label: "pub-room",
        kind: "open",
        memberCount: 2,
        audienceFingerprint: "audience-hash",
      },
      audienceFingerprint: "audience-hash",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      creationKey: "projection:550e8400-e29b-41d4-a716-446655440020",
    } satisfies ProjectionSnapshot];

    let interrupted = false;
    try { await node(state); } catch { interrupted = true; }
    expect(interrupted).toBe(true);
    expect(workstationCalls).toBe(0);
  });

  test("D476: preflight rejection ToolMessages do not strand a valid projection sibling", async () => {
    const node = createPostModelNode(makeMockResolver({ share_memory: { type: "allow" } }), NO_MATCH);
    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [
        { id: "valid", name: "share_memory", args: { mode: "project" } },
        { id: "rejected", name: "share_memory", args: { mode: "project" } },
      ],
    });
    const state = makeState([
      aiMsg,
      new ToolMessage({
        name: "share_memory",
        tool_call_id: "rejected",
        content: "Choose a Room first.",
      }),
    ]);
    state.projectionRejectedToolCallIds = ["rejected"];
    state.projectionSnapshots = [{
      toolCallId: "valid",
      requesterUserId: "test-owner",
      requesterActorId: "test-actor",
      agentId: "test-agent",
      sourceFingerprints: [{ id: "private-memory", contentHash: "hash" }],
      content: "Safe text.",
      contentHash: "content-hash",
      destination: {
        roomId: "destination-room",
        namespaceId: "destination-namespace",
        label: "closed-room",
        kind: "group",
        memberCount: 2,
        audienceFingerprint: "audience-hash",
      },
      audienceFingerprint: "audience-hash",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      creationKey: "projection:550e8400-e29b-41d4-a716-446655440021",
    } satisfies ProjectionSnapshot];

    const result = await node(state);
    expect(result.approvedToolCalls).toHaveLength(1);
    expect(result.approvedToolCalls?.[0]?.id).toBe("valid");
  });

  test("require_approval with high-severity command → prove_it interrupt (throws outside graph)", async () => {
    // `sudo apt update` is classified high-severity by the command scanner,
    // which maps to prove_it at `standard` level (D061 verb matrix).
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "sudo apt update" } }],
    });

    const state = makeState([aiMsg]);
    state.actorRole = "owner";
    state.threadId = 51; // M-1: resolveLaneKey fails closed without it
    let threw = false;
    try { await node(state); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("non-executable run_shell is forbidden before prove_it (catalog snapshot gate)", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);

    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "whoami" } }],
    });

    const state = makeState([aiMsg]);
    state.actorRole = "household";
    state.memoryAccessEnvelope = {
      ownerId: "household-user",
      actorId: "actor-household",
      agentId: "agent-genie",
      roomId: "room-household",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: { run_shell: "forbidden" },
    };

    const result = await node(state);

    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.approvalDenied).toBe(true);
    const rawContent = result.messages?.at(-1)?.content;
    const content = typeof rawContent === "string"
      ? rawContent
      : JSON.stringify(rawContent);
    expect(content).toContain("not available");
  });

  test("require_approval with critical command → BLOCK (no interrupt, D061 behavior change)", async () => {
    // `rm -rf /` is critical severity → verb map returns "block".
    // Critical patterns must not prompt for approval — they emit a
    // denial ToolMessage directly. This is a deliberate D061 semantics
    // change from the prior "any require_approval → interrupt" flow.
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "rm -rf /" } }],
    });

    const state = makeState([aiMsg]);
    state.actorRole = "owner";
    state.threadId = 50; // resolveLaneKey fails closed without one (M-1)
    const result = await node(state);

    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.approvalDenied).toBe(true);
    expect(result.messages).toBeDefined();
    expect(result.messages!.length).toBeGreaterThan(state.messages.length);
    // The denial message content should mention the block reason.
    const lastMsg = result.messages![result.messages!.length - 1]!;
    const content = typeof lastMsg.content === "string"
      ? lastMsg.content
      : JSON.stringify(lastMsg.content);
    expect(content).toContain("blocked");
  });

  test("require_approval with medium-severity command → approval_ask interrupt (throws outside graph)", async () => {
    // `npm install -g typescript` is medium severity → ask at standard level.
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "npm install -g typescript" } }],
    });

    const state = makeState([aiMsg]);
    state.actorRole = "owner";
    state.threadId = 52; // M-1: resolveLaneKey fails closed without it
    let threw = false;
    try { await node(state); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("capabilityless read-only approval reaches confirm-style ask without executing", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "play_explainer",
      factory: () => new DynamicStructuredTool({
        name: "play_explainer",
        description: "Resolve an explainer after explicit confirmation.",
        schema: z.object({ explainerId: z.string() }),
        func: async () => "resolved explainer",
      }),
      category: "help",
      trustTier: "guest",
      impact: "read-only",
      exposure: "core",
      requiresApproval: true,
      approvalLevel: "confirm",
      resultScanPolicy: "never",
    });
    initToolCatalog(catalog);

    for (const decision of [
      { approved: false, verb: "deny" as const, expectedExecutions: 0 },
      { approved: true, verb: "once" as const, expectedExecutions: 1 },
    ]) {
      let executions = 0;
      const resolver = makeMockResolver({
        play_explainer: {
          type: "require_approval",
          route: { type: "prove_it", approvers: ["owner-id"] },
        },
      });
      const graph = new StateGraph(NautiloStateAnnotation)
        .addNode("post_model", createPostModelNode(resolver, NO_MATCH))
        .addNode("tools_like", (graphState) => {
          executions += graphState.approvedToolCalls.length;
          return {};
        })
        .addEdge(START, "post_model")
        .addEdge("post_model", "tools_like")
        .addEdge("tools_like", END)
        .compile({ checkpointer: new MemorySaver() });
      const state = makeState([
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "play-explainer-call",
            name: "play_explainer",
            args: { explainerId: "intro" },
          }],
        }),
      ]);
      state.threadId = 54;
      const config = {
        configurable: { thread_id: `capabilityless-approval-${decision.verb}` },
      };

      const parked = await graph.invoke(state, config) as Awaited<
        ReturnType<typeof graph.invoke>
      > & { __interrupt__?: Array<{ value?: unknown }> };
      expect(parked).toMatchObject({
        __interrupt__: [{ value: { type: "approval_ask" } }],
      });
      expect(executions).toBe(0);

      await graph.invoke(new Command({ resume: {
        approved: decision.approved,
        verb: decision.verb,
      } }), config);
      expect(executions).toBe(decision.expectedExecutions);
    }

    const standingState = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{
          id: "play-explainer-standing",
          name: "play_explainer",
          args: { explainerId: "intro" },
        }],
      }),
    ]);
    standingState.threadId = 55;
    const standingResult = await createPostModelNode(makeMockResolver({
      play_explainer: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    }), ALWAYS_MATCH)(standingState);
    expect(standingResult.approvedToolCalls).toHaveLength(1);
  });

  test("capabilityless prove_it cannot be satisfied by standing or workstation approval", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "capabilityless_delete",
      factory: () => new DynamicStructuredTool({
        name: "capabilityless_delete",
        description: "Delete a synthetic connected-app record.",
        schema: z.object({ recordId: z.string() }),
        func: async () => "deleted",
      }),
      category: "meta",
      trustTier: "standard",
      impact: "destructive",
      exposure: "core",
      requiresApproval: true,
      approvalLevel: "prove_it",
      resultScanPolicy: "never",
    });
    initToolCatalog(catalog);

    let standingCalls = 0;
    let workstationCalls = 0;
    const resolver = makeMockResolver({
      capabilityless_delete: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const graph = new StateGraph(NautiloStateAnnotation)
      .addNode("post_model", createPostModelNode(resolver, {
        matchCommandApproval: async () => {
          standingCalls += 1;
          return { id: "standing-rule", scope: "server" as const };
        },
        resolveWorkstationApprovalOverride: () => {
          workstationCalls += 1;
          return { override: "auto", executionClass: "profile_bound_sandbox" };
        },
        isPinEnrolled: async () => true,
      }))
      .addEdge(START, "post_model")
      .addEdge("post_model", END)
      .compile({ checkpointer: new MemorySaver() });
    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{
          id: "capabilityless-delete-call",
          name: "capabilityless_delete",
          args: { recordId: "record-1" },
        }],
      }),
    ]);
    state.threadId = 56;

    const parked = await graph.invoke(state, {
      configurable: { thread_id: "capabilityless-prove-it-floor" },
    }) as Awaited<ReturnType<typeof graph.invoke>> & {
      __interrupt__?: Array<{ value?: unknown }>;
    };

    expect(parked).toMatchObject({
      __interrupt__: [{ value: {
        type: "prove_it_challenge",
        tools: [{ id: "capabilityless-delete-call", name: "capabilityless_delete" }],
      } }],
    });
    expect(standingCalls).toBe(0);
    expect(workstationCalls).toBe(0);
  });

  test("require_approval with external binary → approval_ask interrupt (throws outside graph)", async () => {
    // `./install.sh` has no scanner hit but fires the external-binary
    // heuristic → ask at standard level regardless.
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "./install.sh" } }],
    });

    const state = makeState([aiMsg]);
    state.actorRole = "owner";
    state.threadId = 53; // M-1: resolveLaneKey fails closed without it
    let threw = false;
    try { await node(state); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("forbidden tools create ToolMessages and route back to LLM", async () => {
    const resolver = makeMockResolver({
      run_shell: { type: "forbidden", reason: "strangers cannot use shell" },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "run_shell", args: {} }],
    });

    const state = makeState([aiMsg]);
    const result = await node(state);

    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.pendingApproval).toHaveLength(0);
    expect(result.approvalDenied).toBe(true);
    expect(result.messages).toBeDefined();
    expect(result.messages!.length).toBeGreaterThan(state.messages.length);
  });

  test("mixed batch: approved tools pass, pending trigger interrupt (throws outside graph)", async () => {
    const resolver = makeMockResolver({
      search_memory: { type: "read_only" },
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner"] },
      },
      update_config: { type: "forbidden", reason: "no access" },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [
        { id: "tc1", name: "search_memory", args: {} },
        { id: "tc2", name: "run_shell", args: {} },
        { id: "tc3", name: "update_config", args: {} },
      ],
    });

    const state = makeState([aiMsg]);
    state.threadId = 54; // M-1: resolveLaneKey fails closed without it
    let threw = false;
    try { await node(state); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("approvalDenied is false when all tools approved", async () => {
    const resolver = makeMockResolver({
      search_memory: { type: "allow" },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "search_memory", args: {} }],
    });

    const result = await node(makeState([aiMsg]));

    expect(result.approvalDenied).toBe(false);
  });

  test("approvalDenied is false when no resolver", async () => {
    const node = createPostModelNode(null);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "search_memory", args: {} }],
    });

    const result = await node(makeState([aiMsg]));

    expect(result.approvalDenied).toBe(false);
  });

  test("approvalDenied is false for non-tool messages", async () => {
    const node = createPostModelNode(null);
    const result = await node(makeState([new HumanMessage("hello")]));

    expect(result.approvalDenied).toBe(false);
    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.pendingApproval).toHaveLength(0);
  });

  test("matching standing approval bypasses the ask interrupt (M037)", async () => {
    // Benign medium-severity command — verb would be "ask" normally. With
    // a matching standing approval (DB matcher returns a row), it
    // auto-approves without firing the dialog.
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, ALWAYS_MATCH);

    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "npm install react" } }],
      }),
    ]);
    state.threadId = 42;

    const result = await node(state);

    expect(result.approvedToolCalls).toHaveLength(1);
    expect(result.approvalDenied).toBe(false);
  });

  test("M037 records an auto-approval callback on match", async () => {
    const calls: Array<{ scope: string; toolName: string }> = [];
    const deps: PostModelDeps = {
      matchCommandApproval: async () => ({ id: "rule-x", scope: "room" as const }),
      recordAutoApproval: (info) => calls.push({ scope: info.scope, toolName: info.toolName }),
    };
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, deps);
    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "ls /a/b" } }],
      }),
    ]);
    state.threadId = 43;
    const result = await node(state);
    expect(result.approvedToolCalls).toHaveLength(1);
    expect(calls).toEqual([{ scope: "room", toolName: "run_shell" }]);
  });

  test("SECURITY: standing approval does NOT bypass scanner-critical (rm -rf /)", async () => {
    // Even when the matcher would match every call (ALWAYS_MATCH), a
    // critical command resolves to "block" and the matcher is never
    // consulted for it — the safety backstop.
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, ALWAYS_MATCH);

    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "rm -rf /" } }],
      }),
    ]);
    state.threadId = 100;

    const result = await node(state);

    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.approvalDenied).toBe(true);
  });

  test("SECURITY: standing approval does NOT bypass prove_it (sudo = high severity)", async () => {
    // sudo resolves to prove_it; the matcher (ALWAYS_MATCH) is never
    // consulted on the prove_it path, so the PIN gate still fires.
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, ALWAYS_MATCH);

    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "sudo apt update" } }],
      }),
    ]);
    state.threadId = 101;

    // prove_it interrupt fires, throws outside a graph context.
    let threw = false;
    try { await node(state); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("anonymous turn (no userId) skips the matcher and falls to ask", async () => {
    // userId === "" → the matcher is never invoked (fail-closed). Use a
    // matcher that would throw if called, to prove it isn't.
    const deps: PostModelDeps = {
      matchCommandApproval: async () => {
        throw new Error("matcher must not be called for anonymous turns");
      },
    };
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, deps);
    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "npm install react" } }],
      }),
    ]);
    state.userId = "";
    state.threadId = 2;
    // ask interrupt fires (no matcher) → throws outside graph context.
    let threw = false;
    try { await node(state); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("uses actorId from memoryAccessEnvelope when available", async () => {
    let capturedActorId = "";
    const resolver: PolicyResolver = {
      ...makeMockResolver({}),
      checkToolAccess: async (actorId) => {
        capturedActorId = actorId;
        return { type: "allow" as const };
      },
    };
    const node = createPostModelNode(resolver, NO_MATCH);

    const state = makeState([
      new AIMessage({ content: "", tool_calls: [{ id: "tc1", name: "search_memory", args: {} }] }),
    ]);
    state.memoryAccessEnvelope = {
      ownerId: "owner-1",
      actorId: "specific-actor-id",
      agentId: "",
      roomId: "",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: {},
    };

    await node(state);

    expect(capturedActorId).toBe("specific-actor-id");
  });

  // ===========================================================================
  // M-1 (PR #58 follow-up): resolveLaneKey fails closed on missing threadId
  // ===========================================================================

  test("M-1: pending-approval call with no threadId THROWS (fail-closed)", async () => {
    // Previously, a state missing both langgraphThreadId and a positive
    // numeric threadId would resolve to the sentinel string "lane-unknown".
    // All orphan-lane approvals would collide into one shared bucket —
    // a silent cross-user privilege escalation. M-1 replaces the sentinel
    // with a fail-closed throw.
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "ls" } }],
      }),
    ]);
    // makeState already sets threadId: 0 and langgraphThreadId: "" —
    // exactly the fail-closed case.

    let caught: Error | null = null;
    try {
      await node(state);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("resolveLaneKey");
    expect(caught!.message).toContain("lane key");
  });

  test("M-1: read-only-only tool calls do NOT throw even without threadId", async () => {
    // If nothing goes to the `pending` bucket (all tools are allow /
    // read_only), the lane key is never needed. The node must not
    // throw just because threadId happens to be absent on a read-only
    // path — that'd break legitimate requests.
    const resolver = makeMockResolver({
      search_memory: { type: "read_only" },
      run_web_search: { type: "allow" },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "tc1", name: "search_memory", args: {} },
          { id: "tc2", name: "run_web_search", args: {} },
        ],
      }),
    ]);
    // threadId: 0, langgraphThreadId: "" — same fail-closed state as
    // the previous test, but no pending-approval tools.

    const result = await node(state);
    expect(result.approvedToolCalls).toHaveLength(2);
    expect(result.approvalDenied).toBe(false);
  });

  // ===========================================================================
  // M-5 (PR #58 follow-up): session-store bypass works in the `auto` anomaly branch
  // ===========================================================================

  test("M037: standing rule bypasses ask even in the auto-anomaly branch", async () => {
    // Scenario: trust says require_approval (forced via mock), verb map
    // says auto (low-impact tool at standard). The anomaly branch consults
    // the DB matcher; a matching standing rule short-circuits to
    // auto-approve instead of escalating to ask.
    //
    // We initialize a minimal test catalog so the verb map sees an
    // impact of "low" (vs the default "destructive" fallback when
    // catalog is null).
    const { ToolCatalog, initToolCatalog } = await import("@nautilo/catalog");
    const { DynamicStructuredTool } = await import("@langchain/core/tools");
    const { z } = await import("zod");
    const catalog = new ToolCatalog();
    catalog.register({
      name: "manage_memory",
      factory: () =>
        new DynamicStructuredTool({
          name: "manage_memory",
          description: "stub",
          schema: z.object({ action: z.string() }),
          func: () => Promise.resolve("ok"),
        }),
      category: "knowledge",
      trustTier: "standard",
      impact: "low", // → verb map returns auto at standard
      exposure: "core",
      tags: [],
      resultScanPolicy: "never",
    });
    initToolCatalog(catalog);

    const resolver = makeMockResolver({
      manage_memory: {
        // Force trust to disagree with the verb map — this is the
        // anomaly case (trust=require_approval but verbMap=auto).
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, ALWAYS_MATCH);

    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc1", name: "manage_memory", args: { action: "save" } }],
      }),
    ]);
    state.threadId = 55;

    const result = await node(state);

    // No interrupt — standing rule auto-approved in the auto-anomaly branch.
    expect(result.approvedToolCalls).toHaveLength(1);
    expect(result.approvalDenied).toBe(false);
  });

  test("M-1: langgraphThreadId alone is sufficient (happy path)", async () => {
    const resolver = makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, NO_MATCH);

    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc1", name: "run_shell", args: { command: "ls" } }],
      }),
    ]);
    state.langgraphThreadId = "lg-abc-123";
    // threadId stays 0 — langgraph id takes precedence.

    // Throws on interrupt (outside a real graph context), NOT on
    // resolveLaneKey — that's the signal the lane resolved fine.
    let caught: Error | null = null;
    try {
      await node(state);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    // If this message were about resolveLaneKey, M-1 regressed.
    expect(caught!.message).not.toContain("resolveLaneKey");
  });
});

// ===========================================================================
// D418 task 3.2.5 — Full Workstation approval override seam (Pass 2)
//
// The post-model consults an injected `resolveWorkstationApprovalOverride`
// dep for each `ask` / `prove_it` / `auto`-anomaly candidate BEFORE batching.
// `auto` ⇒ approve (suppress the prompt); `none` ⇒ existing verb-map path.
// `block` is never overridable; anonymous turns never consult the resolver;
// a resolver throw is swallowed + treated as `none`.
// ===========================================================================

describe("postModelNode (D418 Full Workstation override seam)", () => {
  // Medium-severity shell command → verb map "ask" at standard level.
  const ASK_COMMAND = "npm install -g typescript";
  // High-severity shell command → verb map "prove_it" at standard level.
  const PROVE_IT_COMMAND = "sudo apt update";
  // Critical shell command → verb map "block" (hard policy stop).
  const BLOCK_COMMAND = "rm -rf /";

  function requireApprovalResolver(): PolicyResolver {
    return makeMockResolver({
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
  }

  function askState(command: string) {
    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc1", name: "run_shell", args: { command } }],
      }),
    ]);
    state.threadId = 700;
    return state;
  }

  function autoDecision() {
    return { override: "auto" as const, executionClass: "profile_bound_sandbox" as const };
  }
  function noneDecision() {
    return {
      override: "none" as const,
      executionClass: "profile_bound_sandbox" as const,
      reason: "no_active_session" as const,
      detail: "no active Full Workstation session",
    };
  }

  test("eligible Full Mode overrides `ask` → auto-approves (no interrupt, no matcher)", async () => {
    const deps: PostModelDeps = {
      // A matcher that would throw if consulted — the override must
      // short-circuit BEFORE the standing-approval matcher runs.
      matchCommandApproval: async () => {
        throw new Error("matcher must not be consulted when override=auto");
      },
      resolveWorkstationApprovalOverride: () => autoDecision(),
    };
    const node = createPostModelNode(requireApprovalResolver(), deps);
    const result = await node(askState(ASK_COMMAND));
    expect(result.approvedToolCalls).toHaveLength(1);
    expect(result.approvalDenied).toBe(false);
  });

  test("eligible Full Mode overrides `prove_it` → auto-approves (no PIN interrupt)", async () => {
    const deps: PostModelDeps = {
      matchCommandApproval: async () => null,
      resolveWorkstationApprovalOverride: () => autoDecision(),
    };
    const node = createPostModelNode(requireApprovalResolver(), deps);
    // sudo → prove_it; without the override this throws (prove_it interrupt
    // outside a graph context). With override=auto it approves cleanly.
    const result = await node(askState(PROVE_IT_COMMAND));
    expect(result.approvedToolCalls).toHaveLength(1);
    expect(result.approvalDenied).toBe(false);
  });

  test("`none` leaves `ask` intact (approval_ask interrupt fires)", async () => {
    const deps: PostModelDeps = {
      matchCommandApproval: async () => null,
      resolveWorkstationApprovalOverride: () => noneDecision(),
    };
    const node = createPostModelNode(requireApprovalResolver(), deps);
    let threw = false;
    try {
      await node(askState(ASK_COMMAND));
    } catch {
      threw = true;
    }
    // ask interrupt throws outside a graph context — normal approval runs.
    expect(threw).toBe(true);
  });

  test("no-session `none` leaves `prove_it` intact (prove_it interrupt fires)", async () => {
    const deps: PostModelDeps = {
      matchCommandApproval: async () => null,
      resolveWorkstationApprovalOverride: () => noneDecision(),
    };
    const node = createPostModelNode(requireApprovalResolver(), deps);
    let threw = false;
    try {
      await node(askState(PROVE_IT_COMMAND));
    } catch {
      threw = true;
    }
    // prove_it interrupt throws outside a graph context — normal PIN path runs.
    expect(threw).toBe(true);
  });

  test("SECURITY: `block` (critical) is NOT overridable — resolver never consulted", async () => {
    // The resolver throws if called. The block path must not consult it,
    // and must still deny the critical command.
    const deps: PostModelDeps = {
      matchCommandApproval: async () => null,
      resolveWorkstationApprovalOverride: () => {
        throw new Error("resolver must not be consulted for block verbs");
      },
    };
    const node = createPostModelNode(requireApprovalResolver(), deps);
    const result = await node(askState(BLOCK_COMMAND));
    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.approvalDenied).toBe(true);
    // The denial message surfaces the block reason (not the resolver error).
    const lastMsg = result.messages![result.messages!.length - 1]!;
    const content = typeof lastMsg.content === "string"
      ? lastMsg.content
      : JSON.stringify(lastMsg.content);
    expect(content).toContain("blocked");
  });

  test("SECURITY: anonymous turn (no userId) never consults the resolver", async () => {
    // If the resolver WERE consulted it would return auto and the tool
    // would be approved (no interrupt). Because the turn is anonymous,
    // the resolver is skipped and the ask interrupt fires instead.
    const deps: PostModelDeps = {
      matchCommandApproval: async () => null,
      resolveWorkstationApprovalOverride: () => autoDecision(),
    };
    const node = createPostModelNode(requireApprovalResolver(), deps);
    const state = askState(ASK_COMMAND);
    state.userId = "";
    let threw = false;
    try {
      await node(state);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("SECURITY: resolver throw is swallowed → treated as `none` (fail-closed)", async () => {
    const deps: PostModelDeps = {
      matchCommandApproval: async () => null,
      resolveWorkstationApprovalOverride: () => {
        throw new Error("resolver-boom");
      },
    };
    const node = createPostModelNode(requireApprovalResolver(), deps);
    let caught: Error | null = null;
    try {
      await node(askState(ASK_COMMAND));
    } catch (e) {
      caught = e as Error;
    }
    // The ask interrupt throws (normal approval runs); the resolver error
    // must NOT propagate — that would be a widening surface.
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain("resolver-boom");
  });

  test("override=auto still lets a read-only / approved tool pass through (no regression)", async () => {
    // The override only applies to `pending` (require_approval) tools;
    // Pass 1 allow / read_only tools are approved before the resolver runs.
    const resolverCalls: string[] = [];
    const resolver: PolicyResolver = makeMockResolver({
      search_memory: { type: "read_only" },
      run_shell: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const deps: PostModelDeps = {
      matchCommandApproval: async () => null,
      resolveWorkstationApprovalOverride: (req) => {
        resolverCalls.push(req.toolCall.name);
        return autoDecision();
      },
    };
    const node = createPostModelNode(resolver, deps);
    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "tc1", name: "search_memory", args: {} },
          { id: "tc2", name: "run_shell", args: { command: ASK_COMMAND } },
        ],
      }),
    ]);
    state.threadId = 701;
    const result = await node(state);
    expect(result.approvedToolCalls).toHaveLength(2);
    expect(result.approvalDenied).toBe(false);
    // The resolver is consulted ONLY for the require_approval tool.
    expect(resolverCalls).toEqual(["run_shell"]);
  });
});

// ===========================================================================
// D516 — semantic computer-use admission is outside generic approval.
// These tools intentionally remain unregistered until the catalog cutover,
// while the exact Electron-enforced binding carrier is tested here.
// ===========================================================================

describe("postModelNode (D516 semantic computer-use admission)", () => {
  function installTestCatalog(_toolName: string) {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => true, mediaGenerationAvailable: () => true });
    initToolCatalog(catalog);
  }

  function computerState(toolName = "computer_observe") {
    installTestCatalog(toolName);
    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "computer-call-1", name: toolName, args: {} }],
      }),
    ]);
    state.userId = "human-1";
    state.agentId = "agent-1";
    state.activatedToolNames = [toolName];
    state.causalHumanUserId = "human-1";
    state.trustedExecutionEntrypoint = "foreground.main";
    state.verifiedOrdinaryOrigin = {
      kind: "local_electron",
      userId: "human-1",
      actorId: "human-1",
      relayId: "relay-1",
      desktopSessionId: "session-1",
      pairingGeneration: "pairing-1",
      requestId: "request-1",
    };
    state.desktopAutomationProvenance = {
      originHumanId: "human-1",
      originRunId: "run-1",
      originAgentId: "agent-1",
      lineageId: "lineage-1",
      installationEpoch: "epoch-1",
      grantGeneration: 1,
    };
    state.desktopAutomationRouteBinding = {
      version: 2,
      provider: "cua",
      providerGeneration: "provider-generation-1",
      grantGeneration: 1,
    };
    return state;
  }

  function computerPolicy(): PolicyResolver {
    return makeMockResolver({
      computer_observe: { type: "require_approval", route: { type: "prove_it", approvers: ["owner-id"] } },
      computer_do: { type: "require_approval", route: { type: "prove_it", approvers: ["owner-id"] } },
      computer_unknown: { type: "require_approval", route: { type: "prove_it", approvers: ["owner-id"] } },
    });
  }

  test("denial is a hard forbidden result and never enters generic prove_it", async () => {
    let calls = 0;
    const result = await createPostModelNode(computerPolicy(), {
      ...NO_MATCH,
      resolveComputerUseAdmission: () => {
        calls += 1;
        return { status: "denied", reason: "grant is stale" };
      },
    })(computerState());
    expect(calls).toBe(1);
    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.pendingApproval).toHaveLength(0);
    expect(result.approvalDenied).toBe(true);
    const refusal = result.messages?.find((message) =>
      ToolMessage.isInstance(message) && message.tool_call_id === "computer-call-1",
    );
    expect(refusal).toBeInstanceOf(ToolMessage);
    expect((refusal as ToolMessage).content).toContain("provider route is no longer current");
    expect((refusal as ToolMessage).content).toContain("Do not retry");
    expect((refusal as ToolMessage).content).not.toContain("permission to use computer_observe");
  });

  test("needs_user preserves only call identity and never enters approval routing", async () => {
    const result = await createPostModelNode(computerPolicy(), {
      ...NO_MATCH,
      resolveComputerUseAdmission: () => ({
        status: "needs_user",
        reason: "foreground_human_run_required",
        intent: { toolName: "computer_observe", toolCallId: "computer-call-1" },
      }),
      resolveWorkstationApprovalOverride: () => {
        throw new Error("semantic desktop calls must not reach approval override");
      },
    })(computerState());
    expect(result.approvedToolCalls).toHaveLength(0);
    expect(result.pendingApproval).toHaveLength(0);
    expect(result.approvalDenied).toBe(true);
    const refusal = result.messages?.find((message) =>
      ToolMessage.isInstance(message) && message.tool_call_id === "computer-call-1",
    );
    expect(refusal).toBeInstanceOf(ToolMessage);
    expect((refusal as ToolMessage).content).toBe(
      "Desktop automation needs a new Human-originated foreground Genie run before this action can continue.",
    );
    expect((refusal as ToolMessage).additional_kwargs).toEqual({
      computer_use: {
        status: "needs_user",
        reason: "foreground_human_run_required",
        intent: { toolName: "computer_observe", toolCallId: "computer-call-1" },
        recovery: "start_new_foreground_human_run",
      },
    });
  });

  test("an admitted binding bypasses generic prove_it and is stored for the exact call", async () => {
    const result = await createPostModelNode(computerPolicy(), {
      ...NO_MATCH,
      resolveComputerUseAdmission: () => ({
        status: "admitted",
        binding: {
        version: 12,
          computerUseContextId: "context-1",
          computerUseInvocationId: "computer-invocation:fixture-1",
          relayId: "relay-1",
          pairingGeneration: "pairing-1",
          desktopSessionId: "session-1",
          originHumanId: "human-1",
          originRunId: "run-1",
          originAgentId: "agent-1",
          lineageId: "lineage-1",
          installationEpoch: "epoch-1",
          grantGeneration: 1,
          provider: "cua",
          providerGeneration: "provider-generation-1",
        supportedActions: ["focus", "click", "scroll"] as const,
        supportsWindowCreation: false,
        supportsElementTargeting: false,
        supportsTargetedObservation: false,
        supportsVerification: false,
        },
      }),
    })(computerState());
    expect(result.approvedToolCalls).toEqual([
      expect.objectContaining({ id: "computer-call-1", name: "computer_observe" }),
    ]);
    expect(result.pendingApproval).toHaveLength(0);
    expect(result.approvalDenied).toBe(false);
    expect(Object.keys(result.computerUseInvocationBindings ?? {})).toEqual(["computer-call-1"]);
    expect(result.computerUseInvocationBindings?.["computer-call-1"]?.computerUseContextId).toBe("context-1");
    expect(result.computerUseInvocationBindings?.["computer-call-1"]?.relayId).toBe("relay-1");
  });

  test("missing resolver and unknown computer names fail closed without calling workstation override", async () => {
    let workstationCalls = 0;
    const deps: PostModelDeps = {
      ...NO_MATCH,
      resolveWorkstationApprovalOverride: () => {
        workstationCalls += 1;
        return { override: "auto", executionClass: "profile_bound_sandbox" };
      },
    };
    const noResolver = await createPostModelNode(computerPolicy(), deps)(computerState());
    const unknown = await createPostModelNode(computerPolicy(), deps)(computerState("computer_unknown"));
    expect(noResolver.approvedToolCalls).toHaveLength(0);
    expect(unknown.approvedToolCalls).toHaveLength(0);
    expect(workstationCalls).toBe(0);
  });

});

describe("D458 verified ordinary-origin host resolution precedes approval", () => {
  function pairedState() {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const state = makeState([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tool-1", name: "run_shell", args: { command: "npm install react" } }],
      }),
    ]);
    state.threadId = 800;
    state.langgraphThreadId = "room:paired";
    state.activatedToolNames = ["run_shell"];
    state.verifiedOrdinaryOrigin = {
      kind: "paired_mobile",
      serverInstanceId: "server-1",
      serverBindingGeneration: 1,
      userId: "test-owner",
      actorId: "actor-1",
      controllerInstallationId: "controller-1",
      installationGeneration: 1,
      requestId: "request-1",
    };
    return state;
  }

  const resolver = makeMockResolver({
    run_shell: {
      type: "require_approval",
      route: { type: "prove_it", approvers: ["owner-id"] },
    },
  });

  test("unverified ordinary origin denies before approval or host lookup", async () => {
    const state = pairedState();
    state.verifiedOrdinaryOrigin = null;
    let hostCalls = 0;
    let overrideCalls = 0;
    setOrdinaryHostResolver({
      resolve: async () => {
        hostCalls += 1;
        return { status: "unavailable" };
      },
    });
    const result = await createPostModelNode(resolver, {
      ...NO_MATCH,
      resolveWorkstationApprovalOverride: () => {
        overrideCalls += 1;
        return { override: "auto", executionClass: "profile_bound_sandbox" };
      },
    })(state);
    expect(hostCalls).toBe(0);
    expect(overrideCalls).toBe(0);
    expect(result.approvedToolCalls).toEqual([]);
    expect(result.approvalDenied).toBe(true);
  });

  test("zero eligible hosts denies before Workstation approval consultation", async () => {
    setOrdinaryHostResolver({ resolve: async () => ({ status: "unavailable" }) });
    let overrideCalls = 0;
    const result = await createPostModelNode(resolver, {
      ...NO_MATCH,
      resolveWorkstationApprovalOverride: () => {
        overrideCalls += 1;
        return { override: "auto", executionClass: "profile_bound_sandbox" };
      },
    })(pairedState());
    expect(overrideCalls).toBe(0);
    expect(result.approvedToolCalls).toEqual([]);
    expect(result.approvalDenied).toBe(true);
  });

  test("one eligible host constrains Workstation approval to that exact relay", async () => {
    setOrdinaryHostResolver({
      resolve: async () => ({
        status: "selected",
        host: {
          relayId: "mac-b",
          bindingId: "binding-b",
          pairingGeneration: "generation-b",
          desktopSessionId: "session-b",
          capabilityRevision: 4,
        },
      }),
    });
    let requiredRelayId: string | undefined;
    const result = await createPostModelNode(resolver, {
      ...NO_MATCH,
      resolveWorkstationApprovalOverride: (request) => {
        requiredRelayId = request.requiredRelayId;
        return { override: "auto", executionClass: "profile_bound_sandbox" };
      },
    })(pairedState());
    expect(requiredRelayId).toBe("mac-b");
    expect(result.approvedToolCalls).toHaveLength(1);
    expect(result.requiredHostRelays).toEqual({ "tool-1": "mac-b" });
  });

  test("a local file call is denied before host lookup when origin is unverified", async () => {
    const state = pairedState();
    state.messages = [new AIMessage({
      content: "",
      tool_calls: [{ id: "file-1", name: "file", args: { command: "read", zone: "current", path: "notes.md" } }],
    })];
    state.activatedToolNames = ["file"];
    state.currentFolder = "/repo";
    state.workspacePath = "/workspace";
    state.verifiedOrdinaryOrigin = null;
    let hostCalls = 0;
    setOrdinaryHostResolver({ resolve: async () => {
      hostCalls += 1;
      return { status: "unavailable" };
    } });
    const result = await createPostModelNode(makeMockResolver({ file: { type: "read_only" } }), NO_MATCH)(state);
    expect(hostCalls).toBe(0);
    expect(result.approvedToolCalls).toEqual([]);
    expect(result.approvalDenied).toBe(true);
  });

  test("a verified local file call pins the exact selected relay", async () => {
    const state = pairedState();
    state.messages = [new AIMessage({
      content: "",
      tool_calls: [{ id: "file-1", name: "file", args: { command: "read", zone: "current", path: "notes.md" } }],
    })];
    state.activatedToolNames = ["file"];
    setOrdinaryHostResolver({ resolve: async () => ({
      status: "selected",
      host: {
        relayId: "mac-file",
        bindingId: "binding-file",
        pairingGeneration: "generation-file",
        desktopSessionId: "session-file",
        capabilityRevision: 2,
      },
    }) });
    const result = await createPostModelNode(makeMockResolver({ file: { type: "read_only" } }), NO_MATCH)(state);
    expect(result.approvedToolCalls).toHaveLength(1);
    expect(result.requiredHostRelays).toEqual({ "file-1": "mac-file" });
  });

  test("a Task report-back pins its exact captured relay without selecting a current fallback", async () => {
    const state = pairedState();
    state.currentFolder = "/repo";
    state.workspacePath = "/workspace";
    state.messages = [new AIMessage({
      content: "",
      tool_calls: [{ id: "file-1", name: "file", args: { command: "read", zone: "current", path: "notes.md" } }],
    })];
    state.activatedToolNames = ["file"];
    state.verifiedOrdinaryOrigin = null;
    state.trustedExecutionEntrypoint = "foreground.task_report_back";
    state.taskReportBackContinuation = {
      status: "available",
      browserStatus: "not_captured",
      relayId: "captured-mac",
      relaySessionId: "socket-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-1",
      currentFolder: state.currentFolder ?? "",
      workspacePath: state.workspacePath ?? "",
    };
    let hostCalls = 0;
    setOrdinaryHostResolver({ resolve: async () => {
      hostCalls += 1;
      return { status: "selected", host: {
        relayId: "fallback-mac",
        bindingId: "binding-fallback",
        pairingGeneration: "generation-fallback",
        desktopSessionId: "desktop-fallback",
        capabilityRevision: 1,
      } };
    } });

    const result = await createPostModelNode(makeMockResolver({ file: { type: "read_only" } }), NO_MATCH)(state);
    expect(hostCalls).toBe(0);
    expect(result.approvedToolCalls).toHaveLength(1);
    expect(result.requiredHostRelays).toEqual({ "file-1": "captured-mac" });
  });

  test("a server-workspace file call does not resolve or inherit a host", async () => {
    const state = pairedState();
    state.messages = [new AIMessage({
      content: "",
      tool_calls: [{ id: "file-1", name: "file", args: { command: "read", zone: "workspace", path: "notes.md" } }],
    })];
    state.activatedToolNames = ["file"];
    let hostCalls = 0;
    setOrdinaryHostResolver({ resolve: async () => {
      hostCalls += 1;
      return { status: "unavailable" };
    } });
    const result = await createPostModelNode(makeMockResolver({ file: { type: "read_only" } }), NO_MATCH)(state);
    expect(hostCalls).toBe(0);
    expect(result.approvedToolCalls).toHaveLength(1);
    expect(result.requiredHostRelays).toEqual({});
  });

  test("several eligible hosts interrupt before Workstation approval", async () => {
    setOrdinaryHostResolver({
      resolve: async () => ({
        status: "choice_required",
        choiceId: "choice-1",
        options: [
          { selector: "selector-a", label: "Mac A" },
          { selector: "selector-b", label: "Mac B" },
        ],
      }),
    });
    let overrideCalls = 0;
    let interrupted = false;
    try {
      await createPostModelNode(resolver, {
        ...NO_MATCH,
        resolveWorkstationApprovalOverride: () => {
          overrideCalls += 1;
          return { override: "auto", executionClass: "profile_bound_sandbox" };
        },
      })(pairedState());
    } catch {
      interrupted = true;
    }
    expect(interrupted).toBe(true);
    expect(overrideCalls).toBe(0);
  });
});
