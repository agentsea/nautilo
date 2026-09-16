import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CommandSignature } from "@nautilo/types";
import { users } from "./users";
import { agents } from "./agents";
import { rooms } from "./rooms";

// ---------------------------------------------------------------------------
// actors — identity root for the trust layer
// ---------------------------------------------------------------------------

export const actors = pgTable(
  "actors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    trustState: text("trust_state").notNull().default("verified"),
    /**
     * M042B: which flavor of identity this actor represents.
     * "user" (default) = a human — the only kind created by
     * seedTrustPersonal pre-M042B. "agent" = a per-agent actor row
     * minted by seedDefaultAgent so room_members can FK cleanly into
     * actors.id for both humans and agents. The default keeps every
     * existing row correct without a backfill.
     */
    kind: text("kind").notNull().default("user"),
    /**
     * M042B: back-pointer to agents.id when kind='agent'. NULL for
     * human actors. ON DELETE CASCADE so deleting an agent row cleans
     * up its mirror actor row atomically.
     */
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_actors_owner_kind").on(table.ownerId, table.kind),
    index("idx_actors_agent").on(table.agentId),
  ],
);

export type Actor = typeof actors.$inferSelect;
export type NewActor = typeof actors.$inferInsert;

// ---------------------------------------------------------------------------
// namespaces — memory / artifact scope boundaries (M044: Room-derived)
// ---------------------------------------------------------------------------
//
// M044 canonicalization (REL-NSP-RMS 1:1): Namespace belongs to a Room.
// The back-pointer lives on `rooms.namespace_id`, not on a `users.id`
// FK here. Pre-M044 the table carried `owner_id → users.id NOT NULL`
// as if a User owned the Namespace; the canonical model says a Room
// does — one Namespace per Room, minted transactionally with the Room
// by `seedDefaultRoom`. The `owner_id` column is dropped in migration
// 0016. `scope` + `label` stay as descriptive metadata (no gate path
// reads them post-M044); dropping them is a cosmetic follow-up.

export const namespaces = pgTable("namespaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").notNull(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Namespace = typeof namespaces.$inferSelect;
export type NewNamespace = typeof namespaces.$inferInsert;

// ---------------------------------------------------------------------------
// capabilities — atomic permissions
// ---------------------------------------------------------------------------

export const capabilities = pgTable("capabilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull(),
  category: text("category").notNull(),
});

export type Capability = typeof capabilities.$inferSelect;
export type NewCapability = typeof capabilities.$inferInsert;

// ---------------------------------------------------------------------------
// roles — named bundles of capabilities (M043: global, not per-group-type)
// ---------------------------------------------------------------------------
//
// M043 collapsed per-`group_type` duplication: pre-M043 the same slug
// (`owner`, `household`, `teammate`) appeared as multiple rows — one
// for `home/<slug>`, `work/<slug>`, `agent_ownership/<slug>`. Canonical
// model per REL-CAP-ROL / REL-ROL-SRV: one global row per slug, reused
// across every Group that wants that Role regardless of Group "type."
// The `group_type` column is gone; `slug` is UNIQUE so seeds can use
// `ON CONFLICT (slug) DO NOTHING`.

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    label: text("label").notNull(),
    isSystem: boolean("is_system").notNull().default(true),
  },
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

// ---------------------------------------------------------------------------
// roleCapabilities — M:N join between roles and capabilities
// ---------------------------------------------------------------------------

export const roleCapabilities = pgTable(
  "role_capabilities",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => capabilities.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.capabilityId] })],
);

// ---------------------------------------------------------------------------
// groups — server-wide labeled bags of Humans, each carrying one Role (M128)
// ---------------------------------------------------------------------------
//
// M128: Groups are server-scoped and Agent-agnostic. The pre-M128
// `agent_id` column (added in M042D for `type='agent_ownership'`
// back-pointer to agents) is dropped in migration 0062; permissions
// ride with the Human, not the (Human, Agent) pair. The `type`
// column now holds one of the six canonical ladder slugs (`owners`
// | `admins` | `superusers` | `members` | `contributors` |
// `guests`); a server has at most one row per slug, enforced by
// `uq_groups_type`.
//
// D418 Wave 2 / Stack 193 — system-managed discriminator. Canonical
// ladder Groups are platform/system-managed authorization objects
// independent of any Human account lifecycle (exactly like the ladder
// Roles, which use `roles.is_system`). They carry `is_system = true` and
// a NULL `owner_id`; deleting any Human (including the bootstrap owner)
// must NOT cascade-delete them or their memberships. User-managed
// Groups carry `is_system = false` and a required non-NULL `owner_id`
// (the pre-D418 FK lifecycle is preserved for them). The invariant is
// enforced by the `groups_system_owner_check` CHECK constraint
// (migration 0100): a system-managed Group has no Human owner, and a
// user-managed Group requires one — no fake system User or service
// principal is invented.

