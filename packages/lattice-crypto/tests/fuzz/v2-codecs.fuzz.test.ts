import { describe, expect, test } from "bun:test";
import {
  CanonicalDecodingError,
  CanonicalEncodingError,
} from "../../src/format/v2-primitives.ts";
import { V2ValidationError } from "../../src/v2-types/ids.ts";
import { V2LimitError } from "../../src/v2-types/limits.ts";
import {
  fixtureV2Codecs,
  type V2CodecFixture,
  V2_CODEC_FIXTURE_NAMES,
} from "../helpers/v2-codec-fixtures.ts";

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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function replayCommand(seed: number): string {
  return `M225_FUZZ_SEED=${seed} bun test --timeout 60000 `
    + "tests/fuzz/v2-codecs.fuzz.test.ts";
}

type BuiltInErrorConstructor =
  | ErrorConstructor
  | RangeErrorConstructor
  | TypeErrorConstructor;

const ownedBuiltInRejections = new Map<
  string,
  ReadonlyMap<string, BuiltInErrorConstructor>
>([
  ["Agent Runtime generation", new Map([
    ["Agent Runtime key must contain exactly 32 bytes", RangeError],
  ])],
  ["Namespace binding", new Map([
    ["Namespace binding signature must contain exactly 64 bytes", RangeError],
  ])],
  ["Namespace keyring", new Map([
    ["Namespace key class is unsupported", RangeError],
    ["Namespace keyring current generation must be the unique latest entry", RangeError],
    ["Namespace keyring generations must be strictly increasing", RangeError],
    ["Namespace generation key must contain exactly 32 bytes", RangeError],
  ])],
  ["Namespace keyring envelope", new Map([
    ["Namespace key class is unsupported", RangeError],
    ["Namespace keyring signature must contain exactly 64 bytes", RangeError],
  ])],
  ["object access manifest", new Map([
    ["object access manifest domain mismatch", TypeError],
    ["previous manifest hash presence must be 0 or 1", TypeError],
    ["revision zero requires no previous manifest hash; later revisions require one", TypeError],
  ])],
  ["encrypted object payload", new Map([
    ["format domain mismatch; expected nautilo/lattice-crypto/encrypted-payload/v2", TypeError],
    ["object key class must be human or ai", TypeError],
  ])],
  ["Namespace object envelope", new Map([
    ["format domain mismatch; expected nautilo/lattice-crypto/namespace-object-envelope/v2", TypeError],
    ["object key class must be human or ai", TypeError],
  ])],
  ["Namespace recovery package", new Map([
    ["Recovery key generation must be positive", RangeError],
    ["Recovery package key class is unsupported", RangeError],
  ])],
  ["Human recovery archive", new Map([
    ["Recovery archive package belongs to another Human", RangeError],
    ["Recovery archive package targets another recovery key generation", RangeError],
    ["Recovery archive signature must contain exactly 64 bytes", RangeError],
    ["Recovery package key class is unsupported", RangeError],
  ])],
  ["Agent manager keyring", new Map([
    ["Agent manager recovery key class must be runtime or management", RangeError],
    ["Agent manager retained history must be complete through current generation", Error],
    ["Agent manager retained history must be contiguous from generation 0", Error],
  ])],
  ["Agent manager recovery package", new Map([
    ["Agent manager recovery key class must be runtime or management", RangeError],
  ])],
  ["device transfer approval and nested package", new Map([
    ["Device transfer approval package count does not match inventory commitment", Error],
    ["Device transfer key class is unsupported", RangeError],
    ["Device transfer package is detached from its approval", Error],
  ])],
  ["recovery-device activation challenge", new Map([
    ["Recovery device challenge expiry must follow issuance", RangeError],
    ["Recovery device challenge lifetime exceeds the 24-hour limit", RangeError],
  ])],
]);

function isOwnedRejection(
  codec: V2CodecFixture,
  error: unknown,
): error is Error {
  if (
    error instanceof CanonicalDecodingError
    || error instanceof CanonicalEncodingError
    || error instanceof V2ValidationError
    || error instanceof V2LimitError
  ) return true;
  if (!(error instanceof Error)) return false;
  const expectedConstructor = ownedBuiltInRejections
    .get(codec.name)
    ?.get(error.message);
  return expectedConstructor !== undefined
    && error.constructor === expectedConstructor;
}

function assertCanonicalOrOwnedRejection(
  codec: V2CodecFixture,
  candidate: Uint8Array,
  seed: number,
): void {
  let canonical: Uint8Array | null;
  try {
    canonical = codec.roundTrip(candidate);
  } catch (error) {
    if (!isOwnedRejection(codec, error)) {
      throw new Error(
        `${codec.name} escaped its owned rejection families; replay: ${
          replayCommand(seed)
        }`,
        { cause: error },
      );
    }
    return;
  }
  if (canonical !== null && !sameBytes(canonical, candidate)) {
    throw new Error(
      `${codec.name} accepted noncanonical bytes; replay: ${
        replayCommand(seed)
      }`,
    );
  }
}

function deterministicMutations(
  canonical: Uint8Array,
  seed: number,
): readonly Uint8Array[] {
  const cut = seed % canonical.length;
  const deepOffset = (
    Math.imul(seed, 0x9e37_79b1) >>> 0
  ) % canonical.length;
  const corrupted = canonical.slice();
  corrupted[deepOffset] = corrupted[deepOffset]! ^ (1 << (seed % 8));
  const lengthCorrupted = canonical.slice();
  const lengthOffset = Math.max(
    0,
    Math.min(canonical.length - 4, deepOffset - (deepOffset % 4)),
  );
  lengthCorrupted.fill(0xff, lengthOffset, lengthOffset + 4);
  return [
    canonical.slice(0, cut),
    Uint8Array.from([...canonical, seed & 0xff]),
    corrupted,
    lengthCorrupted,
  ];
}

describe("v2 canonical codec structured fuzz corpus", () => {
  const codecs = fixtureV2Codecs(0);

  test("starts every decoder from a valid canonical fixture", () => {
    expect(codecs.map((codec) => codec.name)).toEqual(
      [...V2_CODEC_FIXTURE_NAMES],
    );
    for (const codec of codecs) {
      expect(codec.roundTrip(codec.canonical)).toEqual(codec.canonical);
    }
  });

  test("deterministically truncates and corrupts deep canonical structures", () => {
    for (const seed of selectedSeeds(2_048)) {
      for (const codec of codecs) {
        for (const candidate of deterministicMutations(codec.canonical, seed)) {
          assertCanonicalOrOwnedRejection(codec, candidate, seed);
        }
      }
    }
    console.log(JSON.stringify({
      lane: "lattice-v2-fuzz",
      corpus: "canonical-codecs",
      seedRange: "1-2048",
      codecCount: codecs.length,
      mutations: ["truncate", "append", "deep-bit-flip", "length-corruption"],
      replay: replayCommand(1).replace("=1", "=<seed>"),
    }));
  });

  test("the harness rejects generic built-in and keyword-shaped failures", () => {
    for (const error of [
      new Error("always fail"),
      new TypeError("always fail"),
      new RangeError("always fail"),
      new Error("object decoder always fails"),
      new TypeError("namespace keyring exploded"),
    ]) {
      expect(() =>
        assertCanonicalOrOwnedRejection(
          {
            name: "deliberately broken codec",
            canonical: Uint8Array.of(0x22),
            roundTrip: () => {
              throw error;
            },
          },
          Uint8Array.of(0x22),
          17,
        )
      ).toThrow("escaped its owned rejection families");
    }
  });
});
