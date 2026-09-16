import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalRemotePairingTranscript,
  REMOTE_PAIRING_PROOF_ALGORITHM,
} from "@nautilo/types";
import {
  derivePairingCeremonyContext,
  verifyRemoteControllerProof,
} from "../../src/remote-control/controller-proof";

const pepper = "a development-only pairing pepper that has at least 32 bytes";
const challenge = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  serverInstanceId: "22222222-2222-4222-8222-222222222222",
  serverBindingGeneration: 3,
  userId: "33333333-3333-4333-8333-333333333333",
  actorId: "44444444-4444-4444-8444-444444444444",
  relayTokenId: "55555555-5555-4555-8555-555555555555",
  hostInstallationId: "66666666-6666-4666-8666-666666666666",
  desktopSessionId: "desktop-session-opaque",
  pairingGeneration: "55555555-5555-4555-8555-555555555555",
};
const installationId = "77777777-7777-4777-8777-777777777777";
const bytesToHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

function validProof() {
  const key = ed25519.keygen(new Uint8Array(32).fill(7));
  const ceremonyContext = derivePairingCeremonyContext(pepper, challenge);
  const publicKey = bytesToHex(key.publicKey);
  const transcript = canonicalRemotePairingTranscript({
    challengeId: challenge.id,
    ceremonyContext,
    installationId,
    algorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
    publicKey,
  });
  return {
    algorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
    ceremonyContext,
    publicKey,
    signature: bytesToHex(ed25519.sign(new TextEncoder().encode(transcript), key.secretKey)),
  };
}

describe("remote controller proof", () => {
  test("verifies a Noble-generated Ed25519 vector with Node native crypto", () => {
    const verified = verifyRemoteControllerProof({ pepper, challenge, installationId, proof: validProof() });
    expect(verified?.fingerprint).toHaveLength(64);
  });

  test("rejects context, transcript and encoding mutations", () => {
    const proof = validProof();
    expect(verifyRemoteControllerProof({ pepper, challenge, installationId, proof: { ...proof, ceremonyContext: "00".repeat(32) } })).toBeNull();
    expect(verifyRemoteControllerProof({ pepper, challenge, installationId: installationId.replace("7", "8"), proof })).toBeNull();
    expect(verifyRemoteControllerProof({ pepper, challenge, installationId, proof: { ...proof, signature: proof.signature.toUpperCase() } })).toBeNull();
    expect(verifyRemoteControllerProof({
      pepper,
      challenge,
      installationId,
      proof: { ...proof, publicKey: "00".repeat(32) },
    })).toBeNull();
  });
});
