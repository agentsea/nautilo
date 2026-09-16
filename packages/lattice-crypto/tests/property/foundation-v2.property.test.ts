import { describe, expect, test } from "bun:test";
import {
  canonicalizeParticipants,
  participantDigest,
} from "../../src/domain/participants.ts";
import {
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
} from "../../src/format/v2-primitives.ts";
import { humanId } from "../../src/v2-types/ids.ts";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = random() % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function propertySeed(seed: number, run: () => void): void {
  try {
    run();
  } catch (error) {
    throw new Error(
      `v2 property failed; replay with seed ${seed}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

describe("v2 recorded-seed foundation properties", () => {
  test("participant canonicalization and digest ignore input permutation", () => {
    for (let seed = 1; seed <= 512; seed += 1) {
      propertySeed(seed, () => {
        const random = seededRandom(seed);
        const count = 1 + (random() % 64);
        const participants = Array.from(
          { length: count },
          (_, index) => humanId(`human-${index.toString().padStart(2, "0")}`),
        );
        const left = shuffled(participants, random);
        const right = shuffled(participants, random);

        expect(canonicalizeParticipants(left)).toEqual(
          canonicalizeParticipants(right),
        );
        expect(participantDigest(left)).toEqual(participantDigest(right));
      });
    }
  });

  test("u32, u64, and frames round-trip over recorded boundary-biased values", () => {
    const fixed = [
      0,
      1,
      0xff,
      0x100,
      0xffff,
      0x1_0000,
      0xffff_ffff,
      Number.MAX_SAFE_INTEGER,
    ];
    for (let seed = 1; seed <= 512; seed += 1) {
      propertySeed(seed, () => {
        const random = seededRandom(seed);
        const u32Value = fixed[random() % (fixed.length - 1)]! >>> 0;
        const u64Value = random() * 0x20_0000 + (random() & 0x1f_ffff);
        const payload = Uint8Array.from(
          { length: random() % 257 },
          () => random() & 0xff,
        );
        const encoded = new Uint8Array([
          ...encodeU32(u32Value),
          ...encodeU64(u64Value),
          ...frame(payload),
        ]);

        const decoded = decodeExact(encoded, (reader) => ({
          u32: reader.readU32(),
          u64: reader.readU64(),
          payload: reader.readFrame(256),
        }));

        expect(decoded).toEqual({
          u32: u32Value,
          u64: u64Value,
          payload,
        });
      });
    }
  });
});
