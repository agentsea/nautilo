import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareDeviceWrappedAgentLiveShadowStreamStart,
  sealDeviceWrappedAgentLiveShadowStreamFrame,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  encodeLiveShadowMessagePlanV4,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import { parseProtectedMessageDtoV2 } from "@nautilo/types";
import type { ClientProfileVault } from "../../src/client-vault/types.ts";
import type {
  NamespaceAuthorityClient,
  OpenedNamespaceGeneration,
} from "../../src/client/message/namespace-authority-client.ts";
import { createVaultLiveShadowMessageReceiver } from "../../src/client/message/vault-live-shadow-message-receiver.ts";
import { fullEncryptionDurableEventDigestV2 } from "../../src/message/live-shadow-realtime-evidence.ts";
import { prepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDek } from "../../src/message/agent-conversation-crypto.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from "../../src/message/conversation-repository.ts";
import { encodeMessagePayloadV2 } from "../../src/message/message-payload-v2.ts";
import { readPreparedConversationCryptoRevisionSnapshot } from "../../src/message/conversation-prepared-revision.ts";

const NOW = 1_800_318_000_000,
  SESSION = "10000000-0000-4000-8000-000000000318",
  ROOM = "20000000-0000-4000-8000-000000000318",
  NS = "30000000-0000-4000-8000-000000000318",
  AGENT = "40000000-0000-4000-8000-000000000318";
