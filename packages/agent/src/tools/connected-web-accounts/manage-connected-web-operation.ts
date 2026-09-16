import { connectedWebOperationTerminalReadResultSchema } from "@nautilo/types";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { ConnectedWebOperationSafeReceipt } from "@nautilo/types";
import { connectedWebActivityPageSchema } from "@nautilo/types";
import { z } from "zod";
import {
  getConnectedWebOperationToolRuntime,
  type ConnectedWebAccountReadSuccess,
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

function boundedReadText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum ? value.trim() : null;
}

function safeTerminalReadResult(value: unknown): NonNullable<ConnectedWebOperationSafeProjection["result"]> | null {
  if (value && typeof value === "object" && "account" in value && value.account === null) {
    const parsed = connectedWebOperationTerminalReadResultSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== "account,cost,ok,outputs,outputsTruncated,page,read,status"
    || result["ok"] !== true || result["status"] !== "completed" || !Array.isArray(result["outputs"])
    || result["outputs"].length !== 0 || result["outputsTruncated"] !== false) return null;
  const account = result["account"] as Record<string, unknown>;
  const page = result["page"] as Record<string, unknown>;
  const cost = result["cost"] as Record<string, unknown>;
  if (!account || typeof account !== "object" || Array.isArray(account) || Object.keys(account).sort().join(",") !== "id,label,origin,service"
    || !page || typeof page !== "object" || Array.isArray(page) || Object.keys(page).sort().join(",") !== "origin,ref,title"
    || !cost || typeof cost !== "object" || Array.isArray(cost) || Object.keys(cost).sort().join(",") !== "amountUsd,currency,state"
    || cost["currency"] !== "USD" || (cost["state"] !== "actual" && cost["state"] !== "unknown")
    || (cost["state"] === "actual" && (typeof cost["amountUsd"] !== "number" || !Number.isFinite(cost["amountUsd"]) || cost["amountUsd"] < 0))
    || (cost["state"] === "unknown" && cost["amountUsd"] !== null)
    || !boundedReadText(account["id"], 256) || !boundedReadText(account["label"], 256) || !boundedReadText(account["service"], 128) || !boundedReadText(account["origin"], 2_048)
    || page["ref"] !== account["id"] || page["title"] !== account["label"] || page["origin"] !== account["origin"]) return null;
  let read: ConnectedWebAccountReadSuccess["read"] = null;
  if (result["read"] !== null) {
    const raw = result["read"] as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "answer,completeness,facts,origin,provenance"
      || !boundedReadText(raw["answer"], 8_000)
      || !Array.isArray(raw["facts"]) || raw["facts"].length > 32 || !["complete", "partial", "unknown"].includes(raw["completeness"] as string)
      || !["authenticated_website", "user_connected_website"].includes(raw["provenance"] as string) || raw["origin"] !== account["origin"]) return null;
    for (const fact of raw["facts"]) {
      if (!fact || typeof fact !== "object" || Array.isArray(fact) || Object.keys(fact as object).sort().join(",") !== "label,value"
        || !boundedReadText((fact as Record<string, unknown>)["label"], 256) || !boundedReadText((fact as Record<string, unknown>)["value"], 1_024)) return null;
    }
    read = {
      answer: raw["answer"] as string,
      facts: raw["facts"] as ConnectedWebAccountReadSuccess["read"] extends infer T ? T extends { facts: infer F } ? F : never : never,
      completeness: raw["completeness"] as ConnectedWebAccountReadSuccess["read"] extends infer T ? T extends { completeness: infer C } ? C : never : never,
      provenance: raw["provenance"] as ConnectedWebAccountReadSuccess["read"] extends infer T ? T extends { provenance: infer P } ? P : never : never,
      origin: raw["origin"] as string,
    };
  }
  return {
    ok: true, status: "completed",
    account: { id: account["id"] as string, label: account["label"] as string, service: account["service"] as string, origin: account["origin"] as string },
    page: { ref: page["ref"] as string, title: page["title"] as string, origin: page["origin"] as string },
    read,
    cost: { currency: "USD", amountUsd: cost["amountUsd"] as number | null, state: cost["state"] },
    outputs: [], outputsTruncated: false,
  };
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
