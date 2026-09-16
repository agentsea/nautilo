import { File, FileMode } from "expo-file-system";
import { hasLocalVideoContainer } from "@/features/artifacts/artifact-video-format";

export function isLocalVideoFile(fileUri: string): boolean {
  if (!fileUri.startsWith("file://")) return false;
  const handle = new File(fileUri).open(FileMode.ReadOnly);
  // The ISO BMFF signature needs the 8-byte box header plus major brand;
  // EBML needs four bytes. This is a header read, not a media-size ceiling.
  try { return hasLocalVideoContainer(handle.readBytes(12)); }
  finally { handle.close(); }
}
