import type { ThreadMessageLike } from "@assistant-ui/react";
import type { JobStatus } from "@nautilo/types";
import type { ToolActivityEvent } from "./runtime-contexts";

export interface ToolJobIdentity {
  jobId: string;
  roomId: string;
  turnId?: string;
  authorAgentId?: string;
}

export interface ToolTerminalJob extends ToolJobIdentity {
  status: Extract<JobStatus, "completed" | "failed" | "timed_out" | "cancelled">;
}

export type ToolLifecycleCandidates = ReadonlyMap<string, ToolActivityEvent>;

/** A delayed Job read may settle only the exact activity object it observed. */
export function isSameToolLifecycleCandidate(
  toolCallId: string,
  activity: ToolActivityEvent,
  candidates: ToolLifecycleCandidates | undefined,
): boolean {
  return candidates === undefined || candidates.get(toolCallId) === activity;
}

/**
 * Bind display state only when the Job proves the same Room, turn, and known
 * Agent. A modern tool event with a turn id never falls back to an unrelated
 * unique Room job merely because that is the only job the client can see.
 */
export function bindRunningToolActivityToJob(
  activity: ToolActivityEvent,
  activityRoomId: string | null,
  job: ToolJobIdentity,
): ToolActivityEvent {
  if (activity.status !== "running" || activityRoomId !== job.roomId) return activity;
  if (activity.jobId !== undefined) return activity;
  // Room proximity is never sufficient, even if only one job is currently
  // visible there. Both modern identities must be present and equal.
  if (activity.turnId === undefined || job.turnId !== activity.turnId) return activity;
  if (activity.authorAgentId !== job.authorAgentId) return activity;
  return { ...activity, jobId: job.jobId };
}

export function missingToolReceiptMessage(status: ToolTerminalJob["status"]): string {
  switch (status) {
    case "failed":
      return "Tool outcome unavailable: the turn failed before a final tool receipt arrived.";
    case "timed_out":
      return "Tool outcome unavailable: the turn timed out before a final tool receipt arrived.";
    case "cancelled":
      return "Tool outcome unavailable: the turn was stopped before a final tool receipt arrived.";
    case "completed":
      return "Tool outcome unavailable: the turn completed without a final tool receipt.";
  }
}

/** A terminal Job is a backstop only; a canonical tool.end always wins later. */
export function finalizeRunningToolActivityWithoutReceipt(
  activity: ToolActivityEvent,
  activityRoomId: string | null,
  job: ToolTerminalJob,
  endedAt: number,
): ToolActivityEvent {
  if (activityRoomId !== job.roomId) return activity;
  const bound = activity.jobId === job.jobId
    ? activity
    : bindRunningToolActivityToJob(activity, activityRoomId, job);
  if (bound.status !== "running" || bound.jobId !== job.jobId) return activity;
  return {
    ...bound,
    status: "error",
    endedAt,
    error: missingToolReceiptMessage(job.status),
    runShellProgress: undefined,
    structuredSshProgress: undefined,
    browserResearchIntervention: undefined,
    connectedWebActionAttention: undefined,
    connectedWebActionResumeFailed: undefined,
  };
}

export interface CanonicalToolEndProjection {
  status: "success" | "error";
  endedAt: number;
  error?: string;
  result?: string;
  resultTruncated?: boolean;
}

/** Canonical tool.end replaces every conservative missing-receipt fallback. */
export function applyCanonicalToolEndToActivity(
  activity: ToolActivityEvent,
  event: CanonicalToolEndProjection,
): ToolActivityEvent {
  const {
    runShellContinuity: _runShellContinuity,
    runShellContinuityChangedAt: _runShellContinuityChangedAt,
    ...base
  } = activity as ToolActivityEvent & {
    runShellContinuity?: unknown;
    runShellContinuityChangedAt?: unknown;
  };
  return {
    ...base,
    status: event.status === "error" ? "error" : "ok",
    endedAt: event.endedAt,
    error: event.status === "error" ? (event.error ?? "unknown") : undefined,
    runShellProgress: undefined,
    structuredSshProgress: undefined,
    browserResearchIntervention: undefined,
    connectedWebActionAttention: undefined,
    connectedWebActionResumeFailed: undefined,
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.resultTruncated === true ? { resultTruncated: true } : {}),
  };
}

type ThreadMessagePart = Exclude<ThreadMessageLike["content"], string> extends
  readonly (infer Part)[] ? Part : never;
type ToolCallPart = Extract<ThreadMessagePart, { readonly type: "tool-call" }>;

function pendingToolCallPart(message: ThreadMessageLike): ToolCallPart | null {
  if (!Array.isArray(message.content) || message.content.length !== 1) return null;
  const candidate = message.content[0] as unknown;
  if (!candidate || typeof candidate !== "object") return null;
  const part = candidate as Partial<ToolCallPart>;
  return part.type === "tool-call" && typeof part.toolCallId === "string" &&
      typeof part.toolName === "string" &&
      part.result === undefined
    ? part as ToolCallPart
    : null;
}

/** Finalize only exact pending transcript cards; never overwrite a receipt. */
export function finalizeToolCallMessagesWithoutReceipt(
  messages: readonly ThreadMessageLike[],
  toolCallIds: ReadonlySet<string>,
  result: string,
): ThreadMessageLike[] | readonly ThreadMessageLike[] {
  let changed = false;
  const next = messages.map((message) => {
    const part = pendingToolCallPart(message);
    if (part === null || !toolCallIds.has(part.toolCallId!)) return message;
    changed = true;
    return {
      ...message,
      content: [{ ...part, result, isError: true }],
    } satisfies ThreadMessageLike;
  });
  return changed ? next : messages;
}
