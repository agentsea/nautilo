import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanMemoryContentEmbeddingRequestV2,
  encodeHumanMemoryContentEmbeddingRequestV2,
  prepareHumanMemoryContentEmbeddingRequestV2,
  verifyHumanMemoryContentEmbeddingRequestV2,
} from "../../src/memory/content-embedding-request-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const MAX_SEED = 32;

function selectedSeeds(): readonly number[] {
  const raw = process.env["M243_HUMAN_MEMORY_EMBEDDING_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M243_HUMAN_MEMORY_EMBEDDING_PROPERTY_SEED must be 1-${MAX_SEED}`,
    );
  }
  return [seed];
}

function replay(seed: number): string {
  return `M243_HUMAN_MEMORY_EMBEDDING_PROPERTY_SEED=${seed} `
    + "bun test --timeout 60000 tests/property/"
    + "human-memory-content-embedding-request-v1.property.test.ts";
}

describe("Human Memory content-embedding request recorded-seed properties", () => {
  test("round-trips Unicode, multiple exact sets, and rejects one-byte substitutions", () => {
    for (const seed of selectedSeeds()) {
      try {
        const crypto = new LatticeCrypto(seededRng(24_300 + seed));
        const signer = crypto.generateSigningKeyPair();
        const envelopeCount = 1 + (seed % 4);
        const created = prepareHumanMemoryContentEmbeddingRequestV2(crypto, {
          subjectHumanId: humanId(`human-${seed}`),
          requestId: `memory-embedding-${seed}`,
          memoryId: `${seed.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
          expectedProductRevision: seed === 1 ? 0 : seed,
          nextProductRevision: seed === 1 ? 1 : seed + 1,
          cryptoObjectId: objectId(`memory:v1:${seed}`),
          ciphertextPayloadHash: new Uint8Array(32).fill(seed),
          genesisManifestHash: new Uint8Array(32).fill(seed + 1),
          namespaceEnvelopes: Array.from(
            { length: envelopeCount },
            (_, index) => ({
              namespaceId: namespaceId(`namespace-${String(index).padStart(3, "0")}`),
              envelopeHash: new Uint8Array(32).fill(seed + index + 3),
            }),
          ),
          type: `fact-${seed}`,
          content: `Memory ${seed}: Zażółć 🧠`,
          ...(seed % 2 === 0 ? { importance: seed / 100 } : {}),
          requestedProvider: seed % 2 === 0 ? "openai" : "openrouter",
          requestedModel: `model/${seed}`,
          dimensions: 1536,
          processorContractVersion: 1,
          issuedAt: unixTimestamp(1_000_000 + seed),
          deadlineAt: unixTimestamp(1_010_000 + seed),
          committerDeviceId: cryptoDeviceId(`device-${seed}`),
          hostAuthorizationRevision: authorizationRevision(seed),
          committerSigningPublicKey: signer.publicKey,
          committerSigningPrivateKey: signer.privateKey,
        });
        const canonical = encodeHumanMemoryContentEmbeddingRequestV2(
          decodeHumanMemoryContentEmbeddingRequestV2(created.bytes),
        );
        expect(canonical).toEqual(created.bytes);
        expect(verifyHumanMemoryContentEmbeddingRequestV2(crypto, {
          requestBytes: canonical,
          committerSigningPublicKey: signer.publicKey,
          now: unixTimestamp(1_005_000 + seed),
        }).content).toBe(`Memory ${seed}: Zażółć 🧠`);

        const tampered = canonical.slice();
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
        expect(() => verifyHumanMemoryContentEmbeddingRequestV2(crypto, {
          requestBytes: tampered,
          committerSigningPublicKey: signer.publicKey,
          now: unixTimestamp(1_005_000 + seed),
        })).toThrow("signature");
      } catch (error) {
        throw new Error(
          `Human Memory content-embedding property failed at seed ${seed}; replay: ${replay(seed)}`,
          { cause: error },
        );
      }
    }
  });
});
