import { isProtectedTopLevelRoomKind } from "../../message/protected-room-topology.ts";
import { randomUUID } from "node:crypto";

import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  and,
  conversationSharedAgentShadowExecutions,
  conversationSharedAgentShadowInvocations,
  eq,
  inArray,
  isNull,
  sql,
} from "@nautilo/db";
import {
  LatticeCrypto,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  humanAiReadableLiveShadowExecutionInputSetDigest,
  namespaceId,
  unixTimestamp,
  createDomainForegroundAuthorizationPlan,
  deriveAgentRuntimeObjectSignerPublic,
  domainForegroundAuthoritySetDigest,
  type AgentRuntimeKeyGeneration,
  type DomainForegroundAuthorityEntry,
  type DomainForegroundAuthorizationCurrentAuthority,
  type ForegroundSessionLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  encodeLiveShadowMessagePlanV4,
  destroyDomainForegroundAuthorizationPlanV2,
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
  LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V4,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";

import { log } from "@nautilo/logger";

import {
  authenticateForegroundRuntimeRecipientKeyPair,
  authenticateProtectedInvocationRecipientKeyPair,
  destroyProtectedInvocationRecipient,
  type ProtectedInvocationRecipient,
} from "../../invocation/protected-grant-invocation.ts";
import { LiveShadowRecipientRegistry } from "./live-shadow-recipient-registry.ts";
import {
  PostgresNamespaceProductAuthority,
} from "../delivery/postgres-namespace-product-authority.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
} from "./postgres-conversation-product-store.ts";
import {
  PostgresDomainKeyAuthorityRepository,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "../delivery/postgres-domain-key-authority.ts";

import { LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS } from
  "./live-shadow-foreground-policy.ts";
export { LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS } from
  "./live-shadow-foreground-policy.ts";

export type LiveShadowTurnPlanResult =
  | Readonly<{ status: "disabled"; mode: "plaintext_only" }>
  | Readonly<{
      status: "ineligible";
      reason: "room_topology_unsupported";
    }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "policy_unavailable"
        | "device_unavailable"
        | "agent_authority_unavailable"
        | "domain_unavailable"
        | "reservation_unavailable";
    }>
  | Readonly<{
      status: "unavailable";
      reason: "namespace_unavailable";
      requiredNamespaceIds: readonly string[];
    }>
  | Readonly<{ status: "planned"; planBytes: Uint8Array;
      representationMode?: "full_encryption" }>;

export interface LiveShadowTurnPlanInput {
  readonly requestVersion?: 1 | 2;
  readonly authority: Readonly<{
    userId: string;
    humanActorId: string;
  }>;
  readonly roomId: string;
  readonly clientActionSessionId: string;
  readonly clientDeviceId: string;
  readonly idempotencyKey: string;
  readonly now: number;
}

export interface SharedAgentForegroundExecutionPlanInput {
  readonly authority: LiveShadowTurnPlanInput["authority"];
  readonly executionId: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly clientActionSessionId: string;
  readonly clientDeviceId: string;
  readonly now: number;
}

/** The original input device is lineage, not the device approving a resume. */
export function sharedExecutionMatchesApprover(
  row: PostgresJsBridgeRow,
  input: Pick<LiveShadowTurnPlanInput,
    "authority" | "clientDeviceId" | "clientActionSessionId">,
): boolean {
  return text(row, "invoking_human_id") === input.authority.humanActorId
    && text(row, "authorization_device_id") === input.clientDeviceId
    && text(row, "client_action_session_id") === input.clientActionSessionId;
}

export interface RuntimeInvocationForegroundAuthorizationPlanInput {
  readonly authority: LiveShadowTurnPlanInput["authority"];
  readonly invocationId: string;
  readonly operationIds: readonly string[];
  readonly roomId: string;
  readonly clientActionSessionId: string;
  readonly clientDeviceId: string;
  readonly now: number;
}

export type RuntimeInvocationForegroundAuthorizationPlanResult =
  | Exclude<LiveShadowTurnPlanResult, { status: "planned" }>
  | Readonly<{
    status: "authorization_required";
    invocationId: string;
    authorizationPlanBytes: Uint8Array;
    sourceHumanPlanBytes: Uint8Array;
    recipientPublicKey: Uint8Array;
    deadlineAt: number;
    scope: RuntimeLiveShadowForegroundAuthorizationScope;
  }>
  | Readonly<{
    status: "authorized";
    invocationId: string;
    sessionReference: string;
    authorizationDigest: Uint8Array;
    deadlineAt: number;
    scope: RuntimeLiveShadowForegroundAuthorizationScope;
  }>;

export interface RuntimeInvocationForegroundCurrentAuthority {
  readonly scope: RuntimeLiveShadowForegroundAuthorizationScope;
  readonly current: Omit<
    DomainForegroundAuthorizationCurrentAuthority,
    "recipientEncryptionPrivateKey"
  > & Readonly<{
      issuedAt: number;
      deadlineAt: number;
      readableNamespaceIds: readonly string[];
    }>;
  readonly protectedInput: Readonly<{
    policyRevision: number;
    sessionId: string;
    roomId: string;
    subjectHumanId: string;
    committerDeviceId: string;
    hostAuthorizationRevision: number;
    namespaceId: string;
    namespaceAccessRevision: number;
    namespaceKeyGeneration: number;
    namespaceHeadDigest: Uint8Array;
    namespacePublicationDigest: Uint8Array;
    namespacePublicationSetDigest: Uint8Array;
    namespaceAudienceFingerprint: Uint8Array;
  }>;
  readonly withCurrentRoomNamespaceKey: <Value>(input: Readonly<{
    domains: readonly Readonly<{
      domainId: string;
      domainKeyGeneration: number;
      authorizationRevision: number;
      headDigest: Uint8Array;
      domainKey: Uint8Array;
    }>[];
    use(key: Uint8Array): Promise<Value> | Value;
  }>) => Promise<Value | null>;
  destroy(): void;
}

export type SharedAgentForegroundExecutionPlanResult =
  | Exclude<LiveShadowTurnPlanResult, { status: "planned" }>
  | Readonly<{
    status: "authorization_required";
    executionId: string;
    executionKind: "turn" | "resume";
    authorizationPlanBytes: Uint8Array;
    sourceHumanPlanBytes?: Uint8Array;
    recipientPublicKey: Uint8Array;
    deadlineAt: number;
    scope: RuntimeLiveShadowForegroundAuthorizationScope;
  }>
  | Readonly<{
    status: "authorized";
    executionId: string;
    executionKind: "turn" | "resume";
    planBytes: Uint8Array;
    /** Immutable runtime budget, independent of the short-lived V4 work proof. */
    executionDeadlineAt: number;
    sessionReference: string;
    authorizationDigest: Uint8Array;
    scope: RuntimeLiveShadowForegroundAuthorizationScope;
  }>;

export type LiveShadowNamespaceAuthorityScheme = "domain_key_v2";

export type ResolveLiveShadowReadableNamespaces = (
  input: Readonly<{
    humanActorId: string;
    roomId: string;
    agentId: string;
  }>,
) => Promise<readonly string[]>;

export type LiveShadowTurnFallbackStage =
  | "session_establishment"
  | "session_reuse"
  | "human_admission"
  | "agent_input"
  | "assistant_stream"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "durable_transcript"
  | "client_verification"
  | "shutdown";

export type LiveShadowTurnFallbackReason =
  | "protected_unavailable"
  | "stale_authority"
  | "integrity_failure"
  | "parity_mismatch"
  | "deadline_expired"
  | "recipient_lost"
  | "cancelled"
  | "product_conflict";

export interface LiveShadowTurnFallbackInput {
  readonly authority: Readonly<{ userId: string; humanActorId: string }>;
  readonly operationId: string;
  readonly planBytes: Uint8Array;
  readonly stage: LiveShadowTurnFallbackStage;
  readonly reason: LiveShadowTurnFallbackReason;
  readonly now: number;
}

export interface LiveShadowTurnJobBindingInput {
  readonly authority: Readonly<{ userId: string; humanActorId: string }>;
  readonly operationId: string;
  readonly jobId: string;
  readonly now: number;
}

type ProductCandidate = Readonly<{
  policyRevision: number;
  representationMode?: "full_encryption";
  sessionId: string;
  roomId: string;
  namespaceId: string;
  agentId: string;
}>;

export type DomainKeyV2CryptoAuthority = Readonly<{
  scheme: "domain_key_v2";
  subjectHumanId: string;
  committerDeviceId: string;
  committerDeviceSigningKeyGeneration: number;
  hostAuthorizationRevision: number;
  agentAuthorizationRevision: number;
  room: Omit<DomainForegroundNamespaceAuthorityInspectionV2, "status">;
  readableNamespaceIds: readonly string[];
  domains: readonly DomainForegroundAuthorityEntry[];
}>;

export type AgentLiveShadowForegroundAuthorizationScope = Readonly<{
  subjectHumanId: string;
  issuingDeviceId: string;
  recipientAgentId: string;
  sessionId: string;
  roomId: string;
  policyRevision: number;
  hostAuthorizationRevision: number;
  agentAuthorizationRevision: number;
  namespaceIds: readonly string[];
  grantDomainIds: readonly string[];
  domainAuthoritySetDigest: Uint8Array;
}>;

export type RuntimeLiveShadowForegroundAuthorizationScope = Readonly<{
  subjectHumanId: string;
  issuingDeviceId: string;
  recipientKind: "nautilo_foreground_runtime";
  browserSessionId: string;
  topLevelRoomId: string;
  policyRevision: number;
  hostAuthorizationRevision: number;
  namespaceIds: readonly string[];
  grantDomainIds: readonly string[];
  domainAuthoritySetDigest: Uint8Array;
}>;

export type LiveShadowForegroundAuthorizationScope =
  | AgentLiveShadowForegroundAuthorizationScope
  | RuntimeLiveShadowForegroundAuthorizationScope;

export type LiveShadowReusableForegroundAuthorization = Readonly<{
  sessionReference: string;
  authorizationDigest: Uint8Array;
  authorizationPlanBytes: Uint8Array;
  authorizationPlanDigest: Uint8Array;
  recipientId: string;
  recipientKeyId: string;
  recipientPublicKey: Uint8Array;
}>;

export interface LiveShadowForegroundAuthorizationPlanPort {
  inspectReusable(
    scope: LiveShadowForegroundAuthorizationScope,
    minimumDeadlineAt?: number,
  ): LiveShadowReusableForegroundAuthorization | null;
}

function one(rows: readonly PostgresJsBridgeRow[], label: string): PostgresJsBridgeRow {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new TypeError(`${label} is not unique`);
  }
  return rows[0];
}

function text(row: PostgresJsBridgeRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function nullableText(row: PostgresJsBridgeRow, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  return text(row, name);
}

function counter(row: PostgresJsBridgeRow, name: string, minimum = 0): number {
  const value = row[name];
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < minimum) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized as number;
}

function bytes(row: PostgresJsBridgeRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new TypeError(`${name} is invalid`);
  }
  return value.slice();
}

function bool(row: PostgresJsBridgeRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") throw new TypeError(`${name} is invalid`);
  return value;
}

/**
 * Load the current product authority for one shared-Agent execution.
 *
 * PostgreSQL only infers grouped functional dependencies from a table's
 * primary key. Group by the execution sequence (the actual primary key), not
 * the separately unique execution ID, so every selected execution column is
 * legal while Room membership is aggregated.
 */
function loadSharedAgentExecutionAuthoritySnapshot(
  tx: PostgresJsBridgeExecutor,
  input: Readonly<{
    executionId: string;
    subjectHumanId: string;
    subjectUserId: string;
    agentId: string;
  }>,
): Promise<readonly PostgresJsBridgeRow[]> {
  return tx.query(
    `/* m296_shared_agent_execution_plan_revalidate */
     SELECT execution.state, execution.policy_revision,
            execution.session_id::text AS session_id,
            execution.room_id::text AS room_id,
            execution.agent_id::text AS agent_id,
            execution.invoking_human_id,
            execution.invoking_device_id,
            execution.authorization_device_id,
            execution.client_action_session_id,
            policy.mode, policy.revision AS current_policy_revision,
            room.kind, room.parent_room_id, room.archived_at,
            room.namespace_id::text AS namespace_id,
            authority_room.id::text AS top_level_room_id,
            authority_room.kind AS top_level_room_kind,
            authority_room.archived_at AS top_level_room_archived_at,
            COUNT(*) FILTER (WHERE actor.kind = 'user')::int AS human_count,
            COUNT(*) FILTER (WHERE actor.kind = 'agent')::int AS agent_count,
            BOOL_OR(actor.kind = 'user' AND actor.id::text = $2
              AND actor.owner_id = $3::uuid) AS subject_current,
            BOOL_OR(actor.kind = 'agent' AND actor.agent_id = $4::uuid)
              AS agent_current,
            NOT EXISTS (
              SELECT 1
                FROM room_members current_member
                JOIN actors current_human
                  ON current_human.id = current_member.actor_id
                 WHERE current_member.room_id = authority_room.id
                 AND current_human.kind = 'user'
                 AND NOT (
                   current_human.id = ANY(authority_room.human_actor_ids)
                 )
            ) AND NOT EXISTS (
              SELECT 1
                FROM unnest(authority_room.human_actor_ids)
                  AS roster_entry(stored_human_id)
               WHERE NOT EXISTS (
                 SELECT 1 FROM room_members stored_member
                  JOIN actors stored_human
                    ON stored_human.id = stored_member.actor_id
                   WHERE stored_member.room_id = authority_room.id
                   AND stored_human.kind = 'user'
                   AND stored_human.id = roster_entry.stored_human_id
               )
            ) AS human_roster_current
       FROM conversation_shared_agent_shadow_executions execution
       JOIN encryption_transition_policy policy ON policy.id = 'server'
       JOIN rooms room ON room.id = execution.room_id
       JOIN rooms authority_room
         ON authority_room.id = COALESCE(room.parent_room_id, room.id)
        AND authority_room.namespace_id = room.namespace_id
       JOIN room_members member ON member.room_id = authority_room.id
       JOIN actors actor ON actor.id = member.actor_id
      WHERE execution.execution_id = $1
      GROUP BY execution.sequence, policy.mode, policy.revision,
               room.id, authority_room.id
      LIMIT 2`,
    [input.executionId, input.subjectHumanId, input.subjectUserId,
      input.agentId],
  );
}

