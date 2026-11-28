import { WorkspaceArtifactLengthMismatchError } from "@nautilo/api-client/browser";
import { apiClient } from "../lib/api";
import type { ReaderFile } from "../components/work-surface/reader-surface";
import type { ViewerLoadContext } from "./types";

type ArtifactFile = Extract<ReaderFile, { kind: "artifact" }>;

async function readViewerBytes(file: ArtifactFile, maxBytes: number, signal?: AbortSignal) {
  const scope = {
    ...(file.roomId === undefined ? {} : { roomId: file.roomId }),
    ...(signal === undefined ? {} : { signal }),
  };
  try {
    return await apiClient.getWorkspaceArtifactBytesArrayBuffer(file.id, {
      ...scope, maxBytes,
      ...(file.sizeBytes === undefined ? {} : { expectedBytes: file.sizeBytes }),
    });
  } catch (error) {
    // The opener may still hold the length from before an edit. Acquire
    // fresh metadata before retrying, preserving the same scope and ceiling.
    if (!(error instanceof WorkspaceArtifactLengthMismatchError) || signal?.aborted) throw error;
    const latest = await apiClient.getWorkspaceArtifact(file.id, scope);
    if (!latest || !Number.isSafeInteger(latest.size) || latest.size < 0 || latest.size === file.sizeBytes) throw error;
    return apiClient.getWorkspaceArtifactBytesArrayBuffer(file.id, {
      ...scope, maxBytes, expectedBytes: latest.size,
    });
  }
}

export async function loadArtifactViewerArrayBuffer(
  file: ArtifactFile,
  context: ViewerLoadContext,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const bytes = context.artifactBytes === undefined
    ? await readViewerBytes(file, maxBytes, context.signal)
    : await context.artifactBytes({
      artifactId: file.id,
      maxBytes,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.deadlineAt === undefined
        ? {}
        : { deadlineAt: context.deadlineAt }),
    });
  if (bytes.byteLength > maxBytes) {
    throw new RangeError("Artifact viewer byte limit exceeded");
  }
  return bytes;
}

export async function loadArtifactViewerBlob(
  file: ArtifactFile,
  context: ViewerLoadContext,
  maxBytes: number,
): Promise<Blob> {
  return new Blob(
    [await loadArtifactViewerArrayBuffer(file, context, maxBytes)],
    { type: file.mimeType },
  );
}
