/** Closed typed account operations. No URL, credential, executable or header
 * can be supplied by the model. Publishing approval is a separate binding. */
export type GitHubOperation =
  | { readonly operation: "issue_read"; readonly repository: string; readonly number: number }
  | { readonly operation: "pr_read"; readonly repository: string; readonly number: number }
  | { readonly operation: "comment_create"; readonly repository: string; readonly number: number; readonly body: string }
  | { readonly operation: "pr_create"; readonly repository: string; readonly headRepository: string; readonly baseBranch: string; readonly headBranch: string; readonly title: string; readonly body: string; readonly draft: boolean };

export interface GitHubInvocationOwner {
  readonly instanceId: string;
  readonly humanUserId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly pairingGeneration: string;
  readonly serverOrigin: string;
  readonly serverFingerprint: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly grantRevision: number;
  readonly protectedPolicyVersion: number;
}

export interface GitHubAccount { readonly id: number; readonly login: string }
export interface GitHubRepository { readonly id: number; readonly fullName: string; readonly htmlUrl: string }
export interface GitHubResource {
  readonly id: number;
  readonly number: number;
  readonly kind: "issue" | "pull_request";
  readonly htmlUrl: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
}

export interface GitHubPullRequestPreparation {
  readonly headRepository: GitHubRepository;
  readonly forkNetworkId: number;
  readonly maintainerCanModify: false;
  readonly base: Readonly<{ ref: string; sha: string }>;
  readonly head: Readonly<{ ref: string; sha: string }>;
}

export interface GitHubPreparedOperation {
  readonly version: 1;
  readonly preparationId: string;
  readonly generation: string;
  readonly toolCallId: string;
  readonly digest: string;
  readonly request: GitHubOperation;
  readonly account: GitHubAccount;
  readonly repository: GitHubRepository;
  readonly resource: GitHubResource | null;
  readonly pullRequest?: GitHubPullRequestPreparation;
}

export type GitHubFailureCode = "invalid_request" | "account_unavailable" | "authority_changed"
  | "resource_changed" | "approval_stale" | "capacity_exhausted" | "not_found"
  | "permission_denied" | "rate_limited" | "request_failed" | "outcome_unknown";
export type GitHubBrokerResult =
  | { readonly ok: true; readonly operation: "issue_read" | "pr_read"; readonly account: GitHubAccount;
      readonly repository: GitHubRepository; readonly resource: GitHubResource; readonly sideEffectStarted: false; readonly retrySafe: true }
  | { readonly ok: true; readonly operation: "comment_create"; readonly account: GitHubAccount;
      readonly repository: GitHubRepository; readonly resource: GitHubResource;
      readonly comment: Readonly<{ id: number; htmlUrl: string; body: string }>;
      readonly sideEffectStarted: true; readonly retrySafe: false }
  | { readonly ok: true; readonly operation: "pr_create"; readonly account: GitHubAccount;
      readonly repository: GitHubRepository; readonly resource: GitHubResource;
      readonly pullRequest: GitHubPullRequestPreparation; readonly branchMovementObserved: boolean;
      readonly approvedCommitGuaranteed: false; readonly sideEffectStarted: true; readonly retrySafe: false }
  | { readonly ok: false; readonly operation: GitHubOperation["operation"]; readonly code: GitHubFailureCode;
      readonly sideEffectStarted: boolean; readonly retrySafe: boolean };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
export function isGitHubRepositoryName(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(value)) return false;
  return ![".", ".."].includes(value.split("/")[1]!);
}
export function isGitHubBranchName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "@"
    && [...value].every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127 && !"~^:?*[\\".includes(character)) && !value.includes("..") && !value.includes("@{")
    && !value.endsWith(".") && value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
