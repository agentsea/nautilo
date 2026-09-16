import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import { namespaces } from "./trust";
import { users } from "./users";

/**
 * D456 — safe, non-secret identity for one Human×Namespace×provider account.
 * Provider tokens remain with the selected Connection Driver. Opaque driver
 * account/config ids are routing handles, not bearer credentials.
 */
export const connectedAppProfiles = pgTable(
  "connected_app_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    namespaceId: uuid("namespace_id").notNull().references(() => namespaces.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    driverKind: text("driver_kind").notNull(),
    status: text("status").notNull().default("connected"),
    connectedAccountId: text("connected_account_id").notNull(),
    providerConfigId: text("provider_config_id").notNull(),
    connectionName: text("connection_name").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    providerWorkspaceIdentity: text("provider_workspace_identity").notNull(),
    providerUserKind: text("provider_user_kind").notNull(),
    accountUsername: text("account_username"),
    accountDisplayName: text("account_display_name"),
    accountEmail: text("account_email"),
    accountAvatarUrl: text("account_avatar_url"),
    accountWorkspaceName: text("account_workspace_name"),
    driverCredentialRefId: text("driver_credential_ref_id"),
    driverCredentialNamespaceId: uuid("driver_credential_namespace_id")
      .references(() => namespaces.id, { onDelete: "set null" }),
    driverCredentialAgentId: text("driver_credential_agent_id"),
    driverCredentialRecordId: text("driver_credential_record_id"),
    lastErrorCode: text("last_error_code"),
    revision: integer("revision").notNull().default(0),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_connected_app_profile_actor_provider_driver")
      .on(table.userId, table.namespaceId, table.providerId, table.driverKind),
    index("idx_connected_app_profiles_user_namespace")
      .on(table.userId, table.namespaceId, table.updatedAt),
    check("connected_app_profiles_provider_check", sql`${table.providerId} ~ '^[a-z][a-z0-9_-]*$'`),
    check(
      "connected_app_profiles_driver_check",
      sql`${table.driverKind} IN ('oomol_hosted', 'openconnector_local', 'nautilo_native')`,
    ),
    check(
      "connected_app_profiles_status_check",
      sql`${table.status} IN ('connected', 'reconnect_required', 'error')`,
    ),
    check("connected_app_profiles_revision_check", sql`${table.revision} >= 0`),
  ],
);

/**
 * Durable OAuth continuation. Authorization URLs are intentionally never
 * stored: only the opaque driver request handle and binding facts needed to
 * resume polling after a server restart are retained.
 */
export const connectedAppOauthAttempts = pgTable(
  "connected_app_oauth_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    namespaceId: uuid("namespace_id").notNull().references(() => namespaces.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    driverKind: text("driver_kind").notNull(),
    connectionRequestId: text("connection_request_id").notNull(),
    providerConfigId: text("provider_config_id").notNull(),
    connectionName: text("connection_name").notNull(),
    status: text("status").notNull().default("connecting"),
    errorCode: text("error_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_connected_app_oauth_driver_request")
      .on(table.driverKind, table.connectionRequestId),
    uniqueIndex("uq_connected_app_oauth_active_actor_provider")
      .on(table.userId, table.namespaceId, table.providerId, table.driverKind)
      .where(sql`${table.status} = 'connecting'`),
    index("idx_connected_app_oauth_actor")
      .on(table.userId, table.namespaceId, table.providerId, table.createdAt),
    check("connected_app_oauth_provider_check", sql`${table.providerId} ~ '^[a-z][a-z0-9_-]*$'`),
    check(
      "connected_app_oauth_driver_check",
      sql`${table.driverKind} IN ('oomol_hosted', 'openconnector_local')`,
    ),
    check(
      "connected_app_oauth_status_check",
      sql`${table.status} IN ('connecting', 'connected', 'failed', 'expired')`,
    ),
    check(
      "connected_app_oauth_terminal_check",
      sql`(${table.status} = 'connecting' AND ${table.completedAt} IS NULL)
        OR (${table.status} <> 'connecting' AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Server-wide, non-secret provider readiness. OAuth client secrets are stored
 * by OpenConnector; Nautilo persists only an opaque vault reference for the
 * optional OpenConnector administrator token.
 */
export const connectedAppProviderConfigs = pgTable(
  "connected_app_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id").notNull(),
    driverKind: text("driver_kind").notNull(),
    status: text("status").notNull().default("setup_required"),
    clientId: text("client_id"),
    adminCredentialRefId: text("admin_credential_ref_id"),
    adminCredentialNamespaceId: uuid("admin_credential_namespace_id")
      .references(() => namespaces.id, { onDelete: "set null" }),
    adminCredentialAgentId: text("admin_credential_agent_id"),
    lastErrorCode: text("last_error_code"),
    revision: integer("revision").notNull().default(0),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_connected_app_provider_config_provider_driver")
      .on(table.providerId, table.driverKind),
    check("connected_app_provider_configs_provider_check", sql`${table.providerId} ~ '^[a-z][a-z0-9_-]*$'`),
    check(
      "connected_app_provider_configs_driver_check",
      sql`${table.driverKind} = 'openconnector_local'`,
    ),
    check(
      "connected_app_provider_configs_status_check",
      sql`${table.status} IN ('setup_required', 'ready', 'error')`,
    ),
    check("connected_app_provider_configs_revision_check", sql`${table.revision} >= 0`),
  ],
);

export type ConnectedAppProfileRow = typeof connectedAppProfiles.$inferSelect;
export type ConnectedAppOauthAttemptRow = typeof connectedAppOauthAttempts.$inferSelect;
export type ConnectedAppProviderConfigRow = typeof connectedAppProviderConfigs.$inferSelect;
