import { expect, test } from "bun:test";
import type { MessageBackfillAckRequest, MessageBackfillClaim, MessageBackfillSourceResponse } from "@nautilo/api-client/browser";
import { LatticeCrypto, accessRevision, namespaceGeneration, namespaceId } from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import { encodeClientDeviceProfileV2 } from "../../src/client-vault/profile-v2.ts";
import { createClientDeviceProfileV3Candidate, destroyOpenedClientDeviceProfileV3, encodeClientDeviceProfileV3 } from "../../src/client-vault/profile-v3.ts";
import { createClientDeviceProfileV4Candidate, destroyOpenedClientDeviceProfileV4, stageAndActivateClientDeviceProfileV4 } from "../../src/client-vault/profile-v4.ts";
import { MemoryClientProfileVault } from "../../src/testing/client-profile-vault.ts";
import { bindEncryptionDataOperationOwner } from "../../src/transition/encryption-data-operation-owner.ts";
import type { LiveShadowEncryptionTransitionPolicy } from "../../src/transition/encryption-transition-policy.ts";
import { createDeviceMessageBackfillClient } from "../../src/client/message/device-message-backfill-client.ts";
import { deriveMessageCryptoObjectIdV2 } from "../../src/message/conversation-repository.ts";
import { admitHumanExistingMessageRepresentation } from "../../src/message/human-existing-message-representation-admission.ts";
import { encodeMessagePayloadV2, type MessagePayloadV2 } from "../../src/message/message-payload-v2.ts";
import { messageBackfillAcknowledgementDigest, messageBackfillClaimDigest } from "../../src/message/message-backfill-ack.ts";
import { createVaultRoomHistoryShadowMessageReader } from "../../src/client/message/vault-room-history-shadow-message-reader.ts";
import { createDomainNamespaceAuthorityAdapterV2 } from "../../src/client/message/domain-namespace-authority-adapter.ts";
import type { ClientProfileCoordinates } from "../../src/client-vault/types.ts";
import type { NamespaceAuthorityClient } from "../../src/client/message/namespace-authority-client.ts";

const NOW = 1_800_000_000_000;
const ROOM = "31300000-0000-4000-8000-000000000001";
const CHILD_ROOM = "31300000-0000-4000-8000-000000000006";
const NAMESPACE = "31300000-0000-4000-8000-000000000002";
const HUMAN = "31300000-0000-4000-8000-000000000003";
const USER = "31300000-0000-4000-8000-000000000004";
const SESSION = "31300000-0000-4000-8000-000000000005";
const DEVICE = "m313-test-browser";
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const from = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

class NonReentrantProfileVault extends MemoryClientProfileVault {
  profileIsOpen = false;
  override async withOpenProfile<Value>(coordinates: ClientProfileCoordinates,
    use: (bytes: Uint8Array) => Value | Promise<Value>): Promise<Value> {
    if (this.profileIsOpen) throw new Error("Profile custody is non-reentrant");
    this.profileIsOpen = true;
    try {return await super.withOpenProfile(coordinates, use);}
    finally {this.profileIsOpen = false;}
  }
}

