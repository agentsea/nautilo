/**
 * Container validators: header shape, bounded frames (ordering, AAD, FINAL
 * marker, sizes), terminal manifest binding, and semantic-root/per-record
 * hash verification. Does NOT perform AEAD or any production crypto.
 */

import { appendError, fail, ok, type PortabilityError, type ValidationResult } from "../errors";
import {
  CONTAINER_VERSION,
  SEMANTIC_VERSION,
  isKnownContainerVersion,
  isKnownPayloadCodec,
  type SemanticVersion,
} from "../versions";
import { validateKeySlots } from "../key-slots/validate";
import {
  PROTECTION_SUITE_BOUNDS,
  validateProtectionSuiteDeclared,
} from "../protection/suite";
import { LIMITS } from "./limits";
import { canonicalJsonBytes } from "../canonical";
import { sha256Hex } from "../sha256";
import type {
  ContainerHeaderV1,
  EncryptedFrameV1,
  FrameKind,
  TerminalManifestV1,
  ManifestRecord,
  ArtifactChunkFrame,
  ArtifactTerminalFrame,
  ArtifactFrame,
  ArtifactStreamManifest,
} from "./types";
import {
  ARTIFACT_FRAME_NONCE_BYTES,
  ARTIFACT_FRAME_TAG_BYTES,
  ARTIFACT_FRAME_MAX_BODY_BYTES,
} from "./types";

type Rec = Record<string, unknown>;

const HEX64_RE = /^[0-9a-f]{64}$/;
const BUNDLE_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

function isObject(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUnknownArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isBytes(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX64_RE.test(v);
}

function isFrameKind(v: unknown): v is FrameKind {
  return v === "record" || v === "terminal-manifest";
}

/** Validate the immutable public container header. */
export function validateContainerHeader(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return fail("MALFORMED_HEADER", "header must be object");
  }
  let result: ValidationResult = ok();

  if (!isKnownContainerVersion(value["containerVersion"])) {
    result = appendError(result, "UNKNOWN_CONTAINER_VERSION", `containerVersion must be ${CONTAINER_VERSION}`, "containerVersion");
  }

  const sv = value["semanticVersion"];
  if (!isObject(sv) || typeof sv["major"] !== "number" || typeof sv["minor"] !== "number") {
    result = appendError(result, "UNKNOWN_SEMANTIC_VERSION", "semanticVersion must be {major,minor}", "semanticVersion");
  } else if (sv["major"] !== 1) {
    result = appendError(result, "UNSUPPORTED_SEMANTIC_VERSION", `semantic major ${sv["major"]} not supported`, "semanticVersion.major");
  } else if (!Number.isInteger(sv["minor"]) || sv["minor"] < 0) {
    result = appendError(result, "UNKNOWN_SEMANTIC_VERSION", "semantic minor must be non-negative integer", "semanticVersion.minor");
  } else if (sv["minor"] > SEMANTIC_VERSION.minor) {
    result = appendError(result, "UNSUPPORTED_SEMANTIC_VERSION", `semantic minor ${sv["minor"]} not supported`, "semanticVersion.minor");
  }

  const bundleId = value["bundleId"];
  if (typeof bundleId !== "string" || !BUNDLE_ID_RE.test(bundleId)) {
    result = appendError(result, "BUNDLE_ID_INVALID", "bundleId must match ^[a-zA-Z0-9_-]{8,128}$", "bundleId");
  }

  if (!isKnownPayloadCodec(value["payloadCodec"])) {
    result = appendError(result, "UNKNOWN_PAYLOAD_CODEC", `payloadCodec must be genie-live-records`, "payloadCodec");
  }

  const suiteResult = validateProtectionSuiteDeclared(value["protectionSuite"], undefined);
  if (!suiteResult.ok) {
    for (const e of suiteResult.errors) {
      result = appendError(result, e.code, e.message, "protectionSuite");
    }
  }

  const cs = value["chunkSize"];
  if (typeof cs !== "number" || !Number.isInteger(cs) || cs < LIMITS.chunkSize.min || cs > LIMITS.chunkSize.max) {
    result = appendError(result, "CHUNK_SIZE_OUT_OF_BOUNDS", `chunkSize must be integer in [${LIMITS.chunkSize.min}, ${LIMITS.chunkSize.max}]`, "chunkSize");
  }

  const slotsResult = validateKeySlots(value["keySlots"]);
  if (!slotsResult.ok) {
    for (const e of slotsResult.errors) {
      result = appendError(result, e.code, e.message, e.path !== undefined ? e.path : "keySlots");
    }
  }

  const fc = value["frameCount"];
  if (typeof fc !== "number" || !Number.isInteger(fc) || fc < 0 || fc > LIMITS.maxFrameCount) {
    result = appendError(result, "FRAME_COUNT_OVER_LIMIT", `frameCount must be integer in [0, ${LIMITS.maxFrameCount}]`, "frameCount");
  }

  const tp = value["totalPayloadBytes"];
  if (typeof tp !== "number" || !Number.isFinite(tp) || tp < 0 || tp > LIMITS.maxTotalPayloadBytes) {
    result = appendError(result, "PAYLOAD_OVERSIZED", `totalPayloadBytes must be in [0, ${LIMITS.maxTotalPayloadBytes}]`, "totalPayloadBytes");
  }

  return result;
}

