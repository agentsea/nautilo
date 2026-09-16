/**
 * Pure D385/D378 policy for the Desktop-local media proxy.
 *
 * This module intentionally has no Electron, filesystem, or process imports:
 * canonicalization happens in main before these predicates run. Keeping the
 * authority grammar here makes path/URL/token policy directly testable.
 */

import * as path from "node:path";

export function isOpaqueMediaProxyId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
}

/** Project-relative refs only: no absolute paths, URL grammar or traversal. */
export function isValidBoundMediaRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")) return false;
  if ([...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  })) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Inputs must already be canonical (realpath-resolved) before this check. */
export function isCanonicalPathWithinRoot(candidate: string, root: string): boolean {
  if (!path.isAbsolute(candidate) || !path.isAbsolute(root)) return false;
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  if (normalizedRoot === path.parse(normalizedRoot).root) {
    return normalizedCandidate.startsWith(normalizedRoot);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function parseMediaProxyPreviewToken(url: string): string | null {
  // Do not use URL.pathname here: URL normalizes `/../x` into `/x`, which
  // would turn a rejected lexical path into an accepted capability token.
  const match = /^nautilo-media:\/\/proxy\/([A-Za-z0-9][A-Za-z0-9._~-]*)$/.exec(url);
  return match?.[1] ?? null;
}

/** The URL capability is still renderer-owned; absent owner metadata denies. */
export function isMediaProxyRequestAuthorized(input: {
  previewToken: string | null;
  ownerId: number | undefined;
  requesterId: number | undefined;
}): boolean {
  return input.previewToken !== null
    && typeof input.ownerId === "number"
    && input.ownerId === input.requesterId;
}

/** Whitelist only the browser's byte-range ask; no caller headers are copied. */
export function mediaProxyRangeHeaders(
  headers: unknown,
): Record<string, string> {
  const record = headers && typeof headers === "object" ? headers as Record<string, unknown> : {};
  const getter = record["get"];
  const fromGetter = typeof getter === "function"
    ? (getter as (name: string) => unknown).call(headers, "range")
    : undefined;
  const lower = record["range"];
  const upper = record["Range"];
  const range = typeof fromGetter === "string"
    ? fromGetter
    : typeof lower === "string"
      ? lower
      : typeof upper === "string"
        ? upper
        : null;
  return typeof range === "string" && /^bytes=(?:\d+-\d*|-\d+)$/.test(range)
    ? { Range: range }
    : {};
}
