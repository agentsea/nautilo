/**
 * Wave 1A — audited, manually framed `xchacha20poly1305-framed-v1` recovery
 * protection.
 *
 * This module implements the production AEAD framing that Wave 0 declared but
 * deliberately did not stub:
 *
 *   - XChaCha20-Poly1305 AEAD over each record frame and the terminal-manifest
 *     frame, via the audited `@noble/ciphers` implementation (32-byte key,
 *     24-byte nonce, 16-byte tag — confirmed against the installed
 *     `@noble/ciphers@1.3.0` type definitions, `xchacha20poly1305` ARXCipher).
 *   - Argon2id recovery-slot DEK wrapping / unwrapping. The Argon2id KDF is
 *     **injected** by the caller (`Argon2idDeriveFn`): the `argon2` runtime
 *     package is NOT a declared dependency of this package, so this module
 *     never imports it. Production callers pass the real `argon2` runtime;
 *     tests pass a deterministic stand-in.
 *   - Deterministic, header-bound per-frame nonce derivation with a stated
 *     uniqueness strategy (no nonce storage, no random-nonce collision risk).
 *   - Per-frame AAD binding the immutable-header digest + frame ordinal +
 *     frame type + plaintext length + finality.
 *   - One-record-per-frame record framing (see the framed-framing note below).
 *   - A terminal-manifest FINAL verification API that yields semantic records
 *     only after the terminal-manifest frame authenticates AND every per-record
 *     hash, the semantic root, the frame count, the payload byte total, and the
 *     record/frame-ordinal mapping all verify.
 *
 * What this module is NOT: CLI, server, DB, media, keychain, or transport. It
 * does not persist anything; callers hand it a fully-built immutable header and
 * take back encrypted frames + a manifest.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { canonicalJsonBytes, computeSemanticRoot } from "../canonical";
import { sha256, sha256Hex } from "../sha256";
import { LIMITS } from "../container/limits";
import { validateFrameSequence, validateTerminalManifest, verifySemanticRoot } from "../container/validate";
import { validateFrameAad } from "./suite";
import { PROTECTION_SUITE_BOUNDS } from "./suite";
import { ARGON2ID_BOUNDS, type Argon2idParams } from "./argon2-bounds";
import { appendError, fail, type PortabilityError, type ValidationResult } from "../errors";
import type { ContainerHeaderV1, EncryptedFrameV1, FrameKind, TerminalManifestV1, ManifestRecord } from "../container/types";
import type { RecoverySlot } from "../key-slots/types";

const KEY_BYTES = PROTECTION_SUITE_BOUNDS.keyBytes; // 32
const NONCE_BYTES = PROTECTION_SUITE_BOUNDS.nonceBytes; // 24
const TAG_BYTES = PROTECTION_SUITE_BOUNDS.tagBytes; // 16

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ---------------------------------------------------------------------------
// Injected Argon2id KDF
// ---------------------------------------------------------------------------

/**
 * Caller-supplied Argon2id key-derivation function. Production callers wrap the
 * real `argon2` runtime (e.g. `argon2.hash(passphrase, { type: argon2.argon2id,
 * salt, memoryCost, timeCost, parallelism, hashLength: 32, raw: true })`) into
 * this shape. Returning a `Uint8Array` (sync) or `Promise<Uint8Array>` (async,
 * the common case for the native binding) are both accepted.
 *
 * This package does not import the `argon2` runtime because it is not a
 * declared dependency of `@nautilo/profile-portability`.
 */
export type Argon2idDeriveFn = (input: {
  readonly passphrase: Uint8Array;
  readonly salt: Uint8Array;
  readonly params: Argon2idParams;
}) => Uint8Array | Promise<Uint8Array>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type BundleEncryptResult =
  | { readonly ok: true; readonly frames: EncryptedFrameV1[]; readonly manifest: TerminalManifestV1; readonly headerDigest: string }
  | { readonly ok: false; readonly errors: PortabilityError[] };

export type VerifyFinalResult =
  | { readonly ok: true; readonly records: unknown[]; readonly manifest: TerminalManifestV1; readonly headerDigest: string }
  | { readonly ok: false; readonly errors: PortabilityError[] };

