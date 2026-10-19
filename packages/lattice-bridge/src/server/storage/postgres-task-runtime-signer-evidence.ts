import { eq, humanCryptoDevices } from "@nautilo/db";
import {
  destroyVerifiedTaskRuntimeSignerAuthorization,
  readTaskRuntimeSignerAuthorizationIssuer,
  type LatticeCrypto,
  verifyHistoricalTaskRuntimeSignerAuthorization,
  type VerifiedHistoricalTaskRuntimeSignerAuthorization,
} from "@nautilo/lattice-crypto";

import { ClassifiedDataOperationError } from
  "../../transition/encryption-data-operation-owner.ts";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresExecutor,
} from "./postgres-lattice-storage.ts";
import type { DatabaseRow } from "./postgres-record-codecs.ts";

export interface VerifiedStoredTaskRuntimeSignerEvidenceV1 {
  readonly certificate: VerifiedHistoricalTaskRuntimeSignerAuthorization;
  readonly issuerPublicKey: Uint8Array;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function bytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) {
    throw new ClassifiedDataOperationError(
      "integrity",
      `Task Runtime signer ${field} must be bytes`,
    );
  }
  return Uint8Array.from(value);
}

function text(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new ClassifiedDataOperationError(
      "integrity",
      `Task Runtime signer ${field} must be text`,
    );
  }
  return value;
}

function counter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint"
    || (typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw))
    ? Number(raw)
    : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ClassifiedDataOperationError(
      "integrity",
      `Task Runtime signer ${field} must be a safe counter`,
    );
  }
  return value;
}

/**
 * Authenticates append-only Task Runtime signer evidence with the immutable
 * issuer Device generation and signing key. Revocation after publication does
 * not invalidate retained object history.
 */
export async function loadVerifiedTaskRuntimeSignerEvidenceV1(
  executor: CryptoPostgresExecutor,
  crypto: LatticeCrypto,
  certificateBytes: Uint8Array,
): Promise<VerifiedStoredTaskRuntimeSignerEvidenceV1> {
  let hint: ReturnType<
    typeof readTaskRuntimeSignerAuthorizationIssuer
  >;
  try {
    hint = readTaskRuntimeSignerAuthorizationIssuer(
      crypto,
      certificateBytes,
    );
  } catch (cause) {
    throw new ClassifiedDataOperationError(
      "integrity",
      "Stored Task Runtime signer certificate format is invalid",
      { cause },
    );
  }
  let issuerPublicKey: Uint8Array | undefined;
  let verified: VerifiedHistoricalTaskRuntimeSignerAuthorization | undefined;
  let retained = false;
  try {
    const rows = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        device_id: humanCryptoDevices.deviceId,
        human_id: humanCryptoDevices.humanId,
        device_generation: humanCryptoDevices.deviceGeneration,
        signing_public_key: humanCryptoDevices.signingPublicKey,
        state: humanCryptoDevices.state,
      }).from(humanCryptoDevices).where(eq(
        humanCryptoDevices.deviceId,
        hint.deviceId,
      )).limit(2).for("share"),
    );
    const row = rows[0];
    if (
      rows.length !== 1
      || row === undefined
      || text(row, "device_id") !== hint.deviceId
      || text(row, "human_id") !== hint.humanId
      || counter(row, "device_generation") !== hint.deviceGeneration
      || !["active", "revoked"].includes(text(row, "state"))
    ) {
      throw new ClassifiedDataOperationError(
        "integrity",
        "Stored Task Runtime signer issuer history is unavailable",
      );
    }
    issuerPublicKey = bytes(row, "signing_public_key");
    const keyHash = crypto.hash(issuerPublicKey);
    try {
      if (!equal(keyHash, hint.signingPublicKeyHash)) {
        throw new ClassifiedDataOperationError(
          "integrity",
          "Stored Task Runtime signer issuer key is substituted",
        );
      }
    } finally {
      keyHash.fill(0);
    }
    try {
      verified = verifyHistoricalTaskRuntimeSignerAuthorization(crypto, {
        certificateBytes,
        resolveHistoricalIssuer: context =>
          context.issuer.humanId === hint.humanId
            && context.issuer.deviceId === hint.deviceId
            && context.issuer.deviceGeneration === hint.deviceGeneration
            && context.issuer.serverInstanceId === hint.serverInstanceId
            && context.issuer.lineageGeneration === hint.lineageGeneration
            && context.issuer.epoch === hint.epoch
            && context.issuer.securityRevision === hint.securityRevision
            && equal(context.issuer.headDigest, hint.headDigest)
            && equal(
              context.issuer.signingPublicKeyHash,
              hint.signingPublicKeyHash,
            )
            ? issuerPublicKey! : null,
      });
    } catch (cause) {
      throw new ClassifiedDataOperationError(
        "integrity",
        "Stored Task Runtime signer certificate is invalid",
        { cause },
      );
    }
    retained = true;
    return Object.freeze({ certificate: verified, issuerPublicKey });
  } finally {
    hint.headDigest.fill(0);
    hint.signingPublicKeyHash.fill(0);
    if (!retained) {
      issuerPublicKey?.fill(0);
      if (verified !== undefined) {
        destroyVerifiedTaskRuntimeSignerAuthorization(verified);
      }
    }
  }
}

export function destroyVerifiedStoredTaskRuntimeSignerEvidenceV1(
  value: VerifiedStoredTaskRuntimeSignerEvidenceV1,
): void {
  destroyVerifiedTaskRuntimeSignerAuthorization(value.certificate);
  value.issuerPublicKey.fill(0);
}
