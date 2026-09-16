import type { NautiloApiClient } from "@nautilo/api-client";
import {
  createElectronInitialDeviceReadinessClient,
  type ElectronSafeStoragePort,
  type LocalInitialDeviceReadinessClient,
} from "@nautilo/lattice-bridge/client/electron";

export async function createElectronEncryptionRecoveryReadinessClient(input: {
  readonly api: NautiloApiClient;
  readonly serverScope: string;
  readonly directory: string;
  readonly safeStorage: ElectronSafeStoragePort;
  readonly installationIdForAccount: (account: Readonly<{
    serverScope: string;
    userId: string;
    humanActorId: string;
  }>) => string;
  readonly createRecoveryInstallationId?: () => string;
  readonly activateRecoveryInstallationId?: (
    installationId: string,
    account: Readonly<{
      serverScope: string;
      userId: string;
      humanActorId: string;
    }>,
  ) => void;
  readonly onRecoveryIdentityActivated?: () => Promise<void> | void;
}): Promise<LocalInitialDeviceReadinessClient | null> {
  const viewer = await input.api.whoami();
  if (viewer.sessionUserId === null || viewer.sessionActorId === null) return null;
  const account = Object.freeze({
    serverScope: input.serverScope,
    userId: viewer.sessionUserId,
    humanActorId: viewer.sessionActorId,
  });
  return createElectronInitialDeviceReadinessClient({
    api: input.api,
    serverScope: input.serverScope,
    directory: input.directory,
    safeStorage: input.safeStorage,
    userId: viewer.sessionUserId,
    humanActorId: viewer.sessionActorId,
    installationId: input.installationIdForAccount(account),
    ...(input.createRecoveryInstallationId === undefined ? {} : {
      createRecoveryInstallationId: input.createRecoveryInstallationId,
    }),
    ...(input.activateRecoveryInstallationId === undefined ? {} : {
      activateRecoveryInstallationId: (installationId: string) =>
        input.activateRecoveryInstallationId!(installationId, account),
    }),
    ...(input.onRecoveryIdentityActivated === undefined ? {} : {
      onRecoveryIdentityActivated: input.onRecoveryIdentityActivated,
    }),
  });
}
