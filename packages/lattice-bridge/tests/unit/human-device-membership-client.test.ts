import { describe, expect, test } from "bun:test";
import {
  DeviceProviderStateVault,
  HumanDeviceOpenMlsGroup,
  LatticeCrypto,
  cryptoDeviceId,
  decodeHumanDeviceGroupHead,
  encodeHumanDeviceGroupHead,
  encodeHumanDeviceGroupJoinRequest,
  encodeHumanDeviceGroupTransition,
  humanId,
  prepareRecoveryDevicePossessionChallenge,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  deviceTransferInventoryDigestV2,
  deviceTransferInventoryRevisionV2,
  pendingDeviceRevisionV2,
  recoveryKeyGenerationV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import type {
  HumanDeviceMembershipStatusV1,
} from "@nautilo/api-client";

import {
  authenticateClientDeviceProfileV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import {
  createHumanDeviceMembershipClient,
  deriveHumanDeviceMembershipVerificationCode,
  type HumanDeviceMembershipApiPort,
} from "../../src/device/human-device-membership-client.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";
import { createRecoveryMnemonicCredential } from
  "../../src/recovery/recovery-kit.ts";

const SERVER_ID = "10000000-0000-4000-8000-000000000304";
const USER_ID = "20000000-0000-4000-8000-000000000304";
const HUMAN_ID = "30000000-0000-4000-8000-000000000304";
const PERSONAL_ROOM_ID = "40000000-0000-4000-8000-000000000304";
const PERSONAL_NAMESPACE_ID = "50000000-0000-4000-8000-000000000304";
const DEVICE_ID = "device_m304_restart_browser";
const LINEAGE = new Uint8Array(32).fill(0x44);
const COORDINATES = Object.freeze({
  serverScope: "https://m304-restart.test",
  userId: USER_ID,
  humanActorId: HUMAN_ID,
  profileId: "profile_m304_restart_browser",
  deviceId: DEVICE_ID,
  installationLineageDigest: "44".repeat(32),
});

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function emptyStatus(): HumanDeviceMembershipStatusV1 {
  return Object.freeze({
    formatVersion: 1,
    serverInstanceId: SERVER_ID,
    humanId: HUMAN_ID,
    deviceId: DEVICE_ID,
    deviceGeneration: 1,
    deviceRevision: 1,
    membershipState: "unbound",
    personalAuthority: null,
    head: null,
    welcome: null,
    targetJoin: null,
    commits: [],
    nextSequence: null,
  });
}

describe("Human-device membership client", () => {
  test("binds the comparison code to the target without selecting one approver", () => {
    const crypto = new LatticeCrypto(seededRng(3_043));
    const input = Object.freeze({
      crypto,
      operationId: "operation_m304_target",
      humanId: HUMAN_ID,
      targetDeviceId: DEVICE_ID,
      targetSigningPublicKey: new Uint8Array(32).fill(0x43),
    });
    const expected = deriveHumanDeviceMembershipVerificationCode(input);
    expect(deriveHumanDeviceMembershipVerificationCode({
      ...input,
      targetSigningPublicKey: input.targetSigningPublicKey.slice(),
    })).toBe(expected);
    expect(deriveHumanDeviceMembershipVerificationCode({
      ...input,
      operationId: "operation_m304_other_target",
    })).not.toBe(expected);
  });

  test("prepares a V4 target profile before beginning additional-device membership", async () => {
    const crypto = new LatticeCrypto(seededRng(3_042));
    const vault = new MemoryClientProfileVault();
    const expectedFailure = new Error("stop_after_begin_request");
    let beginCalls = 0;
    const api: HumanDeviceMembershipApiPort = {
      loadHumanDeviceMembership: () => Promise.resolve(Object.freeze({
        ...emptyStatus(),
        membershipState: "absent" as const,
        head: Object.freeze({
          headBytesBase64url: "AA",
          sequence: 0,
        }),
      })),
      beginHumanDeviceMembership(request) {
        beginCalls += 1;
        expect(request.deviceId).toBe(DEVICE_ID);
        expect(request.signingPublicKeyBase64url.length).toBeGreaterThan(0);
        expect(request.encryptionPublicKeyBase64url.length).toBeGreaterThan(0);
        return Promise.reject(expectedFailure);
      },
      establishHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected establish")),
      publishHumanDeviceMembershipJoin: () =>
        Promise.reject(new Error("unexpected join")),
      listHumanDeviceMembershipPending: () =>
        Promise.reject(new Error("unexpected pending")),
      listHumanDeviceMembershipRoster: () =>
        Promise.reject(new Error("unexpected roster")),
      publishHumanDeviceMembershipAdd: () =>
        Promise.reject(new Error("unexpected Add")),
      publishHumanDeviceMembershipRemove: () =>
        Promise.reject(new Error("unexpected Remove")),
      acknowledgeHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected acknowledgement")),
    };
    const client = createHumanDeviceMembershipClient({
      api,
      crypto,
      vault,
      coordinates: COORDINATES,
      clientKind: "electron",
      installationLineageDigest: LINEAGE,
      idempotencyKey: "m304-additional-electron",
    });

    expect(await client.requiresAdditionalDevice()).toBe(true);
    expect(client.continue()).rejects.toBe(expectedFailure);
    expect(beginCalls).toBe(1);
    const active = (await vault.listPublicProfiles()).find((entry) =>
      entry.lifecycle === "active"
    );
    expect(active?.generation).toBe(1);
    await vault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto,
        profileBytes,
        expectedDeviceId: DEVICE_ID,
      });
      try {
        expect(profile.humanDeviceGroupSnapshot).toBeNull();
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
  });

  test("keeps a cryptographically new Human on first-device setup", async () => {
    const crypto = new LatticeCrypto(seededRng(3_044));
    const vault = new MemoryClientProfileVault();
    const api: HumanDeviceMembershipApiPort = {
      loadHumanDeviceMembership: () => Promise.resolve(Object.freeze({
        ...emptyStatus(),
        membershipState: "absent" as const,
        head: null,
      })),
      beginHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected begin")),
      establishHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected establish")),
      publishHumanDeviceMembershipJoin: () =>
        Promise.reject(new Error("unexpected join")),
      listHumanDeviceMembershipPending: () =>
        Promise.reject(new Error("unexpected pending")),
      listHumanDeviceMembershipRoster: () =>
        Promise.reject(new Error("unexpected roster")),
      publishHumanDeviceMembershipAdd: () =>
        Promise.reject(new Error("unexpected Add")),
      publishHumanDeviceMembershipRemove: () =>
        Promise.reject(new Error("unexpected Remove")),
      acknowledgeHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected acknowledgement")),
    };
    const client = createHumanDeviceMembershipClient({
      api,
      crypto,
      vault,
      coordinates: COORDINATES,
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      idempotencyKey: "m304-first-browser",
    });

    expect(await client.requiresAdditionalDevice()).toBe(false);
  });

  test("activates an accepted initial MLS stage after a lost server response", async () => {
    const crypto = new LatticeCrypto(seededRng(3_044));
    const signing = crypto.generateSigningKeyPair();
    const encryption = await crypto.generateEncryptionKeyPair();
    const v2: OpenedClientDeviceProfileV2 = Object.freeze({
      formatVersion: 2,
      deviceId: DEVICE_ID,
      signingPublicKey: signing.publicKey,
      signingPrivateKey: signing.privateKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionPrivateKey: encryption.privateKey,
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 1,
      deliveryHighWatermark: 0,
      keyringDeliveries: Object.freeze([]),
    });
    const v2Bytes = encodeClientDeviceProfileV2(v2);
    const v4 = await createClientDeviceProfileV4Candidate({
      crypto,
      currentProfileBytes: v2Bytes,
      expectedDeviceId: DEVICE_ID,
    });
    const v4Bytes = encodeClientDeviceProfileV4(v4);
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await vault.stageProfile({
      coordinates: COORDINATES,
      stageId: "initial-profile",
      generation: 1,
      profileBytes: v4Bytes,
      publicState: Object.freeze({
        clientKind: "browser",
        publicFingerprint: "30".repeat(32),
      }),
    });
    await vault.activateProfile(COORDINATES, "initial-profile");

    let current = emptyStatus();
    let loseFirstResponse = true;
    const api: HumanDeviceMembershipApiPort = {
      loadHumanDeviceMembership: () => Promise.resolve(current),
      establishHumanDeviceMembership(request) {
        const head = decodeHumanDeviceGroupHead(
          Uint8Array.from(
            atob(request.headBytesBase64url.replaceAll("-", "+")
              .replaceAll("_", "/") + "=".repeat(
                (4 - request.headBytesBase64url.length % 4) % 4,
              )),
            (character) => character.charCodeAt(0),
          ),
        );
        current = Object.freeze({
          ...current,
          membershipState: "current",
          head: Object.freeze({
            headBytesBase64url: request.headBytesBase64url,
            sequence: 0,
          }),
        });
        expect(head.serverInstanceId).toBe(SERVER_ID);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          return Promise.reject(new Error("simulated_lost_response"));
        }
        return Promise.resolve({ formatVersion: 1, status: "duplicate" });
      },
      beginHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected begin")),
      publishHumanDeviceMembershipJoin: () =>
        Promise.reject(new Error("unexpected join")),
      listHumanDeviceMembershipPending: () =>
        Promise.reject(new Error("unexpected pending")),
      listHumanDeviceMembershipRoster: () =>
        Promise.reject(new Error("unexpected roster")),
      publishHumanDeviceMembershipAdd: () =>
        Promise.reject(new Error("unexpected Add")),
      publishHumanDeviceMembershipRemove: () =>
        Promise.reject(new Error("unexpected Remove")),
      acknowledgeHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected acknowledgement")),
    };
    const createClient = () => createHumanDeviceMembershipClient({
      api,
      crypto,
      vault,
      coordinates: COORDINATES,
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      idempotencyKey: "m304-restart-browser",
    });

    let rejected: unknown;
    try {
      await createClient().ensure();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe("simulated_lost_response");
    expect((await vault.listPublicProfiles()).map((entry) => entry.lifecycle))
      .toEqual(["active", "staged"]);

    expect(await createClient().ensure()).toEqual({ status: "ready" });
    expect((await vault.listPublicProfiles()).map((entry) => entry.lifecycle))
      .toEqual(["active"]);
    await vault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto,
        profileBytes,
        expectedDeviceId: DEVICE_ID,
      });
      try {
        expect(profile.humanDeviceGroupSnapshot).not.toBeNull();
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });

    destroyOpenedClientDeviceProfileV4(v4);
    v2Bytes.fill(0);
    v4Bytes.fill(0);
  });

  test("activates one accepted Welcome when polling and continuation overlap", async () => {
    const sourceDeviceId = "device_m304_source_browser";
    const sourceCrypto = new LatticeCrypto(seededRng(3_045));
    const targetCrypto = new LatticeCrypto(seededRng(3_046));
    const signing = targetCrypto.generateSigningKeyPair();
    const encryption = await targetCrypto.generateEncryptionKeyPair();
    const targetV2Bytes = encodeClientDeviceProfileV2(Object.freeze({
      formatVersion: 2 as const,
      deviceId: DEVICE_ID,
      signingPublicKey: signing.publicKey,
      signingPrivateKey: signing.privateKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionPrivateKey: encryption.privateKey,
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 1,
      deliveryHighWatermark: 0,
      keyringDeliveries: Object.freeze([]),
    }));
    const targetProfile = await createClientDeviceProfileV4Candidate({
      crypto: targetCrypto,
      currentProfileBytes: targetV2Bytes,
      expectedDeviceId: DEVICE_ID,
    });
    const sourceVault = DeviceProviderStateVault.fromKey(
      sourceCrypto,
      cryptoDeviceId(sourceDeviceId),
      new Uint8Array(32).fill(0x45),
    );
    const targetProviderVault = DeviceProviderStateVault.fromKey(
      targetCrypto,
      cryptoDeviceId(DEVICE_ID),
      targetProfile.baseProfile.providerStateSealingKey,
    );
    const groupCoordinates = Object.freeze({
      serverInstanceId: SERVER_ID,
      humanId: humanId(HUMAN_ID),
      lineageGeneration: 1,
    });
    const sourceGroup = new HumanDeviceOpenMlsGroup(
      sourceCrypto,
      sourceVault,
      {
        coordinates: groupCoordinates,
        ownCredential: Object.freeze({
          formatVersion: 1 as const,
          ...groupCoordinates,
          deviceId: cryptoDeviceId(sourceDeviceId),
          installationLineageDigest: new Uint8Array(32).fill(0x45),
          deviceKeyGeneration: 1,
        }),
      },
    );
    const targetGroup = new HumanDeviceOpenMlsGroup(
      targetCrypto,
      targetProviderVault,
      {
        coordinates: groupCoordinates,
        ownCredential: Object.freeze({
          formatVersion: 1 as const,
          ...groupCoordinates,
          deviceId: cryptoDeviceId(DEVICE_ID),
          installationLineageDigest: LINEAGE,
          deviceKeyGeneration: 1,
        }),
      },
    );
    await Promise.all([sourceGroup.initialize(), targetGroup.initialize()]);
    const founded = await sourceGroup.createInitialState();
    const join = await targetGroup.createJoinRequest(founded.head);
    const add = await sourceGroup.prepareAdd({
      active: founded.active,
      currentHead: founded.head,
      joinRequest: join.publicResult,
    });
    const joinSnapshot = Object.freeze({
      providerId: join.localState.providerId,
      domainId: join.localState.domainId,
      epoch: join.localState.revision,
      stateHash: founded.head.stateHash.slice(),
      ciphertext: join.localState.ciphertext.slice(),
    });
    const targetProfileBytes = encodeClientDeviceProfileV4(Object.freeze({
      formatVersion: 4 as const,
      baseProfile: targetProfile.baseProfile,
      humanDeviceGroupSnapshot: joinSnapshot,
      signerEvidence: targetProfile.signerEvidence,
    }));
    const profileVault = new MemoryClientProfileVault();
    await profileVault.unlock();
    await profileVault.stageProfile({
      coordinates: COORDINATES,
      stageId: "target-join",
      generation: 1,
      profileBytes: targetProfileBytes,
      publicState: Object.freeze({
        clientKind: "electron",
        publicFingerprint: "46".repeat(32),
      }),
    });
    await profileVault.activateProfile(COORDINATES, "target-join");

    const operationId = "operation_m304_concurrent_welcome";
    let acknowledgements = 0;
    let current: HumanDeviceMembershipStatusV1 = Object.freeze({
      ...emptyStatus(),
      deviceRevision: 2,
      membershipState: "welcome_pending" as const,
      head: Object.freeze({
        headBytesBase64url: base64url(
          encodeHumanDeviceGroupHead(add.publicResult.nextHead),
        ),
        sequence: 1,
      }),
      welcome: Object.freeze({
        operationId,
        sequence: 1,
        transitionBytesBase64url: base64url(
          encodeHumanDeviceGroupTransition(add.publicResult),
        ),
        welcomeBytesBase64url: base64url(add.publicResult.welcomeBytes),
      }),
      targetJoin: Object.freeze({
        operationId,
        requestBytesBase64url: base64url(
          encodeHumanDeviceGroupJoinRequest(join.publicResult),
        ),
      }),
    });
    const api: HumanDeviceMembershipApiPort = {
      loadHumanDeviceMembership: () => Promise.resolve(current),
      acknowledgeHumanDeviceMembership() {
        acknowledgements += 1;
        current = Object.freeze({
          ...current,
          deviceRevision: 3,
          membershipState: "current" as const,
          welcome: null,
          targetJoin: null,
        });
        return Promise.resolve({ formatVersion: 1, status: "acknowledged" });
      },
      establishHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected establish")),
      beginHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected begin")),
      publishHumanDeviceMembershipJoin: () =>
        Promise.reject(new Error("unexpected join")),
      listHumanDeviceMembershipPending: () =>
        Promise.reject(new Error("unexpected pending")),
      listHumanDeviceMembershipRoster: () =>
        Promise.reject(new Error("unexpected roster")),
      publishHumanDeviceMembershipAdd: () =>
        Promise.reject(new Error("unexpected Add")),
      publishHumanDeviceMembershipRemove: () =>
        Promise.reject(new Error("unexpected Remove")),
    };
    const client = createHumanDeviceMembershipClient({
      api,
      crypto: targetCrypto,
      vault: profileVault,
      coordinates: COORDINATES,
      clientKind: "electron",
      installationLineageDigest: LINEAGE,
      idempotencyKey: "m304-concurrent-welcome",
    });

    expect(await Promise.all([client.ensure(), client.ensure()])).toEqual([
      { status: "ready" },
      { status: "ready" },
    ]);
    expect(acknowledgements).toBe(1);
    await profileVault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto: targetCrypto,
        profileBytes,
        expectedDeviceId: DEVICE_ID,
      });
      try {
        expect(profile.baseProfile.baseProfile.trustedDeviceRevision).toBe(3);
        expect(
          profile.baseProfile.baseProfile.trustedHostAuthorizationRevision,
        ).toBe(3);
        expect(profile.humanDeviceGroupSnapshot?.epoch).toBe(1);
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });

    current = Object.freeze({ ...current, deviceRevision: 4 });
    expect(await client.ensure()).toEqual({ status: "ready" });
    await profileVault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto: targetCrypto,
        profileBytes,
        expectedDeviceId: DEVICE_ID,
      });
      try {
        expect(profile.baseProfile.baseProfile.trustedDeviceRevision).toBe(4);
        expect(
          profile.baseProfile.baseProfile.trustedHostAuthorizationRevision,
        ).toBe(4);
        expect(profile.humanDeviceGroupSnapshot?.epoch).toBe(1);
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });

    joinSnapshot.stateHash.fill(0);
    joinSnapshot.ciphertext.fill(0);
    targetProfileBytes.fill(0);
    targetV2Bytes.fill(0);
    destroyOpenedClientDeviceProfileV4(targetProfile);
    sourceVault.destroy();
    targetProviderVault.destroy();
  });

  test("keeps the recovered MLS lineage when the completion response is lost", async () => {
    const crypto = new LatticeCrypto(seededRng(3_047));
    const vault = new MemoryClientProfileVault();
    const recovery = await createRecoveryMnemonicCredential(crypto);
    const inventoryRevision = deviceTransferInventoryRevisionV2(0);
    const inventoryDigest = deviceTransferInventoryDigestV2({
      humanId: humanId(HUMAN_ID),
      inventoryRevision,
      inventory: Object.freeze([]),
    });
    let current: HumanDeviceMembershipStatusV1 = Object.freeze({
      ...emptyStatus(),
      deviceRevision: 0,
      membershipState: "removed" as const,
    });
    let completedHead = "";
    let recoveredPersonalAuthority = false;
    const api: HumanDeviceMembershipApiPort = {
      loadHumanDeviceMembership: () => Promise.resolve(current),
      beginHumanDeviceMembershipRecovery: async (request) => {
        const now = Date.now();
        const signingPublicKey = Buffer.from(
          request.signingPublicKeyBase64url,
          "base64url",
        );
        const encryptionPublicKey = Buffer.from(
          request.encryptionPublicKeyBase64url,
          "base64url",
        );
        const prepared = await prepareRecoveryDevicePossessionChallenge({
          crypto,
          challengeId: "challenge_m304_recovery_client",
          pendingDevice: {
            humanId: humanId(HUMAN_ID),
            deviceId: cryptoDeviceId(DEVICE_ID),
            pendingDeviceRevision: pendingDeviceRevisionV2(0),
            encryptionPublicKey,
            signingPublicKey,
          },
          resolveTrustedPendingDevice: () => ({
            humanId: humanId(HUMAN_ID),
            deviceId: cryptoDeviceId(DEVICE_ID),
            pendingDeviceRevision: pendingDeviceRevisionV2(0),
            encryptionPublicKeyDigest: crypto.hash(encryptionPublicKey),
            signingPublicKeyDigest: crypto.hash(signingPublicKey),
            status: "pending",
          }),
          recoveryKeyId: recovery.keyId,
          recoveryGeneration: recoveryKeyGenerationV2(1),
          recoveryPublicKey: recovery.publicKey,
          resolveTrustedCurrentRecoveryKey: () => ({
            humanId: humanId(HUMAN_ID),
            recoveryKeyId: recovery.keyId,
            recoveryGeneration: recoveryKeyGenerationV2(1),
            publicKeyDigest: crypto.hash(recovery.publicKey),
          }),
          recoveryArchiveDigest: new Uint8Array(32).fill(0x47),
          inventoryRevision,
          resolveTrustedInventoryCommitment: () => ({
            humanId: humanId(HUMAN_ID),
            inventoryRevision,
            inventoryCount: 0,
            inventoryDigest,
          }),
          issuedAt: unixTimestamp(now),
          expiresAt: unixTimestamp(now + 60_000),
        });
        return Object.freeze({
          formatVersion: 1 as const,
          operationId: "operation_m304_recovery_client",
          challengeBytesBase64url: base64url(prepared.challengeBytes),
          serverInstanceId: SERVER_ID,
          currentLineageGeneration: 1,
          nextLineageGeneration: 2,
          personalAuthority: {
            roomId: PERSONAL_ROOM_ID,
            namespaceId: PERSONAL_NAMESPACE_ID,
          },
        });
      },
      completeHumanDeviceMembershipRecovery: (_operationId, request) => {
        completedHead = request.headBytesBase64url;
        current = Object.freeze({
          ...current,
          deviceRevision: 1,
          membershipState: "current" as const,
          personalAuthority: {
            roomId: PERSONAL_ROOM_ID,
            namespaceId: PERSONAL_NAMESPACE_ID,
          },
          head: Object.freeze({
            headBytesBase64url: completedHead,
            sequence: 0,
          }),
        });
        return Promise.reject(new Error("simulated_lost_recovery_response"));
      },
      establishHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected establish")),
      beginHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected begin")),
      publishHumanDeviceMembershipJoin: () =>
        Promise.reject(new Error("unexpected join")),
      listHumanDeviceMembershipPending: () =>
        Promise.reject(new Error("unexpected pending")),
      listHumanDeviceMembershipRoster: () =>
        Promise.reject(new Error("unexpected roster")),
      publishHumanDeviceMembershipAdd: () =>
        Promise.reject(new Error("unexpected Add")),
      publishHumanDeviceMembershipRemove: () =>
        Promise.reject(new Error("unexpected Remove")),
      acknowledgeHumanDeviceMembership: () =>
        Promise.reject(new Error("unexpected acknowledgement")),
    };
    const client = createHumanDeviceMembershipClient({
      api,
      crypto,
      vault,
      coordinates: COORDINATES,
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      idempotencyKey: "m304-recovery-client",
      personalAuthority: {
        ensure: () => Promise.resolve({ status: "pending" as const }),
        recover: (anchor, credential) => {
          expect(anchor).toEqual({
            roomId: PERSONAL_ROOM_ID,
            namespaceId: PERSONAL_NAMESPACE_ID,
          });
          expect(credential.keyId).toBe(recovery.keyId);
          expect(credential.generation).toBe(1);
          expect(credential.privateKey).toBeInstanceOf(Uint8Array);
          expect(credential.privateKey).toHaveLength(32);
          recoveredPersonalAuthority = true;
          return Promise.resolve({ status: "ready" as const });
        },
      },
    });

    expect(await client.recoverWithMnemonic(recovery.mnemonic)).toEqual({
      status: "recovered",
    });
    expect(completedHead.length).toBeGreaterThan(0);
    expect(recoveredPersonalAuthority).toBeTrue();
    expect((await vault.listPublicProfiles()).map((entry) => entry.lifecycle))
      .toEqual(["active"]);
    await vault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto,
        profileBytes,
        expectedDeviceId: DEVICE_ID,
      });
      try {
        expect(profile.humanDeviceGroupSnapshot).not.toBeNull();
        expect(decodeHumanDeviceGroupHead(
          Buffer.from(completedHead, "base64url"),
        ).lineageGeneration).toBe(2);
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
  });
});
