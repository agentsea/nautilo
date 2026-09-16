/** Direct share is iOS-only until Android has a reviewed source-lifetime contract. */
export function canShareOriginalFile(): boolean { return false; }
export function shareOriginalFile(_fileUri: string, _mimeType: string): Promise<void> {
  return Promise.reject(new Error("Save the file first, then share it from your device's Files app."));
}
