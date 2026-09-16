import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  openDomainKeyRecipientEnvelope,
  prepareDomainKeyHead,
  prepareDomainKeyRecipientEnvelope,
  verifyDomainKeyHead,
} from "@nautilo/lattice-crypto";
import {
  decodeDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyHeadV2,
  destroyDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyRecipientEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import { ApiError } from "@nautilo/api-client/browser";

import {
  createClientDomainKeyCacheVaultV2,
} from "../../src/client-vault/domain-key-cache-v2.ts";
import { MemoryClientNamespaceGenerationCacheVaultV1 } from
  "../../src/client-vault/namespace-generation-cache-v1.ts";
import {
  createClientDeviceProfileV3Candidate,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
} from "../../src/client-vault/profile-v3.ts";
import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  stageAndActivateClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import type { ClientProfileCoordinates } from
  "../../src/client-vault/types.ts";
import {
  createDomainKeyAuthorityClientV2,
  type DomainKeyAuthorityClientV2,
} from "../../src/client/message/domain-key-authority-client.ts";
import {
  createDomainNamespaceAuthorityClientV2,
  type OpenedDomainNamespaceAuthorityV2,
} from "../../src/client/message/domain-namespace-authority-client.ts";
import { createDomainNamespaceAuthorityAdapterV2 } from
  "../../src/client/message/domain-namespace-authority-adapter.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";

const NOW = 1_800_100_000_000;
const SERVER = "https://m301.example";
const ROOM = "a1000000-0000-4000-8000-000000000001";
const NAMESPACE = "a1000000-0000-4000-8000-000000000002";
const DOMAIN = "domain:m301:alice-bob";
const ALICE = "a1000000-0000-4000-8000-000000000003";
const BOB = "a1000000-0000-4000-8000-000000000004";
const PARTICIPANT_DIGEST = new Uint8Array(32).fill(0x31);

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

async function createDevice(
  crypto: LatticeCrypto,
  humanActorId: string,
  deviceId: string,
) {
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const coordinates: ClientProfileCoordinates = Object.freeze({
    serverScope: SERVER,
    userId: humanActorId,
    humanActorId,
    profileId: `profile:${deviceId}`,
    deviceId,
    installationLineageDigest: "a1".repeat(32),
  });
  const profileV2: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 1,
    trustedHostAuthorizationRevision: 1,
    deliveryHighWatermark: 0,
    keyringDeliveries: Object.freeze([]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(profileV2);
  const v3 = await createClientDeviceProfileV3Candidate({
    crypto,
    currentProfileBytes: v2Bytes,
    expectedDeviceId: deviceId,
  });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({
    crypto,
    currentProfileBytes: v3Bytes,
    expectedDeviceId: deviceId,
  });
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await stageAndActivateClientDeviceProfileV4({
    crypto,
    vault,
    coordinates,
    stageId: `stage:${deviceId}`,
    generation: 1,
    publicState: {
      clientKind: "browser",
      publicFingerprint: "b1".repeat(32),
    },
    candidate: v4,
  });
  destroyOpenedClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV3(v3);
  v2Bytes.fill(0);
  v3Bytes.fill(0);
  return Object.freeze({
    humanActorId,
    deviceId,
    coordinates,
    signingPublicKey: signing.publicKey.slice(),
    signingPrivateKey: signing.privateKey.slice(),
    encryptionPublicKey: encryption.publicKey.slice(),
    encryptionPrivateKey: encryption.privateKey.slice(),
    vault,
  });
}

type AuthorityApi = Parameters<
  typeof createDomainKeyAuthorityClientV2
>[0]["api"];

describe("M301 V2 Domain-key authority client", () => {
  test("classifies a rejected source-head lookup without wedging backlog service", async () => {
    const diagnostics: Array<Readonly<{ stage: string; reason: string }>> = [];
    const repairs: string[] = [];
    const cache = new MemoryClientNamespaceGenerationCacheVaultV1();
    const client = createDomainKeyAuthorityClientV2({
      api: {
        planDomainKeyAuthorityV2: () => Promise.reject(
          new ApiError(403, "private transport detail"),
        ),
        listPendingDomainKeySourceWorkV2: () => Promise.resolve({
          responseVersion: 2 as const,
          work: [{
            sourceRoomId: ROOM,
            namespaceId: NAMESPACE,
            keyClass: "ai" as const,
          }],
        }),
      } as unknown as AuthorityApi,
      crypto: new LatticeCrypto(seededRng(301_000)),
      vault: new MemoryClientProfileVault(),
      cache: createClientDomainKeyCacheVaultV2(cache),
      coordinates: Object.freeze({
        serverScope: SERVER,
        userId: ALICE,
        humanActorId: ALICE,
        profileId: "profile:m301:head-failure",
        deviceId: "device:m301:head-failure",
        installationLineageDigest: "a1".repeat(32),
      }),
      serverId: SERVER,
      now: () => NOW,
      createId: () => "operation:m301:head-failure",
      onBacklogCoordinate: (request) => {
        repairs.push([
          request.sourceRoomId,
          request.namespaceId,
          request.keyClass,
        ].join("/"));
        return Promise.resolve();
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(await client.serviceBacklog?.()).toEqual({
      status: "ready",
      coordinates: 1,
      fulfilled: 0,
    });
    expect(diagnostics).toEqual([{
      stage: "fulfil",
      reason: "head_authorization_denied",
    }]);
    expect(repairs).toEqual([`${ROOM}/${NAMESPACE}/ai`]);
  });

  test("retries authority drift during backlog discovery without reconnecting", async () => {
    const scheduled: Array<Readonly<{
      task: () => Promise<void>;
      delayMs: number;
    }>> = [];
    const serviced: string[] = [];
    const repairs: string[] = [];
    let discoveryCalls = 0;
    const cache = new MemoryClientNamespaceGenerationCacheVaultV1();
    const client = createDomainKeyAuthorityClientV2({
      api: {
        planDomainKeyAuthorityV2: (roomId: string, namespaceId: string) => {
          serviced.push([roomId, namespaceId].join("/"));
          return Promise.reject(new ApiError(403, "not a key source"));
        },
        listPendingDomainKeySourceWorkV2: () => {
          discoveryCalls += 1;
          if (discoveryCalls === 1) {
            return Promise.reject(new ApiError(503, "authority_changed"));
          }
          return Promise.resolve({
            responseVersion: 2 as const,
            work: discoveryCalls === 2
              ? [{
                  sourceRoomId: ROOM,
                  namespaceId: NAMESPACE,
                  keyClass: "ai" as const,
                }]
              : [],
          });
        },
      } as unknown as AuthorityApi,
      crypto: new LatticeCrypto(seededRng(301_000_1)),
      vault: new MemoryClientProfileVault(),
      cache: createClientDomainKeyCacheVaultV2(cache),
      coordinates: Object.freeze({
        serverScope: SERVER,
        userId: ALICE,
        humanActorId: ALICE,
        profileId: "profile:m314:authority-drift",
        deviceId: "device:m314:authority-drift",
        installationLineageDigest: "a1".repeat(32),
      }),
      serverId: SERVER,
      now: () => NOW,
      createId: () => "operation:m314:authority-drift",
      scheduleRetry: (task, delayMs) => {
        scheduled.push(Object.freeze({ task, delayMs }));
      },
      onBacklogCoordinate: (request) => {
        repairs.push([
          request.sourceRoomId,
          request.namespaceId,
          request.keyClass,
        ].join("/"));
        return Promise.resolve();
      },
    });

    expect(await client.serviceBacklog?.()).toEqual({
      status: "unavailable",
      reason: "backlog_request_failed",
    });
    expect(discoveryCalls).toBe(1);
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([1_000]);

    const driftRetry = scheduled.shift();
    expect(driftRetry).toBeDefined();
    await driftRetry!.task();
    expect(discoveryCalls).toBe(2);
    expect(serviced).toEqual([`${ROOM}/${NAMESPACE}`]);
    expect(repairs).toEqual([`${ROOM}/${NAMESPACE}/ai`]);
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([1_000]);

    const drainRetry = scheduled.shift();
    expect(drainRetry).toBeDefined();
    await drainRetry!.task();
    expect(discoveryCalls).toBe(3);
    expect(scheduled).toEqual([]);
  });

  test("reconnects an offline historical source through newcomer key delivery and retained bundle repair", async () => {
    const crypto = new LatticeCrypto(seededRng(301_001));
    const alice = await createDevice(crypto, ALICE, "device:m301:alice");
    const bob = await createDevice(crypto, BOB, "device:m301:bob");
    const recoveredAlice = await createDevice(
      crypto,
      ALICE,
      "device:m305:alice-recovered",
    );
    const recovery = await crypto.generateEncryptionKeyPair();
    const recoveryKeyId = "recovery:m301:alice";
    let activeDomain = DOMAIN;
    let activeParticipantDigest = PARTICIPANT_DIGEST;
    let activeParticipantCount = 2;
    let transitioning = false;
    let replacementPublished = false;
    const bundleRepair: { current?: (device: typeof alice) => Promise<void> } = {};
    const devices = new Map([
      [alice.deviceId, alice],
      [bob.deviceId, bob],
      [recoveredAlice.deviceId, recoveredAlice],
    ]);
    let headBytes: Uint8Array | null = null;
    let headDigest: Uint8Array | null = null;
    let issuerSigningPublicKey: Uint8Array | null = null;
    let recoveryEnvelopeBytes: Uint8Array | null = null;
    const envelopes = new Map<string, Readonly<{
      envelopeBytes: Uint8Array;
      envelopeDigest: Uint8Array;
      issuerSigningPublicKey: Uint8Array;
      requestDigest: Uint8Array | null;
    }>>();
    const pending = new Map<string, Readonly<{
      requestId: string;
      requestBytes: Uint8Array;
      requestDigest: Uint8Array;
      device: typeof bob;
    }>>();
    let acknowledgements = 0;
    const api: AuthorityApi = Object.freeze({
      planDomainKeyAuthorityV2: (_roomId, _namespaceId, request) => {
        const device = devices.get(request.clientDeviceId)!;
        if (headBytes === null || headDigest === null
          || issuerSigningPublicKey === null) {
          const recipientDigest = crypto.hash(device.encryptionPublicKey);
          const recoveryDigest = crypto.hash(recovery.publicKey);
          const response = {
            responseVersion: 2 as const,
            status: "create_required" as const,
            domainId: activeDomain,
            participantDigestBase64url: b64(activeParticipantDigest),
            participantCount: activeParticipantCount,
            keyClass: request.keyClass,
            domainKeyGeneration: 1 as const,
            authorizationRevision: 1 as const,
            previousHeadDigestBase64url: null,
            issuerHumanId: device.humanActorId,
            issuerDeviceId: device.deviceId,
            issuerDeviceSigningGeneration: 1,
            issuerSigningPublicKeyBase64url: b64(device.signingPublicKey),
            recipientEncryptionPublicKeyBase64url:
              b64(device.encryptionPublicKey),
            recipientPublicKeyDigestBase64url: b64(recipientDigest),
            recoveryKeyId,
            recoveryKeyGeneration: 1,
            recoveryPublicKeyBase64url: b64(recovery.publicKey),
            recoveryPublicKeyDigestBase64url: b64(recoveryDigest),
            issuedAt: NOW,
            deadlineAt: NOW + 30_000,
          };
          recipientDigest.fill(0);
          recoveryDigest.fill(0);
          return Promise.resolve(response);
        }
        return Promise.resolve({
          responseVersion: 2 as const,
          status: "ready" as const,
          domainId: activeDomain,
          participantDigestBase64url: b64(activeParticipantDigest),
          participantCount: activeParticipantCount,
          keyClass: request.keyClass,
          domainKeyGeneration: 1,
          authorizationRevision: 1,
          headDigestBase64url: b64(headDigest),
          headBytesBase64url: b64(headBytes),
          issuerSigningPublicKeyBase64url: b64(issuerSigningPublicKey),
          recipientDeviceSigningGeneration: 1,
          recipientDeviceRevision: 1,
          recipientEnvelope: null,
        });
      },
      publishDomainKeyAuthorityV2: (
        _roomId,
        _namespaceId,
        request,
      ) => {
        headBytes = bytes(request.headBytesBase64url);
        headDigest = crypto.hash(headBytes);
        const device = devices.get(request.clientDeviceId)!;
        issuerSigningPublicKey = device.signingPublicKey.slice();
        const verified = verifyDomainKeyHead(crypto, {
          headBytes,
          issuerSigningPublicKey,
          expectedHeadDigest: headDigest,
          now: NOW,
        });
        expect(verified?.cryptoDomainId).toBe(cryptoDomainId(activeDomain));
        if (verified !== null) destroyDomainKeyHeadV2(verified);
        const envelopeBytes = bytes(request.envelopeBytesBase64url);
        const envelopeDigest = crypto.hash(envelopeBytes);
        recoveryEnvelopeBytes = bytes(request.recoveryEnvelopeBytesBase64url);
        const recoveryEnvelopeDigest = crypto.hash(recoveryEnvelopeBytes);
        envelopes.set(device.deviceId, Object.freeze({
          envelopeBytes,
          envelopeDigest,
          issuerSigningPublicKey: device.signingPublicKey.slice(),
          requestDigest: null,
        }));
        return Promise.resolve({
          responseVersion: 2 as const,
          status: "published" as const,
          operationId: request.operationId,
          domainId: activeDomain,
          keyClass: request.keyClass,
          domainKeyGeneration: 1,
          authorizationRevision: 1,
          headDigestBase64url: b64(headDigest),
          envelopeDigestBase64url: b64(envelopeDigest),
          recoveryEnvelopeDigestBase64url: b64(recoveryEnvelopeDigest),
        });
      },
      fetchDomainKeyEnvelopeV2: (_roomId, _namespaceId, request) => {
        if (request.recipientKind === "recovery") {
          const digest = recoveryEnvelopeBytes === null
            ? null
            : crypto.hash(recoveryEnvelopeBytes);
          const response = recoveryEnvelopeBytes === null || digest === null
            ? { responseVersion: 2 as const, status: "unavailable" as const }
            : {
                responseVersion: 2 as const,
                status: "ready" as const,
                requestDigestBase64url: null,
                envelopeBytesBase64url: b64(recoveryEnvelopeBytes),
                envelopeDigestBase64url: b64(digest),
                issuerSigningPublicKeyBase64url:
                  b64(issuerSigningPublicKey!),
              };
          digest?.fill(0);
          return Promise.resolve(response);
        }
        const envelope = envelopes.get(request.clientDeviceId);
        return Promise.resolve(envelope === undefined
          ? { responseVersion: 2 as const, status: "unavailable" as const }
          : {
              responseVersion: 2 as const,
              status: "ready" as const,
              requestDigestBase64url: envelope.requestDigest === null
                ? null
                : b64(envelope.requestDigest),
              envelopeBytesBase64url: b64(envelope.envelopeBytes),
              envelopeDigestBase64url: b64(envelope.envelopeDigest),
              issuerSigningPublicKeyBase64url:
                b64(envelope.issuerSigningPublicKey),
            });
      },
      requestDomainKeyRecipientV2: (
        _roomId,
        _namespaceId,
        request,
      ) => {
        const requestBytes = bytes(request.requestBytesBase64url);
        const requestDigest = crypto.hash(requestBytes);
        const existing = pending.get(request.clientDeviceId);
        if (existing === undefined) {
          pending.set(request.clientDeviceId, Object.freeze({
            requestId: request.requestId,
            requestBytes,
            requestDigest,
            device: devices.get(request.clientDeviceId)!,
          }));
        } else {
          requestBytes.fill(0);
          requestDigest.fill(0);
        }
        const selected = pending.get(request.clientDeviceId)!;
        return Promise.resolve({
          responseVersion: 2 as const,
          status: existing === undefined ? "requested" as const : "replayed" as const,
          requestId: selected.requestId,
          requestDigestBase64url: b64(selected.requestDigest),
        });
      },
      listPendingDomainKeyRequestsV2: () => Promise.resolve({
        responseVersion: 2 as const,
        requests: [...pending.values()].map((entry) => {
          const digest = crypto.hash(entry.device.encryptionPublicKey);
          const value = {
            requestId: entry.requestId,
            requestBytesBase64url: b64(entry.requestBytes),
            requestDigestBase64url: b64(entry.requestDigest),
            domainId: activeDomain,
            keyClass: "ai" as const,
            domainKeyGeneration: 1,
            authorizationRevision: 1,
            headDigestBase64url: b64(headDigest!),
            recipientHumanId: entry.device.humanActorId,
            recipientDeviceId: entry.device.deviceId,
            recipientDeviceGeneration: 1,
            recipientSigningPublicKeyBase64url:
              b64(entry.device.signingPublicKey),
            recipientEncryptionPublicKeyBase64url:
              b64(entry.device.encryptionPublicKey),
            recipientPublicKeyDigestBase64url: b64(digest),
          };
          digest.fill(0);
          return value;
        }),
      }),
      listPendingDomainKeySourceWorkV2: () => Promise.resolve({
        responseVersion: 2 as const,
        work: pending.size === 0 && !(transitioning && !replacementPublished) ? [] : [{
          sourceRoomId: ROOM,
          namespaceId: NAMESPACE,
          keyClass: "ai" as const,
        }],
      }),
      fulfilDomainKeyRecipientV2: (
        _roomId,
        _namespaceId,
        request,
      ) => {
        const pendingRequest = [...pending.values()].find(
          (entry) => entry.requestId === request.requestId,
        )!;
        const authorizationBytes = bytes(
          request.authorizationBytesBase64url,
        );
        const authorization = decodeDomainKeyRecipientAuthorizationV2(
          authorizationBytes,
        );
        const envelopeBytes = authorization.envelopeBytes.slice();
        const envelopeDigest = crypto.hash(envelopeBytes);
        const authorizationDigest = crypto.hash(authorizationBytes);
        const source = devices.get(request.clientDeviceId)!;
        envelopes.set(pendingRequest.device.deviceId, Object.freeze({
          envelopeBytes,
          envelopeDigest: envelopeDigest.slice(),
          issuerSigningPublicKey: source.signingPublicKey.slice(),
          requestDigest: pendingRequest.requestDigest.slice(),
        }));
        pending.delete(pendingRequest.device.deviceId);
        destroyDomainKeyRecipientAuthorizationV2(authorization);
        authorizationBytes.fill(0);
        return Promise.resolve({
          responseVersion: 2 as const,
          status: "fulfilled" as const,
          requestId: request.requestId,
          envelopeDigestBase64url: b64(envelopeDigest),
          authorizationDigestBase64url: b64(authorizationDigest),
        });
      },
      acknowledgeDomainKeyEnvelopeV2: () => {
        acknowledgements++;
        const digest = new Uint8Array(32).fill(0x66);
        return Promise.resolve({
          responseVersion: 2 as const,
          status: "acknowledged" as const,
          acknowledgementDigestBase64url: b64(digest),
        });
      },
      planDomainNamespaceBundleV2: () => Promise.reject(
        new Error("not used by Domain-key delivery"),
      ),
      publishDomainNamespaceBundleV2: () => Promise.reject(
        new Error("not used by Domain-key delivery"),
      ),
    });
    let nextId = 0;
    const scheduled: Array<() => Promise<void>> = [];
    const bundleRepairs: string[] = [];
    const client = (
      device: typeof alice,
      retry = false,
      repair = false,
    ) => {
      const sealedCache = new MemoryClientNamespaceGenerationCacheVaultV1();
      void sealedCache.lock();
      return createDomainKeyAuthorityClientV2({
        api,
        crypto,
        vault: device.vault,
        cache: createClientDomainKeyCacheVaultV2(sealedCache),
        coordinates: device.coordinates,
        serverId: SERVER,
        now: () => NOW,
        createId: () => `operation:m301:${++nextId}`,
        ...(repair
          ? {
              onBacklogCoordinate: (request: Readonly<{
                sourceRoomId: string;
                namespaceId: string;
                keyClass: "human" | "ai";
              }>) => {
                if (bundleRepair.current !== undefined) return bundleRepair.current(device);
                // The repair callback must observe real catch-up delivery,
                // rather than a fixture that gave both peers the key upfront.
                expect(pending.size).toBe(0);
                expect(envelopes.has(bob.deviceId)).toBeTrue();
                bundleRepairs.push(request.keyClass);
                return Promise.resolve();
              },
            }
          : {}),
        ...(retry
          ? {
              scheduleRetry: (task: () => Promise<void>) => {
                scheduled.push(task);
              },
            }
          : {}),
      });
    };
    const aliceClient = client(alice, false, true);
    const bobClient = client(bob, true);
    const recoveredAliceClient = client(recoveredAlice);

    expect(await aliceClient.ensure({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
    })).toEqual({ status: "ready" });
    expect(recoveryEnvelopeBytes).not.toBeNull();
    const openedRecovery = await openDomainKeyRecipientEnvelope(crypto, {
      envelopeBytes: recoveryEnvelopeBytes!,
      issuerSigningPublicKey: alice.signingPublicKey,
      recipientHumanId: humanId(ALICE),
      recipientKind: "recovery",
      recipientKeyId: recoveryKeyId,
      recipientKeyGeneration: 1,
      recipientPrivateKey: recovery.privateKey,
    });
    expect(openedRecovery?.domainKey).toHaveLength(32);
    if (openedRecovery !== null) {
      destroyDomainKeyRecipientEnvelopeV2(openedRecovery.envelope);
      openedRecovery.envelopeDigest.fill(0);
      openedRecovery.domainKey.fill(0);
    }
    expect(await recoveredAliceClient.recover?.({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
    }, {
      keyId: recoveryKeyId,
      generation: 1,
      publicKey: recovery.publicKey,
      privateKey: recovery.privateKey,
    })).toEqual({ status: "ready" });
    expect(envelopes.has(recoveredAlice.deviceId)).toBeTrue();
    expect(await bobClient.ensure({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
    })).toEqual({ status: "pending", reason: "source_required" });
    expect(pending.size).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(await aliceClient.serviceBacklog?.()).toEqual({
      status: "ready",
      coordinates: 1,
      fulfilled: 1,
    });
    expect(pending.size).toBe(0);
    expect(bundleRepairs).toEqual(["ai"]);
    await scheduled.shift()!();
    expect(await bobClient.ensure({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
    })).toEqual({ status: "ready" });
    expect(acknowledgements).toBe(1);


    // Compose the actual Domain delivery clients with native Namespace bundle
    // replacement. Alice goes offline with history under the old Domain; Bob
    // establishes the new Domain while she is away. Neither client receives
    // the other Domain's key by fixture injection.
    let bundleBytes: Uint8Array | null = null;
    let bundleDigest: Uint8Array | null = null;
    let oldBundleBytes: Uint8Array | null = null;
    let oldBundleDigest: Uint8Array | null = null;
    const oldEnvelope = envelopes.get(alice.deviceId)!;
    const namespaceApi: Parameters<typeof createDomainNamespaceAuthorityClientV2>[0]["api"] = {
      planDomainNamespaceBundleV2: async (_room, _namespace, request) => {
        if (transitioning && !replacementPublished && request.clientDeviceId !== alice.deviceId) {
          return { responseVersion: 2, status: "unavailable", reason: "recipient_sync_required" };
        }
        if (bundleBytes !== null && (!transitioning || replacementPublished)) {
          return {
            responseVersion: 2, status: "ready", domainId: activeDomain, keyClass: "ai",
            bindingBytesBase64url: b64(bundleBytes), bindingDigestBase64url: b64(bundleDigest!),
            issuerSigningPublicKeyBase64url: b64(alice.signingPublicKey),
          };
        }
        const base = {
          responseVersion: 2 as const, domainId: activeDomain,
          participantDigestBase64url: b64(activeParticipantDigest), participantCount: activeParticipantCount,
          keyClass: "ai" as const, domainKeyGeneration: 1, domainAuthorizationRevision: 1,
          domainHeadDigestBase64url: b64(headDigest!), namespaceId: NAMESPACE,
          issuerHumanId: ALICE, issuerDeviceId: alice.deviceId,
          issuerDeviceSigningGeneration: 1,
          issuerSigningPublicKeyBase64url: b64(alice.signingPublicKey),
        };
        return transitioning ? {
          ...base, status: "replace_required" as const, namespaceAccessRevision: 2,
          namespaceCurrentGeneration: 1, bundleRevision: 2, retainedGenerationCount: 2,
          advanceGeneration: true, previousBindingDigestBase64url: b64(oldBundleDigest!),
          sourceBindingBytesBase64url: b64(oldBundleBytes!),
          sourceBindingDigestBase64url: b64(oldBundleDigest!),
          sourceIssuerSigningPublicKeyBase64url: b64(alice.signingPublicKey),
          sourceEnvelopeBytesBase64url: b64(oldEnvelope.envelopeBytes),
          sourceEnvelopeDigestBase64url: b64(oldEnvelope.envelopeDigest),
          sourceEnvelopeIssuerSigningPublicKeyBase64url: b64(oldEnvelope.issuerSigningPublicKey),
          sourceRecipientDeviceSigningGeneration: 1,
        } : {
          ...base, status: "create_required" as const, namespaceAccessRevision: 1,
          namespaceCurrentGeneration: 0, bundleRevision: 1, retainedGenerationCount: 1,
          previousBindingDigestBase64url: null,
        };
      },
      publishDomainNamespaceBundleV2: async (_room, _namespace, request) => {
        bundleBytes = bytes(request.bindingBytesBase64url);
        bundleDigest = crypto.hash(bundleBytes);
        if (transitioning) replacementPublished = true;
        return {
          responseVersion: 2, status: "published", operationId: request.operationId,
          namespaceId: NAMESPACE, domainId: activeDomain, keyClass: "ai",
          bindingDigestBase64url: b64(bundleDigest),
        };
      },
    };
    const request = { sourceRoomId: ROOM, namespaceId: NAMESPACE, keyClass: "ai" as const };
    const namespaceClient = (device: typeof alice, domainAuthority: DomainKeyAuthorityClientV2) =>
      createDomainNamespaceAuthorityClientV2({
        api: namespaceApi, crypto, vault: device.vault, coordinates: device.coordinates,
        domainAuthority, serverId: SERVER, now: () => NOW,
        createId: () => `bundle:reconnect:${++nextId}`,
      });
    const beforeDisconnect = namespaceClient(alice, aliceClient);
    expect(await beforeDisconnect.ensure(request)).toEqual({ status: "ready" });
    const historical = await beforeDisconnect.withOpenedGenerations(request,
      (entries) => entries.map((entry) => entry.generationKey.slice()));
    if (historical.status !== "opened") throw new Error("Initial history did not open");
    oldBundleBytes = bundleBytes!.slice();
    oldBundleDigest = bundleDigest!.slice();

    // Membership has advanced while Alice is offline. The server retains the
    // old envelope only as the qualified-source plan; Bob never receives it.
    activeDomain = `${DOMAIN}:new-membership`;
    transitioning = true;
    headBytes = null;
    headDigest = null;
    issuerSigningPublicKey = null;
    envelopes.clear();
    activeParticipantDigest = new Uint8Array(32).fill(0x44);
    activeParticipantCount = 3;
    const newcomerDevice = await createDevice(crypto,
      "a1000000-0000-4000-8000-000000000005", "device:m320:newcomer");
    devices.set(newcomerDevice.deviceId, newcomerDevice);
    const newcomer = client(newcomerDevice, false, true);
    expect(await newcomer.ensure(request)).toEqual({ status: "ready" });
    expect(envelopes.has(alice.deviceId)).toBeFalse();
    const newcomerNamespace = namespaceClient(newcomerDevice, newcomer);
    expect(await newcomerNamespace.ensure(request)).toEqual({
      status: "pending", reason: "qualified_source_required",
    });

    // Reconnecting uses a fresh cache, not the old process's cached Domain key.
    const returning = client(alice, false, true);
    const returningNamespace = namespaceClient(alice, returning);
    bundleRepair.current = async (device) => {
      await (device.deviceId === alice.deviceId ? returningNamespace : newcomerNamespace).ensure(request);
    };
    expect(pending.size).toBe(0);
    await returning.serviceBacklog?.();
    expect(pending.has(alice.deviceId)).toBeTrue();
    expect(replacementPublished).toBeFalse();
    await newcomer.serviceBacklog?.();
    expect(envelopes.has(alice.deviceId)).toBeTrue();
    expect(pending.size).toBe(0);
    expect(replacementPublished).toBeFalse();
    await returning.serviceBacklog?.();
    expect(replacementPublished).toBeTrue();
    const caughtUp = await newcomerNamespace.withOpenedGenerations(request,
      (entries) => entries.map((entry) => entry.generationKey.slice()));
    expect(caughtUp.status).toBe("opened");
    if (caughtUp.status !== "opened") throw new Error("Newcomer did not open repaired history");
    expect(caughtUp.value).toHaveLength(2);
    expect(caughtUp.value[0]).toEqual(historical.value[0]);
    expect(caughtUp.value[1]).not.toEqual(historical.value[0]);
    historical.value.forEach((key) => key.fill(0));
    caughtUp.value.forEach((key) => key.fill(0));

    PARTICIPANT_DIGEST.fill(0x31);
    envelopes.forEach((entry) => {
      entry.envelopeBytes.fill(0);
      entry.envelopeDigest.fill(0);
      entry.issuerSigningPublicKey.fill(0);
      entry.requestDigest?.fill(0);
    });
    pending.forEach((entry) => {
      entry.requestBytes.fill(0);
      entry.requestDigest.fill(0);
    });
    (recoveryEnvelopeBytes as Uint8Array | null)?.fill(0);
    recovery.publicKey.fill(0);
    recovery.privateKey.fill(0);
  });

  test("publishes, advances, and reopens exact Domain-wrapped Namespace history", async () => {
    const crypto = new LatticeCrypto(seededRng(301_002));
    const alice = await createDevice(crypto, ALICE, "device:m301:bundle");
    const domainKey = new Uint8Array(32).fill(0x71);
    const targetDomainKey = new Uint8Array(32).fill(0x72);
    const targetDomain = `${DOMAIN}:charlie`;
    const targetParticipantDigest = new Uint8Array(32).fill(0x32);
    const sourceHead = prepareDomainKeyHead(crypto, {
      serverId: SERVER,
      cryptoDomainId: cryptoDomainId(DOMAIN),
      participantDigest: PARTICIPANT_DIGEST,
      participantCount: 2,
      keyClass: "ai",
      domainKeyGeneration: 1,
      authorizationRevision: authorizationRevision(1),
      previousHeadDigest: null,
      publicationOperationId: "operation:m301:source-head",
      issuerHumanId: humanId(ALICE),
      issuerDeviceId: cryptoDeviceId(alice.deviceId),
      issuerDeviceSigningGeneration: 1,
      issuedAt: NOW,
      deadlineAt: NOW + 30_000,
      issuerSigningPublicKey: alice.signingPublicKey,
      issuerSigningPrivateKey: alice.signingPrivateKey,
    });
    const aliceEncryptionDigest = crypto.hash(alice.encryptionPublicKey);
    const sourceEnvelope = await prepareDomainKeyRecipientEnvelope(crypto, {
      head: sourceHead.head,
      headDigest: sourceHead.digest,
      recipient: {
        recipientHumanId: humanId(ALICE),
        recipientKind: "device",
        recipientKeyId: alice.deviceId,
        recipientKeyGeneration: 1,
        recipientPublicKey: alice.encryptionPublicKey,
        recipientPublicKeyDigest: aliceEncryptionDigest,
      },
      domainKey,
      issuerHumanId: humanId(ALICE),
      issuerDeviceId: cryptoDeviceId(alice.deviceId),
      issuerDeviceSigningGeneration: 1,
      issuerSigningPublicKey: alice.signingPublicKey,
      issuerSigningPrivateKey: alice.signingPrivateKey,
    });
    const domainHeadDigest = sourceHead.digest;
    const targetDomainHeadDigest = new Uint8Array(32).fill(0x70);
    let membershipChanged = false;
    let authorityServerId = SERVER;
    const domainAuthority: DomainKeyAuthorityClientV2 = Object.freeze({
      ensure: () => Promise.resolve({ status: "ready" as const }),
      withDomainKey: async <Value>(_request: unknown, use: (
        key: Uint8Array,
        authority: Readonly<{
          serverId: string;
          domainId: string;
          participantDigest: Uint8Array;
          participantCount: number;
          keyClass: "ai";
          domainKeyGeneration: number;
          authorizationRevision: number;
          headDigest: Uint8Array;
          recipientDeviceSigningGeneration: number;
        }>,
      ) => Value | Promise<Value>) => Object.freeze({
        status: "opened" as const,
        value: await use(
          (membershipChanged ? targetDomainKey : domainKey).slice(),
          Object.freeze({
            serverId: authorityServerId,
            domainId: membershipChanged ? targetDomain : DOMAIN,
            participantDigest: membershipChanged
              ? targetParticipantDigest.slice()
              : PARTICIPANT_DIGEST.slice(),
            participantCount: membershipChanged ? 3 : 2,
            keyClass: "ai" as const,
            domainKeyGeneration: 1,
            authorizationRevision: 1,
            headDigest: membershipChanged
              ? targetDomainHeadDigest.slice()
              : domainHeadDigest.slice(),
            recipientDeviceSigningGeneration: 1,
          }),
        ),
      }),
      servicePending: () => Promise.resolve({
        status: "ready" as const,
        fulfilled: 0,
      }),
    });
    let bindingBytes: Uint8Array | null = null;
    let bindingDigest: Uint8Array | null = null;
    let sourceBindingBytes: Uint8Array | null = null;
    let sourceBindingDigest: Uint8Array | null = null;
    let replacementPublished = false;
    const api = Object.freeze({
      planDomainNamespaceBundleV2: () => Promise.resolve(
        bindingBytes === null || bindingDigest === null
          ? {
              responseVersion: 2 as const,
              status: "create_required" as const,
              domainId: DOMAIN,
              participantDigestBase64url: b64(PARTICIPANT_DIGEST),
              participantCount: 2,
              keyClass: "ai" as const,
              domainKeyGeneration: 1,
              domainAuthorizationRevision: 1,
              domainHeadDigestBase64url: b64(domainHeadDigest),
              namespaceId: NAMESPACE,
              namespaceAccessRevision: 2,
              namespaceCurrentGeneration: 0 as const,
              bundleRevision: 1 as const,
              retainedGenerationCount: 1 as const,
              previousBindingDigestBase64url: null,
              issuerHumanId: ALICE,
              issuerDeviceId: alice.deviceId,
              issuerDeviceSigningGeneration: 1,
              issuerSigningPublicKeyBase64url: b64(alice.signingPublicKey),
            }
          : membershipChanged && !replacementPublished
          ? {
              responseVersion: 2 as const,
              status: "replace_required" as const,
              domainId: targetDomain,
              participantDigestBase64url: b64(targetParticipantDigest),
              participantCount: 3,
              keyClass: "ai" as const,
              domainKeyGeneration: 1,
              domainAuthorizationRevision: 1,
              domainHeadDigestBase64url: b64(targetDomainHeadDigest),
              namespaceId: NAMESPACE,
              namespaceAccessRevision: 3,
              namespaceCurrentGeneration: 1,
              bundleRevision: 2,
              retainedGenerationCount: 2,
              advanceGeneration: true,
              previousBindingDigestBase64url: b64(sourceBindingDigest!),
              sourceBindingBytesBase64url: b64(sourceBindingBytes!),
              sourceBindingDigestBase64url: b64(sourceBindingDigest!),
              sourceIssuerSigningPublicKeyBase64url:
                b64(alice.signingPublicKey),
              sourceEnvelopeBytesBase64url: b64(sourceEnvelope.bytes),
              sourceEnvelopeDigestBase64url: b64(sourceEnvelope.digest),
              sourceEnvelopeIssuerSigningPublicKeyBase64url:
                b64(alice.signingPublicKey),
              sourceRecipientDeviceSigningGeneration: 1,
              issuerHumanId: ALICE,
              issuerDeviceId: alice.deviceId,
              issuerDeviceSigningGeneration: 1,
              issuerSigningPublicKeyBase64url: b64(alice.signingPublicKey),
            }
          : {
              responseVersion: 2 as const,
              status: "ready" as const,
              domainId: membershipChanged ? targetDomain : DOMAIN,
              keyClass: "ai" as const,
              bindingBytesBase64url: b64(bindingBytes),
              bindingDigestBase64url: b64(bindingDigest),
              issuerSigningPublicKeyBase64url: b64(alice.signingPublicKey),
            },
      ),
      publishDomainNamespaceBundleV2: (
        _roomId: string,
        _namespaceId: string,
        request: Readonly<{
          operationId: string;
          bindingBytesBase64url: string;
        }>,
      ) => {
        bindingBytes = bytes(request.bindingBytesBase64url);
        bindingDigest = crypto.hash(bindingBytes);
        if (membershipChanged) {
          replacementPublished = true;
        } else {
          sourceBindingBytes = bindingBytes.slice();
          sourceBindingDigest = bindingDigest.slice();
        }
        return Promise.resolve({
          responseVersion: 2 as const,
          status: "published" as const,
          operationId: request.operationId,
          namespaceId: NAMESPACE,
          domainId: membershipChanged ? targetDomain : DOMAIN,
          keyClass: "ai" as const,
          bindingDigestBase64url: b64(bindingDigest),
        });
      },
    });
    let nextId = 0;
    const accessStates: unknown[] = [];
    const client = createDomainNamespaceAuthorityClientV2({
      api,
      crypto,
      vault: alice.vault,
      coordinates: alice.coordinates,
      domainAuthority,
      serverId: SERVER,
      now: () => NOW,
      createId: () => `operation:m301:bundle:${++nextId}`,
      onAccessState: (state) => accessStates.push(state),
    });
    expect(await client.ensure({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
    })).toEqual({ status: "ready" });
    expect(accessStates.at(-1)).toEqual({
      roomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
      status: "ready",
    });
    expect(bindingBytes).not.toBeNull();
    expect(bindingDigest).not.toBeNull();
    let openedAuthority: OpenedDomainNamespaceAuthorityV2 | undefined;
    const opened = await client.withOpenedGenerations({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
      expectedAccessRevision: 2,
      expectedCurrentGeneration: 0,
    }, (entries, authority) => {
      openedAuthority = Object.freeze({
        ...authority,
        namespaceHeadDigest: authority.namespaceHeadDigest.slice(),
        domainHeadDigest: authority.domainHeadDigest.slice(),
        bundleDigest: authority.bundleDigest.slice(),
      });
      return entries.map((entry) => Object.freeze({
        generation: entry.generation,
        key: entry.generationKey.slice(),
        head: entry.headDigest.slice(),
      }));
    });
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") {
      throw new Error("Native V2 Namespace bundle did not open");
    }
    if (openedAuthority === undefined) {
      throw new Error("Native V2 Namespace authority was not exposed");
    }
    const capturedAuthority: OpenedDomainNamespaceAuthorityV2 = openedAuthority;
    const currentBindingDigest = bindingDigest as Uint8Array | null;
    if (currentBindingDigest === null) {
      throw new Error("Namespace binding digest is unavailable");
    }
    expect(opened.value).toHaveLength(1);
    expect(opened.value[0]?.generation).toBe(0);
    expect(capturedAuthority).toEqual({
      sourceRoomId: ROOM,
      serverId: SERVER,
      namespaceId: NAMESPACE,
      keyClass: "ai",
      namespaceAccessRevision: 2,
      namespaceKeyGeneration: 0,
      namespaceHeadDigest: opened.value[0]!.head,
      domainId: DOMAIN,
      domainKeyGeneration: 1,
      domainAuthorizationRevision: 1,
      domainHeadDigest,
      bundleRevision: 1,
      bundleDigest: currentBindingDigest,
    });
    const initialKey = opened.value[0]!.key.slice();
    const initialHead = opened.value[0]!.head.slice();
    opened.value.forEach((entry) => {
      entry.key.fill(0);
      entry.head.fill(0);
    });
    capturedAuthority.namespaceHeadDigest.fill(0);
    capturedAuthority.domainHeadDigest.fill(0);
    capturedAuthority.bundleDigest.fill(0);

    const staleHead = initialHead.slice();
    staleHead[0] = staleHead[0]! ^ 0xff;
    let rejectedCallbackCount = 0;
    expect(await client.withOpenedGenerations({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
      expectedCurrentHeadDigest: staleHead,
    }, () => {
      rejectedCallbackCount += 1;
      return "must-not-open";
    })).toEqual({
      status: "unavailable",
      reason: "bundle_open_failed",
    });
    expect(rejectedCallbackCount).toBe(0);
    staleHead.fill(0);

    const currentBindingBytes = bindingBytes as Uint8Array | null;
    if (currentBindingBytes === null) {
      throw new Error("Namespace binding is unavailable");
    }
    const validBindingBytes = currentBindingBytes.slice();
    const tamperedBindingBytes = currentBindingBytes.slice();
    tamperedBindingBytes[tamperedBindingBytes.length - 1] =
      tamperedBindingBytes[tamperedBindingBytes.length - 1]! ^ 0xff;
    bindingBytes = tamperedBindingBytes;
    expect(await client.withOpenedGenerations({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
    }, () => {
      rejectedCallbackCount += 1;
      return "must-not-open";
    })).toEqual({
      status: "unavailable",
      reason: "binding_invalid",
    });
    expect(rejectedCallbackCount).toBe(0);
    tamperedBindingBytes.fill(0);
    bindingBytes = validBindingBytes;

    const foregroundAdapter = createDomainNamespaceAuthorityAdapterV2({
      domainAuthority,
      namespaceAuthority: client,
    });
    const outputKeyring = await foregroundAdapter.withOpenedGenerations?.({
      sourceRoomId: ROOM,
      subjectHumanId: ALICE,
      deviceSigningKeyGeneration: 1,
      keyClass: "ai",
      authority: [{
        namespaceId: NAMESPACE,
        retainedGenerations: [{
          generation: 0,
          accessRevision: 2,
          headDigest: initialHead,
          publicationDigest: initialHead,
          publicationSetDigest: initialHead,
          audienceFingerprint: initialHead,
        }],
      }],
    }, (entries) => entries.map((entry) => ({
      namespaceId: entry.namespaceId,
      generation: entry.generation,
      accessRevision: entry.accessRevision,
      keyMatches: entry.generationKey.every((value, index) =>
        value === initialKey[index]
      ),
      headMatches: entry.headDigest.every((value, index) =>
        value === initialHead[index]
      ),
    })));
    expect(outputKeyring?.status).toBe("opened");
    if (outputKeyring?.status !== "opened") {
      throw new Error("Foreground output keyring did not open");
    }
    expect(outputKeyring.value).toHaveLength(1);
    expect(String(outputKeyring.value[0]?.namespaceId)).toBe(NAMESPACE);
    expect(Number(outputKeyring.value[0]?.generation)).toBe(0);
    expect(Number(outputKeyring.value[0]?.accessRevision)).toBe(2);
    expect(outputKeyring.value[0]?.keyMatches).toBeTrue();
    expect(outputKeyring.value[0]?.headMatches).toBeTrue();
    membershipChanged = true;
    expect(await client.ensure({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
    })).toEqual({ status: "ready" });
    expect(replacementPublished).toBe(true);
    // Existing one-argument callbacks remain source- and runtime-compatible.
    const openedAfterMembership = await client.withOpenedGenerations({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
      expectedAccessRevision: 3,
      expectedCurrentGeneration: 1,
    }, (entries) => entries.map((entry) => entry.generationKey.slice()));
    expect(openedAfterMembership.status).toBe("opened");
    if (openedAfterMembership.status === "opened") {
      expect(openedAfterMembership.value).toHaveLength(2);
      expect(openedAfterMembership.value[0]).toEqual(initialKey);
      expect(openedAfterMembership.value[1]).not.toEqual(initialKey);
      openedAfterMembership.value.forEach((key) => key.fill(0));
    }
    authorityServerId = "https://substitution.example";
    expect(await client.withOpenedGenerations({
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      keyClass: "ai",
    }, () => "must-not-open")).toEqual({
      status: "unavailable",
      reason: "domain_stale",
    });
    initialKey.fill(0);
    initialHead.fill(0);
    domainKey.fill(0);
    targetDomainKey.fill(0);
    targetDomainHeadDigest.fill(0);
    targetParticipantDigest.fill(0);
    (sourceBindingBytes as Uint8Array | null)?.fill(0);
    (sourceBindingDigest as Uint8Array | null)?.fill(0);
    destroyDomainKeyRecipientEnvelopeV2(sourceEnvelope.envelope);
    sourceEnvelope.bytes.fill(0);
    sourceEnvelope.digest.fill(0);
    destroyDomainKeyHeadV2(sourceHead.head);
    sourceHead.bytes.fill(0);
    sourceHead.digest.fill(0);
    aliceEncryptionDigest.fill(0);
  });
});
