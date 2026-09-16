import type {
  AcquireBrowserArtifactInput,
  BrowserArtifactAcquisition,
} from "./shared-browser-viewer-artifact-coordinator-contract";

export * from "./shared-browser-viewer-artifact-coordinator-contract";

/** Native builds retain their existing file-backed artifact transport. */
export function acquireBrowserArtifact(
  _input: AcquireBrowserArtifactInput,
): Promise<BrowserArtifactAcquisition> {
  return Promise.resolve({ kind: "unavailable", reason: "platform" });
}
