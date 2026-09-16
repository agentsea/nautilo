export type ArtifactByteDownload =
  /** Text is decoded and its operation-owned native file is removed before return. */
  | Readonly<{ kind: "text"; content: string }>
  /** Binary bytes remain leased until releaseArtifactFileUri receives this exact URI. */
  | Readonly<{ kind: "file"; fileUri: string }>;

export type ArtifactByteDownloadInput = Readonly<{
  url: string;
  token: string;
  cacheName: string;
  text: boolean;
  signal?: AbortSignal;
}>;

export function downloadArtifactBytes(_input: ArtifactByteDownloadInput): Promise<ArtifactByteDownload> {
  return Promise.reject(new Error("Artifact byte download is unavailable in this runtime."));
}

export function releaseArtifactFileUri(_fileUri: string): void {}
