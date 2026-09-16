import { describe, expect, test } from "bun:test";
import {
  fixtureV2Codecs,
  V2_CODEC_FIXTURE_NAMES,
} from "../helpers/v2-codec-fixtures.ts";

const MAX_SEED = 64;

function selectedSeeds(): readonly number[] {
  const raw = process.env["M225_FORMAT_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M225_FORMAT_PROPERTY_SEED must be an integer from 1 through ${
        MAX_SEED
      }`,
    );
  }
  return [seed];
}

function replayCommand(seed: number): string {
  return `M225_FORMAT_PROPERTY_SEED=${seed} bun test --timeout 60000 `
    + "tests/property/formats-v2.property.test.ts";
}

describe("v2 recorded-seed complete format properties", () => {
  test("every v2 format is canonical, deterministic, detached, and seed-sensitive", () => {
    for (const seed of selectedSeeds()) {
      try {
        const codecs = fixtureV2Codecs(seed);
        const repeated = fixtureV2Codecs(seed);
        const prior = fixtureV2Codecs(seed - 1);
        expect(codecs.map((codec) => codec.name)).toEqual(
          [...V2_CODEC_FIXTURE_NAMES],
        );
        expect(codecs).toHaveLength(17);

        for (const [index, codec] of codecs.entries()) {
          const roundTrip = codec.roundTrip(codec.canonical);
          expect(roundTrip, codec.name).not.toBeNull();
          expect(roundTrip, codec.name).toEqual(codec.canonical);
          expect(roundTrip, codec.name).not.toBe(codec.canonical);
          expect(codec.canonical, codec.name)
            .toEqual(repeated[index]!.canonical);
          expect(codec.canonical, codec.name)
            .not.toEqual(prior[index]!.canonical);

          const source = codec.canonical.slice();
          source[0] = source[0]! ^ 0xff;
          expect(roundTrip, codec.name).not.toEqual(source);
        }
      } catch (error) {
        throw new Error(
          `complete v2 format property failed at seed ${seed}; replay: ${
            replayCommand(seed)
          }`,
          { cause: error },
        );
      }
    }
    console.log(JSON.stringify({
      lane: "lattice-v2-property",
      property: "complete-v2-formats",
      seedRange: `1-${MAX_SEED}`,
      codecCount: V2_CODEC_FIXTURE_NAMES.length,
      replay: replayCommand(1).replace("=1", "=<seed>"),
    }));
  });
});
