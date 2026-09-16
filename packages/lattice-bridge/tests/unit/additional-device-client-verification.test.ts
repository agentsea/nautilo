import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  restoreSealedProviderState,
} from "@nautilo/lattice-crypto";

import {
  addAdditionalDeviceDomainSignerEvidenceV4,
  createAdditionalDeviceApproverClient,
  createAdditionalDeviceTargetClient,
  createProfileVaultPendingAdditionalDeviceStateVault,
  deriveAdditionalDeviceClientIdentity,
  deriveAdditionalDeviceJoinPackageId,
  deriveAdditionalDeviceVerificationCode,
  restartPendingAdditionalDeviceAttempt,
  type PendingAdditionalDeviceClientState,
} from
  "../../src/device/additional-device-client.ts";
import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import { encodeClientDeviceProfileV1 } from
  "../../src/client-vault/profile-v2.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";

describe("additional-device comparison code", () => {
  const crypto = new LatticeCrypto();
  const base = {
    crypto,
    operationId: "device-enrollment-1",
    humanId: "human-1",
    targetDeviceId: "device-desktop",
    targetSigningPublicKey: new Uint8Array(32).fill(0x11),
    approverDeviceId: "device-browser",
    approverSigningPublicKey: new Uint8Array(32).fill(0x22),
  };

  test("is stable on both devices and changes for every bound coordinate", () => {
    const expected = deriveAdditionalDeviceVerificationCode(base);
    expect(expected).toMatch(/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/u);
    expect(deriveAdditionalDeviceVerificationCode({
      ...base,
      targetSigningPublicKey: base.targetSigningPublicKey.slice(),
      approverSigningPublicKey: base.approverSigningPublicKey.slice(),
    })).toBe(expected);

    for (const changed of [
      { operationId: "device-enrollment-2" },
      { humanId: "human-2" },
      { targetDeviceId: "device-browser" },
      { approverDeviceId: "device-desktop" },
      { targetSigningPublicKey: new Uint8Array(32).fill(0x12) },
      { approverSigningPublicKey: new Uint8Array(32).fill(0x23) },
    ]) {
      expect(deriveAdditionalDeviceVerificationCode({ ...base, ...changed }))
        .not.toBe(expected);
    }
  });

  test("rejects malformed signing keys", () => {
    expect(() => deriveAdditionalDeviceVerificationCode({
      ...base,
      targetSigningPublicKey: new Uint8Array(31),
    })).toThrow("comparison keys are invalid");
  });

  test("keeps logout/login stable while isolating accounts and servers", () => {
    const input = {
      crypto,
      serverScope: "https://nautilo.test",
      userId: "user-a",
      humanActorId: "human-a",
      installationId: "install-1",
      clientKind: "browser" as const,
    };
    const first = deriveAdditionalDeviceClientIdentity(input);
    const relogin = deriveAdditionalDeviceClientIdentity(input);
    const otherAccount = deriveAdditionalDeviceClientIdentity({
      ...input,
      userId: "user-b",
      humanActorId: "human-b",
    });
    const otherServer = deriveAdditionalDeviceClientIdentity({
      ...input,
      serverScope: "https://other.nautilo.test",
    });
    expect(relogin).toEqual(first);
    expect(otherAccount.coordinates.deviceId)
      .not.toBe(first.coordinates.deviceId);
    expect(otherAccount.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(otherAccount.coordinates.userId).toBe("user-b");
    expect(otherServer.coordinates.deviceId).not.toBe(first.coordinates.deviceId);
    first.installationLineageDigest.fill(0);
    relogin.installationLineageDigest.fill(0);
    otherAccount.installationLineageDigest.fill(0);
    otherServer.installationLineageDigest.fill(0);
  });

  test("rejects a server plan for another account before join custody", async () => {
    const userId = "00000000-0000-4000-8000-000000000081";
    const humanActorId = "00000000-0000-4000-8000-000000000082";
    const identity = deriveAdditionalDeviceClientIdentity({
      crypto,
      serverScope: "https://nautilo.test",
      userId,
      humanActorId,
      installationId: "install-1",
      clientKind: "browser",
    });
    let stored: PendingAdditionalDeviceClientState | null = null;
    const clone = (value: PendingAdditionalDeviceClientState | null):
      PendingAdditionalDeviceClientState | null => value === null ? null : Object.freeze({
      ...value,
      installationLineageDigest: value.installationLineageDigest.slice(),
      profileBytes: value.profileBytes.slice(),
      joins: Object.freeze([]),
    });
    const substitutedEnrollment = {
      userId: "00000000-0000-4000-8000-000000000099",
      humanActorId,
      deviceId: identity.coordinates.deviceId,
      operationId: "operation-substituted",
      inventoryRevision: 1,
      inventoryCount: 0,
      inventoryDigestBase64url: "A".repeat(43),
    };
    const approver = {
      deviceId: "device-browser",
      signingPublicKeyBase64url: "A".repeat(43),
    };
    const pageBinding = new TextEncoder().encode(JSON.stringify({
      operationId: substitutedEnrollment.operationId,
      targetDeviceId: substitutedEnrollment.deviceId,
      inventoryRevision: substitutedEnrollment.inventoryRevision,
      inventoryCount: substitutedEnrollment.inventoryCount,
      inventoryDigestBase64url:
        substitutedEnrollment.inventoryDigestBase64url,
      domainCount: 0,
      approver,
      personalAuthority: null,
      start: 0,
      end: 0,
      domains: [],
    }));
    const target = createAdditionalDeviceTargetClient({
      api: {
        beginProtectedAdditionalDeviceV2: () => Promise.resolve({
          formatVersion: 2,
          enrollment: substitutedEnrollment,
          approver,
          personalAuthority: null,
          domainCount: 0,
          page: {
            start: 0,
            end: 0,
            nextStart: null,
            pageDigestBase64url: Buffer.from(crypto.hash(pageBinding))
              .toString("base64url"),
          },
          domains: [],
        } as never),
      } as never,
      vault: {
        load: () => Promise.resolve(clone(stored)),
        create: (value) => {
          stored = clone(value);
          return Promise.resolve("inserted" as const);
        },
        compareAndSwap: () => Promise.resolve(false),
        removeExact: () => Promise.resolve(false),
      },
      profileVault: {} as never,
      serverScope: "https://nautilo.test",
      userId,
      humanActorId,
      deviceId: identity.coordinates.deviceId,
      clientKind: "browser",
      installationLineageDigest: identity.installationLineageDigest,
      idempotencyKey: identity.idempotencyKey,
      transitionCampaignVault: {
        unlock: () => Promise.resolve({ status: "available" as const }),
        putSealed: () => Promise.resolve("inserted" as const),
        listIndexes: () => Promise.resolve([]),
        withOpenedBody: () => Promise.reject(new Error("not used")),
        updateIndex: () => Promise.resolve(false),
        removeExact: () => Promise.resolve(false),
      },
      crypto,
    });
    let failure: unknown;
    try {
      await target.continue();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe(
      "Additional-device account was substituted",
    );
    identity.installationLineageDigest.fill(0);
  });

  test("derives a bounded portable join-package id from long durable coordinates", () => {
    const operationId = `additional-device:${"a".repeat(100)}`;
    const domainId = `domain:${"b".repeat(100)}`;
    const expected = deriveAdditionalDeviceJoinPackageId({
      crypto,
      operationId,
      domainId,
    });
    expect(expected).toMatch(/^join:[0-9a-f]{64}$/u);
    expect(expected.length).toBeLessThanOrEqual(128);
    expect(deriveAdditionalDeviceJoinPackageId({
      crypto,
      operationId,
      domainId,
    })).toBe(expected);
    expect(deriveAdditionalDeviceJoinPackageId({
      crypto,
      operationId,
      domainId: `${domainId}x`,
    })).not.toBe(expected);
  });

  test("restarts an expired local attempt without replacing device custody", () => {
    const state = {
      formatVersion: 1 as const,
      revision: 2 as const,
      idempotencyKey: "additional-device:electron:install-1",
      coordinates: Object.freeze({
        serverScope: "http://127.0.0.1:3201",
        userId: "user-1",
        humanActorId: "human-1",
        profileId: "device-desktop",
        deviceId: "device-desktop",
        installationLineageDigest: "11".repeat(32),
      }),
      clientKind: "electron" as const,
      installationLineageDigest: new Uint8Array(32).fill(0x11),
      profileBytes: new Uint8Array([1, 2, 3]),
      operationId: "expired-operation",
      joins: Object.freeze([]),
    };
    const restarted = restartPendingAdditionalDeviceAttempt(state);
    expect(restarted).toMatchObject({
      formatVersion: 1,
      revision: 1,
      idempotencyKey: state.idempotencyKey,
      operationId: null,
      joins: [],
    });
    expect(restarted.coordinates).toBe(state.coordinates);
    expect(restarted.installationLineageDigest)
      .not.toBe(state.installationLineageDigest);
    expect(restarted.profileBytes).not.toBe(state.profileBytes);
    expect(restarted.installationLineageDigest)
      .toEqual(state.installationLineageDigest);
    expect(restarted.profileBytes).toEqual(state.profileBytes);
  });

  test("persists and reopens the canonical 256-Domain pending join inventory", async () => {
    const profileVault = new MemoryClientProfileVault();
    await profileVault.unlock();
    const coordinates = Object.freeze({
      serverScope: "https://nautilo.test",
      userId: "00000000-0000-4000-8000-000000000091",
      humanActorId: "00000000-0000-4000-8000-000000000092",
      profileId: "device-capacity",
      deviceId: "device-capacity",
      installationLineageDigest: "11".repeat(32),
    });
    const pendingVault = createProfileVaultPendingAdditionalDeviceStateVault({
      vault: profileVault,
      coordinates,
      clientKind: "electron",
      crypto,
    });
    const joins = Object.freeze(Array.from({ length: 256 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      const domainId = cryptoDomainId(`domain-capacity-${suffix}`);
      return Object.freeze({
        domainId,
        expectedHead: Object.freeze({
          providerId: `provider-capacity-${suffix}`,
          domainId,
          epoch: domainEpoch(0),
          stateHash: new Uint8Array(32).fill(index),
        }),
        localState: restoreSealedProviderState({
          providerId: `provider-capacity-${suffix}`,
          domainId,
          deviceId: cryptoDeviceId(coordinates.deviceId),
          revision: domainEpoch(0),
          snapshotKind: "candidate",
          ciphertext: new Uint8Array(6_600).fill(index),
        }),
        package: Object.freeze({
          formatVersion: 1 as const,
          providerId: `provider-capacity-${suffix}`,
          domainId,
          humanId: coordinates.humanActorId,
          deviceId: coordinates.deviceId,
          expectedEpoch: 0,
          expectedProviderHeadHashBase64url: "A".repeat(43),
          generation: 1 as const,
          packageId: `join-capacity-${suffix}`,
          packageHashBase64url: "B".repeat(43),
          keyPackageBytesBase64url: "AQ",
          createdAt: 1_000,
          expiresAt: 61_000,
          signatureBase64url: "AQ",
        }),
      });
    }));
    const pending: PendingAdditionalDeviceClientState = Object.freeze({
      formatVersion: 1,
      revision: 2,
      idempotencyKey: "additional-device:capacity",
      coordinates,
      clientKind: "electron",
      installationLineageDigest: new Uint8Array(32).fill(0x11),
      profileBytes: new Uint8Array([1]),
      operationId: "operation-capacity",
      joins,
    });
    expect(await pendingVault.create(pending)).toBe("inserted");
    const reopened = await pendingVault.load(pending.idempotencyKey);
    expect(reopened?.joins).toHaveLength(256);
    expect(reopened?.joins.at(-1)?.domainId).toBe("domain-capacity-255");
    const syncing: PendingAdditionalDeviceClientState = Object.freeze({
      ...pending,
      revision: 3,
      syncVerificationCode: "ABCDEF-012345-6789AB",
      syncReason: "current_domain_sync_required",
    });
    expect(await pendingVault.compareAndSwap({
      expected: reopened!,
      replacement: syncing,
    })).toBe(true);
    expect(await pendingVault.load(pending.idempotencyKey)).toMatchObject({
      revision: 3,
      syncReason: "current_domain_sync_required",
    });
  });

  test("keeps a sealed partially committed campaign visible for exact resume", async () => {
    const profileVault = new MemoryClientProfileVault();
    await profileVault.unlock();
    const coordinates = Object.freeze({
      serverScope: "https://nautilo.test",
      userId: "00000000-0000-4000-8000-000000000093",
      humanActorId: "00000000-0000-4000-8000-000000000094",
      profileId: "device-approver",
      deviceId: "device-approver",
      installationLineageDigest: "22".repeat(32),
    });
    const signing = crypto.generateSigningKeyPair();
    const encryption = await crypto.generateEncryptionKeyPair();
    const v1 = encodeClientDeviceProfileV1({
      deviceId: coordinates.deviceId,
      signingPublicKey: signing.publicKey,
      signingPrivateKey: signing.privateKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionPrivateKey: encryption.privateKey,
    });
    const profile = await createClientDeviceProfileV4Candidate({
      crypto,
      currentProfileBytes: v1,
      expectedDeviceId: coordinates.deviceId,
      v1Migration: {
        trustedDeviceRevision: 1,
        trustedHostAuthorizationRevision: 1,
        deliveryHighWatermark: 0,
      },
    });
    const profileBytes = encodeClientDeviceProfileV4(profile);
    await profileVault.stageProfile({
      coordinates,
      stageId: "initial",
      generation: 1,
      profileBytes,
      publicState: { clientKind: "browser", publicFingerprint: "11".repeat(32) },
    });
    await profileVault.activateProfile(coordinates, "initial");
    const campaign = Object.freeze({
      formatVersion: 1 as const,
      operationId: "operation-partial",
      kind: "additional_device_transition" as const,
      targetDeviceId: "device-target",
      targetClientKind: "electron" as const,
      verificationCode: "ABCDEF-012345-6789AB",
      candidateProfileDigestBase64url: "A".repeat(43),
      candidateProfileGeneration: 2,
      authenticatedRequestDigestBase64url: "B".repeat(43),
      canonicalBytes: 100,
      sealedBytes: 116,
      createdAt: 1_000,
      updatedAt: 1_000,
      attempts: 0,
      attemptWindowStartedAt: null,
      attemptsInWindow: 0,
      nextAttemptAt: 1_000,
      lastAttemptAt: null,
      state: "pending" as const,
    });
    const approver = createAdditionalDeviceApproverClient({
      api: {
        listProtectedAdditionalDevicePendingV2: () => Promise.resolve({
          formatVersion: 2,
          pending: [],
        }),
      } as never,
      profileVault,
      coordinates,
      transitionCampaignVault: {
        unlock: () => Promise.resolve({ status: "available" as const }),
        listIndexes: () => Promise.resolve([campaign]),
        putSealed: () => Promise.reject(new Error("not used")),
        withOpenedBody: () => Promise.reject(new Error("not used")),
        updateIndex: () => Promise.resolve(false),
        removeExact: () => Promise.resolve(false),
      },
      crypto,
    });
    expect(await approver.inspect()).toEqual([{
      enrollment: {
        operationId: campaign.operationId,
        deviceId: campaign.targetDeviceId,
        clientKind: campaign.targetClientKind,
      },
      progress: "transfer_ready",
      verificationCode: campaign.verificationCode,
    }]);

    destroyOpenedClientDeviceProfileV4(profile);
    profileBytes.fill(0);
    v1.fill(0);
  });

  test("pins the exact two-device Domain signer inventory on each local profile", async () => {
    const localSigning = crypto.generateSigningKeyPair();
    const localEncryption = await crypto.generateEncryptionKeyPair();
    const peer = crypto.generateSigningKeyPair();
    const v1 = encodeClientDeviceProfileV1({
      deviceId: "device-browser",
      signingPublicKey: localSigning.publicKey,
      signingPrivateKey: localSigning.privateKey,
      encryptionPublicKey: localEncryption.publicKey,
      encryptionPrivateKey: localEncryption.privateKey,
    });
    const profile = await createClientDeviceProfileV4Candidate({
      crypto,
      currentProfileBytes: v1,
      expectedDeviceId: "device-browser",
      v1Migration: {
        trustedDeviceRevision: 1,
        trustedHostAuthorizationRevision: 1,
        deliveryHighWatermark: 0,
      },
    });
    let candidate: Awaited<ReturnType<
      typeof addAdditionalDeviceDomainSignerEvidenceV4
    >> | undefined;
    try {
      candidate = await addAdditionalDeviceDomainSignerEvidenceV4({
        crypto,
        profile,
        humanId: "human-alice",
        domainId: "domain-alice",
        domainEpoch: 1,
        participantDigest: new Uint8Array(32).fill(0x41),
        providerTransitionDigest: new Uint8Array(32).fill(0x42),
        peerDeviceId: "device-desktop",
        peerSigningPublicKey: peer.publicKey,
        acceptedAt: 4_200,
      });
      const evidence = candidate.signerEvidence.find((entry) =>
        entry.kind === "shared_human_domain_trust"
      );
      expect(evidence).toMatchObject({
        kind: "shared_human_domain_trust",
        domainId: "domain-alice",
        domainEpoch: 1,
        acceptedByDeviceId: "device-browser",
      });
      expect(evidence?.kind === "shared_human_domain_trust"
        ? evidence.devices.map((entry) => entry.deviceId)
        : []).toEqual(["device-browser", "device-desktop"]);
    } finally {
      if (candidate) destroyOpenedClientDeviceProfileV4(candidate);
      destroyOpenedClientDeviceProfileV4(profile);
      v1.fill(0);
      localSigning.privateKey.fill(0);
      localEncryption.privateKey.fill(0);
      peer.privateKey.fill(0);
    }
  });
});