/** Validate a single encrypted frame's structural bounds. */
export function validateFrame(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return fail("FRAME_MALFORMED", "frame must be object");
  }
  const errors: PortabilityError[] = [];
  const ordinal = value["ordinal"];
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) {
    errors.push({ code: "FRAME_ORDINAL_OUT_OF_RANGE", message: "ordinal must be non-negative integer", path: "ordinal" });
  }
  if (!isFrameKind(value["kind"])) {
    errors.push({ code: "FRAME_MALFORMED", message: `kind must be record|terminal-manifest`, path: "kind" });
  }
  const ct = value["ciphertext"];
  if (!isBytes(ct)) {
    errors.push({ code: "FRAME_MALFORMED", message: "ciphertext must be Uint8Array", path: "ciphertext" });
  } else if (ct.length > LIMITS.maxFrameCiphertextBytes) {
    errors.push({ code: "FRAME_CIPHERTEXT_OVERSIZED", message: `ciphertext exceeds ${LIMITS.maxFrameCiphertextBytes}`, path: "ciphertext" });
  }
  const aad = value["aad"];
  if (!isBytes(aad)) {
    errors.push({ code: "FRAME_MALFORMED", message: "aad must be Uint8Array", path: "aad" });
  } else if (aad.length > PROTECTION_SUITE_BOUNDS.aadMaxBytes) {
    errors.push({ code: "SUITE_AAD_OVERSIZED", message: `aad exceeds ${PROTECTION_SUITE_BOUNDS.aadMaxBytes}`, path: "aad" });
  }
  if (errors.length > 0) return { ok: false, errors };
  return ok();
}

/**
 * Validate an ordered frame sequence: strict 0-based ordinals with no gaps or
 * duplicates, exactly one FINAL terminal-manifest frame as the highest
 * ordinal, and per-frame bounds. Does not decrypt.
 */
export function validateFrameSequence(frames: unknown): ValidationResult {
  if (!Array.isArray(frames)) {
    return fail("FRAME_MALFORMED", "frames must be array");
  }
  if (frames.length === 0) {
    return fail("FRAME_MISSING_FINAL", "frames must not be empty");
  }
  if (frames.length > LIMITS.maxFrameCount) {
    return fail("FRAME_COUNT_OVER_LIMIT", `frames length exceeds ${LIMITS.maxFrameCount}`);
  }
  let result: ValidationResult = ok();
  let finalCount = 0;
  let maxOrdinal = -1;
  const seen = new Set<number>();
  let finalOrdinal: number | undefined;
  for (let i = 0; i < frames.length; i++) {
    const r = validateFrame(frames[i]);
    if (!r.ok) {
      for (const e of r.errors) {
        result = appendError(result, e.code, e.message, e.path !== undefined ? `frames[${i}].${e.path}` : `frames[${i}]`);
      }
    }
    const f = frames[i] as EncryptedFrameV1 | undefined;
    if (f !== undefined && typeof f.ordinal === "number") {
      if (seen.has(f.ordinal)) {
        result = appendError(result, "FRAME_ORDINAL_DUPLICATE", `duplicate ordinal ${f.ordinal}`, `frames[${i}].ordinal`);
      } else {
        seen.add(f.ordinal);
      }
      if (f.ordinal > maxOrdinal) maxOrdinal = f.ordinal;
    }
    if (f !== undefined && f.kind === "terminal-manifest") {
      finalCount += 1;
      if (typeof f.ordinal === "number") finalOrdinal = f.ordinal;
    }
  }
  for (let expected = 0; expected < seen.size; expected++) {
    if (!seen.has(expected)) {
      result = appendError(result, "FRAME_ORDINAL_GAP", `missing ordinal ${expected}`, "frames");
    }
  }
  if (finalCount === 0) {
    result = appendError(result, "FRAME_MISSING_FINAL", "no terminal-manifest frame", "frames");
  } else if (finalCount > 1) {
    result = appendError(result, "FRAME_MULTIPLE_FINAL", `${finalCount} terminal-manifest frames`, "frames");
  }
  if (finalCount === 1 && maxOrdinal >= 0 && finalOrdinal !== undefined && finalOrdinal !== maxOrdinal) {
    result = appendError(result, "FRAME_MISSING_FINAL", "terminal-manifest frame must be the highest ordinal", "frames");
  }
  return result;
}

