import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { browserDecisionObservationSchema, browserDecisionPlanError, browserDecisionPlanSchema,
  interpretBrowserDecisionCall, type BrowserDecisionState } from "../../graph/browser-decision";
import { resolveBrowserDecisionModel } from "../browser/browser-snapshot";
import { readBrowserHistory } from "../browser/browser-history";
import type { BaseMessage } from "@langchain/core/messages";
import {
  getConnectedWebOperationDirectToolRuntime,
  type ConnectedWebOperationDirectToolInput,
  type ConnectedWebOperationDirectToolResult,
  type ConnectedWebOperationDirectControlOptions,
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
    z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]), amount: z.number().optional() }).strict(),
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

export type ControlConnectedWebOperationToolArgs = z.infer<typeof controlConnectedWebOperationToolSchema> & { decisionPlan?: unknown };

export interface ControlConnectedWebOperationToolContext extends ManageConnectedWebOperationToolContext {
  readonly fullEncryptionOnly?: boolean;
  readonly browserDecision?: BrowserDecisionState | null;
  readonly browserDecisionCall?: { id?: string; name: string; args: Record<string, unknown> };
  readonly browserDecisionSingleton?: boolean;
  readonly browserHistoryMessages?: BaseMessage[];
  readonly signal?: AbortSignal;
}