export function parseGitHubOperation(value: unknown): GitHubOperation | null {
  if (object(value) && value["operation"] === "pr_create") {
    return exact(value, ["operation", "repository", "headRepository", "baseBranch", "headBranch", "title", "body", "draft"])
      && isGitHubRepositoryName(value["repository"]) && isGitHubRepositoryName(value["headRepository"])
      && isGitHubBranchName(value["baseBranch"]) && isGitHubBranchName(value["headBranch"])
      && typeof value["title"] === "string" && value["title"].trim().length > 0
      && typeof value["body"] === "string" && typeof value["draft"] === "boolean"
      ? { operation: "pr_create", repository: value["repository"], headRepository: value["headRepository"], baseBranch: value["baseBranch"],
          headBranch: value["headBranch"], title: value["title"], body: value["body"], draft: value["draft"] } : null;
  }
  if (!object(value) || !isGitHubRepositoryName(value["repository"])
    || !Number.isSafeInteger(value["number"]) || (value["number"] as number) < 1) return null;
  if (value["operation"] === "issue_read" || value["operation"] === "pr_read") {
    return exact(value, ["operation", "repository", "number"])
      ? { operation: value["operation"], repository: value["repository"], number: value["number"] as number } : null;
  }
  return value["operation"] === "comment_create" && exact(value, ["operation", "repository", "number", "body"])
    && typeof value["body"] === "string" && value["body"].trim().length > 0
    ? { operation: "comment_create", repository: value["repository"], number: value["number"] as number, body: value["body"] } : null;
}

/** Stable closed tuples avoid key-order drift and bind local authority as well
 * as account, resource and exact comment bytes. No reusable secret is hashed. */
export async function digestGitHubPreparation(owner: GitHubInvocationOwner, prepared: Omit<GitHubPreparedOperation, "digest">): Promise<string> {
  const value = ["nautilo.github-operation.v1", owner.instanceId, owner.humanUserId, owner.agentId, owner.roomId,
    owner.conversationId, owner.runId, owner.relayId, owner.desktopSessionId, owner.pairingGeneration,
    owner.serverOrigin, owner.serverFingerprint, owner.profileId, owner.profileRevision, owner.grantRevision, owner.protectedPolicyVersion,
    prepared.version, prepared.preparationId, prepared.generation, prepared.toolCallId,
    prepared.request.operation, prepared.request.repository,
    prepared.request.operation === "pr_create" ? [prepared.request.headRepository, prepared.request.baseBranch, prepared.request.headBranch, prepared.request.title, prepared.request.body, prepared.request.draft] : [prepared.request.number, prepared.request.operation === "comment_create" ? prepared.request.body : null],
    prepared.account.id, prepared.account.login, prepared.repository.id, prepared.repository.fullName, prepared.repository.htmlUrl,
    prepared.resource === null ? null : [prepared.resource.id, prepared.resource.number, prepared.resource.kind, prepared.resource.htmlUrl],
    prepared.pullRequest === undefined ? null : [prepared.pullRequest.headRepository.id, prepared.pullRequest.headRepository.fullName, prepared.pullRequest.headRepository.htmlUrl, prepared.pullRequest.forkNetworkId, prepared.pullRequest.maintainerCanModify, prepared.pullRequest.base.ref, prepared.pullRequest.base.sha, prepared.pullRequest.head.ref, prepared.pullRequest.head.sha]];
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function sameGitHubOwner(left: GitHubInvocationOwner, right: GitHubInvocationOwner): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => left[key as keyof GitHubInvocationOwner] === right[key as keyof GitHubInvocationOwner]);
}

export function parseGitHubInvocationOwner(value: unknown): GitHubInvocationOwner | null {
  const strings = ["instanceId", "humanUserId", "agentId", "roomId", "conversationId", "runId", "relayId", "desktopSessionId",
    "pairingGeneration", "serverOrigin", "serverFingerprint", "profileId"];
  const numbers = ["profileRevision", "grantRevision", "protectedPolicyVersion"];
  if (!object(value) || !exact(value, [...strings, ...numbers])
    || !strings.every(key => typeof value[key] === "string" && value[key].trim() === value[key] && (key === "instanceId" || value[key].length > 0))
    || !numbers.every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)) return null;
  try {
    const origin = new URL(value["serverOrigin"] as string);
    if (origin.origin !== value["serverOrigin"] || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) return null;
  } catch { return null; }
  return structuredClone(value) as unknown as GitHubInvocationOwner;
}

