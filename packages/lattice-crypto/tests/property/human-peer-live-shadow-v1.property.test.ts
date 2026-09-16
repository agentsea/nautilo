import { describe, expect, test } from "bun:test";

import {
  decodeHumanPeerLiveShadowMessagePlanV1,
  encodeHumanPeerLiveShadowMessagePlanV1,
} from "../../src/message/human-peer-live-shadow-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const MAX_SEED = 64;

function selectedSeeds(): readonly number[] {
  const raw = process.env["M295_HUMAN_PEER_LIVE_SHADOW_PROPERTY_SEED"];
  if (raw === undefined) {
    return Array.from({ length: MAX_SEED }, (_, index) => index + 1);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED) {
    throw new RangeError(
      `M295_HUMAN_PEER_LIVE_SHADOW_PROPERTY_SEED must be 1-${MAX_SEED}`,
    );
  }
  return [seed];
}

describe("Human-peer live Shadow plan recorded-seed properties", () => {
  test("round-trips canonical authority and keeps mutations byte-distinct", () => {
    for (const seed of selectedSeeds()) {
      const issuedAt = 1_900_000_000_000 + seed;
      const plan = encodeHumanPeerLiveShadowMessagePlanV1({
        formatVersion: 1,
        purpose: "message.human_peer_live_shadow_plan",
        operationId: `human_peer_operation_${seed}`,
        clientIdempotencyKey: `human_peer_request_${seed}`,
        policyRevision: seed,
        sessionId: `${seed.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
        roomId: `${seed.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`,
        humanMessageId: seed,
        revision: 0,
        transcriptOrdinal: seed + 1,
        role: "user",
        createdAt: unixTimestamp(issuedAt),
        subjectHumanId: humanId(`human_peer_${seed}`),
        committerDeviceId: cryptoDeviceId(`device_peer_${seed}`),
        committerDeviceSigningKeyGeneration: seed % 5,
        hostAuthorizationRevision: authorizationRevision(seed % 7),
        namespaceId: namespaceId(`namespace_peer_${seed}`),
        keyClass: "human",
        namespaceAccessRevision: seed % 9,
        namespaceKeyGeneration: seed % 11,
        namespaceHeadDigest: new Uint8Array(32).fill(seed),
        namespacePublicationDigest: new Uint8Array(32).fill(seed + 1),
        namespacePublicationSetDigest: new Uint8Array(32).fill(seed + 2),
        namespaceAudienceFingerprint: new Uint8Array(32).fill(seed + 3),
        attemptCoordinate: `human_peer_attempt_${seed}`,
        issuedAt: unixTimestamp(issuedAt),
        deadlineAt: unixTimestamp(issuedAt + 30_000),
      });
      expect(encodeHumanPeerLiveShadowMessagePlanV1(
        decodeHumanPeerLiveShadowMessagePlanV1(plan),
      )).toEqual(plan);
      const mutation = plan.slice();
      const offset = (Math.imul(seed, 0x9e37_79b1) >>> 0) % mutation.length;
      mutation[offset] = mutation[offset]! ^ (1 << (seed % 8));
      try {
        expect(encodeHumanPeerLiveShadowMessagePlanV1(
          decodeHumanPeerLiveShadowMessagePlanV1(mutation),
        )).toEqual(mutation);
        expect(mutation).not.toEqual(plan);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});