export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // D418 Wave 2: NULL for system-managed Groups (is_system=true),
    // required for user-managed Groups (is_system=false). The CHECK
    // constraint below enforces exactly one valid state per row.
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    isSystem: boolean("is_system").notNull().default(false),
    type: text("type").notNull(),
    label: text("label").notNull(),
    trustPreset: text("trust_preset").notNull().default("personal"),
    // M131: the 1:1 `role_id` column is gone. A Group now carries one or
    // more Roles via the `group_roles` junction (below). Canonical seeds
    // still map each of the six Groups to exactly one ladder Role, so a
    // fresh server behaves identically to the pre-M131 1:1 shape.
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    /** M128 — one canonical server-wide Group per ladder slug. */
    uniqueIndex("uq_groups_type").on(table.type),
    /** D418 Wave 2 — system-managed ⇔ no Human owner; user-managed ⇔ one. */
    check(
      "groups_system_owner_check",
      sql`(${table.isSystem} = true AND ${table.ownerId} IS NULL) OR (${table.isSystem} = false AND ${table.ownerId} IS NOT NULL)`,
    ),
  ],
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;

// ---------------------------------------------------------------------------
// groupRoles — M:N join between groups and the roles they carry (M131)
// ---------------------------------------------------------------------------
//
// M131: replaces the 1:1 `groups.role_id`. A Group may carry one or more
// Roles; a Human's effective Capabilities are the union across every Role
// of every Group they belong to. Canonical seeds map each of the six
// Groups to exactly one ladder Role (Requirement 5), so day-one behavior
// is unchanged. Mirrors `roleCapabilities`'s composite-PK shape. Catalogue
// data — NOT under Path-C RLS (mirrors role_capabilities; no POLICY).

export const groupRoles = pgTable(
  "group_roles",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.roleId] })],
);

export type GroupRole = typeof groupRoles.$inferSelect;
export type NewGroupRole = typeof groupRoles.$inferInsert;

// ---------------------------------------------------------------------------
// groupMembers — M:N join between groups and humans (M043)
// ---------------------------------------------------------------------------
//
// M043: per REL-GRP-HUM, Groups collect Humans (never Agents). Pre-M043
// this table FKed to `actors.id` with a runtime `kind='user'` check;
// the canonical model goes straight to `users.id` — the runtime check
// becomes a structural impossibility via the FK. Role is no longer a
// per-member column (moved to `groups.role_id`), so membership is just
// `(group_id, user_id)`.
//
// `granted_by` retains the `actors.id` FK: it's an audit field that can
// legitimately be set by either an owner (user-actor) or — in future
// iterations — by another agent on the owner's behalf, so polymorphic
// Actor attribution is the right shape here.

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at").notNull().defaultNow(),
    grantedBy: uuid("granted_by").references(() => actors.id, { onDelete: "set null" }),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.userId] })],
);

export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;

// ---------------------------------------------------------------------------
// standingApprovals — pre-authorization rules
// ---------------------------------------------------------------------------

// M043: `created_by` and `actor_pattern` moved from `actors.id` to
// `users.id` — standing approvals are Subject-level declarations (only
// Humans create them; the pattern matches against a Human — never an
// Agent). Column names kept stable to minimize call-site churn; the FK
// target is the canonical change.

// M037: the standing-approval engine extends this table (no new table).
// `scope` discriminates a server-wide grant ("server" — any room, this
// user) from a room-scoped one ("room" — `room_id` required). `signature`
// + `signature_key` carry the arity-classified generalized matcher this
// path always writes; the matcher compares on `signature_key` for equality.
// `group_id` / `actor_pattern` / `max_*` stay DORMANT (the old relationship/
// budget pre-auth model — do not conflate). See ISSUE-M037.
//
// M077: `approval_kind` discriminates exact tool signatures (`tool`, the
// default for all pre-M077 rows) from capability-scoped grants (`capability`).
// Capability rows match on `capability_slug` (+ optional `session_id`) and
// may bypass only the `ask` path — never `prove_it` / `block`.
export const standingApprovals = pgTable(
  "standing_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id").references(() => groups.id, {
      onDelete: "cascade",
    }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    /** `tool` (default) | `capability`. Pre-M077 rows are all `tool`. */
    approvalKind: text("approval_kind").notNull().default("tool"),
    /** Required when approvalKind === "capability". */
    capabilitySlug: text("capability_slug"),
    /** Optional session scope for capability grants (NULL = any session). */
    sessionId: text("session_id"),
    toolPattern: text("tool_pattern").notNull(),
    actorPattern: uuid("actor_pattern").references(() => users.id),
    maxAmount: numeric("max_amount"),
    maxDailyAmount: numeric("max_daily_amount"),
    maxMonthlyAmount: numeric("max_monthly_amount"),
    // M037 — scope of the grant: "server" (any room, this user) | "room".
    scope: text("scope").notNull().default("server"),
    // M037 — required when scope === "room"; FK → rooms, cascade on room delete.
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "cascade" }),
    // M037 — structured signature matcher (this path always populates it).
    signature: jsonb("signature").$type<CommandSignature | null>(),
    // M037 — canonical string of `signature` for indexed equality lookup.
    signatureKey: text("signature_key"),
    active: boolean("active").notNull().default(true),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // M037 — hot lookup for matchCommandApproval.
    index("idx_standing_approvals_lookup").on(
      table.createdBy,
      table.scope,
      table.toolPattern,
      table.signatureKey,
    ),
    // M077 — hot lookup for matchCapabilityApproval.
    index("idx_standing_approvals_capability_lookup").on(
      table.createdBy,
      table.scope,
      table.approvalKind,
      table.capabilitySlug,
    ),
  ],
);

