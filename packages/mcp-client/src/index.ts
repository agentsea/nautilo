/**
 * @nautilo/mcp-client — MCP host client (D384, Stack 146 Phase 0).
 *
 * Public surface:
 * - {@link McpClientManager} — per-server lifecycle, events, dispatch.
 * - {@link resolveMcpAuth} / {@link resolveEnvPassthrough} / {@link buildSpawnEnv} —
 *   the single auth-resolution seam (Phase 0: env passthrough + fail-closed
 *   on `authRef`; Phase 4 adds vault reads).
 * - {@link createStdioTransport} — stdio transport wrapper (stderr log,
 *   graceful shutdown).
 * - {@link mcpToolToLangChain} — MCP tool → LangChain `StructuredTool`
 *   (raw `inputSchema`, no Zod, no Ajv — per C4 decision).
 *
 * Streamable-HTTP transport is Phase 1; its module is a stub.
 */

export {
  McpClientManager,
  buildRelayToolRegistration,
  type McpClientFactory,
  type McpClientManagerOptions,
  type McpManagedClient,
  type McpTransportFactory,
} from "./manager.ts";

export {
  resolveMcpAuth,
  resolveEnvPassthrough,
  buildSpawnEnv,
  McpAuthNotAvailableError,
  McpEnvTokenMissingError,
} from "./resolve-auth.ts";

export {
  createMcpResiliencePolicy,
  type McpResilienceOptions,
  type McpResiliencePolicy,
} from "./resilience.ts";

export { redactError, redactSecretsInText } from "./redact.ts";

export {
  createRelayMcpHost,
  mapRelayMcpConfig,
  type RelayMcpHostHandle,
  type RelayMcpHostOptions,
} from "./relay-host.ts";

export {
  createStdioTransport,
  type NautiloStdioTransport,
  type StdioTransportOptions,
} from "./transports/stdio.ts";

export {
  createStreamableHttpTransport,
  type NautiloHttpTransport,
} from "./transports/streamable-http.ts";

export {
  mcpToolToLangChain,
  type McpCallToolClient,
  type McpCallToolResult,
  type McpContentBlock,
  type McpDispatch,
} from "./tool-factory.ts";

export type {
  McpAuthRef,
  McpCatalogBundle,
  McpConnectionState,
  McpDiscoveredTool,
  McpManagerEventMap,
  McpResolvedAuth,
  McpServerConfig,
  McpStdioTransportConfig,
  McpStreamableHttpTransportConfig,
  McpToolRegistration,
  McpTransportConfig,
  McpTransportKind,
} from "./types.ts";
