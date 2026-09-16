import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * D384 C0 — MCP server config store.
 *
 * Persists operator-defined MCP server definitions (transport, tool filters,
 * namespace scope). This is NOT the secret vault: `env_passthrough` holds
 * variable NAMES only; `auth_ref` holds a vault key reference, never a value.
 *
 * `namespace_id` NULL on a server-owned row means global / all-namespaces.
 * No `agent_id` — MCP servers are server-scoped config, not per-agent state.
 */
export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** `server` | `relay-<relayId>` */
  host: text("host").notNull().default("server"),
  /** `stdio` | `streamable-http` | `sse-legacy` */
  transportKind: text("transport_kind").notNull(),
  /** Variant only: `{command,args}` | `{url,headers}` — no secrets. */
  transport: jsonb("transport").notNull(),
  /** Server-env variable NAMES to pass through at spawn; values never stored. */
  envPassthrough: text("env_passthrough").array(),
  /** Optional non-secret literal env values. */
  envLiteral: jsonb("env_literal"),
  /** `{type:'bearer'|'oauth', vaultKey}` or null. */
  authRef: jsonb("auth_ref"),
  namespaceId: uuid("namespace_id"),
  includeTools: text("include_tools").array(),
  excludeTools: text("exclude_tools").array(),
  enabled: boolean("enabled").notNull().default(true),
  trustTier: text("trust_tier"),
  /** Relay-tier spawn sandbox profile only. */
  spawnSandboxProfile: jsonb("spawn_sandbox_profile"),
  /**
   * D503 local-tier status evidence. Fixed categories and environment variable
   * names only — never stderr, exception text, paths, URLs, or secret values.
   */
  lastCheckStatus: text("last_check_status"),
  lastCheckFailureCode: text("last_check_failure_code"),
  lastCheckMissingEnvironment: text("last_check_missing_environment").array(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
