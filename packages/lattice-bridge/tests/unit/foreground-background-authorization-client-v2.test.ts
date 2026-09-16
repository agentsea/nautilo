import { describe, expect, spyOn, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDomainId,
  encodeHumanDeviceGroupHead,
  humanDeviceGroupHeadDigest,
  humanId,
} from "@nautilo/lattice-crypto";
import { encodeBackgroundWorkDescriptorV2 } from
  "@nautilo/lattice-crypto/background";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import { createForegroundBackgroundAuthorizationClientV2 } from
  "../../src/client/message/foreground-shadow-client-composition.ts";
import { deriveAdditionalDeviceClientIdentity } from
  "../../src/device/additional-device-client.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";

const SERVER_SCOPE = "https://background-authority.test";
const SERVER_INSTANCE_ID = "10000000-0000-4000-8000-000000000317";
const USER_ID = "20000000-0000-4000-8000-000000000317";
const HUMAN_ID = "30000000-0000-4000-8000-000000000317";
const INSTALLATION_ID = "40000000-0000-4000-8000-000000000317";

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

describe("foreground background authorization composition", () => {
  test("accepts current admission and M304 authority only when it matches local V4 state", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    const crypto = new LatticeCrypto(seededRng(31_704));
    const derived = deriveAdditionalDeviceClientIdentity({
      crypto,
      serverScope: SERVER_SCOPE,
      userId: USER_ID,
      humanActorId: HUMAN_ID,
      installationId: INSTALLATION_ID,
      clientKind: "browser",
    });
    const signing = crypto.generateSigningKeyPair();
    const encryption = await crypto.generateEncryptionKeyPair();
    const v2: OpenedClientDeviceProfileV2 = Object.freeze({
      formatVersion: 2,
      deviceId: derived.coordinates.deviceId,
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
    const candidate = await createClientDeviceProfileV4Candidate({
      crypto,
      currentProfileBytes: v2Bytes,
      expectedDeviceId: derived.coordinates.deviceId,
    });
    const stateHash = new Uint8Array(32).fill(0x71);
    const snapshot = Object.freeze({
      providerId: "openmls-v2" as const,
      domainId: "human-device-group:m317",
      epoch: 3,
      stateHash,
      ciphertext: new Uint8Array(96).fill(0x72),
    });
    const profileBytes = encodeClientDeviceProfileV4(Object.freeze({
      ...candidate,
      humanDeviceGroupSnapshot: snapshot,
    }));
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await vault.stageProfile({
      coordinates: derived.coordinates,
      stageId: "background-authority-profile",
      generation: 1,
      profileBytes,
      publicState: {clientKind: "browser", publicFingerprint: "31".repeat(32)},
    });
    await vault.activateProfile(
      derived.coordinates,
      "background-authority-profile",
    );

    const head = Object.freeze({
      formatVersion: 1 as const,
      providerId: "openmls-human-device-v1" as const,
      serverInstanceId: SERVER_INSTANCE_ID,
      humanId: humanId(HUMAN_ID),
      lineageGeneration: 2,
      groupId: cryptoDomainId(snapshot.domainId),
      epoch: snapshot.epoch,
      stateHash: stateHash.slice(),
      rosterDigest: new Uint8Array(32).fill(0x73),
      previousHeadDigest: null,
      securityRevision: 4,
    });
    const headBytes = encodeHumanDeviceGroupHead(head);
    const headDigest = humanDeviceGroupHeadDigest(crypto, head);
    const descriptorBytes = encodeBackgroundWorkDescriptorV2({
      formatVersion: 2,
      requestId: "request-m317",
      recipientGeneration: 0,
      workKind: "stenographer.extraction",
      workId: "work-m317",
      anchorNamespaceId: "60000000-0000-4000-8000-000000000317",
      anchorDomainId: "domain-m317",
      subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
      operations: ["decrypt", "encrypt"],
      purpose: "journal.extract",
      authority: {
        serverId: SERVER_SCOPE,
        roomId: "50000000-0000-4000-8000-000000000317",
        namespaceId: "60000000-0000-4000-8000-000000000317",
        namespaceAccessRevision: 2,
        namespaceKeyGeneration: 1,
        namespaceHeadDigest: new Uint8Array(32).fill(1),
        domainId: "domain-m317",
        domainKeyGeneration: 3,
        domainAuthorizationRevision: 4,
        domainHeadDigest: new Uint8Array(32).fill(2),
        bundleRevision: 5,
        bundleDigest: new Uint8Array(32).fill(3),
      },
      policyRevision: 9,
      source: {kind: "stenographer_work", startSequence: 10, endSequence: 12, rebuildGeneration: 0,
        fingerprint: new Uint8Array(32).fill(4)},
      inputBindings: [{objectId: "message-10", namespaceId: "60000000-0000-4000-8000-000000000317"}],
      outputSlots: [{objectId: "record-1",
        objectType: "nautilo.reflection.record.v1", createdAt: 1_000,
        namespaceIds: ["60000000-0000-4000-8000-000000000317"]}],
      maximumPlaintextBytes: 512 * 1_024,
      maximumCiphertextBytes: 1_024 * 1_024 + 40,
      recipientKeyId: "recipient-1",
      recipientPublicKey: encryption.publicKey,
      issuedAt: 900,
      notBefore: 900,
      expiresAt: 2_000,
      idempotencyId: "idempotency-m317",
    });
    let rosterDigest = headDigest;
    let admissionGeneration = 5;
    let domainAuthorityCalls = 0;
    const calls: string[] = [];
    const api = {
      admin: {encryptionTransition: {getPolicy: async () => {
        calls.push("policy");
        return {policy: {mode: "encrypted_only", shadowBehavior: "strict",
          revision: 9, updatedAt: "2026-09-10T00:00:00.000Z"}};
      }}},
      deviceAdmission: {status: async () => {
        calls.push("admission");
        return {responseVersion: 1, required: true, status: "admitted",
          deviceId: derived.coordinates.deviceId,
          deviceGeneration: admissionGeneration, expiresAt: 2_000};
      }},
      loadHumanDeviceMembership: async () => {
        calls.push("membership");
        return {formatVersion: 1, serverInstanceId: SERVER_INSTANCE_ID,
          humanId: HUMAN_ID, deviceId: derived.coordinates.deviceId,
          deviceGeneration: 5, deviceRevision: 7, membershipState: "current",
          personalAuthority: null,
          head: {headBytesBase64url: base64url(headBytes), sequence: 8},
          welcome: null, targetJoin: null, commits: [], nextSequence: null};
      },
      listHumanDeviceMembershipRoster: async () => {
        calls.push("roster");
        return {formatVersion: 1, currentDeviceId: derived.coordinates.deviceId,
          currentMemberCount: 1, devices: [{
            deviceId: derived.coordinates.deviceId, clientKind: "browser",
            deviceGeneration: 5, deviceRevision: 7,
            membershipState: "current", isCurrentDevice: true, canRemove: false,
            publicFingerprintBase64url: "MQ",
            membershipEvidence: {lineageGeneration: 2, epoch: 3,
              securityRevision: 4, acknowledgedSequence: 8,
              headDigestBase64url: base64url(rosterDigest)},
            admissionEvidence: {lastProvedAt: 900, expiresAt: 2_000},
            domainKeyCoverage: {acknowledged: 0, required: 0},
            deliveryEvidence: {acknowledgedSequence: 0, highWatermark: 0,
              blocked: null},
          }]};
      },
      listBackgroundAuthorizationRequests: async () => ({
        responseVersion: 1,
        requests: [{requestBytesBase64url: base64url(descriptorBytes)}],
      }),
      respondBackgroundAuthorizationRequest: async () => {
        throw new Error("malformed descriptor must not be submitted");
      },
      planDomainKeyAuthorityV2: async () => {
        domainAuthorityCalls += 1;
        throw new Error("authority intentionally unavailable after inspection");
      },
      publishDomainKeyAuthorityV2: async () => { throw new Error("unexpected"); },
      requestDomainKeyRecipientV2: async () => {
        domainAuthorityCalls += 1;
        throw new Error("authority intentionally unavailable after inspection");
      },
      listPendingDomainKeyRequestsV2: async () => { throw new Error("unexpected"); },
      fulfilDomainKeyRecipientV2: async () => { throw new Error("unexpected"); },
      fetchDomainKeyEnvelopeV2: async () => { throw new Error("unexpected"); },
      acknowledgeDomainKeyEnvelopeV2: async () => { throw new Error("unexpected"); },
      planDomainNamespaceBundleV2: async () => { throw new Error("unexpected"); },
      publishDomainNamespaceBundleV2: async () => { throw new Error("unexpected"); },
    };
    const client = createForegroundBackgroundAuthorizationClientV2({
      clientKind: "browser",
      createProfileVault: () => vault,
      createNamespaceGenerationCacheVault: () => ({
        availability: async () => ({status: "available"}),
        unlock: async () => ({status: "available"}),
        lock: async () => undefined,
        withEntries: async () => ({status: "miss"}),
        putEntries: async () => undefined,
        stagePublication: async () => undefined,
        withPendingPublication: async () => ({status: "absent"}),
        activatePublication: async () => undefined,
        abortPublication: async () => undefined,
        evict: async () => undefined,
        forget: async () => undefined,
      }) as never,
      createId: () => "m317-id",
    }, {
      api: api as never,
      crypto,
      serverScope: SERVER_SCOPE,
      userId: USER_ID,
      humanActorId: HUMAN_ID,
      installationId: INSTALLATION_ID,
      now: () => 1_000,
    });

    const currentResult = await client.service();
    expect(currentResult).toMatchObject({
      status: "complete", discovered: 1, deferred: 1, stale: 0,
    });
    expect(calls).toEqual(["policy", "admission", "membership", "roster"]);
    expect(domainAuthorityCalls).toBeGreaterThan(0);
    expect(warning).toHaveBeenCalledTimes(1);

    calls.length = 0;
    domainAuthorityCalls = 0;
    rosterDigest = new Uint8Array(32).fill(0xff);
    expect(await client.service()).toMatchObject({
      status: "complete", discovered: 1, deferred: 1, stale: 0,
    });
    expect(calls).toEqual(["policy", "admission", "membership", "roster"]);
    expect(domainAuthorityCalls).toBe(0);

    calls.length = 0;
    domainAuthorityCalls = 0;
    rosterDigest = headDigest;
    admissionGeneration = 6;
    expect(await client.service()).toMatchObject({
      status: "complete", discovered: 1, deferred: 1, stale: 0,
    });
    expect(calls).toEqual(["policy", "admission", "membership", "roster"]);
    expect(domainAuthorityCalls).toBe(0);

    destroyOpenedClientDeviceProfileV4(candidate);
    v2Bytes.fill(0);
    profileBytes.fill(0);
    headBytes.fill(0);
    headDigest.fill(0);
    descriptorBytes.fill(0);
    stateHash.fill(0);
    warning.mockRestore();
  });
});
