export type ArtifactFileHandoffOptions = Readonly<{
  title: string;
  mimeType: string;
}>;

export function isArtifactFileHandoffAvailable(_fileUri: string): Promise<boolean> {
  return Promise.resolve(false);
}

export function openArtifactFile(
  _fileUri: string,
  _options: ArtifactFileHandoffOptions,
): Promise<never> {
  return Promise.reject(new Error("Artifact file handoff is unavailable in this runtime."));
}
