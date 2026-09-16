import { Platform } from "react-native";
import { isAvailableAsync, shareAsync } from "expo-sharing";

export function canShareOriginalFile(): boolean { return Platform.OS === "ios"; }

/** iOS completion is the service/dismissal boundary, not proof of delivery. */
export async function shareOriginalFile(fileUri: string, mimeType: string): Promise<void> {
  if (!canShareOriginalFile() || !fileUri.startsWith("file://") || !(await isAvailableAsync())) {
    throw new Error("Native sharing is unavailable. Save the file instead.");
  }
  // Never use this cleanup boundary on Android: its chooser callback may
  // precede the recipient's first read of the exported URI.
  await shareAsync(fileUri, { mimeType, dialogTitle: "Share original file" });
}
