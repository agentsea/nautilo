import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  unlink,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, resolve } from "node:path";
import {
  ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
  ARTIFACT_BLOB_MAX_FILE_BYTES,
  ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES,
  artifactBlobSealedChunkBytes,
  deriveArtifactBlobChunkCount,
  openArtifactBlobChunk,
  sealArtifactBlobChunk,
  type ArtifactBlobHeader,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  ARTIFACT_BLOB_FORMAT_VERSION_V1,
  decodeArtifactBlobHeaderV1,
  encodeArtifactBlobChunkFrameV1,
  encodeArtifactBlobHeaderV1,
} from "@nautilo/lattice-crypto/wire";
import { artifactBlobStorageRefV1 } from "./artifact-repository.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_BYTES = 32;
const MAX_CIPHERTEXT_BYTES = ARTIFACT_BLOB_MAX_FILE_BYTES;
const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;
const MAX_RECONCILE_LIMIT = 256;
const MAX_RECONCILE_SCAN = 1_024;
const TARGET_SUFFIX = ".artifact-blob-v1";
const TEMP_SUFFIX = `${TARGET_SUFFIX}.tmp`;
const QUARANTINE_SUFFIX = `${TARGET_SUFFIX}.quarantine`;

export interface ArtifactBlobFilesystemFileV1 {
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<Readonly<{ bytesRead: number }>>;
  stat(): Promise<Stats>;
  sync(): Promise<void>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<Readonly<{ bytesWritten: number }>>;
}

export interface ArtifactBlobFilesystemV1 {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(
    path: string,
    flags: string,
    mode?: number,
  ): Promise<ArtifactBlobFilesystemFileV1>;
  chmod(path: string, mode: number): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<Stats>;
  listBounded(path: string, limit: number): Promise<readonly string[]>;
}

const nodeFilesystem: ArtifactBlobFilesystemV1 = Object.freeze({
  mkdir,
  open,
  chmod,
  link,
  unlink,
  lstat,
  async listBounded(path: string, limit: number) {
    const names: string[] = [];
    const directory = await opendir(path);
    // Async iteration owns and closes the directory, including on `break`.
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length >= limit) break;
    }
    return names;
  },
});

export interface EncryptedArtifactBlobReferenceV1 {
  readonly artifactId: string;
  readonly blobId: string;
  readonly blobGeneration: number;
  readonly plaintextLength: number;
  readonly ciphertextLength: number;
  readonly ciphertextSha256: Uint8Array;
  readonly chunkPlaintextBytes:
    typeof ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES;
  readonly chunkCount: number;
}

export type EncryptedArtifactBlobPublicationV1 =
  | Readonly<{
    status: "published" | "replayed";
    reference: EncryptedArtifactBlobReferenceV1;
  }>
  | Readonly<{
    status: "quarantined";
    reason: "immutable_collision";
  }>;

export type EncryptedArtifactBlobVerificationV1 =
  | Readonly<{ status: "exact" }>
  | Readonly<{ status: "missing" }>
  | Readonly<{
    status: "mismatch";
    reason: "not_regular_file" | "length" | "hash";
  }>;

export interface EncryptedArtifactBlobStoredFactsV1 {
  readonly artifactId: string;
  readonly blobId: string;
  readonly blobGeneration: number;
  readonly ciphertextLength: number;
  readonly ciphertextSha256: Uint8Array;
}

export type EncryptedArtifactBlobInspectionV1 =
  | Readonly<{
    status: "exact";
    reference: EncryptedArtifactBlobReferenceV1;
  }>
  | Readonly<{ status: "missing" }>
  | Readonly<{
    status: "mismatch";
    reason: "not_regular_file" | "length" | "hash" | "header";
  }>;

export interface EncryptedArtifactBlobReconciliationV1 {
  readonly scanned: number;
  readonly cleaned: number;
  readonly retained: number;
  readonly failed: number;
  readonly scanBoundReached: boolean;
}

