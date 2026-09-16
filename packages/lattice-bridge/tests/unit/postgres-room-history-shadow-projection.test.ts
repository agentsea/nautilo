import { describe, expect, test } from "bun:test";
import {
  humanId,
  unixTimestamp,
  LATTICE_LIMITS,
  LatticeCrypto,
  participantDigest,
  createAgentObjectAccessManifest,
  objectId,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainNamespaceRetainedAuthoritySetDigest,
  prepareDomainNamespaceBundle,
  namespaceGeneration,
  namespaceId,
  encodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import { decodeMessagePayloadV2 } from
  "../../src/message/message-payload-v2.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import {
  createPostgresRoomHistoryShadowProjection,
  createCurrentHumanDomainKeyRoomHistoryAuthorityResolver,
  createCurrentDomainKeyRoomHistoryAuthorityResolver,
  type RoomHistoryDomainKeyV2Authority,
  type RoomHistorySelectedCoordinate,
  type RoomHistoryShadowProjectionRecord,
} from "../../src/server/message/postgres-room-history-shadow-projection.ts";
import {
  PostgresNamespaceProductAuthority,
} from
  "../../src/server/delivery/postgres-namespace-product-authority.ts";
import { PostgresDomainKeyAuthorityRepository } from
  "../../src/server/delivery/postgres-domain-key-authority.ts";
import { sharedHistoryExecution } from "../fixtures/room-history-shared-execution.ts";
import { deriveMessageCryptoObjectIdV2 } from "../../src/message/conversation-repository.ts";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
  DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  deriveHumanMessageEditCryptoObjectIdV1,
} from "@nautilo/lattice-crypto/wire";
import { prepareHumanExistingMessageRepresentationCryptoRevision,
  prepareHumanPeerLiveShadowCryptoRevision } from
  "../../src/message/human-existing-message-representation-crypto.ts";
import { prepareForegroundRuntimeExistingMessageCryptoRevision } from
  "../../src/message/agent-conversation-crypto.ts";
import { readPreparedConversationCryptoRevision, readPreparedConversationCryptoRevisionSnapshot } from
  "../../src/message/conversation-prepared-revision.ts";

type Query = Readonly<{ statement: string; parameters: readonly unknown[] }>;

function liveRecord(record: RoomHistoryShadowProjectionRecord) {
  if (record.kind === "existing_representation") throw new Error("Expected live Shadow fixture");
  if (record.representationMode === "protected-only") throw new Error("Expected ordinary Shadow fixture");
  return record;
}

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly queries: Query[] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    const result = this.#results.shift();
    if (result === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    return Promise.resolve(result as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    _options: Readonly<{ isolationLevel: ConversationProductPostgresIsolationLevel }>,
  ): Promise<Result> {
    return callback(this);
  }
}

function connection(
  query: (statement: string) => Promise<readonly PostgresJsBridgeRow[]>,
): PostgresJsBridgeConnection {
  const executor: PostgresJsBridgeExecutor = {
    query: <Row extends PostgresJsBridgeRow>(statement: string) =>
      query(statement) as Promise<readonly Row[]>,
  };
  return Object.freeze({
    query: executor.query,
    transaction: <Result>(
      use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
    ) => use(executor),
    transactionOnce: <Result>(
      use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
    ) => use(executor),
  });
}

function domainKeyAuthorityRows(
  statement: string,
  participants: readonly string[],
  deviceGeneration: number,
  deviceRevision: number,
): readonly PostgresJsBridgeRow[] {
  if (statement.includes('from "namespace_domain_key_heads"')) {
    if (statement.includes('"retained_generation_count"')) {
      return [{
        namespace_id: NAMESPACE_ID,
        namespace_access_revision: 4,
        namespace_current_generation: 1,
        domain_id: "domain-v2-1",
        domain_key_generation: 5,
        domain_authorization_revision: 6,
        domain_head_digest: DIGEST_BYTES,
        bundle_revision: 7,
        retained_generation_count: 2,
        retained_authority_set_digest: DIGEST_BYTES,
        binding_digest: DIGEST_BYTES,
      }];
    }
    return [{
      namespace_id: NAMESPACE_ID,
      domain_id: "domain-v2-1",
      domain_key_generation: 5,
      domain_authorization_revision: 6,
      domain_head_digest: DIGEST_BYTES,
      binding_digest: DIGEST_BYTES,
    }];
  }
  if (statement.includes('from "domain_key_heads"')) {
    return [{
      domain_id: "domain-v2-1",
      participant_digest: participantDigest(participants.map(humanId)),
      participant_count: participants.length,
      domain_key_generation: 5,
      authorization_revision: 6,
      head_digest: DIGEST_BYTES,
    }];
  }
  if (statement.includes('from "domain_key_recipient_envelopes"')) {
    return [{
      domain_id: "domain-v2-1",
      recipient_human_id: HUMAN_ID,
      recipient_kind: "device",
      recipient_key_id: DEVICE_ID,
      recipient_key_generation: deviceGeneration,
    }];
  }
  if (statement.includes('from "human_crypto_recovery_keys"')) return [];
  if (statement.includes('from "human_crypto_devices"')) {
    if (statement.includes(' as "generation"')) {
      return [{
        human_id: HUMAN_ID,
        device_id: DEVICE_ID,
        generation: deviceGeneration,
      }];
    }
    return [{
      device_id: DEVICE_ID,
      human_id: HUMAN_ID,
      device_generation: deviceGeneration,
      revision: deviceRevision,
      signing_public_key: new Uint8Array([1]),
    }];
  }
  throw new Error(`Unexpected V2 authority query: ${statement}`);
}

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_SESSION_ID = "10000000-0000-4000-8000-000000000002";
const ROOM_ID = "10000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000004";
const HUMAN_ID = "10000000-0000-4000-8000-000000000005";
const DEVICE_ID =
  "crypto:browser:9ca1c0f393d9ae9c5a3a89c99a22a806a7d6f76b9eaeca2e9837d9276d42046e";
const USER_ID = "10000000-0000-4000-8000-000000000007";
const OBJECT_ID = "message:v2:ready";
const CORRUPT_OBJECT_ID = "message:v2:corrupt";
const DIGEST = "A".repeat(43);
const DIGEST_BYTES = new Uint8Array(32).fill(1);

const authority: RoomHistoryDomainKeyV2Authority = Object.freeze({
  scheme: "domain_key_v2",
  keyClass: "ai",
  subjectHumanId: HUMAN_ID,
  readerDeviceId: DEVICE_ID,
  readerDeviceSigningKeyGeneration: 1,
  hostAuthorizationRevision: 2,
  policyRevision: 3,
  roomId: ROOM_ID,
  namespaceId: NAMESPACE_ID,
  namespaceAccessRevision: 4,
  namespaceCurrentGeneration: 1,
  namespaceHeadDigestBase64url: DIGEST,
  domainId: "domain-v2-1",
  domainKeyGeneration: 5,
  domainAuthorizationRevision: 6,
  domainHeadDigestBase64url: DIGEST,
  namespaceBundleRevision: 7,
  namespaceBundleDigestBase64url: DIGEST,
});

const humanAuthority: RoomHistoryDomainKeyV2Authority = Object.freeze({
  scheme: "domain_key_v2",
  keyClass: "human",
  subjectHumanId: HUMAN_ID,
  readerDeviceId: DEVICE_ID,
  readerDeviceSigningKeyGeneration: 1,
  hostAuthorizationRevision: 2,
  policyRevision: 3,
  roomId: ROOM_ID,
  namespaceId: NAMESPACE_ID,
  namespaceAccessRevision: 4,
  namespaceCurrentGeneration: 1,
  namespaceHeadDigestBase64url: DIGEST,
  domainId: "domain-v2-1",
  domainKeyGeneration: 5,
  domainAuthorizationRevision: 6,
  domainHeadDigestBase64url: DIGEST,
  namespaceBundleRevision: 7,
  namespaceBundleDigestBase64url: DIGEST,
});

function coordinate(
  messageId: number,
  overrides: Partial<RoomHistorySelectedCoordinate> = {},
): RoomHistorySelectedCoordinate {
  return Object.freeze({
    sessionId: SESSION_ID,
    messageId,
    editRevision: 0,
    role: "user",
    logicalMessageKey: `turn:turn-${messageId}`,
    ...overrides,
  });
}

function productRow(
  selectionOrdinal: number,
  messageId: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    selection_ordinal: selectionOrdinal,
    message_id: messageId,
    session_id: SESSION_ID,
    room_id: ROOM_ID,
    namespace_id: NAMESPACE_ID,
    role: "user",
    content: `human ${messageId}`,
    tool_calls: null,
    tool_name: null,
    created_at: new Date(`2027-01-15T08:00:0${selectionOrdinal}.000Z`),
    edited_at: null,
    edit_revision: 0,
    fingerprint: `turn-${messageId}`,
    reply_to_message_id: null,
    subthread_room_id: null,
    reply_count: 0,
    last_reply_at: null,
    summary_revision: 0,
    source_user_id: USER_ID,
    source_human_id: HUMAN_ID,
    author_agent_id: null,
    crypto_object_id: OBJECT_ID,
    lifecycle_object_id: OBJECT_ID,
    object_id_scheme: "live_shadow_v1",
    shadow_operation_id: `shadow-operation-${messageId}`,
    human_peer_shadow_operation_id: null,
    shadow_transcript_ordinal: selectionOrdinal + 1,
    payload_version: 2,
    key_class: "ai",
    author_role: "user",
    completion: "complete",
    disposition: "mapped",
    parity_status: "client_verified",
    turn_room_id: ROOM_ID,
    turn_namespace_id: NAMESPACE_ID,
    namespace_generation: 1,
    turn_namespace_access_revision: 4,
    namespace_head_digest: DIGEST_BYTES,
    namespace_publication_digest: DIGEST_BYTES,
    namespace_publication_set_digest: DIGEST_BYTES,
    namespace_audience_fingerprint: DIGEST_BYTES,
    plan_bytes: null,
    human_request_bytes: null,
    human_request_digest: null,
    agent_signer_key_id: "agent-signer-1",
    ...overrides,
  };
}

