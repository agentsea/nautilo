import { describe, expect, test } from "bun:test";
import {
  DeviceProviderStateVault,
  LatticeCrypto,
  OpenMlsGroupProvider,
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareAgentRuntimeInitialization,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
  createProcessorObjectSignerPublicV1,
  createProcessorSignerAuthorizationV1,
  deviceTransferApprovalSigningBytesV2,
  deviceTransferInventoryRevisionV2,
  encodeAgentRuntimeSignerPublicationV1,
  pendingDeviceRevisionV2,
  serializeDeviceTransferApprovalV2,
  type DeviceTransferApprovalV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import {
  addClientSignerEvidenceV4,
  addClientSharedHumanDomainSignerEvidenceV4,
  addClientHumanDeviceTransferSignerEvidenceV4,
  authenticateClientDeviceProfileV4,
  CLIENT_DEVICE_PROFILE_MAX_SIGNER_EVIDENCE,
  CLIENT_DEVICE_PROFILE_V4_MAX_BYTES,
  createClientDeviceProfileV4Candidate,
  createClientProfileObjectAccessAnchorPortV4,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
  stageAndActivateClientDeviceProfileV4,
  withClientObjectAccessSignerResolversV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  createSharedHumanDomainTrustAcceptanceV1,
  encodeSharedHumanDomainTrustAcceptanceV1,
} from "../../src/delivery/shared-human-domain-trust.ts";
import {
  addClientDomainProviderSnapshot,
  createClientDeviceProfileV3Candidate,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
  updateClientDeviceProfileV3,
  withClientDomainRoots,
} from "../../src/client-vault/profile-v3.ts";
import { ingestObjectAccessSignerEvidenceV4 } from
  "../../src/client-vault/ingest-object-access-signer-evidence-v4.ts";
import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import { MemoryClientProfileVault } from "../../src/testing/client-profile-vault.ts";

const DEVICE = "device_profile_v4_alice";
const COORDINATES = {
  serverScope: "https://profile-v4.test",
  userId: "10000000-0000-4000-8000-000000000004",
  humanActorId: "20000000-0000-4000-8000-000000000004",
  profileId: "profile_v4_alice",
  deviceId: DEVICE,
  installationLineageDigest: "44".repeat(32),
} as const;

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(2_634));
  const deviceSigning = crypto.generateSigningKeyPair();
  const deviceEncryption = await crypto.generateEncryptionKeyPair();
  const v2: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: DEVICE,
    signingPublicKey: deviceSigning.publicKey,
    signingPrivateKey: deviceSigning.privateKey,
    encryptionPublicKey: deviceEncryption.publicKey,
    encryptionPrivateKey: deviceEncryption.privateKey,
    trustedDeviceRevision: 2,
    trustedHostAuthorizationRevision: 3,
    deliveryHighWatermark: 0,
    keyringDeliveries: Object.freeze([]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(v2);
  const manager = crypto.generateSigningKeyPair();
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-profile-v4-agent",
    agentId: agentId("agent-profile-v4"),
    authorizationRevision: authorizationRevision(4),
    configObjects: [{
      objectId: objectId("config-profile-v4"),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x61),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId("human-profile-v4-manager"),
      managerAuthorizationRevision: authorizationRevision(4),
      managerDeviceId: cryptoDeviceId("device-profile-v4-manager"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  return {
    crypto,
    v2Bytes,
    deviceSigning,
    manager,
    publication: initialized.signerPublication,
    publicationBytes: encodeAgentRuntimeSignerPublicationV1(
      initialized.signerPublication,
    ),
  };
}

async function createAgentPublicationForIssuer(input: Readonly<{
  crypto: LatticeCrypto;
  manager: Readonly<{ privateKey: Uint8Array; publicKey: Uint8Array }>;
  managerHumanId: string;
  managerDeviceId: string;
  managerAuthorizationRevision: number;
  suffix: string;
}>) {
  const initialized = await prepareAgentRuntimeInitialization({
    crypto: input.crypto,
    operationId: `operation-profile-v4-${input.suffix}`,
    agentId: agentId(`agent-profile-v4-${input.suffix}`),
    authorizationRevision: authorizationRevision(4),
    configObjects: [{
      objectId: objectId(`config-profile-v4-${input.suffix}`),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x62),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(input.managerHumanId),
      managerAuthorizationRevision: authorizationRevision(
        input.managerAuthorizationRevision,
      ),
      managerDeviceId: cryptoDeviceId(input.managerDeviceId),
    },
    managerSigningPrivateKey: input.manager.privateKey,
    resolveCurrentManagerAuthority: () => input.manager.publicKey,
  });
  return Object.freeze({
    publication: initialized.signerPublication,
    publicationBytes: encodeAgentRuntimeSignerPublicationV1(
      initialized.signerPublication,
    ),
  });
}

describe("client profile v4 signer evidence", () => {
  test("advances rollback anchors in V4 while preserving evidence and CAS", async () => {
    const state = await fixture();
    const profile = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto, currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const withEvidence = await addClientSignerEvidenceV4({
      crypto: state.crypto, profile, evidence: {
        kind: "agent_runtime_publication", evidenceBytes: state.publicationBytes,
        issuingPublicKey: state.manager.publicKey,
      },
    });
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await stageAndActivateClientDeviceProfileV4({
      crypto: state.crypto, vault, coordinates: COORDINATES,
      stageId: "v4-initial", generation: 1,
      publicState: { clientKind: "browser", publicFingerprint: "44".repeat(32) },
      candidate: withEvidence,
    });
    let stage = 0;
    const anchors = createClientProfileObjectAccessAnchorPortV4({
      crypto: state.crypto, vault, coordinates: COORDINATES,
      createStageId: () => `v4-anchor-${++stage}`,
    });
    const next = Object.freeze({ objectId: objectId("object-profile-v4"),
      payloadHash: new Uint8Array(32).fill(1), accessRevision: accessRevision(0),
      manifestHash: new Uint8Array(32).fill(2) });

    expect(await anchors.advance({ expected: null, next })).toBeTrue();
    expect(await anchors.advance({ expected: null, next })).toBeFalse();
    expect(await anchors.load(next.objectId)).toEqual(next);
    await vault.withOpenProfile(COORDINATES, async (bytes) => {
      const reopened = await authenticateClientDeviceProfileV4({
        crypto: state.crypto, profileBytes: bytes, expectedDeviceId: DEVICE,
      });
      expect(reopened.signerEvidence).toHaveLength(1);
      expect(reopened.baseProfile.activeProviderSnapshots)
        .toEqual(withEvidence.baseProfile.activeProviderSnapshots);
      destroyOpenedClientDeviceProfileV4(reopened);
    });
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(2);

    destroyOpenedClientDeviceProfileV4(withEvidence);
    destroyOpenedClientDeviceProfileV4(profile);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("recovers only the freshly reconstructed interrupted v4 anchor candidate", async () => {
    const state = await fixture();
    const profile = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await stageAndActivateClientDeviceProfileV4({
      crypto: state.crypto, vault, coordinates: COORDINATES,
      stageId: "v4-anchor-base", generation: 1,
      publicState: { clientKind: "browser", publicFingerprint: "45".repeat(32) },
      candidate: profile,
    });
    const next = Object.freeze({ objectId: objectId("object-v4-interrupted"),
      payloadHash: new Uint8Array(32).fill(5), accessRevision: accessRevision(0),
      manifestHash: new Uint8Array(32).fill(6) });
    const substituted = Object.freeze({ ...next,
      payloadHash: new Uint8Array(32).fill(7) });
    const activate = vault.activateProfile.bind(vault);
    let interrupted = false;
    vault.activateProfile = (coordinates, stageId) => {
      if (!interrupted && stageId === "v4-anchor-interrupted") {
        interrupted = true;
        return Promise.reject(new Error("simulated v4 anchor interruption"));
      }
      return activate(coordinates, stageId);
    };
    const interruptionError = await createClientProfileObjectAccessAnchorPortV4({
      crypto: state.crypto, vault, coordinates: COORDINATES,
      createStageId: () => "v4-anchor-interrupted",
    }).advance({ expected: null, next }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(interruptionError).toHaveProperty(
      "message", "simulated v4 anchor interruption",
    );

    vault.activateProfile = activate;
    const substitutedOwner = createClientProfileObjectAccessAnchorPortV4({
      crypto: state.crypto, vault, coordinates: COORDINATES,
      createStageId: () => "v4-anchor-substituted",
    });
    expect(await substitutedOwner.advance({ expected: null, next: substituted })
      .then(() => null, (error: unknown) => error)).toHaveProperty(
        "message", "another client profile stage is already pending",
      );
    expect((await vault.listPublicProfiles()).filter((entry) =>
      entry.lifecycle === "staged"
    )).toHaveLength(1);

    let replacementStageCalls = 0;
    const recreatedOwner = createClientProfileObjectAccessAnchorPortV4({
      crypto: state.crypto, vault, coordinates: COORDINATES,
      createStageId: () => {
        replacementStageCalls += 1;
        return "v4-anchor-recreated-random";
      },
    });
    expect(await recreatedOwner.advance({ expected: null, next })).toBeTrue();
    expect(replacementStageCalls).toBe(0);
    expect(await recreatedOwner.load(next.objectId)).toEqual(next);
    expect((await vault.listPublicProfiles())).toHaveLength(1);
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(2);

    destroyOpenedClientDeviceProfileV4(profile);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("stores one Human-device group snapshot outside the legacy Domain inventory", async () => {
    const state = await fixture();
    const profile = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const snapshot = Object.freeze({
      providerId: "openmls-v2",
      domainId: "human-device-group:test",
      epoch: 3,
      stateHash: new Uint8Array(32).fill(0x71),
      ciphertext: new Uint8Array(96).fill(0x72),
    });
    const bytes = encodeClientDeviceProfileV4(Object.freeze({
      ...profile,
      humanDeviceGroupSnapshot: snapshot,
    }));
    const restarted = await authenticateClientDeviceProfileV4({
      crypto: state.crypto,
      profileBytes: bytes,
      expectedDeviceId: DEVICE,
    });

    expect(restarted.humanDeviceGroupSnapshot).toEqual(snapshot);
    expect(restarted.baseProfile.activeProviderSnapshots).toEqual([]);

    destroyOpenedClientDeviceProfileV4(restarted);
    destroyOpenedClientDeviceProfileV4(profile);
    bytes.fill(0);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("retains exact shared-Domain first-contact signer keys across restart", async () => {
    const state = await fixture();
    const profile = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const peer = state.crypto.generateSigningKeyPair();
    const devices = Object.freeze([{
      humanId: "human-profile-v4-alice",
      deviceId: DEVICE,
      deviceGeneration: 1,
      signingPublicKey: profile.baseProfile.baseProfile.signingPublicKey,
    }, {
      humanId: "human-profile-v4-bob",
      deviceId: "device-profile-v4-bob",
      deviceGeneration: 1,
      signingPublicKey: peer.publicKey,
    }]);
    const accepted = createSharedHumanDomainTrustAcceptanceV1({
      crypto: state.crypto,
      domainId: "domain-profile-v4-shared",
      domainEpoch: 1,
      participantDigest: new Uint8Array(32).fill(0x31),
      targetSubmissionDigest: new Uint8Array(32).fill(0x32),
      devices,
      acceptedByHumanId: "human-profile-v4-alice",
      acceptedByDeviceId: DEVICE,
      acceptedAt: 4_000,
      acceptingSigningPrivateKey:
        profile.baseProfile.baseProfile.signingPrivateKey,
    });
    const acceptanceBytes = encodeSharedHumanDomainTrustAcceptanceV1(
      accepted.acceptance,
    );
    let candidate: Awaited<ReturnType<
      typeof addClientSharedHumanDomainSignerEvidenceV4
    >> | undefined;
    let reopened: Awaited<ReturnType<
      typeof authenticateClientDeviceProfileV4
    >> | undefined;
    try {
      candidate = await addClientSharedHumanDomainSignerEvidenceV4({
        crypto: state.crypto,
        profile,
        acceptanceBytes,
        devices,
      });
      const bytes = encodeClientDeviceProfileV4(candidate);
      try {
        reopened = await authenticateClientDeviceProfileV4({
          crypto: state.crypto,
          profileBytes: bytes,
          expectedDeviceId: DEVICE,
        });
      } finally {
        bytes.fill(0);
      }
      const resolved = withClientObjectAccessSignerResolversV4({
        crypto: state.crypto,
        profile: reopened,
        operation: (resolvers) =>
          resolvers.resolveHistoricalHumanDeviceSigningPublicKey({
            humanId: "human-profile-v4-bob",
            deviceId: "device-profile-v4-bob",
          })?.slice() ?? null,
      });
      expect(resolved === null ? null : Array.from(resolved)).toEqual(
        Array.from(peer.publicKey),
      );
      resolved?.fill(0);

      const replay = await addClientSharedHumanDomainSignerEvidenceV4({
        crypto: state.crypto,
        profile: reopened,
        acceptanceBytes,
        devices,
      });
      try {
        expect(replay.signerEvidence).toHaveLength(1);
      } finally {
        destroyOpenedClientDeviceProfileV4(replay);
      }

      const substitutedDevices = devices.map((entry) => ({
        ...entry,
        signingPublicKey: entry.deviceId === "device-profile-v4-bob"
          ? new Uint8Array(32).fill(0x7f)
          : entry.signingPublicKey,
      }));
      expect(addClientSharedHumanDomainSignerEvidenceV4({
        crypto: state.crypto,
        profile: reopened,
        acceptanceBytes,
        devices: substitutedDevices,
      })).rejects.toThrow();
    } finally {
      acceptanceBytes.fill(0);
      accepted.acceptance.participantDigest.fill(0);
      accepted.acceptance.targetSubmissionDigest.fill(0);
      accepted.acceptance.deviceInventoryDigest.fill(0);
      accepted.acceptance.signature.fill(0);
      accepted.devices.forEach((entry) => entry.signingPublicKey.fill(0));
      peer.privateKey.fill(0);
      if (reopened !== undefined) destroyOpenedClientDeviceProfileV4(reopened);
      if (candidate !== undefined) destroyOpenedClientDeviceProfileV4(candidate);
      destroyOpenedClientDeviceProfileV4(profile);
      state.v2Bytes.fill(0);
    }
  });

  test("authenticates transported evidence before one idempotent v4 activation", async () => {
    const state = await fixture();
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await vault.stageProfile({
      coordinates: COORDINATES,
      stageId: "profile-v4-transport-base",
      generation: 1,
      profileBytes: state.v2Bytes,
      publicState: {
        clientKind: "browser",
        publicFingerprint: "ac".repeat(32),
      },
    });
    await vault.activateProfile(COORDINATES, "profile-v4-transport-base");
    const evidenceBytesBase64url = Buffer.from(state.publicationBytes)
      .toString("base64url");
    let stage = 0;
    const ingest = () => ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url,
      }],
      resolveTrustedIssuingDevicePublicKey: ({
        humanId,
        deviceId,
        hostAuthorizationRevision,
        trustedDeviceRevision,
      }) => Promise.resolve(
        humanId === "human-profile-v4-manager"
          && deviceId === "device-profile-v4-manager"
          && hostAuthorizationRevision === 4
          && trustedDeviceRevision === 2
          ? state.manager.publicKey.slice()
          : null,
      ),
      createStageId: () => `profile-v4-transport:${++stage}`,
    });
    await vault.lock();
    await ingest();
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(2);
    await vault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const opened = await authenticateClientDeviceProfileV4({
        crypto: state.crypto,
        profileBytes,
        expectedDeviceId: DEVICE,
      });
      expect(opened.signerEvidence).toHaveLength(1);
      destroyOpenedClientDeviceProfileV4(opened);
    });
    await ingest();
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(2);

    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("preserves an interrupted randomized v2 migration it cannot reproduce", async () => {
    const state = await fixture();
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await vault.stageProfile({
      coordinates: COORDINATES,
      stageId: "profile-v2-interrupted-base",
      generation: 1,
      profileBytes: state.v2Bytes,
      publicState: {
        clientKind: "browser",
        publicFingerprint: "a9".repeat(32),
      },
    });
    await vault.activateProfile(COORDINATES, "profile-v2-interrupted-base");
    const evidenceBytesBase64url = Buffer.from(state.publicationBytes)
      .toString("base64url");
    let stage = 0;
    const ingest = () => ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [{ kind: "agent_runtime_publication", evidenceBytesBase64url }],
      resolveTrustedIssuingDevicePublicKey: () =>
        Promise.resolve(state.manager.publicKey.slice()),
      createStageId: () => `profile-v2-interrupted:${++stage}`,
    });
    const activate = vault.activateProfile.bind(vault);
    vault.activateProfile = (coordinates, stageId) =>
      stageId === "profile-v2-interrupted:1"
        ? Promise.reject(new Error("simulated v2 migration interruption"))
        : activate(coordinates, stageId);
    expect(await ingest().then(() => null, (error: unknown) => error))
      .toHaveProperty("message", "simulated v2 migration interruption");
    vault.activateProfile = activate;
    expect(await ingest().then(() => null, (error: unknown) => error))
      .toHaveProperty("message", "another client profile stage is already pending");
    expect((await vault.listPublicProfiles()).map((entry) => ({
      lifecycle: entry.lifecycle,
      stageId: entry.stageId,
      generation: entry.generation,
    }))).toEqual([
      { lifecycle: "active", stageId: undefined, generation: 1 },
      { lifecycle: "staged", stageId: "profile-v2-interrupted:1", generation: 2 },
    ]);

    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("reconstructs verified evidence before recovering an interrupted v4 activation", async () => {
    const state = await fixture();
    const baseProfile = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const baseProfileBytes = encodeClientDeviceProfileV4(baseProfile);
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await vault.stageProfile({
      coordinates: COORDINATES,
      stageId: "profile-v4-transport-base",
      generation: 1,
      profileBytes: baseProfileBytes,
      publicState: {
        clientKind: "browser",
        publicFingerprint: "ac".repeat(32),
      },
    });
    await vault.activateProfile(COORDINATES, "profile-v4-transport-base");
    const evidenceBytesBase64url = Buffer.from(state.publicationBytes)
      .toString("base64url");
    let stage = 0;
    const ingest = (issuingKey = state.manager.publicKey) =>
      ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url,
      }],
      resolveTrustedIssuingDevicePublicKey: ({
        humanId,
        deviceId,
        hostAuthorizationRevision,
        trustedDeviceRevision,
      }) => Promise.resolve(
        humanId === "human-profile-v4-manager"
          && deviceId === "device-profile-v4-manager"
          && hostAuthorizationRevision === 4
          && trustedDeviceRevision === 2
          ? issuingKey.slice()
          : null,
      ),
      createStageId: () => `profile-v4-transport:${++stage}`,
    });
    const activate = vault.activateProfile.bind(vault);
    let interrupted = false;
    vault.activateProfile = (coordinates, stageId) => {
      if (!interrupted && stageId === "profile-v4-transport:1") {
        interrupted = true;
        return Promise.reject(new Error("simulated signer evidence interruption"));
      }
      return activate(coordinates, stageId);
    };
    await vault.lock();
    expect(await ingest().then(() => null, (error: unknown) => error))
      .toHaveProperty("message", "simulated signer evidence interruption");
    expect((await vault.listPublicProfiles()).map((entry) => entry.lifecycle))
      .toEqual(["active", "staged"]);
    const substitutedKey = state.manager.publicKey.slice();
    substitutedKey[0] = substitutedKey[0]! ^ 1;
    expect(await ingest(substitutedKey).then(
      () => null,
      (error: unknown) => error,
    )).toBeInstanceOf(Error);
    expect((await vault.listPublicProfiles()).map((entry) => entry.lifecycle))
      .toEqual(["active", "staged"]);
    substitutedKey.fill(0);
    vault.activateProfile = activate;
    await ingest();
    expect(stage).toBe(1);
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(2);
    await vault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const opened = await authenticateClientDeviceProfileV4({
        crypto: state.crypto,
        profileBytes,
        expectedDeviceId: DEVICE,
      });
      expect(opened.signerEvidence).toHaveLength(1);
      destroyOpenedClientDeviceProfileV4(opened);
    });
    await ingest();
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(2);

    state.publicationBytes.fill(0);
    baseProfileBytes.fill(0);
    destroyOpenedClientDeviceProfileV4(baseProfile);
    state.v2Bytes.fill(0);
  });

  test("leaves locked custody untouched when no signer evidence is supplied", async () => {
    const state = await fixture();
    const vault = new MemoryClientProfileVault();

    await ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [],
      createStageId: () => "profile-v4-empty-ingest",
    });

    expect(await vault.availability()).toEqual({ status: "locked" });
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("does not retry terminal custody while ingesting signer evidence", async () => {
    const state = await fixture();
    const vault = new MemoryClientProfileVault();
    let unlockCalls = 0;
    vault.availability = () => Promise.resolve({ status: "storage_lost" });
    vault.unlock = () => {
      unlockCalls += 1;
      return Promise.resolve({ status: "available" });
    };

    const error = await ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url: Buffer.from(state.publicationBytes)
          .toString("base64url"),
      }],
      createStageId: () => "profile-v4-terminal-ingest",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Client profile vault is unavailable");
    expect(unlockCalls).toBe(0);

    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("ingests a cross-Human issuer from retained shared-Domain trust", async () => {
    const state = await fixture();
    const profile = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const devices = Object.freeze([{
      humanId: COORDINATES.humanActorId,
      deviceId: DEVICE,
      deviceGeneration: 1,
      signingPublicKey: profile.baseProfile.baseProfile.signingPublicKey,
    }, {
      humanId: "human-profile-v4-manager",
      deviceId: "device-profile-v4-manager",
      deviceGeneration: 1,
      signingPublicKey: state.manager.publicKey,
    }]);
    const accepted = createSharedHumanDomainTrustAcceptanceV1({
      crypto: state.crypto,
      domainId: "domain-profile-v4-ingest-shared",
      domainEpoch: 1,
      participantDigest: new Uint8Array(32).fill(0x34),
      targetSubmissionDigest: new Uint8Array(32).fill(0x35),
      devices,
      acceptedByHumanId: COORDINATES.humanActorId,
      acceptedByDeviceId: DEVICE,
      acceptedAt: 5_000,
      acceptingSigningPrivateKey:
        profile.baseProfile.baseProfile.signingPrivateKey,
    });
    const acceptanceBytes = encodeSharedHumanDomainTrustAcceptanceV1(
      accepted.acceptance,
    );
    const retained = await addClientSharedHumanDomainSignerEvidenceV4({
      crypto: state.crypto,
      profile,
      acceptanceBytes,
      devices,
    });
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await stageAndActivateClientDeviceProfileV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      stageId: "profile-v4-shared-ingest-base",
      generation: 1,
      publicState: {
        clientKind: "browser",
        publicFingerprint: "ad".repeat(32),
      },
      candidate: retained,
    });
    let externalCalls = 0;
    const ingest = () => ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url: Buffer.from(state.publicationBytes)
          .toString("base64url"),
      }],
      resolveTrustedIssuingDevicePublicKey: () => {
        externalCalls += 1;
        return Promise.resolve(null);
      },
      createStageId: () => "profile-v4-shared-ingest-next",
    });
    await ingest();
    expect(externalCalls).toBe(0);
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(2);
    await vault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const reopened = await authenticateClientDeviceProfileV4({
        crypto: state.crypto,
        profileBytes,
        expectedDeviceId: DEVICE,
      });
      const resolved = withClientObjectAccessSignerResolversV4({
        crypto: state.crypto,
        profile: reopened,
        operation: (resolvers) =>
          resolvers.resolveAgentRuntimeSignerPublicKey({
            kind: "agent_runtime",
            agentId: state.publication.agentId,
            runtimeGeneration: state.publication.runtimeGeneration,
            signerKeyId: state.publication.signerKeyId,
          })?.slice() ?? null,
      });
      expect(resolved === null ? null : Array.from(resolved)).toEqual(
        Array.from(state.publication.signerPublicKey),
      );
      resolved?.fill(0);
      destroyOpenedClientDeviceProfileV4(reopened);
    });
    await ingest();
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(2);

    const swapped = await createAgentPublicationForIssuer({
      crypto: state.crypto,
      manager: state.manager,
      managerHumanId: "human-profile-v4-manager",
      managerDeviceId: "device-profile-v4-manager-swapped",
      managerAuthorizationRevision: 4,
      suffix: "swapped-device",
    });
    expect(ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url: Buffer.from(swapped.publicationBytes)
          .toString("base64url"),
      }],
      createStageId: () => "profile-v4-shared-ingest-swapped",
    })).rejects.toThrow("issuer is not trusted");

    const collidingManager = state.crypto.generateSigningKeyPair();
    const collidingDevices = Object.freeze([devices[0]!, {
      ...devices[1]!,
      signingPublicKey: collidingManager.publicKey,
    }]);
    const collidingAcceptance = createSharedHumanDomainTrustAcceptanceV1({
      crypto: state.crypto,
      domainId: "domain-profile-v4-ingest-collision",
      domainEpoch: 1,
      participantDigest: new Uint8Array(32).fill(0x36),
      targetSubmissionDigest: new Uint8Array(32).fill(0x37),
      devices: collidingDevices,
      acceptedByHumanId: COORDINATES.humanActorId,
      acceptedByDeviceId: DEVICE,
      acceptedAt: 5_001,
      acceptingSigningPrivateKey:
        profile.baseProfile.baseProfile.signingPrivateKey,
    });
    const collidingBytes = encodeSharedHumanDomainTrustAcceptanceV1(
      collidingAcceptance.acceptance,
    );
    const collided = await addClientSharedHumanDomainSignerEvidenceV4({
      crypto: state.crypto,
      profile: retained,
      acceptanceBytes: collidingBytes,
      devices: collidingDevices,
    });
    const collisionVault = new MemoryClientProfileVault();
    await collisionVault.unlock();
    await stageAndActivateClientDeviceProfileV4({
      crypto: state.crypto,
      vault: collisionVault,
      coordinates: COORDINATES,
      stageId: "profile-v4-shared-ingest-collision-base",
      generation: 1,
      publicState: {
        clientKind: "browser",
        publicFingerprint: "af".repeat(32),
      },
      candidate: collided,
    });
    expect(ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault: collisionVault,
      coordinates: COORDINATES,
      evidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url: Buffer.from(state.publicationBytes)
          .toString("base64url"),
      }],
      createStageId: () => "profile-v4-shared-ingest-collision",
    })).rejects.toThrow("Human device signer evidence collided");

    collidingBytes.fill(0);
    swapped.publicationBytes.fill(0);
    acceptanceBytes.fill(0);
    destroyOpenedClientDeviceProfileV4(collided);
    destroyOpenedClientDeviceProfileV4(retained);
    destroyOpenedClientDeviceProfileV4(profile);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("ingests a same-Human transferred device without bypassing self trust", async () => {
    const state = await fixture();
    const profile = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const targetEncryption = await state.crypto.generateEncryptionKeyPair();
    const signingDigest = state.crypto.hash(state.manager.publicKey);
    const encryptionDigest = state.crypto.hash(targetEncryption.publicKey);
    const inventoryDigest = new Uint8Array(32).fill(0x38);
    const unsigned: DeviceTransferApprovalV2 = {
      formatVersion: 2,
      humanId: humanId(COORDINATES.humanActorId),
      targetDeviceId: cryptoDeviceId("device-profile-v4-manager"),
      pendingDeviceRevision: pendingDeviceRevisionV2(0),
      encryptionPublicKeyDigest: encryptionDigest,
      signingPublicKeyDigest: signingDigest,
      issuerDeviceId: cryptoDeviceId(DEVICE),
      createdAt: unixTimestamp(11_000),
      inventoryRevision: deviceTransferInventoryRevisionV2(0),
      inventoryCount: 0,
      inventoryDigest,
      packages: [],
      joinIntents: [],
      signature: new Uint8Array(64),
    };
    const approvalBytes = serializeDeviceTransferApprovalV2({
      ...unsigned,
      signature: state.crypto.sign(
        profile.baseProfile.baseProfile.signingPrivateKey,
        deviceTransferApprovalSigningBytesV2(unsigned),
      ),
    });
    const retained = await addClientHumanDeviceTransferSignerEvidenceV4({
      crypto: state.crypto,
      profile,
      approvalBytes,
      targetSigningPublicKey: state.manager.publicKey,
      issuerSigningPublicKey:
        profile.baseProfile.baseProfile.signingPublicKey,
    });
    const forgedIssuer = profile.baseProfile.baseProfile.signingPublicKey.slice();
    forgedIssuer[0] = forgedIssuer[0]! ^ 1;
    expect(addClientHumanDeviceTransferSignerEvidenceV4({
      crypto: state.crypto,
      profile,
      approvalBytes,
      targetSigningPublicKey: state.manager.publicKey,
      issuerSigningPublicKey: forgedIssuer,
    })).rejects.toThrow("not authentic");

    const publication = await createAgentPublicationForIssuer({
      crypto: state.crypto,
      manager: state.manager,
      managerHumanId: COORDINATES.humanActorId,
      managerDeviceId: "device-profile-v4-manager",
      managerAuthorizationRevision: 4,
      suffix: "same-human-transfer",
    });
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await stageAndActivateClientDeviceProfileV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      stageId: "profile-v4-transfer-ingest-base",
      generation: 1,
      publicState: {
        clientKind: "electron",
        publicFingerprint: "ae".repeat(32),
      },
      candidate: retained,
    });
    await ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url: Buffer.from(publication.publicationBytes)
          .toString("base64url"),
      }],
      createStageId: () => "profile-v4-transfer-ingest-next",
    });
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(2);

    const selfAboveTrustedRevision = await createAgentPublicationForIssuer({
      crypto: state.crypto,
      manager: state.deviceSigning,
      managerHumanId: COORDINATES.humanActorId,
      managerDeviceId: DEVICE,
      managerAuthorizationRevision: 4,
      suffix: "self-above-trusted-revision",
    });
    expect(ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url: Buffer.from(
          selfAboveTrustedRevision.publicationBytes,
        ).toString("base64url"),
      }],
      createStageId: () => "profile-v4-transfer-self-stale",
    })).rejects.toThrow("issuer is not trusted");

    const swappedSelfHuman = await createAgentPublicationForIssuer({
      crypto: state.crypto,
      manager: state.deviceSigning,
      managerHumanId: "human-profile-v4-swapped",
      managerDeviceId: DEVICE,
      managerAuthorizationRevision: 3,
      suffix: "self-swapped-human",
    });
    expect(ingestObjectAccessSignerEvidenceV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      evidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url: Buffer.from(swappedSelfHuman.publicationBytes)
          .toString("base64url"),
      }],
      createStageId: () => "profile-v4-transfer-self-swapped",
    })).rejects.toThrow("issuer is not trusted");

    swappedSelfHuman.publicationBytes.fill(0);
    selfAboveTrustedRevision.publicationBytes.fill(0);
    publication.publicationBytes.fill(0);
    forgedIssuer.fill(0);
    approvalBytes.fill(0);
    signingDigest.fill(0);
    encryptionDigest.fill(0);
    inventoryDigest.fill(0);
    targetEncryption.privateKey.fill(0);
    targetEncryption.publicKey.fill(0);
    destroyOpenedClientDeviceProfileV4(retained);
    destroyOpenedClientDeviceProfileV4(profile);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("migrates without changing v3 state and reauthenticates retained evidence after restart", async () => {
    const state = await fixture();
    const empty = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    expect(empty.signerEvidence).toEqual([]);
    expect(empty.baseProfile.activeProviderSnapshots).toEqual([]);
    expect(empty.baseProfile.objectAccessAnchors).toEqual([]);

    const retained = await addClientSignerEvidenceV4({
      crypto: state.crypto,
      profile: empty,
      evidence: {
        kind: "agent_runtime_publication",
        evidenceBytes: state.publicationBytes,
        issuingPublicKey: state.manager.publicKey,
      },
    });
    const bytes = encodeClientDeviceProfileV4(retained);
    const restarted = await authenticateClientDeviceProfileV4({
      crypto: state.crypto,
      profileBytes: bytes,
      expectedDeviceId: DEVICE,
    });
    expect(restarted.signerEvidence).toHaveLength(1);
    expect(restarted.signerEvidence[0]).toMatchObject({
      kind: "agent_runtime_publication",
      agentId: "agent-profile-v4",
      managerDeviceId: "device-profile-v4-manager",
    });
    expect(encodeClientDeviceProfileV4(restarted)).toEqual(bytes);

    destroyOpenedClientDeviceProfileV4(restarted);
    destroyOpenedClientDeviceProfileV4(retained);
    destroyOpenedClientDeviceProfileV4(empty);
    bytes.fill(0);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("retains both compared Human device keys through a signed transfer restart", async () => {
    const state = await fixture();
    const empty = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const issuer = state.crypto.generateSigningKeyPair();
    const target = state.crypto.generateSigningKeyPair();
    const targetEncryption = await state.crypto.generateEncryptionKeyPair();
    const human = humanId(COORDINATES.humanActorId);
    const targetDevice = cryptoDeviceId("device-profile-v4-target");
    const issuerDevice = cryptoDeviceId("device-profile-v4-issuer");
    const encryptionDigest = state.crypto.hash(targetEncryption.publicKey);
    const signingDigest = state.crypto.hash(target.publicKey);
    const inventoryDigest = new Uint8Array(32).fill(0x74);
    const unsigned: DeviceTransferApprovalV2 = {
      formatVersion: 2,
      humanId: human,
      targetDeviceId: targetDevice,
      pendingDeviceRevision: pendingDeviceRevisionV2(0),
      encryptionPublicKeyDigest: encryptionDigest,
      signingPublicKeyDigest: signingDigest,
      issuerDeviceId: issuerDevice,
      createdAt: unixTimestamp(10_000),
      inventoryRevision: deviceTransferInventoryRevisionV2(1),
      inventoryCount: 1,
      inventoryDigest,
      packages: [{
        formatVersion: 2,
        humanId: human,
        targetDeviceId: targetDevice,
        pendingDeviceRevision: pendingDeviceRevisionV2(0),
        encryptionPublicKeyDigest: encryptionDigest,
        signingPublicKeyDigest: signingDigest,
        namespaceId: namespaceId("namespace-profile-v4-transfer"),
        keyClass: "ai",
        domainId: cryptoDomainId("domain-profile-v4-transfer"),
        domainEpoch: domainEpoch(0),
        accessRevision: accessRevision(0),
        currentGeneration: namespaceGeneration(0),
        bindingHash: new Uint8Array(32).fill(0x75),
        issuerDeviceId: issuerDevice,
        createdAt: unixTimestamp(10_000),
        ciphertext: new Uint8Array(105).fill(0x76),
      }],
      joinIntents: [{
        formatVersion: 2,
        humanId: human,
        targetDeviceId: targetDevice,
        pendingDeviceRevision: pendingDeviceRevisionV2(0),
        domainId: cryptoDomainId("domain-profile-v4-transfer"),
        domainEpoch: domainEpoch(0),
        committerDeviceId: issuerDevice,
      }],
      signature: new Uint8Array(64),
    };
    const approval: DeviceTransferApprovalV2 = {
      ...unsigned,
      signature: state.crypto.sign(
        issuer.privateKey,
        deviceTransferApprovalSigningBytesV2(unsigned),
      ),
    };
    const approvalBytes = serializeDeviceTransferApprovalV2(approval);
    const retained = await addClientHumanDeviceTransferSignerEvidenceV4({
      crypto: state.crypto,
      profile: empty,
      approvalBytes,
      targetSigningPublicKey: target.publicKey,
      issuerSigningPublicKey: issuer.publicKey,
    });
    const bytes = encodeClientDeviceProfileV4(retained);
    const restarted = await authenticateClientDeviceProfileV4({
      crypto: state.crypto,
      profileBytes: bytes,
      expectedDeviceId: DEVICE,
    });
    withClientObjectAccessSignerResolversV4({
      crypto: state.crypto,
      profile: restarted,
      operation: (resolvers) => {
        expect(resolvers.resolveHistoricalHumanDeviceSigningPublicKey({
          humanId: COORDINATES.humanActorId,
          deviceId: targetDevice,
        })).toEqual(target.publicKey);
        expect(resolvers.resolveHistoricalHumanDeviceSigningPublicKey({
          humanId: COORDINATES.humanActorId,
          deviceId: issuerDevice,
        })).toEqual(issuer.publicKey);
      },
    });

    const wrongIssuer = issuer.publicKey.slice();
    wrongIssuer[0] = wrongIssuer[0]! ^ 1;
    expect(addClientHumanDeviceTransferSignerEvidenceV4({
      crypto: state.crypto,
      profile: empty,
      approvalBytes,
      targetSigningPublicKey: target.publicKey,
      issuerSigningPublicKey: wrongIssuer,
    })).rejects.toThrow("not authentic");

    wrongIssuer.fill(0);
    approvalBytes.fill(0);
    bytes.fill(0);
    destroyOpenedClientDeviceProfileV4(restarted);
    destroyOpenedClientDeviceProfileV4(retained);
    destroyOpenedClientDeviceProfileV4(empty);
    state.v2Bytes.fill(0);
  });

  test("preserves v3 provider snapshots and object anchors exactly", async () => {
    const state = await fixture();
    const v3 = await createClientDeviceProfileV3Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const providerVault = DeviceProviderStateVault.fromKey(
      state.crypto,
      cryptoDeviceId(DEVICE),
      v3.providerStateSealingKey,
    );
    const provider = new OpenMlsGroupProvider(state.crypto, providerVault);
    const providerState = await provider.createInitialState({
      domainId: cryptoDomainId("domain-profile-v4-preserved"),
      humanId: humanId("human-profile-v4-preserved"),
    });
    const providerHead = provider.publicHead(providerState);
    const withProvider = await addClientDomainProviderSnapshot({
      crypto: state.crypto,
      profile: v3,
      snapshot: providerState,
      expectedHead: providerHead,
    });
    const anchor = Object.freeze({
      objectId: objectId("object-profile-v4-preserved"),
      payloadHash: new Uint8Array(32).fill(0x91),
      accessRevision: accessRevision(3),
      manifestHash: new Uint8Array(32).fill(0x92),
    });
    const withAnchor = await updateClientDeviceProfileV3({
      crypto: state.crypto,
      profile: withProvider,
      objectAccessAnchors: [anchor],
    });
    const v3Bytes = encodeClientDeviceProfileV3(withAnchor);
    const v4 = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: v3Bytes,
      expectedDeviceId: DEVICE,
    });
    const withEvidence = await addClientSignerEvidenceV4({
      crypto: state.crypto,
      profile: v4,
      evidence: {
        kind: "agent_runtime_publication",
        evidenceBytes: state.publicationBytes,
        issuingPublicKey: state.manager.publicKey,
      },
    });
    const v4Bytes = encodeClientDeviceProfileV4(withEvidence);
    const restarted = await authenticateClientDeviceProfileV4({
      crypto: state.crypto,
      profileBytes: v4Bytes,
      expectedDeviceId: DEVICE,
    });
    expect(restarted.baseProfile.objectAccessAnchors).toEqual([anchor]);
    expect(restarted.baseProfile.activeProviderSnapshots).toHaveLength(1);
    await withClientDomainRoots({
      crypto: state.crypto,
      profile: restarted.baseProfile,
      expectedHead: providerHead,
      operation: () => undefined,
    });

    destroyOpenedClientDeviceProfileV4(restarted);
    destroyOpenedClientDeviceProfileV4(withEvidence);
    destroyOpenedClientDeviceProfileV4(v4);
    destroyOpenedClientDeviceProfileV3(withAnchor);
    destroyOpenedClientDeviceProfileV3(withProvider);
    destroyOpenedClientDeviceProfileV3(v3);
    providerState.ciphertext.fill(0);
    providerHead.stateHash.fill(0);
    providerVault.destroy();
    v4Bytes.fill(0);
    v3Bytes.fill(0);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("retains the canonical 256-Domain baseline within the profile byte bound", async () => {
    const state = await fixture();
    const v3 = await createClientDeviceProfileV3Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const providerVault = DeviceProviderStateVault.fromKey(
      state.crypto,
      cryptoDeviceId(DEVICE),
      v3.providerStateSealingKey,
    );
    const provider = new OpenMlsGroupProvider(state.crypto, providerVault);
    const snapshots = [] as typeof v3.activeProviderSnapshots[number][];
    try {
      await provider.initialize();
      for (let index = 0; index < 256; index += 1) {
        const domain = cryptoDomainId(
          `domain-profile-v4-capacity-${String(index).padStart(3, "0")}`,
        );
        const sealed = await provider.createInitialState({
          domainId: domain,
          humanId: humanId("human-profile-v4-capacity"),
        });
        const head = provider.publicHead(sealed);
        snapshots.push(Object.freeze({
          providerId: sealed.providerId,
          domainId: sealed.domainId,
          epoch: sealed.revision,
          stateHash: head.stateHash.slice(),
          ciphertext: sealed.ciphertext.slice(),
        }));
        sealed.ciphertext.fill(0);
        head.stateHash.fill(0);
      }
      const v3Bytes = encodeClientDeviceProfileV3(Object.freeze({
        ...v3,
        activeProviderSnapshots: Object.freeze(snapshots),
      }));
      const v4 = await createClientDeviceProfileV4Candidate({
        crypto: state.crypto,
        currentProfileBytes: v3Bytes,
        expectedDeviceId: DEVICE,
      });
      const v4Bytes = encodeClientDeviceProfileV4(v4);
      expect(v4Bytes.length).toBeGreaterThan(1_048_576);
      expect(v4Bytes.length).toBeLessThanOrEqual(
        CLIENT_DEVICE_PROFILE_V4_MAX_BYTES,
      );
      const restarted = await authenticateClientDeviceProfileV4({
        crypto: state.crypto,
        profileBytes: v4Bytes,
        expectedDeviceId: DEVICE,
      });
      expect(restarted.baseProfile.activeProviderSnapshots).toHaveLength(256);

      destroyOpenedClientDeviceProfileV4(restarted);
      destroyOpenedClientDeviceProfileV4(v4);
      v4Bytes.fill(0);
      v3Bytes.fill(0);
    } finally {
      snapshots.forEach((snapshot) => {
        snapshot.stateHash.fill(0);
        snapshot.ciphertext.fill(0);
      });
      providerVault.destroy();
      destroyOpenedClientDeviceProfileV3(v3);
      state.publicationBytes.fill(0);
      state.v2Bytes.fill(0);
    }
  });

  test("rejects evidence substitution and same-coordinate collisions", async () => {
    const state = await fixture();
    const empty = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const retained = await addClientSignerEvidenceV4({
      crypto: state.crypto,
      profile: empty,
      evidence: {
        kind: "agent_runtime_publication",
        evidenceBytes: state.publicationBytes,
        issuingPublicKey: state.manager.publicKey,
      },
    });
    const wrongKey = state.manager.publicKey.slice();
    wrongKey[0] = wrongKey[0]! ^ 1;
    expect(addClientSignerEvidenceV4({
      crypto: state.crypto,
      profile: retained,
      evidence: {
        kind: "agent_runtime_publication",
        evidenceBytes: state.publicationBytes,
        issuingPublicKey: wrongKey,
      },
    })).rejects.toThrow();

    const bytes = encodeClientDeviceProfileV4(retained);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(authenticateClientDeviceProfileV4({
      crypto: state.crypto,
      profileBytes: bytes,
      expectedDeviceId: DEVICE,
    })).rejects.toThrow();

    wrongKey.fill(0);
    bytes.fill(0);
    destroyOpenedClientDeviceProfileV4(retained);
    destroyOpenedClientDeviceProfileV4(empty);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("rejects signer-evidence count and profile-byte overflow", async () => {
    const state = await fixture();
    const empty = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const retained = await addClientSignerEvidenceV4({
      crypto: state.crypto,
      profile: empty,
      evidence: {
        kind: "agent_runtime_publication",
        evidenceBytes: state.publicationBytes,
        issuingPublicKey: state.manager.publicKey,
      },
    });
    const evidence = retained.signerEvidence[0]!;
    expect(() => encodeClientDeviceProfileV4({
      ...retained,
      signerEvidence: Array.from(
        { length: CLIENT_DEVICE_PROFILE_MAX_SIGNER_EVIDENCE + 1 },
        () => evidence,
      ),
    })).toThrow("Client signer evidence inventory exceeds its bound");

    if (evidence.kind !== "agent_runtime_publication") {
      throw new Error("Expected an Agent Runtime signer publication fixture");
    }
    const oversizedEvidence = [0, 1].map((index) => Object.freeze({
      ...evidence,
      agentId: `agent-profile-v4-oversized-${String(index)}`,
      evidenceBytes: new Uint8Array(
        Math.floor(CLIENT_DEVICE_PROFILE_V4_MAX_BYTES / 2) + 1_024,
      ),
    }));
    expect(() => encodeClientDeviceProfileV4({
      ...retained,
      signerEvidence: oversizedEvidence,
    })).toThrow("Client profile v4 exceeds its byte bound");
    oversizedEvidence.forEach((entry) => entry.evidenceBytes.fill(0));

    expect(authenticateClientDeviceProfileV4({
      crypto: state.crypto,
      profileBytes: new Uint8Array(CLIENT_DEVICE_PROFILE_V4_MAX_BYTES + 1),
      expectedDeviceId: DEVICE,
    })).rejects.toThrow("Client profile v4 bytes are invalid");

    destroyOpenedClientDeviceProfileV4(retained);
    destroyOpenedClientDeviceProfileV4(empty);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("retains and re-verifies processor authorization evidence", async () => {
    const state = await fixture();
    const empty = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const issuer = state.crypto.generateSigningKeyPair();
    const signer = state.crypto.generateSigningKeyPair();
    const signerPublic = createProcessorObjectSignerPublicV1(state.crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-profile-v4-auth",
      workDescriptorHash: new Uint8Array(32).fill(0x81),
      signerPrivateKey: signer.privateKey,
    });
    const authorization = createProcessorSignerAuthorizationV1(
      state.crypto,
      {
        formatVersion: PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
        id: "processor-profile-v4-auth",
        processorKind: "stenographer",
        processorVersion: 1,
        workId: "processor-profile-v4-work",
        namespaceId: namespaceId("namespace-profile-v4"),
        domainId: cryptoDomainId("domain-profile-v4"),
        domainEpoch: domainEpoch(2),
        namespaceAccessRevision: accessRevision(3),
        policyRevision: authorizationRevision(4),
        processorAuthorizationRevision: authorizationRevision(5),
        issuingHumanId: humanId("human-profile-v4-issuer"),
        issuingDeviceId: cryptoDeviceId("device-profile-v4-issuer"),
        issuingDeviceAuthorizationRevision: authorizationRevision(6),
        issuerSigningPublicKeyHash: state.crypto.hash(issuer.publicKey),
        signer: signerPublic.principal,
        signerPublicKey: signer.publicKey,
        workDescriptorHash: new Uint8Array(32).fill(0x81),
        credentialHash: new Uint8Array(32).fill(0x82),
        outputObjectIds: [objectId("processor-profile-v4-output")],
        maxOutputObjects: 1,
        maxOutputPlaintextBytes: 4_096,
        maxOutputCiphertextBytes: 8_192,
        issuedAt: 1_000,
        expiresAt: 601_000,
      },
      issuer.privateKey,
    );
    const retained = await addClientSignerEvidenceV4({
      crypto: state.crypto,
      profile: empty,
      evidence: {
        kind: "processor_authorization",
        evidenceBytes: authorization.bytes,
        issuingPublicKey: issuer.publicKey,
      },
    });
    const bytes = encodeClientDeviceProfileV4(retained);
    const restarted = await authenticateClientDeviceProfileV4({
      crypto: state.crypto,
      profileBytes: bytes,
      expectedDeviceId: DEVICE,
    });
    withClientObjectAccessSignerResolversV4({
      crypto: state.crypto,
      profile: restarted,
      operation: (resolvers) => {
        expect(resolvers.resolveProcessorSignerAuthorizationBytes({
          authorizationId: authorization.authorization.id,
          authorizationHash: authorization.hash,
        })).toEqual(authorization.bytes);
        expect(resolvers.resolveHistoricalProcessorIssuingDevicePublicKey({
          ...authorization.authorization,
          purpose: "verify-historical-processor-signer-authorization",
        })).toEqual(issuer.publicKey);
      },
    });

    destroyOpenedClientDeviceProfileV4(restarted);
    destroyOpenedClientDeviceProfileV4(retained);
    destroyOpenedClientDeviceProfileV4(empty);
    bytes.fill(0);
    authorization.bytes.fill(0);
    authorization.hash.fill(0);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });

  test("authenticates the complete candidate before atomic vault activation", async () => {
    const state = await fixture();
    const candidate = await createClientDeviceProfileV4Candidate({
      crypto: state.crypto,
      currentProfileBytes: state.v2Bytes,
      expectedDeviceId: DEVICE,
    });
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await stageAndActivateClientDeviceProfileV4({
      crypto: state.crypto,
      vault,
      coordinates: COORDINATES,
      stageId: "profile-v4-stage",
      generation: 1,
      publicState: {
        clientKind: "browser",
        publicFingerprint: "ab".repeat(32),
      },
      candidate,
    });
    await vault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const opened = await authenticateClientDeviceProfileV4({
        crypto: state.crypto,
        profileBytes,
        expectedDeviceId: DEVICE,
      });
      expect(opened.baseProfile.baseProfile.deviceId).toBe(DEVICE);
      destroyOpenedClientDeviceProfileV4(opened);
    });
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(1);

    destroyOpenedClientDeviceProfileV4(candidate);
    state.publicationBytes.fill(0);
    state.v2Bytes.fill(0);
  });
});
