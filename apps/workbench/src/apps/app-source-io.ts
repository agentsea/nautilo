import { ConflictError } from "@nautilo/api-client/browser";
import type { AppSourceTarget } from "../adapters/open-app-source-ref";
import { apiClient } from "../lib/api";

export type LoadAppSourceResult =
  | { kind: "ready"; content: string; baseSha256: string; baseRevision: null }
  | { kind: "error"; message: string };

export type SaveAppSourceResult =
  | { kind: "saved"; newSha256: string; sourceHash: string }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "error"; message: string };

export async function loadAppSourceFile(target: AppSourceTarget): Promise<LoadAppSourceResult> {
  try {
    const file = await apiClient.getMiniAppSourceFile(target.appId, target.path);
    return {
      kind: "ready",
      content: file.content,
      baseSha256: file.sha256,
      baseRevision: null,
    };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Could not load app source file.",
    };
  }
}

export async function saveAppSourceFile(
  target: AppSourceTarget,
  content: string,
  baseSha256: string,
): Promise<SaveAppSourceResult> {
  try {
    const result = await apiClient.saveMiniAppSourceFile(target.appId, target.path, {
      content,
      baseSha256,
    });
    return {
      kind: "saved",
      newSha256: result.sha256,
      sourceHash: result.sourceHash,
    };
  } catch (err) {
    if (err instanceof ConflictError) {
      return { kind: "conflict", currentSha256: err.currentSha256 };
    }
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Could not save app source file.",
    };
  }
}
