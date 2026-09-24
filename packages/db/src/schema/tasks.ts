import { sql } from "drizzle-orm";
import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, index, check, customType, foreignKey } from "drizzle-orm/pg-core";
import { SELECTION_PROFILES, type ComboSpec } from "@nautilo/types";
import { users } from "./users";
import { agents } from "./agents";
import { rooms } from "./rooms";
import { agentScopes } from "./agent-scopes";
import { cryptoObjects } from "./crypto-storage";
import { namespaces } from "./trust";
import { taskDefinitionCryptoRevisions } from "./task-definition-crypto-revisions";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    requestorId: uuid("requestor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    expectedOutput: text("expected_output"),
    preset: text("preset", {
      enum: ["task", "in_scope", "in_private_namespace", "in_background", "schedule", "ask_peer", "ping", "repo_docs"],
    }).notNull().default("task"),
    scheduleKind: text("schedule_kind", { enum: ["now", "one_shot", "cron"] }).notNull().default("now"),
    runAt: timestamp("run_at", { withTimezone: true }),
    cron: text("cron"),
    timezone: text("timezone").notNull().default("UTC"),
    catchup: text("catchup", { enum: ["skip", "run_once"] }).notNull().default("run_once"),
    callingRoomId: uuid("calling_room_id").references(() => rooms.id, { onDelete: "set null" }),
    targetChat: text("target_chat", {
      enum: ["last_in_namespace", "new_in_namespace", "last_dm", "new_dm", "orphan"],
    }).notNull().default("orphan"),
    targetChatHandle: text("target_chat_handle"),
    targetRoomId: uuid("target_room_id").references(() => rooms.id, { onDelete: "set null" }),
    resultDelivery: text("result_delivery", { enum: ["wake", "raw", "raw_and_wake"] }).notNull().default("wake"),
    targetUserIds: uuid("target_user_ids").array().notNull().default([]),
    useScope: boolean("use_scope").notNull().default(false),
    scopeId: uuid("scope_id").references(() => agentScopes.id, { onDelete: "set null" }),
    toolsMode: text("tools_mode", { enum: ["auto", "none", "whitelist"] }).notNull().default("auto"),
    toolsWhitelist: text("tools_whitelist").array().notNull().default([]),
    awaitResponse: boolean("await_response").notNull().default(false),
    // M152 — multi-axis model selection. Replaces the one-dimensional
    // `privacy_mode boolean`. `selection_profile` is the named intent (Tier-1);
    // `selection_spec` is the explicit {band?, objective} override (Tier-2).
    selectionProfile: text("selection_profile", {
      enum: SELECTION_PROFILES,
    })
      .notNull()
      .default("balanced"),
    selectionSpec: jsonb("selection_spec").$type<ComboSpec | null>(),
    // D429 Phase 3 — exact model pin. Mutually exclusive with the M152
    // selection profile/spec above. Null = no exact pin (the row falls back to
    // the profile/spec resolver at dispatch). No FK: the resolved catalog is a
    // runtime projection, not a static table, so a FK would couple the schema
    // to a catalog that does not exist in the database.
    requestedModelId: text("requested_model_id"),
    timeLimitSeconds: integer("time_limit_seconds"),
    parentTaskId: uuid("parent_task_id"), // self-FK enforced in migration
    depth: integer("depth").notNull().default(0),
    status: text("status", {
      enum: ["pending", "running", "awaiting", "paused", "completed", "cancelled", "errored"],
    }).notNull().default("pending"),
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    fireLockId: uuid("fire_lock_id"),
    fireLockedAt: timestamp("fire_locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    contentRepresentation: text("content_representation", {
      enum: ["ordinary", "dual", "protected"],
    }).notNull().default("ordinary"),
    contentNamespaceId: uuid("content_namespace_id").references(
      () => namespaces.id,
      { onDelete: "restrict" },
    ),
    contentRevision: integer("content_revision").notNull().default(0),
    cryptoObjectId: text("crypto_object_id").references(
      () => cryptoObjects.objectId,
      { onDelete: "no action" },
    ),
    cryptoAccessRevision: integer("crypto_access_revision").notNull().default(0),
    cryptoRequiredNamespaceFingerprint: bytea("crypto_required_namespace_fingerprint"),
    cryptoMappingState: text("crypto_mapping_state", {
      enum: ["unmapped", "verified", "stale"],
    }).notNull().default("unmapped"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    index("tasks_due_idx").on(t.status, t.nextFireAt),
    index("tasks_owner_idx").on(t.ownerId, t.status),
    index("tasks_calling_room_idx").on(t.callingRoomId),
    foreignKey({
      name: "tasks_current_crypto_revision_fk",
      columns: [t.id, t.contentNamespaceId, t.contentRevision, t.cryptoObjectId, t.cryptoRequiredNamespaceFingerprint],
      foreignColumns: [
        taskDefinitionCryptoRevisions.taskId,
        taskDefinitionCryptoRevisions.contentNamespaceId,
        taskDefinitionCryptoRevisions.contentRevision,
        taskDefinitionCryptoRevisions.cryptoObjectId,
        taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
      ],
    }).onDelete("restrict"),
    check("tasks_content_revision_nonnegative", sql`${t.contentRevision} >= 0`),
    check("tasks_crypto_access_revision_nonnegative", sql`${t.cryptoAccessRevision} >= 0`),
    check("tasks_crypto_mapping_coherent", sql`(
      ${t.contentRepresentation} = 'ordinary'
      and ${t.contentNamespaceId} is null
      and ${t.contentRevision} = 0
      and ${t.cryptoObjectId} is null
      and ${t.cryptoAccessRevision} = 0
      and ${t.cryptoRequiredNamespaceFingerprint} is null
      and ${t.cryptoMappingState} = 'unmapped'
    ) or (
      ${t.contentRepresentation} in ('dual', 'protected')
      and ${t.contentNamespaceId} is not null
      and ${t.contentRevision} > 0
      and ${t.cryptoObjectId} is not null
      and ${t.cryptoAccessRevision} >= 0
      and octet_length(${t.cryptoRequiredNamespaceFingerprint}) = 32
      and ${t.cryptoMappingState} in ('verified', 'stale')
      and (${t.contentRepresentation} <> 'protected' or (
        ${t.prompt} = ''
        and ${t.expectedOutput} is null
        and ${t.lastError} is null
      ))
    )`),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
