import { and, count as drizzleCount, eq, gte, isNull, sql } from "drizzle-orm";

import type { Database } from "../config/database";
import { artifactCryptoBlobs } from "../schema/artifact-crypto-blobs";
import { artifactCryptoOperations } from "../schema/artifact-crypto-operations";
import { artifactCryptoRevisions } from "../schema/artifact-crypto-revisions";
import { artifacts } from "../schema/artifacts";
import {
  ENCRYPTION_TRANSITION_FAMILIES,
  encryptionTransitionObservationAdmissions,
  encryptionTransitionObservationBuckets,
  encryptionTransitionOutcomeTotals,
  type EncryptionTransitionFamily,
  type EncryptionTransitionOperation,
  type EncryptionTransitionOutcome,
  type EncryptionTransitionReason,
} from "../schema/encryption-transition";
import { memories } from "../schema/memories";
import { memoryCryptoOperations } from "../schema/memory-crypto-operations";
import { memoryCryptoRevisions } from "../schema/memory-crypto-revisions";
import {
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPublications,
  reflectionRecords,
} from "../schema/reflection-records";
import { sessionMessageCryptoRevisions } from "../schema/session-message-crypto-revisions";
import { sessionMessages } from "../schema/sessions";
import {
  conversationShadowTurnOperations,
  conversationShadowTurnPlanAttempts,
} from
  "../schema/conversation-shadow-turn-operations";
import { conversationHumanPeerShadowAcknowledgements,
  conversationHumanPeerShadowOperations } from
  "../schema/conversation-human-peer-shadow-operations";
import {
  conversationSharedAgentShadowAcknowledgements,
  conversationSharedAgentShadowExecutions,
  conversationSharedAgentShadowInvocations,
  conversationSharedAgentShadowOperations,
  conversationSharedAgentShadowPlanAttempts,
} from "../schema/conversation-shared-agent-shadow-operations";

export const LIVE_SHADOW_TURN_STAGES = [
  "browser_human_prepare",
  "server_human_open_parity",
  "human_durable_mapping",
  "agent_protected_input",
  "agent_stream_frame_chain",
  "browser_stream_frame_chain",
  "assistant_tool_call_boundary",
  "tool_result_boundary",
  "transcript_durable_mappings",
  "browser_durable_transcript_parity",
  "browser_terminal_acknowledgement",
] as const;

export type LiveShadowTurnStage = typeof LIVE_SHADOW_TURN_STAGES[number];

export const LIVE_SHADOW_ENTITY_KINDS = [
  "human_message",
  "final_agent_message",
  "tool_call",
  "tool_result",
] as const;

export type LiveShadowEntityKind = typeof LIVE_SHADOW_ENTITY_KINDS[number];

export interface LiveShadowTurnStageDashboard {
  readonly stage: LiveShadowTurnStage;
  readonly verified: bigint;
  readonly eligible: bigint;
}

export interface LiveShadowTurnFallbackDashboard {
  readonly stage: string;
  readonly reason: string;
  readonly count: bigint;
}

export interface LiveShadowEntityDashboard {
  readonly entity: LiveShadowEntityKind;
  readonly verified: bigint;
  readonly eligible: bigint;
}

export interface LiveShadowTurnDashboard {
  readonly eligibleTurns: bigint;
  readonly completeRoundTrips: bigint;
  readonly pendingTurns: bigint;
  readonly oldestPendingAt: Date | null;
  readonly stages: readonly LiveShadowTurnStageDashboard[];
  readonly entities: readonly LiveShadowEntityDashboard[];
  readonly fallbacks: readonly LiveShadowTurnFallbackDashboard[];
}

export interface HumanPeerLiveShadowDashboard {
  readonly eligibleWrites: bigint;
  readonly publishedWrites: bigint;
  readonly pendingWrites: bigint;
  readonly fallbackWrites: bigint;
  readonly failedWrites: bigint;
  readonly recipientReadAttempts: bigint;
  readonly recipientReadVerified: bigint;
  readonly recipientReadFallback: bigint;
}

export interface SharedAgentLiveShadowDashboard
  extends HumanPeerLiveShadowDashboard {
  readonly participantHumanOpportunities: bigint;
  readonly protectedParticipantHumanOpportunities: bigint;
  readonly plaintextParticipantHumanOpportunities: bigint;
  readonly protectedRecipientDeviceOpportunities: bigint;
  readonly planningUnavailable: bigint;
  readonly planningDeviceUnavailable: bigint;
  readonly planningNamespaceUnavailable: bigint;
  readonly planningRecipientSyncRequired: bigint;
  readonly agentRecipientReadAttempts: bigint;
  readonly agentRecipientReadVerified: bigint;
  readonly agentRecipientReadFallback: bigint;
  readonly conductorAwaitingUser: bigint;
  readonly conductorNotSelected: bigint;
  readonly conductorSelected: bigint;
  readonly conductorUnavailable: bigint;
  readonly conductorInvocationsEligible: bigint;
  readonly conductorInvocationsAwaitingAuthorization: bigint;
  readonly conductorAuthorizationEstablished: bigint;
  readonly conductorAuthorizationReused: bigint;
  readonly conductorCurrentInputVerified: bigint;
  readonly conductorRouteDeterministic: bigint;
  readonly conductorRouteFloorManager: bigint;
  readonly conductorHistoryNotRequested: bigint;
  readonly conductorHistoryVerified: bigint;
  readonly conductorHistoryUnavailable: bigint;
  readonly conductorVerifiedWake: bigint;
  readonly conductorVerifiedAwaitingUser: bigint;
  readonly conductorVerifiedSilent: bigint;
  readonly conductorFallback: bigint;
  readonly conductorSelectedAgentExecutions: bigint;
  readonly conductorFallbackReasons: readonly Readonly<{
    reason: string;
    count: bigint;
  }>[];
  readonly executionsAwaitingAuthorization: bigint;
  readonly executionsAuthorized: bigint;
  readonly executionsRunning: bigint;
  readonly executionsCompleted: bigint;
  readonly executionsFallback: bigint;
  readonly executionsFailed: bigint;
  readonly protectedExecutionInputs: bigint;
  readonly resumeExecutions: bigint;
  readonly resumesAwaitingAuthorization: bigint;
  readonly resumesAuthorized: bigint;
  readonly resumesRunning: bigint;
  readonly resumesCompleted: bigint;
  readonly resumesFallback: bigint;
  readonly resumesFailed: bigint;
  readonly authorizationEstablished: bigint;
  readonly authorizationReused: bigint;
  readonly authorizationUnavailable: bigint;
  readonly authorizationExpired: bigint;
  readonly authorizationRevoked: bigint;
  readonly streamStarted: bigint;
  readonly streamCompleted: bigint;
  readonly assistantPublished: bigint;
  /** Canonical mapped role=tool result rows; not ordinary assistant tool_calls. */
  readonly toolResultsPublished: bigint;
}

/** Content-free current-state totals for M301's V2 Domain authority. */
export interface DomainKeyCatchUpDashboard {
  readonly requested: bigint;
  readonly waiting: bigint;
  readonly delivered: bigint;
  readonly acknowledged: bigint;
  readonly stale: bigint;
  readonly expired: bigint;
  readonly unrecoverable: bigint;
  readonly humanDomainHeads: bigint;
  readonly aiDomainHeads: bigint;
  readonly humanNamespaceBundles: bigint;
  readonly aiNamespaceBundles: bigint;
  readonly humanNamespaceBundleAdvances: bigint;
  readonly aiNamespaceBundleAdvances: bigint;
}

export interface EncryptionTransitionAttemptRow {
  readonly family: EncryptionTransitionFamily;
  readonly operation: EncryptionTransitionOperation;
  readonly outcome: EncryptionTransitionOutcome;
  readonly reason: EncryptionTransitionReason;
  readonly count: bigint;
}

export interface EncryptionTransitionCoverageRow {
  readonly family: EncryptionTransitionFamily;
  readonly verified: bigint;
  readonly total: bigint;
  readonly touchedVerified?: bigint;
  readonly touchedTotal?: bigint;
}

export interface EncryptionTransitionPendingRow {
  readonly family: EncryptionTransitionFamily;
  readonly pending: bigint;
  readonly oldestPendingAt: Date | null;
}

export interface EncryptionTransitionFamilyDashboard {
  readonly family: EncryptionTransitionFamily | "overall";
  readonly eligibleAttempts: bigint;
  readonly verifiedAttempts: bigint;
  readonly coveredObjects: bigint;
  readonly totalObjects: bigint;
  readonly touchedCoveredObjects: bigint;
  readonly touchedObjects: bigint;
  readonly pendingLifecycleOperations: bigint;
  readonly oldestPendingAt: Date | null;
  readonly outcomes: readonly Omit<EncryptionTransitionAttemptRow, "family">[];
  /** M275 — history reads are a distinct denominator from write attempts. */
  readonly historyReadOutcomes:
    readonly Omit<EncryptionTransitionAttemptRow, "family">[];
}

