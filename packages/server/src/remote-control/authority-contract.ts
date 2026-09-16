/**
 * D458 Wave 7.0 authority contracts.
 *
 * These helpers deliberately contain no persistence, routing, JWT parsing, or
 * relay wiring. They describe the decisions those later seams must make after
 * the existing Logto verifier and canonical principal resolver have run.
 */

export type RemoteCeremony = "create_challenge" | "consume_challenge" | "revoke_binding";

export type RemoteIdentityRejection =
  | "missing_token"
  | "invalid_token"
  | "revoked_token"
  | "wrong_server"
  | "wrong_issuer"
  | "wrong_resource"
  | "unknown_principal"
  | "disabled_principal"
  | "revoked_principal"
  | "stale_reauthentication"
  | "interactive_presence_required";

export interface VerifiedRemoteIdentity {
  tokenStatus: "valid" | "missing" | "invalid" | "revoked";
  serverId: string;
  issuer: string;
  resource: string;
  /** Informational only. Desktop and mobile Native PKCE clients may differ. */
  clientId: string;
  sessionUserId: string | null;
  sessionActorId: string | null;
  principalStatus: "active" | "unknown" | "disabled" | "revoked";
  issuedAtMs: number;
  acquiredBy: "interactive_login" | "silent_refresh" | "unknown";
}

export interface RemoteCeremonyAuthorityInput {
  ceremony: RemoteCeremony;
  identity: VerifiedRemoteIdentity;
  expectedServerId: string;
  expectedIssuer: string;
  expectedResource: string;
  nowMs: number;
  maxTokenAgeMs: number;
  /**
   * Independent user action or PIN/prove-it result. A token's iat and silent
   * refresh are never accepted as this evidence.
   */
  presenceEvidence:
    | "explicit_pairing_gesture"
    | "pin_prove_it"
    | "token_iat"
    | "silent_refresh"
    | "none";
}

export type RemoteCeremonyAuthorityDecision =
  | {
      ok: true;
      sessionUserId: string;
      sessionActorId: string;
      serverId: string;
      ceremony: RemoteCeremony;
    }
  | {
      ok: false;
      /** Deliberately non-enumerating response for all identity failures. */
      publicCode: "remote_authority_denied";
      auditReason: RemoteIdentityRejection;
    };

export function authorizeRemoteCeremony(
  input: RemoteCeremonyAuthorityInput,
): RemoteCeremonyAuthorityDecision {
  const { identity } = input;
  if (identity.tokenStatus !== "valid") {
    const reasons = {
      missing: "missing_token",
      invalid: "invalid_token",
      revoked: "revoked_token",
    } as const;
    return deny(reasons[identity.tokenStatus]);
  }
  if (identity.serverId !== input.expectedServerId) return deny("wrong_server");
  if (identity.issuer !== input.expectedIssuer) return deny("wrong_issuer");
  if (identity.resource !== input.expectedResource) return deny("wrong_resource");
  if (
    identity.principalStatus === "unknown" ||
    !identity.sessionUserId ||
    !identity.sessionActorId
  ) {
    return deny("unknown_principal");
  }
  if (identity.principalStatus === "disabled") return deny("disabled_principal");
  if (identity.principalStatus === "revoked") return deny("revoked_principal");
  if (
    !Number.isFinite(identity.issuedAtMs) ||
    identity.issuedAtMs > input.nowMs ||
    input.nowMs - identity.issuedAtMs > input.maxTokenAgeMs
  ) {
    return deny("stale_reauthentication");
  }
  if (
    input.presenceEvidence !== "explicit_pairing_gesture" &&
    input.presenceEvidence !== "pin_prove_it"
  ) {
    return deny("interactive_presence_required");
  }

  return {
    ok: true,
    sessionUserId: identity.sessionUserId,
    sessionActorId: identity.sessionActorId,
    serverId: input.expectedServerId,
    ceremony: input.ceremony,
  };
}

function deny(auditReason: RemoteIdentityRejection): RemoteCeremonyAuthorityDecision {
  return { ok: false, publicCode: "remote_authority_denied", auditReason };
}

export interface StoredPairingChallenge {
  challengeId: string;
  challengeVersion: number;
  serverId: string;
  sessionUserId: string;
  sessionActorId: string;
  remoteHostId: string;
  hostInstallationId: string;
  relayTokenId: string;
  desktopSessionId: string;
  /** Server-validated relay_tokens row UUID; changes only on explicit re-pair. */
  pairingGeneration: string;
  expiresAtMs: number;
  consumedAtMs: number | null;
  revokedAtMs: number | null;
}

export interface PairingConsumptionRequest {
  /**
   * Result from the future cryptographic verifier adapter. This contract does
   * not compare verifier material or claim timing guarantees.
   */
  verifierMatch: boolean;
  serverId: string;
  sessionUserId: string;
  sessionActorId: string;
  mobileInstallationId: string;
  mobileInstallationStatus: "active" | "reinstalled" | "revoked";
  hostInstallationId: string;
  relayTokenId: string;
  desktopSessionId: string;
  pairingGeneration: string;
  hostStatus: "active" | "revoked";
  nowMs: number;
}

export interface ServerMintedPairingIdentity {
  controllerBindingId: string;
  controllerBindingGeneration: number;
}

export type PairingRejection =
  | "challenge_missing_or_substituted"
  | "challenge_expired"
  | "challenge_replayed"
  | "challenge_revoked"
  | "wrong_server"
  | "wrong_user"
  | "wrong_actor"
  | "wrong_host"
  | "wrong_relay_enrollment"
  | "desktop_session_replaced"
  | "pairing_generation_changed"
  | "host_revoked"
  | "mobile_installation_replaced"
  | "mobile_installation_revoked";

