import type { ArtifactDto } from "@nautilo/api-client/browser";

import type { BrowserArtifactArrayBufferClient } from "./shared-browser-viewer-byte-source-contract";

/** The narrow existing API-client capability needed to acquire a viewer source. */
export interface BrowserArtifactCoordinatorClient extends BrowserArtifactArrayBufferClient {
  setToken(token: string): void;
  getWorkspaceArtifact(artifactId: string, options?: { roomId?: string }): Promise<ArtifactDto | null>;
}

export interface AcquireBrowserArtifactInput {
  /** Active server identity used exclusively by the shared auth provider. */
  readonly serverId: string;
  /** Canonical server base URL used exclusively by the shared auth provider. */
  readonly baseUrl: string;
  /** Existing API client bound to the same server. */
  readonly client: BrowserArtifactCoordinatorClient;
  /** Internal workspace-artifact row id. */
  readonly artifactId: string;
  /** An optional, already-validated room narrows server-side authorization. */
  readonly roomId?: string;
  /** Explicit product policy ceiling; this coordinator defines no default. */
  readonly maxBytes: number;
  /** Caller-owned cancellation for this one acquisition generation. */
  readonly signal: AbortSignal;
}

export type BrowserArtifactAcquisition =
  | {
    readonly kind: "ready";
    readonly artifact: ArtifactDto;
    readonly bytes: ArrayBuffer;
    readonly declaredBytes: number;
    readonly observedBytes: number;
  }
  | { readonly kind: "not_found" }
  | { readonly kind: "too_large"; readonly artifact: ArtifactDto; readonly declaredBytes: number; readonly maxBytes: number }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_implemented" }
  | { readonly kind: "auth_dead" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "invalid_input" }
  | { readonly kind: "server"; readonly status: number }
  | { readonly kind: "unavailable"; readonly reason: "metadata" | "bytes" | "integrity" | "platform" };
