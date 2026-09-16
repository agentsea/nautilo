/**
 * D440 Phase 3 — agent-side `run_shell` mutual-exclusivity gate for the
 * structured git variant.
 *
 * Relay tools dispatch through `args` WITHOUT a schema parse, so the
 * LLM-facing Zod `superRefine` is not the runtime gate. `executeViaRelayRaw`
 * re-checks exactly-one-of (`command` | `git`) at the dispatch seam and
 * returns a coherent error WITHOUT dispatching on a violation. A raw
 * `command: "git ..."` is intentionally NOT promoted into the broker — it
 * stays a raw command and flows through the ordinary sandbox with no
 * metadata/template exception.
 *
 * This file also pins the Zod schema contract (superRefine) the model sees.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { toolsNode, setRelayRegistry, type ToolRelayRegistry } from "../../src/nodes/tools";
import { createRunShellTool } from "../../src/tools/shell/run-shell";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";

type RelayDispatchRequest = {
  toolName: string;
  args: Record<string, unknown>;
  impact: "read-only" | "low" | "high" | "destructive";
  approvalObtained: boolean;
  allowedRoots?: string[] | undefined;
  timeout?: number;
};

function makeCapturingRegistry(sink: { req?: RelayDispatchRequest }): ToolRelayRegistry {
  const registry = {
    findByCapabilityForUser: () => ["mock-relay-1"],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
      allowedRoots: ["/tmp"],
      securityLevel: "standard",
    }),
    dispatch: (_relayId: string, req: RelayDispatchRequest) => {
      sink.req = req;
      return Promise.resolve({ status: "ok", result: "done" });
    },
    register: () => Promise.resolve(),
    unregister: () => Promise.resolve(),
    updatePresence: () => {},
    resolveDispatch: () => {},
    cancelDispatch: () => {},
    listConnected: () => Promise.resolve(["mock-relay-1"]),
    findByCapability: () => ["mock-relay-1"],
    start: () => {},
    stop: () => {},
  };
  return registry as unknown as ToolRelayRegistry;
}

function makeState(args: Record<string, unknown>): NautiloState {
  return {
    messages: [
      new AIMessage({ content: "", tool_calls: [{ id: "tc-run_shell", name: "run_shell", args }] }),
    ],
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
    approvedToolCalls: [{ id: "tc-run_shell", name: "run_shell", args, type: "tool_call" }],
    requiredHostRelays: { "tc-run_shell": "mock-relay-1" },
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
    activatedToolNames: ["run_shell"],
    relayCapabilities: { use_high_impact_tools: true },
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: "test-owner",
      actorId: "actor-1",
      relayId: "mock-relay-1",
      desktopSessionId: "desktop-session-1",
      pairingGeneration: "generation-1",
      requestId: "tc-run_shell",
    },
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

function buildCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "run_shell",
    factory: () =>
      new DynamicStructuredTool({
        name: "run_shell",
        description: "stub",
        schema: z.object({
          command: z.string().optional(),
          git: z.any().optional(),
          timeout_seconds: z.number().optional(),
          timeout_reason: z.string().optional(),
        }),
        func: () => Promise.reject(new Error("relay tool — should not invoke locally")),
      }),
    category: "development",
    executor: "relay",
    trustTier: "admin",
    impact: "destructive",
    requiredCapabilities: ["use_high_impact_tools"],
    tags: [],
    resultScanPolicy: "on-suspicious",
  });
  return catalog;
}

function contentOf(msg: { content: unknown } | undefined): string {
  if (!msg) return "";
  return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
}

beforeAll(() => {
  initToolCatalog(buildCatalog());
});

describe("D440 Phase 3 — run_shell dispatch-seam mutual exclusivity", () => {
  test("git-only dispatch is forwarded with the git variant carried unchanged", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    const git = { operation: "status" };
    await toolsNode(makeState({ git }));
    expect(sink.req).toBeDefined();
    expect(sink.req?.args["git"]).toEqual(git);
    expect(sink.req?.args["command"]).toBeUndefined();
  });

  test("command-only dispatch is forwarded unchanged (baseline preserved)", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    await toolsNode(makeState({ command: "echo hello" }));
    expect(sink.req).toBeDefined();
    expect(sink.req?.args["command"]).toBe("echo hello");
    expect(sink.req?.args["git"]).toBeUndefined();
  });

  test("a raw `command: \"git ...\"` is NOT promoted into the git variant", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    await toolsNode(makeState({ command: "git status --short" }));
    expect(sink.req?.args["command"]).toBe("git status --short");
    expect(sink.req?.args["git"]).toBeUndefined();
  });

  test("both command and git → error returned, NOT dispatched", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    const out = await toolsNode(
      makeState({ command: "git status", git: { operation: "status" } }),
    );
    expect(sink.req).toBeUndefined();
    expect(contentOf(out.messages?.slice(-1)[0]).toLowerCase()).toContain("exactly one");
  });

  test("neither command nor git → error returned, NOT dispatched", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    const out = await toolsNode(makeState({ timeout_seconds: 10 }));
    expect(sink.req).toBeUndefined();
    expect(contentOf(out.messages?.slice(-1)[0]).toLowerCase()).toContain("exactly one");
  });
});

describe("D440 Phase 3 — run_shell Zod schema superRefine contract", () => {
  const tool = createRunShellTool();
  const schema = tool.schema as unknown as {
    safeParse(input: unknown): { success: boolean; data?: unknown; error?: { issues?: { message: string }[] } };
  };

  test("command-only parses", () => {
    expect(schema.safeParse({ command: "echo hi" }).success).toBe(true);
  });

  test("git status-only parses", () => {
    expect(schema.safeParse({ git: { operation: "status" } }).success).toBe(true);
  });

  test("git add with paths parses", () => {
    expect(schema.safeParse({ git: { operation: "add", paths: ["a.txt"] } }).success).toBe(true);
  });

  test("git worktree-add with target+ref parses", () => {
    expect(
      schema.safeParse({ git: { operation: "worktree-add", target: "/x/wt", ref: "HEAD" } }).success,
    ).toBe(true);
  });

  test("tool guidance reserves structured worktree removal for broker-created trees", () => {
    expect(tool.description).toContain("worktree-remove");
    expect(tool.description).toContain("broker-created worktree");
    expect(tool.description).toContain("Nautilo derives the execution lane");
    expect(tool.description).toContain("existing repositories/worktrees");
  });

  test("legacy execution hints parse compatibly but are stripped from the model contract", () => {
    const parsed = schema.safeParse({ command: "pwd", execution: "workstation" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty("execution");
  });

  test("both command and git fails the superRefine", () => {
    const r = schema.safeParse({ command: "git status", git: { operation: "status" } });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = (r.error?.issues ?? []).map((i) => i.message).join(" ");
      expect(messages.toLowerCase()).toContain("exactly one");
    }
  });

  test("neither command nor git fails the superRefine", () => {
    expect(schema.safeParse({ timeout_seconds: 10 }).success).toBe(false);
  });
});
