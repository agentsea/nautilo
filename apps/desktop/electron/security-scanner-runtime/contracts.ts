/**
 * D560 — local, managed security-scanner acquisition contracts.
 *
 * This boundary deliberately has no relay/tool-registry types.  Callers get
 * only an opaque installation record and an internal executable path.  A
 * reviewed manifest is the sole authority for executable bytes.
 */

export type SecurityScannerPlatform = "darwin-arm64" | "darwin-x64";
export type SecurityScannerComponentKind = "engine" | "rules";
export type SecurityScannerArchiveFormat = "binary" | "tar.gz";

export interface SecurityScannerArtifact {
  readonly component: string;
  /** Engine executables and rule content are intentionally different identities. */
  readonly kind: SecurityScannerComponentKind;
  readonly version: string;
  readonly platform: SecurityScannerPlatform;
  readonly url: string;
  readonly archiveBytes: number;
  readonly sha256: string;
  readonly format: SecurityScannerArchiveFormat;
  /** Relative file within the artifact.  Rules never have an entrypoint. */
  readonly entrypoint?: string;
  readonly entrypointSha256?: string;
  readonly license: string;
  readonly source: string;
  /** Immutable receipt for the notices that accompanied this release. */
  readonly notices: {
    readonly url: string;
    readonly sha256: string;
    readonly bytes: number;
  };
}

export interface SecurityScannerManifest {
  readonly schemaVersion: 1;
  readonly allowedDownloadHosts: readonly string[];
  /** URL pathname prefixes that can be fetched, keyed by host. */
  readonly allowedDownloadPrefixes: Readonly<Record<string, readonly string[]>>;
  readonly artifacts: readonly SecurityScannerArtifact[];
}

export type SecurityScannerInstallPhase =
  | "resolving"
  | "downloading"
  | "verifying"
  | "staging"
  | "activating"
  | "ready"
  | "cancelled"
  | "failed";

export interface SecurityScannerInstallState {
  readonly phase: SecurityScannerInstallPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly canCancel: boolean;
  readonly code?: SecurityScannerRuntimeCode;
}

export type SecurityScannerRuntimeCode =
  | "SECURITY_SCANNER_NOT_FOUND"
  | "SECURITY_SCANNER_PLATFORM_UNSUPPORTED"
  | "SECURITY_SCANNER_CANCELLED"
  | "SECURITY_SCANNER_ARTIFACT_INVALID"
  | "SECURITY_SCANNER_UNHEALTHY"
  | "SECURITY_SCANNER_INSTALL_FAILED";

export interface SecurityScannerRuntimeDetails {
  readonly state: "ready" | "unavailable";
  readonly component: string;
  readonly kind: SecurityScannerComponentKind;
  readonly version?: string;
  readonly platform?: SecurityScannerPlatform;
  readonly code?: SecurityScannerRuntimeCode;
  readonly fingerprint?: string;
  /** An opaque activation generation; it is not a filesystem path. */
  readonly generation?: number;
  readonly checkedAt: number;
}

export interface SecurityScannerFetchResponse {
  readonly url: string;
  readonly status: number;
  readonly contentLength: number | null;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface SecurityScannerRuntimeHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly runtimeRoot: string;
  fetch(url: string, signal?: AbortSignal): Promise<SecurityScannerFetchResponse>;
  /** Must run the installed executable with a fixed safe version/health probe. */
  health(entrypoint: string, expectedVersion: string, signal?: AbortSignal): Promise<boolean>;
  now(): number;
}

export interface ResolveSecurityScannerOptions {
  readonly version?: string;
  readonly signal?: AbortSignal;
  readonly onState?: (state: SecurityScannerInstallState) => void;
}

export interface SecurityScannerInstallation {
  readonly details: SecurityScannerRuntimeDetails;
  /** Main-process-only path; never forward over relay/tool contracts. */
  readonly internalPath: string | null;
}
