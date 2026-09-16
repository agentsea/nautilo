import { describe, expect, test } from "bun:test";
import type { NautiloApiClient } from "@nautilo/api-client/browser";

import {
  consumeRemoteManualPairingWithDeps,
  consumeRemoteQrPairingWithDeps,
  type RemotePairingDeps,
} from "./remote-pairing";
import type { RemoteServerTarget } from "./remote-request";

const target: RemoteServerTarget = {
  id: "srv_selected",
  serverUrl: "https://selected.example",
  displayName: "Selected",
};
const challengeId = "7bcf2581-9341-489b-a98b-674c52dc7406";
const ceremonyContext = "11".repeat(32);
const proof = {
  installationId: "fb413d82-1888-4c5c-aac1-ea10f38f5148",
  proof: {
    algorithm: "Ed25519" as const,
    ceremonyContext,
    publicKey: "22".repeat(32),
    signature: "33".repeat(64),
  },
};
const response = {
  ok: true as const,
  installationId: proof.installationId,
  controllerInstallationId: proof.installationId,
  bindingId: "1fdbd0cf-c972-43c2-88f1-77395ea8ddf2",
  installationGeneration: 1,
  serverInstanceId: "a12d9df0-49d9-4c41-bb35-b24174340e95",
  serverBindingGeneration: 1,
};

describe("Remote pairing transport parity", () => {
  test("QR signs and consumes only through the captured server", async () => {
    const consumed: unknown[] = [];
    const prepared: unknown[] = [];
    const retained: unknown[] = [];
    const client = {
      consumeRemotePairingChallenge: (input: unknown) => {
        consumed.push(input);
        return Promise.resolve(response);
      },
    } as unknown as NautiloApiClient;
    const deps: RemotePairingDeps = {
      request: async (receivedTarget, operation) => {
        expect(receivedTarget).toEqual(target);
        return operation(client);
      },
      prepareProof: async (input) => {
        prepared.push(input);
        return proof;
      },
      retainAuthority: async (serverId, value) => {
        retained.push({ serverId, value });
      },
      getControllerLabel: () => "iPhone simulator",
    };

    await consumeRemoteQrPairingWithDeps(
      target,
      { challengeId, ceremonyContext, secret: "one-time-secret" },
      deps,
    );

    expect(prepared).toEqual([
      { serverId: target.id, challengeId, ceremonyContext },
    ]);
    expect(consumed).toEqual([
      {
        challengeId,
        secret: "one-time-secret",
        installationId: proof.installationId,
        proof: proof.proof,
        label: "iPhone simulator",
      },
    ]);
    expect(retained).toEqual([{ serverId: target.id, value: response }]);
  });

  test("manual prepare feeds the same signed consume shape", async () => {
    const calls: unknown[] = [];
    const retained: unknown[] = [];
    const client = {
      prepareManualRemotePairing: (input: unknown) => {
        calls.push({ prepare: input });
        return Promise.resolve({
          challengeId,
          ceremonyContext,
          expiresAt: "2026-07-27T12:00:00.000Z",
        });
      },
      consumeRemotePairingChallenge: (input: unknown) => {
        calls.push({ consume: input });
        return Promise.resolve(response);
      },
    } as unknown as NautiloApiClient;
    const deps: RemotePairingDeps = {
      request: (receivedTarget, operation) => {
        expect(receivedTarget).toEqual(target);
        return operation(client);
      },
      prepareProof: async (input) => {
        expect(input).toEqual({
          serverId: target.id,
          challengeId,
          ceremonyContext,
        });
        return proof;
      },
      retainAuthority: async (serverId, value) => {
        retained.push({ serverId, value });
      },
      getControllerLabel: () => "Android phone simulator",
    };

    await consumeRemoteManualPairingWithDeps(target, "MANUAL-123", deps);

    expect(calls).toEqual([
      { prepare: { manualCode: "MANUAL-123" } },
      {
        consume: {
          challengeId,
          secret: "MANUAL-123",
          installationId: proof.installationId,
          proof: proof.proof,
          label: "Android phone simulator",
        },
      },
    ]);
    expect(retained).toEqual([{ serverId: target.id, value: response }]);
  });

  test("device-label discovery cannot block the cryptographic pairing", async () => {
    const consumed: unknown[] = [];
    const client = {
      consumeRemotePairingChallenge: (input: unknown) => {
        consumed.push(input);
        return Promise.resolve(response);
      },
    } as unknown as NautiloApiClient;
    await consumeRemoteQrPairingWithDeps(
      target,
      { challengeId, ceremonyContext, secret: "one-time-secret" },
      {
        request: (_target, operation) => operation(client),
        prepareProof: async () => proof,
        retainAuthority: async () => {},
        getControllerLabel: () => {
          throw new Error("device provider unavailable");
        },
      },
    );
    expect(consumed).toEqual([{
      challengeId,
      secret: "one-time-secret",
      installationId: proof.installationId,
      proof: proof.proof,
    }]);
  });
});
