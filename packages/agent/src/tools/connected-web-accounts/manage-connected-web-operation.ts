import { connectedWebOperationTerminalReadResultSchema } from "@nautilo/types";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { ConnectedWebOperationSafeReceipt } from "@nautilo/types";
import { connectedWebActivityPageSchema } from "@nautilo/types";
import { z } from "zod";
import {
  getConnectedWebOperationToolRuntime,
  type ConnectedWebOperationSafeProjection,
  type ConnectedWebOperationToolActorContext,
  type ConnectedWebOperationToolInput,
  type ConnectedWebOperationToolResult,
} from "./runtime";
import {
  resolveConnectedWebAccountReadActor,
  type ConnectedWebAccountReadToolContext,
} from "./read-connected-web-account";

const OPERATION_ID_SCHEMA = z.string().uuid();
const CONTROL_EPOCH_SCHEMA = z.number().int().min(1);
const STEER_INSTRUCTION_MAX_BYTES = 4_096;
const SAFE_CODE_MAX_CHARS = 128;
const SAFE_SUMMARY_MAX_CHARS = 512;

const operationBaseSchema = {
  operationId: OPERATION_ID_SCHEMA,
  expectedControlEpoch: CONTROL_EPOCH_SCHEMA,
};

function boundedUtf8Text(maximumBytes: number) {
  return z.string().trim().min(1).refine(
    (value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
    { message: `Must be at most ${maximumBytes} UTF-8 bytes.` },
  );
}

/** Model-visible control inputs; foreground authority is deliberately injected. */
export const manageConnectedWebOperationToolSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inspect"), ...operationBaseSchema, activityBefore: z.number().int().positive().safe().optional().describe("Use activityLog.before to read the next page of earlier reported browser actions.") }).strict(),
  z.object({ operation: z.literal("continue"), ...operationBaseSchema }).strict(),
  z.object({
    operation: z.literal("check_later"),
    ...operationBaseSchema,
    dueAt: z.string().datetime({ offset: true }).describe("Check current operation status at this exact time. Conditional checks are not supported."),
  }).strict(),
  z.object({
    operation: z.literal("steer"),
    ...operationBaseSchema,
    instruction: boundedUtf8Text(STEER_INSTRUCTION_MAX_BYTES),
  }).strict(),
  z.object({ operation: z.literal("take_control"), ...operationBaseSchema }).strict(),
  z.object({ operation: z.literal("release_control"), ...operationBaseSchema }).strict(),
  z.object({ operation: z.literal("stop"), ...operationBaseSchema }).strict(),
]);

export type ManageConnectedWebOperationToolArgs = z.infer<typeof manageConnectedWebOperationToolSchema>;

/** Trusted invocation fields are supplied by the tool resolver, never the model. */
export interface ManageConnectedWebOperationToolContext extends ConnectedWebAccountReadToolContext {
  readonly toolCallId?: string | undefined;
  readonly currentThreadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly laneKey?: string | undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Fails closed if the exact foreground delivery proof was not injected. */
export function resolveManageConnectedWebOperationActor(
  context?: ManageConnectedWebOperationToolContext,
): ConnectedWebOperationToolActorContext | null {
  const actor = resolveConnectedWebAccountReadActor(context);
  const toolCallId = nonEmptyString(context?.toolCallId);
  const currentThreadId = nonEmptyString(context?.currentThreadId);
  const turnId = nonEmptyString(context?.turnId);
  const laneKey = nonEmptyString(context?.laneKey);
  if (!actor || !toolCallId || !currentThreadId || !turnId) return null;
  return laneKey === null
    ? { ...actor, toolCallId, currentThreadId, turnId }
    : { ...actor, toolCallId, currentThreadId, turnId, laneKey };
}

function safeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // A provider/browser coordinate is never safe status prose.
  if (trimmed.length === 0 || trimmed.length > maximum || /[\r\n]/u.test(trimmed)
    || /\b(?:https?|wss?|cdp):\/\/|\b(?:cookie|authorization|bearer)\b/iu.test(trimmed)) return null;
  return trimmed;
}

