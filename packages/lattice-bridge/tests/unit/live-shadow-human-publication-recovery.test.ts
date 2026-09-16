import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
  encodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  encodeHumanPeerLiveShadowMessagePlanV1,
  encodeSharedAgentLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import type { LiveShadowMessagePreparedRequestV1 } from "@nautilo/api-client/browser";
import type { ProtectedMessageDtoV2 } from "@nautilo/types";
import { sha256 } from "@noble/hashes/sha2.js";

import { createAuthorizedHumanLiveShadowMessageClient, type HumanLiveShadowMessageApiPort } from
  "../../src/client/message/authorized-human-live-shadow-message-client.ts";
import { isOwnedHumanPublication, matchesHumanPublicationReceipt } from
  "../../src/client/message/live-shadow-human-publication-receipt.ts";
import { createPreparedMutationJournal, type PreparedMutationJournalIndex,
  type PreparedMutationJournalVaultPort } from "../../src/client/memory/prepared-mutation-journal.ts";
import type { ClientProfileCoordinates, ClientProfileVault } from "../../src/client-vault/types.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from "../../src/message/conversation-repository.ts";
import { MemoryClientProfileVault } from "../../src/testing/client-profile-vault.ts";
import { encodeClientDeviceProfileV2 } from "../../src/client-vault/profile-v2.ts";
import { createClientDeviceProfileV3Candidate, destroyOpenedClientDeviceProfileV3, encodeClientDeviceProfileV3 } from
  "../../src/client-vault/profile-v3.ts";
import { createClientDeviceProfileV4Candidate, destroyOpenedClientDeviceProfileV4, stageAndActivateClientDeviceProfileV4 } from
  "../../src/client-vault/profile-v4.ts";
import type { NamespaceAuthorityClient } from "../../src/client/message/namespace-authority-client.ts";

const NOW = 1_800_000_000_000;
const ROOM = "40000000-0000-4000-8000-000000000311";
const SESSION = "30000000-0000-4000-8000-000000000311";
const NAMESPACE = "50000000-0000-4000-8000-000000000311";
const COORDINATES: ClientProfileCoordinates = {
  serverScope: "https://publication.test", userId: "10000000-0000-4000-8000-000000000311",
  humanActorId: "20000000-0000-4000-8000-000000000311", profileId: "publication_profile",
  deviceId: "publication_device", installationLineageDigest: "31".repeat(32),
};
type Scheme = "human_peer_v1" | "shared_agent_v1" | "human_ai_readable_v1" | "human_ai_readable_v2";
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");