async function fixture(keyClass: "human" | "ai" = "human", role: MessagePayloadV2["role"] = "system", native = false) {
  const crypto = new LatticeCrypto(seededRng(313_900), { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const v2 = encodeClientDeviceProfileV2({ formatVersion: 2, deviceId: DEVICE,
    signingPublicKey: signing.publicKey, signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 2, trustedHostAuthorizationRevision: 3,
    deliveryHighWatermark: 0, keyringDeliveries: [] });
  const v3 = await createClientDeviceProfileV3Candidate({ crypto, currentProfileBytes: v2, expectedDeviceId: DEVICE });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({ crypto, currentProfileBytes: v3Bytes, expectedDeviceId: DEVICE });
  const coordinates = { serverScope: "https://backfill.test", userId: USER, humanActorId: HUMAN,
    profileId: "m313-profile", deviceId: DEVICE, installationLineageDigest: "31".repeat(32) };
  const vault = new NonReentrantProfileVault();
  await vault.unlock();
  await stageAndActivateClientDeviceProfileV4({ crypto, vault, coordinates, stageId: "m313-stage", generation: 1,
    publicState: { clientKind: "browser", publicFingerprint: "32".repeat(32) }, candidate: v4 });
  destroyOpenedClientDeviceProfileV4(v4); destroyOpenedClientDeviceProfileV3(v3); v2.fill(0); v3Bytes.fill(0);
  const head = new Uint8Array(32).fill(0x33);
  const key = new Uint8Array(32).fill(0x34);
  const payload: MessagePayloadV2 = { role, content: "canonical unopened history",
    ...(role === "system" ? { sensitiveMetadata: { reason: "summary" } } : {}),
    ...(role === "tool" ? { toolName: "lookup", sensitiveMetadata: { toolCallId: "call-1" } } : {}) };
  const ordinary = encodeMessagePayloadV2(payload);
  const claim: MessageBackfillClaim = { version: 1, claimId: "31300000-0000-4000-8000-000000000006",
    operationId: "m313-operation", coordinate: { sessionId: SESSION, messageId: 42, revision: 0,
      roomId: ROOM, namespaceId: NAMESPACE, role, logicalMessageKey: "row:42" },
    sourceRevision: role === "tool" ? 0 : null, action: "encrypt", subjectHumanId: HUMAN, deviceId: DEVICE, serverInstanceId: "m313-server",
    deviceGeneration: 2, lineageGeneration: 1, membershipEpoch: 1, membershipSecurityRevision: 2,
    membershipHeadDigestBase64url: b64(head), hostAuthorizationRevision: 3, policyRevision: 7,
    keyClass, namespaceAccessRevision: 4, namespaceKeyGeneration: 1, namespaceHeadDigestBase64url: b64(head),
    domainId: "m313-domain", domainGeneration: 1, domainAuthorizationRevision: 2, domainHeadDigestBase64url: b64(head),
    namespaceBundleRevision: 1, namespaceBundleDigestBase64url: b64(head), repairIdentityDigestBase64url: b64(head),
    createdAt: NOW, authorHumanTurnId: role === "user" ? "turn-42" : null, sessionAgentId: null,
    cryptoObjectId: deriveMessageCryptoObjectIdV2({ sessionId: SESSION, messageId: 42, revision: 0 }),
    issuedAt: NOW, expiresAt: NOW + 10_000 };
  const calls: string[] = [];
  const acks: MessageBackfillAckRequest[] = [];
  let policy: LiveShadowEncryptionTransitionPolicy = { mode: "shadow_encryption", shadowBehavior: "strict" };
  let published: { payload: string; manifest: string; envelope: string } | null = null;
  let missingOrdinary = false;
  let unavailableKey = false;
  let abortAfterPublish = false;
  let fullAfterSource = false;
  let corruptSource = false;
  let loseAckResponse = false;
  let staleSource = false;
  let staleAcknowledgement = false;
  let resolutionAvailableAfterWaiting = false;
  let hangNextUntilAbort = false;
  let prepareAuthority = false;
  let hangAuthorityUntilAbort = false;
  let selectedSourceOverride: { sourceUserId?: string; authorAgentId?: string; logicalMessageKey?: string } = {};
  let priorityAttempt = 0;
  const seenUrgencies: unknown[] = [];
  const transportSignals: (AbortSignal | undefined)[] = [];
  const controller = new AbortController();
  const generation = { namespaceId: namespaceId(NAMESPACE), keyClass, generation: namespaceGeneration(1),
    accessRevision: accessRevision(4), generationKey: key, headDigest: head, audienceFingerprint: head };
  let returnedGenerationOverride: Partial<typeof generation> = {};
  const namespaceAuthority: NamespaceAuthorityClient = native ? createDomainNamespaceAuthorityAdapterV2({
    domainAuthority: {ensure: async () => ({status: "ready"}),
      servicePending: async () => ({status: "ready", fulfilled: 0}),
      withDomainKey: async () => {throw new Error("Adapter must open native Namespace authority");}},
    namespaceAuthority: {ensure: async () => ({status: "ready"}), servicePending: async () => 0,
      withOpenedGenerations: async (request, use) => {
        calls.push("keys");
        expect(request.keyClass).toBe(keyClass);
        expect(request.expectedAccessRevision).toBe(claim.namespaceAccessRevision);
        expect(request.expectedCurrentGeneration).toBe(claim.namespaceKeyGeneration);
        expect(request.expectedCurrentHeadDigest).toEqual(from(claim.namespaceHeadDigestBase64url));
        // A cold native V2 Domain envelope needs the same authenticated profile.
        await vault.withOpenProfile(coordinates, profileBytes => {expect(profileBytes.length).toBeGreaterThan(0);});
        if (unavailableKey) return {status: "unavailable", reason: "offline"};
        const borrowed = {...generation, ...returnedGenerationOverride, generationKey: key.slice()};
        try {return {status: "opened", value: await use([borrowed], Object.freeze({
          sourceRoomId: request.sourceRoomId,
          serverId: "https://m313.test",
          namespaceId: request.namespaceId,
          keyClass: request.keyClass,
          namespaceAccessRevision: claim.namespaceAccessRevision,
          namespaceKeyGeneration: claim.namespaceKeyGeneration,
          namespaceHeadDigest: head,
          domainId: "domain:m313:test",
          domainKeyGeneration: 1,
          domainAuthorizationRevision: 1,
          domainHeadDigest: head,
          bundleRevision: 1,
          bundleDigest: head,
        }))};}
        finally {borrowed.generationKey.fill(0);}
      }},
  }) : {
    ensure: async request => {
      if (hangAuthorityUntilAbort) {
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, {once: true});
        });
      }
      return { status: "ready" };
    }, synchronizeRecipients: async () => ({ status: "ready" }),
    withOpenedAiGenerations: async (_input, use) => ({ status: "opened", value: await use([]) }),
    withOpenedGenerations: async (request, use) => {
      calls.push("keys");
      expect(request.keyClass).toBe(keyClass);
      return unavailableKey ? { status: "unavailable", reason: "offline" } : { status: "opened", value: await use([generation]) };
    },
  };
  const reader = createVaultRoomHistoryShadowMessageReader({ crypto, vault, coordinates,
    namespaceAuthority, authority: { withOpenedRetainedRoomAuthority: async (_input, use) => ({ status: "opened",
      value: await use({ retainedGenerations: [{ ...generation, publicationDigest: head, publicationSetDigest: head }] }) }) },
    resolveTrustedDeviceSigningPublicKey: async () => signing.publicKey, createProfileStageId: () => "m313-read-stage" });
  const makeProtected = (): Extract<MessageBackfillSourceResponse, { status: "protected" }> => {
    if (published === null) throw new Error("missing published fixture");
    const coordinate = { sessionId: SESSION, messageId: 42, editRevision: 0, role, logicalMessageKey: "row:42" };
    const attribution = role === "user" ? { sourceUserId: USER } : role === "system" ? {} : { authorAgentId: USER };
    return { status: "protected", claim, ordinaryPayloadBytesBase64url: missingOrdinary ? null : b64(ordinary),
      sourceDigestBase64url: missingOrdinary ? null : b64(crypto.hash(ordinary)), history: {
        responseVersion: 1, status: "ready", operationId: "m313-history", clientRequestKey: "m313-history-read",
        selectedCoordinateDigestBase64url: b64(head), selectedCount: 1, selectedCoordinates: [coordinate], eligibleCount: 1,
        authority: { scheme: "domain_key_v2", keyClass, subjectHumanId: HUMAN, readerDeviceId: DEVICE,
          readerDeviceSigningKeyGeneration: 2, hostAuthorizationRevision: 3, policyRevision: 7,
          roomId: ROOM, namespaceId: NAMESPACE, namespaceAccessRevision: 4, namespaceCurrentGeneration: 1,
          namespaceHeadDigestBase64url: b64(head), domainId: "m313-domain", domainKeyGeneration: 1,
          domainAuthorizationRevision: 2, domainHeadDigestBase64url: b64(head), namespaceBundleRevision: 1,
          namespaceBundleDigestBase64url: b64(head) }, signerEvidence: [],
        acknowledgement: { status: "already_recorded" },
        records: [{ kind: "existing_representation", coordinate,
          ...(missingOrdinary ? { representationMode: "protected-only" as const,
            selectedSource: { role, logicalMessageKey: "row:42", ...attribution, ...selectedSourceOverride } } : {}),
          protectedMessage: { dtoVersion: 2, projection: { ...attribution, role, messageId: "42", logicalMessageKey: "row:42",
            sessionId: SESSION, roomId: ROOM, namespaceId: NAMESPACE, createdAt: new Date(NOW).toISOString(), editRevision: 0 },
            protectedPayload: { status: "encrypted", cryptoObjectId: claim.cryptoObjectId, payloadVersion: 2, keyClass,
              encryptedPayloadBytesBase64url: published.payload, accessManifestBytesBase64url: published.manifest,
              namespaceEnvelopeBytesBase64url: published.envelope } },
          repair: { publisherKind: "human_device", publisherHumanId: HUMAN, identityDigestBase64url: b64(head),
            allocationDigestBase64url: b64(crypto.hash(ordinary)), attestationDigestBase64url: b64(crypto.hash(from(published.manifest))),
            publisherSignerKeyId: DEVICE, publisherSigningPublicKeyBase64url: b64(signing.publicKey) },
          retainedGeneration: { namespaceGeneration: 1, accessRevision: 4, headDigestBase64url: b64(head),
            publicationDigestBase64url: b64(head), publicationSetDigestBase64url: b64(head), audienceFingerprintBase64url: b64(head) } }],
      } };
  };
  const client = createDeviceMessageBackfillClient({ crypto, vault, coordinates, namespaceAuthority,
    owner: bindEncryptionDataOperationOwner({ policy: { resolve: async () => ({ policy, revalidationToken: 1 }),
      revalidate: async () => {} } }),
    historyReader: { ...reader, readerDeviceId: DEVICE, acknowledge: async request => {
      calls.push("restore"); expect(request.allowOrdinaryRepairs).toBe(true);
      expect(request.result.records[0]).toMatchObject({ status: "verified", verification: "signed_representation_authenticated" });
      missingOrdinary = false; return "accepted";
    } }, now: () => NOW, createId: () => "m313-created-id",
    api: {
      nextMessageBackfill: async (request, options) => { calls.push("next"); seenUrgencies.push(request.urgent);
        transportSignals.push(options?.signal);
        if (hangNextUntilAbort) {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            }, {once: true});
          });
        }
        if (prepareAuthority) return {status: "prepare_authority",
          coordinate: claim.coordinate, keyClass, resumeAt: NOW + 1};
        if (request.urgent !== undefined) expect(request.urgent).toEqual({roomId: ROOM, messageId: 42, revision: 0});
        if (resolutionAvailableAfterWaiting) {
          priorityAttempt += 1;
          return priorityAttempt === 1
            ? {status: "waiting" as const, resumeAt: NOW + 1,
              snapshotAt: NOW, complete: false}
            : {status: "more" as const, resumeAt: NOW,
              snapshotAt: NOW, complete: false, resolvedSelection: {roomId: CHILD_ROOM, messageId: 42, revision: 0}};
        }
        return { status: "claimed", claim }; },
      readMessageBackfillSource: async (_request, options) => {
        transportSignals.push(options?.signal);
        calls.push("source");
        if (staleSource) return {status: "stale", resumeAt: claim.expiresAt};
        if (fullAfterSource) policy = { mode: "encrypted_only", shadowBehavior: "strict" };
        return published === null ? { status: "ordinary", claim, payloadBytesBase64url: b64(ordinary), sourceDigestBase64url: b64(corruptSource ? head : crypto.hash(ordinary)) }
          : makeProtected();
      },
      publishMessageBackfill: async (request, options) => {
        transportSignals.push(options?.signal);
        calls.push("publish");
        if (native) {
          expect(vault.profileIsOpen).toBe(false);
          // Transport's fresh-admission path may also need custody.
          await vault.withOpenProfile(coordinates, profileBytes => {expect(profileBytes.length).toBeGreaterThan(0);});
        }
        const admitted = await admitHumanExistingMessageRepresentation({ crypto,
          productPlan: { subjectHumanId: HUMAN, operationId: claim.operationId, sessionId: SESSION, roomId: ROOM,
            messageId: 42, revision: 0, createdAt: NOW, authorRole: role, authorHumanTurnId: claim.authorHumanTurnId,
            sessionAgentId: null, namespaceId: NAMESPACE, namespaceBindingHash: head, namespaceAccessRevision: 4,
            namespaceKeyGeneration: 1, bindingRevisionAtWrap: 4, keyClass, objectId: claim.cryptoObjectId },
          authoritativePlaintext: payload, requestBytes: from(request.requestBytesBase64url),
          payloadBytes: from(request.payloadBytesBase64url), manifestBytes: from(request.manifestBytesBase64url),
          envelopeBytes: [from(request.envelopeBytesBase64url)], now: NOW, resolveCurrentHumanAuthority: () => signing.publicKey });
        expect(admitted.prepared.keyClass).toBe(keyClass);
        published = { payload: request.payloadBytesBase64url, manifest: request.manifestBytesBase64url, envelope: request.envelopeBytesBase64url };
        if (abortAfterPublish) controller.abort();
        return { status: "published" };
      },
      acknowledgeMessageBackfill: async (request, options) => {
        transportSignals.push(options?.signal);
        calls.push("ack"); acks.push(request);
        if (native) {
          expect(vault.profileIsOpen).toBe(false);
          await vault.withOpenProfile(coordinates, profileBytes => {expect(profileBytes.length).toBeGreaterThan(0);});
        }
        const digest = messageBackfillAcknowledgementDigest(request);
        expect(crypto.verify(signing.publicKey, digest, from(request.signatureBase64url))).toBe(true);
        expect(request.claimDigestBase64url).toBe(b64(messageBackfillClaimDigest(claim)));
        digest.fill(0);
        if (loseAckResponse) throw new Error("transport response lost");
        if (staleAcknowledgement) return {status: "stale", resumeAt: NOW};
        return { status: "caught_up", resumeAt: null };
      },
    },
  });
  return { client, calls, acks, claim, controller, makeProtected, seenUrgencies, transportSignals,
    setReturnedGeneration(value: Partial<typeof generation>) {returnedGenerationOverride = value;},
    setPolicy(value: LiveShadowEncryptionTransitionPolicy) { policy = value; },
    setMissingOrdinary() { missingOrdinary = true; claim.action = "restore"; },
    setSelectedSource(value: typeof selectedSourceOverride) { selectedSourceOverride = value; },
    setUnavailableKey() { unavailableKey = true; },
    setAbortAfterPublish() { abortAfterPublish = true; },
    setFullAfterSource() { fullAfterSource = true; },
    setCorruptSource() { corruptSource = true; },
    setLoseAckResponse() { loseAckResponse = true; },
    setStaleSource() { staleSource = true; },
    setStaleAcknowledgement() { staleAcknowledgement = true; },
    setResolutionAvailableAfterWaiting() { resolutionAvailableAfterWaiting = true; },
    setHangNextUntilAbort() { hangNextUntilAbort = true; },
    setPrepareAuthorityUntilAbort() {
      prepareAuthority = true;
      hangAuthorityUntilAbort = true;
    },
  };
}

