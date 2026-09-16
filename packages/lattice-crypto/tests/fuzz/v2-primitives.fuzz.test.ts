import { describe, expect, test } from "bun:test";
import {
  CanonicalDecodingError,
  decodeExact,
} from "../../src/format/v2-primitives.ts";

function fuzzBytes(seed: number): Uint8Array {
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return Uint8Array.from(
    { length: next() % 513 },
    () => next() & 0xff,
  );
}

function selectedSeeds(maximum: number): readonly number[] {
  const raw = process.env["M225_FUZZ_SEED"];
  if (raw === undefined) {
    return Array.from({ length: maximum }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > maximum) {
    throw new RangeError(
      `M225_FUZZ_SEED must be an integer from 1 through ${maximum}`,
    );
  }
  return [seed];
}

function replayCommand(seed: number): string {
  return `M225_FUZZ_SEED=${seed} bun test --timeout 60000 `
    + "tests/fuzz/v2-primitives.fuzz.test.ts";
}

describe("v2 canonical primitive decoder fuzz corpus", () => {
  test("arbitrary bytes either decode completely or fail with the owned error family", () => {
    for (const seed of selectedSeeds(4_096)) {
      const input = fuzzBytes(seed);
      try {
        const decoded = decodeExact(input, (reader) => {
          const version = reader.readVersion(2);
          const count = reader.readCount(64);
          const payload = reader.readFrame(256);
          const revision = reader.readU64();
          return { version, count, payload, revision };
        });
        expect(decoded.version).toBe(2);
        expect(decoded.count).toBeLessThanOrEqual(64);
        expect(decoded.payload.length).toBeLessThanOrEqual(256);
        expect(Number.isSafeInteger(decoded.revision)).toBe(true);
      } catch (error) {
        if (!(error instanceof CanonicalDecodingError)) {
          throw new Error(
            `v2 primitive fuzz failed; replay: ${replayCommand(seed)}`,
            { cause: error },
          );
        }
      }
    }
    console.log(JSON.stringify({
      lane: "lattice-v2-fuzz",
      corpus: "primitive-decoder",
      seedRange: "1-4096",
      replay: replayCommand(1).replace("=1", "=<seed>"),
    }));
  });

  test("truncating a valid framed record at every byte never escapes parser errors", () => {
    const fixture = new Uint8Array([
      0, 0, 0, 2,
      0, 0, 0, 1,
      0, 0, 0, 3, 0xaa, 0xbb, 0xcc,
      0, 0, 0, 0, 0, 0, 0, 7,
    ]);
    for (let length = 0; length < fixture.length; length += 1) {
      expect(() =>
        decodeExact(fixture.slice(0, length), (reader) => {
          reader.readVersion(2);
          reader.readCount(64);
          reader.readFrame(256);
          reader.readU64();
        })
      ).toThrow(CanonicalDecodingError);
    }
  });
});
