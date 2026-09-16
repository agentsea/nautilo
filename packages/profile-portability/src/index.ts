/**
 * @nautilo/profile-portability — Wave 0 / P0 contract package.
 *
 * Dependency-free pure TypeScript contract, validators, canonical hashing,
 * and fixtures for the versioned semantic / container / protection
 * boundaries of the portable Genie profile bundle.
 *
 * What this package IS (Wave 0):
 *  - Versioned semantic records (`GenieLiveV1`) with no source IDs or paths.
 *  - Immutable container header, bounded key slots, record frames, AAD,
 *    ordering, FINAL marker, and encrypted terminal manifest types + validators.
 *  - Canonical semantic-root / per-record SHA-256 hashing helpers.
 *  - Limits and a stable rejection error vocabulary.
 *  - Archive manifest allowlist rejector (unknown/duplicate/traversal/symlink/
 *    oversized/compression-bomb/malformed-frame).
 *  - Protection suite as an opaque declared identifier with declared
 *    bounds/compatibility validation.
 *  - Golden fixtures and tests for valid and malformed structural inputs.
 *
 * What this package is NOT (out of Wave 0, deliberately not stubbed as working):
 *  - Production AEAD encryption / decryption (XChaCha20-Poly1305).
 *  - Argon2id key derivation.
 *  - Keychain access.
 *  - CLI commands, server APIs, DB writes, media writes, streaming transport.
 */

export * from "./errors";
export * from "./versions";
export * from "./sha256";
export * from "./canonical";
export * from "./profile-bundle";
export * as semantic from "./semantic";
export * as container from "./container";
export * as protection from "./protection";
export * as keySlots from "./key-slots";
