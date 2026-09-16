/**
 * Structural validators for `GenieLiveV1` and its semantic records.
 *
 * Enforces the content boundary: known record kinds, allowed top-level keys
 * per kind, primitive field types, and rejection of forbidden field names
 * (source IDs, credentials, embeddings, etc.). Does NOT implement encryption,
 * derivation, or any production behavior.
 */

import {
  appendError,
  fail,
  ok,
  type PortabilityError,
  type ValidationResult,
} from "../errors";
import { SEMANTIC_VERSION } from "../versions";
import {
  ALL_PORTABLE_SCOPES,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MEDIA_FORMAT_VERSION,
  ARTIFACT_OPAQUE_ID_RE,
  FORBIDDEN_FIELD_NAMES,
  MEMORY_RECORD_TYPE_MAX_UTF8_BYTES,
  SEMANTIC_RECORD_KINDS,
  type GenieLiveV1,
  type PortableArtifact,
  type PortableScope,
  type SemanticRecord,
  type SemanticRecordKind,
  type SemanticRecordV1_0,
  type SemanticRecordV1_1,
} from "./types";

type Rec = Record<string, unknown>;

const HEX_RE = /^[0-9a-f]{64}$/;
const BUNDLE_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const ARTIFACT_MEDIA_PREFIX = "media/artifacts/";
const ARTIFACT_MEDIA_SUFFIX = ".bin";

function isObject(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUnknownArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isBoundedMemoryType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = utf8Length(value);
  return length >= 1 && length <= MEMORY_RECORD_TYPE_MAX_UTF8_BYTES;
}

function isNullString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNullNumber(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

function isPortableScope(v: unknown): v is PortableScope {
  return typeof v === "string" && (ALL_PORTABLE_SCOPES as readonly string[]).includes(v);
}

function isRecordKind(v: unknown): v is SemanticRecordKind {
  return typeof v === "string" && (SEMANTIC_RECORD_KINDS as readonly string[]).includes(v);
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

function hasTraversal(path: string): boolean {
  const segs = path.split("/");
  for (const seg of segs) {
    if (seg === "..") return true;
  }
  return false;
}

/**
 * Validate a `media/artifacts/<opaque-id>.bin` opaque media path and return
 * the opaque id, or push path errors and return null. Rejects absolute,
 * traversal, backslash, missing prefix/suffix, and bad opaque-id charset.
 */
function validateArtifactMediaPath(
  path: unknown,
  fieldPath: string,
  errors: PortabilityError[],
): string | null {
  if (typeof path !== "string" || path.length === 0) {
    errors.push({ code: "ARTIFACT_MEDIA_PATH_INVALID", message: "path must be non-empty string", path: fieldPath });
    return null;
  }
  if (isAbsolute(path)) {
    errors.push({ code: "ARTIFACT_MEDIA_PATH_INVALID", message: `absolute path not allowed: ${path}`, path: fieldPath });
    return null;
  }
  if (hasTraversal(path) || path.includes("\\")) {
    errors.push({ code: "ARTIFACT_MEDIA_PATH_INVALID", message: `unsafe path segment not allowed: ${path}`, path: fieldPath });
    return null;
  }
  if (!path.startsWith(ARTIFACT_MEDIA_PREFIX) || !path.endsWith(ARTIFACT_MEDIA_SUFFIX)) {
    errors.push({ code: "ARTIFACT_MEDIA_PATH_INVALID", message: `path must be media/artifacts/<opaque-id>.bin: ${path}`, path: fieldPath });
    return null;
  }
  const opaqueId = path.slice(ARTIFACT_MEDIA_PREFIX.length, path.length - ARTIFACT_MEDIA_SUFFIX.length);
  if (!ARTIFACT_OPAQUE_ID_RE.test(opaqueId)) {
    errors.push({ code: "ARTIFACT_MEDIA_PATH_INVALID", message: `opaque-id must match ${ARTIFACT_OPAQUE_ID_RE.source}: ${opaqueId}`, path: fieldPath });
    return null;
  }
  return opaqueId;
}

function rejectUnknownKeys(
  obj: Rec,
  allowed: readonly string[],
  path: string,
  errors: PortabilityError[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push({
        code: "SEMANTIC_RECORD_FORBIDDEN_FIELD",
        message: `unknown field "${key}" on record`,
        path: `${path}.${key}`,
      });
    }
  }
  for (const forbidden of FORBIDDEN_FIELD_NAMES) {
    if (Object.prototype.hasOwnProperty.call(obj, forbidden)) {
      errors.push({
        code: "SEMANTIC_RECORD_FORBIDDEN_FIELD",
        message: `forbidden field "${forbidden}" on record`,
        path: `${path}.${forbidden}`,
      });
    }
  }
}

function validateVoiceMapEntry(v: unknown, path: string, errors: PortabilityError[]): boolean {
  if (!isObject(v)) {
    errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "expected voice entry object", path });
    return false;
  }
  let good = true;
  if (v["slot"] !== undefined && (!isString(v["slot"]) || v["slot"].trim().length === 0)) {
    errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "slot must be a non-empty string when present", path: `${path}.slot` });
    good = false;
  }
  if (!isString(v["voiceId"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "voiceId must be string", path: `${path}.voiceId` }); good = false; }
  if (!isString(v["label"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "label must be string", path: `${path}.label` }); good = false; }
  if (!isNullString(v["provider"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "provider must be string|null", path: `${path}.provider` }); good = false; }
  if (!isNullString(v["voiceUri"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "voiceUri must be string|null", path: `${path}.voiceUri` }); good = false; }
  rejectUnknownKeys(v, ["slot", "voiceId", "label", "provider", "voiceUri"], path, errors);
  return good;
}

