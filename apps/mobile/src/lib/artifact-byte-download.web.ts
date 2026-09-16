import type { ArtifactByteDownload, ArtifactByteDownloadInput } from "./artifact-byte-download";

export interface BrowserArtifactByteEnvironment {
  fetch(input: string, init: RequestInit): Promise<Response>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export function createBrowserArtifactByteTransport(environment: BrowserArtifactByteEnvironment) {
  return {
    async download(input: ArtifactByteDownloadInput): Promise<ArtifactByteDownload> {
      const response = await environment.fetch(input.url, {
        headers: { Authorization: `Bearer ${input.token}` },
        signal: input.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (input.text) return { kind: "text", content: await response.text() };
      return { kind: "file", fileUri: environment.createObjectURL(await response.blob()) };
    },
    release(fileUri: string): void {
      if (fileUri.startsWith("blob:")) environment.revokeObjectURL(fileUri);
    },
  };
}

const browserTransport = typeof fetch === "function" && typeof URL !== "undefined"
  ? createBrowserArtifactByteTransport({
      fetch: (input, init) => fetch(input, init),
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
    })
  : null;

export function downloadArtifactBytes(input: ArtifactByteDownloadInput): Promise<ArtifactByteDownload> {
  return browserTransport
    ? browserTransport.download(input)
    : Promise.reject(new Error("Browser artifact byte download is unavailable."));
}

export function releaseArtifactFileUri(fileUri: string): void {
  browserTransport?.release(fileUri);
}
