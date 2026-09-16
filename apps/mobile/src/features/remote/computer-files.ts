import type {
  ListRemoteHostFilesRequest,
  ListRemoteHostFilesResponse,
  ReadRemoteHostFilePreviewRequest,
  ReadRemoteHostFilePreviewResponse,
  RemoteHostFileRootKind,
  SelectRemoteHostCurrentFolderRequest,
  SelectRemoteHostCurrentFolderResponse,
} from "@nautilo/api-client/browser";

import { prepareRemoteOrdinaryRequestProof } from "./controller-ordinary-proof";
import {
  runSameServerRemoteRequest,
  type RemoteServerTarget,
} from "./remote-api";
export { pairedFilesystemDisplayPath } from "./computer-files-presentation";

export type ComputerFilesFailure =
  | "offline"
  | "revoked"
  | "no_current_folder"
  | "root_stale"
  | "transport"
  | "service"
  | "inaccessible"
  | "unsupported"
  | "too_large"
  | "not_found"
  | "unpaired"
  | "session";

export type ComputerFilesPresentation = {
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryLabel?: "Try again" | "Check again";
};

const hostFilePaths = {
  list: "/api/remote/host-files/list",
  read: "/api/remote/host-files/read",
  select: "/api/remote/current-folder/select",
} as const;

/**
 * Produce the phone proof from the exact immutable request body. The server
 * verifies that same canonical body, so a caller cannot sign one host/root and
 * fetch another. This module deliberately never consults the active server.
 */
async function signedHostFileRequest<T>(
  target: RemoteServerTarget,
  path: (typeof hostFilePaths)[keyof typeof hostFilePaths],
  body: Readonly<Record<string, unknown>>,
  operation: (proof: NonNullable<Awaited<ReturnType<typeof prepareRemoteOrdinaryRequestProof>>>) => Promise<T>,
): Promise<T> {
  const proof = await prepareRemoteOrdinaryRequestProof({
    serverId: target.id,
    method: "POST",
    path,
    body,
  });
  if (!proof) throw new ComputerFilesError("unpaired");
  return operation(proof);
}

export async function listComputerFiles(
  target: RemoteServerTarget,
  input: ListRemoteHostFilesRequest,
): Promise<ListRemoteHostFilesResponse> {
  const body = Object.freeze({ ...input });
  return signedHostFileRequest(target, hostFilePaths.list, body, (mobileOriginProof) =>
    runSameServerRemoteRequest(target, (client) =>
      client.listRemoteHostFiles(body, { mobileOriginProof }),
    ),
  );
}

export async function readComputerFilePreview(
  target: RemoteServerTarget,
  input: ReadRemoteHostFilePreviewRequest,
): Promise<ReadRemoteHostFilePreviewResponse> {
  const body = Object.freeze({ ...input });
  return signedHostFileRequest(target, hostFilePaths.read, body, (mobileOriginProof) =>
    runSameServerRemoteRequest(target, (client) =>
      client.readRemoteHostFilePreview(body, { mobileOriginProof }),
    ),
  );
}

export async function selectComputerCurrentFolder(
  target: RemoteServerTarget,
  input: SelectRemoteHostCurrentFolderRequest,
): Promise<SelectRemoteHostCurrentFolderResponse> {
  const body = Object.freeze({ ...input });
  return signedHostFileRequest(target, hostFilePaths.select, body, (mobileOriginProof) =>
    runSameServerRemoteRequest(target, (client) =>
      client.selectRemoteHostCurrentFolder(body, { mobileOriginProof }),
    ),
  );
}

export class ComputerFilesError extends Error {
  constructor(readonly code: ComputerFilesFailure) {
    super(code);
    this.name = "ComputerFilesError";
  }
}

/** Map the bounded server vocabulary to action-oriented native copy. */
export function computerFilesPresentation(error: unknown): ComputerFilesPresentation {
  const code = errorCode(error);
  switch (code) {
    case "unpaired":
      return {
        title: "Pair this phone first",
        detail: "Pair this phone with the computer in Computers before browsing its files.",
        retryable: false,
      };
    case "session":
      return {
        title: "Sign in again",
        detail: "Your session ended. Sign in again, then reopen this computer.",
        retryable: false,
      };
    case "offline":
      return {
        title: "Computer is offline",
        detail: "Keep its Nautilo desktop connected, then try again.",
        retryable: true,
        retryLabel: "Try again",
      };
    case "revoked":
      return {
        title: "Access was revoked",
        detail: "This phone is no longer paired with that computer. Pair it again to restore access.",
        retryable: false,
      };
    case "no_current_folder":
      return {
        title: "No Current Folder selected",
        detail: "Choose a folder on this computer from your phone.",
        retryable: false,
      };
    case "root_stale":
      return {
        title: "Folder is no longer available",
        detail: "Choose another folder on this computer.",
        retryable: false,
      };
    case "inaccessible":
      return {
        title: "Folder is not accessible",
        detail: "Restore Nautilo Desktop’s access to this folder, then check again.",
        retryable: true,
        retryLabel: "Check again",
      };
    case "unsupported":
      return {
        title: "Preview is not supported",
        detail: "This file type cannot be previewed on your phone.",
        retryable: false,
      };
    case "too_large":
      return {
        title: "Too large to preview",
        detail: "This item is larger than the safe mobile preview limit.",
        retryable: false,
      };
    case "not_found":
      return {
        title: "Item no longer exists",
        detail: "Refresh this folder and try again.",
        retryable: true,
        retryLabel: "Try again",
      };
    case "transport":
      return {
        title: "Could not reach this computer",
        detail: "Keep its Nautilo desktop connected, then try again.",
        retryable: true,
        retryLabel: "Try again",
      };
    case "service":
    default:
      return {
        title: "Nautilo is temporarily unavailable",
        detail: "The server could not complete this request. Try again shortly.",
        retryable: true,
        retryLabel: "Try again",
      };
  }
}

function errorCode(error: unknown): ComputerFilesFailure {
  if (error instanceof ComputerFilesError) return error.code;
  if (isApiError(error)) {
    if (error.status === 401) return "session";
    const message = error.message.trim().toLowerCase();
    if (isHostFileFailure(message)) return message;
    if (error.status === 403) return "revoked";
    if (error.status >= 500) return "service";
  }
  return "service";
}

function isApiError(error: unknown): error is { readonly status: number; readonly message: string } {
  return typeof error === "object" && error !== null &&
    typeof (error as { status?: unknown }).status === "number" &&
    typeof (error as { message?: unknown }).message === "string";
}

function isHostFileFailure(value: string): value is Exclude<ComputerFilesFailure, "unpaired" | "session"> {
  return [
    "offline",
    "revoked",
    "no_current_folder",
    "root_stale",
    "transport",
    "inaccessible",
    "unsupported",
    "too_large",
    "not_found",
  ].includes(value);
}

export function rootTitle(rootKind: RemoteHostFileRootKind): string {
  if (rootKind === "workspace") return "Workspace";
  if (rootKind === "paired_filesystem") return "This Mac";
  return "Current Folder";
}


export function parentRelativePath(relativePath: string): string | null {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  parts.pop();
  return parts.join("/");
}
