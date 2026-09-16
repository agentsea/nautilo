import { sql } from "drizzle-orm";
import {
  check,
  index,
  bigint,
  bigserial,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { rooms } from "./rooms";
import { users } from "./users";

export const CONNECTED_WEB_ACCOUNT_STATUSES = [
  "connecting",
  "connected",
  "busy",
  "attention_needed",
  "expired",
  "revoked",
  "provider_unavailable",
  "error",
] as const;
export type ConnectedWebAccountStatus = (typeof CONNECTED_WEB_ACCOUNT_STATUSES)[number];

export const CONNECTED_WEB_ACCOUNT_CLEANUP_STATES = [
  "not_required",
  "pending",
  "failed",
  "completed",
] as const;
export type ConnectedWebAccountCleanupState = (typeof CONNECTED_WEB_ACCOUNT_CLEANUP_STATES)[number];

/**
 * Server-only opaque coordinates necessary to stop or cancel interrupted
 * provider work. They never cross the public projection boundary.
 */
export interface ConnectedWebAccountExecutionCheckpoint {
  readonly resource: "login" | "read" | "view" | "action";
  /** Reservation fences concurrent providers before any external work starts. */
  readonly phase: "reserving" | "active";
  readonly reservationToken: string;
  /** Present only after the exact reservation has been atomically activated. */
  readonly opaqueExecutionRef?: string;
  readonly recordedAt: string;
  /** Terminal synchronous execution awaiting exact provider-browser cleanup. */
  readonly cleanupStatus?: "connected" | "attention_needed";
}

/** The only first-house external effect: save/favorite one named item. */
export const CONNECTED_WEB_ACTION_OPERATION_STATUSES = [
  "reserving",
  "running",
  /** The website write has finished; only a read-only postcondition check remains. */
  "verifying",
  "completed",
  "ambiguous",
  "cancelled",
  "authentication_required",
  "failed",
] as const;
export type ConnectedWebActionOperationStatus = (typeof CONNECTED_WEB_ACTION_OPERATION_STATUSES)[number];

const nautiloProductRole = pgRole("nautilo").existing();

/**
 * Canonical personal account fact. This deliberately does not reuse the
 * Agent/Namespace connection vault: the owner is always one authenticated
 * Human and the external profile binding is server-only.
 */
export const connectedWebAccounts = pgTable(
  "connected_web_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    service: varchar("service", { length: 128 }).notNull(),
    origin: varchar("origin", { length: 2_048 }).notNull(),
    label: varchar("label", { length: 256 }).notNull(),
    status: varchar("status", { length: 32, enum: CONNECTED_WEB_ACCOUNT_STATUSES })
      .notNull()
      .default("connecting"),
    /** Opaque server-only provider locator. It is null until a provider creates the profile. */
    profileRef: text("profile_ref"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    /** Server-only recovery coordinate; never a public browser capability. */
    executionCheckpoint: jsonb("execution_checkpoint").$type<ConnectedWebAccountExecutionCheckpoint | null>(),
    cleanupState: varchar("cleanup_state", { length: 16, enum: CONNECTED_WEB_ACCOUNT_CLEANUP_STATES })
      .notNull()
      .default("not_required"),
    cleanupFailureCode: varchar("cleanup_failure_code", { length: 128 }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_connected_web_accounts_owner_updated").on(table.ownerUserId, table.updatedAt),
    index("idx_connected_web_accounts_stale_execution").on(table.status, table.updatedAt)
      .where(sql`${table.executionCheckpoint} IS NOT NULL`),
    check("connected_web_accounts_service_nonempty", sql`octet_length(${table.service}) between 1 and 128`),
    check("connected_web_accounts_origin_nonempty", sql`octet_length(${table.origin}) between 1 and 2048`),
    check("connected_web_accounts_label_nonempty", sql`octet_length(${table.label}) between 1 and 256`),
    check("connected_web_accounts_status_check", sql`${table.status} in ('connecting', 'connected', 'busy', 'attention_needed', 'expired', 'revoked', 'provider_unavailable', 'error')`),
    check("connected_web_accounts_cleanup_check", sql`${table.cleanupState} in ('not_required', 'pending', 'failed', 'completed')`),
    check("connected_web_accounts_revocation_shape", sql`(${table.status} = 'revoked' and ${table.revokedAt} is not null) or (${table.status} <> 'revoked' and ${table.revokedAt} is null)`),
    pgPolicy("connected_web_accounts_product_all", {
      as: "permissive",
      for: "all",
      to: nautiloProductRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ConnectedWebAccountRow = typeof connectedWebAccounts.$inferSelect;
export type NewConnectedWebAccountRow = typeof connectedWebAccounts.$inferInsert;

/**
 * Durable action-delivery ledger. It is deliberately narrower than a generic
 * browser job: one exact LangGraph tool delivery may only save one item on one
 * Human-owned profile. Provider coordinates remain opaque server custody.
 */
export const connectedWebActionOperations = pgTable(
  "connected_web_action_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The account/user lifecycle already owns destruction. Keep this small
    // idempotency ledger from retaining a deleted personal account forever.
    ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => connectedWebAccounts.id, { onDelete: "cascade" }),
    deliveryId: varchar("delivery_id", { length: 256 }).notNull(),
    requestDigest: varchar("request_digest", { length: 64 }).notNull(),
    actionType: varchar("action_type", { length: 32 }).notNull().default("save_item"),
    target: varchar("target", { length: 1_024 }).notNull(),
    status: varchar("status", { length: 32, enum: CONNECTED_WEB_ACTION_OPERATION_STATUSES }).notNull(),
    /** Provider run id only; never a public receipt or client projection. */
    opaqueRunRef: text("opaque_run_ref"),
    /** Safe, bounded postcondition evidence only. */
    receipt: jsonb("receipt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_connected_web_action_operations_account_updated").on(table.accountId, table.updatedAt),
    uniqueIndex("uq_connected_web_action_operations_owner_delivery").on(table.ownerUserId, table.deliveryId),
    index("idx_connected_web_action_operations_reconcile").on(table.status, table.updatedAt)
      .where(sql`${table.status} in ('reserving', 'running', 'verifying')`),
    check("connected_web_action_operations_delivery_nonempty", sql`octet_length(${table.deliveryId}) between 1 and 256`),
    check("connected_web_action_operations_digest", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
    check("connected_web_action_operations_type", sql`${table.actionType} = 'save_item'`),
    check("connected_web_action_operations_target_nonempty", sql`octet_length(${table.target}) between 1 and 1024`),
    check("connected_web_action_operations_status", sql`${table.status} in ('reserving', 'running', 'verifying', 'completed', 'ambiguous', 'cancelled', 'authentication_required', 'failed')`),
    pgPolicy("connected_web_action_operations_product_all", {
      as: "permissive", for: "all", to: nautiloProductRole, using: sql`true`, withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ConnectedWebActionOperationRow = typeof connectedWebActionOperations.$inferSelect;

/** The one truthfully named writer currently controlling an operation. */
export const CONNECTED_WEB_OPERATION_DRIVERS = ["hosted", "checking", "direct", "human"] as const;
export type ConnectedWebOperationDriver = (typeof CONNECTED_WEB_OPERATION_DRIVERS)[number];

/** Lifecycle is separate from the writer so an attention or terminal state cannot be mistaken for a driver. */
export const CONNECTED_WEB_OPERATION_LIFECYCLES = ["admitted", "running", "attention", "terminal"] as const;
export type ConnectedWebOperationLifecycle = (typeof CONNECTED_WEB_OPERATION_LIFECYCLES)[number];

/**
 * Opaque, server-sealed provider locators. They intentionally have no live
 * view, debugger, cookie, credential, request, or page-content field.
 */
export interface ConnectedWebOperationProviderReferences {
  readonly version: 1;
  readonly sessionRef?: string;
  readonly runRef?: string;
  readonly workspaceRef?: string;
  readonly browserRef?: string;
}

/** Small, provider-neutral activity suitable for a Human card or Genie wake. */
export interface ConnectedWebOperationSafeActivity {
  readonly version: 1;
  readonly phase: "starting" | "working" | "checking" | "attention" | "finishing";
  readonly code: string;
  readonly summary: string;
}

/** The terminal result is deliberately safe and references the action ledger when an effect exists. */
export interface ConnectedWebOperationSafeReceipt {
  readonly version: 1;
  readonly outcome: "completed" | "cancelled" | "failed" | "attention_required" | "ambiguous";
  readonly code: string;
  readonly summary: string;
  readonly actionOperationId?: string;
}

/**
 * Durable authority for exactly one Connected Website request. It retains
 * sealed server coordinates and the exact initiating conversation, while the
 * pre-existing action ledger remains canonical for external-effect truth.
 */
export const connectedWebOperations = pgTable(
  "connected_web_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // Null denotes an isolated public Browser Use operation; never a saved account.
    accountId: uuid("account_id").references(() => connectedWebAccounts.id, { onDelete: "cascade" }),
    initiatingAgentId: uuid("initiating_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    initiatingRoomId: uuid("initiating_room_id").notNull().references(() => rooms.id, { onDelete: "restrict" }),
    initiatingThreadId: varchar("initiating_thread_id", { length: 512 }).notNull(),
    initiatingLane: varchar("initiating_lane", { length: 128 }).notNull(),
    deliveryId: varchar("delivery_id", { length: 256 }).notNull(),
    requestDigest: varchar("request_digest", { length: 64 }).notNull(),
    /** Encrypted/opaque original task authority; never a card, log, or model result. */
    sealedIntent: text("sealed_intent").notNull(),
    /** Optional link to the existing external-effect idempotency ledger. */
    actionOperationId: uuid("action_operation_id").references(() => connectedWebActionOperations.id, { onDelete: "restrict" }),
    effectIdempotencyKey: varchar("effect_idempotency_key", { length: 256 }),
    driver: varchar("driver", { length: 16, enum: CONNECTED_WEB_OPERATION_DRIVERS }).notNull().default("hosted"),
    lifecycle: varchar("lifecycle", { length: 16, enum: CONNECTED_WEB_OPERATION_LIFECYCLES }).notNull().default("admitted"),
    /** Every Human/direct/hosted writer handoff increments this epoch. */
    controlEpoch: bigint("control_epoch", { mode: "number" }).notNull().default(1),
    /** DB-minted lease proof; never accepted from a client or provider event. */
    controlLeaseToken: uuid("control_lease_token").notNull().defaultRandom(),
    controlLeaseExpiresAt: timestamp("control_lease_expires_at", { withTimezone: true }),
    sealedProviderRefs: jsonb("sealed_provider_refs").$type<ConnectedWebOperationProviderReferences>()
      .notNull().default(sql`'{"version":1}'::jsonb`),
    eventCursor: bigint("event_cursor", { mode: "number" }).notNull().default(0),
    safeActivity: jsonb("safe_activity").$type<ConnectedWebOperationSafeActivity>().notNull(),
    wakeFingerprint: varchar("wake_fingerprint", { length: 128 }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    /** A Genie-requested wake is independent of provider polling cadence. */
    requestedWakeAt: timestamp("requested_wake_at", { withTimezone: true }),
    supervisorClaimOwner: varchar("supervisor_claim_owner", { length: 128 }),
    supervisorClaimExpiresAt: timestamp("supervisor_claim_expires_at", { withTimezone: true }),
    wakeClaimOwner: varchar("wake_claim_owner", { length: 128 }),
    wakeClaimExpiresAt: timestamp("wake_claim_expires_at", { withTimezone: true }),
    wakeAttempts: bigint("wake_attempts", { mode: "number" }).notNull().default(0),
    wakeDeliveredAt: timestamp("wake_delivered_at", { withTimezone: true }),
    cumulativeCostUsdMicros: bigint("cumulative_cost_usd_micros", { mode: "number" }).notNull().default(0),
    remainingBudgetUsdMicros: bigint("remaining_budget_usd_micros", { mode: "number" }).notNull(),
    terminalReceipt: jsonb("terminal_receipt").$type<ConnectedWebOperationSafeReceipt>(),
    /** Versioned, provider-free completed text-read projection; null for non-read terminals. */
    terminalReadResult: jsonb("terminal_read_result").$type<unknown>(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    /** Terminal browser custody: null after stop or atomic transfer to a later operation. */
    browserIdleUntil: timestamp("browser_idle_until", { withTimezone: true }),
    /** Irreversible cleanup fence; a claimed browser can never be reused. */
    browserCleanupStartedAt: timestamp("browser_cleanup_started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_connected_web_operations_owner_delivery").on(table.ownerUserId, table.deliveryId),
    index("idx_connected_web_operations_account_updated").on(table.accountId, table.updatedAt),
    index("idx_connected_web_operations_browser_idle").on(table.browserIdleUntil)
      .where(sql`${table.browserIdleUntil} is not null`),
    index("idx_connected_web_operations_supervisor_due").on(table.lifecycle, table.nextCheckAt, table.updatedAt)
      .where(sql`${table.lifecycle} in ('admitted', 'running', 'attention')`),
    index("idx_connected_web_operations_wake_due").on(table.wakeDeliveredAt, table.updatedAt)
      .where(sql`${table.wakeFingerprint} is not null and ${table.wakeDeliveredAt} is null`),
    index("idx_connected_web_operations_requested_wake").on(table.requestedWakeAt)
      .where(sql`${table.requestedWakeAt} is not null`),
    check("connected_web_operations_thread_nonempty", sql`octet_length(${table.initiatingThreadId}) between 1 and 512`),
    check("connected_web_operations_lane_nonempty", sql`octet_length(${table.initiatingLane}) between 1 and 128`),
    check("connected_web_operations_delivery_nonempty", sql`octet_length(${table.deliveryId}) between 1 and 256`),
    check("connected_web_operations_digest", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
    check("connected_web_operations_sealed_intent_nonempty", sql`octet_length(${table.sealedIntent}) between 1 and 16384`),
    check("connected_web_operations_effect_key_shape", sql`${table.effectIdempotencyKey} is null or octet_length(${table.effectIdempotencyKey}) between 1 and 256`),
    check("connected_web_operations_public_read", sql`${table.accountId} is not null or (${table.actionOperationId} is null and ${table.effectIdempotencyKey} is null and ${table.driver} in ('hosted', 'checking'))`),
    check("connected_web_operations_driver", sql`${table.driver} in ('hosted', 'checking', 'direct', 'human')`),
    check("connected_web_operations_lifecycle", sql`${table.lifecycle} in ('admitted', 'running', 'attention', 'terminal')`),
    check("connected_web_operations_epoch", sql`${table.controlEpoch} >= 1`),
    check("connected_web_operations_cursor", sql`${table.eventCursor} >= 0`),
    check("connected_web_operations_cost", sql`${table.cumulativeCostUsdMicros} >= 0 and ${table.remainingBudgetUsdMicros} >= 0`),
    check("connected_web_operations_supervisor_claim", sql`(${table.supervisorClaimOwner} is null) = (${table.supervisorClaimExpiresAt} is null)`),
    check("connected_web_operations_wake_claim", sql`(${table.wakeClaimOwner} is null) = (${table.wakeClaimExpiresAt} is null)`),
    check("connected_web_operations_wake_attempts", sql`${table.wakeAttempts} >= 0`),
    check("connected_web_operations_terminal_shape", sql`(${table.lifecycle} = 'terminal') = (${table.terminalAt} is not null) and (${table.lifecycle} = 'terminal') = (${table.terminalReceipt} is not null)`),
    check("connected_web_operations_provider_refs_shape", sql`
      jsonb_typeof(${table.sealedProviderRefs}) = 'object'
      and ${table.sealedProviderRefs} ? 'version'
      and ${table.sealedProviderRefs} - 'version' - 'sessionRef' - 'runRef' - 'workspaceRef' - 'browserRef' = '{}'::jsonb
      and ${table.sealedProviderRefs}->>'version' = '1'
      and (not (${table.sealedProviderRefs} ? 'sessionRef') or jsonb_typeof(${table.sealedProviderRefs}->'sessionRef') = 'string')
      and (not (${table.sealedProviderRefs} ? 'runRef') or jsonb_typeof(${table.sealedProviderRefs}->'runRef') = 'string')
      and (not (${table.sealedProviderRefs} ? 'workspaceRef') or jsonb_typeof(${table.sealedProviderRefs}->'workspaceRef') = 'string')
      and (not (${table.sealedProviderRefs} ? 'browserRef') or jsonb_typeof(${table.sealedProviderRefs}->'browserRef') = 'string')
    `),
    check("connected_web_operations_safe_activity_shape", sql`
      jsonb_typeof(${table.safeActivity}) = 'object'
      and ${table.safeActivity} ?& array['version', 'phase', 'code', 'summary']
      and ${table.safeActivity} - 'version' - 'phase' - 'code' - 'summary' = '{}'::jsonb
      and ${table.safeActivity}->>'version' = '1'
      and ${table.safeActivity}->>'phase' in ('starting', 'working', 'checking', 'attention', 'finishing')
      and jsonb_typeof(${table.safeActivity}->'code') = 'string'
      and jsonb_typeof(${table.safeActivity}->'summary') = 'string'
    `),
    check("connected_web_operations_terminal_receipt_shape", sql`
      ${table.terminalReceipt} is null or (
        jsonb_typeof(${table.terminalReceipt}) = 'object'
        and ${table.terminalReceipt} ?& array['version', 'outcome', 'code', 'summary']
        and ${table.terminalReceipt} - 'version' - 'outcome' - 'code' - 'summary' - 'actionOperationId' = '{}'::jsonb
        and ${table.terminalReceipt}->>'version' = '1'
        and ${table.terminalReceipt}->>'outcome' in ('completed', 'cancelled', 'failed', 'attention_required', 'ambiguous')
      )
    `),
    check("connected_web_operations_terminal_read_result_shape", sql`
      ${table.terminalReadResult} is null or (
        jsonb_typeof(${table.terminalReadResult}) = 'object'
        and ${table.terminalReadResult}->>'version' = '1'
        and ${table.terminalReadResult} ?& array['version', 'account', 'page', 'read', 'cost', 'outputs', 'outputsTruncated']
        and ${table.terminalReadResult} - 'version' - 'account' - 'page' - 'read' - 'cost' - 'outputs' - 'outputsTruncated' = '{}'::jsonb
        and ((${table.accountId} is null and jsonb_typeof(${table.terminalReadResult}->'account') = 'null') or (${table.accountId} is not null and jsonb_typeof(${table.terminalReadResult}->'account') = 'object'))
        and jsonb_typeof(${table.terminalReadResult}->'page') = 'object'
        and jsonb_typeof(${table.terminalReadResult}->'read') in ('null', 'object')
        and jsonb_typeof(${table.terminalReadResult}->'cost') = 'object'
        and ${table.terminalReadResult}->'outputs' = '[]'::jsonb
        and ${table.terminalReadResult}->>'outputsTruncated' = 'false'
      )
    `),
    check("connected_web_operations_terminal_read_result_owner", sql`
      ${table.terminalReadResult} is null or (${table.lifecycle} = 'terminal' and ${table.actionOperationId} is null)
    `),
    pgPolicy("connected_web_operations_product_all", {
      as: "permissive", for: "all", to: nautiloProductRole, using: sql`true`, withCheck: sql`true`,
    }),
  ],
).enableRLS();

export type ConnectedWebOperationRow = typeof connectedWebOperations.$inferSelect;
export type NewConnectedWebOperationRow = typeof connectedWebOperations.$inferInsert;

/** Sanitized append-only action ledger; raw event data/URLs/reasoning never enter this table. */
export const connectedWebOperationActivityEntries = pgTable("connected_web_operation_activity_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  operationId: uuid("operation_id").notNull().references(() => connectedWebOperations.id, { onDelete: "cascade" }),
  controlEpoch: bigint("control_epoch", { mode: "number" }).notNull(),
  providerEventId: bigint("provider_event_id", { mode: "number" }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  status: varchar("status", { length: 16, enum: ["pending", "running", "completed", "error"] }).notNull(),
  summary: text("summary").notNull(),
}, (table) => [
  uniqueIndex("uq_connected_web_activity_event").on(table.operationId, table.controlEpoch, table.providerEventId),
  index("idx_connected_web_activity_page").on(table.operationId, table.id),
  pgPolicy("connected_web_activity_product_all", { as: "permissive", for: "all", to: nautiloProductRole, using: sql`true`, withCheck: sql`true` }),
]).enableRLS();
