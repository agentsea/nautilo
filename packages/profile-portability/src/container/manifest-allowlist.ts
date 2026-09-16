/**
 * Canonical archive manifest allowlist parser/rejector.
 *
 * A `.nautilo-profile` archive is a fixed set of named entries. This validator
 * rejects — before any extraction or source/target mutation — entries that
 * are: outside the allowlist (`MANIFEST_UNKNOWN_PATH`), duplicates
 * (`MANIFEST_DUPLICATE_PATH`), path traversal / absolute paths
 * (`MANIFEST_TRAVERSAL` / `MANIFEST_ABSOLUTE_PATH`), symlinks
 * (`MANIFEST_SYMLINK`), oversized per-entry or total (`MANIFEST_ENTRY_OVERSIZED`
 * / `MANIFEST_ARCHIVE_OVERSIZED`), compressed (`MANIFEST_COMPRESSION_NOT_ALLOWED`),
 * or compression bombs (`MANIFEST_COMPRESSION_BOMB`). It also rejects
 * malformed frame entries (`MANIFEST_MALFORMED_FRAME`).
 *
 * No filesystem I/O is performed; this operates on the declared manifest only.
 */

import { appendError, fail, ok, type PortabilityError, type ValidationResult } from "../errors";
import { LIMITS } from "./limits";
import { ARCHIVE_ALLOWLIST, type ArchiveEntry } from "./types";

type Rec = Record<string, unknown>;

function isAllowedPath(path: string): boolean {
  for (const prefix of ARCHIVE_ALLOWLIST) {
    if (prefix.endsWith("/")) {
      if (path.startsWith(prefix)) return true;
    } else if (path === prefix) {
      return true;
    }
  }
  return false;
}

function hasTraversal(path: string): boolean {
  const segs = path.split("/");
  for (const seg of segs) {
    if (seg === "..") return true;
  }
  return false;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

export function validateArchiveEntry(entry: unknown): ValidationResult {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return fail("MANIFEST_MALFORMED_FRAME", "archive entry must be object");
  }
  const e = entry as Rec;
  const errors: PortabilityError[] = [];
  const path = e["path"];
  if (typeof path !== "string" || path.length === 0) {
    errors.push({ code: "MANIFEST_MALFORMED_FRAME", message: "entry path must be non-empty string", path: "path" });
  } else {
    if (isAbsolute(path)) errors.push({ code: "MANIFEST_ABSOLUTE_PATH", message: `absolute path not allowed: ${path}`, path: "path" });
    if (hasTraversal(path)) errors.push({ code: "MANIFEST_TRAVERSAL", message: `traversal segment not allowed: ${path}`, path: "path" });
    if (!isAllowedPath(path)) errors.push({ code: "MANIFEST_UNKNOWN_PATH", message: `path not in allowlist: ${path}`, path: "path" });
  }
  const kind = e["kind"];
  if (kind === "symlink") {
    errors.push({ code: "MANIFEST_SYMLINK", message: `symlink entry not allowed: ${typeof path === "string" ? path : ""}`, path: "kind" });
  } else if (kind !== "file" && kind !== "directory") {
    errors.push({ code: "MANIFEST_MALFORMED_FRAME", message: `entry kind must be file|directory|symlink`, path: "kind" });
  }
  const size = e["size"];
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    errors.push({ code: "MANIFEST_MALFORMED_FRAME", message: "size must be non-negative number", path: "size" });
  } else if (size > LIMITS.maxArchiveEntryBytes) {
    errors.push({ code: "MANIFEST_ENTRY_OVERSIZED", message: `entry size ${size} exceeds ${LIMITS.maxArchiveEntryBytes}`, path: "size" });
  }
  const compressedSize = e["compressedSize"];
  if (typeof compressedSize !== "number" || !Number.isFinite(compressedSize) || compressedSize < 0) {
    errors.push({ code: "MANIFEST_MALFORMED_FRAME", message: "compressedSize must be non-negative number", path: "compressedSize" });
  }
  if (e["isCompressed"] === true) {
    errors.push({ code: "MANIFEST_COMPRESSION_NOT_ALLOWED", message: "compressed entries are not allowed", path: "isCompressed" });
  }
  if (typeof size === "number" && typeof compressedSize === "number" && compressedSize > 0 && size / compressedSize > LIMITS.compressionBombRatio) {
    errors.push({ code: "MANIFEST_COMPRESSION_BOMB", message: `compression ratio ${size}/${compressedSize} exceeds ${LIMITS.compressionBombRatio}`, path: "compressedSize" });
  }
  if (errors.length > 0) return { ok: false, errors };
  return ok();
}

/** Validate a full archive manifest (ordered list of declared entries). */
export function validateArchiveManifest(entries: unknown): ValidationResult {
  if (!Array.isArray(entries)) {
    return fail("MANIFEST_MALFORMED_FRAME", "archive manifest must be array");
  }
  let result: ValidationResult = ok();
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < entries.length; i++) {
    const r = validateArchiveEntry(entries[i]);
    if (!r.ok) {
      for (const e of r.errors) {
        result = appendError(result, e.code, e.message, e.path !== undefined ? `entries[${i}].${e.path}` : `entries[${i}]`);
      }
    }
    const entry = entries[i] as ArchiveEntry | undefined;
    if (entry !== undefined && typeof entry.path === "string") {
      if (seen.has(entry.path)) {
        result = appendError(result, "MANIFEST_DUPLICATE_PATH", `duplicate path: ${entry.path}`, `entries[${i}].path`);
      } else {
        seen.add(entry.path);
      }
      if (typeof entry.size === "number" && Number.isFinite(entry.size)) {
        total += entry.size;
      }
    }
  }
  if (total > LIMITS.maxArchiveTotalBytes) {
    result = appendError(result, "MANIFEST_ARCHIVE_OVERSIZED", `total ${total} exceeds ${LIMITS.maxArchiveTotalBytes}`, "entries");
  }
  return result;
}

