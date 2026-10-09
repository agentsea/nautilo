import { expect, test } from "bun:test";
import { digestGitHubPreparation, type GitHubInvocationOwner, type GitHubPreparedOperation } from "@nautilo/types";
const owner: GitHubInvocationOwner = { instanceId: "", humanUserId: "human", agentId: "agent", roomId: "room", conversationId: "thread", runId: "turn", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "opaque-pair", serverOrigin: "https://server.example", serverFingerprint: "fingerprint", profileId: "profile", profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
const { agentId: _agent, roomId: _room, conversationId: _thread, runId: _run, ...identity } = owner;
void _agent; void _room; void _thread; void _run;
const capability = { version: 1 as const, generation: "generation", identity };
async function preparation(): Promise<GitHubPreparedOperation> {
  const value = { version: 1 as const, preparationId: "preparation", generation: "generation", toolCallId: "call", request: { operation: "comment_create" as const, repository: "fixture/project", number: 12, body: "Full approved body\n<script>literal</script>" }, account: { id: 1, login: "fixture" }, repository: { id: 2, fullName: "fixture/project", htmlUrl: "https://github.com/fixture/project" }, resource: { id: 3, number: 12, kind: "issue" as const, htmlUrl: "https://github.com/fixture/project/issues/12", title: "Fixture", body: "Original", state: "open" as const } };
  return { ...value, digest: await digestGitHubPreparation(owner, value) };
}
import { renderToStaticMarkup } from "react-dom/server";
import { GitHubPublishApprovalDetail } from "../../src/components/github-publish-approval-detail";
import { githubApprovalId } from "@nautilo/types";
void capability;
test("exact account, target and complete body render as inert text with no silent shortening", async () => {
  const prepared = await preparation();
  const html = renderToStaticMarkup(<GitHubPublishApprovalDetail approval={{ version: 1, approvalId: githubApprovalId(prepared), digest: prepared.digest, prepared }} />);
  expect(html).toContain("fixture"); expect(html).toContain("ID 1"); expect(html).toContain("fixture/project"); expect(html).toContain("#12");
  expect(html).toContain("Full approved body"); expect(html).toContain("&lt;script&gt;literal&lt;/script&gt;"); expect(html).not.toContain("<script>");
  expect(html).not.toContain(owner.serverFingerprint);
});
test("malformed review cannot render an apparent publication approval", () => {
  const html = renderToStaticMarkup(<GitHubPublishApprovalDetail approval={{ version: 1, digest: "bad" }} />);
  expect(html).toContain('role="alert"'); expect(html).toContain("Publishing is blocked");
});
test("pull request review includes both repository IDs, branches, OIDs, title and empty-body truth", async () => {
  const original = await preparation();
  const request = { operation: "pr_create" as const, repository: "fixture/project", headRepository: "fixture/fork", baseBranch: "main", headBranch: "feature", title: "Exact title", body: "", draft: true };
  const prepared = { ...original, request, resource: null, pullRequest: { headRepository: { id: 4, fullName: "fixture/fork", htmlUrl: "https://github.com/fixture/fork" }, forkNetworkId: 2, maintainerCanModify: false as const, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature", sha: "b".repeat(40) } } };
  const html = renderToStaticMarkup(<GitHubPublishApprovalDetail approval={{ version: 1, approvalId: githubApprovalId(prepared), digest: prepared.digest, prepared }} />);
  for (const text of ["fixture/project:main", "fixture/fork:feature", "a".repeat(40), "b".repeat(40), "ID 4", "Exact title", "(empty body)", "Draft", "maintainer edits disabled"]) expect(html).toContain(text);
});

import { initialApprovalLifecycleState, reduceApprovalLifecycle, deriveApprovalAskView, type ApprovalAskPayload } from "../../src/approval/approval-lifecycle";
import { gitHubReviewFromPendingApproval } from "@nautilo/types";
test("existing approval owner retains exact GitHub review after lost acknowledgement and clears it only for the matching terminal event", async () => {
  const prepared = await preparation(), approvalId = githubApprovalId(prepared);
  const github = { version: 1 as const, approvalId, digest: prepared.digest, prepared };
  const payload: ApprovalAskPayload & { github: typeof github } = { approvalId, github, threadId: "thread", laneKey: "thread", tools: [{ name: "local_github", args: {} }], reason: "Publish", reasonCode: "destructive-tool", network: null, allowedVerbs: ["once", "deny"], scopeInfo: [], requiresExplicitReview: true };
  let lifecycle = reduceApprovalLifecycle(initialApprovalLifecycleState(), { kind: "ask", payload });
  expect(gitHubReviewFromPendingApproval(lifecycle.pending)).toEqual(github);
  lifecycle = reduceApprovalLifecycle(lifecycle, { kind: "submitStart" });
  lifecycle = reduceApprovalLifecycle(lifecycle, { kind: "submitError", error: "Reply lost" });
  expect(deriveApprovalAskView(lifecycle).show).toBeTrue(); expect(gitHubReviewFromPendingApproval(lifecycle.pending)).toEqual(github);
  lifecycle = reduceApprovalLifecycle(lifecycle, { kind: "resolved", approvalId: "other", resolution: "approved" });
  expect(gitHubReviewFromPendingApproval(lifecycle.pending)).toEqual(github);
  lifecycle = reduceApprovalLifecycle(lifecycle, { kind: "resolved", approvalId, resolution: "approved" });
  expect(gitHubReviewFromPendingApproval(lifecycle.pending)).toBeNull();
  lifecycle = reduceApprovalLifecycle(lifecycle, { kind: "ask", payload });
  expect(gitHubReviewFromPendingApproval(lifecycle.pending)).toBeNull();
});
