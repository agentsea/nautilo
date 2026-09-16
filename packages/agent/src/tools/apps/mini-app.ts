import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { getMiniAppToolRuntime } from "./mini-app-runtime";

/** Max JSON string returned to the model (keeps tool results bounded). */
const MAX_RESULT_JSON_CHARS = 24_000;

const MUTATION_COMMANDS = new Set(["create_app", "apply_source_batch"]);

const sourceFileSchema = z.object({
  path: z.string().describe("Relative path inside the app directory (e.g. app.json, main.ts)."),
  content: z.string().describe("UTF-8 text file content."),
});

const sourceWriteSchema = z.object({
  path: z.string().describe("Relative path inside the app directory."),
  content: z.string().describe("UTF-8 text file content."),
  baseSha256: z
    .string()
    .optional()
    .describe("Expected SHA-256 of the current file bytes before overwrite (conflict-safe writes)."),
});

/**
 * Flat provider-friendly schema (NOT z.discriminatedUnion). Per-command
 * requirements are enforced in the dispatcher, mirroring `task` / `file`.
 */
export const miniAppToolSchema = z.object({
  command: z
    .enum([
      "list_apps",
      "inspect_app",
      "read_source",
      "create_app",
      "apply_source_batch",
      "validate_app",
    ])
    .describe("Mini-app authoring operation."),
  appId: z.string().optional().describe("Installed app id (required for all commands except list_apps)."),
  path: z.string().optional().describe("Relative source path (required for read_source)."),
  offsetBytes: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("For read_source: UTF-8 byte offset; defaults to 0."),
  lengthBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("For read_source: UTF-8 bytes to return. Omit to request every remaining byte."),
  expectedSha256: z
    .string()
    .optional()
    .describe("For read_source continuation beyond byte 0: SHA-256 returned by the prior range."),
  files: z
    .array(sourceFileSchema)
    .optional()
    .describe("Multi-file payload for create_app; must include app.json."),
  writes: z
    .array(sourceWriteSchema)
    .optional()
    .describe("Batch file writes for apply_source_batch."),
  expectedSourceHash: z
    .string()
    .optional()
    .describe("Optional optimistic-lock on the app source hash before mutation."),
  includeTree: z
    .boolean()
    .optional()
    .describe("For inspect_app: include bounded source tree paths."),
  includeManifest: z
    .boolean()
    .optional()
    .describe("For inspect_app: include parsed app.json manifest."),
  buildRuntime: z
    .boolean()
    .optional()
    .describe("For validate_app: run runtime build check."),
  buildAgentTools: z
    .boolean()
    .optional()
    .describe("For validate_app: run deployed agent-tool build check."),
});

export type MiniAppToolArgs = z.infer<typeof miniAppToolSchema>;

export interface MiniAppToolContext {
  userId?: string | undefined;
  ownerId?: string | undefined;
  memoryAccessEnvelope?: MemoryAccessEnvelope | null | undefined;
}

function pickNonEmpty(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

export function resolveMiniAppActorUserId(context?: MiniAppToolContext): string {
  const envelope = context?.memoryAccessEnvelope;
  return (
    pickNonEmpty(context?.userId) ||
    pickNonEmpty(context?.ownerId) ||
    pickNonEmpty(envelope?.ownerId)
  );
}

function hasDirectUserContext(context?: MiniAppToolContext): boolean {
  return Boolean(pickNonEmpty(context?.userId) || pickNonEmpty(context?.ownerId));
}

function errorJson(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, error: message, ...extra });
}

function boundJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= MAX_RESULT_JSON_CHARS) return text;
  return JSON.stringify({
    ok: false,
    error: "mini_app result too large; narrow the request (fewer files, omit tree/manifest, or read one path).",
    truncated: true,
    bytes: text.length,
  });
}

function validateMiniAppCommandArgs(args: MiniAppToolArgs): string | null {
  switch (args.command) {
    case "list_apps":
      return null;
    case "inspect_app":
      if (!pickNonEmpty(args.appId)) {
        return errorJson("inspect_app requires appId.");
      }
      return null;
    case "read_source":
      if (!pickNonEmpty(args.appId) || !pickNonEmpty(args.path)) {
        return errorJson("read_source requires appId and path.");
      }
      if (args.offsetBytes !== undefined && (!Number.isSafeInteger(args.offsetBytes) || args.offsetBytes < 0)) {
        return errorJson("invalid_range", { message: "offsetBytes must be a non-negative safe integer" });
      }
      if (
        args.lengthBytes !== undefined &&
        (!Number.isSafeInteger(args.lengthBytes) || args.lengthBytes <= 0)
      ) {
        return errorJson("invalid_range", { message: "lengthBytes must be a positive safe integer when provided" });
      }
      if ((args.offsetBytes ?? 0) > 0 && !pickNonEmpty(args.expectedSha256)) {
        return errorJson("invalid_range", {
          message: "expectedSha256 is required for continuation beyond offsetBytes 0",
        });
      }
      return null;
    case "create_app":
      if (!pickNonEmpty(args.appId) || !args.files?.length) {
        return errorJson("create_app requires appId and a non-empty files array (must include app.json).");
      }
      return null;
    case "apply_source_batch":
      if (!pickNonEmpty(args.appId) || !args.writes?.length) {
        return errorJson("apply_source_batch requires appId and a non-empty writes array.");
      }
      return null;
    case "validate_app":
      if (!pickNonEmpty(args.appId)) {
        return errorJson("validate_app requires appId.");
      }
      return null;
    default:
      return errorJson(`unknown mini_app command: ${String(args.command)}`);
  }
}

