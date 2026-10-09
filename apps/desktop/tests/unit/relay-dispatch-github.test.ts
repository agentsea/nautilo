import { expect, test } from "bun:test";
import { dispatchGitHubOperation } from "../../electron/relay-dispatch/github";
import { GitHubBroker } from "../../electron/github-broker/broker";
import { GitHubPreparations } from "../../electron/github-broker/preparations";
import type { GitHubApiClient } from "../../electron/github-broker/credentials";
import type { GitHubInvocationOwner } from "../../../../packages/types/src/github-broker";

const owner: GitHubInvocationOwner = { instanceId: "", humanUserId: "human-fixture", agentId: "agent-fixture", roomId: "room-fixture",
  conversationId: "conversation-fixture", runId: "run-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture",
  pairingGeneration: "pairing-fixture", serverOrigin: "https://server.example", serverFingerprint: "fingerprint-fixture", profileId: "profile-fixture",
  profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
test("adapter never accepts a legacy name or authority in model arguments", async () => {
  let custody = 0;
  const broker = new GitHubBroker({ preparations: new GitHubPreparations({ generation: "generation-fixture", capacity: 1 }),
    credentials: { async withClient() { custody += 1; throw new Error("Must not reach custody"); } },
    isCurrent: async () => false, isCurrentNow: () => false, isPublishingApproved: async () => false });
  const args = { operation: "issue_read", repository: "fixture-org/project", number: 12 };
  expect(await dispatchGitHubOperation(broker, "run_shell", args, { owner, toolCallId: "call-fixture" })).toMatchObject({ code: "invalid_request" });
  expect(await dispatchGitHubOperation(broker, "local_github", { ...args, owner }, { owner, toolCallId: "call-fixture" })).toMatchObject({ code: "invalid_request" });
  expect(await dispatchGitHubOperation(broker, "local_github", args, { owner, toolCallId: "call-fixture" })).toMatchObject({ code: "authority_changed" });
  expect(custody).toBe(0);
});
test("account status uses the existing read stage and cannot carry publishing state", async () => {
  let calls = 0;
  const broker = new GitHubBroker({ preparations: new GitHubPreparations({ generation: "generation-fixture", capacity: 1 }),
    credentials: { async withClient(_signal, work) { return work({ async request(method, path) {
      calls += 1; expect({ method, path }).toEqual({ method: "GET", path: "/user" });
      return { status: 200, data: { id: 10, login: "fixture-user", token: "ignored-provider-field" } };
    } }); } }, isCurrent: async () => true, isCurrentNow: () => true, isPublishingApproved: async () => false });
  const request = { operation: "account_status" };
  expect(await dispatchGitHubOperation(broker, "local_github", request, { owner, toolCallId: "call-fixture" }))
    .toMatchObject({ ok: true, operation: "account_status", account: { id: 10, login: "fixture-user" }, operationReady: true });
  expect(await dispatchGitHubOperation(broker, "local_github", request, { owner, toolCallId: "call-fixture",
    publishingApproval: { verb: "once", approvalId: "fabricated", digest: "a".repeat(64) } })).toMatchObject({ code: "invalid_request" });
  expect(calls).toBe(1);
});
test("comment cannot bypass preparation by providing approval only", async () => {
  const broker = new GitHubBroker({ preparations: new GitHubPreparations({ generation: "generation-fixture", capacity: 1 }),
    credentials: { async withClient() { throw new Error("Must not reach custody"); } },
    isCurrent: async () => true, isCurrentNow: () => true, isPublishingApproved: async () => true });
  expect(await dispatchGitHubOperation(broker, "local_github", { operation: "comment_create", repository: "fixture-org/project", number: 12, body: "A comment" },
    { owner, toolCallId: "call-fixture", publishingApproval: { verb: "once", approvalId: "fabricated", digest: "a".repeat(64) } })).toMatchObject({ code: "approval_stale" });
});

test("PR create cannot be routed as a read or published with an approval-only flag", async () => {
  let custody = 0;
  const broker = new GitHubBroker({ preparations: new GitHubPreparations({ generation: "generation-fixture", capacity: 1 }),
    credentials: { async withClient() { custody += 1; throw new Error("Must not reach custody"); } },
    isCurrent: async () => true, isCurrentNow: () => true, isPublishingApproved: async () => true });
  const request = { operation: "pr_create", repository: "fixture-org/project", headRepository: "fixture-user/fork", baseBranch: "main",
    headBranch: "feature/topic", title: "Reviewed", body: "Full body", draft: false };
  expect(await dispatchGitHubOperation(broker, "local_github", request, { owner, toolCallId: "call-fixture",
    publishingApproval: { verb: "once", approvalId: "fabricated", digest: "a".repeat(64) } })).toMatchObject({ operation: "pr_create", code: "approval_stale" });
  expect(custody).toBe(0);
});

for (const lostReply of [false, true]) test(`consumed publication refuses altered redelivery without claiming safe retry (lost reply ${lostReply})`, async () => {
  let custody = 0, calls = 0, posts = 0;
  const preparations = new GitHubPreparations({ generation: "generation-fixture", capacity: 1 });
  const client: GitHubApiClient = { async request(method, path, body) {
    calls += 1;
    if (method === "POST") {
      posts += 1;
      if (lostReply) throw new Error("Synthetic lost reply");
      return { status: 201, data: { id: 40, body: body!.body } };
    }
    return { status: 200, data: path === "/user" ? { id: 10, login: "fixture-user" }
      : path.endsWith("/project") ? { id: 20, full_name: "fixture-org/project" }
      : { id: 30, number: 12, title: "Fixture", body: "Details", state: "open" } };
  } };
  const broker = new GitHubBroker({ preparations, credentials: { async withClient(_signal, work) { custody += 1; return work(client); } },
    isCurrent: async () => true, isCurrentNow: () => true, isPublishingApproved: async () => true });
  const request = { operation: "comment_create" as const, repository: "fixture-org/project", number: 12, body: "Reviewed comment" };
  const first = await broker.prepare(owner, "call-fixture", request);
  if (!first.ok) throw new Error("Fixture preparation failed");
  const prepared = first.prepared;
  const publishingApproval = { verb: "once" as const, digest: prepared.digest, approvalId: `github-publish:${prepared.preparationId}:${prepared.digest}` };
  expect(await dispatchGitHubOperation(broker, "local_github", request, { owner, toolCallId: "call-fixture", prepared }))
    .toMatchObject({ code: "approval_stale", sideEffectStarted: false, retrySafe: true });
  expect(await dispatchGitHubOperation(broker, "local_github", request, { owner, toolCallId: "call-fixture", prepared, publishingApproval }))
    .toMatchObject({ ok: !lostReply, sideEffectStarted: true, retrySafe: false });
  const before = { custody, calls, posts };
  for (const args of [request, { ...request, body: "Unreviewed" }, { operation: "issue_read", repository: request.repository, number: 12 }, { ...request, number: -1 }]) {
    const result = await dispatchGitHubOperation(broker, "local_github", args,
      { owner, toolCallId: "call-fixture", prepared, ...(args === request ? {} : { publishingApproval }) });
    expect(result).toEqual({ ok: false, operation: "comment_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  }
  // A copied ID or changed authority cannot forge retained sent-effect truth.
  for (const changed of [
    { owner: { ...owner, humanUserId: "other-human" }, toolCallId: "call-fixture", prepared },
    { owner, toolCallId: "other-call", prepared },
    { owner, toolCallId: "call-fixture", prepared: { ...prepared, digest: "a".repeat(64) } },
  ]) expect(await dispatchGitHubOperation(broker, "local_github", request, changed))
    .toMatchObject({ code: "approval_stale", sideEffectStarted: false, retrySafe: true });
  preparations.dispose();
  expect(await dispatchGitHubOperation(broker, "local_github", request, { owner, toolCallId: "call-fixture", prepared }))
    .toEqual({ ok: false, operation: "comment_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  expect({ custody, calls, posts }).toEqual(before); expect(posts).toBe(1);
});
