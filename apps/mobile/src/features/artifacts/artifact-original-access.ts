import { ApiError, NautiloApiClient } from "@nautilo/api-client/browser";
import { ensureValidToken } from "@/lib/auth";
import { emitAuthDead } from "@/lib/auth-events";
import { downloadOriginalFile } from "@/lib/original-file-download";
import { loadTokenSnapshot } from "@/lib/server-store";
import {
  acquireArtifactOriginal,
  safeArtifactBasename,
  type ArtifactOriginalExportResult,
  type ArtifactOriginalExportScope,
  type ArtifactOriginalMetadataResult,
} from "./artifact-original-export";

/**
 * Acquire one current, read-authorized Artifact original for a native consumer.
 * The caller owns cache preparation and the resulting file cleanup lifetime.
 */
export async function acquireAuthorizedArtifactOriginal(input: Readonly<{
  scope: ArtifactOriginalExportScope;
  baseUrl: string;
  isCurrent: () => boolean;
  controller: AbortController;
}>): Promise<ArtifactOriginalExportResult> {
  const { scope, baseUrl, isCurrent, controller } = input;
  const { signal } = controller;
  const authorize = async (forceRefresh = false) => {
    if (signal.aborted) throw new Error("Save cancelled");
    if (!isCurrent()) throw new Error("Source changed");
    const token = await ensureValidToken(scope.serverId, baseUrl, { forceRefresh });
    const snapshot = await loadTokenSnapshot(scope.serverId);
    if (!isCurrent() || signal.aborted) throw new Error("Source changed");
    if (snapshot.tokens && (snapshot.tokens.accessToken !== token || snapshot.tokens.userId !== scope.accountId)) {
      controller.abort();
      throw new Error("Source changed");
    }
    if (!token || !snapshot.tokens) throw new ApiError(401, "Authentication required");
    const client = new NautiloApiClient(baseUrl);
    client.setToken(token);
    return { client, token };
  };
  const withAuthorization = async <T,>(run: (auth: Awaited<ReturnType<typeof authorize>>) => Promise<T>): Promise<T> => {
    try { return await run(await authorize()); }
    catch (error) {
      if (httpStatus(error) !== 401 || !isCurrent() || signal.aborted) throw error;
      return run(await authorize(true));
    }
  };
  const failure = async (error: unknown): Promise<Exclude<ArtifactOriginalMetadataResult, { kind: "metadata" }>> => {
    if (errorCode(error) === "ERR_EXPORT_TEMP_CLEANUP") return { kind: "cleanup_failed" };
    if (signal.aborted || !isCurrent()) return { kind: "cancelled" };
    const code = httpStatus(error);
    if (code === 401) {
      const snapshot = await loadTokenSnapshot(scope.serverId);
      if (!isCurrent() || signal.aborted || (snapshot.tokens && snapshot.tokens.userId !== scope.accountId)) return { kind: "cancelled" };
      emitAuthDead(scope.serverId);
      return { kind: "auth_dead" };
    }
    if (code === 403) return { kind: "forbidden" };
    if (code === 404) return { kind: "missing" };
    return { kind: code === null ? "network" : "server" };
  };

  return acquireArtifactOriginal(scope, {
    getCurrentScope: () => isCurrent() ? scope : null,
    loadMetadata: async ({ sourceId }) => {
      try {
        const metadata = await withAuthorization(({ client }) => client.getWorkspaceArtifact(sourceId));
        return metadata ? { kind: "metadata", metadata } : { kind: "missing" };
      } catch (error) { return failure(error); }
    },
    acquireFile: async ({ sourceId, metadata }) => {
      try {
        const file = await withAuthorization(({ client, token }) => downloadOriginalFile({
          url: client.getWorkspaceArtifactBytesUrl(sourceId), token,
          filename: safeArtifactBasename(metadata.path), signal,
        }));
        if (file.size !== metadata.size) {
          try { file.cleanup(); }
          catch { return { kind: "cleanup_failed" }; }
          return { kind: "server" };
        }
        return { kind: "file", fileUri: file.fileUri, cleanup: file.cleanup };
      } catch (error) { return failure(error); }
    },
  }, signal);
}

function httpStatus(error: unknown): number | null {
  if (error instanceof ApiError) return error.status;
  const match = (error instanceof Error ? error.message : "").match(/(?:http|status)[:\s]*(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : null;
}
