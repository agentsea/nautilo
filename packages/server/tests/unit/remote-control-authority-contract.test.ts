import { describe, expect, test } from "bun:test";
import {
  authorizeRemoteCeremony,
  projectPairingAudit,
  type RemoteCeremonyAuthorityInput,
  type VerifiedRemoteIdentity,
} from "../../src/remote-control/authority-contract";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

function identity(
  overrides: Partial<VerifiedRemoteIdentity> = {},
): VerifiedRemoteIdentity {
  return {
    tokenStatus: "valid",
    serverId: "server-a",
    issuer: "https://identity.example/oidc",
    resource: "https://server-a.example/api",
    clientId: "desktop-native-client",
    sessionUserId: "user-1",
    sessionActorId: "actor-1",
    principalStatus: "active",
    issuedAtMs: NOW - 30_000,
    acquiredBy: "interactive_login",
    ...overrides,
  };
}

function ceremony(
  overrides: Partial<RemoteCeremonyAuthorityInput> = {},
): RemoteCeremonyAuthorityInput {
  return {
    ceremony: "consume_challenge",
    identity: identity(),
    expectedServerId: "server-a",
    expectedIssuer: "https://identity.example/oidc",
    expectedResource: "https://server-a.example/api",
    nowMs: NOW,
    maxTokenAgeMs: 5 * 60_000,
    presenceEvidence: "explicit_pairing_gesture",
    ...overrides,
  };
}

describe("remote controller ceremony identity boundary", () => {
  test("distinct desktop/mobile Logto clients can resolve to the same canonical user", () => {
    const desktop = authorizeRemoteCeremony(
      ceremony({
        ceremony: "create_challenge",
        identity: identity({ clientId: "desktop-native-client" }),
      }),
    );
    const mobile = authorizeRemoteCeremony(
      ceremony({
        identity: identity({
          clientId: "mobile-native-client",
          acquiredBy: "silent_refresh",
        }),
      }),
    );

    expect(desktop).toMatchObject({
      ok: true,
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
    });
    expect(mobile).toMatchObject({
      ok: true,
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
    });
  });

  test.each([
    ["missing token", { tokenStatus: "missing" }, "missing_token"],
    ["invalid token", { tokenStatus: "invalid" }, "invalid_token"],
    ["revoked token", { tokenStatus: "revoked" }, "revoked_token"],
    ["wrong server", { serverId: "server-b" }, "wrong_server"],
    ["wrong issuer", { issuer: "https://attacker.invalid" }, "wrong_issuer"],
    ["wrong resource", { resource: "https://server-b.example/api" }, "wrong_resource"],
    ["unknown principal", { principalStatus: "unknown" }, "unknown_principal"],
    ["disabled principal", { principalStatus: "disabled" }, "disabled_principal"],
    ["revoked principal", { principalStatus: "revoked" }, "revoked_principal"],
  ] as const)("%s fails closed without a distinguishing public response", (_label, patch, reason) => {
    expect(authorizeRemoteCeremony(ceremony({ identity: identity(patch) }))).toEqual({
      ok: false,
      publicCode: "remote_authority_denied",
      auditReason: reason,
    });
  });

  test("a missing canonical user or actor fails as an unknown principal", () => {
    expect(
      authorizeRemoteCeremony(
        ceremony({ identity: identity({ sessionUserId: null, sessionActorId: null }) }),
      ),
    ).toMatchObject({ ok: false, auditReason: "unknown_principal" });
  });

  test("stale and future-issued tokens fail the recent-token ceremony guard", () => {
    for (const issuedAtMs of [NOW - 300_001, NOW + 1]) {
      expect(
        authorizeRemoteCeremony(ceremony({ identity: identity({ issuedAtMs }) })),
      ).toMatchObject({ ok: false, auditReason: "stale_reauthentication" });
    }
  });

  test.each(["silent_refresh", "token_iat", "none"] as const)(
    "%s is not interactive-presence authority",
    (presenceEvidence) => {
      expect(authorizeRemoteCeremony(ceremony({ presenceEvidence }))).toEqual({
        ok: false,
        publicCode: "remote_authority_denied",
        auditReason: "interactive_presence_required",
      });
    },
  );

  test("PIN/prove-it is independent acceptable presence evidence", () => {
    expect(
      authorizeRemoteCeremony(ceremony({ presenceEvidence: "pin_prove_it" })),
    ).toMatchObject({ ok: true });
  });
});

describe("secret-free pairing audit projection", () => {
  test("drops challenge, Logto, and relay secrets while preserving canonical IDs", () => {
    const projected = projectPairingAudit({
      challengeId: "challenge-row-1",
      serverId: "server-a",
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
      hostInstallationId: "host-1",
      mobileInstallationId: "mobile-1",
      outcome: "consumed",
      atMs: NOW,
      verifierHash: "hash-secret",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "id-secret",
      relayToken: "relay-secret",
    });

    expect(projected).toEqual({
      challengeId: "challenge-row-1",
      serverId: "server-a",
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
      hostInstallationId: "host-1",
      mobileInstallationId: "mobile-1",
      outcome: "consumed",
      atMs: NOW,
    });
    expect(JSON.stringify(projected)).not.toMatch(/secret|token/i);
  });

  test("unknown runtime fields cannot cross the explicit allowlist", () => {
    const source = {
      challengeId: "challenge-row-1",
      serverId: "server-a",
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
      hostInstallationId: "host-1",
      outcome: "rejected" as const,
      auditReason: "wrong_user",
      atMs: NOW,
      unexpectedSecret: "must-not-leak",
      nestedRuntimeState: { token: "also-secret" },
    };
    const projected = projectPairingAudit(source);
    expect(projected).toEqual({
      challengeId: "challenge-row-1",
      serverId: "server-a",
      sessionUserId: "user-1",
      sessionActorId: "actor-1",
      hostInstallationId: "host-1",
      outcome: "rejected",
      auditReason: "wrong_user",
      atMs: NOW,
    });
    expect(JSON.stringify(projected)).not.toContain("must-not-leak");
  });
});
