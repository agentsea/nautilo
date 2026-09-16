import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "@nautilo/lattice-crypto";
import {
  createDeviceJoinPackage,
  verifyDeviceJoinPackage,
} from "../../src/index.ts";

function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const request = {
    formatVersion: 2 as const,
    providerId: "openmls-v2",
    domainId: cryptoDomainId("domain_ab"),
    humanId: humanId("human_alice"),
    deviceId: cryptoDeviceId("device_alice_pending"),
    expectedHead: {
      providerId: "openmls-v2",
      domainId: cryptoDomainId("domain_ab"),
      epoch: domainEpoch(3),
      stateHash: new Uint8Array(32).fill(0x31),
    },
    keyPackageBytes: new Uint8Array(512).fill(0x41),
  };
  const envelope = createDeviceJoinPackage({
    crypto,
    request,
    generation: 1,
    packageId: "join_package_1",
    createdAt: 10_000,
    expiresAt: 20_000,
    signingPrivateKey: signing.privateKey,
  });
  return { crypto, signing, request, envelope };
}

describe("device join package envelope", () => {
  test("binds opaque provider bytes to the current registered device and head", () => {
    const setup = fixture();
    expect(verifyDeviceJoinPackage({
      crypto: setup.crypto,
      envelope: setup.envelope,
      now: 10_001,
      resolveDevice: () => ({
        humanId: "human_alice",
        state: "active",
        generation: 1,
        signingPublicKey: setup.signing.publicKey,
      }),
      resolveProviderHead: () => setup.request.expectedHead,
    })).toMatchObject({
      deviceId: "device_alice_pending",
      domainId: "domain_ab",
      generation: 1,
      packageId: "join_package_1",
    });
  });

  test("rejects revoked devices, stale heads, expiry, and altered package bytes", () => {
    const setup = fixture();
    const common = {
      crypto: setup.crypto,
      envelope: setup.envelope,
      now: 10_001,
      resolveDevice: () => ({
        humanId: "human_alice",
        state: "active" as const,
        generation: 1,
        signingPublicKey: setup.signing.publicKey,
      }),
      resolveProviderHead: () => setup.request.expectedHead,
    };
    expect(() => verifyDeviceJoinPackage({
      ...common,
      resolveDevice: () => null,
    })).toThrow("device is not registered");
    expect(() => verifyDeviceJoinPackage({
      ...common,
      resolveProviderHead: () => ({
        ...setup.request.expectedHead,
        stateHash: new Uint8Array(32).fill(0x99),
      }),
    })).toThrow("provider head is stale");
    expect(() => verifyDeviceJoinPackage({
      ...common,
      now: 20_000,
    })).toThrow("expired");
    expect(() => verifyDeviceJoinPackage({
      ...common,
      envelope: {
        ...setup.envelope,
        keyPackageBytes: new Uint8Array(512).fill(0x42),
      },
    })).toThrow("signature");
  });
});
