import { Buffer } from "node:buffer";
import { homedir } from "node:os";

import {
  type DesktopShellResult,
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type RelayNetworkPolicy,
  type RelayWorkstationShellBinding,
  admitRunShellTimeoutMs,
  parseRelayRunShellGitOperation,
} from "@nautilo/relay";
import {
  GitBroker,
  type GitBrokerDisposition,
  type Sandbox,
  spawnSandboxed,
} from "@nautilo/sandbox";
import type { ProtectedPathPolicy } from "@nautilo/security";

import type { RunShellOutputArtifactStore } from "../run-shell-output-continuity.ts";
import { createSanitizedRunShellObservation } from "./run-shell-output.ts";
import type { DesktopDispatchDecision } from "./router.ts";
import { resolveContainedWorkstationIdentityProjection } from "./workstation-identity.ts";

export interface RunShellGitBroker {
  status(): Promise<GitBrokerDisposition>;
  diff(ref?: string): Promise<GitBrokerDisposition>;
  add(pathspecs: readonly string[]): Promise<GitBrokerDisposition>;
  commit(message: string): Promise<GitBrokerDisposition>;
  worktreeAdd(target: string, ref: string): Promise<GitBrokerDisposition>;
  worktreeRemove(target: string): Promise<GitBrokerDisposition>;
}

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
  dispatchRealWorkstation(input: {
    readonly request: RelayDispatchRequest;
    readonly signal: AbortSignal | undefined;
  }): Promise<DesktopDispatchDecision>;
  dispatchSandboxedRunShell(input: {
    readonly request: RelayDispatchRequest;
    readonly signal: AbortSignal | undefined;
    readonly guardRoots: readonly string[];
    readonly policy: LocalDispatchPolicyState;
    readonly sandbox: Sandbox | null;
  }): Promise<DesktopDispatchDecision>;
}

export interface CreateWorkstationHandlersInput {
  readonly relayId?: string | undefined;
  readonly runWorkstationShell?:
    | ((request: {
        readonly command: string;
        readonly cwd: string;
        readonly consentMode?: "verified_uncontained_session" | undefined;
        readonly workspacePath?: string | undefined;
        readonly isCurrentWorkspace?: (() => boolean) | undefined;
        readonly timeoutMs?: number | undefined;
        readonly abortSignal?: AbortSignal | undefined;
        readonly onStdoutChunk?: ((chunk: Buffer) => void) | undefined;
        readonly onStderrChunk?: ((chunk: Buffer) => void) | undefined;
      }) => Promise<RelayDispatchResult>)
    | undefined;
  readonly verifyUncontainedHostCommands?:
    | ((binding: {
        readonly instanceId: string;
        readonly userId: string;
        readonly relayId: string;
        readonly desktopSessionId: string | null;
      }) => Promise<boolean>)
    | undefined;
  readonly getLocalWorkspacePath?: (() => string | undefined) | undefined;
  readonly workstationWorkspacePath?: string | undefined;
  readonly protectedPathPolicy?: ProtectedPathPolicy | undefined;
  readonly resolveWorkstationRelativeCwd: (input: {
    readonly workspacePath: string;
    readonly requestedCwd: unknown;
    readonly protectedPathPolicy?: ProtectedPathPolicy | undefined;
  }) => Promise<
    | { readonly ok: true; readonly workspace: string; readonly cwd: string }
    | { readonly ok: false; readonly errorCode: string; readonly error: string }
  >;
  readonly outputArtifactStore?: RunShellOutputArtifactStore | undefined;
  readonly workstationIdentityHomePath?: string | undefined;
  readonly readWorkstationGitHubToken?:
    | ((signal?: AbortSignal) => Promise<string | null>)
    | undefined;
  readonly createGitBroker?: RunShellGitBrokerFactory | undefined;
  readonly gitWritableGrantRootsProvider?:
    (() => Promise<readonly string[]>) | undefined;
  readonly selectSandboxProtectedPaths: (
    policy: ProtectedPathPolicy,
  ) => readonly string[];
  readonly spawnSandboxed: typeof spawnSandboxed;
  readonly unusableCurrentFolderError: (cwd: string) => string | null;
  readonly hasSandboxCwdFailure: (stderr: string) => boolean;
  readonly sandboxCurrentFolderError: (cwd: string) => string;
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

