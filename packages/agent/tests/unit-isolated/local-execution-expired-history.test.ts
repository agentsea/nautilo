import { afterEach, expect, test } from "bun:test";
import { resolveInstance } from "@nautilo/config";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { RelayLocalExecutionBinding } from "@nautilo/relay";
import type { NautiloState } from "../../src/agent/state";
import { createToolsNode } from "../../src/nodes/tools";
import { setRelayRegistry, setWorkstationDispatchPlanRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { createWriteStdinTool } from "../../src/tools/local-execution/local-execution";

afterEach(() => { setRelayRegistry(null); setWorkstationDispatchPlanRegistry(null); clearToolCatalog(); });
function fixture() {
  const catalog = new ToolCatalog();
  catalog.register({ name: "write_stdin", factory: createWriteStdinTool, exposure: "core", category: "development", trustTier: "admin",
    impact: "read-only", executor: "cloud", resultScanPolicy: "never" });
  initToolCatalog(catalog);
  const binding: RelayLocalExecutionBinding = { version: 1, executionId: "execution-fixture", generation: "generation-fixture", invocationId: "original-call", operation: "start",
    owner: { instanceId: resolveInstance().instanceId, humanUserId: "human-fixture", agentId: "agent-fixture", runId: "old-run", conversationId: "conversation-fixture",
      relayId: "relay-fixture", desktopSessionId: "desktop-fixture", pairingGeneration: "opaque-pairing", serverBindingId: "server-fixture",
      profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null } };
  const sent: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  let errorCode: string | undefined = "LOCAL_EXECUTION_RECEIPT_EXPIRED";
  let generation = binding.generation, pairing = "raw-pairing", denySource = false, denyAfterRead = false, lost = false;
  let afterLive: (() => void) | undefined;
  let admissions = 0;
  setRelayRegistry({
    findByCapabilityForUser: () => ["relay-fixture"],
    getCapabilities: () => ({ profile: "desktop-agent", canExecuteLocal: true, canReadLocalExecutionHistory: true, canSearchLocalExecutionOutput: true,
      localExecution: { version: 1, generation: binding.generation, pipe: true, pty: true, capacity: 1 } }),
    getUserId: () => "human-fixture", getDesktopSessionId: () => "desktop-fixture", getProtocolVersion: () => 26,
    getPairingGeneration: () => pairing, getLocalExecutionPairingGeneration: () => "opaque-pairing",
    getLocalExecutionBinding: () => binding,
    dispatch: async (_relay, request) => {
      sent.push(request);
      if (request.localExecutionHistoryBinding) return { status: "ok", result: { session_id: binding.executionId, generation: binding.generation,
        historical: true, state: "completed", exitCode: 7, output: { data: "saved final output" } } };
      afterLive?.();
      if (lost) throw new Error("LOCAL_EXECUTION_RECEIPT_EXPIRED");
      return { status: "error", ...(errorCode === undefined ? {} : { errorCode }), error: "LOCAL_EXECUTION_RECEIPT_EXPIRED" };
    },
  } as ToolRelayRegistry);
  const node = createToolsNode({ localExecutionHistoryPortForState: () => ({ withReference: async (executionId, read) => {
    admissions++;
    if (denySource) throw new Error("Source denied");
    const result = await read({ executionId, generation, sourceMessageId: 42 });
    if (denyAfterRead) throw new Error("Source revoked");
    return result;
  } }) });
  const state = (args: Record<string, unknown> = {}, overrides: Partial<NautiloState> = {}) => ({
    messages: [], approvedToolCalls: [{ id: "read-call", name: "write_stdin", args: { session_id: binding.executionId, ...args }, type: "tool_call" }],
    actorRole: "owner", userId: "agent-owner-fixture", causalHumanUserId: "human-fixture", personaId: "agent-owner-fixture", turnId: "turn-fixture",
    agentId: "agent-fixture", roomId: "room-fixture", currentThreadId: "conversation-fixture", activatedToolNames: [], activatedToolLeases: [],
    engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: { canExecuteLocal: true }, requiredHostRelays: { "read-call": "relay-fixture" },
    trustedExecutionEntrypoint: "foreground.main", verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human-fixture", actorId: "actor-fixture",
      relayId: "relay-fixture", desktopSessionId: "desktop-fixture", pairingGeneration: "raw-pairing", requestId: "request-fixture" }, ...overrides,
  }) as unknown as NautiloState;
  return { sent, node, state, admissions: () => admissions, error: (code: string | undefined) => { errorCode = code; },
    generation: (value: string) => { generation = value; }, denySource: () => { denySource = true; }, denyAfter: () => { denyAfterRead = true; },
    lost: () => { lost = true; }, replacePairing: () => { afterLive = () => { pairing = "replacement"; }; } };
}

for (const search of [false, true]) test(`expired same-generation ${search ? "search" : "read"} recovers the authorized saved receipt without replay`, async () => {
  const f = fixture(); const result = await f.node(f.state(search ? { search: "final", cursor: 0, max_output_bytes: 64 } : { cursor: 0 }));
  expect(f.sent).toHaveLength(2);
  expect(f.sent[0]!.localExecutionBinding?.operation).toBe("read");
  expect(f.sent[1]).toMatchObject({ toolName: "write_stdin", impact: "read-only", localExecutionHistoryBinding: { generation: "generation-fixture", executionId: "execution-fixture", sourceMessageId: 42 } });
  expect(f.sent[1]).not.toHaveProperty("localExecutionBinding");
  expect(f.sent[1]!.args).toEqual(f.sent[0]!.args);
  expect(result.messages!.at(-1)!.content).toContain("saved final output");
});

for (const code of [undefined, "LOCAL_EXECUTION_UNAVAILABLE", "LOCAL_EXECUTION_OWNER_FENCED"]) test(`non-expiry error ${String(code)} never opens history`, async () => {
  const f = fixture(); f.error(code); await f.node(f.state()); expect(f.sent).toHaveLength(1); expect(f.admissions()).toBe(0);
});
test("lost replies containing expiry text do not authorize fallback", async () => {
  const f = fixture(); f.lost(); await f.node(f.state()); expect(f.sent).toHaveLength(1); expect(f.admissions()).toBe(0);
});
for (const args of [{ chars: "write once" }, { cancel: true }]) test(`expired ${"chars" in args ? "input" : "Stop"} never becomes a history operation`, async () => {
  const f = fixture(); await f.node(f.state(args)); expect(f.sent).toHaveLength(1); expect(f.admissions()).toBe(0);
});
for (const mode of ["source", "post-source", "generation", "pairing", "foreign-room"] as const) test(`expired recovery fails closed on ${mode} change`, async () => {
  const f = fixture();
  if (mode === "source") f.denySource();
  if (mode === "post-source") f.denyAfter();
  if (mode === "generation") f.generation("different-generation");
  if (mode === "pairing") f.replacePairing();
  const result = await f.node(f.state({}, mode === "foreign-room" ? { currentThreadId: "foreign-conversation" } : {}));
  expect(result.messages!.at(-1)!.content).not.toContain("saved final output");
  expect(f.sent).toHaveLength(mode === "foreign-room" ? 0 : mode === "post-source" ? 2 : 1);
});