function validateModelPolicy(v: unknown, path: string, errors: PortabilityError[]): boolean {
  if (!isObject(v)) {
    errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "expected modelPolicy object", path });
    return false;
  }
  let good = true;
  if (!isNullString(v["primaryModel"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "primaryModel must be string|null", path: `${path}.primaryModel` }); good = false; }
  if (!isNullString(v["fallbackModel"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "fallbackModel must be string|null", path: `${path}.fallbackModel` }); good = false; }
  if (!isNullNumber(v["temperature"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "temperature must be number|null", path: `${path}.temperature` }); good = false; }
  rejectUnknownKeys(v, ["primaryModel", "fallbackModel", "temperature"], path, errors);
  return good;
}

function validateAvatarRef(v: unknown, path: string, errors: PortabilityError[]): boolean {
  if (!isObject(v)) {
    errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "expected avatar object", path });
    return false;
  }
  let good = true;
  if (!isString(v["mediaEntry"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "mediaEntry must be string", path: `${path}.mediaEntry` }); good = false; }
  if (!isString(v["mimeType"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "mimeType must be string", path: `${path}.mimeType` }); good = false; }
  if (!isHex64(v["sha256"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "sha256 must be 64-char hex", path: `${path}.sha256` }); good = false; }
  if (!isNullNumber(v["width"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "width must be number|null", path: `${path}.width` }); good = false; }
  if (!isNullNumber(v["height"])) { errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "height must be number|null", path: `${path}.height` }); good = false; }
  rejectUnknownKeys(v, ["mediaEntry", "mimeType", "sha256", "width", "height"], path, errors);
  return good;
}

function validatePreferences(v: unknown, path: string, errors: PortabilityError[]): boolean {
  if (!isObject(v)) {
    errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "expected preferences object", path });
    return false;
  }
  let good = true;
  for (const key of Object.keys(v)) {
    const val = v[key];
    const okVal = val === null || typeof val === "string" || typeof val === "boolean" || (typeof val === "number" && Number.isFinite(val));
    if (!okVal) {
      errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "preference value must be string|number|boolean|null", path: `${path}.${key}` });
      good = false;
    }
  }
  return good;
}

