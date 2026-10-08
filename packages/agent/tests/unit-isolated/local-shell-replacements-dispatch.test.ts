import { afterEach, beforeEach, expect, test } from "bun:test";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import { toolsNode } from "../../src/nodes/tools";
import { createLocalGitTool } from "../../src/tools/local-git/local-git";
import { createReadShellOutputTool } from "../../src/tools/shell/read-shell-output";
import { setRelayRegistry, setWorkstationDispatchPlanRegistry, type ToolRelayRegistry, type WorkstationDispatchPlanView } from "../../src/tools/invocation-service";

beforeEach(() => { const catalog = new ToolCatalog(); for (const factory of [createLocalGitTool, createReadShellOutputTool]) catalog.register({ name: factory().name, factory, exposure: "core", category: "development", executor: "relay", trustTier: "admin", impact: "read-only", resultScanPolicy: "never" }); initToolCatalog(catalog); });
afterEach(() => { clearToolCatalog(); setRelayRegistry(null); setWorkstationDispatchPlanRegistry(null); });
function fixture() {
  const sent: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  const live = { protocol: 22, connected: true, capability: true };
  let plan: WorkstationDispatchPlanView | null = {
    executionClass: "typed_broker", toolCallId: "call-fixture", userId: "human-fixture", relayId: "relay-fixture", instanceId: "instance-fixture",
    desktopSessionId: "desktop-fixture", serverBindingId: "server-fixture", pairingGeneration: "pair-fixture", profileId: "profile-fixture",
    profileRevision: 1, grantIds: ["grant-fixture"], capabilityRevision: 1, currentFolder: "/synthetic/project", grantRevision: 1, protectedPolicyVersion: 1,
  };
  setWorkstationDispatchPlanRegistry({ get: () => plan, revalidate: () => ({ ok: true }) });
  setRelayRegistry({
    findByCapabilityForUser: (_capability, human) => live.connected && human === "human-fixture" ? ["relay-fixture"] : [],
    getCapabilities: () => ({ profile: "desktop-agent", canUseLocalGit: live.capability, localGit: { version: 1 }, canReadShellOutput: live.capability,
      canReadWorkspace: true, workspaceRoot: "/synthetic/project", allowedRoots: ["/synthetic/project"], securityLevel: "standard" }),
    getUserId: () => live.connected ? "human-fixture" : undefined,
    getDesktopSessionId: () => "desktop-fixture", getPairingGeneration: () => "pair-fixture", getCapabilityRevision: () => 1,
    getProtocolVersion: () => live.protocol,
    getWorkstationProfileSnapshot: () => ({ profileId: "profile-fixture", profileRevision: 1, grantIds: ["grant-fixture"], protectedPolicyVersion: 1, networkMode: "isolated", capabilities: [] }),
    dispatch: async (_id, request) => { sent.push(request); return { status: "ok", result: { ok: true } }; },
  } as ToolRelayRegistry);
  const state = (name: string, args: Record<string, unknown>, overrides: Partial<NautiloState> = {}) => ({
    messages: [], approvedToolCalls: [{ id: "call-fixture", name, args, type: "tool_call" }], actorRole: "owner",
    userId: "agent-owner-fixture", causalHumanUserId: "human-fixture", personaId: "agent-owner-fixture", turnId: "turn-fixture",
    agentId: "agent-fixture", roomId: "room-fixture", currentThreadId: "conversation-fixture", activatedToolNames: [], activatedToolLeases: [],
    engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: { canUseLocalGit: true, canReadShellOutput: true },
    requiredHostRelays: { "call-fixture": "relay-fixture" }, trustedExecutionEntrypoint: "foreground.main", currentFolder: "/synthetic/project",
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human-fixture", actorId: "actor-fixture", relayId: "relay-fixture",
      desktopSessionId: "desktop-fixture", pairingGeneration: "pair-fixture", requestId: "request-fixture" }, ...overrides,
  }) as unknown as NautiloState;
  return { live, sent, state, plan: (value: WorkstationDispatchPlanView | null) => { plan = value; } };
}
test("typed Git keeps its name and attaches the admitted plan with causal Human authority", async () => {
  const f = fixture(); const result = await toolsNode(f.state("local_git", { operation: "status" }));
  expect(result.messages?.at(-1)?.content).toBe('{"ok":true}');
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ toolName: "local_git", args: { operation: "status" }, workstationShellBinding: { subject: { userId: "human-fixture" }, currentFolder: "/synthetic/project" } });
});
test("log reads bypass any new workstation plan and never request execution", async () => {
  const f = fixture(); f.plan(null);
  await toolsNode(f.state("read_shell_output", { operation: "page", reference: "a".repeat(43) }));
  expect(f.sent).toHaveLength(1); expect(f.sent[0]?.toolName).toBe("read_shell_output");
  expect(f.sent[0]).not.toHaveProperty("workstationShellBinding");
  expect(f.sent[0]).not.toHaveProperty("localExecutionBinding");
});
test("missing plan, old Desktop, stale owner, and malformed arguments never dispatch", async () => {
  const f = fixture(); f.plan(null);
  await toolsNode(f.state("local_git", { operation: "status" }));
  f.live.protocol = 21;
  await toolsNode(f.state("read_shell_output", { operation: "page", reference: "a".repeat(43) }));
  f.live.protocol = 22; f.live.connected = false;
  await toolsNode(f.state("local_git", { operation: "status" }));
  f.live.connected = true;
  await toolsNode(f.state("read_shell_output", { operation: "page", reference: "a".repeat(43), command: "unexpected" }));
  expect(f.sent).toHaveLength(0);
});