function isManifestRecord(v: unknown): v is ManifestRecord {
  if (!isObject(v)) return false;
  return typeof v["recordKind"] === "string" && typeof v["frameOrdinal"] === "number" && isHex64(v["sha256"]) && typeof v["bytes"] === "number";
}

/**
 * Validate the terminal manifest's structural shape. Does NOT verify per-record
 * hashes against decrypted records (that requires AEAD, out of Wave 0); use
 * `verifySemanticRoot` for the manifest-internal hash binding.
 */
export function validateTerminalManifest(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return fail("MANIFEST_RECORD_KIND_UNKNOWN", "terminal manifest must be object");
  }
  let result: ValidationResult = ok();
  if (!isHex64(value["semanticRoot"])) {
    result = appendError(result, "SEMANTIC_ROOT_MISMATCH", "semanticRoot must be 64-char hex", "semanticRoot");
  }
  const records = value["records"];
  if (!isUnknownArray(records)) {
    result = appendError(result, "MANIFEST_RECORD_KIND_UNKNOWN", "records must be array", "records");
  } else if (records.length === 0) {
    result = appendError(result, "MANIFEST_RECORD_KIND_UNKNOWN", "records must not be empty", "records");
  } else {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!isManifestRecord(r)) {
        result = appendError(result, "MANIFEST_RECORD_HASH_INVALID", "manifest record must be {recordKind,frameOrdinal,sha256,bytes}", `records[${i}]`);
      } else {
        const fo = r.frameOrdinal;
        if (!Number.isInteger(fo) || fo < 0) {
          result = appendError(result, "MANIFEST_FRAME_ORDINAL_INVALID", "frameOrdinal must be non-negative integer", `records[${i}].frameOrdinal`);
        }
      }
    }
  }
  const fc = value["frameCount"];
  if (typeof fc !== "number" || !Number.isInteger(fc) || fc < 0) {
    result = appendError(result, "MANIFEST_FRAME_COUNT_MISMATCH", "frameCount must be non-negative integer", "frameCount");
  }
  const tp = value["totalPayloadBytes"];
  if (typeof tp !== "number" || !Number.isFinite(tp) || tp < 0) {
    result = appendError(result, "MANIFEST_PAYLOAD_BYTES_MISMATCH", "totalPayloadBytes must be non-negative number", "totalPayloadBytes");
  }
  return result;
}

/**
 * Verify the manifest-internal binding: the semantic root equals the SHA-256
 * of the canonical encoding of the sorted per-record hashes, and each
 * per-record hash is a 64-char hex digest. This is the integrity check a
 * reader performs after FINAL authentication; it does not require decryption.
 */
export function verifySemanticRoot(manifest: unknown): ValidationResult {
  if (!isObject(manifest)) {
    return fail("SEMANTIC_ROOT_MISMATCH", "manifest must be object");
  }
  if (!isHex64(manifest["semanticRoot"])) {
    return fail("SEMANTIC_ROOT_MISMATCH", "semanticRoot must be 64-char hex");
  }
  const records = manifest["records"];
  if (!isUnknownArray(records)) {
    return fail("MANIFEST_RECORD_HASH_INVALID", "records must be array");
  }
  const hashes: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!isObject(r) || !isHex64(r["sha256"])) {
      return fail("MANIFEST_RECORD_HASH_INVALID", `record[${i}].sha256 must be 64-char hex`);
    }
    hashes.push(r["sha256"]);
  }
  const sorted = [...hashes].sort();
  const computed = sha256Hex(canonicalJsonBytes(sorted));
  if (computed !== manifest["semanticRoot"]) {
    return fail("SEMANTIC_ROOT_MISMATCH", `semantic root mismatch: expected ${computed}`);
  }
  return ok();
}