function dateMillis(row: PostgresJsBridgeRow, name: string): number {
  const value = row[name];
  const millis = value instanceof Date ? value.getTime() : Date.parse(text(row, name));
  if (!Number.isSafeInteger(millis)) throw new TypeError(`${name} is invalid`);
  return millis;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function destroyForegroundSessionPlan(
  plan: ForegroundSessionLiveShadowMessagePlan,
): void {
  plan.agentSignerPublicKey.fill(0);
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
  plan.grantDomainParticipantDigest.fill(0);
  plan.grantDomainHeadDigest.fill(0);
  plan.grantDomainPublicationDigest.fill(0);
  plan.namespaceBundleDigest.fill(0);
  if (plan.authorization.disposition === "authorization_required") {
    plan.authorization.authorizationPlanBytes.fill(0);
    plan.authorization.authorizationPlanDigest.fill(0);
    plan.authorization.recipientPublicKey.fill(0);
  } else {
    plan.authorization.authorizationDigest.fill(0);
  }
}

function canonicalGrantDomainNamespaceIds(
  values: readonly string[],
): readonly string[] {
  if (values.length < 1 || values.length > 65_536) {
    throw new RangeError("Live Shadow readable Namespace inventory is invalid");
  }
  const canonical = [...values].sort((left, right) =>
    Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
  );
  canonical.forEach((value) => namespaceId(value));
  if (canonical.some((value, index) =>
    index > 0 && value === canonical[index - 1]
  )) {
    throw new TypeError("Live Shadow readable Namespaces contain a duplicate");
  }
  return Object.freeze(canonical);
}

const PRODUCT_CANDIDATE_SQL = `/* m282_live_shadow_product_candidate */
SELECT p.mode, p.revision AS policy_revision,
       r.id AS room_id, r.kind, r.parent_room_id, r.archived_at,
       r.graph_thread_id, r.namespace_id,
       m.actor_id, a.kind AS actor_kind, a.owner_id, a.agent_id
  FROM encryption_transition_policy p
  JOIN rooms r ON r.id = $1
  JOIN room_members m ON m.room_id = r.id
  JOIN actors a ON a.id = m.actor_id
 WHERE p.id = 'server'
 ORDER BY m.actor_id`;

async function inspectProductCandidate(
  connection: PostgresJsBridgeConnection,
  input: LiveShadowTurnPlanInput,
): Promise<
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "policy_unavailable" }>
  | Readonly<{ status: "ineligible" }>
  | Readonly<{ status: "eligible"; candidate: ProductCandidate }>
> {
  const rows = await connection.query(PRODUCT_CANDIDATE_SQL, [input.roomId]);
  if (rows.length === 0) return Object.freeze({ status: "ineligible" });
  const first = rows[0]!;
  const mode = text(first, "mode");
  if (mode === "plaintext_only") return Object.freeze({ status: "disabled" });
  if (mode !== "shadow_encryption" && mode !== "encrypted_only") {
    return Object.freeze({ status: "policy_unavailable" });
  }
  const exactRoom = rows.every((row) =>
    text(row, "room_id") === input.roomId
    && text(row, "kind") === "private"
    && nullableText(row, "parent_room_id") === null
    && row["archived_at"] === null
  );
  const humans = rows.filter((row) => text(row, "actor_kind") === "user");
  const agents = rows.filter((row) => text(row, "actor_kind") === "agent");
  const human = humans[0];
  const agent = agents[0];
  if (
    !exactRoom
    || rows.length !== 2
    || humans.length !== 1
    || agents.length !== 1
    || human === undefined
    || agent === undefined
    || text(human, "actor_id") !== input.authority.humanActorId
    || text(human, "owner_id") !== input.authority.userId
    || nullableText(agent, "agent_id") === null
  ) return Object.freeze({ status: "ineligible" });

  const graphThreadId = text(first, "graph_thread_id");
  const agentId = text(agent, "agent_id");
  await connection.query(
    `/* m282_live_shadow_session_ensure */
     INSERT INTO sessions (thread_id, owner_id, agent_id, room_id, channel)
     VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'browser')
     ON CONFLICT (owner_id, thread_id) DO NOTHING`,
    [graphThreadId, input.authority.userId, agentId, input.roomId],
  );
  const session = one(await connection.query(
    `/* m282_live_shadow_session_read */
     SELECT id, thread_id, owner_id, agent_id, room_id
       FROM sessions
      WHERE owner_id = $1::uuid AND thread_id = $2
      LIMIT 2`,
    [input.authority.userId, graphThreadId],
  ), "Live Shadow Session");
  if (
    text(session, "thread_id") !== graphThreadId
    || text(session, "owner_id") !== input.authority.userId
    || nullableText(session, "agent_id") !== agentId
    || nullableText(session, "room_id") !== input.roomId
  ) return Object.freeze({ status: "ineligible" });
  return Object.freeze({
    status: "eligible",
    candidate: Object.freeze({
      policyRevision: counter(first, "policy_revision", 1),
      ...(mode === "encrypted_only"
        ? { representationMode: "full_encryption" as const }
        : {}),
      sessionId: text(session, "id"),
      roomId: input.roomId,
      namespaceId: text(first, "namespace_id"),
      agentId,
    }),
  });
}

function destroyDomainKeyV2CryptoAuthority(
  authority: DomainKeyV2CryptoAuthority,
): void {
  authority.room.namespaceHeadDigest.fill(0);
  authority.room.namespacePublicationDigest.fill(0);
  authority.room.namespacePublicationSetDigest.fill(0);
  authority.room.namespaceAudienceFingerprint.fill(0);
  authority.room.domainHeadDigest.fill(0);
  authority.room.bundleDigest.fill(0);
  authority.domains.forEach((entry) => {
    entry.participantDigest.fill(0);
    entry.headDigest.fill(0);
    entry.activeNamespaceBindingSetDigest.fill(0);
  });
}

function sameDomainKeyV2Entry(
  left: DomainForegroundAuthorityEntry,
  right: DomainForegroundAuthorityEntry,
): boolean {
  return left.domainId === right.domainId
    && left.sourceNamespaceId === right.sourceNamespaceId
    && left.participantCount === right.participantCount
    && left.keyClass === right.keyClass
    && left.domainKeyGeneration === right.domainKeyGeneration
    && left.authorizationRevision === right.authorizationRevision
    && left.activeNamespaceBindingCount === right.activeNamespaceBindingCount
    && equalBytes(left.participantDigest, right.participantDigest)
    && equalBytes(left.headDigest, right.headDigest)
    && equalBytes(
      left.activeNamespaceBindingSetDigest,
      right.activeNamespaceBindingSetDigest,
    );
}

export async function inspectDomainKeyV2CryptoAuthority(input: Readonly<{
  productAuthority: PostgresNamespaceProductAuthority;
  repository: PostgresDomainKeyAuthorityRepository;
  resolveReadableNamespaces: ResolveLiveShadowReadableNamespaces;
  planInput: Pick<LiveShadowTurnPlanInput, "authority" | "clientDeviceId">;
  product: Pick<ProductCandidate, "roomId" | "agentId" | "namespaceId">;
  topLevelRoomId?: string;
  /** Checkpoint reads disclose only the exact checkpoint Namespace key. */
  exactNamespaceOnly?: boolean;
}>): Promise<
  | Readonly<{ status: "device_unavailable" | "agent_authority_unavailable" }>
  | Readonly<{
      status: "namespace_unavailable";
      requiredNamespaceIds: readonly string[];
    }>
  | Readonly<{ status: "ready"; authority: DomainKeyV2CryptoAuthority }>
> {
  const authorityRoomId = input.topLevelRoomId ?? input.product.roomId;
  let readable: readonly string[];
  try {
    readable = canonicalGrantDomainNamespaceIds(
      await input.resolveReadableNamespaces({
        humanActorId: input.planInput.authority.humanActorId,
        roomId: authorityRoomId,
        agentId: input.product.agentId,
      }),
    );
  } catch {
    return Object.freeze({ status: "agent_authority_unavailable" });
  }
  if (!readable.includes(input.product.namespaceId)) {
    return Object.freeze({ status: "agent_authority_unavailable" });
  }
  if (input.exactNamespaceOnly === true) {
    readable = Object.freeze([input.product.namespaceId]);
  }
  const inspected = await input.productAuthority.withCurrentReadableNamespaceSet({
    subjectUserId: input.planInput.authority.userId,
    subjectHumanId: input.planInput.authority.humanActorId,
    sourceRoomId: authorityRoomId,
    namespaceIds: readable,
    use: async (entries) => {
      const roomEntry = entries.find((entry) =>
        entry.namespaceId === input.product.namespaceId
      );
      if (roomEntry === undefined) return null;
      const [domains, room] = await Promise.all([
        input.repository.inspectForegroundAuthority({
          namespaceIds: readable,
          keyClass: "ai",
          subjectHumanId: input.planInput.authority.humanActorId,
          deviceId: input.planInput.clientDeviceId,
        }),
        input.repository.inspectForegroundNamespaceAuthority({
          namespaceId: input.product.namespaceId,
          keyClass: "ai",
        }),
      ]);
      return Object.freeze({ domains, room });
    },
  });
  if (inspected === null) {
    return Object.freeze({ status: "agent_authority_unavailable" });
  }
  if (inspected.domains.status !== "ready") {
    if (inspected.domains.reason === "device_unavailable") {
      return Object.freeze({ status: "device_unavailable" });
    }
    const requiredNamespaceIds = "requiredNamespaceIds" in inspected.domains
      ? inspected.domains.requiredNamespaceIds
      : readable;
    return Object.freeze({
      status: "namespace_unavailable",
      requiredNamespaceIds,
    });
  }
  if (inspected.room.status !== "ready") {
    inspected.domains.domains.forEach((entry) => {
      entry.participantDigest.fill(0);
      entry.headDigest.fill(0);
      entry.activeNamespaceBindingSetDigest.fill(0);
    });
    return Object.freeze({
      status: "namespace_unavailable",
      requiredNamespaceIds: Object.freeze([input.product.namespaceId]),
    });
  }
  const currentRoom = inspected.room;
  const roomDomain = inspected.domains.domains.find((entry) =>
    entry.domainId === currentRoom.domainId
  );
  if (
    roomDomain === undefined
    || roomDomain.domainKeyGeneration
      !== currentRoom.domainKeyGeneration
    || roomDomain.authorizationRevision
      !== currentRoom.domainAuthorizationRevision
    || !equalBytes(roomDomain.headDigest, currentRoom.domainHeadDigest)
  ) {
    inspected.domains.domains.forEach((entry) => {
      entry.participantDigest.fill(0);
      entry.headDigest.fill(0);
      entry.activeNamespaceBindingSetDigest.fill(0);
    });
    currentRoom.namespaceHeadDigest.fill(0);
    currentRoom.namespacePublicationDigest.fill(0);
    currentRoom.namespacePublicationSetDigest.fill(0);
    currentRoom.namespaceAudienceFingerprint.fill(0);
    currentRoom.domainHeadDigest.fill(0);
    currentRoom.bundleDigest.fill(0);
    return Object.freeze({ status: "agent_authority_unavailable" });
  }
  const room = Object.freeze({
    namespaceId: currentRoom.namespaceId,
    namespaceAccessRevision: currentRoom.namespaceAccessRevision,
    namespaceKeyGeneration: currentRoom.namespaceKeyGeneration,
    namespaceHeadDigest: currentRoom.namespaceHeadDigest,
    namespacePublicationDigest: currentRoom.namespacePublicationDigest,
    namespacePublicationSetDigest: currentRoom.namespacePublicationSetDigest,
    namespaceAudienceFingerprint: currentRoom.namespaceAudienceFingerprint,
    domainId: currentRoom.domainId,
    domainKeyGeneration: currentRoom.domainKeyGeneration,
    domainAuthorizationRevision: currentRoom.domainAuthorizationRevision,
    domainHeadDigest: currentRoom.domainHeadDigest,
    bundleRevision: currentRoom.bundleRevision,
    bundleDigest: currentRoom.bundleDigest,
  });
  return Object.freeze({
    status: "ready" as const,
    authority: Object.freeze({
      scheme: "domain_key_v2" as const,
      subjectHumanId: input.planInput.authority.humanActorId,
      committerDeviceId: inspected.domains.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        inspected.domains.committerDeviceSigningGeneration,
      hostAuthorizationRevision:
        inspected.domains.hostAuthorizationRevision,
      agentAuthorizationRevision: 0,
      room,
      readableNamespaceIds: readable,
      domains: inspected.domains.domains,
    }),
  });
}

const PLAN_ROW_COLUMNS = `turn.operation_id, turn.policy_revision,
  turn.session_id, turn.room_id, turn.human_message_id,
  turn.human_message_created_at, turn.subject_human_id,
  turn.committer_device_id, turn.host_authorization_revision, turn.agent_id,
  turn.agent_authorization_revision, turn.namespace_id,
  turn.namespace_binding_hash, signer.agent_runtime_generation,
  signer.agent_signer_key_id, signer.agent_signer_public_key,
  turn.namespace_access_revision, turn.namespace_key_generation,
  turn.binding_revision_at_wrap, turn.domain_id, turn.domain_epoch,
  turn.recipient_id, turn.recipient_key_id, turn.recipient_public_key,
  turn.attempt_coordinate, turn.deadline_at,
  turn.namespace_authority_scheme,
  turn.committer_device_signing_key_generation,
  turn.namespace_head_digest, turn.namespace_publication_digest,
  turn.namespace_publication_set_digest,
  turn.namespace_audience_fingerprint,
  turn.grant_domain_id, turn.grant_domain_participant_digest,
  turn.grant_domain_key_generation, turn.grant_domain_head_digest,
  turn.grant_domain_publication_digest,
  turn.grant_domain_authorization_revision,
  turn.namespace_bundle_revision, turn.namespace_bundle_digest,
  turn.agent_grant_plan_bytes, turn.agent_grant_plan_digest`;

