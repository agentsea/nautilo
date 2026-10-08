import type { GitRepositoryIdentity } from "./types";
import type { GitBrokerWorktreeLimits } from "./types";

/** Closed whole-operation transport. Its Desktop implementation owns the
 * admitted Git/helper, credentials and protected private scratch lifetime. */
export interface GitNetworkRemote {
  readonly repository: string;
  readonly repositoryId: number;
  readonly accountId: number;
  readonly accountLogin: string;
  readonly branch: string;
  /** Exact advertised commit, or null only for a branch that does not exist. */
  readonly oid: string | null;
}
export interface GitNetworkContext {
  readonly signal?: AbortSignal;
  readonly isCurrent: () => boolean;
}
/** Read-only clean metadata; valid only while the transport callback runs. */
export interface GitNetworkFetchedMetadata {
  readonly gitDir: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly emptyTreeOid: string;
}
export type GitNetworkWorktreeInput = GitNetworkContext & {
  readonly repository: string;
  readonly branch: string;
  /** Required caller policy; no hidden clone/pull materialization defaults. */
  readonly limits: GitBrokerWorktreeLimits;
};
export interface GitNetworkTransport {
  inspect(input: GitNetworkContext & { readonly repository: string; readonly branch: string }): Promise<GitNetworkRemote>;
  /** Fetch only this pinned branch/commit. The callback sees a validated object
   * database, never credentials/config. The transport owns its cleanup and
   * retains uncertain child resources instead of deleting beneath a writer. */
  withFetchedObjects<T>(input: GitNetworkContext & { readonly remote: GitNetworkRemote },
    consume: (objectsPath: string, metadata?: GitNetworkFetchedMetadata) => Promise<T>): Promise<T>;
  push(input: GitNetworkContext & {
    readonly remote: GitNetworkRemote;
    /** Data ingress only: validate/copy to protected private objects before
     * credentials. Never expose the live project store/config/alternates to
     * the authenticated child. */
    readonly sourceObjectsPath: string;
    readonly sourceOid: string;
    /** Synchronous final authority/once-consumption gate before any push can
     * send. False means no send. Never call again to retry a failed effect. */
    readonly beforeSend: () => boolean;
  }): Promise<{ readonly outcome: "pushed" | "rejected" | "unknown"; readonly sent: boolean }>;
}

export interface GitNetworkLocalSnapshot {
  readonly identity: GitRepositoryIdentity;
  readonly sourceBranch: string;
  readonly sourceOid: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly indexHash: string;
  readonly repositoryStamp: string;
}
export interface GitNetworkPushPreparation {
  readonly remote: GitNetworkRemote;
  readonly local: GitNetworkLocalSnapshot;
}
export type GitNetworkDisposition = {
  readonly operation: "fetch" | "push" | "clone" | "pull";
  readonly ok: boolean;
  readonly reason: "ok" | "invalid_request" | "authority_changed" | "repository_changed" | "remote_changed"
    | "not_fast_forward" | "approval_required" | "known_failure" | "outcome_unknown";
  readonly sideEffectStarted: boolean;
  readonly retrySafe: boolean;
  readonly remote?: GitNetworkRemote;
  readonly trackingRef?: string;
  readonly targetPath?: string;
  readonly oldOid?: string | null;
  readonly newOid?: string;
  /** Potential candidate/index/lock artifacts after a partial application, for recovery.
   * They are never an instruction to force reset or overwrite current work. */
  readonly residualPaths?: readonly string[];
};

/** Local transactional work stays in GitBroker. The transport never receives
 * working-tree/index/ref mutation authority. */
