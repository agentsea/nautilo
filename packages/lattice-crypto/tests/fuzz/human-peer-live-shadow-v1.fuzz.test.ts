import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanPeerLiveShadowMessageRequestV1,
  encodeHumanPeerLiveShadowMessageRequestV1,
  prepareHumanPeerLiveShadowMessageRequestV1,
  verifyHumanPeerLiveShadowMessageRequestV1,
} from "../../src/message/human-peer-live-shadow-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const MAX_SEED = 256;

function selectedSeeds(): readonly number[] {
  const raw = process.env["M295_HUMAN_PEER_LIVE_SHADOW_FUZZ_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M295_HUMAN_PEER_LIVE_SHADOW_FUZZ_SEED must be 1-${MAX_SEED}`,
    );
  }
  return [seed];
}

describe("Human-peer live Shadow signed-request mutation fuzz", () => {
  test("never authenticates truncated, extended, or mutated bytes", () => {
    const now = 1_900_000_000_000;
    const crypto = new LatticeCrypto(seededRng(295_512));
    const signer = crypto.generateSigningKeyPair();
    const digest = (fill: number) => new Uint8Array(32).fill(fill);
    const canonical = prepareHumanPeerLiveShadowMessageRequestV1(crypto, {
      subjectHumanId: humanId("human_peer_fuzz"),
      operationId: "human_peer_operation_fuzz",
      clientIdempotencyKey: "human_peer_request_fuzz",
      policyRevision: 2,
      sessionId: "00000000-0000-4000-8000-000000000295",
      roomId: "00000000-0000-4000-8000-000000000296",
      messageId: 295,
      revision: 0,
      transcriptOrdinal: 8,
      role: "user",
      createdAt: unixTimestamp(now),
      cryptoObjectId: objectId("message:live-shadow:v1:human-peer-fuzz"),
      namespaceId: namespaceId("namespace_peer_fuzz"),
      keyClass: "human",
      namespaceAccessRevision: 3,
      namespaceKeyGeneration: 4,
      namespaceHeadDigest: digest(1),
      namespacePublicationDigest: digest(2),
      namespacePublicationSetDigest: digest(3),
      namespaceAudienceFingerprint: digest(4),
      planDigest: digest(5),
      plaintextPayloadDigest: digest(6),
      encryptedPayloadDigest: digest(7),
      manifestDigest: digest(8),
      envelopeDigest: digest(9),
      issuedAt: unixTimestamp(now),
      deadlineAt: unixTimestamp(now + 30_000),
      committerDeviceId: cryptoDeviceId("device_peer_fuzz"),
      committerDeviceSigningKeyGeneration: 3,
      hostAuthorizationRevision: authorizationRevision(4),
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    }).bytes;

    for (const seed of selectedSeeds()) {
      const offset = (Math.imul(seed, 0x9e37_79b1) >>> 0) % canonical.length;
      const flipped = canonical.slice();
      flipped[offset] = flipped[offset]! ^ (1 << (seed % 8));
      const candidates = [
        canonical.slice(0, seed % canonical.length),
        Uint8Array.from([...canonical, seed & 0xff]),
        flipped,
      ];
      for (const candidate of candidates) {
        try {
          const decoded = decodeHumanPeerLiveShadowMessageRequestV1(candidate);
          expect(encodeHumanPeerLiveShadowMessageRequestV1(decoded))
            .toEqual(candidate);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          continue;
        }
        expect(() => verifyHumanPeerLiveShadowMessageRequestV1(crypto, {
          requestBytes: candidate,
          now: unixTimestamp(now + 1),
          resolveCurrentAuthority: () => signer.publicKey,
        })).toThrow();
      }
    }
  });
});
