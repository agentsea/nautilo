import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  createBrowserInitialDeviceReadinessClient,
} from "@nautilo/lattice-bridge/client/browser";
import {
  deviceAdmissionChallengeFromDto,
  deviceAdmissionProofToDto,
} from "@nautilo/lattice-bridge";
import type { DeviceAdmissionChallengeDto } from
  "@nautilo/api-client/browser";

import { useAuth } from "../hooks/use-auth";
import { apiClient } from "../lib/api";
import {
  activateFreshBrowserCryptoInstallationId,
  readOrCreateBrowserCryptoInstallationId,
} from "../lib/browser-crypto-installation";
import { desktopAPI, isDesktop } from "../lib/desktop";
import {
  createDesktopEncryptionRecoveryReadinessPort,
  registerWorkbenchEncryptionRecoveryReadiness,
  type WorkbenchEncryptionRecoveryReadinessPort,
} from "../lib/encryption-recovery-readiness";

const EncryptionReadinessContext = createContext<
  WorkbenchEncryptionRecoveryReadinessPort | undefined
>(undefined);

export function EncryptionReadinessProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const auth = useAuth();
  // This is local custody, not admission. A failed same-account whoami refresh
  // must not discard the device or manufacture an unsupported-client result.
  // The admission gate separately proves current server authority. Missing or
  // changed account coordinates still clear/rebuild this exact local client.
  const client = useMemo<
    WorkbenchEncryptionRecoveryReadinessPort | undefined
  >(() => {
    if (
      !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null
    ) return undefined;
    if (isDesktop) {
      const main = desktopAPI?.encryptionRecovery;
      return main === undefined
        ? undefined
        : createDesktopEncryptionRecoveryReadinessPort(main);
    }
    if (typeof window === "undefined") return undefined;
    const cryptoAccount = {
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    };
    const installationId = readOrCreateBrowserCryptoInstallationId(
      cryptoAccount,
    );
    if (installationId === null) return undefined;
    const local = createBrowserInitialDeviceReadinessClient({
      api: apiClient,
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
      installationId,
      createRecoveryInstallationId: () => crypto.randomUUID(),
      activateRecoveryInstallationId: (nextInstallationId) => {
        if (!activateFreshBrowserCryptoInstallationId(
          nextInstallationId,
          cryptoAccount,
        )) {
          throw new Error("Fresh Browser crypto identity could not be saved");
        }
      },
      onRecoveryIdentityActivated: () => window.location.reload(),
    });
    return Object.freeze({
      ...local,
      async deviceAdmissionDeviceId() {
        return await local.deviceAdmissionDeviceId?.() ?? null;
      },
      async signDeviceAdmissionChallenge(
        challenge: DeviceAdmissionChallengeDto,
      ) {
        if (local.signDeviceAdmissionChallenge === undefined) {
          throw new Error("Device admission signing is unavailable");
        }
        const proof = await local.signDeviceAdmissionChallenge(
          deviceAdmissionChallengeFromDto(challenge),
        );
        return deviceAdmissionProofToDto(proof);
      },
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
  ]);

  useEffect(() => {
    if (client === undefined) return undefined;
    return registerWorkbenchEncryptionRecoveryReadiness(client);
  }, [client]);

  return (
    <EncryptionReadinessContext.Provider value={client}>
      {children}
    </EncryptionReadinessContext.Provider>
  );
}

export function useEncryptionReadinessClient():
WorkbenchEncryptionRecoveryReadinessPort | undefined {
  return useContext(EncryptionReadinessContext);
}