export type UnwrapDekResult =
  | { readonly ok: true; readonly dek: Uint8Array }
  | { readonly ok: false; readonly code: "WRONG_PASSPHRASE" | "DEK_UNWRAP_FAILED" | "DEK_LENGTH_INVALID"; readonly message: string };

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`u32be out of range: ${n}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
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

function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    const v = b[i]!;
    s += v.toString(16).padStart(2, "0");
  }
  return s;
}

/** Constant-time-ish byte equality. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// AEAD primitives (XChaCha20-Poly1305 via @noble/ciphers)
// ---------------------------------------------------------------------------

function seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

/**
 * Decrypt + authenticate. `@noble/ciphers` throws on Poly1305 tag mismatch; we
 * re-throw a tagged error so callers can map it to `AEAD_AUTH_FAILED`.
 */
class AeadAuthError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AeadAuthError";
  }
}

function open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch (e) {
    throw new AeadAuthError(e instanceof Error ? e.message : "aead authentication failed");
  }
}

// ---------------------------------------------------------------------------
// Immutable-header digest
// ---------------------------------------------------------------------------

/**
 * Project a container header to a JSON-safe, canonical-encodable shape: every
 * `Uint8Array` slot field (salt / wrappedDek / aad) is hex-encoded so it can
 * pass `canonicalJson` (which rejects binary buffers). The projection is
 * deterministic and reproducible at decrypt time from the stored header, so the
 * digest commits to every immutable header field including all slot bytes.
 */
function headerToDigestable(header: ContainerHeaderV1): unknown {
  const keySlots = header.keySlots.map((slot) => {
    if (slot.kind === "recovery") {
      return {
        kind: slot.kind,
        slotId: slot.slotId,
        kdf: slot.kdf,
        kdfParams: slot.kdfParams,
        salt: toHex(slot.salt),
        wrappedDek: toHex(slot.wrappedDek),
        aad: toHex(slot.aad),
      };
    }
    return {
      kind: slot.kind,
      slotId: slot.slotId,
      keychainLabel: slot.keychainLabel,
      wrappedDek: toHex(slot.wrappedDek),
      aad: toHex(slot.aad),
    };
  });
  return {
    containerVersion: header.containerVersion,
    semanticVersion: header.semanticVersion,
    bundleId: header.bundleId,
    payloadCodec: header.payloadCodec,
    protectionSuite: header.protectionSuite,
    chunkSize: header.chunkSize,
    keySlots,
    frameCount: header.frameCount,
    totalPayloadBytes: header.totalPayloadBytes,
  };
}

/** SHA-256 (hex) over the canonical encoding of the immutable header. */
export function computeHeaderDigest(header: ContainerHeaderV1): string {
  return sha256Hex(canonicalJsonBytes(headerToDigestable(header)));
}

/** Raw 32-byte header digest bytes. */
export function computeHeaderDigestBytes(header: ContainerHeaderV1): Uint8Array {
  return sha256(canonicalJsonBytes(headerToDigestable(header)));
}

// ---------------------------------------------------------------------------
// Nonce derivation + uniqueness strategy
// ---------------------------------------------------------------------------

/**
 * Per-frame XChaCha20-Poly1305 nonce, derived as the first 24 bytes of
 * `SHA-256(headerDigest || u32be(ordinal) || "frame")`.
 *
 * Uniqueness strategy (nonces must be unique per key):
 *   - The DEK is a fresh 32-byte random key per bundle, so the AEAD key is
 *     unique per bundle.
 *   - `headerDigest` is unique per bundle (it commits to `bundleId`, the random
 *     slot salts, and the wrapped DEK), so the derived nonce space is disjoint
 *     across bundles even if ordinals repeat.
 *   - `ordinal` is unique within a bundle (enforced by `validateFrameSequence`:
 *     0-based, contiguous, no gaps or duplicates).
 *   - The `"frame"` domain-separation tag keeps frame nonces disjoint from wrap
 *     nonces (`deriveWrapNonce`).
 *
 * SHA-256 outputs 32 bytes; taking the first 24 preserves a ~2^-192 collision
 * bound across distinct (digest, ordinal) pairs, negligible for any realistic
 * frame count. Nonces are deterministic and public — this is safe for
 * XChaCha20-Poly1305, which requires only uniqueness (not secrecy) per key.
 */
export function deriveFrameNonce(headerDigest: string, ordinal: number): Uint8Array {
  const full = sha256(concat(TEXT_ENCODER.encode(headerDigest), u32be(ordinal), TEXT_ENCODER.encode("frame")));
  return full.subarray(0, NONCE_BYTES);
}

/**
 * Per-slot DEK-wrap nonce, derived as the first 24 bytes of
 * `SHA-256(salt || u32be(slotId) || "wrap")`.
 *
 * Uniqueness: the wrap key (KEK) is `argon2id(passphrase, salt)`, unique per
 * slot by the random 16-byte salt; the nonce is salt-derived and `"wrap"`-tag
 * disjoint from frame nonces. Deriving from the stored salt (rather than the
 * header digest) avoids a chicken-and-egg: the wrapped DEK is part of the
 * header, so the header digest cannot be known until the slot is sealed.
 */
export function deriveWrapNonce(salt: Uint8Array, slotId: number): Uint8Array {
  const full = sha256(concat(salt, u32be(slotId), TEXT_ENCODER.encode("wrap")));
  return full.subarray(0, NONCE_BYTES);
}

// ---------------------------------------------------------------------------
// AAD binding
// ---------------------------------------------------------------------------

/**
 * Per-frame AAD = canonical JSON encoding of
 *   { digest, final, kind, length, ordinal }
 * where:
 *   - `digest`  = immutable-header digest (hex) — binds the frame to the header
 *   - `ordinal` = frame ordinal               — binds position
 *   - `kind`    = "record" | "terminal-manifest" — binds frame type
 *   - `length`  = plaintext bytes              — binds content length
 *   - `final`   = kind === "terminal-manifest" — binds finality
 *
 * `canonicalJson` sorts keys lexicographically and emits no insignificant
 * whitespace, so the AAD is deterministic and reconstructable at decrypt time
 * from `(headerDigest, ordinal, kind, ciphertext.length - tagBytes)` — `final`
 * is derived from `kind` and `length` is recoverable from the ciphertext length.
 * The encoding is well under the 1024-byte AAD ceiling.
 */
export function computeFrameAad(input: {
  readonly headerDigest: string;
  readonly ordinal: number;
  readonly kind: FrameKind;
  readonly plaintextLength: number;
}): Uint8Array {
  const aadObj = {
    digest: input.headerDigest,
    ordinal: input.ordinal,
    kind: input.kind,
    length: input.plaintextLength,
    final: input.kind === "terminal-manifest",
  };
  const bytes = canonicalJsonBytes(aadObj);
  const aadCheck = validateFrameAad(bytes);
  if (!aadCheck.ok) {
    // Cannot happen for a digest+small header without a contract violation.
    throw new Error(`frame AAD exceeds suite ceiling: ${aadCheck.errors[0]?.message ?? ""}`);
  }
  return bytes;
}

/**
 * Slot AAD for DEK wrapping = canonical JSON of `{ slotKind, slotId, kdf }`.
 * Binds the wrapped DEK to its slot identity so a wrapped DEK cannot be
 * transplanted into a different slot or bundle. Does NOT include the header
 * digest (the header digest already commits to the wrapped DEK bytes, and
 * including it would create a digest/`wrappedDek` chicken-and-egg).
 */
export function computeSlotAad(input: { readonly slotId: number; readonly kind: "recovery"; readonly kdf: "argon2id" }): Uint8Array {
  return canonicalJsonBytes({ slotKind: input.kind, slotId: input.slotId, kdf: input.kdf });
}

// ---------------------------------------------------------------------------
// DEK generation + Argon2id recovery-slot wrap / unwrap
// ---------------------------------------------------------------------------

/** Generate a fresh 32-byte random DEK using the platform CSPRNG. */
export function generateDek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/** Validate Argon2id params against the declared bounds before running the KDF. */
function checkArgon2idParams(params: Argon2idParams): ValidationResult {
  const b = ARGON2ID_BOUNDS;
  if (
    typeof params.memoryCostKiB !== "number" || !Number.isInteger(params.memoryCostKiB) ||
    params.memoryCostKiB < b.memoryCostKiB.min || params.memoryCostKiB > b.memoryCostKiB.max
  ) {
    return fail("KDF_PARAM_OUT_OF_BOUNDS", `memoryCostKiB must be integer in [${b.memoryCostKiB.min}, ${b.memoryCostKiB.max}]`, "kdfParams.memoryCostKiB");
  }
  if (typeof params.timeCost !== "number" || !Number.isInteger(params.timeCost) || params.timeCost < b.timeCost.min || params.timeCost > b.timeCost.max) {
    return fail("KDF_PARAM_OUT_OF_BOUNDS", `timeCost must be integer in [${b.timeCost.min}, ${b.timeCost.max}]`, "kdfParams.timeCost");
  }
  if (typeof params.parallelism !== "number" || !Number.isInteger(params.parallelism) || params.parallelism < b.parallelism.min || params.parallelism > b.parallelism.max) {
    return fail("KDF_PARAM_OUT_OF_BOUNDS", `parallelism must be integer in [${b.parallelism.min}, ${b.parallelism.max}]`, "kdfParams.parallelism");
  }
  if (params.outputLength !== b.outputLength.exactly) {
    return fail("KDF_PARAM_OUT_OF_BOUNDS", `outputLength must be ${b.outputLength.exactly}`, "kdfParams.outputLength");
  }
  return { ok: true };
}

export type WrapDekInput = {
  readonly dek: Uint8Array;
  readonly passphrase: Uint8Array;
  readonly salt: Uint8Array;
  readonly kdfParams: Argon2idParams;
  readonly slotId: number;
  readonly argon2id: Argon2idDeriveFn;
};

/**
 * Wrap a DEK under an Argon2id-derived KEK and build the matching `RecoverySlot`.
 * The caller supplies the random `salt` (16 bytes) and `slotId`; the slot's
 * `aad` and the wrap nonce are derived deterministically, so unwrap needs only
 * the stored slot + the header (for nothing — wrap nonce is salt-derived) +
 * the passphrase.
 */
export async function wrapDekWithRecoverySlot(input: WrapDekInput): Promise<RecoverySlot> {
  if (input.dek.length !== KEY_BYTES) {
    throw new RangeError(`dek must be ${KEY_BYTES} bytes, got ${input.dek.length}`);
  }
  if (input.salt.length !== ARGON2ID_BOUNDS.saltLength.exactly) {
    throw new RangeError(`salt must be ${ARGON2ID_BOUNDS.saltLength.exactly} bytes, got ${input.salt.length}`);
  }
  const paramsCheck = checkArgon2idParams(input.kdfParams);
  if (!paramsCheck.ok) {
    throw new RangeError(`argon2id params invalid: ${paramsCheck.errors[0]?.message ?? ""}`);
  }
  const derived = await input.argon2id({ passphrase: input.passphrase, salt: input.salt, params: input.kdfParams });
  if (!(derived instanceof Uint8Array) || derived.length !== KEY_BYTES) {
    if (derived instanceof Uint8Array) derived.fill(0);
    throw new RangeError(`argon2id derive must return ${KEY_BYTES}-byte Uint8Array, got ${derived?.length ?? "non-Uint8Array"}`);
  }
  try {
    const slotAad = computeSlotAad({ slotId: input.slotId, kind: "recovery", kdf: "argon2id" });
    const wrapNonce = deriveWrapNonce(input.salt, input.slotId);
    const wrappedDek = seal(derived, wrapNonce, slotAad, input.dek);
    return {
      kind: "recovery",
      slotId: input.slotId,
      kdf: "argon2id",
      kdfParams: input.kdfParams,
      salt: input.salt,
      wrappedDek,
      aad: slotAad,
    };
  } finally {
    derived.fill(0);
  }
}

export type UnwrapDekInput = {
  readonly slot: RecoverySlot;
  readonly passphrase: Uint8Array;
  readonly argon2id: Argon2idDeriveFn;
};

/**
 * Unwrap the DEK from a recovery slot. A wrong passphrase produces a different
 * KEK, so the Poly1305 tag verification fails → `WRONG_PASSPHRASE`. A tampered
 * `wrappedDek` is indistinguishable from a wrong passphrase at the AEAD layer
 * and is also reported as `WRONG_PASSPHRASE` (auth failure).
 */
export async function unwrapDekFromRecoverySlot(input: UnwrapDekInput): Promise<UnwrapDekResult> {
  const slot = input.slot;
  const paramsCheck = checkArgon2idParams(slot.kdfParams);
  if (!paramsCheck.ok) {
    return { ok: false, code: "DEK_UNWRAP_FAILED", message: `argon2id params invalid: ${paramsCheck.errors[0]?.message ?? ""}` };
  }
  if (slot.salt.length !== ARGON2ID_BOUNDS.saltLength.exactly) {
    return { ok: false, code: "DEK_UNWRAP_FAILED", message: `salt must be ${ARGON2ID_BOUNDS.saltLength.exactly} bytes` };
  }
  if (slot.wrappedDek.length === 0) {
    return { ok: false, code: "DEK_UNWRAP_FAILED", message: "wrappedDek is empty" };
  }
  const derived = await input.argon2id({ passphrase: input.passphrase, salt: slot.salt, params: slot.kdfParams });
  if (!(derived instanceof Uint8Array) || derived.length !== KEY_BYTES) {
    if (derived instanceof Uint8Array) derived.fill(0);
    return { ok: false, code: "DEK_UNWRAP_FAILED", message: `argon2id derive must return ${KEY_BYTES}-byte Uint8Array` };
  }
  try {
    const slotAad = computeSlotAad({ slotId: slot.slotId, kind: "recovery", kdf: slot.kdf });
    const wrapNonce = deriveWrapNonce(slot.salt, slot.slotId);
    let dek: Uint8Array;
    try {
      dek = open(derived, wrapNonce, slotAad, slot.wrappedDek);
    } catch {
      return { ok: false, code: "WRONG_PASSPHRASE", message: "recovery-slot DEK unwrap failed (wrong passphrase or tampered wrappedDek)" };
    }
    if (dek.length !== KEY_BYTES) {
      dek.fill(0);
      return { ok: false, code: "DEK_LENGTH_INVALID", message: `unwrapped DEK must be ${KEY_BYTES} bytes, got ${dek.length}` };
    }
    return { ok: true, dek };
  } finally {
    derived.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Record framing + bundle encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a set of semantic records into the framed `xchacha20poly1305-framed-v1`
 * structure: one `record` frame per record (ordinals `0..N-1`) plus one
 * `terminal-manifest` frame at ordinal `N` (the FINAL marker). Each frame's
 * ciphertext is `plaintext || 16-byte Poly1305 tag`.
 *
 * Framing note (one-record-per-frame): Wave 0's terminal manifest maps one
 * `frameOrdinal` per record, so Wave 1A keeps a 1:1 record→frame mapping and
 * enforces each record's canonical plaintext ≤ `chunkSize` (and the resulting
 * ciphertext ≤ `maxFrameCiphertextBytes`). Multi-chunk splitting of records
 * that exceed `chunkSize` is a deliberate future extension, not implemented
 * here; records that exceed the ceiling are rejected with
 * `FRAME_PLAINTEXT_OVERSIZED` rather than silently chunked.
 *
 * The header must already declare the matching `frameCount` (N+1) and
 * `totalPayloadBytes`; `encryptBundle` cross-checks them and fails if they do
 * not match what it produces.
 */
export type EncryptBundleInput = {
  readonly header: ContainerHeaderV1;
  readonly records: readonly unknown[];
  readonly dek: Uint8Array;
};

export function encryptBundle(input: EncryptBundleInput): BundleEncryptResult {
  if (input.dek.length !== KEY_BYTES) {
    return { ok: false, errors: [{ code: "DEK_LENGTH_INVALID", message: `dek must be ${KEY_BYTES} bytes, got ${input.dek.length}` }] };
  }
  const header = input.header;
  const records = input.records;
  const recordCount = records.length;
  const expectedFrameCount = recordCount + 1;

  if (header.frameCount !== expectedFrameCount) {
    return { ok: false, errors: [{ code: "MANIFEST_FRAME_COUNT_MISMATCH", message: `header.frameCount (${header.frameCount}) must equal records.length+1 (${expectedFrameCount})`, path: "frameCount" }] };
  }

  const headerDigest = computeHeaderDigest(header);

  // Per-record plaintexts + manifest records.
  const plaintexts: Uint8Array[] = [];
  const manifestRecords: ManifestRecord[] = [];
  const hashes: string[] = [];
  let totalPayloadBytes = 0;
  for (let i = 0; i < recordCount; i++) {
    const rec = records[i]!;
    const plain = canonicalJsonBytes(rec);
    const lenErr = checkPlaintextSize(plain.length, header.chunkSize, `records[${i}]`);
    if (lenErr !== undefined) return { ok: false, errors: [lenErr] };
    plaintexts.push(plain);
    const hash = sha256Hex(plain);
    hashes.push(hash);
    manifestRecords.push({
      recordKind: readRecordKind(rec),
      frameOrdinal: i,
      sha256: hash,
      bytes: plain.length,
    });
    totalPayloadBytes += plain.length;
  }

  if (header.totalPayloadBytes !== totalPayloadBytes) {
    return { ok: false, errors: [{ code: "MANIFEST_PAYLOAD_BYTES_MISMATCH", message: `header.totalPayloadBytes (${header.totalPayloadBytes}) must equal sum of record bytes (${totalPayloadBytes})`, path: "totalPayloadBytes" }] };
  }

  const semanticRoot = computeSemanticRoot(hashes);
  const manifest: TerminalManifestV1 = {
    semanticRoot,
    records: manifestRecords,
    frameCount: expectedFrameCount,
    totalPayloadBytes,
  };

  const frames: EncryptedFrameV1[] = [];
  for (let i = 0; i < recordCount; i++) {
    const plain = plaintexts[i]!;
    const aad = computeFrameAad({ headerDigest, ordinal: i, kind: "record", plaintextLength: plain.length });
    const nonce = deriveFrameNonce(headerDigest, i);
    const ct = seal(input.dek, nonce, aad, plain);
    frames.push({ ordinal: i, kind: "record", ciphertext: ct, aad });
  }

  const manifestPlain = canonicalJsonBytes(manifest);
  const manifestLenErr = checkPlaintextSize(manifestPlain.length, header.chunkSize, "terminal-manifest");
  if (manifestLenErr !== undefined) return { ok: false, errors: [manifestLenErr] };
  const terminalOrdinal = recordCount;
  const terminalAad = computeFrameAad({ headerDigest, ordinal: terminalOrdinal, kind: "terminal-manifest", plaintextLength: manifestPlain.length });
  const terminalNonce = deriveFrameNonce(headerDigest, terminalOrdinal);
  const terminalCt = seal(input.dek, terminalNonce, terminalAad, manifestPlain);
  frames.push({ ordinal: terminalOrdinal, kind: "terminal-manifest", ciphertext: terminalCt, aad: terminalAad });

  return { ok: true, frames, manifest, headerDigest };
}

function readRecordKind(rec: unknown): string {
  if (typeof rec === "object" && rec !== null && !Array.isArray(rec)) {
    const k = (rec as Record<string, unknown>)["recordKind"];
    if (typeof k === "string") return k;
  }
  return "";
}

function checkPlaintextSize(plainLen: number, chunkSize: number, path: string): PortabilityError | undefined {
  if (plainLen > chunkSize) {
    return { code: "FRAME_PLAINTEXT_OVERSIZED", message: `plaintext (${plainLen} bytes) exceeds chunkSize (${chunkSize})`, path };
  }
  if (plainLen + TAG_BYTES > LIMITS.maxFrameCiphertextBytes) {
    return { code: "FRAME_CIPHERTEXT_OVERSIZED", message: `ciphertext (${plainLen + TAG_BYTES} bytes) exceeds maxFrameCiphertextBytes (${LIMITS.maxFrameCiphertextBytes})`, path };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Terminal-manifest FINAL verification
// ---------------------------------------------------------------------------

export type VerifyFinalInput = {
  readonly header: ContainerHeaderV1;
  readonly frames: readonly EncryptedFrameV1[];
  readonly dek: Uint8Array;
};

/**
 * Decrypt, authenticate, and verify a framed bundle. The terminal-manifest
 * frame (the FINAL marker, highest ordinal) is authenticated like every other
 * frame; only after it decrypts and structurally validates do we check the
 * manifest-internal bindings: per-record SHA-256, the semantic root, the frame
 * count, the payload byte total, and the record/frame-ordinal mapping.
 *
 * Records are yielded (`records: unknown[]`) ONLY after every check passes;
 * callers should run the semantic validators on the returned records. Any AEAD
 * failure (tampered ciphertext, tampered/stored-AAD mismatch, header mutation
 * that changes the digest and thus the AAD/nonce) is reported as
 * `AEAD_AUTH_FAILED`; a missing/duplicated/mis-ordered FINAL is reported by the
 * frame-sequence checks (`FRAME_*`).
 */
export function verifyFinalBundle(input: VerifyFinalInput): VerifyFinalResult {
  if (input.dek.length !== KEY_BYTES) {
    return { ok: false, errors: [{ code: "DEK_LENGTH_INVALID", message: `dek must be ${KEY_BYTES} bytes, got ${input.dek.length}` }] };
  }

  const seqResult = validateFrameSequence(input.frames);
  if (!seqResult.ok) return seqResult;

  const header = input.header;
  const headerDigest = computeHeaderDigest(header);

  // Decrypt + authenticate every frame in ordinal order.
  const recordPlains = new Map<number, Uint8Array>();
  let manifestPlain: Uint8Array | undefined;
  let result: ValidationResult = { ok: true };

  const ordered = [...input.frames].sort((a, b) => a.ordinal - b.ordinal);
  for (const frame of ordered) {
    const res = decryptFrame(frame, headerDigest, input.dek);
    if (!res.ok) {
      return { ok: false, errors: [res.error] };
    }
    if (frame.kind === "record") {
      recordPlains.set(frame.ordinal, res.plaintext);
    } else {
      manifestPlain = res.plaintext;
    }
  }

  if (manifestPlain === undefined) {
    return { ok: false, errors: [{ code: "FRAME_MISSING_FINAL", message: "terminal-manifest frame did not decrypt", path: "frames" }] };
  }

  let manifestUnknown: unknown;
  try {
    manifestUnknown = JSON.parse(TEXT_DECODER.decode(manifestPlain));
  } catch {
    return { ok: false, errors: [{ code: "MANIFEST_RECORD_KIND_UNKNOWN", message: "terminal manifest is not valid JSON", path: "terminal-manifest" }] };
  }

  const manifestCheck = validateTerminalManifest(manifestUnknown);
  if (!manifestCheck.ok) return manifestCheck;
  const manifest = manifestUnknown as TerminalManifestV1;

  if (manifest.frameCount !== input.frames.length) {
    result = appendError(result, "MANIFEST_FRAME_COUNT_MISMATCH", `manifest.frameCount (${manifest.frameCount}) must equal frames.length (${input.frames.length})`, "manifest.frameCount");
  }

  const recordCount = input.frames.length - 1;
  if (manifest.records.length !== recordCount) {
    result = appendError(result, "MANIFEST_FRAME_COUNT_MISMATCH", `manifest.records length (${manifest.records.length}) must equal record frame count (${recordCount})`, "manifest.records");
  }

  const parsedRecords: unknown[] = [];
  let sumPayload = 0;
  const checkN = Math.min(manifest.records.length, recordCount);
  for (let i = 0; i < checkN; i++) {
    const plain = recordPlains.get(i);
    if (plain === undefined) {
      result = appendError(result, "FRAME_ORDINAL_GAP", `record frame ordinal ${i} missing plaintext`, `frames[${i}]`);
      continue;
    }
    const mrec = manifest.records[i]!;
    if (mrec.frameOrdinal !== i) {
      result = appendError(result, "MANIFEST_FRAME_ORDINAL_INVALID", `manifest.records[${i}].frameOrdinal (${mrec.frameOrdinal}) must equal ${i}`, `manifest.records[${i}].frameOrdinal`);
    }
    const hash = sha256Hex(plain);
    if (mrec.sha256 !== hash) {
      result = appendError(result, "RECORD_HASH_MISMATCH", `record ${i} hash mismatch: manifest ${mrec.sha256} vs actual ${hash}`, `manifest.records[${i}].sha256`);
    }
    if (mrec.bytes !== plain.length) {
      result = appendError(result, "MANIFEST_PAYLOAD_BYTES_MISMATCH", `record ${i} bytes: manifest ${mrec.bytes} vs actual ${plain.length}`, `manifest.records[${i}].bytes`);
    }
    let rec: unknown;
    try {
      rec = JSON.parse(TEXT_DECODER.decode(plain));
    } catch {
      result = appendError(result, "SEMANTIC_RECORD_FIELD_INVALID", `record ${i} is not valid JSON`, `records[${i}]`);
      rec = null;
    }
    const actualKind = readRecordKind(rec);
    if (mrec.recordKind !== actualKind) {
      result = appendError(result, "MANIFEST_RECORD_KIND_UNKNOWN", `record ${i} kind: manifest ${mrec.recordKind} vs actual ${actualKind}`, `manifest.records[${i}].recordKind`);
    }
    parsedRecords.push(rec);
    sumPayload += plain.length;
  }

  if (manifest.totalPayloadBytes !== sumPayload) {
    result = appendError(result, "MANIFEST_PAYLOAD_BYTES_MISMATCH", `manifest.totalPayloadBytes (${manifest.totalPayloadBytes}) must equal sum of record bytes (${sumPayload})`, "manifest.totalPayloadBytes");
  }

  const rootCheck = verifySemanticRoot(manifest);
  if (!rootCheck.ok) {
    for (const e of rootCheck.errors) {
      result = appendError(result, e.code, e.message, e.path !== undefined ? e.path : "manifest.semanticRoot");
    }
  }

  if (!result.ok) return result;
  return { ok: true, records: parsedRecords, manifest, headerDigest };
}

type DecryptFrameResult =
  | { readonly ok: true; readonly plaintext: Uint8Array }
  | { readonly ok: false; readonly error: PortabilityError };

function decryptFrame(frame: EncryptedFrameV1, headerDigest: string, dek: Uint8Array): DecryptFrameResult {
  if (frame.ciphertext.length < TAG_BYTES) {
    return { ok: false, error: { code: "AEAD_AUTH_FAILED", message: `frame ${frame.ordinal} ciphertext shorter than tag`, path: `frames[${frame.ordinal}].ciphertext` } };
  }
  const plaintextLength = frame.ciphertext.length - TAG_BYTES;
  const expectedAad = computeFrameAad({ headerDigest, ordinal: frame.ordinal, kind: frame.kind, plaintextLength });
  if (!equalBytes(frame.aad, expectedAad)) {
    return { ok: false, error: { code: "FRAME_AAD_MISMATCH", message: `frame ${frame.ordinal} stored AAD does not match recomputed AAD (header tampered or AAD mutated)`, path: `frames[${frame.ordinal}].aad` } };
  }
  const nonce = deriveFrameNonce(headerDigest, frame.ordinal);
  try {
    const plain = open(dek, nonce, expectedAad, frame.ciphertext);
    return { ok: true, plaintext: plain };
  } catch {
    return { ok: false, error: { code: "AEAD_AUTH_FAILED", message: `frame ${frame.ordinal} AEAD authentication failed`, path: `frames[${frame.ordinal}].ciphertext` } };
  }
}
