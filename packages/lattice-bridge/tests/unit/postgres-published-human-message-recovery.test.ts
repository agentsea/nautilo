import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto, accessRevision, agentId, authorizationRevision, cryptoDeviceId,
  encryptObjectPayload, humanId, namespaceGeneration, namespaceId, objectId,
  prepareHumanAiReadableLiveShadowMessageRequest, prepareHumanPeerLiveShadowMessageRequest,
  prepareSharedAgentLiveShadowMessageRequest, prepareObjectAccessManifestGenesis,
  unixTimestamp, wrapObjectDekForNamespace, type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2,
  encodeHumanAiReadableLiveShadowMessagePlanV1, encodeHumanPeerLiveShadowMessagePlanV1,
  encodeSharedAgentLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import { encodeProtectedMessageDtoV2, parseProtectedMessageDtoV2 } from "@nautilo/types";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from "../../src/message/conversation-repository.ts";
import { PROTECTED_TOP_LEVEL_ROOM_KINDS } from "../../src/message/protected-room-topology.ts";
import {
  recoverPostgresPublishedHumanMessage, verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow, type ConversationProductPostgresConnection,
} from "@nautilo/lattice-bridge/server";

const ROOM = "10000000-0000-4000-8000-000000000001";
const SESSION = "10000000-0000-4000-8000-000000000002";
const NAMESPACE = "10000000-0000-4000-8000-000000000003";
const HUMAN = "10000000-0000-4000-8000-000000000004";
const USER = "10000000-0000-4000-8000-000000000005";
const NOW = 1_700_000_000_000; // Deliberately long past the original send deadline.
const bytes = (marker: number) => new Uint8Array(32).fill(marker);
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");

