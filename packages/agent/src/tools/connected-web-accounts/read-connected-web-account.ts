import { DynamicStructuredTool } from "@langchain/core/tools";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { z } from "zod";
import {
  getConnectedWebAccountReadToolRuntime,
  type ConnectedWebAccountCapability,
  type ConnectedWebAccountReadResult,
  type ConnectedWebAccountReadToolActorContext,
} from "./runtime";

/** Admits the complete connected-account origin form as well as shorter labels and ids. */
export const CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS = 2_048;
/** Matches the established foreground task prompt boundary. */
export const CONNECTED_WEB_ACCOUNT_READ_REQUEST_MAX_CHARS = 4_096;
/** Matches the existing compact server-tool JSON projection boundary. */
export const CONNECTED_WEB_ACCOUNT_READ_MODEL_RESULT_MAX_JSON_CHARS = 16_000;
/** Keep private-artifact receipts small enough for the bounded projection. */
const CONNECTED_WEB_ACCOUNT_READ_MODEL_OUTPUT_MAX_COUNT = 4;
const CONNECTED_WEB_OPERATION_SAFE_CODE_MAX_CHARS = 128;
const CONNECTED_WEB_OPERATION_SAFE_SUMMARY_MAX_CHARS = 512;

export const connectedWebAccountReadToolSchema = z.object({
  account: z.string().trim().min(1).max(CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS).describe("One of the connected website labels, site/service names, origins, or exact account ids from your current capability context. A unique parent/subdomain site match is accepted; ambiguous selectors are returned for clarification."),
  request: z.string().trim().min(1).max(CONNECTED_WEB_ACCOUNT_READ_REQUEST_MAX_CHARS).describe("Plain-language information to read from that one connected account."),
  delivery: z.enum(["text", "workspace"]).default("text").describe("Choose workspace only when the Human explicitly asked to download, save, or capture a file or image; otherwise use text."),
});

/** Callers may omit delivery; the model schema and dispatcher default it to text. */
export type ConnectedWebAccountReadToolArgs = z.input<typeof connectedWebAccountReadToolSchema>;

type ConnectedWebAccountReadContinuation = Readonly<{
  account: string;
  request: string;
  delivery: "text" | "workspace";
}>;

