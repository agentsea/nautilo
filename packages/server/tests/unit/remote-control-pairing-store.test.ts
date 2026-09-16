import { describe, expect, test } from "bun:test";
import type { RemotePairingStore } from "../../src/remote-control/pairing-store";

describe("D458 remote pairing store contract", () => {
  test("requires exact-id verifier lookup and a CAS consume seam", async () => {
    const store: RemotePairingStore = {
      ensureControllerInstallation: async () => ({ id: "controller" }),
      createChallenge: async () => ({ id: "challenge", version: 1 }),
      findChallengeForVerification: async (challengeId) =>
        challengeId === "challenge"
          ? {
              id: "challenge",
              version: 1,
              serverInstanceId: "server",
              serverBindingGeneration: 1,
              userId: "user",
              actorId: "actor",
              relayTokenId: "relay",
              hostInstallationId: "host",
              desktopSessionId: "session",
              pairingGeneration: "relay",
              qrVerifierDigest: "digest",
              manualVerifierDigest: null,
              expiresAt: new Date(),
              consumedAt: null,
              revokedAt: null,
              failedAttempts: 0,
            }
          : null,
      findChallengeForManualVerifier: async () => null,
      recordFailedVerifierAttempt: async () => "rejected",
      consumeChallengeAndCreateBinding: async () => "conflict",
      consumeChallengeEnsureInstallationAndCreateBinding: async () => ({ outcome: "conflict" }),
      revokeBindingForUser: async () => false,
      revokeChallenge: async () => false,
      cleanupExpiredChallenges: async () => 0,
      findActiveRelayForUser: async () => null,
      listPairedHostRowsForUser: async () => [],
      listPairedHostRowsForController: async () => ({
        controllerLabel: null,
        rows: [],
      }),
      listActiveHostBindingsForController: async () => [],
      listControllerBindingsForUser: async () => [],
      renameControllerInstallationForUser: async () => false,
      findControllerOriginForOrdinaryRequest: async () => null,
    };
    expect(await store.findChallengeForVerification("challenge")).not.toBeNull();
    expect(await store.findChallengeForVerification("other")).toBeNull();
    expect(await store.consumeChallengeAndCreateBinding({
      challengeId: "challenge",
      expectedVersion: 1,
      consumedAt: new Date(),
      controllerInstallationId: "controller",
      serverInstanceId: "server",
      serverBindingGeneration: 1,
      installationGeneration: 1,
      userId: "user",
      actorId: "actor",
      relayTokenId: "relay",
      hostInstallationId: "host",
      desktopSessionId: "session",
      pairingGeneration: "relay",
    })).toBe("conflict");
  });
});