function fixture(family: "human_peer_v1" | "shared_agent_v1" | "human_ai_readable_v1") {
  const crypto = new LatticeCrypto(seededRng(311_901));
  const signing = crypto.generateSigningKeyPair();
  const keyClass = family === "human_peer_v1" ? "human" : "ai";
  const common = {
    operationId: "recovery-published-human", clientIdempotencyKey: "original-send",
    policyRevision: 4, sessionId: SESSION, roomId: ROOM, humanMessageId: 21,
    revision: 0 as const, transcriptOrdinal: 1, role: "user" as const,
    createdAt: unixTimestamp(NOW), subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId("original-device"), committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(7), namespaceId: namespaceId(NAMESPACE),
    namespaceAccessRevision: accessRevision(2), namespaceKeyGeneration: namespaceGeneration(3),
    namespaceHeadDigest: bytes(1), namespacePublicationDigest: bytes(2),
    namespacePublicationSetDigest: bytes(3), namespaceAudienceFingerprint: bytes(4),
    issuedAt: unixTimestamp(NOW), deadlineAt: unixTimestamp(NOW + 30_000),
  };
  const planBase = { ...common, formatVersion: 1 as const, attemptCoordinate: "original-attempt" };
  const planBytes = family === "human_peer_v1"
    ? encodeHumanPeerLiveShadowMessagePlanV1({ ...planBase, keyClass: "human", purpose: "message.human_peer_live_shadow_plan" })
    : family === "shared_agent_v1"
    ? encodeSharedAgentLiveShadowMessagePlanV1({ ...planBase, keyClass: "ai", purpose: "message.shared_agent_live_shadow_plan", recipientAgentId: agentId("original-agent") })
    : encodeHumanAiReadableLiveShadowMessagePlanV1({ ...planBase, keyClass: "ai", purpose: "message.human_ai_readable_live_shadow_plan" });
  const cryptoObjectId = objectId(deriveLiveShadowMessageCryptoObjectIdV1({
    operationId: common.operationId, sessionId: SESSION, messageId: 21,
    revision: 0, transcriptOrdinal: 1, authorRole: "user",
  }));
  const plaintext = new TextEncoder().encode('{"role":"user","content":"private original"}');
  const encrypted = encryptObjectPayload(crypto, {
    objectId: cryptoObjectId, objectType: "conversation.message", keyClass, createdAt: unixTimestamp(NOW),
  }, plaintext);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(crypto, bytes(8), {
    objectId: cryptoObjectId, namespaceId: namespaceId(NAMESPACE), keyClass,
    keyGeneration: namespaceGeneration(3), bindingRevisionAtWrap: accessRevision(2),
  }, encrypted.dek));
  encrypted.dek.fill(0);
  const access = prepareObjectAccessManifestGenesis(crypto, {
    objectId: cryptoObjectId, payloadHash: crypto.hash(payloadBytes), envelopeBytes: [envelopeBytes],
    sourceAuthorized: true, targetAuthorized: true, committerDeviceId: cryptoDeviceId("original-device"),
    hostAuthorizationRevision: authorizationRevision(7), signingPrivateKey: signing.privateKey,
  });
  const { humanMessageId, ...requestCommon } = common;
  const requestBase = { ...requestCommon, messageId: humanMessageId, cryptoObjectId,
    planDigest: crypto.hash(planBytes), plaintextPayloadDigest: crypto.hash(plaintext),
    encryptedPayloadDigest: crypto.hash(payloadBytes), manifestDigest: crypto.hash(access.manifestBytes),
    envelopeDigest: crypto.hash(envelopeBytes), committerSigningPublicKey: signing.publicKey,
    committerSigningPrivateKey: signing.privateKey };
  const request = family === "human_peer_v1"
    ? prepareHumanPeerLiveShadowMessageRequest(crypto, { ...requestBase, keyClass: "human" })
    : family === "shared_agent_v1"
    ? prepareSharedAgentLiveShadowMessageRequest(crypto, { ...requestBase, keyClass: "ai", recipientAgentId: agentId("original-agent") })
    : prepareHumanAiReadableLiveShadowMessageRequest(crypto, { ...requestBase, keyClass: "ai" });
  signing.privateKey.fill(0);
  const human = parseProtectedMessageDtoV2({ dtoVersion: 2,
    projection: { messageId: "21", sessionId: SESSION, roomId: ROOM, namespaceId: NAMESPACE,
      role: "user", createdAt: new Date(NOW).toISOString(), editRevision: 0 },
    protectedPayload: { status: "encrypted", cryptoObjectId, payloadVersion: 2, keyClass,
      encryptedPayloadBytesBase64url: b64(payloadBytes), accessManifestBytesBase64url: b64(access.manifestBytes),
      namespaceEnvelopeBytesBase64url: b64(envelopeBytes) } });
  const row: ConversationProductDatabaseRow = {
    operation_id: common.operationId, session_id: SESSION, room_id: ROOM, namespace_id: NAMESPACE,
    subject_human_id: HUMAN, human_message_id: 21, transcript_ordinal: 1,
    crypto_object_id: cryptoObjectId, state: "published", plan_bytes: planBytes,
    plan_digest: crypto.hash(planBytes), human_request_bytes: request.bytes,
    human_request_digest: request.requestDigest,
    operation_policy_revision: common.policyRevision,
    representation_mode: "shadow_encryption",
    publication_policy_revision: null,
    parity_status: "client_verified",
    protected_message_digest: crypto.hash(new TextEncoder().encode(encodeProtectedMessageDtoV2(human))),
    created_at: new Date(NOW),
  };
  const storage = {
    getObject: async () => ({ objectId: cryptoObjectId, payloadBytes: payloadBytes.slice() }),
    getObjectAccessState: async () => ({ head: { objectId: cryptoObjectId, accessRevision: 0,
      manifestBytes: access.manifestBytes.slice() }, namespaceEnvelopes: [{ namespaceId: NAMESPACE, envelopeHash: crypto.hash(envelopeBytes),
      envelopeBytes: envelopeBytes.slice() }] }),
  } as unknown as Pick<LatticeStorage, "getObject" | "getObjectAccessState">;
  return { crypto, row, storage, human, family, request };
}

async function recover(value: ReturnType<typeof fixture>, options: {
  account?: string; room?: string; currentAccess?: boolean; duplicate?: boolean;
  authorityKind?: string;
} = {}) {
  const queries: string[] = [];
  const queryParameters: (readonly unknown[])[] = [];
  const connection: ConversationProductPostgresConnection = {
    query: async <Row extends ConversationProductDatabaseRow>(statement: string, parameters: readonly unknown[] = []) => {
      queries.push(statement);
      queryParameters.push(parameters);
      if (statement.includes("current_user")) return [{ current_user: "nautilo", session_user: "nautilo" }] as unknown as Row[];
      const matchesFamily = statement.includes(value.family === "human_peer_v1"
        ? 'from "conversation_human_peer_shadow_operations"' : 'from "conversation_shared_agent_shadow_operations"');
      const matchesAuthorityKind = parameters.includes(options.authorityKind ?? "private");
      return matchesFamily && matchesAuthorityKind && parameters.includes(USER) && parameters.includes(ROOM) && options.currentAccess !== false
        ? [value.row, ...(options.duplicate ? [value.row] : [])] as Row[] : [];
    },
    transaction: (callback) => callback(connection),
  };
  const product = await verifyConversationProductPostgresHandle(connection);
  const result = await recoverPostgresPublishedHumanMessage({ product, crypto: value.crypto, storage: value.storage }, {
    authority: { userId: options.account ?? USER, humanActorId: HUMAN },
    roomId: options.room ?? ROOM, operationId: "recovery-published-human",
  });
  return { result, queries, queryParameters };
}

