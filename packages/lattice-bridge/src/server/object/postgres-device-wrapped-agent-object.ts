import {
  persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet,
  type LatticeCrypto,
  type ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization,
} from "@nautilo/lattice-crypto";

import {
  readPreparedDeviceWrappedAgentObjectSnapshot,
  type PreparedDeviceWrappedAgentObject,
} from "../../object/device-wrapped-agent-object-crypto.ts";
import {
  PostgresLatticeStorage,
  assertVerifiedCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

class DeviceWrappedAgentObjectAuthorizationStale extends Error {}

/** Persist one prepared object and its authenticated common-v5 access state. */
export async function persistDeviceWrappedAgentObject(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  prepared: PreparedDeviceWrappedAgentObject;
  resolveCurrentAuthorization:
    ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
}>): Promise<"created" | "duplicate" | "stale"> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  const snapshot = readPreparedDeviceWrappedAgentObjectSnapshot(input.prepared);
  try {
    return await withVerifiedCryptoPostgresTransaction(
      input.handle,
      async (handle) => {
        const storage = new PostgresLatticeStorage(handle);
        await storage.putObject(snapshot.object);
        const result = await
          persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet({
            crypto: input.crypto,
            storage,
            prepared: snapshot.access,
            resolveCurrentAuthorization: input.resolveCurrentAuthorization,
          });
        if (result === "stale") {
          throw new DeviceWrappedAgentObjectAuthorizationStale();
        }
        return result === "applied" ? "created" : "duplicate";
      },
    );
  } catch (error) {
    if (error instanceof DeviceWrappedAgentObjectAuthorizationStale) {
      return "stale";
    }
    throw error;
  }
}
