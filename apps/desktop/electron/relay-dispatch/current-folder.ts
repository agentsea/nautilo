import type { RelayDispatchRequest } from "@nautilo/relay";

import type {
  CurrentFolderAdoptionCommitResult,
  CurrentFolderAdoptionPrepareResult,
  CurrentFolderAdoptionSourceRootKind,
} from "../current-folder-adoption";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type DesktopDispatchDecision,
} from "./router.ts";

export interface CurrentFolderAdoptionPrepareRequest {
  readonly sourceRootKind: CurrentFolderAdoptionSourceRootKind;
  readonly relativePath: string;
}

export interface CurrentFolderAdoptionCommitRequest {
  /** Opaque Electron-local preparation reference; never a filesystem path. */
  readonly preparationId: string;
}

export type CurrentFolderSelectionResult =
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly error: string };

export type CurrentFolderSelectPort = (
  request: {
    readonly sourceRootKind: "workspace" | "current_folder";
    readonly relativePath: string;
  },
) => Promise<CurrentFolderSelectionResult>;

export interface PairedFilesystemDirectoryPort {
  readonly list: (request: {
    readonly relativePath: string;
    readonly afterName?: string;
    readonly limit: number;
    readonly includeHidden: boolean;
    readonly query: string;
  }) => Promise<
    | {
        readonly ok: true;
        readonly entries: readonly Record<string, unknown>[];
        readonly nextCursor: string | null;
      }
    | { readonly ok: false; readonly code: string }
  >;
  readonly select: (request: {
    readonly relativePath: string;
  }) => Promise<CurrentFolderSelectionResult>;
}

export interface CurrentFolderAdoptionPort {
  readonly prepare: (
    request: CurrentFolderAdoptionPrepareRequest,
  ) => Promise<CurrentFolderAdoptionPrepareResult>;
  readonly commit: (
    request: CurrentFolderAdoptionCommitRequest,
  ) => Promise<CurrentFolderAdoptionCommitResult>;
}

/**
 * Fixed Electron-owned Current Folder lanes. Every non-match is inert: it
 * does not touch a port, construct state, or reinterpret another tool.
 */
