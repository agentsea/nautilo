import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalRemoteOrdinaryRequestBody,
  canonicalRemoteOrdinaryRequestTranscript,
  REMOTE_PAIRING_PROOF_ALGORITHM,
  type RemoteOrdinaryRequestProof,
} from "@nautilo/types";
import {
  admitOrdinaryOrigin,
  type OrdinaryOriginAdmissionDeps,
} from "../../src/remote-control/ordinary-origin-admission";
import type { StoredControllerOrigin } from "../../src/remote-control/ordinary-origin-proof";
import { createElectronOriginCredentialStore } from "../../src/remote-control/electron-origin-credential-store";

const NOW = 1_800_000_000_000;
const BODY = { voiceMode: false, content: "hello" };
const PATH = "/api/rooms/55555555-5555-4555-8555-555555555555/messages";
const key = ed25519.keygen(new Uint8Array(32).fill(7));
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const stored: StoredControllerOrigin = {
  controllerInstallationId: "11111111-1111-4111-8111-111111111111",
  installationId: "22222222-2222-4222-8222-222222222222",
  installationGeneration: 3,
  serverInstanceId: "33333333-3333-4333-8333-333333333333",
  serverBindingGeneration: 4,
  userId: "66666666-6666-4666-8666-666666666666",
  actorId: "77777777-7777-4777-8777-777777777777",
  proofKeyAlgorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
  proofKey: hex(key.publicKey),
  revokedAt: null,
};

function signedProof(body: unknown = BODY): RemoteOrdinaryRequestProof {
  const unsigned = {
    serverInstanceId: stored.serverInstanceId,
    serverBindingGeneration: stored.serverBindingGeneration,
    controllerInstallationId: stored.controllerInstallationId,
    installationId: stored.installationId,
    installationGeneration: stored.installationGeneration,
    requestId: "44444444-4444-4444-8444-444444444444",
    issuedAtMs: NOW - 1_000,
    method: "POST",
    path: PATH,
    bodySha256: createHash("sha256")
      .update(canonicalRemoteOrdinaryRequestBody(body), "utf8")
      .digest("hex"),
  };
  return {
    ...unsigned,
    algorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
    signature: hex(ed25519.sign(
      new TextEncoder().encode(canonicalRemoteOrdinaryRequestTranscript(unsigned)),
      key.secretKey,
    )),
  };
}

function deps(
  overrides: Partial<OrdinaryOriginAdmissionDeps> = {},
): OrdinaryOriginAdmissionDeps & { admissions: string[]; cleanups: number[] } {
  const admissions: string[] = [];
  const cleanups: number[] = [];
  return {
    admissions,
    cleanups,
    pairingStore: { findControllerOriginForOrdinaryRequest: async () => stored },
    admissionStore: {
      admitOnce: async (input) => {
        if (admissions.includes(input.requestId)) return false;
        admissions.push(input.requestId);
        return true;
      },
      cleanupExpired: async ({ limit }) => {
        cleanups.push(limit);
        return 0;
      },
    },
    getServerIdentity: async () => ({
      serverInstanceId: stored.serverInstanceId,
      serverBindingGeneration: stored.serverBindingGeneration,
    }),
    electronCredentialStore: {
      issue: () => { throw new Error("not used"); },
      consume: () => null,
    },
    getRelayRegistry: () => null,
    now: () => new Date(NOW),
    ...overrides,
  };
}

const request = {
  sessionUserId: stored.userId,
  sessionActorId: stored.actorId,
  method: "POST",
  path: PATH,
  body: BODY,
};

