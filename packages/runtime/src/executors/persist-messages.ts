import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import {
  logicalMessageKey,
  type AdvancedVideoWorkcardContinuation,
  type MessageArtifactOpenRef,
  type ServerEvent,
} from "@nautilo/types";
import { appendTranscriptMessages, computeMessageFingerprint } from "@nautilo/agent";
import type { AppendNotificationContext } from "@nautilo/trust";
import {
  type MemoryReviewAdmission,
  findArtifactInternalIdsForCanonicalNamespace,
  getRoomNamespaceId,
  hydrateMessageArtifacts,
  recordMessageArtifacts,
  stampTurnIdOnAttachments,
} from "@nautilo/db";
import { log, warn } from "@nautilo/logger";
import { notifyForegroundTurnLifecycle } from "../foreground-turn-lifecycle";
import {
  notifyDurableToolResultLifecycle,
  type DurableToolExecutionEntrypoint,
} from "../durable-tool-result-lifecycle";

function isReasoningContentBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const t = (block as Record<string, unknown>)["type"];
  return t === "reasoning" || t === "redacted_thinking" || t === "thinking";
}

/** Strip reasoning blocks before transcript persistence (not LangGraph checkpoint). */
export function sanitizeMessageForTranscript(message: BaseMessage): BaseMessage {
  if (!AIMessage.isInstance(message)) return message;
  if (typeof message.content === "string") return message;
  if (!Array.isArray(message.content)) return message;
  const filtered = message.content.filter((block) => !isReasoningContentBlock(block));
  if (filtered.length === message.content.length) return message;
  const content = filtered.length > 0 ? filtered : "";
  const sanitized = new AIMessage({ content });
  if (message.tool_calls?.length) {
    sanitized.tool_calls = message.tool_calls;
  }
  return sanitized;
}

function persistDebugRole(msg: BaseMessage): string {
  if (msg instanceof HumanMessage) return "user";
  if (msg instanceof ToolMessage) return "tool";
  if (AIMessage.isInstance(msg)) return "assistant";
  return "other";
}

export interface PersistMessagesOptions {
  memoryReview?: MemoryReviewAdmission;
  agentId?: string;
  roomId?: string;
  /**
   * D426 — the child Room that owns this persisted row. When present, the
   * agent store stamps every inserted row with this id and transactionally
   * refreshes the parent anchor's authoritative thread summary. This is
   * deliberately distinct from `roomId`: callers must pass the canonical
   * Subthread Room id only, never the parent Room id.
   */
  subthreadRoomId?: string;
  humanTurnId?: string;
  /** D521 — identity shared with the streamed visible assistant bubble. */
  assistantMessageKey?: string;
  /** Server/runtime-stamped provenance; absent/unknown stays fail-closed. */
  trustedExecutionEntrypoint?: DurableToolExecutionEntrypoint;
  /** M233 — explicit per-append notification facts; never inferred here. */
  notificationContext?: AppendNotificationContext;
  /** D124 — room-scoped WS lane (`room:<uuid>`); required to fan out `message.new` for user rows. */
  laneKey?: string;
  eventBus: { emit(event: ServerEvent): void };
  /**
   * M143 — per-row `session_messages.metadata`. Set ONLY on a single-message
   * persist (the Task report-back synthetic human input row) — it is applied
   * to every row in this call.
   */
  metadata?: Record<string, unknown>;
  /** Internal supervision tags tool plumbing only; a deliberate answer stays visible. */
  internalToolMetadata?: Record<string, unknown>;
  /**
   * M143 — when true, do NOT emit `message.new` for `user` rows inserted by
   * this call. The Task report-back synthetic input row is hidden from chat
   * render; emitting `message.new` would leak it onto live WS clients even
   * though the DB read filters hide it on reload.
   */
  suppressUserMessageEvents?: boolean;
  /**
   * D391 — retained attachment ids uploaded with this (human) turn. When set
   * and a human row is persisted, stamp `turn_id` (= that row's M134
   * fingerprint) on these attachments so they render from room history. Passed
   * ONLY on the human persist call. Best-effort: a stamp failure just means the
   * image won't render from history, never a turn failure.
   */
  retainedAttachmentIds?: readonly string[];
  /**
   * D424 — ArtifactOpenCard authoring for the human row persisted by this
   * call. External workspace-artifact ids (legacy `artifactRefs` +
   * `focusedResources` kind `workspace-artifact`) that may become cards.
   * Resolved to internal `artifacts.id` gated on the canonical room namespace
   * (`options.roomId`'s `rooms.namespace_id`), recorded as a durable
   * pointer-only relation, and hydrated onto the user `message.new` event.
   * Best-effort: a failure never blocks the turn. Assistant/tool rows never
   * author cards. Passed ONLY on the human persist call.
   */
  messageArtifactExternalIds?: readonly string[];
}

