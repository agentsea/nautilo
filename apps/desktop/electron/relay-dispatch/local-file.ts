import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { OfficeCreateRunFn } from "@nautilo/config/officecli";
import type { ProtectedPathPolicy } from "@nautilo/security";
import type { Sandbox } from "@nautilo/sandbox";
import type {
  RelayDispatchRequest,
  RelayDispatchResult,
  RelayFsChangeEvent,
  RelaySandboxProfile,
  WorkspaceGuard,
} from "@nautilo/relay";

import {
  executeRelayApplyPatchDispatch,
  type ApplyPatchDispatchPreparation,
  type ApplyPatchTrustedIdentity,
  type CommitDesktopApplyPatch,
} from "../apply-patch-dispatch.ts";
import type { ApplyPatchDesktopRuntimeResolution } from "../apply-patch-runtime.ts";
import type {
  DesktopAgentContentCommitResult,
  DesktopAgentStructuralCommitResult,
  DesktopHistoryRestoreResult,
  DesktopOfficeCliCommitResult,
} from "../document-mutations/desktop-document-mutation-runtime.ts";
import { probeDesktopRipgrep } from "../ripgrep-runtime.ts";
import { handleLocalFileDispatch } from "../local-file-dispatch/index.ts";
import {
  DESKTOP_FILESYSTEM_BASELINE_ACCESS,
  deriveDesktopFilesystemAccessOperation,
  deriveDesktopFilesystemAccessOperations,
  type DesktopFilesystemAuthority,
  type DesktopFilesystemGrantAuthorityResolver,
} from "./desktop-filesystem.ts";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type DesktopDispatchDecision,
} from "./router.ts";

export type {
  ApplyPatchDispatchPreparation,
  ApplyPatchTrustedIdentity,
  CommitDesktopApplyPatch,
};

export interface DesktopOfficeCliCoordinatorCommitInput {
  readonly targetPath: string;
  readonly targetBefore: Uint8Array | null;
  readonly after: Uint8Array;
  readonly source?: {
    readonly path: string;
    readonly before: Uint8Array;
  } | undefined;
  readonly agentId: string;
  readonly turnId: string;
  readonly reauthorize: () => Promise<void>;
}

export type CommitDesktopOfficeCli = (
  input: DesktopOfficeCliCoordinatorCommitInput,
) => Promise<DesktopOfficeCliCommitResult>;

export interface DesktopAgentContentCoordinatorCommitInput {
  readonly targetPath: string;
  readonly authorizedRoots?: readonly string[] | undefined;
  readonly before: Uint8Array | null;
  readonly after: Uint8Array;
  readonly agentId: string;
  readonly turnId: string;
  readonly command: string;
  readonly mutationRequestId: string;
  readonly semanticDigest: string;
  readonly replayOnly?: boolean | undefined;
  readonly clientMutationId?: string | undefined;
  readonly reauthorize: () => Promise<void>;
}

export type CommitDesktopAgentContent = (
  input: DesktopAgentContentCoordinatorCommitInput,
) => Promise<DesktopAgentContentCommitResult>;

export interface DesktopAgentStructuralCoordinatorCommitInput {
  readonly command: "delete" | "move" | "copy";
  readonly sourcePath: string;
  readonly destinationPath?: string | undefined;
  readonly authorizedRoots: readonly string[];
  readonly agentId: string;
  readonly turnId: string;
  readonly mutationRequestId: string;
  readonly semanticDigest: string;
  readonly replayOnly?: boolean | undefined;
  readonly reauthorize: () => Promise<void>;
}

export type CommitDesktopAgentStructural = (
  input: DesktopAgentStructuralCoordinatorCommitInput,
) => Promise<DesktopAgentStructuralCommitResult>;

export interface DesktopHistoryRestoreCoordinatorCommitInput {
  readonly action: "undo" | "redo" | "undo_turn";
  readonly targetPath?: string | undefined;
  readonly revisionId?: string | undefined;
  readonly targetTurnId?: string | undefined;
  readonly agentId: string;
  readonly turnId: string;
  readonly mutationRequestId: string;
  readonly semanticDigest: string;
  readonly authorizedRoots: readonly string[];
  readonly replayOnly?: boolean | undefined;
  readonly reauthorize: () => Promise<void>;
}

export type CommitDesktopHistoryRestore = (
  input: DesktopHistoryRestoreCoordinatorCommitInput,
) => Promise<DesktopHistoryRestoreResult>;