function safeText(value: unknown, maximum?: number): string | null {
  if (typeof value !== "string" || (maximum !== undefined && value.length > maximum)) return null;
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
  if (!result.ok) return JSON.stringify({ ok: false, code: result.code, recovery: "none",
    ...(result.browserFailure ? { browserFailure: result.browserFailure } : {}),
    ...(result.detail ? { detail: safeText(result.detail, 96 * 1024) ?? "Browser error detail could not be safely projected." } : {}),
  });
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
  const observation = result.observation === undefined ? null : browserDecisionObservationSchema.safeParse(result.observation);
  if (observation && (!observation.success || safeText(JSON.stringify(observation.data)) !== JSON.stringify(observation.data))) {
    return JSON.stringify({ ok: false, code: "invalid_result", browserFailure: "browser_observation_invalid", recovery: "none" });
  }
  return JSON.stringify({
    ok: true,
    command: { text: observation?.success ? "Current structured browser observation follows." : command, truncated: result.command.truncated === true },
    ...(observation?.success ? { observation: observation.data } : {}),
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
  context?: ControlConnectedWebOperationToolContext,
): Promise<string> {
  const actor = resolveManageConnectedWebOperationActor(context);
  const runtime = getConnectedWebOperationDirectToolRuntime();
  if (!actor || !runtime) return JSON.stringify({ ok: false, code: "unavailable", recovery: "none" });
  const interpreted = interpretBrowserDecisionCall({ name: "control_connected_web_operation", args });
  if (interpreted.kind === "invalid") return browserDecisionPlanError(interpreted.error, interpreted.code,
    interpreted.instruction.replaceAll("browser_snapshot", "control_connected_web_operation snapshot"));
  const options: ConnectedWebOperationDirectControlOptions = { ...(context?.signal ? { signal: context.signal } : {}) };
  let decision: ConnectedWebOperationDirectControlOptions["decision"];
  if (args.decisionPlan !== undefined && args.command.kind !== "snapshot") {
    return browserDecisionPlanError(null, "decision_plan_requires_snapshot", "Use one control_connected_web_operation snapshot with decisionPlan. No action was sent.");
  }
  if (interpreted.kind === "plan") {
    if (!resolveBrowserDecisionModel(context) || !context?.signal || context.signal.aborted) {
      return JSON.stringify({ ok: false, code: "unavailable", detail: "Routine decisions are unavailable. Use ordinary control commands after observing current state. No browser request was sent.", recovery: "none" });
    }
    if (context.browserDecisionSingleton !== true) return browserDecisionPlanError(null, "decision_plan_requires_singleton",
      "Send the operation snapshot and decisionPlan as one standalone tool call. No browser request was sent.");
    decision = { kind: "observe" };
  }
  const episode = context?.browserDecision;
  const pending = episode?.pending;
  if (pending && pending.call.id === context?.toolCallId) {
    const call = context?.browserDecisionCall;
    if (episode?.phase !== "waiting" || episode.turnId !== context?.turnId
      || episode.target?.kind !== "connected_web" || episode.target.operationId !== args.operationId
      || episode.target.controlEpoch !== args.expectedControlEpoch
      || pending.call.name !== call?.name || JSON.stringify(pending.call.args) !== JSON.stringify(call?.args)
      || resolveBrowserDecisionModel(context, episode.modelId) === null
      || !context?.signal || context.signal.aborted) {
      return JSON.stringify({ ok: false, code: "conflict", browserFailure: "browser_authority_lost", detail: "Browser decision binding changed. Inspect current operation before continuing.", recovery: "none" });
    }
    decision = pending.observationId === null ? { kind: "observe" } : { kind: "act", observationId: pending.observationId };
  }
  try {
    const input: ConnectedWebOperationDirectToolInput = { operationId: args.operationId,
      expectedControlEpoch: args.expectedControlEpoch, command: args.command };
    return project(await runtime.control(actor, input, { ...options, ...(decision ? { decision } : {}) }), args.operationId);
  } catch {
    return JSON.stringify({ ok: false, code: "unavailable", recovery: "none",
      browserFailure: args.command.kind === "snapshot" ? "browser_observation_invalid" : "browser_outcome_unknown",
      detail: "The connected browser runtime did not return a trustworthy receipt. Inspect operation status and current state before continuing; do not replay an uncertain action.",
    });
  }
}

export function createControlConnectedWebOperationTool(context?: ControlConnectedWebOperationToolContext) {
  const model = resolveBrowserDecisionModel(context);
  const schema = controlConnectedWebOperationToolSchema.partial().extend({
    historyToolCallId: z.string().min(1).optional(),
    ...(model ? { decisionPlan: browserDecisionPlanSchema.optional() } : {}),
  }).superRefine((args, issue) => {
    if (args.historyToolCallId !== undefined) {
      if (Object.keys(args).length !== 1) issue.addIssue({ code: "custom", message: "Historical retrieval accepts only historyToolCallId; it never acts on a browser." });
    } else {
      const { historyToolCallId: _history, ...current } = args;
      const { decisionPlan: _plan, ...command } = current as Record<string, unknown>;
      const parsed = controlConnectedWebOperationToolSchema.safeParse(command);
      if (!parsed.success) for (const error of parsed.error.issues) issue.addIssue({ ...error });
    }
  });
  return new DynamicStructuredTool({
    name: "control_connected_web_operation",
    description: "Control an already-taken-over connected website operation using a semantic command. Reuse the operation id and current control epoch from operation management. Preserve its original scope: read operations remain reads; run_website_task allows actions within the user's request without repeated approval. Pause for dangerous, irreversible, ambiguous or out-of-scope actions. After takeover or an uncertain response, inspect saved state before acting; never repeat a potentially completed change blindly. This is server direct control, not a local browser_* tool. It cannot use browser coordinates, screenshots, files, tabs, frames, dialogs, cookies, storage, JavaScript evaluation, or generic arguments. " +
      "Use historyToolCallId alone to retrieve exact retained historical browser evidence; historical references cannot authorize actions. " +
      (model ? `PREFERRED ROUTE: ${model.displayName} is available now. Favor delegation for routine work. Send command:{kind:'snapshot'} with decisionPlan as a standalone call for a complete coherent segment. Supply the goal, constraints and exact named values; omit actions for fresh click discovery, or include click_observed plus reusable keyboard, scroll, select or other action templates. The same operation permissions and current control epoch govern every action. You verify completion, diagnose errors or new strategy, then delegate the remaining segment again. Never guess success predicates or page labels. ` : ""),
    schema,
    func: async (args) => args.historyToolCallId !== undefined
      ? readBrowserHistory(context?.browserHistoryMessages ?? [], args.historyToolCallId)
        ?? JSON.stringify({ ok: false, code: "history_unavailable", detail: "No unique retained browser observation exists for that tool-call ID in this conversation." })
      : dispatchControlConnectedWebOperation({ ...controlConnectedWebOperationToolSchema.parse({
          operationId: args.operationId, expectedControlEpoch: args.expectedControlEpoch, command: args.command,
        }), ...("decisionPlan" in args ? { decisionPlan: args.decisionPlan } : {}) }, context),
  });
}
