import { describe, expect, test } from "bun:test";
import { accessRevision, agentId, authorizationRevision, cryptoDeviceId, humanId,
  namespaceGeneration, namespaceId, unixTimestamp } from "@nautilo/lattice-crypto";
import { encodeHumanAiReadableLiveShadowMessagePlanV1, encodeHumanPeerLiveShadowMessagePlanV1,
  encodeSharedAgentLiveShadowMessagePlanV1 } from "@nautilo/lattice-crypto/wire";
import { createProductionLiveShadowMessageComposition } from "../../src/routes/live-shadow-message-composition";

const NOW = 1_800_000_000_000;
const USER = "10000000-0000-4000-8000-000000000318";
const HUMAN = "20000000-0000-4000-8000-000000000318";
const ROOM = "30000000-0000-4000-8000-000000000318";
const SESSION = "40000000-0000-4000-8000-000000000318";
const NAMESPACE = "50000000-0000-4000-8000-000000000318";

function planBytes(scheme: "peer" | "shared" | "ai_readable") {
  const common = {
    formatVersion: 1 as const, operationId: "m318_policy_send", clientIdempotencyKey: "m318_policy_client",
    policyRevision: 7, sessionId: SESSION, roomId: ROOM, humanMessageId: 318,
    revision: 0 as const, transcriptOrdinal: 1, role: "user" as const, createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId("m318_device"),
    committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: authorizationRevision(1),
    namespaceId: namespaceId(NAMESPACE), namespaceAccessRevision: accessRevision(1),
    namespaceKeyGeneration: namespaceGeneration(1), namespaceHeadDigest: new Uint8Array(32).fill(1),
    namespacePublicationDigest: new Uint8Array(32).fill(2),
    namespacePublicationSetDigest: new Uint8Array(32).fill(3),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(4), attemptCoordinate: "m318_attempt",
    issuedAt: unixTimestamp(NOW), deadlineAt: unixTimestamp(NOW + 30_000),
  };
  if (scheme === "peer") return encodeHumanPeerLiveShadowMessagePlanV1({
    ...common, purpose: "message.human_peer_live_shadow_plan", keyClass: "human",
  });
  if (scheme === "ai_readable") return encodeHumanAiReadableLiveShadowMessagePlanV1({
    ...common, purpose: "message.human_ai_readable_live_shadow_plan", keyClass: "ai",
  });
  return encodeSharedAgentLiveShadowMessagePlanV1({
    ...common, purpose: "message.shared_agent_live_shadow_plan", keyClass: "ai",
    recipientAgentId: agentId("m318_agent"),
  });
}

describe("prepared Message policy entrance", () => {
  test.each((["peer", "shared", "ai_readable"] as const).flatMap((scheme) => [
    { scheme, mode: "plaintext_only" as const, revision: 7, full: false },
    { scheme, mode: "shadow_encryption" as const, revision: 7, full: true },
    { scheme, mode: "encrypted_only" as const, revision: 7, full: false },
    { scheme, mode: "encrypted_only" as const, revision: 8, full: true },
  ]))("rejects stale/mismatched prepared policy before database custody: %j", async (scenario) => {
    let policyReads = 0;
    const composition = createProductionLiveShadowMessageComposition({
      wakeForegroundMemoryEffectRecovery: () => undefined,
      loadRuntimePolicy: () => {
        policyReads++;
        return Promise.resolve({ mode: scenario.mode, revision: scenario.revision, shadowBehavior: "fallback" });
      },
    });
    const prepared = {
      operationId: "m318_policy_send", userId: USER, actorId: HUMAN, planBytes: planBytes(scenario.scheme),
      requestBytes: new Uint8Array([1]), encryptedPayloadBytes: new Uint8Array([2]),
      manifestBytes: new Uint8Array([3]), envelopeBytes: new Uint8Array([4]), now: NOW,
      ...(scenario.full ? { representationMode: "full_encryption" as const }
        : { expectedContent: "ordinary", ordinaryPayloadBytes: new Uint8Array([5]) }),
    };
    const result = scenario.scheme === "peer"
      ? await composition.admitHumanPeer(prepared)
      : await composition.admitSharedAgent?.(prepared);
    expect(result).toEqual({ status: "ordinary_fallback", operationId: "m318_policy_send",
      reason: "authority_stale", messageId: null });
    expect(policyReads).toBe(1);
  });
});