/** Validate a single semantic record (parsed from untrusted input). */
export function validateSemanticRecord(
  value: unknown,
  semanticMinor: 0 | 1 = SEMANTIC_VERSION.minor,
): ValidationResult {
  if (semanticMinor !== 0 && semanticMinor !== 1) {
    return fail(
      "UNSUPPORTED_SEMANTIC_VERSION",
      `semantic minor ${String(semanticMinor)} not supported`,
      "semanticVersion.minor",
    );
  }
  if (!isObject(value)) {
    return fail("SEMANTIC_RECORD_FIELD_INVALID", "record must be an object");
  }
  const kind = value["recordKind"];
  if (!isRecordKind(kind)) {
    return fail("SEMANTIC_RECORD_UNKNOWN_KIND", `unknown recordKind: ${String(kind)}`);
  }
  const errors: PortabilityError[] = [];
  const path = `record[${kind}]`;

  switch (kind) {
    case "identity": {
      rejectUnknownKeys(value, ["recordKind", "name", "handleIntent"], path, errors);
      if (!isString(value["name"])) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "name must be string", path: `${path}.name` });
      if (!isNullString(value["handleIntent"])) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "handleIntent must be string|null", path: `${path}.handleIntent` });
      break;
    }
    case "soul": {
      rejectUnknownKeys(value, ["recordKind", "text"], path, errors);
      if (!isNullString(value["text"])) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "text must be string|null", path: `${path}.text` });
      break;
    }
    case "personality": {
      rejectUnknownKeys(value, ["recordKind", "text"], path, errors);
      if (!isNullString(value["text"])) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "text must be string|null", path: `${path}.text` });
      break;
    }
    case "voices": {
      rejectUnknownKeys(value, ["recordKind", "voices"], path, errors);
      const voices = value["voices"];
      if (!Array.isArray(voices)) {
        errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "voices must be array", path: `${path}.voices` });
      } else {
        for (let i = 0; i < voices.length; i++) {
          validateVoiceMapEntry(voices[i], `${path}.voices[${i}]`, errors);
        }
      }
      break;
    }
    case "modelPolicy": {
      rejectUnknownKeys(value, ["recordKind", "policy"], path, errors);
      validateModelPolicy(value["policy"], `${path}.policy`, errors);
      break;
    }
    case "avatar": {
      rejectUnknownKeys(value, ["recordKind", "avatar"], path, errors);
      const av = value["avatar"];
      if (av !== null && av !== undefined) {
        validateAvatarRef(av, `${path}.avatar`, errors);
      }
      break;
    }
    case "preferences": {
      rejectUnknownKeys(value, ["recordKind", "preferences"], path, errors);
      validatePreferences(value["preferences"], `${path}.preferences`, errors);
      break;
    }
    case "memory": {
      rejectUnknownKeys(
        value,
        semanticMinor === 0
          ? ["recordKind", "scope", "content", "createdAt"]
          : ["recordKind", "scope", "type", "content", "createdAt"],
        path,
        errors,
      );
      if (value["scope"] !== "private") errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "memory scope must be private", path: `${path}.scope` });
      if (
        semanticMinor === 1
        && !isBoundedMemoryType(value["type"])
      ) {
        errors.push({
          code: "SEMANTIC_RECORD_FIELD_INVALID",
          message: `memory type must be 1-${MEMORY_RECORD_TYPE_MAX_UTF8_BYTES} UTF-8 bytes`,
          path: `${path}.type`,
        });
      }
      if (!isString(value["content"])) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "content must be string", path: `${path}.content` });
      if (!isNullString(value["createdAt"])) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "createdAt must be string|null", path: `${path}.createdAt` });
      break;
    }
    case "artifact": {
      rejectUnknownKeys(value, ["recordKind", "path", "mimeType", "size", "sha256", "bytesEntry"], path, errors);
      const logicalPath = value["path"];
      if (typeof logicalPath !== "string" || logicalPath.length === 0) {
        errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "path must be non-empty string", path: `${path}.path` });
      } else if (isAbsolute(logicalPath) || hasTraversal(logicalPath) || logicalPath.includes("\\")) {
        errors.push({ code: "ARTIFACT_MEDIA_PATH_INVALID", message: `unsafe logical path not allowed: ${logicalPath}`, path: `${path}.path` });
      }
      if (!isString(value["mimeType"])) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "mimeType must be string", path: `${path}.mimeType` });
      const size = value["size"];
      if (!isNumber(size) || size < 0) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "size must be non-negative number", path: `${path}.size` });
      if (!isHex64(value["sha256"])) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "sha256 must be 64-char hex", path: `${path}.sha256` });
      // bytesEntry is the opaque media location and MUST be a valid
      // media/artifacts/<opaque-id>.bin path (format v2).
      validateArtifactMediaPath(value["bytesEntry"], `${path}.bytesEntry`, errors);
      break;
    }
    case "skill": {
      rejectUnknownKeys(value, ["recordKind", "kind", "name", "disabledByDefault"], path, errors);
      const k = value["kind"];
      if (k !== "command" && k !== "skill") errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "kind must be command|skill", path: `${path}.kind` });
      if (!isString(value["name"])) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "name must be string", path: `${path}.name` });
      if (value["disabledByDefault"] !== true) errors.push({ code: "SEMANTIC_RECORD_FIELD_INVALID", message: "disabledByDefault must be true", path: `${path}.disabledByDefault` });
      break;
    }
    default: {
      return fail("SEMANTIC_RECORD_UNKNOWN_KIND", "unhandled recordKind");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return ok();
}

