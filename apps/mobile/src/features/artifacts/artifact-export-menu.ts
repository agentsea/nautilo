export type ArtifactExportDestination = "file" | "media" | "share";

export type ArtifactExportMenuInput = Readonly<{
  filename: string;
  mimeType: string;
  onExport: (destination: ArtifactExportDestination) => void;
}>;

/** Non-native fallback exposes only the universally supported original-file path. */
export function showArtifactExportMenu(input: ArtifactExportMenuInput): void {
  input.onExport("file");
}
