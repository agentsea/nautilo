import type {
  ConsumeRemotePairingChallengeResponse,
  NautiloApiClient,
} from "@nautilo/api-client/browser";

import type { RemoteServerTarget } from "./remote-request";

export interface RemotePairingProof {
  readonly installationId: string;
  readonly proof: {
    readonly algorithm: "Ed25519";
    readonly ceremonyContext: string;
    readonly publicKey: string;
    readonly signature: string;
  };
}

export interface RemotePairingDeps {
  readonly request: <T>(
    target: RemoteServerTarget,
    operation: (client: NautiloApiClient) => Promise<T>,
  ) => Promise<T>;
  readonly prepareProof: (input: {
    serverId: string;
    challengeId: string;
    ceremonyContext: string;
  }) => Promise<RemotePairingProof>;
  readonly retainAuthority: (
    serverId: string,
    response: ConsumeRemotePairingChallengeResponse,
  ) => Promise<void>;
  readonly getControllerLabel: () => string;
}

function safeControllerLabel(deps: RemotePairingDeps): string | undefined {
  try {
    const label = deps.getControllerLabel().trim().slice(0, 200);
    return label || undefined;
  } catch {
    return undefined;
  }
}

export async function consumeRemoteQrPairingWithDeps(
  target: RemoteServerTarget,
  input: {
    challengeId: string;
    secret: string;
    ceremonyContext: string;
  },
  deps: RemotePairingDeps,
): Promise<ConsumeRemotePairingChallengeResponse> {
  const prepared = await deps.prepareProof({
    serverId: target.id,
    challengeId: input.challengeId,
    ceremonyContext: input.ceremonyContext,
  });
  const label = safeControllerLabel(deps);
  const response = await deps.request(target, (client) =>
    client.consumeRemotePairingChallenge({
      challengeId: input.challengeId,
      secret: input.secret,
      installationId: prepared.installationId,
      proof: prepared.proof,
      ...(label ? { label } : {}),
    }),
  );
  await deps.retainAuthority(target.id, response);
  return response;
}

export async function consumeRemoteManualPairingWithDeps(
  target: RemoteServerTarget,
  manualCode: string,
  deps: RemotePairingDeps,
): Promise<ConsumeRemotePairingChallengeResponse> {
  const prepared = await deps.request(target, (client) =>
    client.prepareManualRemotePairing({ manualCode }),
  );
  const proof = await deps.prepareProof({
    serverId: target.id,
    challengeId: prepared.challengeId,
    ceremonyContext: prepared.ceremonyContext,
  });
  const label = safeControllerLabel(deps);
  const response = await deps.request(target, (client) =>
    client.consumeRemotePairingChallenge({
      challengeId: prepared.challengeId,
      secret: manualCode,
      installationId: proof.installationId,
      proof: proof.proof,
      ...(label ? { label } : {}),
    }),
  );
  await deps.retainAuthority(target.id, response);
  return response;
}
