import {
  and,
  eq,
  humanCryptoDevices,
  inArray,
} from "@nautilo/db";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";

/** Resolve the exact historical Human device key named by a signed manifest. */
export function createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(
  handle: CryptoPostgresHandle,
) {
  return async (context: Readonly<{
    subjectHumanId: string;
    committerDeviceId: string;
    hostAuthorizationRevision: number;
  }>): Promise<Uint8Array | null> => {
    const rows = await executeTypedCryptoQuery(
      handle,
      cryptoTypedDb.select({
        human_id: humanCryptoDevices.humanId,
        signing_public_key: humanCryptoDevices.signingPublicKey,
        revision: humanCryptoDevices.revision,
      }).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.deviceId, context.committerDeviceId),
        eq(humanCryptoDevices.humanId, context.subjectHumanId),
        inArray(humanCryptoDevices.state, ["active", "revoked"]),
      )).limit(2),
    );
    const row = rows[0];
    return rows.length === 1
        && row !== undefined
        && row.revision >= context.hostAuthorizationRevision
        && row.signing_public_key instanceof Uint8Array
      ? row.signing_public_key.slice()
      : null;
  };
}
