import { expect, test } from "bun:test";
import { digestGitHubPreparation, parseGitHubInvocationOwner, parseGitHubOperation, parseGitHubPreparedOperation,
  type GitHubInvocationOwner, type GitHubPreparedOperation } from "../../src/github-broker";

const owner: GitHubInvocationOwner = { instanceId: "", humanUserId: "human-fixture", agentId: "agent-fixture",
  roomId: "room-fixture", conversationId: "conversation-fixture", runId: "run-fixture", relayId: "relay-fixture",
  desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", serverOrigin: "https://server.example",
  serverFingerprint: "fingerprint-fixture", profileId: "profile-fixture", profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
const prepared: Omit<GitHubPreparedOperation, "digest"> = { version: 1, preparationId: "preparation-fixture", generation: "generation-fixture",
  toolCallId: "call-fixture", request: { operation: "comment_create", repository: "fixture-org/project", number: 12, body: "An approved comment." },
  account: { id: 10, login: "fixture-user" }, repository: { id: 20, fullName: "fixture-org/project", htmlUrl: "https://github.com/fixture-org/project" },
  resource: { id: 30, number: 12, kind: "issue", htmlUrl: "https://github.com/fixture-org/project/issues/12", title: "Fixture", body: "Details", state: "open" } };

test("typed GitHub grammar closes URL, shell, credential and unsupported publishing fields", () => {
  expect(parseGitHubOperation({ operation: "account_status" })).toEqual({ operation: "account_status" });
  expect(parseGitHubOperation({ operation: "account_status", token: "synthetic-provider-value" })).toBeNull();
  expect(parseGitHubOperation({ operation: "pr_read", repository: "fixture-org/project", number: 12 })).not.toBeNull();
  for (const repository of ["https://github.com/fixture-org/project", "../project", "fixture-org/..", "fixture-org/project?x=1", "fixture-org/project/other"]) {
    expect(parseGitHubOperation({ operation: "issue_read", repository, number: 12 })).toBeNull();
  }
  for (const invalid of [{ ...prepared.request, token: "synthetic-provider-value" }, { ...prepared.request, operation: "merge" },
    { ...prepared.request, body: " " }, { ...prepared.request, number: Number.MAX_SAFE_INTEGER + 1 }, { ...prepared.request, number: 0 }]) {
    expect(parseGitHubOperation(invalid)).toBeNull();
  }
});
test("owner permits default instance but rejects missing, additional or malformed authority", () => {
  expect(parseGitHubInvocationOwner(owner)).toEqual(owner);
  expect(parseGitHubInvocationOwner({ ...owner, token: "synthetic-provider-value" })).toBeNull();
  expect(parseGitHubInvocationOwner({ ...owner, instanceId: " " })).toBeNull();
  expect(parseGitHubInvocationOwner({ ...owner, profileRevision: Infinity })).toBeNull();
  expect(parseGitHubInvocationOwner({ ...owner, serverOrigin: "https://server.example/path" })).toBeNull();
});
test("preparation digest pins every authority dimension, target identity and exact comment bytes", async () => {
  const digest = await digestGitHubPreparation(owner, prepared);
  for (const key of Object.keys(owner) as (keyof GitHubInvocationOwner)[]) {
    const value = owner[key];
    expect(await digestGitHubPreparation({ ...owner, [key]: typeof value === "number" ? value + 1 : `${value}-changed` }, prepared)).not.toBe(digest);
  }
  for (const changed of [{ ...prepared, account: { ...prepared.account, id: 11 } }, { ...prepared, repository: { ...prepared.repository, id: 21 } },
    { ...prepared, resource: { ...prepared.resource!, id: 31 } }, { ...prepared, toolCallId: "other-call" },
    { ...prepared, request: { operation: "comment_create" as const, repository: "fixture-org/project", number: 12, body: "An approved comment.\n" } }]) {
    expect(await digestGitHubPreparation(owner, changed)).not.toBe(digest);
  }
});
test("closed preparation rejects forged links, marker coercion and private metadata", async () => {
  const value = { ...prepared, digest: await digestGitHubPreparation(owner, prepared) };
  expect(parseGitHubPreparedOperation(value)).toEqual(value);
  for (const invalid of [{ ...value, token: "synthetic-provider-value" }, { ...value, version: [1] },
    { ...value, repository: { ...value.repository, htmlUrl: "https://other.example/project" } },
    { ...value, resource: { ...value.resource, kind: ["issue"] } }]) expect(parseGitHubPreparedOperation(invalid)).toBeNull();
  expect(parseGitHubPreparedOperation({ ...value, request: { operation: "account_status" } })).toBeNull();
});

const createRequest = { operation: "pr_create" as const, repository: "fixture-org/project", headRepository: "fixture-user/fork", baseBranch: "main",
  headBranch: "feature/topic", title: "A reviewed change", body: "Complete body", draft: false };
const createPrepared: Omit<GitHubPreparedOperation, "digest"> = { ...prepared, request: createRequest, resource: null,
  pullRequest: { headRepository: { id: 21, fullName: createRequest.headRepository, htmlUrl: `https://github.com/${createRequest.headRepository}` },
    forkNetworkId: 20, maintainerCanModify: false, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature/topic", sha: "b".repeat(40) } } };
test("PR grammar closes publishing options and requires unambiguous branch names", () => {
  expect(parseGitHubOperation(createRequest)).toEqual(createRequest);
  for (const invalid of [{ ...createRequest, draft: [false] }, { ...createRequest, issue: 12 }, { ...createRequest, maintainer_can_modify: true },
    { ...createRequest, headRepository: "https://other.example/fork" }, ...["..", "-bad..ref", "a.lock", ".hidden", "a@{b", "a:b", "a\n", "a//b", "a/"].map(headBranch => ({ ...createRequest, headBranch }))]) {
    expect(parseGitHubOperation(invalid)).toBeNull();
  }
});
test("PR digest pins payload, both repositories and observed branch SHAs", async () => {
  const digest = await digestGitHubPreparation(owner, createPrepared);
  const parsed = { ...createPrepared, digest };
  expect(parseGitHubPreparedOperation(parsed)).toEqual(parsed);
  for (const key of ["title", "body", "baseBranch", "headBranch", "headRepository", "repository", "draft"] as const) {
    const value = createRequest[key];
    const request = { ...createRequest, [key]: typeof value === "boolean" ? !value : `${value}-changed` };
    expect(await digestGitHubPreparation(owner, { ...createPrepared, request })).not.toBe(digest);
  }
  for (const pullRequest of [{ ...createPrepared.pullRequest!, forkNetworkId: 99 },
    { ...createPrepared.pullRequest!, headRepository: { ...createPrepared.pullRequest!.headRepository, id: 99 } },
    { ...createPrepared.pullRequest!, base: { ...createPrepared.pullRequest!.base, sha: "c".repeat(40) } },
    { ...createPrepared.pullRequest!, head: { ...createPrepared.pullRequest!.head, sha: "c".repeat(40) } }]) {
    expect(await digestGitHubPreparation(owner, { ...createPrepared, pullRequest })).not.toBe(digest);
  }
  for (const invalid of [{ ...parsed, resource: prepared.resource }, { ...parsed, pullRequest: undefined },
    { ...parsed, pullRequest: { ...parsed.pullRequest, forkNetworkId: [20] } },
    { ...parsed, pullRequest: { ...parsed.pullRequest, head: { ref: "feature/topic", sha: "not-an-oid" } } },
    { ...parsed, pullRequest: { ...parsed.pullRequest, token: "synthetic-provider-field" } }]) expect(parseGitHubPreparedOperation(invalid)).toBeNull();
});

test("parsed PR preparation owns isolated closed nested objects", async () => {
  const value = { ...structuredClone(createPrepared), digest: await digestGitHubPreparation(owner, createPrepared) };
  const parsed = parseGitHubPreparedOperation(value)!;
  Object.assign(value.account, { id: 99 }); Object.assign(value.repository, { id: 99 });
  Object.assign(value.pullRequest!.headRepository, { id: 99 }); Object.assign(value.pullRequest!.head, { sha: "c".repeat(40) });
  Object.assign(value.request, { title: "Replacement" });
  expect(parsed.account.id).toBe(10); expect(parsed.repository.id).toBe(20); expect(parsed.pullRequest!.headRepository.id).toBe(21);
  expect(parsed.pullRequest!.head.sha).toBe("b".repeat(40)); expect(parsed.request).toEqual(createRequest);
});

test("authenticated Git grammar is separate from REST and rejects ambient transport selectors", async () => {
  const { parseGitHubGitOperation, parseGitHubOperation } = await import("../../src/github-broker");
  const fetch = { operation: "fetch" as const, repository: "fixture-org/project", branch: "main" };
  const push = { operation: "push" as const, repository: "fixture-org/project", sourceBranch: "feature/test", destinationBranch: "main" };
  expect(parseGitHubGitOperation(fetch)).toEqual(fetch); expect(parseGitHubGitOperation(push)).toEqual(push);
  expect(parseGitHubOperation(fetch)).toBeNull(); expect(parseGitHubOperation(push)).toBeNull();
  for (const extra of [{ url: "https://other.invalid/repo" }, { force: true }, { env: {} }, { helper: "custom" }]) expect(parseGitHubGitOperation({ ...push, ...extra })).toBeNull();
  for (const branch of ["--force", "../other", "main:other", "main\nother", "refs/.hidden/main"]) expect(parseGitHubGitOperation({ ...push, sourceBranch: branch })).toBeNull();
});

test("clone and pull grammar pins branch and one child without shell/force/merge selectors", async () => {
  const { parseGitHubGitOperation, parseGitHubOperation } = await import("../../src/github-broker");
  const clone = { operation: "clone" as const, repository: "fixture-org/project", branch: "main", directory: "project" };
  const pull = { operation: "pull" as const, repository: "fixture-org/project", branch: "main" };
  expect(parseGitHubGitOperation(clone)).toEqual(clone);
  expect(parseGitHubGitOperation(pull)).toEqual(pull);
  expect(parseGitHubOperation(clone)).toBeNull(); expect(parseGitHubOperation(pull)).toBeNull();
  for (const directory of ["..", "../project", "/absolute", ".git", "project/child", "-flag", "trailing.", "path\0suffix"]) {
    expect(parseGitHubGitOperation({ ...clone, directory })).toBeNull();
  }
  for (const extra of [{ force: true }, { rebase: true }, { directory: "other" }, { credential: "synthetic" }]) {
    expect(parseGitHubGitOperation({ ...pull, ...extra })).toBeNull();
  }
});
