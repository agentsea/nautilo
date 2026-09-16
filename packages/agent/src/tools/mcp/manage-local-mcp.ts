import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { LocalMcpInstallModelIntent } from "@nautilo/types";
import {
  getLocalMcpToolRuntime,
  type LocalMcpToolActorContext,
} from "./local-mcp-runtime";

/**
 * D384 §5.4 — `manage_local_mcp`: a Genie sets up a LOCAL (relay-tier)
 * MCP on the requesting user's own machine.
 *
 * HARD-SCOPED to the caller's own relay (local tier). There is NO
 * server-tier path here: `register` always writes `host=relay-<id>` and
 * every other verb operates only on the user's own local rows (the injected
 * runtime refuses server-tier rows — SEC7 parity for agents).
 *
 * D503: `install` is the only setup action advertised to Genie. It is
 * prepared before the approval and executed only from a server-trusted
 * binding afterwards; it never performs a name-only enable. The older
 * register/enable service methods remain route/internal compatibility, but
 * deliberately do not appear in this model schema.
 */

const MAX_RESULT_JSON_CHARS = 16_000;

export const manageLocalMcpToolSchema = z.object({
  action: z
    .enum(["install", "disable", "remove", "status", "list"])
    .describe(
      "install: propose one local MCP launch for exact human approval; disable: stop but retain a local MCP; remove: stop and permanently delete it after human confirmation; status/list: inspect your own local MCPs.",
    ),
  name: z
    .string()
    .optional()
    .describe("MCP server name (required for disable / remove / status; install carries its name in request)."),
  relayId: z.string().optional().describe("Optional machine relay id to disambiguate status or disable."),
  request: z
    .object({
      version: z.literal("local-mcp-install-v1"),
      name: z.string(),
      relayId: z.string().optional(),
      transport: z.union([
        z.object({ kind: z.literal("stdio"), command: z.string(), args: z.array(z.string()) }).strict(),
        z.object({ kind: z.literal("streamable-http"), url: z.string() }).strict(),
      ]),
      source: z.object({ url: z.string().optional() }).strict().optional(),
      package: z.object({ name: z.string(), version: z.string().optional() }).strict().optional(),
      environment: z.array(z.string()).optional(),
    })
    .strict()
    .optional()
    .describe("Install proposal. Direct argv or streamable-HTTP only; environment variable names only, never values or headers."),
});

export type ManageLocalMcpToolArgs = z.infer<typeof manageLocalMcpToolSchema>;

export interface ManageLocalMcpToolContext {
  userId?: string | undefined;
  ownerId?: string | undefined;
  memoryAccessEnvelope?: MemoryAccessEnvelope | null | undefined;
}

function pickNonEmpty(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

/** Acting user = ownerId ?? userId ?? envelope.ownerId (mirrors skill_manage). */
export function resolveLocalMcpActorUserId(context?: ManageLocalMcpToolContext): string {
  const envelope = context?.memoryAccessEnvelope;
  return (
    pickNonEmpty(context?.ownerId) ||
    pickNonEmpty(context?.userId) ||
    pickNonEmpty(envelope?.ownerId)
  );
}

function errorJson(message: string): string {
  return JSON.stringify({ ok: false, error: message });
}

function boundJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= MAX_RESULT_JSON_CHARS) return text;
  return JSON.stringify({
    ok: false,
    error: "manage_local_mcp result too large; narrow the request (e.g. status of one server).",
    truncated: true,
  });
}

export async function dispatchManageLocalMcpCommand(
  args: ManageLocalMcpToolArgs,
  context?: ManageLocalMcpToolContext,
): Promise<string> {
  const userId = resolveLocalMcpActorUserId(context);
  if (!userId) {
    return errorJson("manage_local_mcp unavailable without an authenticated user.");
  }

  let runtime;
  try {
    runtime = getLocalMcpToolRuntime();
  } catch (e) {
    return errorJson(e instanceof Error ? e.message : String(e));
  }

  const ctx: LocalMcpToolActorContext = { userId };

  try {
    switch (args.action) {
      case "install": {
        // The post-model node prepares this proposal and emits an exact
        // approval. Execution goes through invocation-service with the
        // server-trusted binding, not this direct model-facing dispatcher.
        // Keep this defensive path explicit so a caller cannot bypass it.
        const request = args.request as LocalMcpInstallModelIntent | undefined;
        if (!request) return errorJson("install requires a canonical `request`.");
        return errorJson(
          "install must be prepared and explicitly approved before execution; retry through the Genie approval flow.",
        );
      }
      case "list": {
        return boundJson(await runtime.list(ctx));
      }
      case "status": {
        const name = pickNonEmpty(args.name);
        if (!name) return errorJson("status requires a `name`.");
        return boundJson(await runtime.status(ctx, { name, relayId: args.relayId }));
      }
      case "disable": {
        const name = pickNonEmpty(args.name);
        if (!name) return errorJson(`${args.action} requires a \`name\`.`);
        return boundJson(
          await runtime.setEnabled(ctx, { name, enabled: false, relayId: args.relayId }),
        );
      }
      case "remove": {
        const name = pickNonEmpty(args.name);
        if (!name) return errorJson("remove requires a `name`.");
        return boundJson(await runtime.remove(ctx, { name, relayId: args.relayId }));
      }
      default: {
        const _exhaustive: never = args.action;
        void _exhaustive;
        return errorJson(`unknown manage_local_mcp action: ${String(args.action)}`);
      }
    }
  } catch (e) {
    return errorJson(e instanceof Error ? e.message : String(e));
  }
}

export function createManageLocalMcpTool(context?: ManageLocalMcpToolContext) {
  return new DynamicStructuredTool({
    name: "manage_local_mcp",
    description: `Set up a LOCAL (relay-tier) MCP server on the requesting user's own machine.

Use this to install / disable / inspect an MCP that runs on the user's connected relay (their own computer) — NOT a server-wide MCP.

Verbs:
- install — provide one versioned canonical request. The Human sees the exact direct argv or streamable-HTTP URL, source, package/download/pinning warnings, selected machine, required environment names/status, personal availability, whether an unsandboxed local subprocess will launch, and the digest. They must explicitly approve this exact request once before anything is saved or launched. Never use a shell string, SSE, headers, or literal secret values.
- disable — stop a previously installed local MCP.
- remove — stop and permanently delete a previously installed local MCP after the Human confirms the exact name and machine.
- status — live connection health + tool count of one local MCP.
- list — the user's own local MCPs.

Hard-scoped to the user's own relay: you cannot create or edit a server-wide MCP through this tool.`,
    schema: manageLocalMcpToolSchema,
    func: async (args) => dispatchManageLocalMcpCommand(args, context),
  });
}