export interface GitNetworkLocalOperations {
  capture(sourceBranch: string): Promise<GitNetworkLocalSnapshot>;
  revalidate(snapshot: GitNetworkLocalSnapshot): Promise<boolean>;
  isCurrentNow(snapshot: GitNetworkLocalSnapshot): boolean;
  readTrackingRef(snapshot: GitNetworkLocalSnapshot, ref: string): Promise<string | null>;
  promote(snapshot: GitNetworkLocalSnapshot, objectsPath: string, oid: string): Promise<void>;
  compareAndSwapTracking(snapshot: GitNetworkLocalSnapshot, ref: string, oid: string, previous: string | null): Promise<boolean>;
  isAncestor(snapshot: GitNetworkLocalSnapshot, ancestor: string, objectsPath: string): Promise<boolean>;
}
export function validNetworkBranch(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "@" && !value.startsWith("-")
    && [...value].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127 && !"~^:?*[\\".includes(char))
    && !value.includes("..") && !value.includes("@{") && !value.endsWith(".")
    && value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
export function validNetworkRepository(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(value)
    && ![".", ".."].includes(value.split("/")[1]!);
}
export function validNetworkOid(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) && !/^0+$/.test(value);
}
function sameNetworkRemote(left: GitNetworkRemote, right: GitNetworkRemote): boolean {
  return left.repository === right.repository && left.repositoryId === right.repositoryId
    && left.accountId === right.accountId && left.accountLogin === right.accountLogin
    && left.branch === right.branch && left.oid === right.oid;
}
function validRemote(remote: GitNetworkRemote, repository: string, branch: string): boolean {
  return remote.repository === repository && remote.branch === branch
    && Number.isSafeInteger(remote.repositoryId) && remote.repositoryId > 0
    && Number.isSafeInteger(remote.accountId) && remote.accountId > 0
    && /^[A-Za-z0-9-]+$/.test(remote.accountLogin) && (remote.oid === null || validNetworkOid(remote.oid));
}
const current = (input: GitNetworkContext): boolean => !input.signal?.aborted && input.isCurrent();
const context = (input: GitNetworkContext): GitNetworkContext => ({ isCurrent: input.isCurrent, ...(input.signal === undefined ? {} : { signal: input.signal }) });
function result(operation: "fetch" | "push", reason: GitNetworkDisposition["reason"], started = false): GitNetworkDisposition {
  return { operation, ok: reason === "ok", reason, sideEffectStarted: started, retrySafe: !started };
}
export interface GitNetworkDependencies { readonly local: GitNetworkLocalOperations; readonly transport: GitNetworkTransport }

/** Only a broker-owned tracking ref changes; HEAD/index/worktree never do. */
export async function fetchNetwork(input: GitNetworkContext & { readonly repository: string; readonly branch: string },
  deps: GitNetworkDependencies): Promise<GitNetworkDisposition> {
  input = { ...input };
  if (!validNetworkRepository(input.repository) || !validNetworkBranch(input.branch)) return result("fetch", "invalid_request");
  let started = false;
  try {
    if (!current(input)) return result("fetch", "authority_changed");
    const snapshot = await deps.local.capture("");
    const remote = await deps.transport.inspect({ ...context(input), repository: input.repository, branch: input.branch });
    if (!validRemote(remote, input.repository, input.branch) || remote.oid === null
      || remote.oid.length !== (snapshot.objectFormat === "sha256" ? 64 : 40)) return result("fetch", "remote_changed");
    const trackingRef = `refs/remotes/nautilo-github/${remote.repositoryId}/${remote.branch}`;
    const previous = await deps.local.readTrackingRef(snapshot, trackingRef);
    if (!current(input) || !await deps.local.revalidate(snapshot)) return result("fetch", "authority_changed");
    return await deps.transport.withFetchedObjects({ ...context(input), remote }, async objectsPath => {
      if (!current(input) || !await deps.local.revalidate(snapshot) || !current(input)) return result("fetch", "authority_changed");
      // Immutable object promotion is itself a durable mutation. A failure from
      // this point cannot be relabelled retry-safe merely because ref CAS failed.
      started = true;
      await deps.local.promote(snapshot, objectsPath, remote.oid!);
      if (!current(input) || !await deps.local.revalidate(snapshot) || !current(input)) return result("fetch", "authority_changed", true);
      const updated = await deps.local.compareAndSwapTracking(snapshot, trackingRef, remote.oid!, previous);
      if (!updated) return result("fetch", "repository_changed", true);
      if (!current(input)) return result("fetch", "outcome_unknown", true);
      return { ...result("fetch", "ok", true), remote, trackingRef };
    });
  } catch { return result("fetch", started ? "outcome_unknown" : "known_failure", started); }
}

