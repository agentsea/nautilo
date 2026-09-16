import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  getConnectedWebOperationDirectToolRuntime,
  type ConnectedWebOperationDirectToolInput,
  type ConnectedWebOperationDirectToolResult,
} from "./runtime";
import {
  resolveManageConnectedWebOperationActor,
  type ManageConnectedWebOperationToolContext,
} from "./manage-connected-web-operation";

const operationBase = { operationId: z.string().uuid(), expectedControlEpoch: z.number().int().min(1) };
// agent-browser's semantic snapshot contract issues element references as
// `@eN`.  Accept the documented optional-@ spelling at this boundary; the
// vendored argv mapper canonicalizes it before process invocation.
const ref = z.string().trim().regex(/^@?e[1-9]\d*$/u);
const key = z.string().trim().min(1).max(128);
const value = z.string().max(4_096);
const text = z.string().max(16_384);

/**
 * Server direct control uses its own semantic command vocabulary.  It never
 * accepts a relay tool name, arbitrary argument object, coordinate, browser
 * id, provider id, profile, session, cookie, or CDP capability.
 */
export const controlConnectedWebOperationToolSchema = z.object({
  ...operationBase,
  command: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("snapshot") }).strict(),
    z.object({ kind: z.literal("click"), ref }).strict(),
    z.object({ kind: z.literal("type"), ref, text, clear: z.boolean().optional() }).strict(),
    z.object({ kind: z.literal("press"), key }).strict(),
    z.object({ kind: z.literal("open"), url: z.string().url().refine((value) => /^https?:\/\//u.test(value)) }).strict(),
    z.object({ kind: z.literal("back") }).strict(),
    z.object({ kind: z.literal("forward") }).strict(),
    z.object({ kind: z.literal("reload") }).strict(),
    z.object({ kind: z.literal("hover"), ref }).strict(),
    z.object({ kind: z.literal("double_click"), ref }).strict(),
    z.object({ kind: z.literal("drag"), from: ref, to: ref }).strict(),
    z.object({ kind: z.literal("select"), ref, values: z.array(value).min(1).max(64) }).strict(),
    z.object({ kind: z.literal("set_checked"), ref, checked: z.boolean() }).strict(),
    z.object({ kind: z.literal("scroll_into_view"), ref }).strict(),
    z.object({ kind: z.literal("wait_for"), ref }).strict(),
    z.object({ kind: z.literal("wait"), milliseconds: z.number().int().min(0).max(30_000) }).strict(),
    z.object({ kind: z.literal("read"), ref }).strict(),
    z.object({
      kind: z.literal("get"),
      what: z.enum(["box", "value", "attr", "title", "url"]),
      ref: ref.optional(),
      name: z.string().trim().min(1).max(256).optional(),
    }).strict().superRefine((command, context) => {
      const needsRef = command.what === "box" || command.what === "value" || command.what === "attr";
      if (needsRef !== (command.ref !== undefined)) context.addIssue({ code: "custom", message: "invalid get target" });
      if ((command.what === "attr") !== (command.name !== undefined)) context.addIssue({ code: "custom", message: "invalid get attribute" });
    }),
  ]),
}).strict();

export type ControlConnectedWebOperationToolArgs = z.infer<typeof controlConnectedWebOperationToolSchema>;

function safeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && ((codePoint < 32 && character !== "\t" && character !== "\n" && character !== "\r") || codePoint === 127)) return null;
  }
  // Page text may legitimately contain ordinary website links and words such
  // as "session".  Only redact capability-shaped endpoints; account/provider
  // coordinates are excluded structurally by the field-by-field projection.
  return value
    .replace(/wss:\/\/[^\s"'<>]+/gu, "[redacted]")
    .replace(/https:\/\/[^\s"'<>]*\.cdp\.browser-use\.com[^\s"'<>]*/giu, "[redacted]");
}

function project(result: ConnectedWebOperationDirectToolResult, operationId: string): string {
  if (!result.ok) return JSON.stringify({ ok: false, code: result.code, recovery: "none" });
  const command = safeText(result.command.text, 96 * 1024);
  const operation = result.operation;
  if (command === null || operation.operationId !== operationId || !Number.isSafeInteger(operation.controlEpoch)
    || !["hosted", "checking", "direct", "human"].includes(operation.driver)
    || !["admitted", "running", "attention", "terminal"].includes(operation.lifecycle)
    || !operation.activity || safeText(operation.activity.code, 128) === null || safeText(operation.activity.summary, 512) === null) {
    return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
  }
  // Build the response field-by-field.  This prevents later server additions
  // from accidentally projecting durable provider/account/browser fields.
  return JSON.stringify({
    ok: true,
    command: { text: command, truncated: result.command.truncated === true },
    operation: {
      operationId: operation.operationId,
      driver: operation.driver,
      lifecycle: operation.lifecycle,
      controlEpoch: operation.controlEpoch,
      activity: { phase: operation.activity.phase, code: operation.activity.code, summary: operation.activity.summary },
      receipt: operation.receipt === null ? null : {
        outcome: operation.receipt.outcome, code: operation.receipt.code, summary: operation.receipt.summary,
      },
      result: null,
    },
  });
}

export async function dispatchControlConnectedWebOperation(
  args: ControlConnectedWebOperationToolArgs,
  context?: ManageConnectedWebOperationToolContext,
): Promise<string> {
  const actor = resolveManageConnectedWebOperationActor(context);
  const runtime = getConnectedWebOperationDirectToolRuntime();
  if (!actor || !runtime) return JSON.stringify({ ok: false, code: "unavailable", recovery: "none" });
  try {
    return project(await runtime.control(actor, args as ConnectedWebOperationDirectToolInput), args.operationId);
  } catch {
    return JSON.stringify({ ok: false, code: "unavailable", recovery: "none" });
  }
}

export function createControlConnectedWebOperationTool(context?: ManageConnectedWebOperationToolContext) {
  return new DynamicStructuredTool({
    name: "control_connected_web_operation",
    description: "Control an already-taken-over connected website operation using a small semantic command. Reuse the operation id and current control epoch from operation management. Preserve its original scope: read operations remain reads; run_website_task allows actions within the user's request without repeated approval. Pause for dangerous, irreversible, ambiguous or out-of-scope actions. After takeover or an uncertain response, inspect saved state before acting; never repeat a potentially completed change blindly. This is server direct control, not a local browser_* tool. It cannot use browser coordinates, screenshots, files, tabs, frames, dialogs, cookies, storage, JavaScript evaluation, or generic arguments.",
    schema: controlConnectedWebOperationToolSchema,
    func: async (args: ControlConnectedWebOperationToolArgs) => dispatchControlConnectedWebOperation(args, context),
  });
}
