import type { FileExportResult, NautiloFileExport, SaveFileInput } from "./NautiloFileExportModule";

const unavailable: NautiloFileExport = {
  prepareExportCacheAsync(): Promise<void> {
    return Promise.reject(new Error("Saving files is unavailable in this runtime."));
  },
  saveFileAsync(_input: SaveFileInput): Promise<FileExportResult> {
    return Promise.reject(new Error("Saving files is unavailable in this runtime."));
  },
  saveMediaAsync(_input: SaveFileInput): Promise<FileExportResult> {
    return Promise.reject(new Error("Saving media is unavailable in this runtime."));
  },
  cancelPendingExportAsync(_requestId: string): Promise<boolean> {
    return Promise.resolve(false);
  },
};

export function isFileExportAvailable(): boolean {
  return false;
}

export function isMediaExportAvailable(): boolean {
  return false;
}

export function nativeFileExportUnavailableError(): Error {
  return new Error("Saving files requires an updated Nautilo native build.");
}

export default unavailable;