const b64 = (v: Uint8Array) => Buffer.from(v).toString("base64url");

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(318901));
  const key = new Uint8Array(32).fill(0x95),
    head = new Uint8Array(32).fill(0x31),
    pub = new Uint8Array(32).fill(0x32),
    set = new Uint8Array(32).fill(0x33),
    audience = new Uint8Array(32).fill(0x34);
  const runtime = Object.freeze({
    agentId: agentId(AGENT),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(2),
    key: new Uint8Array(32).fill(0x96),
  });
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const planBytes = encodeLiveShadowMessagePlanV4({
    formatVersion: 4,
    purpose: "message.live_shadow_plan",
    operationId: "op-m318",
    policyRevision: 4,
    sessionId: SESSION,
    roomId: ROOM,
    humanMessageId: 318,
    revision: 0,
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId("human-m318"),
    committerDeviceId: cryptoDeviceId("device-m318"),
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(7),
    recipientAgentId: runtime.agentId,
    agentAuthorizationRevision: authorizationRevision(5),
    agentRuntimeGeneration: runtime.generation,
    agentSignerKeyId: signer.principal.signerKeyId,
    agentSignerPublicKey: signer.publicKey,
    namespaceId: namespaceId(NS),
    namespaceAccessRevision: accessRevision(2),
    namespaceKeyGeneration: namespaceGeneration(3),
    namespaceHeadDigest: head,
    namespacePublicationDigest: pub,
    namespacePublicationSetDigest: set,
    namespaceAudienceFingerprint: audience,
    grantDomainId: "grant",
    grantDomainParticipantDigest: new Uint8Array(32).fill(1),
    grantDomainKeyGeneration: 1,
    grantDomainHeadDigest: new Uint8Array(32).fill(2),
    grantDomainPublicationDigest: new Uint8Array(32).fill(3),
    grantDomainAuthorizationRevision: authorizationRevision(3),
    namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(3),
    namespaceBundleRevision: 1,
    namespaceBundleDigest: new Uint8Array(32).fill(4),
    authorization: {
      disposition: "authorization_reusable",
      sessionReference: "session",
      authorizationDigest: new Uint8Array(32).fill(5),
    },
    attemptCoordinate: "attempt",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30000),
  });
  const plan = decodeLiveShadowMessagePlanV4(planBytes),
    messageId = 319;
  const oid = deriveLiveShadowMessageCryptoObjectIdV1({
    operationId: plan.operationId,
    sessionId: SESSION,
    messageId,
    revision: 0,
    transcriptOrdinal: 2,
    authorRole: "assistant",
  });
  const dek = new Uint8Array(32).fill(0x97);
  const envelope = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(
      crypto,
      key,
      {
        objectId: objectId(oid),
        namespaceId: namespaceId(NS),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(3),
        bindingRevisionAtWrap: accessRevision(2),
      },
      dek,
    ),
  );
  const start = prepareDeviceWrappedAgentLiveShadowStreamStart(crypto, {
    operationId: plan.operationId,
    policyRevision: 4,
    sessionId: SESSION,
    roomId: ROOM,
    messageId,
    revision: 0,
    createdAt: unixTimestamp(NOW + 2),
    cryptoObjectId: objectId(oid),
    authorAgentId: runtime.agentId,
    assistantMessageKey: "assistant-m318",
    transcriptOrdinal: 2,
    streamId: "stream-m318",
    namespaceId: namespaceId(NS),
    namespaceAccessRevision: accessRevision(2),
    namespaceKeyGeneration: namespaceGeneration(3),
    namespaceHeadDigest: head,
    namespacePublicationDigest: pub,
    namespacePublicationSetDigest: set,
    namespaceAudienceFingerprint: audience,
    agentAuthorizationRevision: authorizationRevision(5),
    runtime,
    runtimeSigner: signer.principal,
    hostAuthorizationRevision: authorizationRevision(7),
    namespaceEnvelopeBytes: envelope,
    namespaceEnvelopeDigest: crypto.hash(envelope),
    firstChunkSequence: 1,
    issuedAt: unixTimestamp(NOW + 2),
    deadlineAt: unixTimestamp(NOW + 30000),
  });
  const payload = Object.freeze({
      role: "assistant" as const,
      content: "Full reply",
      toolCalls: [{ id: "pending", name: "next", args: {} }],
    }),
    payloadBytes = encodeMessagePayloadV2(payload),
    chunk = new TextEncoder().encode(payload.content);
  const frame = sealDeviceWrappedAgentLiveShadowStreamFrame(crypto, {
    startBytes: start.bytes,
    objectDek: dek,
    chunkSequence: 1,
    previousFrameHash: new Uint8Array(32),
    ordinaryChunk: chunk,
    done: true,
    totalChunkCount: 1,
    streamedTextDigest: crypto.hash(chunk),
    finalPayloadDigest: crypto.hash(payloadBytes),
    reserveNonce: () => true,
  });
  const prepared =
    prepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDek({
      crypto,
      objectId: oid,
      payload,
      createdAt: NOW + 2,
      objectDek: dek,
      namespaceEnvelopeBytes: envelope,
      namespace: {
        namespaceId: NS,
        accessRevision: 2,
        keyGeneration: 3,
        headDigest: head,
        publicationDigest: pub,
        publicationSetDigest: set,
        audienceFingerprint: audience,
        aiKey: key,
      },
      operationId: plan.operationId,
      grant: {
        grantId: "grant",
        grantHash: new Uint8Array(32).fill(5),
        recipientKeyId: "recipient",
      },
      runtime,
      signerKeyId: plan.agentSignerKeyId,
      signerPublicKey: plan.agentSignerPublicKey,
      agentAuthorizationRevision: plan.agentAuthorizationRevision,
      resolveCurrentAuthorization: (context) =>
        Object.freeze({
          context,
          grantAuthorized: true,
          namespaceAuthorized: true,
          agentAuthorized: true,
          hostAllowsOperation: true,
          currentRuntime: Object.freeze({
            agentId: runtime.agentId,
            authorizationRevision: plan.agentAuthorizationRevision,
            runtimeGeneration: runtime.generation,
          }),
          signerPublicKey: signer.publicKey.slice(),
        }),
    });
  const snap = readPreparedConversationCryptoRevisionSnapshot(prepared);
  if (snap.kind !== "agent-v3-device-wrapped-live-shadow")
    throw Error("fixture");
  const protectedMessage = parseProtectedMessageDtoV2({
    dtoVersion: 2,
    projection: {
      messageId: String(messageId),
      sessionId: SESSION,
      roomId: ROOM,
      namespaceId: NS,
      role: "assistant",
      authorAgentId: AGENT,
      createdAt: new Date(NOW + 2).toISOString(),
      editRevision: 0,
    },
    protectedPayload: {
      status: "encrypted",
      cryptoObjectId: oid,
      payloadVersion: 2,
      keyClass: "ai",
      encryptedPayloadBytesBase64url: b64(
        snap.value.object.payloadBytes.ciphertext,
      ),
      accessManifestBytesBase64url: b64(snap.value.access.manifestBytes),
      namespaceEnvelopeBytesBase64url: b64(snap.value.access.envelopeBytes[0]),
    },
  });
  if (protectedMessage.protectedPayload.status !== "encrypted") {
    throw new Error("fixture protected payload");
  }
  const encryptedProtectedPayload = protectedMessage.protectedPayload;
  const authority = {
    withOpenedAiGenerations: async (
      _r: unknown,
      use: (e: readonly OpenedNamespaceGeneration[]) => unknown,
    ) => ({
      status: "opened" as const,
      value: await use([
        {
          namespaceId: namespaceId(NS),
          keyClass: "ai",
          accessRevision: accessRevision(2),
          generation: namespaceGeneration(3),
          generationKey: key.slice(),
          audienceFingerprint: audience.slice(),
          headDigest: head.slice(),
        },
      ]),
    }),
  } as NamespaceAuthorityClient;
  const make = async () => {
    const receiver = createVaultLiveShadowMessageReceiver({
      crypto,
      vault: {} as ClientProfileVault,
      coordinates: {
        serverScope: "server",
        userId: "user",
        humanActorId: "human-m318",
        profileId: "profile",
        deviceId: "device-m318",
        installationLineageDigest: "lineage",
      },
      namespaceAuthority: authority,
      submitVerification: async () => "verified",
      now: () => NOW + 3,
    });
    const humanOid = deriveLiveShadowMessageCryptoObjectIdV1({
      operationId: plan.operationId,
      sessionId: SESSION,
      messageId: 318,
      revision: 0,
      transcriptOrdinal: 1,
      authorRole: "user",
    });
    await receiver.registerHuman({
      operationId: plan.operationId,
      planBytes: planBytes.slice(),
      ordinaryPayloadBytes: new Uint8Array([1]),
      protectedMessage: {
        ...protectedMessage,
        projection: {
          messageId: "318",
          sessionId: SESSION,
          roomId: ROOM,
          namespaceId: NS,
          role: "user",
          createdAt: new Date(NOW).toISOString(),
          editRevision: 0,
        },
        protectedPayload: {
          ...encryptedProtectedPayload,
          cryptoObjectId: humanOid,
        },
      },
    });
    return receiver;
  };
  return {
    crypto,
    plan,
    start,
    frame,
    payload,
    payloadBytes,
    protectedMessage,
    make,
  };
}