export interface EncryptionTransitionObservationPressure {
  readonly retainedRows: bigint;
  readonly capacityRows: bigint;
  readonly pendingAdmissions: bigint;
  readonly admissionCapacity: bigint;
  readonly maximumRetentionMs: number;
}

function toCount(raw: string | null | undefined, label: string): bigint {
  if (raw === undefined || raw === null || !/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`Invalid encryption transition aggregate: ${label}`);
  }
  return BigInt(raw);
}

function toOptionalDate(raw: Date | string | null | undefined, label: string): Date | null {
  if (raw === undefined || raw === null) return null;
  const value = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid encryption transition aggregate: ${label}`);
  }
  return value;
}

export function assembleEncryptionTransitionDashboard(input: Readonly<{
  attemptRows: readonly EncryptionTransitionAttemptRow[];
  coverageRows: readonly EncryptionTransitionCoverageRow[];
  pendingRows?: readonly EncryptionTransitionPendingRow[];
}>): readonly EncryptionTransitionFamilyDashboard[] {
  const coverageByFamily = new Map<
    EncryptionTransitionFamily,
    EncryptionTransitionCoverageRow
  >();
  for (const row of input.coverageRows) {
    if (coverageByFamily.has(row.family)) {
      throw new Error(`Duplicate encryption coverage family: ${row.family}`);
    }
    const touchedVerified = row.touchedVerified ?? 0n;
    const touchedTotal = row.touchedTotal ?? 0n;
    if (row.verified < 0n || row.total < 0n || row.verified > row.total
      || touchedVerified < 0n || touchedTotal < 0n
      || touchedVerified > touchedTotal) {
      throw new Error(`Invalid encryption coverage counts: ${row.family}`);
    }
    coverageByFamily.set(row.family, row);
  }
  const pendingByFamily = new Map(
    (input.pendingRows ?? []).map((row) => [row.family, row] as const),
  );

  const families = ENCRYPTION_TRANSITION_FAMILIES.map((family) => {
    const familyAttempts = input.attemptRows.filter((row) => row.family === family);
    const outcomes = familyAttempts
      .filter((row) => row.operation !== "read")
      .map(({ family: _family, ...row }) => row);
    const historyReadOutcomes = familyAttempts
      .filter((row) => row.operation === "read")
      .map(({ family: _family, ...row }) => row);
    const eligibleAttempts = outcomes.reduce((sum, row) => sum + row.count, 0n);
    const verifiedAttempts = outcomes.reduce(
      (sum, row) => row.outcome === "verified" ? sum + row.count : sum,
      0n,
    );
    const coverage = coverageByFamily.get(family);
    if (!coverage) throw new Error(`Missing encryption coverage family: ${family}`);
    return {
      family,
      eligibleAttempts,
      verifiedAttempts,
      coveredObjects: coverage.verified,
      totalObjects: coverage.total,
      touchedCoveredObjects: coverage.touchedVerified ?? 0n,
      touchedObjects: coverage.touchedTotal ?? 0n,
      pendingLifecycleOperations: pendingByFamily.get(family)?.pending ?? 0n,
      oldestPendingAt: pendingByFamily.get(family)?.oldestPendingAt ?? null,
      outcomes,
      historyReadOutcomes,
    } satisfies EncryptionTransitionFamilyDashboard;
  });
  return [
    ...families,
    {
      family: "overall",
      eligibleAttempts: families.reduce(
        (sum, row) => sum + row.eligibleAttempts,
        0n,
      ),
      verifiedAttempts: families.reduce(
        (sum, row) => sum + row.verifiedAttempts,
        0n,
      ),
      coveredObjects: families.reduce((sum, row) => sum + row.coveredObjects, 0n),
      totalObjects: families.reduce((sum, row) => sum + row.totalObjects, 0n),
      touchedCoveredObjects: families.reduce(
        (sum, row) => sum + row.touchedCoveredObjects,
        0n,
      ),
      touchedObjects: families.reduce((sum, row) => sum + row.touchedObjects, 0n),
      pendingLifecycleOperations: families.reduce(
        (sum, row) => sum + row.pendingLifecycleOperations,
        0n,
      ),
      oldestPendingAt: families.reduce<Date | null>((oldest, row) => {
        if (row.oldestPendingAt === null) return oldest;
        return oldest === null || row.oldestPendingAt < oldest
          ? row.oldestPendingAt
          : oldest;
      }, null),
      outcomes: [],
      historyReadOutcomes: families.flatMap((row) =>
        row.historyReadOutcomes
      ),
    },
  ];
}

export type EncryptionTransitionDashboardDb = Pick<Database, "select" | "execute">;

// These aliases belong to the existing lifecycle subqueries below. Full proves
// authenticated content, not comparison with an ordinary sibling.
const completedMessageRepresentation = sql`(
  (revision.representation_mode = 'shadow_encryption'
    and revision.parity_status in ('server_verified', 'client_verified'))
  or (revision.representation_mode = 'full_encryption'
    and revision.parity_status in ('server_authenticated', 'client_authenticated'))
)`;

export async function readLiveShadowTurnDashboard(
  db: EncryptionTransitionDashboardDb,
  shadowEpoch: Readonly<{
    revision: number;
    shadowEncryptionStartedAt: Date | null;
  }>,
): Promise<LiveShadowTurnDashboard> {
  if (shadowEpoch.shadowEncryptionStartedAt === null) {
    return Object.freeze({
      eligibleTurns: 0n,
      completeRoundTrips: 0n,
      pendingTurns: 0n,
      oldestPendingAt: null,
      stages: Object.freeze(LIVE_SHADOW_TURN_STAGES.map((stage) =>
        Object.freeze({ stage, verified: 0n, eligible: 0n })
      )),
      entities: Object.freeze(LIVE_SHADOW_ENTITY_KINDS.map((entity) =>
        Object.freeze({ entity, verified: 0n, eligible: 0n })
      )),
      fallbacks: Object.freeze([]),
    });
  }
  const revision = shadowEpoch.revision;
  const humanVerified = sql`exists (
    select 1 from ${sessionMessageCryptoRevisions} revision
     where revision.shadow_operation_id =
       ${conversationShadowTurnOperations.operationId}
       and revision.shadow_transcript_ordinal = 1
       and revision.author_role = 'user'
       and revision.completion = 'complete'
       and revision.disposition = 'mapped'
       and ${completedMessageRepresentation}
  )`;
  const streamApplicable = sql`exists (
    select 1 from ${sessionMessageCryptoRevisions} revision
     where revision.shadow_operation_id =
       ${conversationShadowTurnOperations.operationId}
       and revision.author_role = 'assistant'
       and revision.shadow_stream_id is not null
  )`;
  const streamVerified = sql`${streamApplicable} and not exists (
    select 1 from ${sessionMessageCryptoRevisions} revision
     where revision.shadow_operation_id =
       ${conversationShadowTurnOperations.operationId}
       and revision.author_role = 'assistant'
       and revision.shadow_stream_id is not null
       and not (
         revision.completion = 'complete'
         and revision.disposition = 'mapped'
         and ${completedMessageRepresentation}
         and revision.shadow_stream_start_digest is not null
         and revision.shadow_stream_terminal_digest is not null
         and revision.shadow_streamed_text_digest is not null
       )
  )`;
  const toolCallApplicable = sql`exists (
    select 1 from ${sessionMessageCryptoRevisions} revision
    join ${sessionMessages} message
      on message.session_id = revision.session_id
     and message.id = revision.message_id
     and message.edit_revision = revision.edit_revision
   where revision.shadow_operation_id =
     ${conversationShadowTurnOperations.operationId}
     and revision.author_role = 'assistant'
     and message.tool_calls is not null
  )`;
  const toolCallVerified = sql`${toolCallApplicable} and not exists (
    select 1 from ${sessionMessageCryptoRevisions} revision
    join ${sessionMessages} message
      on message.session_id = revision.session_id
     and message.id = revision.message_id
     and message.edit_revision = revision.edit_revision
   where revision.shadow_operation_id =
     ${conversationShadowTurnOperations.operationId}
     and revision.author_role = 'assistant'
     and message.tool_calls is not null
     and not (
       revision.completion = 'complete'
       and revision.disposition = 'mapped'
       and ${completedMessageRepresentation}
     )
  )`;
  const toolResultApplicable = sql`exists (
    select 1 from ${sessionMessageCryptoRevisions} revision
   where revision.shadow_operation_id =
     ${conversationShadowTurnOperations.operationId}
     and revision.author_role = 'tool'
  )`;
  const toolResultVerified = sql`${toolResultApplicable} and not exists (
    select 1 from ${sessionMessageCryptoRevisions} revision
   where revision.shadow_operation_id =
     ${conversationShadowTurnOperations.operationId}
     and revision.author_role = 'tool'
     and not (
       revision.completion = 'complete'
       and revision.disposition = 'mapped'
       and ${completedMessageRepresentation}
     )
  )`;
  const [summary] = await db.select({
    eligible: sql<string>`count(*)::text`,
    complete: sql<string>`count(*) filter (where
      ${conversationShadowTurnOperations.state} = 'client_verified')::text`,
    pending: sql<string>`count(*) filter (where
      ${conversationShadowTurnPlanAttempts.state} = 'checking'
      or ${conversationShadowTurnOperations.state} in
        ('planned', 'human_verified', 'running', 'completed'))::text`,
    oldest: sql<Date | string | null>`min(
      ${conversationShadowTurnPlanAttempts.createdAt}
    ) filter (where ${conversationShadowTurnPlanAttempts.state} = 'checking'
      or ${conversationShadowTurnOperations.state} in
        ('planned', 'human_verified', 'running', 'completed'))`,
    browserPrepare: sql<string>`count(*) filter (where
      ${conversationShadowTurnOperations.humanRequestDigest} is not null)::text`,
    humanVerified: sql<string>`count(*) filter (where ${humanVerified})::text`,
    agentInput: sql<string>`count(*) filter (where
      ${conversationShadowTurnOperations.startedAt} is not null)::text`,
    streamVerified: sql<string>`count(*) filter (where ${streamVerified})::text`,
    toolCallEligible: sql<string>`count(*) filter (where ${toolCallApplicable})::text`,
    toolCallVerified: sql<string>`count(*) filter (where ${toolCallVerified})::text`,
    toolResultEligible: sql<string>`count(*) filter (where ${toolResultApplicable})::text`,
    toolResultVerified: sql<string>`count(*) filter (where ${toolResultVerified})::text`,
    transcriptVerified: sql<string>`count(*) filter (where
      ${conversationShadowTurnOperations.state} in
        ('completed', 'client_verified'))::text`,
  }).from(conversationShadowTurnPlanAttempts).leftJoin(
    conversationShadowTurnOperations,
    eq(
      conversationShadowTurnPlanAttempts.operationId,
      conversationShadowTurnOperations.operationId,
    ),
  ).where(eq(
    conversationShadowTurnPlanAttempts.policyRevision,
    revision,
  ));
  if (summary === undefined) {
    throw new Error("Live Shadow turn aggregate is unavailable");
  }
  const eligible = toCount(summary.eligible, "eligible live Shadow turns");
  const complete = toCount(summary.complete, "complete live Shadow turns");
  const human = toCount(summary.humanVerified, "verified Human turns");
  const transcript = toCount(
    summary.transcriptVerified,
    "verified transcript turns",
  );
  const stages = Object.freeze([
    { stage: "browser_human_prepare", verified: toCount(summary.browserPrepare,
      "Browser prepared turns"), eligible },
    { stage: "server_human_open_parity", verified: human, eligible },
    { stage: "human_durable_mapping", verified: human, eligible },
    { stage: "agent_protected_input", verified: toCount(summary.agentInput,
      "Agent protected input turns"), eligible },
    { stage: "agent_stream_frame_chain", verified: toCount(summary.streamVerified,
      "Agent stream turns"), eligible },
    { stage: "browser_stream_frame_chain", verified: complete, eligible },
    { stage: "assistant_tool_call_boundary", verified: toCount(
      summary.toolCallVerified, "verified tool-call turns"), eligible: toCount(
        summary.toolCallEligible, "eligible tool-call turns") },
    { stage: "tool_result_boundary", verified: toCount(
      summary.toolResultVerified, "verified tool-result turns"), eligible: toCount(
        summary.toolResultEligible, "eligible tool-result turns") },
    { stage: "transcript_durable_mappings", verified: transcript, eligible },
    { stage: "browser_durable_transcript_parity", verified: complete, eligible },
    { stage: "browser_terminal_acknowledgement", verified: complete, eligible },
  ] satisfies readonly LiveShadowTurnStageDashboard[]);
  const entityRows = await db.execute(sql`
    with lifecycle as (
      select revision.shadow_operation_id,
             revision.author_role,
             revision.shadow_stream_id,
             message.tool_calls,
             (
               revision.completion = 'complete'
               and revision.disposition = 'mapped'
               and ${completedMessageRepresentation}
             ) as verified
        from ${sessionMessageCryptoRevisions} revision
        join ${sessionMessages} message
          on message.session_id = revision.session_id
         and message.id = revision.message_id
         and message.edit_revision = revision.edit_revision
        join ${conversationShadowTurnOperations} turn_operation
          on turn_operation.operation_id = revision.shadow_operation_id
        join ${conversationShadowTurnPlanAttempts} plan_attempt
          on plan_attempt.operation_id = turn_operation.operation_id
       where plan_attempt.policy_revision = ${revision}
    ), tool_call_entities as (
      select lifecycle.shadow_operation_id,
             call.value ->> 'id' as call_id,
             bool_and(lifecycle.verified) as verified
        from lifecycle
        cross join lateral jsonb_array_elements(
          coalesce(lifecycle.tool_calls, '[]')::jsonb
        ) call(value)
       where lifecycle.author_role = 'assistant'
         and nullif(call.value ->> 'id', '') is not null
       group by lifecycle.shadow_operation_id, call.value ->> 'id'
    )
    select
      count(*) filter (where author_role = 'user')::text as human_eligible,
      count(*) filter (where author_role = 'user' and verified)::text
        as human_verified,
      count(*) filter (where author_role = 'assistant'
        and shadow_stream_id is not null)::text as agent_eligible,
      count(*) filter (where author_role = 'assistant'
        and shadow_stream_id is not null and verified)::text as agent_verified,
      count(*) filter (where author_role = 'tool')::text as result_eligible,
      count(*) filter (where author_role = 'tool' and verified)::text
        as result_verified,
      (select count(*)::text from tool_call_entities) as call_eligible,
      (select count(*) filter (where verified)::text from tool_call_entities)
        as call_verified
    from lifecycle
  `) as unknown as readonly Record<string, unknown>[];
  if (entityRows.length !== 1) {
    throw new Error("Live Shadow entity aggregate is unavailable");
  }
  const entityRow = entityRows[0]!;
  const entityCount = (key: string, label: string): bigint => {
    const raw = entityRow[key];
    return toCount(typeof raw === "string" ? raw : undefined, label);
  };
  const entities = Object.freeze([
    Object.freeze({ entity: "human_message" as const,
      verified: entityCount("human_verified", "verified Human Messages"),
      eligible: entityCount("human_eligible", "eligible Human Messages") }),
    Object.freeze({ entity: "final_agent_message" as const,
      verified: entityCount("agent_verified", "verified final Agent Messages"),
      eligible: entityCount("agent_eligible", "eligible final Agent Messages") }),
    Object.freeze({ entity: "tool_call" as const,
      verified: entityCount("call_verified", "verified Tool Calls"),
      eligible: entityCount("call_eligible", "eligible Tool Calls") }),
    Object.freeze({ entity: "tool_result" as const,
      verified: entityCount("result_verified", "verified Tool Results"),
      eligible: entityCount("result_eligible", "eligible Tool Results") }),
  ] satisfies readonly LiveShadowEntityDashboard[]);
  const fallbackStage = sql<string | null>`case
    when ${conversationShadowTurnPlanAttempts.state} = 'unavailable'
      then 'plan'
    else ${conversationShadowTurnOperations.terminalStage}
  end`;
  const fallbackReason = sql<string | null>`case
    when ${conversationShadowTurnPlanAttempts.state} = 'unavailable'
      then ${conversationShadowTurnPlanAttempts.unavailableReason}
    else ${conversationShadowTurnOperations.terminalReason}
  end`;
  const rawFallbacks = await db.select({
    stage: fallbackStage,
    reason: fallbackReason,
    count: sql<string>`count(*)::text`,
  }).from(conversationShadowTurnPlanAttempts).leftJoin(
    conversationShadowTurnOperations,
    eq(
      conversationShadowTurnPlanAttempts.operationId,
      conversationShadowTurnOperations.operationId,
    ),
  ).where(and(
    eq(conversationShadowTurnPlanAttempts.policyRevision, revision),
    sql`${conversationShadowTurnPlanAttempts.state} = 'unavailable'
      or ${conversationShadowTurnOperations.state} in ('fallback', 'failed')`,
  )).groupBy(
    fallbackStage,
    fallbackReason,
  );
  return Object.freeze({
    eligibleTurns: eligible,
    completeRoundTrips: complete,
    pendingTurns: toCount(summary.pending, "pending live Shadow turns"),
    oldestPendingAt: toOptionalDate(summary.oldest, "oldest live Shadow turn"),
    stages,
    entities,
    fallbacks: Object.freeze(rawFallbacks.map((row) => {
      if (row.stage === null || row.reason === null) {
        throw new Error("Live Shadow fallback aggregate is incomplete");
      }
      return Object.freeze({
        stage: row.stage,
        reason: row.reason,
        count: toCount(row.count, "live Shadow fallback count"),
      });
    })),
  });
}

/** M295 — distinct Human-only write and per-device live-read denominators. */
export async function readHumanPeerLiveShadowDashboard(
  db: EncryptionTransitionDashboardDb,
  shadowEpoch: Readonly<{
    revision: number;
    shadowEncryptionStartedAt: Date | null;
  }>,
): Promise<HumanPeerLiveShadowDashboard> {
  if (shadowEpoch.shadowEncryptionStartedAt === null) {
    return Object.freeze({
      eligibleWrites: 0n,
      publishedWrites: 0n,
      pendingWrites: 0n,
      fallbackWrites: 0n,
      failedWrites: 0n,
      recipientReadAttempts: 0n,
      recipientReadVerified: 0n,
      recipientReadFallback: 0n,
    });
  }
  const rows = await db.select({
    eligible_writes: sql<string>`count(distinct ${conversationHumanPeerShadowOperations.sequence})::text`,
    published_writes: sql<string>`count(distinct ${conversationHumanPeerShadowOperations.sequence}) filter (where ${conversationHumanPeerShadowOperations.state} = 'published')::text`,
    pending_writes: sql<string>`count(distinct ${conversationHumanPeerShadowOperations.sequence}) filter (where ${conversationHumanPeerShadowOperations.state} in ('planned', 'human_verified'))::text`,
    fallback_writes: sql<string>`count(distinct ${conversationHumanPeerShadowOperations.sequence}) filter (where ${conversationHumanPeerShadowOperations.state} = 'fallback')::text`,
    failed_writes: sql<string>`count(distinct ${conversationHumanPeerShadowOperations.sequence}) filter (where ${conversationHumanPeerShadowOperations.state} = 'failed')::text`,
    recipient_read_attempts: sql<string>`count(${conversationHumanPeerShadowAcknowledgements.sequence})::text`,
    recipient_read_verified: sql<string>`count(${conversationHumanPeerShadowAcknowledgements.sequence}) filter (where ${conversationHumanPeerShadowAcknowledgements.status} = 'verified')::text`,
    recipient_read_fallback: sql<string>`count(${conversationHumanPeerShadowAcknowledgements.sequence}) filter (where ${conversationHumanPeerShadowAcknowledgements.status} = 'fallback')::text`,
  }).from(conversationHumanPeerShadowOperations).leftJoin(
    conversationHumanPeerShadowAcknowledgements,
    eq(conversationHumanPeerShadowAcknowledgements.operationId,
      conversationHumanPeerShadowOperations.operationId),
  ).where(and(
    eq(conversationHumanPeerShadowOperations.policyRevision,
      shadowEpoch.revision),
    gte(conversationHumanPeerShadowOperations.createdAt,
      shadowEpoch.shadowEncryptionStartedAt),
  ));
  if (rows.length !== 1) {
    throw new Error("Human-peer live Shadow aggregate is unavailable");
  }
  const row: Record<string, unknown> = rows[0]!;
  const count = (key: string, label: string): bigint => {
    const value = row[key];
    return toCount(typeof value === "string" ? value : undefined, label);
  };
  return Object.freeze({
    eligibleWrites: count("eligible_writes", "eligible Human-peer writes"),
    publishedWrites: count("published_writes", "published Human-peer writes"),
    pendingWrites: count("pending_writes", "pending Human-peer writes"),
    fallbackWrites: count("fallback_writes", "fallback Human-peer writes"),
    failedWrites: count("failed_writes", "failed Human-peer writes"),
    recipientReadAttempts: count(
      "recipient_read_attempts",
      "Human-peer recipient reads",
    ),
    recipientReadVerified: count(
      "recipient_read_verified",
      "verified Human-peer recipient reads",
    ),
    recipientReadFallback: count(
      "recipient_read_fallback",
      "fallback Human-peer recipient reads",
    ),
  });
}

/** M296 — XH1A Human writes, per-device reads, Conductor, and execution truth. */
export async function readSharedAgentLiveShadowDashboard(
  db: EncryptionTransitionDashboardDb,
  shadowEpoch: Readonly<{
    revision: number;
    shadowEncryptionStartedAt: Date | null;
  }>,
): Promise<SharedAgentLiveShadowDashboard> {
  const zero = Object.freeze({
    eligibleWrites: 0n, publishedWrites: 0n, pendingWrites: 0n,
    fallbackWrites: 0n, failedWrites: 0n, recipientReadAttempts: 0n,
    recipientReadVerified: 0n, recipientReadFallback: 0n,
    participantHumanOpportunities: 0n,
    protectedParticipantHumanOpportunities: 0n,
    plaintextParticipantHumanOpportunities: 0n,
    protectedRecipientDeviceOpportunities: 0n,
    planningUnavailable: 0n, planningDeviceUnavailable: 0n,
    planningNamespaceUnavailable: 0n, planningRecipientSyncRequired: 0n,
    agentRecipientReadAttempts: 0n, agentRecipientReadVerified: 0n,
    agentRecipientReadFallback: 0n,
    conductorAwaitingUser: 0n, conductorNotSelected: 0n,
    conductorSelected: 0n, conductorUnavailable: 0n,
    conductorInvocationsEligible: 0n,
    conductorInvocationsAwaitingAuthorization: 0n,
    conductorAuthorizationEstablished: 0n,
    conductorAuthorizationReused: 0n,
    conductorCurrentInputVerified: 0n,
    conductorRouteDeterministic: 0n,
    conductorRouteFloorManager: 0n,
    conductorHistoryNotRequested: 0n,
    conductorHistoryVerified: 0n,
    conductorHistoryUnavailable: 0n,
    conductorVerifiedWake: 0n,
    conductorVerifiedAwaitingUser: 0n,
    conductorVerifiedSilent: 0n,
    conductorFallback: 0n,
    conductorSelectedAgentExecutions: 0n,
    conductorFallbackReasons: Object.freeze([]),
    executionsAwaitingAuthorization: 0n, executionsAuthorized: 0n,
    executionsRunning: 0n, executionsCompleted: 0n,
    executionsFallback: 0n, executionsFailed: 0n,
    protectedExecutionInputs: 0n,
    resumeExecutions: 0n, resumesAwaitingAuthorization: 0n,
    resumesAuthorized: 0n, resumesRunning: 0n, resumesCompleted: 0n,
    resumesFallback: 0n, resumesFailed: 0n,
    authorizationEstablished: 0n, authorizationReused: 0n,
    authorizationUnavailable: 0n, authorizationExpired: 0n,
    authorizationRevoked: 0n, streamStarted: 0n, streamCompleted: 0n,
    assistantPublished: 0n, toolResultsPublished: 0n,
  });
  if (shadowEpoch.shadowEncryptionStartedAt === null) return zero;
  const rows = await db.select({
    eligible_writes: sql<string>`count(distinct ${conversationSharedAgentShadowOperations.sequence})::text`,
    published_writes: sql<string>`count(distinct ${conversationSharedAgentShadowOperations.sequence}) filter (where ${conversationSharedAgentShadowOperations.state} = 'published')::text`,
    pending_writes: sql<string>`count(distinct ${conversationSharedAgentShadowOperations.sequence}) filter (where ${conversationSharedAgentShadowOperations.state} in ('planned', 'human_verified'))::text`,
    fallback_writes: sql<string>`count(distinct ${conversationSharedAgentShadowOperations.sequence}) filter (where ${conversationSharedAgentShadowOperations.state} = 'fallback')::text`,
    failed_writes: sql<string>`count(distinct ${conversationSharedAgentShadowOperations.sequence}) filter (where ${conversationSharedAgentShadowOperations.state} = 'failed')::text`,
    recipient_read_attempts: sql<string>`count(distinct ${conversationSharedAgentShadowAcknowledgements.sequence})::text`,
    recipient_read_verified: sql<string>`count(distinct ${conversationSharedAgentShadowAcknowledgements.sequence}) filter (where ${conversationSharedAgentShadowAcknowledgements.status} = 'verified')::text`,
    recipient_read_fallback: sql<string>`count(distinct ${conversationSharedAgentShadowAcknowledgements.sequence}) filter (where ${conversationSharedAgentShadowAcknowledgements.status} = 'fallback')::text`,
    conductor_awaiting_user: sql<string>`count(distinct ${conversationSharedAgentShadowOperations.sequence}) filter (where ${conversationSharedAgentShadowOperations.conductorState} = 'awaiting_user')::text`,
    conductor_not_selected: sql<string>`count(distinct ${conversationSharedAgentShadowOperations.sequence}) filter (where ${conversationSharedAgentShadowOperations.conductorState} = 'not_selected')::text`,
    conductor_selected: sql<string>`count(distinct ${conversationSharedAgentShadowOperations.sequence}) filter (where ${conversationSharedAgentShadowOperations.conductorState} = 'selected')::text`,
    conductor_unavailable: sql<string>`count(distinct ${conversationSharedAgentShadowOperations.sequence}) filter (where ${conversationSharedAgentShadowOperations.conductorState} = 'unavailable')::text`,
  }).from(conversationSharedAgentShadowOperations).leftJoin(
    conversationSharedAgentShadowAcknowledgements,
    and(
      eq(conversationSharedAgentShadowAcknowledgements.operationId,
        conversationSharedAgentShadowOperations.operationId),
      eq(conversationSharedAgentShadowAcknowledgements.operationKind,
        "human_message"),
    ),
  ).where(and(
    eq(conversationSharedAgentShadowOperations.policyRevision,
      shadowEpoch.revision),
    gte(conversationSharedAgentShadowOperations.createdAt,
      shadowEpoch.shadowEncryptionStartedAt),
  ));
  const executions = await db.select({
      awaiting_authorization: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.state} = 'awaiting_authorization')::text`,
      authorized: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.state} = 'authorized')::text`,
      running: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.state} = 'running')::text`,
      completed: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.state} = 'completed')::text`,
      fallback: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.state} = 'fallback')::text`,
      failed: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.state} = 'failed')::text`,
      protected_inputs: sql<string>`coalesce(sum(${conversationSharedAgentShadowExecutions.inputCount}), 0)::text`,
      resume_executions: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.executionKind} = 'resume')::text`,
      resumes_awaiting_authorization: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.executionKind} = 'resume' and ${conversationSharedAgentShadowExecutions.state} = 'awaiting_authorization')::text`,
      resumes_authorized: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.executionKind} = 'resume' and ${conversationSharedAgentShadowExecutions.state} = 'authorized')::text`,
      resumes_running: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.executionKind} = 'resume' and ${conversationSharedAgentShadowExecutions.state} = 'running')::text`,
      resumes_completed: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.executionKind} = 'resume' and ${conversationSharedAgentShadowExecutions.state} = 'completed')::text`,
      resumes_fallback: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.executionKind} = 'resume' and ${conversationSharedAgentShadowExecutions.state} = 'fallback')::text`,
      resumes_failed: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.executionKind} = 'resume' and ${conversationSharedAgentShadowExecutions.state} = 'failed')::text`,
      authorization_established: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.invocationId} is null and ${conversationSharedAgentShadowExecutions.authorizationDisposition} = 'establish')::text`,
      authorization_reused: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.invocationId} is null and ${conversationSharedAgentShadowExecutions.authorizationDisposition} = 'reuse')::text`,
      authorization_unavailable: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.invocationId} is null and ${conversationSharedAgentShadowExecutions.state} in ('fallback', 'failed') and ${conversationSharedAgentShadowExecutions.authorizationDisposition} is null)::text`,
      authorization_expired: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.invocationId} is null and ${conversationSharedAgentShadowExecutions.terminalReason} = 'authorization_expired')::text`,
      authorization_revoked: sql<string>`count(*) filter (where ${conversationSharedAgentShadowExecutions.invocationId} is null and ${conversationSharedAgentShadowExecutions.terminalReason} = 'authorization_revoked')::text`,
    }).from(conversationSharedAgentShadowExecutions).where(and(
      gte(conversationSharedAgentShadowExecutions.createdAt,
        shadowEpoch.shadowEncryptionStartedAt),
      eq(conversationSharedAgentShadowExecutions.policyRevision,
        shadowEpoch.revision),
    ));
  const invocationAuthorizations = await db.select({
    disposition:
      conversationSharedAgentShadowInvocations.authorizationDisposition,
    state: conversationSharedAgentShadowInvocations.state,
    terminalReason: conversationSharedAgentShadowInvocations.terminalReason,
    total: drizzleCount(),
  }).from(conversationSharedAgentShadowInvocations).where(and(
    gte(
      conversationSharedAgentShadowInvocations.createdAt,
      shadowEpoch.shadowEncryptionStartedAt,
    ),
    eq(
      conversationSharedAgentShadowInvocations.policyRevision,
      shadowEpoch.revision,
    ),
  )).groupBy(
    conversationSharedAgentShadowInvocations.authorizationDisposition,
    conversationSharedAgentShadowInvocations.state,
    conversationSharedAgentShadowInvocations.terminalReason,
  );
  const conductorInvocations = await db.execute(sql`
    select
      count(*)::text as eligible,
      count(*) filter (where invocation.state = 'awaiting_authorization')::text
        as awaiting_authorization,
      count(*) filter
        (where invocation.authorization_disposition = 'establish')::text
        as authorization_established,
      count(*) filter
        (where invocation.authorization_disposition = 'reuse')::text
        as authorization_reused,
      count(*) filter
        (where invocation.terminal_reason like 'conductor_verified_%'
          or invocation.terminal_reason like 'conductor_fallback_history_%'
          or invocation.terminal_reason like 'conductor_fallback_routing_%'
          or invocation.terminal_reason like
            'conductor_fallback_agent_attachment_%')::text
        as current_input_verified,
      count(*) filter
        (where invocation.terminal_reason like
          'conductor_verified_deterministic_%')::text
        as route_deterministic,
      count(*) filter
        (where invocation.terminal_reason like
          'conductor_verified_floor_manager_%')::text
        as route_floor_manager,
      count(*) filter
        (where invocation.terminal_reason like
          'conductor_verified_%_history_not_requested_%')::text
        as history_not_requested,
      count(*) filter
        (where invocation.terminal_reason like
          'conductor_verified_%_history_verified_%')::text
        as history_verified,
      count(*) filter
        (where invocation.terminal_reason like
          'conductor_fallback_history_%')::text
        as history_unavailable,
      count(*) filter
        (where invocation.terminal_reason like
          'conductor_verified_%_wake')::text as verified_wake,
      count(*) filter
        (where invocation.terminal_reason like
          'conductor_verified_%_ask_user')::text as verified_awaiting_user,
      count(*) filter
        (where invocation.terminal_reason like
          'conductor_verified_%_silent')::text as verified_silent,
      count(*) filter (where invocation.state = 'fallback')::text as fallback,
      coalesce(sum((
        select count(distinct execution.execution_id)
          from conversation_shared_agent_shadow_executions execution
          join conversation_shared_agent_shadow_invocations agent_invocation
            on agent_invocation.invocation_id = execution.invocation_id
         where agent_invocation.policy_revision = invocation.policy_revision
           and agent_invocation.session_id = invocation.session_id
           and agent_invocation.room_id = invocation.room_id
           and agent_invocation.invoking_human_id
             = invocation.invoking_human_id
           and agent_invocation.invoking_device_id
             = invocation.invoking_device_id
           and agent_invocation.client_action_session_id
             = invocation.client_action_session_id
           and agent_invocation.input_count = invocation.input_count
           and agent_invocation.input_set_digest = invocation.input_set_digest
      )), 0)::text as selected_agent_executions
      from conversation_shared_agent_shadow_invocations invocation
     where invocation.created_at >= ${sql.param(
       shadowEpoch.shadowEncryptionStartedAt,
       conversationSharedAgentShadowInvocations.createdAt,
     )}
       and invocation.policy_revision = ${shadowEpoch.revision}
       and invocation.terminal_reason like 'conductor_%'
  `) as unknown as readonly Record<string, unknown>[];
  const conductorFallbackReasons = await db.execute(sql`
    select invocation.terminal_reason as reason, count(*)::text as count
      from conversation_shared_agent_shadow_invocations invocation
     where invocation.created_at >= ${sql.param(
       shadowEpoch.shadowEncryptionStartedAt,
       conversationSharedAgentShadowInvocations.createdAt,
     )}
       and invocation.policy_revision = ${shadowEpoch.revision}
       and invocation.state = 'fallback'
       and invocation.terminal_reason like 'conductor_fallback_%'
     group by invocation.terminal_reason
     order by invocation.terminal_reason
  `) as unknown as readonly Record<string, unknown>[];
  const coverage = await db.execute(sql`
    select
      coalesce(sum(participant_human_count), 0)::text
        as participant_human_opportunities,
      coalesce(sum(protected_participant_human_count), 0)::text
        as protected_participant_human_opportunities,
      coalesce(sum(plaintext_participant_human_count), 0)::text
        as plaintext_participant_human_opportunities,
      coalesce(sum(protected_recipient_device_count), 0)::text
        as protected_recipient_device_opportunities
      from conversation_shared_agent_shadow_operations operation
     where operation.policy_revision = ${shadowEpoch.revision}
       and operation.created_at >= ${sql.param(
         shadowEpoch.shadowEncryptionStartedAt,
         conversationSharedAgentShadowOperations.createdAt,
       )}
  `) as unknown as readonly Record<string, unknown>[];
  const planning = await db.execute(sql`
    select
      count(*) filter (where state = 'unavailable')::text as unavailable,
      count(*) filter (where state = 'unavailable'
        and unavailable_reason = 'device_unavailable')::text
        as device_unavailable,
      count(*) filter (where state = 'unavailable'
        and unavailable_reason = 'namespace_unavailable')::text
        as namespace_unavailable,
      count(*) filter (where state = 'unavailable'
        and unavailable_reason = 'recipient_sync_required')::text
        as recipient_sync_required
      from conversation_shared_agent_shadow_plan_attempts attempt
     where attempt.policy_revision = ${shadowEpoch.revision}
       and attempt.created_at >= ${sql.param(
         shadowEpoch.shadowEncryptionStartedAt,
         conversationSharedAgentShadowPlanAttempts.createdAt,
       )}
  `) as unknown as readonly Record<string, unknown>[];
  const output = await db.select({
    recipient_read_attempts: sql<string>`count(distinct ${conversationSharedAgentShadowAcknowledgements.sequence})::text`,
    recipient_read_verified: sql<string>`count(distinct ${conversationSharedAgentShadowAcknowledgements.sequence}) filter (where ${conversationSharedAgentShadowAcknowledgements.status} = 'verified')::text`,
    recipient_read_fallback: sql<string>`count(distinct ${conversationSharedAgentShadowAcknowledgements.sequence}) filter (where ${conversationSharedAgentShadowAcknowledgements.status} = 'fallback')::text`,
    stream_started: sql<string>`count(distinct ${sessionMessageCryptoRevisions.sequence}) filter (where ${sessionMessageCryptoRevisions.shadowStreamStartDigest} is not null)::text`,
    stream_completed: sql<string>`count(distinct ${sessionMessageCryptoRevisions.sequence}) filter (where ${sessionMessageCryptoRevisions.shadowStreamTerminalDigest} is not null)::text`,
    assistant_published: sql<string>`count(distinct ${sessionMessageCryptoRevisions.sequence}) filter (where ${sessionMessageCryptoRevisions.authorRole} = 'assistant' and ${sessionMessageCryptoRevisions.completion} = 'complete' and ${sessionMessageCryptoRevisions.disposition} = 'mapped')::text`,
    tool_results_published: sql<string>`count(distinct ${sessionMessageCryptoRevisions.sequence}) filter (where ${sessionMessageCryptoRevisions.authorRole} = 'tool' and ${sessionMessageCryptoRevisions.completion} = 'complete' and ${sessionMessageCryptoRevisions.disposition} = 'mapped')::text`,
  }).from(conversationSharedAgentShadowExecutions).leftJoin(
    sessionMessageCryptoRevisions,
    eq(sessionMessageCryptoRevisions.sharedAgentShadowExecutionId,
      conversationSharedAgentShadowExecutions.executionId),
  ).leftJoin(
    conversationSharedAgentShadowAcknowledgements,
    and(
      eq(conversationSharedAgentShadowAcknowledgements.operationId,
        conversationSharedAgentShadowExecutions.executionId),
      eq(conversationSharedAgentShadowAcknowledgements.operationKind,
        "agent_execution"),
      eq(conversationSharedAgentShadowAcknowledgements.messageId,
        sessionMessageCryptoRevisions.messageId),
      eq(conversationSharedAgentShadowAcknowledgements.editRevision,
        sessionMessageCryptoRevisions.editRevision),
    ),
  ).where(and(
    gte(conversationSharedAgentShadowExecutions.createdAt,
      shadowEpoch.shadowEncryptionStartedAt),
    eq(conversationSharedAgentShadowExecutions.policyRevision,
      shadowEpoch.revision),
  ));
  if (
    rows.length !== 1
    || executions.length !== 1
    || conductorInvocations.length !== 1
    || coverage.length !== 1
    || planning.length !== 1
    || output.length !== 1
  ) {
    throw new Error("Shared-Agent live Shadow aggregate is unavailable");
  }
  const count = (row: Record<string, unknown>, key: string): bigint =>
    toCount(typeof row[key] === "string" ? row[key] : undefined,
      `Shared-Agent ${key}`);
  const row = rows[0]!;
  const execution = executions[0]!;
  const invocationAuthorizationCount = (
    predicate: (row: typeof invocationAuthorizations[number]) => boolean,
  ): bigint => invocationAuthorizations.reduce(
    (total, row) => total + (predicate(row) ? BigInt(row.total) : 0n),
    0n,
  );
  const conductorInvocation = conductorInvocations[0]!;
  const coverageRow = coverage[0]!;
  const planningRow = planning[0]!;
  const outputRow = output[0]!;
  return Object.freeze({
    eligibleWrites: count(row, "eligible_writes"),
    publishedWrites: count(row, "published_writes"),
    pendingWrites: count(row, "pending_writes"),
    fallbackWrites: count(row, "fallback_writes"),
    failedWrites: count(row, "failed_writes"),
    recipientReadAttempts: count(row, "recipient_read_attempts"),
    recipientReadVerified: count(row, "recipient_read_verified"),
    recipientReadFallback: count(row, "recipient_read_fallback"),
    participantHumanOpportunities: count(
      coverageRow,
      "participant_human_opportunities",
    ),
    protectedParticipantHumanOpportunities: count(
      coverageRow,
      "protected_participant_human_opportunities",
    ),
    plaintextParticipantHumanOpportunities: count(
      coverageRow,
      "plaintext_participant_human_opportunities",
    ),
    protectedRecipientDeviceOpportunities: count(
      coverageRow,
      "protected_recipient_device_opportunities",
    ),
    planningUnavailable: count(planningRow, "unavailable"),
    planningDeviceUnavailable: count(planningRow, "device_unavailable"),
    planningNamespaceUnavailable: count(planningRow, "namespace_unavailable"),
    planningRecipientSyncRequired: count(
      planningRow,
      "recipient_sync_required",
    ),
    agentRecipientReadAttempts: count(outputRow, "recipient_read_attempts"),
    agentRecipientReadVerified: count(outputRow, "recipient_read_verified"),
    agentRecipientReadFallback: count(outputRow, "recipient_read_fallback"),
    conductorAwaitingUser: count(row, "conductor_awaiting_user"),
    conductorNotSelected: count(row, "conductor_not_selected"),
    conductorSelected: count(row, "conductor_selected"),
    conductorUnavailable: count(row, "conductor_unavailable"),
    conductorInvocationsEligible: count(conductorInvocation, "eligible"),
    conductorInvocationsAwaitingAuthorization: count(
      conductorInvocation,
      "awaiting_authorization",
    ),
    conductorAuthorizationEstablished: count(
      conductorInvocation,
      "authorization_established",
    ),
    conductorAuthorizationReused: count(
      conductorInvocation,
      "authorization_reused",
    ),
    conductorCurrentInputVerified: count(
      conductorInvocation,
      "current_input_verified",
    ),
    conductorRouteDeterministic: count(
      conductorInvocation,
      "route_deterministic",
    ),
    conductorRouteFloorManager: count(
      conductorInvocation,
      "route_floor_manager",
    ),
    conductorHistoryNotRequested: count(
      conductorInvocation,
      "history_not_requested",
    ),
    conductorHistoryVerified: count(
      conductorInvocation,
      "history_verified",
    ),
    conductorHistoryUnavailable: count(
      conductorInvocation,
      "history_unavailable",
    ),
    conductorVerifiedWake: count(conductorInvocation, "verified_wake"),
    conductorVerifiedAwaitingUser: count(
      conductorInvocation,
      "verified_awaiting_user",
    ),
    conductorVerifiedSilent: count(conductorInvocation, "verified_silent"),
    conductorFallback: count(conductorInvocation, "fallback"),
    conductorSelectedAgentExecutions: count(
      conductorInvocation,
      "selected_agent_executions",
    ),
    conductorFallbackReasons: Object.freeze(
      conductorFallbackReasons.map((fallback) => {
        const reason = fallback["reason"];
        if (
          typeof reason !== "string"
          || !/^conductor_fallback_[a-z0-9_]+$/u.test(reason)
        ) throw new TypeError("Shared-Agent Conductor fallback reason is invalid");
        return Object.freeze({
          reason,
          count: count(fallback, "count"),
        });
      }),
    ),
    executionsAwaitingAuthorization: count(execution, "awaiting_authorization"),
    executionsAuthorized: count(execution, "authorized"),
    executionsRunning: count(execution, "running"),
    executionsCompleted: count(execution, "completed"),
    executionsFallback: count(execution, "fallback"),
    executionsFailed: count(execution, "failed"),
    protectedExecutionInputs: count(execution, "protected_inputs"),
    resumeExecutions: count(execution, "resume_executions"),
    resumesAwaitingAuthorization: count(
      execution,
      "resumes_awaiting_authorization",
    ),
    resumesAuthorized: count(execution, "resumes_authorized"),
    resumesRunning: count(execution, "resumes_running"),
    resumesCompleted: count(execution, "resumes_completed"),
    resumesFallback: count(execution, "resumes_fallback"),
    resumesFailed: count(execution, "resumes_failed"),
    authorizationEstablished: count(execution, "authorization_established")
      + invocationAuthorizationCount((row) => row.disposition === "establish"),
    authorizationReused: count(execution, "authorization_reused")
      + invocationAuthorizationCount((row) => row.disposition === "reuse"),
    authorizationUnavailable: count(execution, "authorization_unavailable")
      + invocationAuthorizationCount((row) =>
        row.disposition === null
        && (row.state === "fallback" || row.state === "failed")
      ),
    authorizationExpired: count(execution, "authorization_expired")
      + invocationAuthorizationCount((row) =>
        row.terminalReason === "authorization_expired"
      ),
    authorizationRevoked: count(execution, "authorization_revoked")
      + invocationAuthorizationCount((row) =>
        row.terminalReason === "authorization_revoked"
      ),
    streamStarted: count(outputRow, "stream_started"),
    streamCompleted: count(outputRow, "stream_completed"),
    assistantPublished: count(outputRow, "assistant_published"),
    toolResultsPublished: count(outputRow, "tool_results_published"),
  });
}