export async function dispatchMiniAppCommand(
  args: MiniAppToolArgs,
  context?: MiniAppToolContext,
): Promise<string> {
  const actorUserId = resolveMiniAppActorUserId(context);
  if (!actorUserId) {
    return errorJson("mini_app unavailable without authenticated user context.");
  }
  if (MUTATION_COMMANDS.has(args.command) && !hasDirectUserContext(context)) {
    return errorJson("mini_app mutations require authenticated user context (userId or ownerId).");
  }

  const validationError = validateMiniAppCommandArgs(args);
  if (validationError) return validationError;

  let runtime;
  try {
    runtime = getMiniAppToolRuntime();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorJson(msg);
  }

  const ctx = { userId: actorUserId };

  try {
    switch (args.command) {
      case "list_apps": {
        const result = await runtime.listApps(ctx);
        return boundJson(result);
      }
      case "inspect_app": {
        const result = await runtime.inspectApp(ctx, {
          appId: args.appId!.trim(),
          includeTree: args.includeTree,
          includeManifest: args.includeManifest,
        });
        return boundJson(result);
      }
      case "read_source": {
        const result = await runtime.readSource(ctx, {
          appId: args.appId!.trim(),
          path: args.path!.trim(),
          ...(args.offsetBytes === undefined ? {} : { offsetBytes: args.offsetBytes }),
          ...(args.lengthBytes === undefined ? {} : { lengthBytes: args.lengthBytes }),
          ...(args.expectedSha256 === undefined ? {} : { expectedSha256: args.expectedSha256 }),
        });
        // read_source is a caller-owned source projection. It must not pass
        // through the unrelated model-result bound: an explicit valid range
        // is either returned intact or rejected by its actual transport.
        return JSON.stringify(result);
      }
      case "create_app": {
        const result = await runtime.createApp(ctx, {
          appId: args.appId!.trim(),
          files: args.files!.map((f) => ({ path: f.path, content: f.content })),
          expectedSourceHash: args.expectedSourceHash,
        });
        return boundJson(result);
      }
      case "apply_source_batch": {
        const result = await runtime.applySourceBatch(ctx, {
          appId: args.appId!.trim(),
          writes: args.writes!.map((w) => ({
            path: w.path,
            content: w.content,
            baseSha256: w.baseSha256,
          })),
          expectedSourceHash: args.expectedSourceHash,
        });
        return boundJson(result);
      }
      case "validate_app": {
        const result = await runtime.validateApp(ctx, {
          appId: args.appId!.trim(),
          buildRuntime: args.buildRuntime,
          buildAgentTools: args.buildAgentTools,
        });
        return boundJson(result);
      }
      default:
        return errorJson(`unknown mini_app command: ${String(args.command)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorJson(msg, { command: args.command });
  }
}

export function createMiniAppTool(context?: MiniAppToolContext) {
  return new DynamicStructuredTool({
    name: "mini_app",
    description: `Create and maintain installed mini-app source under the server apps root.

Use this tool — not \`file\` — for mini-app authoring. V1 apps must be dependency-free (no npm/bun installs).

Commands:
- list_apps — list installed apps with status/source hash summaries (each carries \`enabled\`)
- inspect_app — app metadata; optional source tree and manifest

Disabled apps (\`enabled: false\`) are kept only as build REFERENCES: you may
inspect_app / read_source them to learn patterns, but never treat them as active
apps — do not deploy them, offer them to the user, or use them for user tasks.
Their per-app usage tools are not registered, so you cannot call them anyway.
- read_source — read one UTF-8 byte range from an app; use nextOffsetBytes and
  expectedSha256 to continue a partial read safely
- create_app — create a new app from a multi-file payload (must include app.json)
- apply_source_batch — bounded batch writes with optional baseSha256 conflict checks
- validate_app — manifest/build/agent-tool validation status

Always validate after writing source. For UI code use the iframe bridge (\`window.nautiloApp\`) for document/state access.`,
    schema: miniAppToolSchema,
    func: async (args) => dispatchMiniAppCommand(args, context),
  });
}
