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

const MAX_SEED = 64;

function selectedSeeds(): readonly number[] {
  const raw = process.env["M263_MANIFEST_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M263_MANIFEST_PROPERTY_SEED must be from 1 through ${MAX_SEED}`,
    );
  }
  return [seed];
}

function replay(seed: number): string {
  return `M263_MANIFEST_PROPERTY_SEED=${seed} bun test --timeout 60000 `
    + "tests/property/object-access-manifest-v5.property.test.ts";
}

function hash(seed: number, marker: number): Uint8Array {
  return new Uint8Array(32).map((_, index) =>
    (seed * 31 + marker * 17 + index) & 0xff
  );
}

describe("ObjectAccessManifestV5 recorded-seed properties", () => {
  test("is canonical, deterministic, detached, and signature-bound", () => {
    for (const seed of selectedSeeds()) {
      try {
        const crypto = new LatticeCrypto(seededRng(26_300 + seed));
        const device = crypto.generateSigningKeyPair();
        const unsigned = {
          objectId: objectId(`object-property-${seed}`),
          payloadHash: hash(seed, 1),
          accessRevision: accessRevision(0),
          previousManifestHash: null,
          envelopeHashes: Array.from(
            { length: seed % 5 },
            (_, index) => hash(seed, index + 2),
          ).reverse(),
          signer: {
            kind: "human_device" as const,
            subjectHumanId: humanId(`human-property-${seed}`),
            committerDeviceId: cryptoDeviceId(`device-property-${seed}`),
          },
          signerAuthorizationHash: null,
          hostAuthorizationRevision: authorizationRevision(seed),
        };
        const created = createHumanObjectAccessManifestV5(
          crypto,
          unsigned,
          device.privateKey,
        );
        const repeated = createHumanObjectAccessManifestV5(
          crypto,
          unsigned,
          device.privateKey,
        );
        const decoded = decodeObjectAccessManifestV5(created.bytes);
        const canonical = encodeObjectAccessManifestV5(decoded);
        expect(repeated.bytes).toEqual(created.bytes);
        expect(canonical).toEqual(created.bytes);
        expect(canonical).not.toBe(created.bytes);
        expect(verifyObjectAccessManifestV5(crypto, {
          manifestBytes: created.bytes,
          resolveHistoricalHumanDeviceSigningPublicKey: () => device.publicKey,
          resolveAgentRuntimeSignerPublicKey: () => null,
          resolveProcessorSignerAuthorizationBytes: () => null,
          resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
        }).manifestHash).toEqual(created.hash);

        unsigned.payloadHash.fill(0xff);
        unsigned.envelopeHashes.forEach((bytes) => bytes.fill(0xff));
        expect(created.manifest.payloadHash).not.toEqual(unsigned.payloadHash);
        expect(created.bytes).toEqual(canonical);

        const tampered = created.bytes.slice();
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
        expect(() => verifyObjectAccessManifestV5(crypto, {
          manifestBytes: tampered,
          resolveHistoricalHumanDeviceSigningPublicKey: () => device.publicKey,
          resolveAgentRuntimeSignerPublicKey: () => null,
          resolveProcessorSignerAuthorizationBytes: () => null,
          resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
        })).toThrow();
      } catch (error) {
        throw new Error(
          `ObjectAccessManifestV5 property failed at seed ${seed}; replay: ${replay(seed)}`,
          { cause: error },
        );
      }
    }
  });
});
