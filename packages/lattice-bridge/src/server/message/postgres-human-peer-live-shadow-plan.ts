import { randomUUID } from "node:crypto";

import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  and,
  asc,
  conversationHumanPeerShadowOperations,
  eq,
  inArray,
  lte,
  sessions,
  sql,
} from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  humanPeerLiveShadowAcknowledgementDigest,
  unixTimestamp,
  verifyHumanPeerLiveShadowAcknowledgement,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanPeerLiveShadowMessageRequestV1,
  encodeHumanPeerLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";

import { deriveLiveShadowMessageCryptoObjectIdV1 } from
  "../../message/conversation-repository.ts";
import {
  PostgresNamespaceProductAuthority,
  type HumanPeerNamespaceWriteAuthorityResult,
} from "../delivery/postgres-namespace-product-authority.ts";
import { PostgresDomainKeyAuthorityRepository } from
  "../delivery/postgres-domain-key-authority.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
} from "./postgres-conversation-product-store.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export type HumanPeerLiveShadowPlanResult =
  | Readonly<{ status: "disabled"; mode: "plaintext_only" }>
  | Readonly<{
      status: "ineligible";
      reason: "room_topology_unsupported";
    }>
  | Readonly<{
      status: "unavailable";
      authorizationScheme: "human_peer_v1";
      reason:
        | "policy_unavailable"
        | "device_unavailable"
        | "namespace_unavailable"
        | "recipient_sync_required"
        | "reservation_unavailable";
      requiredNamespaceIds?: readonly string[];
    }>
  | Readonly<{ status: "planned"; planBytes: Uint8Array;
      representationMode?: "full_encryption" }>;

export interface HumanPeerLiveShadowPlanInput {
  readonly mentionEveryone?: boolean;
  readonly authority: Readonly<{
    userId: string;
    humanActorId: string;
  }>;
  readonly roomId: string;
  readonly clientDeviceId: string;
  readonly idempotencyKey: string;
  readonly now: number;
}

function one(
  rows: readonly PostgresJsBridgeRow[],
  label: string,
): PostgresJsBridgeRow {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new TypeError(`${label} is not unique`);
  }
  return rows[0];
}

