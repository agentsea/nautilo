import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createInitialNamespaceKeyrings,
  prepareNamespaceKeyringRevision,
} from "../../src/namespace/keyrings.ts";
import {
  accessRevision,
  namespaceId,
} from "../../src/v2-types/ids.ts";

function nextRandom(state: { value: number }): number {
  let value = state.value >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value;
}

describe("v2 recorded-seed keyring transition properties", () => {
  test("arbitrary reseal/rotation sequences retain exact history and advance once", () => {
    for (let seed = 1; seed <= 256; seed++) {
      try {
        const crypto = new LatticeCrypto(seededRng(seed ^ 0x2250));
        const random = { value: seed };
        let keyring = createInitialNamespaceKeyrings(
          crypto,
          namespaceId("namespace_room"),
        ).human;
        let expectedGeneration = 0;
        const steps = 1 + (nextRandom(random) % 64);

        for (let step = 1; step <= steps; step++) {
          const rotate = (nextRandom(random) & 1) === 1;
          const previous = keyring;
          const previousKeys = previous.generations.map((entry) =>
            entry.key.slice()
          );
          keyring = prepareNamespaceKeyringRevision(
            crypto,
            previous,
            accessRevision(step),
            rotate,
          );
          if (rotate) expectedGeneration++;

          expect(Number(keyring.accessRevision)).toBe(step);
          expect(Number(keyring.currentGeneration)).toBe(expectedGeneration);
          expect(keyring.generations).toHaveLength(expectedGeneration + 1);
          expect(
            keyring.generations.slice(0, previousKeys.length)
              .map((entry) => entry.key),
          ).toEqual(previousKeys);
          expect(Number(previous.accessRevision)).toBe(step - 1);
          for (let index = 0; index < previousKeys.length; index++) {
            expect(keyring.generations[index]!.key).not.toBe(
              previous.generations[index]!.key,
            );
          }
          if (rotate) {
            const fresh = keyring.generations.at(-1)!.key;
            expect(
              previousKeys.some((retained) =>
                retained.every((byte, index) => byte === fresh[index])
              ),
            ).toBe(false);
          }
        }
      } catch (error) {
        throw new Error(
          `keyring transition property failed; replay seed ${seed}`,
          { cause: error },
        );
      }
    }
  });
});
