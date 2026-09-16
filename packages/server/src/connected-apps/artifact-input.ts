import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  envelopeFactsForArtifacts,
  resolveWorkspaceArtifact,
} from "@nautilo/agent";

export class ConnectedAppArtifactInputError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "ConnectedAppArtifactInputError";
  }
}

export interface ConnectedAppArtifactInputSource {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly chunks: AsyncIterable<Uint8Array>;
  /** Revalidate the row and opened handle after staging, before provider dispatch. */
  verify(): Promise<void>;
  close(): Promise<void>;
}

export type ConnectedAppArtifactInputResolver = (input: {
  readonly artifactPath: string;
  readonly signal?: AbortSignal | undefined;
}) => Promise<ConnectedAppArtifactInputSource>;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function fileIdentity(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * Open one ordinary Room artifact under the invocation's existing memory
 * envelope. The open handle is the byte authority; a second row/path check
 * before provider dispatch detects replacement or revision drift.
 */
export async function openWorkspaceArtifactInput(input: {
  readonly envelope: MemoryAccessEnvelope;
  readonly artifactPath: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<ConnectedAppArtifactInputSource> {
  const logicalPath = input.artifactPath.replace(/^\/+/, "");
  const factsResult = envelopeFactsForArtifacts(input.envelope);
  if (!factsResult.ok) {
    throw new ConnectedAppArtifactInputError("connected_app_artifact_forbidden", 403);
  }
  const initial = await resolveWorkspaceArtifact({
    logicalPath,
    facts: factsResult.facts,
    intent: "read",
  });
  if (!initial.ok || !initial.artifact) {
    throw new ConnectedAppArtifactInputError("connected_app_artifact_not_found", 404);
  }

  let handle: FileHandle;
  try {
    handle = await open(initial.physicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ConnectedAppArtifactInputError("connected_app_artifact_bytes_unavailable", 404);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };

  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || initial.artifact.size !== openedStats.size) {
      throw new ConnectedAppArtifactInputError("connected_app_artifact_changed", 409);
    }
    const pinnedFile = fileIdentity(openedStats);
    const pinnedRow = {
      id: initial.artifact.id,
      artifactId: initial.artifact.artifactId,
      revision: initial.artifact.revision,
      storageUri: initial.artifact.storageUri,
    };

    const verify = async (): Promise<void> => {
      const [current, currentHandleStats, currentPathStats] = await Promise.all([
        resolveWorkspaceArtifact({
          logicalPath,
          facts: factsResult.facts,
          intent: "read",
        }),
        handle.stat(),
        lstat(initial.physicalPath),
      ]).catch(() => {
        throw new ConnectedAppArtifactInputError("connected_app_artifact_changed", 409);
      });
      if (!current.ok || !current.artifact
        || current.artifact.id !== pinnedRow.id
        || current.artifact.artifactId !== pinnedRow.artifactId
        || current.artifact.revision !== pinnedRow.revision
        || current.artifact.storageUri !== pinnedRow.storageUri
        || !sameFileIdentity(fileIdentity(currentHandleStats), pinnedFile)
        || !sameFileIdentity(fileIdentity(currentPathStats), pinnedFile)) {
        throw new ConnectedAppArtifactInputError("connected_app_artifact_changed", 409);
      }
    };

    const chunks = (async function* (): AsyncGenerator<Uint8Array> {
      let position = 0;
      // Transfer granularity only: this reusable buffer does not cap the artifact size.
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      while (position < pinnedFile.size) {
        if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead <= 0 || position + bytesRead > pinnedFile.size) {
          throw new ConnectedAppArtifactInputError("connected_app_artifact_changed", 409);
        }
        position += bytesRead;
        yield Uint8Array.from(buffer.subarray(0, bytesRead));
      }
    })();

    return {
      name: basename(initial.logicalPath),
      mimeType: initial.artifact.mimeType || "application/octet-stream",
      sizeBytes: pinnedFile.size,
      chunks,
      verify,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
