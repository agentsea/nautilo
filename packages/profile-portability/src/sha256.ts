/**
 * SHA-256 helpers for canonical semantic integrity hashes.
 *
 * Hashing delegates to the audited, synchronous `@noble/hashes` SHA-256
 * primitive. It is pure TypeScript/JavaScript and therefore works identically
 * in the CLI and a browser Worker without a Node builtin or async WebCrypto
 * boundary.
 * Production AEAD encryption, Argon2id derivation, and key wrapping remain
 * outside Wave 0.
 */

import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(nobleSha256(data));
}

export function sha256Hex(data: Uint8Array): string {
  let hex = "";
  for (const byte of nobleSha256(data)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const TEXT_ENCODER = new TextEncoder();

export function sha256Utf8(text: string): string {
  return sha256Hex(TEXT_ENCODER.encode(text));
}