function advancedVideoWorkcardContinuation(
  metadata: Record<string, unknown> | undefined,
): AdvancedVideoWorkcardContinuation | undefined {
  if (metadata?.["originatedBy"] !== "advanced_video_workcard") return undefined;
  const referenceCount = metadata["referenceCount"];
  if (!Number.isInteger(referenceCount) || typeof referenceCount !== "number" || referenceCount < 1 || referenceCount > 30) {
    return undefined;
  }
  return { kind: "advanced_video", referenceCount };
}

export function classifyDbError(error: unknown): string {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  for (let i = 0; i < 8 && cur !== undefined && cur !== null && !seen.has(cur); i++) {
    seen.add(cur);
    if (typeof cur === "object" && "code" in cur) {
      const c = (cur as { code: unknown }).code;
      if (typeof c === "string") {
        if (c === "23503") return "fk_violation";
        if (c === "23505") return "unique_violation";
        if (c === "57014") return "timeout";
        if (c === "40P01") return "deadlock";
      }
    }
    const next =
      typeof cur === "object" && cur !== null && "cause" in cur
        ? (cur as { cause: unknown }).cause
        : undefined;
    cur = next;
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/code:\s*23503|23503|violates foreign key constraint/i.test(text)) return "fk_violation";
  if (/23505|unique constraint/i.test(text)) return "unique_violation";
  return "unknown";
}

