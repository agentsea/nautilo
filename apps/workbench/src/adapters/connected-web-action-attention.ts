/**
 * Owner-private authentication attention for one already-running connected
 * website action. This deliberately carries no provider browser/profile/run
 * coordinates and is only attached to its exact tool delivery.
 */

export type ConnectedWebActionAttentionIntervention = Readonly<
  | {
      kind: "authentication_required";
      mode: "connect";
      reason: "not_connected";
      target: Readonly<{ selector: string }>;
    }
  | {
      kind: "authentication_required";
      mode: "reconnect";
      reason: "reconnect" | "sign_in" | "mfa" | "captcha";
      account: Readonly<{ id: string; label: string; service: string; origin: string }>;
    }
>;

export type ConnectedWebActionAttention = Readonly<{
  type: "connected_web.action_attention";
  threadId: string;
  laneKey: string;
  toolCallId: string;
  intervention: ConnectedWebActionAttentionIntervention;
  /** Local monotonically increasing receipt, solely for repeated prompts. */
  revision: number;
}>;

export type ConnectedWebActionResumeFailed = Readonly<{
  type: "connected_web.action_resume_failed";
  threadId: string;
  laneKey: string;
  toolCallId: string;
  cancelRecovery: "available" | "unavailable";
}>;

type WireAttention = Omit<ConnectedWebActionAttention, "revision">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function origin(value: unknown): value is string {
  if (!text(value, 2_048)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      && parsed.origin === value;
  } catch {
    return false;
  }
}

function intervention(value: unknown): ConnectedWebActionAttentionIntervention | null {
  if (!record(value) || value["kind"] !== "authentication_required") return null;
  if (value["mode"] === "connect") {
    if (!exact(value, ["kind", "mode", "reason", "target"]) || value["reason"] !== "not_connected"
      || !record(value["target"]) || !exact(value["target"], ["selector"])
      || !text(value["target"]["selector"], 2_048)) return null;
    return { kind: "authentication_required", mode: "connect", reason: "not_connected", target: { selector: value["target"]["selector"] } };
  }
  if (value["mode"] !== "reconnect" || !exact(value, ["kind", "mode", "reason", "account"])
    || !["reconnect", "sign_in", "mfa", "captcha"].includes(String(value["reason"]))
    || !record(value["account"]) || !exact(value["account"], ["id", "label", "service", "origin"])) return null;
  const account = value["account"];
  if (!text(account["id"], 64) || !UUID.test(account["id"])
    || !text(account["label"], 256) || !text(account["service"], 128) || !origin(account["origin"])) return null;
  return {
    kind: "authentication_required", mode: "reconnect",
    reason: value["reason"] as "reconnect" | "sign_in" | "mfa" | "captcha",
    account: { id: account["id"], label: account["label"], service: account["service"], origin: account["origin"] },
  };
}

/** Parse the owner-private WS event; unexpected fields or another owner fail closed. */
export function parseConnectedWebActionAttention(
  value: unknown,
  revision: number,
  expectedUserId: string,
): ConnectedWebActionAttention | null {
  if (!record(value) || !exact(value, ["type", "threadId", "laneKey", "toolCallId", "userId", "intervention"])
    || value["type"] !== "connected_web.action_attention"
    || value["userId"] !== expectedUserId || !text(expectedUserId, 256)
    || !text(value["threadId"], 256) || !text(value["laneKey"], 512) || !text(value["toolCallId"], 512)) return null;
  const parsed = intervention(value["intervention"]);
  if (!parsed) return null;
  return {
    type: "connected_web.action_attention",
    threadId: value["threadId"], laneKey: value["laneKey"], toolCallId: value["toolCallId"], intervention: parsed, revision,
  };
}

export function connectedWebActionAttentionKey(value: Pick<WireAttention, "threadId" | "laneKey" | "toolCallId">): string {
  return `${value.threadId}\0${value.laneKey}\0${value.toolCallId}`;
}

/** Parse only the safe requester-private coordinates of a failed resume. */
export function parseConnectedWebActionResumeFailed(
  value: unknown,
  expectedUserId: string,
): ConnectedWebActionResumeFailed | null {
  if (!record(value) || !exact(value, ["type", "threadId", "laneKey", "toolCallId", "userId", "cancelRecovery"])
    || value["type"] !== "connected_web.action_resume_failed"
    || (value["cancelRecovery"] !== "available" && value["cancelRecovery"] !== "unavailable")
    || value["userId"] !== expectedUserId || !text(expectedUserId, 256)
    || !text(value["threadId"], 256) || !text(value["laneKey"], 512) || !text(value["toolCallId"], 512)) return null;
  return {
    type: "connected_web.action_resume_failed",
    threadId: value["threadId"],
    laneKey: value["laneKey"],
    toolCallId: value["toolCallId"],
    cancelRecovery: value["cancelRecovery"],
  };
}

/**
 * Resolve an early attention event when its matching tool.start arrives. A
 * duplicated tool id in another thread is deliberately ambiguous and ignored.
 */
export function pendingAttentionForToolStart(
  pending: Iterable<ConnectedWebActionAttention>,
  toolName: string,
  laneKey: string | undefined,
  toolCallId: string,
): ConnectedWebActionAttention | undefined {
  if (toolName !== "act_connected_web_account" || laneKey === undefined) return undefined;
  let match: ConnectedWebActionAttention | undefined;
  for (const attention of pending) {
    if (attention.laneKey !== laneKey || attention.toolCallId !== toolCallId) continue;
    if (match !== undefined && match.threadId !== attention.threadId) return undefined;
    if (match === undefined || attention.revision > match.revision) match = attention;
  }
  return match;
}

/**
 * An attention event is a one-shot bridge to its matching running card. Once
 * attached, remove it so LangGraph replay of the same tool call cannot revive
 * an already-answered sign-in prompt.
 */
export function consumePendingAttentionForToolStart(
  pending: Map<string, ConnectedWebActionAttention>,
  toolName: string,
  laneKey: string | undefined,
  toolCallId: string,
): ConnectedWebActionAttention | undefined {
  const match = pendingAttentionForToolStart(pending.values(), toolName, laneKey, toolCallId);
  if (match) pending.delete(connectedWebActionAttentionKey(match));
  return match;
}
