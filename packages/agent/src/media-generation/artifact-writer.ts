import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { VeniceArtifactCommitProof } from "./venice-lifecycle";

const ALLOWED_MEDIA_MIME_TYPES = ["video/mp4", "audio/mp4", "audio/mpeg"] as const;
const HEADER_BYTES = 64;

export type SupportedGeneratedMediaMimeType = (typeof ALLOWED_MEDIA_MIME_TYPES)[number];

export type MediaArtifactIndexCommit = Readonly<{
  /** Private server path of an already atomically-finalized artifact. */
  finalPath: string;
  receiptId: string;
  mimeType: SupportedGeneratedMediaMimeType;
  size: number;
  sha256: string;
}>;

export type CommittedMediaArtifactIdentity = Readonly<{
  artifactId: string;
  artifactInternalId: string;
  artifactRevision: number;
}>;

/**
 * The index implementation owns namespace attachment and durable DB commit.
 * The writer only calls it after bytes have completely streamed and atomically
 * finalized under the server-owned root.
 */
export type MediaArtifactIndexCommitter = Readonly<{
  commit(input: MediaArtifactIndexCommit): Promise<CommittedMediaArtifactIdentity>;
}>;

/**
 * Index implementations may prove that their transaction did not commit. Any
 * other error is conservatively treated as unknown and leaves final bytes for
 * reconciliation rather than risking deletion of an already-indexed artifact.
 */
export class MediaArtifactIndexCommitError extends Error {
  readonly commitCertainty: "not_committed" | "unknown";

  constructor(commitCertainty: "not_committed" | "unknown") {
    super("Media artifact index commit did not complete.");
    this.name = "MediaArtifactIndexCommitError";
    this.commitCertainty = commitCertainty;
  }
}

export type MediaArtifactStream = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export type WriteStagedMediaArtifactInput = Readonly<{
  receiptId: string;
  mimeType: SupportedGeneratedMediaMimeType;
  stream: MediaArtifactStream;
  /** Absolute server-owned root. A dedicated staging/final pair is created beneath it. */
  serverArtifactRoot: string;
  /** Explicit operator/storage policy; no hidden universal media limit exists here. */
  maxBytes: number;
  indexCommitter: MediaArtifactIndexCommitter;
  /** Deterministic test seam; production defaults to an unguessable UUID. */
  fileToken?: string;
}>;

export type WrittenStagedMediaArtifact = Readonly<{
  artifactId: string;
  artifactInternalId: string;
  artifactRevision: number;
  mimeType: SupportedGeneratedMediaMimeType;
  size: number;
  sha256: string;
  commitProof: VeniceArtifactCommitProof;
}>;

export type MediaArtifactWriteErrorCode =
  | "MEDIA_ARTIFACT_INVALID_INPUT"
  | "MEDIA_ARTIFACT_STREAM_INTERRUPTED"
  | "MEDIA_ARTIFACT_EMPTY"
  | "MEDIA_ARTIFACT_TOO_LARGE"
  | "MEDIA_ARTIFACT_MIME_MISMATCH"
  | "MEDIA_ARTIFACT_INTEGRITY"
  | "MEDIA_ARTIFACT_CAPACITY"
  | "MEDIA_ARTIFACT_STORAGE"
  | "MEDIA_ARTIFACT_INDEX_FAILED";

/** Safe operational error: never carries a provider body, media bytes, or private path. */
export class MediaArtifactWriteError extends Error {
  readonly code: MediaArtifactWriteErrorCode;

  constructor(code: MediaArtifactWriteErrorCode, message: string) {
    super(message);
    this.name = "MediaArtifactWriteError";
    this.code = code;
  }
}

function safeReceipt(value: string): boolean {
  return /^mg_[A-Za-z0-9_-]{16,128}$/u.test(value);
}

function safeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/u.test(value);
}