type ApplyPatchCurrentFolderResolution =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly code: "stale_context" | "denied_path"; readonly message: string };

/**
 * Resolve apply_patch authority exclusively from Electron main's live Current
 * Folder. The server value is compared as a stale-context assertion and never
 * becomes filesystem authority.
 */
async function resolveApplyPatchCurrentFolder(input: {
  readonly expectedCurrentFolder: string;
  readonly getLocalWorkspacePath?: (() => string | undefined) | undefined;
  readonly protectedPathPolicy?: ProtectedPathPolicy | undefined;
}): Promise<ApplyPatchCurrentFolderResolution> {
  const selected = input.getLocalWorkspacePath?.();
  if (
    selected === undefined ||
    !path.isAbsolute(selected) ||
    !path.isAbsolute(input.expectedCurrentFolder) ||
    path.normalize(selected) !== path.normalize(input.expectedCurrentFolder)
  ) {
    return {
      ok: false,
      code: "stale_context",
      message: "Current Folder changed while apply_patch was prepared",
    };
  }
  try {
    const root = await fsp.realpath(selected);
    if (!(await fsp.stat(root)).isDirectory()) {
      return { ok: false, code: "stale_context", message: "Current Folder is unavailable" };
    }
    if (input.protectedPathPolicy === undefined || !input.protectedPathPolicy.check(root).allowed) {
      return { ok: false, code: "denied_path", message: "Current Folder is protected" };
    }
    return { ok: true, root };
  } catch {
    return { ok: false, code: "stale_context", message: "Current Folder is unavailable" };
  }
}

function isLocalFileRequest(request: RelayDispatchRequest): boolean {
  return request.executionClass === "local-file" || request.toolName === "local-file";
}

function isLocalFileSearch(request: RelayDispatchRequest): boolean {
  const operation = isLocalFileRequest(request) ? request.args["operation"] : undefined;
  return operation !== null &&
    typeof operation === "object" &&
    (operation as { kind?: unknown }).kind === "search";
}

export interface LocalFileHandlers {
  dispatchDirect(input: {
    readonly request: RelayDispatchRequest;
    readonly guard: WorkspaceGuard;
    readonly signal: AbortSignal | undefined;
    readonly authority: DesktopFilesystemAuthority | undefined;
    readonly applyPatchPreparation: ApplyPatchDispatchPreparation | undefined;
  }): Promise<DesktopDispatchDecision>;
  dispatchSandboxedSearch(input: {
    readonly request: RelayDispatchRequest;
    readonly guard: WorkspaceGuard;
    readonly signal: AbortSignal | undefined;
    readonly authority: DesktopFilesystemAuthority | undefined;
    readonly sandbox: Sandbox | null;
    readonly getRipgrepRuntime: () => Promise<Awaited<ReturnType<typeof probeDesktopRipgrep>>>;
  }): Promise<DesktopDispatchDecision>;
}

export interface CreateLocalFileHandlersDeps {
  readonly relayId?: string | undefined;
  readonly baseRoots: readonly string[];
  readonly onFsChange?: ((event: RelayFsChangeEvent) => void) | undefined;
  readonly desktopFilesystemGrantAuthority?: DesktopFilesystemGrantAuthorityResolver | undefined;
  readonly commitDesktopApplyPatch?: CommitDesktopApplyPatch | undefined;
  readonly commitDesktopOfficeCli?: CommitDesktopOfficeCli | undefined;
  readonly commitDesktopAgentContent?: CommitDesktopAgentContent | undefined;
  readonly commitDesktopAgentStructural?: CommitDesktopAgentStructural | undefined;
  readonly commitDesktopHistoryRestore?: CommitDesktopHistoryRestore | undefined;
  readonly resolveApplyPatchTrustedIdentity?: ((
    request: RelayDispatchRequest,
    preparation: ApplyPatchDispatchPreparation,
  ) => ApplyPatchTrustedIdentity | undefined | Promise<ApplyPatchTrustedIdentity | undefined>) | undefined;
  readonly getLocalWorkspacePath?: (() => string | undefined) | undefined;
  readonly protectedPathPolicy?: ProtectedPathPolicy | undefined;
  readonly officeRun?: OfficeCreateRunFn | undefined;
  readonly buildApplyPatchEnvelope: (input: {
    readonly base: RelaySandboxProfile;
    readonly currentFolder: string;
    readonly protectedPathPolicy: ProtectedPathPolicy;
    readonly scratch: { readonly workspace: string; readonly protectedFileMaskPath: string };
    readonly runtime: Extract<ApplyPatchDesktopRuntimeResolution, { readonly ok: true }>;
  }) => RelaySandboxProfile;
  readonly resolveApplyPatchRuntime: () => Promise<ApplyPatchDesktopRuntimeResolution>;
  readonly createGuardedScratch: () => {
    readonly workspace: string;
    readonly protectedFileMaskPath: string;
  };
  /** Injectable only to characterize this extracted routing boundary in isolation. */
  readonly executeApplyPatchDispatch?: typeof executeRelayApplyPatchDispatch;
}

