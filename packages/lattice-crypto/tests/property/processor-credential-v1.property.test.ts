import { describe, expect, test } from "bun:test";

import {
  decodeProcessorCredentialV1,
  encodeProcessorCredentialV1,
  openProcessorCredentialV1,
  verifyProcessorCredentialV1,
} from "../../src/background/processor-credential-v1.ts";
import {
  PROCESSOR_CREDENTIAL_FIXTURE_NOW,
  createProcessorCredentialFixtureV1,
} from "../helpers/processor-credential-v1-fixture.ts";

const MAX_SEED = 32;

function selectedSeeds(): readonly number[] {
  const raw = process.env["M241_PROCESSOR_CREDENTIAL_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M241_PROCESSOR_CREDENTIAL_PROPERTY_SEED must be 1-${MAX_SEED}`,
    );
  }
  return [seed];
}

function replayCommand(seed: number): string {
  return `M241_PROCESSOR_CREDENTIAL_PROPERTY_SEED=${seed} `
    + "bun test --timeout 60000 "
    + "tests/property/processor-credential-v1.property.test.ts";
}

describe("ProcessorCredentialV1 recorded-seed properties", () => {
  test("round-trips, verifies, opens, rejects signed substitutions, and is seed-sensitive", async () => {
    let previousWire: Uint8Array | null = null;
    for (const seed of selectedSeeds()) {
      try {
        const state =
          await createProcessorCredentialFixtureV1(24_300 + seed);
        const canonical = encodeProcessorCredentialV1(
          decodeProcessorCredentialV1(state.created.bytes),
        );
        const verified = await verifyProcessorCredentialV1(state.crypto, {
          credentialBytes: canonical,
          now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
          resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
        });
        const opened = await openProcessorCredentialV1(state.crypto, {
          credentialBytes: canonical,
          recipientPrivateKey: state.recipient.privateKey,
          now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
          resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
        });

        expect(canonical).toEqual(state.created.bytes);
        expect(verified.workDescriptor).toEqual(state.descriptor);
        expect(opened?.aiRoot).toEqual(state.aiRoot);
        if (previousWire !== null) {
          expect(canonical).not.toEqual(previousWire);
        }
        previousWire = canonical;

        const tampered = canonical.slice();
        tampered[tampered.length - 1] =
          tampered[tampered.length - 1]! ^ 1;
        expect(verifyProcessorCredentialV1(state.crypto, {
          credentialBytes: tampered,
          now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
          resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
        })).rejects.toThrow();
      } catch (error) {
        throw new Error(
          `ProcessorCredentialV1 property failed at seed ${seed}; replay: ${
            replayCommand(seed)
          }`,
          { cause: error },
        );
      }
    }
  });
});
