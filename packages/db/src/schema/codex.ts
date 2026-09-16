import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { jobs } from "./jobs";
import { rooms } from "./rooms";
import { tasks } from "./tasks";
import { taskRuns } from "./task-runs";
import { users } from "./users";

/**
 * Deliberately small, server-retained usage projection. It is not a relay or
 * provider wire type: callers must map provider responses into this stable,
 * safe vocabulary before persistence. The database repeats this allowlist so
 * an unchecked JSON write cannot bypass the TypeScript boundary.
 */
type CodexUsageSnapshotFields = {
  schemaVersion: 1;
  rateLimits: {
    primary: CodexUsageRateLimitWindow | null;
    secondary: CodexUsageRateLimitWindow | null;
    plan: CodexUsagePlan | null;
    credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
    spendControl: { limit: string; used: string; remainingPercent: number; resetsAt: string } | null;
    reached: "rate_limit_reached" | "credits_depleted" | "usage_limit_reached" | null;
    observedAt: string;
    freshness: "live" | "cached" | "stale";
  };
  usage: {
    summary: {
      lifetimeTokens: string | null;
      peakDailyTokens: string | null;
      longestRunningTurnSec: string | null;
      currentStreakDays: string | null;
      longestStreakDays: string | null;
    };
    daily: readonly { startDate: string; tokens: string }[];
    observedAt: string;
    freshness: "live" | "cached" | "stale";
  };
};

/** At least one reviewed safe projection must be present; an empty envelope is invalid. */
export type CodexUsageSnapshot =
  | (Pick<CodexUsageSnapshotFields, "schemaVersion" | "rateLimits"> &
      Partial<Pick<CodexUsageSnapshotFields, "usage">>)
  | (Pick<CodexUsageSnapshotFields, "schemaVersion" | "usage"> &
      Partial<Pick<CodexUsageSnapshotFields, "rateLimits">>);

export type CodexUsagePlan =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "usage_based"
  | "unknown";

export type CodexUsageRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
};

/**
 * D453 — server-retained, safe metadata for one isolated Codex account home.
 *
 * `homeHandle` is an opaque host-generated identifier. It is deliberately not
 * a filesystem path, a reversible path encoding, or authentication material.
 * The paired host remains the only place that can resolve it to a private
 * CODEX_HOME. Provider usage is a bounded, sanitized projection; callers must
 * never put raw account or login responses into `usageSnapshot`.
 */
