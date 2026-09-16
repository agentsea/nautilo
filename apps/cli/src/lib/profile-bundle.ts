/**
 * CLI-only filesystem and artifact-sidecar helpers for the canonical profile
 * envelope in @nautilo/profile-portability. The profile/avatar/memory JSON
 * envelope itself intentionally has no second implementation here.
 */
import { chmod, mkdir, rename, stat, unlink, writeFile, readFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import {
  canonicalJsonBytes, container, decryptProfileBundleFile, encryptProfileBundleFile,
  headerFromJson, parseProfileBundleFile, protection, ProfileBundleFileError,
  serializeProfileBundleFile, sha256, semantic, WrongPassphraseError,
  type Argon2idDeriveFn, type Argon2idParams, type AvatarMedia, type ProfileBundleFile,
  type ProfileBundleArtifactStreamRef,
} from "@nautilo/profile-portability";

export {
  decryptProfileBundleFile, encryptProfileBundleFile, headerFromJson,
  parseProfileBundleFile, ProfileBundleFileError, serializeProfileBundleFile,
  WrongPassphraseError, type Argon2idDeriveFn, type Argon2idParams, type AvatarMedia,
  type ProfileBundleFile, type ProfileBundleArtifactStreamRef,
};

const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const computeHeaderDigest = protection.computeHeaderDigest;
const generateDek = protection.generateDek;
type SemanticRecord = semantic.SemanticRecord;

export { generateDek };

function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}
// Filesystem IO (atomic, 0600) with injectable seams
// ---------------------------------------------------------------------------

export interface FsWriteDeps {
  readonly writeFile?: ((path: string, data: string, opts: { mode: number }) => Promise<void>) | undefined;
  readonly chmod?: ((path: string, mode: number) => Promise<void>) | undefined;
  readonly rename?: ((from: string, to: string) => Promise<void>) | undefined;
  readonly mkdir?: ((path: string, opts: { recursive: boolean }) => Promise<void>) | undefined;
  readonly unlink?: ((path: string) => Promise<void>) | undefined;
  readonly stat?: ((path: string) => Promise<{ mode: number }>) | undefined;
  readonly randomUUID?: (() => string) | undefined;
}

const MODE_0600 = 0o600;

/**
 * Write the bundle atomically with mode 0600. Refuses to overwrite an existing
 * file whose mode is not 0600 (defense against a too-permissive prior copy).
 */