/** Type guards. */
export function isContainerHeaderV1(v: unknown): v is ContainerHeaderV1 {
  return validateContainerHeader(v).ok;
}

export function isTerminalManifestV1(v: unknown): v is TerminalManifestV1 {
  return validateTerminalManifest(v).ok;
}

// ---------------------------------------------------------------------------
// Wave 3 — format v2 artifact-byte chunk frame validators
// ---------------------------------------------------------------------------
//
// These operate on the LOGICAL frame shape (parsed from the on-wire binary
// encoding by the serializer). They enforce the structural invariants a reader
// checks BEFORE AEAD: valid frame type, media version, entry path shape, chunk
// ordinal bounds, finality, nonce/AAD/ciphertext sizes. AEAD itself is
// performed in the serializer; the cross-entry / cross-manifest binding
// (duplicate / missing / orphan / gap / finality / size / hash) is enforced by
// `validateArtifactFrameSequence` + `validateArtifactStreamManifest`.
// ---------------------------------------------------------------------------

const ARTIFACT_MEDIA_PREFIX = "media/artifacts/";
const ARTIFACT_MEDIA_SUFFIX = ".bin";
const ARTIFACT_OPAQUE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function isValidArtifactEntryPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return false;
  if (path.includes("\\") || path.split("/").some((seg) => seg === "..")) return false;
  if (!path.startsWith(ARTIFACT_MEDIA_PREFIX) || !path.endsWith(ARTIFACT_MEDIA_SUFFIX)) return false;
  const opaqueId = path.slice(ARTIFACT_MEDIA_PREFIX.length, path.length - ARTIFACT_MEDIA_SUFFIX.length);
  return ARTIFACT_OPAQUE_ID_RE.test(opaqueId);
}

/** Validate a single artifact chunk frame's structural bounds (no AEAD). */
export function validateArtifactChunkFrame(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return fail("FRAME_MALFORMED", "artifact chunk frame must be object");
  }
  const errors: PortabilityError[] = [];
  if (value["frameType"] !== "artifact-chunk") {
    errors.push({ code: "FRAME_MALFORMED", message: "frameType must be artifact-chunk", path: "frameType" });
  }
  if (typeof value["mediaVersion"] !== "number" || !Number.isInteger(value["mediaVersion"]) || value["mediaVersion"] <= 0) {
    errors.push({ code: "ARTIFACT_MEDIA_VERSION_UNSUPPORTED", message: "mediaVersion must be positive integer", path: "mediaVersion" });
  }
  if (!isValidArtifactEntryPath(value["entryPath"])) {
    errors.push({ code: "ARTIFACT_MEDIA_PATH_INVALID", message: "entryPath must be media/artifacts/<opaque-id>.bin", path: "entryPath" });
  }
  const ordinal = value["ordinal"];
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) {
    errors.push({ code: "FRAME_ORDINAL_OUT_OF_RANGE", message: "ordinal must be non-negative integer", path: "ordinal" });
  }
  if (typeof value["final"] !== "boolean") {
    errors.push({ code: "FRAME_MALFORMED", message: "final must be boolean", path: "final" });
  }
  const ptl = value["plaintextLength"];
  if (typeof ptl !== "number" || !Number.isInteger(ptl) || ptl < 0) {
    errors.push({ code: "FRAME_MALFORMED", message: "plaintextLength must be non-negative integer", path: "plaintextLength" });
  }
  if (!isBytes(value["nonce"]) || value["nonce"].length !== ARTIFACT_FRAME_NONCE_BYTES) {
    errors.push({ code: "FRAME_MALFORMED", message: `nonce must be ${ARTIFACT_FRAME_NONCE_BYTES}-byte Uint8Array`, path: "nonce" });
  }
  if (!isBytes(value["aad"])) {
    errors.push({ code: "FRAME_MALFORMED", message: "aad must be Uint8Array", path: "aad" });
  } else if (value["aad"].length > PROTECTION_SUITE_BOUNDS.aadMaxBytes) {
    errors.push({ code: "SUITE_AAD_OVERSIZED", message: `aad exceeds ${PROTECTION_SUITE_BOUNDS.aadMaxBytes}`, path: "aad" });
  }
  const ct = value["ciphertext"];
  if (!isBytes(ct)) {
    errors.push({ code: "FRAME_MALFORMED", message: "ciphertext must be Uint8Array", path: "ciphertext" });
  } else if (ct.length < ARTIFACT_FRAME_TAG_BYTES) {
    errors.push({ code: "FRAME_MALFORMED", message: "ciphertext shorter than authentication tag", path: "ciphertext" });
  } else if (ct.length > ARTIFACT_FRAME_MAX_BODY_BYTES) {
    errors.push({ code: "FRAME_CIPHERTEXT_OVERSIZED", message: `ciphertext exceeds ${ARTIFACT_FRAME_MAX_BODY_BYTES}`, path: "ciphertext" });
  }
  if (errors.length > 0) return { ok: false, errors };
  return ok();
}

