import { expect, test } from "bun:test";
import { GitHubBroker, type GitHubPublishingApproval } from "../../electron/github-broker/broker";
import { GitHubPreparations } from "../../electron/github-broker/preparations";
import type { GitHubApiClient, GitHubApiResponse, GitHubApiBody } from "../../electron/github-broker/credentials";
import type { GitHubInvocationOwner, GitHubPreparedOperation } from "../../../../packages/types/src/github-broker";

const owner: GitHubInvocationOwner = { instanceId: "", humanUserId: "human-fixture", agentId: "agent-fixture", roomId: "room-fixture",
  conversationId: "conversation-fixture", runId: "run-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture",
  pairingGeneration: "pairing-fixture", serverOrigin: "https://server.example", serverFingerprint: "fingerprint-fixture", profileId: "profile-fixture",
  profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
const request = { operation: "comment_create" as const, repository: "fixture-org/project", number: 12, body: "An approved comment." };
function barrier<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
function fixture() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const state = { current: true, approval: true, accountId: 10, repoId: 20, resourceId: 30, credentials: 0,
    post: null as ((body: GitHubApiBody | undefined) => Promise<GitHubApiResponse>) | null,
    afterApproval: null as (() => void) | null,
    afterRead: null as (() => void) | null };
  const client: GitHubApiClient = { async request(method, path, body) {
    calls.push({ method, path, body });
    if (method === "POST") return state.post ? state.post(body) : { status: 201, data: { id: 40, body: body!.body, token: "ignored-provider-field" } };
    let data: unknown = path === "/user" ? { id: state.accountId, login: "fixture-user", credentials: "ignored-provider-field" }
      : path.endsWith("/project") ? { id: state.repoId, full_name: "fixture-org/project", clone_url: "ignored-provider-field" }
      : { id: state.resourceId, number: 12, title: "Fixture", body: "Details", state: "open", private: "ignored-provider-field" };
    if (path.includes("/pulls/")) data = { ...(data as Record<string, unknown>), pull_request: {} };
    state.afterRead?.(); return { status: 200, data };
  } };
  const preparations = new GitHubPreparations({ generation: "generation-fixture", capacity: 8 });
  const broker = new GitHubBroker({ preparations, credentials: { async withClient(_signal, action) { state.credentials += 1; return action(client); } },
    isCurrent: async () => state.current, isCurrentNow: () => state.current,
    isPublishingApproved: async () => { state.afterApproval?.(); return state.approval; } });
  const prepare = async () => {
    const result = await broker.prepare(owner, "call-fixture", request); if (!result.ok) throw new Error("Fixture preparation failed");
    return result.prepared;
  };
  const approval = (prepared: GitHubPreparedOperation): GitHubPublishingApproval => ({ verb: "once", digest: prepared.digest,
    approvalId: `github-publish:${prepared.preparationId}:${prepared.digest}` });
  return { calls, state, broker, preparations, prepare, approval };
}
test("issue/PR reads follow exact fixed resource paths and return a closed secret-free DTO", async () => {
  const f = fixture();
  for (const operation of ["issue_read", "pr_read"] as const) {
    const result = await f.broker.read(owner, { operation, repository: request.repository, number: 12 });
    expect(result.ok).toBe(true); expect(result.sideEffectStarted).toBe(false); expect(result.retrySafe).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ignored-provider-field");
    expect(f.calls.at(-1)!.path).toBe(`/repos/fixture-org/project/${operation === "issue_read" ? "issues" : "pulls"}/12`);
  }
  expect(f.calls.every(call => call.method === "GET")).toBe(true);
});
test("no current authority or malformed model intent accesses account custody", async () => {
  const f = fixture(); f.state.current = false;
  expect(await f.broker.read(owner, { operation: "issue_read", repository: request.repository, number: 12 })).toMatchObject({ ok: false, code: "authority_changed" });
  expect(await f.broker.prepare(owner, "call-fixture", { ...request, approvalObtained: true })).toMatchObject({ ok: false });
  expect(f.state.credentials).toBe(0); expect(f.calls).toHaveLength(0);
});
test("authority loss during a read withholds the observed resource", async () => {
  const f = fixture(); f.state.afterRead = () => { f.state.current = false; };
  const result = await f.broker.read(owner, { operation: "issue_read", repository: request.repository, number: 12 });
  expect(result).toMatchObject({ ok: false, code: "authority_changed", sideEffectStarted: false }); expect(f.calls).toHaveLength(1);
});
test("Off queued by asynchronous authority revalidation wins before credential or HTTP work", async () => {
  let current = true, custody = 0;
  const broker = new GitHubBroker({ preparations: new GitHubPreparations({ generation: "generation-fixture", capacity: 1 }),
    credentials: { async withClient() { custody += 1; throw new Error("Must not access account after Off"); } },
    isCurrentNow: () => current, isCurrent: async () => { queueMicrotask(() => { current = false; }); return true; },
    isPublishingApproved: async () => true });
  expect(await broker.read(owner, { operation: "issue_read", repository: request.repository, number: 12 })).toMatchObject({ code: "authority_changed" });
  expect(custody).toBe(0);
});
test("publishing requires the exact preparation, one-time reply and current approval owner", async () => {
  const f = fixture(); const prepared = await f.prepare();
  expect(await f.broker.publish(owner, "other-call", prepared, f.approval(prepared))).toMatchObject({ code: "approval_stale" });
  expect(await f.broker.publish(owner, "call-fixture", { ...prepared, digest: "b".repeat(64) }, f.approval(prepared))).toMatchObject({ code: "approval_stale" });
  f.state.approval = false;
  expect(await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared))).toMatchObject({ code: "approval_stale" });
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
});
test("account, repository and resource drift never reuses a publishing approval", async () => {
  for (const key of ["accountId", "repoId", "resourceId"] as const) {
    const f = fixture(); const prepared = await f.prepare(); f.state[key] += 1;
    expect(await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared))).toMatchObject({ code: "resource_changed", sideEffectStarted: false });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
  }
});
test("Off during exact publishing approval prevents POST even if the earlier resolver returned true", async () => {
  const f = fixture(); const prepared = await f.prepare();
  f.state.afterApproval = () => { queueMicrotask(() => { f.state.current = false; }); };
  expect(await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared))).toMatchObject({ code: "authority_changed", sideEffectStarted: false });
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
});
test("concurrent exact publishing is consumed before transport and returns one shared result", async () => {
  const f = fixture(); const prepared = await f.prepare(); const sent = barrier<void>(); const reply = barrier<GitHubApiResponse>();
  f.state.post = async () => { sent.resolve(); return reply.promise; };
  const first = f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared)); await sent.promise;
  const second = f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared));
  reply.resolve({ status: 201, data: { id: 40, body: request.body } });
  expect(await first).toEqual(await second); expect((await first).ok).toBe(true);
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});
test("lost POST reply is truthful unknown and exact redelivery never sends another comment", async () => {
  const f = fixture(); const prepared = await f.prepare();
  f.state.post = async () => { throw new Error("synthetic-provider-value"); };
  const result = await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared));
  expect(result).toEqual({ ok: false, operation: "comment_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  expect(await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared))).toEqual(result);
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("synthetic-provider-value");
});
test("authority loss or generation retirement after POST preserves uncertainty", async () => {
  for (const retire of [false, true]) {
    const f = fixture(); const prepared = await f.prepare();
    f.state.post = async () => { if (retire) f.preparations.dispose(); else f.state.current = false;
      return { status: 201, data: { id: 40, body: request.body } }; };
    expect(await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared))).toMatchObject({ ok: false, code: "outcome_unknown", retrySafe: false });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  }
});
test("fresh Desktop generation cannot reconstruct an old approved preparation", async () => {
  const original = fixture(); const prepared = await original.prepare(); const restarted = fixture();
  expect(await restarted.broker.publish(owner, "call-fixture", prepared, original.approval(prepared))).toMatchObject({ code: "approval_stale" });
  expect(restarted.calls).toHaveLength(0);
});

