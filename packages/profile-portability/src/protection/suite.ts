/**
 * Protection suite — opaque declared identifier. Wave 0 treats the suite as
 * a declared identifier and validates only its declared bounds/compatibility
 * (suite id, key/nonce/tag lengths, AAD ceiling). It does NOT implement
 * XChaCha20-Poly1305 AEAD, frame encryption, or decryption — those are out of
 * Wave 0 and must not be stubbed as working behavior.
 *
 * The suite id `xchacha20poly1305-framed-v1` is the only declared suite. A
 * header declaring any other suite is rejected (`UNKNOWN_PROTECTION_SUITE`).
 * Plaintext mode is never permitted: a header/slot declaring no suite or a
 * "plaintext" suite is rejected as `PLAINTEXT_DOWNGRADE`.
 */

import { PROTECTION_SUITE_ID, isKnownProtectionSuite, type ProtectionSuiteId } from "../versions";
import { appendError, fail, ok, type ValidationResult } from "../errors";

export const PROTECTION_SUITE_BOUNDS = {
  suiteId: PROTECTION_SUITE_ID,
  keyBytes: 32,
  nonceBytes: 24,
  tagBytes: 16,
  aadMaxBytes: 1024,
} as const;

export type ProtectionSuiteBounds = typeof PROTECTION_SUITE_BOUNDS;

export type ProtectionSuite = {
  readonly id: ProtectionSuiteId;
  readonly keyBytes: number;
  readonly nonceBytes: number;
  readonly tagBytes: number;
  readonly aadMaxBytes: number;
};

export const DECLARED_PROTECTION_SUITE: ProtectionSuite = {
  id: PROTECTION_SUITE_ID,
  keyBytes: PROTECTION_SUITE_BOUNDS.keyBytes,
  nonceBytes: PROTECTION_SUITE_BOUNDS.nonceBytes,
  tagBytes: PROTECTION_SUITE_BOUNDS.tagBytes,
  aadMaxBytes: PROTECTION_SUITE_BOUNDS.aadMaxBytes,
};

/** Plaintext / no-encryption downgrade sentinel — always rejected. */
export const PLAINTEXT_SUITE_IDS: readonly string[] = ["plaintext", "none", ""];

/**
 * Validate a declared suite id and its declared parameter values (as carried
 * in a header). Checks the suite is known, that declared AEAD lengths match
 * the suite bounds, and rejects plaintext downgrade. Does not perform crypto.
 */
export function validateProtectionSuiteDeclared(
  suiteId: unknown,
  declared: { readonly keyBytes?: unknown; readonly nonceBytes?: unknown; readonly tagBytes?: unknown; readonly aadMaxBytes?: unknown } | undefined,
): ValidationResult {
  if (typeof suiteId !== "string") {
    return fail("UNKNOWN_PROTECTION_SUITE", "protectionSuite must be a string");
  }
  if (PLAINTEXT_SUITE_IDS.includes(suiteId)) {
    return fail("PLAINTEXT_DOWNGRADE", `plaintext suite "${suiteId}" not permitted`);
  }
  if (!isKnownProtectionSuite(suiteId)) {
    return fail("UNKNOWN_PROTECTION_SUITE", `unknown protection suite: ${suiteId}`);
  }
  let result: ValidationResult = ok();
  const b = PROTECTION_SUITE_BOUNDS;
  if (declared !== undefined) {
    if (declared.keyBytes !== undefined && declared.keyBytes !== b.keyBytes) {
      result = appendError(result, "SUITE_PARAM_OUT_OF_BOUNDS", `keyBytes must be ${b.keyBytes}`, "keyBytes");
    }
    if (declared.nonceBytes !== undefined && declared.nonceBytes !== b.nonceBytes) {
      result = appendError(result, "SUITE_PARAM_OUT_OF_BOUNDS", `nonceBytes must be ${b.nonceBytes}`, "nonceBytes");
    }
    if (declared.tagBytes !== undefined && declared.tagBytes !== b.tagBytes) {
      result = appendError(result, "SUITE_PARAM_OUT_OF_BOUNDS", `tagBytes must be ${b.tagBytes}`, "tagBytes");
    }
    if (declared.aadMaxBytes !== undefined && declared.aadMaxBytes !== b.aadMaxBytes) {
      result = appendError(result, "SUITE_PARAM_OUT_OF_BOUNDS", `aadMaxBytes must be ${b.aadMaxBytes}`, "aadMaxBytes");
    }
  }
  return result;
}

/** Validate a per-frame AAD length against the suite ceiling. */
export function validateFrameAad(aad: Uint8Array): ValidationResult {
  if (aad.length > PROTECTION_SUITE_BOUNDS.aadMaxBytes) {
    return fail("SUITE_AAD_OVERSIZED", `frame AAD exceeds ${PROTECTION_SUITE_BOUNDS.aadMaxBytes} bytes`);
  }
  return ok();
}