/** Validate a single artifact terminal-manifest frame's structural bounds. */
export function validateArtifactTerminalFrame(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return fail("FRAME_MALFORMED", "artifact terminal frame must be object");
  }
  const errors: PortabilityError[] = [];
  if (value["frameType"] !== "artifact-manifest") {
    errors.push({ code: "FRAME_MALFORMED", message: "frameType must be artifact-manifest", path: "frameType" });
  }
  if (typeof value["mediaVersion"] !== "number" || !Number.isInteger(value["mediaVersion"]) || value["mediaVersion"] <= 0) {
    errors.push({ code: "ARTIFACT_MEDIA_VERSION_UNSUPPORTED", message: "mediaVersion must be positive integer", path: "mediaVersion" });
  }
  const ordinal = value["ordinal"];
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) {
    errors.push({ code: "FRAME_ORDINAL_OUT_OF_RANGE", message: "ordinal must be non-negative integer", path: "ordinal" });
  }
  if (value["final"] !== true) {
    errors.push({ code: "FRAME_MISSING_FINAL", message: "terminal-manifest frame must have final=true", path: "final" });
  }
  const ptl = value["plaintextLength"];
  if (typeof ptl !== "number" || !Number.isInteger(ptl) || ptl < 0) {
    errors.push({ code: "FRAME_MALFORMED", message: "plaintextLength must be non-negative integer", path: "plaintextLength" });
  }
  if (!isBytes(value["nonce"]) || value["nonce"].length !== ARTIFACT_FRAME_NONCE_BYTES) {
    errors.push({ code: "FRAME_MALFORMED", message: `nonce must be ${ARTIFACT_FRAME_NONCE_BYTES}-byte Uint8Array`, path: "nonce" });
  }
  if (!isBytes(value["aad"])) {
    errors.push({ code: "FRAME_MALFORMED", message: "aad must be Uint8Array", path: "aad" });
  } else if (value["aad"].length > PROTECTION_SUITE_BOUNDS.aadMaxBytes) {
    errors.push({ code: "SUITE_AAD_OVERSIZED", message: `aad exceeds ${PROTECTION_SUITE_BOUNDS.aadMaxBytes}`, path: "aad" });
  }
  const ct = value["ciphertext"];
  if (!isBytes(ct)) {
    errors.push({ code: "FRAME_MALFORMED", message: "ciphertext must be Uint8Array", path: "ciphertext" });
  } else if (ct.length < ARTIFACT_FRAME_TAG_BYTES) {
    errors.push({ code: "FRAME_MALFORMED", message: "ciphertext shorter than authentication tag", path: "ciphertext" });
  }
  if (errors.length > 0) return { ok: false, errors };
  return ok();
}

/**
 * Validate an ordered sequence of artifact chunk frames for ONE entry: strict
 * 0-based ordinals with no gaps or duplicates, exactly one final chunk as the
 * highest ordinal. Does not decrypt. Operates on the logical chunk frames.
 */
