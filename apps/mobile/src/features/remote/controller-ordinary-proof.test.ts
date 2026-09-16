import { describe, expect, mock, test } from "bun:test";
import { canonicalRemoteOrdinaryRequestTranscript } from "@nautilo/types";
import type { OrdinaryProofDeps } from "./controller-ordinary-proof";

mock.module("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));
mock.module("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "when-unlocked-this-device-only",
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
mock.module("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { HEX: "hex" },
  digestStringAsync: async () => "ab".repeat(32),
  getRandomBytesAsync: async (size: number) => new Uint8Array(size),
  randomUUID: () => "44444444-4444-4444-8444-444444444444",
}));

const { prepareRemoteOrdinaryRequestProof } = await import("./controller-ordinary-proof");

const authority = {
  controllerInstallationId: "11111111-1111-4111-8111-111111111111",
  installationId: "22222222-2222-4222-8222-222222222222",
  installationGeneration: 3,
  serverInstanceId: "33333333-3333-4333-8333-333333333333",
  serverBindingGeneration: 4,
};

function deps(overrides: Partial<OrdinaryProofDeps> = {}): OrdinaryProofDeps {
  return {
    loadAuthority: async () => authority,
    loadInstallation: async () => ({
      installationId: authority.installationId,
      publicKey: new Uint8Array(32),
      sign: (bytes) => {
        expect(new TextDecoder().decode(bytes)).toBe(canonicalRemoteOrdinaryRequestTranscript({
          ...authority,
          requestId: "44444444-4444-4444-8444-444444444444",
          issuedAtMs: 1_800_000_000_000,
          method: "POST",
          path: "/api/rooms/55555555-5555-4555-8555-555555555555/messages",
          bodySha256: "ab".repeat(32),
        }));
        return new Uint8Array(64).fill(0xcd);
      },
    }),
    sha256: async (body) => {
      expect(body).toBe('{"content":"hello","voiceMode":false}');
      return "ab".repeat(32);
    },
    randomUuid: () => "44444444-4444-4444-8444-444444444444",
    nowMs: () => 1_800_000_000_000,
    ...overrides,
  };
}

describe("paired mobile ordinary request proof", () => {
  test("binds canonical body and exact server authority without selecting a host", async () => {
    const proof = await prepareRemoteOrdinaryRequestProof({
      serverId: "srv_one",
      method: "post",
      path: "/api/rooms/55555555-5555-4555-8555-555555555555/messages",
      body: { voiceMode: false, content: "hello" },
    }, deps());
    expect(proof).toMatchObject({
      ...authority,
      requestId: "44444444-4444-4444-8444-444444444444",
      issuedAtMs: 1_800_000_000_000,
      method: "POST",
      bodySha256: "ab".repeat(32),
      algorithm: "Ed25519",
      signature: "cd".repeat(64),
    });
    expect(proof).not.toHaveProperty("bindingId");
    expect(proof).not.toHaveProperty("relayId");
  });

  test("returns no proof for an unpaired or replaced app installation", async () => {
    expect(await prepareRemoteOrdinaryRequestProof(
      { serverId: "srv_one", method: "POST", path: "/api/x", body: {} },
      deps({ loadAuthority: async () => null }),
    )).toBeNull();
    expect(await prepareRemoteOrdinaryRequestProof(
      { serverId: "srv_one", method: "POST", path: "/api/x", body: {} },
      deps({ loadInstallation: async () => ({
        installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        publicKey: new Uint8Array(32),
        sign: () => new Uint8Array(64),
      }) }),
    )).toBeNull();
  });
});
