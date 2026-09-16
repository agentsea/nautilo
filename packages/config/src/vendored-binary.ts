// Generic vendored-binary integrity gate (D392) — tool-agnostic, node-only.
//
// A shared, manifest-agnostic verify-once primitive for third-party binaries we
// vendor (OfficeCLI and desktop tool runtimes such as agent-browser and gog).
// It does NOT know about any manifest schema or
// resolution strategy: the caller resolves a concrete binary path and looks up
// the pinned sha for it, then hands both here. This keeps each tool's resolver /
// manifest shape where it belongs and centralizes only the security-sensitive
// hash-and-cache logic.
//
// Isolated behind the `@nautilo/config/vendored-binary` subpath (like
// `federated-id-pure` / `loopback-origin`) so it never leaks node:crypto/fs into
// browser bundles that import the `@nautilo/config` barrel.

import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

/** Lowercase hex sha256. */
export const VENDORED_SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export function normalizeSha256Hex(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return VENDORED_SHA256_HEX_RE.test(trimmed) ? trimmed : null;
}

/** Compute the sha256 hex digest of an in-memory buffer. */
export function sha256HexOfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stream a file and return its sha256 hex digest. */
export async function sha256HexOfFile(filePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/**
 * Integrity policy for a resolved binary:
 *  - `"strict"`         — a sha mismatch REFUSES the binary. Use where the
 *                         vendored bytes are never mutated post-install: Linux
 *                         servers / CI (precisely where a compromised deploy is
 *                         the live threat).
 *  - `"tolerate-signed"`— a sha mismatch is TOLERATED (ok + `note`). Use on
 *                         **signed-at-package platforms** where the OS/toolchain
 *                         rewrites the binary after vendoring: macOS (ad-hoc
 *                         codesign on first exec) and Windows (Authenticode at
 *                         package time). The fetch-time verification of the
 *                         pristine downloaded bytes is the authoritative check
 *                         there; the on-disk sha legitimately drifts.
 */
export type VendoredBinaryVerifyPolicy = "strict" | "tolerate-signed";

export type VendoredBinaryVerifyOutcome =
  | {
      readonly ok: true;
      readonly binaryPath: string;
      /** true when a pinned sha was hashed and matched (or tolerated). */
      readonly shaChecked: boolean;
      /** present when a mismatch was tolerated (`tolerate-signed`) — caller should log. */
      readonly note?: string;
    }
  | {
      readonly ok: false;
      readonly code: "UNAVAILABLE" | "CHECKSUM_MISMATCH";
      readonly error: string;
    };

export interface VerifyVendoredBinaryOnceInput {
  /** Absolute path of an already-resolved, existing+executable binary, or null. */
  readonly binaryPath: string | null;
  /**
   * The pinned sha for THIS binary, or null/undefined when nothing is pinned
   * (operator override / unmanaged) — in which case the binary is trusted
   * without hashing (`shaChecked:false`). We can only verify what we pinned.
   */
  readonly expectedSha256?: string | null;
  /** Mismatch handling. Defaults to `"strict"`. */
  readonly policy?: VendoredBinaryVerifyPolicy;
  /** Human label for messages, e.g. "OfficeCLI". */
  readonly label?: string;
  /**
   * Per-process cache keyed by absolute binary path → usable? Callers pass their
   * own Map to isolate/reset independently; defaults to a shared module cache.
   */
  readonly cache?: Map<string, boolean>;
}

const defaultCache = new Map<string, boolean>();

/** Clear a verify-once cache (defaults to the shared module cache). Test-friendly. */
export function resetVendoredBinaryVerifyCache(cache: Map<string, boolean> = defaultCache): void {
  cache.clear();
}

/**
 * Verify a resolved vendored binary against its pinned sha **once per process**
 * (cached by path), applying the given platform policy. Never throws.
 */
export async function verifyVendoredBinaryOnce(
  input: VerifyVendoredBinaryOnceInput,
): Promise<VendoredBinaryVerifyOutcome> {
  const label = input.label ?? "vendored binary";
  const { binaryPath } = input;
  if (binaryPath === null) {
    return { ok: false, code: "UNAVAILABLE", error: `No usable ${label} binary on this host.` };
  }

  const cache = input.cache ?? defaultCache;
  const cached = cache.get(binaryPath);
  if (cached !== undefined) {
    return cached
      ? { ok: true, binaryPath, shaChecked: true }
      : {
          ok: false,
          code: "CHECKSUM_MISMATCH",
          error: `${label} binary previously failed integrity verification: ${binaryPath}`,
        };
  }

  const expected =
    input.expectedSha256 === undefined || input.expectedSha256 === null
      ? null
      : normalizeSha256Hex(input.expectedSha256);

  if (expected === null) {
    // Nothing pinned to compare against (override / unmanaged) — trust once.
    cache.set(binaryPath, true);
    return { ok: true, binaryPath, shaChecked: false };
  }

  let actualSha: string;
  try {
    statSync(binaryPath); // fast existence check before streaming
    actualSha = await sha256HexOfFile(binaryPath);
  } catch (err) {
    cache.set(binaryPath, false);
    return {
      ok: false,
      code: "CHECKSUM_MISMATCH",
      error: `Failed to hash ${label} binary ${binaryPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (actualSha === expected) {
    cache.set(binaryPath, true);
    return { ok: true, binaryPath, shaChecked: true };
  }

  if ((input.policy ?? "strict") === "tolerate-signed") {
    cache.set(binaryPath, true);
    return {
      ok: true,
      binaryPath,
      shaChecked: true,
      note: `${label} sha differs from manifest (expected ${expected}, got ${actualSha}); tolerated on a signed-at-package platform (macOS codesign / Windows Authenticode mutate bytes post-vendor).`,
    };
  }

  cache.set(binaryPath, false);
  return {
    ok: false,
    code: "CHECKSUM_MISMATCH",
    error: `${label} sha256 mismatch for ${binaryPath}: expected ${expected}, got ${actualSha}.`,
  };
}
