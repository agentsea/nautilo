/**
 * D525 — durable, provider-opaque receipts for paid media generation.
 *
 * This table is intentionally a lifecycle receipt, not a prompt, lyrics, or
 * provider-response archive. Provider queue IDs are server-only opaque
 * coordinates; delivery URLs and credentials do not have columns here.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts";
import { agents } from "./agents";
import { rooms } from "./rooms";
import { namespaces } from "./trust";
import { users } from "./users";

export const MEDIA_GENERATION_STATES = [
  "prequeue", "admitting", "queued", "retrieving", "saving", "ready", "needs_action", "failed", "unknown",
] as const;
export type MediaGenerationState = (typeof MEDIA_GENERATION_STATES)[number];

export const MEDIA_GENERATION_KINDS = ["video", "music"] as const;
export type MediaGenerationKind = (typeof MEDIA_GENERATION_KINDS)[number];

export const MEDIA_GENERATION_CLEANUP_STATES = ["pending", "completed"] as const;
export type MediaGenerationCleanupState = (typeof MEDIA_GENERATION_CLEANUP_STATES)[number];

/** Safe, presentation-ready failure only: never a provider body, prompt, or URL. */
export interface MediaGenerationSafeFailure {
  readonly code: string;
  readonly phase: "quote" | "queue" | "retrieve" | "download" | "save" | "cleanup" | "reconcile";
  readonly retrySafe: boolean;
  readonly stateChanged: boolean;
  readonly completionCertainty: "not_started" | "accepted" | "unknown" | "complete";
  readonly chargeCertainty: "not_charged" | "charged" | "unknown" | "refunded";
  readonly recoveryActions: readonly ("retry_same_receipt" | "revise" | "switch_model" | "repair_account" | "start_fresh")[];
  readonly creditsRefunded?: boolean;
}

export interface MediaGenerationNormalizedSettings {
  readonly durationSeconds?: number;
  readonly resolution?: string;
  readonly aspectRatio?: string;
  readonly audioEnabled?: boolean;
  readonly instrumental?: boolean;
}

/** Presentation-safe receipt data. It deliberately has no creative text. */
export interface MediaGenerationSafeSnapshot {
  readonly version: 1;
  readonly normalizedSettings: MediaGenerationNormalizedSettings;
  readonly inputSummary: {
    readonly promptCharacters: number;
    readonly lyricsCharacters?: number;
    readonly referenceImageCount?: number;
  };
}

