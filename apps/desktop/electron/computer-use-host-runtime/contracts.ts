/**
 * The updateable Computer Use Host is deliberately a private Desktop runtime.
 * Nothing in this contract accepts a server URL, PATH entry, shell command, or
 * model-provided executable. A release can enter only through the compiled
 * official-pointer authority or the separately bundled bootstrap seam.
 */
export type ComputerUseHostArchitecture = "arm64" | "x64";
export type ComputerUseHostSource = "bundled" | "managed" | "rollback";

export type ComputerUseHostMember = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  executable?: true;
}>;

export type ComputerUseHostRelease = Readonly<{
  schemaVersion: 1;
  releaseId: string;
  version: string;
  /** The one compiled, official pointer that authorized this release. */
  pointerUrl: string;
  archive: Readonly<{
    format: "bare" | "tar.gz";
    url: string;
    bytes: number;
    sha256: string;
  }>;
  entrypoint: string;
  members: readonly ComputerUseHostMember[];
  architectures: readonly ComputerUseHostArchitecture[];
  signature: Readonly<{
    teamId: string;
    designatedRequirement: string;
    notarized: true;
  }>;
}>;

export type ComputerUseHostRecord = Readonly<{
  schemaVersion: 1;
  generation: number;
  source: "bundled" | "managed";
  releaseId: string;
  version: string;
  archiveSha256: string;
  releaseSha256: string;
}>;

export type ComputerUseHostState =
  | Readonly<{
    state: "ready";
    source: ComputerUseHostSource;
    release: ComputerUseHostRelease;
    generation: number;
    /** Present only when official refresh failed and this exact safe release was retained. */
    remoteUpdateFailure?: ComputerUseHostFailureCode;
  }>
  | Readonly<{ state: "unavailable"; code: ComputerUseHostFailureCode }>;

export type ComputerUseHostFailureCode =
  | "host_root_unsafe"
  | "host_pointer_untrusted"
  | "host_release_invalid"
  | "host_archive_invalid"
  | "host_members_invalid"
  | "host_signature_invalid"
  | "host_health_failed"
  | "host_activation_failed"
  | "host_unavailable";

export interface ComputerUseHostLease {
  readonly generation: number;
  release(): void;
}

/**
 * Production obtains this from a compiled Desktop authority. The API has no
 * arbitrary URL parameter on purpose: callers cannot redirect host updates.
 */
export interface ComputerUseHostReleaseAuthority {
  resolveOfficialRelease(
    officialPointerUrl: string,
    signal?: AbortSignal,
  ): Promise<ComputerUseHostRelease>;
}

/** A downloaded archive plus a safe materialization supplied by the Node seam. */
export interface ComputerUseHostStagedArtifact {
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly root: string;
  readonly members: readonly ComputerUseHostMember[];
}

/**
 * Node owns filesystem and archive mechanics. It must create only 0700 roots,
 * extract without links or path escapes, and atomically publish the staging
 * root. The manager independently rechecks every released identity before
 * activation.
 */
export interface ComputerUseHostStorage {
  recoverStaging(): Promise<void>;
  ensurePrivateRoot(): Promise<boolean>;
  readRecord(kind: "active" | "rollback"): Promise<ComputerUseHostRecord | null>;
  findRelease(record: ComputerUseHostRecord): Promise<ComputerUseHostRelease | null>;
  /** Opens only an already-published, marker-owned immutable release. */
  openInstalled(release: ComputerUseHostRelease): Promise<ComputerUseHostStagedArtifact>;
  stageBundled(release: ComputerUseHostRelease): Promise<ComputerUseHostStagedArtifact>;
  downloadAndStage(release: ComputerUseHostRelease, signal?: AbortSignal): Promise<ComputerUseHostStagedArtifact>;
  /** Atomically publishes and returns the final immutable digest-root view. */
  publish(staged: ComputerUseHostStagedArtifact, release: ComputerUseHostRelease): Promise<ComputerUseHostStagedArtifact>;
  writeRecord(kind: "active" | "rollback", record: ComputerUseHostRecord): Promise<void>;
}

export interface ComputerUseHostAttestor {
  verifyMacosRelease(
    entrypoint: string,
    release: ComputerUseHostRelease,
    expectedArchitectures: readonly ComputerUseHostArchitecture[],
    signal?: AbortSignal,
  ): Promise<boolean>;
  health(entrypoint: string, release: ComputerUseHostRelease, signal?: AbortSignal): Promise<boolean>;
}

export interface ComputerUseHostRuntimeOptions {
  /** Compiled official pointer—not persisted/server/model input. */
  readonly officialPointerUrl: string;
  /** The signed bootstrap supplied with the Desktop package. */
  readonly bundledRelease: ComputerUseHostRelease;
  readonly releaseAuthority?: ComputerUseHostReleaseAuthority;
  readonly storage: ComputerUseHostStorage;
  readonly attestor: ComputerUseHostAttestor;
  readonly expectedArchitectures: readonly ComputerUseHostArchitecture[];
}
