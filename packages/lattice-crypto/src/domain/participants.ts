import { sha256 } from "@noble/hashes/sha2.js";
import {
  concatV2,
  encodeU32,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  type HumanId,
  humanId,
} from "../v2-types/ids.ts";

export const PARTICIPANT_DIGEST_DOMAIN =
  "nautilo/lattice-crypto/crypto-domain-participants/v2";

export function compareUnsignedUtf8(left: string, right: string): number {
  const leftBytes = utf8V2(left);
  const rightBytes = utf8V2(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function canonicalizeParticipants(
  participants: readonly HumanId[],
): readonly HumanId[] {
  if (!Array.isArray(participants) || participants.length < 1) {
    throw new RangeError("Human participant set must not be empty");
  }
  if (!Number.isSafeInteger(participants.length)) {
    throw new RangeError("Human participant set length is invalid");
  }
  const canonical = participants
    .map((participant) => humanId(participant))
    .sort(compareUnsignedUtf8);
  // out-of-range `undefined === value` comparison after the real final item.
  for (let index = 1; index < canonical.length; index++) {
    if (canonical[index - 1] === canonical[index]) {
      throw new RangeError("Human participant set contains a duplicate");
    }
  }
  return Object.freeze(canonical);
}

export function participantDigestInput(
  participants: readonly HumanId[],
): Uint8Array {
  const canonical = canonicalizeParticipants(participants);
  return concatV2(
    frameText(PARTICIPANT_DIGEST_DOMAIN),
    encodeU32(canonical.length),
    ...canonical.map((participant) => frameText(participant)),
  );
}

export function participantDigest(
  participants: readonly HumanId[],
): Uint8Array {
  return sha256(participantDigestInput(participants));
}
