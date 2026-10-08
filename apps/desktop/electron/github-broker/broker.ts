import { digestGitHubPreparation, githubFailure, parseGitHubInvocationOwner, parseGitHubOperation, parseGitHubPreparedOperation,
  type GitHubAccount, type GitHubBrokerResult, type GitHubFailureCode, type GitHubInvocationOwner,
  type GitHubOperation, type GitHubPullRequestPreparation, type GitHubPreparedOperation, type GitHubRepository, type GitHubResource } from "../../../../packages/types/src/github-broker";
import type { GitHubPreparedPublication } from "../../../../packages/types/src/github-invocation";
import type { GitHubApiClient, GitHubCredentialProvider } from "./credentials";
import { GitHubPreparations, type GitHubPreparationResult } from "./preparations";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function id(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function httpFailure(status: number): GitHubFailureCode {
  return status === 401 ? "account_unavailable" : status === 404 ? "not_found" : status === 403 ? "permission_denied"
    : status === 429 ? "rate_limited" : "request_failed";
}
class GitHubResolutionFailure extends Error {
  constructor(readonly code: GitHubFailureCode) { super(code); }
}
function failureCode(error: unknown): GitHubFailureCode {
  return error instanceof GitHubResolutionFailure ? error.code
    : error instanceof Error && error.message === "GITHUB_ACCOUNT_UNAVAILABLE" ? "account_unavailable" : "request_failed";
}
interface Resolved { account: GitHubAccount; repository: GitHubRepository; resource: GitHubResource }
interface ResolvedPullRequest { account: GitHubAccount; repository: GitHubRepository; resource: null; pullRequest: GitHubPullRequestPreparation }
type CreateRequest = Extract<GitHubOperation, { operation: "pr_create" }>;

export interface GitHubPublishingApproval {
  readonly verb: "once";
  readonly approvalId: string;
  readonly digest: string;
}
export interface GitHubBrokerPorts {
  readonly credentials: GitHubCredentialProvider;
  readonly preparations: GitHubPreparations;
  /** Fresh exact local and server/Room/crypto/account integration authority. */
  readonly isCurrent: (owner: GitHubInvocationOwner) => Promise<boolean>;
  /** Synchronous owner/session epoch fence, including immediately before POST. */
  readonly isCurrentNow: (owner: GitHubInvocationOwner) => boolean;
  /** Trusted admission owner verifies the durable exact Human reply. Never a
   * model flag, standing shell approval or an Auto-Approve bypass. */
  readonly isPublishingApproved: (owner: GitHubInvocationOwner, prepared: GitHubPreparedPublication, approval: GitHubPublishingApproval) => Promise<boolean>;
}

export class GitHubBroker {
  constructor(readonly ports: GitHubBrokerPorts) {}
  async #current(owner: GitHubInvocationOwner, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !parseGitHubInvocationOwner(owner) || !this.ports.isCurrentNow(owner)
      || !await this.ports.isCurrent(owner) || signal?.aborted || !this.ports.isCurrentNow(owner)) {
      throw new GitHubResolutionFailure("authority_changed");
    }
  }
  async #resolve(client: GitHubApiClient, owner: GitHubInvocationOwner, request: Exclude<GitHubOperation, CreateRequest>, signal?: AbortSignal): Promise<Resolved> {
    await this.#current(owner, signal);
    const user = await client.request("GET", "/user");
    if (user.status !== 200) throw new GitHubResolutionFailure(httpFailure(user.status));
    const accountValue = object(user.data);
    if (!accountValue || !id(accountValue["id"]) || typeof accountValue["login"] !== "string"
      || !/^[A-Za-z0-9-]+$/.test(accountValue["login"])) throw new GitHubResolutionFailure("account_unavailable");
    const account: GitHubAccount = { id: accountValue["id"], login: accountValue["login"] };
    await this.#current(owner, signal);
    const repo = await client.request("GET", `/repos/${request.repository}`);
    if (repo.status !== 200) throw new GitHubResolutionFailure(httpFailure(repo.status));
    const repositoryValue = object(repo.data);
    if (!repositoryValue || !id(repositoryValue["id"]) || typeof repositoryValue["full_name"] !== "string"
      || repositoryValue["full_name"].toLowerCase() !== request.repository.toLowerCase()) throw new GitHubResolutionFailure("resource_changed");
    const repository: GitHubRepository = { id: repositoryValue["id"], fullName: request.repository, htmlUrl: `https://github.com/${request.repository}` };
    await this.#current(owner, signal);
    const response = await client.request("GET", `/repos/${request.repository}/${request.operation === "pr_read" ? "pulls" : "issues"}/${request.number}`);
    if (response.status !== 200) throw new GitHubResolutionFailure(httpFailure(response.status));
    const value = object(response.data);
    if (!value || !id(value["id"]) || value["number"] !== request.number || typeof value["title"] !== "string"
      || (value["body"] !== null && typeof value["body"] !== "string") || !["open", "closed"].includes(value["state"] as string)) throw new GitHubResolutionFailure("resource_changed");
    const kind = request.operation === "pr_read" || object(value["pull_request"]) ? "pull_request" : "issue";
    const resource: GitHubResource = { id: value["id"], number: request.number, kind,
      htmlUrl: `${repository.htmlUrl}/${kind === "pull_request" ? "pull" : "issues"}/${request.number}`,
      title: value["title"], body: value["body"] ?? "", state: value["state"] as "open" | "closed" };
    await this.#current(owner, signal);
    return { account, repository, resource };
  }
  async #resolvePullRequest(client: GitHubApiClient, owner: GitHubInvocationOwner, request: CreateRequest, signal?: AbortSignal): Promise<ResolvedPullRequest> {
    await this.#current(owner, signal);
    const response = await client.request("GET", "/user");
    if (response.status !== 200) throw new GitHubResolutionFailure(httpFailure(response.status));
    const user = object(response.data);
    if (!user || !id(user["id"]) || typeof user["login"] !== "string" || !/^[A-Za-z0-9-]+$/.test(user["login"])) throw new GitHubResolutionFailure("account_unavailable");
    const account = { id: user["id"], login: user["login"] };
    const resolveRepository = async (name: string) => {
      await this.#current(owner, signal);
      const response = await client.request("GET", `/repos/${name}`);
      if (response.status !== 200) throw new GitHubResolutionFailure(httpFailure(response.status));
      const value = object(response.data);
      if (!value || !id(value["id"]) || typeof value["full_name"] !== "string" || value["full_name"].toLowerCase() !== name.toLowerCase()
        || typeof value["fork"] !== "boolean") throw new GitHubResolutionFailure("resource_changed");
      const source = object(value["source"]);
      const networkId = value["fork"] === false ? value["id"] : source?.["id"];
      if (!id(networkId)) throw new GitHubResolutionFailure("resource_changed");
      return { repository: { id: value["id"], fullName: name, htmlUrl: `https://github.com/${name}` }, networkId };
    };
    const baseRepository = await resolveRepository(request.repository);
    const headRepository = request.headRepository.toLowerCase() === request.repository.toLowerCase()
      ? { ...baseRepository, repository: { ...baseRepository.repository, fullName: request.headRepository, htmlUrl: `https://github.com/${request.headRepository}` } }
      : await resolveRepository(request.headRepository);
    if (baseRepository.networkId !== headRepository.networkId) throw new GitHubResolutionFailure("resource_changed");
    const resolveBranch = async (repository: string, branch: string) => {
      await this.#current(owner, signal);
      const response = await client.request("GET", `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (response.status !== 200) throw new GitHubResolutionFailure(httpFailure(response.status));
      const value = object(response.data), commit = object(value?.["object"]);
      if (!value || value["ref"] !== `refs/heads/${branch}` || commit?.["type"] !== "commit"
        || typeof commit["sha"] !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit["sha"])) throw new GitHubResolutionFailure("resource_changed");
      return { ref: branch, sha: commit["sha"] };
    };
    const base = await resolveBranch(request.repository, request.baseBranch);
    const head = await resolveBranch(request.headRepository, request.headBranch);
    await this.#current(owner, signal);
    return { account, repository: baseRepository.repository, resource: null,
      pullRequest: { headRepository: headRepository.repository, forkNetworkId: baseRepository.networkId, maintainerCanModify: false, base, head } };
  }
  async read(owner: GitHubInvocationOwner, raw: unknown, signal?: AbortSignal): Promise<GitHubBrokerResult> {
    owner = structuredClone(owner);
    const request = parseGitHubOperation(raw);
    if (!request || request.operation === "comment_create" || request.operation === "pr_create") return githubFailure("issue_read", "invalid_request");
    try {
      await this.#current(owner, signal);
      return await this.ports.credentials.withClient(signal, async client => {
        const resolved = await this.#resolve(client, owner, request, signal);
        if (signal?.aborted || !this.ports.isCurrentNow(owner)) throw new GitHubResolutionFailure("authority_changed");
        return { ok: true, operation: request.operation, ...resolved, sideEffectStarted: false, retrySafe: true };
      });
    } catch (error) { return githubFailure(request.operation, failureCode(error)); }
  }
  async prepare(owner: GitHubInvocationOwner, toolCallId: string, raw: unknown, signal?: AbortSignal): Promise<GitHubPreparationResult> {
    owner = structuredClone(owner);
    const request = parseGitHubOperation(raw);
    if (!request || (request.operation !== "comment_create" && request.operation !== "pr_create") || !parseGitHubInvocationOwner(owner) || !toolCallId) {
      return { ok: false, result: githubFailure(request?.operation ?? "comment_create", "invalid_request") };
    }
    try { await this.#current(owner, signal); }
    catch (error) { return { ok: false, result: githubFailure(request.operation, failureCode(error)) }; }
    return this.ports.preparations.prepare(owner, toolCallId, request, async preparationId => {
      try {
        await this.#current(owner, signal);
        return await this.ports.credentials.withClient(signal, async client => {
          const resolved = request.operation === "pr_create" ? await this.#resolvePullRequest(client, owner, request, signal) : await this.#resolve(client, owner, request, signal);
          const canonical = { version: 1 as const, preparationId, generation: this.ports.preparations.generation, toolCallId, request: structuredClone(request), ...resolved };
          const digest = await digestGitHubPreparation(owner, canonical);
          await this.#current(owner, signal);
          if (signal?.aborted || !this.ports.isCurrentNow(owner)) throw new GitHubResolutionFailure("authority_changed");
          return { ok: true, prepared: { ...canonical, digest } };
        });
      } catch (error) { return { ok: false, result: githubFailure(request.operation, failureCode(error)) }; }
    });
  }
  async publish(owner: GitHubInvocationOwner, toolCallId: string, prepared: GitHubPreparedOperation, approval: GitHubPublishingApproval, signal?: AbortSignal): Promise<GitHubBrokerResult> {
    const parsed = parseGitHubPreparedOperation(prepared);
    if (!parsed) return githubFailure(parseGitHubOperation(prepared?.request)?.operation ?? "comment_create", "approval_stale");
    prepared = parsed; owner = structuredClone(owner); approval = structuredClone(approval);
    const knownSent = this.ports.preparations.wasConsumed(owner, toolCallId, prepared);
    if ((prepared.request.operation !== "comment_create" && prepared.request.operation !== "pr_create") || !this.ports.preparations.matches(owner, toolCallId, prepared)
      || approval.verb !== "once" || approval.digest !== prepared.digest
      || approval.approvalId !== `github-publish:${prepared.preparationId}:${prepared.digest}`) return githubFailure(prepared.request.operation, knownSent ? "outcome_unknown" : "approval_stale", knownSent);
    const request = prepared.request;
    const operation = request.operation;
    let finish: ((result: GitHubBrokerResult) => void) | undefined;
    const existing = this.ports.preparations.completion(owner, toolCallId, prepared);
    let effectStarted = existing !== null;
    const preflightFailure = (code: GitHubFailureCode) => {
      const sent = effectStarted || this.ports.preparations.wasConsumed(owner, toolCallId, prepared);
      return githubFailure(operation, sent ? "outcome_unknown" : code, sent);
    };
    try {
      await this.#current(owner, signal);
      if (existing !== null) {
        effectStarted = true;
        const result = await existing;
        await this.#current(owner, signal);
        return result;
      }
      return await this.ports.credentials.withClient(signal, async client => {
        let resolved: Resolved | ResolvedPullRequest = request.operation === "pr_create"
          ? await this.#resolvePullRequest(client, owner, request, signal) : await this.#resolve(client, owner, request, signal);
        const matches = (observed: Resolved | ResolvedPullRequest) => observed.account.id === prepared.account.id && observed.account.login === prepared.account.login
          && observed.repository.id === prepared.repository.id
          && (request.operation === "pr_create" ? "pullRequest" in observed && JSON.stringify(observed.pullRequest) === JSON.stringify(prepared.pullRequest)
            : observed.resource !== null && prepared.resource !== null && observed.resource.id === prepared.resource.id && observed.resource.kind === prepared.resource.kind);
        if (!matches(resolved)) return preflightFailure("resource_changed");
        if (!await this.ports.isPublishingApproved(owner, structuredClone(prepared), approval)) return preflightFailure("approval_stale");
        // The Human may have reviewed for a while. Reobserve both branch tips
        // after approval; a new observation needs a new preparation and review.
        if (request.operation === "pr_create") {
          resolved = await this.#resolvePullRequest(client, owner, request, signal);
          if (!matches(resolved)) return preflightFailure("resource_changed");
        }
        await this.#current(owner, signal);
        if (signal?.aborted || !this.ports.isCurrentNow(owner)) return preflightFailure("authority_changed");
        const consumed = this.ports.preparations.consume(owner, toolCallId, prepared);
        if (consumed.kind === "invalid") return preflightFailure("approval_stale");
        if (consumed.kind === "existing") {
          effectStarted = true;
          const result = await consumed.result;
          await this.#current(owner, signal);
          return result;
        }
        effectStarted = true;
        finish = consumed.finish;
        const response = request.operation === "pr_create"
          ? await client.request("POST", `/repos/${request.repository}/pulls`, { title: request.title, body: request.body, base: request.baseBranch,
              head: `${request.headRepository.split("/")[0]}:${request.headBranch}`, head_repo: request.headRepository.split("/")[1]!, draft: request.draft, maintainer_can_modify: false })
          : await client.request("POST", `/repos/${request.repository}/issues/${request.number}/comments`, { body: request.body });
        await this.#current(owner, signal);
        if (!this.ports.isCurrentNow(owner) || !this.ports.preparations.matches(owner, toolCallId, prepared)) throw new GitHubResolutionFailure("authority_changed");
        const value = object(response.data);
        let result: GitHubBrokerResult;
        if (request.operation === "pr_create") {
          result = this.#createdPullRequest(response.status, value, request, resolved as ResolvedPullRequest);
        } else if (response.status !== 201 || !value || !id(value["id"]) || value["body"] !== request.body) {
          result = githubFailure(operation, response.status >= 400 && response.status < 500 ? httpFailure(response.status) : "outcome_unknown", true);
        } else {
          result = { ok: true, operation: "comment_create", ...(resolved as Resolved),
            comment: { id: value["id"], htmlUrl: `${resolved.repository.htmlUrl}/issues/${request.number}#issuecomment-${value["id"]}`, body: request.body },
            sideEffectStarted: true, retrySafe: false };
        }
        finish(result); return result;
      });
    } catch (error) {
      const result = preflightFailure(failureCode(error));
      finish?.(result); return result;
    }
  }
  #createdPullRequest(status: number, value: Record<string, unknown> | null, request: CreateRequest, resolved: ResolvedPullRequest): GitHubBrokerResult {
    const fail = () => githubFailure("pr_create", status >= 400 && status < 500 ? httpFailure(status) : "outcome_unknown", true);
    if (status !== 201 || !value || !id(value["id"]) || !id(value["number"]) || value["title"] !== request.title
      || (value["body"] === null ? "" : value["body"]) !== request.body || value["draft"] !== request.draft || value["state"] !== "open"
      || value["maintainer_can_modify"] !== false) return fail();
    const branch = (raw: unknown, repository: GitHubRepository, ref: string) => {
      const entry = object(raw), repo = object(entry?.["repo"]);
      if (!entry || !repo || repo["id"] !== repository.id || typeof repo["full_name"] !== "string"
        || repo["full_name"].toLowerCase() !== repository.fullName.toLowerCase() || entry["ref"] !== ref
        || typeof entry["sha"] !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry["sha"])) return null;
      return { ref, sha: entry["sha"] };
    };
    const base = branch(value["base"], resolved.repository, request.baseBranch);
    const head = branch(value["head"], resolved.pullRequest.headRepository, request.headBranch);
    if (!base || !head) return fail();
    return { ok: true, operation: "pr_create", account: resolved.account, repository: resolved.repository,
      resource: { id: value["id"], number: value["number"], kind: "pull_request", htmlUrl: `${resolved.repository.htmlUrl}/pull/${value["number"]}`,
        title: request.title, body: request.body, state: "open" },
      pullRequest: { ...resolved.pullRequest, base, head },
      branchMovementObserved: base.sha !== resolved.pullRequest.base.sha || head.sha !== resolved.pullRequest.head.sha,
      // GitHub accepts branch names, not a compare-and-swap commit condition.
      approvedCommitGuaranteed: false, sideEffectStarted: true, retrySafe: false };
  }

}
