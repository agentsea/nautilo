import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";

import type { AuthorityProjectionCommitmentPort } from "./authority-contracts";

const CHECKPOINT_AAD = Buffer.from("nautilo-reflection-authority-checkpoint-v1", "utf8");

export type AuthorityProjectionCheckpointPort = AuthorityProjectionCommitmentPort;

function canonicalAlternative(value: EffectiveAudienceAlternative): object {
  return {
    humanRefs: [...value.humanRefs].sort(),
    includesPublicBoundary: value.includesPublicBoundary,
  };
}

/** Server-keyed opaque commitments plus authenticated repair-state sealing. */
export function createHmacAuthorityProjectionCheckpointPort(
  key: Uint8Array,
): AuthorityProjectionCheckpointPort {
  if (key.byteLength < 32) {
    throw new TypeError("Authority projection key must contain at least 32 bytes");
  }
  const ownedKey = key.slice();
  const encryptionKey = createHash("sha256")
    .update("nautilo-reflection-authority-checkpoint-key-v1", "utf8")
    .update(ownedKey)
    .digest();
  const commit = (kind: string, value: unknown): Uint8Array => {
    const hmac = createHmac("sha256", ownedKey);
    hmac.update(`nautilo-reflection-authority-${kind}-v1\0`, "utf8");
    hmac.update(JSON.stringify(value), "utf8");
    return new Uint8Array(hmac.digest());
  };
  return Object.freeze({
    commitAlternative: (alternative: EffectiveAudienceAlternative) =>
      commit("alternative", canonicalAlternative(alternative)),
    commitSet: (alternatives: readonly EffectiveAudienceAlternative[]) =>
      commit("set", alternatives.map(canonicalAlternative)),
    sealCheckpoint(logicalCheckpoint: string): Uint8Array {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(CHECKPOINT_AAD);
      const ciphertext = Buffer.concat([
        cipher.update(logicalCheckpoint, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return new Uint8Array(Buffer.concat([
        Buffer.from([1]),
        nonce,
        tag,
        ciphertext,
      ]));
    },
    openSealedCheckpoint(sealed: Uint8Array): string {
      if (sealed.byteLength < 30 || sealed[0] !== 1) {
        throw new TypeError("Authority checkpoint is invalid");
      }
      try {
        const nonce = sealed.slice(1, 13);
        const tag = sealed.slice(13, 29);
        const ciphertext = sealed.slice(29);
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
        decipher.setAAD(CHECKPOINT_AAD);
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new TypeError("Authority checkpoint is invalid");
      }
    },
  });
}