function safeTerminalReadResult(value: unknown): NonNullable<ConnectedWebOperationSafeProjection["result"]> | null {
  const parsed = connectedWebOperationTerminalReadResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeProjection(value: unknown, expectedOperationId: string): ConnectedWebOperationSafeProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const operation = value as Record<string, unknown>;
  if (Object.keys(operation).filter((key) => key !== "activityLog").sort().join(",") !== "activity,controlEpoch,driver,lifecycle,operationId,receipt,result"
    || operation["operationId"] !== expectedOperationId
    || !Number.isSafeInteger(operation["controlEpoch"]) || (operation["controlEpoch"] as number) < 1
    || !["hosted", "checking", "direct", "human"].includes(operation["driver"] as string)
    || !["admitted", "running", "attention", "terminal"].includes(operation["lifecycle"] as string)) return null;
  const activityValue = operation["activity"];
  if (!activityValue || typeof activityValue !== "object" || Array.isArray(activityValue)) return null;
  const activity = activityValue as Record<string, unknown>;
  if (Object.keys(activity).sort().join(",") !== "code,phase,summary"
    || !["starting", "working", "checking", "attention", "finishing"].includes(activity["phase"] as string)) return null;
  const code = safeText(activity["code"], SAFE_CODE_MAX_CHARS);
  const summary = safeText(activity["summary"], SAFE_SUMMARY_MAX_CHARS);
  if (!code || !summary) return null;

  let receipt: ConnectedWebOperationSafeReceipt | null = null;
  if (operation["receipt"] !== null) {
    const receiptValue = operation["receipt"];
    if (!receiptValue || typeof receiptValue !== "object" || Array.isArray(receiptValue)) return null;
    const rawReceipt = receiptValue as Record<string, unknown>;
    if (Object.keys(rawReceipt).sort().join(",") !== "code,outcome,summary"
      || !["completed", "cancelled", "failed", "attention_required", "ambiguous"].includes(rawReceipt["outcome"] as string)) return null;
    const receiptCode = safeText(rawReceipt["code"], SAFE_CODE_MAX_CHARS);
    const receiptSummary = safeText(rawReceipt["summary"], SAFE_SUMMARY_MAX_CHARS);
    if (!receiptCode || !receiptSummary) return null;
    receipt = {
      outcome: rawReceipt["outcome"] as ConnectedWebOperationSafeReceipt["outcome"],
      code: receiptCode,
      summary: receiptSummary,
    };
  }
  if ((operation["lifecycle"] === "terminal") !== (receipt !== null)) return null;
  const result = operation["result"] === null ? null : safeTerminalReadResult(operation["result"]);
  if (operation["result"] !== null && result === null) return null;
  if (result !== null && (operation["lifecycle"] !== "terminal" || receipt?.outcome !== "completed")) return null;
  const activityLog = operation["activityLog"] === undefined ? undefined : connectedWebActivityPageSchema.safeParse(operation["activityLog"]);
  if (activityLog && !activityLog.success) return null;
  return {
    operationId: expectedOperationId,
    driver: operation["driver"] as ConnectedWebOperationSafeProjection["driver"],
    lifecycle: operation["lifecycle"] as ConnectedWebOperationSafeProjection["lifecycle"],
    controlEpoch: operation["controlEpoch"] as number,
    activity: { phase: activity["phase"] as ConnectedWebOperationSafeProjection["activity"]["phase"], code, summary },
    receipt,
    result,
    ...(activityLog?.success ? { activityLog: activityLog.data } : {}),
  };
}

function projectManageConnectedWebOperationResult(
  result: ConnectedWebOperationToolResult,
  input: ConnectedWebOperationToolInput,
): string {
  if (!result.ok) {
    if (!(["unavailable", "not_found", "forbidden", "conflict", "invalid_result"] as const).includes(result.code)
      || !(["none", "human_authentication"] as const).includes(result.recovery)) {
      return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
    }
    return JSON.stringify({ ok: false, code: result.code, recovery: result.recovery });
  }
  const operation = safeProjection(result.operation, input.operationId);
  if (result.accepted !== input.operation || !operation) {
    return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
  }
  return JSON.stringify({ ok: true, accepted: result.accepted, operation });
}

export async function dispatchManageConnectedWebOperation(
  args: ManageConnectedWebOperationToolArgs,
  context?: ManageConnectedWebOperationToolContext,
): Promise<string> {
  const actor = resolveManageConnectedWebOperationActor(context);
  const runtime = getConnectedWebOperationToolRuntime();
  if (!actor || !runtime) return JSON.stringify({ ok: false, code: "unavailable", recovery: "none" });
  try {
    return projectManageConnectedWebOperationResult(
      await runtime.manage(actor, args as ConnectedWebOperationToolInput),
      args as ConnectedWebOperationToolInput,
    );
  } catch {
    return JSON.stringify({ ok: false, code: "unavailable", recovery: "none" });
  }
}

/** One compact supervision tool; it intentionally has no generic browser surface. */
export function createManageConnectedWebOperationTool(context?: ManageConnectedWebOperationToolContext) {
  return new DynamicStructuredTool({
    name: "manage_connected_web_operation",
    description: "Inspect or manage one existing connected-website operation. Use inspect before deciding whether to continue, check later with an explicit ISO due time, steer, take control, release control, or stop. The operation id and expected control epoch come only from a prior safe operation result. This is not a browser command tool: never substitute a local browser, request a live URL, or ask for credentials. If authentication is needed, let Nautilo present the protected Human sign-in journey and wait for Done or Cancel. Server support is required; unavailable means no operation was changed.",
    schema: manageConnectedWebOperationToolSchema,
    func: async (args: ManageConnectedWebOperationToolArgs) => dispatchManageConnectedWebOperation(args, context),
  });
}
