import { expect, test } from "bun:test";
import type { GitHubInvocationOwner } from "@nautilo/types";
const owner: GitHubInvocationOwner = { instanceId: "", humanUserId: "human", agentId: "agent", roomId: "room", conversationId: "thread", runId: "turn", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "opaque-pair", serverOrigin: "https://server.example", serverFingerprint: "fingerprint", profileId: "profile", profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
const { agentId: _agent, roomId: _room, conversationId: _thread, runId: _run, ...identity } = owner;
void _agent; void _room; void _thread; void _run;
const capability = { version: 1 as const, generation: "generation", identity, authenticatedGit: { version: 1 as const } };
import { GitHubBroker } from "../../electron/github-broker/broker";
import { GitHubPreparations } from "../../electron/github-broker/preparations";
import { dispatchAdmittedGitHub } from "../../electron/relay-dispatch/github";
import { DesktopRelaySession } from "../../electron/desktop-relay-session";
import { githubApprovalId } from "@nautilo/types";
import type { RelayWorkstationShellBinding } from "@nautilo/relay";
function fixture() {
  let current = true, posts = 0, accountReads = 0, approvalChecks = 0;
  const preparations = new GitHubPreparations({ generation: "generation", capacity: 2 });
  const broker = new GitHubBroker({ preparations, isCurrent: async () => current, isCurrentNow: () => current,
    isPublishingApproved: async (_owner, prepared, approval) => {
      approvalChecks += 1;
      return approval.approvalId === githubApprovalId(prepared) && approval.digest === prepared.digest;
    },
    credentials: { async withClient(_signal, work) { return work({ async request(method, path, body) {
      accountReads++;
      if (method === "POST") { posts++; throw new Error("lost reply"); }
      void body;
      return { status: 200, data: path === "/user" ? { id: 1, login: "fixture" } : path.endsWith("/project") ? { id: 2, full_name: "fixture/project" }
        : { id: 3, number: 12, title: "Fixture", body: "Original", state: "open" } };
    } }); } } });
  const runtime = { capability, broker, isCurrent: () => current, retire: () => { current = false; preparations.dispose(); } };
  return { runtime, posts: () => posts, reads: () => accountReads, approvals: () => approvalChecks };
}
test("absent custody advertises no owner and refuses account use; exact session retirement cannot reattach", async () => {
  const f = fixture(), session = new DesktopRelaySession({ serverUrl: "https://server.example" });
  expect(session.githubRuntime).toBeNull();
  const args = { operation: "issue_read", repository: "fixture/project", number: 12 };
  const binding = { version: 1, generation: "generation", toolCallId: "call", stage: "read", owner, localNetworkPolicy: { mode: "host" } };
  expect(await dispatchAdmittedGitHub(null, "local_github", args, binding)).toMatchObject({ ok: false }); expect(f.reads()).toBe(0);
  session.attachGitHubRuntime(f.runtime);
  expect(await dispatchAdmittedGitHub(session.githubRuntime, "local_github", args, binding)).toMatchObject({ ok: true });
  session.retireGitHubRuntime(); expect(session.githubRuntime).toBeNull(); expect(() => session.attachGitHubRuntime(f.runtime)).not.toThrow();
  expect(await dispatchAdmittedGitHub(f.runtime, "local_github", args, binding)).toMatchObject({ ok: false });
  session.retire(); await session.finishRetirement();
});
test("exact preparation publishes once; lost reply and retired original never become replay permission", async () => {
  const f = fixture(), args = { operation: "comment_create", repository: "fixture/project", number: 12, body: "Exact body" };
  const binding = { version: 1, generation: "generation", toolCallId: "call", stage: "prepare", owner, localNetworkPolicy: { mode: "host" } };
  const result = await dispatchAdmittedGitHub(f.runtime, "local_github", args, binding);
  if (!result.ok || !("prepared" in result)) throw new Error("fixture preparation failed");
  const prepared = result.prepared, publish = { ...binding, stage: "publish", prepared, approval: { verb: "once", approvalId: githubApprovalId(prepared), digest: prepared.digest } };
  expect(f.posts()).toBe(0);
  expect(await dispatchAdmittedGitHub(f.runtime, "local_github", args, publish)).toMatchObject({ code: "outcome_unknown", retrySafe: false });
  expect(await dispatchAdmittedGitHub(f.runtime, "local_github", args, publish)).toMatchObject({ retrySafe: false }); expect(f.posts()).toBe(1);
  f.runtime.retire(); expect(await dispatchAdmittedGitHub(f.runtime, "local_github", args, publish)).toMatchObject({ retrySafe: false }); expect(f.posts()).toBe(1);
});

test("restricted account networking refuses reads and publication preparation before credential access", async () => {
  const f = fixture();
  for (const localNetworkPolicy of [{ mode: "isolated" },
    { mode: "proxy-allowlist", allow: [{ type: "domain", host: "api.github.com" }] }]) {
    for (const args of [{ operation: "issue_read", repository: "fixture/project", number: 12 },
      { operation: "comment_create", repository: "fixture/project", number: 12, body: "Exact body" }]) {
      const binding = { version: 1, generation: "generation", toolCallId: "call",
        stage: args.operation === "issue_read" ? "read" : "prepare", owner, localNetworkPolicy };
      expect(await dispatchAdmittedGitHub(f.runtime, "local_github", args, binding)).toMatchObject({ ok: false });
    }
  }
  expect(f.reads()).toBe(0);
  expect(f.posts()).toBe(0);
});

test("authenticated Git requires host policy and exact project binding, then consumes one reviewed push", async () => {
  const f = fixture();
  let pushes = 0;
  const local = { identity: { workTree: "/project", gitDir: "/project/.git", commonDir: "/project/.git", isLinkedWorktree: false },
    sourceBranch: "topic", sourceOid: "2".repeat(40), objectFormat: "sha1" as const,
    indexHash: "3".repeat(64), repositoryStamp: "4".repeat(64) };
  const remote = { repository: "fixture/project", repositoryId: 2, accountId: 1, accountLogin: "fixture",
    branch: "topic", oid: "1".repeat(40) };
  const gitBroker = {
    fetch: async () => ({ operation: "fetch" as const, ok: true, reason: "ok" as const, sideEffectStarted: true, retrySafe: false }),
    clone: async () => ({ operation: "clone" as const, ok: true, reason: "ok" as const, sideEffectStarted: true, retrySafe: false }),
    pull: async () => ({ operation: "pull" as const, ok: true, reason: "ok" as const, sideEffectStarted: true, retrySafe: false }),
    preparePush: async () => ({ remote, local }),
    push: async (input: { consume: () => boolean }) => {
      if (!input.consume()) return { operation: "push" as const, ok: false, reason: "approval_required" as const, sideEffectStarted: false, retrySafe: true };
      pushes += 1;
      return { operation: "push" as const, ok: true, reason: "ok" as const, sideEffectStarted: true, retrySafe: false };
    },
  };
  const runtime = { ...f.runtime, authenticatedGit: { transport: {} as never,
    worktreeLimits: { fileCount: 10, blobBytes: 1024, totalBytes: 4096 } } };
  const workstation = (toolCallId: string): RelayWorkstationShellBinding => ({
    version: 2, toolCallId, relayId: owner.relayId, desktopSessionId: owner.desktopSessionId,
    serverBindingId: "server-binding", pairingGeneration: "raw-pairing",
    profileId: owner.profileId, profileRevision: owner.profileRevision,
    grantIds: ["grant"], capabilityRevision: 4, currentFolder: "/project",
    grantRevision: owner.grantRevision, protectedPolicyVersion: owner.protectedPolicyVersion,
    subject: { userId: owner.humanUserId, instanceId: owner.instanceId,
      relayId: owner.relayId, agentScope: "all_owned_agents" },
    operation: "execute", executionClass: "profile_bound_sandbox",
  });
  const readBinding = { version: 1, generation: "generation", toolCallId: "fetch-call", stage: "read", owner,
    localNetworkPolicy: { mode: "host" } };
  const fetch = { operation: "fetch", repository: "fixture/project", branch: "main" };
  expect(await dispatchAdmittedGitHub(runtime, "local_git", fetch, readBinding, undefined, workstation("fetch-call"), gitBroker)).toMatchObject({ ok: true });
  expect(await dispatchAdmittedGitHub(runtime, "local_git", fetch,
    { ...readBinding, localNetworkPolicy: { mode: "isolated" } }, undefined, workstation("fetch-call"), gitBroker)).toMatchObject({ code: "authority_changed" });
  expect(await dispatchAdmittedGitHub(runtime, "local_git", fetch, readBinding, undefined, undefined, gitBroker)).toMatchObject({ code: "authority_changed" });

  const push = { operation: "push", repository: "fixture/project", sourceBranch: "topic", destinationBranch: "topic" };
  const prepareBinding = { ...readBinding, toolCallId: "push-call", stage: "prepare" };
  const preparation = await dispatchAdmittedGitHub(runtime, "local_git", push, prepareBinding, undefined, workstation("push-call"), gitBroker);
  if (!preparation.ok || !("prepared" in preparation)) throw new Error("push preparation failed");
  const prepared = preparation.prepared;
  const publishBinding = { ...prepareBinding, stage: "publish", prepared,
    approval: { verb: "once", approvalId: githubApprovalId(prepared), digest: prepared.digest } };
  const concurrent = await Promise.all([
    dispatchAdmittedGitHub(runtime, "local_git", push, publishBinding, undefined, workstation("push-call"), gitBroker),
    dispatchAdmittedGitHub(runtime, "local_git", push, publishBinding, undefined, workstation("push-call"), gitBroker),
  ]);
  expect(concurrent[0]).toMatchObject({ ok: true, retrySafe: false });
  expect(concurrent[1]).toMatchObject({ ok: true, retrySafe: false });
  expect(await dispatchAdmittedGitHub(runtime, "local_git", push, publishBinding, undefined, workstation("push-call"), gitBroker)).toMatchObject({ ok: true, retrySafe: false });
  expect({ pushes, approvals: f.approvals() }).toEqual({ pushes: 1, approvals: 2 });
});
