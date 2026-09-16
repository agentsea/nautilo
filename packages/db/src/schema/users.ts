import {
  pgTable,
  text,
  uuid,
  varchar,
  timestamp,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  /**
   * Email address — **nullable post-M107**. A local single-household
   * Nautilo install identifies users by `handle` (Logto username) +
   * password + PIN; email is an optional contact channel, not an
   * identity key (REL-HUM-SRV: "email is an optional contact channel,
   * not an identity key"). Stays a column so a future SMTP wiring
   * (operator-minted reset emails, federated identity exchange) can
   * use it without another migration; UNIQUE is preserved at the
   * Postgres level so multiple rows can be NULL while non-NULL values
   * remain distinct.
   *
   * Pre-M107 this column was NOT NULL and existing rows still carry
   * their original address. Post-M107 invite redeems insert `NULL`.
   */
  email: varchar("email", { length: 255 }).unique(),
  /**
   * M051 (Logto cluster): OIDC subject identifier (`sub` claim) issued
   * by the Server's Logto instance. Reserved exclusively for the OIDC
   * identity link.
   *   - NULL → legacy PIN-mode user, OR a freshly-created row pre-JIT
   *     (M052 fills it on first authenticated request).
   *   - non-NULL → row is bound to a Logto user; subsequent JWTs with
   *     this `sub` resolve to this row directly via `findUserByExternalId`.
   *
   * Decoupled from `handle` (M042C, human-chosen part of @handle@server)
   * and `email` (used for first-time linking by M053's migration tool).
   * If Logto's sub format ever changes, only this column is rekeyed.
   *
   * Uniqueness is enforced via a partial unique index defined in the
   * M051 migration (`users_external_id_unique` WHERE external_id IS NOT
   * NULL) so legacy NULL rows coexist freely. The drizzle column itself
   * is plain `text` because drizzle-kit doesn't natively round-trip
   * partial-index predicates as of the version pinned here.
   *
   * Canonical design: `research/logto-integration-v1.md` §4.4.
   */
  externalId: text("external_id"),
  /**
   * M042C: federated-id local part. Combined with the server's
   * `NAUTILO_HOSTNAME` it forms `@<handle>@<server>` — the owner's
   * addressable identity. Nullable in the M042C migration for
   * backward compat with pre-M042C DBs; `seedDefaultOwner` populates
   * it on first post-M042C boot (derived from `users.name` via
   * `slugifyToHandle`, falling back to `"owner"`). Fresh installs
   * collect it during onboarding. Tightening to NOT NULL + UNIQUE is
   * a follow-up migration.
   */
  handle: text("handle"),
  /**
   * M047: federated-id home part.
   *   - NULL → local Human: lives on this Server, authenticates here,
   *     owns Agents here. The vast majority of today's rows.
   *   - non-NULL → foreign-origin stub: the home Server's hostname for
   *     a federated Human who participates in Rooms hosted here. Stub
   *     rows exist (in a future Iteration-5 world) to satisfy FK
   *     constraints (`room_members.actor_id` → `actors.owner_id` →
   *     `users.id`) and to hold server-trust metadata.
   *
   * Identity renders as `@<handle>@<server ?? getServerHostname()>`.
   * Canonical definition: REL-HUM-SRV. Consumed in
   * `getFederatedIdForActor` (`packages/trust/src/queries.ts`). Three
   * handle-keyed lookups additionally scope to `server IS NULL` to
   * prevent foreign-stub leakage into owner-identity flows:
   * `findActorByHandle`, `updateOwnerHandle`. (M126 retired
   * `deriveUniqueHandle` along with the Logto JIT path; invites now
   * supply handles directly.)
   *
   * No UNIQUE / NOT NULL tightening here — proper shape is
   * `UNIQUE(handle, server)` with NULL-as-local semantics that need a
   * partial index; deferred to the Iteration-5 federation pass when
   * foreign stubs actually land.
   */
  server: text("server"),
  /**
   * D219 — soft-delete (account disable) columns. Retire of the legacy
   * M061 `server_role` enum: server-wide authority is now derived purely
   * from Capabilities (Group→Role membership, REL-CAP-HUM); the enum was
   * a divergent second RBAC axis and was dropped in the D219 migration.
   *
   * Soft-delete is an attribute of REL-HUM-SRV (Subject-on-Server), not a
   * new entity and orthogonal to the RBAC axis:
   *   - `disabledAt` — when the account was disabled (NULL = active). The
   *     trust preHandler 401s any request whose `users` row has a non-NULL
   *     value (`user_disabled_session_blocked`); only the explicit enable
   *     route clears it.
   *   - `disabledBy` — the `users.id` of the admin who disabled it
   *     (`ON DELETE SET NULL` so deleting that admin doesn't cascade).
   *   - `disabledReason` — free-text reason shown in the admin directory.
   */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledBy: uuid("disabled_by").references((): AnyPgColumn => users.id, {
    onDelete: "set null",
  }),
  disabledReason: text("disabled_reason"),
  /**
   * D124 — Polling-derived presence. Bumped to NOW() on every
   * authenticated request (best-effort; no transaction guarantees).
   * Drives "last seen Xm ago" subtitle in Signal-shape headers and
   * the presence dot in Explorer rows.
   *
   * Format conventions: <60s = "now", <60m = "Xm ago",
   * <24h = "Xh ago", >=24h = ISO date.
   */
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  /**
   * D208 — the human user's own profile picture (square avatar). Distinct
   * from `profiles.avatar_ref` which is per-user customization of the
   * user's *agent* (Jeannie / Genie) avatar. NULL = use SHELL fallback.
   * AvatarRef is `{ kind: "preset" | "uploaded" | "generated", ... }`
   * (canonical type in `@nautilo/types`); stored as `jsonb` here because
   * the type is a discriminated union and we need shape flexibility for
   * future kinds (e.g. federated `external` reference).
   */
  humanAvatarRef: jsonb("human_avatar_ref"),
  /**
   * M087: account-level timezone, IANA name (e.g. "Europe/Athens",
   * "America/New_York"). Auto-populated by the chat ingress on the first
   * authenticated send (the client auto-detects via
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`) and refreshed on
   * drift. Onboarding pre-populates it.
   *
   * NULL -> server reads as "UTC" at consumer sites. Invalid request
   * values are dropped server-side via `validateIanaTimezone`; we never
   * persist garbage here.
   */
  timezone: text("timezone"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