/**
 * M301 — durable V2 Domain-key delivery and authority totals. Run through the
 * restricted crypto connection: these rows are deliberately unavailable to
 * the product role even though the aggregate contains no secret bytes.
 */
export async function readDomainKeyCatchUpDashboard(
  db: Pick<EncryptionTransitionDashboardDb, "execute">,
): Promise<DomainKeyCatchUpDashboard> {
  const rows = await db.execute(sql`
    select
      (select count(*)::text from domain_key_recipient_requests) as requested,
      (select count(*)::text from domain_key_recipient_requests
        where state = 'pending') as waiting,
      (select count(*)::text from domain_key_recipient_requests
        where state = 'fulfilled') as delivered,
      (select count(*)::text from domain_key_envelope_acknowledgements
        where request_digest is not null) as acknowledged,
      (select count(*)::text from domain_key_recipient_requests
        where state = 'stale') as stale,
      (select count(*)::text from domain_key_recipient_requests
        where state = 'expired') as expired,
      (select count(*)::text from domain_key_recipient_requests
        where state = 'unrecoverable') as unrecoverable,
      (select count(*)::text from domain_key_heads
        where key_class = 'human') as human_domain_heads,
      (select count(*)::text from domain_key_heads
        where key_class = 'ai') as ai_domain_heads,
      (select count(*)::text from namespace_domain_key_heads
        where key_class = 'human') as human_namespace_bundles,
      (select count(*)::text from namespace_domain_key_heads
        where key_class = 'ai') as ai_namespace_bundles,
      (select count(*)::text from namespace_domain_key_heads
        where key_class = 'human' and bundle_revision > 1)
        as human_namespace_bundle_advances,
      (select count(*)::text from namespace_domain_key_heads
        where key_class = 'ai' and bundle_revision > 1)
        as ai_namespace_bundle_advances
  `) as unknown as readonly Record<string, unknown>[];
  if (rows.length !== 1) {
    throw new Error("V2 Domain-key catch-up aggregate is unavailable");
  }
  const row = rows[0]!;
  const count = (key: string, label: string): bigint => {
    const value = row[key];
    return toCount(typeof value === "string" ? value : undefined, label);
  };
  return Object.freeze({
    requested: count("requested", "V2 Domain-key requests"),
    waiting: count("waiting", "waiting V2 Domain-key requests"),
    delivered: count("delivered", "delivered V2 Domain-key requests"),
    acknowledged: count("acknowledged", "acknowledged V2 Domain-key requests"),
    stale: count("stale", "stale V2 Domain-key requests"),
    expired: count("expired", "expired V2 Domain-key requests"),
    unrecoverable: count("unrecoverable", "unrecoverable V2 Domain-key requests"),
    humanDomainHeads: count("human_domain_heads", "Human V2 Domain heads"),
    aiDomainHeads: count("ai_domain_heads", "AI V2 Domain heads"),
    humanNamespaceBundles: count(
      "human_namespace_bundles",
      "Human V2 Namespace bundles",
    ),
    aiNamespaceBundles: count(
      "ai_namespace_bundles",
      "AI V2 Namespace bundles",
    ),
    humanNamespaceBundleAdvances: count(
      "human_namespace_bundle_advances",
      "advanced Human V2 Namespace bundles",
    ),
    aiNamespaceBundleAdvances: count(
      "ai_namespace_bundle_advances",
      "advanced AI V2 Namespace bundles",
    ),
  });
}

