import {
  BrowserArtifactByteSourceError,
  type AcquireBrowserArtifactBytesInput,
  type AcquiredBrowserArtifactBytes,
} from "./shared-browser-viewer-byte-source-contract";

export * from "./shared-browser-viewer-byte-source-contract";

/** Native builds deliberately retain their existing file-backed artifact transport. */
export function acquireBrowserArtifactViewerBytes(
  _input: AcquireBrowserArtifactBytesInput,
): Promise<AcquiredBrowserArtifactBytes> {
  return Promise.reject(
    new BrowserArtifactByteSourceError(
      "unavailable",
      "Browser artifact viewer bytes are unavailable on this platform.",
    ),
  );
}
