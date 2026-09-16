import {
  createPostgresJsBridgeConnection,
  getSharedDirectCryptoDb,
} from "@nautilo/db";
import {
  createPostgresAdditionalDeviceComposition,
  resolveAdditionalDevicePersonalAuthorityAnchor,
  verifyCryptoPostgresHandle,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";

import type { ProtectedAdditionalDeviceComposition } from "./protected-additional-device";
import { getServerDirectDb } from "../lib/server-direct-db";

export { resolveAdditionalDevicePersonalAuthorityAnchor };

export function createProductionAdditionalDeviceComposition():
ProtectedAdditionalDeviceComposition {
  let handlePromise: Promise<CryptoPostgresHandle> | null = null;
  let cryptoConnection: ReturnType<
    typeof createPostgresJsBridgeConnection
  > | null = null;
  const cryptoDb = () => {
    cryptoConnection ??= createPostgresJsBridgeConnection(
      getSharedDirectCryptoDb(),
    );
    return cryptoConnection;
  };
  let productConnection: ReturnType<
    typeof createPostgresJsBridgeConnection
  > | null = null;
  const productDb = () => {
    productConnection ??= createPostgresJsBridgeConnection(
      getServerDirectDb(),
    );
    return productConnection;
  };
  const base = createPostgresAdditionalDeviceComposition({
    getHandle: () => {
      handlePromise ??= verifyCryptoPostgresHandle(
        cryptoDb(),
      );
      return handlePromise;
    },
    resolvePersonalAuthorityAnchor: (humanActorId) =>
      resolveAdditionalDevicePersonalAuthorityAnchor(
        productDb(),
        humanActorId,
      ),
  });
  return base;
}
