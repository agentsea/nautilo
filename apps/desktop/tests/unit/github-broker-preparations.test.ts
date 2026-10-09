import { expect, spyOn, test } from "bun:test";
import { GitHubPreparations, type GitHubPreparationResult } from "../../electron/github-broker/preparations";
import type { GitHubInvocationOwner, GitHubPreparedOperation } from "../../../../packages/types/src/github-broker";

const owner: GitHubInvocationOwner = { instanceId: "", humanUserId: "human-fixture", agentId: "agent-fixture", roomId: "room-fixture",
  conversationId: "conversation-fixture", runId: "run-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture",
  pairingGeneration: "pairing-fixture", serverOrigin: "https://server.example", serverFingerprint: "fingerprint-fixture", profileId: "profile-fixture",
  profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
const request = { operation: "comment_create" as const, repository: "fixture-org/project", number: 12, body: "An approved comment." };
function prepared(preparationId: string): GitHubPreparedOperation {
  return { version: 1, preparationId, generation: "generation-fixture", toolCallId: "call-fixture", digest: "a".repeat(64), request,
    account: { id: 10, login: "fixture-user" }, repository: { id: 20, fullName: request.repository, htmlUrl: "https://github.com/fixture-org/project" },
    resource: { id: 30, number: 12, kind: "issue", htmlUrl: "https://github.com/fixture-org/project/issues/12", title: "Fixture", body: "Details", state: "open" } };
}
test("same immutable call reserves once and mutable authority drift conflicts rather than creating a new identity", async () => {
  const store = new GitHubPreparations({ generation: "generation-fixture", capacity: 2 }); let calls = 0;
  const create = async (preparationId: string): Promise<GitHubPreparationResult> => { calls += 1; return { ok: true, prepared: prepared(preparationId) }; };
  const first = await store.prepare(owner, "call-fixture", request, create);
  expect(await store.prepare(owner, "call-fixture", request, create)).toEqual(first);
  for (const changed of [{ ...owner, profileRevision: 2 }, { ...owner, grantRevision: 2 }, { ...owner, serverFingerprint: "other-fingerprint" }]) {
    expect(await store.prepare(changed, "call-fixture", request, create)).toMatchObject({ ok: false, result: { code: "approval_stale" } });
  }
  expect(calls).toBe(1);
});
test("concurrent preparation joins the reserved identity before asynchronous account probes", async () => {
  const store = new GitHubPreparations({ generation: "generation-fixture", capacity: 1 }); let resolve!: (value: GitHubPreparationResult) => void; let calls = 0;
  const first = store.prepare(owner, "call-fixture", request, async preparationId => {
    calls += 1; return new Promise(done => { resolve = value => done(value); queueMicrotask(() => resolve({ ok: true, prepared: prepared(preparationId) })); });
  });
  const second = store.prepare(owner, "call-fixture", request, async () => { throw new Error("Must not probe twice"); });
  expect(await first).toEqual(await second); expect(calls).toBe(1);
});
test("capacity refuses new identities without evicting a consumed outcome", async () => {
  const store = new GitHubPreparations({ generation: "generation-fixture", capacity: 1 });
  const first = await store.prepare(owner, "call-fixture", request, async preparationId => ({ ok: true, prepared: prepared(preparationId) }));
  if (!first.ok) throw new Error("Fixture failed");
  const claim = store.consume(owner, "call-fixture", first.prepared); expect(claim.kind).toBe("claimed");
  if (claim.kind === "claimed") claim.finish({ ok: false, operation: "comment_create", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  expect(await store.prepare(owner, "other-call", request, async () => { throw new Error("Capacity must refuse"); })).toMatchObject({ ok: false, result: { code: "capacity_exhausted" } });
  expect(store.consume(owner, "call-fixture", first.prepared).kind).toBe("existing");
});
test("retirement is idempotent, fences delayed preparation and settles in-flight publishing unknown", async () => {
  const store = new GitHubPreparations({ generation: "generation-fixture", capacity: 2 });
  const first = await store.prepare(owner, "call-fixture", request, async preparationId => ({ ok: true, prepared: prepared(preparationId) }));
  if (!first.ok) throw new Error("Fixture failed");
  store.consume(owner, "call-fixture", first.prepared);
  const waiting = store.consume(owner, "call-fixture", first.prepared);
  store.dispose(); store.dispose();
  if (waiting.kind !== "existing") throw new Error("Fixture missing joined effect");
  expect(await waiting.result).toMatchObject({ code: "outcome_unknown", retrySafe: false });
  expect(store.consume(owner, "call-fixture", first.prepared).kind).toBe("invalid");
  expect(await store.prepare(owner, "other-call", request, async () => { throw new Error("Retired"); })).toMatchObject({ ok: false, result: { code: "approval_stale" } });
});
test("retirement settles reserved preparation before an in-flight read returns, and late bytes cannot revive it", async () => {
  const store = new GitHubPreparations({ generation: "generation-fixture", capacity: 1 });
  let started!: () => void; const entered = new Promise<void>(done => { started = done; });
  let release!: () => void; const pending = new Promise<void>(done => { release = done; });
  const first = store.prepare(owner, "call-fixture", request, async preparationId => {
    started(); await pending; return { ok: true, prepared: prepared(preparationId) };
  });
  await entered; store.dispose();
  expect(await first).toMatchObject({ ok: false, result: { code: "approval_stale" } });
  release(); await pending;
  expect(await store.prepare(owner, "call-fixture", request, async () => { throw new Error("No resurrection"); })).toMatchObject({ ok: false, result: { code: "approval_stale" } });
});

async function gitPrepared(preparationId: string, toolCallId = "git-call") {
  const { digestGitHubGitPush } = await import("../../../../packages/types/src/github-broker");
  const value = { version: 1 as const, preparationId, generation: "generation-fixture", toolCallId,
    request: { operation: "push" as const, repository: "fixture-org/project", sourceBranch: "feature", destinationBranch: "main" },
    remote: { repository: "fixture-org/project", repositoryId: 20, accountId: 10, accountLogin: "fixture-user", branch: "main", oid: "a".repeat(40) },
    local: { identity: { workTree: "/fixture/project", gitDir: "/fixture/project/.git", commonDir: "/fixture/project/.git", isLinkedWorktree: false },
      sourceBranch: "feature", sourceOid: "b".repeat(40), objectFormat: "sha1" as const, indexHash: "c".repeat(64), repositoryStamp: "d".repeat(64) } };
  return { ...value, digest: await digestGitHubGitPush(owner, value) };
}
const gitRequest = { operation: "push" as const, repository: "fixture-org/project", sourceBranch: "feature", destinationBranch: "main" };
test("Git push shares publishing capacity and identity namespace without widening REST", async () => {
  const store = new GitHubPreparations({ generation: "generation-fixture", capacity: 1 });
  const git = await store.prepareGitPush(owner, "git-call", gitRequest, async id => ({ ok: true, prepared: await gitPrepared(id) }));
  expect(git.ok).toBe(true);
  expect(await store.prepare(owner, "rest-call", request, async () => { throw new Error("No capacity"); })).toMatchObject({ ok: false, result: { code: "capacity_exhausted" } });
  expect(await store.prepare(owner, "git-call", request, async () => { throw new Error("Cannot borrow Git identity"); })).toMatchObject({ ok: false, result: { code: "approval_stale" } });
});
test("Git push canonical key order matches and changed source, destination or owner cannot consume", async () => {
  const store = new GitHubPreparations({ generation: "generation-fixture", capacity: 1 });
  const git = await store.prepareGitPush(owner, "git-call", gitRequest, async id => {
    const value = await gitPrepared(id);
    return { ok: true, prepared: { digest: value.digest, local: { repositoryStamp: value.local.repositoryStamp, indexHash: value.local.indexHash,
      sourceOid: value.local.sourceOid, objectFormat: value.local.objectFormat, sourceBranch: value.local.sourceBranch, identity: { ...value.local.identity } },
      remote: value.remote, request: { destinationBranch: "main", sourceBranch: "feature", repository: "fixture-org/project", operation: "push" },
      toolCallId: value.toolCallId, generation: value.generation, preparationId: value.preparationId, version: 1 } };
  });
  if (!git.ok) throw new Error("Preparation failed");
  expect(store.matchesGitPush(owner, "git-call", git.prepared)).toBe(true);
  expect(store.consumeGitPush({ ...owner, agentId: "other" }, "git-call", git.prepared).kind).toBe("invalid");
  expect(store.consumeGitPush(owner, "git-call", { ...git.prepared, local: { ...git.prepared.local, sourceOid: "e".repeat(40) } }).kind).toBe("invalid");
  expect(store.consumeGitPush(owner, "git-call", { ...git.prepared, remote: { ...git.prepared.remote, oid: "e".repeat(40) } }).kind).toBe("invalid");
  const claim = store.consumeGitPush(owner, "git-call", git.prepared);
  expect(claim.kind).toBe("claimed");
  const joined = store.consumeGitPush(owner, "git-call", git.prepared); expect(joined.kind).toBe("existing");
  if (claim.kind !== "claimed" || joined.kind !== "existing") throw new Error("Missing claim");
  claim.finish({ ok: false, operation: "push", code: "outcome_unknown", sideEffectStarted: true, retrySafe: false });
  expect(await joined.result).toMatchObject({ code: "outcome_unknown", retrySafe: false });
  expect(await store.completionGitPush(owner, "git-call", git.prepared)).toMatchObject({ code: "outcome_unknown", retrySafe: false });
  store.dispose();
  expect(store.wasGitPushConsumed(owner, "git-call", git.prepared)).toBe(true);
  expect(store.consumeGitPush(owner, "git-call", git.prepared).kind).toBe("invalid");
});
test("Git preparation retirement fences delayed probes and bad digests", async () => {
  const store = new GitHubPreparations({ generation: "generation-fixture", capacity: 2 });
  expect(await store.prepareGitPush(owner, "bad", gitRequest, async id => ({ ok: true, prepared: { ...await gitPrepared(id, "bad"), digest: "0".repeat(64) } }))).toMatchObject({ ok: false, result: { code: "approval_stale" } });
  let release!: () => void; const barrier = new Promise<void>(done => { release = done; });
  const delayed = store.prepareGitPush(owner, "git-call", gitRequest, async id => { await barrier; return { ok: true, prepared: await gitPrepared(id) }; });
  store.dispose();
  expect(await delayed).toMatchObject({ ok: false, result: { code: "approval_stale" } });
  release(); await barrier;
  expect(await store.prepareGitPush(owner, "git-call", gitRequest, async () => { throw new Error("Cannot revive"); })).toMatchObject({ ok: false, result: { code: "approval_stale" } });
});

test("Git preparation stores the canonical object hashed before an asynchronous digest", async () => {
  const store = new GitHubPreparations({ generation: "generation-fixture", capacity: 1 });
  let mutated = false;
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let source: Awaited<ReturnType<typeof gitPrepared>> | undefined;
  const digest = spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
    if (source) { source.digest = "0".repeat(64); source.remote.oid = "e".repeat(40); mutated = true; }
    return original(algorithm, data);
  });
  try {
    const prepared = await store.prepareGitPush(owner, "git-call", gitRequest, async id => {
      source = await gitPrepared(id); return { ok: true, prepared: source };
    });
    expect(mutated).toBe(true);
    if (!prepared.ok) throw new Error("Canonical preparation should remain valid");
    expect(prepared.prepared.digest).not.toBe("0".repeat(64));
    expect(prepared.prepared.remote.oid).toBe("a".repeat(40));
    expect(store.matchesGitPush(owner, "git-call", prepared.prepared)).toBe(true);
  } finally { digest.mockRestore(); }
});
