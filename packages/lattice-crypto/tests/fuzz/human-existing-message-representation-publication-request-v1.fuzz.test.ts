import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanExistingMessageRepresentationPublicationRequestV1,
  encodeHumanExistingMessageRepresentationPublicationRequestV1,
  prepareHumanExistingMessageRepresentationPublicationRequestV1,
  verifyHumanExistingMessageRepresentationPublicationRequestV1,
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

const MAX_SEED = 512;

function selectedSeeds(): readonly number[] {
  const raw = process.env["M280_EXISTING_MESSAGE_REPRESENTATION_FUZZ_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M280_EXISTING_MESSAGE_REPRESENTATION_FUZZ_SEED must be 1-${MAX_SEED}`,
    );
  }
  return [seed];
}

function replay(seed: number): string {
  return `M280_EXISTING_MESSAGE_REPRESENTATION_FUZZ_SEED=${seed} `
    + "bun test --timeout 60000 tests/fuzz/"
    + "human-existing-message-representation-publication-request-v1.fuzz.test.ts";
}

describe("Human existing Message representation request mutation fuzz", () => {
  test("never accepts truncated, extended, or mutated signed bytes", () => {
    const crypto = new LatticeCrypto(seededRng(280_512));
    const signer = crypto.generateSigningKeyPair();
    const issuedAt = 1_900_000_000_000;
    const canonical = prepareHumanExistingMessageRepresentationPublicationRequestV1(
      crypto,
      {
        subjectHumanId: humanId("human-existing-message-fuzz"),
        operationId: "existing-message-operation-fuzz",
        sessionId: "00000000-0000-4000-8000-000000000280",
        roomId: "00000000-0000-4000-8000-000000000281",
        messageId: 280,
        revision: 7,
        createdAt: unixTimestamp(issuedAt - 1_000),
        authorRole: "tool",
        authorHumanTurnId: null,
        sessionAgentId: agentId("agent-existing-message-fuzz"),
        cryptoObjectId: objectId("message:v1:fuzz"),
        namespaceId: namespaceId("namespace-existing-message-fuzz"),
        namespaceBindingHash: new Uint8Array(32).fill(1),
        namespaceAccessRevision: 4,
        namespaceKeyGeneration: 2,
        bindingRevisionAtWrap: 4,
        ciphertextPayloadHash: new Uint8Array(32).fill(2),
        plaintextPayloadHash: new Uint8Array(32).fill(3),
        accessManifestHash: new Uint8Array(32).fill(4),
        envelopeHash: new Uint8Array(32).fill(5),
        issuedAt: unixTimestamp(issuedAt),
        deadlineAt: unixTimestamp(issuedAt + 30_000),
        committerDeviceId: cryptoDeviceId("device-existing-message-fuzz"),
        hostAuthorizationRevision: authorizationRevision(5),
        committerSigningPublicKey: signer.publicKey,
        committerSigningPrivateKey: signer.privateKey,
      },
    ).bytes;

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
            decoded = decodeHumanExistingMessageRepresentationPublicationRequestV1(
              candidate,
            );
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            continue;
          }
          expect(
            encodeHumanExistingMessageRepresentationPublicationRequestV1(decoded),
          ).toEqual(candidate);
          expect(() => verifyHumanExistingMessageRepresentationPublicationRequestV1(
            crypto,
            {
              requestBytes: candidate,
              now: unixTimestamp(issuedAt + 1),
              resolveCurrentAuthority: () => signer.publicKey,
            },
          )).toThrow();
        }
      } catch (error) {
        throw new Error(
          `Existing Message representation fuzz failed at seed ${seed}; replay: ${replay(seed)}`,
          { cause: error },
        );
      }
    }
  });
});
