import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";
import {
  createPostgresJsBridgeConnection,
  encryptionTransitionPolicy,
  getSharedDirectCryptoDb,
  sessionMessageCryptoRevisions,
  sessionMessages,
  sessions,
} from "@nautilo/db";
import {
  NautiloApiClient,
  type MessageBackfillClaim,
  type RoomHistoryShadowReadResponseV1,
  type NautiloApiFetch,
} from "@nautilo/api-client";
import {
  LatticeCrypto,
  agentRuntimeGeneration,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  namespaceId as cryptoNamespaceId,
  objectId,
  prepareHumanExistingMessageRepresentationPublicationRequest,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  bindEncryptionDataOperationOwner,
  createDeviceAdmissionProof,
  decodeMessagePayloadV2,
  deviceAdmissionChallengeFromDto,
  deviceAdmissionProofToDto,
  messageBackfillAcknowledgementDigest,
  messageBackfillClaimDigest,
  prepareHumanExistingMessageRepresentationCryptoRevision,
  prepareHumanPeerLiveShadowCryptoRevision,
  readPreparedConversationCryptoRevision,
} from "@nautilo/lattice-bridge";
import {and, eq, inArray, or, sql} from "drizzle-orm";
import {rooms, roomMembers, namespaces, nautiloInstanceIdentity, cryptoObjects,
 objectCryptoAccessHeads, objectCryptoAccessManifests, objectCryptoNamespaceEnvelopes,
 encryptionTransitionHistoryReadAdmissions, humanCryptoDevices, messageBackfillToolContexts, users, actors, agents, profiles, channelIdentities, credentials, groupMembers,
 namespaceDomainKeyHeads, namespaceDomainKeyBindings, domainKeyEnvelopeAcknowledgements,
 domainKeyRecipientEnvelopes, domainKeyRecipientRequests, domainKeyHeads, domainKeyPublicationOperations} from "@nautilo/db";
import {seedBackfillDevice} from "./helpers/message-backfill-custody";
import {runForegroundRuntimeMessageRepair} from "./helpers/message-backfill-runtime-race";
import {deriveAdditionalDeviceClientIdentity} from
  "../../../lattice-bridge/src/device/additional-device-client";
import {createDeviceMessageBackfillClient} from
  "../../../lattice-bridge/src/client/message/device-message-backfill-client";
import {createForegroundRoomHistoryShadowMessageReader, type ForegroundShadowClientPlatform} from
  "../../../lattice-bridge/src/client/message/foreground-shadow-client-composition";
import {createDomainNamespaceAuthorityAdapterV2} from
 "../../../lattice-bridge/src/client/message/domain-namespace-authority-adapter";
import {type RoomHistoryExistingRepresentationRecordTransportV1} from
  "../../../lattice-bridge/src/client/message/vault-room-history-shadow-message-reader";

import { encodeClientDeviceProfileV1 } from
  "../../../lattice-bridge/src/client-vault/profile-v2.ts";
import {
  createClientDomainKeyCacheVaultV2,
} from "../../../lattice-bridge/src/client-vault/domain-key-cache-v2.ts";
import {
  MemoryClientNamespaceGenerationCacheVaultV1,
} from "../../../lattice-bridge/src/client-vault/namespace-generation-cache-v1.ts";
import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../../../lattice-bridge/src/client-vault/profile-v4.ts";
import type { ClientProfileCoordinates } from
  "../../../lattice-bridge/src/client-vault/types.ts";
import {
  createDomainKeyAuthorityClientV2,
} from "../../../lattice-bridge/src/client/message/domain-key-authority-client.ts";
import {
  createDomainNamespaceAuthorityClientV2,
  type DomainNamespaceAuthorityClientV2,
} from "../../../lattice-bridge/src/client/message/domain-namespace-authority-client.ts";
import { MemoryClientProfileVault } from
  "../../../lattice-bridge/src/testing/client-profile-vault.ts";
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";

import {MESSAGE_BACKFILL_TOOL_CONTEXT_STEPS} from "../../../lattice-bridge/src/server/message/message-backfill-tool-context";

const SERVER_SCOPE = process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001";

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function injectFetch(
  app: Awaited<ReturnType<typeof setupOwnerAppFixture>>["app"],
): NautiloApiFetch {
  return async (request, init) => {
    const url = new URL(typeof request === "string"
      ? request
      : request instanceof URL ? request.href : request.url);
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new TypeError("Message backfill integration transport requires JSON");
    }
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(body === undefined || body === null ? {} : {payload: body}),
    });
    if (response.statusCode >= 400) console.error("M313 protocol response", url.pathname, response.statusCode, response.body);
    return new Response(response.body, {
      status: response.statusCode,
      headers: Object.fromEntries(Object.entries(response.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    });
  };
}

async function admittedApi(input: Readonly<{
  app: Awaited<ReturnType<typeof setupOwnerAppFixture>>["app"];
  bearer: string;
  deviceId: string;
  signingPrivateKey: Uint8Array;
  crypto: LatticeCrypto;
}>): Promise<NautiloApiClient> {
  const api = new NautiloApiClient(SERVER_SCOPE, {
    fetchImpl: injectFetch(input.app),
  });
  api.setToken(input.bearer);
  const response = await api.deviceAdmission.challenge({
    requestVersion: 1,
    deviceId: input.deviceId,
  });
  const proof = createDeviceAdmissionProof({
    crypto: input.crypto,
    challenge: deviceAdmissionChallengeFromDto(response.challenge),
    signingPrivateKey: input.signingPrivateKey,
  });
  const admitted = await api.deviceAdmission.prove({
    requestVersion: 1,
    proof: deviceAdmissionProofToDto(proof),
  });
  if (admitted.status !== "admitted") {
    throw new Error("M313 signed device admission failed");
  }
  return api;
}

async function profileVault(input: Readonly<{
  crypto: LatticeCrypto;
  coordinates: ClientProfileCoordinates;
  signing: Readonly<{publicKey: Uint8Array; privateKey: Uint8Array}>;
  encryption: Readonly<{publicKey: Uint8Array; privateKey: Uint8Array}>;
}>): Promise<MemoryClientProfileVault> {
  const v1 = encodeClientDeviceProfileV1({
    deviceId: input.coordinates.deviceId,
    signingPublicKey: input.signing.publicKey,
    signingPrivateKey: input.signing.privateKey,
    encryptionPublicKey: input.encryption.publicKey,
    encryptionPrivateKey: input.encryption.privateKey,
  });
  const profile = await createClientDeviceProfileV4Candidate({
    crypto: input.crypto,
    currentProfileBytes: v1,
    expectedDeviceId: input.coordinates.deviceId,
    v1Migration: {
      trustedDeviceRevision: 1,
      trustedHostAuthorizationRevision: 1,
      deliveryHighWatermark: 0,
    },
  });
  const bytes = encodeClientDeviceProfileV4(profile);
  const vault = new MemoryClientProfileVault();
  try {
    await vault.unlock();
    await vault.stageProfile({
      coordinates: input.coordinates,
      stageId: "m313-initial-profile",
      generation: 1,
      profileBytes: bytes,
      publicState: {
        clientKind: "browser",
        publicFingerprint: Array.from(input.signing.publicKey, byte =>
          byte.toString(16).padStart(2, "0")).join(""),
      },
    });
    await vault.activateProfile(input.coordinates, "m313-initial-profile");
    return vault;
  } finally {
    destroyOpenedClientDeviceProfileV4(profile);
    v1.fill(0);
    bytes.fill(0);
  }
}

function authorityClients(input: Readonly<{
  api: NautiloApiClient;
  crypto: LatticeCrypto;
  vault: MemoryClientProfileVault;
  coordinates: ClientProfileCoordinates;
}>) {
  const cache = new MemoryClientNamespaceGenerationCacheVaultV1();
  const namespaceRef: {current?: DomainNamespaceAuthorityClientV2} = {};
  const domain = createDomainKeyAuthorityClientV2({
    api: input.api,
    crypto: input.crypto,
    vault: input.vault,
    cache: createClientDomainKeyCacheVaultV2(cache),
    coordinates: input.coordinates,
    serverId: input.coordinates.serverScope,
    now: () => Date.now(),
    createId: randomUUID,
    scheduleRetry: () => undefined,
    onBacklogCoordinate: async request => {
      await namespaceRef.current?.ensure(request);
    },
    onDiagnostic: () => undefined,
  });
  const namespace = createDomainNamespaceAuthorityClientV2({
    api: input.api,
    crypto: input.crypto,
    vault: input.vault,
    coordinates: input.coordinates,
    domainAuthority: domain,
    serverId: input.coordinates.serverScope,
    now: () => Date.now(),
    createId: randomUUID,
  });
  namespaceRef.current = namespace;
  return {domain, namespace, cache};
}

