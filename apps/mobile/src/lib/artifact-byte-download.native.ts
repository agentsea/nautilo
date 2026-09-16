import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";

import type { ArtifactByteDownload, ArtifactByteDownloadInput } from "./artifact-byte-download";

const ownedDirectories = new Map<string, Directory>();

export async function downloadArtifactBytes(
  input: ArtifactByteDownloadInput,
): Promise<ArtifactByteDownload> {
  if (!input.cacheName || input.cacheName === "." || input.cacheName === ".." || /[/\\]/u.test(input.cacheName) || input.cacheName.includes(String.fromCharCode(0))) {
    throw new Error("Invalid artifact cache filename.");
  }
  const operationDirectory = new Directory(Paths.cache, "nautilo-artifacts", randomUUID());
  operationDirectory.create({ intermediates: true });
  const destination = new File(operationDirectory, input.cacheName);
  try {
    await File.downloadFileAsync(input.url, destination, {
      headers: { Authorization: `Bearer ${input.token}` },
      signal: input.signal,
    });
    if (input.text) {
      const content = await destination.text();
      operationDirectory.delete();
      return { kind: "text", content };
    }
    ownedDirectories.set(destination.uri, operationDirectory);
    return { kind: "file", fileUri: destination.uri };
  } catch (error) {
    try {
      if (operationDirectory.exists) operationDirectory.delete();
    } catch {
      throw Object.assign(new Error("The artifact download failed and its temporary copy could not be removed."), {
        code: "ERR_ARTIFACT_TEMP_CLEANUP",
      });
    }
    throw error;
  }
}

/** Release only a binary lease created by this module; arbitrary file URIs have no deletion authority. */
export function releaseArtifactFileUri(fileUri: string): void {
  const directory = ownedDirectories.get(fileUri);
  if (!directory) return;
  try {
    if (directory.exists) directory.delete();
    ownedDirectories.delete(fileUri);
  } catch {
    // Keep ownership registered so a later lifecycle release can retry. The
    // existing viewer release seam is synchronous and has no residual-error UI.
  }
}
