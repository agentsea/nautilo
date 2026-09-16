/**
 * Ed25519 proof-of-possession verification for remote-controller pairing.
 *
 * QR/manual secrets prove possession of a short-lived ceremony invitation.
 * This module additionally proves that the mobile installation owns the
 * public key it asks the server to bind before any durable mutation occurs.
 */
import { createHash, createHmac, timingSafeEqual, verify } from "node:crypto";
import {
  canonicalRemotePairingTranscript,
  isLowercaseHex,
  REMOTE_PAIRING_PROOF_ALGORITHM,
} from "@nautilo/types";

const CONTEXT_DOMAIN = "nautilo.remote-pairing.ceremony-context.v1";
// RFC 8410 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface PersistedPairingCeremonyTuple {
  readonly id: string;
  readonly version: number;
  readonly serverInstanceId: string;
  readonly serverBindingGeneration: number;
  readonly userId: string;
  readonly actorId: string;
  readonly relayTokenId: string;
  readonly hostInstallationId: string;
  readonly desktopSessionId: string;
  readonly pairingGeneration: string;
}

export interface RemoteControllerProof {
  readonly algorithm: typeof REMOTE_PAIRING_PROOF_ALGORITHM;
  readonly ceremonyContext: string;
  readonly publicKey: string;
  readonly signature: string;
}

/**
 * Server-authored, challenge-bound context sent to the phone. It is not a
 * bearer credential: the final pairing operation still needs the one-time
 * verifier and an Ed25519 signature over this exact context.
 */
export function derivePairingCeremonyContext(
  pepper: string,
  challenge: PersistedPairingCeremonyTuple,
): string {
  return createHmac("sha256", pepper)
    .update(`${CONTEXT_DOMAIN}\0`, "utf8")
    .update(
      JSON.stringify([
        challenge.id,
        challenge.version,
        challenge.serverInstanceId,
        challenge.serverBindingGeneration,
        challenge.userId,
        challenge.actorId,
        challenge.relayTokenId,
        challenge.hostInstallationId,
        challenge.desktopSessionId,
        challenge.pairingGeneration,
      ]),
      "utf8",
    )
    .digest("hex");
}

function ceremonyContextMatches(expected: string, received: string): boolean {
  if (!isLowercaseHex(expected, 32) || !isLowercaseHex(received, 32)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

/** Returns null unless encoding, context and Ed25519 proof all verify. */
export function verifyRemoteControllerProof(input: {
  readonly pepper: string;
  readonly challenge: PersistedPairingCeremonyTuple;
  readonly installationId: string;
  readonly proof: RemoteControllerProof;
}): { fingerprint: string } | null {
  const { proof } = input;
  if (
    proof.algorithm !== REMOTE_PAIRING_PROOF_ALGORITHM ||
    !isLowercaseHex(proof.ceremonyContext, 32) ||
    !isLowercaseHex(proof.publicKey, 32) ||
    !isLowercaseHex(proof.signature, 64)
  ) {
    return null;
  }
  const expectedContext = derivePairingCeremonyContext(input.pepper, input.challenge);
  if (!ceremonyContextMatches(expectedContext, proof.ceremonyContext)) return null;
  let transcript: string;
  try {
    transcript = canonicalRemotePairingTranscript({
      challengeId: input.challenge.id,
      ceremonyContext: proof.ceremonyContext,
      installationId: input.installationId,
      algorithm: proof.algorithm,
      publicKey: proof.publicKey,
    });
  } catch {
    return null;
  }
  try {
    const publicKey = Buffer.from(proof.publicKey, "hex");
    const signature = Buffer.from(proof.signature, "hex");
    const valid = verify(
      null,
      Buffer.from(transcript, "utf8"),
      { key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: "der", type: "spki" },
      signature,
    );
    if (!valid) return null;
    return { fingerprint: createHash("sha256").update(publicKey).digest("hex") };
  } catch {
    // Invalid Ed25519 encodings must be a generic ceremony denial, never an
    // attacker-controlled route exception or persistence opportunity.
    return null;
  }
}
