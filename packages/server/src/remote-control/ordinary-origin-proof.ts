import { verify } from "node:crypto";
import {
  canonicalRemoteOrdinaryRequestTranscript,
  isLowercaseHex,
  REMOTE_PAIRING_PROOF_ALGORITHM,
  type RemoteOrdinaryRequestProof,
  type VerifiedPairedMobileOrigin,
} from "@nautilo/types";
export type { RemoteOrdinaryRequestProof } from "@nautilo/types";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface StoredControllerOrigin {
  readonly controllerInstallationId: string;
  readonly installationId: string;
  readonly installationGeneration: number;
  readonly serverInstanceId: string;
  readonly serverBindingGeneration: number;
  readonly userId: string;
  readonly actorId: string;
  readonly proofKeyAlgorithm: typeof REMOTE_PAIRING_PROOF_ALGORITHM;
  readonly proofKey: string;
  readonly revokedAt: Date | null;
}

export type VerifiedMobileOrdinaryOrigin = VerifiedPairedMobileOrigin;

/**
 * Verifies origin only. The caller still owns one-use request admission and
 * must require at least one current active binding before host Tool discovery.
 */
export function verifyMobileOrdinaryOrigin(input: {
  readonly stored: StoredControllerOrigin | null;
  readonly sessionUserId: string;
  readonly sessionActorId: string;
  readonly serverInstanceId: string;
  readonly serverBindingGeneration: number;
  readonly method: string;
  readonly path: string;
  readonly bodySha256: string;
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly maxFutureSkewMs: number;
  readonly proof: RemoteOrdinaryRequestProof;
}): VerifiedMobileOrdinaryOrigin | null {
  const { stored, proof } = input;
  if (!stored || stored.revokedAt !== null) return null;
  if (
    stored.userId !== input.sessionUserId ||
    stored.actorId !== input.sessionActorId ||
    stored.serverInstanceId !== input.serverInstanceId ||
    stored.serverBindingGeneration !== input.serverBindingGeneration ||
    stored.controllerInstallationId !== proof.controllerInstallationId ||
    stored.installationId !== proof.installationId ||
    stored.installationGeneration !== proof.installationGeneration ||
    proof.serverInstanceId !== input.serverInstanceId ||
    proof.serverBindingGeneration !== input.serverBindingGeneration ||
    proof.method !== input.method ||
    proof.path !== input.path ||
    proof.bodySha256 !== input.bodySha256 ||
    proof.algorithm !== REMOTE_PAIRING_PROOF_ALGORITHM ||
    stored.proofKeyAlgorithm !== REMOTE_PAIRING_PROOF_ALGORITHM ||
    !isLowercaseHex(stored.proofKey, 32) ||
    !isLowercaseHex(proof.signature, 64) ||
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isSafeInteger(input.maxAgeMs) ||
    !Number.isSafeInteger(input.maxFutureSkewMs) ||
    proof.issuedAtMs > input.nowMs + input.maxFutureSkewMs ||
    input.nowMs - proof.issuedAtMs > input.maxAgeMs
  ) {
    return null;
  }

  let transcript: string;
  try {
    transcript = canonicalRemoteOrdinaryRequestTranscript(proof);
  } catch {
    return null;
  }
  try {
    const valid = verify(
      null,
      Buffer.from(transcript, "utf8"),
      {
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(stored.proofKey, "hex")]),
        format: "der",
        type: "spki",
      },
      Buffer.from(proof.signature, "hex"),
    );
    return valid
      ? {
          kind: "paired_mobile",
          serverInstanceId: stored.serverInstanceId,
          serverBindingGeneration: stored.serverBindingGeneration,
          userId: stored.userId,
          actorId: stored.actorId,
          controllerInstallationId: stored.controllerInstallationId,
          installationGeneration: stored.installationGeneration,
          requestId: proof.requestId,
        }
      : null;
  } catch {
    return null;
  }
}