function text(row: PostgresJsBridgeRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function number(row: PostgresJsBridgeRow, field: string): number {
  const value = row[field];
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized as number;
}

function dateMillis(row: PostgresJsBridgeRow, field: string): number {
  const value = row[field];
  const result = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
    ? Date.parse(value)
    : Number.NaN;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${field} is invalid`);
  }
  return result;
}

function bytes(row: PostgresJsBridgeRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new TypeError(`${field} is invalid`);
  }
  return value.slice();
}

function destroyAuthority(
  value: Extract<HumanPeerNamespaceWriteAuthorityResult, { status: "ready" }>,
): void {
  value.committerDeviceSigningPublicKey.fill(0);
  value.namespaceHeadDigest.fill(0);
  value.namespacePublicationDigest.fill(0);
  value.namespacePublicationSetDigest.fill(0);
  value.namespaceAudienceFingerprint.fill(0);
}

async function ensureHumanSession(
  product: PostgresJsBridgeConnection,
  input: HumanPeerLiveShadowPlanInput,
): Promise<Readonly<{
  sessionId: string;
  namespaceId: string;
  policyRevision: number;
  representationMode?: "full_encryption";
}> | "disabled" | "policy_unavailable" | null> {
  const policy = await product.query(
    `/* m295_human_peer_policy */
     SELECT mode, revision FROM encryption_transition_policy
      WHERE id = 'server' LIMIT 2`,
  );
  if (policy.length !== 1) return "policy_unavailable";
  const mode = text(policy[0]!, "mode");
  if (mode === "plaintext_only") return "disabled";
  if (mode !== "shadow_encryption" && mode !== "encrypted_only") {
    return "policy_unavailable";
  }
  const rooms = await product.query(
    `/* m295_human_peer_session_room */
     SELECT r.graph_thread_id, r.namespace_id::text AS namespace_id,
            r.parent_room_id, r.archived_at, actor.owner_id::text AS owner_id
       FROM rooms r
       JOIN actors actor ON actor.id = $2::uuid AND actor.kind = 'user'
      WHERE r.id = $1::uuid
      LIMIT 2`,
    [input.roomId, input.authority.humanActorId],
  );
  if (rooms.length !== 1) return null;
  const room = rooms[0]!;
  if (
    room["parent_room_id"] !== null
    || room["archived_at"] !== null
    || text(room, "owner_id") !== input.authority.userId
  ) return null;
  const threadId = text(room, "graph_thread_id");
  await product.query(
    `/* m295_human_peer_session_ensure */
     INSERT INTO sessions
       (thread_id, owner_id, persona_id, room_id, channel)
     VALUES ($1, $2::uuid, 'owner', $3::uuid, 'browser')
     ON CONFLICT (owner_id, thread_id) DO NOTHING`,
    [threadId, input.authority.userId, input.roomId],
  );
  const session = one(await executeTypedConversationProductQuery(
    product,
    conversationProductTypedDb.select({ id: sessions.id, room_id: sessions.roomId })
      .from(sessions)
      .where(and(eq(sessions.ownerId, input.authority.userId), eq(sessions.threadId, threadId))),
  ), "Human-peer Session");
  // sessions.agent_id is a routing/default hint, not Room membership. The
  // locked canonical roster in withCurrentHumanOnlyRoom below owns topology.
  if (text(session, "room_id") !== input.roomId) return null;
  return Object.freeze({
    sessionId: text(session, "id"),
    namespaceId: text(room, "namespace_id"),
    policyRevision: number(policy[0]!, "revision"),
    ...(mode === "encrypted_only"
      ? { representationMode: "full_encryption" as const }
      : {}),
  });
}

export class PostgresHumanPeerLiveShadowPlanner {
  readonly #productAuthority: PostgresNamespaceProductAuthority;
  readonly #repository: PostgresDomainKeyAuthorityRepository;

  constructor(
    private readonly product: PostgresJsBridgeConnection,
    restricted: PostgresJsBridgeConnection,
    private readonly crypto = new LatticeCrypto(),
    serverId: string,
  ) {
    this.#productAuthority = new PostgresNamespaceProductAuthority(product);
    this.#repository = new PostgresDomainKeyAuthorityRepository(
      restricted,
      crypto,
      serverId,
    );
  }

  async plan(
    input: HumanPeerLiveShadowPlanInput,
  ): Promise<HumanPeerLiveShadowPlanResult> {
    if (
      !UUID.test(input.authority.userId)
      || !UUID.test(input.authority.humanActorId)
      || !UUID.test(input.roomId)
      || !PORTABLE.test(input.clientDeviceId)
      || !PORTABLE.test(input.idempotencyKey)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Human-peer plan input is invalid");
    const product = await ensureHumanSession(this.product, input);
    if (product === "disabled") {
      return Object.freeze({ status: "disabled", mode: "plaintext_only" });
    }
    if (product === "policy_unavailable") {
      return Object.freeze({
        status: "unavailable",
        authorizationScheme: "human_peer_v1",
        reason: "policy_unavailable",
      });
    }
    if (product === null) {
      return Object.freeze({
        status: "ineligible",
        reason: "room_topology_unsupported",
      });
    }
    const inspected = await this.#productAuthority.withCurrentHumanOnlyRoom({
      subjectUserId: input.authority.userId,
      subjectHumanId: input.authority.humanActorId,
      roomId: input.roomId,
      namespaceId: product.namespaceId,
      use: (authority) => this.#repository.inspectSharedAgentWriteAuthority({
        authority,
        deviceId: input.clientDeviceId,
        keyClass: "human",
      }),
    });
    if (inspected === null) {
      return Object.freeze({
        status: "ineligible",
        reason: "room_topology_unsupported",
      });
    }
    if (inspected.status === "unavailable") {
      return Object.freeze({
        status: "unavailable",
        authorizationScheme: "human_peer_v1",
        reason: inspected.reason,
        ...(inspected.reason === "namespace_unavailable"
            || inspected.reason === "recipient_sync_required"
          ? { requiredNamespaceIds: [product.namespaceId] }
          : {}),
      });
    }
    try {
      return await this.product.transactionOnce(async (transaction) => {
        await transaction.query(
          `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
          [product.sessionId, input.idempotencyKey],
        );
        const existing = await transaction.query(
          `/* m295_human_peer_plan_replay */
           SELECT operation.plan_bytes, operation.deadline_at,
                  attempt.policy_revision
             FROM conversation_human_peer_shadow_plan_attempts attempt
             JOIN conversation_human_peer_shadow_operations operation
               ON operation.operation_id = attempt.operation_id
            WHERE attempt.session_id = $1::uuid
              AND attempt.client_idempotency_key = $2
              AND attempt.state = 'planned'
            LIMIT 2`,
          [product.sessionId, input.idempotencyKey],
        );
        if (existing.length === 1) {
          if (dateMillis(existing[0]!, "deadline_at") <= input.now
            || number(existing[0]!, "policy_revision") !== product.policyRevision) {
            return Object.freeze({
              status: "unavailable" as const,
              authorizationScheme: "human_peer_v1" as const,
              reason: "reservation_unavailable" as const,
            });
          }
          return Object.freeze({
            status: "planned" as const,
            planBytes: bytes(existing[0]!, "plan_bytes"),
            ...(product.representationMode === undefined ? {}
              : { representationMode: product.representationMode }),
          });
        }
        const messageRows = await transaction.query(
          `SELECT nextval(
             pg_get_serial_sequence('session_messages', 'id')
           )::integer AS message_id`,
        );
        const messageId = number(
          one(messageRows, "Human-peer Message reservation"),
          "message_id",
        );
        if (messageId < 1) throw new Error("Human-peer Message ID is invalid");
        const operationId = randomUUID();
        const attemptCoordinate = randomUUID();
        const createdAt = input.now;
        const deadlineAt = input.now + 30_000;
        const transcriptOrdinal = 1;
        const cryptoObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
          operationId,
          sessionId: product.sessionId,
          messageId,
          revision: 0,
          transcriptOrdinal,
          authorRole: "user",
        });
        const planBytes = encodeHumanPeerLiveShadowMessagePlanV1({
          formatVersion: 1,
          purpose: "message.human_peer_live_shadow_plan",
          operationId,
          clientIdempotencyKey: input.idempotencyKey,
          ...(input.mentionEveryone === true ? { mentionEveryone: true as const } : {}),
          policyRevision: product.policyRevision,
          sessionId: product.sessionId,
          roomId: input.roomId,
          humanMessageId: messageId,
          revision: 0,
          transcriptOrdinal,
          role: "user",
          createdAt: unixTimestamp(createdAt),
          subjectHumanId: inspected.subjectHumanId,
          committerDeviceId: inspected.committerDeviceId,
          committerDeviceSigningKeyGeneration:
            inspected.committerDeviceSigningKeyGeneration,
          hostAuthorizationRevision: authorizationRevision(
            inspected.committerDeviceRevision,
          ),
          namespaceId: inspected.namespaceId,
          keyClass: "human",
          namespaceAccessRevision: inspected.namespaceAccessRevision,
          namespaceKeyGeneration: inspected.namespaceKeyGeneration,
          namespaceHeadDigest: inspected.namespaceHeadDigest,
          namespacePublicationDigest: inspected.namespacePublicationDigest,
          namespacePublicationSetDigest:
            inspected.namespacePublicationSetDigest,
          namespaceAudienceFingerprint:
            inspected.namespaceAudienceFingerprint,
          attemptCoordinate,
          issuedAt: unixTimestamp(input.now),
          deadlineAt: unixTimestamp(deadlineAt),
        });
        const planDigest = this.crypto.hash(planBytes);
        try {
          await transaction.query(
            `/* m295_human_peer_operation_insert */
             INSERT INTO conversation_human_peer_shadow_operations (
               operation_id, client_idempotency_key, policy_revision,
               session_id, room_id, human_message_id,
               human_message_created_at, transcript_ordinal,
               subject_human_id, committer_device_id,
               committer_device_signing_key_generation,
               host_authorization_revision, namespace_id,
               namespace_access_revision, namespace_key_generation,
               namespace_head_digest, namespace_publication_digest,
               namespace_publication_set_digest,
               namespace_audience_fingerprint, crypto_object_id,
               attempt_coordinate, plan_digest, plan_bytes, state,
               deadline_at)
             VALUES (
               $1, $2, $3, $4::uuid, $5::uuid, $6,
               to_timestamp($7 / 1000.0), $8, $9, $10, $11, $12,
               $13::uuid, $14, $15, $16, $17, $18, $19, $20, $21,
               $22, $23, 'planned', to_timestamp($24 / 1000.0))`,
            [
              operationId, input.idempotencyKey, product.policyRevision,
              product.sessionId, input.roomId, messageId, createdAt,
              transcriptOrdinal, inspected.subjectHumanId,
              inspected.committerDeviceId,
              inspected.committerDeviceSigningKeyGeneration,
              inspected.committerDeviceRevision, inspected.namespaceId,
              inspected.namespaceAccessRevision,
              inspected.namespaceKeyGeneration,
              inspected.namespaceHeadDigest,
              inspected.namespacePublicationDigest,
              inspected.namespacePublicationSetDigest,
              inspected.namespaceAudienceFingerprint, cryptoObjectId,
              attemptCoordinate, planDigest, planBytes, deadlineAt,
            ],
          );
          await transaction.query(
            `/* m295_human_peer_plan_attempt_insert */
             INSERT INTO conversation_human_peer_shadow_plan_attempts (
               session_id, room_id, client_idempotency_key, policy_revision,
               subject_user_id, state, operation_id)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, 'planned', $6)`,
            [product.sessionId, input.roomId, input.idempotencyKey,
              product.policyRevision, input.authority.userId, operationId],
          );
          return Object.freeze({ status: "planned" as const, planBytes,
            ...(product.representationMode === undefined ? {}
              : { representationMode: product.representationMode }) });
        } finally {
          planDigest.fill(0);
        }
      }, { isolationLevel: "read committed" });
    } finally {
      destroyAuthority(inspected);
    }
  }

  /** Close expired Human-only writes independently of another Room send. */
  async reconcileExpired(now: number, maximum = 64): Promise<number> {
    if (
      !Number.isSafeInteger(now)
      || now < 0
      || !Number.isSafeInteger(maximum)
      || maximum < 1
      || maximum > 256
    ) throw new TypeError("Human-peer reconciliation bounds are invalid");
    return this.product.transactionOnce(async (transaction) => {
      const due = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          operationId: conversationHumanPeerShadowOperations.operationId,
        }).from(conversationHumanPeerShadowOperations).where(and(
          inArray(
            conversationHumanPeerShadowOperations.state,
            ["planned", "human_verified"],
          ),
          lte(conversationHumanPeerShadowOperations.deadlineAt, new Date(now)),
        )).orderBy(
          asc(conversationHumanPeerShadowOperations.deadlineAt),
          asc(conversationHumanPeerShadowOperations.sequence),
        ).limit(maximum).for("update", {
          of: conversationHumanPeerShadowOperations,
          skipLocked: true,
        }),
      );
      const operationIds = due.map((row) => String(row.operation_id));
      if (operationIds.length === 0) return 0;
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.update(
          conversationHumanPeerShadowOperations,
        ).set({
          state: "failed",
          terminalStage:
            sql`CASE WHEN ${conversationHumanPeerShadowOperations.state} = 'planned' THEN 'human_admission' ELSE 'protected_completion' END`,
          terminalReason: "deadline_expired",
          terminalAt: new Date(now),
          reconciliationAttemptCount:
            sql`LEAST(${conversationHumanPeerShadowOperations.reconciliationAttemptCount} + 1, 8)`,
          updatedAt: new Date(now),
        }).where(inArray(
          conversationHumanPeerShadowOperations.operationId,
          operationIds,
        )).returning({
          operationId: conversationHumanPeerShadowOperations.operationId,
        }),
      );
      return rows.length;
    });
  }

  /** Close one durable write only after its correlated Room event is ready. */
  async recordPublished(input: Readonly<{
    operationId: string;
    messageId: number;
    protectedMessageDigest: Uint8Array;
    finalEventDigest: Uint8Array;
    now: number;
  }>): Promise<"published" | "replayed" | "conflict"> {
    if (
      !PORTABLE.test(input.operationId)
      || !Number.isSafeInteger(input.messageId)
      || input.messageId < 1
      || input.protectedMessageDigest.length !== 32
      || input.finalEventDigest.length !== 32
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Human-peer publication receipt is invalid");
    return this.product.transactionOnce(async (transaction) => {
      const rows = await transaction.query(
        `/* m295_human_peer_publish_lock */
         SELECT human_message_id, state, protected_message_digest,
                final_event_digest
           FROM conversation_human_peer_shadow_operations
          WHERE operation_id = $1
          FOR UPDATE`,
        [input.operationId],
      );
      if (rows.length !== 1) return "conflict" as const;
      const row = rows[0]!;
      if (number(row, "human_message_id") !== input.messageId) {
        return "conflict" as const;
      }
      const state = text(row, "state");
      if (state === "published") {
        const protectedDigest = bytes(row, "protected_message_digest");
        const eventDigest = bytes(row, "final_event_digest");
        try {
          return protectedDigest.every((value, index) =>
              value === input.protectedMessageDigest[index]
            ) && eventDigest.every((value, index) =>
              value === input.finalEventDigest[index]
            ) ? "replayed" as const : "conflict" as const;
        } finally {
          protectedDigest.fill(0);
          eventDigest.fill(0);
        }
      }
      if (state !== "human_verified") return "conflict" as const;
      const updated = await transaction.query(
        `/* m295_human_peer_publish */
         UPDATE conversation_human_peer_shadow_operations
            SET state = 'published', protected_message_digest = $2,
                final_event_digest = $3,
                terminal_at = to_timestamp($4 / 1000.0),
                updated_at = to_timestamp($4 / 1000.0)
          WHERE operation_id = $1 AND state = 'human_verified'
        RETURNING operation_id`,
        [input.operationId, input.protectedMessageDigest,
          input.finalEventDigest, input.now],
      );
      return updated.length === 1 ? "published" as const : "conflict" as const;
    }, { isolationLevel: "read committed" });
  }

  /** Close one eligible protected attempt after the ordinary fallback wins. */
  async recordFallback(input: Readonly<{
    operationId: string;
    subjectHumanId: string;
    stage:
      | "human_admission"
      | "ordinary_commit"
      | "protected_completion"
      | "product_mapping"
      | "realtime_publication";
    reason:
      | "stale_authority"
      | "integrity_failure"
      | "parity_mismatch"
      | "deadline_expired"
      | "product_conflict"
      | "storage_failure"
      | "transport_failure";
    now: number;
  }>): Promise<"fallback" | "replayed" | "conflict"> {
    if (
      !PORTABLE.test(input.operationId)
      || !PORTABLE.test(input.subjectHumanId)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Human-peer fallback receipt is invalid");
    return this.product.transactionOnce(async (transaction) => {
      const rows = await transaction.query(
        `/* m295_human_peer_fallback_lock */
         SELECT state, terminal_stage, terminal_reason
           FROM conversation_human_peer_shadow_operations
          WHERE operation_id = $1 AND subject_human_id = $2
          FOR UPDATE`,
        [input.operationId, input.subjectHumanId],
      );
      if (rows.length !== 1) return "conflict" as const;
      const row = rows[0]!;
      const state = text(row, "state");
      if (state === "fallback") {
        return text(row, "terminal_stage") === input.stage
            && text(row, "terminal_reason") === input.reason
          ? "replayed" as const
          : "conflict" as const;
      }
      if (state !== "planned" && state !== "human_verified") {
        return "conflict" as const;
      }
      const updated = await transaction.query(
        `/* m295_human_peer_fallback */
         UPDATE conversation_human_peer_shadow_operations
            SET state = 'fallback', terminal_stage = $2,
                terminal_reason = $3,
                terminal_at = to_timestamp($4 / 1000.0),
                updated_at = to_timestamp($4 / 1000.0)
          WHERE operation_id = $1 AND state IN ('planned', 'human_verified')
        RETURNING operation_id`,
        [input.operationId, input.stage, input.reason, input.now],
      );
      return updated.length === 1 ? "fallback" as const : "conflict" as const;
    }, { isolationLevel: "read committed" });
  }

  /** Verify and retain one current recipient device's independent live read. */
  async acknowledge(input: Readonly<{
    operationId: string;
    roomId: string;
    acknowledgementBytes: Uint8Array;
    recipient: Readonly<{
      subjectHumanId: string;
      deviceId: string;
      deviceSigningKeyGeneration: number;
      hostAuthorizationRevision: number;
      signingPublicKey: Uint8Array;
    }>;
    now: number;
  }>): Promise<"verified" | "replayed" | "conflict"> {
    let acknowledgement;
    try {
      acknowledgement = verifyHumanPeerLiveShadowAcknowledgement(
        this.crypto,
        {
          bytes: input.acknowledgementBytes,
          now: unixTimestamp(input.now),
          resolveCurrentAuthority: (context) =>
            context.subjectHumanId === humanId(input.recipient.subjectHumanId)
                && context.operationId === input.operationId
                && context.committerDeviceId
                  === cryptoDeviceId(input.recipient.deviceId)
                && context.committerDeviceSigningKeyGeneration
                  === input.recipient.deviceSigningKeyGeneration
                && context.hostAuthorizationRevision
                  === authorizationRevision(
                    input.recipient.hostAuthorizationRevision,
                  )
              ? input.recipient.signingPublicKey.slice()
              : null,
        },
      );
    } catch {
      return "conflict";
    }
    try {
      return await this.product.transactionOnce(async (transaction) => {
        const rows = await transaction.query(
          `/* m295_human_peer_ack_lock */
           SELECT operation.session_id::text AS session_id,
                  operation.room_id::text AS room_id,
                  operation.human_message_id, operation.transcript_ordinal,
                  operation.crypto_object_id, operation.client_idempotency_key,
                  operation.policy_revision, operation.protected_message_digest,
                  operation.human_request_bytes, operation.state
             FROM conversation_human_peer_shadow_operations operation
            WHERE operation.operation_id = $1
            FOR UPDATE`,
          [input.operationId],
        );
        if (rows.length !== 1) return "conflict" as const;
        const row = rows[0]!;
        const requestBytes = bytes(row, "human_request_bytes");
        const protectedDigest = bytes(row, "protected_message_digest");
        const request = decodeHumanPeerLiveShadowMessageRequestV1(requestBytes);
        try {
          if (
            text(row, "state") !== "published"
            || text(row, "room_id") !== input.roomId
            || acknowledgement.operationId !== input.operationId
            || acknowledgement.clientIdempotencyKey
              !== text(row, "client_idempotency_key")
            || acknowledgement.policyRevision !== number(row, "policy_revision")
            || acknowledgement.sessionId !== text(row, "session_id")
            || acknowledgement.roomId !== input.roomId
            || acknowledgement.messageId !== number(row, "human_message_id")
            || acknowledgement.revision !== 0
            || acknowledgement.transcriptOrdinal
              !== number(row, "transcript_ordinal")
            || acknowledgement.cryptoObjectId
              !== text(row, "crypto_object_id")
            || !acknowledgement.protectedMessageDigest.every(
              (value, index) => value === protectedDigest[index],
            )
            || !acknowledgement.ordinaryPayloadDigest.every(
              (value, index) => value === request.plaintextPayloadDigest[index],
            )
          ) return "conflict" as const;
          const digest = humanPeerLiveShadowAcknowledgementDigest(
            input.acknowledgementBytes,
          );
          try {
            const existing = await transaction.query(
              `SELECT acknowledgement_digest
                 FROM conversation_human_peer_shadow_acknowledgements
                WHERE operation_id = $1 AND committer_device_id = $2
                  AND committer_device_signing_key_generation = $3
                LIMIT 2`,
              [input.operationId, input.recipient.deviceId,
                input.recipient.deviceSigningKeyGeneration],
            );
            if (existing.length === 1) {
              const previous = bytes(existing[0]!, "acknowledgement_digest");
              try {
                return previous.every((value, index) => value === digest[index])
                  ? "replayed" as const
                  : "conflict" as const;
              } finally {
                previous.fill(0);
              }
            }
            await transaction.query(
              `INSERT INTO conversation_human_peer_shadow_acknowledgements (
                 operation_id, subject_human_id, committer_device_id,
                 committer_device_signing_key_generation,
                 host_authorization_revision, acknowledgement_digest,
                 status, reason, issued_at, deadline_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                       to_timestamp($9 / 1000.0), to_timestamp($10 / 1000.0))`,
              [input.operationId, input.recipient.subjectHumanId,
                input.recipient.deviceId,
                input.recipient.deviceSigningKeyGeneration,
                input.recipient.hostAuthorizationRevision, digest,
                acknowledgement.status, acknowledgement.reason,
                acknowledgement.issuedAt, acknowledgement.deadlineAt],
            );
            return "verified" as const;
          } finally {
            digest.fill(0);
          }
        } finally {
          requestBytes.fill(0);
          protectedDigest.fill(0);
          request.namespaceHeadDigest.fill(0);
          request.namespacePublicationDigest.fill(0);
          request.namespacePublicationSetDigest.fill(0);
          request.namespaceAudienceFingerprint.fill(0);
          request.planDigest.fill(0);
          request.plaintextPayloadDigest.fill(0);
          request.encryptedPayloadDigest.fill(0);
          request.manifestDigest.fill(0);
          request.envelopeDigest.fill(0);
          request.signature.fill(0);
        }
      }, { isolationLevel: "read committed" });
    } finally {
      acknowledgement.protectedMessageDigest.fill(0);
      acknowledgement.ordinaryPayloadDigest.fill(0);
      acknowledgement.signature.fill(0);
    }
  }

  async loadPublishedPlan(input: Readonly<{
    operationId: string;
    roomId: string;
  }>): Promise<Uint8Array | null> {
    const rows = await this.product.query(
      `SELECT plan_bytes
         FROM conversation_human_peer_shadow_operations
        WHERE operation_id = $1 AND room_id = $2::uuid
          AND state = 'published'
        LIMIT 2`,
      [input.operationId, input.roomId],
    );
    return rows.length === 1 ? bytes(rows[0]!, "plan_bytes") : null;
  }
}

export function createPostgresHumanPeerLiveShadowPlanner(input: Readonly<{
  product: PostgresJsBridgeConnection;
  restricted: PostgresJsBridgeConnection;
  serverId: string;
}>): PostgresHumanPeerLiveShadowPlanner {
  return new PostgresHumanPeerLiveShadowPlanner(
    input.product,
    input.restricted,
    undefined,
    input.serverId,
  );
}
