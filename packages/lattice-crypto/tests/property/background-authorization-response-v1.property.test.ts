import { describe, expect, test } from "bun:test";

import {
  decodeBackgroundAuthorizationResponseV1,
  encodeBackgroundAuthorizationResponseV1,
  verifyCurrentBackgroundAuthorizationResponseV1,
  verifyHistoricalBackgroundAuthorizationResponseV1,
} from "../../src/background/background-authorization-response-v1.ts";
import {
  createBackgroundAuthorizationResponseFixtureV1,
} from "../helpers/background-authorization-response-v1-fixture.ts";

const MAX_SEED = 32;

function selectedSeeds(): readonly number[] {
  if (
    process.env["LATTICE_MUTATION_SCOPE_ONLY"]
      === "background-grant-response"
    || process.env["LATTICE_MUTATION_HOSTED_SCOPE"]
      === "background-grant-response"
  ) {
    return [1];
  }
  const raw =
    process.env["M241_BACKGROUND_AUTHORIZATION_RESPONSE_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      "M241_BACKGROUND_AUTHORIZATION_RESPONSE_PROPERTY_SEED "
        + `must be 1-${MAX_SEED}`,
    );
  }
  return [seed];
}

function replayCommand(seed: number): string {
  return "M241_BACKGROUND_AUTHORIZATION_RESPONSE_PROPERTY_SEED="
    + `${seed} bun test --timeout 60000 `
    + "tests/property/"
    + "background-authorization-response-v1.property.test.ts";
}

describe("BackgroundAuthorizationResponseV1 recorded-seed properties", () => {
  test("round-trips, verifies both authority modes, and rejects replay substitutions", async () => {
    let previousWire: Uint8Array | null = null;
    for (const seed of selectedSeeds()) {
      try {
        const state =
          await createBackgroundAuthorizationResponseFixtureV1(
            24_600 + seed,
          );
        const canonical = encodeBackgroundAuthorizationResponseV1(
          decodeBackgroundAuthorizationResponseV1(
            state.response.bytes,
          ),
        );
        const current =
          await verifyCurrentBackgroundAuthorizationResponseV1(
            state.crypto,
            {
              responseBytes: canonical,
              now: state.descriptor.notBefore,
              resolveCurrentIssuingDevicePublicKey: () =>
                state.issuer.publicKey,
            },
          );
        const historical =
          await verifyHistoricalBackgroundAuthorizationResponseV1(
            state.crypto,
            {
              responseBytes: canonical,
              resolveHistoricalIssuingDevicePublicKey: () =>
                state.issuer.publicKey,
            },
          );

        expect(canonical).toEqual(state.response.bytes);
        expect(current.workDescriptor).toEqual(state.descriptor);
        expect(historical.credentialHash).toEqual(state.created.hash);
        if (previousWire !== null) {
          expect(canonical).not.toEqual(previousWire);
        }
        previousWire = canonical;

        const tampered = canonical.slice();
        tampered[tampered.length - 1] =
          tampered[tampered.length - 1]! ^ 1;
        expect(verifyCurrentBackgroundAuthorizationResponseV1(
          state.crypto,
          {
            responseBytes: tampered,
            now: state.descriptor.notBefore,
            resolveCurrentIssuingDevicePublicKey: () =>
              state.issuer.publicKey,
          },
        )).rejects.toThrow();
      } catch (error) {
        throw new Error(
          "BackgroundAuthorizationResponseV1 property failed "
            + `at seed ${seed}; replay: ${replayCommand(seed)}`,
          { cause: error },
        );
      }
    }
  });
});
