import type { ProtectedMemoryDtoV1 } from "@nautilo/api-client/browser";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import type { AuthorizedHumanMemoryDeviceContentPort } from
  "./authorized-human-memory-client.ts";
import type { ObservedAuthorizedHumanMemoryDeviceContentPort } from
  "./authorized-human-memory-client.ts";
import { AuthorizedHumanMemoryUnavailableError } from
  "./authorized-human-memory-client.ts";
import { prepareHumanMemoryReadAcknowledgementV1 } from
  "../../memory/human-memory-read-acknowledgement.ts";

export type HumanMemoryReadObservationAdmissionV1 = NonNullable<
  ProtectedMemoryDtoV1["readObservationAdmission"]
>;

function tokenBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("Memory read observation token is invalid");
  }
  const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function createObservedHumanMemoryDeviceContent(input: Readonly<{
  crypto: LatticeCrypto;
  content: AuthorizedHumanMemoryDeviceContentPort;
  withSigningAuthority<Result>(dto: ProtectedMemoryDtoV1, use: (authority: Readonly<{
    subjectHumanId: string; readerDeviceId: string;
    readerDeviceSigningKeyGeneration: number; hostAuthorizationRevision: number;
    signingPrivateKey: Uint8Array; signingPublicKey: Uint8Array;
  }>) => Promise<Result>): Promise<Result | null>;
  observe(acknowledgementBytes: Uint8Array): Promise<void>;
}>): ObservedAuthorizedHumanMemoryDeviceContentPort {
  function beginObservationScope() {
    const deliveries: Promise<void>[] = [];

    function schedule(
      dto: ProtectedMemoryDtoV1,
      outcome: "verified" | "failed" | "unavailable",
      unavailableReason?: "client_crypto_unavailable"
        | "current_read_authority_unavailable" | "retained_key_material_unavailable",
    ): void {
      const delivery = (async () => {
        let acknowledgement: Uint8Array | null = null;
        try {
          const admission = dto.readObservationAdmission;
          if (
            admission === undefined
            || dto.protectedPayload.status !== "encrypted"
          ) return;
          const cryptoObjectId = dto.protectedPayload.cryptoObjectId;
          const token = tokenBytes(admission.tokenBase64url);
          try {
            if (token.length !== 32) return;
            acknowledgement = await input.withSigningAuthority(
              dto,
              (authority) => Promise.resolve(prepareHumanMemoryReadAcknowledgementV1(
                input.crypto,
                {
                  formatVersion: 1,
                  purpose: "memory.read_acknowledgement",
                  observationToken: token,
                  policyRevision: admission.policyRevision,
                  subjectHumanId: authority.subjectHumanId,
                  readerDeviceId: authority.readerDeviceId,
                  readerDeviceSigningKeyGeneration:
                    authority.readerDeviceSigningKeyGeneration,
                  hostAuthorizationRevision: authority.hostAuthorizationRevision,
                  memoryId: dto.projection.memoryId,
                  cryptoObjectId,
                  contentRevision: dto.projection.contentRevision,
                  cryptoAccessRevision: dto.projection.cryptoAccessRevision,
                  outcome,
                  reason: outcome === "verified" ? "none"
                    : outcome === "failed" ? "integrity_failure"
                    : unavailableReason!,
                  issuedAt: admission.issuedAt,
                  deadlineAt: admission.expiresAt,
                  signingPrivateKey: authority.signingPrivateKey,
                  signingPublicKey: authority.signingPublicKey,
                },
              )),
            );
          } finally {
            token.fill(0);
          }
          if (acknowledgement !== null) await input.observe(acknowledgement);
        } catch {
          // Observation is subordinate to the authenticated read result.
        } finally {
          acknowledgement?.fill(0);
        }
      })();
      deliveries.push(delivery);
    }

    const content = Object.freeze({
      ...input.content,
      async openExact(dto: ProtectedMemoryDtoV1) {
        try {
          return await input.content.openExact(dto);
        } catch (error) {
          if (error instanceof AuthorizedHumanMemoryUnavailableError) {
            if (error.reason === "integrity_failure" || error.reason === "corrupt") {
              schedule(dto, "failed");
            } else {
              const reason = error.reason === "lost_key_material"
                ? "retained_key_material_unavailable"
                : error.reason === "authorization_required"
                    || error.reason === "incomplete_access_set"
                  ? "current_read_authority_unavailable"
                  : error.reason === "unsupported_version"
                      || error.reason === "encryption_pending"
                      || error.reason === "shadow_pending"
                      || error.reason === "backfill_pending"
                      || error.reason === "target_encryption_not_ready"
                    ? "client_crypto_unavailable"
                    : undefined;
              if (reason !== undefined) schedule(dto, "unavailable", reason);
            }
          }
          throw error;
        }
      },
    });
    let settlement: Promise<void> | undefined;
    return Object.freeze({
      content,
      verified(dto: ProtectedMemoryDtoV1) { schedule(dto, "verified"); },
      failed(dto: ProtectedMemoryDtoV1) { schedule(dto, "failed"); },
      settle() {
        settlement ??= Promise.allSettled(deliveries).then(() => undefined);
        return settlement;
      },
    });
  }

  return Object.freeze({
    ...input.content,
    beginObservationScope,
  });
}
