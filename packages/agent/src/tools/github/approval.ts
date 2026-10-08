import { parseGitHubPreparedOperation, type GitHubPreparedOperation } from "../../../../types/src/github-broker";

export interface GitHubPublishReview {
  readonly type: "approval_ask";
  readonly approvalId: string;
  readonly allowedVerbs: readonly ["once", "deny"];
  readonly requiresExplicitReview: true;
  readonly prepared: GitHubPreparedOperation;
}

/** The full exact preparation belongs in the durable graph checkpoint. Neither
 * an auto-approval flag nor a previous call's Once reply authorizes publishing. */
export function githubPublishReview(prepared: GitHubPreparedOperation): GitHubPublishReview {
  if (!parseGitHubPreparedOperation(prepared) || !["comment_create", "pr_create"].includes(prepared.request.operation)) throw new Error("GitHub publishing review requires an exact prepared publishing operation");
  return { type: "approval_ask", approvalId: `github-publish:${prepared.preparationId}:${prepared.digest}`,
    allowedVerbs: ["once", "deny"], requiresExplicitReview: true, prepared: structuredClone(prepared) };
}

export function isGitHubPublishApproved(review: GitHubPublishReview, decision: unknown): boolean {
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) return false;
  const value = decision as Record<string, unknown>;
  return value["approved"] === true && value["verb"] === "once" && value["approvalId"] === review.approvalId;
}