export async function persistMessages(
  threadId: string,
  ownerId: string,
  messages: BaseMessage[],
  savedFingerprints: Set<string>,
  options: PersistMessagesOptions,
): Promise<void> {
  const newPairs: Array<{ msg: BaseMessage; fp: string }> = [];
  for (const msg of messages) {
    // M135 P6 — transient room-context blocks are injected into the woken
    // bot's LLM turn + checkpoint (for the re-wake "seen" set) but must NEVER
    // reach the visible transcript. Skip them at the persistence boundary.
    if ((msg.additional_kwargs as { nautilo_transient_context?: unknown } | undefined)
        ?.nautilo_transient_context === true) {
      continue;
    }
    const fp = computeMessageFingerprint(
      msg,
      options.humanTurnId ? { humanTurnId: options.humanTurnId } : {},
    );
    if (savedFingerprints.has(fp)) continue;
    newPairs.push({ msg, fp });
  }
  const newMessages = newPairs.map((p) => p.msg);

  if (newMessages.length === 0) {
    // A replay/deduped direct Human input did not create a new canonical row.
    // It must not leave an already-armed exact-client candidate alive.
    if (options.humanTurnId && messages.some((message) => message instanceof HumanMessage)) {
      notifyForegroundTurnLifecycle({
        kind: "human_persist_failed",
        turnId: options.humanTurnId,
      });
    }
    return;
  }

  const transcriptMessages = newMessages.map(sanitizeMessageForTranscript);

  if (process.env["NAUTILO_DEBUG_PERSIST"] === "1") {
    const roles = newMessages.map((m) => persistDebugRole(m)).join(",");
    const fpPreview = newMessages
      .map((m) => computeMessageFingerprint(m, options.humanTurnId ? { humanTurnId: options.humanTurnId } : {}))
      .map((fp) => (fp.length > 72 ? `${fp.slice(0, 72)}…` : fp))
      .join(" | ");
    log(
      `[nautilo/persist] NAUTILO_DEBUG_PERSIST thread=${threadId} owner=${ownerId} count=${newMessages.length} roles=${roles} fp=${fpPreview}`,
    );
  }

  try {
    const result = await appendTranscriptMessages(threadId, ownerId, "owner", transcriptMessages, {
      ...(options.memoryReview ? { memoryReview: options.memoryReview } : {}),
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.roomId ? { roomId: options.roomId } : {}),
      ...(options.subthreadRoomId ? { subthreadRoomId: options.subthreadRoomId } : {}),
      ...(options.humanTurnId ? { humanTurnId: options.humanTurnId } : {}),
      ...(options.notificationContext
        ? { notificationContext: options.notificationContext }
        : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.internalToolMetadata ? { internalToolMetadata: options.internalToolMetadata } : {}),
    });

    // D426 — the store recomputed this snapshot in the append transaction.
    // Publish only after that transaction resolves, on the PARENT lane where
    // the anchor renders. This is intentionally unrelated to message.new, so
    // it cannot affect unread, conductor, prompt, or job state.
    if (result.rootSummary) {
      options.eventBus.emit({
        type: "thread.summary.changed",
        laneKey: `room:${result.rootSummary.parentRoomId}`,
        anchorMessageId: result.rootSummary.anchorMessageId,
        replyCount: result.rootSummary.replyCount,
        lastReplyAt: result.rootSummary.lastReplyAt?.toISOString() ?? null,
        summaryRevision: result.rootSummary.revision,
      });
    }

    // Partial failure: only mark successfully-inserted (or
    // successfully-deduped-against-existing) rows as "saved" in the
    // in-memory set. Rows that errored stay outside the set so the
    // next persist call in this turn gets a fresh attempt.
    const failed = new Set(result.failedIndices);
    for (let i = 0; i < newPairs.length; i++) {
      if (!failed.has(i)) savedFingerprints.add(newPairs[i]!.fp);
    }

    // D513 Phase 3.2 — this is the smallest durable boundary for a direct
    // Human turn: append has completed successfully and the Human row was not
    // one of a partial failure's rejected indices. This private notification
    // carries only the existing turn id; it is not a transcript field or a
    // ServerEvent. The server may match it to an already-coalescing-qualified
    // reservation, but cannot reconstruct eligibility from a Room or message.
    const attemptedHuman = newPairs.some((pair) => pair.msg instanceof HumanMessage);
    const insertedHuman = result.insertedRows.some((row) => row.role === "user");
    if (options.humanTurnId && attemptedHuman && insertedHuman) {
      notifyForegroundTurnLifecycle({
        kind: "human_persisted",
        turnId: options.humanTurnId,
      });
    } else if (options.humanTurnId && attemptedHuman) {
      // A partial append can be returned without throwing. Deduped/failed
      // Human rows are not a new direct foreground turn, so cancel any armed
      // exact-client candidate before this function returns.
      notifyForegroundTurnLifecycle({
        kind: "human_persist_failed",
        turnId: options.humanTurnId,
      });
    }

    // D513 Phase 3.3 — observe only a ToolMessage that this exact append
    // actually inserted. `insertedRows` is the durable store receipt; saved
    // fingerprints and a ToolMessage's content/name alone are insufficient
    // because replay/dedup must not regain automatic-presentation eligibility.
    const insertedFingerprints = new Set(
      result.insertedRows.flatMap((row) => row.fingerprint ? [row.fingerprint] : []),
    );
    for (const pair of newPairs) {
      if (!(pair.msg instanceof ToolMessage) || !insertedFingerprints.has(pair.fp)) continue;
      if (typeof pair.msg.name !== "string" || typeof pair.msg.content !== "string") continue;
      notifyDurableToolResultLifecycle({
        kind: "tool_result_persisted",
        toolName: pair.msg.name,
        content: pair.msg.content,
        fingerprint: pair.fp,
        trustedExecutionEntrypoint: options.trustedExecutionEntrypoint ?? null,
        turnId: options.humanTurnId ?? null,
      });
    }

    const laneKey = options.laneKey;
    // A tool-call AIMessage may contain narration even when token/tool streams
    // are quiet. Do not republish that internal audit row via message.new.
    const internalAssistantFingerprints = new Set(options.internalToolMetadata
      ? newPairs.flatMap(({ msg, fp }) => AIMessage.isInstance(msg) && msg.tool_calls?.length ? [fp] : [])
      : []);
    if (
      !options.suppressUserMessageEvents &&
      laneKey?.startsWith("room:") &&
      result.insertedRows.length > 0
    ) {
      const unavailableUserRow = result.insertedRows.find(
        (row) => row.role === "user" && row.content === null,
      );
      if (unavailableUserRow) {
        throw new Error(
          `Persisted user message ${unavailableUserRow.id} ordinary content is unavailable`,
        );
      }
      for (const row of result.insertedRows) {
        if (row.role === "user") {
          if (row.content === null) {
            throw new Error(
              `Persisted user message ${row.id} ordinary content is unavailable`,
            );
          }
          // D424 — author ArtifactOpenCards for the human row (best-effort,
          // gated on canonical-room-namespace attachment). Record the durable
          // relation, hydrate safe current metadata, and attach it to the
          // `message.new` event. Assistant/tool rows never author cards.
          let artifacts: MessageArtifactOpenRef[] | undefined;
          const externalIds = options.messageArtifactExternalIds;
          if (externalIds && externalIds.length > 0 && options.roomId) {
            const messageIdNum = Number(row.id);
            if (Number.isInteger(messageIdNum) && messageIdNum > 0) {
              const canonicalRoomNamespaceId = await getRoomNamespaceId(
                options.roomId,
              ).catch(() => null);
              if (canonicalRoomNamespaceId) {
                try {
                  const internalRows = await findArtifactInternalIdsForCanonicalNamespace({
                    externalArtifactIds: externalIds,
                    canonicalRoomNamespaceId,
                  });
                  if (internalRows.size > 0) {
                    const ordered: string[] = [];
                    for (const extId of externalIds) {
                      const internalId = internalRows.get(extId);
                      if (internalId && !ordered.includes(internalId)) {
                        ordered.push(internalId);
                      }
                    }
                    if (ordered.length > 0) {
                      await recordMessageArtifacts({
                        messageId: messageIdNum,
                        artifactInternalIds: ordered,
                      });
                      const hydrated = await hydrateMessageArtifacts({
                        messageIds: [messageIdNum],
                        canonicalRoomNamespaceId,
                        roomId: options.roomId,
                      });
                      const hydratedList = hydrated.get(messageIdNum);
                      if (hydratedList && hydratedList.length > 0) {
                        artifacts = hydratedList;
                      }
                    }
                  }
                } catch (e) {
                  warn(
                    `[nautilo/executor] D424 artifact card persist/hydrate failed: ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }
            }
          }
          const workcardContinuation = advancedVideoWorkcardContinuation(options.metadata);
          options.eventBus.emit({
            type: "message.new",
            laneKey,
            messageId: row.id,
            ...(row.createdAt ? { createdAt: row.createdAt } : {}),
            logicalMessageKey: logicalMessageKey(row),
            editRevision: 0,
            role: "user",
            content: row.content,
            sourceUserId: ownerId,
            senderUserId: ownerId,
            ...(typeof row.replyToMessageId === "number" &&
            Number.isInteger(row.replyToMessageId) &&
            row.replyToMessageId > 0
              ? { replyToMessageId: row.replyToMessageId }
              : {}),
            ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
            ...(workcardContinuation
              ? { workcardContinuation }
              : {}),
          });
        } else if (
          // M158 — the agent's visible reply must also emit `message.new` so the
          // server's unread recompute (`publishUnreadForNewMessage`) fires and
          // lights the dot for human recipients in a backgrounded room. Without
          // this, a 1:1 user↔agent reply never triggers an unread delta (the
          // user's own turn is excluded, and the assistant row used to be
          // silent). No `senderUserId` ⇒ every human recipient is counted.
          // Skip empty/tool-call assistant rows (no visible text); the active
          // viewer already rendered the streamed reply, so the client
          // reconciles this event onto the streamed bubble instead of adding a
          // duplicate.
          row.role === "assistant" &&
          !internalAssistantFingerprints.has(row.fingerprint ?? "") &&
          typeof row.content === "string" &&
          row.content.trim().length > 0
        ) {
          options.eventBus.emit({
            type: "message.new",
            laneKey,
            messageId: row.id,
            ...(row.createdAt ? { createdAt: row.createdAt } : {}),
            role: "ai",
            content: row.content,
            ...(options.agentId ? { authorAgentId: options.agentId } : {}),
            ...(options.assistantMessageKey
              ? { assistantMessageKey: options.assistantMessageKey }
              : {}),
          });
        }
      }
    }

    // D391 — link this turn's retained attachments to the human row's M134
    // fingerprint (= `turn_id`) so they render from room history. Runs on the
    // human persist call (the only one carrying `retainedAttachmentIds`); the
    // stamp is idempotent (matches `turn_id IS NULL`). Best-effort — a failure
    // just means the image won't render from history, never a turn failure.
    if (options.retainedAttachmentIds && options.retainedAttachmentIds.length > 0) {
      const humanFp = newPairs.find(
        (p, i) => p.msg instanceof HumanMessage && !failed.has(i),
      )?.fp;
      if (humanFp) {
        try {
          await stampTurnIdOnAttachments({
            attachmentIds: [...options.retainedAttachmentIds],
            turnId: humanFp,
          });
        } catch (e) {
          warn(
            `[nautilo/executor] D391 turn_id stamp failed (${options.retainedAttachmentIds.length} attachment(s)): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    if (failed.size > 0) {
      warn(
        `[nautilo/executor] partial persist failure thread=${threadId} failed=${failed.size}/${newMessages.length}`,
      );
      options.eventBus.emit({
        type: "session.persistence_failed",
        threadId,
        sessionId: null,
        errorCode: "partial",
        droppedCount: failed.size,
      });
    }
  } catch (error) {
    if (options.humanTurnId && newPairs.some((pair) => pair.msg instanceof HumanMessage)) {
      notifyForegroundTurnLifecycle({ kind: "human_persist_failed", turnId: options.humanTurnId });
    }
    const message = error instanceof Error ? error.message : String(error);
    warn(
      `[nautilo/executor] persist failed thread=${threadId} count=${newMessages.length}: ${message}`,
    );
    options.eventBus.emit({
      type: "session.persistence_failed",
      threadId,
      sessionId: null,
      errorCode: classifyDbError(error),
      droppedCount: newMessages.length,
    });
  }
}
