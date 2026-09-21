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
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
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
  const authenticatedHuman = isAuthenticatedHumanViewer(auth.viewer);
  // This is local custody, not admission. A failed same-account whoami refresh
  // must not discard the device or manufacture an unsupported-client result.
  // The admission gate separately proves current server authority. Missing or
  // changed account coordinates still clear/rebuild this exact local client.
  const client = useMemo<
    WorkbenchEncryptionRecoveryReadinessPort | undefined
  >(() => {
    const userId = auth.viewer.sessionUserId;
    const humanActorId = auth.viewer.sessionActorId;
    if (
      !authenticatedHuman
      || userId === null
      || humanActorId === null
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
      userId,
      humanActorId,
    };
    const installationId = readOrCreateBrowserCryptoInstallationId(
      cryptoAccount,
    );
    if (installationId === null) return undefined;
    const local = createBrowserInitialDeviceReadinessClient({
      api: apiClient,
      serverScope: window.location.origin,
      userId,
      humanActorId,
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
    authenticatedHuman,
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