export interface ConnectedWebAccountReadToolContext {
  readonly voiceMode?: boolean | undefined;
  /** Authenticated user id from the current Genie invocation. */
  readonly userId?: string | undefined;
  /** Current Genie id from the current Genie invocation. */
  readonly agentId?: string | undefined;
  /** Current foreground Room; this is required for personal-account authority. */
  readonly roomId?: string | undefined;
  /** Non-empty task/subagent calling Room is preserved for server-side rejection. */
  readonly callingRoomId?: string | null | undefined;
  readonly memoryAccessEnvelope?: MemoryAccessEnvelope | undefined;
  /** Trusted invocation identity injected by the tools node, never model input. */
  readonly toolCallId?: string | undefined;
  readonly currentThreadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly laneKey?: string | undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeOperationText(value: unknown, maximum: number): string | null {
  const text = nonEmptyString(value);
  return text !== null && text.length <= maximum && !/[\r\n]/u.test(text)
    && !/\b(?:https?|wss?|cdp):\/\/|\b(?:cookie|authorization|bearer)\b/iu.test(text)
    ? text
    : null;
}

/** Do not fall back to Room, Namespace, or legacy connection-vault scope. */
export function resolveConnectedWebAccountReadActor(
  context?: ConnectedWebAccountReadToolContext,
): ConnectedWebAccountReadToolActorContext | null {
  const userId = nonEmptyString(context?.userId);
  const agentId = nonEmptyString(context?.agentId);
  const roomId = nonEmptyString(context?.roomId);
  const callingRoomId = nonEmptyString(context?.callingRoomId);
  return userId && agentId && roomId && context?.memoryAccessEnvelope
    ? {
      userId,
      agentId,
      roomId,
      callingRoomId,
      memoryAccessEnvelope: context.memoryAccessEnvelope,
      ...(typeof context.voiceMode === "boolean" ? { voiceMode: context.voiceMode } : {}),
      ...(nonEmptyString(context?.toolCallId) === null ? {} : { toolCallId: nonEmptyString(context?.toolCallId)! }),
      ...(nonEmptyString(context?.currentThreadId) === null ? {} : { currentThreadId: nonEmptyString(context?.currentThreadId)! }),
      ...(nonEmptyString(context?.turnId) === null ? {} : { turnId: nonEmptyString(context?.turnId)! }),
      ...(nonEmptyString(context?.laneKey) === null ? {} : { laneKey: nonEmptyString(context?.laneKey)! }),
    }
    : null;
}

/**
 * Per-turn prompt projection for an already-authorized owned Genie. The
 * server runtime performs the same authority checks as execution and returns
 * no provider/browser coordinate.
 */
export async function listConnectedWebAccountCapabilities(
  context?: ConnectedWebAccountReadToolContext,
): Promise<readonly ConnectedWebAccountCapability[]> {
  const actor = resolveConnectedWebAccountReadActor(context);
  if (actor === null) return [];
  const runtime = getConnectedWebAccountReadToolRuntime();
  if (runtime?.listAvailable === undefined) return [];
  try {
    return await runtime.listAvailable(actor);
  } catch {
    return [];
  }
}

/**
 * Projects a typed server result rather than serializing an upstream object.
 * This is intentional: a future server implementation cannot leak a profile,
 * browser, run, live-view, or provider field merely by adding it to its own
 * internal result object.
 */
export function projectConnectedWebAccountReadResult(
  result: ConnectedWebAccountReadResult,
  continuation?: ConnectedWebAccountReadContinuation,
): string {
  if (!result.ok) {
    if (result.code === "authentication_required") {
      const intervention = result.intervention;
      if (!intervention || intervention.kind !== "authentication_required"
        || !continuation
        || !nonEmptyString(continuation.account)
        || continuation.account.length > CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS
        || !nonEmptyString(continuation.request)
        || (continuation.delivery !== "text" && continuation.delivery !== "workspace")) {
        return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
      }
      const sealedContinuation = {
        account: continuation.account,
        request: continuation.request,
        delivery: continuation.delivery,
      };
      if (intervention.mode === "connect") {
        const selector = nonEmptyString(intervention.target.selector);
        if (!selector || selector.length > CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS
          || intervention.reason !== "not_connected" || result.recovery !== "connect") {
          return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
        }
        return JSON.stringify({
          ok: false,
          code: "authentication_required",
          recovery: "connect",
          intervention: {
            kind: "authentication_required",
            mode: "connect",
            reason: "not_connected",
            target: { selector },
          },
          continuation: sealedContinuation,
        });
      }
      const allowedReasons = new Set(["reconnect", "sign_in", "mfa", "captcha"]);
      const account = intervention.account;
      if (result.recovery !== "reconnect" || !allowedReasons.has(intervention.reason)
        || !nonEmptyString(account.id) || !nonEmptyString(account.label)
        || !nonEmptyString(account.service) || !nonEmptyString(account.origin)) {
        return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
      }
      return JSON.stringify({
        ok: false,
        code: "authentication_required",
        recovery: "reconnect",
        intervention: {
          kind: "authentication_required",
          mode: "reconnect",
          reason: intervention.reason,
          account: {
            id: account.id,
            label: account.label,
            service: account.service,
            origin: account.origin,
          },
        },
        continuation: sealedContinuation,
      });
    }
    return JSON.stringify({
      ok: false,
      code: result.code,
      recovery: result.recovery,
    });
  }

  try {
    if (result.status === "active") {
      if (!nonEmptyString(result.account.id) || !nonEmptyString(result.account.label)
        || !nonEmptyString(result.account.service) || !nonEmptyString(result.account.origin)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result.operation.operationId)
        || result.operation.driver !== "hosted" || result.operation.lifecycle !== "running"
        || !Number.isSafeInteger(result.operation.controlEpoch) || result.operation.controlEpoch < 1
        || result.operation.receipt !== null
        || !(["starting", "working", "checking", "attention", "finishing"] as const).includes(result.operation.activity.phase)
        || safeOperationText(result.operation.activity.code, CONNECTED_WEB_OPERATION_SAFE_CODE_MAX_CHARS) === null
        || safeOperationText(result.operation.activity.summary, CONNECTED_WEB_OPERATION_SAFE_SUMMARY_MAX_CHARS) === null) {
        return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
      }
      return JSON.stringify({
        ok: true,
        status: "active",
        account: {
          id: result.account.id,
          label: result.account.label,
          service: result.account.service,
          origin: result.account.origin,
        },
        operation: {
          operationId: result.operation.operationId,
          driver: "hosted",
          lifecycle: "running",
          controlEpoch: result.operation.controlEpoch,
          activity: {
            phase: result.operation.activity.phase,
            code: safeOperationText(result.operation.activity.code, CONNECTED_WEB_OPERATION_SAFE_CODE_MAX_CHARS)!,
            summary: safeOperationText(result.operation.activity.summary, CONNECTED_WEB_OPERATION_SAFE_SUMMARY_MAX_CHARS)!,
          },
          receipt: null,
        },
      });
    }
    if (result.page.ref !== result.account.id || result.page.title !== result.account.label
      || result.page.origin !== result.account.origin || typeof result.outputsTruncated !== "boolean"
      || result.outputs.length > CONNECTED_WEB_ACCOUNT_READ_MODEL_OUTPUT_MAX_COUNT
      || result.outputs.some((output) => output.artifactId.length === 0
        || output.path.length === 0 || output.path.length > 512 || output.path.includes("://")
        || output.mime.length === 0 || output.mime.length > 128
        || !Number.isSafeInteger(output.bytes) || output.bytes < 0)) {
      return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
    }
    const projectedValue = {
      ok: true,
      status: "completed" as const,
      account: {
        id: result.account.id,
        label: result.account.label,
        service: result.account.service,
        origin: result.account.origin,
      },
      page: {
        ref: result.page.ref,
        title: result.page.title,
        origin: result.page.origin,
      },
      read: result.read === null ? null : {
        answer: result.read.answer,
        facts: result.read.facts.map((fact) => ({ label: fact.label, value: fact.value })),
        completeness: result.read.completeness,
        provenance: result.read.provenance,
        origin: result.read.origin,
      },
      cost: {
        currency: result.cost.currency,
        amountUsd: result.cost.amountUsd,
        state: result.cost.state,
      },
      outputs: result.outputs.map((output) => ({
        artifactId: output.artifactId,
        path: output.path,
        mime: output.mime,
        bytes: output.bytes,
      })),
      outputsTruncated: result.outputsTruncated,
    };
    const projected = JSON.stringify(projectedValue);
    if (projected.length <= CONNECTED_WEB_ACCOUNT_READ_MODEL_RESULT_MAX_JSON_CHARS) return projected;

    // The browser run still completed. Drop only the oversized untrusted read
    // projection; never rewrite provider completion as a failed browser run.
    return JSON.stringify({ ...projectedValue, read: null });
  } catch {
    return JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
  }
}