export async function prepareNetworkPush(input: GitNetworkContext & { readonly repository: string; readonly sourceBranch: string; readonly destinationBranch: string },
  deps: GitNetworkDependencies): Promise<GitNetworkPushPreparation | null> {
  input = { ...input };
  if (!validNetworkRepository(input.repository) || !validNetworkBranch(input.sourceBranch) || !validNetworkBranch(input.destinationBranch)) return null;
  try {
    if (!current(input)) return null;
    const local = await deps.local.capture(input.sourceBranch);
    if (!validNetworkOid(local.sourceOid)) return null;
    const remote = await deps.transport.inspect({ ...context(input), repository: input.repository, branch: input.destinationBranch });
    if (!validRemote(remote, input.repository, input.destinationBranch)) return null;
    if (remote.oid !== null) {
      if (remote.oid.length !== local.sourceOid.length) return null;
      const fastForward = await deps.transport.withFetchedObjects({ ...context(input), remote },
        async objectsPath => await deps.local.isAncestor(local, remote.oid!, objectsPath));
      if (!fastForward) return null;
    }
    if (!current(input) || !await deps.local.revalidate(local) || !current(input)) return null;
    return structuredClone({ remote, local });
  } catch { return null; }
}

/** The existing publishing owner supplies exact approval and consumption. A
 * thrown/lost transport result after that gate stays unknown, never retryable. */
export async function pushNetwork(input: GitNetworkContext & {
  readonly prepared: GitNetworkPushPreparation;
  readonly approved: boolean;
  readonly consume: () => boolean;
}, deps: GitNetworkDependencies): Promise<GitNetworkDisposition> {
  const prepared = structuredClone(input.prepared);
  if (!input.approved) return result("push", "approval_required");
  let consumed = false;
  try {
    if (!validRemote(prepared.remote, prepared.remote.repository, prepared.remote.branch)
      || !validNetworkRepository(prepared.remote.repository) || !validNetworkBranch(prepared.remote.branch)
      || !validNetworkBranch(prepared.local.sourceBranch) || !validNetworkOid(prepared.local.sourceOid)) return result("push", "invalid_request");
    if (!current(input) || !await deps.local.revalidate(prepared.local) || !current(input)) return result("push", "authority_changed");
    const observed = await deps.transport.inspect({ ...context(input), repository: prepared.remote.repository, branch: prepared.remote.branch });
    if (!sameNetworkRemote(prepared.remote, observed)) return result("push", "remote_changed");
    if (!current(input) || !await deps.local.revalidate(prepared.local) || !current(input)) return result("push", "authority_changed");
    const sent = await deps.transport.push({ ...context(input), remote: prepared.remote,
      sourceObjectsPath: `${prepared.local.identity.commonDir}/objects`, sourceOid: prepared.local.sourceOid,
      beforeSend: () => {
        if (consumed || !current(input) || !deps.local.isCurrentNow(prepared.local)) return false;
        consumed = input.consume();
        return consumed;
      } });
    if (!consumed) return result("push", "approval_required");
    // Consumption precedes potential transmission. A claimed operation is never
    // retried automatically, including an unconfirmed spawn/transport failure.
    if (!current(input) || sent.outcome === "unknown" || (sent.outcome === "pushed" && !sent.sent)) return result("push", "outcome_unknown", true);
    return { ...result("push", sent.outcome === "pushed" ? "ok" : "known_failure", true), remote: prepared.remote };
  } catch { return result("push", consumed ? "outcome_unknown" : "known_failure", consumed); }
}
