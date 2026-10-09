import { resolveInstance } from "@nautilo/config";
import { afterEach, expect, test } from "bun:test";
import { digestGitHubPreparation, type GitHubInvocationOwner, type GitHubPreparedOperation } from "@nautilo/types";
const owner: GitHubInvocationOwner = { instanceId: resolveInstance().instanceId, humanUserId: "human", agentId: "agent", roomId: "room", conversationId: "thread", runId: "turn", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "opaque-pair", serverOrigin: "https://server.example", serverFingerprint: "fingerprint", profileId: "profile", profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
const { agentId: _agent, roomId: _room, conversationId: _thread, runId: _run, ...identity } = owner;
void _agent; void _room; void _thread; void _run;
const capability = { version: 1 as const, generation: "generation", identity };
async function preparation(): Promise<GitHubPreparedOperation> {
  const value = { version: 1 as const, preparationId: "preparation", generation: "generation", toolCallId: "call", request: { operation: "comment_create" as const, repository: "fixture/project", number: 12, body: "Full approved body\n<script>literal</script>" }, account: { id: 1, login: "fixture" }, repository: { id: 2, fullName: "fixture/project", htmlUrl: "https://github.com/fixture/project" }, resource: { id: 3, number: 12, kind: "issue" as const, htmlUrl: "https://github.com/fixture/project/issues/12", title: "Fixture", body: "Original", state: "open" as const } };
  return { ...value, digest: await digestGitHubPreparation(owner, value) };
}
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver, entrypoint } from "@langchain/langgraph";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { PolicyResolver } from "@nautilo/trust";
import { createPostModelNode } from "../../src/nodes/post-model";
import { createToolsNode } from "../../src/nodes/tools";
import { createGitHubTool } from "../../src/tools/github/github";
import { bindGitHubInvocation, setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import { setOrdinaryHostResolver } from "../../src/runtime/ordinary-host-resolver";
import type { NautiloState } from "../../src/agent/state";
afterEach(() => { clearToolCatalog(); setRelayRegistry(null); setOrdinaryHostResolver(null); });
async function fixture() {
  const prepared = await preparation(); let current = true, source = true, after = true; const sent: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  const catalog = new ToolCatalog(); catalog.register({ name: "local_github", factory: createGitHubTool, executor: "relay", category: "development", trustTier: "admin", impact: "destructive", exposure: "core", requiredCapabilities: ["use_workstation"], relayCapabilities: ["canUseGitHub"], resultScanPolicy: "never" }); initToolCatalog(catalog);
  setRelayRegistry({ findByCapabilityForUser: () => ["relay"], getUserId: () => "human", getDesktopSessionId: () => "desktop", getPairingGeneration: () => "raw-pair", getLocalExecutionPairingGeneration: () => "opaque-pair", getProtocolVersion: () => 27, getCapabilityRevision: () => 1,
    getActiveWorkstationSession: () => ({ userId: "human", relayId: "relay", desktopSessionId: "desktop", capabilityRevision: 1 }),
    getWorkstationProfileSnapshot: () => ({ profileId: "profile", profileRevision: 1, protectedPolicyVersion: 1, grantIds: [], networkMode: "isolated", capabilities: [] }),
    getCapabilities: () => ({ profile: "desktop-agent", canUseGitHub: true, github: { ...capability, generation: current ? "generation" : "replacement" } }),
    dispatch: async (_relay, request) => { sent.push(request); return { status: "ok", result: request.githubBinding?.stage === "prepare" ? { ok: true, prepared } : { ok: true, body: "private account result" } }; },
  } as ToolRelayRegistry);
  setOrdinaryHostResolver({ resolve: async () => ({ status: "selected", host: { relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "raw-pair", capabilityRevision: 1 } }) });
  const call = { id: "call", name: "local_github", args: prepared.request };
  const state = { messages: [new AIMessage({ content: "", tool_calls: [call] })], approvedToolCalls: [], userId: "human", causalHumanUserId: "human", personaId: "human", actorRole: "owner", agentId: "agent", roomId: "room", turnId: "turn", currentThreadId: "thread", langgraphThreadId: "thread", memoryAccessEnvelope: null, activatedToolNames: [], activatedToolLeases: [], engagedSkillNames: [], relayCapabilities: { canUseGitHub: true }, trustedExecutionEntrypoint: "foreground.main", verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human", actorId: "actor", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "raw-pair", requestId: "request" } } as unknown as NautiloState;
  const port = { async withAdmission<T>(work: (signal: AbortSignal) => Promise<T>) { if (!source) throw new Error("revoked"); const result = await work(new AbortController().signal); if (!after) throw new Error("revoked"); return result; } };
  expect(bindGitHubInvocation(state, "call", "prepare")).not.toBeNull();
  const policy = { checkToolAccess: async () => ({ type: "allow" }) } as unknown as PolicyResolver;
  const node = createPostModelNode(policy, { humanTerminalAdmissionPortForState: () => port });
  const workflow = entrypoint({ name: "github-review", checkpointer: new MemorySaver() }, () => node(state));
  const config = { configurable: { thread_id: "github-review" } };
  return { prepared, sent, workflow, config, state, tools: createToolsNode({ humanTerminalAdmissionPortForState: () => port }), revoke: () => { current = false; }, revokeSource: () => { source = false; }, revokeAfter: () => { after = false; }, port };
}

import { bindGitHubInvocation as bind } from "../../src/tools/invocation-service";
test("read dispatch requires exact source and queued custody without relying on catalog availability", async () => {
  const f = await fixture(); const call = { id: "call", name: "local_github", args: { operation: "issue_read", repository: "fixture/project", number: 12 } };
  const binding = bind(f.state, "call", "read")!;
  const state = { ...f.state, requiredHostRelays: { call: "relay" }, messages: [new AIMessage({ content: "", tool_calls: [call] })], approvedToolCalls: [call], githubInvocationBindings: { call: binding } };
  const result = await f.tools(state); expect(f.sent).toHaveLength(1); expect(JSON.stringify(result.messages)).toContain("private account result");
  for (const changed of [{ roomId: "foreign" }, { agentId: "foreign" }, { turnId: "foreign" }, { verifiedOrdinaryOrigin: null }, { githubInvocationBindings: {} }]) await f.tools({ ...state, ...changed });
  expect(f.sent).toHaveLength(1);
  f.revokeSource(); await f.tools(state); expect(f.sent).toHaveLength(1);
});
test("post-dispatch source loss suppresses private read bytes", async () => {
  const f = await fixture(); const call = { id: "call", name: "local_github", args: { operation: "issue_read", repository: "fixture/project", number: 12 } };
  const binding = bind(f.state, "call", "read")!; f.revokeAfter();
  const result = await f.tools({ ...f.state, requiredHostRelays: { call: "relay" }, messages: [new AIMessage({ content: "", tool_calls: [call] })], approvedToolCalls: [call], githubInvocationBindings: { call: binding } });
  expect(f.sent).toHaveLength(1); expect(JSON.stringify(result.messages)).not.toContain("private account result");
});

test("post-effect source loss suppresses publishing bytes and forbids replay after custody loss", async () => {
  const f = await fixture();
  const call = { id: "call", name: "local_github", args: f.prepared.request };
  const initial = bind(f.state, "call", "prepare")!;
  const binding = { ...initial, stage: "publish" as const, prepared: f.prepared,
    approval: { verb: "once" as const, approvalId: `github-publish:${f.prepared.preparationId}:${f.prepared.digest}`, digest: f.prepared.digest } };
  const state = { ...f.state, requiredHostRelays: { call: "relay" }, messages: [new AIMessage({ content: "", tool_calls: [call] })],
    approvedToolCalls: [call], githubInvocationBindings: { call: binding } };
  f.revokeAfter();
  const result = await f.tools(state);
  expect(f.sent).toHaveLength(1);
  expect(JSON.stringify(result.messages)).not.toContain("private account result");
  expect(JSON.stringify(result.messages)).toContain("Do not retry or recreate");
  f.revoke();
  const replay = await f.tools(state);
  expect(f.sent).toHaveLength(1);
  expect(JSON.stringify(replay.messages)).toContain("Do not retry or recreate");
});