test.each(["human", "ai"] as const)("real crypto and history reader converge unopened %s history for every role", async keyClass => {
  for (const role of ["user", "assistant", "tool", "system"] as const) {
    const value = await fixture(keyClass, role);
    value.client.prioritize(value.claim.coordinate);
    expect(await value.client.runBatch({ signal: value.controller.signal })).toEqual({
      state: "caught_up", resumeAt: null, reconciled: true,
      reconciledSelection: {roomId: ROOM, messageId: 42, revision: 0},
    });
    expect(value.calls).toEqual(["next", "source", "keys", "publish", "source", "keys", "ack"]);
    expect(value.transportSignals).toHaveLength(5);
    expect(value.transportSignals.every(signal => signal === value.controller.signal)).toBe(true);
    expect(value.acks[0]).toMatchObject({ outcome: "reconciled" });
    expect(value.acks[0]!.sourceDigestBase64url).not.toBeNull();
    expect(value.acks[0]!.manifestDigestBase64url).not.toBeNull();
  }
});

test.each(["plaintext_only", "encrypted_only"] as const)("owner forbids all backfill transports in %s", async mode => {
  const value = await fixture(); value.setPolicy({ mode, shadowBehavior: "fallback" });
  expect(await value.client.runBatch({ signal: value.controller.signal })).toEqual({ state: "waiting", resumeAt: null });
  expect(value.calls).toEqual([]);
});