export async function readEncryptionTransitionDashboard(
  db: EncryptionTransitionDashboardDb,
  shadowEpoch: Readonly<{
    revision: number;
    shadowEncryptionStartedAt: Date | null;
  }>,
): Promise<readonly EncryptionTransitionFamilyDashboard[]> {
  const rawAttempts = shadowEpoch.shadowEncryptionStartedAt === null
    ? []
    : await db.select({
      family: encryptionTransitionOutcomeTotals.family,
      operation: encryptionTransitionOutcomeTotals.operation,
      outcome: encryptionTransitionOutcomeTotals.outcome,
      reason: encryptionTransitionOutcomeTotals.reason,
      count: sql<string>`sum(${encryptionTransitionOutcomeTotals.attemptCount})::text`,
    }).from(encryptionTransitionOutcomeTotals)
      .where(eq(
        encryptionTransitionOutcomeTotals.policyRevision,
        shadowEpoch.revision,
      ))
      .groupBy(
        encryptionTransitionOutcomeTotals.family,
        encryptionTransitionOutcomeTotals.operation,
        encryptionTransitionOutcomeTotals.outcome,
        encryptionTransitionOutcomeTotals.reason,
      );
  const attemptRows: EncryptionTransitionAttemptRow[] = rawAttempts.map((row) => ({
    family: row.family,
    operation: row.operation,
    outcome: row.outcome,
    reason: row.reason,
    count: toCount(row.count, "attempt count"),
  }));

  const epochStartedAt = shadowEpoch.shadowEncryptionStartedAt;
  const messageTouched = epochStartedAt === null
    ? sql`false`
    : sql`coalesce(${sessionMessages.editedAt}, ${sessionMessages.createdAt})
      >= ${sql.param(epochStartedAt, sessionMessages.createdAt)}`;
  const memoryTouched = epochStartedAt === null
    ? sql`false`
    : sql`${memories.updatedAt} >= ${sql.param(epochStartedAt, memories.updatedAt)}`;
  const artifactTouched = epochStartedAt === null
    ? sql`false`
    : sql`${artifacts.updatedAt} >= ${sql.param(epochStartedAt, artifacts.updatedAt)}`;
  const recordTouched = epochStartedAt === null
    ? sql`false`
    : sql`${reflectionRecords.updatedAt}
      >= ${sql.param(epochStartedAt, reflectionRecords.updatedAt)}`;
  const messageVerified = sql`${sessionMessages.cryptoObjectId} is not null and exists (
    select 1 from ${sessionMessageCryptoRevisions} revision
    where revision.session_id = ${sessionMessages.sessionId}
      and revision.message_id = ${sessionMessages.id}
      and revision.edit_revision = ${sessionMessages.editRevision}
      and revision.crypto_object_id = ${sessionMessages.cryptoObjectId}
      and revision.completion = 'complete'
      and revision.disposition = 'mapped'
      and ${completedMessageRepresentation}
  )`;
  const memoryVerified = sql`${memories.cryptoObjectId} is not null
    and ${memories.cryptoMappingState} = 'verified'
    and ${memories.cryptoRequiredNamespaceFingerprint} is not null
    and exists (
      select 1 from ${memoryCryptoRevisions} revision
      where revision.memory_id = ${memories.id}
        and revision.content_revision = ${memories.contentRevision}
        and revision.crypto_object_id = ${memories.cryptoObjectId}
        and revision.required_namespace_fingerprint =
          ${memories.cryptoRequiredNamespaceFingerprint}
        and revision.completion = 'complete'
        and revision.disposition = 'mapped'
    )`;
  const artifactVerified = sql`${artifacts.cryptoObjectId} is not null
    and ${artifacts.cryptoMappingState} = 'verified'
    and ${artifacts.cryptoRequiredNamespaceFingerprint} is not null
    and ${artifacts.cryptoLifecycleState} = 'active'
    and exists (
      select 1 from ${artifactCryptoRevisions} revision
      where revision.artifact_row_id = ${artifacts.id}
        and revision.artifact_id = ${artifacts.artifactId}
        and revision.artifact_revision = ${artifacts.revision}
        and revision.crypto_object_id = ${artifacts.cryptoObjectId}
        and revision.required_namespace_fingerprint =
          ${artifacts.cryptoRequiredNamespaceFingerprint}
        and revision.completion = 'complete'
        and revision.disposition = 'mapped'
    ) and exists (
      select 1 from ${artifactCryptoBlobs} blob
      where blob.artifact_row_id = ${artifacts.id}
        and blob.artifact_id = ${artifacts.artifactId}
        and blob.blob_id = ${artifacts.blobId}
        and blob.blob_generation = ${artifacts.blobGeneration}
        and blob.ciphertext_length = ${artifacts.ciphertextLength}
        and blob.ciphertext_sha256 = ${artifacts.ciphertextSha256}
        and blob.state = 'published'
    )`;
  const recordVerified = sql`exists (
    select 1
    from ${reflectionRecordPayloadRepresentationHeads} head
    join ${reflectionRecordPayloadRepresentations} representation
      on representation.record_id = head.record_id
     and representation.representation = head.representation
     and representation.representation_generation =
       head.current_representation_generation
    join ${reflectionRecordPublications} publication
      on publication.record_id = representation.record_id
     and publication.representation = representation.representation
     and publication.representation_generation =
       representation.representation_generation
     and publication.crypto_object_id = representation.crypto_object_id
    where head.record_id = ${reflectionRecords.recordId}
      and head.representation = 'protected'
      and representation.crypto_object_id is not null
      and publication.state = 'complete'
  )`;

  const [[message], [memory], [artifact], [record]] = await Promise.all([
    db.select({
      total: sql<string>`count(*)::text`,
      verified: sql<string>`count(*) filter (where ${messageVerified})::text`,
      touchedTotal: sql<string>`count(*) filter (where ${messageTouched})::text`,
      touchedVerified: sql<string>`count(*) filter (where
        ${messageTouched} and ${messageVerified})::text`,
    }).from(sessionMessages),
    db.select({
      total: sql<string>`count(*)::text`,
      verified: sql<string>`count(*) filter (where ${memoryVerified})::text`,
      touchedTotal: sql<string>`count(*) filter (where ${memoryTouched})::text`,
      touchedVerified: sql<string>`count(*) filter (where
        ${memoryTouched} and ${memoryVerified})::text`,
    }).from(memories),
    db.select({
      total: sql<string>`count(*)::text`,
      verified: sql<string>`count(*) filter (where ${artifactVerified})::text`,
      touchedTotal: sql<string>`count(*) filter (where ${artifactTouched})::text`,
      touchedVerified: sql<string>`count(*) filter (where
        ${artifactTouched} and ${artifactVerified})::text`,
    }).from(artifacts).where(isNull(artifacts.deletedAt)),
    db.select({
      total: sql<string>`count(*)::text`,
      verified: sql<string>`count(*) filter (where ${recordVerified})::text`,
      touchedTotal: sql<string>`count(*) filter (where ${recordTouched})::text`,
      touchedVerified: sql<string>`count(*) filter (where
        ${recordTouched} and ${recordVerified})::text`,
    }).from(reflectionRecords).where(and(
      eq(reflectionRecords.lifecycle, "current"),
      eq(reflectionRecords.disposition, "available"),
    )),
  ]);
  // Keep the explicit projection guard visible: a missing aggregate row is a
  // storage fault, never a zero denominator.
  if (!message || !memory || !artifact || !record) {
    throw new Error("Encryption stored coverage aggregate is unavailable");
  }
  const coverageRows: EncryptionTransitionCoverageRow[] = [
    {
      family: "message",
      verified: toCount(message.verified, "message verified"),
      total: toCount(message.total, "message total"),
      touchedVerified: toCount(message.touchedVerified, "message touched verified"),
      touchedTotal: toCount(message.touchedTotal, "message touched total"),
    },
    {
      family: "memory",
      verified: toCount(memory.verified, "memory verified"),
      total: toCount(memory.total, "memory total"),
      touchedVerified: toCount(memory.touchedVerified, "memory touched verified"),
      touchedTotal: toCount(memory.touchedTotal, "memory touched total"),
    },
    {
      family: "artifact",
      verified: toCount(artifact.verified, "artifact verified"),
      total: toCount(artifact.total, "artifact total"),
      touchedVerified: toCount(artifact.touchedVerified, "artifact touched verified"),
      touchedTotal: toCount(artifact.touchedTotal, "artifact touched total"),
    },
    {
      family: "record",
      verified: toCount(record.verified, "record verified"),
      total: toCount(record.total, "record total"),
      touchedVerified: toCount(record.touchedVerified, "record touched verified"),
      touchedTotal: toCount(record.touchedTotal, "record touched total"),
    },
  ];
  const pendingRows: EncryptionTransitionPendingRow[] = epochStartedAt === null
    ? ENCRYPTION_TRANSITION_FAMILIES.map((family) => ({
        family,
        pending: 0n,
        oldestPendingAt: null,
      }))
    : await Promise.all([
        db.select({
          count: sql<string>`count(*)::text`,
          oldest: sql<Date | string | null>`min(${sessionMessageCryptoRevisions.createdAt})`,
        }).from(sessionMessageCryptoRevisions).where(and(
          eq(sessionMessageCryptoRevisions.completion, "pending"),
          eq(sessionMessageCryptoRevisions.disposition, "active"),
          gte(sessionMessageCryptoRevisions.createdAt, epochStartedAt),
        )).then(([row]) => ({
          family: "message" as const,
          pending: toCount(row?.count, "pending message lifecycle"),
          oldestPendingAt: toOptionalDate(row?.oldest, "oldest pending message"),
        })),
        db.select({
          count: sql<string>`count(*)::text`,
          oldest: sql<Date | string | null>`min(${memoryCryptoOperations.createdAt})`,
        }).from(memoryCryptoOperations).where(and(
          eq(memoryCryptoOperations.completion, "pending"),
          eq(memoryCryptoOperations.disposition, "active"),
          gte(memoryCryptoOperations.createdAt, epochStartedAt),
        )).then(([row]) => ({
          family: "memory" as const,
          pending: toCount(row?.count, "pending memory lifecycle"),
          oldestPendingAt: toOptionalDate(row?.oldest, "oldest pending memory"),
        })),
        db.select({
          count: sql<string>`count(*)::text`,
          oldest: sql<Date | string | null>`min(${artifactCryptoOperations.createdAt})`,
        }).from(artifactCryptoOperations).where(and(
          eq(artifactCryptoOperations.completion, "pending"),
          eq(artifactCryptoOperations.disposition, "active"),
          gte(artifactCryptoOperations.createdAt, epochStartedAt),
        )).then(([row]) => ({
          family: "artifact" as const,
          pending: toCount(row?.count, "pending artifact lifecycle"),
          oldestPendingAt: toOptionalDate(row?.oldest, "oldest pending artifact"),
        })),
        db.select({
          count: sql<string>`count(*)::text`,
          oldest: sql<Date | string | null>`min(${reflectionRecordPublications.createdAt})`,
        }).from(reflectionRecordPublications).where(and(
          eq(reflectionRecordPublications.representation, "protected"),
          gte(reflectionRecordPublications.createdAt, epochStartedAt),
          sql`${reflectionRecordPublications.state} in (
            'reserved', 'crypto_complete', 'product_attached'
          )`,
        )).then(([row]) => ({
          family: "record" as const,
          pending: toCount(row?.count, "pending record lifecycle"),
          oldestPendingAt: toOptionalDate(row?.oldest, "oldest pending record"),
        })),
      ]);
  return assembleEncryptionTransitionDashboard({
    attemptRows,
    coverageRows,
    pendingRows,
  });
}

