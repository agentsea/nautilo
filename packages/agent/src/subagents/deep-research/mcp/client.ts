import type { Configuration } from "../shared/config";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { warn } from "@nautilo/logger";

/**
 * Stub MCP tool loader. Returns empty array until Nautilo's MCP connector (D040) is built.
 */
export function loadMcpTools(cfg: Configuration): Promise<DynamicStructuredTool[]> {
  const url = cfg.mcp_config?.url ?? null;
  if (url) {
    warn("[mcp] MCP tools configured but not yet supported in Nautilo deep research; skipping");
  }
  return Promise.resolve([]);
}