/** Validate a single format v2 artifact media entry (parsed from untrusted input). */
export function validateArtifactMediaEntry(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return fail("ARTIFACT_MEDIA_PATH_INVALID", "artifact media entry must be an object");
  }
  const errors: PortabilityError[] = [];
  validateArtifactMediaPath(value["path"], "path", errors);
  const size = value["size"];
  if (!isNumber(size) || size < 0) {
    errors.push({ code: "ARTIFACT_MEDIA_SIZE_INVALID", message: "size must be non-negative number", path: "size" });
  } else if (size > ARTIFACT_MAX_BYTES) {
    errors.push({ code: "ARTIFACT_MEDIA_SIZE_INVALID", message: `size ${size} exceeds ${ARTIFACT_MAX_BYTES}`, path: "size" });
  }
  if (!isHex64(value["sha256"])) {
    errors.push({ code: "ARTIFACT_MEDIA_SHA_INVALID", message: "sha256 must be 64-char hex", path: "sha256" });
  }
  rejectUnknownKeys(value, ["path", "size", "sha256"], "entry", errors);
  if (errors.length > 0) return { ok: false, errors };
  return ok();
}

/**
 * Validate the format v2 artifact media manifest and enforce the 1:1 binding
 * with the bundle's `PortableArtifact` records by `bytesEntry`.
 *
 * Rules: `mediaVersion` must be `ARTIFACT_MEDIA_FORMAT_VERSION`; every entry
 * path is a valid opaque `media/artifacts/<opaque-id>.bin`; entry paths are
 * unique; every `PortableArtifact.bytesEntry` references exactly one entry
 * (`ARTIFACT_MEDIA_MISSING`); every entry is referenced by exactly one
 * artifact (`ARTIFACT_MEDIA_ORPHAN`); no two artifacts share a `bytesEntry`
 * (`ARTIFACT_BYTES_ENTRY_DUPLICATE`); and each matched pair's `size` and
 * `sha256` agree (`ARTIFACT_MEDIA_MISMATCH`).
 */
