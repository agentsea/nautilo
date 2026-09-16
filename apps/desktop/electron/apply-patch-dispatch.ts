/**
 * D448 — Desktop's strict, local authority boundary for one relay apply-patch
 * operation. Desktop supplies the locally resolved Current Folder root and
 * executable authority. Native apply_patch runs only in an invocation-private
 * tree; an injected coordinator port is the sole live-file writer.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRelayLocalApplyPatchRequest,
  parseRelayLocalApplyPatchResult,
  type RelayLocalApplyPatchRequest,
  type RelayLocalApplyPatchResult,
  type RelaySandboxProfile,
} from "@nautilo/relay";
import type { DesktopFilesystemAccessOperation } from "@nautilo/desktop-filesystem-grants";
import { Sandbox, createSandboxFromEnvelope } from "@nautilo/sandbox";
import {
  preflightApplyPatch,
} from "../../../packages/agent/src/tools/apply-patch/preflight.ts";
import type { ApplyPatchPreflightSummary } from "../../../packages/agent/src/tools/apply-patch/contract.ts";
import {
  runApplyPatchProcess,
  type ApplyPatchProcessWrapperResult,
  type ApplyPatchSandboxAdapter,
  type ApplyPatchStartedProcess,
} from "../../../packages/agent/src/tools/apply-patch/process-wrapper.ts";
import {
  executeWorkspaceApplyPatch,
  type ApplyPatchWorkspaceCommitPort,
  type WorkspaceApplyPatchOperationReconciliation,
} from "../../../packages/agent/src/tools/apply-patch/workspace-executor.ts";
import {
  createWorkspaceApplyPatchPrivateTreePort,
  type WorkspaceApplyPatchPrivateTree,
} from "../../../packages/agent/src/tools/apply-patch/workspace-production-adapter.ts";
import {
  resolveApplyPatchDesktopRuntime,
  type ApplyPatchDesktopRuntimeResolution,
} from "./apply-patch-runtime.ts";
import { createGuardedNodeAdapter } from "./local-file-history/file-adapter.ts";

export type ApplyPatchDispatchPreparation = {
  readonly request: RelayLocalApplyPatchRequest;
  readonly preflight: ApplyPatchPreflightSummary;
  readonly requiredOperations: readonly DesktopFilesystemAccessOperation[];
};

export type ApplyPatchDispatchFailure = {
  readonly ok: false;
  readonly code: "invalid_request" | "parse_error" | "denied_path";
  readonly message: string;
};

export type ApplyPatchDispatchPreparationResult =
  | { readonly ok: true; readonly preparation: ApplyPatchDispatchPreparation }
  | ApplyPatchDispatchFailure;

const operationOrder: readonly DesktopFilesystemAccessOperation[] = ["read", "create_modify", "delete"];

function stableFailure(
  code: ApplyPatchDispatchFailure["code"],
  message: string,
): ApplyPatchDispatchFailure {
  return { ok: false, code, message };
}

/** Derive the complete local operation set from patch semantics. */
export function requiredOperationsForApplyPatch(
  summary: ApplyPatchPreflightSummary,
): readonly DesktopFilesystemAccessOperation[] {
  const required = new Set<DesktopFilesystemAccessOperation>();
  for (const operation of summary.operations) {
    switch (operation.operation) {
      case "add":
        // Adds may overwrite an existing regular file, so snapshotting its
        // pre-state requires local read authority as well as modification.
        required.add("read");
        required.add("create_modify");
        break;
      case "update":
        required.add("read");
        required.add("create_modify");
        break;
      case "delete":
        required.add("read");
        required.add("delete");
        break;
      case "move":
        required.add("read");
        required.add("create_modify");
        required.add("delete");
        break;
    }
  }
  return operationOrder.filter((operation) => required.has(operation));
}

