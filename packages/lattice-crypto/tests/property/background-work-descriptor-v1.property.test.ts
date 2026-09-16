import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
  decodeBackgroundWorkDescriptorV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "../../src/background/work-descriptor-v1.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

const MAX_SEED = 128;

function descriptor(seed: number): BackgroundWorkDescriptorV1 {
  const inputCount = 1 + (seed % 8);
  const outputCount = 1 + ((seed * 3) % 8);
  return {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
    requestId: `request-${seed}`,
    recipientGeneration: seed,
    workKind: seed % 2 === 0
      ? "stenographer.extraction"
      : "stenographer.historical",
    workId: `batch-${seed}`,
    namespaceId: namespaceId(`namespace-${seed}`),
    domainId: cryptoDomainId(`domain-${seed}`),
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(seed),
    },
    purpose: "journal.extract",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "journal_range",
      startSequence: seed * 100,
      endSequence: seed * 100 + inputCount - 1,
      rebuildGeneration: seed % 7,
      fingerprint: new Uint8Array(32).fill(seed & 0xff),
    },
    inputObjectIds: Array.from(
      { length: inputCount },
      (_, index) =>
        objectId(
          `input-${seed}-${index.toString().padStart(3, "0")}`,
        ),
    ),
    outputObjectIds: Array.from(
      { length: outputCount },
      (_, index) =>
        objectId(
          `output-${seed}-${index.toString().padStart(3, "0")}`,
        ),
    ),
    outputObjectMetadata: Array.from(
      { length: outputCount },
      (_, index) => ({
        objectId: objectId(
          `output-${seed}-${index.toString().padStart(3, "0")}`,
        ),
        objectType: "journal.rollup",
        createdAt: unixTimestamp(seed * 10_000 + index),
      }),
    ),
    maximumInputObjectCount: inputCount,
    maximumOutputObjectCount: outputCount,
    maximumPlaintextBytes: 1 + ((seed * 997) % V2_LIMITS.plaintextBytes),
    maximumCiphertextBytes: 1 + ((seed * 991) % V2_LIMITS.ciphertextBytes),
    expectedDomainEpoch: domainEpoch(seed),
    expectedNamespaceAccessRevision: accessRevision(seed + 1),
    expectedPolicyRevision: authorizationRevision(seed + 2),
    recipientKeyId: `recipient-${seed}`,
    recipientPublicKey:
      new Uint8Array(V2_LIMITS.hpkePublicKeyBytes).fill(seed & 0xff),
    issuedAt: seed * 10_000,
    notBefore: seed * 10_000 + 1,
    expiresAt: seed * 10_000 + 60_000,
    idempotencyId: `batch-${seed}-generation-${seed % 7}`,
  };
}

function replayCommand(seed: number): string {
  return `M241_DESCRIPTOR_PROPERTY_SEED=${seed} bun test --timeout 60000 `
    + "tests/property/background-work-descriptor-v1.property.test.ts";
}

function selectedSeeds(): readonly number[] {
  const raw = process.env["M241_DESCRIPTOR_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M241_DESCRIPTOR_PROPERTY_SEED must be 1-${MAX_SEED}`,
    );
  }
  return [seed];
}

describe("BackgroundWorkDescriptorV1 recorded-seed properties", () => {
  test("is deterministic, canonical, detached, bounded, and seed-sensitive", () => {
    for (const seed of selectedSeeds()) {
      try {
        const original = descriptor(seed);
        const repeated = descriptor(seed);
        const previous = descriptor(seed === 1 ? MAX_SEED : seed - 1);
        const encoded = encodeBackgroundWorkDescriptorV1(original);
        const decoded = decodeBackgroundWorkDescriptorV1(encoded);

        expect(decoded).toEqual(original);
        expect(decoded).not.toBe(original);
        expect(decoded.recipientPublicKey)
          .not.toBe(original.recipientPublicKey);
        expect(decoded.source.fingerprint)
          .not.toBe(original.source.fingerprint);
        expect(encoded).toEqual(
          encodeBackgroundWorkDescriptorV1(repeated),
        );
        expect(encoded).not.toEqual(
          encodeBackgroundWorkDescriptorV1(previous),
        );
        expect(encodeBackgroundWorkDescriptorV1(decoded)).toEqual(encoded);
        expect(() =>
          decodeBackgroundWorkDescriptorV1(encoded.slice(0, -1))
        ).toThrow();
        expect(() =>
          decodeBackgroundWorkDescriptorV1(
            new Uint8Array([...encoded, seed & 0xff]),
          )
        ).toThrow("trailing");
      } catch (error) {
        throw new Error(
          `BackgroundWorkDescriptorV1 property failed at seed ${seed}; replay: ${
            replayCommand(seed)
          }`,
          { cause: error },
        );
      }
    }
  });
});
