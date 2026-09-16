/**
 * D448 Phase 8.2 — immutable, content-addressed Workspace mutation bytes.
 *
 * A coordinator writes candidate bytes here *before* its database
 * transaction. The later pointer CAS/receipt transaction decides whether
 * those bytes become visible. Failed transactions may leave an unreferenced
 * object behind; that is safe and intentionally requires no compensation.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getArtifactsRoot } from "@nautilo/config";

const CONTENT_SUBDIRECTORY = "workspace-document-mutation-content/sha256";
// Mutable artifact pointers must never target the receipt's content-addressed
// object.  A unique live object gives each successful pointer its own write
// surface while receipts keep naming the immutable sha256 object above.
const LIVE_SUBDIRECTORY = "workspace-document-mutation-content/live";

type WritableFileHandle = {
  writeFile(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

type ReadableFileHandle = {
  sync(): Promise<void>;
  close(): Promise<void>;
};

export type WorkspaceDocumentMutationContentFileOps = {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readFile(path: string): Promise<Uint8Array>;
  open(path: string, flags: string, mode?: number): Promise<WritableFileHandle | ReadableFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
};

const nodeFileOps: WorkspaceDocumentMutationContentFileOps = {
  mkdir,
  readFile,
  open,
  rename,
  unlink,
};

export class WorkspaceDocumentMutationContentHashMismatchError extends Error {
  override name = "WorkspaceDocumentMutationContentHashMismatchError";
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Workspace mutation content SHA-256 must be 64 lowercase hexadecimal characters");
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  // Windows and some network filesystems cannot open/fsync a directory.
  return code === "EINVAL" || code === "EPERM" || code === "EISDIR" || code === "ENOTSUP";
}

async function fsyncParentDirectory(
  ops: WorkspaceDocumentMutationContentFileOps,
  parent: string,
): Promise<void> {
  let handle: ReadableFileHandle | WritableFileHandle | undefined;
  try {
    handle = await ops.open(parent, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

export type WriteWorkspaceDocumentMutationContentInput = {
  /** Candidate post-image bytes derived and validated by the coordinator. */
  readonly bytes: Uint8Array;
  /** The coordinator's exact post-image SHA; used for both name and verify. */
  readonly sha256: string;
  /** Test/operator seam; production defaults to the configured artifact root. */
  readonly artifactsRoot?: string;
  /** Test seam only. Production uses durable node fs promises. */
  readonly fileOps?: WorkspaceDocumentMutationContentFileOps;
};

export type WorkspaceDocumentMutationContent = {
  readonly sha256: string;
  readonly size: number;
  readonly absolutePath: string;
  readonly storageUri: string;
  readonly reused: boolean;
};

/** A unique, mutable object suitable only for an artifact's live pointer. */
export type WorkspaceDocumentMutationLiveContent = Omit<WorkspaceDocumentMutationContent, "reused">;

/**
 * Durably write a fresh live object.  Unlike the receipt writer this never
 * deduplicates by hash: two artifacts with identical bytes must not acquire
 * the same mutable storage URI.
 */
export async function writeWorkspaceDocumentMutationLiveContent(
  input: WriteWorkspaceDocumentMutationContentInput,
): Promise<WorkspaceDocumentMutationLiveContent> {
  assertSha256(input.sha256);
  if (sha256Hex(input.bytes) !== input.sha256) {
    throw new WorkspaceDocumentMutationContentHashMismatchError(
      "Live candidate bytes do not match the declared Workspace mutation SHA-256",
    );
  }
  const ops = input.fileOps ?? nodeFileOps;
  const root = input.artifactsRoot ?? getArtifactsRoot();
  const directory = join(root, LIVE_SUBDIRECTORY, input.sha256.slice(0, 2));
  const absolutePath = join(directory, `${input.sha256}.${randomUUID()}`);
  const temporaryPath = `${absolutePath}.tmp`;
  await ops.mkdir(directory, { recursive: true });
  let temporaryWritten = false;
  try {
    const handle = await ops.open(temporaryPath, "wx", 0o600) as WritableFileHandle;
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    temporaryWritten = true;
    await ops.rename(temporaryPath, absolutePath);
    temporaryWritten = false;
    await fsyncParentDirectory(ops, directory);
    const verified = await ops.readFile(absolutePath);
    if (verified.byteLength !== input.bytes.byteLength || sha256Hex(verified) !== input.sha256) {
      throw new WorkspaceDocumentMutationContentHashMismatchError(
        "Fresh live Workspace mutation object failed byte/hash verification",
      );
    }
    return { sha256: input.sha256, size: input.bytes.byteLength, absolutePath, storageUri: `file://${absolutePath}` };
  } finally {
    if (temporaryWritten) {
      try { await ops.unlink(temporaryPath); } catch { /* unreferenced temp */ }
    }
  }
}

/**
 * Places bytes under a server-owned `sha256/<digest>` name. It accepts no
 * logical path, artifact id, namespace, or authority selector. The caller
 * must still decide authorization and later commit the pointer in a DB tx.
 */
export async function writeWorkspaceDocumentMutationContent(
  input: WriteWorkspaceDocumentMutationContentInput,
): Promise<WorkspaceDocumentMutationContent> {
  assertSha256(input.sha256);
  const actualSha256 = sha256Hex(input.bytes);
  if (actualSha256 !== input.sha256) {
    throw new WorkspaceDocumentMutationContentHashMismatchError(
      "Candidate bytes do not match the declared Workspace mutation SHA-256",
    );
  }

  const ops = input.fileOps ?? nodeFileOps;
  const root = input.artifactsRoot ?? getArtifactsRoot();
  const directory = join(root, CONTENT_SUBDIRECTORY, input.sha256.slice(0, 2));
  const absolutePath = join(directory, input.sha256);
  const result = (reused: boolean): WorkspaceDocumentMutationContent => ({
    sha256: input.sha256,
    size: input.bytes.byteLength,
    absolutePath,
    // Existing Workspace artifact readers use the repository's raw
    // `file://${absolutePath}` convention (including literal spaces).
    storageUri: `file://${absolutePath}`,
    reused,
  });

  await ops.mkdir(directory, { recursive: true });
  try {
    const existing = await ops.readFile(absolutePath);
    if (existing.byteLength !== input.bytes.byteLength || sha256Hex(existing) !== input.sha256) {
      throw new WorkspaceDocumentMutationContentHashMismatchError(
        `Existing immutable Workspace mutation object does not match ${input.sha256}`,
      );
    }
    return result(true);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (error instanceof WorkspaceDocumentMutationContentHashMismatchError) throw error;
    if (code !== "ENOENT") throw error;
  }

  // Temp and final path share `directory`, so rename is a same-filesystem
  // atomic transition. The temp name is never an authority-bearing input.
  const temporaryPath = join(directory, `.${input.sha256}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryWritten = false;
  try {
    const handle = await ops.open(temporaryPath, "wx", 0o600) as WritableFileHandle;
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    temporaryWritten = true;
    await ops.rename(temporaryPath, absolutePath);
    temporaryWritten = false;
    await fsyncParentDirectory(ops, directory);
    return result(false);
  } finally {
    if (temporaryWritten) {
      try {
        await ops.unlink(temporaryPath);
      } catch {
        // Best effort only: an unreferenced temp cannot become visible.
      }
    }
  }
}
