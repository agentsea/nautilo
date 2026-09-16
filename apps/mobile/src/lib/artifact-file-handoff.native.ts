import { isAvailableAsync, shareAsync } from "expo-sharing";

import type { ArtifactFileHandoffOptions } from "./artifact-file-handoff";

export function isArtifactFileHandoffAvailable(fileUri: string): Promise<boolean> {
  return fileUri.startsWith("file://") ? isAvailableAsync() : Promise.resolve(false);
}

export function openArtifactFile(
  fileUri: string,
  options: ArtifactFileHandoffOptions,
): Promise<void> {
  return shareAsync(fileUri, {
    dialogTitle: options.title,
    mimeType: options.mimeType,
  });
}
