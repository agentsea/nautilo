import { afterEach, describe, expect, test } from "bun:test";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { parseRelayLocalExecutionUncertainty, type RelayLocalExecutionBinding } from "@nautilo/relay";
import type { ServerEvent } from "@nautilo/types";
import { setAgentEventSink } from "../../src/runtime-hooks";
import type { NautiloState } from "../../src/agent/state";
import { toolsNode } from "../../src/nodes/tools";
import { setRelayRegistry, setWorkstationDispatchPlanRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { createExecCommandTool, createWriteStdinTool } from "../../src/tools/local-execution/local-execution";

afterEach(() => { setAgentEventSink(null); setRelayRegistry(null); setWorkstationDispatchPlanRegistry(null); clearToolCatalog(); });
function fixture() {
  const catalog = new ToolCatalog();
  for (const factory of [createExecCommandTool, createWriteStdinTool]) {
    catalog.register({ name: factory().name, factory, exposure: "core", category: "development", trustTier: "admin",
      impact: "read-only", executor: "cloud", resultScanPolicy: "never" });
  }
  initToolCatalog(catalog);
  let binding: RelayLocalExecutionBinding | null = null;
  let dispatchError: Error | null = null;
  const sent: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  setRelayRegistry({
    findByCapabilityForUser: (_capability: string, userId: string) => userId === "human-fixture" ? ["relay-fixture"] : [],
    getCapabilities: () => ({ profile: "desktop-agent", canExecuteLocal: true,
      localExecution: { version: 1, generation: "generation-fixture", pipe: true, pty: true, capacity: 1 } }),
    getUserId: () => "human-fixture", getDesktopSessionId: () => "desktop-fixture", getProtocolVersion: () => 20,
    getPairingGeneration: () => "pairing-fixture",
    getLocalExecutionPairingGeneration: () => "pairing-fixture",
    getLocalExecutionWorkstationBinding: () => sent[0]?.workstationShellBinding ?? null,
    getLocalExecutionBinding: (_relayId: string, executionId: string) => binding?.executionId === executionId ? binding : null,
    dispatch: async (_relayId, request) => { sent.push(request); if (request.localExecutionBinding?.operation === "start") binding = request.localExecutionBinding;
      if (dispatchError !== null) throw dispatchError;
      return { status: "ok", result: { session_id: binding?.executionId, state: "running" } }; },
  } as ToolRelayRegistry);
  setWorkstationDispatchPlanRegistry({
    get: () => ({ toolCallId: "call-exec_command", userId: "human-fixture", relayId: "relay-fixture", instanceId: "",
      desktopSessionId: "desktop-fixture", serverBindingId: "server-fixture", pairingGeneration: "pairing-fixture",
      profileId: "profile-fixture", profileRevision: 1, grantIds: [], capabilityRevision: 1,
      executionClass: "profile_bound_sandbox", currentFolder: "/tmp/fixture", grantRevision: 1, protectedPolicyVersion: 1 }),
    revalidate: () => ({ ok: true }),
  });
  const state = (name: string, args: Record<string, unknown>, overrides: Partial<NautiloState> = {}) => ({
    currentFolder: "/tmp/fixture", messages: [], approvedToolCalls: [{ id: `call-${name}`, name, args, type: "tool_call" }], actorRole: "owner",
    userId: "agent-owner-fixture", causalHumanUserId: "human-fixture", personaId: "agent-owner-fixture", turnId: "turn-fixture",
    agentId: "agent-fixture", roomId: "room-fixture", currentThreadId: "conversation-fixture", activatedToolNames: [], activatedToolLeases: [],
    engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: { canExecuteLocal: true },
    requiredHostRelays: { [`call-${name}`]: "relay-fixture" }, trustedExecutionEntrypoint: "foreground.main",
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human-fixture", actorId: "actor-fixture", relayId: "relay-fixture",
      desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", requestId: "request-fixture" }, ...overrides,
  }) as unknown as NautiloState;
  return { sent, state, failWith: (error: Error | null) => { dispatchError = error; } };
}

describe("contained execution invocation", () => {
  test("uses causal Human and a fixed Relay effect floor, then permits only same-conversation continuation", async () => {
    const { sent, state } = fixture();
    await toolsNode(state("exec_command", { cmd: "echo fixture" }));
    expect(sent).toHaveLength(1);
    const original = sent[0]!.localExecutionBinding!;
    expect(sent[0]).toMatchObject({ impact: "destructive", localExecutionBinding: { invocationId: "call-exec_command",
      owner: { humanUserId: "human-fixture", agentId: "agent-fixture", conversationId: "conversation-fixture" } } });
    setWorkstationDispatchPlanRegistry({
      get: () => { throw new Error("unrelated Current Folder plan must never govern a retained continuation"); },
      revalidate: () => { throw new Error("unrelated discovery revision must never govern a retained continuation"); },
    });
    await toolsNode(state("write_stdin", { session_id: original.executionId }, { turnId: "later-turn" }));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.localExecutionBinding!.owner.runId).toBe(original.owner.runId);
    await toolsNode(state("write_stdin", { session_id: original.executionId }, { currentThreadId: "foreign-conversation" }));
    await toolsNode(state("write_stdin", { session_id: "foreign-execution" }));
    expect(sent).toHaveLength(2);
  });
  test("lost initial reply retains the exact recovery locator without claiming process state", async () => {
    const f = fixture();
    const events: ServerEvent[] = [];
    setAgentEventSink({ emit: (event) => events.push(event) });
    f.failWith(Object.assign(new Error("lost sent reply"), { runShellOutcome: "unknown" }));
    const result = await toolsNode(f.state("exec_command", { cmd: "echo fixture" }));
    const message = result.messages?.at(-1);
    expect(typeof message?.content).toBe("string");
    const envelope = parseRelayLocalExecutionUncertainty(JSON.parse(message!.content as string));
    expect(envelope).toMatchObject({ version: 1, kind: "local_execution_outcome_unknown", generation: "generation-fixture",
      executionId: f.sent[0]!.localExecutionBinding!.executionId, session_id: f.sent[0]!.localExecutionBinding!.executionId,
      operation: "start", outcome: "unknown", recovery: "read_or_cancel_same_execution" });
    const ended = events.find((event) => event.type === "tool.end");
    expect(ended?.status).toBe("error");
    expect(parseRelayLocalExecutionUncertainty(JSON.parse(ended!.result!))).toEqual(envelope);
    expect(message).toMatchObject({ status: "error" });
    expect(envelope).not.toHaveProperty("state");
    expect(envelope).not.toHaveProperty("owner");
    expect(f.sent).toHaveLength(1);
    f.failWith(null);
    await toolsNode(f.state("write_stdin", { session_id: envelope!.session_id }));
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.localExecutionBinding!.executionId).toBe(envelope!.executionId);
    expect(f.sent[1]!.localExecutionBinding!.operation).toBe("read");
  });

  test("uncertain input and Stop receipts preserve the original execution reference", async () => {
    const f = fixture();
    await toolsNode(f.state("exec_command", { cmd: "echo fixture", tty: true }));
    const original = f.sent[0]!.localExecutionBinding!;
    f.failWith(Object.assign(new Error("lost sent reply"), { runShellOutcome: "unknown" }));
    for (const args of [{ chars: "once\n" }, { cancel: true }]) {
      const result = await toolsNode(f.state("write_stdin", { session_id: original.executionId, ...args }));
      const message = result.messages?.at(-1);
      const envelope = parseRelayLocalExecutionUncertainty(JSON.parse(message!.content as string));
      expect(envelope).toMatchObject({ executionId: original.executionId, generation: original.generation,
        operation: "chars" in args ? "input" : "cancel", outcome: "unknown" });
      expect(message).toMatchObject({ status: "error" });
    }
    expect(f.sent).toHaveLength(3);
  });

  test("pre-send failures and missing admission never create an uncertain execution locator", async () => {
    const f = fixture();
    f.failWith(new Error("execution outcome unknown text is not a transport discriminant"));
    const beforeSend = await toolsNode(f.state("exec_command", { cmd: "echo fixture" }));
    expect(beforeSend.messages?.at(-1)?.content).not.toContain("local_execution_outcome_unknown");
    f.failWith(Object.assign(new Error("lost sent reply"), { runShellOutcome: "unknown" }));
    const denied = await toolsNode(f.state("exec_command", { cmd: "echo fixture" }, { verifiedOrdinaryOrigin: null }));
    expect(denied.messages?.at(-1)?.content).not.toContain("local_execution_outcome_unknown");
    expect(f.sent).toHaveLength(1);
  });

  test("rejects absent initiating origin rather than borrowing Agent-owner authority", async () => {
    const { sent, state } = fixture();
    await toolsNode(state("exec_command", { cmd: "echo fixture" }, { verifiedOrdinaryOrigin: null }));
    expect(sent).toHaveLength(0);
  });
});