function assertInput(input: WriteStagedMediaArtifactInput): void {
  if (!safeReceipt(input.receiptId)) throw new MediaArtifactWriteError("MEDIA_ARTIFACT_INVALID_INPUT", "Media artifact receipt is malformed.");
  if (!ALLOWED_MEDIA_MIME_TYPES.includes(input.mimeType)) throw new MediaArtifactWriteError("MEDIA_ARTIFACT_INVALID_INPUT", "Generated media MIME type is unsupported.");
  if (!path.isAbsolute(input.serverArtifactRoot)) throw new MediaArtifactWriteError("MEDIA_ARTIFACT_INVALID_INPUT", "Media artifact storage must use an absolute server-owned root.");
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new MediaArtifactWriteError("MEDIA_ARTIFACT_INVALID_INPUT", "Media artifact byte policy is invalid.");
  if (input.fileToken !== undefined && !safeToken(input.fileToken)) throw new MediaArtifactWriteError("MEDIA_ARTIFACT_INVALID_INPUT", "Media artifact file token is malformed.");
}

function extensionForMime(mimeType: SupportedGeneratedMediaMimeType): "mp4" | "m4a" | "mp3" {
  switch (mimeType) {
    case "video/mp4": return "mp4";
    case "audio/mp4": return "m4a";
    case "audio/mpeg": return "mp3";
  }
}

function isMp4Container(header: Uint8Array): boolean {
  return header.byteLength >= 8 && header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70;
}

function isM4aContainer(header: Uint8Array): boolean {
  // `audio/mp4` is ISO BMFF. Valid M4A files frequently advertise generic
  // `isom`/`mp42` major brands and carry M4A in compatible brands or tracks,
  // so rejecting every non-`M4A ` major brand would reject provider output.
  // Track-level audio verification belongs to the later codec-inspection lane.
  return isMp4Container(header);
}

function isMp3(header: Uint8Array): boolean {
  if (header.byteLength >= 3 && header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) return true;
  return header.byteLength >= 2 && header[0] === 0xff && (header[1]! & 0xe0) === 0xe0;
}

function validateMagic(mimeType: SupportedGeneratedMediaMimeType, header: Uint8Array): void {
  const valid = mimeType === "video/mp4" ? isMp4Container(header)
    : mimeType === "audio/mp4" ? isM4aContainer(header)
      : isMp3(header);
  if (!valid) throw new MediaArtifactWriteError("MEDIA_ARTIFACT_MIME_MISMATCH", "Generated media bytes do not match the approved media format.");
}

function classifyStorageError(error: unknown): MediaArtifactWriteError {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new MediaArtifactWriteError("MEDIA_ARTIFACT_CAPACITY", "Media storage capacity is exhausted; the generation remains available for later persistence.");
  }
  return new MediaArtifactWriteError("MEDIA_ARTIFACT_STORAGE", "Nautilo could not safely persist generated media.");
}

async function* readChunks(stream: MediaArtifactStream): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in stream) {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) yield chunk;
    return;
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value === undefined) throw new Error("media stream returned an empty chunk");
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeAll(handle: fsp.FileHandle, chunk: Uint8Array, offset: number): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    const result = await handle.write(chunk, written, chunk.byteLength - written, offset + written);
    if (result.bytesWritten < 1) throw new Error("media staging write made no progress");
    written += result.bytesWritten;
  }
}

function validCommittedIdentity(value: CommittedMediaArtifactIdentity): boolean {
  return typeof value.artifactId === "string" && value.artifactId.trim().length > 0 &&
    typeof value.artifactInternalId === "string" && value.artifactInternalId.trim().length > 0 &&
    Number.isSafeInteger(value.artifactRevision) && value.artifactRevision >= 0;
}

async function removeIfPresent(filePath: string): Promise<void> {
  await fsp.rm(filePath, { force: true }).catch(() => undefined);
}

/** Persist the directory entry before a durable artifact index can reference it. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Stream one generated media result into a server-owned staging file, validate
 * it, atomically finalize it, then let the injected canonical artifact index
 * commit return identity. No provider call or DB mutation lives here.
 */
