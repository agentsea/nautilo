import {
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type RelayNetworkPolicy,
  type RelayWorkstationShellBinding,
  parseRelayRunShellGitOperation,
} from "@nautilo/relay";
import {
  GitBroker,
  type GitBrokerDisposition,
} from "@nautilo/sandbox";
import type { GitNetworkContext, GitNetworkDisposition, GitNetworkPushPreparation, GitNetworkTransport,
  GitNetworkWorktreeInput } from "../../../../packages/sandbox/src/git-broker/network";
import type { ProtectedPathPolicy } from "@nautilo/security";

import type { DesktopDispatchDecision } from "./router.ts";

export interface RunShellGitBroker {
  status(): Promise<GitBrokerDisposition>;
  diff(ref?: string): Promise<GitBrokerDisposition>;
  add(pathspecs: readonly string[]): Promise<GitBrokerDisposition>;
  commit(message: string): Promise<GitBrokerDisposition>;
  worktreeAdd(target: string, ref: string): Promise<GitBrokerDisposition>;
  worktreeRemove(target: string): Promise<GitBrokerDisposition>;
  fetch?(input: GitNetworkContext & { repository: string; branch: string }, transport: GitNetworkTransport): Promise<GitNetworkDisposition>;
  preparePush?(input: GitNetworkContext & { repository: string; sourceBranch: string; destinationBranch: string },
    transport: GitNetworkTransport): Promise<GitNetworkPushPreparation | null>;
  push?(input: GitNetworkContext & { prepared: GitNetworkPushPreparation; approved: boolean; consume: () => boolean },
    transport: GitNetworkTransport): Promise<GitNetworkDisposition>;
  clone?(input: GitNetworkWorktreeInput & { directory: string }, transport: GitNetworkTransport): Promise<GitNetworkDisposition>;
  pull?(input: GitNetworkWorktreeInput, transport: GitNetworkTransport): Promise<GitNetworkDisposition>;
}

export type AuthenticatedGitBroker = Required<Pick<RunShellGitBroker, "fetch" | "preparePush" | "push" | "clone" | "pull">>;

export type RunShellGitBrokerFactory = (opts: {
  readonly authority: {
    readonly repository: string;
    readonly grantedRoots: readonly string[];
    readonly protectedPaths?: readonly string[];
  };
  readonly gitExecutable: string;
}) => RunShellGitBroker;

type DesktopFilesystemAuthority = {
  readonly roots: readonly string[];
  readonly readOnlyRoots?: readonly string[];
  readonly writableRoots?: readonly string[];
};

export interface LocalDispatchPolicyState {
  readonly desktopFilesystemAuthority: DesktopFilesystemAuthority | undefined;
  readonly revalidatedShellBinding: RelayWorkstationShellBinding | undefined;
  readonly sandboxEnvelopeWorkspace: string | undefined;
  readonly locallyAuthorizedWorkspace: string | undefined;
  readonly shellNetworkPolicy: RelayNetworkPolicy | undefined;
}

export interface WorkstationHandlers {
  resolveAuthenticatedGitBroker(input: {
    readonly request: RelayDispatchRequest;
    readonly policy: LocalDispatchPolicyState;
  }): Promise<AuthenticatedGitBroker | null>;
  dispatchLocalGit(input: {
    readonly request: RelayDispatchRequest;
    readonly policy: LocalDispatchPolicyState;
  }): Promise<DesktopDispatchDecision>;
}

export interface CreateWorkstationHandlersInput {
  readonly protectedPathPolicy?: ProtectedPathPolicy | undefined;
  readonly createGitBroker?: RunShellGitBrokerFactory | undefined;
  readonly gitWritableGrantRootsProvider?:
    (() => Promise<readonly string[]>) | undefined;
  readonly selectSandboxProtectedPaths: (
    policy: ProtectedPathPolicy,
  ) => readonly string[];
}

const defaultGitBrokerFactory: RunShellGitBrokerFactory = (opts) =>
  new GitBroker({
    authority: opts.authority,
    gitExecutable: opts.gitExecutable,
  });