export async function writeProfileBundleFileAtomically(
  finalPath: string,
  file: ProfileBundleFile,
  deps?: FsWriteDeps,
): Promise<void> {
  const writeFileFn = deps?.writeFile ?? writeFile;
  const chmodFn = deps?.chmod ?? chmod;
  const renameFn = deps?.rename ?? rename;
  const mkdirFn = deps?.mkdir ?? mkdir;
  const unlinkFn = deps?.unlink ?? unlink;
  const statFn = deps?.stat ?? stat;
  const uuid = deps?.randomUUID ?? randomUUID;

  const dir = dirname(finalPath);
  await mkdirFn(dir, { recursive: true });

  try {
    const st = await statFn(finalPath);
    const mode = st.mode & 0o777;
    if (mode !== MODE_0600) {
      throw new ProfileBundleFileError(
        `refusing to overwrite ${finalPath}: file mode is ${mode.toString(8)} (expected 0600)`,
      );
    }
  } catch (e) {
    if (e instanceof ProfileBundleFileError) throw e;
    /* absent — ok */
  }

  const tmp = join(dir, `.${basename(finalPath)}.${process.pid}.${uuid()}.tmp`);
  const payload = serializeProfileBundleFile(file);
  try {
    await writeFileFn(tmp, payload, { mode: MODE_0600 });
    await chmodFn(tmp, MODE_0600);
    await renameFn(tmp, finalPath);
    await chmodFn(finalPath, MODE_0600);
  } catch (e) {
    await unlinkFn(tmp).catch(() => undefined);
    throw e;
  }
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

export interface FsReadDeps {
  readonly readFile?: ((path: string) => Promise<string>) | undefined;
}

export async function readProfileBundleFile(
  path: string,
  deps?: FsReadDeps,
): Promise<ProfileBundleFile> {
  const readFileFn = deps?.readFile ?? ((p: string) => readFile(p, "utf-8"));
  const text = await readFileFn(path);
  return parseProfileBundleFile(text);
}

// ---------------------------------------------------------------------------
// Default Argon2id derive fn (real `argon2` runtime; injected by the command)
// ---------------------------------------------------------------------------

/**
 * Build the production `Argon2idDeriveFn` from the real `argon2` runtime. Kept
 * lazy so the `argon2` native binding is only touched when the command runs —
 * tests inject their own stand-in and never load this.
 */
export interface Argon2Runtime {
  readonly argon2id: 0 | 1 | 2;
  hash(
    password: Buffer,
    options: {
      type: 0 | 1 | 2;
      salt: Buffer;
      memoryCost: number;
      timeCost: number;
      parallelism: number;
      hashLength: number;
      raw: true;
    },
  ): Promise<Buffer>;
}

export function createArgon2idDeriveFn(argon2Module: Argon2Runtime): Argon2idDeriveFn {
  return async ({ passphrase, salt, params }) => {
    const password = Buffer.from(passphrase);
    const argonSalt = Buffer.from(salt);
    let out: Buffer | null = null;
    try {
      out = await argon2Module.hash(password, {
        type: argon2Module.argon2id,
        salt: argonSalt,
        memoryCost: params.memoryCostKiB,
        timeCost: params.timeCost,
        parallelism: params.parallelism,
        hashLength: params.outputLength,
        raw: true,
      });
      return new Uint8Array(out);
    } finally {
      password.fill(0);
      argonSalt.fill(0);
      out?.fill(0);
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers for the command: neutral default filename derivation
// ---------------------------------------------------------------------------

const FILE_EXT = ".nautilo-profile.json";

/**
 * Derive a neutral, name-derived default export filename from the bundle's
 * identity record. Falls back to a generic `nautilo-profile` stem when no
 * identity is present. Never hard-codes a vendor name.
 */
export function deriveDefaultExportFilename(records: readonly SemanticRecord[]): string {
  const identity = records.find((r): r is semantic.IdentityRecord => r.recordKind === "identity");
  const raw = identity?.name ?? "nautilo-profile";
  const slug = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const stem = slug.length >= 3 ? slug : "nautilo-profile";
  return `${stem}${FILE_EXT}`;
}

// ===========================================================================
// Wave 3 — format v2 streaming artifact-byte chunk serializer/deserializer
// ===========================================================================
//
// Real bounded-memory chunk framing for artifact bytes. Artifact bytes are
// opt-in and may be arbitrarily large product-wise, so they are streamed as a
// sequence of individually-authenticated AEAD chunk frames (one bounded chunk
// per frame) followed by one terminal artifact-manifest frame — never a JSON
// hex blob and never a whole-artifact Uint8Array. The serializer reads from
// async iterable readers one chunk at a time and writes frames to an async
// writer; the deserializer reads frames one at a time and dispatches
// plaintext chunks to a per-entry sink. Neither side ever holds a whole
// artifact in memory.
//
// Per-chunk AAD binds: immutable-header digest, artifact media version, entry
// path, chunk ordinal, finality, and plaintext length. Nonces are derived
// per (headerDigest, entryPath, ordinal) with an `"artifact-chunk"` domain tag,
// disjoint from the record-frame, DEK-wrap, and avatar domains. The terminal
// manifest frame authenticates per-entry size / sha256 / chunkCount and is
// cross-checked against the accumulated totals.
//
// Legacy v1 (avatar-only) read/write is untouched: these are additive exports
// used by later CLI/server code.

const ARTIFACT_STREAM_CHUNK_SIZE = 64 * 1024;
const ARTIFACT_MEDIA_VERSION = 2;
const ARTIFACT_FRAME_TYPE_CHUNK = 1;
const ARTIFACT_FRAME_TYPE_TERMINAL = 2;

function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`u32be out of range: ${n}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Async byte source — an async iterable of bounded `Uint8Array` chunks. */
export type AsyncByteReader = AsyncIterable<Uint8Array>;

/** Async byte sink — receives framed wire bytes during serialization. */
export interface AsyncByteWriter {
  write(chunk: Uint8Array): Promise<void> | void;
  close?(): Promise<void> | void;
}

/** One artifact stream source: strict `PortableArtifact` metadata + bytes. */
export interface ArtifactStreamSource {
  readonly artifact: semantic.PortableArtifact;
  readonly reader: AsyncByteReader;
}

export interface SerializeArtifactStreamInput {
  readonly header: container.ContainerHeaderV1;
  readonly dek: Uint8Array;
  readonly sources: readonly ArtifactStreamSource[];
  readonly writer: AsyncByteWriter;
  readonly chunkSize?: number | undefined;
}

/** Per-entry sink the deserializer dispatches decrypted plaintext chunks to. */
export interface ArtifactEntrySink {
  openEntry(entryPath: string): Promise<void> | void;
  writeChunk(entryPath: string, plaintext: Uint8Array): Promise<void> | void;
  closeEntry(entryPath: string): Promise<void> | void;
}

export interface DeserializeArtifactStreamInput {
  readonly header: container.ContainerHeaderV1;
  readonly dek: Uint8Array;
  readonly reader: AsyncByteReader;
  readonly sink: ArtifactEntrySink;
}

// --- nonce + AAD derivation (distinct domains per entry/chunk) ------------

function deriveArtifactChunkNonce(headerDigest: string, entryPath: string, ordinal: number): Uint8Array {
  return sha256(
    concatBytes(
      TEXT_ENCODER.encode(headerDigest),
      TEXT_ENCODER.encode(entryPath),
      u32be(ordinal),
      TEXT_ENCODER.encode("artifact-chunk"),
    ),
  ).subarray(0, NONCE_BYTES);
}

function deriveArtifactManifestNonce(headerDigest: string): Uint8Array {
  return sha256(
    concatBytes(
      TEXT_ENCODER.encode(headerDigest),
      TEXT_ENCODER.encode("artifact-manifest"),
      u32be(0),
      TEXT_ENCODER.encode("artifact-manifest"),
    ),
  ).subarray(0, NONCE_BYTES);
}

function computeArtifactChunkAad(input: {
  readonly headerDigest: string;
  readonly mediaVersion: number;
  readonly entryPath: string;
  readonly ordinal: number;
  readonly final: boolean;
  readonly plaintextLength: number;
}): Uint8Array {
  return canonicalJsonBytes({
    digest: input.headerDigest,
    mediaVersion: input.mediaVersion,
    entryPath: input.entryPath,
    ordinal: input.ordinal,
    final: input.final,
    length: input.plaintextLength,
    domain: "artifact-chunk",
  });
}

function computeArtifactManifestAad(input: {
  readonly headerDigest: string;
  readonly mediaVersion: number;
  readonly plaintextLength: number;
}): Uint8Array {
  return canonicalJsonBytes({
    digest: input.headerDigest,
    mediaVersion: input.mediaVersion,
    domain: "artifact-manifest",
    final: true,
    length: input.plaintextLength,
  });
}

// --- binary frame encoding (length-prefixed; raw ciphertext, not hex) -------
//
// Wire frame:  u32 BE bodyLen | body
// Body layout:
//   u8  frameType (1=chunk, 2=terminal)
//   u8  mediaVersion
//   u16 BE entryPathLen | entryPathUtf8 (empty for terminal)
//   u32 BE ordinal
//   u8  final (0/1)
//   u32 BE plaintextLength
//   [24] nonce
//   u16 BE aadLen | aad
//   u32 BE ctLen | ciphertext

function encodeFrame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

function encodeChunkFrameBody(f: {
  readonly mediaVersion: number;
  readonly entryPath: string;
  readonly ordinal: number;
  readonly final: boolean;
  readonly plaintextLength: number;
  readonly nonce: Uint8Array;
  readonly aad: Uint8Array;
  readonly ciphertext: Uint8Array;
}): Uint8Array {
  const entryPathBytes = TEXT_ENCODER.encode(f.entryPath);
  const bodyLen = 1 + 1 + 2 + entryPathBytes.length + 4 + 1 + 4 + NONCE_BYTES + 2 + f.aad.length + 4 + f.ciphertext.length;
  const out = new Uint8Array(bodyLen);
  const dv = new DataView(out.buffer);
  let off = 0;
  out[off++] = ARTIFACT_FRAME_TYPE_CHUNK;
  out[off++] = f.mediaVersion;
  dv.setUint16(off, entryPathBytes.length, false); off += 2;
  out.set(entryPathBytes, off); off += entryPathBytes.length;
  dv.setUint32(off, f.ordinal, false); off += 4;
  out[off++] = f.final ? 1 : 0;
  dv.setUint32(off, f.plaintextLength, false); off += 4;
  out.set(f.nonce, off); off += NONCE_BYTES;
  dv.setUint16(off, f.aad.length, false); off += 2;
  out.set(f.aad, off); off += f.aad.length;
  dv.setUint32(off, f.ciphertext.length, false); off += 4;
  out.set(f.ciphertext, off);
  return out;
}

function encodeTerminalFrameBody(f: {
  readonly mediaVersion: number;
  readonly plaintextLength: number;
  readonly nonce: Uint8Array;
  readonly aad: Uint8Array;
  readonly ciphertext: Uint8Array;
}): Uint8Array {
  // entryPath is empty for the terminal frame; ordinal is 0.
  const bodyLen = 1 + 1 + 2 + 0 + 4 + 1 + 4 + NONCE_BYTES + 2 + f.aad.length + 4 + f.ciphertext.length;
  const out = new Uint8Array(bodyLen);
  const dv = new DataView(out.buffer);
  let off = 0;
  out[off++] = ARTIFACT_FRAME_TYPE_TERMINAL;
  out[off++] = f.mediaVersion;
  dv.setUint16(off, 0, false); off += 2;
  dv.setUint32(off, 0, false); off += 4;
  out[off++] = 1; // final
  dv.setUint32(off, f.plaintextLength, false); off += 4;
  out.set(f.nonce, off); off += NONCE_BYTES;
  dv.setUint16(off, f.aad.length, false); off += 2;
  out.set(f.aad, off); off += f.aad.length;
  dv.setUint32(off, f.ciphertext.length, false); off += 4;
  out.set(f.ciphertext, off);
  return out;
}

// --- serializer -------------------------------------------------------------

/**
 * Stream-encrypt artifact bytes into a bounded, authenticated chunk-frame
 * stream. For each source, reads the reader one bounded chunk at a time,
 * AEAD-encrypts it under the bundle DEK with a per-entry/per-chunk nonce and
 * AAD, and writes the framed bytes to `writer`. After all sources, writes one
 * terminal artifact-manifest frame authenticating per-entry size / sha256 /
 * chunkCount. Never reads a whole artifact into memory.
 */
export async function serializeArtifactStream(input: SerializeArtifactStreamInput): Promise<void> {
  if (input.dek.length !== KEY_BYTES) {
    throw new ProfileBundleFileError(`dek must be ${KEY_BYTES} bytes, got ${input.dek.length}`);
  }
  const chunkSize = input.chunkSize ?? ARTIFACT_STREAM_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 64 || chunkSize > 1024 * 1024) {
    throw new ProfileBundleFileError(`chunkSize must be integer in [64, 1048576]`);
  }
  if (input.sources.length === 0) {
    throw new ProfileBundleFileError("artifact stream requires at least one source");
  }
  const seenEntries = new Set<string>();
  for (const src of input.sources) {
    if (!isValidArtifactBytesEntry(src.artifact.bytesEntry)) {
      throw new ProfileBundleFileError(`invalid artifact bytesEntry: ${src.artifact.bytesEntry}`);
    }
    if (seenEntries.has(src.artifact.bytesEntry)) {
      throw new ProfileBundleFileError(`duplicate artifact bytesEntry: ${src.artifact.bytesEntry}`);
    }
    seenEntries.add(src.artifact.bytesEntry);
  }

  const headerDigest = computeHeaderDigest(input.header);
  const writer = input.writer;
  const manifestEntries: ArtifactStreamManifestEntryLike[] = [];

  for (const src of input.sources) {
    const entryPath = src.artifact.bytesEntry;
    const hash = createHash("sha256");
    let bytesReceived = 0;
    let chunkCount = 0;
    let ordinal = 0;
    const iterator = src.reader[Symbol.asyncIterator]();
    try {
      let current = await iterator.next();
      if (current.done === true) {
        // Empty artifact: emit a single zero-length final chunk so the entry
        // has a well-defined final marker and the reader can authenticate it.
        await writeChunkFrame(writer, input.dek, headerDigest, entryPath, ordinal, true, new Uint8Array(0));
        chunkCount += 1;
        ordinal += 1;
      } else {
        while (current.done === false) {
          const chunk = current.value;
          // Peek ahead: the current chunk is final iff the reader is exhausted
          // after it. This correctly marks the last chunk final even when the
          // artifact size is an exact multiple of chunkSize.
          const following = await iterator.next();
          const isLast = following.done === true;
          const bounded = chunk.length > chunkSize ? chunk.subarray(0, chunkSize) : chunk;
          await writeChunkFrame(writer, input.dek, headerDigest, entryPath, ordinal, isLast, bounded);
          hash.update(bounded);
          bytesReceived += bounded.length;
          chunkCount += 1;
          ordinal += 1;
          current = following;
        }
      }
    } finally {
      await iterator.return?.();
    }

    const actualSha = hash.digest("hex");
    if (bytesReceived !== src.artifact.size) {
      throw new ProfileBundleFileError(
        `artifact ${entryPath} size mismatch: declared ${src.artifact.size} vs streamed ${bytesReceived}`,
      );
    }
    if (actualSha !== src.artifact.sha256) {
      throw new ProfileBundleFileError(
        `artifact ${entryPath} sha256 mismatch: declared ${src.artifact.sha256} vs streamed ${actualSha}`,
      );
    }
    manifestEntries.push({ entryPath, size: bytesReceived, sha256: actualSha, chunkCount });
  }

  const manifest: ArtifactStreamManifestLike = {
    mediaVersion: ARTIFACT_MEDIA_VERSION,
    entries: manifestEntries,
  };
  const manifestPlain = canonicalJsonBytes(manifest);
  const manifestAad = computeArtifactManifestAad({
    headerDigest,
    mediaVersion: ARTIFACT_MEDIA_VERSION,
    plaintextLength: manifestPlain.length,
  });
  const manifestNonce = deriveArtifactManifestNonce(headerDigest);
  const manifestCt = xchacha20poly1305(input.dek, manifestNonce, manifestAad).encrypt(manifestPlain);
  const manifestBody = encodeTerminalFrameBody({
    mediaVersion: ARTIFACT_MEDIA_VERSION,
    plaintextLength: manifestPlain.length,
    nonce: manifestNonce,
    aad: manifestAad,
    ciphertext: manifestCt,
  });
  await writer.write(encodeFrame(manifestBody));
  await writer.close?.();
}

async function writeChunkFrame(
  writer: AsyncByteWriter,
  dek: Uint8Array,
  headerDigest: string,
  entryPath: string,
  ordinal: number,
  final: boolean,
  plaintext: Uint8Array,
): Promise<void> {
  const aad = computeArtifactChunkAad({
    headerDigest,
    mediaVersion: ARTIFACT_MEDIA_VERSION,
    entryPath,
    ordinal,
    final,
    plaintextLength: plaintext.length,
  });
  const nonce = deriveArtifactChunkNonce(headerDigest, entryPath, ordinal);
  const ct = xchacha20poly1305(dek, nonce, aad).encrypt(plaintext);
  const body = encodeChunkFrameBody({
    mediaVersion: ARTIFACT_MEDIA_VERSION,
    entryPath,
    ordinal,
    final,
    plaintextLength: plaintext.length,
    nonce,
    aad,
    ciphertext: ct,
  });
  await writer.write(encodeFrame(body));
}

function isValidArtifactBytesEntry(path: string): boolean {
  const prefix = "media/artifacts/";
  const suffix = ".bin";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((seg) => seg === "..")) return false;
  const opaqueId = path.slice(prefix.length, path.length - suffix.length);
  return /^[A-Za-z0-9_-]{8,128}$/.test(opaqueId);
}

type ArtifactStreamManifestEntryLike = {
  readonly entryPath: string;
  readonly size: number;
  readonly sha256: string;
  readonly chunkCount: number;
};

type ArtifactStreamManifestLike = {
  readonly mediaVersion: number;
  readonly entries: readonly ArtifactStreamManifestEntryLike[];
};

// --- deserializer -----------------------------------------------------------

type EntryState = {
  readonly entryPath: string;
  readonly ordinals: Set<number>;
  maxOrdinal: number;
  finalCount: number;
  finalOrdinal: number;
  chunkCount: number;
  bytesReceived: number;
  finalSeen: boolean;
  readonly hash: ReturnType<typeof createHash>;
  opened: boolean;
};

class BufferedByteReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly iterator: AsyncIterator<Uint8Array>;
  private done = false;
  constructor(reader: AsyncByteReader) {
    this.iterator = reader[Symbol.asyncIterator]();
  }
  async readExact(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) {
      if (this.done) {
        throw new ProfileBundleFileError("unexpected end of artifact stream");
      }
      const r = await this.iterator.next();
      if (r.done === true) {
        this.done = true;
        continue;
      }
      this.buffer = concatBytes(this.buffer, r.value);
    }
    const out = new Uint8Array(n);
    out.set(this.buffer.subarray(0, n));
    const remaining = this.buffer.length - n;
    const newBuf = new Uint8Array(remaining);
    newBuf.set(this.buffer.subarray(n));
    this.buffer = newBuf;
    return out;
  }
  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

type ParsedChunkFrame = {
  readonly frameType: number;
  readonly mediaVersion: number;
  readonly entryPath: string;
  readonly ordinal: number;
  readonly final: boolean;
  readonly plaintextLength: number;
  readonly nonce: Uint8Array;
  readonly aad: Uint8Array;
  readonly ciphertext: Uint8Array;
};

function parseFrameBody(body: Uint8Array): ParsedChunkFrame {
  if (body.length < 4 + 1 + 1 + 2 + 4 + 1 + 4 + NONCE_BYTES + 2 + 4) {
    throw new ProfileBundleFileError("artifact frame body is too short");
  }
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let off = 0;
  const frameType = body[off++]!;
  const mediaVersion = body[off++]!;
  const entryPathLen = dv.getUint16(off, false); off += 2;
  if (off + entryPathLen > body.length) throw new ProfileBundleFileError("artifact frame entryPath overruns body");
  const entryPath = TEXT_DECODER.decode(body.subarray(off, off + entryPathLen)); off += entryPathLen;
  const ordinal = dv.getUint32(off, false); off += 4;
  const final = body[off++]! === 1;
  const plaintextLength = dv.getUint32(off, false); off += 4;
  if (off + NONCE_BYTES > body.length) throw new ProfileBundleFileError("artifact frame nonce overruns body");
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.set(body.subarray(off, off + NONCE_BYTES)); off += NONCE_BYTES;
  const aadLen = dv.getUint16(off, false); off += 2;
  if (off + aadLen > body.length) throw new ProfileBundleFileError("artifact frame aad overruns body");
  const aad = new Uint8Array(aadLen);
  aad.set(body.subarray(off, off + aadLen)); off += aadLen;
  const ctLen = dv.getUint32(off, false); off += 4;
  if (off + ctLen > body.length) throw new ProfileBundleFileError("artifact frame ciphertext overruns body");
  const ciphertext = new Uint8Array(ctLen);
  ciphertext.set(body.subarray(off, off + ctLen));
  return { frameType, mediaVersion, entryPath, ordinal, final, plaintextLength, nonce, aad, ciphertext };
}

/**
 * Stream-decrypt and verify an artifact chunk-frame stream. Reads frames one
 * at a time from `reader`, authenticates each chunk's AAD (recomputed from the
 * immutable-header digest + frame fields) and AEAD-decrypts it, dispatching
 * plaintext to `sink` per entry. After the terminal artifact-manifest frame
 * authenticates, cross-checks per-entry size / sha256 / chunkCount and rejects
 * duplicate / missing / orphan entries, ordinal gaps, finality errors, and
 * size/hash mismatches. Never holds a whole artifact in memory.
 */
export async function deserializeArtifactStream(input: DeserializeArtifactStreamInput): Promise<void> {
  if (input.dek.length !== KEY_BYTES) {
    throw new ProfileBundleFileError(`dek must be ${KEY_BYTES} bytes, got ${input.dek.length}`);
  }
  const headerDigest = computeHeaderDigest(input.header);
  const reader = new BufferedByteReader(input.reader);
  const entries = new Map<string, EntryState>();

  try {
    while (true) {
      const lenBuf = await reader.readExact(4);
      const bodyLen = new DataView(lenBuf.buffer, lenBuf.byteOffset, lenBuf.byteLength).getUint32(0, false);
      if (bodyLen > 16 * 1024 * 1024) {
        throw new ProfileBundleFileError(`artifact frame body too large: ${bodyLen}`);
      }
      const body = await reader.readExact(bodyLen);
      const parsed = parseFrameBody(body);

      if (parsed.frameType === ARTIFACT_FRAME_TYPE_TERMINAL) {
        await handleTerminalFrame(input, headerDigest, parsed, entries);
        return;
      }
      if (parsed.frameType !== ARTIFACT_FRAME_TYPE_CHUNK) {
        throw new ProfileBundleFileError(`unknown artifact frame type: ${parsed.frameType}`);
      }
      await handleChunkFrame(input, headerDigest, parsed, entries);
    }
  } finally {
    await reader.close();
  }
}

async function handleChunkFrame(
  input: DeserializeArtifactStreamInput,
  headerDigest: string,
  parsed: ParsedChunkFrame,
  entries: Map<string, EntryState>,
): Promise<void> {
  if (parsed.mediaVersion !== ARTIFACT_MEDIA_VERSION) {
    throw new ProfileBundleFileError(`unsupported artifact mediaVersion: ${parsed.mediaVersion}`);
  }
  if (!isValidArtifactBytesEntry(parsed.entryPath)) {
    throw new ProfileBundleFileError(`invalid artifact entryPath: ${parsed.entryPath}`);
  }
  if (parsed.plaintextLength + TAG_BYTES !== parsed.ciphertext.length) {
    throw new ProfileBundleFileError(
      `artifact chunk ${parsed.entryPath}#${parsed.ordinal} plaintextLength+tag != ciphertext length`,
    );
  }
  const expectedAad = computeArtifactChunkAad({
    headerDigest,
    mediaVersion: parsed.mediaVersion,
    entryPath: parsed.entryPath,
    ordinal: parsed.ordinal,
    final: parsed.final,
    plaintextLength: parsed.plaintextLength,
  });
  if (toHex(expectedAad) !== toHex(parsed.aad)) {
    throw new ProfileBundleFileError(
      `artifact chunk ${parsed.entryPath}#${parsed.ordinal} AAD mismatch (header tampered or AAD mutated)`,
    );
  }
  const expectedNonce = deriveArtifactChunkNonce(headerDigest, parsed.entryPath, parsed.ordinal);
  if (toHex(expectedNonce) !== toHex(parsed.nonce)) {
    throw new ProfileBundleFileError(`artifact chunk ${parsed.entryPath}#${parsed.ordinal} nonce mismatch`);
  }
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(input.dek, parsed.nonce, parsed.aad).decrypt(parsed.ciphertext);
  } catch {
    throw new ProfileBundleFileError(
      `artifact chunk ${parsed.entryPath}#${parsed.ordinal} AEAD authentication failed`,
    );
  }

  let state = entries.get(parsed.entryPath);
  if (state === undefined) {
    state = {
      entryPath: parsed.entryPath,
      ordinals: new Set(),
      maxOrdinal: -1,
      finalCount: 0,
      finalOrdinal: -1,
      chunkCount: 0,
      bytesReceived: 0,
      finalSeen: false,
      hash: createHash("sha256"),
      opened: false,
    };
    entries.set(parsed.entryPath, state);
  }
  if (state.finalSeen) {
    throw new ProfileBundleFileError(
      `artifact chunk ${parsed.entryPath}#${parsed.ordinal} received after final chunk`,
    );
  }
  if (state.ordinals.has(parsed.ordinal)) {
    throw new ProfileBundleFileError(
      `artifact chunk ${parsed.entryPath}#${parsed.ordinal} duplicate ordinal`,
    );
  }
  state.ordinals.add(parsed.ordinal);
  if (parsed.ordinal > state.maxOrdinal) state.maxOrdinal = parsed.ordinal;
  if (parsed.final) {
    state.finalCount += 1;
    state.finalOrdinal = parsed.ordinal;
    state.finalSeen = true;
  }
  if (!state.opened) {
    await input.sink.openEntry(parsed.entryPath);
    state.opened = true;
  }
  await input.sink.writeChunk(parsed.entryPath, plain);
  state.hash.update(plain);
  state.bytesReceived += plain.length;
  state.chunkCount += 1;
}

