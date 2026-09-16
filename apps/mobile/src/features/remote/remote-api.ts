import {
  ApiError,
  type ConsumeRemotePairingChallengeResponse,
  type NautiloApiClient,
} from "@nautilo/api-client/browser";

import { ensureValidToken } from "@/lib/auth";
import { emitAuthDead } from "@/lib/auth-events";
import { getApiClient } from "@/lib/api";
import { prepareRemotePairingConsumeProof } from "./controller-proof";
import { getControllerDeviceLabel } from "./controller-device-label-runtime";
import { retainRemoteControllerAuthority } from "./controller-authority";
import {
  consumeRemoteManualPairingWithDeps,
  consumeRemoteQrPairingWithDeps,
} from "./remote-pairing";
import {
  runSameServerRemoteRequest as runSameServerRemoteRequestWithDeps,
  type RemoteServerTarget,
  type SameServerRequestDeps,
} from "./remote-request";

export type { RemoteServerTarget } from "./remote-request";

const defaultRequestDeps: SameServerRequestDeps = {
  getClient: getApiClient,
  refreshToken: ensureValidToken,
  authDead: emitAuthDead,
};

/**
 * Retry one stale bearer only against the exact server originally selected.
 * The target is immutable for the entire operation; this helper never reads
 * or changes the active-server registry.
 */
export async function runSameServerRemoteRequest<T>(
  target: RemoteServerTarget,
  operation: (client: NautiloApiClient) => Promise<T>,
  deps: SameServerRequestDeps = defaultRequestDeps,
): Promise<T> {
  return runSameServerRemoteRequestWithDeps(target, operation, deps);
}

export async function consumeRemoteQrPairing(
  target: RemoteServerTarget,
  input: {
    challengeId: string;
    secret: string;
    ceremonyContext: string;
  },
): Promise<ConsumeRemotePairingChallengeResponse> {
  return consumeRemoteQrPairingWithDeps(target, input, {
    request: runSameServerRemoteRequest,
    prepareProof: prepareRemotePairingConsumeProof,
    retainAuthority: retainRemoteControllerAuthority,
    getControllerLabel: getControllerDeviceLabel,
  });
}

export async function consumeRemoteManualPairing(
  target: RemoteServerTarget,
  manualCode: string,
): Promise<ConsumeRemotePairingChallengeResponse> {
  return consumeRemoteManualPairingWithDeps(target, manualCode, {
    request: runSameServerRemoteRequest,
    prepareProof: prepareRemotePairingConsumeProof,
    retainAuthority: retainRemoteControllerAuthority,
    getControllerLabel: getControllerDeviceLabel,
  });
}

export function remoteErrorMessage(error: unknown, serverName: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session expired. Sign in to this server again, then retry.";
    }
    if (error.status === 403) {
      return `This pairing code is no longer available. Generate a new code on ${serverName}, then try again.`;
    }
  }
  return error instanceof Error && /network|fetch|timeout/i.test(error.message)
    ? `Couldn’t reach ${serverName}. Check the connection and try again.`
    : `Couldn’t complete the request on ${serverName}. Please try again.`;
}