/** Parse the dedicated request and derive its complete local operation set. */
export function prepareRelayApplyPatchDispatch(value: {
  readonly args: unknown;
}): ApplyPatchDispatchPreparationResult {
  const parsedRequest = parseRelayLocalApplyPatchRequest(value.args);
  if (!parsedRequest.ok) {
    return stableFailure("invalid_request", "apply_patch relay request is malformed.");
  }
  const preflight = preflightApplyPatch(parsedRequest.request.operation.patch);
  if (!preflight.ok) {
    return stableFailure(preflight.error.code === "invalid_request" ? "invalid_request" : "parse_error", preflight.error.message);
  }
  const requiredOperations = requiredOperationsForApplyPatch(preflight.summary);
  return {
    ok: true,
    preparation: {
      request: parsedRequest.request,
      preflight: preflight.summary,
      requiredOperations,
    },
  };
}

/** Trusted identity must be supplied outside the v9 model/relay patch body. */
export interface ApplyPatchTrustedIdentity {
  readonly ownerId: string;
  readonly agentId: string;
  readonly turnId: string;
}

export interface ApplyPatchCoordinatorCommitInput {
  readonly root: string;
  readonly identity: ApplyPatchTrustedIdentity;
  readonly preparation: ApplyPatchDispatchPreparation;
  /** Exact preimages and staged postimages; no native/live path is exposed. */
  readonly operations: readonly WorkspaceApplyPatchOperationReconciliation[];
  /** Revalidates the locally selected Current Folder at commit fences. */
  readonly reauthorize: () => Promise<void>;
}

export type CommitDesktopApplyPatch = (
  input: ApplyPatchCoordinatorCommitInput,
) => ReturnType<ApplyPatchWorkspaceCommitPort["reconcileApplied"]>;

export interface ApplyPatchDispatchOptions {
  readonly preparation: ApplyPatchDispatchPreparation;
  /** Built in relay.ts from the locally resolved Current Folder only. */
  readonly sandboxEnvelope: RelaySandboxProfile;
  /** Locally resolved before compiling the envelope's trusted tools directory. */
  readonly runtime?: Extract<ApplyPatchDesktopRuntimeResolution, { ok: true }> | undefined;
  /** Mandatory coordinator/V2-journal port; it is the sole live-file writer. */
  readonly commitApplied?: CommitDesktopApplyPatch | undefined;
  /** Current Folder authority revalidation, injected by relay.ts. */
  readonly reauthorize?: (() => Promise<void>) | undefined;
  /** Mandatory trusted owner/agent/turn binding, never taken from patch text. */
  readonly trustedIdentity?: ApplyPatchTrustedIdentity | undefined;
  readonly resolveRuntime?: () => ApplyPatchDesktopRuntimeResolution;
  readonly runProcess?: (input: {
    readonly root: string;
    readonly patch: string;
    readonly runtime: Extract<ApplyPatchDesktopRuntimeResolution, { ok: true }>;
    readonly sandboxEnvelope: RelaySandboxProfile;
  }) => Promise<ApplyPatchProcessWrapperResult>;
}

type SandboxHandle = { readonly sandbox: Sandbox; process?: ChildProcess };

