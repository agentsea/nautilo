import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { OriginalFileDownload, OriginalFileDownloadInput } from "./original-file-download";

/** Each operation owns an unguessable directory; no shared preview cache is reused. */
export async function downloadOriginalFile(input: OriginalFileDownloadInput): Promise<OriginalFileDownload> {
  if (!input.filename || input.filename === "." || input.filename === ".." || /[/\\]/u.test(input.filename) || input.filename.includes(String.fromCharCode(0))) {
    throw new Error("Invalid export filename.");
  }
  // React Native's AbortController polyfill does not implement throwIfAborted.
  if (input.signal.aborted) throw new Error("Save cancelled");
  const directory = new Directory(Paths.cache, "nautilo-exports", randomUUID());
  directory.create({ intermediates: true });
  const destination = new File(directory, input.filename);
  const cleanup = (): void => {
    if (directory.exists) directory.delete();
  };
  try {
    await File.downloadFileAsync(input.url, destination, {
      headers: { Authorization: `Bearer ${input.token}` },
      signal: input.signal,
    });
    if (input.signal.aborted) throw new Error("Save cancelled");
    if (!destination.exists || !Number.isSafeInteger(destination.size) || destination.size < 0) {
      throw new Error("The original file download did not finish.");
    }
    return { fileUri: destination.uri, size: destination.size, cleanup };
  } catch (error) {
    try { cleanup(); }
    catch {
      throw Object.assign(new Error("The download failed and its temporary copy could not be removed."), {
        code: "ERR_EXPORT_TEMP_CLEANUP",
      });
    }
    throw error;
  }
}