test("stale restricted authority waits for the current lease instead of hot-looping", async () => {
  const value = await fixture(); value.setStaleSource();
  expect(await value.client.runBatch({signal: value.controller.signal})).toEqual({
    state: "waiting", resumeAt: value.claim.expiresAt,
  });
  expect(value.calls).toEqual(["next", "source"]);
  expect(value.acks).toEqual([]);
});

test("an expired claim immediately allows fresh discovery without opening source", async () => {
  const value = await fixture(); value.claim.expiresAt = NOW;
  expect(await value.client.runBatch({signal: value.controller.signal})).toEqual({
    state: "more", resumeAt: NOW,
  });
  expect(value.calls).toEqual(["next"]);
});

test("consumes an urgent hint while passing through the server's durable resolution", async () => {
  const value = await fixture();
  value.setResolutionAvailableAfterWaiting();
  value.client.prioritize(value.claim.coordinate);

  expect(await value.client.runBatch({signal: value.controller.signal})).toEqual({
    state: "waiting", resumeAt: NOW + 1,
  });
  expect(await value.client.runBatch({signal: value.controller.signal})).toEqual({
    state: "more", resumeAt: NOW, resolvedSelection: {roomId: CHILD_ROOM, messageId: 42, revision: 0},
  });
  expect(value.seenUrgencies).toEqual([
    {roomId: ROOM, messageId: 42, revision: 0},
    undefined,
  ]);
});

