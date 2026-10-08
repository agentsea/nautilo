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
import { Command, MemorySaver, entrypoint } from "@langchain/langgraph";
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
  const prepared = await preparation(); let current = true, source = true; const sent: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
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
  const port = { async withAdmission<T>(work: (signal: AbortSignal) => Promise<T>) { if (!source) throw new Error("revoked"); const result = await work(new AbortController().signal); if (!source) throw new Error("revoked"); return result; } };
  expect(bindGitHubInvocation(state, "call", "prepare")).not.toBeNull();
  const policy = { checkToolAccess: async () => ({ type: "allow" }) } as unknown as PolicyResolver;
  const node = createPostModelNode(policy, { humanTerminalAdmissionPortForState: () => port });
  const checkpointer = new MemorySaver();
  const makeWorkflow = () => entrypoint({ name: "github-review", checkpointer }, () => node(state));
  const workflow = makeWorkflow();
  const config = { configurable: { thread_id: "github-review" } };
  return { prepared, sent, workflow, makeWorkflow, config, state, tools: createToolsNode({ humanTerminalAdmissionPortForState: () => port }), revoke: () => { current = false; }, revokeSource: () => { source = false; } };
}
test("allow policy still parks before publishing and replay uses one durable original preparation", async () => {
  const f = await fixture(); const result = await f.workflow.invoke({}, f.config);
  expect(result).toMatchObject({ __interrupt__: [{ value: { type: "approval_ask", allowedVerbs: ["once", "deny"], requiresExplicitReview: true } }] });
  expect(f.sent).toHaveLength(1); expect(f.sent[0]?.githubBinding?.stage).toBe("prepare");
  const review = (result as unknown as { __interrupt__: Array<{ value: unknown }> }).__interrupt__[0]!.value as { approvalId: string; github: { digest: string } };
  const patch = await f.makeWorkflow().invoke(new Command({ resume: { approved: true, verb: "once", githubApprovalId: review.approvalId, githubDigest: review.github.digest, githubLaneKey: "thread" } }), f.config);
  expect(f.sent).toHaveLength(1); expect(patch.approvedToolCalls).toHaveLength(1);
  await f.tools({ ...f.state, ...patch }); expect(f.sent).toHaveLength(2); expect(f.sent[1]?.githubBinding?.stage).toBe("publish");
});
test("custody replacement while parked never prepares or publishes a replacement", async () => {
  const f = await fixture(); await f.workflow.invoke({}, f.config); f.revoke();
  const patch = await f.workflow.invoke(new Command({ resume: { approved: true, verb: "once" } }), f.config);
  expect(patch.approvedToolCalls ?? []).toHaveLength(0); expect(f.sent).toHaveLength(1);
});
test("wrong digest, broadened verb and lost source each deny original publication", async () => {
  for (const decision of [{ approved: true, verb: "always" }, { approved: true, verb: "once", githubDigest: "f".repeat(64) }]) {
    const f = await fixture(); await f.workflow.invoke({}, f.config);
    const patch = await f.workflow.invoke(new Command({ resume: decision }), f.config);
    expect(patch.approvedToolCalls ?? []).toHaveLength(0); expect(f.sent).toHaveLength(1);
  }
  const f = await fixture(); await f.workflow.invoke({}, f.config); f.revokeSource();
  const patch = await f.workflow.invoke(new Command({ resume: { approved: true, verb: "once" } }), f.config);
  expect(patch.approvedToolCalls ?? []).toHaveLength(0); expect(f.sent).toHaveLength(1);
});

test("changed request after preparation is refused without generating a replacement review", async () => {
  const f = await fixture(); await f.workflow.invoke({}, f.config);
  f.state.messages = [new AIMessage({ content: "", tool_calls: [{ id: "call", name: "local_github", args: { ...f.prepared.request, body: "Changed" } }] })];
  const result = await f.makeWorkflow().invoke(new Command({ resume: { approved: true, verb: "once" } }), f.config);
  expect(result.approvedToolCalls ?? []).toHaveLength(0); expect(f.sent).toHaveLength(1);
});
test("missing invocation-local protected/source admission never prepares even under allow policy", async () => {
  const f = await fixture();
  const node = createPostModelNode({ checkToolAccess: async () => ({ type: "allow" }) } as unknown as PolicyResolver);
  const result = await node(f.state); expect(result.approvedToolCalls ?? []).toHaveLength(0); expect(f.sent).toHaveLength(0);
});

test("forbidden and read-only actor decisions cannot be upgraded by publishing review", async () => {
  for (const type of ["forbidden", "read_only"] as const) {
    const f = await fixture();
    const node = createPostModelNode({ checkToolAccess: async () => ({ type }) } as unknown as PolicyResolver, { humanTerminalAdmissionPortForState: () => ({ async withAdmission(work) { return await work(new AbortController().signal); } }) });
    const result = await node(f.state); expect(result.approvedToolCalls ?? []).toHaveLength(0); expect(f.sent).toHaveLength(0);
  }
});
