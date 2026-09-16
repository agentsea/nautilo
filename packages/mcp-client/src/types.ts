/**
 * @nautilo/mcp-client — shared types.
 *
 * Stack 146 / D384. Phase 0: the `McpServerConfig` shape mirrors the
 * `mcpServers` DB row (`packages/db/src/schema/mcp-servers.ts`) but is
 * declared here as a neutral, DB-agnostic interface so this package has
 * no dependency on `@nautilo/db`. Wave 3 server wiring maps the DB row
 * to this shape at boot.
 *
 * CRITICAL: this config carries only variable NAMES for env passthrough
 * and a vault KEY reference for auth — never credential values. Values
 * are resolved at spawn/call time by `resolveMcpAuth` (the single seam).
 */

import type { ToolApprovalLevel, ToolExposure, ToolTrustTier } from "@nautilo/types";

/**
 * MCP transport kind. `streamable-http` is Phase 1 — only `stdio` is
 * implemented in Phase 0; the streamable-http module is a stub.
 */
export type McpTransportKind = "stdio" | "streamable-http" | "sse-legacy";

/**
 * `transport` jsonb variant. No secrets: the stdio variant holds only the
 * spawn command + args; the http variant holds the URL + non-secret headers.
 * Auth headers come from `authRef` via `resolveMcpAuth`, NOT from here.
 */
export interface McpStdioTransportConfig {
  command: string;
  args?: readonly string[];
  cwd?: string;
}

export interface McpStreamableHttpTransportConfig {
  url: string;
  /** Non-secret header overrides only (e.g. `Accept: application/json`). */
  headers?: Record<string, string>;
}

export type McpTransportConfig =
  | McpStdioTransportConfig
  | McpStreamableHttpTransportConfig;

/**
 * `authRef` jsonb shape. `vaultKey` is a reference into the vault, never
 * a credential value. Resolved by Phase 4 vault wiring; until then any
 * non-null `authRef` causes `resolveMcpAuth` to throw `McpAuthNotAvailableError`.
 */
export type McpAuthRef =
  | { type: "bearer"; vaultKey: string }
  | { type: "oauth"; vaultKey: string }
  // Phase-1 interim: bearer token read from a server-env var at connect time
  // (no vault). Vault-backed `bearer`/`oauth` remain Phase 4.
  | { type: "env"; envVar: string }
  | null;

/**
 * Server-config shape — neutral copy of `mcpServers.$inferSelect` minus
 * the DB bookkeeping columns (`id`, `createdAt`, `updatedAt`).
 */
export interface McpServerConfig {
  /** Stable, unique server name. Used as `sourceServer` on catalog entries. */
  name: string;
  /** `server` | `relay-<relayId>` — where this server is hosted. */
  host: string;
  transportKind: McpTransportKind;
  transport: McpTransportConfig;
  /** Env var NAMES whose values are pulled from `process.env` at spawn. */
  envPassthrough?: readonly string[] | null;
  /** Non-secret literal env values (merged on top of passthrough at spawn). */
  envLiteral?: Record<string, string> | null;
  authRef?: McpAuthRef | null;
  /** Namespace scope for tools registered from this server. */
  namespaceId?: string | null;
  /** Optional allowlist of tool names; empty/null = all tools. */
  includeTools?: readonly string[] | null;
  /** Optional denylist of tool names. */
  excludeTools?: readonly string[] | null;
  enabled?: boolean;
  /** Operator-assigned trust tier; defaults to `standard` when omitted. */
  trustTier?: ToolTrustTier | null;
  /** Relay-tier spawn sandbox profile (relay-hosted servers only). */
  spawnSandboxProfile?: unknown;
}

/**
 * Result of resolving auth for a config. `null` = no auth required.
 * Phase 0 only ever returns `null` (no authRef) — the env-passthrough
 * case is handled by `resolveMcpAuth` returning `null` (auth is not a
 * credential; it's just env vars that the transport will read at spawn).
 */
export type McpResolvedAuth = {
  /** Bearer token value resolved from the vault. Phase 4 only. */
  bearerToken?: string;
  /** Resolved HTTP header(s) to merge into the transport. Phase 4 only. */
  headers?: Record<string, string>;
} | null;

/**
 * Per-server lifecycle state.
 */
export type McpConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/**
 * A tool discovered via `tools/list`, neutralized from the SDK's `Tool`
 * type. `inputSchema` is kept verbatim — it is forwarded straight to
 * LangChain's `tool({ schema })`: no Zod conversion or Ajv layer.
 */
export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Event map for `McpClientManager`. TypedEmitter signature.
 */
export interface McpManagerEventMap {
  "mcp:connected": [serverName: string];
  "mcp:disconnected": [serverName: string, reason?: string];
  "mcp:error": [serverName: string, error: Error];
  "mcp:tools-changed": [serverName: string, tools: readonly McpDiscoveredTool[]];
}

/**
 * A bundle produced by `McpClientManager.getCatalogBundle(serverName)` for
 * the Wave 3 server/agent wiring to feed into `ToolCatalog.register`.
 *
 * `namespaceId` is exposed alongside the registrations because the
 * `ToolRegistration` shape itself has no namespace slot — Wave 3 uses it
 * to scope tool visibility per namespace.
 */
export interface McpCatalogBundle {
  serverName: string;
  namespaceId: string | null;
  registrations: readonly McpToolRegistration[];
}

/**
 * Extension of `ToolRegistration` carrying the MCP-specific bits that the
 * catalog ignores but the manager / Wave 3 wiring needs (namespace + tool
 * filter provenance). The catalog's `register()` accepts any `ToolRegistration`;
 * extra fields are simply not read by it.
 */
export interface McpToolRegistration {
  name: string;
  factory: () => import("@langchain/core/tools").StructuredTool;
  source: "mcp";
  /** D419 — omitted until this registration has migrated to explicit exposure. */
  exposure?: ToolExposure | undefined;
  /** `cloud` = server-tier (local dispatch); `relay` = relay-hosted (D384 P5). */
  executor: "cloud" | "relay";
  /** Relay id owning this tool when `executor:"relay"` (D384 P5); else absent. */
  hostedBy?: string | null;
  sourceServer: string;
  category: import("@nautilo/types").ToolCategory;
  trustTier: ToolTrustTier;
  impact: import("@nautilo/types").ToolImpactLevel;
  tags: string[];
  requiresApproval: boolean;
  approvalLevel?: ToolApprovalLevel | undefined;
  resultScanPolicy: import("@nautilo/types").ToolResultScanPolicy;
  /** The discovered tool name on the MCP server (may differ from `name` if namespaced). */
  mcpToolName: string;
}
