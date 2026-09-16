/** Structural subset supplied by the canonical Artifact metadata response. */
export type ArtifactOriginalMetadata = Readonly<{
  id: string;
  artifactId: string;
  path: string;
  mimeType: string;
  size: number;
  revision: number;
  canWrite: boolean;
}>;

export type ArtifactOriginalExportScope = Readonly<{
  serverId: string;
  accountId: string;
  sourceKind: "artifact";
  sourceId: string;
  generation: number;
}>;

type FailureKind = "auth_dead" | "forbidden" | "missing" | "network" | "server" | "cancelled" | "cleanup_failed";

export type ArtifactOriginalMetadataResult =
  | Readonly<{ kind: "metadata"; metadata: ArtifactOriginalMetadata }>
  | Readonly<{ kind: FailureKind; message?: string }>;

export type ArtifactOriginalFileResult =
  | Readonly<{ kind: "file"; fileUri: string; cleanup: () => void | Promise<void> }>
  | Readonly<{ kind: FailureKind; message?: string }>;

export type ArtifactOriginalExportResult =
  | Readonly<{
      kind: "ready";
      fileUri: string;
      filename: string;
      mimeType: string;
      size: number;
      revision: number;
      artifact: ArtifactOriginalMetadata;
      cleanup: () => void | Promise<void>;
      /** A same-revision metadata reread detects ordinary races; it is not an immutable-byte proof. */
      consistency: "metadata_rechecked_not_immutable";
    }>
  | Readonly<{
      kind: "failed";
      reason: FailureKind | "invalid_scope" | "source_changed" | "invalid_file";
      message?: string;
    }>;

export type ArtifactOriginalExportDependencies = Readonly<{
  getCurrentScope: () => ArtifactOriginalExportScope | null;
  loadMetadata: (input: Readonly<{ sourceId: string; signal?: AbortSignal }>) => Promise<ArtifactOriginalMetadataResult>;
  acquireFile: (input: Readonly<{
    sourceId: string;
    metadata: ArtifactOriginalMetadata;
    signal?: AbortSignal;
  }>) => Promise<ArtifactOriginalFileResult>;
}>;

/**
 * Produce a destination-safe display basename without changing a valid suffix.
 * Path components are never forwarded to a native destination provider.
 */
export function safeArtifactBasename(path: string): string {
  const basename = path.split(/[\\/]/).filter((part) => part.length > 0).at(-1) ?? "";
  const sanitized = basename
    // eslint-disable-next-line no-control-regex -- remove control bytes from an OS destination basename
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return sanitized.length > 0 && sanitized !== "." && sanitized !== ".." ? sanitized : "file";
}

/**
 * Acquire an authorized original independently from preview eligibility.
 *
 * The current server bytes route is not revision-conditioned and ArtifactDto
 * carries no byte digest. A matching metadata reread therefore detects a
 * common concurrent change but MUST NOT be presented as immutable-revision
 * proof. Every non-ready outcome after file ownership cleans that file.
 */
export async function acquireArtifactOriginal(
  scope: ArtifactOriginalExportScope,
  dependencies: ArtifactOriginalExportDependencies,
  signal?: AbortSignal,
): Promise<ArtifactOriginalExportResult> {
  if (!validScope(scope) || !sameScope(scope, dependencies.getCurrentScope())) {
    return failed("invalid_scope");
  }
  if (signal?.aborted) return failed("cancelled");

  let first: ArtifactOriginalMetadataResult;
  try {
    first = await dependencies.loadMetadata({ sourceId: scope.sourceId, signal });
  } catch (error) {
    return failed("network", errorMessage(error));
  }
  if (first.kind !== "metadata") return fromDependencyFailure(first);
  if (signal?.aborted) return failed("cancelled");
  if (!sameScope(scope, dependencies.getCurrentScope())) return failed("source_changed");
  if (first.metadata.id !== scope.sourceId) return failed("source_changed");

  let acquired: ArtifactOriginalFileResult;
  try {
    acquired = await dependencies.acquireFile({
      sourceId: scope.sourceId,
      metadata: first.metadata,
      signal,
    });
  } catch (error) {
    return failed(signal?.aborted ? "cancelled" : "network", errorMessage(error));
  }
  if (acquired.kind !== "file") return fromDependencyFailure(acquired);

  const discard = async (
    reason: Extract<ArtifactOriginalExportResult, { kind: "failed" }>["reason"],
    message?: string,
  ): Promise<ArtifactOriginalExportResult> => {
    try {
      await acquired.cleanup();
    } catch {
      return failed("cleanup_failed");
    }
    return failed(reason, message);
  };

  if (acquired.fileUri.trim().length === 0) return discard("invalid_file");
  if (signal?.aborted) return discard("cancelled");
  if (!sameScope(scope, dependencies.getCurrentScope())) return discard("source_changed");

  let second: ArtifactOriginalMetadataResult;
  try {
    second = await dependencies.loadMetadata({ sourceId: scope.sourceId, signal });
  } catch (error) {
    return discard(signal?.aborted ? "cancelled" : "network", errorMessage(error));
  }
  if (second.kind !== "metadata") {
    const outcome = fromDependencyFailure(second);
    return discard(outcome.reason, outcome.message);
  }
  if (signal?.aborted) return discard("cancelled");
  if (!sameScope(scope, dependencies.getCurrentScope())) return discard("source_changed");
  if (!sameArtifactMetadata(first.metadata, second.metadata)) return discard("source_changed");

  return {
    kind: "ready",
    fileUri: acquired.fileUri,
    filename: safeArtifactBasename(second.metadata.path),
    mimeType: second.metadata.mimeType,
    size: second.metadata.size,
    revision: second.metadata.revision,
    artifact: second.metadata,
    cleanup: acquired.cleanup,
    consistency: "metadata_rechecked_not_immutable",
  };
}

function validScope(scope: ArtifactOriginalExportScope): boolean {
  return scope.sourceKind === "artifact" && scope.serverId.length > 0 && scope.accountId.length > 0 &&
    scope.sourceId.length > 0 && Number.isSafeInteger(scope.generation) && scope.generation >= 0;
}

function sameScope(expected: ArtifactOriginalExportScope, actual: ArtifactOriginalExportScope | null): boolean {
  return actual !== null && expected.serverId === actual.serverId && expected.accountId === actual.accountId &&
    expected.sourceKind === actual.sourceKind && expected.sourceId === actual.sourceId &&
    expected.generation === actual.generation;
}

function sameArtifactMetadata(left: ArtifactOriginalMetadata, right: ArtifactOriginalMetadata): boolean {
  return left.id === right.id && left.artifactId === right.artifactId && left.path === right.path &&
    left.mimeType === right.mimeType && left.size === right.size && left.revision === right.revision;
}

function fromDependencyFailure(
  result: Exclude<ArtifactOriginalMetadataResult | ArtifactOriginalFileResult, { kind: "metadata" } | { kind: "file" }>,
): Extract<ArtifactOriginalExportResult, { kind: "failed" }> {
  return failed(result.kind, result.message);
}

function failed(
  reason: Extract<ArtifactOriginalExportResult, { kind: "failed" }>["reason"],
  message?: string,
): Extract<ArtifactOriginalExportResult, { kind: "failed" }> {
  return { kind: "failed", reason, ...(message ? { message } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Original file acquisition failed.";
}
/** OS destination hints use the MIME essence; bytes and canonical metadata remain untouched. */
export function nativeExportMimeType(mimeType: string): string {
  const essence = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(essence) ? essence : "application/octet-stream";
}
