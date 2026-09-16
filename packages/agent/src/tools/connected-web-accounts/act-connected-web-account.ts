import { DynamicStructuredTool } from "@langchain/core/tools";
import { interrupt, isGraphBubbleUp } from "@langchain/langgraph";
import { z } from "zod";
import {
  getConnectedWebAccountActionToolRuntime,
  type ConnectedWebAccountActionResult,
} from "./runtime";
import {
  CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS,
  resolveConnectedWebAccountReadActor,
  type ConnectedWebAccountReadToolContext,
} from "./read-connected-web-account";

const TARGET_MAX_CHARS = 1_024;

export const connectedWebAccountActionToolSchema = z.object({
  account: z.string().trim().min(1).max(CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS)
    .describe("One unique connected website account label, service, origin, or exact id from current capability context."),
  action: z.literal("save_item").describe("The only supported website action: save, bookmark, or favorite one item."),
  target: z.string().trim().min(1).max(TARGET_MAX_CHARS)
    .describe("The one Human-named item to save. Do not include credentials, payment details, or instructions to send/change/delete anything."),
}).strict();

export type ConnectedWebAccountActionToolArgs = z.infer<typeof connectedWebAccountActionToolSchema>;

function safeText(value: unknown, max: number): string | null { return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : null; }
type SafeAuthenticationIntervention =
  | { kind: "authentication_required"; mode: "connect"; reason: "not_connected"; target: { selector: string } }
  | { kind: "authentication_required"; mode: "reconnect"; reason: "reconnect" | "sign_in" | "mfa" | "captcha"; account: { id: string; label: string; service: string; origin: string } };

function safeAuthenticationIntervention(value: unknown): SafeAuthenticationIntervention | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intervention = value as Record<string, unknown>;
  if (intervention["kind"] !== "authentication_required") return null;
  if (intervention["mode"] === "connect") {
    const target = intervention["target"];
    const selector = target && typeof target === "object" && !Array.isArray(target)
      ? safeText((target as Record<string, unknown>)["selector"], CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS) : null;
    return intervention["reason"] === "not_connected" && selector
      ? { kind: "authentication_required", mode: "connect", reason: "not_connected", target: { selector } }
      : null;
  }
  if (intervention["mode"] !== "reconnect" || (intervention["reason"] !== "reconnect" && intervention["reason"] !== "sign_in" && intervention["reason"] !== "mfa" && intervention["reason"] !== "captcha")) return null;
  if (!intervention["account"] || typeof intervention["account"] !== "object" || Array.isArray(intervention["account"])) return null;
  const account = intervention["account"] as Record<string, unknown>;
  const id = safeText(account["id"], 128); const label = safeText(account["label"], 256);
  const service = safeText(account["service"], 128); const origin = safeText(account["origin"], 2_048);
  return id && label && service && origin
    ? { kind: "authentication_required", mode: "reconnect", reason: intervention["reason"], account: { id, label, service, origin } }
    : null;
}
function safeProjection(result: ConnectedWebAccountActionResult): string {
  if (result.ok) {
    const account = result.account; const receipt = result.receipt;
    if (result.status !== "completed" || result.action !== "save_item" || receipt.effectState !== "observed"
      || !safeText(account.id, 128) || !safeText(account.label, 256) || !safeText(account.service, 128) || !safeText(account.origin, 2_048)
      || !safeText(result.target, TARGET_MAX_CHARS) || !safeText(receipt.executionRef, 128) || !safeText(receipt.postcondition, 2_048)
      || !safeText(receipt.evidenceCode, 128) || (receipt.cost.state !== "actual" && receipt.cost.state !== "unknown")
      || (receipt.cost.state === "actual" && (typeof receipt.cost.amountUsd !== "number" || !Number.isFinite(receipt.cost.amountUsd) || receipt.cost.amountUsd < 0))
      || (receipt.cost.state === "unknown" && receipt.cost.amountUsd !== null)) return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
    return JSON.stringify({
      ok: true, status: "completed", action: "save_item", target: result.target,
      account: { id: account.id, label: account.label, service: account.service, origin: account.origin },
      receipt: { executionRef: receipt.executionRef, effectState: "observed", postcondition: receipt.postcondition, evidenceCode: receipt.evidenceCode, cost: { amountUsd: receipt.cost.amountUsd, state: receipt.cost.state } },
    });
  }
  if (result.code === "authentication_required" && result.intervention) {
    const intervention = safeAuthenticationIntervention(result.intervention);
    return intervention === null
      ? JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" })
      : JSON.stringify({ ok: false, code: result.code, recovery: result.recovery, intervention });
  }
  return JSON.stringify({ ok: false, code: result.code, recovery: result.recovery });
}

function authDecision(value: unknown, deliveryId: string): "done" | "cancel" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record["toolCallId"] !== deliveryId) return null;
  const decision = record["decision"];
  return decision === "done" || decision === "cancel" ? decision : null;
}

type ConnectedWebActionResumeContext = Readonly<{
  version: "connected-web-action-resume-v1";
  toolCallId: string;
  userId: string;
  intervention: SafeAuthenticationIntervention;
}>;