async function preparePublication(input: Readonly<{
  crypto: LatticeCrypto;
  claim: MessageBackfillClaim;
  sourceBytesBase64url: string;
  sourceDigestBase64url: string;
  signingPublicKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  namespace: DomainNamespaceAuthorityClientV2;
}>) {
  const sourceBytes = Uint8Array.from(Buffer.from(
    input.sourceBytesBase64url,
    "base64url",
  ));
  const sourceDigest = Uint8Array.from(Buffer.from(
    input.sourceDigestBase64url,
    "base64url",
  ));
  const namespaceHead = Uint8Array.from(Buffer.from(
    input.claim.namespaceHeadDigestBase64url,
    "base64url",
  ));
  try {
    const payload = decodeMessagePayloadV2(sourceBytes);
    const opened = await input.namespace.withOpenedGenerations({
      sourceRoomId: input.claim.coordinate.roomId,
      namespaceId: input.claim.coordinate.namespaceId,
      keyClass: input.claim.keyClass,
      expectedAccessRevision: input.claim.namespaceAccessRevision,
      expectedCurrentGeneration: input.claim.namespaceKeyGeneration,
      expectedCurrentHeadDigest: namespaceHead,
    }, generations => {
      const generation = generations.find(entry =>
        entry.namespaceId === input.claim.coordinate.namespaceId
        && entry.keyClass === input.claim.keyClass
        && entry.generation === input.claim.namespaceKeyGeneration
        && entry.accessRevision === input.claim.namespaceAccessRevision);
      if (!generation) throw new Error("M313 Namespace generation did not open");
      const common = {
        crypto: input.crypto,
        objectId: input.claim.cryptoObjectId,
        payload,
        createdAt: input.claim.createdAt,
        device: {
          deviceId: input.claim.deviceId,
          hostAuthorizationRevision: input.claim.hostAuthorizationRevision,
          signingPrivateKey: input.signingPrivateKey,
        },
        resolveCurrentAuthorization: () => null,
      };
      const namespace = {
        namespaceId: input.claim.coordinate.namespaceId,
        accessRevision: input.claim.namespaceAccessRevision,
        keyGeneration: input.claim.namespaceKeyGeneration,
      };
      const prepared = input.claim.keyClass === "ai"
        ? prepareHumanExistingMessageRepresentationCryptoRevision({
          ...common,
          namespace: {...namespace, aiKey: generation.generationKey},
        })
        : prepareHumanPeerLiveShadowCryptoRevision({
          ...common,
          namespace: {...namespace, humanKey: generation.generationKey},
        });
      return readPreparedConversationCryptoRevision(prepared);
    });
    if (opened.status !== "opened") {
      throw new Error(`M313 Namespace authority unavailable: ${opened.reason}`);
    }
    const snapshot = opened.value;
    const envelope = snapshot.access.envelopeBytes[0];
    if (!envelope) throw new Error("M313 publication envelope is missing");
    const request = prepareHumanExistingMessageRepresentationPublicationRequest(
      input.crypto,
      {
        subjectHumanId: humanId(input.claim.subjectHumanId),
        operationId: input.claim.operationId,
        sessionId: input.claim.coordinate.sessionId,
        roomId: input.claim.coordinate.roomId,
        messageId: input.claim.coordinate.messageId,
        revision: input.claim.coordinate.revision,
        createdAt: unixTimestamp(input.claim.createdAt),
        authorRole: input.claim.coordinate.role,
        authorHumanTurnId: input.claim.authorHumanTurnId,
        sessionAgentId: input.claim.sessionAgentId === null
          ? null
          : agentId(input.claim.sessionAgentId),
        cryptoObjectId: objectId(input.claim.cryptoObjectId),
        namespaceId: cryptoNamespaceId(input.claim.coordinate.namespaceId),
        namespaceBindingHash: namespaceHead,
        namespaceAccessRevision: input.claim.namespaceAccessRevision,
        namespaceKeyGeneration: input.claim.namespaceKeyGeneration,
        bindingRevisionAtWrap: input.claim.namespaceAccessRevision,
        ciphertextPayloadHash: input.crypto.hash(snapshot.object.payloadBytes.ciphertext),
        plaintextPayloadHash: sourceDigest,
        accessManifestHash: input.crypto.hash(snapshot.access.manifestBytes),
        envelopeHash: input.crypto.hash(envelope),
        issuedAt: unixTimestamp(input.claim.issuedAt),
        deadlineAt: unixTimestamp(input.claim.expiresAt),
        committerDeviceId: cryptoDeviceId(input.claim.deviceId),
        hostAuthorizationRevision: authorizationRevision(
          input.claim.hostAuthorizationRevision,
        ),
        committerSigningPublicKey: input.signingPublicKey,
        committerSigningPrivateKey: input.signingPrivateKey,
      },
    );
    const manifestDigestBase64url = encode(input.crypto.hash(
      snapshot.access.manifestBytes,
    ));
    return {
      request: {
        claimId: input.claim.claimId,
        requestBytesBase64url: encode(request.bytes),
        payloadBytesBase64url: encode(snapshot.object.payloadBytes.ciphertext),
        manifestBytesBase64url: encode(snapshot.access.manifestBytes),
        envelopeBytesBase64url: encode(envelope),
      },
      manifestDigestBase64url,
      dispose() {
        request.bytes.fill(0);
        snapshot.object.payloadBytes.ciphertext.fill(0);
        snapshot.access.manifestBytes.fill(0);
        snapshot.access.envelopeBytes.forEach(value => value.fill(0));
      },
    };
  } finally {
    sourceBytes.fill(0);
    sourceDigest.fill(0);
    namespaceHead.fill(0);
  }
}

function reconciliationAck(
  crypto: LatticeCrypto,
  claim: MessageBackfillClaim,
  signingPrivateKey: Uint8Array,
  sourceDigestBase64url: string,
  manifestDigestBase64url: string,
) {
  const claimDigest = messageBackfillClaimDigest(claim);
  const unsigned = {
    claimId: claim.claimId,
    outcome: "reconciled" as const,
    claimDigestBase64url: encode(claimDigest),
    sourceDigestBase64url,
    manifestDigestBase64url,
  };
  const digest = messageBackfillAcknowledgementDigest(unsigned);
  const signature = crypto.sign(signingPrivateKey, digest);
  try {
    return {...unsigned, signatureBase64url: encode(signature)};
  } finally {
    claimDigest.fill(0);
    digest.fill(0);
    signature.fill(0);
  }
}

