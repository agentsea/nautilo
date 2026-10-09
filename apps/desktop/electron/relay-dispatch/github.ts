import { parseGitHubCapability, sameGitHubDesktopIdentity, type GitHubCapability } from "@nautilo/types";
import { parseGitHubInvocationOwner, parseGitHubOperation, parseGitHubPreparedOperation, githubFailure, type GitHubInvocationOwner,
  digestGitHubGitPush, githubGitFailure, parseGitHubGitOperation, parseGitHubPreparedGitPush, type GitHubPreparedOperation,
  type GitHubFailureCode, type GitHubOperation, type GitHubGitResult } from "../../../../packages/types/src/github-broker";
import { parseRelayGitHubInvocationBinding, type RelayWorkstationShellBinding } from "@nautilo/relay";
import type { AuthenticatedGitBroker } from "./workstation";
import type { GitBrokerWorktreeLimits } from "../../../../packages/sandbox/src/git-broker/types";
import type { GitNetworkDisposition, GitNetworkTransport } from "../../../../packages/sandbox/src/git-broker/network";
import { GitHubBroker, type GitHubPublishingApproval } from "../github-broker/broker";

/** Produced by authenticated Relay/server admission, never model tool args. */
export interface AdmittedGitHubDispatch {
  readonly owner: GitHubInvocationOwner;
  readonly toolCallId: string;
  readonly prepared?: GitHubPreparedOperation;
  readonly publishingApproval?: GitHubPublishingApproval;
}
/** A separate typed route. This adapter cannot execute a shell or fall back to
 * legacy run_shell credential projection when account admission fails. */
export async function dispatchGitHubOperation(broker: GitHubBroker, toolName: string, args: unknown,
  admission: AdmittedGitHubDispatch, signal?: AbortSignal) {
  const request = parseGitHubOperation(args);
  const owner = parseGitHubInvocationOwner(admission.owner);
  const prepared = parseGitHubPreparedOperation(admission.prepared);
  const refuse = (operation: GitHubOperation["operation"], code: GitHubFailureCode) => {
    // Exact retained sent-effect truth is content-free, not permission to read
    // the old receipt or retry its POST. Forged preparations cannot match it.
    if (toolName === "local_github" && owner && prepared && admission.toolCallId
      && broker.ports.preparations.wasConsumed(owner, admission.toolCallId, prepared)) {
      return githubFailure(prepared.request.operation, "outcome_unknown", true);
    }
    return githubFailure(operation, code);
  };
  if (toolName !== "local_github" || !request || !owner || !admission.toolCallId) {
    return refuse(request?.operation ?? "issue_read", "invalid_request");
  }
  if (request.operation !== "comment_create" && request.operation !== "pr_create") {
    if (admission.prepared || admission.publishingApproval) return refuse(request.operation, "invalid_request");
    return broker.read(admission.owner, request, signal);
  }
  if (!admission.prepared && !admission.publishingApproval) return broker.prepare(admission.owner, admission.toolCallId, request, signal);
  if (!admission.prepared || !admission.publishingApproval || JSON.stringify(admission.prepared.request) !== JSON.stringify(request)) {
    return refuse(request.operation, "approval_stale");
  }
  return broker.publish(admission.owner, admission.toolCallId, admission.prepared, admission.publishingApproval, signal);
}

/** Supplied only after credential cutover has admitted this session's custody.
 * The existing preparation owner retains all once/unknown effect receipts. */
