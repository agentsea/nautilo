import {
  parseGitHubPublishApproval,
  type GitHubPreparedGitPush,
  type GitHubPreparedPublication,
} from "@nautilo/types";

function isPreparedGitPush(prepared: GitHubPreparedPublication): prepared is GitHubPreparedGitPush {
  return prepared.request.operation === "push";
}

/** Full exact publishing payload, rendered as text rather than executable markup. */
export function GitHubPublishApprovalDetail({ approval }: { approval: unknown }) {
  const parsed = parseGitHubPublishApproval(approval);
  if (!parsed) return <p role="alert">Exact GitHub review is unavailable. Publishing is blocked.</p>;
  if (isPreparedGitPush(parsed.prepared)) {
    const { remote, local } = parsed.prepared;
    return <section aria-label="GitHub publishing review" className="mt-3 space-y-2 text-sm">
      <p>Account: {remote.accountLogin} (ID {remote.accountId})</p>
      <p>Repository: {remote.repository} (ID {remote.repositoryId})</p>
      <p>Destination: {remote.branch} at {remote.oid ?? "new branch"}</p>
      <p>Source: {local.sourceBranch} at {local.sourceOid}</p>
      <p>This approves one exact fast-forward push. An uncertain result will not be retried automatically.</p>
    </section>;
  }
  const { account, repository, resource, request, pullRequest } = parsed.prepared;
  return <section aria-label="GitHub publishing review" className="mt-3 space-y-2 text-sm">
    <p>Account: {account.login} (ID {account.id})</p>
    <p>Repository: {repository.fullName} (ID {repository.id})</p>
    {resource ? <p>Target: {resource.kind} #{resource.number} — {resource.title} (ID {resource.id})</p> : null}
    {request.operation === "pr_create" && pullRequest ? <>
      <p>Base: {repository.fullName}:{pullRequest.base.ref} at {pullRequest.base.sha}</p>
      <p>Head: {pullRequest.headRepository.fullName}:{pullRequest.head.ref} at {pullRequest.head.sha} (repository ID {pullRequest.headRepository.id})</p>
      <p>Title: {request.title}</p><p>{request.draft ? "Draft pull request" : "Ready for review"}; maintainer edits disabled.</p>
      <p>GitHub may observe branch movement during creation; this approval cannot guarantee an exact commit.</p>
    </> : null}
    {request.operation === "comment_create" || request.operation === "pr_create"
      ? <pre aria-label="Exact publishing body" className="whitespace-pre-wrap break-words">{request.body || "(empty body)"}</pre> : null}
    <p>This approves one exact publication. An uncertain result will not be retried automatically.</p>
  </section>;
}