export async function writeStagedMediaArtifact(input: WriteStagedMediaArtifactInput): Promise<WrittenStagedMediaArtifact> {
  assertInput(input);
  const token = input.fileToken ?? randomUUID().replaceAll("-", "");
  const stagingDirectory = path.join(input.serverArtifactRoot, ".media-staging");
  const finalDirectory = path.join(input.serverArtifactRoot, "media");
  const basename = `${input.receiptId}-${token}.${extensionForMime(input.mimeType)}`;
  const temporaryPath = path.join(stagingDirectory, `${basename}.part`);
  const finalPath = path.join(finalDirectory, basename);
  let finalized = false;
  let preserveFinal = false;

  try {
    try {
      await fsp.mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
      await fsp.mkdir(finalDirectory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw classifyStorageError(error);
    }

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(temporaryPath, "wx", 0o600);
    } catch (error) {
      throw classifyStorageError(error);
    }

    let size = 0;
    const header: number[] = [];
    const digest = createHash("sha256");
    try {
      try {
        for await (const chunk of readChunks(input.stream)) {
          if (!(chunk instanceof Uint8Array)) throw new Error("media stream yielded a non-byte chunk");
          const nextSize = size + chunk.byteLength;
          if (!Number.isSafeInteger(nextSize) || nextSize > input.maxBytes) {
            throw new MediaArtifactWriteError("MEDIA_ARTIFACT_TOO_LARGE", "Generated media exceeds the configured storage policy.");
          }
          if (header.length < HEADER_BYTES) {
            for (let index = 0; index < chunk.byteLength && header.length < HEADER_BYTES; index += 1) header.push(chunk[index]!);
          }
          await writeAll(handle, chunk, size);
          digest.update(chunk);
          size = nextSize;
        }
      } catch (error) {
        if (error instanceof MediaArtifactWriteError) throw error;
        throw new MediaArtifactWriteError("MEDIA_ARTIFACT_STREAM_INTERRUPTED", "Generated media transfer was interrupted before it could be saved.");
      }
      await handle.sync();
    } catch (error) {
      throw error instanceof MediaArtifactWriteError ? error : classifyStorageError(error);
    } finally {
      await handle.close().catch(() => undefined);
    }

    if (size === 0) throw new MediaArtifactWriteError("MEDIA_ARTIFACT_EMPTY", "Generated media was empty and was not saved.");
    try {
      validateMagic(input.mimeType, Uint8Array.from(header));
    } catch (error) {
      if (error instanceof MediaArtifactWriteError) throw error;
      throw new MediaArtifactWriteError("MEDIA_ARTIFACT_INTEGRITY", "Generated media could not be verified.");
    }

    try {
      await fsp.rename(temporaryPath, finalPath);
      finalized = true;
      await syncDirectory(finalDirectory);
    } catch (error) {
      throw classifyStorageError(error);
    }

    const sha256 = digest.digest("hex");
    let identity: CommittedMediaArtifactIdentity;
    try {
      identity = await input.indexCommitter.commit({ finalPath, receiptId: input.receiptId, mimeType: input.mimeType, size, sha256 });
      // A resolved commit may already have durable ownership even if its
      // returned identity is malformed; do not delete those bytes below.
      preserveFinal = true;
    } catch (error) {
      if (!(error instanceof MediaArtifactIndexCommitError) || error.commitCertainty !== "not_committed") {
        preserveFinal = true;
      }
      throw new MediaArtifactWriteError("MEDIA_ARTIFACT_INDEX_FAILED", "Generated media was saved but could not be indexed for the Workspace.");
    }
    if (!validCommittedIdentity(identity)) throw new MediaArtifactWriteError("MEDIA_ARTIFACT_INDEX_FAILED", "Generated media index returned an invalid artifact identity.");
    return Object.freeze({
      ...identity,
      mimeType: input.mimeType,
      size,
      sha256,
      commitProof: {
        receiptId: input.receiptId,
        artifactInternalId: identity.artifactInternalId,
        artifactRevision: identity.artifactRevision,
        state: "durably_committed" as const,
      },
    });
  } finally {
    await removeIfPresent(temporaryPath);
    // Only an index implementation that proves no commit happened lets us
    // remove an unindexed final. Unknown/committed outcomes stay for custody
    // reconciliation; we never delete already-indexed bytes.
    if (finalized && !preserveFinal) await removeIfPresent(finalPath);
  }
}
