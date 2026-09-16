import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanExistingMessageRepresentationPublicationRequestV1,
  encodeHumanExistingMessageRepresentationPublicationRequestV1,
  prepareHumanExistingMessageRepresentationPublicationRequestV1,
  verifyHumanExistingMessageRepresentationPublicationRequestV1,
  type HumanExistingMessageRepresentationAuthorRoleV1,
} from "../../src/message/existing-representation-publication-request-v1.ts";
import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const MAX_SEED = 64;
const ROLES = ["user", "assistant", "tool", "system"] as const;

function selectedSeeds(): readonly number[] {
  const raw = process.env["M280_EXISTING_MESSAGE_REPRESENTATION_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M280_EXISTING_MESSAGE_REPRESENTATION_PROPERTY_SEED must be 1-${MAX_SEED}`,
    );
  }
  return [seed];
}

function replay(seed: number): string {
  return `M280_EXISTING_MESSAGE_REPRESENTATION_PROPERTY_SEED=${seed} `
    + "bun test --timeout 60000 tests/property/"
    + "human-existing-message-representation-publication-request-v1.property.test.ts";
}

function roleFor(seed: number): HumanExistingMessageRepresentationAuthorRoleV1 {
  return ROLES[(seed - 1) % ROLES.length]!;
}

describe("Human existing Message representation publication recorded-seed properties", () => {
  test("round-trips every immutable role and rejects every deterministic byte mutation", () => {
    for (const seed of selectedSeeds()) {
      try {
        const crypto = new LatticeCrypto(seededRng(280_000 + seed));
        const signer = crypto.generateSigningKeyPair();
        const authorRole = roleFor(seed);
        const issuedAt = 1_900_000_000_000 + seed;
        const created = prepareHumanExistingMessageRepresentationPublicationRequestV1(
          crypto,
          {
            subjectHumanId: humanId(`human-existing-message-${seed}`),
            operationId: `existing-message-operation-${seed}`,
            sessionId: `${seed.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
            roomId: `${seed.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`,
            messageId: seed,
            revision: seed % 5,
            createdAt: unixTimestamp(issuedAt - 1_000),
            authorRole,
            authorHumanTurnId: authorRole === "user" ? `human-turn-${seed}` : null,
            sessionAgentId: seed % 3 === 0 ? null : agentId(`agent-${seed}`),
            cryptoObjectId: objectId(`message:v1:${seed}`),
            namespaceId: namespaceId(`namespace-${seed}`),
            namespaceBindingHash: new Uint8Array(32).fill(seed),
            namespaceAccessRevision: seed % 7,
            namespaceKeyGeneration: 1 + (seed % 5),
            bindingRevisionAtWrap: seed % 7,
            ciphertextPayloadHash: new Uint8Array(32).fill(seed + 1),
            plaintextPayloadHash: new Uint8Array(32).fill(seed + 2),
            accessManifestHash: new Uint8Array(32).fill(seed + 3),
            envelopeHash: new Uint8Array(32).fill(seed + 4),
            issuedAt: unixTimestamp(issuedAt),
            deadlineAt: unixTimestamp(issuedAt + 30_000),
            committerDeviceId: cryptoDeviceId(`device-${seed}`),
            hostAuthorizationRevision: authorizationRevision(seed),
            committerSigningPublicKey: signer.publicKey,
            committerSigningPrivateKey: signer.privateKey,
          },
        );
        const canonical = encodeHumanExistingMessageRepresentationPublicationRequestV1(
          decodeHumanExistingMessageRepresentationPublicationRequestV1(created.bytes),
        );
        expect(canonical).toEqual(created.bytes);
        const verified = verifyHumanExistingMessageRepresentationPublicationRequestV1(
          crypto,
          {
            requestBytes: canonical,
            now: unixTimestamp(issuedAt + 1),
            resolveCurrentAuthority: () => signer.publicKey,
          },
        );
        expect(verified.authorRole).toBe(authorRole);
        expect(verified.authorHumanTurnId).toBe(
          authorRole === "user" ? `human-turn-${seed}` : null,
        );

        const offset = Math.imul(seed, 0x9e37_79b1) >>> 0;
        const tampered = canonical.slice();
        const index = offset % canonical.length;
        tampered[index] = tampered[index]! ^ (1 << (seed % 8));
        expect(() => verifyHumanExistingMessageRepresentationPublicationRequestV1(
          crypto,
          {
            requestBytes: tampered,
            now: unixTimestamp(issuedAt + 1),
            resolveCurrentAuthority: () => signer.publicKey,
          },
        )).toThrow();
      } catch (error) {
        throw new Error(
          `Existing Message representation property failed at seed ${seed}; replay: ${replay(seed)}`,
          { cause: error },
        );
      }
    }
  });
});
