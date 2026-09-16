import {
  canonicalRemoteOrdinaryRequestBody,
  canonicalRemoteOrdinaryRequestTranscript,
  REMOTE_PAIRING_PROOF_ALGORITHM,
  type RemoteOrdinaryRequestProof,
} from "@nautilo/types";
import * as Crypto from "expo-crypto";
import {
  loadRemoteControllerAuthority,
  type RemoteControllerAuthority,
} from "./controller-authority";
import {
  loadOrCreateControllerInstallation,
  type ControllerInstallation,
} from "./controller-installation";

const toHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

export interface OrdinaryProofDeps {
  readonly loadAuthority: (serverId: string) => Promise<RemoteControllerAuthority | null>;
  readonly loadInstallation: (serverId: string) => Promise<ControllerInstallation>;
  readonly sha256: (canonicalBody: string) => Promise<string>;
  readonly randomUuid: () => string;
  readonly nowMs: () => number;
}

const defaultDeps: OrdinaryProofDeps = {
  loadAuthority: loadRemoteControllerAuthority,
  loadInstallation: loadOrCreateControllerInstallation,
  sha256: (body) => Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    body,
    { encoding: Crypto.CryptoEncoding.HEX },
  ),
  randomUuid: Crypto.randomUUID,
  nowMs: Date.now,
};

/**
 * Signs an ordinary request only when this exact app installation retained a
 * committed pairing authority for the selected server. No host is selected.
 */
export async function prepareRemoteOrdinaryRequestProof(
  input: {
    readonly serverId: string;
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
  },
  deps: OrdinaryProofDeps = defaultDeps,
): Promise<RemoteOrdinaryRequestProof | null> {
  const authority = await deps.loadAuthority(input.serverId);
  if (!authority) return null;
  const installation = await deps.loadInstallation(input.serverId);
  if (installation.installationId !== authority.installationId) return null;

  const unsigned = {
    serverInstanceId: authority.serverInstanceId,
    serverBindingGeneration: authority.serverBindingGeneration,
    controllerInstallationId: authority.controllerInstallationId,
    installationId: authority.installationId,
    installationGeneration: authority.installationGeneration,
    requestId: deps.randomUuid().toLowerCase(),
    issuedAtMs: deps.nowMs(),
    method: input.method.toUpperCase(),
    path: input.path,
    bodySha256: await deps.sha256(canonicalRemoteOrdinaryRequestBody(input.body)),
  };
  const transcript = canonicalRemoteOrdinaryRequestTranscript(unsigned);
  return {
    ...unsigned,
    algorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
    signature: toHex(installation.sign(new TextEncoder().encode(transcript))),
  };
}
