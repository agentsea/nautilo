export type OriginalFileDownloadInput = Readonly<{
  url: string;
  token: string;
  filename: string;
  signal: AbortSignal;
}>;

export type OriginalFileDownload = Readonly<{
  fileUri: string;
  size: number;
  cleanup: () => void;
}>;

export function downloadOriginalFile(_input: OriginalFileDownloadInput): Promise<OriginalFileDownload> {
  return Promise.reject(new Error("Native file saving requires an updated iPhone or Android build."));
}
