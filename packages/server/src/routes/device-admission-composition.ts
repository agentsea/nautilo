import {
  createPostgresJsBridgeConnection,
  getSharedDirectCryptoDb,
} from "@nautilo/db";
import {
  PostgresDeviceAdmissionRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";

import type { DeviceAdmissionComposition } from "./device-admission";

export function createProductionDeviceAdmissionComposition():
DeviceAdmissionComposition {
  let connection: ReturnType<typeof createPostgresJsBridgeConnection> | null =
    null;
  let handlePromise: Promise<CryptoPostgresHandle> | null = null;
  const repository = async () => {
    connection ??= createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
    handlePromise ??= verifyCryptoPostgresHandle(connection);
    return new PostgresDeviceAdmissionRepository(await handlePromise);
  };
  const composition: DeviceAdmissionComposition = {
    async issueChallenge(input) {
      return (await repository()).issueChallenge({
        ...input.authority,
        deviceId: input.deviceId,
        now: input.now,
      });
    },
    async admit(input) {
      return (await repository()).admit({
        ...input.authority,
        proof: input.proof,
        now: input.now,
      });
    },
    async status(input) {
      return (await repository()).status({
        ...input.authority,
        now: input.now,
      });
    },
    async currentAuthorityForDelegation(input) {
      return (await repository()).currentAuthorityForDelegation(input);
    },
  };
  return Object.freeze(composition);
}