export function validateArtifactMediaManifest(
  manifest: unknown,
  artifacts: readonly PortableArtifact[],
): ValidationResult {
  if (!isObject(manifest)) {
    return fail("ARTIFACT_MEDIA_VERSION_UNSUPPORTED", "artifact media manifest must be an object");
  }
  let result: ValidationResult = ok();
  const mv = manifest["mediaVersion"];
  if (mv !== ARTIFACT_MEDIA_FORMAT_VERSION) {
    result = appendError(result, "ARTIFACT_MEDIA_VERSION_UNSUPPORTED", `mediaVersion must be ${ARTIFACT_MEDIA_FORMAT_VERSION}: ${String(mv)}`, "mediaVersion");
  }
  const entries = manifest["entries"];
  if (!Array.isArray(entries)) {
    result = appendError(result, "ARTIFACT_MEDIA_PATH_INVALID", "entries must be array", "entries");
    return result;
  }

  // Per-entry structural validation + duplicate-path detection.
  const entriesByPath = new Map<string, { size: number; sha256: string }>();
  for (let i = 0; i < entries.length; i++) {
    const r = validateArtifactMediaEntry(entries[i]);
    if (!r.ok) {
      for (const e of r.errors) {
        result = appendError(result, e.code, e.message, e.path !== undefined ? `entries[${i}].${e.path}` : `entries[${i}]`);
      }
    }
    const entry = entries[i] as Rec | undefined;
    if (entry !== undefined && typeof entry["path"] === "string") {
      const p = entry["path"];
      if (entriesByPath.has(p)) {
        result = appendError(result, "ARTIFACT_MEDIA_DUPLICATE", `duplicate media entry path: ${p}`, `entries[${i}].path`);
      } else {
        entriesByPath.set(p, { size: entry["size"] as number, sha256: entry["sha256"] as string });
      }
    }
  }

  // Artifact-side: collect bytesEntry, reject duplicate bytesEntry, and
  // cross-check size/sha256 against the matched media entry.
  const seenBytesEntry = new Set<string>();
  let artifactIndex = 0;
  for (const art of artifacts) {
    const be = art.bytesEntry;
    if (seenBytesEntry.has(be)) {
      result = appendError(result, "ARTIFACT_BYTES_ENTRY_DUPLICATE", `duplicate artifact bytesEntry: ${be}`, `artifactRecords[${artifactIndex}].bytesEntry`);
      artifactIndex++;
      continue;
    }
    seenBytesEntry.add(be);
    const media = entriesByPath.get(be);
    if (media === undefined) {
      result = appendError(result, "ARTIFACT_MEDIA_MISSING", `no media entry for artifact bytesEntry: ${be}`, `artifactRecords[${artifactIndex}].bytesEntry`);
      artifactIndex++;
      continue;
    }
    if (media.size !== art.size) {
      result = appendError(result, "ARTIFACT_MEDIA_MISMATCH", `size mismatch: artifact ${art.size} vs media ${media.size}`, `artifactRecords[${artifactIndex}].size`);
    }
    if (media.sha256 !== art.sha256) {
      result = appendError(result, "ARTIFACT_MEDIA_MISMATCH", `sha256 mismatch for bytesEntry: ${be}`, `artifactRecords[${artifactIndex}].sha256`);
    }
    artifactIndex++;
  }

  // Orphan detection: media entries not referenced by any artifact.
  for (const [path] of entriesByPath) {
    if (!seenBytesEntry.has(path)) {
      result = appendError(result, "ARTIFACT_MEDIA_ORPHAN", `media entry has no matching artifact: ${path}`, `entries[${path}]`);
    }
  }

  return result;
}

