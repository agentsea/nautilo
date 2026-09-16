import { Alert, Platform } from "react-native";

import { canShareOriginalFile } from "@/lib/original-file-share";
import { isMediaLibraryCandidate, mediaLibraryLabel } from "./artifact-media-export";
import type { ArtifactExportMenuInput } from "./artifact-export-menu";

/** Present native destinations without leaking platform policy into shared routes. */
export function showArtifactExportMenu(input: ArtifactExportMenuInput): void {
  Alert.alert(
    input.filename,
    Platform.OS === "android"
      ? "To share a copy, save it and share from Android Files."
      : "Save or share an original copy.",
    [
      { text: "Save file…", onPress: () => input.onExport("file") },
      ...(canShareOriginalFile()
        ? [{ text: "Share…", onPress: () => input.onExport("share" as const) }]
        : []),
      ...(isMediaLibraryCandidate(input.mimeType)
        ? [{ text: mediaLibraryLabel(Platform.OS), onPress: () => input.onExport("media" as const) }]
        : []),
      { text: "Cancel", style: "cancel" as const },
    ],
  );
}