test.each([false, true])("a stale acknowledgement waits for lease expiry (missing key: %s)", async missingKey => {
  const value = await fixture(); value.setStaleAcknowledgement();
  if (missingKey) value.setUnavailableKey();
  expect(await value.client.runBatch({signal: value.controller.signal})).toEqual({
    state: "waiting", resumeAt: value.claim.expiresAt,
  });
  expect(value.acks).toHaveLength(1);
  expect(value.acks[0]?.outcome).toBe(missingKey ? "waiting_for_authority" : "reconciled");
});

test.each(["strict", "fallback"] as const)("missing key remains truthful waiting in %s", async shadowBehavior => {
  const value = await fixture(); value.setPolicy({ mode: "shadow_encryption", shadowBehavior }); value.setUnavailableKey();
  await value.client.runBatch({ signal: value.controller.signal });
  expect(value.calls).not.toContain("publish");
  expect(value.acks[0]).toMatchObject({ outcome: "waiting_for_authority", sourceDigestBase64url: null, manifestDigestBase64url: null });
});

test("Full transition during source loading blocks crypto and publication", async () => {
  const value = await fixture(); value.setFullAfterSource();
  expect(await value.client.runBatch({ signal: value.controller.signal })).toEqual({ state: "waiting", resumeAt: value.claim.expiresAt });
  expect(await value.client.runBatch({ signal: value.controller.signal })).toEqual({ state: "waiting", resumeAt: null });
  expect(value.calls).toEqual(["next", "source"]);
});