export function parseGitHubPreparedOperation(value: unknown): GitHubPreparedOperation | null {
  if (!object(value) || !exact(value, ["version", "preparationId", "generation", "toolCallId", "digest", "request", "account", "repository", "resource", ...(value["pullRequest"] === undefined ? [] : ["pullRequest"])])
    || value["version"] !== 1 || !["preparationId", "generation", "toolCallId"].every(key => typeof value[key] === "string" && value[key].length > 0)
    || typeof value["digest"] !== "string" || !/^[a-f0-9]{64}$/.test(value["digest"])) return null;
  const request = parseGitHubOperation(value["request"]);
  const account = value["account"], repository = value["repository"], resource = value["resource"];
  const id = (entry: unknown) => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0;
  if (!request || !object(account) || !exact(account, ["id", "login"]) || !id(account["id"])
    || typeof account["login"] !== "string" || !/^[A-Za-z0-9-]+$/.test(account["login"])
    || !object(repository) || !exact(repository, ["id", "fullName", "htmlUrl"]) || !id(repository["id"])
    || repository["fullName"] !== request.repository || repository["htmlUrl"] !== `https://github.com/${request.repository}`
    ) return null;
  if (request.operation === "pr_create") {
    const pullRequest = parseGitHubPullRequestPreparation(value["pullRequest"], request);
    return resource === null && pullRequest !== null ? {
      version: 1, preparationId: value["preparationId"] as string, generation: value["generation"] as string,
      toolCallId: value["toolCallId"] as string, digest: value["digest"], request,
      account: { id: account["id"] as number, login: account["login"] },
      repository: { id: repository["id"] as number, fullName: repository["fullName"], htmlUrl: repository["htmlUrl"] },
      resource: null, pullRequest,
    } : null;
  }
  if (value["pullRequest"] !== undefined || !object(resource) || !exact(resource, ["id", "number", "kind", "htmlUrl", "title", "body", "state"])
    || !id(resource["id"]) || resource["number"] !== request.number || !["issue", "pull_request"].includes(resource["kind"] as string)
    || resource["htmlUrl"] !== `${repository["htmlUrl"]}/${resource["kind"] === "pull_request" ? "pull" : "issues"}/${request.number}`
    || typeof resource["title"] !== "string" || typeof resource["body"] !== "string" || !["open", "closed"].includes(resource["state"] as string)) return null;
  const parsed = value as unknown as GitHubPreparedOperation;
  return { version: 1, preparationId: parsed.preparationId, generation: parsed.generation, toolCallId: parsed.toolCallId, digest: parsed.digest, request,
    account: { id: parsed.account.id, login: parsed.account.login },
    repository: { id: parsed.repository.id, fullName: parsed.repository.fullName, htmlUrl: parsed.repository.htmlUrl },
    resource: { id: resource["id"] as number, number: request.number, kind: resource["kind"] as GitHubResource["kind"], htmlUrl: resource["htmlUrl"],
      title: resource["title"], body: resource["body"], state: resource["state"] as GitHubResource["state"] } };
}

export function githubFailure(operation: GitHubOperation["operation"], code: GitHubFailureCode, sideEffectStarted = false): GitHubBrokerResult {
  return { ok: false, operation, code, sideEffectStarted, retrySafe: !sideEffectStarted };
}

export function parseGitHubPullRequestPreparation(value: unknown, request: Extract<GitHubOperation, { operation: "pr_create" }>): GitHubPullRequestPreparation | null {
  if (!object(value) || !exact(value, ["headRepository", "forkNetworkId", "maintainerCanModify", "base", "head"])) return null;
  const repo = value["headRepository"], base = value["base"], head = value["head"];
  if (!object(repo) || !exact(repo, ["id", "fullName", "htmlUrl"]) || !Number.isSafeInteger(repo["id"]) || (repo["id"] as number) < 1
    || repo["fullName"] !== request.headRepository || repo["htmlUrl"] !== `https://github.com/${request.headRepository}`
    || value["maintainerCanModify"] !== false || !Number.isSafeInteger(value["forkNetworkId"]) || (value["forkNetworkId"] as number) < 1
    || !object(base) || !object(head) || !exact(base, ["ref", "sha"]) || !exact(head, ["ref", "sha"])
    || base["ref"] !== request.baseBranch || head["ref"] !== request.headBranch
    || ![base["sha"], head["sha"]].every(sha => typeof sha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))) return null;
  return structuredClone(value) as unknown as GitHubPullRequestPreparation;
}

