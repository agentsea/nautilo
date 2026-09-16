import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createHumanObjectAccessManifestV5,
  decodeObjectAccessManifestV5,
  encodeObjectAccessManifestV5,
  verifyObjectAccessManifestV5,
} from "../../src/format/object-access-manifest-v5.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
} from "../../src/v2-types/ids.ts";

const MAX_SEED = 512;

function selectedSeeds(): readonly number[] {
  const raw = process.env["M263_MANIFEST_FUZZ_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(`M263_MANIFEST_FUZZ_SEED must be from 1 through ${MAX_SEED}`);
  }
  return [seed];
}

function replay(seed: number): string {
  return `M263_MANIFEST_FUZZ_SEED=${seed} bun test --timeout 60000 `
    + "tests/fuzz/object-access-manifest-v5.fuzz.test.ts";
}

describe("ObjectAccessManifestV5 deterministic mutation fuzz", () => {
  test("never accepts noncanonical or unauthenticated mutated bytes", () => {
    const crypto = new LatticeCrypto(seededRng(26_399));
    const device = crypto.generateSigningKeyPair();
    const canonical = createHumanObjectAccessManifestV5(crypto, {
      objectId: objectId("object-fuzz-v5"),
      payloadHash: new Uint8Array(32).fill(0x31),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [new Uint8Array(32).fill(0x32)],
      signer: {
        kind: "human_device",
        subjectHumanId: humanId("human-fuzz-v5"),
        committerDeviceId: cryptoDeviceId("device-fuzz-v5"),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(3),
    }, device.privateKey).bytes;

    for (const seed of selectedSeeds()) {
      try {
        const offset = (Math.imul(seed, 0x9e37_79b1) >>> 0) % canonical.length;
        const flipped = canonical.slice();
        flipped[offset] = flipped[offset]! ^ (1 << (seed % 8));
        const candidates = [
          canonical.slice(0, seed % canonical.length),
          Uint8Array.from([...canonical, seed & 0xff]),
          flipped,
        ];
        for (const candidate of candidates) {
          let decoded;
          try {
            decoded = decodeObjectAccessManifestV5(candidate);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            continue;
          }
          expect(encodeObjectAccessManifestV5(decoded)).toEqual(candidate);
          expect(() => verifyObjectAccessManifestV5(crypto, {
            manifestBytes: candidate,
            resolveHistoricalHumanDeviceSigningPublicKey: () => device.publicKey,
            resolveAgentRuntimeSignerPublicKey: () => null,
            resolveProcessorSignerAuthorizationBytes: () => null,
            resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
          })).toThrow();
        }
      } catch (error) {
        throw new Error(
          `ObjectAccessManifestV5 fuzz failed at seed ${seed}; replay: ${replay(seed)}`,
          { cause: error },
        );
      }
    }
  });
});
