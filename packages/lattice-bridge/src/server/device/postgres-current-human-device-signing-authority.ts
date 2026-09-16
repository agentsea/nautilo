import type {
  PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  and, eq, humanCryptoCustodies, humanCryptoDevices,
} from "@nautilo/db";
import { cryptoTypedDb, executeTypedCryptoQuery, type CryptoPostgresExecutor } from
  "../storage/postgres-lattice-storage.ts";

export interface CurrentHumanDeviceSigningAuthorityCoordinates {
  readonly subjectUserId: string;
  readonly subjectHumanId: string;
  readonly humanActorId: string;
  readonly deviceId: string;
  readonly deviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
}

/**
 * Hold the exact current Human device and custody authority while a product
 * publication callback commits. Device revocation and custody deactivation
 * update these rows, so neither can pass this SHARE lock between signature
 * verification and the product CAS.
 *
 * Lock ordering is deliberately crypto authority first, then product locks in
 * `publish`. The callback must not attempt another crypto authority mutation.
 */
export async function withCurrentHumanDeviceSigningAuthority<Value>(
  restricted: PostgresJsBridgeConnection,
  input: CurrentHumanDeviceSigningAuthorityCoordinates,
  publish: (signingPublicKey: Uint8Array) => Promise<Value>,
): Promise<Value | null> {
  return restricted.transactionOnce(async (transaction) => {
    return withCurrentHumanDeviceSigningAuthorityExecutor(transaction, input, publish);
  }, { isolationLevel: "read committed" });
}

/** Same authority lock within a caller-owned restricted transaction. */
export async function withCurrentHumanDeviceSigningAuthorityExecutor<Value>(
  transaction: CryptoPostgresExecutor,
  input: CurrentHumanDeviceSigningAuthorityCoordinates,
  publish: (signingPublicKey: Uint8Array) => Promise<Value>,
): Promise<Value | null> {
  const rows = await executeTypedCryptoQuery(transaction,
      cryptoTypedDb.select({
        signing_public_key: humanCryptoDevices.signingPublicKey,
      }).from(humanCryptoDevices).innerJoin(
        humanCryptoCustodies,
        eq(humanCryptoCustodies.humanId, humanCryptoDevices.humanId),
      ).where(and(
        eq(humanCryptoDevices.humanId, input.subjectHumanId),
        eq(humanCryptoDevices.userId, input.subjectUserId),
        eq(humanCryptoDevices.humanActorId, input.humanActorId),
        eq(humanCryptoDevices.deviceId, input.deviceId),
        eq(humanCryptoDevices.deviceGeneration,
          input.deviceSigningKeyGeneration),
        eq(humanCryptoDevices.revision, input.hostAuthorizationRevision),
        eq(humanCryptoDevices.state, "active"),
        eq(humanCryptoCustodies.state, "active"),
      )).for("share", {
        of: [humanCryptoDevices, humanCryptoCustodies],
      }),
    );
  const key = rows[0]?.signing_public_key;
  if (rows.length !== 1 || !(key instanceof Uint8Array)) return null;
  const ownedKey = key.slice();
  try {
    return await publish(ownedKey);
  } finally {
    ownedKey.fill(0);
  }
}