export async function readEncryptionTransitionObservationPressure(
  db: EncryptionTransitionDashboardDb,
  shadowEpoch: Readonly<{ revision: number; shadowEncryptionStartedAt: Date | null }>,
  bounds: Readonly<{ storageLimitRows: number; retentionMs: number }>,
): Promise<EncryptionTransitionObservationPressure> {
  if (
    !Number.isSafeInteger(bounds.storageLimitRows)
    || bounds.storageLimitRows < 1
    || !Number.isSafeInteger(bounds.retentionMs)
    || bounds.retentionMs < 1
  ) throw new TypeError("Encryption transition pressure bounds are invalid");
  if (shadowEpoch.shadowEncryptionStartedAt === null) {
    return Object.freeze({
      retainedRows: 0n,
      capacityRows: BigInt(bounds.storageLimitRows),
      pendingAdmissions: 0n,
      admissionCapacity: BigInt(bounds.storageLimitRows),
      maximumRetentionMs: bounds.retentionMs,
    });
  }
  const [[row], [admission]] = await Promise.all([
    db.select({ count: sql<string>`count(*)::text` })
      .from(encryptionTransitionObservationBuckets).where(eq(
        encryptionTransitionObservationBuckets.policyRevision,
        shadowEpoch.revision,
      )),
    db.select({ count: sql<string>`count(*)::text` })
      .from(encryptionTransitionObservationAdmissions).where(eq(
        encryptionTransitionObservationAdmissions.policyRevision,
        shadowEpoch.revision,
      )),
  ]);
  return Object.freeze({
    retainedRows: toCount(row?.count, "retained observation rows"),
    capacityRows: BigInt(bounds.storageLimitRows),
    pendingAdmissions: toCount(
      admission?.count,
      "pending observation admissions",
    ),
    admissionCapacity: BigInt(bounds.storageLimitRows),
    maximumRetentionMs: bounds.retentionMs,
  });
}
