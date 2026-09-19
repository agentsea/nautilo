import { PROTECTED_TOP_LEVEL_ROOM_KINDS, isProtectedTopLevelRoomKind } from "../../message/protected-room-topology.ts";
import { createHash, randomUUID } from "node:crypto";

import {
  and,
  alias,
  asc,
  conversationSharedAgentShadowExecutionInputs,
  conversationSharedAgentShadowExecutions,
  conversationSharedAgentShadowInvocations,
  conversationSharedAgentShadowOperations,
  eq,
  gt,
  inArray,
  isNull,
  notExists,
  notInArray,
  sessionMessages,
  sessionMessageCryptoRevisions,
  sessions,
  sql,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  humanAiReadableLiveShadowExecutionInputSetDigest,
  humanAiReadableLiveShadowAcknowledgementDigest,
  sharedAgentLiveShadowAcknowledgementDigest,
  unixTimestamp,
  verifyHumanAiReadableLiveShadowAcknowledgement,
  verifySharedAgentLiveShadowAcknowledgement,
  decodeHumanAiReadableLiveShadowMessageRequest,
  decodeHumanAiReadableLiveShadowMessagePlan,
  encodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V1,
  HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V2,
} from "@nautilo/lattice-crypto/wire";

import { deriveLiveShadowMessageCryptoObjectIdV1 } from
  "../../message/conversation-repository.ts";
import { LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS } from
  "./live-shadow-foreground-policy.ts";
import {
  PostgresDomainKeyAuthorityRepository,
} from "../delivery/postgres-domain-key-authority.ts";
import {
  PostgresNamespaceProductAuthority,
  type SharedAgentNamespaceWriteAuthorityResult,
} from "../delivery/postgres-namespace-product-authority.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
} from "./postgres-conversation-product-store.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export type SharedAgentLiveShadowPlanResult =
  | Readonly<{ status: "disabled"; mode: "plaintext_only" }>
  | Readonly<{
      status: "ineligible";
      reason: "room_topology_unsupported";
    }>
  | Readonly<{
      status: "unavailable";
      authorizationScheme: "human_ai_readable_v1" | "human_ai_readable_v2";
      reason:
        | "policy_unavailable"
        | "device_unavailable"
        | "namespace_unavailable"
        | "recipient_sync_required"
        | "reservation_unavailable";
      requiredNamespaceIds?: readonly string[];
    }>
  | Readonly<{ status: "planned"; planBytes: Uint8Array;
      authorizationScheme?: "human_ai_readable_v2";
      representationMode?: "full_encryption" }>;

export interface SharedAgentLiveShadowPlanInput {
  readonly requestVersion?: 1 | 2;
  readonly authority: Readonly<{
    userId: string;
    humanActorId: string;
  }>;
  readonly roomId: string;
  readonly clientDeviceId: string;
  readonly idempotencyKey: string;
  readonly now: number;
}

export type ResolveSharedAgentReadableNamespaces = (
  input: Readonly<{
    humanActorId: string;
    roomId: string;
    agentId: string;
  }>,
) => Promise<readonly string[]>;

function canonicalReadableNamespaces(values: readonly string[]): readonly string[] {
  if (
    values.length < 1
    || values.length > 65_536
    || values.some((value) => !UUID.test(value))
  ) throw new TypeError("Shared-Agent readable Namespace set is invalid");
  const canonical = [...new Set(values)].sort();
  if (canonical.length !== values.length) {
    throw new TypeError("Shared-Agent readable Namespace set is duplicated");
  }
  return Object.freeze(canonical);
}

export type SharedAgentConductorResolution =
  | "awaiting_user"
  | "not_selected"
  | "unavailable";

export interface SharedAgentExecutionReservation {
  readonly executionId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly invokingHumanId: string;
  readonly invokingDeviceId: string;
  readonly clientActionSessionId: string;
  readonly policyRevision: number;
  readonly authorizationContent: string;
  readonly inputSetDigest: Uint8Array;
  readonly inputs: readonly Readonly<{
    operationId: string;
    messageId: number;
  }>[];
  readonly deadlineAt: number;
}

export interface SharedAgentRuntimeInvocationReservation {
  readonly invocationId: string;
  readonly roomId: string;
  readonly invokingHumanId: string;
  readonly invokingDeviceId: string;
  readonly clientActionSessionId: string;
  readonly policyRevision: number;
  readonly inputSetDigest: Uint8Array;
  readonly inputs: readonly Readonly<{
    operationId: string;
    messageId: number;
  }>[];
  readonly deadlineAt: number;
  readonly conductorAlreadyStarted?: boolean;
  readonly conductorAwaitingUser?: boolean;
}

export interface SharedAgentRuntimeInvocationExecutionAttachment {
  readonly invocationId: string;
  readonly executions: readonly Readonly<{
    executionId: string;
    sessionId: string;
    agentId: string;
  }>[];
}

export type RuntimeInvocationConductorClaimResult =
  | "claimed"
  | "already_running"
  | "terminal"
  | "conflict";

export type RuntimeInvocationConductorRoutePath =
  | "deterministic"
  | "floor_manager";

export type RuntimeInvocationConductorHistoryStatus =
  | "not_requested"
  | "verified";

export type RuntimeInvocationConductorOutcome =
  | "wake"
  | "ask_user"
  | "silent";

export type SharedAgentRuntimeResumeReservationResult =
  | Readonly<{
      status: "replayed";
      /** A terminal failed execution may be recovered only by a safer Cancel. */
      cancelRecovery: "available" | "unavailable";
    }>
  | Readonly<{
      status: "reserved";
      invocationId: string;
      executionId: string;
      roomId: string;
      agentId: string;
      invokingHumanId: string;
      sourceDeviceId: string;
      authorizationDeviceId: string;
      clientActionSessionId: string;
      policyRevision: number;
      deadlineAt: number;
    }>;