export const codexAccountProfiles = pgTable(
  "codex_account_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Opaque paired-host relay identity, never a host address. */
    relayId: text("relay_id").notNull(),
    /** Opaque host-minted profile/home handle; never a local path. */
    homeHandle: text("home_handle").notNull(),
    /** Human-authored local label only; it is not an account identifier. */
    label: varchar("label", { length: 120 }).notNull(),
    /** Last provider-verified display identity; never a token or local path. */
    accountEmail: varchar("account_email", { length: 320 }),
    /** Host profile generation; changes when the isolated home is recreated. */
    profileGeneration: integer("profile_generation").notNull().default(0),
    /** Official-account generation; stale child/account events must not cross it. */
    accountGeneration: integer("account_generation").notNull().default(0),
    /** A fresh private home is not selectable until official account/read proves sign-in. */
    registrationState: varchar("registration_state", {
      length: 16,
      enum: ["provisional", "registered"],
    })
      .notNull()
      .default("registered"),
    authState: varchar("auth_state", { length: 32 })
      .notNull()
      .default("signed_out"),
    /** Provider-reported plan class, if a safe projection is available. */
    planType: varchar("plan_type", { length: 120 }),
    /** Sanitized, bounded usage/rate-limit projection (D453 task 2.4 owns writes). */
    usageSnapshot: jsonb("usage_snapshot").$type<CodexUsageSnapshot>(),
    usageObservedAt: timestamp("usage_observed_at", { withTimezone: true }),
    /** Stable product error vocabulary only; never an upstream error blob. */
    lastErrorCode: varchar("last_error_code", { length: 96 }),
    /** Optimistic-concurrency revision for profile/default mutations. */
    revision: integer("revision").notNull().default(0),
    /** Two-phase, history-retaining removal lifecycle. */
    removalState: varchar("removal_state", { length: 16 })
      .notNull()
      .default("active"),
    /** Set only once the paired host has finalized the removal. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_codex_account_profiles_user_relay_home")
      .on(table.userId, table.relayId, table.homeHandle),
    // Allows child Human×Agent/binding rows to reference `(id, user_id)` as
    // one atomic owner-scoped identity. A plain `account_profile_id` FK would
    // let a guessed foreign UUID pass referential integrity.
    unique("uq_codex_account_profiles_user_id").on(table.userId, table.id),
    // Retained audit/history access path. Do not replace this with the
    // owner-visible partial index below: removed profiles remain queryable to
    // operational/audit code by their original owner.
    index("idx_codex_account_profiles_user").on(table.userId, table.updatedAt),
    // Normal owner UI reads never surface finalized removals, while a removal
    // in flight stays visible so the caller can retry/finalize it.
    index("idx_codex_account_profiles_owner_visible")
      .on(table.userId, table.updatedAt)
      .where(sql`${table.removalState} <> 'removed'`),
    index("idx_codex_account_profiles_user_relay").on(table.userId, table.relayId),
    uniqueIndex("uq_codex_account_profiles_active_provisional_owner_relay")
      .on(table.userId, table.relayId)
      .where(sql`${table.removalState} <> 'removed' AND ${table.registrationState} = 'provisional'`),
    check(
      "codex_account_profiles_registration_state_check",
      sql`${table.registrationState} IN ('provisional', 'registered')`,
    ),
    check(
      "codex_account_profiles_provisional_auth_check",
      sql`${table.registrationState} <> 'provisional' OR ${table.authState} <> 'signed_in'`,
    ),
    check(
      "codex_account_profiles_auth_state_check",
      sql`${table.authState} IN ('signed_out', 'login_pending', 'signed_in', 'expired', 'error')`,
    ),
    check(
      "codex_account_profiles_revision_check",
      sql`${table.revision} >= 0 AND ${table.profileGeneration} >= 0 AND ${table.accountGeneration} >= 0`,
    ),
    check(
      "codex_account_profiles_removal_state_check",
      sql`(${table.removalState} IN ('active', 'removing') AND ${table.removedAt} IS NULL)
        OR (${table.removalState} = 'removed' AND ${table.removedAt} IS NOT NULL)`,
    ),
    check(
      "codex_account_profiles_plan_type_check",
      sql`${table.planType} IS NULL OR ${table.planType} IN ('free', 'go', 'plus', 'pro', 'prolite', 'team', 'business', 'enterprise', 'ent26', 'edu', 'usage_based', 'unknown', 'self_serve_business_usage_based', 'enterprise_cbp_usage_based')`,
    ),
    // `app_is_valid_codex_usage_snapshot` is added by the D453 migration
    // before this generated constraint. Keep this schema expression aligned
    // with its SQL allowlist; TypeScript alone is not a write boundary.
    check(
      "codex_account_profiles_usage_snapshot_check",
      sql`${table.usageSnapshot} IS NULL OR app_is_valid_codex_usage_snapshot(${table.usageSnapshot})`,
    ),
    check(
      "codex_account_profiles_usage_freshness_check",
      sql`(${table.usageSnapshot} IS NULL AND ${table.usageObservedAt} IS NULL)
        OR (${table.usageSnapshot} IS NOT NULL
          AND ${table.usageObservedAt} IS NOT NULL
          AND ${table.usageObservedAt} >= ${table.createdAt}
          AND ${table.usageObservedAt} <= ${table.updatedAt})`,
    ),
    check(
      "codex_account_profiles_home_handle_check",
      sql`char_length(${table.homeHandle}) BETWEEN 1 AND 512
        AND position('/' in ${table.homeHandle}) = 0
        AND position(chr(92) in ${table.homeHandle}) = 0
        AND position('..' in ${table.homeHandle}) = 0`,
    ),
  ],
);

/** D453 — the Human-level Codex default configured in Connections. */
export const codexUserPreferences = pgTable(
  "codex_user_preferences",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    /** Nullable until an explicit owner-selected profile is chosen. */
    accountProfileId: uuid("account_profile_id"),
    defaultPosture: varchar("default_posture", { length: 32 })
      .notNull()
      .default("codex_default"),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "codex_user_preferences_profile_owner_fk",
      columns: [table.userId, table.accountProfileId],
      foreignColumns: [codexAccountProfiles.userId, codexAccountProfiles.id],
    }).onDelete("restrict"),
    index("idx_codex_user_preferences_profile")
      .on(table.accountProfileId)
      .where(sql`${table.accountProfileId} IS NOT NULL`),
    check(
      "codex_user_preferences_posture_check",
      sql`${table.defaultPosture} IN ('codex_default', 'prompted_workspace', 'full_access_headless')`,
    ),
    check(
      "codex_user_preferences_revision_check",
      sql`${table.revision} >= 0`,
    ),
    check(
      "codex_user_preferences_enabled_profile_check",
      sql`${table.enabled} = false OR ${table.accountProfileId} IS NOT NULL`,
    ),
  ],
);