describe("Full foreground receiver real crypto", () => {
  test("opens V2 stream and durable; V1 still checks parity", async () => {
    const f = await fixture(),
      r = await f.make();
    expect(
      await r.receive({
        wireVersion: 2,
        type: "message.shadow_stream_start",
        laneKey: `room:${ROOM}`,
        operationId: f.plan.operationId,
        transcriptOrdinal: 2,
        streamStartBytesBase64url: b64(f.start.bytes),
      }),
    ).toEqual({ status: "start_verified" });
    expect(
      await r.receive({
        wireVersion: 2,
        type: "message.shadow_stream_frame",
        laneKey: `room:${ROOM}`,
        operationId: f.plan.operationId,
        transcriptOrdinal: 2,
        frameBytesBase64url: b64(f.frame.bytes),
        done: true,
      }),
    ).toMatchObject({ status: "frame_verified", ordinaryChunk: "Full reply" });
    const d = fullEncryptionDurableEventDigestV2(f.crypto, {
      operationId: f.plan.operationId,
      policyRevision: 4,
      transcriptOrdinal: 2,
      protectedMessage: f.protectedMessage,
    });
    expect(
      await r.receive({
        wireVersion: 2,
        type: "message.shadow_durable",
        laneKey: `room:${ROOM}`,
        operationId: f.plan.operationId,
        policyRevision: 4,
        transcriptOrdinal: 2,
        protectedMessage: f.protectedMessage,
        durableEventDigestBase64url: b64(d),
      }),
    ).toMatchObject({ status: "durable_verified", payload: f.payload });
    const v1 = await f.make();
    await v1.receive({
      wireVersion: 1,
      type: "message.shadow_stream_start",
      laneKey: `room:${ROOM}`,
      operationId: f.plan.operationId,
      transcriptOrdinal: 2,
      streamStartBytesBase64url: b64(f.start.bytes),
    });
    expect(
      await v1.receive({
        wireVersion: 1,
        type: "message.shadow_stream_frame",
        laneKey: `room:${ROOM}`,
        operationId: f.plan.operationId,
        transcriptOrdinal: 2,
        ordinaryChunk: "wrong",
        frameBytesBase64url: b64(f.frame.bytes),
        done: true,
      }),
    ).toMatchObject({ status: "failed", checkpoint: "stream_frame_parity" });
  });
  test("rejects frame, digest, and role tampering without fallback", async () => {
    const f = await fixture();
    const a = await f.make();
    await a.receive({
      wireVersion: 2,
      type: "message.shadow_stream_start",
      laneKey: `room:${ROOM}`,
      operationId: f.plan.operationId,
      transcriptOrdinal: 2,
      streamStartBytesBase64url: b64(f.start.bytes),
    });
    const bad = f.frame.bytes.slice();
    bad[10] = bad[10]! ^ 1;
    expect(
      await a.receive({
        wireVersion: 2,
        type: "message.shadow_stream_frame",
        laneKey: `room:${ROOM}`,
        operationId: f.plan.operationId,
        transcriptOrdinal: 2,
        frameBytesBase64url: b64(bad),
        done: true,
      }),
    ).toMatchObject({ status: "failed" });
    for (const role of [false, true]) {
      const r = await f.make(),
        m = role
          ? {
              ...f.protectedMessage,
              projection: {
                ...f.protectedMessage.projection,
                role: "tool" as const,
              },
            }
          : f.protectedMessage,
        d = fullEncryptionDurableEventDigestV2(f.crypto, {
          operationId: f.plan.operationId,
          policyRevision: 4,
          transcriptOrdinal: 2,
          protectedMessage: m,
        });
      if (!role) d[0] = d[0]! ^ 1;
      const result = await r.receive({
        wireVersion: 2,
        type: "message.shadow_durable",
        laneKey: `room:${ROOM}`,
        operationId: f.plan.operationId,
        policyRevision: 4,
        transcriptOrdinal: 2,
        protectedMessage: m,
        durableEventDigestBase64url: b64(d),
      });
      expect(result).toMatchObject({ status: "failed" });
      expect(
        result.status === "failed" && result.ordinaryFallback,
      ).toBeUndefined();
    }
  });
});
