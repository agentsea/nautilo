import { parseGitHubInvocationOwner, parseGitHubOperation, parseGitHubPreparedOperation, sameGitHubOwner,
  type GitHubInvocationOwner, type GitHubPreparedOperation } from "./github-broker";

/** Advertised only by an admitted Desktop custody owner. No account secret or
 * model-selected source identity crosses this contract. */
export type GitHubDesktopIdentity = Omit<GitHubInvocationOwner, "agentId" | "roomId" | "conversationId" | "runId">;
export interface GitHubCapability { readonly version: 1; readonly generation: string; readonly identity: GitHubDesktopIdentity }
export interface GitHubInvocationBinding {
  readonly version: 1;
  readonly generation: string;
  readonly toolCallId: string;
  readonly owner: GitHubInvocationOwner;
  readonly stage: "read" | "prepare" | "publish";
  readonly prepared?: GitHubPreparedOperation;
  readonly approval?: { readonly verb: "once"; readonly approvalId: string; readonly digest: string };
}
export interface GitHubPublishApproval {
  readonly version: 1;
  readonly approvalId: string;
  readonly digest: string;
  /** Exact public account, target and complete payload; no source owner tuple. */
  readonly prepared: GitHubPreparedOperation;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.trim() === v;
export function githubPublishing(args: unknown): boolean {
  const value = parseGitHubOperation(args);
  return value?.operation === "comment_create" || value?.operation === "pr_create";
}
export function githubApprovalId(prepared: GitHubPreparedOperation): string {
  return `github-publish:${prepared.preparationId}:${prepared.digest}`;
}
export function parseGitHubCapability(value: unknown): GitHubCapability | null {
  if (!record(value) || !exact(value, ["version", "generation", "identity"]) || value["version"] !== 1 || !text(value["generation"]) || !record(value["identity"])) return null;
  const identity = value["identity"];
  if (Object.keys(identity).some(key => ["agentId", "roomId", "conversationId", "runId"].includes(key))) return null;
  const owner = parseGitHubInvocationOwner({ ...identity, agentId: "source", roomId: "source", conversationId: "source", runId: "source" });
  if (!owner) return null;
  return structuredClone(value) as unknown as GitHubCapability;
}
export function sameGitHubDesktopIdentity(owner: GitHubInvocationOwner, identity: GitHubDesktopIdentity): boolean {
  return sameGitHubOwner(owner, { ...identity, agentId: owner.agentId, roomId: owner.roomId, conversationId: owner.conversationId, runId: owner.runId });
}
export function parseGitHubInvocationBinding(value: unknown, args?: unknown): GitHubInvocationBinding | null {
  if (!record(value) || value["version"] !== 1 || !text(value["generation"]) || !text(value["toolCallId"]) || !parseGitHubInvocationOwner(value["owner"])) return null;
  const stage = value["stage"];
  const keys = ["version", "generation", "toolCallId", "owner", "stage"];
  if (stage === "publish") keys.push("prepared", "approval");
  if (!exact(value, keys) || !["read", "prepare", "publish"].includes(stage as string)) return null;
  const request = args === undefined ? undefined : parseGitHubOperation(args);
  if (args !== undefined && (!request || (stage === "read") === githubPublishing(request))) return null;
  if (stage === "publish") {
    const prepared = parseGitHubPreparedOperation(value["prepared"]), approval = value["approval"];
    if (!prepared || !githubPublishing(prepared.request) || prepared.generation !== value["generation"] || prepared.toolCallId !== value["toolCallId"]
      || !record(approval) || !exact(approval, ["verb", "approvalId", "digest"]) || approval["verb"] !== "once"
      || approval["approvalId"] !== githubApprovalId(prepared) || approval["digest"] !== prepared.digest
      || (request && JSON.stringify(request) !== JSON.stringify(parseGitHubOperation(prepared.request)))) return null;
  }
  return structuredClone(value) as unknown as GitHubInvocationBinding;
}
export function parseGitHubPublishApproval(value: unknown): GitHubPublishApproval | null {
  if (!record(value) || !exact(value, ["version", "approvalId", "digest", "prepared"]) || value["version"] !== 1) return null;
  const prepared = parseGitHubPreparedOperation(value["prepared"]);
  if (!prepared || !githubPublishing(prepared.request) || value["approvalId"] !== githubApprovalId(prepared) || value["digest"] !== prepared.digest) return null;
  return { version: 1, approvalId: value["approvalId"], digest: prepared.digest, prepared };
}

export interface GitHubApprovalEcho { readonly approvalId: string; readonly digest: string; readonly laneKey: string }
/** Transport validation only. Durable pending-interrupt equality is checked
 * separately before graph resume, then again against the original preparation. */
export function parseGitHubApprovalEcho(value: unknown): GitHubApprovalEcho | null {
  if (!record(value) || !exact(value, ["approvalId", "digest", "laneKey", "verb"])
    || !text(value["approvalId"]) || !value["approvalId"].startsWith("github-publish:")
    || typeof value["digest"] !== "string" || !/^[a-f0-9]{64}$/.test(value["digest"])
    || !text(value["laneKey"]) || (value["verb"] !== "once" && value["verb"] !== "deny")) return null;
  return { approvalId: value["approvalId"], digest: value["digest"], laneKey: value["laneKey"] };
}

/** Read the exact review extension from the existing pending approval owner.
 * A resolved/cleared pending payload has no separately retained GitHub state. */
export function gitHubReviewFromPendingApproval(value: unknown): GitHubPublishApproval | null {
  if (!record(value)) return null;
  const review = parseGitHubPublishApproval(value["github"]);
  return review?.approvalId === value["approvalId"] ? review : null;
}
