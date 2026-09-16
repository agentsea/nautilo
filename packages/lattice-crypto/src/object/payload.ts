import type { LatticeCrypto } from "../crypto/index.ts";
import {
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  encryptedPayloadAadV2,
  normalizeEncryptedPayloadContextV2,
  type EncryptedPayloadContextV2,
} from "../format/object-v2.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

const KEY_BYTES = 32;

export interface EncryptedPayloadV2 {
  readonly formatVersion: typeof ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2;
  readonly context: EncryptedPayloadContextV2;
  readonly ciphertext: Uint8Array;
}

export interface EncryptedPayloadResultV2 {
  readonly dek: Uint8Array;
  readonly payload: EncryptedPayloadV2;
}

function assertKey(label: string, key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new TypeError(`${label} must be exactly ${KEY_BYTES} bytes`);
  }
}

export function encryptObjectPayloadV2(
  crypto: LatticeCrypto,
  context: EncryptedPayloadContextV2,
  plaintext: Uint8Array,
): EncryptedPayloadResultV2 {
  if (!(plaintext instanceof Uint8Array)) {
    throw new TypeError("object plaintext must be Uint8Array");
  }
  assertV2Limit(
    "object plaintext bytes",
    plaintext.length,
    V2_LIMITS.plaintextBytes,
  );
  const normalized = normalizeEncryptedPayloadContextV2(context);
  const dek = crypto.randomBytes(KEY_BYTES);
  try {
    assertKey("generated DEK", dek);
    const ciphertext = crypto.aeadSeal(
      dek,
      plaintext,
      encryptedPayloadAadV2(normalized),
    );
    assertV2Limit(
      "encrypted payload bytes",
      ciphertext.length,
      V2_LIMITS.ciphertextBytes,
    );
    return Object.freeze({
      dek: copyOwnedBytesV2(dek),
      payload: Object.freeze({
        formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
        context: normalized,
        ciphertext: copyOwnedBytesV2(ciphertext),
      }),
    });
  } finally {
    dek.fill(0);
  }
}

export function decryptObjectPayloadV2(
  crypto: LatticeCrypto,
  dek: Uint8Array,
  payload: EncryptedPayloadV2,
): Uint8Array | null {
  assertKey("DEK", dek);
  if (
    payload === null
    || payload.formatVersion !== ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2
    || !(payload.ciphertext instanceof Uint8Array)
  ) {
    return null;
  }
  assertV2Limit(
    "encrypted payload bytes",
    payload.ciphertext.length,
    V2_LIMITS.ciphertextBytes,
  );
  try {
    const context = normalizeEncryptedPayloadContextV2(payload.context);
    const plaintext = crypto.aeadOpen(
      dek,
      payload.ciphertext,
      encryptedPayloadAadV2(context),
    );
    // fast path, the owned catch below rejects the same null result.
    if (plaintext === null) return null;
    try {
      assertV2Limit(
        // violation is deliberately collapsed to the same fail-closed null by
        // the owned catch below, so its internal diagnostic is unobservable.
        "object plaintext bytes",
        plaintext.length,
        V2_LIMITS.plaintextBytes,
      );
      return copyOwnedBytesV2(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } catch {
    return null;
  }
}