/**
 * D453 — immutable, owner-scoped projection of one Codex thread binding.
 *
 * Every host/session/workspace field below is an opaque paired-host receipt or
 * stable identifier. No local root, executable, auth state, or raw app-server
 * envelope is retained here. Replacement archives a row and creates a new
 * binding. The sole same-row exception is an exact rebind from `needs_rebind`:
 * it may replace a short-lived receipt/session scope while preserving the
 * thread's identity, ownership, account, posture, and selected model.
 */
export const codexThreadBindings = pgTable(
  "codex_thread_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceAgentId: uuid("source_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    /** Canonical source Task for delegated Codex work. */
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    /** Exact durable run and foreground Job that admitted this Codex thread. */
    taskRunId: uuid("task_run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "restrict" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    /** Parent task lineage, retained when a Genie delegated the source Task. */
    parentTaskId: uuid("parent_task_id").references(() => tasks.id, {
      onDelete: "restrict",
    }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "restrict" }),
    /** Canonical room/task lane identity, not a filesystem location. */
    laneKey: text("lane_key").notNull(),
    bindingKind: varchar("binding_kind", { length: 16 }).notNull(),
    relayId: text("relay_id").notNull(),
    relaySessionId: text("relay_session_id").notNull(),
    desktopSessionId: text("desktop_session_id").notNull(),
    pairingGenerationRef: text("pairing_generation_ref").notNull(),
    capabilityRevision: integer("capability_revision").notNull(),
    /** Opaque host-minted WorkspaceReceipt fields; no selected path is stored. */
    workspaceRef: text("workspace_ref").notNull(),
    workspaceRevision: integer("workspace_revision").notNull(),
    workspaceFingerprint: text("workspace_fingerprint").notNull(),
    workspaceIssuedAt: timestamp("workspace_issued_at", { withTimezone: true }).notNull(),
    workspaceExpiresAt: timestamp("workspace_expires_at", { withTimezone: true }).notNull(),
    accountProfileId: uuid("account_profile_id").notNull(),
    /** Opaque Codex thread id, not an application path or transcript payload. */
    codexThreadId: text("codex_thread_id").notNull(),
    profileGeneration: integer("profile_generation").notNull(),
    accountGeneration: integer("account_generation").notNull(),
    runtimeGeneration: integer("runtime_generation").notNull(),
    childGeneration: integer("child_generation").notNull(),
    bindingGeneration: integer("binding_generation").notNull().default(0),
    selectedModel: text("selected_model"),
    codexSandboxMode: varchar("codex_sandbox_mode", { length: 32 }).notNull(),
    codexApprovalPolicy: varchar("codex_approval_policy", { length: 32 }).notNull(),
    state: varchar("state", { length: 32 }).notNull().default("opening"),
    lastTurnId: text("last_turn_id"),
    lastItemCursor: text("last_item_cursor"),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Non-null rows are immutable retained history and never start new turns. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_codex_thread_bindings_user_created")
      .on(table.userId, table.createdAt),
    index("idx_codex_thread_bindings_task").on(table.taskId, table.createdAt),
    index("idx_codex_thread_bindings_task_run").on(table.taskRunId, table.createdAt),
    index("idx_codex_thread_bindings_job").on(table.jobId),
    index("idx_codex_thread_bindings_profile")
      .on(table.accountProfileId, table.createdAt),
    index("idx_codex_thread_bindings_room_lane")
      .on(table.roomId, table.laneKey, table.createdAt),
    // Lets durable owner-Human request facts reference a binding without
    // accepting a guessed foreign binding UUID. The tuple is otherwise
    // immutable, except for the separately fenced live receipt generation.
    unique("uq_codex_thread_bindings_user_id").on(table.userId, table.id),
    foreignKey({
      name: "codex_thread_bindings_profile_owner_fk",
      columns: [table.userId, table.accountProfileId],
      foreignColumns: [codexAccountProfiles.userId, codexAccountProfiles.id],
    }).onDelete("restrict"),
    uniqueIndex("uq_codex_thread_bindings_active_task")
      .on(table.userId, table.taskId)
      .where(sql`${table.bindingKind} = 'task' AND ${table.archivedAt} IS NULL`),
    check(
      "codex_thread_bindings_generations_check",
      sql`${table.capabilityRevision} >= 0 AND ${table.workspaceRevision} >= 0 AND ${table.profileGeneration} >= 0 AND ${table.accountGeneration} >= 0 AND ${table.runtimeGeneration} >= 0 AND ${table.childGeneration} >= 0 AND ${table.bindingGeneration} >= 0 AND ${table.revision} >= 0`,
    ),
    check(
      "codex_thread_bindings_sandbox_check",
      sql`${table.codexSandboxMode} IN ('default', 'workspace-write', 'danger-full-access')`,
    ),
    check(
      "codex_thread_bindings_approval_check",
      sql`${table.codexApprovalPolicy} IN ('default', 'on-request', 'never')`,
    ),
    check(
      "codex_thread_bindings_state_check",
      sql`${table.state} IN ('opening', 'active', 'queued', 'awaiting_approval', 'awaiting_input', 'needs_rebind', 'completed', 'cancelled', 'errored', 'recovery_required', 'archived')`,
    ),
    check(
      "codex_thread_bindings_kind_check",
      sql`${table.bindingKind} = 'task'`,
    ),
    check(
      "codex_thread_bindings_workspace_receipt_time_check",
      sql`${table.workspaceIssuedAt} < ${table.workspaceExpiresAt}`,
    ),
    check(
      "codex_thread_bindings_archive_state_check",
      sql`(${table.archivedAt} IS NULL AND ${table.state} <> 'archived') OR (${table.archivedAt} IS NOT NULL AND ${table.state} = 'archived')`,
    ),
  ],
);

