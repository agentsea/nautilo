/** Builds the signed D458 consume payload; no private material crosses this module. */
import {
  canonicalRemotePairingTranscript,
  REMOTE_PAIRING_PROOF_ALGORITHM,
} from "@nautilo/types";
import { loadOrCreateControllerInstallation, type ControllerInstallationDeps } from "./controller-installation";

const toHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function prepareRemotePairingConsumeProof(input: {
  readonly serverId: string;
  readonly challengeId: string;
  readonly ceremonyContext: string;
  readonly deps?: ControllerInstallationDeps;
}): Promise<{
  installationId: string;
  proof: {
    algorithm: typeof REMOTE_PAIRING_PROOF_ALGORITHM;
    ceremonyContext: string;
    publicKey: string;
    signature: string;
  };
}> {
  const installation = await loadOrCreateControllerInstallation(input.serverId, input.deps);
  const publicKey = toHex(installation.publicKey);
  const transcript = canonicalRemotePairingTranscript({
    challengeId: input.challengeId,
    ceremonyContext: input.ceremonyContext,
    installationId: installation.installationId,
    algorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
    publicKey,
  });
  return {
    installationId: installation.installationId,
    proof: {
      algorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
      ceremonyContext: input.ceremonyContext,
      publicKey,
      signature: toHex(installation.sign(new TextEncoder().encode(transcript))),
    },
  };
}
