import { parseGitHubCapability, parseGitHubInvocationBinding, sameGitHubDesktopIdentity, type GitHubCapability } from "@nautilo/types";
import { parseGitHubInvocationOwner, parseGitHubOperation, parseGitHubPreparedOperation, githubFailure, type GitHubInvocationOwner,
  type GitHubPreparedOperation, type GitHubFailureCode, type GitHubOperation } from "../../../../packages/types/src/github-broker";
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
  readonly isCurrent: () => boolean;
  readonly retire: () => void;
}
export async function dispatchAdmittedGitHub(runtime: DesktopGitHubRuntime | null, toolName: string, args: unknown,
  value: unknown, signal?: AbortSignal) {
  const supplied = parseGitHubInvocationBinding(value);
  const binding = parseGitHubInvocationBinding(value, args);
  const capability = parseGitHubCapability(runtime?.capability);
  if (!runtime || !binding || !capability || toolName !== "local_github" || signal?.aborted || !runtime.isCurrent()
    || binding.generation !== capability.generation || !sameGitHubDesktopIdentity(binding.owner, capability.identity)) {
    return githubFailure(supplied?.prepared?.request.operation ?? parseGitHubOperation(args)?.operation ?? "issue_read",
      supplied?.stage === "publish" ? "outcome_unknown" : "authority_changed", supplied?.stage === "publish");
  }
  const result = await dispatchGitHubOperation(runtime.broker, toolName, args, { owner: binding.owner, toolCallId: binding.toolCallId,
    ...(binding.stage === "publish" ? { prepared: binding.prepared!, publishingApproval: binding.approval! } : {}) }, signal);
  if (signal?.aborted || !runtime.isCurrent()) return githubFailure(parseGitHubOperation(args)!.operation,
    binding.stage === "publish" ? "outcome_unknown" : "authority_changed", binding.stage === "publish");
  return result;
}