export interface EncryptedArtifactBlobStoreV1 {
  publish(input: Readonly<{
    crypto: LatticeCrypto;
    artifactId: string;
    blobId: string;
    blobGeneration: number;
    plaintextLength: number;
    blobDek: Uint8Array;
    plaintext: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    expectedReplay?: EncryptedArtifactBlobReferenceV1;
  }>): Promise<EncryptedArtifactBlobPublicationV1>;
  publishCiphertext(input: Readonly<{
    artifactId: string;
    blobId: string;
    blobGeneration: number;
    ciphertextLength: number;
    ciphertextSha256: Uint8Array;
    ciphertext: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    expectedReplay?: EncryptedArtifactBlobReferenceV1;
  }>): Promise<EncryptedArtifactBlobPublicationV1>;
  verify(
    reference: EncryptedArtifactBlobReferenceV1,
  ): Promise<EncryptedArtifactBlobVerificationV1>;
  inspectStored(
    stored: EncryptedArtifactBlobStoredFactsV1,
  ): Promise<EncryptedArtifactBlobInspectionV1>;
  readCiphertextRange<Value>(input: Readonly<{
    reference: EncryptedArtifactBlobReferenceV1;
    start: number;
    endExclusive: number;
    consume(range: Readonly<{
      header: ArtifactBlobHeader;
      firstChunkIndex: number;
      sealedChunks: readonly Uint8Array[];
    }>): Value | PromiseLike<Value>;
  }>): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: "missing" | "mismatch" }>
  >;
  openRange<Value>(input: Readonly<{
    crypto: LatticeCrypto;
    blobDek: Uint8Array;
    reference: EncryptedArtifactBlobReferenceV1;
    start: number;
    endExclusive: number;
    consume(opened: Uint8Array): Value | PromiseLike<Value>;
  }>): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: "missing" | "mismatch" }>
  >;
  reconcileOrphans(input: Readonly<{
    liveBlobIds: ReadonlySet<string>;
    limit: number;
  }>): Promise<EncryptedArtifactBlobReconciliationV1>;
}

function exactUuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function exactInteger(
  label: string,
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) throw new RangeError(`${label} is outside its supported range`);
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && timingSafeEqual(left, right);
}

function validateReference(
  value: EncryptedArtifactBlobReferenceV1,
): EncryptedArtifactBlobReferenceV1 {
  const actual = Object.keys(value).sort();
  const expected = [
    "artifactId",
    "blobGeneration",
    "blobId",
    "chunkCount",
    "chunkPlaintextBytes",
    "ciphertextLength",
    "ciphertextSha256",
    "plaintextLength",
  ].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) throw new TypeError("Encrypted Artifact blob reference fields must be exact");
  const plaintextLength = exactInteger(
    "Artifact plaintext length",
    value.plaintextLength,
    0,
    ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES,
  );
  const chunkCount = deriveArtifactBlobChunkCount(plaintextLength);
  if (
    value.chunkPlaintextBytes !== ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES
    || value.chunkCount !== chunkCount
    || !(value.ciphertextSha256 instanceof Uint8Array)
    || value.ciphertextSha256.length !== SHA256_BYTES
  ) throw new TypeError("Encrypted Artifact blob reference is incoherent");
  return Object.freeze({
    artifactId: exactUuid("Artifact id", value.artifactId),
    blobId: exactUuid("Artifact blob id", value.blobId),
    blobGeneration: exactInteger(
      "Artifact blob generation",
      value.blobGeneration,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    plaintextLength,
    ciphertextLength: exactInteger(
      "Artifact ciphertext length",
      value.ciphertextLength,
      1,
      MAX_CIPHERTEXT_BYTES,
    ),
    ciphertextSha256: value.ciphertextSha256.slice(),
    chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
    chunkCount,
  });
}

function validateStoredFacts(
  value: EncryptedArtifactBlobStoredFactsV1,
): EncryptedArtifactBlobStoredFactsV1 {
  const actual = Object.keys(value).sort();
  const expected = [
    "artifactId",
    "blobGeneration",
    "blobId",
    "ciphertextLength",
    "ciphertextSha256",
  ].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) throw new TypeError("Stored encrypted Artifact blob facts must be exact");
  if (
    !(value.ciphertextSha256 instanceof Uint8Array)
    || value.ciphertextSha256.length !== SHA256_BYTES
  ) throw new TypeError("Stored encrypted Artifact blob hash is invalid");
  return Object.freeze({
    artifactId: exactUuid("Artifact id", value.artifactId),
    blobId: exactUuid("Artifact blob id", value.blobId),
    blobGeneration: exactInteger(
      "Artifact blob generation",
      value.blobGeneration,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    ciphertextLength: exactInteger(
      "Artifact ciphertext length",
      value.ciphertextLength,
      1,
      MAX_CIPHERTEXT_BYTES,
    ),
    ciphertextSha256: value.ciphertextSha256.slice(),
  });
}

function headerFromReference(
  reference: EncryptedArtifactBlobReferenceV1,
): ArtifactBlobHeader {
  return Object.freeze({
    formatVersion: ARTIFACT_BLOB_FORMAT_VERSION_V1,
    artifactId: reference.artifactId,
    blobId: reference.blobId,
    blobGeneration: reference.blobGeneration,
    plaintextLength: reference.plaintextLength,
    chunkPlaintextBytes: reference.chunkPlaintextBytes,
    chunkCount: reference.chunkCount,
  });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isCollision(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function writeAll(
  handle: ArtifactBlobFilesystemFileV1,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (result.bytesWritten < 1) throw new Error("Artifact blob write made no progress");
    offset += result.bytesWritten;
  }
}

async function readExact(
  handle: ArtifactBlobFilesystemFileV1,
  target: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < target.length) {
    const result = await handle.read(
      target,
      offset,
      target.length - offset,
      position + offset,
    );
    if (result.bytesRead < 1) throw new Error("Artifact blob ended unexpectedly");
    offset += result.bytesRead;
  }
}

