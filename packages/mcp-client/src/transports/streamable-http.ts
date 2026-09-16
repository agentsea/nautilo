/**
 * @nautilo/mcp-client — HTTP transports (D384 Phase 1, task 1.1).
 *
 * - `streamable-http` (CANONICAL, MCP 2025-11-25): single MCP endpoint,
 *   POST + GET, optional SSE streaming. On dispose we explicitly
 *   `terminateSession()` before `close()` (D056 gotcha) so the server can
 *   reclaim the session id.
 * - `sse-legacy` (DEPRECATED 2024-11-05 HTTP+SSE): back-compat only, via
 *   the SDK's `SSEClientTransport`. Not a first-class choice.
 *
 * Auth headers come ONLY from `resolveMcpAuth` (the single seam): Phase-1
 * env-token → `Authorization: Bearer …`; vault-backed bearer/oauth is
 * Phase 4 (and `resolveMcpAuth` throws for it today). Non-secret header
 * overrides may also be set on the config's `transport.headers`.
 */

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveMcpAuth } from "../resolve-auth.ts";
import type {
  McpServerConfig,
  McpStreamableHttpTransportConfig,
} from "../types.ts";

export interface NautiloHttpTransport {
  /** The underlying SDK transport — pass to `Client.connect()`. */
  readonly inner: StreamableHTTPClientTransport | SSEClientTransport;
  /** Dispose: terminate the session (streamable) then close. */
  close(): Promise<void>;
}

/**
 * Build an HTTP MCP transport (Streamable HTTP, or legacy SSE) for a config.
 * Does NOT connect — `Client.connect()` performs the handshake.
 */
export function createStreamableHttpTransport(
  cfg: McpServerConfig,
): NautiloHttpTransport {
  if (
    cfg.transportKind !== "streamable-http" &&
    cfg.transportKind !== "sse-legacy"
  ) {
    throw new Error(
      `[mcp] createStreamableHttpTransport: server "${cfg.name}" has transportKind "${cfg.transportKind}", expected "streamable-http" or "sse-legacy".`,
    );
  }
  const transportCfg = cfg.transport as McpStreamableHttpTransportConfig;
  if (!transportCfg || typeof transportCfg.url !== "string") {
    throw new Error(
      `[mcp] createStreamableHttpTransport: server "${cfg.name}" http transport config missing "url".`,
    );
  }
  const url = new URL(transportCfg.url);

  // Non-secret header overrides from config + resolved auth (env-token Bearer).
  const auth = resolveMcpAuth(cfg, "headers");
  const headers: Record<string, string> = {
    ...(transportCfg.headers ?? {}),
    ...(auth?.headers ?? {}),
  };
  const requestInit: RequestInit =
    Object.keys(headers).length > 0 ? { headers } : {};

  if (cfg.transportKind === "streamable-http") {
    const inner = new StreamableHTTPClientTransport(url, { requestInit });
    return {
      inner,
      async close(): Promise<void> {
        try {
          await inner.terminateSession();
        } catch {
          // Session may already be gone (server restarted); closing anyway.
        }
        await inner.close();
      },
    };
  }

  // sse-legacy — deprecated HTTP+SSE transport, back-compat only.
  const inner = new SSEClientTransport(url, { requestInit });
  return {
    inner,
    close: () => inner.close(),
  };
}