export type StandingApproval = typeof standingApprovals.$inferSelect;
export type NewStandingApproval = typeof standingApprovals.$inferInsert;

// ---------------------------------------------------------------------------
// approvalChallenges — prove_it challenge records
// ---------------------------------------------------------------------------

// M043: `requested_by` and `resolved_by` moved from `actors.id` to
// `users.id` — approval challenges are Subject-level (only Humans
// request + resolve them). `eligibleApprovers` now carries `users.id`
// strings; existing in-flight rows (5-minute TTL window) are backfilled
// by the M043 migration.

export const approvalChallenges = pgTable("approval_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").references(() => groups.id),
  requiredCapability: text("required_capability").notNull(),
  requestedBy: uuid("requested_by")
    .notNull()
    .references(() => users.id),
  action: text("action").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>(),
  amount: numeric("amount"),
  eligibleApprovers: jsonb("eligible_approvers")
    .$type<string[]>()
    .notNull(),
  status: text("status").notNull().default("pending"),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  standingApprovalId: uuid("standing_approval_id").references(
    () => standingApprovals.id,
  ),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ApprovalChallenge = typeof approvalChallenges.$inferSelect;
export type NewApprovalChallenge = typeof approvalChallenges.$inferInsert;

// ---------------------------------------------------------------------------
// credentials — authentication credentials for actors (PIN, passkey, etc.)
// ---------------------------------------------------------------------------

// M043: credentials moved from `actors.id` to `users.id`. PINs,
// passkeys, and any future credential belong to the Human Subject —
// Agents don't authenticate. The runtime `kind='user'` expectation
// that existed in every caller becomes a structural guarantee via FK.

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_credentials_user_type").on(table.userId, table.type),
  ],
);

export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;

// ---------------------------------------------------------------------------
// recovery_codes — single-use account backup codes
// ---------------------------------------------------------------------------

// M043: recovery codes follow credentials — FK to `users.id`. Same
// rationale: PIN recovery is a Human-Subject concern.
//
// D104 originally split PIN backup codes from Logto password recovery codes.
// M120 collapses the OSS user-facing model back to one account recovery-code
// set; `logto_account` remains as a legacy DB value but new account recovery
// flows use `pin`.

export const RECOVERY_CODE_PURPOSE = {
  PIN: "pin",
  LOGTO_ACCOUNT: "logto_account",
} as const;

export type RecoveryCodePurpose =
  (typeof RECOVERY_CODE_PURPOSE)[keyof typeof RECOVERY_CODE_PURPOSE];

export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * D104 — `pin` = PIN reset flow; `logto_account` = Logto password recovery.
     */
    purpose: text("purpose").notNull().default(RECOVERY_CODE_PURPOSE.PIN),
    codeHash: text("code_hash").notNull(),
    used: boolean("used").notNull().default(false),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_recovery_codes_user_purpose_used").on(
      table.userId,
      table.purpose,
      table.used,
    ),
  ],
);

export type RecoveryCode = typeof recoveryCodes.$inferSelect;
export type NewRecoveryCode = typeof recoveryCodes.$inferInsert;

// ---------------------------------------------------------------------------
// channel_identities — M042C mapping of (channel, external id) → user
// ---------------------------------------------------------------------------
//
// Subsumes archived ISSUE-M039. Every trusted-at-boot connection for the
// owner (TUI, Electron) is seeded here with the federated id as
// `external_id`. Future M041 pairing writes rows for new channels (e.g.
// Telegram); unverified rows have `verified_at = NULL`.
//
// DB-level UNIQUE (channel, external_id) from day one — safe on a new
// table, gives seeds and pairing a clean upsert key.
//
// M043: per REL-CHN-HUM, Channels are Human transport only — Agents do
// not have ChannelIdentities. The FK moved from `actors.id` to
// `users.id`.

export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel").notNull(),
    externalId: text("external_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verifiedAt: timestamp("verified_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_channel_identities_channel_external").on(
      table.channel,
      table.externalId,
    ),
    index("idx_channel_identities_user").on(table.userId),
  ],
);

export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type NewChannelIdentity = typeof channelIdentities.$inferInsert;
