import type { LatticeCrypto, RecoveryKit } from "../crypto/index.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat } from "../util/bytes.ts";

export const RECOVERY_KIT_FORMAT_VERSION = 1 as const;
const SECRET_BYTES = 32;
const PUBLIC_KEY_BYTES = 65;
const CHECKSUM_BYTES = 4;
const ENCODED_BYTES = 1 + SECRET_BYTES + PUBLIC_KEY_BYTES + CHECKSUM_BYTES;
const CHECKSUM_DOMAIN = new TextEncoder().encode(
  "nautilo/lattice-crypto/recovery-kit-checksum/v1",
);

function checksum(body: Uint8Array): Uint8Array {
  return sha256(concat(CHECKSUM_DOMAIN, body)).subarray(0, CHECKSUM_BYTES);
}

export function serializeRecoveryKit(kit: RecoveryKit): Uint8Array {
  if (
    kit.formatVersion !== RECOVERY_KIT_FORMAT_VERSION ||
    kit.secret.length !== SECRET_BYTES ||
    kit.publicKey.length !== PUBLIC_KEY_BYTES
  ) {
    throw new Error("invalid recovery kit");
  }
  const body = concat(
    new Uint8Array([RECOVERY_KIT_FORMAT_VERSION]),
    kit.secret,
    kit.publicKey,
  );
  return concat(body, checksum(body));
}

export async function parseRecoveryKit(
  encoded: Uint8Array,
  crypto: LatticeCrypto,
): Promise<RecoveryKit | null> {
  if (
    encoded.length !== ENCODED_BYTES ||
    encoded[0] !== RECOVERY_KIT_FORMAT_VERSION
  ) {
    return null;
  }
  const body = encoded.subarray(0, ENCODED_BYTES - CHECKSUM_BYTES);
  const expected = checksum(body);
  const actual = encoded.subarray(ENCODED_BYTES - CHECKSUM_BYTES);
  if (!expected.every((byte, index) => byte === actual[index])) return null;
  const secret = encoded.subarray(1, 1 + SECRET_BYTES).slice();
  const publicKey = encoded
    .subarray(1 + SECRET_BYTES, 1 + SECRET_BYTES + PUBLIC_KEY_BYTES)
    .slice();
  const derived = await crypto.deriveEncryptionKeyPair(secret);
  if (!derived.publicKey.every((byte, index) => byte === publicKey[index])) {
    return null;
  }
  return {
    formatVersion: RECOVERY_KIT_FORMAT_VERSION,
    secret,
    publicKey,
    keyId: `recovery_${Array.from(crypto.hash(publicKey).subarray(0, 16))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`,
  };
}