/** One handler set owns one cache for the exact makeDispatchHandler session. */
export function createWorkstationHandlers(
  input: CreateWorkstationHandlersInput,
): WorkstationHandlers {
  const gitBrokers = new Map<string, RunShellGitBroker>();
  const createGitBroker = input.createGitBroker ?? defaultGitBrokerFactory;
  const getGitBroker = (
    binding: RelayWorkstationShellBinding,
    opts: Parameters<RunShellGitBrokerFactory>[0],
  ): RunShellGitBroker => {
    const key = JSON.stringify([
      binding.subject.userId,
      binding.subject.instanceId,
      binding.relayId,
      binding.desktopSessionId,
      binding.serverBindingId,
      binding.pairingGeneration,
      binding.profileId,
      binding.profileRevision,
      [...binding.grantIds].sort(),
      binding.capabilityRevision,
      binding.currentFolder,
      binding.grantRevision,
      binding.protectedPolicyVersion,
      [...opts.authority.grantedRoots].sort(),
    ]);
    const existing = gitBrokers.get(key);
    if (existing !== undefined) return existing;
    const broker = createGitBroker(opts);
    gitBrokers.set(key, broker);
    return broker;
  };

  const executeGit = async (
    req: RelayDispatchRequest,
    policy: LocalDispatchPolicyState,
    operationInput: unknown,
  ): Promise<RelayDispatchResult> => {
    const parsed = parseRelayRunShellGitOperation(operationInput);
    if (!parsed.ok)
      return {
        status: "error",
        errorCode: "LOCAL_GIT_INVALID",
        error: `local_git operation rejected: ${parsed.error}`,
      };
    if (
      policy.revalidatedShellBinding === undefined ||
      policy.desktopFilesystemAuthority === undefined
    )
      return {
        status: "error",
        errorCode: "LOCAL_GIT_REQUIRES_BINDING",
        error: "local_git operation requires a locally revalidated profile-bound shell binding; an unbound structured git dispatch is refused",
      };
    const operation = parsed.operation;
    const mutating =
      operation.operation === "add" ||
      operation.operation === "commit" ||
      operation.operation === "worktree-add" ||
      operation.operation === "worktree-remove";
    if (mutating && !req.approvalObtained)
      return {
        status: "error",
        errorCode: "LOCAL_GIT_APPROVAL_REQUIRED",
        error: `${req.toolName} mutating git operation requires approval before execution; the broker never mutates durable state without approval`,
      };
    const broker = await resolveGitBroker(policy);
    if (!broker)
      return {
        status: "error",
        errorCode: "LOCAL_GIT_NO_WRITABLE_GRANT",
        error: "local_git operation requires an exact locally revalidated Current Folder and active writable grant",
      };
    let disposition: GitBrokerDisposition;
    switch (operation.operation) {
      case "status":
        disposition = await broker.status();
        break;
      case "diff":
        disposition = await broker.diff(operation.ref);
        break;
      case "add":
        disposition = await broker.add(operation.paths);
        break;
      case "commit":
        disposition = await broker.commit(operation.message);
        break;
      case "worktree-add":
        disposition = await broker.worktreeAdd(operation.target, operation.ref);
        break;
      case "worktree-remove":
        disposition = await broker.worktreeRemove(operation.target);
        break;
    }
    return { status: "ok", result: disposition };
  };

  const resolveGitBroker = async (policy: LocalDispatchPolicyState): Promise<RunShellGitBroker | null> => {
    if (policy.revalidatedShellBinding === undefined || policy.desktopFilesystemAuthority === undefined) return null;
    const grantedRoots = [
      ...new Set([
        ...(policy.desktopFilesystemAuthority.writableRoots ?? []),
        ...(policy.locallyAuthorizedWorkspace === undefined
          ? []
          : [policy.locallyAuthorizedWorkspace]),
        ...((await input.gitWritableGrantRootsProvider?.()) ?? []),
      ]),
    ];
    if (grantedRoots.length === 0) return null;
    return getGitBroker(policy.revalidatedShellBinding, {
      authority: {
        repository: policy.revalidatedShellBinding.currentFolder,
        grantedRoots,
        ...(input.protectedPathPolicy === undefined
          ? {}
          : {
              protectedPaths: input.selectSandboxProtectedPaths(
                input.protectedPathPolicy,
              ),
            }),
      },
      gitExecutable: "/usr/bin/git",
    });
  };

  const resolveAuthenticatedGitBroker: WorkstationHandlers["resolveAuthenticatedGitBroker"] = async ({ request, policy }) => {
    // This host transport cannot enforce an isolated or allowlisted profile.
    if (request.toolName !== "local_git" || request.githubBinding === undefined
      || policy.shellNetworkPolicy?.mode !== "host") return null;
    const broker = await resolveGitBroker(policy);
    return broker && broker.fetch && broker.preparePush && broker.push && broker.clone && broker.pull
      ? broker as AuthenticatedGitBroker : null;
  };

  const dispatchLocalGit: WorkstationHandlers["dispatchLocalGit"] = async ({ request, policy }) => {
    if (request.toolName !== "local_git") return { handled: false };
    return { handled: true, result: await executeGit(request, policy, request.args) };
  };

  return { resolveAuthenticatedGitBroker, dispatchLocalGit };
}