export async function dispatchConnectedWebAccountRead(
  args: ConnectedWebAccountReadToolArgs,
  context?: ConnectedWebAccountReadToolContext,
): Promise<string> {
  const actor = resolveConnectedWebAccountReadActor(context);
  if (!actor) {
    return JSON.stringify({
      ok: false,
      code: "unavailable",
      recovery: "none",
    });
  }

  const runtime = getConnectedWebAccountReadToolRuntime();
  if (!runtime) {
    return JSON.stringify({
      ok: false,
      code: "unavailable",
      recovery: "none",
    });
  }

  try {
    const input = {
      account: args.account,
      request: args.request,
      delivery: args.delivery ?? "text",
    } as const;
    return projectConnectedWebAccountReadResult(await runtime.read(actor, input), input);
  } catch {
    // Upstream/provider details are never agent-visible. The server has its
    // own redacted operational logs and can return a more precise typed state.
    return JSON.stringify({
      ok: false,
      code: "provider_unavailable",
      recovery: "none",
    });
  }
}

export function createConnectedWebAccountReadTool(context?: ConnectedWebAccountReadToolContext) {
  return new DynamicStructuredTool({
    name: "read_connected_web_account",
    description: "Read information from one of the user's connected website accounts through its protected Browser Use profile. When the current capability context lists a matching connected website—or the Human says they already connected or logged in—use that label, site/service name, or origin directly; do not search the public web to rediscover it and do not substitute the embedded browser. For a genuinely first-use arbitrary site only, resolve its canonical public http(s) URL anonymously and pass that verified URL as account. It reads and may save an explicitly requested file or image into the private Workspace; choose workspace only for that Human request. If multiple real accounts match, ask the Human which account. When the typed result says authentication_required, let Nautilo present the protected sign-in intervention, wait for Done, then retry the exact original request once. Do not automatically repeat a failed, cancelled, unavailable, or invalid-result run; explain the failure and wait for the Human. Never ask for passwords, MFA codes, passkeys, cookies, or CAPTCHA answers in chat, and never construct or request a provider live-view URL.",
    schema: connectedWebAccountReadToolSchema,
    func: async (args) => dispatchConnectedWebAccountRead(args, context),
  });
}