export class PostgresLiveShadowTurnPlanner {
  readonly #product: PostgresJsBridgeConnection;
  readonly #restricted: PostgresJsBridgeConnection;
  readonly #crypto: LatticeCrypto;
  readonly #recipients: LiveShadowRecipientRegistry;
  readonly #resolveReadableNamespaces: ResolveLiveShadowReadableNamespaces | null;
  readonly #foregroundAuthorizations:
    LiveShadowForegroundAuthorizationPlanPort | null;
  readonly #namespaceProductAuthority: PostgresNamespaceProductAuthority;
  readonly #domainKeyAuthority: PostgresDomainKeyAuthorityRepository;
  readonly #foregroundPlans = new Map<string, Readonly<{
    bytes: Uint8Array;
    clientActionSessionId: string;
    actorId: string;
    deadlineAt: number;
  }>>();

  constructor(
    product: PostgresJsBridgeConnection,
    restricted: PostgresJsBridgeConnection,
    crypto: LatticeCrypto,
    recipients: LiveShadowRecipientRegistry,
    options: Readonly<{
      serverId: string;
      resolveReadableNamespaces?: ResolveLiveShadowReadableNamespaces;
      foregroundAuthorizations?: LiveShadowForegroundAuthorizationPlanPort;
    }>,
  ) {
    this.#product = product;
    this.#restricted = restricted;
    this.#crypto = crypto;
    this.#recipients = recipients;
    this.#resolveReadableNamespaces = options.resolveReadableNamespaces ?? null;
    this.#foregroundAuthorizations = options.foregroundAuthorizations ?? null;
    this.#namespaceProductAuthority = new PostgresNamespaceProductAuthority(
      product,
    );
    this.#domainKeyAuthority = new PostgresDomainKeyAuthorityRepository(
      restricted,
      crypto,
      options.serverId,
    );
  }

  async #beginAttempt(
    input: LiveShadowTurnPlanInput,
    candidate: ProductCandidate,
  ): Promise<boolean> {
    const rows = await this.#product.query(
      `/* m282_live_shadow_attempt_begin */
       INSERT INTO conversation_shadow_turn_plan_attempts (
         session_id, room_id, client_idempotency_key, policy_revision,
         subject_user_id, subject_human_actor_id, state, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid,
                 'checking', $7, $7)
       ON CONFLICT (session_id, client_idempotency_key) DO UPDATE
         SET state = 'checking', unavailable_reason = NULL,
             operation_id = NULL, updated_at = EXCLUDED.updated_at
       WHERE conversation_shadow_turn_plan_attempts.room_id = EXCLUDED.room_id
         AND conversation_shadow_turn_plan_attempts.policy_revision =
             EXCLUDED.policy_revision
         AND conversation_shadow_turn_plan_attempts.subject_user_id =
             EXCLUDED.subject_user_id
         AND conversation_shadow_turn_plan_attempts.subject_human_actor_id =
             EXCLUDED.subject_human_actor_id
       RETURNING sequence`,
      [
        candidate.sessionId,
        candidate.roomId,
        input.idempotencyKey,
        candidate.policyRevision,
        input.authority.userId,
        input.authority.humanActorId,
        new Date(input.now),
      ],
    );
    return rows.length === 1;
  }

  async #recordAttemptUnavailable(
    input: LiveShadowTurnPlanInput,
    candidate: ProductCandidate,
    reason: Exclude<
      Extract<LiveShadowTurnPlanResult, { status: "unavailable" }>["reason"],
      "policy_unavailable"
    >,
  ): Promise<void> {
    await this.#product.query(
      `/* m282_live_shadow_attempt_unavailable */
       UPDATE conversation_shadow_turn_plan_attempts
          SET state = 'unavailable', unavailable_reason = $1,
              operation_id = NULL, updated_at = $2
        WHERE session_id = $3::uuid AND client_idempotency_key = $4
          AND room_id = $5::uuid AND policy_revision = $6
          AND subject_user_id = $7::uuid
          AND subject_human_actor_id = $8::uuid`,
      [
        reason,
        new Date(input.now),
        candidate.sessionId,
        input.idempotencyKey,
        candidate.roomId,
        candidate.policyRevision,
        input.authority.userId,
        input.authority.humanActorId,
      ],
    );
  }

  async #planForegroundSession(
    input: LiveShadowTurnPlanInput,
    candidate: ProductCandidate,
    authority: DomainKeyV2CryptoAuthority,
    sharedExecution?: Readonly<{
      executionId: string;
      humanMessageId: number;
      humanMessageCreatedAt: number;
      deadlineAt: number;
    }>,
  ): Promise<LiveShadowTurnPlanResult> {
    if (this.#foregroundAuthorizations === null) {
      throw new TypeError("Foreground authorization planner is unavailable");
    }
    const operationId = sharedExecution?.executionId ?? randomUUID();
    const operationDeadlineAt = sharedExecution?.deadlineAt
      ?? input.now + 30_000;
    const authorizationDeadlineAt = input.now + LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS;
    const humanMessageId = sharedExecution?.humanMessageId ?? counter(
      one(await this.#product.query(
        `/* m294_live_shadow_message_id */
         SELECT nextval(pg_get_serial_sequence('session_messages', 'id')) AS human_message_id`,
      ), "Live Shadow Message allocation"),
      "human_message_id",
      1,
    );
    const humanMessageCreatedAt = sharedExecution?.humanMessageCreatedAt
      ?? input.now;
    const agentRuntime: AgentRuntimeKeyGeneration = Object.freeze({
      agentId: agentId(candidate.agentId),
      keyClass: "runtime",
      generation: agentRuntimeGeneration(0),
      key: this.#crypto.randomBytes(32),
    });
    const agentSigner = deriveAgentRuntimeObjectSignerPublic(
      this.#crypto,
      agentRuntime,
    );
    const grantDomainIds = Object.freeze(
      authority.domains.map((entry) => entry.domainId),
    );
    const domainAuthoritySetDigest = domainForegroundAuthoritySetDigest(
      this.#crypto,
      authority.domains,
    );
    const scope: LiveShadowForegroundAuthorizationScope = Object.freeze({
      subjectHumanId: authority.subjectHumanId,
      issuingDeviceId: authority.committerDeviceId,
      recipientAgentId: candidate.agentId,
      sessionId: candidate.sessionId,
      roomId: candidate.roomId,
      policyRevision: candidate.policyRevision,
      hostAuthorizationRevision: authority.hostAuthorizationRevision,
      agentAuthorizationRevision: authority.agentAuthorizationRevision,
      // The retained Domain set carries the complete cross-Room Agent
      // authority. This foreground session is deliberately bound to one Room,
      // so Runtime leases need only that Room's Namespace coordinate and do
      // not reintroduce the former 256-readable-Namespace ceiling.
      namespaceIds: Object.freeze([authority.room.namespaceId]),
      grantDomainIds,
      domainAuthoritySetDigest: domainAuthoritySetDigest.slice(),
    });
    const reusable = this.#foregroundAuthorizations.inspectReusable(scope);
    let keyPair: Awaited<ReturnType<LatticeCrypto["generateEncryptionKeyPair"]>>
      | null = null;
    let recipient: ProtectedInvocationRecipient | null = null;
    let recipientStored = false;
    let authorizationPlanBytes: Uint8Array | null = null;
    let authorizationPlanDigest: Uint8Array | null = null;
    let recipientId: string;
    let recipientKeyId: string;
    let recipientPublicKey: Uint8Array | null = null;
    let plan: ForegroundSessionLiveShadowMessagePlan | null = null;
    let planBytes: Uint8Array | null = null;
    let planDigest: Uint8Array | null = null;
    try {
      let authorization: ForegroundSessionLiveShadowMessagePlan["authorization"];
      if (reusable === null) {
        const authorizationId = randomUUID();
        recipientId = `live-shadow-session:${authorizationId}`;
        recipientKeyId = `live-shadow-session-key:${authorizationId}`;
        keyPair = await this.#crypto.generateEncryptionKeyPair();
        recipientPublicKey = keyPair.publicKey.slice();
        const maximumSecretBytes = Math.min(
          DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
          2_048 + authority.domains.length * 384,
        );
        const authorizationPlan = createDomainForegroundAuthorizationPlan(
          this.#crypto,
          {
              authorizationId,
              policyRevision: candidate.policyRevision,
              sessionId: candidate.sessionId,
              roomId: candidate.roomId,
              subjectHumanId: humanId(authority.subjectHumanId),
              committerDeviceId: cryptoDeviceId(authority.committerDeviceId),
              committerDeviceSigningGeneration:
                authority.committerDeviceSigningKeyGeneration,
              hostAuthorizationRevision: authorizationRevision(
                authority.hostAuthorizationRevision,
              ),
              recipientKind: "agent",
              recipientPrincipalId: candidate.agentId,
              recipientAuthorizationRevision: authorizationRevision(
                authority.agentAuthorizationRevision,
              ),
              recipientRuntimeGeneration: agentRuntime.generation,
              recipientKeyId,
              operations: Object.freeze(["decrypt", "encrypt"]),
              issuedAt: input.now,
              deadlineAt: authorizationDeadlineAt,
              maximumSecretBytes,
              domains: authority.domains,
          },
        );
        try {
          authorizationPlanBytes = serializeDomainForegroundAuthorizationPlanV2(
            authorizationPlan,
          );
          authorizationPlanDigest = this.#crypto.hash(authorizationPlanBytes);
        } finally {
          destroyDomainForegroundAuthorizationPlanV2(authorizationPlan);
        }
        authorization = Object.freeze({
          disposition: "authorization_required" as const,
          authorizationId,
          authorizationPlanBytes: authorizationPlanBytes.slice(),
          authorizationPlanDigest: authorizationPlanDigest.slice(),
          recipientId,
          recipientKeyId,
          recipientPublicKey: recipientPublicKey.slice(),
        });
      } else {
        authorizationPlanBytes = reusable.authorizationPlanBytes.slice();
        authorizationPlanDigest = reusable.authorizationPlanDigest.slice();
        recipientId = reusable.recipientId;
        recipientKeyId = reusable.recipientKeyId;
        recipientPublicKey = reusable.recipientPublicKey.slice();
        authorization = Object.freeze({
          disposition: "authorization_reusable" as const,
          sessionReference: reusable.sessionReference,
          authorizationDigest: reusable.authorizationDigest.slice(),
        });
      }
      const room = authority.room;
      const roomDomain = authority.domains.find((entry) =>
        entry.domainId === authority.room.domainId
      );
      if (roomDomain === undefined) {
        throw new TypeError("V2 Room Domain authority is absent");
      }
      plan = Object.freeze({
        formatVersion: 4 as const,
        purpose: "message.live_shadow_plan" as const,
        operationId,
        policyRevision: candidate.policyRevision,
        sessionId: candidate.sessionId,
        roomId: candidate.roomId,
        humanMessageId,
        revision: 0 as const,
        createdAt: unixTimestamp(humanMessageCreatedAt),
        subjectHumanId: humanId(authority.subjectHumanId),
        committerDeviceId: cryptoDeviceId(authority.committerDeviceId),
        committerDeviceSigningKeyGeneration:
          authority.committerDeviceSigningKeyGeneration,
        hostAuthorizationRevision: authorizationRevision(
          authority.hostAuthorizationRevision,
        ),
        recipientAgentId: agentId(candidate.agentId),
        agentAuthorizationRevision: authorizationRevision(
          authority.agentAuthorizationRevision,
        ),
        agentRuntimeGeneration: agentRuntime.generation,
        agentSignerKeyId: agentSigner.principal.signerKeyId,
        agentSignerPublicKey: agentSigner.publicKey.slice(),
        namespaceId: namespaceId(room.namespaceId),
        namespaceAccessRevision: room.namespaceAccessRevision,
        namespaceKeyGeneration: room.namespaceKeyGeneration,
        namespaceHeadDigest: room.namespaceHeadDigest.slice(),
        namespacePublicationDigest: room.namespacePublicationDigest.slice(),
        namespacePublicationSetDigest:
          room.namespacePublicationSetDigest.slice(),
        namespaceAudienceFingerprint:
          room.namespaceAudienceFingerprint.slice(),
        grantDomainId: authority.room.domainId,
        grantDomainParticipantDigest: roomDomain.participantDigest.slice(),
        grantDomainKeyGeneration: authority.room.domainKeyGeneration,
        grantDomainHeadDigest: authority.room.domainHeadDigest.slice(),
        grantDomainPublicationDigest:
          roomDomain.activeNamespaceBindingSetDigest.slice(),
        grantDomainAuthorizationRevision: authorizationRevision(
          authority.room.domainAuthorizationRevision,
        ),
        namespaceBundleGrantDomainAuthorizationRevision:
          authorizationRevision(authority.room.domainAuthorizationRevision),
        namespaceBundleRevision: authority.room.bundleRevision,
        namespaceBundleDigest: authority.room.bundleDigest.slice(),
        authorization,
        attemptCoordinate: `message:create:${operationId}`,
        issuedAt: unixTimestamp(input.now),
        deadlineAt: unixTimestamp(operationDeadlineAt),
      });
      planBytes = encodeLiveShadowMessagePlanV4(plan);
      planDigest = this.#crypto.hash(planBytes);

      if (authorization.disposition === "authorization_required") {
        recipient = await authenticateProtectedInvocationRecipientKeyPair({
          crypto: this.#crypto,
          recipientAgentId: agentId(candidate.agentId),
          recipientKeyId,
          publicKey: keyPair!.publicKey,
          privateKey: keyPair!.privateKey,
        });
        recipientStored = this.#recipients.put({
          operationId,
          clientActionSessionId: input.clientActionSessionId,
          actorId: input.authority.humanActorId,
          deadlineAt: operationDeadlineAt,
          publicKey: keyPair!.publicKey,
          recipient,
          agentRuntime,
        });
      } else {
        recipientStored = this.#recipients.putAgentRuntime({
          operationId,
          clientActionSessionId: input.clientActionSessionId,
          actorId: input.authority.humanActorId,
          deadlineAt: operationDeadlineAt,
          agentRuntime,
        });
      }
      if (!recipientStored) throw new TypeError("Live Shadow custody collided");

      const inserted = await this.#product.transactionOnce(async (tx) => {
        if (sharedExecution !== undefined) {
          await this.#revalidateSharedExecution(
            tx,
            input,
            candidate,
            { ...sharedExecution, topLevelRoomId: candidate.roomId },
          );
          return tx.query(
            `/* m296_shared_agent_execution_plan_store */
             UPDATE conversation_shared_agent_shadow_executions
                SET plan_bytes = $2, plan_digest = $3,
                    authorization_plan_bytes = $4,
                    authorization_plan_digest = $5,
                    recipient_key_id = $6,
                    agent_runtime_generation = $7,
                    agent_signer_key_id = $8,
                    agent_signer_public_key = $9,
                    updated_at = GREATEST(updated_at, $10)
              WHERE execution_id = $1
                AND state = 'awaiting_authorization'
                AND plan_bytes IS NULL
            RETURNING execution_id`,
            [operationId, planBytes, planDigest, authorizationPlanBytes,
              authorizationPlanDigest, recipientKeyId,
              plan!.agentRuntimeGeneration, plan!.agentSignerKeyId,
              plan!.agentSignerPublicKey, new Date(input.now)],
          );
        }
        await this.#revalidateReservation(tx, input, candidate);
        const operations = await tx.query(
          `/* m294_live_shadow_plan_insert */
           INSERT INTO conversation_shadow_turn_operations (
             operation_id, client_idempotency_key, policy_revision,
             session_id, room_id, human_message_id, human_message_created_at,
             subject_human_id, committer_device_id,
             committer_device_signing_key_generation,
             host_authorization_revision, agent_id,
             agent_authorization_revision, namespace_id,
             namespace_authority_scheme, namespace_access_revision,
             namespace_key_generation, namespace_head_digest,
             namespace_publication_digest, namespace_publication_set_digest,
             namespace_audience_fingerprint, grant_domain_id,
             grant_domain_participant_digest, grant_domain_key_generation,
             grant_domain_head_digest, grant_domain_publication_digest,
             grant_domain_authorization_revision, namespace_bundle_revision,
             namespace_bundle_digest, agent_grant_plan_bytes,
             agent_grant_plan_digest, recipient_id, recipient_key_id,
             recipient_public_key, attempt_coordinate, plan_digest, deadline_at
           ) VALUES (
             $1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10,
             $11, $12::uuid, $13, $14::uuid, $37, $15,
             $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
             $27, $28, $29, $30, $31, $32, $33, $34, $35, $36
           ) RETURNING operation_id`,
          [
            operationId, input.idempotencyKey, plan!.policyRevision,
            plan!.sessionId, plan!.roomId, plan!.humanMessageId,
            new Date(plan!.createdAt), plan!.subjectHumanId,
            plan!.committerDeviceId,
            plan!.committerDeviceSigningKeyGeneration,
            plan!.hostAuthorizationRevision, plan!.recipientAgentId,
            plan!.agentAuthorizationRevision, plan!.namespaceId,
            plan!.namespaceAccessRevision, plan!.namespaceKeyGeneration,
            plan!.namespaceHeadDigest, plan!.namespacePublicationDigest,
            plan!.namespacePublicationSetDigest,
            plan!.namespaceAudienceFingerprint, plan!.grantDomainId,
            plan!.grantDomainParticipantDigest,
            plan!.grantDomainKeyGeneration, plan!.grantDomainHeadDigest,
            plan!.grantDomainPublicationDigest,
            plan!.grantDomainAuthorizationRevision,
            plan!.namespaceBundleRevision, plan!.namespaceBundleDigest,
            authorizationPlanBytes, authorizationPlanDigest,
            recipientId, recipientKeyId, recipientPublicKey,
            plan!.attemptCoordinate, planDigest,
            new Date(plan!.deadlineAt),
            "domain_key_v2",
          ],
        );
        if (operations.length !== 1) return [];
        const signers = await tx.query(
          `/* m294_live_shadow_agent_signer_insert */
           INSERT INTO conversation_shadow_turn_agent_signers (
             operation_id, agent_runtime_generation, agent_signer_key_id,
             agent_signer_public_key
           ) VALUES ($1, $2, $3, $4) RETURNING operation_id`,
          [operationId, plan!.agentRuntimeGeneration, plan!.agentSignerKeyId,
            plan!.agentSignerPublicKey],
        );
        if (signers.length !== 1) return [];
        return tx.query(
          `/* m294_live_shadow_attempt_planned */
           UPDATE conversation_shadow_turn_plan_attempts
              SET state = 'planned', unavailable_reason = NULL,
                  operation_id = $1, updated_at = $2
            WHERE session_id = $3::uuid AND client_idempotency_key = $4
              AND room_id = $5::uuid AND policy_revision = $6
              AND subject_user_id = $7::uuid
              AND subject_human_actor_id = $8::uuid AND state = 'checking'
          RETURNING sequence`,
          [operationId, new Date(input.now), candidate.sessionId,
            input.idempotencyKey, candidate.roomId, candidate.policyRevision,
            input.authority.userId, input.authority.humanActorId],
        );
      }, { isolationLevel: "serializable" });
      if (inserted.length !== 1) throw new TypeError("Live Shadow reservation failed");
      for (const [retainedOperationId, retained] of this.#foregroundPlans) {
        if (retained.deadlineAt <= input.now) {
          retained.bytes.fill(0);
          this.#foregroundPlans.delete(retainedOperationId);
        }
      }
      this.#foregroundPlans.set(operationId, Object.freeze({
        bytes: planBytes.slice(),
        clientActionSessionId: input.clientActionSessionId,
        actorId: input.authority.humanActorId,
        deadlineAt: operationDeadlineAt,
      }));
      return Object.freeze({ status: "planned", planBytes: planBytes.slice(),
        ...(candidate.representationMode === undefined ? {}
          : { representationMode: candidate.representationMode }) });
    } catch {
      if (recipientStored) this.#recipients.delete(operationId);
      else if (recipient !== null) destroyProtectedInvocationRecipient(recipient);
      if (sharedExecution === undefined) {
        await this.#recordAttemptUnavailable(
          input,
          candidate,
          "reservation_unavailable",
        );
      } else {
        await this.#product.query(
          `/* m296_shared_agent_execution_plan_failed */
           UPDATE conversation_shared_agent_shadow_executions
              SET state = 'fallback', terminal_reason = 'authorization_plan_unavailable',
                  terminal_at = GREATEST(updated_at, $2),
                  updated_at = GREATEST(updated_at, $2)
            WHERE execution_id = $1 AND state = 'awaiting_authorization'`,
          [sharedExecution.executionId, new Date(input.now)],
        );
      }
      return Object.freeze({
        status: "unavailable",
        reason: "reservation_unavailable",
      });
    } finally {
      domainAuthoritySetDigest.fill(0);
      scope.domainAuthoritySetDigest.fill(0);
      agentRuntime.key.fill(0);
      agentSigner.publicKey.fill(0);
      keyPair?.publicKey.fill(0);
      keyPair?.privateKey.fill(0);
      reusable?.authorizationDigest.fill(0);
      reusable?.authorizationPlanBytes.fill(0);
      reusable?.authorizationPlanDigest.fill(0);
      reusable?.recipientPublicKey.fill(0);
      authorizationPlanBytes?.fill(0);
      authorizationPlanDigest?.fill(0);
      recipientPublicKey?.fill(0);
      planBytes?.fill(0);
      planDigest?.fill(0);
      if (plan !== null) destroyForegroundSessionPlan(plan);
      destroyDomainKeyV2CryptoAuthority(authority);
    }
  }

  /**
   * Produce the byte-identical M294 V4 foreground authorization only after the
   * ordinary Conductor selected the sole Agent for an exact shared execution.
   * The execution already owns its Human Messages; this path never allocates
   * or persists another transcript row.
   */
  async #planRuntimeForegroundExecution(
    input: LiveShadowTurnPlanInput,
    candidate: ProductCandidate,
    authority: DomainKeyV2CryptoAuthority,
    sharedExecution: Readonly<{
      executionId: string;
      invocationId: string | null;
      topLevelRoomId: string;
      humanMessageId: number;
      humanMessageCreatedAt: number;
      sourceHumanPlanBytes: Uint8Array;
      executionKind: "turn" | "resume";
      deadlineAt: number;
    }>,
  ): Promise<SharedAgentForegroundExecutionPlanResult> {
    if (this.#foregroundAuthorizations === null) {
      destroyDomainKeyV2CryptoAuthority(authority);
      return Object.freeze({
        status: "unavailable",
        reason: "agent_authority_unavailable",
      });
    }
    const authorizationDeadlineAt = input.now + LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS;
    const agentRuntime: AgentRuntimeKeyGeneration = Object.freeze({
      agentId: agentId(candidate.agentId),
      keyClass: "runtime",
      generation: agentRuntimeGeneration(0),
      key: this.#crypto.randomBytes(32),
    });
    const agentSigner = deriveAgentRuntimeObjectSignerPublic(
      this.#crypto,
      agentRuntime,
    );
    const grantDomainIds = Object.freeze(
      authority.domains.map((entry) => entry.domainId),
    );
    const domainAuthoritySetDigest = domainForegroundAuthoritySetDigest(
      this.#crypto,
      authority.domains,
    );
    const scope: RuntimeLiveShadowForegroundAuthorizationScope = Object.freeze({
      subjectHumanId: authority.subjectHumanId,
      issuingDeviceId: authority.committerDeviceId,
      recipientKind: "nautilo_foreground_runtime",
      browserSessionId: input.clientActionSessionId,
      topLevelRoomId: sharedExecution.topLevelRoomId,
      policyRevision: candidate.policyRevision,
      hostAuthorizationRevision: authority.hostAuthorizationRevision,
      namespaceIds: authority.readableNamespaceIds,
      grantDomainIds,
      domainAuthoritySetDigest: domainAuthoritySetDigest.slice(),
    });
    const reusable = this.#foregroundAuthorizations.inspectReusable(
      scope, sharedExecution.deadlineAt,
    );
    let keyPair: Awaited<ReturnType<LatticeCrypto["generateEncryptionKeyPair"]>>
      | null = null;
    let runtimeRecipient: Awaited<ReturnType<
      typeof authenticateForegroundRuntimeRecipientKeyPair
    >> | null = null;
    let authorizationPlanBytes: Uint8Array | null = null;
    let authorizationPlanDigest: Uint8Array | null = null;
    let recipientPublicKey: Uint8Array | null = null;
    let plan: ForegroundSessionLiveShadowMessagePlan | null = null;
    let planBytes: Uint8Array | null = null;
    let planDigest: Uint8Array | null = null;
    let authorizationId: string;
    let recipientKeyId: string;
    let recipientStored = false;
    try {
      if (reusable === null) {
        authorizationId = randomUUID();
        recipientKeyId = `runtime-foreground-key:${authorizationId}`;
        keyPair = await this.#crypto.generateEncryptionKeyPair();
        recipientPublicKey = keyPair.publicKey.slice();
        const authorizationPlan = createDomainForegroundAuthorizationPlan(
          this.#crypto,
          {
              authorizationId,
              policyRevision: candidate.policyRevision,
              sessionId: input.clientActionSessionId,
              roomId: sharedExecution.topLevelRoomId,
              subjectHumanId: humanId(authority.subjectHumanId),
              committerDeviceId: cryptoDeviceId(authority.committerDeviceId),
              committerDeviceSigningGeneration:
                authority.committerDeviceSigningKeyGeneration,
              hostAuthorizationRevision: authorizationRevision(
                authority.hostAuthorizationRevision,
              ),
              recipientKind: "runtime",
              recipientPrincipalId: "nautilo_foreground_runtime",
              recipientAuthorizationRevision: authorizationRevision(0),
              recipientRuntimeGeneration: 0,
              recipientKeyId,
              operations: Object.freeze(["decrypt", "encrypt"]),
              issuedAt: input.now,
              deadlineAt: authorizationDeadlineAt,
              maximumSecretBytes: Math.min(
                DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
                2_048 + authority.domains.length * 384,
              ),
              domains: authority.domains,
          },
        );
        try {
          authorizationPlanBytes = serializeDomainForegroundAuthorizationPlanV2(
            authorizationPlan,
          );
          authorizationPlanDigest = this.#crypto.hash(authorizationPlanBytes);
        } finally {
          destroyDomainForegroundAuthorizationPlanV2(authorizationPlan);
        }
      } else {
        authorizationId = reusable.recipientId;
        recipientKeyId = reusable.recipientKeyId;
        authorizationPlanBytes = reusable.authorizationPlanBytes.slice();
        authorizationPlanDigest = reusable.authorizationPlanDigest.slice();
        recipientPublicKey = reusable.recipientPublicKey.slice();
      }
      const room = authority.room;
      const roomDomain = authority.domains.find((entry) =>
        entry.domainId === authority.room.domainId
      );
      if (roomDomain === undefined) {
        throw new TypeError("V2 Runtime Room Domain authority is absent");
      }
      plan = Object.freeze({
        formatVersion: 4 as const,
        purpose: "message.live_shadow_plan" as const,
        operationId: sharedExecution.executionId,
        policyRevision: candidate.policyRevision,
        sessionId: candidate.sessionId,
        roomId: candidate.roomId,
        humanMessageId: sharedExecution.humanMessageId,
        revision: 0 as const,
        createdAt: unixTimestamp(sharedExecution.humanMessageCreatedAt),
        subjectHumanId: humanId(authority.subjectHumanId),
        committerDeviceId: cryptoDeviceId(authority.committerDeviceId),
        committerDeviceSigningKeyGeneration:
          authority.committerDeviceSigningKeyGeneration,
        hostAuthorizationRevision: authorizationRevision(
          authority.hostAuthorizationRevision,
        ),
        recipientAgentId: agentId(candidate.agentId),
        agentAuthorizationRevision: authorizationRevision(
          authority.agentAuthorizationRevision,
        ),
        agentRuntimeGeneration: agentRuntime.generation,
        agentSignerKeyId: agentSigner.principal.signerKeyId,
        agentSignerPublicKey: agentSigner.publicKey.slice(),
        namespaceId: namespaceId(room.namespaceId),
        namespaceAccessRevision: room.namespaceAccessRevision,
        namespaceKeyGeneration: room.namespaceKeyGeneration,
        namespaceHeadDigest: room.namespaceHeadDigest.slice(),
        namespacePublicationDigest: room.namespacePublicationDigest.slice(),
        namespacePublicationSetDigest:
          room.namespacePublicationSetDigest.slice(),
        namespaceAudienceFingerprint: room.namespaceAudienceFingerprint.slice(),
        grantDomainId: authority.room.domainId,
        grantDomainParticipantDigest: roomDomain.participantDigest.slice(),
        grantDomainKeyGeneration: authority.room.domainKeyGeneration,
        grantDomainHeadDigest: authority.room.domainHeadDigest.slice(),
        grantDomainPublicationDigest:
          roomDomain.activeNamespaceBindingSetDigest.slice(),
        grantDomainAuthorizationRevision: authorizationRevision(
          authority.room.domainAuthorizationRevision,
        ),
        namespaceBundleGrantDomainAuthorizationRevision:
          authorizationRevision(authority.room.domainAuthorizationRevision),
        namespaceBundleRevision: authority.room.bundleRevision,
        namespaceBundleDigest: authority.room.bundleDigest.slice(),
        // V4 remains a server-only work descriptor during this additive cut.
        // Browser authority is the separate Runtime plan above.  The pending
        // reference is replaced by the accepted Runtime session before work.
        authorization: Object.freeze({
          disposition: "authorization_reusable" as const,
          sessionReference: reusable?.sessionReference
            ?? `pending:${authorizationId}`,
          authorizationDigest: reusable?.authorizationDigest.slice()
            ?? authorizationPlanDigest.slice(),
        }),
        attemptCoordinate: `message:create:${sharedExecution.executionId}`,
        issuedAt: unixTimestamp(input.now),
        deadlineAt: unixTimestamp(Math.min(
          sharedExecution.deadlineAt,
          input.now + LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V4,
        )),
      });
      planBytes = encodeLiveShadowMessagePlanV4(plan);
      planDigest = this.#crypto.hash(planBytes);

      if (reusable === null) {
        runtimeRecipient = await authenticateForegroundRuntimeRecipientKeyPair({
          crypto: this.#crypto,
          recipientKind: "nautilo_foreground_runtime",
          recipientKeyId,
          publicKey: keyPair!.publicKey,
          privateKey: keyPair!.privateKey,
        });
        recipientStored = this.#recipients.putRuntime({
          operationId: sharedExecution.executionId,
          clientActionSessionId: input.clientActionSessionId,
          actorId: input.authority.humanActorId,
          deadlineAt: sharedExecution.deadlineAt,
          publicKey: keyPair!.publicKey,
          recipient: runtimeRecipient,
          agentRuntime,
        });
      } else {
        recipientStored = this.#recipients.putAgentRuntime({
          operationId: sharedExecution.executionId,
          clientActionSessionId: input.clientActionSessionId,
          actorId: input.authority.humanActorId,
          deadlineAt: sharedExecution.deadlineAt,
          agentRuntime,
        });
      }
      if (!recipientStored) throw new TypeError("Runtime custody collided");

      const updated = await this.#product.transactionOnce(async (tx) => {
        await this.#revalidateSharedExecution(
          tx,
          input,
          candidate,
          sharedExecution,
        );
        if (sharedExecution.invocationId === null) {
          return executeTypedConversationProductQuery(
            tx,
            conversationProductTypedDb
              .update(conversationSharedAgentShadowExecutions)
              .set({
                planBytes,
                planDigest,
                authorizationPlanBytes,
                authorizationPlanDigest,
                recipientKeyId,
                agentRuntimeGeneration: plan!.agentRuntimeGeneration,
                agentSignerKeyId: plan!.agentSignerKeyId,
                agentSignerPublicKey: plan!.agentSignerPublicKey,
                ...(reusable === null ? {} : {
                  state: "authorized" as const,
                  authorizationDisposition: "reuse" as const,
                  authorizationDigest: reusable.authorizationDigest,
                  authorizationSessionReference: reusable.sessionReference,
                  authorizedAt: new Date(input.now),
                }),
                updatedAt: sql`greatest(
                  ${conversationSharedAgentShadowExecutions.updatedAt},
                  ${new Date(input.now)}
                )`,
              })
              .where(and(
                eq(
                  conversationSharedAgentShadowExecutions.executionId,
                  sharedExecution.executionId,
                ),
                eq(
                  conversationSharedAgentShadowExecutions.state,
                  "awaiting_authorization",
                ),
                isNull(conversationSharedAgentShadowExecutions.planBytes),
              ))
              .returning({
                execution_id:
                  conversationSharedAgentShadowExecutions.executionId,
              }),
          );
        }
        let invocation = await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb
            .update(conversationSharedAgentShadowInvocations)
            .set({
              authorizationPlanBytes,
              authorizationPlanDigest,
              recipientKeyId,
              ...(reusable === null ? {} : {
                state: "authorized" as const,
                authorizationDisposition: "reuse" as const,
                authorizationDigest: reusable.authorizationDigest,
                authorizationSessionReference: reusable.sessionReference,
                authorizedAt: new Date(input.now),
              }),
              updatedAt: sql`greatest(
                ${conversationSharedAgentShadowInvocations.updatedAt},
                ${new Date(input.now)}
              )`,
            })
            .where(and(
              eq(
                conversationSharedAgentShadowInvocations.invocationId,
                sharedExecution.invocationId,
              ),
              eq(
                conversationSharedAgentShadowInvocations.state,
                "awaiting_authorization",
              ),
              isNull(
                conversationSharedAgentShadowInvocations.authorizationPlanBytes,
              ),
            ))
            .returning({
              invocation_id:
                conversationSharedAgentShadowInvocations.invocationId,
            }),
        );
        if (invocation.length === 0 && reusable !== null) {
          invocation = await executeTypedConversationProductQuery(
            tx,
            conversationProductTypedDb.select({
              invocation_id:
                conversationSharedAgentShadowInvocations.invocationId,
            }).from(conversationSharedAgentShadowInvocations).where(and(
              eq(
                conversationSharedAgentShadowInvocations.invocationId,
                sharedExecution.invocationId,
              ),
              inArray(
                conversationSharedAgentShadowInvocations.state,
                ["authorized", "running"],
              ),
              eq(
                conversationSharedAgentShadowInvocations.authorizationPlanDigest,
                authorizationPlanDigest!,
              ),
              eq(
                conversationSharedAgentShadowInvocations.authorizationDigest,
                reusable.authorizationDigest,
              ),
              eq(
                conversationSharedAgentShadowInvocations
                  .authorizationSessionReference,
                reusable.sessionReference,
              ),
            )).limit(2),
          );
        }
        if (invocation.length !== 1) return [];
        return executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb
            .update(conversationSharedAgentShadowExecutions)
            .set({
              planBytes,
              planDigest,
              agentRuntimeGeneration: plan!.agentRuntimeGeneration,
              agentSignerKeyId: plan!.agentSignerKeyId,
              agentSignerPublicKey: plan!.agentSignerPublicKey,
              ...(reusable === null ? {} : {
                state: "authorized" as const,
                authorizedAt: new Date(input.now),
              }),
              updatedAt: sql`greatest(
                ${conversationSharedAgentShadowExecutions.updatedAt},
                ${new Date(input.now)}
              )`,
            })
            .where(and(
              eq(
                conversationSharedAgentShadowExecutions.executionId,
                sharedExecution.executionId,
              ),
              eq(
                conversationSharedAgentShadowExecutions.invocationId,
                sharedExecution.invocationId,
              ),
              eq(
                conversationSharedAgentShadowExecutions.state,
                "awaiting_authorization",
              ),
              isNull(conversationSharedAgentShadowExecutions.planBytes),
            ))
            .returning({
              execution_id:
                conversationSharedAgentShadowExecutions.executionId,
            }),
        );
      }, { isolationLevel: "serializable" });
      if (updated.length !== 1) throw new TypeError("Runtime plan conflicted");

      return reusable === null
        ? Object.freeze({
          status: "authorization_required" as const,
          executionId: sharedExecution.executionId,
          executionKind: sharedExecution.executionKind,
          authorizationPlanBytes: authorizationPlanBytes.slice(),
          ...(sharedExecution.executionKind === "turn"
            ? { sourceHumanPlanBytes: sharedExecution.sourceHumanPlanBytes.slice() }
            : {}),
          recipientPublicKey: recipientPublicKey.slice(),
          deadlineAt: sharedExecution.deadlineAt,
          scope: Object.freeze({
            ...scope,
            namespaceIds: Object.freeze([...scope.namespaceIds]),
            grantDomainIds: Object.freeze([...scope.grantDomainIds]),
            domainAuthoritySetDigest: scope.domainAuthoritySetDigest.slice(),
          }),
        })
        : Object.freeze({
          status: "authorized" as const,
          executionId: sharedExecution.executionId,
          executionKind: sharedExecution.executionKind,
          planBytes: planBytes.slice(),
          executionDeadlineAt: sharedExecution.deadlineAt,
          sessionReference: reusable.sessionReference,
          authorizationDigest: reusable.authorizationDigest.slice(),
          scope: Object.freeze({
            ...scope,
            namespaceIds: Object.freeze([...scope.namespaceIds]),
            grantDomainIds: Object.freeze([...scope.grantDomainIds]),
            domainAuthoritySetDigest: scope.domainAuthoritySetDigest.slice(),
          }),
        });
    } catch (error) {
      log(
        `[m298] Runtime foreground plan failed execution=${sharedExecution.executionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (recipientStored) this.#recipients.delete(sharedExecution.executionId);
      else if (runtimeRecipient !== null) {
        destroyProtectedInvocationRecipient(runtimeRecipient);
      }
      await this.#product.transactionOnce(async (tx) => {
        if (sharedExecution.invocationId !== null) {
          await executeTypedConversationProductQuery(
            tx,
            conversationProductTypedDb
              .update(conversationSharedAgentShadowInvocations)
              .set({
                state: "fallback",
                terminalReason: "authorization_plan_unavailable",
                terminalAt: sql`greatest(
                  ${conversationSharedAgentShadowInvocations.updatedAt},
                  ${new Date(input.now)}
                )`,
                updatedAt: sql`greatest(
                  ${conversationSharedAgentShadowInvocations.updatedAt},
                  ${new Date(input.now)}
                )`,
              })
              .where(and(
                eq(
                  conversationSharedAgentShadowInvocations.invocationId,
                  sharedExecution.invocationId,
                ),
                eq(
                  conversationSharedAgentShadowInvocations.state,
                  "awaiting_authorization",
                ),
              )),
          );
        }
        await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb
            .update(conversationSharedAgentShadowExecutions)
            .set({
              state: "fallback",
              terminalReason: "authorization_plan_unavailable",
              terminalAt: sql`greatest(
                ${conversationSharedAgentShadowExecutions.updatedAt},
                ${new Date(input.now)}
              )`,
              updatedAt: sql`greatest(
                ${conversationSharedAgentShadowExecutions.updatedAt},
                ${new Date(input.now)}
              )`,
            })
            .where(and(
              sharedExecution.invocationId === null
                ? eq(
                  conversationSharedAgentShadowExecutions.executionId,
                  sharedExecution.executionId,
                )
                : eq(
                  conversationSharedAgentShadowExecutions.invocationId,
                  sharedExecution.invocationId,
                ),
              eq(
                conversationSharedAgentShadowExecutions.state,
                "awaiting_authorization",
              ),
            )),
        );
      }, { isolationLevel: "serializable" });
      return Object.freeze({
        status: "unavailable",
        reason: "reservation_unavailable",
      });
    } finally {
      domainAuthoritySetDigest.fill(0);
      scope.domainAuthoritySetDigest.fill(0);
      agentRuntime.key.fill(0);
      agentSigner.publicKey.fill(0);
      keyPair?.publicKey.fill(0);
      keyPair?.privateKey.fill(0);
      reusable?.authorizationDigest.fill(0);
      reusable?.authorizationPlanBytes.fill(0);
      reusable?.authorizationPlanDigest.fill(0);
      reusable?.recipientPublicKey.fill(0);
      authorizationPlanBytes?.fill(0);
      authorizationPlanDigest?.fill(0);
      recipientPublicKey?.fill(0);
      planBytes?.fill(0);
      planDigest?.fill(0);
      if (plan !== null) destroyForegroundSessionPlan(plan);
      sharedExecution.sourceHumanPlanBytes.fill(0);
      destroyDomainKeyV2CryptoAuthority(authority);
    }
  }

  /**
   * Establish or reuse the Agent-free Runtime authorization before Conductor
   * routing. The representative Agent is a current product-policy coordinate
   * only; Human-derived readable Namespace scope does not depend on it and no
   * Agent execution, key, or work plan is created here.
   */
  async inspectRuntimeInvocationCurrentAuthority(input: Readonly<{
    authority: LiveShadowTurnPlanInput["authority"];
    invocationId: string;
    roomId: string;
    clientActionSessionId: string;
    authorizationPlanBytes: Uint8Array;
    now: number;
  }>): Promise<RuntimeInvocationForegroundCurrentAuthority | null> {
    if (this.#resolveReadableNamespaces === null) return null;
    const plan = parseDomainForegroundAuthorizationPlanV2(
      input.authorizationPlanBytes,
    );
    if (plan === null) return null;
    let inspected: DomainKeyV2CryptoAuthority | null = null;
    let signingPublicKey: Uint8Array | null = null;
    let scopeDigest: Uint8Array | null = null;
    try {
      const rows = await this.#product.query(
        `/* m299_runtime_invocation_current_authority */
         SELECT invocation.policy_revision, invocation.session_id::text,
                invocation.room_id::text, invocation.invoking_human_id,
                invocation.invoking_device_id,
                invocation.authorization_device_id,
                invocation.client_action_session_id, invocation.state,
                invocation.authorization_plan_bytes,
                invocation.authorization_plan_digest,
                invocation.recipient_key_id, invocation.deadline_at,
                room.namespace_id::text AS namespace_id,
                COALESCE(room.parent_room_id, room.id)::text
                  AS top_level_room_id,
                representative.agent_id::text AS representative_agent_id
           FROM conversation_shared_agent_shadow_invocations invocation
           JOIN rooms room ON room.id = invocation.room_id
           JOIN LATERAL (
             SELECT actor.agent_id
               FROM rooms authority
               JOIN room_members member ON member.room_id = authority.id
               JOIN actors actor
                 ON actor.id = member.actor_id AND actor.kind = 'agent'
              WHERE authority.id = COALESCE(room.parent_room_id, room.id)
                AND authority.archived_at IS NULL
              ORDER BY actor.agent_id
              LIMIT 1
           ) representative ON true
          WHERE invocation.invocation_id = $1
          LIMIT 2`,
        [input.invocationId],
      );
      if (rows.length !== 1) return null;
      const row = rows[0]!;
      const storedPlanBytes = bytes(row, "authorization_plan_bytes");
      const storedPlanDigest = bytes(row, "authorization_plan_digest");
      const submittedDigest = this.#crypto.hash(input.authorizationPlanBytes);
      try {
        if (
          !["awaiting_authorization", "authorized", "running"].includes(
            text(row, "state"),
          )
          || text(row, "room_id") !== input.roomId
          || text(row, "invoking_human_id")
            !== input.authority.humanActorId
          || text(row, "client_action_session_id")
            !== input.clientActionSessionId
          || dateMillis(row, "deadline_at") <= input.now
          || !equalBytes(storedPlanBytes, input.authorizationPlanBytes)
          || !equalBytes(storedPlanDigest, submittedDigest)
        ) return null;
      } finally {
        storedPlanBytes.fill(0);
        storedPlanDigest.fill(0);
        submittedDigest.fill(0);
      }
      const candidate: ProductCandidate = Object.freeze({
        policyRevision: counter(row, "policy_revision", 1),
        sessionId: text(row, "session_id"),
        roomId: input.roomId,
        namespaceId: text(row, "namespace_id"),
        agentId: text(row, "representative_agent_id"),
      });
      const currentPlanInput = Object.freeze({
        authority: input.authority,
        roomId: input.roomId,
        clientActionSessionId: input.clientActionSessionId,
        clientDeviceId: text(row, "authorization_device_id"),
        idempotencyKey: input.invocationId,
        now: input.now,
      });
      const authorityResult = await inspectDomainKeyV2CryptoAuthority({
        productAuthority: this.#namespaceProductAuthority,
        repository: this.#domainKeyAuthority,
        resolveReadableNamespaces: this.#resolveReadableNamespaces,
        planInput: currentPlanInput,
        product: candidate,
        topLevelRoomId: text(row, "top_level_room_id"),
      });
      if (authorityResult.status !== "ready") return null;
      const currentAuthority = authorityResult.authority;
      inspected = currentAuthority;
      if (
        plan.authorizationId.length === 0
        || plan.policyRevision !== candidate.policyRevision
        || plan.sessionId !== input.clientActionSessionId
        || plan.roomId !== text(row, "top_level_room_id")
        || plan.subjectHumanId !== input.authority.humanActorId
        || plan.committerDeviceId !== currentAuthority.committerDeviceId
        || plan.committerDeviceSigningGeneration
          !== currentAuthority.committerDeviceSigningKeyGeneration
        || plan.hostAuthorizationRevision
          !== currentAuthority.hostAuthorizationRevision
        || plan.recipientKind !== "runtime"
        || plan.recipientPrincipalId !== "nautilo_foreground_runtime"
        || plan.recipientKeyId !== text(row, "recipient_key_id")
        || plan.issuedAt > input.now
        || plan.deadlineAt <= input.now
        || plan.domains.length !== currentAuthority.domains.length
        || !plan.domains.every((entry, index) =>
          currentAuthority.domains[index] !== undefined
          && sameDomainKeyV2Entry(entry, currentAuthority.domains[index])
        )
      ) return null;
      const operations = new Set(plan.operations);
      if (!operations.has("decrypt") || !operations.has("encrypt")) return null;
      const deviceRows = await this.#restricted.query(
        `/* m299_runtime_invocation_signing_key */
         SELECT device.signing_public_key
           FROM human_crypto_devices device
           JOIN human_crypto_custodies custody
             ON custody.human_id = device.human_id
          WHERE device.device_id = $1
            AND device.user_id = $2::uuid
            AND device.human_id = $3
            AND device.device_generation = $4
            AND device.revision = $5
            AND device.state = 'active'
            AND custody.state = 'active'
          LIMIT 2`,
        [
          currentAuthority.committerDeviceId,
          input.authority.userId,
          input.authority.humanActorId,
          currentAuthority.committerDeviceSigningKeyGeneration,
          currentAuthority.hostAuthorizationRevision,
        ],
      );
      if (deviceRows.length !== 1) return null;
      signingPublicKey = bytes(deviceRows[0]!, "signing_public_key");
      scopeDigest = domainForegroundAuthoritySetDigest(
        this.#crypto,
        currentAuthority.domains,
      );
      const authority = inspected;
      const publicKey = signingPublicKey;
      const digest = scopeDigest;
      let destroyed = false;
      inspected = null;
      signingPublicKey = null;
      scopeDigest = null;
      const current = Object.freeze({
            authorizationId: plan.authorizationId,
            policyRevision: candidate.policyRevision,
            sessionId: input.clientActionSessionId,
            roomId: text(row, "top_level_room_id"),
            subjectHumanId: humanId(authority.subjectHumanId),
            committerDeviceId: cryptoDeviceId(authority.committerDeviceId),
            committerDeviceSigningGeneration:
              authority.committerDeviceSigningKeyGeneration,
            committerDeviceSigningPublicKey: publicKey,
            committerDeviceActive: true,
            hostAuthorizationRevision: authorizationRevision(
              authority.hostAuthorizationRevision,
            ),
            recipientKind: "runtime" as const,
            recipientPrincipalId: "nautilo_foreground_runtime",
            recipientAuthorizationRevision: authorizationRevision(0),
            recipientRuntimeGeneration: 0,
            recipientKeyId: plan.recipientKeyId,
            recipientAuthorized: true,
            issuedAt: plan.issuedAt,
            deadlineAt: plan.deadlineAt,
            readableNamespaceIds: authority.readableNamespaceIds,
            domains: authority.domains,
          });
      return Object.freeze({
        scope: Object.freeze({
          subjectHumanId: authority.subjectHumanId,
          issuingDeviceId: authority.committerDeviceId,
          recipientKind: "nautilo_foreground_runtime" as const,
          browserSessionId: input.clientActionSessionId,
          topLevelRoomId: text(row, "top_level_room_id"),
          policyRevision: candidate.policyRevision,
          hostAuthorizationRevision: authority.hostAuthorizationRevision,
          namespaceIds: authority.readableNamespaceIds,
          grantDomainIds: Object.freeze(
            authority.domains.map((entry) => entry.domainId),
          ),
          domainAuthoritySetDigest: digest,
        }),
        current,
        protectedInput: Object.freeze({
          policyRevision: candidate.policyRevision,
          sessionId: candidate.sessionId,
          roomId: input.roomId,
          subjectHumanId: authority.subjectHumanId,
          committerDeviceId: authority.committerDeviceId,
          hostAuthorizationRevision: authority.hostAuthorizationRevision,
          namespaceId: authority.room.namespaceId,
          namespaceAccessRevision: authority.room.namespaceAccessRevision,
          namespaceKeyGeneration: authority.room.namespaceKeyGeneration,
          namespaceHeadDigest: authority.room.namespaceHeadDigest,
          namespacePublicationDigest:
            authority.room.namespacePublicationDigest,
          namespacePublicationSetDigest:
            authority.room.namespacePublicationSetDigest,
          namespaceAudienceFingerprint:
            authority.room.namespaceAudienceFingerprint,
        }),
        withCurrentRoomNamespaceKey: async <Value>({ domains, use }: Readonly<{
          domains: readonly Readonly<{
            domainId: string;
            domainKeyGeneration: number;
            authorizationRevision: number;
            headDigest: Uint8Array;
            domainKey: Uint8Array;
          }>[];
          use(key: Uint8Array): Promise<Value> | Value;
        }>): Promise<Value | null> => {
          if (destroyed) return null;
          const selected = domains.find((entry) =>
                entry.domainId === authority.room.domainId
                && entry.domainKeyGeneration
                  === authority.room.domainKeyGeneration
                && entry.authorizationRevision
                  === authority.room.domainAuthorizationRevision
                && equalBytes(entry.headDigest, authority.room.domainHeadDigest)
              );
          if (selected === undefined) return null;
          return this.#domainKeyAuthority.withOpenedForegroundNamespaceKey({
              authority: authority.room,
              domainKey: selected.domainKey,
              use,
            });
        },
        destroy: () => {
          if (destroyed) return;
          destroyed = true;
          publicKey.fill(0);
          digest.fill(0);
          destroyDomainKeyV2CryptoAuthority(authority);
        },
      });
    } finally {
      signingPublicKey?.fill(0);
      scopeDigest?.fill(0);
      if (inspected !== null) destroyDomainKeyV2CryptoAuthority(inspected);
      destroyDomainForegroundAuthorizationPlanV2(plan);
    }
  }

  async planRuntimeInvocationAuthorization(
    input: RuntimeInvocationForegroundAuthorizationPlanInput,
  ): Promise<RuntimeInvocationForegroundAuthorizationPlanResult> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(input.invocationId)
      || input.operationIds.length < 1
      || input.operationIds.length > 256
      || new Set(input.operationIds).size !== input.operationIds.length
      || input.operationIds.some((value) =>
        !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value)
      )
      || !/^[0-9a-f-]{36}$/u.test(input.roomId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(
        input.clientActionSessionId,
      )
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(input.clientDeviceId)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Runtime invocation authorization input is invalid");
    if (
      this.#resolveReadableNamespaces === null
      || this.#foregroundAuthorizations === null
    ) return Object.freeze({
      status: "unavailable",
      reason: "agent_authority_unavailable",
    });
    const invocationRows = await this.#product.query(
      `/* m299_runtime_invocation_authorization_candidate */
       SELECT invocation.policy_revision, invocation.session_id::text,
              invocation.room_id::text, invocation.invoking_human_id,
              invocation.invoking_device_id,
              invocation.authorization_device_id,
              invocation.client_action_session_id, invocation.input_count,
              invocation.input_set_digest, invocation.state,
              invocation.deadline_at, invocation.authorization_plan_bytes,
              invocation.authorization_plan_digest,
              invocation.recipient_key_id,
              room.namespace_id::text AS namespace_id,
              COALESCE(room.parent_room_id, room.id)::text
                AS top_level_room_id,
              representative.agent_id::text AS representative_agent_id
         FROM conversation_shared_agent_shadow_invocations invocation
         JOIN rooms room ON room.id = invocation.room_id
         JOIN LATERAL (
           SELECT actor.agent_id
             FROM rooms authority
             JOIN room_members member ON member.room_id = authority.id
             JOIN actors actor
               ON actor.id = member.actor_id AND actor.kind = 'agent'
            WHERE authority.id = COALESCE(room.parent_room_id, room.id)
              AND authority.archived_at IS NULL
            ORDER BY actor.agent_id
            LIMIT 1
         ) representative ON true
        WHERE invocation.invocation_id = $1
        LIMIT 2`,
      [input.invocationId],
    );
    if (invocationRows.length !== 1) {
      return Object.freeze({
        status: "unavailable",
        reason: "reservation_unavailable",
      });
    }
    const invocation = invocationRows[0]!;
    if (
      !["awaiting_authorization", "authorized", "running"].includes(
        text(invocation, "state"),
      )
      || text(invocation, "room_id") !== input.roomId
      || text(invocation, "invoking_human_id")
        !== input.authority.humanActorId
      || text(invocation, "authorization_device_id") !== input.clientDeviceId
      || text(invocation, "client_action_session_id")
        !== input.clientActionSessionId
      || dateMillis(invocation, "deadline_at") <= input.now
    ) return Object.freeze({
      status: "unavailable",
      reason: "reservation_unavailable",
    });
    const operationRows = await this.#product.query(
      `/* m299_runtime_invocation_authorization_inputs */
       SELECT operation.operation_id, operation.human_message_id,
              operation.plan_bytes, operation.room_id::text AS room_id,
              operation.subject_human_id, operation.committer_device_id,
              operation.policy_revision, operation.state,
              operation.conductor_state
         FROM conversation_shared_agent_shadow_operations operation
        WHERE operation.operation_id = ANY($1::text[])`,
      [input.operationIds],
    );
    if (operationRows.length !== input.operationIds.length) {
      return Object.freeze({
        status: "unavailable",
        reason: "reservation_unavailable",
      });
    }
    const byId = new Map(
      operationRows.map((row) => [text(row, "operation_id"), row]),
    );
    const ordered = input.operationIds.map((id) => byId.get(id));
    if (
      ordered.some((row) => row === undefined)
      || ordered.some((row) =>
        text(row!, "state") !== "published"
        || text(row!, "room_id") !== input.roomId
        || text(row!, "subject_human_id") !== input.authority.humanActorId
        || text(row!, "committer_device_id") !== input.clientDeviceId
        || !["pending", "awaiting_user"].includes(
          text(row!, "conductor_state"),
        )
      )
    ) return Object.freeze({
      status: "unavailable",
      reason: "reservation_unavailable",
    });
    const coordinates = ordered.map((row, index) => Object.freeze({
      operationId: text(row!, "operation_id"),
      messageId: counter(row!, "human_message_id", 1),
      inputOrdinal: index + 1,
    }));
    const digest = humanAiReadableLiveShadowExecutionInputSetDigest(
      this.#crypto,
      coordinates,
    );
    const storedDigest = bytes(invocation, "input_set_digest");
    try {
      if (
        !equalBytes(digest, storedDigest)
        || counter(invocation, "input_count", 1) !== coordinates.length
        || counter(invocation, "policy_revision", 1)
          !== counter(ordered[0]!, "policy_revision", 1)
      ) return Object.freeze({
        status: "unavailable",
        reason: "reservation_unavailable",
      });
    } finally {
      digest.fill(0);
      storedDigest.fill(0);
    }

    const candidate: ProductCandidate = Object.freeze({
      policyRevision: counter(invocation, "policy_revision", 1),
      sessionId: text(invocation, "session_id"),
      roomId: input.roomId,
      namespaceId: text(invocation, "namespace_id"),
      agentId: text(invocation, "representative_agent_id"),
    });
    const planInput: LiveShadowTurnPlanInput = Object.freeze({
      authority: input.authority,
      roomId: input.roomId,
      clientActionSessionId: input.clientActionSessionId,
      clientDeviceId: input.clientDeviceId,
      idempotencyKey: input.invocationId,
      now: input.now,
    });
    const inspected = await inspectDomainKeyV2CryptoAuthority({
      productAuthority: this.#namespaceProductAuthority,
      repository: this.#domainKeyAuthority,
      resolveReadableNamespaces: this.#resolveReadableNamespaces,
      planInput,
      product: candidate,
      topLevelRoomId: text(invocation, "top_level_room_id"),
    });
    if (inspected.status !== "ready") {
      return inspected.status === "namespace_unavailable"
        ? Object.freeze({
          status: "unavailable",
          reason: "namespace_unavailable",
          requiredNamespaceIds: inspected.requiredNamespaceIds,
        })
        : Object.freeze({ status: "unavailable", reason: inspected.status });
    }
    const authority = inspected.authority;
    const grantDomainIds = Object.freeze(
      authority.domains.map((entry) => entry.domainId),
    );
    const domainAuthoritySetDigest = domainForegroundAuthoritySetDigest(
      this.#crypto,
      authority.domains,
    );
    const scope: RuntimeLiveShadowForegroundAuthorizationScope = Object.freeze({
      subjectHumanId: authority.subjectHumanId,
      issuingDeviceId: authority.committerDeviceId,
      recipientKind: "nautilo_foreground_runtime",
      browserSessionId: input.clientActionSessionId,
      topLevelRoomId: text(invocation, "top_level_room_id"),
      policyRevision: candidate.policyRevision,
      hostAuthorizationRevision: authority.hostAuthorizationRevision,
      namespaceIds: authority.readableNamespaceIds,
      grantDomainIds,
      domainAuthoritySetDigest: domainAuthoritySetDigest.slice(),
    });
    const reusable = this.#foregroundAuthorizations.inspectReusable(
      scope, dateMillis(invocation, "deadline_at"),
    );
    let keyPair: Awaited<ReturnType<LatticeCrypto["generateEncryptionKeyPair"]>>
      | null = null;
    let runtimeRecipient: Awaited<ReturnType<
      typeof authenticateForegroundRuntimeRecipientKeyPair
    >> | null = null;
    let authorizationPlanBytes: Uint8Array | null = null;
    let authorizationPlanDigest: Uint8Array | null = null;
    let recipientPublicKey: Uint8Array | null = null;
    let recipientStored = false;
    let replayingRequired = false;
    try {
      let authorizationId: string;
      let recipientKeyId: string;
      const invocationState = text(invocation, "state");
      const retainedPlanValue = invocation["authorization_plan_bytes"];
      if (
        reusable === null
        && invocationState === "awaiting_authorization"
        && retainedPlanValue instanceof Uint8Array
      ) {
        authorizationPlanBytes = retainedPlanValue.slice();
        authorizationPlanDigest = bytes(
          invocation,
          "authorization_plan_digest",
        );
        const digest = this.#crypto.hash(authorizationPlanBytes);
        const retainedPlan = parseDomainForegroundAuthorizationPlanV2(
          authorizationPlanBytes,
        );
        recipientPublicKey = this.#recipients.peekRuntimePublicKey({
          operationId: input.invocationId,
          clientActionSessionId: input.clientActionSessionId,
          actorId: input.authority.humanActorId,
        });
        try {
          if (
            retainedPlan === null
            || recipientPublicKey === null
            || !equalBytes(digest, authorizationPlanDigest)
            || retainedPlan.policyRevision !== candidate.policyRevision
            || retainedPlan.sessionId !== input.clientActionSessionId
            || retainedPlan.roomId !== text(invocation, "top_level_room_id")
            || retainedPlan.subjectHumanId !== authority.subjectHumanId
            || retainedPlan.committerDeviceId !== authority.committerDeviceId
            || retainedPlan.domains.length !== authority.domains.length
            || retainedPlan.recipientKind !== "runtime"
            || retainedPlan.recipientPrincipalId
              !== "nautilo_foreground_runtime"
            || !retainedPlan.domains.every((entry, index) =>
              authority.domains[index] !== undefined
              && sameDomainKeyV2Entry(entry, authority.domains[index])
            )
          ) throw new TypeError("Retained Runtime plan is stale");
          authorizationId = retainedPlan.authorizationId;
          recipientKeyId = retainedPlan.recipientKeyId;
          replayingRequired = true;
        } finally {
          digest.fill(0);
          if (retainedPlan !== null) {
            destroyDomainForegroundAuthorizationPlanV2(retainedPlan);
          }
        }
      } else if (reusable === null) {
        if (invocationState !== "awaiting_authorization") {
          throw new TypeError("Runtime session is unavailable");
        }
        authorizationId = randomUUID();
        recipientKeyId = `runtime-foreground-key:${authorizationId}`;
        keyPair = await this.#crypto.generateEncryptionKeyPair();
        recipientPublicKey = keyPair.publicKey.slice();
        const authorizationPlan = createDomainForegroundAuthorizationPlan(
          this.#crypto,
          {
              authorizationId,
              policyRevision: candidate.policyRevision,
              sessionId: input.clientActionSessionId,
              roomId: text(invocation, "top_level_room_id"),
              subjectHumanId: humanId(authority.subjectHumanId),
              committerDeviceId: cryptoDeviceId(authority.committerDeviceId),
              committerDeviceSigningGeneration:
                authority.committerDeviceSigningKeyGeneration,
              hostAuthorizationRevision: authorizationRevision(
                authority.hostAuthorizationRevision,
              ),
              recipientKind: "runtime",
              recipientPrincipalId: "nautilo_foreground_runtime",
              recipientAuthorizationRevision: authorizationRevision(0),
              recipientRuntimeGeneration: 0,
              recipientKeyId,
              operations: Object.freeze(["decrypt", "encrypt"]),
              issuedAt: input.now,
              deadlineAt: input.now + LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS,
              maximumSecretBytes:
                DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
              domains: authority.domains,
          },
        );
        try {
          authorizationPlanBytes = serializeDomainForegroundAuthorizationPlanV2(
            authorizationPlan,
          );
          authorizationPlanDigest = this.#crypto.hash(authorizationPlanBytes);
        } finally {
          destroyDomainForegroundAuthorizationPlanV2(authorizationPlan);
        }
        runtimeRecipient = await authenticateForegroundRuntimeRecipientKeyPair({
          crypto: this.#crypto,
          recipientKind: "nautilo_foreground_runtime",
          recipientKeyId,
          publicKey: keyPair.publicKey,
          privateKey: keyPair.privateKey,
        });
        recipientStored = this.#recipients.putRuntime({
          operationId: input.invocationId,
          clientActionSessionId: input.clientActionSessionId,
          actorId: input.authority.humanActorId,
          deadlineAt: dateMillis(invocation, "deadline_at"),
          publicKey: keyPair.publicKey,
          recipient: runtimeRecipient,
        });
        if (!recipientStored) throw new TypeError("Runtime custody collided");
      } else {
        authorizationId = reusable.recipientId;
        recipientKeyId = reusable.recipientKeyId;
        authorizationPlanBytes = reusable.authorizationPlanBytes.slice();
        authorizationPlanDigest = reusable.authorizationPlanDigest.slice();
        recipientPublicKey = reusable.recipientPublicKey.slice();
      }

      const updated = replayingRequired || invocationState !== "awaiting_authorization"
        ? [{ invocation_id: input.invocationId }]
        : await executeTypedConversationProductQuery(
          this.#product,
          conversationProductTypedDb
          .update(conversationSharedAgentShadowInvocations)
          .set({
            authorizationPlanBytes,
            authorizationPlanDigest,
            recipientKeyId,
            ...(reusable === null ? {} : {
              state: "authorized" as const,
              authorizationDisposition: "reuse" as const,
              authorizationDigest: reusable.authorizationDigest,
              authorizationSessionReference: reusable.sessionReference,
              authorizedAt: new Date(input.now),
            }),
            // Invocation creation uses PostgreSQL's microsecond-resolution
            // clock while the foreground request timestamp comes from
            // JavaScript at millisecond resolution. A reuse planned within
            // that same millisecond must not appear to move the durable
            // lifecycle backwards and trip the monotonic receipt trigger.
            updatedAt: sql`greatest(
              ${conversationSharedAgentShadowInvocations.updatedAt},
              ${new Date(input.now)}
            )`,
          })
          .where(and(
            eq(
              conversationSharedAgentShadowInvocations.invocationId,
              input.invocationId,
            ),
            eq(
              conversationSharedAgentShadowInvocations.state,
              "awaiting_authorization",
            ),
            isNull(
              conversationSharedAgentShadowInvocations.authorizationPlanBytes,
            ),
          ))
          .returning({
            invocation_id:
              conversationSharedAgentShadowInvocations.invocationId,
          }),
        );
      if (updated.length !== 1) throw new TypeError("Runtime plan conflicted");
      const sourceHumanPlanBytes = bytes(
        ordered[ordered.length - 1]!,
        "plan_bytes",
      );
      return reusable === null
        ? Object.freeze({
          status: "authorization_required" as const,
          invocationId: input.invocationId,
          authorizationPlanBytes: authorizationPlanBytes.slice(),
          sourceHumanPlanBytes,
          recipientPublicKey: recipientPublicKey.slice(),
          deadlineAt: dateMillis(invocation, "deadline_at"),
          scope: Object.freeze({
            ...scope,
            namespaceIds: Object.freeze([...scope.namespaceIds]),
            grantDomainIds: Object.freeze([...scope.grantDomainIds]),
            domainAuthoritySetDigest: scope.domainAuthoritySetDigest.slice(),
          }),
        })
        : Object.freeze({
          status: "authorized" as const,
          invocationId: input.invocationId,
          sessionReference: reusable.sessionReference,
          authorizationDigest: reusable.authorizationDigest.slice(),
          deadlineAt: dateMillis(invocation, "deadline_at"),
          scope: Object.freeze({
            ...scope,
            namespaceIds: Object.freeze([...scope.namespaceIds]),
            grantDomainIds: Object.freeze([...scope.grantDomainIds]),
            domainAuthoritySetDigest: scope.domainAuthoritySetDigest.slice(),
          }),
        });
    } catch {
      if (recipientStored) this.#recipients.delete(input.invocationId);
      else if (runtimeRecipient !== null) {
        destroyProtectedInvocationRecipient(runtimeRecipient);
      }
      return Object.freeze({
        status: "unavailable" as const,
        reason: "reservation_unavailable" as const,
      });
    } finally {
      keyPair?.publicKey.fill(0);
      keyPair?.privateKey.fill(0);
      reusable?.authorizationDigest.fill(0);
      reusable?.authorizationPlanBytes.fill(0);
      reusable?.authorizationPlanDigest.fill(0);
      reusable?.recipientPublicKey.fill(0);
      authorizationPlanBytes?.fill(0);
      authorizationPlanDigest?.fill(0);
      recipientPublicKey?.fill(0);
      domainAuthoritySetDigest.fill(0);
      destroyDomainKeyV2CryptoAuthority(authority);
    }
  }

  async planSharedAgentExecution(
    input: SharedAgentForegroundExecutionPlanInput,
  ): Promise<SharedAgentForegroundExecutionPlanResult> {
    if (
      !/^[0-9a-f-]{36}$/u.test(input.executionId)
      || !/^[0-9a-f-]{36}$/u.test(input.roomId)
      || !/^[0-9a-f-]{36}$/u.test(input.agentId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(
        input.clientActionSessionId,
      )
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(input.clientDeviceId)
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw new TypeError("Shared-Agent foreground execution input is invalid");
    if (
      this.#resolveReadableNamespaces === null
      || this.#foregroundAuthorizations === null
    ) return Object.freeze({
      status: "unavailable",
      reason: "agent_authority_unavailable",
    });
    const rows = await this.#product.query(
      `/* m296_shared_agent_execution_plan_candidate */
       SELECT execution.execution_id, execution.invocation_id,
              execution.policy_revision,
              execution.session_id::text AS session_id,
              execution.room_id::text AS room_id,
              execution.agent_id::text AS agent_id,
              execution.invoking_human_id,
              execution.invoking_device_id,
              execution.client_action_session_id,
              execution.authorization_device_id, execution.execution_kind,
              execution.state, execution.deadline_at,
              room.namespace_id::text AS namespace_id,
              COALESCE(room.parent_room_id, room.id)::text
                AS top_level_room_id,
              latest.message_id AS human_message_id,
              operation.human_message_created_at,
              operation.plan_bytes AS source_human_plan_bytes
         FROM conversation_shared_agent_shadow_executions execution
         JOIN rooms room ON room.id = execution.room_id
         JOIN LATERAL (
           SELECT input.message_id, input.human_operation_id
             FROM conversation_shared_agent_shadow_execution_inputs input
            WHERE input.execution_id = execution.execution_id
            ORDER BY input.input_ordinal DESC LIMIT 1
         ) latest ON true
         JOIN conversation_shared_agent_shadow_operations operation
           ON operation.operation_id = latest.human_operation_id
        WHERE execution.execution_id = $1
        LIMIT 2`,
      [input.executionId],
    );
    if (rows.length !== 1) {
      return Object.freeze({
        status: "unavailable",
        reason: "reservation_unavailable",
      });
    }
    const row = rows[0]!;
    if (
      text(row, "state") !== "awaiting_authorization"
      || text(row, "room_id") !== input.roomId
      || text(row, "agent_id") !== input.agentId
      || !sharedExecutionMatchesApprover(row, input)
      || !["turn", "resume"].includes(text(row, "execution_kind"))
      || dateMillis(row, "deadline_at") <= input.now
    ) {
      return Object.freeze({
        status: "unavailable",
        reason: "reservation_unavailable",
      });
    }
    const candidate: ProductCandidate = Object.freeze({
      policyRevision: counter(row, "policy_revision", 1),
      sessionId: text(row, "session_id"),
      roomId: input.roomId,
      namespaceId: text(row, "namespace_id"),
      agentId: input.agentId,
    });
    const planInput: LiveShadowTurnPlanInput = Object.freeze({
      authority: input.authority,
      roomId: input.roomId,
      clientActionSessionId: input.clientActionSessionId,
      clientDeviceId: input.clientDeviceId,
      idempotencyKey: input.executionId,
      now: input.now,
    });
    const inspected = await inspectDomainKeyV2CryptoAuthority({
      productAuthority: this.#namespaceProductAuthority,
      repository: this.#domainKeyAuthority,
      resolveReadableNamespaces: this.#resolveReadableNamespaces,
      planInput,
      product: candidate,
      topLevelRoomId: text(row, "top_level_room_id"),
    });
    if (inspected.status !== "ready") {
      return inspected.status === "namespace_unavailable"
        ? Object.freeze({
          status: "unavailable",
          reason: "namespace_unavailable",
          requiredNamespaceIds: inspected.requiredNamespaceIds,
        })
        : Object.freeze({ status: "unavailable", reason: inspected.status });
    }
    return this.#planRuntimeForegroundExecution(
      planInput,
      candidate,
      inspected.authority,
      {
      executionId: input.executionId,
      invocationId: row["invocation_id"] === null
        ? null
        : text(row, "invocation_id"),
      topLevelRoomId: text(row, "top_level_room_id"),
      humanMessageId: counter(row, "human_message_id", 1),
      humanMessageCreatedAt: dateMillis(row, "human_message_created_at"),
      sourceHumanPlanBytes: bytes(row, "source_human_plan_bytes"),
      executionKind: text(row, "execution_kind") as "turn" | "resume",
      deadlineAt: dateMillis(row, "deadline_at"),
      },
    );
  }

  async #planDomainKeyV2(
    input: LiveShadowTurnPlanInput,
    candidate: ProductCandidate,
  ): Promise<LiveShadowTurnPlanResult> {
    if (
      this.#resolveReadableNamespaces === null
      || this.#foregroundAuthorizations === null
    ) {
      await this.#recordAttemptUnavailable(
        input,
        candidate,
        "agent_authority_unavailable",
      );
      return Object.freeze({
        status: "unavailable",
        reason: "agent_authority_unavailable",
      });
    }
    const inspected = await inspectDomainKeyV2CryptoAuthority({
      productAuthority: this.#namespaceProductAuthority,
      repository: this.#domainKeyAuthority,
      resolveReadableNamespaces: this.#resolveReadableNamespaces,
      planInput: input,
      product: candidate,
    });
    if (inspected.status !== "ready") {
      await this.#recordAttemptUnavailable(input, candidate, inspected.status);
      return inspected.status === "namespace_unavailable"
        ? Object.freeze({
            status: "unavailable",
            reason: "namespace_unavailable",
            requiredNamespaceIds: inspected.requiredNamespaceIds,
          })
        : Object.freeze({ status: "unavailable", reason: inspected.status });
    }
    return this.#planForegroundSession(input, candidate, inspected.authority);
  }

  async plan(input: LiveShadowTurnPlanInput): Promise<LiveShadowTurnPlanResult> {
    const inspected = await inspectProductCandidate(this.#product, input);
    if (inspected.status === "disabled") {
      return Object.freeze({ status: "disabled", mode: "plaintext_only" });
    }
    if (inspected.status === "policy_unavailable") {
      return Object.freeze({ status: "unavailable", reason: "policy_unavailable" });
    }
    if (inspected.status === "ineligible") {
      return Object.freeze({ status: "ineligible", reason: "room_topology_unsupported" });
    }

    await this.reconcileExpired(input.now);

    const existing = await this.#product.query(
      `/* m282_live_shadow_plan_replay */
       SELECT ${PLAN_ROW_COLUMNS}
         FROM conversation_shadow_turn_operations turn
         JOIN conversation_shadow_turn_agent_signers signer
           ON signer.operation_id = turn.operation_id
        WHERE turn.session_id = $1::uuid AND turn.client_idempotency_key = $2
        LIMIT 2`,
      [inspected.candidate.sessionId, input.idempotencyKey],
    );
    if (existing.length === 1) {
      const row = existing[0]!;
      if (
        text(row, "namespace_authority_scheme") !== "domain_key_v2"
        || counter(row, "policy_revision", 1)
          !== inspected.candidate.policyRevision
      ) {
        return Object.freeze({ status: "unavailable", reason: "reservation_unavailable" });
      }
      if (this.#foregroundAuthorizations !== null) {
        const storedAuthorizationPlanBytes = bytes(
          row,
          "agent_grant_plan_bytes",
        );
        const storedAuthorizationPlan = parseDomainForegroundAuthorizationPlanV2(
          storedAuthorizationPlanBytes,
        );
        try {
          if (storedAuthorizationPlan !== null) {
            const operationId = text(row, "operation_id");
            const retained = this.#foregroundPlans.get(operationId);
            if (
              retained === undefined
              || retained.clientActionSessionId
                !== input.clientActionSessionId
              || retained.actorId !== input.authority.humanActorId
              || retained.deadlineAt <= input.now
              || !this.#recipients.hasOperation({
                operationId,
                clientActionSessionId: input.clientActionSessionId,
                actorId: input.authority.humanActorId,
              })
            ) {
              return Object.freeze({
                status: "unavailable",
                reason: "reservation_unavailable",
              });
            }
            const replayPlan = decodeLiveShadowMessagePlanV4(retained.bytes);
            try {
              if (
                replayPlan.operationId !== operationId
                || replayPlan.roomId !== input.roomId
                || replayPlan.committerDeviceId !== input.clientDeviceId
              ) return Object.freeze({
                status: "unavailable",
                reason: "reservation_unavailable",
              });
              return Object.freeze({
                status: "planned",
                planBytes: retained.bytes.slice(),
                ...(inspected.candidate.representationMode === undefined ? {}
                  : { representationMode: inspected.candidate.representationMode }),
              });
            } finally {
              destroyForegroundSessionPlan(replayPlan);
            }
          }
        } finally {
          storedAuthorizationPlanBytes.fill(0);
          if (storedAuthorizationPlan !== null) {
            destroyDomainForegroundAuthorizationPlanV2(
              storedAuthorizationPlan,
            );
          }
        }
      }
      return Object.freeze({ status: "unavailable", reason: "reservation_unavailable" });
    }
    if (existing.length !== 0) {
      return Object.freeze({ status: "unavailable", reason: "reservation_unavailable" });
    }

    if (!await this.#beginAttempt(input, inspected.candidate)) {
      return Object.freeze({ status: "unavailable", reason: "reservation_unavailable" });
    }

    return this.#planDomainKeyV2(input, inspected.candidate);
  }

  /**
   * Lazily close bounded expired work without recreating its lost recipient
   * authority or retrying the Agent. The next eligible plan and explicit
   * lifecycle checks can drive this idempotently.
   */
  async reconcileExpired(now: number, maximum = 64): Promise<number> {
    if (
      !Number.isSafeInteger(now)
      || now < 0
      || !Number.isSafeInteger(maximum)
      || maximum < 1
      || maximum > 256
    ) throw new TypeError("Live Shadow reconciliation bounds are invalid");
    const rows = await this.#product.transactionOnce((transaction) =>
      transaction.query(
        `/* m282_live_shadow_reconcile_expired */
         WITH due AS (
           SELECT operation_id, state
             FROM conversation_shadow_turn_operations
            WHERE state IN ('planned', 'human_verified', 'running')
              AND deadline_at <= $1
            ORDER BY deadline_at, sequence
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE conversation_shadow_turn_operations AS turn
            SET state = 'failed',
                terminal_stage = CASE due.state
                  WHEN 'planned' THEN 'plan'
                  WHEN 'human_verified' THEN 'agent_input'
                  ELSE 'agent_input'
                END,
                terminal_reason = 'deadline_expired',
                terminal_at = $1,
                reconciliation_attempt_count = LEAST(
                  turn.reconciliation_attempt_count + 1,
                  8
                ),
                updated_at = $1
           FROM due
          WHERE turn.operation_id = due.operation_id
        RETURNING turn.operation_id`,
        [new Date(now), maximum],
      )
    );
    for (const row of rows) {
      const operationId = text(row, "operation_id");
      this.#recipients.delete(operationId);
      const retained = this.#foregroundPlans.get(operationId);
      retained?.bytes.fill(0);
      this.#foregroundPlans.delete(operationId);
    }
    return rows.length;
  }

  /** Close only exact process-owned operations during deliberate shutdown. */
  async recordProcessLoss(
    operationIds: readonly string[],
    now: number,
  ): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("Live Shadow shutdown time is invalid");
    }
    const unique = [...new Set(operationIds)];
    if (unique.length === 0) return 0;
    if (unique.length > 1_280) {
      throw new RangeError("Live Shadow shutdown operation set is unbounded");
    }
    for (const operationId of unique) {
      if (
        operationId.length < 1
        || operationId.length > 128
        || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(operationId)
      ) throw new TypeError("Live Shadow shutdown operation ID is invalid");
    }
    const rows = await this.#product.query(
      `/* m282_live_shadow_process_loss */
       UPDATE conversation_shadow_turn_operations
          SET state = 'failed', terminal_stage = 'shutdown',
              terminal_reason = 'recipient_lost', terminal_at = $2,
              reconciliation_attempt_count = LEAST(
                reconciliation_attempt_count + 1,
                8
              ),
              updated_at = $2
        WHERE operation_id = ANY($1::text[])
          AND state IN ('planned', 'human_verified', 'running')
      RETURNING operation_id`,
      [unique, new Date(now)],
    );
    return rows.length;
  }

  /** Exact, content-free terminalization of one previously issued plan. */
  async recordFallback(input: LiveShadowTurnFallbackInput): Promise<boolean> {
    let plan: ForegroundSessionLiveShadowMessagePlan;
    try {
      plan = decodeLiveShadowMessagePlanV4(input.planBytes);
    } catch {
      return false;
    }
    const planDigest = this.#crypto.hash(input.planBytes);
    try {
      if (
        plan.operationId !== input.operationId
        || plan.subjectHumanId !== input.authority.humanActorId
        || input.now < plan.issuedAt
      ) return false;
      const rows = await this.#product.query(
        `/* m282_live_shadow_record_fallback */
         UPDATE conversation_shadow_turn_operations AS turn
            SET state = 'fallback', terminal_stage = $1,
                terminal_reason = $2, terminal_at = $3, updated_at = $3
          WHERE turn.operation_id = $4
            AND turn.session_id = $5::uuid
            AND turn.room_id = $6::uuid
            AND turn.human_message_id = $7
            AND turn.subject_human_id = $8
            AND turn.committer_device_id = $9
            AND turn.plan_digest = $10
            AND turn.state IN ('planned', 'human_verified')
            AND EXISTS (
              SELECT 1 FROM actors actor
               WHERE actor.id = turn.subject_human_id
                 AND actor.kind = 'user'
                 AND actor.owner_id = $11::uuid
            )
         RETURNING turn.operation_id`,
        [
          input.stage === "human_admission"
            ? plan.authorization.disposition === "authorization_required"
              ? "session_establishment"
              : "session_reuse"
            : input.stage,
          input.reason,
          new Date(input.now),
          input.operationId,
          plan.sessionId,
          plan.roomId,
          plan.humanMessageId,
          plan.subjectHumanId,
          plan.committerDeviceId,
          planDigest,
          input.authority.userId,
        ],
      );
      if (rows.length === 1) {
        this.#recipients.delete(input.operationId);
        return true;
      }
      return false;
    } finally {
      planDigest.fill(0);
      destroyForegroundSessionPlan(plan);
    }
  }

  /** Publish the one accepted ordinary Job coordinate; exact replay is a no-op. */
  async bindJob(input: LiveShadowTurnJobBindingInput): Promise<boolean> {
    const rows = await this.#product.query(
      `/* m282_live_shadow_job_bind */
       UPDATE conversation_shadow_turn_operations AS turn
          SET job_id = COALESCE(turn.job_id, $2::uuid), updated_at = $3
         FROM sessions session_row, actors human_actor
        WHERE turn.operation_id = $1
          AND session_row.id = turn.session_id
          AND session_row.owner_id = $4::uuid
          AND human_actor.id = $5
          AND human_actor.kind = 'user'
          AND human_actor.owner_id = session_row.owner_id
          AND (turn.job_id IS NULL OR turn.job_id = $2::uuid)
      RETURNING turn.job_id`,
      [
        input.operationId,
        input.jobId,
        new Date(input.now),
        input.authority.userId,
        input.authority.humanActorId,
      ],
    );
    return rows.length === 1 && text(rows[0]!, "job_id") === input.jobId;
  }

  async #revalidateReservation(
    tx: PostgresJsBridgeExecutor,
    input: LiveShadowTurnPlanInput,
    candidate: ProductCandidate,
  ): Promise<void> {
    const rows = await tx.query(
      `/* m282_live_shadow_reservation_revalidate */
       SELECT p.mode, p.revision AS policy_revision, r.kind, r.parent_room_id,
              r.archived_at, r.namespace_id, a.id AS actor_id,
              a.kind AS actor_kind, a.owner_id, a.agent_id
         FROM encryption_transition_policy p
         JOIN rooms r ON r.id = $1::uuid
         JOIN room_members m ON m.room_id = r.id
         JOIN actors a ON a.id = m.actor_id
        WHERE p.id = 'server'
        ORDER BY a.id
        FOR SHARE OF p, r, m, a`,
      [input.roomId],
    );
    const row = rows[0];
    const humanRows = rows.filter((candidateRow) =>
      text(candidateRow, "actor_kind") === "user"
      && text(candidateRow, "actor_id") === input.authority.humanActorId
      && text(candidateRow, "owner_id") === input.authority.userId
    );
    const agentRows = rows.filter((candidateRow) =>
      text(candidateRow, "actor_kind") === "agent"
      && nullableText(candidateRow, "agent_id") === candidate.agentId
    );
    if (
      row === undefined
      || rows.length !== 2
      || !["shadow_encryption", "encrypted_only"].includes(text(row, "mode"))
      || counter(row, "policy_revision", 1) !== candidate.policyRevision
      || text(row, "kind") !== "private"
      || nullableText(row, "parent_room_id") !== null
      || row["archived_at"] !== null
      || text(row, "namespace_id") !== candidate.namespaceId
      || humanRows.length !== 1
      || agentRows.length !== 1
    ) throw new TypeError("Live Shadow reservation authority changed");
  }

  async #revalidateSharedExecution(
    tx: PostgresJsBridgeExecutor,
    input: LiveShadowTurnPlanInput,
    candidate: ProductCandidate,
    execution: Readonly<{
      executionId: string;
      topLevelRoomId: string;
      humanMessageId: number;
      humanMessageCreatedAt: number;
    }>,
  ): Promise<void> {
    const rows = await loadSharedAgentExecutionAuthoritySnapshot(tx, {
      executionId: execution.executionId,
      subjectHumanId: input.authority.humanActorId,
      subjectUserId: input.authority.userId,
      agentId: candidate.agentId,
    });
    const row = rows.length === 1 ? rows[0]! : undefined;
    if (
      row === undefined
      || text(row, "state") !== "awaiting_authorization"
      || counter(row, "policy_revision", 1) !== candidate.policyRevision
      || !["shadow_encryption", "encrypted_only"].includes(text(row, "mode"))
      || counter(row, "current_policy_revision", 1) !== candidate.policyRevision
      || text(row, "session_id") !== candidate.sessionId
      || text(row, "room_id") !== candidate.roomId
      || text(row, "agent_id") !== candidate.agentId
      || !sharedExecutionMatchesApprover(row, input)
      || !(nullableText(row, "parent_room_id") === null
        ? isProtectedTopLevelRoomKind(text(row, "kind"))
          && text(row, "top_level_room_id") === execution.topLevelRoomId
        : text(row, "kind") === "subthread"
          && nullableText(row, "parent_room_id")
            === execution.topLevelRoomId
          && text(row, "top_level_room_id") === execution.topLevelRoomId)
      || row["archived_at"] !== null
      || !isProtectedTopLevelRoomKind(text(row, "top_level_room_kind"))
      || row["top_level_room_archived_at"] !== null
      || text(row, "namespace_id") !== candidate.namespaceId
      || counter(row, "human_count", 1) < 1
      || counter(row, "agent_count", 1) < 1
      || !bool(row, "subject_current")
      || !bool(row, "agent_current")
      || !bool(row, "human_roster_current")
    ) throw new TypeError("Shared-Agent execution authority changed");
  }
}

export function createPostgresLiveShadowTurnPlanner(input: Readonly<{
  product: PostgresJsBridgeConnection;
  restricted: PostgresJsBridgeConnection;
  recipients: LiveShadowRecipientRegistry;
  serverId: string;
  resolveReadableNamespaces?: ResolveLiveShadowReadableNamespaces;
  foregroundAuthorizations?: LiveShadowForegroundAuthorizationPlanPort;
}>): PostgresLiveShadowTurnPlanner {
  return new PostgresLiveShadowTurnPlanner(
    input.product,
    input.restricted,
    new LatticeCrypto(),
    input.recipients,
    {
      serverId: input.serverId,
      ...(input.resolveReadableNamespaces === undefined
        ? {}
        : { resolveReadableNamespaces: input.resolveReadableNamespaces }),
      ...(input.foregroundAuthorizations === undefined
        ? {}
        : { foregroundAuthorizations: input.foregroundAuthorizations }),
    },
  );
}
