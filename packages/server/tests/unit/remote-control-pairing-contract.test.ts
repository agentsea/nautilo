import { describe, expect, test } from "bun:test";
import {
  consumeValidatedPairingAtomically,
  decidePairingConsumption,
  type AtomicPairingConsumeInput,
  type AtomicPairingConsumePort,
  type PairingConsumptionRequest,
  type StoredPairingChallenge,
} from "../../src/remote-control/authority-contract";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const PAIRING_GENERATION = "4d6818e9-9354-44f4-90e9-0f809d504cb5";

function challenge(
  overrides: Partial<StoredPairingChallenge> = {},
): StoredPairingChallenge {
  return {
    challengeId: "challenge-row-1",
    challengeVersion: 4,
    serverId: "server-a",
    sessionUserId: "user-1",
    sessionActorId: "actor-1",
    remoteHostId: "remote-host-1",
    hostInstallationId: "host-1",
    relayTokenId: PAIRING_GENERATION,
    desktopSessionId: "desktop-session-1",
    pairingGeneration: PAIRING_GENERATION,
    expiresAtMs: NOW + 60_000,
    consumedAtMs: null,
    revokedAtMs: null,
    ...overrides,
  };
}

function request(
  overrides: Partial<PairingConsumptionRequest> = {},
): PairingConsumptionRequest {
  return {
    verifierMatch: true,
    serverId: "server-a",
    sessionUserId: "user-1",
    sessionActorId: "actor-1",
    mobileInstallationId: "mobile-1",
    mobileInstallationStatus: "active",
    hostInstallationId: "host-1",
    relayTokenId: PAIRING_GENERATION,
    desktopSessionId: "desktop-session-1",
    pairingGeneration: PAIRING_GENERATION,
    hostStatus: "active",
    nowMs: NOW,
    ...overrides,
  };
}

describe("one-time controller pairing consumption", () => {
  test("derives the binding entirely from the stored challenge and verified request context", () => {
    expect(
      decidePairingConsumption(challenge(), request(), {
        controllerBindingId: "controller-binding-1",
        controllerBindingGeneration: 1,
      }),
    ).toEqual({
      ok: true,
      consumeAtMs: NOW,
      challengeId: "challenge-row-1",
      challengeVersion: 4,
      binding: {
        canonicalServerId: "server-a",
        controllerBindingId: "controller-binding-1",
        controllerBindingGeneration: 1,
        remoteHostId: "remote-host-1",
        sessionUserId: "user-1",
        sessionActorId: "actor-1",
        mobileInstallationId: "mobile-1",
        hostInstallationId: "host-1",
        relayTokenId: PAIRING_GENERATION,
        desktopSessionId: "desktop-session-1",
        pairingGeneration: PAIRING_GENERATION,
      },
    });
  });

  test.each([
    ["missing", null, {}, "challenge_missing_or_substituted"],
    [
      "substitution",
      challenge(),
      { verifierMatch: false },
      "challenge_missing_or_substituted",
    ],
    ["expiry", challenge({ expiresAtMs: NOW }), {}, "challenge_expired"],
    ["replay", challenge({ consumedAtMs: NOW - 1 }), {}, "challenge_replayed"],
    ["challenge revoke", challenge({ revokedAtMs: NOW - 1 }), {}, "challenge_revoked"],
    ["wrong server", challenge(), { serverId: "server-b" }, "wrong_server"],
    ["wrong user", challenge(), { sessionUserId: "user-2" }, "wrong_user"],
    ["wrong actor", challenge(), { sessionActorId: "actor-2" }, "wrong_actor"],
    ["wrong host", challenge(), { hostInstallationId: "host-2" }, "wrong_host"],
    [
      "relay enrollment substitution",
      challenge(),
      { relayTokenId: "relay-token-row-2" },
      "wrong_relay_enrollment",
    ],
    [
      "desktop session replacement",
      challenge(),
      { desktopSessionId: "desktop-session-2" },
      "desktop_session_replaced",
    ],
    [
      "pairing generation replacement",
      challenge(),
      { pairingGeneration: "54e7c087-7e2c-4a90-a28a-2ae61fd61a90" },
      "pairing_generation_changed",
    ],
    ["host revoke", challenge(), { hostStatus: "revoked" }, "host_revoked"],
    [
      "mobile reinstall",
      challenge(),
      { mobileInstallationStatus: "reinstalled" },
      "mobile_installation_replaced",
    ],
    [
      "mobile revoke",
      challenge(),
      { mobileInstallationStatus: "revoked" },
      "mobile_installation_revoked",
    ],
  ] as const)(
    "%s fails closed with the same public response",
    (_label, stored, patch, auditReason) => {
      expect(
        decidePairingConsumption(
          stored,
          request(patch as Partial<PairingConsumptionRequest>),
          {
            controllerBindingId: "controller-binding-1",
            controllerBindingGeneration: 1,
          },
        ),
      ).toEqual({
        ok: false,
        publicCode: "pairing_unavailable",
        auditReason,
      });
    },
  );

  test("expiry boundary is exclusive: exact expiry is already invalid", () => {
    expect(
      decidePairingConsumption(
        challenge({ expiresAtMs: NOW }),
        request(),
        {
          controllerBindingId: "controller-binding-1",
          controllerBindingGeneration: 1,
        },
      ),
    ).toMatchObject({ ok: false, auditReason: "challenge_expired" });
  });

  test("atomic consume commits exactly once across concurrent duplicate attempts", async () => {
    const decision = decidePairingConsumption(
      challenge(),
      request(),
      {
        controllerBindingId: "controller-binding-1",
        controllerBindingGeneration: 1,
      },
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    let committedVersion: number | null = null;
    const createdBindings: AtomicPairingConsumeInput["binding"][] = [];
    const port: AtomicPairingConsumePort = {
      async consumeChallengeAndCreateBinding(input) {
        // Yield so both calls contend through the same conditional operation.
        await Promise.resolve();
        if (
          committedVersion !== null ||
          input.expectedConsumedAtMs !== null ||
          input.expectedChallengeVersion !== 4
        ) {
          return "conflict";
        }
        committedVersion = input.expectedChallengeVersion;
        createdBindings.push(input.binding);
        return "committed";
      },
    };

    const outcomes = await Promise.all([
      consumeValidatedPairingAtomically(decision, port),
      consumeValidatedPairingAtomically(decision, port),
    ]);
    expect(outcomes.sort()).toEqual(["committed", "conflict"]);
    expect(createdBindings).toHaveLength(1);
    expect(createdBindings[0]).toMatchObject({
      controllerBindingId: "controller-binding-1",
      remoteHostId: "remote-host-1",
      mobileInstallationId: "mobile-1",
    });
  });
});