/**
 * Request-local local-file composition. It owns neither a relay lifecycle nor
 * durable grants/stores; Electron supplies those exact owner ports at creation.
 */
export function createLocalFileHandlers(deps: CreateLocalFileHandlersDeps): LocalFileHandlers {
  const reauthorize = async (
    request: RelayDispatchRequest,
    message: string,
    structural = false,
  ): Promise<void> => {
    if (request.desktopFilesystemGrantRequest === undefined) return;
    const resolver = deps.desktopFilesystemGrantAuthority;
    if (resolver === undefined) {
      throw new Error("Desktop Filesystem Grant authority is unavailable");
    }
    const resolution = await resolver({
      request: request.desktopFilesystemGrantRequest,
      concreteOperation: deriveDesktopFilesystemAccessOperation(request),
      ...(structural
        ? { concreteOperations: deriveDesktopFilesystemAccessOperations(request) ?? [] }
        : {}),
      baselineAuthorities: deps.baseRoots.map((root) => ({
        id: `baseline:${root}`,
        root,
        access: DESKTOP_FILESYSTEM_BASELINE_ACCESS,
      })),
    });
    if (!resolution.ok) {
      throw new Error(`${message}: ${resolution.code}`);
    }
  };

  const dispatchApplyPatch = async (input: {
    readonly request: RelayDispatchRequest;
    readonly preparation: ApplyPatchDispatchPreparation;
  }): Promise<RelayDispatchResult> => {
    if (
      deps.protectedPathPolicy === undefined ||
      deps.getLocalWorkspacePath === undefined ||
      input.request.sandboxProfile === undefined
    ) {
      return {
        status: "error",
        errorCode: "stale_context",
        error: "apply_patch requires a locally selected Current Folder and a local sandbox envelope",
      };
    }
    const currentFolder = await resolveApplyPatchCurrentFolder({
      expectedCurrentFolder: input.preparation.request.expectedCurrentFolder,
      getLocalWorkspacePath: deps.getLocalWorkspacePath,
      protectedPathPolicy: deps.protectedPathPolicy,
    });
    if (!currentFolder.ok) {
      return {
        status: "error",
        errorCode: currentFolder.code,
        error: currentFolder.message,
      };
    }
    const runtime = await deps.resolveApplyPatchRuntime();
    if (!runtime.ok) {
      return { status: "error", errorCode: runtime.code, error: runtime.message };
    }
    let sandboxEnvelope: RelaySandboxProfile;
    try {
      // The raw server envelope supplies no filesystem authority: Electron
      // main's live Current Folder and canonical protected paths replace it.
      sandboxEnvelope = deps.buildApplyPatchEnvelope({
        base: input.request.sandboxProfile,
        currentFolder: currentFolder.root,
        protectedPathPolicy: deps.protectedPathPolicy,
        scratch: deps.createGuardedScratch(),
        runtime,
      });
    } catch {
      return {
        status: "error",
        errorCode: "denied_path",
        error: "apply_patch local sandbox envelope is unavailable",
      };
    }
    const trustedIdentity = deps.resolveApplyPatchTrustedIdentity === undefined
      ? undefined
      : await deps.resolveApplyPatchTrustedIdentity(input.request, input.preparation);
    const outcome = await (deps.executeApplyPatchDispatch ?? executeRelayApplyPatchDispatch)({
      preparation: input.preparation,
      sandboxEnvelope,
      runtime,
      ...(deps.commitDesktopApplyPatch === undefined
        ? {}
        : { commitApplied: deps.commitDesktopApplyPatch }),
      reauthorize: async () => {
        const refreshed = await resolveApplyPatchCurrentFolder({
          expectedCurrentFolder: input.preparation.request.expectedCurrentFolder,
          getLocalWorkspacePath: deps.getLocalWorkspacePath,
          protectedPathPolicy: deps.protectedPathPolicy,
        });
        if (!refreshed.ok || refreshed.root !== currentFolder.root) {
          throw new Error("Current Folder changed before apply_patch commit");
        }
      },
      ...(trustedIdentity === undefined ? {} : { trustedIdentity }),
    });
    if (!outcome.ok) {
      console.warn(`[relay][apply_patch] dispatch failed code=${outcome.code}`);
    }
    return outcome.ok
      ? { status: "ok", result: outcome.result }
      : { status: "error", errorCode: outcome.code, error: outcome.message };
  };

  const dispatchOrdinary = async (input: {
    readonly request: RelayDispatchRequest;
    readonly guard: WorkspaceGuard;
    readonly signal: AbortSignal | undefined;
    readonly authority: DesktopFilesystemAuthority | undefined;
    readonly sandbox?: Sandbox | undefined;
    readonly ripgrepRuntime?: Awaited<ReturnType<typeof probeDesktopRipgrep>> | undefined;
  }): Promise<RelayDispatchResult> => {
    const relayId = deps.relayId;
    if (!relayId) return { status: "error", error: "local-file dispatch requires relayId" };
    const result = await handleLocalFileDispatch(input.request, {
      relayId,
      guard: input.guard,
      ...(deps.onFsChange === undefined ? {} : { onFsChange: deps.onFsChange }),
      ...(input.authority === undefined
        ? {}
        : { desktopFilesystemAuthority: input.authority }),
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.ripgrepRuntime === undefined ? {} : { ripgrepRuntime: input.ripgrepRuntime }),
      ...(deps.officeRun === undefined ? {} : { officeRun: deps.officeRun }),
      ...(deps.commitDesktopOfficeCli === undefined
        ? {}
        : {
            officeCliCommit: async (coordinatorInput) => await deps.commitDesktopOfficeCli!({
              ...coordinatorInput,
              reauthorize: () => reauthorize(
                input.request,
                "Desktop Filesystem Grant request rejected at OfficeCLI commit",
              ),
            }),
          }),
      ...(deps.commitDesktopAgentContent === undefined
        ? {}
        : {
            agentContentCommit: async (coordinatorInput) => await deps.commitDesktopAgentContent!({
              ...coordinatorInput,
              reauthorize: () => reauthorize(
                input.request,
                "Desktop Filesystem Grant request rejected at local file-tool commit",
              ),
            }),
          }),
      ...(deps.commitDesktopAgentStructural === undefined
        ? {}
        : {
            structuralCommit: async (coordinatorInput) => await deps.commitDesktopAgentStructural!({
              ...coordinatorInput,
              reauthorize: () => reauthorize(
                input.request,
                "Desktop Filesystem Grant request rejected at structural file-tool commit",
                true,
              ),
            }),
          }),
      ...(deps.commitDesktopHistoryRestore === undefined
        ? {}
        : {
            historyCommit: async (coordinatorInput) => await deps.commitDesktopHistoryRestore!({
              ...coordinatorInput,
              reauthorize: () => reauthorize(
                input.request,
                "Desktop Filesystem Grant request rejected at history commit",
              ),
            }),
          }),
    });
    if (result.status === "ok" && result.result && typeof result.result === "object") {
      const inner = result.result as { ok?: boolean; result?: unknown };
      if (inner.ok === true && inner.result && typeof inner.result === "object") {
        const change = (inner.result as { changeEvent?: RelayFsChangeEvent }).changeEvent;
        if (change) deps.onFsChange?.(change);
      }
    }
    return result;
  };

  return {
    async dispatchDirect(input) {
      if (!isLocalFileRequest(input.request) || isLocalFileSearch(input.request)) {
        return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
      }
      if (!deps.relayId) {
        return {
          handled: true,
          result: { status: "error", error: "local-file dispatch requires relayId" },
        };
      }
      const result = input.applyPatchPreparation === undefined
        ? await dispatchOrdinary(input)
        : await dispatchApplyPatch({
            request: input.request,
            preparation: input.applyPatchPreparation,
          });
      return { handled: true, result };
    },
    async dispatchSandboxedSearch(input) {
      if (!isLocalFileSearch(input.request)) return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
      const result = await dispatchOrdinary({
        ...input,
        sandbox: input.sandbox ?? undefined,
        ripgrepRuntime: await input.getRipgrepRuntime(),
      });
      return { handled: true, result };
    },
  };
}
