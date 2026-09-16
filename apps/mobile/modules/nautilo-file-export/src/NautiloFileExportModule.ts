import { NativeModule, requireOptionalNativeModule } from "expo";

export type SaveFileInput = Readonly<{
  requestId: string;
  fileUri: string;
  filename: string;
  mimeType: string;
}>;

export type FileExportResult = Readonly<{ status: "saved" | "cancelled" }>;

export interface NautiloFileExport {
  prepareExportCacheAsync(): Promise<void>;
  saveFileAsync(input: SaveFileInput): Promise<FileExportResult>;
  saveMediaAsync(input: SaveFileInput): Promise<FileExportResult>;
  cancelPendingExportAsync(requestId: string): Promise<boolean>;
}

declare class NativeNautiloFileExportModule extends NativeModule<Record<never, never>> implements NautiloFileExport {
  prepareExportCacheAsync(): Promise<void>;
  saveFileAsync(input: SaveFileInput): Promise<FileExportResult>;
  saveMediaAsync(input: SaveFileInput): Promise<FileExportResult>;
  cancelPendingExportAsync(requestId: string): Promise<boolean>;
}

const nativeModule = requireOptionalNativeModule<NativeNautiloFileExportModule>("NautiloFileExport");

export function isFileExportAvailable(): boolean {
  return nativeModule != null && typeof nativeModule.prepareExportCacheAsync === "function";
}

export function isMediaExportAvailable(): boolean {
  return isFileExportAvailable() && typeof nativeModule?.saveMediaAsync === "function";
}

export function nativeFileExportUnavailableError(): Error {
  return new Error("Saving files requires an updated Nautilo native build.");
}

const unavailable: NautiloFileExport = {
  prepareExportCacheAsync: () => Promise.reject(nativeFileExportUnavailableError()),
  saveFileAsync: () => Promise.reject(nativeFileExportUnavailableError()),
  saveMediaAsync: () => Promise.reject(nativeFileExportUnavailableError()),
  cancelPendingExportAsync: (_requestId) => Promise.resolve(false),
};

const fileExportModule: NautiloFileExport = nativeModule == null || !isFileExportAvailable()
  ? unavailable
  : {
      prepareExportCacheAsync: nativeModule.prepareExportCacheAsync.bind(nativeModule),
      saveFileAsync: nativeModule.saveFileAsync.bind(nativeModule),
      saveMediaAsync: typeof nativeModule.saveMediaAsync === "function"
        ? nativeModule.saveMediaAsync.bind(nativeModule)
        : (input) => unavailable.saveMediaAsync(input),
      cancelPendingExportAsync: nativeModule.cancelPendingExportAsync.bind(nativeModule),
    };

export default fileExportModule;