/** Best effort: a child can naturally exit before its process tree is terminated. */
export function terminateDesktopApplyPatchProcess(
  child: Pick<ChildProcess, "pid" | "kill"> | undefined,
  platform: NodeJS.Platform = process.platform,
  killGroup: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => { process.kill(pid, signal); },
): void {
  if (!child?.pid) return;
  try {
    if (platform !== "win32") killGroup(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function desktopRuntimeResolution(): ApplyPatchDesktopRuntimeResolution {
  return resolveApplyPatchDesktopRuntime({
    resourcesPath: process.resourcesPath ?? null,
    devVendorRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor"),
  });
}

/** Capability is absent for every unavailable platform or failed handshake. */
export function applyPatchExecutionCapability(
  resolution: ApplyPatchDesktopRuntimeResolution,
  hasCoordinatorSeam: boolean,
): { readonly applyPatchExecution: true } | Record<never, never> {
  return resolution.ok && hasCoordinatorSeam ? { applyPatchExecution: true } : {};
}

function createSandboxAdapter(envelope: RelaySandboxProfile): ApplyPatchSandboxAdapter<SandboxHandle> {
  return {
    async createSandbox() {
      const sandbox = await createSandboxFromEnvelope(envelope);
      try {
        if (!sandbox.containmentActive()) {
          throw new Error("sandbox containment unavailable");
        }
        if ((envelope.config.protectedPaths?.length ?? 0) > 0 && !sandbox.protectedFileMaskSupported()) {
          throw new Error("sandbox protected-file masking unavailable");
        }
        return { sandbox };
      } catch (error) {
        await sandbox.close();
        throw error;
      }
    },
    start(handle, input): ApplyPatchStartedProcess {
      const wrapped = handle.sandbox.wrap(input.binaryPath, input.argv, input.cwd, input.env);
      const child = spawn(wrapped.program, [...wrapped.args], {
        cwd: wrapped.cwd,
        env: wrapped.env ?? {},
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      handle.process = child;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Uint8Array) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk: Uint8Array) => stderr.push(Buffer.from(chunk)));
      child.stdin?.end(input.stdin, "utf8");
      return {
        completed: new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode, signal) => resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode,
            signal,
          }));
        }),
      };
    },
    terminateProcessTree(handle) {
      terminateDesktopApplyPatchProcess(handle.process);
    },
    async cleanupSandbox(handle) {
      await handle.sandbox.close();
    },
  };
}

async function runDesktopApplyPatchProcess(input: {
  readonly root: string;
  readonly patch: string;
  readonly runtime: Extract<ApplyPatchDesktopRuntimeResolution, { ok: true }>;
  readonly sandboxEnvelope: RelaySandboxProfile;
}): Promise<ApplyPatchProcessWrapperResult> {
  return runApplyPatchProcess({
    root: input.root,
    patch: input.patch,
    binaryPath: input.runtime.binaryPath,
    expectedRuntime: {
      protocol: input.runtime.protocol,
      runtimeVersion: input.runtime.runtimeVersion,
      upstreamRevision: input.runtime.provenance.upstreamRevision,
      nautiloExtractionRevision: input.runtime.provenance.nautiloExtractionRevision,
    },
    sandbox: createSandboxAdapter(input.sandboxEnvelope),
  });
}

function privateSandboxEnvelope(
  envelope: RelaySandboxProfile,
  privateRoot: string,
): RelaySandboxProfile {
  return {
    ...envelope,
    workspace: privateRoot,
    config: {
      ...envelope.config,
      writablePaths: [],
      projectPaths: [],
      ...(envelope.config.readOnlyPaths === undefined
        ? {}
        : { readOnlyPaths: [] }),
    },
  };
}

/**
 * Run a single preflighted relay request. Native execution is confined to a
 * private materialization. Only a complete, exactly observed native outcome
 * reaches the coordinator-backed live-file commit port.
 */
