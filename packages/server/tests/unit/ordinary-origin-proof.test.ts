import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalRemoteOrdinaryRequestTranscript,
  REMOTE_PAIRING_PROOF_ALGORITHM,
} from "@nautilo/types";
import {
  verifyMobileOrdinaryOrigin,
  type RemoteOrdinaryRequestProof,
  type StoredControllerOrigin,
} from "../../src/remote-control/ordinary-origin-proof";

const key = ed25519.keygen(new Uint8Array(32).fill(9));
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const NOW = 1_800_000_000_000;
const base = {
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  serverBindingGeneration: 2,
  controllerInstallationId: "22222222-2222-4222-8222-222222222222",
  installationId: "33333333-3333-4333-8333-333333333333",
  installationGeneration: 4,
  requestId: "44444444-4444-4444-8444-444444444444",
  issuedAtMs: NOW - 1_000,
  method: "POST",
  path: "/api/rooms/55555555-5555-4555-8555-555555555555/messages",
  bodySha256: "ab".repeat(32),
};

const stored: StoredControllerOrigin = {
  controllerInstallationId: base.controllerInstallationId,
  installationId: base.installationId,
  installationGeneration: base.installationGeneration,
  serverInstanceId: base.serverInstanceId,
  serverBindingGeneration: base.serverBindingGeneration,
  userId: "66666666-6666-4666-8666-666666666666",
  actorId: "77777777-7777-4777-8777-777777777777",
  proofKeyAlgorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
  proofKey: hex(key.publicKey),
  revokedAt: null,
};

function proof(overrides: Partial<typeof base> = {}): RemoteOrdinaryRequestProof {
  const input = { ...base, ...overrides };
  return {
    ...input,
    algorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
    signature: hex(
      ed25519.sign(
        new TextEncoder().encode(canonicalRemoteOrdinaryRequestTranscript(input)),
        key.secretKey,
      ),
    ),
  };
}

function verify(input: {
  stored?: StoredControllerOrigin | null;
  proof?: RemoteOrdinaryRequestProof;
  method?: string;
  path?: string;
  bodySha256?: string;
  nowMs?: number;
} = {}) {
  return verifyMobileOrdinaryOrigin({
    stored: input.stored === undefined ? stored : input.stored,
    sessionUserId: stored.userId,
    sessionActorId: stored.actorId,
    serverInstanceId: stored.serverInstanceId,
    serverBindingGeneration: stored.serverBindingGeneration,
    method: input.method ?? base.method,
    path: input.path ?? base.path,
    bodySha256: input.bodySha256 ?? base.bodySha256,
    nowMs: input.nowMs ?? NOW,
    maxAgeMs: 60_000,
    maxFutureSkewMs: 5_000,
    proof: input.proof ?? proof(),
  });
}

describe("D458 paired-mobile ordinary origin proof", () => {
  test("accepts a current stored installation key and returns compact provenance", () => {
    expect(verify()).toEqual({
      kind: "paired_mobile",
      serverInstanceId: stored.serverInstanceId,
      serverBindingGeneration: stored.serverBindingGeneration,
      userId: stored.userId,
      actorId: stored.actorId,
      controllerInstallationId: stored.controllerInstallationId,
      installationGeneration: stored.installationGeneration,
      requestId: base.requestId,
    });
  });

  test("fails closed on body, path, time, generation, revocation, or missing installation", () => {
    expect(verify({ bodySha256: "cd".repeat(32) })).toBeNull();
    expect(verify({ path: `${base.path}/other` })).toBeNull();
    expect(verify({ nowMs: NOW + 61_001 })).toBeNull();
    expect(verify({ nowMs: NOW - 6_001 })).toBeNull();
    expect(verify({ stored: { ...stored, installationGeneration: 5 } })).toBeNull();
    expect(verify({ stored: { ...stored, revokedAt: new Date() } })).toBeNull();
    expect(verify({ stored: null })).toBeNull();
  });

  test("does not trust a caller-supplied installation or signature mutation", () => {
    expect(verify({ proof: proof({ installationId: "88888888-8888-4888-8888-888888888888" }) })).toBeNull();
    const valid = proof();
    expect(verify({ proof: { ...valid, signature: `00${valid.signature.slice(2)}` } })).toBeNull();
  });
});