const prRequest = { operation: "pr_create" as const, repository: "fixture-org/project", headRepository: "fixture-user/fork",
  baseBranch: "main", headBranch: "feature/topic", title: "A reviewed change", body: "The complete reviewed body.\n", draft: true };
function prFixture() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const state = { current: true, accountId: 10, baseId: 20, headId: 21, networkId: 20, baseSha: "a".repeat(40), headSha: "b".repeat(40),
    afterApproval: null as (() => void) | null, post: null as (() => Promise<GitHubApiResponse>) | null };
  const response = () => ({ status: 201, data: { id: 30, number: 12, title: prRequest.title, body: prRequest.body, draft: true, state: "open", maintainer_can_modify: false,
    base: { ref: "main", sha: state.baseSha, repo: { id: state.baseId, full_name: prRequest.repository } },
    head: { ref: "feature/topic", sha: state.headSha, repo: { id: state.headId, full_name: prRequest.headRepository } }, secret: "ignored-provider-field" } });
  const preparations = new GitHubPreparations({ generation: "generation-fixture", capacity: 8 });
  const client: GitHubApiClient = { async request(method, path, body) {
    calls.push({ method, path, body });
    if (method === "POST") return state.post ? state.post() : response();
    if (path === "/user") return { status: 200, data: { id: state.accountId, login: "fixture-user" } };
    if (path === `/repos/${prRequest.repository}`) return { status: 200, data: { id: state.baseId, full_name: prRequest.repository, fork: false } };
    if (path === `/repos/${prRequest.headRepository}`) return { status: 200, data: { id: state.headId, full_name: prRequest.headRepository, fork: true, source: { id: state.networkId } } };
    if (path.endsWith("/heads/main")) return { status: 200, data: { ref: "refs/heads/main", object: { type: "commit", sha: state.baseSha } } };
    if (path.endsWith("/heads/feature%2Ftopic")) return { status: 200, data: { ref: "refs/heads/feature/topic", object: { type: "commit", sha: state.headSha } } };
    throw new Error("Unexpected fixed endpoint");
  } };
  const broker = new GitHubBroker({ preparations, credentials: { withClient: async (_signal, action) => action(client) },
    isCurrent: async () => state.current, isCurrentNow: () => state.current,
    isPublishingApproved: async () => { state.afterApproval?.(); return true; } });
  const prepare = async () => { const result = await broker.prepare(owner, "pr-call", prRequest); if (!result.ok) throw new Error("PR fixture failed"); return result.prepared; };
  const approval = (prepared: GitHubPreparedOperation): GitHubPublishingApproval => ({ verb: "once", approvalId: `github-publish:${prepared.preparationId}:${prepared.digest}`, digest: prepared.digest });
  return { broker, state, calls, preparations, prepare, approval, response };
}
test("PR preparation pins account, both numeric repositories and full branch observations; exact Once sends closed payload", async () => {
  const f = prFixture(); const prepared = await f.prepare();
  expect(prepared.resource).toBeNull(); expect(prepared.repository.id).toBe(20);
  expect(prepared.pullRequest).toEqual({ headRepository: { id: 21, fullName: prRequest.headRepository, htmlUrl: `https://github.com/${prRequest.headRepository}` },
    forkNetworkId: 20, maintainerCanModify: false, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature/topic", sha: "b".repeat(40) } });
  expect(prepared.request).toEqual(prRequest);
  const result = await f.broker.publish(owner, "pr-call", prepared, f.approval(prepared));
  expect(result).toMatchObject({ ok: true, operation: "pr_create", approvedCommitGuaranteed: false, branchMovementObserved: false, sideEffectStarted: true, retrySafe: false });
  expect(JSON.stringify(result)).not.toContain("ignored-provider-field");
  expect(f.calls.filter(call => call.method === "POST")).toEqual([{ method: "POST", path: "/repos/fixture-org/project/pulls",
    body: { title: prRequest.title, body: prRequest.body, base: "main", head: "fixture-user:feature/topic", head_repo: "fork", draft: true, maintainer_can_modify: false } }]);
});
test("unrelated fork network is denied before any publishing preparation", async () => {
  const f = prFixture(); f.state.networkId = 99;
  expect(await f.broker.prepare(owner, "pr-call", prRequest)).toMatchObject({ ok: false, result: { code: "resource_changed" } });
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
});
test("PR account, repo, network and branch drift before or during approval requires fresh review without POST", async () => {
  for (const key of ["accountId", "baseId", "headId", "networkId", "baseSha", "headSha"] as const) {
    const f = prFixture(); const prepared = await f.prepare();
    const change = () => { if (key === "baseSha" || key === "headSha") f.state[key] = "c".repeat(40); else f.state[key] += 1; };
    if (key === "headSha") f.state.afterApproval = change; else change();
    expect(await f.broker.publish(owner, "pr-call", prepared, f.approval(prepared))).toMatchObject({ ok: false, code: "resource_changed", sideEffectStarted: false });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
  }
});
test("branch movement at the GitHub send boundary is reported, never a false exact approved commit guarantee", async () => {
  const f = prFixture(); const prepared = await f.prepare();
  f.state.post = async () => { f.state.headSha = "c".repeat(40); return f.response(); };
  expect(await f.broker.publish(owner, "pr-call", prepared, f.approval(prepared))).toMatchObject({ ok: true, operation: "pr_create",
    approvedCommitGuaranteed: false, branchMovementObserved: true, pullRequest: { head: { sha: "c".repeat(40) } } });
});
test("PR lost send reply remains unknown after external drift and redelivery cannot POST again", async () => {
  const f = prFixture(); const prepared = await f.prepare();
  f.state.post = async () => { throw new Error("synthetic-provider-value"); };
  const first = await f.broker.publish(owner, "pr-call", prepared, f.approval(prepared));
  expect(first).toMatchObject({ ok: false, operation: "pr_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  f.state.headSha = "c".repeat(40);
  expect(await f.broker.publish(owner, "pr-call", prepared, f.approval(prepared))).toEqual(first);
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});
test("malformed or foreign created PR response and retirement after send retain uncertainty", async () => {
  for (const variant of ["missing", "foreign", "retired", "off"] as const) {
    const f = prFixture(); const prepared = await f.prepare();
    f.state.post = async () => {
      const response = f.response();
      if (variant === "missing") return { status: 201, data: { id: 30 } };
      if (variant === "foreign") response.data.head.repo.id = 99;
      if (variant === "retired") f.preparations.dispose();
      if (variant === "off") f.state.current = false;
      return response;
    };
    expect(await f.broker.publish(owner, "pr-call", prepared, f.approval(prepared))).toMatchObject({ ok: false, code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  }
});
test("concurrent PR publication shares one consumed effect", async () => {
  const f = prFixture(); const prepared = await f.prepare(); const sent = barrier<void>(); const release = barrier<GitHubApiResponse>();
  f.state.post = async () => { sent.resolve(); return release.promise; };
  const first = f.broker.publish(owner, "pr-call", prepared, f.approval(prepared)); await sent.promise;
  const second = f.broker.publish(owner, "pr-call", prepared, f.approval(prepared)); release.resolve(f.response());
  expect(await second).toEqual(await first); expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

test("caller mutation during approval cannot alter the isolated PR payload or pinned repository identity", async () => {
  const f = prFixture(); const prepared = await f.prepare();
  f.state.afterApproval = () => {
    Object.assign(prepared.account, { id: 99 }); Object.assign(prepared.repository, { id: 99 });
    Object.assign(prepared.request, { title: "Unreviewed replacement", body: "Unreviewed replacement" });
    Object.assign(prepared.pullRequest!.head, { sha: "c".repeat(40) });
  };
  expect(await f.broker.publish(owner, "pr-call", prepared, f.approval(prepared))).toMatchObject({ ok: true, operation: "pr_create", resource: { title: prRequest.title } });
  expect(f.calls.find(call => call.method === "POST")!.body).toMatchObject({ title: prRequest.title, body: prRequest.body });
});
test("GitHub null body for an approved empty PR body is normalized without accepting other body types", async () => {
  for (const body of [null, 12]) {
    const f = prFixture(); const request = { ...prRequest, body: "" };
    const preparation = await f.broker.prepare(owner, "pr-call", request); if (!preparation.ok) throw new Error("Fixture failed");
    f.state.post = async () => ({ ...f.response(), data: { ...f.response().data, body } });
    const result = await f.broker.publish(owner, "pr-call", preparation.prepared, f.approval(preparation.prepared));
    expect(result).toMatchObject(body === null ? { ok: true, operation: "pr_create", resource: { body: "" } } : { ok: false, code: "outcome_unknown", retrySafe: false });
  }
});
test("PR stale approval and malformed preparation retain the requested operation name", async () => {
  const f = prFixture(); const prepared = await f.prepare();
  expect(await f.broker.publish(owner, "other-call", prepared, f.approval(prepared))).toMatchObject({ operation: "pr_create", code: "approval_stale" });
  expect(await f.broker.publish(owner, "pr-call", { ...prepared, digest: "invalid" }, f.approval(prepared))).toMatchObject({ operation: "pr_create", code: "approval_stale" });
});

test("same repository PR uses the same pinned numeric identity without requiring a fork", async () => {
  const f = prFixture(); const request = { ...prRequest, headRepository: prRequest.repository };
  const preparation = await f.broker.prepare(owner, "pr-call", request); if (!preparation.ok) throw new Error("Fixture failed");
  expect(preparation.prepared.pullRequest!.headRepository.id).toBe(20);
  f.state.post = async () => { const response = f.response(); response.data.head.repo = { id: 20, full_name: request.repository }; return response; };
  expect(await f.broker.publish(owner, "pr-call", preparation.prepared, f.approval(preparation.prepared))).toMatchObject({ ok: true, operation: "pr_create" });
  expect(f.calls.some(call => call.path === `/repos/${prRequest.headRepository}`)).toBe(false);
  expect(f.calls.find(call => call.method === "POST")!.body).toMatchObject({ head: "fixture-org:feature/topic", head_repo: "project", maintainer_can_modify: false });
});
test("a created PR claiming maintainer edits were enabled is not presented as the approved publication", async () => {
  const f = prFixture(); const prepared = await f.prepare();
  f.state.post = async () => ({ ...f.response(), data: { ...f.response().data, maintainer_can_modify: true } });
  expect(await f.broker.publish(owner, "pr-call", prepared, f.approval(prepared))).toMatchObject({ ok: false, code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
});

test("comment consumed outcome truth survives account drift, custody outage and source revocation without releasing stored content", async () => {
  for (const variant of ["account", "custody", "authority"] as const) {
    const f = fixture(); const prepared = await f.prepare();
    f.state.post = async () => { throw new Error("Synthetic lost reply"); };
    const first = await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared));
    if (variant === "account") f.state.accountId = 99;
    if (variant === "custody") f.broker.ports.credentials.withClient = async () => { throw new Error("Synthetic custody unavailable"); };
    if (variant === "authority") f.state.current = false;
    expect(await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared))).toEqual(first);
    expect(first).toMatchObject({ operation: "comment_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  }
});
test("source revocation withholds a consumed successful receipt while preserving sent-effect uncertainty", async () => {
  const f = fixture(); const prepared = await f.prepare();
  expect(await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared))).toMatchObject({ ok: true });
  f.state.current = false;
  const result = await f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared));
  expect(result).toEqual({ ok: false, operation: "comment_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

test("retired generation redelivery retains content-free sent-effect truth for comment and PR without another POST", async () => {
  const comment = fixture(); const commentPrepared = await comment.prepare();
  const pr = prFixture(); const prPrepared = await pr.prepare();
  await comment.broker.publish(owner, "call-fixture", commentPrepared, comment.approval(commentPrepared));
  await pr.broker.publish(owner, "pr-call", prPrepared, pr.approval(prPrepared));
  comment.preparations.dispose(); pr.preparations.dispose();
  expect(await comment.broker.publish(owner, "call-fixture", commentPrepared, comment.approval(commentPrepared))).toEqual({ ok: false, operation: "comment_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  expect(await pr.broker.publish(owner, "pr-call", prPrepared, pr.approval(prPrepared))).toEqual({ ok: false, operation: "pr_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  expect(comment.calls.filter(call => call.method === "POST")).toHaveLength(1); expect(pr.calls.filter(call => call.method === "POST")).toHaveLength(1);
});

test("concurrent redelivery whose custody fails after another call sends POST preserves sent-effect truth", async () => {
  const f = fixture(); const prepared = await f.prepare(); const entered = barrier<void>(); const sendReply = barrier<GitHubApiResponse>();
  const custodyReply = barrier<void>(); const original = f.broker.ports.credentials.withClient; let attempts = 0;
  f.broker.ports.credentials.withClient = async (signal, action) => {
    attempts += 1;
    if (attempts === 2) { await custodyReply.promise; throw new Error("Synthetic custody unavailable"); }
    return original(signal, action);
  };
  f.state.post = async () => { entered.resolve(); return sendReply.promise; };
  const first = f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared));
  const second = f.broker.publish(owner, "call-fixture", prepared, f.approval(prepared));
  await entered.promise; custodyReply.resolve();
  expect(await second).toEqual({ ok: false, operation: "comment_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  sendReply.resolve({ status: 201, data: { id: 40, body: request.body } }); expect((await first).ok).toBe(true);
  expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
});