export interface MediaGenerationReferenceImageBinding {
  readonly path: string;
  readonly artifactId: string;
  readonly artifactInternalId: string;
  readonly revision: number;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Internal-only durable request needed to resume the exact approved queue or
 * preserve a provider refusal for revision. Never return this in a card,
 * tool result, log record, or public receipt projection.
 */
export interface MediaGenerationReferenceVideoBinding extends MediaGenerationReferenceImageBinding {
  readonly durationSeconds: number;
}

export interface MediaGenerationRequestPayload {
  readonly version: 1;
  readonly model: string;
  readonly prompt: string;
  readonly lyrics?: string;
  readonly referenceImages?: readonly MediaGenerationReferenceImageBinding[];
  readonly referenceVideos?: readonly MediaGenerationReferenceVideoBinding[];
  readonly normalizedSettings: MediaGenerationNormalizedSettings;
}

export const mediaGenerations = pgTable(
  "media_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Opaque local receipt returned to later lifecycle calls; never a provider queue ID. */
    receiptId: text("receipt_id").notNull(),
    /** Null on account deletion for the bounded, scrubbed external receipt. */
    ownerId: uuid("owner_id").$type<string>().references(() => users.id, { onDelete: "set null" }),
    /** A retained shared-Room receipt remains attached to its canonical Room. */
    roomId: uuid("room_id").$type<string>().notNull(),
    namespaceId: uuid("namespace_id").$type<string>().notNull().references(() => namespaces.id, { onDelete: "restrict" }),
    /** Exact Genie/thread that initiated the paid receipt; legacy rows may be null. */
    initiatingAgentId: uuid("initiating_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    initiatingThreadId: text("initiating_thread_id"),
    kind: text("kind", { enum: MEDIA_GENERATION_KINDS }).notNull(),
    provider: text("provider").notNull().default("venice"),
    providerModel: text("provider_model").notNull(),
    /** A one-way account discriminator, never an API key. */
    providerAccountFingerprint: text("provider_account_fingerprint").notNull(),
    /** Protected server-only queue coordinate. It is deliberately absent from public projections. */
    providerQueueId: text("provider_queue_id"),
    /** DB-minted queue-admission fence; never accepted from a tool caller. */
    admissionToken: uuid("admission_token"),
    admissionStartedAt: timestamp("admission_started_at", { withTimezone: true }),
    approvalDigest: text("approval_digest").notNull(),
    quoteDigest: text("quote_digest").notNull(),
    safeSnapshot: jsonb("safe_snapshot").$type<MediaGenerationSafeSnapshot>().notNull(),
    requestPayload: jsonb("request_payload").$type<MediaGenerationRequestPayload>().notNull(),
    quotedUsdMicros: integer("quoted_usd_micros").notNull(),
    state: text("state", { enum: MEDIA_GENERATION_STATES }).notNull().default("prequeue"),
    revision: integer("revision").notNull().default(0),
    safeFailure: jsonb("safe_failure").$type<MediaGenerationSafeFailure>(),
    /** Provider-reported elapsed processing time, normalized to safe whole seconds. */
    providerExecutionSeconds: integer("provider_execution_seconds"),
    /** Provider P80 processing duration, normalized to safe whole seconds. Never a countdown. */
    providerAverageExecutionSeconds: integer("provider_average_execution_seconds"),
    artifactInternalId: uuid("artifact_internal_id").references(() => artifacts.id, { onDelete: "restrict" }),
    cleanupState: text("cleanup_state", { enum: MEDIA_GENERATION_CLEANUP_STATES }).notNull().default("pending"),
    cleanupCompletedAt: timestamp("cleanup_completed_at", { withTimezone: true }),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    /** At-least-once completion wake outbox lease and accepted-delivery marker. */
    completionWakeClaimedAt: timestamp("completion_wake_claimed_at", { withTimezone: true }),
    completionWakeDeliveredAt: timestamp("completion_wake_delivered_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_media_generations_receipt_id").on(table.receiptId),
    index("idx_media_generations_scope_created").on(table.ownerId, table.roomId, table.namespaceId, table.createdAt.desc()),
    index("idx_media_generations_reconcile_due").on(table.state, table.nextAttemptAt, table.createdAt)
      .where(sql`${table.state} in ('queued', 'retrieving', 'saving')`),
    index("idx_media_generations_cleanup_due").on(table.cleanupState, table.nextAttemptAt, table.createdAt)
      .where(sql`${table.cleanupState} = 'pending' and ${table.state} = 'ready'`),
    index("idx_media_generations_completion_wake_due").on(table.state, table.readyAt, table.createdAt)
      .where(sql`${table.state} = 'ready' and ${table.completionWakeDeliveredAt} is null and ${table.initiatingAgentId} is not null`),
    foreignKey({
      name: "media_generations_room_namespace_fk",
      columns: [table.roomId, table.namespaceId],
      foreignColumns: [rooms.id, rooms.namespaceId],
    }).onDelete("restrict"),
    check("media_generations_receipt_portable", sql`octet_length(${table.receiptId}) between 1 and 128 and ${table.receiptId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`),
    check("media_generations_provider_fixed", sql`${table.provider} = 'venice' and octet_length(${table.providerModel}) between 1 and 256 and octet_length(${table.providerAccountFingerprint}) between 16 and 128`),
    check("media_generations_digests", sql`${table.approvalDigest} ~ '^[0-9a-f]{64}$' and ${table.quoteDigest} ~ '^[0-9a-f]{64}$'`),
    check("media_generations_quote_nonnegative", sql`${table.quotedUsdMicros} >= 0`),
    check("media_generations_revision_nonnegative", sql`${table.revision} >= 0`),
    check("media_generations_provider_timing_nonnegative", sql`
      (${table.providerExecutionSeconds} is null or ${table.providerExecutionSeconds} between 0 and 2147483647)
      and (${table.providerAverageExecutionSeconds} is null or ${table.providerAverageExecutionSeconds} between 0 and 2147483647)
    `),
    check("media_generations_admission_shape", sql`
      (${table.admissionToken} is null) = (${table.admissionStartedAt} is null)
      and (${table.providerQueueId} is null) = (${table.acceptedAt} is null)
      and (${table.providerQueueId} is null or ${table.admissionToken} is not null)
      and (${table.state} <> 'prequeue' or (${table.admissionToken} is null and ${table.providerQueueId} is null))
      and (${table.state} <> 'admitting' or (${table.admissionToken} is not null and ${table.providerQueueId} is null))
      and (${table.state} not in ('queued', 'retrieving', 'saving', 'ready') or (${table.admissionToken} is not null and ${table.providerQueueId} is not null))
      and (${table.state} <> 'unknown' or ${table.admissionToken} is not null)
    `),
    check("media_generations_safe_json", sql`
      jsonb_typeof(${table.safeSnapshot}) = 'object'
      and ${table.safeSnapshot} ?& array['version', 'normalizedSettings', 'inputSummary']
      and ${table.safeSnapshot} - 'version' - 'normalizedSettings' - 'inputSummary' = '{}'::jsonb
      and ${table.safeSnapshot}->>'version' = '1'
      and jsonb_typeof(${table.safeSnapshot}->'normalizedSettings') = 'object'
      and (${table.safeSnapshot}->'normalizedSettings') - 'durationSeconds' - 'resolution' - 'aspectRatio' - 'audioEnabled' - 'instrumental' = '{}'::jsonb
      and (not (${table.safeSnapshot}->'normalizedSettings' ? 'durationSeconds') or (jsonb_typeof(${table.safeSnapshot}->'normalizedSettings'->'durationSeconds') = 'number' and (${table.safeSnapshot}->'normalizedSettings'->>'durationSeconds')::numeric > 0))
      and (not (${table.safeSnapshot}->'normalizedSettings' ? 'resolution') or (jsonb_typeof(${table.safeSnapshot}->'normalizedSettings'->'resolution') = 'string' and ${table.safeSnapshot}->'normalizedSettings'->>'resolution' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
      and (not (${table.safeSnapshot}->'normalizedSettings' ? 'aspectRatio') or (jsonb_typeof(${table.safeSnapshot}->'normalizedSettings'->'aspectRatio') = 'string' and ${table.safeSnapshot}->'normalizedSettings'->>'aspectRatio' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
      and (not (${table.safeSnapshot}->'normalizedSettings' ? 'audioEnabled') or jsonb_typeof(${table.safeSnapshot}->'normalizedSettings'->'audioEnabled') = 'boolean')
      and (not (${table.safeSnapshot}->'normalizedSettings' ? 'instrumental') or jsonb_typeof(${table.safeSnapshot}->'normalizedSettings'->'instrumental') = 'boolean')
      and jsonb_typeof(${table.safeSnapshot}->'inputSummary') = 'object'
      and ${table.safeSnapshot}->'inputSummary' ? 'promptCharacters'
      and (${table.safeSnapshot}->'inputSummary') - 'promptCharacters' - 'lyricsCharacters' - 'referenceImageCount' = '{}'::jsonb
      and jsonb_typeof(${table.safeSnapshot}->'inputSummary'->'promptCharacters') = 'number'
      and (${table.safeSnapshot}->'inputSummary'->>'promptCharacters')::numeric >= 0
      and (not (${table.safeSnapshot}->'inputSummary' ? 'lyricsCharacters') or (jsonb_typeof(${table.safeSnapshot}->'inputSummary'->'lyricsCharacters') = 'number' and (${table.safeSnapshot}->'inputSummary'->>'lyricsCharacters')::numeric >= 0))
      and (not (${table.safeSnapshot}->'inputSummary' ? 'referenceImageCount') or (jsonb_typeof(${table.safeSnapshot}->'inputSummary'->'referenceImageCount') = 'number' and (${table.safeSnapshot}->'inputSummary'->>'referenceImageCount')::numeric between 1 and 30))
      and (${table.safeFailure} is null or not (${table.safeFailure} ?| array['raw', 'body', 'prompt', 'lyrics', 'download_url', 'signed_url', 'api_key', 'authorization']))
    `),
    check("media_generations_request_payload_shape", sql`
      jsonb_typeof(${table.requestPayload}) = 'object'
      and ${table.requestPayload} ?& array['version', 'model', 'prompt', 'normalizedSettings']
      and ${table.requestPayload} - 'version' - 'model' - 'prompt' - 'lyrics' - 'referenceImages' - 'referenceVideos' - 'normalizedSettings' = '{}'::jsonb
      and ${table.requestPayload}->>'version' = '1'
      and jsonb_typeof(${table.requestPayload}->'model') = 'string'
      and ${table.requestPayload}->>'model' = ${table.providerModel}
      and ${table.requestPayload}->>'model' ~ '^[A-Za-z0-9._:+-]+$'
      and jsonb_typeof(${table.requestPayload}->'prompt') = 'string'
      and (not (${table.requestPayload} ? 'lyrics') or jsonb_typeof(${table.requestPayload}->'lyrics') = 'string')
      and (not (${table.requestPayload} ? 'referenceImages') or (
        jsonb_typeof(${table.requestPayload}->'referenceImages') = 'array'
        and jsonb_array_length(${table.requestPayload}->'referenceImages') between 0 and 30
      ))
      and (not (${table.requestPayload} ? 'referenceVideos') or (
        jsonb_typeof(${table.requestPayload}->'referenceVideos') = 'array'
        and jsonb_array_length(${table.requestPayload}->'referenceVideos') between 0 and 10
      ))
      and jsonb_typeof(${table.requestPayload}->'normalizedSettings') = 'object'
      and (${table.requestPayload}->'normalizedSettings') - 'durationSeconds' - 'resolution' - 'aspectRatio' - 'audioEnabled' - 'instrumental' = '{}'::jsonb
      and (not (${table.requestPayload}->'normalizedSettings' ? 'durationSeconds') or (jsonb_typeof(${table.requestPayload}->'normalizedSettings'->'durationSeconds') = 'number' and (${table.requestPayload}->'normalizedSettings'->>'durationSeconds')::numeric > 0))
      and (not (${table.requestPayload}->'normalizedSettings' ? 'resolution') or (jsonb_typeof(${table.requestPayload}->'normalizedSettings'->'resolution') = 'string' and ${table.requestPayload}->'normalizedSettings'->>'resolution' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
      and (not (${table.requestPayload}->'normalizedSettings' ? 'aspectRatio') or (jsonb_typeof(${table.requestPayload}->'normalizedSettings'->'aspectRatio') = 'string' and ${table.requestPayload}->'normalizedSettings'->>'aspectRatio' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
      and (not (${table.requestPayload}->'normalizedSettings' ? 'audioEnabled') or jsonb_typeof(${table.requestPayload}->'normalizedSettings'->'audioEnabled') = 'boolean')
      and (not (${table.requestPayload}->'normalizedSettings' ? 'instrumental') or jsonb_typeof(${table.requestPayload}->'normalizedSettings'->'instrumental') = 'boolean')
      and ${table.requestPayload}->'normalizedSettings' = ${table.safeSnapshot}->'normalizedSettings'
    `),
    check("media_generations_claim_shape", sql`(${table.claimOwner} is null) = (${table.claimExpiresAt} is null)`),
    check("media_generations_cleanup_shape", sql`(${table.cleanupState} = 'pending' and ${table.cleanupCompletedAt} is null) or (${table.cleanupState} = 'completed' and ${table.cleanupCompletedAt} is not null)`),
    check("media_generations_artifact_ready_shape", sql`${table.state} <> 'ready' or ${table.artifactInternalId} is not null`),
    check("media_generations_initiator_shape", sql`(${table.initiatingAgentId} is null) = (${table.initiatingThreadId} is null) and (${table.initiatingThreadId} is null or octet_length(${table.initiatingThreadId}) between 1 and 512)`),
    check("media_generations_completion_wake_shape", sql`${table.completionWakeDeliveredAt} is null or ${table.completionWakeClaimedAt} is not null`),
    check("media_generations_retention_shape", sql`${table.retainUntil} is null or ${table.retainUntil} >= ${table.createdAt}`),
  ],
);

export type MediaGeneration = typeof mediaGenerations.$inferSelect;
export type NewMediaGeneration = typeof mediaGenerations.$inferInsert;
/** Explicit future card/tool projection boundary: no creative text or provider queue identity. */
export type MediaGenerationPublicReceipt = Omit<
  MediaGeneration,
  "providerQueueId" | "admissionToken" | "admissionStartedAt" | "requestPayload" |
  "initiatingAgentId" | "initiatingThreadId" | "completionWakeClaimedAt" | "completionWakeDeliveredAt"
>;