test("abort after accepted publication leaves durable replay without a success acknowledgement", async () => {
  const value = await fixture(); value.setAbortAfterPublish();
  expect(await value.client.runBatch({ signal: value.controller.signal })).toEqual({ state: "waiting", resumeAt: null });
  expect(value.calls).toEqual(["next", "source", "keys", "publish"]);
  expect(value.acks).toEqual([]);
});

test("transport cancellation yields without recording a failure acknowledgement", async () => {
  const value = await fixture();
  value.setHangNextUntilAbort();
  value.client.prioritize(value.claim.coordinate);
  const controller = new AbortController();
  const batch = value.client.runBatch({signal: controller.signal});
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  controller.abort();

  expect(await batch).toEqual({state: "waiting", resumeAt: null});
  expect(value.calls).toEqual(["next"]);
  expect(value.acks).toEqual([]);
  expect(value.seenUrgencies).toEqual([{
    roomId: ROOM, messageId: 42, revision: 0,
  }]);
});

test("authority transport cancellation releases a prepared-key wait", async () => {
  const value = await fixture();
  value.setPrepareAuthorityUntilAbort();
  const controller = new AbortController();
  const batch = value.client.runBatch({signal: controller.signal});
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  controller.abort();

  expect(await batch).toEqual({state: "waiting", resumeAt: null});
  expect(value.calls).toEqual(["next"]);
  expect(value.acks).toEqual([]);
});