  const dispatchRealWorkstation: WorkstationHandlers["dispatchRealWorkstation"] =
    async ({ request: req, signal }) => {
      if (req.executionClass !== "real_workstation") return { handled: false };
      if (
        req.toolName !== "run_shell" ||
        req.args["execution"] !== "workstation"
      ) {
        return {
          handled: true,
          result: {
            status: "error",
            errorCode: "REAL_WORKSTATION_CLASS_INVALID",
            error:
              "real workstation execution is valid only for run_shell execution=workstation",
          },
        };
      }
      if (req.args["git"] !== undefined) {
        return {
          handled: true,
          result: {
            status: "error",
            errorCode: "REAL_WORKSTATION_GIT_VARIANT_INVALID",
            error: "structured Git operations remain on the typed GitBroker",
          },
        };
      }
      if (!req.approvalObtained) {
        return {
          handled: true,
          result: {
            status: "error",
            errorCode: "REAL_WORKSTATION_APPROVAL_REQUIRED",
            error: "real workstation execution requires command approval",
          },
        };
      }
      const uncontained = req.uncontainedHostCommandsSession === true;
      if (uncontained) {
        const ownerBinding = req.runShellOwnerBinding;
        if (
          ownerBinding === undefined ||
          input.relayId === undefined ||
          ownerBinding.relayId !== input.relayId ||
          ownerBinding.desktopSessionId === null ||
          input.verifyUncontainedHostCommands === undefined
        ) {
          return {
            handled: true,
            result: {
              status: "error",
              errorCode: "UNCONTAINED_HOST_COMMANDS_LOCAL_BINDING_REQUIRED",
              error:
                "Uncontained host commands require this relay's current local Desktop binding.",
            },
          };
        }
        let locallyActive = false;
        try {
          locallyActive =
            await input.verifyUncontainedHostCommands(ownerBinding);
        } catch {
          locallyActive = false;
        }
        if (!locallyActive)
          return {
            handled: true,
            result: {
              status: "error",
              errorCode: "UNCONTAINED_HOST_COMMANDS_SESSION_INACTIVE",
              error:
                "Uncontained host commands are not active for this Desktop session.",
            },
          };
      }
      const command = req.args["command"];
      const cwd =
        input.getLocalWorkspacePath?.() ?? input.workstationWorkspacePath;
      if (typeof command !== "string" || command.length === 0)
        return {
          handled: true,
          result: {
            status: "error",
            errorCode: "WORKSTATION_COMMAND_REQUIRED",
            error: "No command provided",
          },
        };
      if (!cwd)
        return {
          handled: true,
          result: {
            status: "error",
            errorCode: "WORKSTATION_CURRENT_FOLDER_REQUIRED",
            error:
              "Select a Current Folder before using workstation execution.",
          },
        };
      if (input.runWorkstationShell === undefined)
        return {
          handled: true,
          result: {
            status: "error",
            errorCode: "WORKSTATION_EXECUTOR_UNAVAILABLE",
            error: "This desktop does not provide workstation shell execution.",
          },
        };
      const resolvedCwd = await input.resolveWorkstationRelativeCwd({
        workspacePath: cwd,
        requestedCwd: req.args["cwd"],
        ...(input.protectedPathPolicy === undefined
          ? {}
          : { protectedPathPolicy: input.protectedPathPolicy }),
      });
      if (!resolvedCwd.ok)
        return {
          handled: true,
          result: {
            status: "error",
            errorCode: resolvedCwd.errorCode,
            error: resolvedCwd.error,
          },
        };
      const observation = createSanitizedRunShellObservation(
        req,
        input.outputArtifactStore,
      );
      try {
        const outcome = await input.runWorkstationShell({
          command,
          cwd: resolvedCwd.cwd,
          ...(uncontained
            ? { consentMode: "verified_uncontained_session" as const }
            : {}),
          workspacePath: resolvedCwd.workspace,
          isCurrentWorkspace: () =>
            (input.getLocalWorkspacePath?.() ??
              input.workstationWorkspacePath) === cwd,
          ...(signal === undefined ? {} : { abortSignal: signal }),
          onStdoutChunk: (chunk) => observation.stdout(chunk),
          onStderrChunk: (chunk) => observation.stderr(chunk),
          ...(req.timeout === undefined ? {} : { timeoutMs: req.timeout }),
        });
        if (
          outcome.status !== "ok" ||
          typeof outcome.result !== "object" ||
          outcome.result === null ||
          (outcome.result as DesktopShellResult).version !== 1
        )
          return { handled: true, result: outcome };
        const raw = outcome.result as DesktopShellResult;
        return {
          handled: true,
          result: {
            ...outcome,
            result: observation.attachArtifact(
              observation.result({
                execution: "workstation",
                exitCode: raw.exitCode,
                signal: raw.signal,
                timedOut: raw.timedOut,
                cancelled: raw.cancelled,
                durationMs: raw.durationMs,
                sideEffectsMayHaveStarted: true,
                profileRevision: null,
              }),
            ),
          },
        };
      } finally {
        observation.finish();
      }
    };

