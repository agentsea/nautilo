/**
 * @nautilo/mcp-client — MCP tool → LangChain `StructuredTool` factory.
 *
 * `mcpToolToLangChain` preserves the discovered JSON schema:
 *
 * - Hand the MCP `inputSchema` STRAIGHT to LangChain's `tool({ schema })`.
 *   NO Zod conversion. NO Ajv validation layer. LangChain's built-in
 *   `@cfworker/json-schema` validator handles runtime arg validation;
 *   the MCP server's schema is forwarded to the LLM verbatim so the
 *   model sees the server's own argument shape.
 * - The handler input is typed `unknown` (per the decision doc gotcha
 *   #5) and cast to `Record<string, unknown>` before forwarding to
 *   `client.callTool`.
 * - The `inputSchema` is cast via `as unknown as JsonSchema7Type` (per
 *   gotcha #2) — a TS-only concern; runtime behavior is identical.
 *
 * The `client` argument is the SDK `Client` (or any minimal callTool-shaped
 * interface) — typed as `McpCallToolClient` so tests can pass a stub.
 */

import { tool } from "@langchain/core/tools";
import type { StructuredTool } from "@langchain/core/tools";
import type { JsonSchema7Type } from "@langchain/core/utils/json_schema";
import { redactError } from "./redact.ts";
import type { McpDiscoveredTool } from "./types.ts";

/**
 * Minimal client surface the factory needs. The SDK `Client` satisfies
 * this; tests can pass a stub with just `callTool`.
 */
export interface McpCallToolClient {
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpCallToolResult>;
}

export interface McpCallToolResult {
  content?: ReadonlyArray<McpContentBlock>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: unknown }
  | { type: "resource_link"; uri: string; name: string }
  | { type: string; [key: string]: unknown };

/**
 * Coerce a heterogeneous content block array into a single string, the
 * way the spike did: concatenate every `text` block; ignore non-text.
 * Non-text blocks (image / audio / resource) are dropped — Phase 0
 * supports text-only tool results; structured-content handling is a
 * later concern.
 */
export function contentToText(content: ReadonlyArray<McpContentBlock> | undefined): string {
  if (!content) return "";
  let out = "";
  for (const block of content) {
    if (block !== null && typeof block === "object" && "type" in block) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        out += block.text;
      }
    }
  }
  return out;
}

/**
 * Build a LangChain `StructuredTool` from a raw MCP tool descriptor.
 * The tool, when invoked, calls `client.callTool({ name, arguments })`
 * and returns the concatenated text content. If the server reports
 * `isError: true`, the tool throws with the server's error text — the
 * LangChain runtime surfaces that to the agent as a tool failure.
 */
/**
 * A bound dispatch function: resolve `toolName` on its owning server and run
 * the resilient call (cockatiel policy + stale-session reconnect), returning
 * the tool's text output. Throws on hard failure; the factory below catches
 * and degrades (RES2). This is `McpClientManager.dispatch` bound per server.
 */
export type McpDispatch = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

export function mcpToolToLangChain(
  mcpTool: McpDiscoveredTool,
  dispatch: McpDispatch,
): StructuredTool {
  const description = mcpTool.description ?? `MCP tool ${mcpTool.name}`;
  return tool(
    async (input: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>;
      // RES2 — never throw from the agent-facing tool. `dispatch` applies the
      // resilience policy + stale-session reconnect; a hard failure degrades
      // to a message the model can reason about, so one bad tool does not
      // abort the whole agent turn.
      try {
        return await dispatch(mcpTool.name, args);
      } catch (e) {
        return `MCP tool "${mcpTool.name}" is temporarily unavailable: ${redactError(e)}`;
      }
    },
    {
      name: mcpTool.name,
      description,
      schema: mcpTool.inputSchema as unknown as JsonSchema7Type,
    },
  ) as unknown as StructuredTool;
}
