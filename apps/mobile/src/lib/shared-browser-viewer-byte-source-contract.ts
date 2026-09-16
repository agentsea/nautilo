import type { ArtifactDto } from "@nautilo/api-client/browser";

export interface BrowserArtifactArrayBufferOptions {
  roomId?: string;
  signal: AbortSignal;
  expectedBytes: number;
  maxBytes: number;
}

/** Narrow authorized-byte capability consumed by the Mobile Web viewer boundary. */
export interface BrowserArtifactArrayBufferClient {
  getWorkspaceArtifactBytesArrayBuffer(
    artifactId: string,
    options: BrowserArtifactArrayBufferOptions,
  ): Promise<ArrayBuffer>;
}

export interface AcquireBrowserArtifactBytesInput {
  /** API client already bound to the current server and access token. */
  client: BrowserArtifactArrayBufferClient;
  /** Internal artifact row id used by the authorized bytes route. */
  artifactId: string;
  /** Canonical, already-authorized metadata for this exact artifact revision. */
  artifact: ArtifactDto;
  /** Optional C1-validated room for a room-scoped read; aggregate browsing omits it. */
  roomId?: string;
  /** Explicit format/device policy supplied by the eventual product host. */
  maxBytes: number;
  /** One generation-scoped cancellation signal; no timeout is invented here. */
  signal: AbortSignal;
}

export interface AcquiredBrowserArtifactBytes {
  artifact: ArtifactDto;
  bytes: ArrayBuffer;
  declaredBytes: number;
  observedBytes: number;
}

export type BrowserArtifactByteSourceErrorCode =
  | "unavailable"
  | "invalid_input"
  | "stale_metadata"
  | "size";

export class BrowserArtifactByteSourceError extends Error {
  readonly code: BrowserArtifactByteSourceErrorCode;

  constructor(code: BrowserArtifactByteSourceErrorCode, message: string) {
    super(message);
    this.name = "BrowserArtifactByteSourceError";
    this.code = code;
  }
}