export async function executeRelayApplyPatchDispatch(
  options: ApplyPatchDispatchOptions,
): Promise<{ readonly ok: true; readonly result: RelayLocalApplyPatchResult } | { readonly ok: false; readonly code: string; readonly message: string }> {
  const preparation = options.preparation;
  const runtime = options.runtime ?? (options.resolveRuntime ?? desktopRuntimeResolution)();
  if (!runtime.ok) return { ok: false, code: "runtime_unavailable", message: runtime.message };
  if (
    options.commitApplied === undefined ||
    options.reauthorize === undefined ||
    options.trustedIdentity === undefined ||
    options.trustedIdentity.ownerId.length === 0 ||
    options.trustedIdentity.agentId.length === 0 ||
    options.trustedIdentity.agentId !== preparation.request.operation.routing.agentId ||
    options.trustedIdentity.turnId !== preparation.request.operation.routing.turnId
  ) {
    return {
      ok: false,
      code: "runtime_unavailable",
      message: "apply_patch trusted coordinator identity is unavailable on this relay.",
    };
  }
  const root = await fs.realpath(options.sandboxEnvelope.workspace)
    .catch(() => path.resolve(options.sandboxEnvelope.workspace));
  const guarded = createGuardedNodeAdapter({ allowedRoots: [root] });
  const tree = createWorkspaceApplyPatchPrivateTreePort();
  const execution = await executeWorkspaceApplyPatch<WorkspaceApplyPatchPrivateTree>({
    patch: preparation.request.operation.patch,
    artifacts: {
      readAuthorized: async (logicalPath) => {
        const lexical = path.resolve(root, logicalPath);
        let candidate: string;
        try {
          candidate = await guarded.resolveTarget(lexical, {
            allowMissing: false,
            rejectFinalSymlink: true,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await guarded.resolveTarget(lexical, {
            allowMissing: true,
            rejectFinalSymlink: true,
          });
          return null;
        }
        return {
          logicalPath,
          artifactId: candidate,
          revision: null,
          bytes: new Uint8Array(await guarded.readFile(candidate)),
        };
      },
    },
    tree: {
      ...tree,
      create: () => tree.create(),
    },
    runner: {
      run: async ({ tree: privateTree, patch: patchBody }) => {
        try {
          return await (options.runProcess ?? runDesktopApplyPatchProcess)({
            root: privateTree.root,
            patch: patchBody,
            runtime,
            sandboxEnvelope: privateSandboxEnvelope(
              options.sandboxEnvelope,
              privateTree.root,
            ),
          });
        } catch {
          return {
            ok: false,
            error: {
              code: "runtime_unavailable",
              message: "apply_patch runtime execution failed.",
              retryable: true,
            },
          };
        }
      },
    },
    commit: {
      reconcileApplied: (operations) => options.commitApplied!({
        root,
        identity: options.trustedIdentity!,
        preparation,
        operations,
        reauthorize: options.reauthorize!,
      }),
    },
  });
  if (!execution.ok) {
    return {
      ok: false,
      code: execution.error.code,
      message: execution.error.message,
    };
  }
  // The coordinator owns the externally observable mutation sequence. In
  // particular, the executor coalesces an isolated native delete/add pair for
  // one path into its one observable update, so rebuilding results from the
  // native preflight would duplicate its revision receipt.
  const pathResults = execution.commit.operations.map((committed) => {
    return {
      operation: committed.operation,
      path: committed.path,
      ...(committed.operation === "move" ? { fromPath: committed.fromPath } : {}),
      status: committed.state === "committed" ? "applied" as const : "unknown" as const,
      revisionId: committed.state === "committed" ? committed.revisionIds.at(-1) ?? null : null,
    };
  });
  const result: RelayLocalApplyPatchResult = {
    status: "applied",
    partial: false,
    ...(execution.commit.rebased === true ? { rebased: true } : {}),
    operationCounts: {
      add: pathResults.filter((item) => item.operation === "add").length,
      update: pathResults.filter((item) => item.operation === "update").length,
      move: pathResults.filter((item) => item.operation === "move").length,
      delete: pathResults.filter((item) => item.operation === "delete").length,
    },
    pathResults,
    changedFiles: pathResults,
    revisionIds: pathResults.flatMap((item) =>
      item.revisionId === null ? [] : [item.revisionId]),
    unifiedDiff: execution.unifiedDiff,
    runtimeVersion: execution.report.runtimeVersion,
    turnId: preparation.request.operation.routing.turnId,
  };
  const parsed = parseRelayLocalApplyPatchResult(result);
  if (!parsed.ok) {
    return { ok: false, code: "runtime_corrupt", message: "apply_patch coordinator returned an invalid result." };
  }
  return { ok: true, result: parsed.result };
}
