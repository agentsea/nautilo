/**
 * Canonical encoding and semantic-root hashing helpers.
 *
 * Canonical form: UTF-8 JSON with object keys sorted lexicographically (by
 * UTF-16 code unit, matching `Array.prototype.sort` on strings), no
 * insignificant whitespace, no trailing newline. Arrays preserve order.
 * `undefined`, functions, symbols, bigints, and binary buffers are rejected —
 * semantic records are JSON-safe values by contract (no source IDs, no
 * filesystem paths, no embeddings, no raw bytes).
 *
 * Per-record hash  = sha256Hex(canonicalJson(record)).
 * Semantic root    = sha256Hex(canonicalJson(sortedRecordHashes)) where the
 *                    per-record hashes are sorted ascending before hashing,
 *                    so the root is order-independent over the record set.
 */

import { sha256Hex } from "./sha256";

export class CanonicalEncodingError extends Error {
  public readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} (at ${path})`);
    this.name = "CanonicalEncodingError";
    this.path = path;
  }
}

function canonicalValue(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return jsonString(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalEncodingError("non-finite number not allowed", path);
      }
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      throw new CanonicalEncodingError("undefined not allowed", path);
    case "bigint":
      throw new CanonicalEncodingError("bigint not allowed", path);
    case "function":
    case "symbol":
      throw new CanonicalEncodingError(`${typeof value} not allowed`, path);
    case "object": {
      if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        let out = "[";
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out += ",";
          out += canonicalValue(value[i], `${path}[${i}]`);
        }
        return out + "]";
      }
      if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
        throw new CanonicalEncodingError("binary buffer not allowed in semantic record", path);
      }
      const keys = Object.keys(value).sort();
      if (keys.length === 0) return "{}";
      let out = "{";
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        if (i > 0) out += ",";
        out += jsonString(key) + ":" + canonicalValue(
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
        );
      }
      return out + "}";
    }
    default:
      throw new CanonicalEncodingError(`unsupported value of type ${typeof value}`, path);
  }
}

// Minimal JSON string escaper (RFC 8259), no reliance on platform JSON quirks.
function jsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += "\\u" + hex4(c);
    else out += s[i]!;
  }
  return out + '"';
}

function hex4(n: number): string {
  let s = n.toString(16);
  while (s.length < 4) s = "0" + s;
  return s;
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, "$");
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/** Per-record SHA-256 (hex) over the canonical encoding of one semantic record. */
export function computeRecordHash(record: unknown): string {
  return sha256Hex(canonicalJsonBytes(record));
}

/**
 * Aggregate semantic root over a set of per-record hashes. Hashes are sorted
 * ascending (hex string order) so the root is independent of record order.
 */
export function computeSemanticRoot(recordHashes: readonly string[]): string {
  const sorted = [...recordHashes].sort();
  return sha256Hex(canonicalJsonBytes(sorted));
}
