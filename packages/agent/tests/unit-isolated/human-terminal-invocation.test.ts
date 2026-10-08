import { AIMessage } from "@langchain/core/messages";
import { afterEach, expect, test } from "bun:test";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { PolicyResolver } from "@nautilo/trust";
import type { NautiloState } from "../../src/agent/state";
import { createPostModelNode, resolveApprovalForToolCall } from "../../src/nodes/post-model";
import { createToolsNode } from "../../src/nodes/tools";
import { createHumanTerminalTool } from "../../src/tools/terminal/human-terminal";
import { setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { setOrdinaryHostResolver } from "../../src/runtime/ordinary-host-resolver";

afterEach(() => { clearToolCatalog(); setRelayRegistry(null); setOrdinaryHostResolver(null); });
function fixture() {
  let protocol = 24; let generation = "consent"; let sourceAllowed = true; let postAllowed = true; let domainFailure = false;
  const selection = { humanUserId: "human", agentId: "agent", roomId: "room", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "opaque-pair", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" };
  const sent: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  const catalog = new ToolCatalog(); catalog.register({ name: "human_terminal", factory: createHumanTerminalTool, executor: "relay", category: "development", trustTier: "admin", impact: "high", exposure: "core", requiredCapabilities: ["use_workstation"], relayCapabilities: ["canUseHumanTerminal"], resultScanPolicy: "never" }); initToolCatalog(catalog);
  setRelayRegistry({ findByCapabilityForUser: () => ["relay"], getUserId: () => "human", getDesktopSessionId: () => "desktop", getPairingGeneration: () => "raw-pair", getLocalExecutionPairingGeneration: () => "opaque-pair", getProtocolVersion: () => protocol,
    getCapabilities: () => ({ profile: "desktop-agent", canUseHumanTerminal: true, humanTerminal: { version: 1, generation, owner: selection } }),
    dispatch: async (_relay, request) => { sent.push(request); return { status: "ok", result: domainFailure ? { ok: false, code: "outcome_unknown", inputWritten: "unknown", retrySafe: false } : { ok: true, inputWritten: request.args["action"] !== "read", data: "private-terminal-output" } }; },
  } as ToolRelayRegistry);
  setOrdinaryHostResolver({ resolve: async () => ({ status: "selected", host: { relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "raw-pair", capabilityRevision: 1 } }) });
  const call = { id: "call", name: "human_terminal", args: { action: "write", data: "once" } };
  const state = { messages: [new AIMessage({ content: "", tool_calls: [call] })], approvedToolCalls: [], actorRole: "owner", userId: "human", causalHumanUserId: "human", personaId: "human", agentId: "agent", roomId: "room", turnId: "turn", currentThreadId: "thread", langgraphThreadId: "thread", memoryAccessEnvelope: null,
    activatedToolNames: [], activatedToolLeases: [], engagedSkillNames: [], relayCapabilities: { canUseHumanTerminal: true }, trustedExecutionEntrypoint: "foreground.main",
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human", actorId: "actor", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "raw-pair", requestId: "request" },
  } as unknown as NautiloState;
  const tools = createToolsNode({ humanTerminalAdmissionPortForState: () => ({ async withAdmission(work) {
    if (!sourceAllowed) throw new Error("revoked"); const result = await work(new AbortController().signal); if (!postAllowed) throw new Error("revoked"); return result;
  } }) });
  return { sent, state, tools, selection, fail: () => { domainFailure = true; }, protocol: (value: number) => { protocol = value; }, generation: (value: string) => { generation = value; }, source: (before: boolean, after = true) => { sourceAllowed = before; postAllowed = after; } };
}
function makeMockResolver(

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
    checkToolAccess: async () =>
      ({ type: "allow" as const }),
    routeApproval: async () => ({ type: "prove_it" as const, approvers: [] }),
  };
}

async function admit(f: ReturnType<typeof fixture>) {
  const patch = await createPostModelNode(makeMockResolver())(f.state);
  expect(patch.approvedToolCalls).toHaveLength(1);
  return { ...f.state, ...patch };
}
test("real post-model pins exact handoff and tools dispatches only through fresh source admission", async () => {
  const f = fixture(); const state = await admit(f);
  expect(state.humanTerminalInvocationBindings?.["call"]).toMatchObject({ generation: "consent", owner: { roomId: "room", pairingGeneration: "opaque-pair", conversationId: "thread" } });
  await f.tools(state); expect(f.sent).toHaveLength(1); expect(f.sent[0]?.humanTerminalBinding).toEqual(state.humanTerminalInvocationBindings?.["call"]);
  f.source(false); await f.tools(state); expect(f.sent).toHaveLength(1);
});
test("queued call cannot adopt a fresh generation after regrant, including post-model rerun", async () => {
  const f = fixture(); const state = await admit(f); f.generation("replacement");
  await f.tools(state); expect(f.sent).toHaveLength(0);
  const retry = await createPostModelNode(makeMockResolver())(state);
  expect(retry.approvedToolCalls ?? []).toHaveLength(0); expect(f.sent).toHaveLength(0);
});
test("foreign Room/Agent/origin, old protocol and missing source pin deny without sending", async () => {
  const f = fixture(); const state = await admit(f);
  for (const change of [{ roomId: "other" }, { agentId: "other" }, { verifiedOrdinaryOrigin: null }, { humanTerminalInvocationBindings: {} }]) await f.tools({ ...state, ...change });
  f.protocol(23); await f.tools(state); expect(f.sent).toHaveLength(0);
});
test("post-input source denial is unknown, suppresses bytes and never retries", async () => {
  const f = fixture(); const state = await admit(f); f.source(true, false);
  const result = await f.tools(state); expect(f.sent).toHaveLength(1);
  const text = JSON.stringify(result.messages); expect(text).toContain("outcome is unknown"); expect(text).not.toContain("private-terminal-output");
});
test("Human input preserves critical scanner blocks while typed observation stays a read", () => {
  fixture(); expect(resolveApprovalForToolCall({ name: "human_terminal", args: { action: "run", command: "rm -rf /" } }, "standard").verb).toBe("block");
  expect(resolveApprovalForToolCall({ name: "human_terminal", args: { action: "read" } }, "standard").verb).toBe("auto");
});

test("domain refusal remains an error receipt rather than successful input", async () => {
  const f = fixture(); const state = await admit(f); f.fail();
  const result = await f.tools(state);
  expect(JSON.stringify(result.messages)).toContain("outcome_unknown");
  expect(JSON.stringify(result.messages)).toContain('"status":"error"');
  expect(f.sent).toHaveLength(1);
});

test("a pinned input redelivery refused before dispatch never promises safe retry", async () => {
  const f = fixture(); const state = await admit(f); await f.tools(state);
  f.source(false); const refused = await f.tools(state);
  expect(f.sent).toHaveLength(1); expect(JSON.stringify(refused.messages)).toContain("outcome is unknown");
  expect(JSON.stringify(refused.messages)).toContain("Do not retry");
  f.generation("replacement"); const stale = await f.tools(state);
  expect(f.sent).toHaveLength(1); expect(JSON.stringify(stale.messages)).toContain("Do not retry");
});