test.each(["human", "ai"] as const)("reverse %s restoration uses owner reverse port once and retains authentication provenance", async keyClass => {
  const value = await fixture(keyClass);
  await value.client.runBatch({ signal: value.controller.signal });
  value.calls.length = 0; value.acks.length = 0; value.setMissingOrdinary();
  expect(await value.client.runBatch({ signal: value.controller.signal })).toEqual({
    state: "caught_up", resumeAt: null, reconciled: true,
    reconciledSelection: {roomId: ROOM, messageId: 42, revision: 0},
  });
  expect(value.calls).toEqual(["next", "source", "keys", "restore", "ack"]);
  expect(value.acks[0]).toMatchObject({ outcome: "reconciled", sourceDigestBase64url: null, manifestDigestBase64url: null });
});


test("source commitment substitution is acknowledged as integrity failure without encryption", async () => {
  const value = await fixture(); value.setCorruptSource();
  await value.client.runBatch({ signal: value.controller.signal });
  expect(value.calls).toEqual(["next", "source", "ack"]);
  expect(value.acks[0]).toMatchObject({ outcome: "integrity_failure", sourceDigestBase64url: null, manifestDigestBase64url: null });
});

test.each([
  ["user", "sourceUserId"], ["assistant", "authorAgentId"],
  ["tool", "authorAgentId"], ["system", "logicalMessageKey"],
] as const)("protected-only %s %s substitution cannot restore or acknowledge reconciliation", async (role, field) => {
  const value = await fixture("human", role);
  await value.client.runBatch({ signal: value.controller.signal });
  value.calls.length = 0;
  value.acks.length = 0;
  value.setMissingOrdinary();
  value.setSelectedSource({ [field]: field === "logicalMessageKey" ? "row:substituted" : HUMAN });

  const result = await value.client.runBatch({ signal: value.controller.signal });

  expect(result.reconciled).not.toBe(true);
  expect(value.calls).not.toContain("restore");
  expect(value.calls).not.toContain("publish");
  expect(value.acks).toHaveLength(1);
  expect(value.acks[0]).toMatchObject({ outcome: "integrity_failure",
    sourceDigestBase64url: null, manifestDigestBase64url: null });
});

test("lost success acknowledgement response never publishes a contradictory waiting receipt", async () => {
  const value = await fixture(); value.setLoseAckResponse();
  const error = await value.client.runBatch({ signal: value.controller.signal }).then(() => null, (error: unknown) => error);
  expect(error).toMatchObject({ message: "transport response lost" });
  expect(value.acks).toHaveLength(1);
  expect(value.acks[0]!.outcome).toBe("reconciled");
});


test.each(["human", "ai"] as const)("native V2 %s opening and publication can obtain non-reentrant profile custody", async keyClass => {
  const f = await fixture(keyClass, "system", true);
  expect(await f.client.runBatch({signal: f.controller.signal})).toMatchObject({state: "caught_up"});
  expect(f.calls).toEqual(["next", "source", "keys", "publish", "source", "keys", "ack"]);
  expect(f.acks[0]!.outcome).toBe("reconciled");
  expect(f.acks[0]!.sourceDigestBase64url).not.toBeNull();
});

test.each(["head", "generation", "access", "class"])("native V2 rejects substituted %s authority before publication", async coordinate => {
  const f = await fixture("human", "system", true);
  f.setReturnedGeneration(coordinate === "head" ? {headDigest: new Uint8Array(32)}
    : coordinate === "generation" ? {generation: namespaceGeneration(2)}
    : coordinate === "access" ? {accessRevision: accessRevision(5)} : {keyClass: "ai"});
  await f.client.runBatch({signal: f.controller.signal});
  expect(f.calls).not.toContain("publish");
  expect(f.acks[0]!.outcome).toBe("waiting_for_authority");
});