async function subject(
  rows: unknown[][],
  restricted?: PostgresJsBridgeConnection,
  scheme: "agent" | "human" = "agent",
  repair?: Readonly<{ manifestBytes: Uint8Array; signerPublicKey: Uint8Array | null }>,
  edited?: Readonly<{ payloadBytes: Uint8Array; manifestBytes: Uint8Array;
    envelopeBytes: Uint8Array; signerPublicKey: Uint8Array; retainedAvailable?: boolean; runtimeRetained?: boolean; sourceRoomId?: string }>,
) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }],
    ...rows,
  ]);
  const product = await verifyConversationProductPostgresHandle(connection);
  const cryptoReads: string[] = [];
  const project = createPostgresRoomHistoryShadowProjection({
    product,
    ...(repair === undefined ? {} : { resolveForegroundAgentSigner: () => repair.signerPublicKey?.slice() ?? null }),
    ...(restricted === undefined ? {} : { restricted }),
    resolveAuthority: async () => scheme === "agent"
      ? ({ status: "ready" as const, authority: {...authority, roomId: edited?.sourceRoomId ?? authority.roomId} })
      : ({ status: "unavailable" as const }),
    resolveHumanPeerAuthority: async () => scheme === "human"
      ? ({ status: "ready" as const, authority: {...humanAuthority, roomId: edited?.sourceRoomId ?? humanAuthority.roomId} })
      : ({ status: "unavailable" as const }),
    resolveHumanEditedRepresentationAuthority: async () => edited === undefined || edited.retainedAvailable === false
      ? ({ status: "unavailable" as const })
      : ({ status: "ready" as const, headDigestBase64url: DIGEST,
          committerDeviceSigningPublicKeyBase64url:
            Buffer.from(edited.signerPublicKey).toString("base64url") }),
    ...(edited?.runtimeRetained === undefined ? {} : {
      resolveExistingRetainedGeneration: async (coordinates) => edited.runtimeRetained ? {
        namespaceGeneration: coordinates.generation, accessRevision: coordinates.accessRevision,
        headDigestBase64url: DIGEST, publicationDigestBase64url: DIGEST,
        publicationSetDigestBase64url: DIGEST, audienceFingerprintBase64url: DIGEST,
      } : null,
    }),
    crypto: {
      getObject: async (objectId) => {
        cryptoReads.push(`object:${objectId}`);
        return objectId === CORRUPT_OBJECT_ID
          ? null
          : { objectId, payloadBytes: edited?.payloadBytes ?? new Uint8Array([1, 2, 3]) };
      },
      getObjectAccessState: async (objectId) => {
        cryptoReads.push(`access:${objectId}`);
        return {
          head: {
            objectId,
            accessRevision: 0,
            manifestHash: new Uint8Array(32).fill(1),
            manifestBytes: edited?.manifestBytes ?? repair?.manifestBytes ?? new Uint8Array([4, 5, 6]),
          },
          namespaceEnvelopes: [{
            namespaceId: NAMESPACE_ID,
            envelopeHash: new Uint8Array(32).fill(2),
            envelopeBytes: edited?.envelopeBytes ?? new Uint8Array([7, 8, 9]),
          }],
        };
      },
    },
  });
  return { connection, cryptoReads, project };
}

