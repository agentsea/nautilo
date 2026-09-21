import { describe, expect, test } from "bun:test";
import { accessRevision, agentId, authorizationRevision, cryptoDeviceId, humanId,
  namespaceGeneration, namespaceId, unixTimestamp } from "@nautilo/lattice-crypto";
import { encodeHumanAiReadableLiveShadowMessagePlanV1, encodeHumanPeerLiveShadowMessagePlanV1,
  encodeSharedAgentLiveShadowMessagePlanV1 } from "@nautilo/lattice-crypto/wire";
import {
  createProductionLiveShadowMessageComposition,
  selectLiveShadowTurnPlan,
} from "../../src/routes/live-shadow-message-composition";

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

describe("live Shadow planner selection", () => {
  const input = Object.freeze({
    authority: Object.freeze({ userId: USER, humanActorId: HUMAN }),
    roomId: ROOM,
    clientActionSessionId: SESSION,
    clientDeviceId: "policy-device",
    idempotencyKey: "policy-selection",
    now: NOW,
  });

  test("returns a supported shared plan without consulting the peer planner", async () => {
    const planned = Object.freeze({
      status: "planned" as const,
      planBytes: new Uint8Array([6]),
    });
    let peerCalls = 0;

    expect(await selectLiveShadowTurnPlan(input, {
      shared: async () => planned,
      humanPeer: async () => {
        peerCalls++;
        return Object.freeze({
          status: "planned" as const,
          planBytes: new Uint8Array([99]),
        });
      },
    })).toBe(planned);
    expect(peerCalls).toBe(0);
  });

  test.each([1, 2] as const)("uses Human-only authority for a version-%i topology miss", async (requestVersion) => {
    const peerPlan = Object.freeze({
      status: "planned" as const,
      planBytes: new Uint8Array([7]),
    });
    const calls: string[] = [];

    expect(await selectLiveShadowTurnPlan({ ...input, requestVersion }, {
      shared: async () => {
        calls.push("shared");
        return Object.freeze({
          status: "ineligible" as const,
          reason: "room_topology_unsupported" as const,
        });
      },
      humanPeer: async () => {
        calls.push("human_peer");
        return peerPlan;
      },
    })).toBe(peerPlan);
    expect(calls).toEqual(["shared", "human_peer"]);
  });

  test.each([
    Object.freeze({
      status: "unavailable" as const,
      authorizationScheme: "human_ai_readable_v1" as const,
      reason: "policy_unavailable" as const,
    }),
    Object.freeze({
      status: "unavailable" as const,
      authorizationScheme: "human_ai_readable_v1" as const,
      reason: "recipient_sync_required" as const,
    }),
    Object.freeze({
      status: "unavailable" as const,
      authorizationScheme: "human_ai_readable_v1" as const,
      reason: "namespace_unavailable" as const,
      requiredNamespaceIds: Object.freeze([NAMESPACE]),
    }),
    Object.freeze({ status: "disabled" as const, mode: "plaintext_only" as const }),
  ])("preserves shared unavailability without trying another issuer: %j", async (result) => {
    let peerCalls = 0;

    expect(await selectLiveShadowTurnPlan(input, {
      shared: async () => result,
      humanPeer: async () => {
        peerCalls++;
        return Object.freeze({
          status: "planned" as const,
          planBytes: new Uint8Array([9]),
        });
      },
    })).toBe(result);
    expect(peerCalls).toBe(0);
  });

  test("propagates a shared planner failure without trying the peer planner", async () => {
    const failure = new Error("shared planner failed");
    let peerCalls = 0;

    expect(selectLiveShadowTurnPlan(input, {
      shared: () => Promise.reject(failure),
      humanPeer: async () => {
        peerCalls++;
        return Object.freeze({
          status: "planned" as const,
          planBytes: new Uint8Array([10]),
        });
      },
    })).rejects.toBe(failure);
    expect(peerCalls).toBe(0);
  });
});