describe("read-only published Human outbox recovery", () => {
  test("returns an explicitly protected-only Full recovery without an ordinary body", async () => {
    const value = fixture("human_peer_v1");
    const { result, queries } = await recover({
      ...value,
      row: {
        ...value.row,
        representation_mode: "full_encryption",
        publication_policy_revision: 4,
        parity_status: "client_authenticated",
      },
    });
    expect(result).toMatchObject({
      status: "human_published",
      representationMode: "full_encryption",
    });
    expect(result).not.toHaveProperty("content");
    expect(queries.at(-1)).not.toContain('"content"');
  });

  test.each(["human_peer_v1", "shared_agent_v1", "human_ai_readable_v1"] as const)("returns original durable bytes after send expiry for %s", async (family) => {
    const value = fixture(family);
    const { result, queries } = await recover(value);
    expect(result).toEqual({ status: "human_published", representationMode: "shadow_encryption", operationId: "recovery-published-human",
      authorizationScheme: family, acceptedHumanRequestDigestBase64url: b64(value.request.requestDigest), human: value.human });
    expect(queries.every((query) => /^select /iu.test(query))).toBeTrue();
    const lookup = queries.at(-1)!;
    for (const required of ['"room_members"', '"actors"', '"session_message_crypto_revisions"', '"completion"', '"disposition"', '"parity_status"', '"edit_revision"']) expect(lookup).toContain(required);
    expect(lookup).not.toContain('"content"');
  });
  test.each(["human_peer_v1", "shared_agent_v1", "human_ai_readable_v1"] as const)("accepts open top-level authority and its inherited subthread authority for %s", async (family) => {
    const value = fixture(family);
    const { result, queries, queryParameters } = await recover(value, {
      authorityKind: "open",
    });
    expect(result).toMatchObject({ status: "human_published" });
    const lookup = queries.at(-1)!;
    const parameters = queryParameters.at(-1)!;
    expect(lookup).toContain('coalesce("rooms"."parent_room_id", "rooms"."id")');
    for (const kind of PROTECTED_TOP_LEVEL_ROOM_KINDS) {
      expect(parameters).toContain(kind);
    }
  });
  test("retains an entry whose top-level authority is not a protected Room kind", async () => {
    const { result, queryParameters } = await recover(
      fixture("human_ai_readable_v1"),
      { authorityKind: "access" },
    );
    expect(result).toEqual({ status: "absent" });
    expect(queryParameters.at(-1)).not.toContain("access");
  });
  test.each(["account", "room", "currentAccess", "duplicate"] as const)("retains entries without exact %s authority", async (failure) => {
    const options = { account: USER, room: ROOM, currentAccess: true, duplicate: false };
    if (failure === "account") options.account = "10000000-0000-4000-8000-000000000099";
    if (failure === "room") options.room = "10000000-0000-4000-8000-000000000099";
    if (failure === "currentAccess") options.currentAccess = false;
    if (failure === "duplicate") options.duplicate = true;
    expect((await recover(fixture("human_ai_readable_v1"), options)).result).toEqual({ status: "absent" });
  });
  test.each(["state", "human_request_digest", "plan_digest", "protected_message_digest", "crypto_object_id", "created_at"] as const)("does not prove completion for mismatched %s", async (field) => {
    const value = fixture("human_ai_readable_v1");
    value.row = { ...value.row, [field]: field === "state" ? "human_verified" : field === "crypto_object_id"
      ? "wrong-object" : field === "created_at" ? new Date(NOW + 1) : bytes(99) };
    expect((await recover(value)).result).toEqual({ status: "absent" });
  });
  test("does not prove completion when durable ciphertext is absent or changed", async () => {
    for (const changed of [false, true]) {
      const value = fixture("human_ai_readable_v1");
      const original = value.storage.getObject;
      value.storage.getObject = async (id) => {
        const result = await original(id);
        if (changed && result !== null) { result.payloadBytes[0] = result.payloadBytes[0]! ^ 1; return result; }
        return null;
      };
      expect((await recover(value)).result).toEqual({ status: "absent" });
    }
  });
});