async function handleTerminalFrame(
  input: DeserializeArtifactStreamInput,
  headerDigest: string,
  parsed: ParsedChunkFrame,
  entries: Map<string, EntryState>,
): Promise<void> {
  if (parsed.mediaVersion !== ARTIFACT_MEDIA_VERSION) {
    throw new ProfileBundleFileError(`unsupported artifact mediaVersion: ${parsed.mediaVersion}`);
  }
  if (parsed.entryPath !== "") {
    throw new ProfileBundleFileError("artifact terminal frame must have empty entryPath");
  }
  if (!parsed.final) {
    throw new ProfileBundleFileError("artifact terminal frame must have final=true");
  }
  const expectedAad = computeArtifactManifestAad({
    headerDigest,
    mediaVersion: parsed.mediaVersion,
    plaintextLength: parsed.plaintextLength,
  });
  if (toHex(expectedAad) !== toHex(parsed.aad)) {
    throw new ProfileBundleFileError("artifact terminal manifest AAD mismatch");
  }
  const expectedNonce = deriveArtifactManifestNonce(headerDigest);
  if (toHex(expectedNonce) !== toHex(parsed.nonce)) {
    throw new ProfileBundleFileError("artifact terminal manifest nonce mismatch");
  }
  let manifestPlain: Uint8Array;
  try {
    manifestPlain = xchacha20poly1305(input.dek, parsed.nonce, parsed.aad).decrypt(parsed.ciphertext);
  } catch {
    throw new ProfileBundleFileError("artifact terminal manifest AEAD authentication failed");
  }
  let manifestUnknown: unknown;
  try {
    manifestUnknown = JSON.parse(TEXT_DECODER.decode(manifestPlain));
  } catch {
    throw new ProfileBundleFileError("artifact terminal manifest is not valid JSON");
  }
  const manifestCheck = container.validateArtifactStreamManifest(manifestUnknown);
  if (!manifestCheck.ok) {
    throw new ProfileBundleFileError(
      `artifact terminal manifest invalid: ${manifestCheck.errors.map((e) => `${e.code}:${e.message}`).join("; ")}`,
    );
  }
  const manifest = manifestUnknown as ArtifactStreamManifestLike;

  // Cross-check each manifest entry against the accumulated state.
  const manifestPaths = new Set<string>();
  for (const mrec of manifest.entries) {
    manifestPaths.add(mrec.entryPath);
    const state = entries.get(mrec.entryPath);
    if (state === undefined) {
      throw new ProfileBundleFileError(`artifact terminal manifest references missing entry: ${mrec.entryPath}`);
    }
    if (!state.finalSeen) {
      throw new ProfileBundleFileError(`artifact entry ${mrec.entryPath} missing final chunk`);
    }
    if (state.finalCount !== 1) {
      throw new ProfileBundleFileError(`artifact entry ${mrec.entryPath} has ${state.finalCount} final chunks`);
    }
    if (state.finalOrdinal !== state.maxOrdinal) {
      throw new ProfileBundleFileError(`artifact entry ${mrec.entryPath} final chunk not highest ordinal`);
    }
    if (state.chunkCount !== mrec.chunkCount) {
      throw new ProfileBundleFileError(
        `artifact entry ${mrec.entryPath} chunkCount mismatch: manifest ${mrec.chunkCount} vs actual ${state.chunkCount}`,
      );
    }
    // Contiguous 0..chunkCount-1 ordinals (no gaps/duplicates already enforced
    // per-chunk, but assert the set size matches).
    if (state.ordinals.size !== mrec.chunkCount) {
      throw new ProfileBundleFileError(`artifact entry ${mrec.entryPath} ordinal gap detected`);
    }
    if (state.bytesReceived !== mrec.size) {
      throw new ProfileBundleFileError(
        `artifact entry ${mrec.entryPath} size mismatch: manifest ${mrec.size} vs actual ${state.bytesReceived}`,
      );
    }
    const actualSha = state.hash.digest("hex");
    if (actualSha !== mrec.sha256) {
      throw new ProfileBundleFileError(
        `artifact entry ${mrec.entryPath} sha256 mismatch: manifest ${mrec.sha256} vs actual ${actualSha}`,
      );
    }
    await input.sink.closeEntry(mrec.entryPath);
  }

  // Orphan detection: entries received but not in the manifest.
  for (const [entryPath] of entries) {
    if (!manifestPaths.has(entryPath)) {
      throw new ProfileBundleFileError(`artifact entry has no manifest record: ${entryPath}`);
    }
  }
} // deserializeArtifactStream

