/** Main/Workbench media transport. Local paths, bytes and credentials never cross this boundary. */
export type WorkspaceMediaArtifact = Readonly<{
  id: string; artifactId: string; path: string; mimeType: string; size: number; revision: number;
}>;
export type WorkspaceMediaImportInput = Readonly<{
  requestId: string; roomId: string; mediaKind?: "video" | "audio" | "image";
}>;
export type WorkspaceMediaImportData = Readonly<{
  label: string; artifact: Omit<WorkspaceMediaArtifact, "revision">; mediaKind: "video" | "audio" | "image";
  durationSec?: number; frameRate?: Readonly<{ numerator: number; denominator: number }>;
}>;
export type WorkspaceMediaBatchImportResult =
  | Readonly<{ ok: true; data: WorkspaceMediaImportData }>
  | Readonly<{ ok: false; label: string; error: Readonly<{ code: string }> }>;
export type WorkspaceMediaBatchImportData = Readonly<{
  results: readonly WorkspaceMediaBatchImportResult[];
}>;
export type WorkspaceMediaPreviewInput = Readonly<{
  requestId: string; roomId: string; artifact: WorkspaceMediaArtifact;
}>;
export type WorkspaceMediaPreviewData = Readonly<{
  url: string; revokeToken: string; mimeType: string; sizeBytes: number;
  /** Plaintext digest of the exact staged snapshot; absent on older Desktop hosts. */
  sha256?: string;
  mediaKind: "video" | "audio" | "image"; durationSec?: number;
  frameRate?: Readonly<{ numerator: number; denominator: number }>;
  waveform?: { peaks: number[]; samplesPerSecond: number };
}>;