export function validateArtifactChunkSequence(frames: unknown): ValidationResult {
  if (!Array.isArray(frames)) {
    return fail("FRAME_MALFORMED", "artifact chunk sequence must be array");
  }
  if (frames.length === 0) {
    return fail("FRAME_MISSING_FINAL", "artifact chunk sequence must not be empty");
  }
  let result: ValidationResult = ok();
  const seen = new Set<number>();
  let finalCount = 0;
  let maxOrdinal = -1;
  let finalOrdinal: number | undefined;
  for (let i = 0; i < frames.length; i++) {
    const r = validateArtifactChunkFrame(frames[i]);
    if (!r.ok) {
      for (const e of r.errors) {
        result = appendError(result, e.code, e.message, e.path !== undefined ? `frames[${i}].${e.path}` : `frames[${i}]`);
      }
    }
    const f = frames[i] as ArtifactChunkFrame | undefined;
    if (f !== undefined && typeof f.ordinal === "number") {
      if (seen.has(f.ordinal)) {
        result = appendError(result, "FRAME_ORDINAL_DUPLICATE", `duplicate chunk ordinal ${f.ordinal}`, `frames[${i}].ordinal`);
      } else {
        seen.add(f.ordinal);
      }
      if (f.ordinal > maxOrdinal) maxOrdinal = f.ordinal;
      if (f.final) {
        finalCount += 1;
        finalOrdinal = f.ordinal;
      }
    }
  }
  for (let expected = 0; expected < seen.size; expected++) {
    if (!seen.has(expected)) {
      result = appendError(result, "FRAME_ORDINAL_GAP", `missing chunk ordinal ${expected}`, "frames");
    }
  }
  if (finalCount === 0) {
    result = appendError(result, "FRAME_MISSING_FINAL", "no final chunk in artifact chunk sequence", "frames");
  } else if (finalCount > 1) {
    result = appendError(result, "FRAME_MULTIPLE_FINAL", `${finalCount} final chunks in artifact chunk sequence`, "frames");
  } else if (finalOrdinal !== undefined && finalOrdinal !== maxOrdinal) {
    result = appendError(result, "FRAME_MISSING_FINAL", "final chunk must be the highest ordinal", "frames");
  }
  return result;
}

/** Validate the structural shape of an authenticated artifact stream manifest. */
export function validateArtifactStreamManifest(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return fail("ARTIFACT_MEDIA_VERSION_UNSUPPORTED", "artifact stream manifest must be object");
  }
  let result: ValidationResult = ok();
  const mv = value["mediaVersion"];
  if (typeof mv !== "number" || !Number.isInteger(mv) || mv <= 0) {
    result = appendError(result, "ARTIFACT_MEDIA_VERSION_UNSUPPORTED", "mediaVersion must be positive integer", "mediaVersion");
  }
  const entries = value["entries"];
  if (!isUnknownArray(entries)) {
    return appendError(result, "ARTIFACT_MEDIA_PATH_INVALID", "entries must be array", "entries");
  }
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isObject(e)) {
      result = appendError(result, "MANIFEST_MALFORMED_FRAME", "manifest entry must be object", `entries[${i}]`);
      continue;
    }
    if (!isValidArtifactEntryPath(e["entryPath"])) {
      result = appendError(result, "ARTIFACT_MEDIA_PATH_INVALID", "entryPath must be media/artifacts/<opaque-id>.bin", `entries[${i}].entryPath`);
    } else if (seen.has(e["entryPath"])) {
      result = appendError(result, "ARTIFACT_MEDIA_DUPLICATE", `duplicate manifest entryPath: ${e["entryPath"]}`, `entries[${i}].entryPath`);
    } else {
      seen.add(e["entryPath"]);
    }
    const size = e["size"];
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      result = appendError(result, "ARTIFACT_MEDIA_SIZE_INVALID", "size must be non-negative number", `entries[${i}].size`);
    }
    if (!isHex64(e["sha256"])) {
      result = appendError(result, "ARTIFACT_MEDIA_SHA_INVALID", "sha256 must be 64-char hex", `entries[${i}].sha256`);
    }
    const cc = e["chunkCount"];
    if (typeof cc !== "number" || !Number.isInteger(cc) || cc < 0) {
      result = appendError(result, "MANIFEST_MALFORMED_FRAME", "chunkCount must be non-negative integer", `entries[${i}].chunkCount`);
    }
  }
  return result;
}

/** Type guard for a single artifact chunk frame. */
export function isArtifactChunkFrame(v: unknown): v is ArtifactChunkFrame {
  return validateArtifactChunkFrame(v).ok;
}

/** Type guard for a single artifact terminal-manifest frame. */
export function isArtifactTerminalFrame(v: unknown): v is ArtifactTerminalFrame {
  return validateArtifactTerminalFrame(v).ok;
}

/** Type guard for the artifact stream manifest. */
export function isArtifactStreamManifest(v: unknown): v is ArtifactStreamManifest {
  return validateArtifactStreamManifest(v).ok;
}

export type { ArtifactFrame };

export type { SemanticVersion };