function safeResumeContext(
  value: unknown,
  deliveryId: string,
  userId: string,
): ConnectedWebActionResumeContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "intervention,toolCallId,userId,version"
    || record["version"] !== "connected-web-action-resume-v1"
    || record["toolCallId"] !== deliveryId
    || record["userId"] !== userId) return null;
  const intervention = safeAuthenticationIntervention(record["intervention"]);
  return intervention ? {
    version: "connected-web-action-resume-v1",
    toolCallId: deliveryId,
    userId,
    intervention,
  } : null;
}

/**
 * A purposely non-general browser action. Unsupported effects must be refused
 * by the Genie rather than translated into a `save_item` request.
 */
export function createConnectedWebAccountActionTool(context?: ConnectedWebAccountReadToolContext) {
  return new DynamicStructuredTool({
    name: "act_connected_web_account",
    description: "Save or bookmark one Human-named item on one connected website account and obtain a separately observed receipt. The user's request authorizes this save; do not ask for the same permission again. For other website work use run_website_task, not save_item. Use a connected account directly; do not search the public web to rediscover a site. If authentication is required, let Nautilo present the protected sign-in journey; never ask for passwords, MFA codes, passkeys, or CAPTCHA answers in chat. Do not retry a cancelled, ambiguous, unavailable, or failed action automatically.",
    schema: connectedWebAccountActionToolSchema,
    func: async (args: ConnectedWebAccountActionToolArgs, _runManager, config): Promise<string> => {
      const actor = resolveConnectedWebAccountReadActor(context);
      const runtime = getConnectedWebAccountActionToolRuntime();
      const configuredDeliveryId: unknown = config?.configurable?.["connectedWebActionDeliveryId"] as unknown;
      const deliveryId = typeof configuredDeliveryId === "string" && configuredDeliveryId.trim().length > 0
        ? configuredDeliveryId.trim()
        : null;
      const graphThreadId: unknown = config?.configurable?.["thread_id"] as unknown;
      const rawResumeContext: unknown = config?.configurable?.["connectedWebActionResumeContext"] as unknown;
      if (!actor || !runtime) return JSON.stringify({ ok: false, code: "unavailable", recovery: "none" });
      // An external write without the exact tool delivery identity is unsafe:
      // a graph replay could make it twice. Fail before it can reach a profile.
      if (!deliveryId) return JSON.stringify({ ok: false, code: "approval_required", recovery: "none" });
      try {
        const resumeContext = safeResumeContext(rawResumeContext, deliveryId, actor.userId);
        // A protected resume deliberately replays this tool node from its
        // beginning. Consume the already-parked interrupt before any runtime
        // call so Cancel can never race a newly connected profile into an
        // external effect. A malformed resume marker also fails before work.
        if (rawResumeContext !== undefined && !resumeContext) {
          return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
        }
        let result: ConnectedWebAccountActionResult;
        if (resumeContext) {
          const decision = authDecision(interrupt({
            type: "connected_web_action_attention",
            toolCallId: deliveryId,
            userId: actor.userId,
            intervention: resumeContext.intervention,
          }), deliveryId);
          if (decision === "cancel") {
            const cancelled = runtime.cancelAuthentication
              ? await runtime.cancelAuthentication(actor, { deliveryId })
              : null;
            result = cancelled === null || (!cancelled.ok && cancelled.code === "not_found")
              ? { ok: false, code: "cancelled", recovery: "none" }
              : cancelled;
          } else if (decision === "done") {
            // Calling act first covers pre-admission connect/reconnect, where
            // no durable action row existed. An admitted provider challenge
            // replays its parked receipt without an effect, then resumes the
            // exact row through the dedicated fresh-observation path.
            result = await runtime.act(actor, { ...args, deliveryId });
            if (!result.ok && result.code === "authentication_required"
              && runtime.resumeAfterAuthentication) {
              result = await runtime.resumeAfterAuthentication(actor, { deliveryId });
            }
          } else {
            return JSON.stringify({ ok: false, code: "ambiguous", recovery: "none" });
          }
          // One graph delivery currently admits one protected Human handoff.
          // A second auth challenge ends this tool result safely; the later
          // control-epoch slice will add repeatable takeover without replaying
          // an earlier Done before the newest decision is consumed.
          return safeProjection(result);
        }

        result = await runtime.act(actor, { ...args, deliveryId });
        // Direct tool invocations (tests/isolated callers) have no LangGraph
        // checkpoint to park. Preserve the sealed typed projection there.
        if (typeof graphThreadId !== "string" || graphThreadId.length === 0) return safeProjection(result);
        // This exact DynamicStructuredTool invocation is parked and resumed;
        // no model-visible retry, new delivery, or new approval is created.
        if (!result.ok && result.code === "authentication_required" && result.intervention) {
          const intervention = safeAuthenticationIntervention(result.intervention);
          if (!intervention) return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
          const decision = authDecision(interrupt({
            type: "connected_web_action_attention", toolCallId: deliveryId, userId: actor.userId, intervention,
          }), deliveryId);
          // A real graph always throws on the first pass. Reaching this branch
          // without the protected resume marker is therefore malformed.
          if (decision) return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
        }
        return safeProjection(result);
      } catch (error) {
        // LangGraph uses a thrown control signal to persist/park interrupt().
        // It is not a provider failure and must propagate to the graph.
        if (isGraphBubbleUp(error)) throw error;
        return JSON.stringify({ ok: false, code: "provider_unavailable", recovery: "none" });
      }
    },
  });
}