describe("M275 selected Room-history Shadow projection", () => {
  test("inspects verified generation-zero metadata and selects the newest rewrap", async () => {
    const crypto = new LatticeCrypto(seededRng(320_001));
    const signer = crypto.generateSigningKeyPair();
    const retained = [Object.freeze({
      generation: namespaceGeneration(0), accessRevision: accessRevision(4),
      headDigest: new Uint8Array(32).fill(0x31),
      generationKey: new Uint8Array(32).fill(0x41),
    })];
    const digest = domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
    const prepared = prepareDomainNamespaceBundle(crypto, {
      operationId: "m320:binding:2",
      bundle: Object.freeze({
        formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
        purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
        serverId: "m320-test", cryptoDomainId: cryptoDomainId("domain:m320"),
        participantDigest: new Uint8Array(32).fill(0x21), participantCount: 1,
        keyClass: "ai" as const, domainKeyGeneration: 1,
        domainAuthorizationRevision: authorizationRevision(1),
        domainHeadDigest: new Uint8Array(32).fill(0x22),
        namespaceId: namespaceId(NAMESPACE_ID),
        namespaceAccessRevision: accessRevision(4),
        namespaceCurrentGeneration: namespaceGeneration(0),
        bundleRevision: 2, retainedGenerationCount: 1,
        retainedAuthoritySetDigest: digest, retainedGenerations: retained,
      }),
      previousBindingDigest: null, issuerHumanId: humanId(HUMAN_ID),
      issuerDeviceId: cryptoDeviceId(DEVICE_ID),
      issuerDeviceSigningGeneration: 1,
      issuerSigningPrivateKey: signer.privateKey,
      issuerSigningPublicKey: signer.publicKey,
      domainKey: new Uint8Array(32).fill(0x51), issuedAt: 1_800_000_000_000,
    });
    const repository = new PostgresDomainKeyAuthorityRepository(connection(async (statement) => {
      if (statement.includes('from "namespace_domain_key_heads"')) return [{
        namespace_current_generation: 0, namespace_access_revision: 4,
        binding_digest: prepared.bindingDigest,
      }];
      if (statement.includes('from "namespace_domain_key_bindings"')) return [{
        binding_bytes: prepared.bytes, binding_digest: prepared.bindingDigest,
        namespace_current_generation: 0, namespace_access_revision: 4,
        bundle_revision: 2, signing_public_key: signer.publicKey,
      }, {
        binding_bytes: new Uint8Array([0]), binding_digest: new Uint8Array(32),
        namespace_current_generation: 0, namespace_access_revision: 4,
        bundle_revision: 1, signing_public_key: signer.publicKey,
      }];
      throw new Error(`Unexpected metadata query: ${statement}`);
    }), crypto, "m320-test");
    const result = await repository.inspectNamespaceGenerationAuthorityMetadata({
      namespaceId: NAMESPACE_ID, keyClass: "ai",
      requested: [{ generation: 0, accessRevision: 4 }],
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.currentGeneration).toBe(0);
      expect(result.retainedGenerations).toHaveLength(1);
      expect(result.retainedGenerations[0]).toMatchObject({
        generation: 0, accessRevision: 4,
      });
      expect(result.retainedGenerations[0]!.headDigest).toEqual(digest);
    }
    const inspectWith = (bindingRows: readonly PostgresJsBridgeRow[]) =>
      new PostgresDomainKeyAuthorityRepository(connection(async (statement) =>
        statement.includes('from "namespace_domain_key_heads"') ? [{
          namespace_current_generation: 0, namespace_access_revision: 4,
          binding_digest: prepared.bindingDigest,
        }] : bindingRows
      ), crypto, "m320-test").inspectNamespaceGenerationAuthorityMetadata({
        namespaceId: NAMESPACE_ID, keyClass: "ai",
        requested: [{ generation: 0, accessRevision: 4 }],
      });
    expect(await inspectWith([])).toEqual({
      status: "unavailable", reason: "binding_unavailable",
    });
    const corrupt = prepared.bytes.slice();
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(await inspectWith([{
      binding_bytes: corrupt, binding_digest: prepared.bindingDigest,
      namespace_current_generation: 0, namespace_access_revision: 4,
      bundle_revision: 2, signing_public_key: signer.publicKey,
    }])).toEqual({ status: "unavailable", reason: "binding_invalid" });
    corrupt.fill(0);
  });
  test.each(["valid", "attestation", "publisher", "allocation", "id", "unmapped", "signer_unavailable"])(
    "projects only authenticated existing-representation receipt: %s", async (scenario) => {
      const crypto = new LatticeCrypto(seededRng(311_278));
      const execution = sharedHistoryExecution(crypto, {
        operationId: "unrelated-publisher-execution", sessionId: OTHER_SESSION_ID, roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID, humanId: HUMAN_ID, deviceId: DEVICE_ID,
        agentId: USER_ID, createdAt: 1_800_000_000_000, generation: 2, accessRevision: 5,
        headDigest: DIGEST_BYTES, publicationDigest: DIGEST_BYTES,
        publicationSetDigest: DIGEST_BYTES, audienceFingerprint: DIGEST_BYTES,
      });
      const id = deriveMessageCryptoObjectIdV2({ sessionId: SESSION_ID, messageId: 28, revision: 0 });
      const created = createAgentObjectAccessManifest(crypto, {
        objectId: objectId(id), payloadHash: crypto.hash(new Uint8Array([1, 2, 3])),
        accessRevision: accessRevision(0), previousManifestHash: null,
        envelopeHashes: [crypto.hash(new Uint8Array([7, 8, 9]))],
        signer: execution.signer.principal, hostAuthorizationRevision: authorizationRevision(9),
      }, execution.runtime);
      const { project, connection } = await subject([[productRow(0, 28, {
        object_id_scheme: "message_v2", shadow_operation_id: null, shadow_transcript_ordinal: null,
        crypto_object_id: scenario === "id" ? OBJECT_ID : id, lifecycle_object_id: id,
        repair_identity_digest: DIGEST_BYTES,
        allocation_request_digest: scenario === "allocation" ? new Uint8Array([1]) : DIGEST_BYTES,
        repair_publisher_kind: "foreground_runtime",
        repair_publisher_id: scenario === "publisher" ? "other-signer" : execution.plan.agentSignerKeyId,
        repair_attestation_digest: scenario === "attestation" ? DIGEST_BYTES : created.hash,
        disposition: scenario === "unmapped" ? "active" : "mapped",
        parity_status: "server_verified", fingerprint: null,
        turn_room_id: null, turn_namespace_id: null, namespace_generation: null,
      })]], undefined, "agent", {
        manifestBytes: created.bytes,
        signerPublicKey: scenario === "signer_unavailable" ? null : execution.signer.publicKey,
      });
      const result = await project({ subjectUserId: USER_ID, subjectHumanId: HUMAN_ID,
        readerDeviceId: DEVICE_ID, roomId: ROOM_ID,
        selectedCoordinates: [coordinate(28, { logicalMessageKey: "row:28" })] });
      expect(result).toMatchObject(scenario === "valid"
        ? { status: "ready", eligibleCount: 1, records: [{ kind: "existing_representation",
          protectedMessage: { projection: { role: "user", sourceUserId: USER_ID } },
          repair: { publisherSignerKeyId: execution.plan.agentSignerKeyId } }] }
        : { status: "unavailable", reason: "projection_corrupt" });
      expect(connection.queries).toHaveLength(2);
      if (result.status === "ready") {
        expect(result.signerEvidence).toEqual([]);
        expect(result.records[0]).not.toHaveProperty("shadowOperationId");
        expect(result.records[0]).not.toHaveProperty("retainedGeneration");
      }
    });

  test.each(["ordinary-and-protected", "protected-only"] as const)(
    "does not admit a nonterminal Message repair into %s projection", async (representationMode) => {
      const pending = productRow(1, 28, {
        object_id_scheme: "message_v2",
        shadow_operation_id: null,
        shadow_transcript_ordinal: null,
        crypto_object_id: null,
        lifecycle_object_id: deriveMessageCryptoObjectIdV2({
          sessionId: SESSION_ID,
          messageId: 28,
          revision: 0,
        }),
        repair_identity_digest: DIGEST_BYTES,
        allocation_request_digest: DIGEST_BYTES,
        repair_publisher_kind: "foreground_runtime",
        repair_publisher_id: "pending-repair-publisher",
        repair_attestation_digest: null,
        completion: "pending",
        disposition: "active",
        parity_status: "pending",
        fingerprint: null,
      });
      const ready = productRow(0, 27, {
        content: representationMode === "protected-only" ? null : "human 27",
      });
      const rows = representationMode === "protected-only"
        ? [[ready, pending]]
        : [[ready, pending], [{
            shadow_operation_id: "shadow-operation-27",
            shadow_transcript_ordinal: 1,
            role: "user",
            content: "human 27",
            tool_calls: null,
            tool_name: null,
          }]];
      const { project, connection, cryptoReads } = await subject(rows);

      const result = await project({
        subjectUserId: USER_ID,
        subjectHumanId: HUMAN_ID,
        readerDeviceId: DEVICE_ID,
        roomId: ROOM_ID,
        selectedCoordinates: [coordinate(27), coordinate(28)],
        representationMode,
      });

      expect(result).toMatchObject({
        status: "ready",
        selectedCount: 2,
        eligibleCount: 1,
        records: [{
          coordinate: { messageId: 27 },
          ...(representationMode === "protected-only"
            ? { representationMode: "protected-only" }
            : {}),
        }],
      });
      if (result.status !== "ready") throw new Error("expected partial ready projection");
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.coordinate.messageId).toBe(27);
      expect(cryptoReads).toEqual([`object:${OBJECT_ID}`, `access:${OBJECT_ID}`]);
      if (representationMode === "protected-only") {
        expect(result.records[0]).not.toHaveProperty("ordinaryPayloadBytesBase64url");
        expect(connection.queries[1]!.statement).not.toContain('"session_messages"."content"');
      }
    },
  );

  test.each([true, false])("Runtime repairs retain authenticated Namespace evidence for reverse reads: %s", async (available) => {
    const crypto = new LatticeCrypto(seededRng(313_279));
    const execution = sharedHistoryExecution(crypto, {
      operationId: "runtime-repair", sessionId: OTHER_SESSION_ID, roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID, humanId: HUMAN_ID, deviceId: DEVICE_ID,
      agentId: USER_ID, createdAt: 1_800_000_000_000, generation: 2, accessRevision: 5,
      headDigest: DIGEST_BYTES, publicationDigest: DIGEST_BYTES,
      publicationSetDigest: DIGEST_BYTES, audienceFingerprint: DIGEST_BYTES,
    });
    const id = deriveMessageCryptoObjectIdV2({ sessionId: SESSION_ID, messageId: 28, revision: 0 });
    const prepared = prepareForegroundRuntimeExistingMessageCryptoRevision({ crypto, objectId: id,
      payload: { role: "system", content: "system source", sensitiveMetadata: { reason: "summary" } },
      createdAt: 1_800_000_000_000, objectDek: new Uint8Array(32).fill(0x63),
      namespace: { namespaceId: NAMESPACE_ID, accessRevision: 5, keyGeneration: 2,
        headDigest: DIGEST_BYTES, publicationDigest: DIGEST_BYTES,
        publicationSetDigest: DIGEST_BYTES, audienceFingerprint: DIGEST_BYTES, aiKey: new Uint8Array(32).fill(0x31) },
      operationId: execution.plan.operationId, grant: { grantId: "repair-grant", grantHash: DIGEST_BYTES,
        recipientKeyId: "repair-recipient" }, runtime: execution.runtime,
      signerKeyId: execution.plan.agentSignerKeyId, signerPublicKey: execution.plan.agentSignerPublicKey,
      agentAuthorizationRevision: 9, resolveCurrentAuthorization: () => null,
    });
    const snapshot = readPreparedConversationCryptoRevisionSnapshot(prepared).value;
    const { project } = await subject([[productRow(0, 28, {
      role: "system", author_role: "system", content: null,
      object_id_scheme: "message_v2", shadow_operation_id: null, shadow_transcript_ordinal: null,
      crypto_object_id: id, lifecycle_object_id: id, fingerprint: null,
      repair_identity_digest: DIGEST_BYTES, allocation_request_digest: DIGEST_BYTES,
      repair_publisher_kind: "foreground_runtime", repair_publisher_id: execution.plan.agentSignerKeyId,
      repair_attestation_digest: sha256(snapshot.access.manifestBytes), parity_status: "server_verified",
    })]], undefined, "agent", { manifestBytes: snapshot.access.manifestBytes, signerPublicKey: execution.signer.publicKey }, {
      payloadBytes: snapshot.object.payloadBytes.ciphertext, manifestBytes: snapshot.access.manifestBytes,
      envelopeBytes: snapshot.access.envelopeBytes[0], signerPublicKey: execution.signer.publicKey,
      runtimeRetained: available,
    });
    const result = await project({ subjectUserId: USER_ID, subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID, roomId: ROOM_ID,
      selectedCoordinates: [coordinate(28, { role: "system", logicalMessageKey: "row:28" })],
      representationMode: "protected-only" });
    expect(result).toMatchObject(available ? { status: "ready", records: [{
      kind: "existing_representation", representationMode: "protected-only",
      retainedGeneration: { namespaceGeneration: 2, accessRevision: 5 },
    }] } : { status: "unavailable", reason: "projection_corrupt" });
    if (result.status === "ready") expect(result.records[0]).not.toHaveProperty("ordinaryPayloadBytesBase64url");
  });

  test.each(["ai", "human"] as const)("projects retained device repair for every role in %s history", async (keyClass) => {
    for (const role of ["user", "assistant", "tool", "system"] as const) {
      const crypto = new LatticeCrypto(seededRng(313_278));
      const signing = crypto.generateSigningKeyPair();
      const id = deriveMessageCryptoObjectIdV2({ sessionId: SESSION_ID, messageId: 28, revision: 0 });
      const payload = { role, content: "old Message", ...(role === "system"
        ? { sensitiveMetadata: { reason: "summary" } } : {}) };
      const common = { crypto, objectId: id, payload,
        createdAt: Date.parse("2027-01-15T08:00:00.000Z"),
        device: { deviceId: DEVICE_ID, hostAuthorizationRevision: 2, signingPrivateKey: signing.privateKey },
        resolveCurrentAuthorization: () => null };
      const key = new Uint8Array(32).fill(0x31);
      const prepared = keyClass === "ai"
        ? prepareHumanExistingMessageRepresentationCryptoRevision({ ...common,
          namespace: { namespaceId: NAMESPACE_ID, accessRevision: 4, keyGeneration: 1, aiKey: key } })
        : prepareHumanPeerLiveShadowCryptoRevision({ ...common,
          namespace: { namespaceId: NAMESPACE_ID, accessRevision: 4, keyGeneration: 1, humanKey: key } });
      const snapshot = readPreparedConversationCryptoRevision(prepared);
      const childRoomId = "31300000-0000-4000-8000-000000000099";
      for (const sourceRoomId of role === "assistant" ? [childRoomId, ROOM_ID] : [ROOM_ID]) {
      for (const representationMode of ["ordinary-and-protected", "protected-only"] as const) {
      for (const retainedAvailable of [true, false]) {
        for (const parityStatus of ["client_authenticated", "client_verified"] as const) {
        const { project, connection } = await subject([[productRow(0, 28, {
          room_id: sourceRoomId, subthread_room_id: role === "assistant" ? childRoomId : null,
          role, author_role: role, key_class: keyClass, content: payload.content,
          tool_calls: role === "system" ? JSON.stringify(payload.sensitiveMetadata) : null,
          object_id_scheme: "message_v2", shadow_operation_id: null, shadow_transcript_ordinal: null,
          crypto_object_id: id, lifecycle_object_id: id, fingerprint: null,
          repair_identity_digest: DIGEST_BYTES, allocation_request_digest: DIGEST_BYTES,
          repair_publisher_kind: "human_device", repair_publisher_human_id: USER_ID,
          repair_publisher_id: DEVICE_ID, repair_attestation_digest: sha256(snapshot.access.manifestBytes),
          parity_status: parityStatus,
        })]], undefined, keyClass === "human" ? "human" : "agent", undefined, {
          payloadBytes: snapshot.object.payloadBytes.ciphertext, manifestBytes: snapshot.access.manifestBytes,
          envelopeBytes: snapshot.access.envelopeBytes[0]!, signerPublicKey: signing.publicKey,
          retainedAvailable, sourceRoomId,
        });
        const result = await project({ subjectUserId: USER_ID, subjectHumanId: HUMAN_ID,
          readerDeviceId: DEVICE_ID, roomId: sourceRoomId, representationMode,
          selectedCoordinates: [coordinate(28, { role, logicalMessageKey: "row:28" })] });
        expect(result).toMatchObject(retainedAvailable ? { status: "ready", records: [{
          kind: "existing_representation", repair: { publisherKind: "human_device", publisherHumanId: USER_ID },
          protectedMessage: { projection: { role, roomId: sourceRoomId }, protectedPayload: { keyClass } },
        }], signerEvidence: [] } : { status: "unavailable", reason: "projection_corrupt" });
        if (role === "assistant") {
          const selection = connection.queries.find(query => query.statement.includes('"history_session_room"'));
          expect(selection?.statement).toContain('"rooms"."id" = "sessions"."room_id"');
          expect(selection?.statement).toContain('"rooms"."id" = "session_messages"."subthread_room_id"');
          expect(selection?.statement).toContain('"rooms"."namespace_id" = "history_session_room"."namespace_id"');
          expect(selection?.statement).toContain('"rooms"."parent_room_id" = "sessions"."room_id"');
          expect(selection?.parameters).toContain(sourceRoomId);
        }
        if (result.status === "ready" && representationMode === "protected-only") {
          expect(result.records[0]).toHaveProperty("representationMode", "protected-only");
          expect(result.records[0]).not.toHaveProperty("ordinaryPayloadBytesBase64url");
          const selection = connection.queries.find(query => query.statement.includes('"history_session_room"'));
          expect(selection?.statement).not.toContain('"session_messages"."content"');
        }
        if (result.status === "ready" && role === "system") {
          expect(result.records[0]!.protectedMessage.projection).not.toHaveProperty("sourceUserId");
          expect(result.records[0]!.protectedMessage.projection).not.toHaveProperty("authorAgentId");
          const record = result.records[0]!;
          if (record.kind !== "existing_representation") throw new Error("wrong kind");
          if (representationMode === "ordinary-and-protected") {
            expect(decodeMessagePayloadV2(Buffer.from(record.ordinaryPayloadBytesBase64url!, "base64url"))).toEqual(payload);
          }
        }
        }
      }
      }
      }
    }
  });

  test.each([
    { role: "assistant" as const, ordinals: [2, 3], valid: true },
    { role: "tool" as const, ordinals: [2, 3], valid: true },
    { role: "tool" as const, ordinals: [1, 2], valid: false },
    { role: "tool" as const, ordinals: [2, 4], valid: false },
    { role: "tool" as const, ordinals: [3, 4], valid: false },
  ])("validates shared execution transcript %j", async ({ role, ordinals, valid }) => {
    const execution = sharedHistoryExecution(new LatticeCrypto(seededRng(311_275)), {
      operationId: "history-shared-execution", sessionId: SESSION_ID, roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID, humanId: HUMAN_ID, deviceId: DEVICE_ID,
      agentId: USER_ID, createdAt: 1_800_000_000_000, generation: 2, accessRevision: 5,
      headDigest: DIGEST_BYTES, publicationDigest: DIGEST_BYTES,
      publicationSetDigest: DIGEST_BYTES, audienceFingerprint: DIGEST_BYTES,
    });
    const ordinal = role === "assistant" ? 2 : 3;
    const transcript = [{ shadow_operation_id: execution.plan.operationId,
      shadow_transcript_ordinal: ordinals[0], role: "assistant", content: "",
      tool_calls: JSON.stringify([{ id: "shared-tool-call", name: "lookup", args: {} }]), tool_name: null },
    { shadow_operation_id: execution.plan.operationId, shadow_transcript_ordinal: ordinals[1],
      role: "tool", content: "tool result", tool_calls: null, tool_name: "lookup" }];
    const { project, connection, cryptoReads } = await subject([[productRow(0, 27, {
      ...execution.row, shadow_operation_id: null,
      role, author_role: role, author_agent_id: USER_ID, fingerprint: null,
      content: role === "tool" ? "tool result" : "", tool_name: role === "tool" ? "lookup" : null,
      tool_calls: role === "assistant" ? transcript[0]!.tool_calls : null,
      shadow_transcript_ordinal: ordinal,
      turn_room_id: null, turn_namespace_id: null, namespace_generation: null,
    })], transcript]);
    const result = await project({ subjectUserId: USER_ID, subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID, roomId: ROOM_ID,
      selectedCoordinates: [coordinate(27, { role, logicalMessageKey: "row:27" })] });
    if (!valid) {
      expect(result).toMatchObject({ status: "unavailable", reason: "projection_corrupt" });
      expect(cryptoReads).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ status: "ready", eligibleCount: 1,
      records: [{ shadowOperationFamily: "shared_execution", shadowOperationId: execution.plan.operationId,
        retainedGeneration: { namespaceGeneration: 2, accessRevision: 5 },
        protectedMessage: { projection: { authorAgentId: USER_ID } } }],
      signerEvidence: [{ kind: "shared_agent_execution_plan_v4", operationId: execution.plan.operationId,
        planBytesBase64url: Buffer.from(execution.planBytes).toString("base64url") }] });
    if (result.status === "ready" && role === "tool") {
      expect(decodeMessagePayloadV2(Buffer.from(liveRecord(result.records[0]!).ordinaryPayloadBytesBase64url, "base64url"))
        .sensitiveMetadata).toEqual({ toolCallId: "shared-tool-call" });
    }
    expect(connection.queries[1]!.statement).toContain("conversation_shared_agent_shadow_executions");
    expect(connection.queries[2]!.statement).toContain('"session_message_crypto_revisions"."shared_agent_shadow_execution_id"');
  });

  test.each(["sequential", "postgres_timestamp_strings", "postgres_offset_timestamp_strings", "reservation_overlap", "separate_authorization", "distinct_source_session", "project_checkpoint_redaction", "changed_project_proposal", "wrong_resume_session", "expired_empty_reservation", "unauthorized_output", "completed_empty_reservation", "expired_wrong_source_device"] as const)("projects paged exact Tool lineage: %s", async (scenario) => {
    const crypto = new LatticeCrypto(seededRng(322_401));
    const inputSetDigest = new Uint8Array(32).fill(0x42);
    // Execution 52 is a later resume over the same exact inputs. Projection of
    // execution 51 must remain stable rather than requiring it to be the latest.
    const executions = Array.from({ length: 52 }, (_, index) => {
      const sequence = index + 1;
      const execution = sharedHistoryExecution(crypto, {
        operationId: `history-resume-execution-${sequence}`,
        sessionId: SESSION_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        humanId: HUMAN_ID,
        deviceId: DEVICE_ID,
        agentId: USER_ID,
        createdAt: 1_800_000_000_000 + sequence * 2_000,
        generation: 2,
        accessRevision: 5,
        headDigest: DIGEST_BYTES,
        publicationDigest: DIGEST_BYTES,
        publicationSetDigest: DIGEST_BYTES,
        audienceFingerprint: DIGEST_BYTES,
      });
      return {
        execution,
        metadata: {
          ...execution.row,
          execution_sequence: sequence,
          execution_id: execution.plan.operationId,
          execution_kind: sequence === 1 ? "turn" : "resume",
          execution_invocation_id: `history-resume-invocation-${sequence}`,
          // Runtime invocation authorization and the child V4 work descriptor
          // are separately owned; a resume need not reuse the same grant.
          execution_authorization_digest: scenario === "separate_authorization"
            ? new Uint8Array(32).fill(0x91) : execution.row.execution_authorization_digest,
          execution_invoking_human_id: HUMAN_ID,
          execution_invoking_device_id: DEVICE_ID,
          execution_input_count: 1,
          execution_input_set_digest: inputSetDigest,
          execution_state: "fallback",
          execution_created_at: new Date(1_800_000_000_000 + sequence * 2_000),
          // Reservation is not execution: approval may already be waiting when
          // the preceding invocation receives its terminal bookkeeping update.
          execution_terminal_at: new Date(1_800_000_000_000 + sequence * 2_000
            + (scenario === "reservation_overlap" ? 5_000 : 1_000)),
          invocation_session_id: (scenario === "distinct_source_session" && sequence === 1)
            || (scenario === "wrong_resume_session" && sequence === 25)
            ? OTHER_SESSION_ID : SESSION_ID,
          invocation_room_id: ROOM_ID,
          invocation_invoking_human_id: HUMAN_ID,
          invocation_input_count: 1,
          invocation_input_set_digest: inputSetDigest,
        },
      };
    });
    if (scenario === "postgres_timestamp_strings" || scenario === "postgres_offset_timestamp_strings") {
      for (const { metadata } of executions) {
        const encodeTimestamp = (date: Date) => scenario === "postgres_offset_timestamp_strings"
          ? date.toISOString().replace("T", " ").replace("Z", "+00")
          : date.toISOString();
        Object.assign(metadata, {
          execution_created_at: encodeTimestamp(metadata.execution_created_at),
          execution_terminal_at: encodeTimestamp(metadata.execution_terminal_at),
        });
      }
    }
    const current = executions[50]!;
    if (scenario === "expired_empty_reservation" || scenario === "unauthorized_output"
      || scenario === "completed_empty_reservation" || scenario === "expired_wrong_source_device") {
      Object.assign(executions[24]!.metadata, {
        execution_state: scenario === "completed_empty_reservation" ? "completed" : "failed",
        execution_invoking_device_id: scenario === "expired_wrong_source_device" ? "wrong-source-device" : DEVICE_ID,
        execution_plan_bytes: null,
        execution_plan_digest: null, execution_authorized_at: null,
        execution_authorization_digest: null,
      });
    }
    (current.metadata as Record<string, unknown>)["execution_state"] = "running";
    (current.metadata as Record<string, unknown>)["execution_terminal_at"] = null;
    const projectCheckpoint = scenario === "project_checkpoint_redaction"
      || scenario === "changed_project_proposal";
    const selectedRow = productRow(0, 27, {
      ...current.execution.row,
      ...current.metadata,
      shadow_operation_id: null,
      role: "tool",
      author_role: "tool",
      author_agent_id: USER_ID,
      content: "resumed result",
      tool_name: projectCheckpoint ? "share_memory" : "lookup",
      tool_calls: null,
      shadow_transcript_ordinal: projectCheckpoint ? 3 : 2,
      turn_room_id: null,
      turn_namespace_id: null,
      namespace_generation: null,
    });
    const currentTool = {
      shadow_operation_id: current.execution.plan.operationId,
      session_id: SESSION_ID,
      shadow_transcript_ordinal: projectCheckpoint ? 3 : 2,
      role: "tool",
      content: "resumed result",
      tool_calls: null,
      tool_name: projectCheckpoint ? "share_memory" : "lookup",
      completion: "complete",
      disposition: "mapped",
      parity_status: "server_verified",
    };
    const currentTranscript = projectCheckpoint
      ? [{
          shadow_operation_id: current.execution.plan.operationId,
          session_id: SESSION_ID,
          shadow_transcript_ordinal: 2,
          role: "assistant",
          content: "",
          tool_calls: JSON.stringify([{
            id: "exact-resumed-call",
            name: "share_memory",
            args: scenario === "changed_project_proposal"
              ? { mode: "project", proposed_content: "changed proposal",
                  source_memory_ids: ["memory-source-1"] }
              : { mode: "project" },
          }]),
          tool_name: null,
          completion: "complete",
          disposition: "mapped",
          parity_status: "server_verified",
        }, currentTool]
      : [currentTool];
    // A live execution may emit arbitrarily many durable output rows. Exercise
    // both transcript keyset paging and correlation across the old 256-row
    // dedupe-cache size before the selected resume consumes the final call.
    const parentTranscript = Array.from({ length: 257 }, (_, index) => {
      const ordinal = index + 2;
      const pair = Math.floor(index / 2);
      const finalRequest = index === 256;
      const assistant = index % 2 === 0;
      return {
        shadow_operation_id: executions[0]!.execution.plan.operationId,
        session_id: SESSION_ID,
        shadow_transcript_ordinal: ordinal,
        role: assistant ? "assistant" : "tool",
        content: assistant ? "" : `completed result ${pair}`,
        tool_calls: assistant
          ? JSON.stringify([{
              id: finalRequest ? "exact-resumed-call" : `completed-call-${pair}`,
              name: finalRequest && projectCheckpoint ? "share_memory" : "lookup",
              args: finalRequest && projectCheckpoint
                ? { mode: "project", proposed_content: "original proposal",
                    source_memory_ids: ["memory-source-1"] }
                : { exact: finalRequest },
            }])
          : null,
        tool_name: assistant ? null : "lookup",
        completion: "complete",
        disposition: "mapped",
        parity_status: "server_verified",
      };
    });
    if (scenario === "unauthorized_output") {
      parentTranscript.push({ ...parentTranscript[0]!,
        shadow_operation_id: executions[24]!.execution.plan.operationId,
        shadow_transcript_ordinal: 2, completion: "pending", parity_status: "pending",
      });
    }
    const parentTranscriptPages = Array.from(
      { length: Math.ceil(parentTranscript.length / 50) },
      (_, index) => parentTranscript.slice(index * 50, index * 50 + 51),
    );
    const backwardFirst = executions.slice(1, 51).reverse().map(value => value.metadata);
    const backwardSecond = [executions[0]!.metadata];
    const forwardFirst = executions.slice(0, 50).map(value => value.metadata);
    const forwardSecond = [current.metadata];
    const { project, connection } = await subject([
      [selectedRow],
      currentTranscript,
      backwardFirst,
      backwardSecond,
      forwardFirst,
      ...parentTranscriptPages,
      forwardSecond,
      currentTranscript,
    ]);

    const result = await project({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      selectedCoordinates: [coordinate(27, { role: "tool", logicalMessageKey: "row:27" })],
    });

    if (scenario === "changed_project_proposal" || scenario === "wrong_resume_session" || scenario === "unauthorized_output" || scenario === "completed_empty_reservation"
      || scenario === "expired_wrong_source_device") {
      expect(result).toMatchObject({ status: "unavailable", reason: "projection_corrupt" });
      return;
    }

    expect(result).toMatchObject({
      status: "ready",
      records: [{
        shadowOperationId: current.execution.plan.operationId,
        shadowTranscriptOrdinal: projectCheckpoint ? 3 : 2,
      }],
    });
    if (result.status !== "ready") throw new Error("expected resumed Tool history");
    expect(decodeMessagePayloadV2(Buffer.from(
      liveRecord(result.records[0]!).ordinaryPayloadBytesBase64url,
      "base64url",
    )).sensitiveMetadata).toEqual({ toolCallId: "exact-resumed-call" });
    const lineageQueries = connection.queries.filter(query =>
      query.statement.includes('from "conversation_shared_agent_shadow_executions"')
      && query.statement.includes('"execution_kind"')
      && query.statement.includes('"execution_input_set_digest"')
    );
    expect(lineageQueries).toHaveLength(4);
    expect(lineageQueries[0]!.statement).toContain('"conversation_shared_agent_shadow_executions"."sequence" <=');
    expect(lineageQueries[0]!.parameters).toContain(51);
    const transcriptQueries = connection.queries.filter(query =>
      query.statement.includes('from "session_message_crypto_revisions"')
      && query.statement.includes('"shadow_operation_id"')
    );
    expect(transcriptQueries).toHaveLength(8);
    expect(transcriptQueries.some(query =>
      query.statement.includes('"shadow_transcript_ordinal" >')
    )).toBeTrue();
  });

  test.each(["nonterminal_predecessor", "invocation_digest", "missing_intervening_invocation",
    "invalid_created_timestamp", "invalid_terminal_timestamp", "terminal_before_created",
    "terminal_missing", "invalid_date_object", "timestamp_without_timezone"] as const)(
    "rejects resumed Tool execution lineage with %s", async (scenario) => {
    const crypto = new LatticeCrypto(seededRng(322_402));
    const inputSetDigest = new Uint8Array(32).fill(0x43);
    const parent = sharedHistoryExecution(crypto, {
      operationId: "history-overlap-parent", sessionId: SESSION_ID, roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID, humanId: HUMAN_ID, deviceId: DEVICE_ID,
      agentId: USER_ID, createdAt: 1_800_000_000_000, generation: 2, accessRevision: 5,
      headDigest: DIGEST_BYTES, publicationDigest: DIGEST_BYTES,
      publicationSetDigest: DIGEST_BYTES, audienceFingerprint: DIGEST_BYTES,
    });
    const resumed = sharedHistoryExecution(crypto, {
      operationId: "history-overlap-resume", sessionId: SESSION_ID, roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID, humanId: HUMAN_ID, deviceId: DEVICE_ID,
      agentId: USER_ID,
      createdAt: scenario === "missing_intervening_invocation" ? 1_800_000_002_000 : 1_800_000_001_000,
      headDigest: DIGEST_BYTES, publicationDigest: DIGEST_BYTES,
      publicationSetDigest: DIGEST_BYTES, audienceFingerprint: DIGEST_BYTES,
      generation: 2, accessRevision: 5,
    });
    const intervening = sharedHistoryExecution(crypto, {
      operationId: "history-missing-invocation", sessionId: SESSION_ID, roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID, humanId: HUMAN_ID, deviceId: DEVICE_ID,
      agentId: USER_ID, createdAt: 1_800_000_001_000, generation: 2, accessRevision: 5,
      headDigest: DIGEST_BYTES, publicationDigest: DIGEST_BYTES,
      publicationSetDigest: DIGEST_BYTES, audienceFingerprint: DIGEST_BYTES,
    });
    const metadata = (execution: typeof parent, sequence: number, kind: "turn" | "resume",
      createdAt: number, terminalAt: number) => ({
      ...execution.row, execution_sequence: sequence, execution_id: execution.plan.operationId,
      execution_kind: kind, execution_invocation_id: `overlap-invocation-${sequence}`,
      execution_invoking_human_id: HUMAN_ID, execution_invoking_device_id: DEVICE_ID,
      execution_input_count: 1, execution_input_set_digest: inputSetDigest,
      execution_state: "fallback", execution_created_at: new Date(createdAt),
      execution_terminal_at: new Date(terminalAt), invocation_session_id: SESSION_ID,
      invocation_room_id: ROOM_ID, invocation_invoking_human_id: HUMAN_ID,
      invocation_input_count: 1, invocation_input_set_digest: inputSetDigest,
    });
    const parentMetadata = metadata(parent, 1, "turn", 1_800_000_000_000,
      1_800_000_000_500);
    if (scenario === "nonterminal_predecessor") {
      parentMetadata.execution_state = "running";
      (parentMetadata as Record<string, unknown>)["execution_terminal_at"] = null;
    }
    if (scenario === "invocation_digest") {
      parentMetadata.invocation_input_set_digest = new Uint8Array(32).fill(0x44);
    }
    if (scenario === "invalid_created_timestamp") {
      Object.assign(parentMetadata, { execution_created_at: "not-a-timestamp" });
    }
    if (scenario === "invalid_terminal_timestamp") {
      Object.assign(parentMetadata, { execution_terminal_at: "not-a-timestamp" });
    }
    if (scenario === "terminal_before_created") {
      Object.assign(parentMetadata, {
        execution_created_at: "2027-01-15T08:00:00.000Z",
        execution_terminal_at: "2027-01-15T07:59:59.999Z",
      });
    }
    if (scenario === "terminal_missing") {
      Object.assign(parentMetadata, { execution_terminal_at: null });
    }
    if (scenario === "invalid_date_object") {
      Object.assign(parentMetadata, { execution_created_at: new Date(Number.NaN) });
    }
    if (scenario === "timestamp_without_timezone") {
      Object.assign(parentMetadata, { execution_created_at: "2027-01-15T08:00:00.000" });
    }
    const resumedSequence = scenario === "missing_intervening_invocation" ? 3 : 2;
    const resumedCreatedAt = scenario === "missing_intervening_invocation"
      ? 1_800_000_002_000 : 1_800_000_001_000;
    const resumedMetadata = metadata(resumed, resumedSequence, "resume",
      resumedCreatedAt, resumedCreatedAt + 1_000);
    const interveningMetadata = metadata(intervening, 2, "resume",
      1_800_000_001_000, 1_800_000_001_500);
    if (scenario === "missing_intervening_invocation") {
      const missing = interveningMetadata as Record<string, unknown>;
      missing["execution_invocation_id"] = null;
      missing["invocation_session_id"] = null;
      missing["invocation_room_id"] = null;
      missing["invocation_invoking_human_id"] = null;
      missing["invocation_input_count"] = null;
      missing["invocation_input_set_digest"] = null;
    }
    const selected = productRow(0, 27, { ...resumed.row, ...resumedMetadata,
      shadow_operation_id: null, role: "tool", author_role: "tool", author_agent_id: USER_ID,
      content: "overlap result", tool_name: "lookup", shadow_transcript_ordinal: 2,
      turn_room_id: null, turn_namespace_id: null, namespace_generation: null });
    const resultRow = { shadow_operation_id: resumed.plan.operationId, session_id: SESSION_ID,
      shadow_transcript_ordinal: 2, role: "tool", content: "overlap result",
      tool_calls: null, tool_name: "lookup", completion: "complete", disposition: "mapped",
      parity_status: "server_verified" };
    const { project, cryptoReads } = await subject([
      [selected], [resultRow],
      [resumedMetadata,
        ...(scenario === "missing_intervening_invocation" ? [interveningMetadata] : []),
        parentMetadata],
      [parentMetadata,
        ...(scenario === "missing_intervening_invocation" ? [interveningMetadata] : []),
        resumedMetadata],
    ]);
    expect(await project({ subjectUserId: USER_ID, subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID, roomId: ROOM_ID,
      selectedCoordinates: [coordinate(27, { role: "tool", logicalMessageKey: "row:27" })] }))
      .toMatchObject({ status: "unavailable", reason: "projection_corrupt" });
    expect(cryptoReads).toEqual([]);
  });

  test.each(["execution_room_id", "execution_agent_id", "execution_plan_digest", "execution_authorization_digest", "execution_authorized_at"])(
    "rejects shared execution substituted %s before ciphertext reads", async (field) => {
      const execution = sharedHistoryExecution(new LatticeCrypto(seededRng(311_276)), {
        operationId: "history-shared-execution", sessionId: SESSION_ID, roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID, humanId: HUMAN_ID, deviceId: DEVICE_ID,
        agentId: USER_ID, createdAt: 1_800_000_000_000, generation: 2, accessRevision: 5,
        headDigest: DIGEST_BYTES, publicationDigest: DIGEST_BYTES,
        publicationSetDigest: DIGEST_BYTES, audienceFingerprint: DIGEST_BYTES,
      });
      const { project, cryptoReads } = await subject([[productRow(0, 27, {
        ...execution.row, [field]: field === "execution_authorized_at" ? null
          : field === "execution_plan_digest" || field === "execution_authorization_digest"
            ? new Uint8Array(32) : OTHER_SESSION_ID,
        shadow_operation_id: null, role: "assistant", author_role: "assistant",
        author_agent_id: USER_ID, fingerprint: null,
      })]]);
      expect(await project({ subjectUserId: USER_ID, subjectHumanId: HUMAN_ID,
        readerDeviceId: DEVICE_ID, roomId: ROOM_ID,
        selectedCoordinates: [coordinate(27, { role: "assistant", logicalMessageKey: "row:27" })] }))
        .toMatchObject({ status: "unavailable", reason: "projection_corrupt", eligibleCount: 1 });
      expect(cryptoReads).toEqual([]);
    },
  );

  test.each([1, 2] as const)("projects V%s shared foreground Human evidence with its exact version", async (formatVersion) => {
    const operationId = "shared-agent-operation-human-26";
    const retainedPlan = encodeHumanAiReadableLiveShadowMessagePlan({
      formatVersion, purpose: "message.human_ai_readable_live_shadow_plan",
      operationId, clientIdempotencyKey: "history-human-evidence",
      policyRevision: 1, sessionId: SESSION_ID, roomId: ROOM_ID,
      humanMessageId: 26, revision: 0, transcriptOrdinal: 1, role: "user",
      createdAt: unixTimestamp(1_800_000_000_000), subjectHumanId: humanId(HUMAN_ID),
      committerDeviceId: cryptoDeviceId(DEVICE_ID), committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(1),
      namespaceId: namespaceId("history-human-namespace"), keyClass: "ai",
      namespaceAccessRevision: 1, namespaceKeyGeneration: 1,
      namespaceHeadDigest: new Uint8Array(32).fill(1),
      namespacePublicationDigest: new Uint8Array(32).fill(2),
      namespacePublicationSetDigest: new Uint8Array(32).fill(3),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(4),
      attemptCoordinate: "history-human-attempt",
      issuedAt: unixTimestamp(1_800_000_000_000),
      deadlineAt: unixTimestamp(1_800_000_000_000 + (formatVersion === 2 ? 300_000 : 30_000)),
    });
    const retainedRequest = new Uint8Array([0x32]);
    // The current shared foreground writer records Human input in the ai
    // namespace with this operation family, not the legacy turn family.
    // Ciphertext and access state remain available through the crypto seam.
    const { project, cryptoReads } = await subject([[
      productRow(0, 26, {
        fingerprint: operationId,
        role: "user",
        author_role: "user",
        key_class: "ai",
        object_id_scheme: "live_shadow_v1",
        shadow_operation_id: null,
        human_peer_shadow_operation_id: null,
        shared_agent_shadow_operation_id: operationId,
        shared_agent_shadow_execution_id: null,
        shared_session_id: SESSION_ID,
        shared_message_id: 26,
        shared_object_id: OBJECT_ID,
        shared_transcript_ordinal: 1,
        shadow_transcript_ordinal: 1,
        completion: "complete",
        disposition: "mapped",
        parity_status: "client_verified",
        // A Full-origin row remains protected-only after policy returns to
        // Shadow. Its retained signed commitment must still be projected.
        content: null,
        plan_bytes: retainedPlan,
        human_request_bytes: retainedRequest,
        human_request_digest: sha256(retainedRequest),
      }),
    ], [{
      shadow_operation_id: operationId,
      shared_agent_shadow_operation_id: operationId,
      shadow_transcript_ordinal: 1,
      role: "user",
      content: "human 26",
      tool_calls: null,
      tool_name: null,
    }]]);

    const result = await project({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      selectedCoordinates: [coordinate(26, {
        logicalMessageKey: `turn:${operationId}`,
      })],
    });

    expect(result).toMatchObject({
      status: "ready",
      selectedCount: 1,
      eligibleCount: 1,
      records: [{
        shadowOperationId: operationId,
        representationMode: "protected-only",
        coordinate: { messageId: 26, role: "user" },
        protectedMessage: {
          protectedPayload: {
            status: "encrypted",
            cryptoObjectId: OBJECT_ID,
            keyClass: "ai",
            encryptedPayloadBytesBase64url: "AQID",
            accessManifestBytesBase64url: "BAUG",
            namespaceEnvelopeBytesBase64url: "BwgJ",
          },
        },
      }],
      signerEvidence: [{
        kind: formatVersion === 2 ? "human_ai_readable_live_shadow_request_v2"
          : "human_ai_readable_live_shadow_request_v1",
        operationId,
      }],
    });
    expect(cryptoReads).toEqual([`object:${OBJECT_ID}`, `access:${OBJECT_ID}`]);
  });

  test("inspects more than 256 foreground Domains with four fixed bulk queries", async () => {
    const crypto = new LatticeCrypto(seededRng(315));
    const namespaceIds = Array.from(
      { length: 257 },
      (_, index) => `namespace:${index.toString().padStart(3, "0")}`,
    );
    const domainIds = namespaceIds.map((_, index) =>
      `domain-v2:${index.toString().padStart(3, "0")}`
    );
    const statements: string[] = [];
    const restricted = connection(async (statement) => {
      statements.push(statement);
      if (statement.includes('from "human_crypto_devices"')) {
        return [{
          device_id: DEVICE_ID,
          device_generation: 1,
          revision: 2,
        }];
      }
      if (statement.includes('from "namespace_domain_key_heads"')) {
        return namespaceIds.map((namespaceId, index) => ({
          namespaceId,
          domainId: domainIds[index]!,
        })).reverse().map(({ namespaceId, domainId }) => ({
          namespace_id: namespaceId,
          domain_id: domainId,
          domain_key_generation: 1,
          domain_authorization_revision: 1,
          domain_head_digest: DIGEST_BYTES,
          binding_digest: DIGEST_BYTES,
        }));
      }
      if (statement.includes('from "domain_key_recipient_envelopes"')) {
        return [...domainIds].reverse().map((domainId) => ({
          domain_id: domainId,
        }));
      }
      if (statement.includes('from "domain_key_heads"')) {
        return [...domainIds].reverse().map((domainId) => ({
          domain_id: domainId,
          participant_digest: participantDigest([humanId(HUMAN_ID)]),
          participant_count: 1,
          domain_key_generation: 1,
          authorization_revision: 1,
          head_digest: DIGEST_BYTES,
        }));
      }
      throw new Error(`Unexpected V2 authority query: ${statement}`);
    });
    const repository = new PostgresDomainKeyAuthorityRepository(
      restricted,
      crypto,
      "m315-test",
    );

    const result = await repository.inspectForegroundAuthority({
      namespaceIds,
      keyClass: "ai",
      subjectHumanId: HUMAN_ID,
      deviceId: DEVICE_ID,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("authority should be ready");
    expect(result.domains).toHaveLength(257);
    expect(statements).toHaveLength(4);
    expect(statements.filter((statement) =>
      statement.includes('from "domain_key_heads"')
    )).toHaveLength(1);
    expect(statements.filter((statement) =>
      statement.includes('from "domain_key_recipient_envelopes"')
    )).toHaveLength(1);
  });

  test("rejects a 16,385th foreground Namespace before opening a transaction", async () => {
    let statements = 0;
    const repository = new PostgresDomainKeyAuthorityRepository(
      connection(() => {
        statements += 1;
        throw new Error("capacity rejection must precede SQL");
      }),
      new LatticeCrypto(seededRng(315_001)),
      "m315-test",
    );

    expect(await repository.inspectForegroundAuthority({
      namespaceIds: Array.from(
        { length: LATTICE_LIMITS.agentGrantNamespaces + 1 },
        (_, index) => `namespace:${index.toString().padStart(5, "0")}`,
      ),
      keyClass: "ai",
      subjectHumanId: HUMAN_ID,
      deviceId: DEVICE_ID,
    })).toEqual({
      status: "unavailable",
      reason: "namespace_set_invalid",
    });
    expect(statements).toBe(0);
  });

  test.each([true, false])("resolves Human-only active reader with recipient envelope present=%s", async recipientPresent => {
    const crypto = new LatticeCrypto(seededRng(295_275));
    const product = connection(async (statement) => {
      if (statement.includes("m295_room_history_policy")) {
        return [{ mode: "shadow_encryption", revision: 9 }];
      }
      if (statement.startsWith('select "id", "namespace_id", "parent_room_id" from "rooms"')) {
        return [{ id: ROOM_ID, namespace_id: NAMESPACE_ID, parent_room_id: null }];
      }
      if (statement.includes('order by "rooms"."parent_room_id" nulls first')) return [{ room_id: ROOM_ID }];
      if (statement.includes("m298_namespace_key_human_ai_readable_actor")) return [{ subject_user_id: USER_ID }];
      if (statement.includes("m298_namespace_key_human_ai_readable_source_room")) {
        return [{
          source_room_id: ROOM_ID, source_kind: "group", source_parent_room_id: null, source_archived_at: null,
          room_id: ROOM_ID,
          namespace_id: NAMESPACE_ID,
          kind: "group",
          parent_room_id: null,
          archived_at: null,
          namespace_access_revision: 4,
          human_actor_ids: [HUMAN_ID, USER_ID].sort(),
          subject_user_id: USER_ID,
        }];
      }
      if (statement.includes("m298_namespace_key_human_ai_readable_authority_members")) {
        return [HUMAN_ID, USER_ID].sort().map((actorId) => ({
          actor_id: actorId,
          kind: "user",
        }));
      }
      throw new Error(`Unexpected Human-peer product query: ${statement}`);
    });
    const restricted = connection(async (statement) =>
      !recipientPresent && statement.includes('from "domain_key_recipient_envelopes"') ? []
        : domainKeyAuthorityRows(statement, [HUMAN_ID, USER_ID], 3, 7)
    );
    const resolve = createCurrentHumanDomainKeyRoomHistoryAuthorityResolver({
      product,
      productAuthority: new PostgresNamespaceProductAuthority(product),
      domainKeys: new PostgresDomainKeyAuthorityRepository(
        restricted,
        crypto,
        "history-test",
      ),
    });
    const result = await resolve({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      selectedCoordinates: [coordinate(24)],
    });
    expect(result).toMatchObject({
      status: "ready",
      authority: {
        scheme: "domain_key_v2",
        keyClass: "human",
        readerDeviceSigningKeyGeneration: 3,
        hostAuthorizationRevision: 7,
        policyRevision: 9,
        namespaceAccessRevision: 4,
        namespaceHeadDigestBase64url:
          Buffer.from(DIGEST_BYTES).toString("base64url"),
      },
    });
  });

  test("projects Human-peer retained rows with only Human authority and sender-device evidence", async () => {
    const requestBytes = new Uint8Array([4, 5, 6]);
    const restrictedExecutor: PostgresJsBridgeExecutor = {
      query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
        expect(statement).toContain("m295_room_history_human_peer_signer_evidence");
        return [{
          device_id: "device:human-peer-sender",
          device_generation: 2,
          signing_public_key: new Uint8Array(32).fill(9),
        }] as unknown as readonly Row[];
      },
    };
    const restricted = Object.freeze({
      query: restrictedExecutor.query,
      transaction: <Result>(
        use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      ) => use(restrictedExecutor),
      transactionOnce: <Result>(
        use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      ) => use(restrictedExecutor),
    }) satisfies PostgresJsBridgeConnection;
    const { project, connection } = await subject([[
      productRow(0, 25, {
        fingerprint: "human-peer-operation-25",
        key_class: "human",
        shadow_operation_id: null,
        human_peer_shadow_operation_id: "human-peer-operation-25",
        shadow_transcript_ordinal: 1,
        plan_bytes: new Uint8Array([1, 2, 3]),
        human_request_bytes: requestBytes,
        human_request_digest: sha256(requestBytes),
        human_peer_committer_device_id: "device:human-peer-sender",
        human_peer_committer_device_signing_key_generation: 2,
      }),
    ]], restricted, "human");

    const result = await project({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      selectedCoordinates: [coordinate(25, {
        logicalMessageKey: "turn:human-peer-operation-25",
      })],
    });
    expect(result).toMatchObject({
      status: "ready",
      authority: { scheme: "domain_key_v2", keyClass: "human" },
      eligibleCount: 1,
      records: [{
        shadowOperationId: "human-peer-operation-25",
        protectedMessage: {
          protectedPayload: { keyClass: "human" },
        },
      }],
      signerEvidence: [{
        kind: "human_peer_live_shadow_request_v1",
        operationId: "human-peer-operation-25",
        senderDeviceId: "device:human-peer-sender",
        senderDeviceSigningKeyGeneration: 2,
      }],
    });
    expect(connection.queries.some((query) =>
      query.statement.includes("m275_room_history_complete")
    )).toBe(false);
  });

  test.each(["stable", "last_agent_removed", "membership_removed", "access_changed", "read_denied", "recipient_missing", "recipient_duplicate", "device_revoked"] as const)(
    "resolves closed group current V2 authority with detached revalidation: %s", async (scenario) => {
    const crypto = new LatticeCrypto(seededRng(275_001));
    let productTransactionOpen = false;
    let policyReads = 0;
    let captures = 0;
    const otherHuman = "10000000-0000-4000-8000-000000000008";
    const humans = [HUMAN_ID, otherHuman];
    const productExecutor: PostgresJsBridgeExecutor = {
      query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
        let rows: readonly PostgresJsBridgeRow[];
        if (statement.includes("m275_room_history_policy")) {
          policyReads += 1;
          rows = [{ mode: "shadow_encryption", revision: 9 }];
        } else if (statement.startsWith('select "id", "namespace_id", "parent_room_id" from "rooms"')) {
          rows = [{ id: ROOM_ID, namespace_id: NAMESPACE_ID, parent_room_id: null }];
        } else if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
          rows = [{ room_id: ROOM_ID }];
        } else if (statement.includes("m298_namespace_key_human_ai_readable_actor")) {
          rows = [{ subject_user_id: USER_ID }];
        } else if (statement.includes("m298_namespace_key_human_ai_readable_source_room")) {
          captures++;
          rows = scenario === "read_denied" ? [] : [{
            source_room_id: ROOM_ID,
            source_kind: "group",
            source_parent_room_id: null,
            source_archived_at: null,
            room_id: ROOM_ID,
            namespace_id: NAMESPACE_ID,
            kind: "group",
            parent_room_id: null,
            archived_at: null,
            namespace_access_revision: scenario === "access_changed" && captures === 2 ? 5 : 4,
            human_actor_ids: humans,
            subject_user_id: USER_ID,
          }];
        } else if (statement.includes("m298_namespace_key_human_ai_readable_authority_members")) {
          rows = [
            ...(scenario === "membership_removed" && captures === 2 ? []
              : [{ actor_id: HUMAN_ID, kind: "user" }]),
            { actor_id: otherHuman, kind: "user" },
            ...(scenario === "last_agent_removed" ? [] : [
              { actor_id: USER_ID, kind: "agent" },
              { actor_id: "10000000-0000-4000-8000-000000000009", kind: "agent" },
            ]),
          ];
        } else {
          throw new Error(`Unexpected product query: ${statement}`);
        }
        return rows as readonly Row[];
      },
    };
    const product = Object.freeze({
      query: productExecutor.query,
      transaction: <Result>(
        use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      ) => use(productExecutor),
      transactionOnce: async <Result>(
        use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      ) => {
        productTransactionOpen = true;
        try {
          return await use(productExecutor);
        } finally {
          productTransactionOpen = false;
        }
      },
    }) satisfies PostgresJsBridgeConnection;
    const restrictedExecutor: PostgresJsBridgeExecutor = {
      query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
        expect(productTransactionOpen).toBe(false);
        const rows = domainKeyAuthorityRows(statement, humans, 1, 2);
        if (statement.includes('from "domain_key_recipient_envelopes"')) {
          if (scenario === "recipient_missing") return [];
          if (scenario === "recipient_duplicate") return Object.freeze([...rows, ...rows]) as readonly Row[];
        }
        if (scenario === "device_revoked" && statement.includes('from "human_crypto_devices"')) return [];
        return rows as readonly Row[];
      },
    };
    const restricted = Object.freeze({
      query: restrictedExecutor.query,
      transaction: <Result>(
        use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      ) => use(restrictedExecutor),
      transactionOnce: <Result>(
        use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      ) => use(restrictedExecutor),
    }) satisfies PostgresJsBridgeConnection;
    const resolve = createCurrentDomainKeyRoomHistoryAuthorityResolver({
      product,
      productAuthority: new PostgresNamespaceProductAuthority(product),
      domainKeys: new PostgresDomainKeyAuthorityRepository(
        restricted,
        crypto,
        "history-test",
      ),
    });

    const result = await resolve({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      selectedCoordinates: [coordinate(11)],
    });
    if (scenario !== "stable" && scenario !== "last_agent_removed" && scenario !== "recipient_missing") {
      expect(result).toEqual({ status: "unavailable" });
      expect(captures).toBe(scenario === "read_denied" ? 1 : 2);
      return;
    }
    expect(result).toMatchObject({
      status: "ready",
      authority: {
        policyRevision: 9,
        scheme: "domain_key_v2",
        keyClass: "ai",
        domainId: "domain-v2-1",
        domainKeyGeneration: 5,
        domainAuthorizationRevision: 6,
        namespaceBundleRevision: 7,
      },
    });
    expect(policyReads).toBe(2);
    if (scenario === "recipient_missing") {
      const deniedWrite = await new PostgresNamespaceProductAuthority(product)
        .withDetachedCurrentMessageHistoryRead({
          subjectUserId: USER_ID, subjectHumanId: HUMAN_ID, roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
          use: authority => new PostgresDomainKeyAuthorityRepository(restricted, crypto, "history-test")
            .inspectSharedAgentWriteAuthority({authority, deviceId: DEVICE_ID, keyClass: "ai"}),
        });
      expect(deniedWrite).toEqual({status: "unavailable", reason: "recipient_sync_required"});
    }
  });

  test("Full history selects and returns no ordinary body or sibling transcript", async () => {
    const row = productRow(0, 11, { parity_status: "client_authenticated" });
    delete row["content"];
    delete row["tool_calls"];
    delete row["tool_name"];
    const { connection, cryptoReads, project } = await subject([[row]]);
    const result = await project({
      subjectUserId: USER_ID, subjectHumanId: HUMAN_ID, readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID, selectedCoordinates: [coordinate(11)], representationMode: "protected-only",
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected protected-only history");
    expect(result.records[0]).toHaveProperty("representationMode", "protected-only");
    expect(result.records[0]).not.toHaveProperty("ordinaryPayloadBytesBase64url");
    expect(cryptoReads).toEqual([`object:${OBJECT_ID}`, `access:${OBJECT_ID}`]);
    expect(connection.queries).toHaveLength(2);
    for (const column of ["content", "tool_calls", "tool_name"]) {
      expect(connection.queries[1]?.statement).not.toContain(`"session_messages"."${column}"`);
    }
  });

  test.each(["ai", "human"] as const)(
    "projects a Full edited Human %s object from its manifest despite copied origin lineage", async (keyClass) => {
      const crypto = new LatticeCrypto(seededRng(keyClass === "ai" ? 318_401 : 318_402));
      const signing = crypto.generateSigningKeyPair();
      const key = new Uint8Array(32).fill(0x31);
      const id = deriveHumanMessageEditCryptoObjectIdV1({
        operationId: "human-edit:v1:30000000-0000-4000-8000-000000000318",
        sessionId: SESSION_ID, messageId: 31, revision: 1,
      });
      const common = { crypto, objectId: id,
        payload: { role: "user" as const, content: "edited protected body" },
        createdAt: Date.parse("2027-01-15T08:00:00.000Z"),
        device: { deviceId: DEVICE_ID, hostAuthorizationRevision: 2,
          signingPrivateKey: signing.privateKey }, resolveCurrentAuthorization: () => null };
      const prepared = keyClass === "ai"
        ? prepareHumanExistingMessageRepresentationCryptoRevision({ ...common,
            namespace: { namespaceId: NAMESPACE_ID, accessRevision: 4,
              keyGeneration: 1, aiKey: key } })
        : prepareHumanPeerLiveShadowCryptoRevision({ ...common,
            namespace: { namespaceId: NAMESPACE_ID, accessRevision: 4,
              keyGeneration: 1, humanKey: key } });
      const snapshot = readPreparedConversationCryptoRevision(prepared);
      const row = productRow(0, 31, { edit_revision: 1, key_class: keyClass,
        object_id_scheme: "human_message_edit_v1", crypto_object_id: id, lifecycle_object_id: id,
        parity_status: "client_authenticated",
        // These remain lineage only and must not select the create-request proof.
        shadow_operation_id: keyClass === "ai" ? "original-live-operation" : null,
        human_peer_shadow_operation_id: keyClass === "human" ? "original-peer-operation" : null,
      });
      delete row["content"];
      const { project } = await subject([[row]], undefined,
        keyClass === "human" ? "human" : "agent", undefined, {
          payloadBytes: snapshot.object.payloadBytes.ciphertext,
          manifestBytes: snapshot.access.manifestBytes,
          envelopeBytes: snapshot.access.envelopeBytes[0]!,
          signerPublicKey: signing.publicKey,
        });
      const result = await project({ subjectUserId: USER_ID, subjectHumanId: HUMAN_ID,
        readerDeviceId: DEVICE_ID, roomId: ROOM_ID,
        selectedCoordinates: [coordinate(31, { editRevision: 1 })],
        representationMode: "protected-only" });
      expect(result).toMatchObject({ status: "ready", records: [{
        kind: "human_edited_representation", representationMode: "protected-only",
        authorHumanId: HUMAN_ID, protectedMessage: { protectedPayload: { keyClass } },
      }], signerEvidence: [] });
    });

  test("a missing Human authority preserves independently projected AI history in a mixed page", async () => {
    const ai = productRow(0, 11, { content: null });
    const human = productRow(1, 12, { content: null, key_class: "human",
      shadow_operation_id: null, human_peer_shadow_operation_id: "human-12" });
    const { project } = await subject([[ai, human], [ai], [{ ...human, selection_ordinal: 0 }]]);
    const result = await project({ subjectUserId: USER_ID, subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID, roomId: ROOM_ID,
      selectedCoordinates: [coordinate(11), coordinate(12)], representationMode: "protected-only" });
    expect(result).toMatchObject({ status: "ready", selectedCount: 2, eligibleCount: 2,
      authorities: [{ keyClass: "ai" }], records: [{ coordinate: { messageId: 11 } }] });
    if (result.status !== "ready") throw new Error("expected partial ready projection");
    expect(result.records).toHaveLength(1);
  });

  test("Shadow ciphertext-only history remains reachable without an invented sibling", async () => {
    const { project } = await subject([[productRow(0, 11, { content: null })]]);
    const result = await project({
      subjectUserId: USER_ID, subjectHumanId: HUMAN_ID, readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID, selectedCoordinates: [coordinate(11)],
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ciphertext-only history");
    expect(result.records[0]).toHaveProperty("representationMode", "protected-only");
    expect(result.records[0]).not.toHaveProperty("ordinaryPayloadBytesBase64url");
  });

  test("batches the exact cross-member selection and preserves eligible pending/corrupt rows", async () => {
    const selected = [
      coordinate(11),
      coordinate(12, { sessionId: OTHER_SESSION_ID }),
      coordinate(13),
      coordinate(14),
    ];
    const { connection, cryptoReads, project } = await subject([[
      productRow(0, 11),
      productRow(1, 12, {
        session_id: OTHER_SESSION_ID,
        object_id_scheme: null,
        lifecycle_object_id: null,
        crypto_object_id: null,
        key_class: null,
        author_role: null,
      }),
      productRow(2, 13, {
        crypto_object_id: null,
        lifecycle_object_id: "message:v2:pending",
        completion: "pending",
        disposition: "active",
        parity_status: "pending",
      }),
      productRow(3, 14, {
        crypto_object_id: CORRUPT_OBJECT_ID,
        lifecycle_object_id: CORRUPT_OBJECT_ID,
      }),
    ], [
      {
        shadow_operation_id: "shadow-operation-11",
        shadow_transcript_ordinal: 1,
        role: "user",
        content: "human 11",
        tool_calls: null,
        tool_name: null,
      },
      {
        shadow_operation_id: "shadow-operation-13",
        shadow_transcript_ordinal: 1,
        role: "user",
        content: "human 13",
        tool_calls: null,
        tool_name: null,
      },
      {
        shadow_operation_id: "shadow-operation-14",
        shadow_transcript_ordinal: 1,
        role: "user",
        content: "human 14",
        tool_calls: null,
        tool_name: null,
      },
    ]]);

    const result = await project({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      selectedCoordinates: selected,
    });

    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") throw new Error("expected ready projection");
    expect(result.selectedCount).toBe(4);
    expect(result.eligibleCount).toBe(3);
    expect(result.records.map((record) => ({
      messageId: record.coordinate.messageId,
      payload: record.protectedMessage.protectedPayload,
    }))).toEqual([
      {
        messageId: 11,
        payload: {
          status: "encrypted",
          cryptoObjectId: OBJECT_ID,
          payloadVersion: 2,
          keyClass: "ai",
          encryptedPayloadBytesBase64url: "AQID",
          accessManifestBytesBase64url: "BAUG",
          namespaceEnvelopeBytesBase64url: "BwgJ",
        },
      },
      {
        messageId: 13,
        payload: { status: "pending", reason: "shadow_pending" },
      },
      {
        messageId: 14,
        payload: {
          status: "unavailable",
          reason: "corrupt",
          cryptoObjectId: CORRUPT_OBJECT_ID,
        },
      },
    ]);
    expect(result.records.every((record) =>
      liveRecord(record).ordinaryPayloadBytesBase64url.length > 0
      && liveRecord(record).retainedGeneration.namespaceGeneration === 1
      && liveRecord(record).retainedGeneration.accessRevision === 4
    )).toBe(true);
    expect(result.signerEvidence).toEqual([]);
    expect(cryptoReads).toEqual([
      `object:${OBJECT_ID}`,
      `access:${OBJECT_ID}`,
      `object:${CORRUPT_OBJECT_ID}`,
      `access:${CORRUPT_OBJECT_ID}`,
    ]);
    const query = connection.queries.find((candidate) =>
      candidate.statement.includes('as "selection_ordinal"')
    )!;
    expect(query.statement).toContain("CASE WHEN");
    expect(query.statement).toContain("session_message_crypto_revisions");
    expect(query.statement).toContain('"session_messages"."content"');
    expect(query.parameters).toContain(ROOM_ID);
    expect(query.parameters.filter((value) => value === SESSION_ID)).toHaveLength(9);
  });

  test("resolves a selected tool result from its complete operation and deduplicates signer evidence", async () => {
    const evidenceBytes = new Uint8Array([9, 8, 7]);
    const restrictedExecutor: PostgresJsBridgeExecutor = {
      query: async <Row extends PostgresJsBridgeRow>() => [{
        signer_key_id: "agent-signer-1",
        publication_bytes: evidenceBytes,
      }] as unknown as readonly Row[],
    };
    const restricted = Object.freeze({
      query: restrictedExecutor.query,
      transaction: <Result>(
        use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      ) => use(restrictedExecutor),
      transactionOnce: <Result>(
        use: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      ) => use(restrictedExecutor),
    }) satisfies PostgresJsBridgeConnection;
    const operationId = "shadow-operation-tool";
    const { project } = await subject([[
      productRow(0, 21, {
        role: "tool",
        content: "tool result",
        tool_name: "lookup",
        fingerprint: null,
        author_agent_id: USER_ID,
        author_role: "tool",
        shadow_operation_id: operationId,
        shadow_transcript_ordinal: 3,
      }),
    ], [
      {
        shadow_operation_id: operationId,
        shadow_transcript_ordinal: 1,
        role: "user",
        content: "find it",
        tool_calls: null,
        tool_name: null,
      },
      {
        shadow_operation_id: operationId,
        shadow_transcript_ordinal: 2,
        role: "assistant",
        content: "",
        tool_calls: JSON.stringify([{
          id: "call-from-previous-page",
          name: "lookup",
          args: { query: "value" },
        }]),
        tool_name: null,
      },
      {
        shadow_operation_id: operationId,
        shadow_transcript_ordinal: 3,
        role: "tool",
        content: "tool result",
        tool_calls: null,
        tool_name: "lookup",
      },
    ]], restricted);

    const result = await project({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      selectedCoordinates: [coordinate(21, {
        role: "tool",
        logicalMessageKey: "row:21",
      })],
    });
    expect(result).toMatchObject({ status: "ready", eligibleCount: 1 });
    if (result.status !== "ready") throw new Error("expected ready projection");
    const opened = decodeMessagePayloadV2(Buffer.from(
      liveRecord(result.records[0]!).ordinaryPayloadBytesBase64url,
      "base64url",
    ));
    expect(opened.sensitiveMetadata).toEqual({
      toolCallId: "call-from-previous-page",
    });
    expect(result.signerEvidence).toEqual([{
      kind: "agent_runtime_publication",
      evidenceBytesBase64url: "CQgH",
    }]);
  });

  test("projects the exact retained Human-signed live request instead of requiring a legacy runtime publication", async () => {
    const operationId = "shadow-operation-live-evidence";
    const planBytes = new Uint8Array(262_145).fill(1);
    const requestBytes = new Uint8Array(524_289).fill(2);
    const { project } = await subject([[
      productRow(0, 22, {
        role: "assistant",
        content: "agent answer",
        fingerprint: null,
        created_at: "2027-01-15 08:00:00+00",
        author_role: "assistant",
        author_agent_id: USER_ID,
        shadow_operation_id: operationId,
        plan_bytes: planBytes,
        human_request_bytes: requestBytes,
        human_request_digest: sha256(requestBytes),
        namespace_generation: 0,
      }),
    ], [{
      shadow_operation_id: operationId,
      shadow_transcript_ordinal: 1,
      role: "assistant",
      content: "agent answer",
      tool_calls: null,
      tool_name: null,
    }]]);

    const result = await project({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      selectedCoordinates: [coordinate(22, {
        role: "assistant",
        logicalMessageKey: "row:22",
      })],
    });

    expect(result).toMatchObject({ status: "ready", eligibleCount: 1 });
    if (result.status !== "ready") throw new Error("expected ready projection");
    expect(result.signerEvidence).toHaveLength(1);
    expect(result.signerEvidence[0]).toMatchObject({
      kind: "human_live_shadow_request_v3",
      operationId,
      requestDigestBase64url: Buffer.from(sha256(requestBytes))
        .toString("base64url"),
    });
    if (result.signerEvidence[0]?.kind !== "human_live_shadow_request_v3") {
      throw new Error("expected retained Human request evidence");
    }
    expect(Buffer.from(
      result.signerEvidence[0].planBytesBase64url,
      "base64url",
    )).toHaveLength(planBytes.length);
    expect(Buffer.from(
      result.signerEvidence[0].requestBytesBase64url,
      "base64url",
    )).toHaveLength(requestBytes.length);
    expect(liveRecord(result.records[0]!).retainedGeneration.namespaceGeneration).toBe(0);
  });

  test("fails the complete sidecar on selected-row substitution before crypto reads", async () => {
    const { cryptoReads, project } = await subject([[productRow(0, 99)]]);
    const result = await project({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      selectedCoordinates: [coordinate(11)],
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "selection_changed",
      selectedCount: 1,
      eligibleCount: 0,
    });
    expect(cryptoReads).toEqual([]);
  });

  test("counts eligibility before unavailable V2 authority and performs no crypto read", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [productRow(0, 11)],
    ]);
    const product = await verifyConversationProductPostgresHandle(connection);
    let cryptoReads = 0;
    const project = createPostgresRoomHistoryShadowProjection({
      product,
      resolveAuthority: async () => ({ status: "unavailable" }),
      crypto: {
        getObject: async () => {
          cryptoReads += 1;
          return null;
        },
        getObjectAccessState: async () => {
          cryptoReads += 1;
          return null;
        },
      },
    });

    const result = await project({
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      roomId: ROOM_ID,
      selectedCoordinates: [coordinate(11)],
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "current_read_authority_unavailable",
      selectedCount: 1,
      eligibleCount: 1,
    });
    expect(connection.queries).toHaveLength(2);
    expect(cryptoReads).toBe(0);
  });
});
