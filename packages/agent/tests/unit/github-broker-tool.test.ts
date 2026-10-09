import { expect, test } from "bun:test";
import { githubSchema, createGitHubTool } from "../../src/tools/github/github";
import { githubPublishReview, isGitHubPublishApproved } from "../../src/tools/github/approval";
import type { GitHubPreparedOperation } from "../../../types/src/github-broker";

const prepared: GitHubPreparedOperation = { version: 1, preparationId: "preparation-fixture", generation: "generation-fixture",
  toolCallId: "call-fixture", digest: "a".repeat(64), request: { operation: "comment_create", repository: "fixture-org/project", number: 12, body: "An approved comment." },
  account: { id: 10, login: "fixture-user" }, repository: { id: 20, fullName: "fixture-org/project", htmlUrl: "https://github.com/fixture-org/project" },
  resource: { id: 30, number: 12, kind: "issue", htmlUrl: "https://github.com/fixture-org/project/issues/12", title: "Fixture", body: "Details", state: "open" } };
test("model tool allows only the typed operations and has no local execution fallback", async () => {
  expect(createGitHubTool().name).toBe("local_github");
  expect(githubSchema.safeParse(prepared.request).success).toBe(true);
  for (const invalid of [{ ...prepared.request, prepared }, { ...prepared.request, approvalObtained: true },
    { ...prepared.request, command: "gh api" }, { ...prepared.request, repository: "https://github.com/fixture-org/project" }]) {
    expect(githubSchema.safeParse(invalid).success).toBe(false);
  }
  const failure = await createGitHubTool().invoke({ operation: "issue_read", repository: "fixture-org/project", number: 12 }).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain("admitted Desktop account broker");
});
test("publishing review permits only exact one-time explicit Human reply", () => {
  const review = githubPublishReview(prepared);
  expect(review.allowedVerbs).toEqual(["once", "deny"]); expect(review.requiresExplicitReview).toBe(true);
  expect(review.prepared.request).toEqual(prepared.request);
  expect(isGitHubPublishApproved(review, { approved: true, verb: "once", approvalId: review.approvalId })).toBe(true);
  for (const decision of [null, { approved: true, verb: "always", approvalId: review.approvalId },
    { approved: true, verb: "room", approvalId: review.approvalId }, { approved: true, verb: "once", approvalId: "other" },
    { approved: false, verb: "deny", approvalId: review.approvalId }, { approved: true, verb: "once" }]) {
    expect(isGitHubPublishApproved(review, decision)).toBe(false);
  }
  expect(() => githubPublishReview({ ...prepared, request: { operation: "issue_read", repository: "fixture-org/project", number: 12 } })).toThrow();
});
test("checkpoint preview is independent of mutable caller objects", () => {
  const source = structuredClone(prepared); const review = githubPublishReview(source);
  (source.request as { body: string }).body = "Changed later";
  expect((review.prepared.request as { body: string }).body).toBe("An approved comment.");
});

test("PR creation review exposes full branches and payload and accepts only exact Once", () => {
  const request = { operation: "pr_create" as const, repository: "fixture-org/project", headRepository: "fixture-user/fork", baseBranch: "main",
    headBranch: "feature/topic", title: "A reviewed change", body: "Complete body", draft: true };
  const value: GitHubPreparedOperation = { ...prepared, request, resource: null,
    pullRequest: { headRepository: { id: 21, fullName: request.headRepository, htmlUrl: `https://github.com/${request.headRepository}` },
      forkNetworkId: 20, maintainerCanModify: false, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature/topic", sha: "b".repeat(40) } } };
  expect(githubSchema.safeParse(request).success).toBe(true);
  expect(githubSchema.safeParse({ ...request, approvalObtained: true }).success).toBe(false);
  const review = githubPublishReview(value); expect(review.prepared).toEqual(value);
  expect(review.allowedVerbs).toEqual(["once", "deny"]);
  expect(isGitHubPublishApproved(review, { approved: true, verb: "once", approvalId: review.approvalId })).toBe(true);
  expect(isGitHubPublishApproved(review, { approved: true, verb: "always", approvalId: review.approvalId })).toBe(false);
});