function publication(scheme: Scheme = "shared_agent_v1", owner?: { operationId: string; humanActorId: string }) {
  const operationId = owner?.operationId ?? `publication:${scheme}`;
  const common = {
    formatVersion: 1 as const, operationId, clientIdempotencyKey: "publication_request",
    policyRevision: 1, sessionId: SESSION, roomId: ROOM, humanMessageId: 311,
    revision: 0 as const, transcriptOrdinal: 1, role: "user" as const, createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId(owner?.humanActorId ?? COORDINATES.humanActorId), committerDeviceId: cryptoDeviceId(COORDINATES.deviceId),
    committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: authorizationRevision(1),
    namespaceId: namespaceId(NAMESPACE), namespaceAccessRevision: accessRevision(1),
    namespaceKeyGeneration: namespaceGeneration(1), namespaceHeadDigest: new Uint8Array(32).fill(1),
    namespacePublicationDigest: new Uint8Array(32).fill(2),
    namespacePublicationSetDigest: new Uint8Array(32).fill(3),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(4), attemptCoordinate: "publication_attempt",
    issuedAt: unixTimestamp(NOW), deadlineAt: unixTimestamp(NOW + 30_000),
  };
  const plan = scheme === "human_peer_v1"
    ? encodeHumanPeerLiveShadowMessagePlanV1({ ...common, purpose: "message.human_peer_live_shadow_plan", keyClass: "human" })
    : scheme === "human_ai_readable_v1" || scheme === "human_ai_readable_v2"
    ? encodeHumanAiReadableLiveShadowMessagePlan({ ...common,
      formatVersion: scheme === "human_ai_readable_v2" ? 2 : 1,
      deadlineAt: unixTimestamp(NOW + (scheme === "human_ai_readable_v2" ? 300_000 : 30_000)), purpose: "message.human_ai_readable_live_shadow_plan", keyClass: "ai" })
    : encodeSharedAgentLiveShadowMessagePlanV1({ ...common, purpose: "message.shared_agent_live_shadow_plan",
      keyClass: "ai", recipientAgentId: agentId("agent_publication") });
  const request: LiveShadowMessagePreparedRequestV1 = {
    requestVersion: 1, status: "prepared", authorizationScheme: scheme, operationId,
    planBytesBase64url: b64(plan), signedRequestBytesBase64url: "AQID", ordinaryPayloadBytesBase64url: "BAUG",
    encryptedPayloadBytesBase64url: "BwgJ", accessManifestBytesBase64url: "CgsM", namespaceEnvelopeBytesBase64url: "DQ4P",
  };
  const protectedMessage: ProtectedMessageDtoV2 = {
    dtoVersion: 2,
    projection: { messageId: "311", sessionId: SESSION, roomId: ROOM, namespaceId: NAMESPACE,
      role: "user", createdAt: new Date(NOW).toISOString(), editRevision: 0 },
    protectedPayload: { status: "encrypted", payloadVersion: 2, keyClass: scheme === "human_peer_v1" ? "human" : "ai",
      cryptoObjectId: deriveLiveShadowMessageCryptoObjectIdV1({ operationId, sessionId: SESSION,
        messageId: 311, revision: 0, transcriptOrdinal: 1, authorRole: "user" }),
      encryptedPayloadBytesBase64url: request.encryptedPayloadBytesBase64url,
      accessManifestBytesBase64url: request.accessManifestBytesBase64url,
      namespaceEnvelopeBytesBase64url: request.namespaceEnvelopeBytesBase64url },
  };
  return { request, protectedMessage, response: {
    responseVersion: 1 as const, status: "human_published" as const, operationId, authorizationScheme: scheme,
    acceptedHumanRequestDigestBase64url: b64(sha256(Buffer.from(request.signedRequestBytesBase64url, "base64url"))),
    human: { protectedMessage },
  } };
}

// The actual journal owns canonicalization/digests/state. This hermetic port
// seals bodies with authenticated index metadata and rejects nested mutation
// during the opened-body lease, as the file-backed platform does.
async function sealedJournal() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  type Stored = { index: PreparedMutationJournalIndex; nonce: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
  const records = new Map<string, Stored>();
  let leased = false;
  const assertReleased = () => { if (leased) throw new Error("mutation under opened-body lease"); };
  const aad = (index: PreparedMutationJournalIndex) => new TextEncoder().encode(JSON.stringify(index));
  const seal = async (index: PreparedMutationJournalIndex, body: Uint8Array): Promise<Stored> => {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    return { index, nonce, ciphertext: await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
      additionalData: aad(index) }, key, new Uint8Array(body)) };
  };
  const open = async (record: Stored) => new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM",
    iv: record.nonce, additionalData: aad(record.index) }, key, record.ciphertext));
  const port: PreparedMutationJournalVaultPort = {
    async putSealed(input) {
      assertReleased();
      if (records.has(input.index.operationId)) return "collision";
      records.set(input.index.operationId, await seal(input.index, input.canonicalBody));
      return "inserted";
    },
    listIndexes() { assertReleased(); return Promise.resolve([...records.values()].map((entry) => entry.index)); },
    async withOpenedBody(operationId, digest, use) {
      const record = records.get(operationId);
      if (record === undefined || record.index.authenticatedRequestDigestBase64url !== digest) throw new Error("missing exact receipt");
      const body = await open(record);
      leased = true;
      try { return await use(body); } finally { leased = false; body.fill(0); }
    },
    async updateIndex(expected, replacement) {
      assertReleased();
      const record = records.get(expected.operationId);
      if (record === undefined || record.index !== expected) return false;
      const body = await open(record);
      try { records.set(expected.operationId, await seal(replacement, body)); } finally { body.fill(0); }
      return true;
    },
    removeExact(operationId, digest) {
      assertReleased();
      const record = records.get(operationId);
      if (record?.index.authenticatedRequestDigestBase64url !== digest) return Promise.resolve(false);
      return Promise.resolve(records.delete(operationId));
    },
  };
  return { journal: createPreparedMutationJournal({ vault: port, now: () => NOW }), records,
    async expire(operationId: string) {
      const record = records.get(operationId)!;
      await port.updateIndex(record.index, { ...record.index, state: "terminal_expired", nextAttemptAt: Number.MAX_SAFE_INTEGER });
    } };
}

