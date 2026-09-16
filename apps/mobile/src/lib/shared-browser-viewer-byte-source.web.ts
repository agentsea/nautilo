import {
  BrowserArtifactByteSourceError,
  type AcquireBrowserArtifactBytesInput,
  type AcquiredBrowserArtifactBytes,
} from "./shared-browser-viewer-byte-source-contract";

export * from "./shared-browser-viewer-byte-source-contract";

function isByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Acquire one authorized artifact revision for an in-browser viewer.
 *
 * The API client remains the single owner of fetch, redirect rejection,
 * incremental cap enforcement, Content-Length validation, reader cancellation,
 * and final ArrayBuffer assembly. This adapter adds the Mobile host boundary:
 * exact metadata identity, an optional validated room scope, and an explicit
 * (non-defaulted) product policy cap. It never creates a Blob or object URL.
 */
export async function acquireBrowserArtifactViewerBytes(
  input: AcquireBrowserArtifactBytesInput,
): Promise<AcquiredBrowserArtifactBytes> {
  if (
    input.artifactId.length === 0 ||
    (input.roomId !== undefined && input.roomId.trim().length === 0)
  ) {
    throw new BrowserArtifactByteSourceError(
      "invalid_input",
      "Artifact identifiers and supplied room scopes must be nonempty.",
    );
  }
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new BrowserArtifactByteSourceError(
      "invalid_input",
      "The viewer byte limit must be a positive safe integer.",
    );
  }
  if (!isByteCount(input.artifact.size)) {
    throw new BrowserArtifactByteSourceError(
      "stale_metadata",
      "Artifact metadata has an invalid byte count.",
    );
  }
  if (input.artifact.id !== input.artifactId) {
    throw new BrowserArtifactByteSourceError(
      "stale_metadata",
      "Artifact metadata does not match the requested artifact.",
    );
  }
  if (input.artifact.size > input.maxBytes) {
    throw new BrowserArtifactByteSourceError("size", "Artifact is too large to preview.");
  }

  const bytes = await input.client.getWorkspaceArtifactBytesArrayBuffer(input.artifactId, {
    ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
    signal: input.signal,
    expectedBytes: input.artifact.size,
    maxBytes: input.maxBytes,
  });

  if (bytes.byteLength !== input.artifact.size || bytes.byteLength > input.maxBytes) {
    throw new BrowserArtifactByteSourceError(
      "stale_metadata",
      "Artifact bytes do not match the authorized metadata.",
    );
  }

  return {
    artifact: input.artifact,
    bytes,
    declaredBytes: input.artifact.size,
    observedBytes: bytes.byteLength,
  };
}