/** Authenticated Git is a separate closed grammar. These operations are NOT
 * accepted by parseGitHubOperation or the existing local_github REST tool. */
export type GitHubGitOperation =
  | { readonly operation: "fetch"; readonly repository: string; readonly branch: string }
  | { readonly operation: "clone"; readonly repository: string; readonly branch: string; readonly directory: string }
  | { readonly operation: "pull"; readonly repository: string; readonly branch: string }
  | { readonly operation: "push"; readonly repository: string; readonly sourceBranch: string; readonly destinationBranch: string };
export interface GitHubPreparedGitPush {
  readonly version: 1;
  readonly preparationId: string;
  readonly generation: string;
  readonly toolCallId: string;
  readonly digest: string;
  readonly request: Extract<GitHubGitOperation, { operation: "push" }>;
  readonly remote: { readonly repository: string; readonly repositoryId: number; readonly accountId: number;
    readonly accountLogin: string; readonly branch: string; readonly oid: string | null };
  readonly local: { readonly identity: { readonly workTree: string; readonly gitDir: string; readonly commonDir: string; readonly isLinkedWorktree: boolean };
    readonly sourceBranch: string; readonly sourceOid: string; readonly objectFormat: "sha1" | "sha256"; readonly indexHash: string; readonly repositoryStamp: string };
}
export type GitHubGitResult = {
  readonly ok: boolean;
  readonly operation: GitHubGitOperation["operation"];
  readonly code: "ok" | "invalid_request" | "authority_changed" | "repository_changed" | "remote_changed"
    | "not_fast_forward" | "approval_stale" | "capacity_exhausted" | "request_failed" | "outcome_unknown";
  readonly sideEffectStarted: boolean;
  readonly retrySafe: boolean;
};
export function githubGitFailure(operation: GitHubGitOperation["operation"], code: Exclude<GitHubGitResult["code"], "ok">,
  sideEffectStarted = false): GitHubGitResult {
  return { ok: false, operation, code, sideEffectStarted, retrySafe: !sideEffectStarted };
}
export function parseGitHubGitOperation(value: unknown): GitHubGitOperation | null {
  if (!object(value) || !isGitHubRepositoryName(value["repository"])) return null;
  if (value["operation"] === "clone" && exact(value, ["operation", "repository", "branch", "directory"])
    && isGitHubBranchName(value["branch"]) && !value["branch"].startsWith("-")
    && typeof value["directory"] === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value["directory"])
    && !value["directory"].endsWith(".") && !value["directory"].toLowerCase().startsWith(".git")) {
    return { operation: "clone", repository: value["repository"], branch: value["branch"], directory: value["directory"] };
  }
  if (value["operation"] === "pull" && exact(value, ["operation", "repository", "branch"])
    && isGitHubBranchName(value["branch"]) && !value["branch"].startsWith("-")) {
    return { operation: "pull", repository: value["repository"], branch: value["branch"] };
  }
  if (value["operation"] === "fetch" && exact(value, ["operation", "repository", "branch"]) && isGitHubBranchName(value["branch"]) && !value["branch"].startsWith("-")) {
    return { operation: "fetch", repository: value["repository"], branch: value["branch"] };
  }
  return value["operation"] === "push" && exact(value, ["operation", "repository", "sourceBranch", "destinationBranch"])
    && isGitHubBranchName(value["sourceBranch"]) && !value["sourceBranch"].startsWith("-") && isGitHubBranchName(value["destinationBranch"]) && !value["destinationBranch"].startsWith("-")
    ? { operation: "push", repository: value["repository"], sourceBranch: value["sourceBranch"], destinationBranch: value["destinationBranch"] } : null;
}
export function parseGitHubPreparedGitPush(value: unknown): GitHubPreparedGitPush | null {
  if (!object(value) || !exact(value, ["version", "preparationId", "generation", "toolCallId", "digest", "request", "remote", "local"])
    || value["version"] !== 1 || !["preparationId", "generation", "toolCallId"].every(key => typeof value[key] === "string" && value[key].trim().length > 0)
    || typeof value["digest"] !== "string" || !/^[a-f0-9]{64}$/.test(value["digest"])) return null;
  const request = parseGitHubGitOperation(value["request"]);
  const remote = value["remote"], local = value["local"];
  const oid = (input: unknown): input is string => typeof input === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input) && !/^0+$/.test(input);
  const path = (input: unknown): input is string => typeof input === "string" && input.startsWith("/") && !/[\0\r\n]/.test(input)
    && input.split("/").slice(1).every(part => part !== "" && part !== "." && part !== "..");
  if (request?.operation !== "push" || !object(remote)
    || !exact(remote, ["repository", "repositoryId", "accountId", "accountLogin", "branch", "oid"])
    || remote["repository"] !== request.repository || remote["branch"] !== request.destinationBranch
    || ![remote["repositoryId"], remote["accountId"]].every(id => Number.isSafeInteger(id) && (id as number) > 0)
    || typeof remote["accountLogin"] !== "string" || !/^[A-Za-z0-9-]+$/.test(remote["accountLogin"])
    || !(remote["oid"] === null || oid(remote["oid"]))
    || !object(local) || !exact(local, ["identity", "sourceBranch", "sourceOid", "objectFormat", "indexHash", "repositoryStamp"])
    || local["sourceBranch"] !== request.sourceBranch || !oid(local["sourceOid"])
    || !["sha1", "sha256"].includes(local["objectFormat"] as string) || local["sourceOid"].length !== (local["objectFormat"] === "sha256" ? 64 : 40)
    || (remote["oid"] !== null && remote["oid"].length !== local["sourceOid"].length)
    || typeof local["indexHash"] !== "string" || !(local["indexHash"] === "<missing>" || /^[a-f0-9]{64}$/.test(local["indexHash"]))
    || typeof local["repositoryStamp"] !== "string" || !/^[a-f0-9]{64}$/.test(local["repositoryStamp"])) return null;
  const identity = local["identity"];
  if (!object(identity) || !exact(identity, ["workTree", "gitDir", "commonDir", "isLinkedWorktree"])
    || ![identity["workTree"], identity["gitDir"], identity["commonDir"]].every(path)
    || typeof identity["isLinkedWorktree"] !== "boolean") return null;
  return { version: 1, preparationId: value["preparationId"] as string, generation: value["generation"] as string,
    toolCallId: value["toolCallId"] as string, digest: value["digest"], request,
    remote: { repository: request.repository, repositoryId: remote["repositoryId"] as number, accountId: remote["accountId"] as number,
      accountLogin: remote["accountLogin"], branch: request.destinationBranch, oid: remote["oid"] },
    local: { identity: { workTree: identity["workTree"] as string, gitDir: identity["gitDir"] as string,
      commonDir: identity["commonDir"] as string, isLinkedWorktree: identity["isLinkedWorktree"] },
      sourceBranch: request.sourceBranch, sourceOid: local["sourceOid"], objectFormat: local["objectFormat"] as "sha1" | "sha256", indexHash: local["indexHash"], repositoryStamp: local["repositoryStamp"] } };
}
export async function digestGitHubGitPush(owner: GitHubInvocationOwner, prepared: Omit<GitHubPreparedGitPush, "digest">): Promise<string> {
  const { remote, local } = prepared;
  const bytes = new TextEncoder().encode(JSON.stringify(["nautilo.github-git-push.v1",
    owner.instanceId, owner.humanUserId, owner.agentId, owner.roomId, owner.conversationId, owner.runId,
    owner.relayId, owner.desktopSessionId, owner.pairingGeneration, owner.serverOrigin, owner.serverFingerprint,
    owner.profileId, owner.profileRevision, owner.grantRevision, owner.protectedPolicyVersion,
    prepared.version, prepared.preparationId, prepared.generation, prepared.toolCallId,
    prepared.request.operation, prepared.request.repository, prepared.request.sourceBranch, prepared.request.destinationBranch,
    remote.repository, remote.repositoryId, remote.accountId, remote.accountLogin, remote.branch, remote.oid,
    local.identity.workTree, local.identity.gitDir, local.identity.commonDir, local.identity.isLinkedWorktree,
    local.sourceBranch, local.sourceOid, local.objectFormat, local.indexHash, local.repositoryStamp]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