describe("ordinary paired-mobile origin admission", () => {
  test("keeps missing proof ordinary and atomically rejects a replay", async () => {
    const harness = deps();
    expect(await admitOrdinaryOrigin({
      ...request,
      mobileHeader: undefined,
      electronHeader: undefined,
    }, harness))
      .toEqual({ status: "absent" });
    const header = JSON.stringify(signedProof());
    expect(await admitOrdinaryOrigin({
      ...request,
      mobileHeader: header,
      electronHeader: undefined,
    }, harness)).toMatchObject({
      status: "verified",
      origin: { kind: "paired_mobile", requestId: signedProof().requestId },
    });
    expect(await admitOrdinaryOrigin({
      ...request,
      mobileHeader: header,
      electronHeader: undefined,
    }, harness))
      .toEqual({ status: "denied" });
    await Promise.resolve();
    expect(harness.cleanups).toEqual([100]);
  });

  test("fails closed on malformed, modified, or cross-server proof", async () => {
    expect(await admitOrdinaryOrigin({
      ...request,
      mobileHeader: "{}",
      electronHeader: undefined,
    }, deps()))
      .toEqual({ status: "denied" });
    expect(await admitOrdinaryOrigin({
      ...request,
      body: { ...BODY, content: "modified" },
      mobileHeader: JSON.stringify(signedProof()),
      electronHeader: undefined,
    }, deps())).toEqual({ status: "denied" });
    const wrongServer = deps({
      getServerIdentity: async () => ({
        serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        serverBindingGeneration: 4,
      }),
    });
    expect(await admitOrdinaryOrigin({
      ...request,
      mobileHeader: JSON.stringify(signedProof()),
      electronHeader: undefined,
    }, wrongServer)).toEqual({ status: "denied" });
  });
});

describe("ordinary local-Electron origin admission", () => {
  test("consumes one exact request and revalidates the launch-bound Relay", async () => {
    const store = createElectronOriginCredentialStore({
      now: () => new Date(NOW),
      randomToken: () => "fixed",
    });
    const bodySha256 = createHash("sha256")
      .update(canonicalRemoteOrdinaryRequestBody(BODY), "utf8")
      .digest("hex");
    const binding = {
      requestId: "88888888-8888-4888-8888-888888888888",
      userId: stored.userId,
      actorId: stored.actorId,
      relayId: "relay-a",
      desktopSessionId: "99999999-9999-4999-8999-999999999999",
      pairingGeneration: "generation-a",
      method: "POST",
      path: PATH,
      bodySha256,
    } as const;
    const issued = store.issue(binding);
    const harness = deps({
      electronCredentialStore: store,
      getRelayRegistry: () => ({
        getUserId: () => binding.userId,
        getDesktopSessionId: () => binding.desktopSessionId,
        getPairingGeneration: () => binding.pairingGeneration,
      }),
    });
    const input = {
      ...request,
      mobileHeader: undefined,
      electronHeader: issued.token,
    };
    expect(await admitOrdinaryOrigin(input, harness)).toEqual({
      status: "verified",
      origin: {
        kind: "local_electron",
        userId: binding.userId,
        actorId: binding.actorId,
        relayId: binding.relayId,
        desktopSessionId: binding.desktopSessionId,
        pairingGeneration: binding.pairingGeneration,
        requestId: binding.requestId,
      },
    });
    expect(await admitOrdinaryOrigin(input, harness)).toEqual({ status: "denied" });
  });

  test("denies ambiguous proof families and a changed Relay session", async () => {
    const store = createElectronOriginCredentialStore({
      now: () => new Date(NOW),
      randomToken: () => "fixed",
    });
    const issued = store.issue({
      requestId: "88888888-8888-4888-8888-888888888888",
      userId: stored.userId,
      actorId: stored.actorId,
      relayId: "relay-a",
      desktopSessionId: "99999999-9999-4999-8999-999999999999",
      pairingGeneration: "generation-a",
      method: "POST",
      path: PATH,
      bodySha256: createHash("sha256")
        .update(canonicalRemoteOrdinaryRequestBody(BODY), "utf8")
        .digest("hex"),
    });
    const changed = deps({
      electronCredentialStore: store,
      getRelayRegistry: () => ({
        getUserId: () => stored.userId,
        getDesktopSessionId: () => "different-launch",
        getPairingGeneration: () => "generation-a",
      }),
    });
    expect(await admitOrdinaryOrigin({
      ...request,
      mobileHeader: undefined,
      electronHeader: issued.token,
    }, changed)).toEqual({ status: "denied" });
    expect(await admitOrdinaryOrigin({
      ...request,
      mobileHeader: JSON.stringify(signedProof()),
      electronHeader: "deo_forged",
    }, deps())).toEqual({ status: "denied" });
  });
});
