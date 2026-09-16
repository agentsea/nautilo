import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { VaultCryptoError } from "./errors.ts";

const AES_256_GCM = "aes-256-gcm" as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** @returns ciphertext || tag contiguous (GCM typical pattern). */
export function aesGcmEncrypt(
  aesKey256: Buffer,
  plaintext: Buffer,
): { readonly nonceB64: string; readonly blobB64: string } {
  if (aesKey256.length !== 32) {
    throw new VaultCryptoError("internal key shape");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(AES_256_GCM, aesKey256, nonce, {
    authTagLength: TAG_BYTES,
  });
  const chunks = [cipher.update(plaintext), cipher.final()];
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([...chunks, tag]);
  return {
    nonceB64: nonce.toString("base64"),
    blobB64: blob.toString("base64"),
  };
}

export function aesGcmDecrypt(
  aesKey256: Buffer,
  nonceB64: string,
  blobB64: Buffer | string,
): Buffer {
  if (aesKey256.length !== 32) {
    throw new VaultCryptoError("internal key shape");
  }
  const nonce = Buffer.from(nonceB64, "base64");
  const blob =
    typeof blobB64 === "string" ? Buffer.from(blobB64, "base64") : blobB64;
  if (nonce.length !== NONCE_BYTES || blob.length < TAG_BYTES + 1) {
    throw new VaultCryptoError("invalid envelope layout");
  }
  const ct = blob.subarray(0, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const decipher = createDecipheriv(AES_256_GCM, aesKey256, nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new VaultCryptoError("authenticated decryption failure");
  }
}