const noProfile: ClientProfileVault = {
  availability: () => Promise.reject(new Error("recovery must not open custody")),
  unlock: () => Promise.reject(new Error("not used")), lock: () => Promise.resolve(),
  stageProfile: () => Promise.reject(new Error("not used")), activateProfile: () => Promise.reject(new Error("not used")),
  abortStagedProfile: () => Promise.reject(new Error("not used")), recoverInterruptedActivation: () => Promise.reject(new Error("not used")),
  withOpenProfile: () => Promise.reject(new Error("not used")), listPublicProfiles: () => Promise.resolve([]),
  rotateWrappingMaterial: () => Promise.reject(new Error("not used")), forgetProfile: () => Promise.reject(new Error("not used")),
};

async function preparedSendCustody() {
  const crypto = new LatticeCrypto(seededRng(311_991), { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const v2 = encodeClientDeviceProfileV2({
    formatVersion: 2, deviceId: COORDINATES.deviceId,
    signingPublicKey: signing.publicKey, signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 1, trustedHostAuthorizationRevision: 1, deliveryHighWatermark: 0, keyringDeliveries: [],
  });
  const v3 = await createClientDeviceProfileV3Candidate({ crypto, currentProfileBytes: v2, expectedDeviceId: COORDINATES.deviceId });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({ crypto, currentProfileBytes: v3Bytes, expectedDeviceId: COORDINATES.deviceId });
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await stageAndActivateClientDeviceProfileV4({ crypto, vault, coordinates: COORDINATES,
    stageId: "publication_stage", generation: 1,
    publicState: { clientKind: "browser", publicFingerprint: "31".repeat(32) }, candidate: v4 });
  destroyOpenedClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV3(v3);
  [v2, v3Bytes, signing.privateKey, encryption.privateKey].forEach((bytes) => bytes.fill(0));
  const namespaceAuthority: NamespaceAuthorityClient = {
    ensure: () => Promise.resolve({ status: "ready" }),
    synchronizeRecipients: () => Promise.resolve({ status: "ready" }),
    withOpenedAiGenerations: () => Promise.reject(new Error("shared Human must not request Agent authority")),
    async withOpenedGenerations(request, use) {
      const generationKey = new Uint8Array(32).fill(0x31);
      try {
        const entries = request.authority.flatMap((authority) => authority.retainedGenerations.map((entry) => ({
          namespaceId: namespaceId(authority.namespaceId), keyClass: request.keyClass,
          accessRevision: accessRevision(entry.accessRevision), generation: namespaceGeneration(entry.generation),
          headDigest: entry.headDigest, audienceFingerprint: entry.audienceFingerprint, generationKey,
        })));
        return { status: "opened", value: await use(entries) };
      } finally { generationKey.fill(0); }
    },
  };
  return { crypto, vault, namespaceAuthority };
}

describe("Human publication receipt and exact journal recovery", () => {
  test.each((["human_peer_v1", "shared_agent_v1", "human_ai_readable_v1", "human_ai_readable_v2"] as const)
    .flatMap((scheme) => [false, true].flatMap((full) =>
      [true, false].map((matches) => ({ scheme, matches, full })))))(
    "retires real prepared send only on exact Human publication %j", async ({ scheme, matches, full }) => {
      const source = publication(scheme);
      const custody = await preparedSendCustody();
      const state = await sealedJournal();
      let sends = 0;
      let legacyCallbacks = 0;
      const client = createAuthorizedHumanLiveShadowMessageClient({
        planRequestVersion: scheme === "human_ai_readable_v2" ? 2 : 1,
        ...custody, coordinates: COORDINATES, journal: state.journal,
        ensureJournalAvailable: () => Promise.resolve(true), now: () => NOW + 1,
        createIdempotencyKey: () => "send_publication", normalizeContent: (content) => content,
        onHumanVerified: () => { legacyCallbacks++; throw new Error("legacy callback must not run for shared Human publication"); },
        api: {
          planLiveShadowRoomMessage: () => Promise.resolve({ responseVersion: 1, status: "planned",
            ...(scheme === "human_ai_readable_v2"
              ? { authorizationScheme: "human_ai_readable_v2" as const } : {}),
            planBytesBase64url: source.request.planBytesBase64url,
            ...(full ? { representationMode: "full_encryption" as const } : {}) }),
          async sendRoomMessage(_roomId, body) {
            sends++;
            const request = body.liveShadow;
            if (request?.status !== "prepared") throw new Error("real crypto preparation failed");
            if (full) {
              expect(body).not.toHaveProperty("content");
              expect(request).toMatchObject({ requestVersion: 2, representationMode: "full_encryption" });
              expect(request).not.toHaveProperty("ordinaryPayloadBytesBase64url");
              await state.journal.withPrepared(request.operationId, (mutation) => {
                expect(JSON.stringify(mutation)).not.toContain("ordinaryPayloadBytes");
              });
            } else {
              expect(body.content).toBe("real prepared publication");
              expect(request.requestVersion).toBe(1);
            }
            expect(state.records.size).toBe(1);
            expect(request.encryptedPayloadBytesBase64url).not.toBe(source.request.encryptedPayloadBytesBase64url);
            const protectedMessage: ProtectedMessageDtoV2 = { ...source.protectedMessage,
              protectedPayload: { status: "encrypted", payloadVersion: 2, keyClass: scheme === "human_peer_v1" ? "human" : "ai",
                cryptoObjectId: source.protectedMessage.protectedPayload.status === "encrypted"
                  ? source.protectedMessage.protectedPayload.cryptoObjectId : "unreachable",
                encryptedPayloadBytesBase64url: matches ? request.encryptedPayloadBytesBase64url : "AA",
                accessManifestBytesBase64url: request.accessManifestBytesBase64url,
                namespaceEnvelopeBytesBase64url: request.namespaceEnvelopeBytesBase64url } };
            return { messageId: 311, jobId: "no-agent-terminal", accepted: true, attachments: [], coalesced: false,
              liveShadow: { responseVersion: 1, status: "human_verified", operationId: request.operationId, protectedMessage } };
          },
        },
      });
      await client.send(ROOM, { content: "real prepared publication", clientActionSessionId: "publication_action" });
      expect(sends).toBe(1);
      expect(state.records.size).toBe(matches ? 0 : 1);
      expect(legacyCallbacks).toBe(0);
    });

  test.each(["human_peer_v1", "shared_agent_v1", "human_ai_readable_v1", "human_ai_readable_v2"] as const)(
    "sends nothing when Full %s crypto custody cannot open",
    async (scheme) => {
      const source = publication(scheme);
      const custody = await preparedSendCustody();
      const state = await sealedJournal();
      let sends = 0;
      const client = createAuthorizedHumanLiveShadowMessageClient({
        planRequestVersion: scheme === "human_ai_readable_v2" ? 2 : 1,
        ...custody,
        namespaceAuthority: {
          ...custody.namespaceAuthority,
          withOpenedGenerations: () => Promise.resolve({
            status: "unavailable" as const, reason: "authority_unavailable" as const,
          }),
        },
        coordinates: COORDINATES, journal: state.journal,
        ensureJournalAvailable: () => Promise.resolve(true), now: () => NOW + 1,
        createIdempotencyKey: () => "full_crypto_failure",
        normalizeContent: (content) => content,
        api: {
          planLiveShadowRoomMessage: () => Promise.resolve({
            responseVersion: 1, status: "planned",
            ...(scheme === "human_ai_readable_v2"
              ? { authorizationScheme: "human_ai_readable_v2" as const } : {}),
            planBytesBase64url: source.request.planBytesBase64url,
            representationMode: "full_encryption",
          }),
          sendRoomMessage: () => { sends++; return Promise.reject(new Error("must not send")); },
        },
      });
      const failure: unknown = await client.send(ROOM, {
        content: "transient Full draft", clientActionSessionId: "full_failure",
      }).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("preparation is unavailable");
      expect(sends).toBe(0);
      expect(state.records.size).toBe(0);
    },
  );

  test.each(["human_peer_v1", "shared_agent_v1", "human_ai_readable_v1", "human_ai_readable_v2"] as const)("recognizes canonical owned %s receipt", (scheme) => {
    const value = publication(scheme);
    expect(isOwnedHumanPublication({ request: value.request, roomId: ROOM, coordinates: COORDINATES })).toBe(true);
    expect(matchesHumanPublicationReceipt({ ...value, roomId: ROOM, coordinates: COORDINATES })).toBe(true);
  });

  test.each(["room", "account", "device", "operation", "object", "revision", "session", "namespace",
    "role", "timestamp", "source_user", "agent_author", "key_class", "payload", "manifest", "envelope"] as const)(
    "rejects substituted %s publication receipt", (field) => {
      const value = publication();
      const coordinates = { ...COORDINATES };
      if (field === "account") coordinates.humanActorId = ROOM;
      if (field === "device") coordinates.deviceId = "other_device";
      const request = field === "operation" ? { ...value.request, operationId: "other_operation" } : value.request;
      const dto = structuredClone(value.protectedMessage);
      if (field === "revision") dto.projection.editRevision = 1;
      if (field === "session") dto.projection.sessionId = ROOM;
      if (field === "namespace") dto.projection.namespaceId = ROOM;
      if (field === "role") dto.projection.role = "assistant";
      if (field === "timestamp") dto.projection.createdAt = new Date(NOW + 1).toISOString();
      if (field === "source_user") dto.projection.sourceUserId = ROOM;
      if (field === "agent_author") dto.projection.authorAgentId = "agent_other";
      if (dto.protectedPayload.status === "encrypted") {
        if (field === "key_class") dto.protectedPayload.keyClass = "human";
        if (field === "object") dto.protectedPayload.cryptoObjectId = "other_object";
        if (field === "payload") dto.protectedPayload.encryptedPayloadBytesBase64url = "AA";
        if (field === "manifest") dto.protectedPayload.accessManifestBytesBase64url = "AA";
        if (field === "envelope") dto.protectedPayload.namespaceEnvelopeBytesBase64url = "AA";
      }
      expect(matchesHumanPublicationReceipt({ request, coordinates, roomId: field === "room" ? SESSION : ROOM,
        protectedMessage: dto })).toBe(false);
    });

  test.each(["published", "expired", "starved", "digest", "dto", "operation", "scheme", "absent", "pending", "account"] as const)(
    "recovers only proven owned publication: %s", async (scenario) => {
      const value = publication();
      const state = await sealedJournal();
      const foreignIndexes: PreparedMutationJournalIndex[] = [];
      if (scenario === "starved") {
        for (let index = 0; index < 4; index++) {
          const foreign = publication("shared_agent_v1", { operationId: `foreign:${index}`, humanActorId: ROOM });
          await state.journal.putBeforeSend({ kind: "live_shadow_message", roomId: ROOM, request: foreign.request });
          foreignIndexes.push(state.records.get(foreign.request.operationId)!.index);
        }
      }
      await state.journal.putBeforeSend({ kind: "live_shadow_message", roomId: ROOM, request: value.request });
      const originalIndex = state.records.get(value.request.operationId)!.index;
      await state.journal.putBeforeSend({ kind: "create", memoryId: SESSION, request: {
        requestVersion: 1, memoryId: SESSION, operationId: "unrelated_memory",
        expectedContentRevision: 0, nextContentRevision: 1,
        cryptoObjectId: `nautilo-memory-v1:${SESSION}:1`, payloadVersion: 1,
        encryptedPayloadBytesBase64url: "AQID", accessManifestBytesBase64url: "BAUG",
        requiredNamespaceIds: [NAMESPACE], namespaceEnvelopes: [{ namespaceId: NAMESPACE, envelopeBytesBase64url: "BwgJ" }],
        signedContentEmbeddingRequestBytesBase64url: "CgsM",
      } });
      const unrelatedIndex = state.records.get("unrelated_memory")!.index;
      if (scenario === "expired") await state.expire(value.request.operationId);
      let reads = 0;
      let callbacks = 0;
      const recover: NonNullable<HumanLiveShadowMessageApiPort["recoverLiveShadowRoomMessage"]> = () => {
        reads++;
        if (scenario === "absent") return Promise.resolve({ responseVersion: 1, status: "absent" });
        if (scenario === "pending") return Promise.resolve({ responseVersion: 1, status: "pending", state: "planned", jobId: null });
        return Promise.resolve({ ...value.response,
          ...(scenario === "operation" ? { operationId: "other_operation" } : {}),
          ...(scenario === "scheme" ? { authorizationScheme: "human_peer_v1" as const } : {}),
          ...(scenario === "digest" ? { acceptedHumanRequestDigestBase64url: b64(new Uint8Array(32)) } : {}),
          ...(scenario === "dto" ? { human: { protectedMessage: { ...value.protectedMessage,
            projection: { ...value.protectedMessage.projection, messageId: "999" } } } } : {}),
        });
      };
      const client = createAuthorizedHumanLiveShadowMessageClient({
        api: { planLiveShadowRoomMessage: () => Promise.reject(new Error("must not plan")),
          sendRoomMessage: () => Promise.reject(new Error("must not resend")), recoverLiveShadowRoomMessage: recover },
        crypto: new LatticeCrypto(seededRng(311)), vault: noProfile, coordinates: scenario === "account"
          ? { ...COORDINATES, humanActorId: ROOM } : COORDINATES,
        journal: state.journal, ensureJournalAvailable: () => Promise.resolve(true), now: () => NOW,
        createIdempotencyKey: () => "unused", normalizeContent: (content) => content,
        onHumanVerified: () => { callbacks++; throw new Error("legacy V4 receiver must not receive shared publication"); },
      });
      const completed = scenario === "published" || scenario === "expired" || scenario === "starved";
      expect(await client.recoverPending()).toBe(completed ? 1 : 0);
      expect(state.records.size).toBe((completed ? 1 : 2) + foreignIndexes.length);
      for (const index of foreignIndexes) expect(state.records.get(index.operationId)!.index).toEqual(index);
      expect(state.records.get("unrelated_memory")!.index).toEqual(unrelatedIndex);
      if (scenario === "account") expect(state.records.get(value.request.operationId)!.index).toEqual(originalIndex);
      expect(reads).toBe(scenario === "account" ? 0 : 1);
      expect(callbacks).toBe(0);
    });
});