// ===========================================================================
// Wave 3 — streaming IO adapters + sidecar artifact stream file helpers.
// ===========================================================================
//
// These adapters bridge the server's streaming HTTP bodies and the on-disk
// sidecar `.artifacts` file to the `AsyncByteReader`/`AsyncByteWriter`/sink
// contracts of `serializeArtifactStream`/`deserializeArtifactStream`. They
// never hold a whole artifact in memory: bytes flow chunk-by-chunk through
// async iterables / writers. The sidecar IO is injectable so the round-trip
// is testable with no real disk.

/** Wrap any `AsyncIterable<Uint8Array>` as an `AsyncByteReader`. */
export function asyncReaderFromIterable(iter: AsyncIterable<Uint8Array>): AsyncByteReader {
  const obj: AsyncByteReader = {
    [Symbol.asyncIterator]() {
      const inner = iter[Symbol.asyncIterator]();
      let ended = false;
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (ended) return { done: true, value: undefined };
          const r = await inner.next();
          if (r.done === true) {
            ended = true;
            return { done: true, value: undefined };
          }
          return { done: false, value: new Uint8Array(r.value) };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          ended = true;
          await inner.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
  return obj;
}

/** Wrap a `ReadableStream<Uint8Array>` (e.g. a fetch Response body) as an
 *  `AsyncByteReader` yielding bounded chunks (≤ 64 KiB). Bounding here is
 *  required because `serializeArtifactStream` truncates any chunk larger than
 *  its `chunkSize` to that size — an unbounded web-stream chunk would silently
 *  drop bytes. */
const WEB_STREAM_RECHUNK = 64 * 1024;
export function asyncReaderFromWebStream(body: ReadableStream<Uint8Array>): AsyncByteReader {
  const webReader = body.getReader();
  // Pending tail of an oversized web chunk that was split, drained before the
  // next web read so the iterator never yields a chunk larger than the bound.
  const pendingTail: Uint8Array[] = [];
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (pendingTail.length > 0) {
            const tail = pendingTail.shift()!;
            if (tail.length <= WEB_STREAM_RECHUNK) return { done: false, value: new Uint8Array(tail) };
            pendingTail.unshift(tail.subarray(WEB_STREAM_RECHUNK));
            return { done: false, value: new Uint8Array(tail.subarray(0, WEB_STREAM_RECHUNK)) };
          }
          const r = await webReader.read();
          if (r.done === true) return { done: true, value: undefined };
          const whole = new Uint8Array(r.value);
          if (whole.length <= WEB_STREAM_RECHUNK) return { done: false, value: whole };
          pendingTail.unshift(whole.subarray(WEB_STREAM_RECHUNK));
          return { done: false, value: new Uint8Array(whole.subarray(0, WEB_STREAM_RECHUNK)) };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          pendingTail.length = 0;
          await webReader.cancel().catch(() => undefined);
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** Wrap a Node readable stream as an `AsyncByteReader` (chunks verbatim). */
function asyncReaderFromNodeStream(stream: NodeJS.ReadableStream): AsyncByteReader {
  const obj: AsyncByteReader = {
    [Symbol.asyncIterator]() {
      const iterFn = (stream as unknown as {
        [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
      })[Symbol.asyncIterator];
      if (typeof iterFn !== "function") {
        throw new ProfileBundleFileError("stream is not async-iterable");
      }
      const iter = iterFn.call(stream);
      let ended = false;
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (ended) return { done: true, value: undefined };
          const r = await iter.next();
          if (r.done === true) {
            ended = true;
            return { done: true, value: undefined };
          }
          const v = r.value as Uint8Array | Buffer;
          return { done: false, value: new Uint8Array(v) };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          ended = true;
          await iter.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
  return obj;
}

/**
 * D425 Wave 3 (streaming slice) — minimal structural interface for the API
 * client methods the streaming sink drives. `NautiloApiClient` satisfies
 * this; tests inject a mock. Kept here (not imported from
 * `@nautilo/api-client`) so the lib has no back-edge into the api-client
 * package.
 */
export interface ArtifactStageClient {
  stageProfileBundleArtifactStream(input: {
    readonly planToken: string;
    readonly bytesEntry: string;
    readonly body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  }): Promise<ProfileBundleArtifactStageResult>;
  abortProfileBundleArtifactStaging(input: {
    readonly planToken: string;
  }): Promise<unknown>;
}

/** Stage response shape the sink records per entry (mirrors the server's). */
export interface ProfileBundleArtifactStageResult {
  readonly planToken: string;
  readonly bytesEntry: string;
  readonly artifactId: string;
  readonly sha256: string;
  readonly size: number;
  readonly staged: true;
}

/**
 * D425 Wave 3 (streaming slice) — a per-entry sink that streams decrypted
 * plaintext chunks STRAIGHT into a target-stage HTTP request body, never
 * collecting a whole artifact in memory.
 *
 * - `openEntry` opens a streaming stage request whose body is a pull-based
 *   async iterable: the server (via fetch) pulls one bounded chunk at a
 *   time, so backpressure bounds in-flight memory to ~one chunk.
 * - `writeChunk` feeds a decrypted chunk into the iterable's queue.
 * - `closeEntry` closes the iterable and awaits the stage response; a
 *   server-side checksum/size failure surfaces here as a thrown error.
 *
 * On a terminal manifest / decrypt / chunk error the deserializer throws
 * WITHOUT calling `closeEntry` for every entry; call {@link abort} to
 * resolve any open pull with `done` (so the in-flight request sees a
 * short/terminated body) and then call the client's plan-scoped abort to
 * clean up already-staged spool bytes. Rejection of the in-flight stage
 * promise is swallowed here so it never becomes an unhandled rejection.
 */
export class StreamingArtifactStageSink implements ArtifactEntrySink {
  private readonly entries = new Map<
    string,
    {
      readonly queue: Uint8Array[];
      resolveNext: ((r: IteratorResult<Uint8Array>) => void) | null;
      done: boolean;
      readonly response: Promise<ProfileBundleArtifactStageResult>;
    }
  >();
  private readonly results = new Map<string, ProfileBundleArtifactStageResult>();

  constructor(
    private readonly client: ArtifactStageClient,
    private readonly planToken: string,
  ) {}

  openEntry(entryPath: string): Promise<void> | void {
    const entry = {
      queue: [] as Uint8Array[],
      resolveNext: null as ((r: IteratorResult<Uint8Array>) => void) | null,
      done: false,
      response: undefined as unknown as Promise<ProfileBundleArtifactStageResult>,
    };
    this.entries.set(entryPath, entry);

    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            return new Promise((resolve) => {
              if (entry.queue.length > 0) {
                resolve({ done: false, value: entry.queue.shift()! });
              } else if (entry.done) {
                resolve({ done: true, value: undefined });
              } else {
                entry.resolveNext = resolve;
              }
            });
          },
          return(): Promise<IteratorResult<Uint8Array>> {
            entry.done = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    const response = this.client.stageProfileBundleArtifactStream({
      planToken: this.planToken,
      bytesEntry: entryPath,
      body: iterable,
    });
    // Swallow rejection here so a never-awaited (aborted) stage promise does
    // not surface as an unhandled rejection; closeEntry re-awaitS the
    // original (still-rejecting) promise to surface real errors.
    response.catch(() => {});
    entry.response = response;
  }

  writeChunk(entryPath: string, plaintext: Uint8Array): Promise<void> | void {
    const entry = this.entries.get(entryPath);
    if (!entry) return;
    const chunk = new Uint8Array(plaintext);
    if (entry.resolveNext !== null) {
      const resolve = entry.resolveNext;
      entry.resolveNext = null;
      resolve({ done: false, value: chunk });
    } else {
      entry.queue.push(chunk);
    }
  }

  async closeEntry(entryPath: string): Promise<void> {
    const entry = this.entries.get(entryPath);
    if (!entry) return;
    entry.done = true;
    if (entry.resolveNext !== null) {
      const resolve = entry.resolveNext;
      entry.resolveNext = null;
      resolve({ done: true, value: undefined });
    }
    // Await the original promise so a server-side checksum/size failure
    // surfaces as a thrown error to the deserializer's caller.
    const res = await entry.response;
    this.results.set(entryPath, res);
    this.entries.delete(entryPath);
  }

  /**
   * Resolve any open pull with `done` so in-flight streaming requests see a
   * terminated body. Does NOT throw. Follow with
   * `client.abortProfileBundleArtifactStaging` to clear already-staged
   * spool bytes on the server.
   */
  abort(): Promise<void> {
    for (const [, entry] of this.entries) {
      entry.done = true;
      if (entry.resolveNext !== null) {
        const resolve = entry.resolveNext;
        entry.resolveNext = null;
        resolve({ done: true, value: undefined });
      }
    }
    return Promise.resolve();
  }

  /** Stage responses for entries whose `closeEntry` completed successfully. */
  getResults(): readonly ProfileBundleArtifactStageResult[] {
    return Array.from(this.results.values());
  }
}

/**
 * Injectable sidecar artifact-stream IO. Production writes/reads a real
 * `.artifacts` file (streamed, never buffered whole); tests inject an
 * in-memory implementation so the round-trip needs no real disk.
 */
export interface ArtifactStreamIo {
  /** Open a streaming writer for the sidecar at `path`. Returns the writer
   *  plus a `summary()` for size/sha256 once serialization completes. */
  openWriter(path: string): {
    readonly writer: AsyncByteWriter;
    summary(): { readonly size: number; readonly sha256: string };
  };
  /** Open a streaming reader for the sidecar at `path`. */
  openReader(path: string): AsyncByteReader;
  /** Whether a sidecar exists at `path`. */
  exists(path: string): Promise<boolean>;
  /** Remove the sidecar at `path` (best-effort). */
  remove(path: string): Promise<void>;
}

/** In-memory `ArtifactStreamIo` for tests. */
export function createInMemoryArtifactStreamIo(): ArtifactStreamIo & {
  store: Map<string, Uint8Array>;
} {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    openWriter(path: string) {
      const parts: Uint8Array[] = [];
      let total = 0;
      const hash = createHash("sha256");
      let closed = false;
      const writer: AsyncByteWriter = {
        write(chunk: Uint8Array): void {
          const c = new Uint8Array(chunk);
          parts.push(c);
          total += c.length;
          hash.update(c);
        },
        close(): void {
          if (closed) return;
          closed = true;
          const out = new Uint8Array(total);
          let off = 0;
          for (const p of parts) {
            out.set(p, off);
            off += p.length;
          }
          store.set(path, out);
        },
      };
      return {
        writer,
        summary: () => ({ size: total, sha256: hash.digest("hex") }),
      };
    },
    openReader(path: string) {
      const bytes = store.get(path);
      if (bytes === undefined) {
        throw new ProfileBundleFileError(`artifact sidecar not found: ${path}`);
      }
      return asyncReaderFromIterable(
        (async function* () {
          await Promise.resolve();
          yield bytes;
        })(),
      );
    },
    exists(path: string): Promise<boolean> {
      return Promise.resolve(store.has(path));
    },
    remove(path: string): Promise<void> {
      store.delete(path);
      return Promise.resolve();
    },
  };
}

/** Derive the sidecar path from a bundle path: `<bundle>.artifacts`. */
export function deriveArtifactSidecarPath(bundlePath: string): string {
  return `${bundlePath}.artifacts`;
}

/**
 * Production `ArtifactStreamIo` backed by real files. The writer streams
 * framed bytes through a `createWriteStream` while hashing; the reader wraps a
 * `createReadStream`. Neither holds a whole artifact in memory.
 */
export function createFileArtifactStreamIo(): ArtifactStreamIo {
  return {
    openWriter(path: string) {
      const hash = createHash("sha256");
      let total = 0;
      const out = createWriteStream(path);
      let closed = false;
      const writer: AsyncByteWriter = {
        async write(chunk: Uint8Array): Promise<void> {
          total += chunk.length;
          hash.update(chunk);
          await new Promise<void>((resolve, reject) => {
            const onErr = (e: Error): void => reject(e);
            out.once("error", onErr);
            if (out.write(Buffer.from(chunk))) {
              out.off("error", onErr);
              resolve();
            } else {
              out.once("drain", () => {
                out.off("error", onErr);
                resolve();
              });
            }
          });
        },
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          await new Promise<void>((resolve, reject) => {
            out.once("error", reject);
            out.end(() => resolve());
          });
        },
      };
      return {
        writer,
        summary: () => ({ size: total, sha256: hash.digest("hex") }),
      };
    },
    openReader(path: string) {
      return asyncReaderFromNodeStream(createReadStream(path));
    },
    async exists(path: string) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async remove(path: string) {
      await unlink(path).catch(() => undefined);
    },
  };
}