/**
 * D453 task 4.7 — bounded, durable presentation of one Codex-native
 * `item/tool/requestUserInput` request.
 *
 * This is deliberately not a generic provider-request table. The Electron
 * request broker retains the upstream JSON-RPC id and the Human answer in its
 * in-memory closure. This table holds only enough safe semantic detail for
 * Nautilo to show the owning Human an interrupted/restarted request and to
 * fence a later response against the exact binding/turn/item that originated
 * it.
 */
export type CodexUserInputQuestion = {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly isOther: boolean;
  readonly isSecret: boolean;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
  }[] | null;
};

export type CodexUserInputRequestState =
  | "awaiting_human"
  | "dispatching"
  | "submitted"
  | "expired"
  | "cancelled"
  | "unavailable"
  | "terminal";

export const codexUserInputRequests = pgTable(
  "codex_user_input_requests",
  {
    /** Opaque Nautilo correlation token, never an upstream JSON-RPC id. */
    requestRef: text("request_ref").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Retained only to re-enter the binding's forced-RLS scope for CAS. */
    sourceAgentId: uuid("source_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "restrict" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    taskRunId: uuid("task_run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "restrict" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    bindingId: uuid("binding_id").notNull(),
    /** Reject a response after the binding's live receipt was replaced. */
    bindingGeneration: integer("binding_generation").notNull(),
    /** Safe app-server correlation, not a transcript, path, or raw frame. */
    codexThreadId: text("codex_thread_id").notNull(),
    codexTurnId: text("codex_turn_id").notNull(),
    codexItemId: text("codex_item_id").notNull(),
    /** Strictly bounded semantic projection from the relay request. */
    questions: jsonb("questions").$type<readonly CodexUserInputQuestion[]>().notNull(),
    autoResolutionMs: integer("auto_resolution_ms"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    state: varchar("state", { length: 24 })
      .$type<CodexUserInputRequestState>()
      .notNull()
      .default("awaiting_human"),
    /** Stable Nautilo code only; never an upstream error string or answer. */
    failureCode: varchar("failure_code", { length: 96 }),
    revision: integer("revision").notNull().default(0),
    dispatchingAt: timestamp("dispatching_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "codex_user_input_requests_binding_owner_fk",
      columns: [table.userId, table.bindingId],
      foreignColumns: [codexThreadBindings.userId, codexThreadBindings.id],
    }).onDelete("restrict"),
    // One upstream input item is a one-shot authority. This blocks a replay
    // with a fresh local requestRef from reopening a prior Human prompt.
    uniqueIndex("uq_codex_user_input_requests_binding_turn_item")
      .on(
        table.bindingId,
        table.bindingGeneration,
        table.codexThreadId,
        table.codexTurnId,
        table.codexItemId,
      ),
    index("idx_codex_user_input_requests_owner_state_expiry")
      .on(table.userId, table.state, table.expiresAt),
    index("idx_codex_user_input_requests_terminal_retention")
      .on(table.terminalAt)
      .where(sql`${table.terminalAt} IS NOT NULL`),
    check(
      "codex_user_input_requests_ref_check",
      sql`octet_length(convert_to(${table.requestRef}, 'UTF8')) BETWEEN 1 AND 512`,
    ),
    check(
      "codex_user_input_requests_correlation_check",
      sql`octet_length(convert_to(${table.codexThreadId}, 'UTF8')) BETWEEN 1 AND 512
        AND octet_length(convert_to(${table.codexTurnId}, 'UTF8')) BETWEEN 1 AND 512
        AND octet_length(convert_to(${table.codexItemId}, 'UTF8')) BETWEEN 1 AND 512
        AND ${table.bindingGeneration} >= 0
        AND ${table.revision} >= 0`,
    ),
    check(
      "codex_user_input_requests_questions_check",
      sql`app_is_valid_codex_user_input_questions(${table.questions})`,
    ),
    check(
      "codex_user_input_requests_auto_resolution_check",
      sql`${table.autoResolutionMs} IS NULL OR ${table.autoResolutionMs} BETWEEN 0 AND 300000`,
    ),
    check(
      "codex_user_input_requests_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "codex_user_input_requests_timestamp_order_check",
      sql`${table.updatedAt} >= ${table.createdAt}
        AND (${table.dispatchingAt} IS NULL OR ${table.dispatchingAt} >= ${table.createdAt})
        AND (${table.submittedAt} IS NULL OR (${table.submittedAt} >= ${table.createdAt}
          AND ${table.dispatchingAt} IS NOT NULL
          AND ${table.submittedAt} >= ${table.dispatchingAt}))
        AND (${table.terminalAt} IS NULL OR ${table.terminalAt} >= ${table.createdAt})`,
    ),
    check(
      "codex_user_input_requests_state_check",
      sql`${table.state} IN ('awaiting_human', 'dispatching', 'submitted', 'expired', 'cancelled', 'unavailable', 'terminal')`,
    ),
    check(
      "codex_user_input_requests_failure_check",
      sql`${table.failureCode} IS NULL OR ${table.failureCode} IN ('CODEX_REQUEST_EXPIRED', 'CODEX_REQUEST_CANCELLED', 'CODEX_REQUEST_UNAVAILABLE')`,
    ),
    check(
      "codex_user_input_requests_transition_shape_check",
      sql`(${table.state} = 'awaiting_human'
          AND ${table.dispatchingAt} IS NULL
          AND ${table.submittedAt} IS NULL
          AND ${table.terminalAt} IS NULL
          AND ${table.failureCode} IS NULL)
        OR (${table.state} = 'dispatching'
          AND ${table.dispatchingAt} IS NOT NULL
          AND ${table.submittedAt} IS NULL
          AND ${table.terminalAt} IS NULL
          AND ${table.failureCode} IS NULL)
        OR (${table.state} = 'submitted'
          AND ${table.dispatchingAt} IS NOT NULL
          AND ${table.submittedAt} IS NOT NULL
          AND ${table.terminalAt} IS NULL
          AND ${table.failureCode} IS NULL)
        OR (${table.state} = 'expired'
          AND ${table.terminalAt} IS NOT NULL
          AND ${table.failureCode} = 'CODEX_REQUEST_EXPIRED')
        OR (${table.state} = 'cancelled'
          AND ${table.terminalAt} IS NOT NULL
          AND ${table.failureCode} = 'CODEX_REQUEST_CANCELLED')
        OR (${table.state} = 'unavailable'
          AND ${table.terminalAt} IS NOT NULL
          AND ${table.failureCode} = 'CODEX_REQUEST_UNAVAILABLE')
        OR (${table.state} = 'terminal'
          AND ${table.terminalAt} IS NOT NULL
          AND ${table.failureCode} IS NULL)`,
    ),
  ],
);

export type CodexAccountProfile = typeof codexAccountProfiles.$inferSelect;
export type NewCodexAccountProfile = typeof codexAccountProfiles.$inferInsert;
export type CodexUserPreference = typeof codexUserPreferences.$inferSelect;
export type NewCodexUserPreference = typeof codexUserPreferences.$inferInsert;
export type CodexThreadBinding = typeof codexThreadBindings.$inferSelect;
export type NewCodexThreadBinding = typeof codexThreadBindings.$inferInsert;
export type CodexUserInputRequest = typeof codexUserInputRequests.$inferSelect;
export type NewCodexUserInputRequest = typeof codexUserInputRequests.$inferInsert;
