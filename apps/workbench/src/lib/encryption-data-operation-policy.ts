import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";

import {
  assertCryptoAdmissionAccess,
  getCryptoAdmissionSnapshot,
} from "./crypto-admission-access";

/**
 * The Workbench trusted composition seam. The opaque token is the existing
 * admission generation; it is deliberately not presented as a server policy
 * revision and never crosses a transport boundary.
 */
export function createWorkbenchDataOperationOwner(): EncryptionDataOperationOwner {
  return bindEncryptionDataOperationOwner({
    policy: {
      resolve() {
        assertCryptoAdmissionAccess();
        const snapshot = getCryptoAdmissionSnapshot();
        if (snapshot.status !== "open" || snapshot.policy === null) {
          throw new ClassifiedDataOperationError(
            "authority",
            "Current encryption access policy is unavailable",
          );
        }
        return Promise.resolve(Object.freeze({
          policy: snapshot.policy,
          revalidationToken: snapshot.generation,
        }));
      },
      revalidate(revalidationToken) {
        assertCryptoAdmissionAccess(revalidationToken);
        const snapshot = getCryptoAdmissionSnapshot();
        if (snapshot.status !== "open" || snapshot.policy === null) {
          throw new ClassifiedDataOperationError(
            "authority",
            "Current encryption access policy is unavailable",
          );
        }
        return Promise.resolve();
      },
    },
  });
}