export interface DesktopGitHubRuntime {
  readonly capability: GitHubCapability;
  readonly broker: GitHubBroker;
  readonly authenticatedGit?: {
    readonly transport: GitNetworkTransport;
    readonly worktreeLimits: GitBrokerWorktreeLimits;
  };
  readonly isCurrent: () => boolean;
  readonly retire: () => void;
}
export async function dispatchAdmittedGitHub(runtime: DesktopGitHubRuntime | null, toolName: string, args: unknown,
  value: unknown, signal?: AbortSignal, workstationBinding?: RelayWorkstationShellBinding, authenticatedGitBroker?: AuthenticatedGitBroker) {
  const supplied = parseRelayGitHubInvocationBinding(value);
  const binding = parseRelayGitHubInvocationBinding(value, args);
  const capability = parseGitHubCapability(runtime?.capability);
  const git = parseGitHubGitOperation(args);
  if (!runtime || !binding || binding.localNetworkPolicy.mode !== "host" || !capability || (toolName !== "local_github" && !(toolName === "local_git" && git)) || signal?.aborted || !runtime.isCurrent()
    || binding.generation !== capability.generation || !sameGitHubDesktopIdentity(binding.owner, capability.identity)) {
    if (git) return githubGitFailure(git.operation, supplied?.stage === "publish" ? "outcome_unknown" : "authority_changed", supplied?.stage === "publish");
    return githubFailure(parseGitHubPreparedOperation(supplied?.prepared)?.request.operation ?? parseGitHubOperation(args)?.operation ?? "issue_read",
      supplied?.stage === "publish" ? "outcome_unknown" : "authority_changed", supplied?.stage === "publish");
  }
  if (git) {
    if (capability.authenticatedGit?.version !== 1 || !runtime.authenticatedGit || !workstationBinding || !authenticatedGitBroker
      || binding.localNetworkPolicy.mode !== "host") return githubGitFailure(git.operation, "authority_changed");
    const broker = authenticatedGitBroker;
    const current = () => runtime.isCurrent() && !signal?.aborted;
    const convert = (result: GitNetworkDisposition): GitHubGitResult => ({ ok: result.ok, operation: result.operation,
      code: result.reason === "known_failure" || result.reason === "approval_required" ? "request_failed" : result.reason,
      sideEffectStarted: result.sideEffectStarted, retrySafe: result.retrySafe });
    if (git.operation === "fetch") return convert(await broker.fetch({ ...git, isCurrent: current, ...(signal ? { signal } : {}) }, runtime.authenticatedGit.transport));
    if (git.operation === "clone") return convert(await broker.clone({ ...git, limits: runtime.authenticatedGit.worktreeLimits,
      isCurrent: current, ...(signal ? { signal } : {}) }, runtime.authenticatedGit.transport));
    if (git.operation === "pull") return convert(await broker.pull({ ...git, limits: runtime.authenticatedGit.worktreeLimits,
      isCurrent: current, ...(signal ? { signal } : {}) }, runtime.authenticatedGit.transport));
    if (binding.stage === "prepare") {
      const prepared = await runtime.broker.ports.preparations.prepareGitPush(binding.owner, binding.toolCallId, git, async preparationId => {
        const snapshot = await broker.preparePush({ ...git, isCurrent: current, ...(signal ? { signal } : {}) }, runtime.authenticatedGit!.transport);
        if (!snapshot || !current()) return { ok: false, result: githubGitFailure("push", "request_failed") };
        const candidate = { version: 1 as const, preparationId, generation: binding.generation, toolCallId: binding.toolCallId,
          digest: "", request: git, remote: snapshot.remote, local: snapshot.local };
        return { ok: true, prepared: { ...candidate, digest: await digestGitHubGitPush(binding.owner, candidate) } };
      });
      return prepared.ok ? { ok: true, prepared: prepared.prepared } : prepared.result;
    }
    const prepared = parseGitHubPreparedGitPush(binding.prepared);
    if (binding.stage !== "publish" || !prepared || binding.approval?.approvalId !== `github-publish:${prepared.preparationId}:${prepared.digest}`
      || binding.approval.digest !== prepared.digest) return githubGitFailure("push", "approval_stale");
    const prior = runtime.broker.ports.preparations.completionGitPush(binding.owner, binding.toolCallId, prepared);
    if (prior) return await prior;
    if (!await runtime.broker.ports.isPublishingApproved(binding.owner, prepared, binding.approval)) {
      return githubGitFailure("push", "approval_stale");
    }
    let claim: { readonly finish: (result: GitHubGitResult) => void } | undefined;
    let replay: Promise<GitHubGitResult> | undefined;
    try {
      const disposition = await broker.push({ prepared: { remote: prepared.remote, local: prepared.local }, approved: true,
        consume: () => {
          const consumed = runtime.broker.ports.preparations.consumeGitPush(binding.owner, binding.toolCallId, prepared);
          if (consumed.kind === "existing") {
            replay = consumed.result;
            return false;
          }
          if (consumed.kind !== "claimed") return false;
          claim = consumed;
          return true;
        }, isCurrent: current, ...(signal ? { signal } : {}) }, runtime.authenticatedGit.transport);
      if (replay) return await replay;
      const result = convert(disposition);
      claim?.finish(result);
      return result;
    } catch {
      const result = githubGitFailure("push", claim ? "outcome_unknown" : "request_failed", claim !== undefined);
      claim?.finish(result);
      return result;
    }
  }
  const result = await dispatchGitHubOperation(runtime.broker, toolName, args, { owner: binding.owner, toolCallId: binding.toolCallId,
    ...(binding.stage === "publish" ? { prepared: parseGitHubPreparedOperation(binding.prepared)!, publishingApproval: binding.approval! } : {}) }, signal);
  if (signal?.aborted || !runtime.isCurrent()) return githubFailure(parseGitHubOperation(args)!.operation,
    binding.stage === "publish" ? "outcome_unknown" : "authority_changed", binding.stage === "publish");
  return result;
}