function deterministicResumeIds(coordinate: string): Readonly<{
  invocationId: string;
  executionId: string;
}> {
  const digest = createHash("sha256")
    .update("nautilo/runtime-foreground-resume/v1\0", "utf8")
    .update(coordinate, "utf8")
    .digest("hex");
  const uuidHex = `${digest.slice(0, 12)}4${digest.slice(13, 16)}a${
    digest.slice(17, 32)
  }`;
  return Object.freeze({
    invocationId: `resume:${digest}`,
    executionId: [
      uuidHex.slice(0, 8),
      uuidHex.slice(8, 12),
      uuidHex.slice(12, 16),
      uuidHex.slice(16, 20),
      uuidHex.slice(20, 32),
    ].join("-"),
  });
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

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function destroyAuthority(
  value: Extract<SharedAgentNamespaceWriteAuthorityResult, { status: "ready" }>,
): void {
  value.committerDeviceSigningPublicKey.fill(0);
  value.namespaceHeadDigest.fill(0);
  value.namespacePublicationDigest.fill(0);
  value.namespacePublicationSetDigest.fill(0);
  value.namespaceAudienceFingerprint.fill(0);
}

async function ensureHumanSession(
  product: PostgresJsBridgeConnection,
  input: SharedAgentLiveShadowPlanInput,
): Promise<Readonly<{
  sessionId: string;
  namespaceId: string;
  topLevelRoomId: string;
  representativeAgentId: string;
  policyRevision: number;
  representationMode?: "full_encryption";
}> | "disabled" | "policy_unavailable" | null> {
  const policy = await product.query(
    `/* m296_shared_agent_policy */
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
    `/* m296_shared_agent_session_room */
     SELECT source.graph_thread_id,
            source.namespace_id::text AS namespace_id,
            source.kind AS source_kind,
            source.parent_room_id::text AS source_parent_room_id,
            source.archived_at AS source_archived_at,
            authority.id::text AS top_level_room_id,
            authority.kind AS authority_kind,
            authority.parent_room_id AS authority_parent_room_id,
            authority.archived_at AS authority_archived_at,
            actor.owner_id::text AS owner_id
       FROM rooms source
       JOIN rooms authority
         ON authority.id = COALESCE(source.parent_room_id, source.id)
        AND authority.namespace_id = source.namespace_id
       JOIN actors actor ON actor.id = $2::uuid AND actor.kind = 'user'
      WHERE source.id = $1::uuid
      LIMIT 2`,
    [input.roomId, input.authority.humanActorId],
  );
  if (rooms.length !== 1) return null;
  const room = rooms[0]!;
  const topLevelRoomId = text(room, "top_level_room_id");
  const sourceParentRoomId = room["source_parent_room_id"];
  const sourceShapeCurrent = sourceParentRoomId === null
    ? isProtectedTopLevelRoomKind(text(room, "source_kind"))
    : text(room, "source_kind") === "subthread"
      && sourceParentRoomId === topLevelRoomId;
  if (
    !sourceShapeCurrent
    || room["source_archived_at"] !== null
    || !isProtectedTopLevelRoomKind(text(room, "authority_kind"))
    || room["authority_parent_room_id"] !== null
    || room["authority_archived_at"] !== null
    || text(room, "owner_id") !== input.authority.userId
  ) return null;
  const threadId = text(room, "graph_thread_id");
  const agentRows = await product.query(
    `/* m296_shared_agent_room_agent */
     SELECT actor.agent_id::text AS agent_id
       FROM room_members member
       JOIN actors actor ON actor.id = member.actor_id
      WHERE member.room_id = $1::uuid AND actor.kind = 'agent'
      ORDER BY actor.id`,
    [topLevelRoomId],
  );
  if (agentRows.length < 1) return null;
  const representativeAgentId = text(agentRows[0]!, "agent_id");
  await product.query(
    `/* m296_shared_agent_session_ensure */
     INSERT INTO sessions
       (thread_id, owner_id, persona_id, room_id, agent_id, channel)
     VALUES ($1, $2::uuid, 'owner', $3::uuid, $4::uuid, 'browser')
     ON CONFLICT (owner_id, thread_id) DO NOTHING`,
    [threadId, input.authority.userId, input.roomId, representativeAgentId],
  );
  const session = one(await product.query(
    `/* m296_shared_agent_session_read */
     SELECT id::text AS id, room_id::text AS room_id
       FROM sessions
      WHERE owner_id = $1::uuid AND thread_id = $2
      LIMIT 2`,
    [input.authority.userId, threadId],
  ), "Shared-Agent Session");
  if (text(session, "room_id") !== input.roomId) return null;
  return Object.freeze({
    sessionId: text(session, "id"),
    namespaceId: text(room, "namespace_id"),
    topLevelRoomId,
    representativeAgentId,
    policyRevision: number(policy[0]!, "revision"),
    ...(mode === "encrypted_only"
      ? { representationMode: "full_encryption" as const }
      : {}),
  });
}

async function recordUnavailablePlanAttempt(
  product: PostgresJsBridgeConnection,
  input: SharedAgentLiveShadowPlanInput,
  context: Readonly<{
    sessionId: string;
    policyRevision: number;
    reason:
      | "policy_unavailable"
      | "device_unavailable"
      | "namespace_unavailable"
      | "recipient_sync_required"
      | "reservation_unavailable";
  }>,
): Promise<void> {
  await product.transactionOnce(async (transaction) => {
    await transaction.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [context.sessionId, input.idempotencyKey],
    );
    await transaction.query(
      `/* m296_shared_agent_plan_attempt_unavailable */
       INSERT INTO conversation_shared_agent_shadow_plan_attempts (
         session_id, room_id, client_idempotency_key, policy_revision,
         subject_user_id, state, unavailable_reason)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, 'unavailable', $6)
       ON CONFLICT (session_id, client_idempotency_key) DO UPDATE
         SET policy_revision = excluded.policy_revision,
             subject_user_id = excluded.subject_user_id,
             state = 'unavailable',
             unavailable_reason = excluded.unavailable_reason,
             operation_id = NULL,
             updated_at = now()
       WHERE conversation_shared_agent_shadow_plan_attempts.state
         = 'unavailable'`,
      [context.sessionId, input.roomId, input.idempotencyKey,
        context.policyRevision, input.authority.userId, context.reason],
    );
  }, { isolationLevel: "read committed" });
}

export class PostgresSharedAgentLiveShadowPlanner {
  readonly #productAuthority: PostgresNamespaceProductAuthority;
  readonly #domainKeyRepository: PostgresDomainKeyAuthorityRepository;

  constructor(
    private readonly product: PostgresJsBridgeConnection,
    restricted: PostgresJsBridgeConnection,
    private readonly crypto = new LatticeCrypto(),
    private readonly resolveReadableNamespaces:
      ResolveSharedAgentReadableNamespaces | null = null,
    options: Readonly<{
      serverId: string;
    }>,
  ) {
    this.#productAuthority = new PostgresNamespaceProductAuthority(product);
    this.#domainKeyRepository = new PostgresDomainKeyAuthorityRepository(
      restricted,
      crypto,
      options.serverId,
    );
  }

  async plan(
    input: SharedAgentLiveShadowPlanInput,
  ): Promise<SharedAgentLiveShadowPlanResult> {
    const formatVersion = input.requestVersion ?? 1;
    if (formatVersion !== 1 && formatVersion !== 2) {
      throw new TypeError("Human AI-readable request version is unsupported");
    }
    const authorizationScheme = formatVersion === 2
      ? "human_ai_readable_v2" as const : "human_ai_readable_v1" as const;
    const versionMarker = formatVersion === 2
      ? { authorizationScheme: "human_ai_readable_v2" as const } : {};
    if (
      !UUID.test(input.authority.userId)
      || !UUID.test(input.authority.humanActorId)
      || !UUID.test(input.roomId)
      || !PORTABLE.test(input.clientDeviceId)
      || !PORTABLE.test(input.idempotencyKey)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Shared-Agent plan input is invalid");
    await this.reconcileExpired(input.now);
    const product = await ensureHumanSession(this.product, input);
    if (product === "disabled") {
      return Object.freeze({ status: "disabled", mode: "plaintext_only" });
    }
    if (product === "policy_unavailable") {
      return Object.freeze({
        status: "unavailable",
        authorizationScheme,
        reason: "policy_unavailable",
      });
    }
    if (product === null) {
      return Object.freeze({
        status: "ineligible",
        reason: "room_topology_unsupported",
      });
    }
    const inspected = await this.#productAuthority
      .withCurrentHumanAiReadableRoom({
        subjectUserId: input.authority.userId,
        subjectHumanId: input.authority.humanActorId,
        roomId: input.roomId,
        namespaceId: product.namespaceId,
        use: (authority) => this.#domainKeyRepository
          .inspectSharedAgentWriteAuthority({
            authority,
            deviceId: input.clientDeviceId,
          }),
      });
    if (inspected === null) {
      return Object.freeze({
        status: "ineligible",
        reason: "room_topology_unsupported",
      });
    }
    if (inspected.status === "unavailable") {
      await recordUnavailablePlanAttempt(this.product, input, {
        sessionId: product.sessionId,
        policyRevision: product.policyRevision,
        reason: inspected.reason,
      });
      return Object.freeze({
        status: "unavailable",
        authorizationScheme,
        reason: inspected.reason,
        ...(inspected.reason === "namespace_unavailable"
            || inspected.reason === "recipient_sync_required"
          ? { requiredNamespaceIds: [product.namespaceId] }
          : {}),
      });
    }
    try {
      if (this.resolveReadableNamespaces !== null) {
        let readableNamespaces: readonly string[];
        try {
          readableNamespaces = canonicalReadableNamespaces(
            await this.resolveReadableNamespaces({
              humanActorId: input.authority.humanActorId,
              roomId: product.topLevelRoomId,
              agentId: product.representativeAgentId,
            }),
          );
        } catch {
          await recordUnavailablePlanAttempt(this.product, input, {
            sessionId: product.sessionId,
            policyRevision: product.policyRevision,
            reason: "policy_unavailable",
          });
          return Object.freeze({
            status: "unavailable" as const,
            authorizationScheme,
            reason: "policy_unavailable" as const,
          });
        }
        if (!readableNamespaces.includes(product.namespaceId)) {
          await recordUnavailablePlanAttempt(this.product, input, {
            sessionId: product.sessionId,
            policyRevision: product.policyRevision,
            reason: "policy_unavailable",
          });
          return Object.freeze({
            status: "unavailable" as const,
            authorizationScheme,
            reason: "policy_unavailable" as const,
          });
        }
        const commonReadinessInput = {
          subjectUserId: input.authority.userId,
          subjectHumanId: input.authority.humanActorId,
          sourceRoomId: product.topLevelRoomId,
          namespaceIds: readableNamespaces,
        } as const;
        const domainReadiness = await this.#productAuthority
          .withCurrentReadableNamespaceSet({
              ...commonReadinessInput,
              use: (authorities) => this.#domainKeyRepository
                .inspectForegroundAuthority({
                  namespaceIds: authorities.map((entry) => entry.namespaceId),
                  keyClass: "ai",
                  subjectHumanId: input.authority.humanActorId,
                  deviceId: input.clientDeviceId,
                }),
            });
        if (domainReadiness === null) {
          await recordUnavailablePlanAttempt(this.product, input, {
            sessionId: product.sessionId,
            policyRevision: product.policyRevision,
            reason: "reservation_unavailable",
          });
          return Object.freeze({
            status: "unavailable" as const,
            authorizationScheme,
            reason: "reservation_unavailable" as const,
          });
        }
        if (domainReadiness.status !== "ready") {
          const candidateRequiredNamespaceIds =
            "requiredNamespaceIds" in domainReadiness
              ? domainReadiness.requiredNamespaceIds
              : null;
          const requiredNamespaceIds: readonly string[] =
            Array.isArray(candidateRequiredNamespaceIds)
              && candidateRequiredNamespaceIds.every((value) =>
                typeof value === "string"
              )
              ? candidateRequiredNamespaceIds
              : readableNamespaces;
          const reason = domainReadiness.reason === "device_unavailable"
            ? "device_unavailable" as const
            : domainReadiness.reason === "recipient_sync_required"
            ? "recipient_sync_required" as const
            : requiredNamespaceIds.length > 0
            ? "namespace_unavailable" as const
            : "reservation_unavailable" as const;
          await recordUnavailablePlanAttempt(this.product, input, {
            sessionId: product.sessionId,
            policyRevision: product.policyRevision,
            reason,
          });
          return Object.freeze({
            status: "unavailable" as const,
            authorizationScheme,
            reason,
            ...(reason === "namespace_unavailable"
                || reason === "recipient_sync_required"
              ? {
                  requiredNamespaceIds:
                    requiredNamespaceIds,
                }
              : {}),
          });
        }
        for (const domain of domainReadiness.domains) {
          domain.participantDigest.fill(0);
          domain.headDigest.fill(0);
          domain.activeNamespaceBindingSetDigest.fill(0);
        }
      }
      return await this.product.transactionOnce(async (transaction) => {
        await transaction.query(
          `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
          [product.sessionId, input.idempotencyKey],
        );
        const existing = await transaction.query(
          `/* m296_shared_agent_plan_replay */
           SELECT operation.plan_bytes, operation.deadline_at,
                  attempt.policy_revision
             FROM conversation_shared_agent_shadow_plan_attempts attempt
             JOIN conversation_shared_agent_shadow_operations operation
               ON operation.operation_id = attempt.operation_id
            WHERE attempt.session_id = $1::uuid
              AND attempt.client_idempotency_key = $2
              AND attempt.state = 'planned'
            LIMIT 2`,
          [product.sessionId, input.idempotencyKey],
        );
        if (existing.length === 1) {
          let sameVersion = false;
          try {
            const storedPlan = decodeHumanAiReadableLiveShadowMessagePlan(
              bytes(existing[0]!, "plan_bytes"),
            );
            sameVersion = storedPlan.formatVersion === formatVersion;
            storedPlan.namespaceHeadDigest.fill(0);
            storedPlan.namespacePublicationDigest.fill(0);
            storedPlan.namespacePublicationSetDigest.fill(0);
            storedPlan.namespaceAudienceFingerprint.fill(0);
          } catch {
            // Retained bytes never change protocol under an idempotency key.
          }
          if (!sameVersion || dateMillis(existing[0]!, "deadline_at") <= input.now
            || number(existing[0]!, "policy_revision") !== product.policyRevision) {
            return Object.freeze({
              status: "unavailable" as const,
              authorizationScheme,
              reason: "reservation_unavailable" as const,
            });
          }
          return Object.freeze({
            status: "planned" as const,
            ...versionMarker,
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
          one(messageRows, "Shared-Agent Message reservation"),
          "message_id",
        );
        if (messageId < 1) throw new Error("Shared-Agent Message ID is invalid");
        const operationId = randomUUID();
        const attemptCoordinate = randomUUID();
        const createdAt = input.now;
        const deadlineAt = input.now + (formatVersion === 2
          ? HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V2
          : HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V1);
        const transcriptOrdinal = 1;
        const cryptoObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
          operationId,
          sessionId: product.sessionId,
          messageId,
          revision: 0,
          transcriptOrdinal,
          authorRole: "user",
        });
        const planBytes = encodeHumanAiReadableLiveShadowMessagePlan({
          formatVersion,
          purpose: "message.human_ai_readable_live_shadow_plan",
          operationId,
          clientIdempotencyKey: input.idempotencyKey,
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
          keyClass: "ai",
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
            `/* m296_shared_agent_operation_insert */
             INSERT INTO conversation_shared_agent_shadow_operations (
               operation_id, client_idempotency_key, policy_revision,
               session_id, room_id, human_message_id,
               human_message_created_at, transcript_ordinal,
               subject_human_id, committer_device_id,
               committer_device_signing_key_generation,
               host_authorization_revision, namespace_id,
               namespace_access_revision, namespace_key_generation,
               namespace_head_digest, namespace_publication_digest,
               namespace_publication_set_digest,
               namespace_audience_fingerprint, participant_human_count,
               protected_participant_human_count,
               plaintext_participant_human_count,
               protected_recipient_device_count, crypto_object_id,
               attempt_coordinate, plan_digest, plan_bytes, state,
               deadline_at)
             VALUES (
               $1, $2, $3, $4::uuid, $5::uuid, $6,
               to_timestamp($7 / 1000.0), $8, $9, $10, $11, $12,
               $13::uuid, $14, $15, $16, $17, $18, $19, $20, $21, $22,
               $23, $24, $25, $26, $27, 'planned',
               to_timestamp($28 / 1000.0))`,
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
              inspected.namespaceAudienceFingerprint,
              inspected.participantHumanCount,
              inspected.protectedParticipantHumanCount,
              inspected.plaintextParticipantHumanCount,
              inspected.protectedRecipientDeviceCount,
              cryptoObjectId, attemptCoordinate, planDigest, planBytes,
              deadlineAt,
            ],
          );
          const attempt = await transaction.query(
            `/* m296_shared_agent_plan_attempt_insert */
             INSERT INTO conversation_shared_agent_shadow_plan_attempts (
               session_id, room_id, client_idempotency_key, policy_revision,
               subject_user_id, state, operation_id)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, 'planned', $6)
             ON CONFLICT (session_id, client_idempotency_key) DO UPDATE
               SET policy_revision = excluded.policy_revision,
                   subject_user_id = excluded.subject_user_id,
                   state = 'planned', unavailable_reason = NULL,
                   operation_id = excluded.operation_id,
                   updated_at = now()
             WHERE conversation_shared_agent_shadow_plan_attempts.state
               = 'unavailable'
             RETURNING sequence`,
            [product.sessionId, input.roomId, input.idempotencyKey,
              product.policyRevision, input.authority.userId, operationId],
          );
          if (attempt.length !== 1) {
            throw new TypeError("Shared-Agent plan attempt insert failed");
          }
          return Object.freeze({ status: "planned" as const, planBytes,
            ...versionMarker,
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
    ) throw new TypeError("Shared-Agent publication receipt is invalid");
    return this.product.transactionOnce(async (transaction) => {
      const rows = await transaction.query(
        `/* m296_shared_agent_publish_lock */
         SELECT human_message_id, state, protected_message_digest,
                final_event_digest
           FROM conversation_shared_agent_shadow_operations
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
        `/* m296_shared_agent_publish */
         UPDATE conversation_shared_agent_shadow_operations
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
    ) throw new TypeError("Shared-Agent fallback receipt is invalid");
    return this.product.transactionOnce(async (transaction) => {
      const rows = await transaction.query(
        `/* m296_shared_agent_fallback_lock */
         SELECT state, terminal_stage, terminal_reason
           FROM conversation_shared_agent_shadow_operations
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
        `/* m296_shared_agent_fallback */
         UPDATE conversation_shared_agent_shadow_operations
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
      acknowledgement = verifyHumanAiReadableLiveShadowAcknowledgement(
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
          `/* m296_shared_agent_ack_lock */
           SELECT operation.session_id::text AS session_id,
                  operation.room_id::text AS room_id,
                  operation.human_message_id, operation.transcript_ordinal,
                  operation.crypto_object_id, operation.client_idempotency_key,
                  operation.policy_revision, operation.protected_message_digest,
                  operation.human_request_bytes, operation.state
             FROM conversation_shared_agent_shadow_operations operation
            WHERE operation.operation_id = $1
            FOR UPDATE`,
          [input.operationId],
        );
        if (rows.length !== 1) return "conflict" as const;
        const row = rows[0]!;
        const requestBytes = bytes(row, "human_request_bytes");
        const protectedDigest = bytes(row, "protected_message_digest");
        const request = decodeHumanAiReadableLiveShadowMessageRequest(
          requestBytes,
        );
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
          const digest = humanAiReadableLiveShadowAcknowledgementDigest(
            input.acknowledgementBytes,
          );
          try {
            const existing = await transaction.query(
              `SELECT acknowledgement_digest
                 FROM conversation_shared_agent_shadow_acknowledgements
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
              `INSERT INTO conversation_shared_agent_shadow_acknowledgements (
                 operation_id, operation_kind, message_id, edit_revision,
                 author_role, subject_human_id, committer_device_id,
                 committer_device_signing_key_generation,
                 host_authorization_revision, acknowledgement_digest,
                 status, reason, issued_at, deadline_at)
               VALUES ($1, 'human_message', $2, 0, 'user', $3, $4, $5,
                       $6, $7, $8, $9,
                       to_timestamp($10 / 1000.0), to_timestamp($11 / 1000.0))`,
              [input.operationId, acknowledgement.messageId,
                input.recipient.subjectHumanId,
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
         FROM conversation_shared_agent_shadow_operations
        WHERE operation_id = $1 AND room_id = $2::uuid
          AND state = 'published'
        LIMIT 2`,
      [input.operationId, input.roomId],
    );
    return rows.length === 1 ? bytes(rows[0]!, "plan_bytes") : null;
  }

  /**
   * Resolve the no-execution side of the Conductor lifecycle. `awaiting_user`
   * is deliberately resumable; silent and unavailable outcomes are terminal.
   */
  async recordConductorResolution(input: Readonly<{
    operationIds: readonly string[];
    roomId: string;
    subjectHumanId: string;
    state: SharedAgentConductorResolution;
    reason: string;
    now: number;
  }>): Promise<"recorded" | "replayed" | "conflict"> {
    if (
      input.operationIds.length < 1
      || input.operationIds.length > 256
      || new Set(input.operationIds).size !== input.operationIds.length
      || input.operationIds.some((value) => !PORTABLE.test(value))
      || !UUID.test(input.roomId)
      || !PORTABLE.test(input.subjectHumanId)
      || !PORTABLE.test(input.reason)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Shared-Agent Conductor resolution is invalid");
    return this.product.transactionOnce(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [input.roomId, input.subjectHumanId],
      );
      const rows = await transaction.query(
        `/* m296_shared_agent_conductor_lock */
         SELECT operation_id, conductor_state, conductor_reason
           FROM conversation_shared_agent_shadow_operations
          WHERE operation_id = ANY($1::text[])
            AND room_id = $2::uuid AND subject_human_id = $3
            AND state = 'published'
          FOR UPDATE`,
        [input.operationIds, input.roomId, input.subjectHumanId],
      );
      if (rows.length !== input.operationIds.length) return "conflict" as const;
      const byId = new Map(rows.map((row) => [text(row, "operation_id"), row]));
      const ordered = input.operationIds.map((id) => byId.get(id));
      if (ordered.some((row) => row === undefined)) return "conflict" as const;
      if (ordered.every((row) =>
        text(row!, "conductor_state") === input.state
        && text(row!, "conductor_reason") === input.reason
      )) return "replayed" as const;
      const allowed = input.state === "awaiting_user"
        ? new Set(["pending", "awaiting_user"])
        : new Set(["pending", "awaiting_user"]);
      if (ordered.some((row) => !allowed.has(text(row!, "conductor_state")))) {
        return "conflict" as const;
      }
      const updated = await transaction.query(
        `/* m296_shared_agent_conductor_resolve */
         UPDATE conversation_shared_agent_shadow_operations
            SET conductor_state = $2, conductor_reason = $3,
                conductor_resolved_at = to_timestamp($4 / 1000.0),
                updated_at = to_timestamp($4 / 1000.0)
          WHERE operation_id = ANY($1::text[])
            AND conductor_state = ANY($5::text[])
        RETURNING operation_id`,
        [input.operationIds, input.state, input.reason, input.now,
          [...allowed]],
      );
      return updated.length === input.operationIds.length
        ? "recorded" as const
        : "conflict" as const;
    }, { isolationLevel: "read committed" });
  }

  /**
   * Reserve a fresh protected execution for a Human-driven foreground resume.
   * The original device remains the immutable source of the retained Human
   * input set; the current approving device owns only the new Runtime grant.
   */
  async reserveRuntimeResume(input: Readonly<{
    roomId: string;
    subjectUserId: string;
    subjectHumanId: string;
    agentId: string;
    agentThreadId: string;
    clientActionSessionId: string;
    authorizationDeviceId: string;
    resumeCoordinate: string;
    now: number;
  }>): Promise<SharedAgentRuntimeResumeReservationResult | null> {
    if (
      !UUID.test(input.roomId)
      || !UUID.test(input.subjectUserId)
      || !PORTABLE.test(input.subjectHumanId)
      || !UUID.test(input.agentId)
      || !PORTABLE.test(input.agentThreadId)
      || !PORTABLE.test(input.clientActionSessionId)
      || !PORTABLE.test(input.authorizationDeviceId)
      || !PORTABLE.test(input.resumeCoordinate)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Shared-Agent Runtime resume is invalid");
    const ids = deterministicResumeIds([
      input.roomId,
      input.subjectUserId,
      input.subjectHumanId,
      input.agentId,
      input.agentThreadId,
      input.resumeCoordinate,
    ].join("\0"));
    return this.product.transactionOnce(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [input.roomId, ids.invocationId],
      );
      const existing = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          invocation_id: conversationSharedAgentShadowInvocations.invocationId,
        }).from(conversationSharedAgentShadowInvocations).where(eq(
          conversationSharedAgentShadowInvocations.invocationId,
          ids.invocationId,
        )).limit(2),
      );
      if (existing.length === 1) {
        const prior = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({
            state: conversationSharedAgentShadowExecutions.state,
          }).from(conversationSharedAgentShadowExecutions).where(eq(
            conversationSharedAgentShadowExecutions.executionId,
            ids.executionId,
          )).limit(2),
        );
        return Object.freeze({
          status: "replayed" as const,
          cancelRecovery: prior.length === 1
            && (prior[0]!.state === "fallback" || prior[0]!.state === "failed")
            ? "available" as const
            : "unavailable" as const,
        });
      }
      if (existing.length > 1) return null;

      const candidates = await transaction.query(
        `/* m298_runtime_resume_source */
         WITH authority_room AS (
           SELECT authority.id
             FROM rooms source
             JOIN rooms authority
               ON authority.id = COALESCE(source.parent_room_id, source.id)
              AND authority.namespace_id = source.namespace_id
            WHERE source.id = $1::uuid
              AND source.archived_at IS NULL
              AND authority.archived_at IS NULL
              AND authority.parent_room_id IS NULL
              AND authority.kind IN (${PROTECTED_TOP_LEVEL_ROOM_KINDS.map((kind) => `'${kind}'`).join(", ")})
              AND ((source.parent_room_id IS NULL
                    AND source.kind IN (${PROTECTED_TOP_LEVEL_ROOM_KINDS.map((kind) => `'${kind}'`).join(", ")}))
                OR (source.parent_room_id = authority.id
                    AND source.kind = 'subthread'))
         )
         SELECT session.id::text AS session_id,
                prior.execution_id AS prior_execution_id,
                prior.policy_revision,
                prior.invoking_device_id,
                prior.input_count, prior.input_set_digest
           FROM sessions session
           JOIN authority_room ON true
           JOIN room_members member
             ON member.room_id = authority_room.id
           JOIN actors actor
             ON actor.id = member.actor_id
            AND actor.kind = 'agent'
            AND actor.agent_id = $4::uuid
           JOIN LATERAL (
             SELECT execution_id, policy_revision, invoking_device_id,
                    input_count, input_set_digest
               FROM conversation_shared_agent_shadow_executions
              WHERE session_id = session.id
                AND room_id = $1::uuid
                AND agent_id = $4::uuid
                AND invoking_human_id = $3
                AND execution_kind = 'turn'
              ORDER BY sequence DESC LIMIT 1
           ) prior ON true
          WHERE session.owner_id = $2::uuid
            AND session.thread_id = $5
            AND session.room_id = $1::uuid
            AND session.agent_id = $4::uuid
          LIMIT 2`,
        [input.roomId, input.subjectUserId, input.subjectHumanId,
          input.agentId, input.agentThreadId],
      );
      if (candidates.length !== 1) return null;
      const source = candidates[0]!;
      const inputs = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          input_ordinal:
            conversationSharedAgentShadowExecutionInputs.inputOrdinal,
          human_operation_id:
            conversationSharedAgentShadowExecutionInputs.humanOperationId,
          message_id: conversationSharedAgentShadowExecutionInputs.messageId,
        }).from(conversationSharedAgentShadowExecutionInputs).where(eq(
          conversationSharedAgentShadowExecutionInputs.executionId,
          text(source, "prior_execution_id"),
        )).orderBy(asc(
          conversationSharedAgentShadowExecutionInputs.inputOrdinal,
        )),
      );
      const inputCount = number(source, "input_count");
      if (
        inputs.length !== inputCount
        || inputs.some((row, index) =>
          number(row, "input_ordinal") !== index + 1
        )
      ) return null;
      const sourceDeviceId = text(source, "invoking_device_id");
      const policyRevision = number(source, "policy_revision");
      const inputSetDigest = bytes(source, "input_set_digest");
      // Resume reserves new authority; it never extends the prior execution.
      const deadlineAt = input.now + LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS;
      try {
        const insertedInvocation = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb
            .insert(conversationSharedAgentShadowInvocations)
            .values({
              invocationId: ids.invocationId,
              policyRevision,
              sessionId: text(source, "session_id"),
              roomId: input.roomId,
              invokingHumanId: input.subjectHumanId,
              invokingDeviceId: sourceDeviceId,
              authorizationDeviceId: input.authorizationDeviceId,
              clientActionSessionId: input.clientActionSessionId,
              inputCount,
              inputSetDigest,
              deadlineAt: new Date(deadlineAt),
            })
            .onConflictDoNothing({
              target: conversationSharedAgentShadowInvocations.invocationId,
            })
            .returning({
              invocation_id:
                conversationSharedAgentShadowInvocations.invocationId,
            }),
        );
        if (insertedInvocation.length !== 1) {
          const prior = await executeTypedConversationProductQuery(
            transaction,
            conversationProductTypedDb.select({
              state: conversationSharedAgentShadowExecutions.state,
            }).from(conversationSharedAgentShadowExecutions).where(eq(
              conversationSharedAgentShadowExecutions.executionId,
              ids.executionId,
            )).limit(2),
          );
          return Object.freeze({
            status: "replayed" as const,
            cancelRecovery: prior.length === 1
              && (prior[0]!.state === "fallback" || prior[0]!.state === "failed")
              ? "available" as const
              : "unavailable" as const,
          });
        }
        const insertedExecution = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb
            .insert(conversationSharedAgentShadowExecutions)
            .values({
              executionId: ids.executionId,
              invocationId: ids.invocationId,
              sessionId: text(source, "session_id"),
              roomId: input.roomId,
              agentId: input.agentId,
              invokingHumanId: input.subjectHumanId,
              invokingDeviceId: sourceDeviceId,
              authorizationDeviceId: input.authorizationDeviceId,
              clientActionSessionId: input.clientActionSessionId,
              executionKind: "resume",
              policyRevision,
              inputCount,
              inputSetDigest,
              deadlineAt: new Date(deadlineAt),
            })
            .returning({
              execution_id:
                conversationSharedAgentShadowExecutions.executionId,
            }),
        );
        if (insertedExecution.length !== 1) {
          throw new TypeError("Runtime resume execution insert failed");
        }
        for (const row of inputs) {
          await executeTypedConversationProductQuery(
            transaction,
            conversationProductTypedDb
              .insert(conversationSharedAgentShadowExecutionInputs)
              .values({
                executionId: ids.executionId,
                inputOrdinal: number(row, "input_ordinal"),
                humanOperationId: text(row, "human_operation_id"),
                messageId: number(row, "message_id"),
              }),
          );
        }
        return Object.freeze({
          status: "reserved" as const,
          invocationId: ids.invocationId,
          executionId: ids.executionId,
          roomId: input.roomId,
          agentId: input.agentId,
          invokingHumanId: input.subjectHumanId,
          sourceDeviceId,
          authorizationDeviceId: input.authorizationDeviceId,
          clientActionSessionId: input.clientActionSessionId,
          policyRevision,
          deadlineAt,
        });
      } finally {
        inputSetDigest.fill(0);
      }
    }, { isolationLevel: "serializable" });
  }

  /** Reserve one Agent-free Runtime authorization before Conductor routing. */
  async reserveRuntimeInvocation(input: Readonly<{
    operationIds: readonly string[];
    roomId: string;
    subjectHumanId: string;
    clientActionSessionId: string;
    purpose?: "agent" | "conductor";
    now: number;
  }>): Promise<SharedAgentRuntimeInvocationReservation | null> {
    if (
      input.operationIds.length < 1
      || input.operationIds.length > 256
      || new Set(input.operationIds).size !== input.operationIds.length
      || input.operationIds.some((value) => !PORTABLE.test(value))
      || !UUID.test(input.roomId)
      || !PORTABLE.test(input.subjectHumanId)
      || !PORTABLE.test(input.clientActionSessionId)
      || (input.purpose !== undefined
        && input.purpose !== "agent"
        && input.purpose !== "conductor")
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Shared-Agent Runtime invocation is invalid");
    return this.product.transactionOnce(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [input.roomId, input.subjectHumanId],
      );
      const rows = await transaction.query(
        `/* m298_runtime_invocation_input_lock */
         SELECT operation.operation_id, operation.human_message_id,
                operation.room_id::text AS room_id,
                operation.session_id::text AS session_id,
                operation.agent_id::text AS agent_id,
                operation.subject_human_id, operation.committer_device_id,
                operation.conductor_state,
                operation.state, policy_revision
           FROM conversation_shared_agent_shadow_operations operation
          WHERE operation_id = ANY($1::text[])
          FOR UPDATE`,
        [input.operationIds],
      );
      if (rows.length !== input.operationIds.length) return null;
      const byId = new Map(rows.map((row) => [text(row, "operation_id"), row]));
      const orderedRows = input.operationIds.map((id) => byId.get(id));
      if (
        orderedRows.some((row) => row === undefined)
        || orderedRows.some((row) =>
          text(row!, "state") !== "published"
          || text(row!, "room_id") !== input.roomId
          || row!["agent_id"] !== null
          || text(row!, "subject_human_id") !== input.subjectHumanId
          || !["pending", "awaiting_user"].includes(
            text(row!, "conductor_state"),
          )
        )
      ) return null;
      const invokingDeviceId = text(
        orderedRows[orderedRows.length - 1]!,
        "committer_device_id",
      );
      const policyRevision = number(orderedRows[0]!, "policy_revision");
      const humanSessionId = text(orderedRows[0]!, "session_id");
      if (orderedRows.some((row) =>
        text(row!, "committer_device_id") !== invokingDeviceId
        || number(row!, "policy_revision") !== policyRevision
        || text(row!, "session_id") !== humanSessionId
      )) return null;
      const inputs = Object.freeze(orderedRows.map((row) => Object.freeze({
        operationId: text(row!, "operation_id"),
        messageId: number(row!, "human_message_id"),
      })));
      const inputSetDigest = humanAiReadableLiveShadowExecutionInputSetDigest(
        this.crypto,
        inputs,
      );
      const conductorInvocation = input.purpose === "conductor";
      try {
        const existing = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({
            invocation_id:
              conversationSharedAgentShadowInvocations.invocationId,
            deadline_at:
              conversationSharedAgentShadowInvocations.deadlineAt,
            terminal_reason:
              conversationSharedAgentShadowInvocations.terminalReason,
            state: conversationSharedAgentShadowInvocations.state,
            sequence: conversationSharedAgentShadowInvocations.sequence,
          }).from(conversationSharedAgentShadowInvocations).where(and(
            eq(
              conversationSharedAgentShadowInvocations.policyRevision,
              policyRevision,
            ),
            eq(
              conversationSharedAgentShadowInvocations.sessionId,
              humanSessionId,
            ),
            eq(
              conversationSharedAgentShadowInvocations.roomId,
              input.roomId,
            ),
            eq(
              conversationSharedAgentShadowInvocations.invokingHumanId,
              input.subjectHumanId,
            ),
            eq(
              conversationSharedAgentShadowInvocations.invokingDeviceId,
              invokingDeviceId,
            ),
            eq(
              conversationSharedAgentShadowInvocations.clientActionSessionId,
              input.clientActionSessionId,
            ),
            eq(
              conversationSharedAgentShadowInvocations.inputCount,
              inputs.length,
            ),
            eq(
              conversationSharedAgentShadowInvocations.inputSetDigest,
              inputSetDigest,
            ),
            conductorInvocation
              ? sql`${conversationSharedAgentShadowInvocations.terminalReason}
                  like 'conductor_%'`
              : and(
                  inArray(
                    conversationSharedAgentShadowInvocations.state,
                    ["awaiting_authorization", "authorized", "running"],
                  ),
                  isNull(
                    conversationSharedAgentShadowInvocations.terminalReason,
                  ),
                ),
          )).for("update"),
        );
        const replay = conductorInvocation
          ? [...existing].sort((left, right) =>
              number(right, "sequence") - number(left, "sequence")
            )[0]
          : existing.find((row) =>
              dateMillis(row, "deadline_at") > input.now
            );
        if (replay !== undefined) {
          const terminalReason = replay["terminal_reason"];
          return Object.freeze({
            invocationId: text(replay, "invocation_id"),
            roomId: input.roomId,
            invokingHumanId: input.subjectHumanId,
            invokingDeviceId,
            clientActionSessionId: input.clientActionSessionId,
            policyRevision,
            inputSetDigest: inputSetDigest.slice(),
            inputs,
            deadlineAt: dateMillis(replay, "deadline_at"),
            ...(conductorInvocation
                && !["awaiting_authorization", "authorized"].includes(
                  text(replay, "state"),
                )
              ? { conductorAlreadyStarted: true }
              : {}),
            ...(conductorInvocation
                && typeof terminalReason === "string"
                && terminalReason.startsWith("conductor_verified_")
                && terminalReason.endsWith("_ask_user")
              ? { conductorAwaitingUser: true }
              : {}),
          });
        }
        const invocationId = randomUUID();
        // Human publication already succeeded. Its submission proof expiry is
        // not the budget for Conductor/context/model work in this invocation.
        // Actual signed grant expiry remains a separate, potentially earlier fence.
        const deadlineAt = input.now + LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS;
        const insertedInvocation = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb
            .insert(conversationSharedAgentShadowInvocations)
            .values({
              invocationId,
              policyRevision,
              sessionId: humanSessionId,
              roomId: input.roomId,
              invokingHumanId: input.subjectHumanId,
              invokingDeviceId,
              authorizationDeviceId: invokingDeviceId,
              clientActionSessionId: input.clientActionSessionId,
              inputCount: inputs.length,
              inputSetDigest,
              ...(conductorInvocation
                ? { terminalReason: "conductor_pending" }
                : {}),
              deadlineAt: new Date(deadlineAt),
            })
            .returning({
              invocation_id:
                conversationSharedAgentShadowInvocations.invocationId,
            }),
        );
        if (insertedInvocation.length !== 1) {
          throw new TypeError("Runtime invocation insert failed");
        }
        return Object.freeze({
          invocationId,
          roomId: input.roomId,
          invokingHumanId: input.subjectHumanId,
          invokingDeviceId,
          clientActionSessionId: input.clientActionSessionId,
          policyRevision,
          inputSetDigest: inputSetDigest.slice(),
          inputs,
          deadlineAt,
        });
      } finally {
        inputSetDigest.fill(0);
      }
    }, { isolationLevel: "serializable" });
  }

  /**
   * Claim the one-shot Conductor callback before any protected content is
   * opened. A retained `running` row is deliberately not replayable: after a
   * process loss we prefer an honest indeterminate attempt over a duplicate
   * Floor Manager call or duplicate routing side effect.
   */
  async claimRuntimeInvocationConductor(input: Readonly<{
    invocationId: string;
    roomId: string;
    subjectHumanId: string;
    now: number;
  }>): Promise<RuntimeInvocationConductorClaimResult> {
    if (
      !PORTABLE.test(input.invocationId)
      || !UUID.test(input.roomId)
      || !PORTABLE.test(input.subjectHumanId)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Runtime Conductor claim is invalid");
    return this.product.transactionOnce(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [input.roomId, input.subjectHumanId],
      );
      const claimed = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb
          .update(conversationSharedAgentShadowInvocations)
          .set({ state: "running", updatedAt: new Date(input.now) })
          .where(and(
            eq(
              conversationSharedAgentShadowInvocations.invocationId,
              input.invocationId,
            ),
            eq(conversationSharedAgentShadowInvocations.roomId, input.roomId),
            eq(
              conversationSharedAgentShadowInvocations.invokingHumanId,
              input.subjectHumanId,
            ),
            eq(conversationSharedAgentShadowInvocations.state, "authorized"),
            eq(
              conversationSharedAgentShadowInvocations.terminalReason,
              "conductor_pending",
            ),
            gt(
              conversationSharedAgentShadowInvocations.deadlineAt,
              new Date(input.now),
            ),
          ))
          .returning({
            invocation_id:
              conversationSharedAgentShadowInvocations.invocationId,
          }),
      );
      if (claimed.length === 1) return "claimed" as const;
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          state: conversationSharedAgentShadowInvocations.state,
        }).from(conversationSharedAgentShadowInvocations).where(and(
          eq(
            conversationSharedAgentShadowInvocations.invocationId,
            input.invocationId,
          ),
          eq(conversationSharedAgentShadowInvocations.roomId, input.roomId),
          eq(
            conversationSharedAgentShadowInvocations.invokingHumanId,
            input.subjectHumanId,
          ),
        )).limit(2).for("update"),
      );
      if (rows.length !== 1) return "conflict" as const;
      const state = text(rows[0]!, "state");
      if (state === "running") return "already_running" as const;
      if (["completed", "fallback", "failed"].includes(state)) {
        return "terminal" as const;
      }
      return "conflict" as const;
    }, { isolationLevel: "serializable" });
  }

  /** Record the content-free protected routing result before product effects. */
  async recordRuntimeInvocationConductorOutcome(input: Readonly<{
    invocationId: string;
    roomId: string;
    subjectHumanId: string;
    routePath: RuntimeInvocationConductorRoutePath;
    historyStatus: RuntimeInvocationConductorHistoryStatus;
    outcome: RuntimeInvocationConductorOutcome;
    now: number;
  }>): Promise<"recorded" | "replayed" | "conflict"> {
    if (
      !PORTABLE.test(input.invocationId)
      || !UUID.test(input.roomId)
      || !PORTABLE.test(input.subjectHumanId)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Runtime Conductor outcome is invalid");
    const evidence = [
      "conductor_verified",
      input.routePath,
      `history_${input.historyStatus}`,
      input.outcome,
    ].join("_");
    const terminal = input.outcome === "silent";
    const updated = await executeTypedConversationProductQuery(
      this.product,
      conversationProductTypedDb
        .update(conversationSharedAgentShadowInvocations)
        .set({
          state: terminal ? "completed" : "running",
          terminalReason: evidence,
          ...(terminal ? { terminalAt: new Date(input.now) } : {}),
          updatedAt: new Date(input.now),
        })
        .where(and(
          eq(
            conversationSharedAgentShadowInvocations.invocationId,
            input.invocationId,
          ),
          eq(conversationSharedAgentShadowInvocations.roomId, input.roomId),
          eq(
            conversationSharedAgentShadowInvocations.invokingHumanId,
            input.subjectHumanId,
          ),
          eq(conversationSharedAgentShadowInvocations.state, "running"),
          eq(
            conversationSharedAgentShadowInvocations.terminalReason,
            "conductor_pending",
          ),
        ))
        .returning({
          invocation_id:
            conversationSharedAgentShadowInvocations.invocationId,
        }),
    );
    if (updated.length === 1) return "recorded";
    const replay = await executeTypedConversationProductQuery(
      this.product,
      conversationProductTypedDb.select({
        state: conversationSharedAgentShadowInvocations.state,
        terminal_reason:
          conversationSharedAgentShadowInvocations.terminalReason,
      }).from(conversationSharedAgentShadowInvocations).where(and(
        eq(
          conversationSharedAgentShadowInvocations.invocationId,
          input.invocationId,
        ),
        eq(conversationSharedAgentShadowInvocations.roomId, input.roomId),
        eq(
          conversationSharedAgentShadowInvocations.invokingHumanId,
          input.subjectHumanId,
        ),
      )).limit(2),
    );
    return replay.length === 1
      && text(replay[0]!, "state") === (terminal ? "completed" : "running")
      && replay[0]!["terminal_reason"] === evidence
      ? "replayed"
      : "conflict";
  }

  /** Close a protected Conductor leg before the ordinary Shadow fallback. */
  async recordRuntimeInvocationConductorFallback(input: Readonly<{
    invocationId: string;
    roomId: string;
    subjectHumanId: string;
    stage: string;
    reason: string;
    now: number;
  }>): Promise<"recorded" | "replayed" | "conflict"> {
    if (
      !PORTABLE.test(input.invocationId)
      || !UUID.test(input.roomId)
      || !PORTABLE.test(input.subjectHumanId)
      || !PORTABLE.test(input.stage)
      || !PORTABLE.test(input.reason)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Runtime Conductor fallback is invalid");
    const evidence = `conductor_fallback_${input.stage}_${input.reason}`;
    const updated = await executeTypedConversationProductQuery(
      this.product,
      conversationProductTypedDb
        .update(conversationSharedAgentShadowInvocations)
        .set({
          state: "fallback",
          terminalReason: evidence,
          terminalAt: new Date(input.now),
          updatedAt: new Date(input.now),
        })
        .where(and(
          eq(
            conversationSharedAgentShadowInvocations.invocationId,
            input.invocationId,
          ),
          eq(conversationSharedAgentShadowInvocations.roomId, input.roomId),
          eq(
            conversationSharedAgentShadowInvocations.invokingHumanId,
            input.subjectHumanId,
          ),
          inArray(
            conversationSharedAgentShadowInvocations.state,
            ["awaiting_authorization", "authorized", "running"],
          ),
        ))
        .returning({
          invocation_id:
            conversationSharedAgentShadowInvocations.invocationId,
        }),
    );
    if (updated.length === 1) return "recorded";
    const replay = await executeTypedConversationProductQuery(
      this.product,
      conversationProductTypedDb.select({
        state: conversationSharedAgentShadowInvocations.state,
        terminal_reason:
          conversationSharedAgentShadowInvocations.terminalReason,
      }).from(conversationSharedAgentShadowInvocations).where(eq(
        conversationSharedAgentShadowInvocations.invocationId,
        input.invocationId,
      )).limit(2),
    );
    return replay.length === 1
      && text(replay[0]!, "state") === "fallback"
      && replay[0]!["terminal_reason"] === evidence
      ? "replayed"
      : "conflict";
  }

  /**
   * Attach the exact Agents selected by Conductor to an already-authorized
   * Runtime invocation. Agent identity begins here; the invocation and its
   * ordered Human input set remain Agent-free.
   */
  async attachRuntimeInvocationExecutions(input: Readonly<{
    invocationId: string;
    operationIds: readonly string[];
    roomId: string;
    subjectUserId: string;
    subjectHumanId: string;
    agents: readonly Readonly<{
      agentId: string;
      agentThreadId: string;
      expectedResponseMode?: "active" | "mention_only" | "observe" | null;
    }>[];
    now: number;
  }>): Promise<SharedAgentRuntimeInvocationExecutionAttachment | null> {
    if (
      !PORTABLE.test(input.invocationId)
      || input.operationIds.length < 1
      || input.operationIds.length > 256
      || new Set(input.operationIds).size !== input.operationIds.length
      || input.operationIds.some((value) => !PORTABLE.test(value))
      || !UUID.test(input.roomId)
      || !UUID.test(input.subjectUserId)
      || !PORTABLE.test(input.subjectHumanId)
      || input.agents.length < 1
      || new Set(input.agents.map((value) => value.agentId)).size
        !== input.agents.length
      || input.agents.some((value) =>
        !UUID.test(value.agentId)
        || !PORTABLE.test(value.agentThreadId)
        || (Object.hasOwn(value, "expectedResponseMode")
          && value.expectedResponseMode !== null
          && !["active", "mention_only", "observe"].includes(
            value.expectedResponseMode ?? "",
          ))
      )
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Runtime invocation attachment is invalid");
    return this.product.transactionOnce(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [input.roomId, input.subjectHumanId],
      );
      const currentAgents = await transaction.query(
        `/* m299_runtime_invocation_agent_membership */
         WITH authority_room AS (
           SELECT authority.id
             FROM rooms source
             JOIN rooms authority
               ON authority.id = COALESCE(source.parent_room_id, source.id)
              AND authority.namespace_id = source.namespace_id
            WHERE source.id = $1::uuid
              AND source.archived_at IS NULL
              AND authority.archived_at IS NULL
              AND authority.parent_room_id IS NULL
              AND authority.kind IN (${PROTECTED_TOP_LEVEL_ROOM_KINDS.map((kind) => `'${kind}'`).join(", ")})
              AND ((source.parent_room_id IS NULL
                    AND source.kind IN (${PROTECTED_TOP_LEVEL_ROOM_KINDS.map((kind) => `'${kind}'`).join(", ")}))
                OR (source.parent_room_id = authority.id
                    AND source.kind = 'subthread'))
         )
         SELECT DISTINCT actor.agent_id::text AS agent_id,
                         member.agent_response_mode
           FROM authority_room
           JOIN room_members member ON member.room_id = authority_room.id
           JOIN actors actor ON actor.id = member.actor_id
          WHERE actor.kind = 'agent'
            AND actor.agent_id = ANY($2::uuid[])`,
        [input.roomId, input.agents.map((entry) => entry.agentId)],
      );
      const currentAgentIds = new Set(
        currentAgents.map((row) => text(row, "agent_id")),
      );
      const currentResponseModeByAgent = new Map(
        currentAgents.map((row) => [
          text(row, "agent_id"),
          row["agent_response_mode"] === null
            ? null
            : text(row, "agent_response_mode"),
        ]),
      );
      if (
        currentAgentIds.size !== input.agents.length
        || input.agents.some((entry) => !currentAgentIds.has(entry.agentId))
        || input.agents.some((entry) =>
          Object.hasOwn(entry, "expectedResponseMode")
          && currentResponseModeByAgent.get(entry.agentId)
            !== entry.expectedResponseMode
        )
      ) return null;

      const invocations = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          invocation_id: conversationSharedAgentShadowInvocations.invocationId,
          policy_revision:
            conversationSharedAgentShadowInvocations.policyRevision,
          room_id: conversationSharedAgentShadowInvocations.roomId,
          invoking_human_id:
            conversationSharedAgentShadowInvocations.invokingHumanId,
          invoking_device_id:
            conversationSharedAgentShadowInvocations.invokingDeviceId,
          client_action_session_id:
            conversationSharedAgentShadowInvocations.clientActionSessionId,
          input_count: conversationSharedAgentShadowInvocations.inputCount,
          input_set_digest:
            conversationSharedAgentShadowInvocations.inputSetDigest,
          state: conversationSharedAgentShadowInvocations.state,
          deadline_at: conversationSharedAgentShadowInvocations.deadlineAt,
        }).from(conversationSharedAgentShadowInvocations).where(and(
          eq(
            conversationSharedAgentShadowInvocations.invocationId,
            input.invocationId,
          ),
          eq(conversationSharedAgentShadowInvocations.roomId, input.roomId),
          eq(
            conversationSharedAgentShadowInvocations.invokingHumanId,
            input.subjectHumanId,
          ),
        )).limit(2).for("update"),
      );
      if (invocations.length !== 1) return null;
      const invocation = invocations[0]!;
      if (
        !["authorized", "running"].includes(text(invocation, "state"))
        || dateMillis(invocation, "deadline_at") <= input.now
      ) return null;

      const rows = await transaction.query(
        `/* m299_runtime_invocation_attachment_inputs */
         SELECT operation.operation_id, operation.human_message_id,
                operation.room_id::text AS room_id,
                operation.session_id::text AS session_id,
                operation.agent_id::text AS agent_id,
                operation.subject_human_id, operation.committer_device_id,
                operation.conductor_state, operation.state, policy_revision
           FROM conversation_shared_agent_shadow_operations operation
          WHERE operation.operation_id = ANY($1::text[])
          FOR UPDATE`,
        [input.operationIds],
      );
      if (rows.length !== input.operationIds.length) return null;
      const byId = new Map(rows.map((row) => [text(row, "operation_id"), row]));
      const orderedRows = input.operationIds.map((id) => byId.get(id));
      if (
        orderedRows.some((row) => row === undefined)
        || orderedRows.some((row) =>
          text(row!, "state") !== "published"
          || text(row!, "room_id") !== input.roomId
          || row!["agent_id"] !== null
          || text(row!, "subject_human_id") !== input.subjectHumanId
          || !["pending", "awaiting_user", "selected"].includes(
            text(row!, "conductor_state"),
          )
        )
      ) return null;
      const inputs = Object.freeze(orderedRows.map((row) => Object.freeze({
        operationId: text(row!, "operation_id"),
        messageId: number(row!, "human_message_id"),
      })));
      const digest = humanAiReadableLiveShadowExecutionInputSetDigest(
        this.crypto,
        inputs,
      );
      const storedDigest = bytes(invocation, "input_set_digest");
      try {
        if (
          !equal(digest, storedDigest)
          || number(invocation, "input_count") !== inputs.length
          || number(invocation, "policy_revision")
            !== number(orderedRows[0]!, "policy_revision")
          || text(invocation, "invoking_device_id")
            !== text(orderedRows[orderedRows.length - 1]!, "committer_device_id")
        ) return null;

        const existing = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({
            execution_id:
              conversationSharedAgentShadowExecutions.executionId,
            session_id: conversationSharedAgentShadowExecutions.sessionId,
            agent_id: conversationSharedAgentShadowExecutions.agentId,
          }).from(conversationSharedAgentShadowExecutions).where(eq(
            conversationSharedAgentShadowExecutions.invocationId,
            input.invocationId,
          )),
        );
        if (existing.length > 0) {
          const expected = new Set(input.agents.map((agent) => agent.agentId));
          if (
            existing.length !== expected.size
            || existing.some((row) => !expected.has(text(row, "agent_id")))
          ) return null;
          return Object.freeze({
            invocationId: input.invocationId,
            executions: Object.freeze(existing.map((row) => Object.freeze({
              executionId: text(row, "execution_id"),
              sessionId: text(row, "session_id"),
              agentId: text(row, "agent_id"),
            }))),
          });
        }

        const executions: Array<Readonly<{
          executionId: string;
          sessionId: string;
          agentId: string;
        }>> = [];
        for (const agent of input.agents) {
          await executeTypedConversationProductQuery(
            transaction,
            conversationProductTypedDb.insert(sessions).values({
              threadId: agent.agentThreadId,
              ownerId: input.subjectUserId,
              agentId: agent.agentId,
              roomId: input.roomId,
              channel: "browser",
            }).onConflictDoNothing({
              target: [sessions.ownerId, sessions.threadId],
            }),
          );
          const session = one(await executeTypedConversationProductQuery(
            transaction,
            conversationProductTypedDb.select({
              id: sessions.id,
              room_id: sessions.roomId,
              agent_id: sessions.agentId,
            }).from(sessions).where(and(
              eq(sessions.ownerId, input.subjectUserId),
              eq(sessions.threadId, agent.agentThreadId),
            )).limit(2),
          ), "Runtime Agent execution Session");
          if (
            text(session, "room_id") !== input.roomId
            || text(session, "agent_id") !== agent.agentId
          ) return null;
          const executionId = randomUUID();
          const inserted = await executeTypedConversationProductQuery(
            transaction,
            conversationProductTypedDb
              .insert(conversationSharedAgentShadowExecutions)
              .values({
                executionId,
                invocationId: input.invocationId,
                sessionId: text(session, "id"),
                roomId: input.roomId,
                agentId: agent.agentId,
                invokingHumanId: input.subjectHumanId,
                invokingDeviceId: text(invocation, "invoking_device_id"),
                authorizationDeviceId:
                  text(invocation, "invoking_device_id"),
                clientActionSessionId:
                  text(invocation, "client_action_session_id"),
                policyRevision: number(invocation, "policy_revision"),
                inputCount: inputs.length,
                inputSetDigest: digest,
                deadlineAt: new Date(dateMillis(invocation, "deadline_at")),
              })
              .returning({
                execution_id:
                  conversationSharedAgentShadowExecutions.executionId,
              }),
          );
          if (inserted.length !== 1) {
            throw new TypeError("Runtime Agent execution insert failed");
          }
          for (let index = 0; index < inputs.length; index += 1) {
            const operation = inputs[index]!;
            await executeTypedConversationProductQuery(
              transaction,
              conversationProductTypedDb
                .insert(conversationSharedAgentShadowExecutionInputs)
                .values({
                  executionId,
                  inputOrdinal: index + 1,
                  humanOperationId: operation.operationId,
                  messageId: operation.messageId,
                }),
            );
          }
          executions.push(Object.freeze({
            executionId,
            sessionId: text(session, "id"),
            agentId: agent.agentId,
          }));
        }
        const selected = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb
            .update(conversationSharedAgentShadowOperations)
            .set({
              conductorState: "selected",
              conductorReason: "agent_selected",
              conductorResolvedAt: new Date(input.now),
              updatedAt: new Date(input.now),
            })
            .where(and(
              inArray(
                conversationSharedAgentShadowOperations.operationId,
                input.operationIds,
              ),
              inArray(
                conversationSharedAgentShadowOperations.conductorState,
                ["pending", "awaiting_user"],
              ),
            ))
            .returning({
              operation_id:
                conversationSharedAgentShadowOperations.operationId,
            }),
        );
        if (selected.length !== inputs.length) {
          throw new TypeError("Runtime invocation selection conflicted");
        }
        return Object.freeze({
          invocationId: input.invocationId,
          executions: Object.freeze(executions),
        });
      } finally {
        digest.fill(0);
        storedDigest.fill(0);
      }
    }, { isolationLevel: "serializable" });
  }

  /**
   * Bind one actual Agent wake to the exact ordered protected Human inputs.
   * The selected Agent Session is created/read with the ordinary per-bot
   * thread identity; no Browser or crypto secret crosses this transaction.
   */
  async reserveExecution(input: Readonly<{
    operationIds: readonly string[];
    roomId: string;
    subjectUserId: string;
    subjectHumanId: string;
    agentId: string;
    agentThreadId: string;
    clientActionSessionId: string;
    now: number;
  }>): Promise<SharedAgentExecutionReservation | null> {
    if (
      input.operationIds.length < 1
      || input.operationIds.length > 256
      || new Set(input.operationIds).size !== input.operationIds.length
      || input.operationIds.some((value) => !PORTABLE.test(value))
      || !UUID.test(input.roomId)
      || !UUID.test(input.subjectUserId)
      || !PORTABLE.test(input.subjectHumanId)
      || !UUID.test(input.agentId)
      || !PORTABLE.test(input.agentThreadId)
      || !PORTABLE.test(input.clientActionSessionId)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Shared-Agent execution reservation is invalid");
    return this.product.transactionOnce(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [input.roomId, input.subjectHumanId],
      );
      const rows = await transaction.query(
        `/* m296_shared_agent_execution_input_lock */
         SELECT operation_id, human_message_id, room_id::text AS room_id,
                agent_id::text AS agent_id, subject_human_id,
                committer_device_id, conductor_state, operation.state,
                policy_revision, message.content AS human_content
           FROM conversation_shared_agent_shadow_operations operation
           JOIN session_messages message
             ON message.id = operation.human_message_id
          WHERE operation_id = ANY($1::text[])
          FOR UPDATE`,
        [input.operationIds],
      );
      if (rows.length !== input.operationIds.length) return null;
      const byId = new Map(rows.map((row) => [text(row, "operation_id"), row]));
      const orderedRows = input.operationIds.map((id) => byId.get(id));
      if (
        orderedRows.some((row) => row === undefined)
        || orderedRows.some((row) =>
          text(row!, "state") !== "published"
          || text(row!, "room_id") !== input.roomId
          || text(row!, "agent_id") !== input.agentId
          || text(row!, "subject_human_id") !== input.subjectHumanId
          || !["pending", "awaiting_user"].includes(
            text(row!, "conductor_state"),
          )
        )
      ) return null;
      const invokingDeviceId = text(
        orderedRows[orderedRows.length - 1]!,
        "committer_device_id",
      );
      if (orderedRows.some((row) =>
        text(row!, "committer_device_id") !== invokingDeviceId
      )) return null;
      const policyRevision = number(orderedRows[0]!, "policy_revision");
      if (orderedRows.some((row) =>
        number(row!, "policy_revision") !== policyRevision
      )) return null;
      await transaction.query(
        `/* m296_shared_agent_execution_session_ensure */
         INSERT INTO sessions
           (thread_id, owner_id, agent_id, room_id, channel)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'browser')
         ON CONFLICT (owner_id, thread_id) DO NOTHING`,
        [input.agentThreadId, input.subjectUserId, input.agentId, input.roomId],
      );
      const session = one(await transaction.query(
        `/* m296_shared_agent_execution_session_read */
         SELECT id::text AS id, room_id::text AS room_id,
                agent_id::text AS agent_id
           FROM sessions
          WHERE owner_id = $1::uuid AND thread_id = $2
          LIMIT 2`,
        [input.subjectUserId, input.agentThreadId],
      ), "Shared-Agent execution Session");
      if (
        text(session, "room_id") !== input.roomId
        || text(session, "agent_id") !== input.agentId
      ) return null;
      const inputs = Object.freeze(orderedRows.map((row) => Object.freeze({
        operationId: text(row!, "operation_id"),
        messageId: number(row!, "human_message_id"),
      })));
      const inputSetDigest = humanAiReadableLiveShadowExecutionInputSetDigest(
        this.crypto,
        inputs,
      );
      const executionId = randomUUID();
      const deadlineAt = input.now + 30_000;
      try {
        const inserted = await transaction.query(
          `/* m296_shared_agent_execution_insert */
           INSERT INTO conversation_shared_agent_shadow_executions (
             execution_id, session_id, room_id, agent_id,
             invoking_human_id, invoking_device_id, authorization_device_id,
             client_action_session_id,
             policy_revision, input_count, input_set_digest, deadline_at)
           VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $6, $7, $8, $9,
                   $10, to_timestamp($11 / 1000.0))
           RETURNING execution_id`,
          [executionId, text(session, "id"), input.roomId, input.agentId,
            input.subjectHumanId, invokingDeviceId,
            input.clientActionSessionId, policyRevision, inputs.length,
            inputSetDigest, deadlineAt],
        );
        if (inserted.length !== 1) {
          throw new TypeError("Shared-Agent execution insert failed");
        }
        for (let index = 0; index < inputs.length; index += 1) {
          const operation = inputs[index]!;
          await transaction.query(
            `/* m296_shared_agent_execution_input_insert */
             INSERT INTO conversation_shared_agent_shadow_execution_inputs (
               execution_id, input_ordinal, human_operation_id, message_id)
             VALUES ($1, $2, $3, $4)`,
            [executionId, index + 1, operation.operationId,
              operation.messageId],
          );
        }
        const selected = await transaction.query(
          `/* m296_shared_agent_conductor_selected */
           UPDATE conversation_shared_agent_shadow_operations
              SET conductor_state = 'selected',
                  conductor_reason = 'agent_selected',
                  conductor_resolved_at = to_timestamp($2 / 1000.0),
                  updated_at = to_timestamp($2 / 1000.0)
            WHERE operation_id = ANY($1::text[])
              AND conductor_state IN ('pending', 'awaiting_user')
          RETURNING operation_id`,
          [input.operationIds, input.now],
        );
        if (selected.length !== inputs.length) {
          throw new TypeError("Shared-Agent selection transition conflicted");
        }
        return Object.freeze({
          executionId,
          sessionId: text(session, "id"),
          roomId: input.roomId,
          agentId: input.agentId,
          invokingHumanId: input.subjectHumanId,
          invokingDeviceId,
          clientActionSessionId: input.clientActionSessionId,
          policyRevision,
          authorizationContent: text(
            orderedRows[orderedRows.length - 1]!,
            "human_content",
          ),
          inputSetDigest: inputSetDigest.slice(),
          inputs,
          deadlineAt,
        });
      } finally {
        inputSetDigest.fill(0);
      }
    }, { isolationLevel: "serializable" });
  }

  /** Close unpublished reservations after their execution has lost authority. */
  private async quarantineExecutionReservations(
    connection: PostgresJsBridgeExecutor,
    executionIds: readonly string[],
    now: number,
  ): Promise<void> {
    if (executionIds.length === 0) return;
    await executeTypedConversationProductQuery(connection,
      conversationProductTypedDb.update(sessionMessageCryptoRevisions).set({
        disposition: "quarantined",
        failureCode: "authorization_unavailable",
        nextAttemptAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        quarantineLeaseToken: null,
        updatedAt: new Date(now),
      }).where(and(
        inArray(sessionMessageCryptoRevisions.sharedAgentShadowExecutionId,
          conversationProductTypedDb.select({ executionId: conversationSharedAgentShadowExecutions.executionId })
            .from(conversationSharedAgentShadowExecutions).where(and(
              inArray(conversationSharedAgentShadowExecutions.executionId, executionIds),
              inArray(conversationSharedAgentShadowExecutions.state, ["fallback", "failed"]),
            )),
        ),
        eq(sessionMessageCryptoRevisions.disposition, "active"),
        isNull(sessionMessageCryptoRevisions.shadowDurableEventDigest),
      )),
    );
  }

  async recordExecutionUnavailable(input: Readonly<{
    executionId: string;
    reason: string;
    now: number;
  }>): Promise<"recorded" | "replayed" | "conflict"> {
    if (
      !PORTABLE.test(input.executionId)
      || !PORTABLE.test(input.reason)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Shared-Agent execution outcome is invalid");
    const rows = await this.product.query(
      `/* m296_shared_agent_execution_unavailable */
       UPDATE conversation_shared_agent_shadow_executions
          SET state = 'fallback', terminal_reason = $2,
              terminal_at = to_timestamp($3 / 1000.0),
              updated_at = to_timestamp($3 / 1000.0)
        WHERE execution_id = $1
          AND state IN ('awaiting_authorization', 'authorized', 'running')
      RETURNING execution_id`,
      [input.executionId, input.reason, input.now],
    );
    if (rows.length === 1) {
      const sourceExecution = alias(
        conversationSharedAgentShadowExecutions,
        "source_execution",
      );
      const unfinishedChild = alias(
        conversationSharedAgentShadowExecutions,
        "unfinished_child",
      );
      const sourceInvocation = conversationProductTypedDb.select({
        invocation_id: sourceExecution.invocationId,
      }).from(sourceExecution).where(eq(
        sourceExecution.executionId,
        input.executionId,
      )).limit(1);
      await executeTypedConversationProductQuery(
        this.product,
        conversationProductTypedDb
          .update(conversationSharedAgentShadowInvocations)
          .set({
            state: sql`case
              when ${conversationSharedAgentShadowInvocations.state}
                = 'awaiting_authorization'
              then 'fallback'
              else 'completed'
            end`,
            terminalReason: sql`case
              when ${conversationSharedAgentShadowInvocations.state}
                = 'awaiting_authorization'
              then 'authorization_unavailable'
              else ${conversationSharedAgentShadowInvocations.terminalReason}
            end`,
            terminalAt: new Date(input.now),
            updatedAt: new Date(input.now),
          })
          .where(and(
            eq(
              conversationSharedAgentShadowInvocations.invocationId,
              sourceInvocation,
            ),
            inArray(
              conversationSharedAgentShadowInvocations.state,
              ["awaiting_authorization", "authorized", "running"],
            ),
            notExists(
              conversationProductTypedDb.select({
                execution_id: unfinishedChild.executionId,
              }).from(unfinishedChild).where(and(
                eq(
                  unfinishedChild.invocationId,
                  conversationSharedAgentShadowInvocations.invocationId,
                ),
                notInArray(
                  unfinishedChild.state,
                  ["completed", "fallback", "failed"],
                ),
              )),
            ),
          )),
      );
      await this.quarantineExecutionReservations(this.product, [input.executionId], input.now);
      return "recorded";
    }
    const existing = await this.product.query(
      `SELECT state, terminal_reason
         FROM conversation_shared_agent_shadow_executions
        WHERE execution_id = $1 LIMIT 2`,
      [input.executionId],
    );
    if (existing.length === 1
      && text(existing[0]!, "state") === "fallback"
      && text(existing[0]!, "terminal_reason") === input.reason) {
      await this.quarantineExecutionReservations(this.product, [input.executionId], input.now);
      return "replayed";
    }
    return "conflict";
  }

  /**
   * Lazily close expired Human writes, unresolved Conductor outcomes, and
   * Agent executions. Recovery records facts only; it never recreates a lost
   * Browser authorization or starts Agent work after a process restart.
   */
  async reconcileExpired(now: number, maximum = 64): Promise<number> {
    if (
      !Number.isSafeInteger(now)
      || now < 0
      || !Number.isSafeInteger(maximum)
      || maximum < 1
      || maximum > 256
    ) throw new TypeError("Shared-Agent reconciliation bounds are invalid");
    const reconciled = await this.product.transactionOnce(async (transaction) => {
      const operations = await transaction.query(
        `/* m296_shared_agent_reconcile_expired_operations */
         WITH due AS (
           SELECT operation_id, state
             FROM conversation_shared_agent_shadow_operations
            WHERE deadline_at <= $1
              AND (
                state IN ('planned', 'human_verified')
                OR (state = 'published'
                  AND conductor_state IN ('pending', 'awaiting_user'))
              )
            ORDER BY deadline_at, sequence
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE conversation_shared_agent_shadow_operations AS operation
            SET state = CASE
                  WHEN due.state IN ('planned', 'human_verified')
                    THEN 'failed'
                  ELSE operation.state
                END,
                terminal_stage = CASE
                  WHEN due.state = 'planned' THEN 'human_admission'
                  WHEN due.state = 'human_verified' THEN 'realtime_publication'
                  ELSE operation.terminal_stage
                END,
                terminal_reason = CASE
                  WHEN due.state IN ('planned', 'human_verified')
                    THEN 'deadline_expired'
                  ELSE operation.terminal_reason
                END,
                terminal_at = CASE
                  WHEN due.state IN ('planned', 'human_verified') THEN $1
                  ELSE operation.terminal_at
                END,
                conductor_state = CASE
                  WHEN due.state = 'published' THEN 'unavailable'
                  ELSE operation.conductor_state
                END,
                conductor_reason = CASE
                  WHEN due.state = 'published' THEN 'deadline_expired'
                  ELSE operation.conductor_reason
                END,
                conductor_resolved_at = CASE
                  WHEN due.state = 'published' THEN $1
                  ELSE operation.conductor_resolved_at
                END,
                reconciliation_attempt_count = LEAST(
                  operation.reconciliation_attempt_count + 1,
                  8
                ),
                updated_at = $1
           FROM due
          WHERE operation.operation_id = due.operation_id
        RETURNING operation.operation_id`,
        [new Date(now), maximum],
      );
      const remaining = maximum - operations.length;
      if (remaining < 1) return { count: operations.length, executionIds: [] as string[] };
      const executions = await transaction.query(
        `/* m296_shared_agent_reconcile_expired_executions */
         WITH due AS (
           SELECT execution_id
             FROM conversation_shared_agent_shadow_executions
            WHERE state IN ('awaiting_authorization', 'authorized', 'running')
              AND deadline_at <= $1
            ORDER BY deadline_at, sequence
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE conversation_shared_agent_shadow_executions AS execution
            SET state = 'failed', terminal_reason = 'deadline_expired',
                terminal_at = $1, updated_at = $1
           FROM due
          WHERE execution.execution_id = due.execution_id
        RETURNING execution.execution_id`,
        [new Date(now), remaining],
      );
      const executionIds = executions.map((row) => text(row, "execution_id"));
      const invocationLimit = remaining - executions.length;
      if (invocationLimit < 1) return { count: operations.length + executions.length, executionIds };
      const invocations = await transaction.query(
        `/* m298_runtime_invocation_reconcile_expired */
         WITH due AS (
           SELECT invocation_id
             FROM conversation_shared_agent_shadow_invocations
            WHERE state IN ('awaiting_authorization', 'authorized', 'running')
              AND deadline_at <= $1
            ORDER BY deadline_at, sequence
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE conversation_shared_agent_shadow_invocations AS invocation
            SET state = 'failed', terminal_reason = 'deadline_expired',
                terminal_at = $1, updated_at = $1
           FROM due
          WHERE invocation.invocation_id = due.invocation_id
        RETURNING invocation.invocation_id`,
        [new Date(now), invocationLimit],
      );
      return { count: operations.length + executions.length + invocations.length, executionIds };
    }, { isolationLevel: "read committed" });
    // Publication takes lifecycle before parent locks. Release terminal parent
    // locks before quarantining their unpublished reservations in that order.
    await this.quarantineExecutionReservations(this.product, reconciled.executionIds, now);
    return reconciled.count;
  }

  /** Close only exact process-owned executions during deliberate shutdown. */
  async recordProcessLoss(
    executionIds: readonly string[],
    now: number,
  ): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("Shared-Agent shutdown time is invalid");
    }
    const unique = [...new Set(executionIds)];
    if (unique.length === 0) return 0;
    if (unique.length > 1_280) {
      throw new RangeError("Shared-Agent shutdown execution set is unbounded");
    }
    if (unique.some((executionId) => !PORTABLE.test(executionId))) {
      throw new TypeError("Shared-Agent shutdown execution ID is invalid");
    }
    const rows = await this.product.query(
      `/* m296_shared_agent_process_loss */
       UPDATE conversation_shared_agent_shadow_executions
          SET state = 'failed', terminal_reason = 'process_lost',
              terminal_at = $2, updated_at = $2
        WHERE execution_id = ANY($1::text[])
          AND state IN ('awaiting_authorization', 'authorized', 'running')
      RETURNING execution_id`,
      [unique, new Date(now)],
    );
    await this.quarantineExecutionReservations(
      this.product, unique, now,
    );
    await this.product.query(
      `/* m298_runtime_invocation_process_loss */
       UPDATE conversation_shared_agent_shadow_invocations invocation
          SET state = 'failed', terminal_reason = 'process_lost',
              terminal_at = $2, updated_at = $2
        WHERE invocation_id IN (
          SELECT DISTINCT execution.invocation_id
            FROM conversation_shared_agent_shadow_executions execution
           WHERE execution.execution_id = ANY($1::text[])
             AND execution.invocation_id IS NOT NULL
        )
          AND state IN ('awaiting_authorization', 'authorized', 'running')`,
      [unique, new Date(now)],
    );
    return rows.length;
  }

  /**
   * A resume publishes new Agent output, but does not create a Human turn.
   * Recover its causal pair from the retained, digest-bound input set without
   * reopening content or borrowing the latest message in the Room.
   */
  async loadResumeCausalHumanTurnId(input: Readonly<{
    executionId: string;
    sessionId: string;
    roomId: string;
    agentId: string;
    subjectHumanId: string;
    subjectUserId: string;
    policyRevision: number;
  }>): Promise<string | null> {
    const execution = conversationSharedAgentShadowExecutions;
    const invocation = conversationSharedAgentShadowInvocations;
    const selected = conversationSharedAgentShadowExecutionInputs;
    const operation = conversationSharedAgentShadowOperations;
    const sourceSession = alias(sessions, "causal_human_session");
    try {
      const rows = await executeTypedConversationProductQuery(
        this.product,
        conversationProductTypedDb.select({
          operation_id: sql<string>`${selected.humanOperationId}`.as("operation_id"),
          message_id: selected.messageId,
          input_ordinal: selected.inputOrdinal,
          human_turn_id: sessionMessages.humanTurnId,
          input_count: execution.inputCount,
          input_set_digest: execution.inputSetDigest,
          invocation_input_count: sql<number>`${invocation.inputCount}`.as("invocation_input_count"),
          invocation_input_set_digest: sql<Uint8Array>`${invocation.inputSetDigest}`.as("invocation_input_set_digest"),
        }).from(execution)
          .innerJoin(invocation, and(
            eq(invocation.invocationId, execution.invocationId),
            eq(invocation.sessionId, execution.sessionId),
            eq(invocation.roomId, execution.roomId),
            eq(invocation.invokingHumanId, execution.invokingHumanId),
            eq(invocation.invokingDeviceId, execution.invokingDeviceId),
            eq(invocation.policyRevision, execution.policyRevision),
            inArray(invocation.state, ["authorized", "running"]),
          ))
          .innerJoin(sessions, and(
            eq(sessions.id, execution.sessionId),
            eq(sessions.ownerId, input.subjectUserId),
            eq(sessions.roomId, input.roomId),
            eq(sessions.agentId, input.agentId),
          ))
          .innerJoin(selected, eq(selected.executionId, execution.executionId))
          .innerJoin(operation, and(
            eq(operation.operationId, selected.humanOperationId),
            eq(operation.humanMessageId, selected.messageId),
            eq(operation.roomId, input.roomId),
            eq(operation.subjectHumanId, input.subjectHumanId),
            eq(operation.committerDeviceId, execution.invokingDeviceId),
            eq(operation.policyRevision, execution.policyRevision),
            eq(operation.state, "published"),
            eq(operation.conductorState, "selected"),
          ))
          .innerJoin(sessionMessages, and(
            eq(sessionMessages.id, selected.messageId),
            eq(sessionMessages.sessionId, operation.sessionId),
            eq(sessionMessages.humanTurnId, selected.humanOperationId),
            eq(sessionMessages.role, "user"),
            eq(sessionMessages.transcriptOrigin, "main"),
          ))
          .innerJoin(sourceSession, and(
            eq(sourceSession.id, sessionMessages.sessionId),
            eq(sourceSession.ownerId, input.subjectUserId),
            eq(sourceSession.roomId, input.roomId),
          ))
          .where(and(
            eq(execution.executionId, input.executionId),
            eq(execution.executionKind, "resume"),
            eq(execution.sessionId, input.sessionId),
            eq(execution.roomId, input.roomId),
            eq(execution.agentId, input.agentId),
            eq(execution.invokingHumanId, input.subjectHumanId),
            eq(execution.policyRevision, input.policyRevision),
            inArray(execution.state, ["authorized", "running"]),
          )).orderBy(asc(selected.inputOrdinal)),
      );
      if (rows.length === 0 || rows.some((row, index) =>
        number(row, "input_count") !== rows.length
        || number(row, "invocation_input_count") !== rows.length
        || number(row, "input_ordinal") !== index + 1
        || text(row, "human_turn_id") !== text(row, "operation_id")
      )) return null;
      const digest = humanAiReadableLiveShadowExecutionInputSetDigest(
        this.crypto,
        rows.map((row) => ({
          operationId: text(row, "operation_id"),
          messageId: number(row, "message_id"),
          inputOrdinal: number(row, "input_ordinal"),
        })),
      );
      try {
        if (rows.some((row) =>
          !equal(bytes(row, "input_set_digest"), digest)
          || !equal(bytes(row, "invocation_input_set_digest"), digest)
        )) return null;
        return text(rows[rows.length - 1]!, "human_turn_id");
      } finally {
        digest.fill(0);
      }
    } catch {
      return null;
    }
  }

  async loadExecutionPlan(input: Readonly<{
    executionId: string;
    roomId: string;
    allowAwaitingAuthorization?: true;
  }>): Promise<Uint8Array | null> {
    if (!PORTABLE.test(input.executionId) || !UUID.test(input.roomId)) {
      throw new TypeError("Shared-Agent execution plan lookup is invalid");
    }
    const rows = await this.product.query(
      `/* m296_shared_agent_execution_plan_read */
       SELECT plan_bytes
         FROM conversation_shared_agent_shadow_executions
        WHERE execution_id = $1 AND room_id = $2::uuid
          AND (state IN ('authorized', 'running', 'completed')
            OR ($3::boolean AND state = 'awaiting_authorization'))
        LIMIT 2`,
      [input.executionId, input.roomId,
        input.allowAwaitingAuthorization === true],
    );
    return rows.length === 1 ? bytes(rows[0]!, "plan_bytes") : null;
  }

  /** Record one recipient device's signed read of one Agent/tool durable event. */
  async acknowledgeExecutionOutput(input: Readonly<{
    executionId: string;
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
      acknowledgement = verifySharedAgentLiveShadowAcknowledgement(
        this.crypto,
        {
          bytes: input.acknowledgementBytes,
          now: unixTimestamp(input.now),
          resolveCurrentAuthority: (context) =>
            context.subjectHumanId === humanId(input.recipient.subjectHumanId)
                && context.operationId === input.executionId
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
        const locked = await transaction.query(
          `/* m296_shared_agent_output_ack_lock */
           SELECT execution.state, execution.policy_revision,
                  execution.session_id::text AS session_id,
                  execution.room_id::text AS room_id,
                  execution.agent_id::text AS agent_id,
                  revision.message_id, revision.edit_revision,
                  revision.author_role, revision.crypto_object_id,
                  revision.shadow_transcript_ordinal,
                  revision.shadow_durable_event_digest
             FROM conversation_shared_agent_shadow_executions execution
             JOIN session_message_crypto_revisions revision
               ON revision.shared_agent_shadow_execution_id
                 = execution.execution_id
            WHERE execution.execution_id = $1
              AND revision.message_id = $2
              AND revision.edit_revision = 0
            LIMIT 2
            FOR UPDATE OF execution, revision`,
          [input.executionId, acknowledgement.messageId],
        );
        if (locked.length !== 1) return "conflict" as const;
        const row = locked[0]!;
        const durableDigest = bytes(row, "shadow_durable_event_digest");
        try {
          if (
            !["running", "completed"].includes(text(row, "state"))
            || text(row, "room_id") !== input.roomId
            || acknowledgement.operationId !== input.executionId
            || acknowledgement.clientIdempotencyKey !== input.executionId
            || acknowledgement.policyRevision
              !== number(row, "policy_revision")
            || acknowledgement.sessionId !== text(row, "session_id")
            || acknowledgement.roomId !== input.roomId
            || acknowledgement.recipientAgentId !== text(row, "agent_id")
            || acknowledgement.messageId !== number(row, "message_id")
            || acknowledgement.revision !== number(row, "edit_revision")
            || acknowledgement.transcriptOrdinal
              !== number(row, "shadow_transcript_ordinal")
            || acknowledgement.cryptoObjectId
              !== text(row, "crypto_object_id")
            || !["assistant", "tool"].includes(text(row, "author_role"))
            // For Agent output this field commits to the complete durable
            // event digest, not merely the DTO digest used by Human V1.
            || !equal(
              acknowledgement.protectedMessageDigest,
              durableDigest,
            )
          ) return "conflict" as const;
          const digest = sharedAgentLiveShadowAcknowledgementDigest(
            input.acknowledgementBytes,
          );
          try {
            const existing = await transaction.query(
              `SELECT acknowledgement_digest
                 FROM conversation_shared_agent_shadow_acknowledgements
                WHERE operation_id = $1 AND message_id = $2
                  AND edit_revision = 0 AND committer_device_id = $3
                  AND committer_device_signing_key_generation = $4
                LIMIT 2`,
              [input.executionId, acknowledgement.messageId,
                input.recipient.deviceId,
                input.recipient.deviceSigningKeyGeneration],
            );
            if (existing.length === 1) {
              const previous = bytes(existing[0]!, "acknowledgement_digest");
              try {
                return equal(previous, digest)
                  ? "replayed" as const
                  : "conflict" as const;
              } finally {
                previous.fill(0);
              }
            }
            await transaction.query(
              `INSERT INTO conversation_shared_agent_shadow_acknowledgements (
                 operation_id, operation_kind, message_id, edit_revision,
                 author_role, subject_human_id, committer_device_id,
                 committer_device_signing_key_generation,
                 host_authorization_revision, acknowledgement_digest,
                 status, reason, issued_at, deadline_at)
               VALUES ($1, 'agent_execution', $2, 0, $3, $4, $5, $6, $7,
                       $8, $9, $10, to_timestamp($11 / 1000.0),
                       to_timestamp($12 / 1000.0))`,
              [input.executionId, acknowledgement.messageId,
                text(row, "author_role"), input.recipient.subjectHumanId,
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
          durableDigest.fill(0);
        }
      }, { isolationLevel: "read committed" });
    } finally {
      acknowledgement.protectedMessageDigest.fill(0);
      acknowledgement.ordinaryPayloadDigest.fill(0);
      acknowledgement.signature.fill(0);
    }
  }
}

export function createPostgresSharedAgentLiveShadowPlanner(input: Readonly<{
  product: PostgresJsBridgeConnection;
  restricted: PostgresJsBridgeConnection;
  resolveReadableNamespaces?: ResolveSharedAgentReadableNamespaces;
  serverId: string;
}>): PostgresSharedAgentLiveShadowPlanner {
  return new PostgresSharedAgentLiveShadowPlanner(
    input.product,
    input.restricted,
    undefined,
    input.resolveReadableNamespaces ?? null,
    { serverId: input.serverId },
  );
}