/** Validate a full `GenieLiveV1` semantic payload (parsed from untrusted input). */
export function validateGenieLiveV1(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return fail("MALFORMED_HEADER", "genie-live payload must be an object");
  }
  let result: ValidationResult = ok();

  const sv = value["semanticVersion"];
  let semanticMinor: 0 | 1 | undefined;
  if (!isObject(sv) || typeof sv["major"] !== "number" || typeof sv["minor"] !== "number") {
    result = appendError(result, "UNKNOWN_SEMANTIC_VERSION", "semanticVersion must be {major,minor}", "semanticVersion");
  } else if (sv["major"] !== 1) {
    result = appendError(result, "UNSUPPORTED_SEMANTIC_VERSION", `semantic major ${sv["major"]} not supported`, "semanticVersion.major");
  } else if (!Number.isInteger(sv["minor"]) || sv["minor"] < 0) {
    result = appendError(result, "UNKNOWN_SEMANTIC_VERSION", "semantic minor must be non-negative integer", "semanticVersion.minor");
  } else if (sv["minor"] !== 0 && sv["minor"] !== 1) {
    result = appendError(result, "UNSUPPORTED_SEMANTIC_VERSION", `semantic minor ${sv["minor"]} not supported`, "semanticVersion.minor");
  } else {
    semanticMinor = sv["minor"];
  }

  const bundleId = value["bundleId"];
  if (typeof bundleId !== "string" || !BUNDLE_ID_RE.test(bundleId)) {
    result = appendError(result, "BUNDLE_ID_INVALID", "bundleId must match ^[a-zA-Z0-9_-]{8,128}$", "bundleId");
  }

  const scopes = value["scopes"];
  if (!isUnknownArray(scopes)) {
    result = appendError(result, "UNSUPPORTED_SCOPE", "scopes must be array", "scopes");
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < scopes.length; i++) {
      const s = scopes[i];
      if (!isPortableScope(s)) {
        result = appendError(result, "UNSUPPORTED_SCOPE", `unknown scope: ${String(s)}`, `scopes[${i}]`);
      } else if (seen.has(s)) {
        result = appendError(result, "UNSUPPORTED_SCOPE", `duplicate scope: ${s}`, `scopes[${i}]`);
      } else {
        seen.add(s);
      }
    }
  }

  const records = value["records"];
  if (!Array.isArray(records)) {
    result = appendError(result, "SEMANTIC_RECORD_FIELD_INVALID", "records must be array", "records");
  } else if (records.length === 0) {
    result = appendError(result, "SEMANTIC_RECORD_EMPTY", "records must not be empty", "records");
  } else {
    const artifacts: PortableArtifact[] = [];
    for (let i = 0; i < records.length; i++) {
      if (semanticMinor === undefined) continue;
      const r = validateSemanticRecord(records[i], semanticMinor);
      if (!r.ok) {
        for (const e of r.errors) {
          result = appendError(result, e.code, e.message, `records[${i}]${e.path !== undefined ? `:${e.path}` : ""}`);
        }
      } else {
        const rec = records[i] as Rec;
        if (rec["recordKind"] === "artifact") {
          artifacts.push(rec as unknown as PortableArtifact);
        }
      }
    }
    // Format v2 artifact media binding. v1 (avatar-only) bundles have no
    // artifact records and no artifactMedia and stay readable. When either
    // side is present, enforce the strict 1:1 binding.
    const media = value["artifactMedia"];
    if (media !== undefined) {
      const mr = validateArtifactMediaManifest(media, artifacts);
      if (!mr.ok) {
        for (const e of mr.errors) {
          result = appendError(result, e.code, e.message, e.path !== undefined ? `artifactMedia.${e.path}` : "artifactMedia");
        }
      }
    } else if (artifacts.length > 0) {
      for (let i = 0; i < artifacts.length; i++) {
        result = appendError(result, "ARTIFACT_MEDIA_MISSING", `artifact record has no artifactMedia manifest`, `records[${i}].bytesEntry`);
      }
    }
  }

  return result;
}

/** Type guard narrowing a parsed value to a valid `GenieLiveV1`. */
export function isGenieLiveV1(value: unknown): value is GenieLiveV1 {
  return validateGenieLiveV1(value).ok;
}

/** Version-aware type guard for a single semantic record. */
export function isSemanticRecord(
  value: unknown,
  semanticMinor: 0,
): value is SemanticRecordV1_0;
export function isSemanticRecord(
  value: unknown,
  semanticMinor?: 1,
): value is SemanticRecordV1_1;
export function isSemanticRecord(
  value: unknown,
  semanticMinor: 0 | 1 = SEMANTIC_VERSION.minor,
): value is SemanticRecord {
  return validateSemanticRecord(value, semanticMinor).ok;
}