function chunkPlaintextLength(
  reference: EncryptedArtifactBlobReferenceV1,
  chunkIndex: number,
): number {
  if (reference.plaintextLength === 0) return 0;
  return Math.min(
    reference.chunkPlaintextBytes,
    reference.plaintextLength - chunkIndex * reference.chunkPlaintextBytes,
  );
}

async function hashFile(
  filesystem: ArtifactBlobFilesystemV1,
  path: string,
): Promise<Readonly<{ length: number; sha256: Uint8Array; regular: boolean }>> {
  let handle: ArtifactBlobFilesystemFileV1 | undefined;
  try {
    const pathStat = await filesystem.lstat(path);
    if (!pathStat.isFile()) {
      return { length: pathStat.size, sha256: new Uint8Array(), regular: false };
    }
    handle = await filesystem.open(path, "r");
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || stat.dev !== pathStat.dev
      || stat.ino !== pathStat.ino
    ) return { length: stat.size, sha256: new Uint8Array(), regular: false };
    if (stat.size < 1 || stat.size > MAX_CIPHERTEXT_BYTES) {
      return { length: stat.size, sha256: new Uint8Array(), regular: true };
    }
    const hash = createHash("sha256");
    const buffer = new Uint8Array(ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES);
    let position = 0;
    try {
      while (position < stat.size) {
        const length = Math.min(buffer.length, stat.size - position);
        const read = await handle.read(buffer, 0, length, position);
        if (read.bytesRead < 1) throw new Error("Artifact blob read made no progress");
        hash.update(buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
    } finally {
      buffer.fill(0);
    }
    return {
      length: stat.size,
      sha256: new Uint8Array(hash.digest()),
      regular: true,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(
  filesystem: ArtifactBlobFilesystemV1,
  directory: string,
): Promise<void> {
  let handle: ArtifactBlobFilesystemFileV1 | undefined;
  try {
    handle = await filesystem.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function targetName(blobId: string): string {
  return artifactBlobStorageRefV1(blobId);
}

function blobIdFromTarget(name: string): string | null {
  if (!name.endsWith(TARGET_SUFFIX) || name.startsWith(".")) return null;
  const blobId = name.slice(0, -TARGET_SUFFIX.length);
  return UUID.test(blobId) ? blobId : null;
}

/**
 * Local immutable ciphertext storage only. Importing or constructing the store
 * performs no I/O; every operation is explicit and retains no cryptographic key.
 */
export function createFilesystemEncryptedArtifactBlobStoreV1(options: Readonly<{
  rootDirectory: string;
  filesystem?: ArtifactBlobFilesystemV1;
  createToken?(): string;
  now?(): number;
  orphanGraceMs?: number;
}>): EncryptedArtifactBlobStoreV1 {
  const rootDirectory = resolve(options.rootDirectory);
  const filesystem = options.filesystem ?? nodeFilesystem;
  const createToken = options.createToken ?? randomUUID;
  const now = options.now ?? Date.now;
  const orphanGraceMs = exactInteger(
    "Artifact orphan grace",
    options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS,
    0,
    30 * 24 * 60 * 60 * 1_000,
  );

  const pathFor = (name: string): string => {
    if (basename(name) !== name || name.includes("/") || name.includes("\\")) {
      throw new TypeError("Artifact blob filename is invalid");
    }
    return resolve(rootDirectory, name);
  };

  async function ensureRoot(): Promise<void> {
    await filesystem.mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    const rootStat = await filesystem.lstat(rootDirectory);
    if (!rootStat.isDirectory()) {
      throw new TypeError("Artifact blob root must be a real directory");
    }
  }

  async function quarantineNoReplace(
    sourcePath: string,
    blobId: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = createToken();
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(token)) {
        throw new TypeError("Artifact quarantine token is invalid");
      }
      const quarantinePath = pathFor(
        `.${blobId}.${token}${QUARANTINE_SUFFIX}`,
      );
      try {
        await filesystem.link(sourcePath, quarantinePath);
        await filesystem.unlink(sourcePath);
        return quarantinePath;
      } catch (error) {
        if (!isCollision(error)) throw error;
      }
    }
    throw new Error("Artifact quarantine namespace is exhausted");
  }

  async function verify(
    untrusted: EncryptedArtifactBlobReferenceV1,
  ): Promise<EncryptedArtifactBlobVerificationV1> {
    const reference = validateReference(untrusted);
    let observed: Awaited<ReturnType<typeof hashFile>>;
    try {
      observed = await hashFile(filesystem, pathFor(targetName(reference.blobId)));
    } catch (error) {
      if (isMissing(error)) return { status: "missing" };
      throw error;
    }
    if (!observed.regular) {
      return { status: "mismatch", reason: "not_regular_file" };
    }
    if (observed.length !== reference.ciphertextLength) {
      return { status: "mismatch", reason: "length" };
    }
    return sameBytes(observed.sha256, reference.ciphertextSha256)
      ? { status: "exact" }
      : { status: "mismatch", reason: "hash" };
  }

  async function authenticateAndReadRange(input: Readonly<{
    reference: EncryptedArtifactBlobReferenceV1;
    start: number;
    endExclusive: number;
  }>): Promise<
    | Readonly<{
      status: "opened";
      header: ArtifactBlobHeader;
      firstChunkIndex: number;
      sealedChunks: readonly Uint8Array[];
    }>
    | Readonly<{ status: "unavailable"; reason: "missing" | "mismatch" }>
  > {
    const { reference } = input;
    exactInteger("Artifact range start", input.start, 0, reference.plaintextLength);
    exactInteger(
      "Artifact range end",
      input.endExclusive,
      input.start,
      reference.plaintextLength,
    );
    const path = pathFor(targetName(reference.blobId));
    let pathStat: Stats;
    let handle: ArtifactBlobFilesystemFileV1 | undefined;
    const retainedChunks = new Map<number, Uint8Array>();
    let transferred = false;
    try {
      try {
        pathStat = await filesystem.lstat(path);
        if (!pathStat.isFile()) {
          return { status: "unavailable", reason: "mismatch" };
        }
        handle = await filesystem.open(path, "r");
      } catch (error) {
        if (isMissing(error)) return { status: "unavailable", reason: "missing" };
        throw error;
      }
      const stat = await handle.stat();
      if (
        !stat.isFile()
        || stat.dev !== pathStat.dev
        || stat.ino !== pathStat.ino
        || stat.size !== reference.ciphertextLength
      ) return { status: "unavailable", reason: "mismatch" };

      const hash = createHash("sha256");
      const header = headerFromReference(reference);
      const expectedHeader = encodeArtifactBlobHeaderV1(header);
      const observedHeader = new Uint8Array(expectedHeader.length);
      let position = 0;
      try {
        await readExact(handle, observedHeader, position);
        position += observedHeader.length;
        hash.update(observedHeader);
        if (!sameBytes(observedHeader, expectedHeader)) {
          return { status: "unavailable", reason: "mismatch" };
        }
      } finally {
        observedHeader.fill(0);
        expectedHeader.fill(0);
      }

      const firstChunk = Math.floor(input.start / reference.chunkPlaintextBytes);
      const lastChunk = input.endExclusive === input.start
        ? -1
        : Math.floor((input.endExclusive - 1) / reference.chunkPlaintextBytes);
      const scratch = new Uint8Array(ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES);
      try {
        for (let chunkIndex = 0; chunkIndex < reference.chunkCount; chunkIndex += 1) {
          const prefix = new Uint8Array(4);
          await readExact(handle, prefix, position);
          position += prefix.length;
          hash.update(prefix);
          const sealedLength = new DataView(
            prefix.buffer,
            prefix.byteOffset,
            prefix.byteLength,
          ).getUint32(0, false);
          prefix.fill(0);
          const expectedSealedLength = artifactBlobSealedChunkBytes(
            chunkPlaintextLength(reference, chunkIndex),
          );
          if (sealedLength !== expectedSealedLength) {
            return { status: "unavailable", reason: "mismatch" };
          }
          const retain = chunkIndex >= firstChunk && chunkIndex <= lastChunk;
          if (retain) {
            const sealed = new Uint8Array(sealedLength);
            await readExact(handle, sealed, position);
            hash.update(sealed);
            retainedChunks.set(chunkIndex, sealed);
          } else {
            let remaining = sealedLength;
            while (remaining > 0) {
              const length = Math.min(scratch.length, remaining);
              await readExact(handle, scratch.subarray(0, length), position + sealedLength - remaining);
              hash.update(scratch.subarray(0, length));
              remaining -= length;
            }
          }
          position += sealedLength;
        }
      } finally {
        scratch.fill(0);
      }
      const finalStat = await handle.stat();
      if (
        position !== reference.ciphertextLength
        || finalStat.size !== stat.size
        || !sameBytes(new Uint8Array(hash.digest()), reference.ciphertextSha256)
      ) return { status: "unavailable", reason: "mismatch" };

      const sealedChunks: Uint8Array[] = [];
      for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
        const sealed = retainedChunks.get(chunkIndex);
        if (sealed === undefined) throw new Error("Artifact range chunk was not retained");
        sealedChunks.push(sealed);
      }
      transferred = true;
      return Object.freeze({
        status: "opened" as const,
        header,
        firstChunkIndex: firstChunk,
        sealedChunks: Object.freeze(sealedChunks),
      });
    } finally {
      if (!transferred) {
        for (const sealed of retainedChunks.values()) sealed.fill(0);
      }
      await handle?.close().catch(() => undefined);
    }
  }

  async function inspectStored(
    untrusted: EncryptedArtifactBlobStoredFactsV1,
  ): Promise<EncryptedArtifactBlobInspectionV1> {
    const stored = validateStoredFacts(untrusted);
    const path = pathFor(targetName(stored.blobId));
    let handle: ArtifactBlobFilesystemFileV1 | undefined;
    const headerProbe = encodeArtifactBlobHeaderV1({
      formatVersion: ARTIFACT_BLOB_FORMAT_VERSION_V1,
      artifactId: stored.artifactId,
      blobId: stored.blobId,
      blobGeneration: stored.blobGeneration,
      plaintextLength: 0,
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
      chunkCount: 1,
    });
    const headerBytes = new Uint8Array(headerProbe.length);
    headerProbe.fill(0);
    try {
      let pathStat: Stats;
      try {
        pathStat = await filesystem.lstat(path);
        if (!pathStat.isFile()) {
          return { status: "mismatch", reason: "not_regular_file" };
        }
        handle = await filesystem.open(path, "r");
      } catch (error) {
        if (isMissing(error)) return { status: "missing" };
        throw error;
      }
      const stat = await handle.stat();
      if (
        !stat.isFile()
        || stat.dev !== pathStat.dev
        || stat.ino !== pathStat.ino
      ) return { status: "mismatch", reason: "not_regular_file" };
      if (stat.size !== stored.ciphertextLength) {
        return { status: "mismatch", reason: "length" };
      }

      const hash = createHash("sha256");
      const buffer = new Uint8Array(ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES);
      let position = 0;
      try {
        while (position < stat.size) {
          const length = Math.min(buffer.length, stat.size - position);
          const read = await handle.read(buffer, 0, length, position);
          if (read.bytesRead < 1) throw new Error("Artifact blob read made no progress");
          hash.update(buffer.subarray(0, read.bytesRead));
          if (position < headerBytes.length) {
            const copied = Math.min(read.bytesRead, headerBytes.length - position);
            headerBytes.set(buffer.subarray(0, copied), position);
          }
          position += read.bytesRead;
        }
      } finally {
        buffer.fill(0);
      }
      const finalStat = await handle.stat();
      if (finalStat.size !== stat.size) {
        return { status: "mismatch", reason: "length" };
      }
      if (!sameBytes(new Uint8Array(hash.digest()), stored.ciphertextSha256)) {
        return { status: "mismatch", reason: "hash" };
      }

      let header: ArtifactBlobHeader;
      try {
        header = decodeArtifactBlobHeaderV1(headerBytes);
      } catch {
        return { status: "mismatch", reason: "header" };
      }
      if (
        header.artifactId !== stored.artifactId
        || header.blobId !== stored.blobId
        || header.blobGeneration !== stored.blobGeneration
      ) return { status: "mismatch", reason: "header" };
      return {
        status: "exact",
        reference: validateReference({
          artifactId: header.artifactId,
          blobId: header.blobId,
          blobGeneration: header.blobGeneration,
          plaintextLength: header.plaintextLength,
          ciphertextLength: stored.ciphertextLength,
          ciphertextSha256: stored.ciphertextSha256,
          chunkPlaintextBytes: header.chunkPlaintextBytes,
          chunkCount: header.chunkCount,
        }),
      };
    } finally {
      headerBytes.fill(0);
      await handle?.close().catch(() => undefined);
    }
  }

  async function publishCiphertext(
    input: Parameters<EncryptedArtifactBlobStoreV1["publishCiphertext"]>[0],
  ): Promise<EncryptedArtifactBlobPublicationV1> {
    await ensureRoot();
    const stored = validateStoredFacts({
      artifactId: input.artifactId,
      blobId: input.blobId,
      blobGeneration: input.blobGeneration,
      ciphertextLength: input.ciphertextLength,
      ciphertextSha256: input.ciphertextSha256,
    });
    if (input.expectedReplay !== undefined) {
      const expected = validateReference(input.expectedReplay);
      if (
        expected.artifactId !== stored.artifactId
        || expected.blobId !== stored.blobId
        || expected.blobGeneration !== stored.blobGeneration
        || expected.ciphertextLength !== stored.ciphertextLength
        || !sameBytes(expected.ciphertextSha256, stored.ciphertextSha256)
      ) throw new TypeError("Artifact ciphertext replay coordinates were substituted");
      stored.ciphertextSha256.fill(0);
      return (await verify(expected)).status === "exact"
        ? { status: "replayed", reference: expected }
        : { status: "quarantined", reason: "immutable_collision" };
    }
    const token = createToken();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(token)) {
      throw new TypeError("Artifact blob temporary token is invalid");
    }
    const temporaryPath = pathFor(`.${stored.blobId}.${token}${TEMP_SUFFIX}`);
    const targetPath = pathFor(targetName(stored.blobId));
    let handle: ArtifactBlobFilesystemFileV1 | undefined;
    let temporaryExists = false;
    const hash = createHash("sha256");
    let length = 0;
    try {
      handle = await filesystem.open(temporaryPath, "wx", 0o600);
      temporaryExists = true;
      await filesystem.chmod(temporaryPath, 0o600);
      for await (const source of input.ciphertext) {
        if (!(source instanceof Uint8Array) || source.length === 0) {
          throw new TypeError("Artifact ciphertext stream yielded invalid bytes");
        }
        length += source.length;
        if (length > stored.ciphertextLength) {
          throw new RangeError("Artifact ciphertext stream exceeded its declared length");
        }
        await writeAll(handle, source);
        hash.update(source);
      }
      if (length !== stored.ciphertextLength) {
        throw new RangeError("Artifact ciphertext stream ended before its declared length");
      }
      const observedHash = new Uint8Array(hash.digest());
      try {
        if (!sameBytes(observedHash, stored.ciphertextSha256)) {
          throw new Error("Artifact ciphertext stream hash disagrees");
        }
      } finally {
        observedHash.fill(0);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;

      const probe = encodeArtifactBlobHeaderV1({
        formatVersion: ARTIFACT_BLOB_FORMAT_VERSION_V1,
        artifactId: stored.artifactId,
        blobId: stored.blobId,
        blobGeneration: stored.blobGeneration,
        plaintextLength: 0,
        chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
        chunkCount: 1,
      });
      const headerBytes = new Uint8Array(probe.length);
      probe.fill(0);
      let reader: ArtifactBlobFilesystemFileV1 | undefined;
      let header: ArtifactBlobHeader;
      try {
        reader = await filesystem.open(temporaryPath, "r");
        await readExact(reader, headerBytes, 0);
        header = decodeArtifactBlobHeaderV1(headerBytes);
      } finally {
        headerBytes.fill(0);
        await reader?.close().catch(() => undefined);
      }
      if (
        header.artifactId !== stored.artifactId
        || header.blobId !== stored.blobId
        || header.blobGeneration !== stored.blobGeneration
      ) throw new Error("Artifact ciphertext header coordinates disagree");
      const reference = validateReference({
        artifactId: header.artifactId,
        blobId: header.blobId,
        blobGeneration: header.blobGeneration,
        plaintextLength: header.plaintextLength,
        ciphertextLength: stored.ciphertextLength,
        ciphertextSha256: stored.ciphertextSha256,
        chunkPlaintextBytes: header.chunkPlaintextBytes,
        chunkCount: header.chunkCount,
      });
      try {
        await filesystem.link(temporaryPath, targetPath);
        await filesystem.unlink(temporaryPath);
        temporaryExists = false;
        await syncDirectory(filesystem, rootDirectory);
        return { status: "published", reference };
      } catch (error) {
        if (!isCollision(error)) throw error;
        if ((await verify(reference)).status === "exact") {
          await filesystem.unlink(temporaryPath);
          temporaryExists = false;
          await syncDirectory(filesystem, rootDirectory);
          return { status: "replayed", reference };
        }
        await quarantineNoReplace(temporaryPath, stored.blobId);
        temporaryExists = false;
        await syncDirectory(filesystem, rootDirectory);
        return { status: "quarantined", reason: "immutable_collision" };
      }
    } finally {
      stored.ciphertextSha256.fill(0);
      await handle?.close().catch(() => undefined);
      if (temporaryExists) {
        await filesystem.unlink(temporaryPath).catch(() => undefined);
        await syncDirectory(filesystem, rootDirectory).catch(() => undefined);
      }
    }
  }

  return Object.freeze({
    verify,
    inspectStored,
    publishCiphertext,

    async publish(
      input: Parameters<EncryptedArtifactBlobStoreV1["publish"]>[0],
    ): Promise<EncryptedArtifactBlobPublicationV1> {
      await ensureRoot();
      const header: ArtifactBlobHeader = Object.freeze({
        formatVersion: ARTIFACT_BLOB_FORMAT_VERSION_V1,
        artifactId: exactUuid("Artifact id", input.artifactId),
        blobId: exactUuid("Artifact blob id", input.blobId),
        blobGeneration: exactInteger(
          "Artifact blob generation",
          input.blobGeneration,
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        plaintextLength: exactInteger(
          "Artifact plaintext length",
          input.plaintextLength,
          0,
          ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES,
        ),
        chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
        chunkCount: deriveArtifactBlobChunkCount(input.plaintextLength),
      });
      if (input.expectedReplay !== undefined) {
        const expectedReplay = validateReference(input.expectedReplay);
        if (
          expectedReplay.artifactId !== header.artifactId
          || expectedReplay.blobId !== header.blobId
          || expectedReplay.blobGeneration !== header.blobGeneration
          || expectedReplay.plaintextLength !== header.plaintextLength
        ) throw new TypeError("Artifact replay coordinates were substituted");
        return (await verify(expectedReplay)).status === "exact"
          ? { status: "replayed", reference: expectedReplay }
          : { status: "quarantined", reason: "immutable_collision" };
      }

      const token = createToken();
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(token)) {
        throw new TypeError("Artifact blob temporary token is invalid");
      }
      const temporaryPath = pathFor(`.${header.blobId}.${token}${TEMP_SUFFIX}`);
      const targetPath = pathFor(targetName(header.blobId));
      let handle: ArtifactBlobFilesystemFileV1 | undefined;
      let temporaryExists = false;
      const hash = createHash("sha256");
      let ciphertextLength = 0;
      const writeCiphertext = async (bytes: Uint8Array): Promise<void> => {
        if (ciphertextLength + bytes.length > MAX_CIPHERTEXT_BYTES) {
          throw new RangeError("Artifact ciphertext exceeds its supported bound");
        }
        await writeAll(handle!, bytes);
        hash.update(bytes);
        ciphertextLength += bytes.length;
      };
      try {
        handle = await filesystem.open(temporaryPath, "wx", 0o600);
        temporaryExists = true;
        await filesystem.chmod(temporaryPath, 0o600);
        await writeCiphertext(encodeArtifactBlobHeaderV1(header));

        const chunk = new Uint8Array(ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES);
        let chunkLength = 0;
        let plaintextLength = 0;
        let chunkIndex = 0;
        const sealChunk = async (plaintextChunk: Uint8Array): Promise<void> => {
          const sealed = sealArtifactBlobChunk(input.crypto, {
            header,
            blobDek: input.blobDek,
            chunkIndex,
            plaintextChunk,
          });
          const frame = encodeArtifactBlobChunkFrameV1(sealed);
          try {
            await writeCiphertext(frame);
          } finally {
            sealed.fill(0);
            frame.fill(0);
          }
          chunkIndex += 1;
        };
        try {
          for await (const source of input.plaintext) {
            if (!(source instanceof Uint8Array)) {
              throw new TypeError("Artifact plaintext stream yielded non-bytes");
            }
            let offset = 0;
            while (offset < source.length) {
              const copied = Math.min(chunk.length - chunkLength, source.length - offset);
              chunk.set(source.subarray(offset, offset + copied), chunkLength);
              chunkLength += copied;
              plaintextLength += copied;
              offset += copied;
              if (plaintextLength > header.plaintextLength) {
                throw new RangeError("Artifact plaintext stream exceeded its declared length");
              }
              if (chunkLength === chunk.length) {
                await sealChunk(chunk);
                chunk.fill(0);
                chunkLength = 0;
              }
            }
          }
          if (plaintextLength !== header.plaintextLength) {
            throw new RangeError("Artifact plaintext stream ended before its declared length");
          }
          if (chunkLength > 0) {
            const finalChunk = chunk.slice(0, chunkLength);
            try {
              await sealChunk(finalChunk);
            } finally {
              finalChunk.fill(0);
            }
          } else if (plaintextLength === 0) {
            await sealChunk(new Uint8Array(0));
          }
          if (chunkIndex !== header.chunkCount) {
            throw new Error("Artifact plaintext stream produced an inexact chunk count");
          }
        } finally {
          chunk.fill(0);
        }

        await handle.sync();
        await handle.close();
        handle = undefined;
        const reference = validateReference({
          artifactId: header.artifactId,
          blobId: header.blobId,
          blobGeneration: header.blobGeneration,
          plaintextLength: header.plaintextLength,
          ciphertextLength,
          ciphertextSha256: new Uint8Array(hash.digest()),
          chunkPlaintextBytes: header.chunkPlaintextBytes,
          chunkCount: header.chunkCount,
        });

        try {
          // `rename(2)` overwrites on POSIX. A same-directory hard-link is the
          // portable atomic no-replace publication primitive for this immutable
          // file; unlinking the temporary name completes the rename semantics.
          await filesystem.link(temporaryPath, targetPath);
          await filesystem.unlink(temporaryPath);
          temporaryExists = false;
          await syncDirectory(filesystem, rootDirectory);
          return { status: "published", reference };
        } catch (error) {
          if (!isCollision(error)) throw error;
          const current = await verify(reference);
          if (current.status === "exact") {
            await filesystem.unlink(temporaryPath);
            temporaryExists = false;
            await syncDirectory(filesystem, rootDirectory);
            return { status: "replayed", reference };
          }
          await quarantineNoReplace(temporaryPath, header.blobId);
          temporaryExists = false;
          await syncDirectory(filesystem, rootDirectory);
          return { status: "quarantined", reason: "immutable_collision" };
        }
      } finally {
        await handle?.close().catch(() => undefined);
        if (temporaryExists) {
          await filesystem.unlink(temporaryPath).catch(() => undefined);
          await syncDirectory(filesystem, rootDirectory).catch(() => undefined);
        }
      }
    },

    async readCiphertextRange<Value>(input: Readonly<{
      reference: EncryptedArtifactBlobReferenceV1;
      start: number;
      endExclusive: number;
      consume(range: Readonly<{
        header: ArtifactBlobHeader;
        firstChunkIndex: number;
        sealedChunks: readonly Uint8Array[];
      }>): Value | PromiseLike<Value>;
    }>) {
      const reference = validateReference(input.reference);
      const read = await authenticateAndReadRange({
        reference,
        start: input.start,
        endExclusive: input.endExclusive,
      });
      if (read.status !== "opened") return read;
      try {
        return {
          status: "opened" as const,
          value: await input.consume({
            header: read.header,
            firstChunkIndex: read.firstChunkIndex,
            sealedChunks: read.sealedChunks,
          }),
        };
      } finally {
        read.sealedChunks.forEach((sealed) => sealed.fill(0));
      }
    },

    async openRange<Value>(input: Readonly<{
      crypto: LatticeCrypto;
      blobDek: Uint8Array;
      reference: EncryptedArtifactBlobReferenceV1;
      start: number;
      endExclusive: number;
      consume(opened: Uint8Array): Value | PromiseLike<Value>;
    }>) {
      const reference = validateReference(input.reference);
      const read = await authenticateAndReadRange({
        reference,
        start: input.start,
        endExclusive: input.endExclusive,
      });
      if (read.status !== "opened") return read;
      const opened = new Uint8Array(input.endExclusive - input.start);
      try {
        for (let offset = 0; offset < read.sealedChunks.length; offset += 1) {
          const chunkIndex = read.firstChunkIndex + offset;
          const plaintextChunk = openArtifactBlobChunk(input.crypto, {
            header: read.header,
            blobDek: input.blobDek,
            chunkIndex,
            sealedChunk: read.sealedChunks[offset]!,
          });
          try {
            const chunkStart = chunkIndex * reference.chunkPlaintextBytes;
            const copyStart = Math.max(input.start, chunkStart);
            const copyEnd = Math.min(
              input.endExclusive,
              chunkStart + plaintextChunk.length,
            );
            opened.set(
              plaintextChunk.subarray(
                copyStart - chunkStart,
                copyEnd - chunkStart,
              ),
              copyStart - input.start,
            );
          } finally {
            plaintextChunk.fill(0);
          }
        }
        return {
          status: "opened" as const,
          value: await input.consume(opened),
        };
      } finally {
        opened.fill(0);
        read.sealedChunks.forEach((sealed) => sealed.fill(0));
      }
    },

    async reconcileOrphans(
      input: Parameters<EncryptedArtifactBlobStoreV1["reconcileOrphans"]>[0],
    ): Promise<EncryptedArtifactBlobReconciliationV1> {
      await ensureRoot();
      const limit = exactInteger(
        "Artifact orphan reconciliation limit",
        input.limit,
        1,
        MAX_RECONCILE_LIMIT,
      );
      for (const blobId of input.liveBlobIds) exactUuid("Live Artifact blob id", blobId);
      const scanLimit = Math.min(MAX_RECONCILE_SCAN, limit * 4);
      const names = await filesystem.listBounded(rootDirectory, scanLimit);
      let cleaned = 0;
      let retained = 0;
      let failed = 0;
      for (const name of names) {
        if (cleaned >= limit) break;
        const blobId = blobIdFromTarget(name);
        const identifiablePartial = name.startsWith(".")
          && (name.endsWith(TEMP_SUFFIX) || name.endsWith(QUARANTINE_SUFFIX));
        if (blobId === null && !identifiablePartial) {
          retained += 1;
          continue;
        }
        if (blobId !== null && input.liveBlobIds.has(blobId)) {
          retained += 1;
          continue;
        }
        const path = pathFor(name);
        try {
          const stat = await filesystem.lstat(path);
          if (!stat.isFile() || stat.mtimeMs > now() - orphanGraceMs) {
            retained += 1;
            continue;
          }
          if (blobId !== null) {
            const quarantinePath = await quarantineNoReplace(path, blobId);
            await filesystem.unlink(quarantinePath);
          } else {
            await filesystem.unlink(path);
          }
          cleaned += 1;
        } catch (error) {
          if (!isMissing(error)) failed += 1;
        }
      }
      if (cleaned > 0) await syncDirectory(filesystem, rootDirectory);
      return Object.freeze({
        scanned: names.length,
        cleaned,
        retained,
        failed,
        scanBoundReached: names.length === scanLimit,
      });
    },
  });
}