export async function dispatchCurrentFolderFamily(input: {
  readonly request: RelayDispatchRequest;
  readonly adoption?: CurrentFolderAdoptionPort | undefined;
  readonly pairedDirectory?: PairedFilesystemDirectoryPort | undefined;
  readonly selectCurrentFolder?: CurrentFolderSelectPort | undefined;
}): Promise<DesktopDispatchDecision> {
  const { request: req } = input;

  // D497 — relay arguments carry only a source-root-relative target or an
  // opaque preparation reference. Electron owns every host path, policy
  // decision, preparation lifetime, and local transition receipt.
  if (req.toolName === "nautilo_current_folder_prepare") {
    if (req.executionClass !== "desktop") {
      return {
        handled: true,
        result: {
          status: "error",
          errorCode: "CURRENT_FOLDER_ADOPTION_PREPARE_DENIED",
          error: "Current Folder adoption preparation requires a desktop request.",
        },
      };
    }
    const sourceRootKind = req.args["sourceRootKind"];
    const relativePath = req.args["relativePath"];
    if (
      (sourceRootKind !== "workspace" && sourceRootKind !== "current_folder") ||
      typeof relativePath !== "string" ||
      input.adoption === undefined
    ) {
      return {
        handled: true,
        result: {
          status: "error",
          errorCode: "CURRENT_FOLDER_ADOPTION_PREPARE_INVALID",
          error: "Current Folder adoption preparation is invalid.",
        },
      };
    }
    return {
      handled: true,
      result: {
        status: "ok",
        result: await input.adoption.prepare({ sourceRootKind, relativePath }),
      },
    };
  }

  if (req.toolName === "nautilo_current_folder_commit") {
    if (req.executionClass !== "desktop" || !req.approvalObtained) {
      return {
        handled: true,
        result: {
          status: "error",
          errorCode: "CURRENT_FOLDER_ADOPTION_COMMIT_DENIED",
          error: "Current Folder adoption requires an explicit approved desktop request.",
        },
      };
    }
    const preparationId = req.args["preparationId"];
    if (typeof preparationId !== "string" || input.adoption === undefined) {
      return {
        handled: true,
        result: {
          status: "error",
          errorCode: "CURRENT_FOLDER_ADOPTION_COMMIT_INVALID",
          error: "Current Folder adoption commit is invalid.",
        },
      };
    }
    return {
      handled: true,
      result: {
        status: "ok",
        result: await input.adoption.commit({ preparationId }),
      },
    };
  }

  // D319 — a phone can browse only opaque, directory-only local locations.
  // This command is deliberately before every generic filesystem/sandbox
  // path: it has no host path arguments and can never read or preview files.
  if (req.toolName === "nautilo_paired_filesystem_directory") {
    const relativePath = req.args["relativePath"];
    const limit = req.args["limit"];
    const includeHidden = req.args["includeHidden"];
    const query = req.args["query"];
    const afterName = req.args["afterName"];
    if (
      req.executionClass !== "desktop" ||
      !req.approvalObtained ||
      req.args["rootKind"] !== "paired_filesystem" ||
      req.args["operation"] !== "list_directories" ||
      typeof relativePath !== "string" ||
      relativePath.length > 1024 ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      typeof includeHidden !== "boolean" ||
      typeof query !== "string" ||
      query.length > 200 ||
      (afterName !== undefined &&
        (typeof afterName !== "string" ||
          afterName.length === 0 ||
          afterName.length > 1024 ||
          afterName.includes("\0"))) ||
      input.pairedDirectory === undefined
    ) {
      return {
        handled: true,
        result: {
          status: "error",
          errorCode: "PAIRED_FILESYSTEM_DIRECTORY_INVALID",
          error: "Paired filesystem directory request is invalid.",
        },
      };
    }
    const listed = await input.pairedDirectory.list({
      relativePath,
      limit,
      includeHidden,
      query,
      ...(afterName === undefined ? {} : { afterName }),
    });
    return listed.ok
      ? {
          handled: true,
          result: {
            status: "ok",
            result: { entries: listed.entries, nextCursor: listed.nextCursor },
          },
        }
      : {
          handled: true,
          result: {
            status: "error",
            errorCode: "PAIRED_FILESYSTEM_DIRECTORY_REJECTED",
            error: "Paired filesystem directory is unavailable.",
          },
        };
  }

  // D458 — this is an app-state mutation, not desktop automation and not a
  // filesystem write. It is handled before sandbox or fixed-tool selection and
  // delegates to Electron main's canonical validation + commit seam.
  if (req.toolName === "nautilo_current_folder_select") {
    if (req.executionClass !== "desktop" || !req.approvalObtained) {
      return {
        handled: true,
        result: {
          status: "error",
          errorCode: "CURRENT_FOLDER_SELECTION_DENIED",
          error: "Current Folder selection requires an explicit approved desktop request.",
        },
      };
    }
    const sourceRootKind = req.args["sourceRootKind"];
    const relativePath = req.args["relativePath"];
    if (
      (sourceRootKind !== "workspace" &&
        sourceRootKind !== "current_folder" &&
        sourceRootKind !== "paired_filesystem") ||
      typeof relativePath !== "string" ||
      (sourceRootKind !== "paired_filesystem" &&
        input.selectCurrentFolder === undefined)
    ) {
      return {
        handled: true,
        result: {
          status: "error",
          errorCode: "CURRENT_FOLDER_SELECTION_INVALID",
          error: "Current Folder selection request is invalid.",
        },
      };
    }
    if (sourceRootKind === "paired_filesystem") {
      if (input.pairedDirectory === undefined) {
        return {
          handled: true,
          result: {
            status: "error",
            errorCode: "CURRENT_FOLDER_SELECTION_INVALID",
            error: "Paired filesystem selection is unavailable.",
          },
        };
      }
      const selected = await input.pairedDirectory.select({ relativePath });
      return selected.ok
        ? {
            handled: true,
            result: { status: "ok", result: { ok: true, label: selected.label } },
          }
        : {
            handled: true,
            result: {
              status: "error",
              errorCode: "CURRENT_FOLDER_SELECTION_REJECTED",
              error: selected.error,
            },
          };
    }
    const selected = await input.selectCurrentFolder!({
      sourceRootKind,
      relativePath,
    });
    return selected.ok
      ? {
          handled: true,
          result: { status: "ok", result: { ok: true, label: selected.label } },
        }
      : {
          handled: true,
          result: {
            status: "error",
            errorCode: "CURRENT_FOLDER_SELECTION_REJECTED",
            error: selected.error,
          },
        };
  }

  return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
}
