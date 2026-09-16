import { timingSafeEqual } from "node:crypto";
import type {
  ProcessorCredentialClaim,
  ProcessorCredentialClaimPort,
} from "@nautilo/lattice-crypto";

import {
  markBackgroundAuthorizationRunning,
} from "./lifecycle";
import type {
  BackgroundAuthorizationRecord,
  BackgroundAuthorizationRepository,
} from "./repository";

export type ProcessorCredentialClaimErrorReason =
  | "claim_identity_unavailable"
  | "claim_mismatch"
  | "expired"
  | "invalid_claim"
  | "missing";

export class ProcessorCredentialClaimError extends Error {
  constructor(readonly reason: ProcessorCredentialClaimErrorReason) {
    super(reason);
    this.name = "ProcessorCredentialClaimError";
  }
}

function fail(reason: ProcessorCredentialClaimErrorReason): never {
  throw new ProcessorCredentialClaimError(reason);
}

function exactDigest(actual: unknown, expectedHex: string | null): boolean {
  if (
    !(actual instanceof Uint8Array)
    || actual.length !== 32
    || expectedHex === null
    || !/^[0-9a-f]{64}$/.test(expectedHex)
  ) {
    return false;
  }
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
}

function validClaimShape(claim: ProcessorCredentialClaim): boolean {
  return claim.signal instanceof AbortSignal
    && Number.isSafeInteger(claim.claimedAt)
    && claim.claimedAt >= 0
    && Number.isSafeInteger(claim.recipientGeneration)
    && claim.recipientGeneration >= 0
    && typeof claim.requestId === "string"
    && claim.requestId.length > 0
    && typeof claim.claimId === "string"
    && claim.claimId.length > 0
    && typeof claim.credentialId === "string"
    && claim.credentialId.length > 0
    && typeof claim.idempotencyId === "string"
    && claim.idempotencyId.length > 0;
}

function assertExactDurableClaim(
  record: BackgroundAuthorizationRecord,
  claim: ProcessorCredentialClaim,
): void {
  const snapshot = record.snapshot;
  const material = record.acceptedMaterial;
  const accepted = snapshot.acceptedResponse;
  if (
    snapshot.requestId !== claim.requestId
    || snapshot.claimId !== claim.claimId
    || snapshot.recipientGeneration !== claim.recipientGeneration
    || record.idempotencyKey !== claim.idempotencyId
    || material === null
    || material.credentialId !== claim.credentialId
    || accepted === null
    || !exactDigest(claim.credentialHash, accepted.credentialDigest)
    || !exactDigest(claim.workDescriptorHash, snapshot.descriptorDigest)
  ) {
    fail("claim_mismatch");
  }
}

function assertUnexpiredAtClaim(
  record: BackgroundAuthorizationRecord,
  claimedAt: number,
): void {
  const snapshot = record.snapshot;
  if (
    snapshot.recipient === null
    || snapshot.claimExpiresAt === null
    || record.acceptedMaterial === null
    || claimedAt >= snapshot.recipient.expiresAt
    || claimedAt >= snapshot.claimExpiresAt
    || claimedAt >= record.acceptedMaterial.authorizationExpiresAt
  ) {
    fail("expired");
  }
}

function assertExactReplay(
  record: BackgroundAuthorizationRecord | null,
  claim: ProcessorCredentialClaim,
): void {
  if (record === null) fail("missing");
  if (record.snapshot.state !== "running") {
    /*
     * Reconciliation and completion deliberately clear claimId. Returning
     * `already_claimed` there would turn a merely similar credential into an
     * alleged exact replay. The coordinator owns those restart states and
     * must reconcile rather than re-enter the crypto gate.
     */
    fail("claim_identity_unavailable");
  }
  assertExactDurableClaim(record, claim);
  assertUnexpiredAtClaim(record, claim.claimedAt);
}

/**
 * Durable single-use bridge from the crypto gate to the background request
 * lifecycle. `claimed` is returned only after the request's claimed→running
 * CAS commits. Every other state either proves an exact running replay or
 * fails closed.
 */
export class BackgroundAuthorizationProcessorCredentialClaimPort
  implements ProcessorCredentialClaimPort {
  constructor(
    private readonly repository: BackgroundAuthorizationRepository,
  ) {}

  async claimExactCredential(
    claim: ProcessorCredentialClaim,
  ): Promise<"claimed" | "already_claimed"> {
    if (!validClaimShape(claim)) fail("invalid_claim");
    claim.signal.throwIfAborted();

    const current = await this.repository.get(claim.requestId);
    claim.signal.throwIfAborted();
    if (current === null) fail("missing");
    if (current.snapshot.state === "running") {
      assertExactReplay(current, claim);
      return "already_claimed";
    }
    if (current.snapshot.state !== "claimed") {
      fail("claim_identity_unavailable");
    }
    assertExactDurableClaim(current, claim);
    assertUnexpiredAtClaim(current, claim.claimedAt);

    const next: BackgroundAuthorizationRecord = {
      ...current,
      snapshot: markBackgroundAuthorizationRunning(
        current.snapshot,
        claim.claimedAt,
      ),
    };
    claim.signal.throwIfAborted();
    const stored = await this.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next,
    });
    claim.signal.throwIfAborted();
    if (stored.status === "updated") return "claimed";

    assertExactReplay(stored.current, claim);
    return "already_claimed";
  }
}