export type PairingConsumptionDecision =
  | {
      ok: true;
      consumeAtMs: number;
      challengeId: string;
      challengeVersion: number;
      binding: {
        canonicalServerId: string;
        controllerBindingId: string;
        controllerBindingGeneration: number;
        remoteHostId: string;
        sessionUserId: string;
        sessionActorId: string;
        mobileInstallationId: string;
        hostInstallationId: string;
        relayTokenId: string;
        desktopSessionId: string;
        pairingGeneration: string;
      };
    }
  | {
      ok: false;
      /** Same response prevents challenge/host/user enumeration. */
      publicCode: "pairing_unavailable";
      auditReason: PairingRejection;
    };

export function decidePairingConsumption(
  challenge: StoredPairingChallenge | null,
  request: PairingConsumptionRequest,
  minted: ServerMintedPairingIdentity,
): PairingConsumptionDecision {
  if (!challenge || !request.verifierMatch) {
    return rejectPairing("challenge_missing_or_substituted");
  }
  if (challenge.consumedAtMs !== null) return rejectPairing("challenge_replayed");
  if (challenge.revokedAtMs !== null) return rejectPairing("challenge_revoked");
  if (request.nowMs >= challenge.expiresAtMs) return rejectPairing("challenge_expired");
  if (challenge.serverId !== request.serverId) return rejectPairing("wrong_server");
  if (challenge.sessionUserId !== request.sessionUserId) return rejectPairing("wrong_user");
  if (challenge.sessionActorId !== request.sessionActorId) return rejectPairing("wrong_actor");
  if (challenge.hostInstallationId !== request.hostInstallationId) {
    return rejectPairing("wrong_host");
  }
  if (challenge.relayTokenId !== request.relayTokenId) {
    return rejectPairing("wrong_relay_enrollment");
  }
  if (challenge.desktopSessionId !== request.desktopSessionId) {
    return rejectPairing("desktop_session_replaced");
  }
  if (challenge.pairingGeneration !== request.pairingGeneration) {
    return rejectPairing("pairing_generation_changed");
  }
  if (request.hostStatus === "revoked") return rejectPairing("host_revoked");
  if (request.mobileInstallationStatus === "reinstalled") {
    return rejectPairing("mobile_installation_replaced");
  }
  if (request.mobileInstallationStatus === "revoked") {
    return rejectPairing("mobile_installation_revoked");
  }

  return {
    ok: true,
    consumeAtMs: request.nowMs,
    challengeId: challenge.challengeId,
    challengeVersion: challenge.challengeVersion,
    binding: {
      canonicalServerId: challenge.serverId,
      controllerBindingId: minted.controllerBindingId,
      controllerBindingGeneration: minted.controllerBindingGeneration,
      remoteHostId: challenge.remoteHostId,
      sessionUserId: challenge.sessionUserId,
      sessionActorId: challenge.sessionActorId,
      mobileInstallationId: request.mobileInstallationId,
      hostInstallationId: challenge.hostInstallationId,
      relayTokenId: challenge.relayTokenId,
      desktopSessionId: challenge.desktopSessionId,
      pairingGeneration: challenge.pairingGeneration,
    },
  };
}

function rejectPairing(auditReason: PairingRejection): PairingConsumptionDecision {
  return { ok: false, publicCode: "pairing_unavailable", auditReason };
}

export interface AtomicPairingConsumeInput {
  challengeId: string;
  expectedChallengeVersion: number;
  expectedConsumedAtMs: null;
  consumeAtMs: number;
  binding: Extract<PairingConsumptionDecision, { ok: true }>["binding"];
}

export interface AtomicPairingConsumePort {
  /**
   * The adapter must conditionally consume the exact unconsumed challenge
   * version and create the controller binding in one transaction.
   */
  consumeChallengeAndCreateBinding(
    input: AtomicPairingConsumeInput,
  ): Promise<"committed" | "conflict">;
}

export async function consumeValidatedPairingAtomically(
  decision: Extract<PairingConsumptionDecision, { ok: true }>,
  port: AtomicPairingConsumePort,
): Promise<"committed" | "conflict"> {
  return port.consumeChallengeAndCreateBinding({
    challengeId: decision.challengeId,
    expectedChallengeVersion: decision.challengeVersion,
    expectedConsumedAtMs: null,
    consumeAtMs: decision.consumeAtMs,
    binding: decision.binding,
  });
}

export interface PairingAuditSource {
  challengeId: string;
  serverId: string;
  sessionUserId: string;
  sessionActorId: string;
  hostInstallationId: string;
  mobileInstallationId?: string;
  outcome: "created" | "consumed" | "rejected" | "revoked";
  auditReason?: string;
  atMs: number;
  verifierHash?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  relayToken?: string;
}

export interface RedactedPairingAudit {
  challengeId: string;
  serverId: string;
  sessionUserId: string;
  sessionActorId: string;
  hostInstallationId: string;
  mobileInstallationId?: string;
  outcome: "created" | "consumed" | "rejected" | "revoked";
  auditReason?: string;
  atMs: number;
}

export function projectPairingAudit(source: PairingAuditSource): RedactedPairingAudit {
  const projected: RedactedPairingAudit = {
    challengeId: source.challengeId,
    serverId: source.serverId,
    sessionUserId: source.sessionUserId,
    sessionActorId: source.sessionActorId,
    hostInstallationId: source.hostInstallationId,
    outcome: source.outcome,
    atMs: source.atMs,
  };
  if (source.mobileInstallationId !== undefined) {
    projected.mobileInstallationId = source.mobileInstallationId;
  }
  if (source.auditReason !== undefined) projected.auditReason = source.auditReason;
  return projected;
}
