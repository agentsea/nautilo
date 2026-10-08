import { expect, test } from "bun:test";
import type { GitHubInvocationOwner } from "@nautilo/types";
const owner: GitHubInvocationOwner = { instanceId: "", humanUserId: "human", agentId: "agent", roomId: "room", conversationId: "thread", runId: "turn", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "opaque-pair", serverOrigin: "https://server.example", serverFingerprint: "fingerprint", profileId: "profile", profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
const { agentId: _agent, roomId: _room, conversationId: _thread, runId: _run, ...identity } = owner;
void _agent; void _room; void _thread; void _run;
const capability = { version: 1 as const, generation: "generation", identity };
import { GitHubBroker } from "../../electron/github-broker/broker";
import { GitHubPreparations } from "../../electron/github-broker/preparations";
import { dispatchAdmittedGitHub } from "../../electron/relay-dispatch/github";
import { DesktopRelaySession } from "../../electron/desktop-relay-session";
import { githubApprovalId } from "@nautilo/types";
function fixture() {
  let current = true, posts = 0, accountReads = 0;
  const preparations = new GitHubPreparations({ generation: "generation", capacity: 2 });
  const broker = new GitHubBroker({ preparations, isCurrent: async () => current, isCurrentNow: () => current,
    isPublishingApproved: async (_owner, prepared, approval) => approval.approvalId === githubApprovalId(prepared) && approval.digest === prepared.digest,
    credentials: { async withClient(_signal, work) { return work({ async request(method, path, body) {
      accountReads++;
      if (method === "POST") { posts++; throw new Error("lost reply"); }
      void body;
      return { status: 200, data: path === "/user" ? { id: 1, login: "fixture" } : path.endsWith("/project") ? { id: 2, full_name: "fixture/project" }
        : { id: 3, number: 12, title: "Fixture", body: "Original", state: "open" } };
    } }); } } });
  const runtime = { capability, broker, isCurrent: () => current, retire: () => { current = false; preparations.dispose(); } };
  return { runtime, posts: () => posts, reads: () => accountReads };
}
test("absent custody advertises no owner and refuses account use; exact session retirement cannot reattach", async () => {
  const f = fixture(), session = new DesktopRelaySession({ serverUrl: "https://server.example" });
  expect(session.githubRuntime).toBeNull();
  const args = { operation: "issue_read", repository: "fixture/project", number: 12 };
  const binding = { version: 1, generation: "generation", toolCallId: "call", stage: "read", owner };
  expect(await dispatchAdmittedGitHub(null, "local_github", args, binding)).toMatchObject({ ok: false }); expect(f.reads()).toBe(0);
  session.attachGitHubRuntime(f.runtime);
  expect(await dispatchAdmittedGitHub(session.githubRuntime, "local_github", args, binding)).toMatchObject({ ok: true });
  session.retireGitHubRuntime(); expect(session.githubRuntime).toBeNull(); expect(() => session.attachGitHubRuntime(f.runtime)).toThrow();
  expect(await dispatchAdmittedGitHub(f.runtime, "local_github", args, binding)).toMatchObject({ ok: false });
  session.retire(); await session.finishRetirement();
});
test("exact preparation publishes once; lost reply and retired original never become replay permission", async () => {
  const f = fixture(), args = { operation: "comment_create", repository: "fixture/project", number: 12, body: "Exact body" };
  const binding = { version: 1, generation: "generation", toolCallId: "call", stage: "prepare", owner };
  const result = await dispatchAdmittedGitHub(f.runtime, "local_github", args, binding);
  if (!result.ok || !("prepared" in result)) throw new Error("fixture preparation failed");
  const prepared = result.prepared, publish = { ...binding, stage: "publish", prepared, approval: { verb: "once", approvalId: githubApprovalId(prepared), digest: prepared.digest } };
  expect(f.posts()).toBe(0);
  expect(await dispatchAdmittedGitHub(f.runtime, "local_github", args, publish)).toMatchObject({ code: "outcome_unknown", retrySafe: false });
  expect(await dispatchAdmittedGitHub(f.runtime, "local_github", args, publish)).toMatchObject({ retrySafe: false }); expect(f.posts()).toBe(1);
  f.runtime.retire(); expect(await dispatchAdmittedGitHub(f.runtime, "local_github", args, publish)).toMatchObject({ retrySafe: false }); expect(f.posts()).toBe(1);
});
