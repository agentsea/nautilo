import type { OriginalFileDownload, OriginalFileDownloadInput } from "./original-file-download";

// Browser downloads have different provider/receipt semantics. Do not fake
// native Save completion through an anchor click or a share sheet.
export function downloadOriginalFile(_input: OriginalFileDownloadInput): Promise<OriginalFileDownload> {
  return Promise.reject(new Error("Native Save file is available in the iPhone and Android apps."));
}
