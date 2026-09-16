import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import {
  activateInitialHumanDomainClientCeremony,
  prepareAndStageInitialHumanDomainClientCeremony,
  resumeStagedInitialHumanDomainClientCeremony,
} from "../../src/device/initial-human-domain-client-ceremony.ts";
import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  encodeClientDeviceProfileV1,
} from "../../src/client-vault/profile-v2.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";

const HUMAN = "20000000-0000-4000-8000-000000000274";
const USER = "10000000-0000-4000-8000-000000000274";
const DEVICE = "device_m274_initial_domain";
const DOMAIN = "domain_m274_initial_human";
const OPERATION = "operation_m274_initial_human_domain";
const COORDINATES = Object.freeze({
  serverScope: "https://initial-domain.test",
  userId: USER,
  humanActorId: HUMAN,
  profileId: "profile_m274_initial_domain",
  deviceId: DEVICE,
  installationLineageDigest: "27".repeat(32),
});

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(27_400));
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const profileBytes = encodeClientDeviceProfileV1({
    deviceId: DEVICE,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
  });
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await vault.stageProfile({
    coordinates: COORDINATES,
    stageId: "initial-profile",
    generation: 1,
    profileBytes,
    publicState: {
      clientKind: "browser",
      publicFingerprint: "27".repeat(32),
    },
  });
  await vault.activateProfile(COORDINATES, "initial-profile");
  profileBytes.fill(0);
  return { crypto, vault, signing };
}

async function expectFailure(
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation();
    throw new Error("expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  }
}

describe("initial Human Domain client ceremony", () => {
  test("stages sealed v4 provider custody and activates only after the exact server receipt", async () => {
    const state = await fixture();
    const prepared = await prepareAndStageInitialHumanDomainClientCeremony({
      crypto: state.crypto,
      vault: state.vault,
      coordinates: COORDINATES,
      operationId: OPERATION,
      domainId: DOMAIN,
      humanId: HUMAN,
      currentDomainHead: null,
      activeDeviceIds: [DEVICE],
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 3,
      deliveryHighWatermark: 0,
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected preparation");
    expect(prepared.submission).toMatchObject({
      operationId: OPERATION,
      targetDomainId: DOMAIN,
      participants: [HUMAN],
      committerDeviceId: DEVICE,
      committerHumanId: HUMAN,
      additions: [],
      initialProviderHead: { epoch: 0 },
    });
    expect((await state.vault.listPublicProfiles()).map((entry) => [
      entry.lifecycle,
      entry.generation,
    ])).toEqual([["active", 1], ["staged", 2]]);

    // Crash after local stage but before server submission: no returned
    // capability survives. Reopening the durable stage reconstructs the exact
    // signed request and activation expectation without minting a rival Domain.
    await state.vault.lock();
    await state.vault.unlock();
    const resumed = await resumeStagedInitialHumanDomainClientCeremony({
      crypto: state.crypto,
      vault: state.vault,
      coordinates: COORDINATES,
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 3,
    });
    expect(resumed.status).toBe("prepared");
    if (resumed.status !== "prepared") throw new Error("expected resumed preparation");
    expect(resumed.submission).toEqual(prepared.submission);
    expect(resumed.receiptExpectation).toEqual(prepared.receiptExpectation);

    await expectFailure(() => activateInitialHumanDomainClientCeremony({
      crypto: state.crypto,
      vault: state.vault,
      coordinates: COORDINATES,
      expectation: resumed.receiptExpectation,
      receipt: {
        ...resumed.receiptExpectation,
        formatVersion: 1,
        status: "active",
        stateHash: new Uint8Array(32).fill(0xff),
        committedAt: 12_000,
      },
    }), "receipt");
    expect((await state.vault.listPublicProfiles()).some((entry) =>
      entry.lifecycle === "staged"
    )).toBe(true);

    const receipt = Object.freeze({
      ...resumed.receiptExpectation,
      formatVersion: 1 as const,
      status: "active" as const,
      committedAt: 12_000,
    });
    expect(await activateInitialHumanDomainClientCeremony({
      crypto: state.crypto,
      vault: state.vault,
      coordinates: COORDINATES,
      expectation: resumed.receiptExpectation,
      receipt,
    })).toEqual({ status: "active" });
    expect(await activateInitialHumanDomainClientCeremony({
      crypto: state.crypto,
      vault: state.vault,
      coordinates: COORDINATES,
      expectation: resumed.receiptExpectation,
      receipt,
    })).toEqual({ status: "active" });

    await state.vault.withOpenProfile(COORDINATES, async (bytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto: state.crypto,
        profileBytes: bytes,
        expectedDeviceId: DEVICE,
      });
      try {
        expect(profile.baseProfile.activeProviderSnapshots).toHaveLength(1);
        expect(profile.baseProfile.activeProviderSnapshots[0]).toMatchObject({
          domainId: DOMAIN,
          epoch: 0,
        });
        expect(profile.baseProfile.baseProfile.trustedDeviceRevision).toBe(1);
        expect(
          profile.baseProfile.baseProfile.trustedHostAuthorizationRevision,
        ).toBe(3);
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
    state.signing.privateKey.fill(0);
  });

  test("defers existing Domains and multi-device Humans without staging a rival", async () => {
    const state = await fixture();
    const common = {
      crypto: state.crypto,
      vault: state.vault,
      coordinates: COORDINATES,
      operationId: OPERATION,
      domainId: DOMAIN,
      humanId: HUMAN,
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 3,
      deliveryHighWatermark: 0,
    } as const;
    const existing = await prepareAndStageInitialHumanDomainClientCeremony({
      ...common,
      currentDomainHead: {
        providerId: "openmls-v2",
        domainId: cryptoDomainId(DOMAIN),
        epoch: domainEpoch(0),
        stateHash: new Uint8Array(32).fill(0x22),
      },
      activeDeviceIds: [DEVICE],
    });
    expect(existing).toEqual({
      status: "deferred",
      reason: "existing_domain_requires_delivery",
    });
    const multiple = await prepareAndStageInitialHumanDomainClientCeremony({
      ...common,
      currentDomainHead: null,
      activeDeviceIds: [DEVICE, "device_m274_second"],
    });
    expect(multiple).toEqual({
      status: "deferred",
      reason: "multiple_active_devices_require_fanout",
    });
    expect(await state.vault.listPublicProfiles()).toHaveLength(1);
    state.signing.privateKey.fill(0);
  });

  test("rejects substituted Human/device authority before creating local state", async () => {
    const state = await fixture();
    await expectFailure(() => prepareAndStageInitialHumanDomainClientCeremony({
      crypto: state.crypto,
      vault: state.vault,
      coordinates: COORDINATES,
      operationId: OPERATION,
      domainId: DOMAIN,
      humanId: humanId("human-substituted"),
      currentDomainHead: null,
      activeDeviceIds: [DEVICE],
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 3,
      deliveryHighWatermark: 0,
    }), "Human");
    expect(await state.vault.listPublicProfiles()).toHaveLength(1);
    state.signing.privateKey.fill(0);
  });
});