  const executeGit = async (
    req: RelayDispatchRequest,
    policy: LocalDispatchPolicyState,
  ): Promise<RelayDispatchResult> => {
    const parsed = parseRelayRunShellGitOperation(req.args["git"]);
    if (!parsed.ok)
      return {
        status: "error",
        errorCode: "RUN_SHELL_GIT_INVALID",
        error: `run_shell git operation rejected: ${parsed.error}`,
      };
    if (
      policy.revalidatedShellBinding === undefined ||
      policy.desktopFilesystemAuthority === undefined
    )
      return {
        status: "error",
        errorCode: "RUN_SHELL_GIT_REQUIRES_BINDING",
        error:
          "run_shell git operation requires a locally revalidated profile-bound shell binding; an unbound structured git dispatch is refused",
      };
    const grantedRoots = [
      ...new Set([
        ...(policy.desktopFilesystemAuthority.writableRoots ?? []),
        ...(policy.locallyAuthorizedWorkspace === undefined
          ? []
          : [policy.locallyAuthorizedWorkspace]),
        ...((await input.gitWritableGrantRootsProvider?.()) ?? []),
      ]),
    ];
    if (grantedRoots.length === 0)
      return {
        status: "error",
        errorCode: "RUN_SHELL_GIT_NO_WRITABLE_GRANT",
        error:
          "run_shell git operation requires at least one active writable grant (create_modify/delete); the worktree target parent must be granted explicitly",
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
        errorCode: "RUN_SHELL_GIT_APPROVAL_REQUIRED",
        error:
          "run_shell mutating git operation requires approval before execution; the broker never mutates durable state without approval",
      };
    const broker = getGitBroker(policy.revalidatedShellBinding, {
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

  const dispatchSandboxedRunShell: WorkstationHandlers["dispatchSandboxedRunShell"] =
    async ({ request: req, signal, guardRoots, policy, sandbox }) => {
      if (req.toolName !== "run_shell") return { handled: false };
      const hasGit = req.args["git"] !== undefined;
      const rawCommand = req.args["command"];
      const command =
        typeof rawCommand === "string"
          ? rawCommand
          : rawCommand == null
            ? ""
            : typeof rawCommand === "number" ||
                typeof rawCommand === "boolean" ||
                typeof rawCommand === "bigint"
              ? String(rawCommand)
              : "";
      const hasCommand = command.length > 0;
      if (hasGit && hasCommand)
        return {
          handled: true,
          result: {
            status: "error",
            errorCode: "RUN_SHELL_AMBIGUOUS_MODE",
            error:
              "run_shell admits exactly one of `command` or `git`; the dispatch carried both",
          },
        };
      if (hasGit)
        return { handled: true, result: await executeGit(req, policy) };
      if (!command)
        return {
          handled: true,
          result: { status: "error", error: "No command provided" },
        };
      if (req.impact === "destructive" && !req.approvalObtained)
        return {
          handled: true,
          result: {
            status: "error",
            error: "run_shell requires approval for destructive operations",
          },
        };
      const cwd = policy.desktopFilesystemAuthority
        ? (policy.sandboxEnvelopeWorkspace ?? guardRoots[0] ?? process.cwd())
        : (req.sandboxProfile?.workspace ?? guardRoots[0] ?? process.cwd());
      const cwdError = input.unusableCurrentFolderError(cwd);
      if (cwdError)
        return { handled: true, result: { status: "error", error: cwdError } };
      const timeoutMs = admitRunShellTimeoutMs(req.timeout);
      if (sandbox === null)
        return {
          handled: true,
          result: {
            status: "error",
            error: "internal: run_shell reached without a sandbox",
          },
        };
      const containedWorkstationIdentity =
        policy.revalidatedShellBinding === undefined
          ? undefined
          : await resolveContainedWorkstationIdentityProjection(
              input.workstationIdentityHomePath ?? homedir(),
              input.readWorkstationGitHubToken,
              signal,
            );
      const observation = createSanitizedRunShellObservation(
        req,
        input.outputArtifactStore,
        containedWorkstationIdentity?.outputSecrets,
      );
      try {
        const result = await input.spawnSandboxed(
          sandbox,
          "/bin/sh",
          ["-c", command],
          {
            cwd,
            timeoutMs,
            ...(containedWorkstationIdentity !== undefined &&
            Object.keys(containedWorkstationIdentity.commandEnv).length > 0
              ? { env: containedWorkstationIdentity.commandEnv }
              : {}),
            ...(signal === undefined ? {} : { abortSignal: signal }),
            onStdoutChunk: (chunk) => observation.stdout(chunk),
            onStderrChunk: (chunk) => observation.stderr(chunk),
          },
        );
        observation.finish();
        const shellResult = observation.result({
          execution: "sandboxed",
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          cancelled: result.aborted,
          durationMs: result.durationMs,
          sideEffectsMayHaveStarted: true,
          profileRevision: req.workstationShellBinding?.profileRevision ?? null,
        });
        if (input.hasSandboxCwdFailure(result.stderr))
          return {
            handled: true,
            result: {
              status: "error",
              error: input.sandboxCurrentFolderError(cwd),
            },
          };
        if (result.exitCode !== 0) {
          const denials = sandbox.consumeNetworkDeniedDestinations();
          if (denials.length > 0)
            return {
              handled: true,
              result: {
                status: "error",
                error: `run_shell exit ${result.exitCode ?? "signal"}: ${shellResult.stderr.trim()}`,
                networkDeniedDestination: denials[denials.length - 1],
              },
            };
        }
        return {
          handled: true,
          result: {
            status: "ok",
            result: observation.attachArtifact(shellResult),
          },
        };
      } catch (error) {
        observation.finish();
        return {
          handled: true,
          result: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        observation.finish();
      }
    };

  return { dispatchRealWorkstation, dispatchSandboxedRunShell };
}
