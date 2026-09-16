import { nativeExportMimeType } from "./artifact-original-export";

/** Affordance only: the native library must still accept the actual original. */
export function isMediaLibraryCandidate(mimeType: string): boolean {
  const type = nativeExportMimeType(mimeType);
  return type.startsWith("image/") || type.startsWith("video/");
}

export function mediaLibraryLabel(platform: string): string {
  return platform === "ios" ? "Save to Photos" : "Save to Gallery";
}
