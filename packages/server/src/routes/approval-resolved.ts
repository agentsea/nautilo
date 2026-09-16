import type {
  ApprovalReplyVerb,
  ApprovalResolvedEvent,
  ServerEvent,
} from "@nautilo/types";

export type ApprovalResolutionAttempt =
  | { readonly kind: "started"; readonly token: symbol }
  | { readonly kind: "duplicate" }
  | { readonly kind: "conflict" };

interface ApprovalResolutionRecord {
  readonly fingerprint: string;
  readonly token: symbol;
  state: "resolving" | "resolved";
}

export interface ApprovalResolutionContext {
  readonly approvalId: string;
  readonly threadId: string;
  readonly laneKey?: string | undefined;
  readonly userId: string;
  readonly verb: ApprovalReplyVerb;
  readonly taskId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly origin?: "task" | undefined;
}

export interface ApprovalResolutionCoordinator {
  begin(context: ApprovalResolutionContext): ApprovalResolutionAttempt;
  complete(
    context: ApprovalResolutionContext,
    token: symbol,
  ): ApprovalResolvedEvent | null;
  fail(context: ApprovalResolutionContext, token: symbol): void;
}

function approvalResolutionKey(context: ApprovalResolutionContext): string {
  return `${context.userId}:${context.approvalId}`;
}

function approvalResolutionFingerprint(
  context: ApprovalResolutionContext,
): string {
  return JSON.stringify({
    threadId: context.threadId,
    laneKey: context.laneKey ?? null,
    verb: context.verb,
    taskId: context.taskId ?? null,
    taskRunId: context.taskRunId ?? null,
    origin: context.origin ?? null,
  });
}

function resolutionFromVerb(
  verb: ApprovalReplyVerb,
): ApprovalResolvedEvent["resolution"] {
  return verb === "deny" ? "denied" : "approved";
}

/**
 * ISSUE-D440 authoritative approval terminal producer.
 *
 * `begin` reserves one requester-scoped approval id before async resume work.
 * Same-decision retries are suppressed while resolving and after resolution;
 * a different decision reusing the id is rejected as a conflict. `complete`
 * marks the id terminal before emitting, so a re-entrant/duplicate completion
 * cannot emit twice. `fail` releases only the matching in-flight token so a
 * failed resume may be retried safely.
 *
 * The record is process-local because the durable authority remains the graph
 * checkpoint/task run. Events are emitted only after those canonical resume
 * paths settle successfully; client reducers are independently idempotent.
 */
export function createApprovalResolutionCoordinator(
  emit: (event: ServerEvent) => void,
): ApprovalResolutionCoordinator {
  const records = new Map<string, ApprovalResolutionRecord>();

  return {
    begin(context) {
      const key = approvalResolutionKey(context);
      const fingerprint = approvalResolutionFingerprint(context);
      const existing = records.get(key);
      if (existing) {
        return existing.fingerprint === fingerprint
          ? { kind: "duplicate" }
          : { kind: "conflict" };
      }

      const token = Symbol(key);
      records.set(key, {
        fingerprint,
        token,
        state: "resolving",
      });
      return { kind: "started", token };
    },

    complete(context, token) {
      const key = approvalResolutionKey(context);
      const record = records.get(key);
      if (
        !record ||
        record.token !== token ||
        record.state !== "resolving"
      ) {
        return null;
      }

      // Terminalize before emit: duplicate/re-entrant completion cannot emit.
      record.state = "resolved";
      const event: ApprovalResolvedEvent = {
        type: "approval.resolved",
        approvalId: context.approvalId,
        threadId: context.threadId,
        userId: context.userId,
        resolution: resolutionFromVerb(context.verb),
        verb: context.verb,
        ...(context.laneKey ? { laneKey: context.laneKey } : {}),
        ...(context.taskId ? { taskId: context.taskId } : {}),
        ...(context.taskRunId ? { taskRunId: context.taskRunId } : {}),
        ...(context.origin ? { origin: context.origin } : {}),
      };
      emit(event);
      return event;
    },

    fail(context, token) {
      const key = approvalResolutionKey(context);
      const record = records.get(key);
      if (
        record &&
        record.token === token &&
        record.state === "resolving"
      ) {
        records.delete(key);
      }
    },
  };
}
