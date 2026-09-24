import { apiClient } from "../lib/api";
import type { ReaderFile } from "../components/work-surface/reader-surface";
import type { ViewerLoadContext } from "./types";

type ArtifactFile = Extract<ReaderFile, { kind: "artifact" }>;

export async function loadArtifactViewerArrayBuffer(
  file: ArtifactFile,
  context: ViewerLoadContext,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const bytes = context.artifactBytes === undefined
    ? await apiClient.getWorkspaceArtifactBytesArrayBuffer(file.id, {
      maxBytes,
      ...(file.sizeBytes === undefined ? {} : { expectedBytes: file.sizeBytes }),
      ...(file.roomId === undefined ? {} : { roomId: file.roomId }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
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
