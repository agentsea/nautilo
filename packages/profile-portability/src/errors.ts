/**
 * Stable error vocabulary for the profile-portability contract.
 *
 * Every structural rejection made by the Wave 0 contract resolves to one of
 * these codes. Codes are stable identifiers (not human prose) so callers and
 * later waves can branch on them. Production encryption, Argon2id derivation,
 * CLI, server, DB, media, and transport failures are intentionally NOT here —
 * those are out of Wave 0 and have no working behavior in this package.
 */

export type PortabilityErrorCode =
  // Versioning / compatibility
  | "UNKNOWN_CONTAINER_VERSION"
  | "UNSUPPORTED_CONTAINER_VERSION"
  | "UNKNOWN_SEMANTIC_VERSION"
  | "UNSUPPORTED_SEMANTIC_VERSION"
  | "UNKNOWN_PAYLOAD_CODEC"
  | "UNKNOWN_PROTECTION_SUITE"
  | "UNSUPPORTED_SCOPE"
  // Header shape
  | "MALFORMED_HEADER"
  | "BUNDLE_ID_INVALID"
  | "CHUNK_SIZE_OUT_OF_BOUNDS"
  // Frames
  | "FRAME_ORDINAL_GAP"
  | "FRAME_ORDINAL_DUPLICATE"
  | "FRAME_ORDINAL_OUT_OF_RANGE"
  | "FRAME_MISSING_FINAL"
  | "FRAME_MULTIPLE_FINAL"
  | "FRAME_CIPHERTEXT_OVERSIZED"
  | "FRAME_COUNT_OVER_LIMIT"
  | "PAYLOAD_OVERSIZED"
  | "FRAME_MALFORMED"
  // Terminal manifest
  | "MANIFEST_RECORD_KIND_UNKNOWN"
  | "MANIFEST_RECORD_HASH_INVALID"
  | "MANIFEST_FRAME_ORDINAL_INVALID"
  | "MANIFEST_FRAME_COUNT_MISMATCH"
  | "MANIFEST_PAYLOAD_BYTES_MISMATCH"
  | "SEMANTIC_ROOT_MISMATCH"
  | "RECORD_HASH_MISMATCH"
  // Archive manifest allowlist (malicious / structural input rejection)
  | "MANIFEST_UNKNOWN_PATH"
  | "MANIFEST_DUPLICATE_PATH"
  | "MANIFEST_TRAVERSAL"
  | "MANIFEST_ABSOLUTE_PATH"
  | "MANIFEST_SYMLINK"
  | "MANIFEST_ENTRY_OVERSIZED"
  | "MANIFEST_ARCHIVE_OVERSIZED"
  | "MANIFEST_COMPRESSION_NOT_ALLOWED"
  | "MANIFEST_COMPRESSION_BOMB"
  | "MANIFEST_MALFORMED_FRAME"
  // Protection suite (opaque declared identifier; bounds/compat only)
  | "SUITE_PARAM_OUT_OF_BOUNDS"
  | "SUITE_AAD_OVERSIZED"
  // Key slots
  | "SLOT_COUNT_OUT_OF_BOUNDS"
  | "SLOT_KIND_UNSUPPORTED"
  | "SLOT_ID_DUPLICATE"
  | "SLOT_ID_OUT_OF_RANGE"
  | "SLOT_KDF_UNSUPPORTED"
  | "KDF_PARAM_OUT_OF_BOUNDS"
  | "SALT_LENGTH_INVALID"
  | "WRAPPED_DEK_LENGTH_INVALID"
  | "KEYCHAIN_SLOT_NOT_IMPLEMENTED"
  // Plaintext downgrade
  | "PLAINTEXT_DOWNGRADE"
  // Semantic record content boundary
  | "SEMANTIC_RECORD_UNKNOWN_KIND"
  | "SEMANTIC_RECORD_FORBIDDEN_FIELD"
  | "SEMANTIC_RECORD_FIELD_INVALID"
  | "SEMANTIC_RECORD_EMPTY"
  // Wave 3 / format v2 — portable artifact media manifest
  | "ARTIFACT_MEDIA_VERSION_UNSUPPORTED"
  | "ARTIFACT_MEDIA_PATH_INVALID"
  | "ARTIFACT_MEDIA_SIZE_INVALID"
  | "ARTIFACT_MEDIA_SHA_INVALID"
  | "ARTIFACT_MEDIA_DUPLICATE"
  | "ARTIFACT_BYTES_ENTRY_DUPLICATE"
  | "ARTIFACT_MEDIA_MISSING"
  | "ARTIFACT_MEDIA_ORPHAN"
  | "ARTIFACT_MEDIA_MISMATCH"
  // Wave 1A — framed recovery protection (AEAD / KDF / DEK wrap)
  // Production AEAD (XChaCha20-Poly1305) and Argon2id DEK wrap are implemented
  // in `protection/framed-suite`. Argon2id itself is injected by the caller.
  | "AEAD_AUTH_FAILED"
  | "WRONG_PASSPHRASE"
  | "DEK_UNWRAP_FAILED"
  | "DEK_LENGTH_INVALID"
  | "FRAME_PLAINTEXT_OVERSIZED"
  | "FRAME_AAD_MISMATCH";

export interface PortabilityError {
  readonly code: PortabilityErrorCode;
  readonly message: string;
  /** Optional structural locator, e.g. "keySlots[1]" or "frames[3]". */
  readonly path?: string;
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: PortabilityError[] };

export const ok = (): ValidationResult => ({ ok: true });

export function fail(
  code: PortabilityErrorCode,
  message: string,
  path?: string,
): ValidationResult {
  return { ok: false, errors: [{ code, message, ...(path === undefined ? {} : { path }) }] };
}

export function appendError(
  result: ValidationResult,
  code: PortabilityErrorCode,
  message: string,
  path?: string,
): ValidationResult {
  const err: PortabilityError = {
    code,
    message,
    ...(path === undefined ? {} : { path }),
  };
  if (result.ok) return { ok: false, errors: [err] };
  return { ok: false, errors: [...result.errors, err] };
}

export function isOk(result: ValidationResult): result is { ok: true } {
  return result.ok;
}

export function errorCodes(result: ValidationResult): PortabilityErrorCode[] {
  if (result.ok) return [];
  return result.errors.map((e) => e.code);
}
