import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { ConflictError } from "@nautilo/api-client/browser";
import { apiClient } from "../lib/api";
import { desktopAPI } from "../lib/desktop";
import type { AnchoredTextPatch } from "@nautilo/types";
import { MAX_TEXT_PREVIEW_BYTES } from "../lib/file-preview";

export type LoadEditableTextResult =
  | {
      kind: "ready";
      content: string;
      baseSha256: string;
      baseRevision: number | null;
      localIdentity?: {
        kind: "local_file";
        relayId: string;
        canonicalPath: string;
      };
    }
  | { kind: "too_large" }
  | { kind: "error"; message: string };

export type SaveEditableTextResult =
  | { kind: "saved"; newSha256: string; revision?: number }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "error"; message: string };

export type SaveEditableTextOptions = {
  clientMutationId?: string;
  anchoredPatch?: AnchoredTextPatch;
};

export async function sha256HexForText(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function loadEditableText(
  file: OpenFileTarget,
): Promise<LoadEditableTextResult> {
  try {
    if (file.kind === "artifact") {
      const roomOpts =
        file.roomId !== undefined ? { roomId: file.roomId } : undefined;
      const dto =
        roomOpts !== undefined
          ? await apiClient.getWorkspaceArtifact(file.id, roomOpts)
          : await apiClient.getWorkspaceArtifact(file.id);
      const blob =
        roomOpts !== undefined
          ? await apiClient.getWorkspaceArtifactBytes(file.id, roomOpts)
          : await apiClient.getWorkspaceArtifactBytes(file.id);
      if (blob.size > MAX_TEXT_PREVIEW_BYTES) return { kind: "too_large" };
      const content = await blob.text();
      return {
        kind: "ready",
        content,
        baseSha256: await sha256HexForText(content),
        baseRevision: dto?.revision ?? null,
      };
    }

    if (!desktopAPI) {
      return { kind: "error", message: "Desktop file bridge unavailable." };
    }

    const stat = await desktopAPI.fs.stat(file.path);
    if (!stat.exists) {
      return { kind: "error", message: "File no longer exists." };
    }
    if (stat.size > MAX_TEXT_PREVIEW_BYTES) return { kind: "too_large" };

    const content = await desktopAPI.fs.readFile(file.path);
    return {
      kind: "ready",
      content,
      baseSha256: await sha256HexForText(content),
      baseRevision: null,
      ...(stat.documentIdentity ? { localIdentity: stat.documentIdentity } : {}),
    };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Could not load file.",
    };
  }
}

export async function saveEditableText(
  file: OpenFileTarget,
  content: string,
  base: { sha256: string | null; revision: number | null },
  checkpoint: boolean,
  options: SaveEditableTextOptions = {},
): Promise<SaveEditableTextResult> {
  try {
    if (file.kind === "artifact") {
      const result = await apiClient.saveWorkspaceArtifactContent(
        file.id,
        content,
        {
          baseRevision: base.revision,
          baseSha256: base.sha256,
          checkpoint,
          mimeType: file.mimeType,
          ...(options.clientMutationId ? { clientMutationId: options.clientMutationId } : {}),
          ...(file.roomId !== undefined ? { roomId: file.roomId } : {}),
        },
      );
      return {
        kind: "saved",
        newSha256: result.sha256,
        revision: result.revision,
      };
    }

    if (!desktopAPI) {
      return { kind: "error", message: "Desktop file bridge unavailable." };
    }

    const clientMutationId = options.clientMutationId ?? crypto.randomUUID();
    const result = await desktopAPI.fs.writeFile(file.path, content, {
      baseSha256: base.sha256,
      checkpoint,
      requestId: clientMutationId,
      clientMutationId,
      ...(options.anchoredPatch ? { anchoredPatch: options.anchoredPatch } : {}),
    });

    if (result.ok) {
      return { kind: "saved", newSha256: result.sha256 };
    }

    if (result.code === "conflict") {
      return {
        kind: "conflict",
        currentSha256: result.currentSha256 ?? null,
      };
    }

    if (result.code === "forbidden") {
      return { kind: "error", message: "You do not have permission to save this file." };
    }

    if (result.code === "too_large") {
      return { kind: "error", message: "File is too large to save." };
    }

    return {
      kind: "error",
      message: result.message ?? "Could not save file.",
    };
  } catch (err) {
    if (err instanceof ConflictError) {
      return { kind: "conflict", currentSha256: err.currentSha256 };
    }
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Could not save file.",
    };
  }
}