describe.serial("M314 production Message backfill protocol", () => {
  test.each(["group", "open"] as const)(
    "%s Rooms use real admission, waiting, publication, reader and ack for both key classes",
    async (roomKind) => {
    const fx = await setupOwnerAppFixture({suiteName: "m313a", withDefaultAgentGraph: true});
    const db = fx.db;
    const seated = await seatPeerUser(fx.db, {suiteName: "m313b", groupType: "owners"});
    const verifierSeated = await seatPeerUser(fx.db, {suiteName: "m313c", groupType: "owners"});
    const thirdSeated = await seatPeerUser(fx.db, {suiteName: "m313d", groupType: "owners"});
    const peer = {ownerId: seated.userId, ownerActorId: seated.actorId,
      mintOwnerBearer: () => Promise.resolve(seated.bearer),
      cleanup: async () => {
        await db.delete(groupMembers).where(eq(groupMembers.userId, seated.userId));
        await db.delete(profiles).where(eq(profiles.userId, seated.userId));
        await db.delete(channelIdentities).where(eq(channelIdentities.userId, seated.userId));
        await db.delete(credentials).where(eq(credentials.userId, seated.userId));
        await db.delete(actors).where(eq(actors.ownerId, seated.userId));
        await db.delete(agents).where(eq(agents.id, seated.agentId));
        await db.delete(users).where(eq(users.id, seated.userId));
      }};
    const verifier = {ownerId: verifierSeated.userId, ownerActorId: verifierSeated.actorId,
      mintOwnerBearer: () => Promise.resolve(verifierSeated.bearer),
      cleanup: async () => {
        await db.delete(groupMembers).where(eq(groupMembers.userId, verifierSeated.userId));
        await db.delete(profiles).where(eq(profiles.userId, verifierSeated.userId));
        await db.delete(channelIdentities).where(eq(channelIdentities.userId, verifierSeated.userId));
        await db.delete(credentials).where(eq(credentials.userId, verifierSeated.userId));
        await db.delete(actors).where(eq(actors.ownerId, verifierSeated.userId));
        await db.delete(agents).where(eq(agents.id, verifierSeated.agentId));
        await db.delete(users).where(eq(users.id, verifierSeated.userId));
      }};
    const third = {ownerId: thirdSeated.userId, ownerActorId: thirdSeated.actorId,
      mintOwnerBearer: () => Promise.resolve(thirdSeated.bearer),
      cleanup: async () => {
        await db.delete(groupMembers).where(eq(groupMembers.userId, thirdSeated.userId));
        await db.delete(profiles).where(eq(profiles.userId, thirdSeated.userId));
        await db.delete(channelIdentities).where(eq(channelIdentities.userId, thirdSeated.userId));
        await db.delete(credentials).where(eq(credentials.userId, thirdSeated.userId));
        await db.delete(actors).where(eq(actors.ownerId, thirdSeated.userId));
        await db.delete(agents).where(eq(agents.id, thirdSeated.agentId));
        await db.delete(users).where(eq(users.id, thirdSeated.userId));
      }};
    const crypto = new LatticeCrypto();
    const devices: Awaited<ReturnType<typeof seedBackfillDevice>>[] = [];
    const disposeClients: (() => Promise<void>)[] = [];
    const ownedSessions: string[] = [];
    const ownedNamespaces: string[] = [];
    let humanRoomId: string | undefined;
    let aiRetainedGeneration: Readonly<{
      namespaceGeneration: number;
      accessRevision: number;
      headDigestBase64url: string;
      publicationDigestBase64url: string;
      publicationSetDigestBase64url: string;
      audienceFingerprintBase64url: string;
    }> | undefined;
    const [originalPolicy] = await db.select().from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"));
    try {
      if (!fx.defaultRoomId || !fx.defaultAgentId || !originalPolicy) throw new Error("Missing graph/policy");
      const [identity] = await db.select().from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self"));
      const [agentRoom] = await db.select().from(rooms).where(eq(rooms.id, fx.defaultRoomId));
      if (!identity || !agentRoom?.namespaceId) throw new Error("Missing Server/Namespace");
      ownedNamespaces.push(agentRoom.namespaceId);
      await db.update(rooms).set({kind: roomKind})
        .where(eq(rooms.id, fx.defaultRoomId));
      await db.insert(roomMembers).values([
        {roomId: fx.defaultRoomId, actorId: peer.ownerActorId, roomRole: "member"},
        {roomId: fx.defaultRoomId, actorId: verifier.ownerActorId, roomRole: "member"},
        {roomId: fx.defaultRoomId, actorId: third.ownerActorId, roomRole: "member"},
      ]);
      await db.update(rooms).set({humanActorIds: [fx.ownerActorId, peer.ownerActorId, verifier.ownerActorId, third.ownerActorId].sort()})
        .where(eq(rooms.id, fx.defaultRoomId));
      const [humanNamespace] = await db.insert(namespaces).values({
        scope: "room",
        label: `M314 ${roomKind} Human-only`,
      }).returning();
      if (!humanNamespace) throw new Error("Missing Human Namespace");
      ownedNamespaces.push(humanNamespace.id);
      const [humanRoom] = await db.insert(rooms).values({ownerId: fx.ownerId, type: "shared", kind: roomKind,
        namespaceId: humanNamespace.id, humanActorIds: [fx.ownerActorId, peer.ownerActorId, verifier.ownerActorId, third.ownerActorId].sort(),
        createdBy: fx.ownerActorId, graphThreadId: `m314:${randomUUID()}`, label: `M314 ${roomKind} Human-only`}).returning();
      if (!humanRoom) throw new Error("Missing Human Room");
      humanRoomId = humanRoom.id;
      await db.insert(roomMembers).values([
        {roomId: humanRoom.id, actorId: fx.ownerActorId, roomRole: "admin"},
        {roomId: humanRoom.id, actorId: peer.ownerActorId, roomRole: "member"},
        {roomId: humanRoom.id, actorId: verifier.ownerActorId, roomRole: "member"},
        {roomId: humanRoom.id, actorId: third.ownerActorId, roomRole: "member"},
      ]);
      await db.update(encryptionTransitionPolicy).set({mode: "shadow_encryption", shadowBehavior: "strict",
        revision: sql`${encryptionTransitionPolicy.revision} + 1`, shadowEncryptionStartedAt: new Date(), updatedAt: new Date()})
        .where(eq(encryptionTransitionPolicy.id, "server"));
      const restricted = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
      // The Session owner/original author intentionally has no participating
      // device. Three other authorized Humans exercise repair and retained read.
      const clientOwners = [peer, verifier, third] as const;
      const clientInstallations = clientOwners.map(() => randomUUID());
      const clientIdentities = clientOwners.map((owner, index) => deriveAdditionalDeviceClientIdentity({
        crypto, serverScope: SERVER_SCOPE, userId: owner.ownerId, humanActorId: owner.ownerActorId,
        installationId: clientInstallations[index]!, clientKind: "browser",
      }));
      for (const [index, owner] of clientOwners.entries()) {
        const clientIdentity = clientIdentities[index]!;
        devices.push(await seedBackfillDevice({adminDb: db, restricted, crypto,
          userId: owner.ownerId, humanActorId: owner.ownerActorId, serverInstanceId: identity.serverInstanceId,
          deviceId: clientIdentity.coordinates.deviceId,
          installationLineageDigest: clientIdentity.installationLineageDigest}));
      }
      const clients = [];
      for (const [index, owner] of clientOwners.entries()) {
        const device = devices[index]!;
        const api = await admittedApi({app: fx.app, bearer: await owner.mintOwnerBearer(), deviceId: device.deviceId,
          signingPrivateKey: device.signing.privateKey, crypto});
        const coordinates: ClientProfileCoordinates = clientIdentities[index]!.coordinates;
        const vault = await profileVault({crypto, coordinates, signing: device.signing, encryption: device.encryption});
        disposeClients.push(async () => {await vault.forgetProfile(coordinates); await vault.lock();});
        const authority = authorityClients({api, crypto, vault, coordinates});
        disposeClients.push(async () => {await authority.cache.forget(coordinates); await authority.cache.lock();});
        const readerCache = new MemoryClientNamespaceGenerationCacheVaultV1();
        disposeClients.push(async () => {await readerCache.forget(coordinates); await readerCache.lock();});
        const readerPlatform = {
          clientKind: "browser",
          clientLabel: "Browser",
          createProfileVault: () => vault,
          createPreparedMutationJournalVault: () => {
            throw new Error("Message backfill reader does not use a mutation journal");
          },
          createNamespaceGenerationCacheVault: () => readerCache,
          createId: randomUUID,
        } satisfies ForegroundShadowClientPlatform;
        const reader = createForegroundRoomHistoryShadowMessageReader(readerPlatform, {
          api, serverScope: SERVER_SCOPE, userId: owner.ownerId, humanActorId: owner.ownerActorId,
          installationId: clientInstallations[index]!, crypto, createIdempotencyKey: randomUUID,
          resolveTrustedDeviceSigningPublicKey: () => Promise.resolve(null),
        });
        const backfill = createDeviceMessageBackfillClient({
          owner: bindEncryptionDataOperationOwner({policy: {
            resolve: () => Promise.resolve({
              policy: {mode: "shadow_encryption", shadowBehavior: "strict"}, revalidationToken: 1,
            }),
            revalidate: () => Promise.resolve(),
          }}),
          api, namespaceAuthority: createDomainNamespaceAuthorityAdapterV2({
            domainAuthority: authority.domain, namespaceAuthority: authority.namespace,
          }), vault, coordinates, crypto, historyReader: reader, now: Date.now, createId: randomUUID,
        });
        clients.push({api, authority, reader, backfill, device});
      }
      const a = clients[0]!, b = clients[1]!, c = clients[2]!;
      type ExpectedAttribution = Readonly<{role: "user" | "assistant" | "tool" | "system";
        sourceUserId?: string; authorAgentId?: string}>;
      const expectedAttribution = (role: string): ExpectedAttribution => {
        if (role === "user") return {role, sourceUserId: fx.ownerId};
        if (role === "system") return {role};
        if (role === "assistant" || role === "tool") return {role, authorAgentId: fx.defaultAgentId!};
        throw new Error(`Unexpected mixed role ${role}`);
      };
      const verifyHistory = async (client: typeof a, roomId: string,
        history: RoomHistoryShadowReadResponseV1, logicalMessageKey: string,
        sourceBytesBase64url: string, expected: ExpectedAttribution,
        expectedPublisher: "human_device" | "foreground_runtime" = "human_device") => {
        if (history.status !== "ready") throw new Error(`History unavailable: ${history.status}`);
        const record = history.records[0];
        if (!record || record.kind !== "existing_representation") throw new Error("Missing protected record");
        if (!record.protectedMessage.projection.logicalMessageKey ||
          (record.repair.publisherKind ?? "foreground_runtime") !== expectedPublisher ||
          (expectedPublisher === "human_device" && (!("publisherHumanId" in record.repair)
            || !record.repair.publisherHumanId))) {
          throw new Error(`Protected record lacks canonical ${expectedPublisher} repair evidence`);
        }
        expect(record.protectedMessage.projection).toMatchObject(expected);
        expect(record.coordinate.logicalMessageKey)
          .toBe(logicalMessageKey);
        const payload = decodeMessagePayloadV2(Uint8Array.from(Buffer.from(sourceBytesBase64url, "base64url")));
        const readerRecord = {
          kind: "existing_representation", sessionId: record.coordinate.sessionId,
          messageId: String(record.coordinate.messageId), editRevision: record.coordinate.editRevision,
          protectedMessage: {
            dtoVersion: 2,
            projection: {...record.protectedMessage.projection,
              logicalMessageKey: record.protectedMessage.projection.logicalMessageKey},
            protectedPayload: record.protectedMessage.protectedPayload,
          },
          repair: record.repair.publisherKind === "human_device" ? record.repair
            : {...record.repair, publisherKind: "foreground_runtime"},
          ...(record.retainedGeneration === undefined ? {} : {retainedGeneration: record.retainedGeneration}),
          representationMode: "ordinary-and-protected", ordinarySibling: {payload,
            logicalMessageKey: logicalMessageKey,
            ...(expected.sourceUserId === undefined ? {} : {sourceUserId: expected.sourceUserId}),
            ...(expected.authorAgentId === undefined ? {} : {authorAgentId: expected.authorAgentId})},
          ordinaryPayloadBytesBase64url: sourceBytesBase64url,
        } as RoomHistoryExistingRepresentationRecordTransportV1;
        const read = await client.reader.reconcile({sourceRoomId: roomId,
          authority: history.authority,
          ...(history.authorities === undefined ? {} : {authorities: history.authorities}),
          signerEvidence: history.signerEvidence,
          records: [readerRecord]});
        expect(read).toMatchObject({verifiedCount: 1, fallbackCounts: {}});
        return record.retainedGeneration;
      };
      const verifyProtected = async (client: typeof a, roomId: string, claimId: string,
        sourceBytesBase64url: string, expected: ExpectedAttribution,
        expectedPublisher: "human_device" | "foreground_runtime" = "human_device") => {
        const source = await client.api.readMessageBackfillSource({claimId});
        if (source.status !== "protected") throw new Error(`Protected source unavailable: ${source.status}`);
        return verifyHistory(client, roomId, source.history, source.claim.coordinate.logicalMessageKey,
          sourceBytesBase64url, expected, expectedPublisher);
      };
      const [defaultAgentActor] = await db.select({id: actors.id}).from(actors).where(and(
        eq(actors.agentId, fx.defaultAgentId), eq(actors.kind, "agent"),
      ));
      if (!defaultAgentActor) throw new Error("Missing default Agent actor");
      for (const topology of [
        {keyClass: "human" as const, roomId: humanRoom.id, namespaceId: humanNamespace.id,
          agentId: null, startsWithoutAuthority: roomKind === "open"},
        {keyClass: "ai" as const, roomId: fx.defaultRoomId, namespaceId: agentRoom.namespaceId,
          agentId: fx.defaultAgentId, startsWithoutAuthority: false},
      ]) {
        const coordinate = {sourceRoomId: topology.roomId, namespaceId: topology.namespaceId, keyClass: topology.keyClass};
        const [session] = await db.insert(sessions).values({ownerId: fx.ownerId, roomId: topology.roomId,
          agentId: topology.agentId, threadId: `m313:${randomUUID()}`, channel: "integration"}).returning();
        if (!session) throw new Error("Missing Session");
        ownedSessions.push(session.id);
        const [message] = await db.insert(sessionMessages).values({sessionId: session.id, role: "user",
          content: `M313 ${topology.keyClass} exact source`, fingerprint: randomUUID()}).returning();
        if (!message) throw new Error("Missing Message");
        const urgent = {roomId: topology.roomId, messageId: message.id, revision: 0};
        if (topology.startsWithoutAuthority) {
          expect(await a.api.nextMessageBackfill({urgent})).toMatchObject({
            status: "prepare_authority",
            coordinate: {
              roomId: topology.roomId,
              namespaceId: topology.namespaceId,
              messageId: message.id,
            },
            keyClass: topology.keyClass,
          });
          expect(await a.api.getMessageBackfillProgress()).toMatchObject({
            status: "waiting",
            counts: {unsupported: 0, failed: 0},
          });
        }
        expect(await a.authority.namespace.ensure(coordinate)).toEqual({status: "ready"});
        // M301's real request/delivery path supplies both independent Humans'
        // retained keys while the original author remains offline.
        await Promise.all([
          b.authority.namespace.ensure(coordinate),
          c.authority.namespace.ensure(coordinate),
        ]);
        await a.authority.domain.servicePending(coordinate);
        expect(await b.authority.namespace.ensure(coordinate)).toEqual({status: "ready"});
        expect(await c.authority.namespace.ensure(coordinate)).toEqual({status: "ready"});
        const racers = [a, b] as const;
        // All three current-member devices claim while the original author's
        // Human remains offline. The first two race publication; the third
        // independently verifies the immutable winner.
        const claims = await Promise.all(clients.map(client => client.api.nextMessageBackfill({urgent})));
        const [resultA, resultB, resultC] = claims;
        if (resultA?.status !== "claimed" || resultB?.status !== "claimed" || resultC?.status !== "claimed") {
          throw new Error(`All three devices need claims: ${JSON.stringify(claims)}`);
        }
        const claimA = resultA.claim, claimB = resultB.claim, claimC = resultC.claim;
        expect(claimA.subjectHumanId).not.toBe(claimB.subjectHumanId);
        expect(claimA.deviceId).not.toBe(claimB.deviceId);
        expect(claimA.keyClass).toBe(topology.keyClass);
        expect(claimB.cryptoObjectId).toBe(claimA.cryptoObjectId);
        if (topology.startsWithoutAuthority) {
          const heads = await db.select().from(namespaceDomainKeyHeads).where(and(
            eq(namespaceDomainKeyHeads.namespaceId, topology.namespaceId),
            eq(namespaceDomainKeyHeads.keyClass, topology.keyClass),
          ));
          if (heads.length === 0) throw new Error("Missing public authority head");
          await db.delete(namespaceDomainKeyHeads).where(and(
            eq(namespaceDomainKeyHeads.namespaceId, topology.namespaceId),
            eq(namespaceDomainKeyHeads.keyClass, topology.keyClass),
          ));
          try {
            expect(await a.api.readMessageBackfillSource({claimId: claimA.claimId}))
              .toMatchObject({status: "waiting_for_authority"});
          } finally {
            await db.insert(namespaceDomainKeyHeads).values(heads);
          }
        }
        const sources = await Promise.all(racers.map((client, index) => client.api.readMessageBackfillSource({claimId: index === 0 ? claimA.claimId : claimB.claimId})));
        const sourceA = sources[0]!, sourceB = sources[1]!;
        if (sourceA.status !== "ordinary" || sourceB.status !== "ordinary") throw new Error("Expected ordinary source for both claims");
        const publications = await Promise.all(racers.map((client, index) => preparePublication({crypto,
          claim: index === 0 ? claimA : claimB, sourceBytesBase64url: sourceA.payloadBytesBase64url,
          sourceDigestBase64url: sourceA.sourceDigestBase64url, signingPublicKey: client.device.signing.publicKey,
          signingPrivateKey: client.device.signing.privateKey, namespace: client.authority.namespace})));
        try {
          const settled = await Promise.allSettled(racers.map((client, index) => client.api.publishMessageBackfill(publications[index]!.request)));
          const results = settled.map(result => {
            if (result.status === "rejected") throw result.reason;
            return result.value;
          });
          expect(results.filter(result => result.status === "published")).toHaveLength(1);
          expect(results.every(result => result.status === "published" || result.status === "replayed" || result.status === "stale")).toBe(true);
          const winner = results.findIndex(result => result.status === "published");
          // Retry the winner's exact request as if its successful response had been lost.
          expect(await clients[winner]!.api.publishMessageBackfill(publications[winner]!.request)).toEqual({status: "replayed"});
          for (const [index, client] of racers.entries()) {
            const claim = index === 0 ? claimA : claimB;
            const source = await client.api.readMessageBackfillSource({claimId: claim.claimId});
            if (source.status !== "protected" || source.history.status !== "ready") throw new Error(`Real reader failed: ${source.status}`);
            const history = source.history;
            const record = history.records[0];
            if (!record || record.kind !== "existing_representation" || record.repair.publisherKind !== "human_device" || record.protectedMessage.protectedPayload.status !== "encrypted") throw new Error("Missing device repair record");
            const payload = decodeMessagePayloadV2(Uint8Array.from(Buffer.from(sourceA.payloadBytesBase64url, "base64url")));
            const read = await client.reader.reconcile({sourceRoomId: topology.roomId, authority: history.authority,
              signerEvidence: history.signerEvidence, records: [{kind: "existing_representation", sessionId: session.id,
                messageId: String(message.id), editRevision: 0, protectedMessage: {dtoVersion: 2,
                  projection: {messageId: String(message.id), sessionId: session.id, roomId: topology.roomId,
                    namespaceId: topology.namespaceId, role: "user", createdAt: message.createdAt.toISOString(), editRevision: 0},
                  protectedPayload: record.protectedMessage.protectedPayload},
                repair: record.repair, ...(record.retainedGeneration === undefined ? {} : {retainedGeneration: record.retainedGeneration}),
                representationMode: "ordinary-and-protected", ordinarySibling: {payload},
                ordinaryPayloadBytesBase64url: sourceA.payloadBytesBase64url}]});
            expect(read.verifiedCount).toBe(1);
            const acknowledgement = await client.api.acknowledgeMessageBackfill(reconciliationAck(crypto, claim,
              client.device.signing.privateKey, sourceA.sourceDigestBase64url, publications[winner]!.manifestDigestBase64url));
            expect(["more", "caught_up"]).toContain(acknowledgement.status);
          }
          const retainedGeneration = await verifyProtected(c, topology.roomId, claimC.claimId, sourceA.payloadBytesBase64url,
            {role: "user", sourceUserId: fx.ownerId});
          if (topology.keyClass === "ai") {
            if (!retainedGeneration) throw new Error("AI repair lacks retained Namespace generation");
            aiRetainedGeneration = retainedGeneration;
          }
          expect(["more", "caught_up"]).toContain((await c.api.acknowledgeMessageBackfill(reconciliationAck(crypto,
            claimC, c.device.signing.privateKey, sourceA.sourceDigestBase64url,
            publications[winner]!.manifestDigestBase64url))).status);
          const rows = await db.select().from(sessionMessageCryptoRevisions).where(eq(sessionMessageCryptoRevisions.messageId, message.id));
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({cryptoObjectId: claimA.cryptoObjectId, completion: "complete", disposition: "mapped", parityStatus: "client_verified"});
          expect(await a.api.getMessageBackfillProgress()).toMatchObject({caughtUp: true, snapshotComplete: true});

          if (roomKind === "open") {
            const [existingAgentMembership] = await db.select().from(roomMembers).where(and(
              eq(roomMembers.roomId, topology.roomId), eq(roomMembers.actorId, defaultAgentActor.id),
            ));
            if (topology.keyClass === "human") {
              expect(existingAgentMembership).toBeUndefined();
              await db.insert(roomMembers).values({roomId: topology.roomId,
                actorId: defaultAgentActor.id, roomRole: "member"});
            } else {
              if (!existingAgentMembership) throw new Error("Missing AI-class Agent membership");
              await db.delete(roomMembers).where(and(eq(roomMembers.roomId, topology.roomId),
                eq(roomMembers.actorId, defaultAgentActor.id)));
            }
            try {
              await db.update(sessionMessages).set({content: null}).where(eq(sessionMessages.id, message.id));
              const restoreProbe = await b.api.nextMessageBackfill({urgent});
              if (restoreProbe.status !== "claimed") {
                throw new Error(`Protected-only restoration was not claimed: ${JSON.stringify(restoreProbe)}`);
              }
              expect(restoreProbe.claim).toMatchObject({action: "restore", keyClass: topology.keyClass});
              const protectedOnly = await b.api.readMessageBackfillSource({claimId: restoreProbe.claim.claimId});
              if (protectedOnly.status !== "protected") {
                throw new Error(`Protected-only restoration source unavailable: ${protectedOnly.status}`);
              }
              expect(protectedOnly).toMatchObject({
                ordinaryPayloadBytesBase64url: null,
                history: {status: "ready", records: [{
                  representationMode: "protected-only",
                  protectedMessage: {protectedPayload: {keyClass: topology.keyClass}},
                }]},
              });

              c.backfill.prioritize(urgent);
              const restored = await c.backfill.runBatch({signal: new AbortController().signal});
              expect(["more", "caught_up"]).toContain(restored.state);
              expect(restored).toMatchObject({
                reconciled: true,
                reconciledSelection: urgent,
              });
              const [restoredMessage] = await db.select({content: sessionMessages.content,
                role: sessionMessages.role}).from(sessionMessages).where(eq(sessionMessages.id, message.id));
              expect(restoredMessage).toEqual({content: message.content, role: "user"});
              const [retainedLifecycle] = await db.select({keyClass: sessionMessageCryptoRevisions.keyClass,
                disposition: sessionMessageCryptoRevisions.disposition}).from(sessionMessageCryptoRevisions)
                .where(eq(sessionMessageCryptoRevisions.messageId, message.id));
              expect(retainedLifecycle).toEqual({keyClass: topology.keyClass, disposition: "mapped"});
            } finally {
              if (topology.keyClass === "human") {
                await db.delete(roomMembers).where(and(eq(roomMembers.roomId, topology.roomId),
                  eq(roomMembers.actorId, defaultAgentActor.id)));
              } else if (existingAgentMembership) {
                await db.insert(roomMembers).values(existingAgentMembership);
              }
            }
          }
        } finally {publications.forEach(publication => publication.dispose());}
      }
      const [mixedSession] = await db.insert(sessions).values({ownerId: fx.ownerId,
        roomId: fx.defaultRoomId, agentId: fx.defaultAgentId,
        threadId: `m313-mixed:${randomUUID()}`, channel: "integration"}).returning();
      if (!mixedSession) throw new Error("Missing mixed-role Session");
      ownedSessions.push(mixedSession.id);
      const mixedStart = Date.now() - 30_000;
      const mixedRows = await db.insert(sessionMessages).values([
        {sessionId: mixedSession.id, role: "user", content: "Offline Human source",
          humanTurnId: `m313-human-${randomUUID()}`, createdAt: new Date(mixedStart)},
        {sessionId: mixedSession.id, role: "assistant", content: "Offline Agent source",
          createdAt: new Date(mixedStart + 1)},
        {sessionId: mixedSession.id, role: "system", content: "Offline system source",
          toolCalls: JSON.stringify({reason: "m313-retained-proof"}), createdAt: new Date(mixedStart + 2)},
        {sessionId: mixedSession.id, role: "assistant", content: "",
          toolCalls: JSON.stringify([{id: "m313-mixed-call", name: "lookup", args: {term: "retained"}}]),
          createdAt: new Date(mixedStart + 3)},
        {sessionId: mixedSession.id, role: "tool", content: "Offline Tool source", toolName: "lookup",
          createdAt: new Date(mixedStart + 4)},
      ]).returning();
      const verificationQueue: Array<Readonly<{claim: MessageBackfillClaim; sourceDigestBase64url: string;
        manifestDigestBase64url: string; sourceBytesBase64url: string;
        expected: ExpectedAttribution}>> = [];
      for (const message of mixedRows) {
        // Revoke the final Message publisher independently of the device that
        // maintains current Domain/Namespace key authority.
        const publisher = message.role === "tool" ? b : a;
        const queued = verificationQueue.shift();
        if (queued !== undefined) {
          await verifyProtected(c, fx.defaultRoomId, queued.claim.claimId, queued.sourceBytesBase64url,
            queued.expected);
          await c.api.acknowledgeMessageBackfill(reconciliationAck(crypto, queued.claim,
            c.device.signing.privateKey, queued.sourceDigestBase64url, queued.manifestDigestBase64url));
        }
        const urgent = {roomId: fx.defaultRoomId, messageId: message.id, revision: message.editRevision};
        const repairing = await publisher.api.nextMessageBackfill({urgent});
        if (repairing.status !== "claimed") throw new Error(`Mixed-role repair was not claimed: ${JSON.stringify(repairing)}`);
        const verifying = await c.api.nextMessageBackfill({urgent});
        if (verifying.status !== "claimed") throw new Error(`Mixed-role verification was not claimed: ${JSON.stringify(verifying)}`);
        const source = await publisher.api.readMessageBackfillSource({claimId: repairing.claim.claimId});
        if (source.status !== "ordinary") throw new Error(`Mixed-role source unavailable: ${source.status}`);
        const publication = await preparePublication({crypto, claim: repairing.claim,
          sourceBytesBase64url: source.payloadBytesBase64url, sourceDigestBase64url: source.sourceDigestBase64url,
          signingPublicKey: publisher.device.signing.publicKey, signingPrivateKey: publisher.device.signing.privateKey,
          namespace: publisher.authority.namespace});
        try {
          expect(await publisher.api.publishMessageBackfill(publication.request)).toEqual({status: "published"});
          const expected = expectedAttribution(message.role);
          await verifyProtected(publisher, fx.defaultRoomId, repairing.claim.claimId, source.payloadBytesBase64url,
            expected);
          expect(["more", "caught_up"]).toContain((await publisher.api.acknowledgeMessageBackfill(reconciliationAck(crypto,
            repairing.claim, publisher.device.signing.privateKey, source.sourceDigestBase64url,
            publication.manifestDigestBase64url))).status);
          verificationQueue.push({claim: verifying.claim, sourceDigestBase64url: source.sourceDigestBase64url,
            manifestDigestBase64url: publication.manifestDigestBase64url,
            sourceBytesBase64url: source.payloadBytesBase64url, expected});
        } finally {publication.dispose();}
      }

      if (!aiRetainedGeneration) throw new Error("Missing retained AI Namespace authority");
      const raceRetainedGeneration = aiRetainedGeneration;
      const [racePolicy] = await db.select().from(encryptionTransitionPolicy)
        .where(eq(encryptionTransitionPolicy.id, "server"));
      if (!racePolicy) throw new Error("Missing race policy");
      const [raceSession] = await db.insert(sessions).values({ownerId: fx.ownerId,
        roomId: fx.defaultRoomId, agentId: fx.defaultAgentId,
        threadId: `m313-runtime-race:${randomUUID()}`, channel: "integration"}).returning();
      if (!raceSession) throw new Error("Missing Runtime race Session");
      ownedSessions.push(raceSession.id);
      for (const publicationOrder of ["concurrent", "runtime_first"] as const) {
      const [raceMessage] = await db.insert(sessionMessages).values({sessionId: raceSession.id,
        role: "assistant", content: `M311 and M313 publication: ${publicationOrder}`,
        createdAt: new Date()}).returning();
      if (!raceMessage) throw new Error("Missing Runtime race Message");
      const raceUrgent = {roomId: fx.defaultRoomId, messageId: raceMessage.id,
        revision: raceMessage.editRevision};
      const humanRaceClaim = await a.api.nextMessageBackfill({urgent: raceUrgent});
      if (humanRaceClaim.status !== "claimed") {
        throw new Error(`Human Runtime-race claim unavailable: ${JSON.stringify(humanRaceClaim)}`);
      }
      const raceSource = await a.api.readMessageBackfillSource({claimId: humanRaceClaim.claim.claimId});
      if (raceSource.status !== "ordinary") throw new Error(`Runtime-race source unavailable: ${raceSource.status}`);
      const humanRacePublication = await preparePublication({crypto, claim: humanRaceClaim.claim,
        sourceBytesBase64url: raceSource.payloadBytesBase64url,
        sourceDigestBase64url: raceSource.sourceDigestBase64url,
        signingPublicKey: a.device.signing.publicKey, signingPrivateKey: a.device.signing.privateKey,
        namespace: a.authority.namespace});
      const openedRaceNamespace = await a.authority.namespace.withOpenedGenerations({
        sourceRoomId: fx.defaultRoomId, namespaceId: agentRoom.namespaceId, keyClass: "ai",
        expectedAccessRevision: raceRetainedGeneration.accessRevision,
        expectedCurrentGeneration: raceRetainedGeneration.namespaceGeneration,
        expectedCurrentHeadDigest: Uint8Array.from(Buffer.from(raceRetainedGeneration.headDigestBase64url, "base64url")),
      }, generations => {
        const generation = generations.find(value => value.namespaceId === agentRoom.namespaceId
          && value.keyClass === "ai" && value.generation === raceRetainedGeneration.namespaceGeneration);
        if (!generation) throw new Error("Runtime-race Namespace generation did not open");
        return Object.freeze({key: generation.generationKey.slice(),
          accessRevision: raceRetainedGeneration.accessRevision,
          keyGeneration: raceRetainedGeneration.namespaceGeneration,
          headDigest: Uint8Array.from(Buffer.from(raceRetainedGeneration.headDigestBase64url, "base64url")),
          publicationDigest: Uint8Array.from(Buffer.from(raceRetainedGeneration.publicationDigestBase64url, "base64url")),
          publicationSetDigest: Uint8Array.from(Buffer.from(raceRetainedGeneration.publicationSetDigestBase64url, "base64url")),
          audienceFingerprint: Uint8Array.from(Buffer.from(raceRetainedGeneration.audienceFingerprintBase64url, "base64url"))});
      });
      if (openedRaceNamespace.status !== "opened") {
        throw new Error(`Runtime-race Namespace unavailable: ${openedRaceNamespace.reason}`);
      }
      const runtimeAgentId = fx.defaultAgentId;
      if (!runtimeAgentId) throw new Error("Missing Runtime-race Agent");
      const runtimeKey = crypto.randomBytes(32);
      const runtime = Object.freeze({agentId: agentId(runtimeAgentId), keyClass: "runtime" as const,
        generation: agentRuntimeGeneration(1), key: runtimeKey});
      const runtimeSigner = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
      try {
        const repairWithRuntime = () => runForegroundRuntimeMessageRepair({crypto, restricted, userId: peer.ownerId,
            humanActorId: peer.ownerActorId, agentId: runtimeAgentId,
            namespaceId: agentRoom.namespaceId, messageId: raceMessage.id,
            policyRevision: racePolicy.revision,
            domain: {id: humanRaceClaim.claim.domainId, generation: humanRaceClaim.claim.domainGeneration,
              authorizationRevision: humanRaceClaim.claim.domainAuthorizationRevision,
              headDigest: Uint8Array.from(Buffer.from(humanRaceClaim.claim.domainHeadDigestBase64url, "base64url"))},
            registerCleanup: cleanup => disposeClients.push(cleanup),
            namespace: openedRaceNamespace.value,
            runtime: {agentId: runtimeAgentId, generation: Number(runtime.generation), runtimeKey,
              signerKeyId: runtimeSigner.principal.signerKeyId,
              signerPublicKey: runtimeSigner.publicKey}});
        const runtimeRepair = repairWithRuntime();
        if (publicationOrder === "runtime_first") {
          expect(await runtimeRepair).toMatchObject({status: "verified",
            messages: [{messageId: raceMessage.id, provenance: "repaired"}]});
        }
        const settled = await Promise.allSettled([
          runtimeRepair,
          a.api.publishMessageBackfill(humanRacePublication.request),
        ]);
        const runtimeResult = settled[0];
        const humanResult = settled[1];
        if (runtimeResult.status === "rejected") throw runtimeResult.reason;
        if (humanResult.status === "rejected") throw humanResult.reason;
        // A competing Human may own the durable reservation before its
        // ciphertext is stored. The Runtime safely waits, then independently
        // opens the winner on continuation after both publications settle.
        if (runtimeResult.value.status === "waiting_for_authority") {
          expect(runtimeResult.value).toMatchObject({reason: "message_repair_reservation_stale"});
          expect(["published", "replayed"]).toContain(humanResult.value.status);
          expect(await repairWithRuntime()).toMatchObject({status: "verified"});
        } else expect(runtimeResult.value).toMatchObject({status: "verified"});
        expect(["published", "replayed", "stale"]).toContain(humanResult.value.status);
        const protectedRace = await a.api.readMessageBackfillSource({claimId: humanRaceClaim.claim.claimId});
        if (protectedRace.status !== "protected" || protectedRace.history.status !== "ready") {
          throw new Error(`Runtime-race protected source unavailable: ${protectedRace.status}`);
        }
        const protectedRaceRecord = protectedRace.history.records[0];
        if (!protectedRaceRecord || protectedRaceRecord.kind !== "existing_representation"
          || protectedRaceRecord.protectedMessage.protectedPayload.status !== "encrypted") {
          throw new Error("Runtime-race protected representation missing");
        }
        const expectedPublisher = protectedRaceRecord.repair.publisherKind === "human_device"
          ? "human_device" as const : "foreground_runtime" as const;
        if (publicationOrder === "runtime_first") expect(expectedPublisher).toBe("foreground_runtime");
        expect(protectedRaceRecord.repair.publisherSignerKeyId).toBe(expectedPublisher === "human_device"
          ? a.device.deviceId : runtimeSigner.principal.signerKeyId);
        await verifyProtected(a, fx.defaultRoomId, humanRaceClaim.claim.claimId,
          raceSource.payloadBytesBase64url, {role: "assistant", authorAgentId: fx.defaultAgentId},
          expectedPublisher);
        const manifestDigest = crypto.hash(Uint8Array.from(Buffer.from(
          protectedRaceRecord.protectedMessage.protectedPayload.accessManifestBytesBase64url, "base64url")));
        try {
          expect(["more", "caught_up"]).toContain((await a.api.acknowledgeMessageBackfill(reconciliationAck(
            crypto, humanRaceClaim.claim, a.device.signing.privateKey,
            raceSource.sourceDigestBase64url, encode(manifestDigest)))).status);
        } finally {manifestDigest.fill(0);}
        const [mappedRace] = await db.select().from(sessionMessageCryptoRevisions)
          .where(eq(sessionMessageCryptoRevisions.messageId, raceMessage.id));
        expect(mappedRace).toMatchObject({cryptoObjectId: humanRaceClaim.claim.cryptoObjectId,
          completion: "complete", disposition: "mapped"});
        expect(["client_verified", "server_verified"]).toContain(mappedRace!.parityStatus);
        if (expectedPublisher === "foreground_runtime") expect(mappedRace?.parityStatus).toBe("server_verified");
      } finally {
        humanRacePublication.dispose();
        openedRaceNamespace.value.key.fill(0);
        openedRaceNamespace.value.headDigest.fill(0);
        openedRaceNamespace.value.publicationDigest.fill(0);
        openedRaceNamespace.value.publicationSetDigest.fill(0);
        openedRaceNamespace.value.audienceFingerprint.fill(0);
        runtimeKey.fill(0);
        runtimeSigner.publicKey.fill(0);
      }
      }

      // A retained-key outage in a long Tool prefix must release the one parser
      // slot so a different Room's healthy Tool can make progress.
      const toolSessions = await db.insert(sessions).values([
        {ownerId: fx.ownerId, roomId: humanRoom.id, agentId: null, threadId: `m313-blocked:${randomUUID()}`, channel: "integration"},
        {ownerId: fx.ownerId, roomId: fx.defaultRoomId, agentId: fx.defaultAgentId, threadId: `m313-ready:${randomUUID()}`, channel: "integration"},
      ]).returning();
      const blockedSession = toolSessions[0]!, readySession = toolSessions[1]!;
      ownedSessions.push(blockedSession.id, readySession.id);
      const start = Date.now() - 60_000;
      await db.insert(sessionMessages).values(Array.from({length: MESSAGE_BACKFILL_TOOL_CONTEXT_STEPS + 1}, (_, index) => ({
        sessionId: blockedSession.id, role: "user", content: `prefix ${index}`, createdAt: new Date(start + index),
      })));
      const tools = [];
      for (const session of toolSessions) {
        await db.insert(sessionMessages).values({sessionId: session.id, role: "assistant", content: "",
          toolCalls: JSON.stringify([{id: `call-${session.id}`, name: "lookup", args: {}}]), createdAt: new Date(start + 1_000)});
        const [tool] = await db.insert(sessionMessages).values({sessionId: session.id, role: "tool", toolName: "lookup",
          content: "retained Tool result", createdAt: new Date(start + 2_000)}).returning();
        if (!tool) throw new Error("Missing Tool fixture");
        tools.push(tool);
      }
      const blockedPriority = {roomId: humanRoom.id, messageId: tools[0]!.id, revision: 0};
      const firstBlocked = await a.api.nextMessageBackfill({urgent: blockedPriority});
      let activeContexts = await db.select({id: messageBackfillToolContexts.targetMessageId}).from(messageBackfillToolContexts)
        .where(eq(messageBackfillToolContexts.humanActorId, peer.ownerActorId));
      if (activeContexts.length === 0) {
        // An urgent activation alternates with an ordinary candidate. Complete
        // that real prefix claim before the new Tool can own the parser slot.
        if (firstBlocked.status === "claimed") {
          expect(firstBlocked.claim.coordinate.sessionId).toBe(blockedSession.id);
          expect(firstBlocked.claim.coordinate.role).toBe("user");
          const source = await a.api.readMessageBackfillSource({claimId: firstBlocked.claim.claimId});
          if (source.status !== "ordinary") throw new Error("Missing ordinary prefix source");
          const publication = await preparePublication({crypto, claim: firstBlocked.claim,
            sourceBytesBase64url: source.payloadBytesBase64url, sourceDigestBase64url: source.sourceDigestBase64url,
            signingPublicKey: a.device.signing.publicKey, signingPrivateKey: a.device.signing.privateKey,
            namespace: a.authority.namespace});
          try {
            expect(await a.api.publishMessageBackfill(publication.request)).toEqual({status: "published"});
            await verifyProtected(a, humanRoom.id, firstBlocked.claim.claimId, source.payloadBytesBase64url,
              {role: "user", sourceUserId: fx.ownerId});
            await a.api.acknowledgeMessageBackfill(reconciliationAck(crypto, firstBlocked.claim,
              a.device.signing.privateKey, source.sourceDigestBase64url, publication.manifestDigestBase64url));
          } finally {publication.dispose();}
        } else expect(["more", "caught_up", "waiting"]).toContain(firstBlocked.status);
        const resumed = await a.api.nextMessageBackfill({urgent: blockedPriority});
        expect(resumed.status).toBe("more");
        activeContexts = await db.select({id: messageBackfillToolContexts.targetMessageId}).from(messageBackfillToolContexts)
          .where(eq(messageBackfillToolContexts.humanActorId, peer.ownerActorId));
      }
      expect(activeContexts).toEqual([{id: tools[0]!.id}]);
      const heads = await db.select().from(namespaceDomainKeyHeads).where(and(
        eq(namespaceDomainKeyHeads.namespaceId, humanNamespace.id), eq(namespaceDomainKeyHeads.keyClass, "human")));
      expect(heads).toHaveLength(1);
      await db.delete(namespaceDomainKeyHeads).where(and(eq(namespaceDomainKeyHeads.namespaceId, humanNamespace.id),
        eq(namespaceDomainKeyHeads.keyClass, "human")));
      try {
        let healthy = await a.api.nextMessageBackfill({urgent: {roomId: fx.defaultRoomId, messageId: tools[1]!.id, revision: 0}});
        if (healthy.status === "prepare_authority") {
          expect(healthy.coordinate.roomId).toBe(humanRoom.id);
          healthy = await a.api.nextMessageBackfill({urgent: {roomId: fx.defaultRoomId, messageId: tools[1]!.id, revision: 0}});
        }
        if (healthy.status !== "claimed") throw new Error(`Healthy Tool blocked: ${JSON.stringify(healthy)}`);
        if (healthy.status === "claimed") {
          expect(healthy.claim.coordinate.messageId).toBe(tools[1]!.id);
        }
      } finally {await db.insert(namespaceDomainKeyHeads).values(heads);}


      await db.update(humanCryptoDevices).set({state: "revoked", revokedAt: new Date(), revision: sql`${humanCryptoDevices.revision} + 1`})
        .where(eq(humanCryptoDevices.deviceId, b.device.deviceId));
      // Device removal changes Domain authorization. Drive the real M301
      // authority transition and retained-key delivery before historical read.
      const retainedCoordinate = {sourceRoomId: fx.defaultRoomId,
        namespaceId: agentRoom.namespaceId, keyClass: "ai" as const};
      expect(await a.authority.namespace.ensure(retainedCoordinate)).toEqual({status: "ready"});
      await c.authority.namespace.ensure(retainedCoordinate);
      await a.authority.domain.servicePending(retainedCoordinate);
      expect(await c.authority.namespace.ensure(retainedCoordinate)).toEqual({status: "ready"});
      const retained = verificationQueue.shift();
      if (!retained) throw new Error("Missing retained-read fixture");
      // The pre-removal repair claim is stale after rotation. Historical reads
      // use fresh current authority and the immutable accepted Message evidence.
      const retainedHistory = await c.api.getRoomMessageShadowRead({roomId: fx.defaultRoomId,
        intent: {requestVersion: 1, clientRequestKey: randomUUID(), readerDeviceId: c.device.deviceId},
        coordinate: {sessionId: retained.claim.coordinate.sessionId,
          messageId: retained.claim.coordinate.messageId, editRevision: retained.claim.coordinate.revision,
          role: retained.claim.coordinate.role, logicalMessageKey: retained.claim.coordinate.logicalMessageKey}});
      if (retainedHistory.status !== "ready") throw new Error("Retained history is unavailable");
      expect(retainedHistory.records[0]).toMatchObject({kind: "existing_representation",
        repair: {publisherKind: "human_device", publisherSignerKeyId: b.device.deviceId}});
      await verifyHistory(c, fx.defaultRoomId, retainedHistory, retained.claim.coordinate.logicalMessageKey,
        retained.sourceBytesBase64url, retained.expected);
      expect((await c.api.acknowledgeMessageBackfill(reconciliationAck(crypto, retained.claim,
        c.device.signing.privateKey, retained.sourceDigestBase64url, retained.manifestDigestBase64url))).status)
        .toBe("stale");
      const rejected = await b.api.nextMessageBackfill({}).then(() => null, (error: unknown) => error);
      expect(rejected).toMatchObject({status: 428});
    } finally {
      for (const dispose of [...disposeClients].reverse()) await dispose();
      for (const device of devices) {
        device.signing.privateKey.fill(0); device.encryption.privateKey.fill(0); device.membershipVault.destroy();
      }
      await db.delete(encryptionTransitionHistoryReadAdmissions).where(inArray(encryptionTransitionHistoryReadAdmissions.subjectHumanId,
        [fx.ownerActorId, peer.ownerActorId, verifier.ownerActorId, third.ownerActorId]));
      if (originalPolicy) await db.update(encryptionTransitionPolicy).set({mode: originalPolicy.mode,
        shadowBehavior: originalPolicy.shadowBehavior, shadowEncryptionStartedAt: originalPolicy.shadowEncryptionStartedAt,
        revision: sql`${encryptionTransitionPolicy.revision} + 1`, updatedAt: new Date()}).where(eq(encryptionTransitionPolicy.id, "server"));
      if (ownedSessions.length > 0) {
        const objects = await db.select({id: sessionMessageCryptoRevisions.cryptoObjectId}).from(sessionMessageCryptoRevisions)
          .where(inArray(sessionMessageCryptoRevisions.sessionId, ownedSessions));
        const ids = objects.map(row => row.id);
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ownedSessions));
        if (ids.length > 0) {
          await db.delete(objectCryptoAccessHeads).where(inArray(objectCryptoAccessHeads.objectId, ids));
          await db.delete(objectCryptoNamespaceEnvelopes).where(inArray(objectCryptoNamespaceEnvelopes.objectId, ids));
          await db.delete(objectCryptoAccessManifests).where(inArray(objectCryptoAccessManifests.objectId, ids));
          await db.delete(cryptoObjects).where(inArray(cryptoObjects.objectId, ids));
        }
        await db.delete(sessionMessageCryptoRevisions).where(inArray(sessionMessageCryptoRevisions.sessionId, ownedSessions));
      }
      if (ownedNamespaces.length > 0) {
        await db.delete(namespaceDomainKeyHeads).where(inArray(namespaceDomainKeyHeads.namespaceId, ownedNamespaces));
        await db.delete(namespaceDomainKeyBindings).where(inArray(namespaceDomainKeyBindings.namespaceId, ownedNamespaces));
      }
      const humanIds = [fx.ownerActorId, peer.ownerActorId, verifier.ownerActorId, third.ownerActorId];
      const deviceIds = devices.map(device => device.deviceId);
      if (deviceIds.length > 0) await db.delete(domainKeyEnvelopeAcknowledgements).where(inArray(domainKeyEnvelopeAcknowledgements.recipientDeviceId, deviceIds));
      await db.delete(domainKeyRecipientEnvelopes).where(or(inArray(domainKeyRecipientEnvelopes.issuerHumanId, humanIds), inArray(domainKeyRecipientEnvelopes.recipientHumanId, humanIds)));
      await db.delete(domainKeyRecipientRequests).where(inArray(domainKeyRecipientRequests.recipientHumanId, humanIds));
      await db.delete(domainKeyHeads).where(inArray(domainKeyHeads.issuerHumanId, humanIds));
      await db.delete(domainKeyPublicationOperations).where(inArray(domainKeyPublicationOperations.issuerHumanId, humanIds));
      for (const device of [...devices].reverse()) await device.cleanup();
      if (ownedSessions.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ownedSessions));
        await db.delete(sessions).where(inArray(sessions.id, ownedSessions));
      }
      if (humanRoomId) {
        await db.delete(roomMembers).where(eq(roomMembers.roomId, humanRoomId));
        await db.delete(rooms).where(eq(rooms.id, humanRoomId));
        await db.delete(namespaces).where(eq(namespaces.id, ownedNamespaces[1]!));
      }
      if (fx.defaultRoomId) await db.delete(roomMembers).where(and(
        eq(roomMembers.roomId, fx.defaultRoomId),
        inArray(roomMembers.actorId, [peer.ownerActorId, verifier.ownerActorId, third.ownerActorId]),
      ));
      await peer.cleanup();
      await verifier.cleanup();
      await third.cleanup();
      await fx.cleanup();
    }
    },
    120_000,
  );
});
