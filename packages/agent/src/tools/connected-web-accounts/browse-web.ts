import { DynamicStructuredTool } from "@langchain/core/tools";
import { connectedWebOperationTerminalReadResultSchema, publicBrowserReadActiveSchema } from "@nautilo/types";
import { z } from "zod";
import { getConnectedWebAccountReadToolRuntime } from "./runtime";
import { resolveConnectedWebAccountReadActor, type ConnectedWebAccountReadToolContext,
  CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS, CONNECTED_WEB_ACCOUNT_READ_REQUEST_MAX_CHARS } from "./read-connected-web-account";

export const browseWebToolSchema = z.object({
  url: z.string().url().max(CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS).describe("Verified public HTTP(S) page to open. No website login or saved account is required."),
  request: z.string().trim().min(1).max(CONNECTED_WEB_ACCOUNT_READ_REQUEST_MAX_CHARS).describe("Information to find, relevant filters, and a clear stopping condition for the browser agent."),
}).strict();

export function publicBrowserUseAvailable(): boolean {
  const runtime = getConnectedWebAccountReadToolRuntime();
  return runtime?.readPublic !== undefined && runtime.publicAvailable?.() === true;
}

export async function dispatchBrowseWeb(args: z.infer<typeof browseWebToolSchema>, context?: ConnectedWebAccountReadToolContext): Promise<string> {
  const actor = resolveConnectedWebAccountReadActor(context);
  const runtime = getConnectedWebAccountReadToolRuntime();
  if (!actor || !runtime?.readPublic) return JSON.stringify({ ok: false, code: "unavailable", recovery: "none" });
  try {
    const result = await runtime.readPublic(actor, args);
    if (!result.ok) return JSON.stringify({ ok: false, code: result.code, recovery: result.recovery });
    const parsed = result.status === "active" ? publicBrowserReadActiveSchema.safeParse(result)
      : connectedWebOperationTerminalReadResultSchema.safeParse(result);
    if (!parsed.success || ("account" in parsed.data && parsed.data.account !== null)) {
      return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
    }
    return JSON.stringify(parsed.data);
  } catch {
    return JSON.stringify({ ok: false, code: "provider_unavailable", recovery: "none" });
  }
}

export function createBrowseWebTool(context?: ConnectedWebAccountReadToolContext) {
  return new DynamicStructuredTool({
    name: "browse_web",
    description: "Use Browser Use on a public website without a website login. Honor explicit requests to use Browser Use. Select it autonomously when research requires interactive search, filters, pagination, expandable content, or rendered pages that search/extraction cannot answer. Prefer run_web_search and read_webpage for ordinary research. This starts durable hosted browser work: supervise its returned operationId with manage_connected_web_operation and report the actual result. Website login is required only if the site actually demands it; then use the protected Connected Websites sign-in flow. Public browsing cannot take direct control or make purchases, send messages, change accounts, or save website state. Never ask for credentials in chat or substitute a local browser for an explicitly requested Browser Use session.",
    schema: browseWebToolSchema,
    func: (args) => dispatchBrowseWeb(args, context),
  });
}
