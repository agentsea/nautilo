import {
  isProtectedMessageRealtimeEventV2,
  type ApprovalAskEvent,
  type ApprovalResolvedEvent,
  type MessageAttachmentRef,
  type ProveItChallengeEvent,
  type ServerEvent,
  type ThreadDetailResponse,
} from "@nautilo/types";
import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  parseSerializedToolArgsForDisplay,
  projectToolArgsForCardDisplay,
  projectToolResultTextForDisplay,
} from "../../../components/tool-argument-preview";
import { preserveComputerUseResultForCard } from "../../../components/tool-card/renderers/computer-use";
import { preserveConnectedAppResultForCard } from "../../../components/tool-card/renderers/connected-app-receipt";
import { mergeHydratedRoomMessages } from "../../../adapters/room-hydration-reconciliation";
import { MESSAGE_ATTACHMENTS_METADATA_KEY } from "../../../adapters/session-rehydrate";
import {
  applyActorReaction,
} from "../shape/reactions/reaction-aggregate";
import type { ReactionAggregate } from "../shape/reactions/ReactionStrip";

/**
 * State for the one child Room currently presented by the thread drawer.
 *
 * This deliberately models only a view over a Room. It does not own a socket:
 * the parent runtime feeds routed ServerEvents through `threadRoomReducer`.
 * `runtimeMessages` is the ordered external-store projection consumed by the
 * child-scoped production Assistant UI runtime mounted by the drawer.
 */
export interface ThreadRoomMessage {
  id: string;
  assistantMessageKey?: string;
  logicalMessageKey?: string;
  role: string;
  content: string;
  createdAt: string;
  editedAt?: string | null;
  editRevision?: number;
  sourceUserId?: string;
  authorAgentId?: string;
  attachments?: MessageAttachmentRef[];
  /** id of the child-row this optimistic/persisted message quotes. */
  replyToMessageId?: number | null;
  /** Local-only id used until the canonical persisted message id is known. */
  optimisticRequestId?: string;
}

export interface ThreadStreamBuffer {
  id: string;
  assistantMessageKey?: string;
  turnId: string | null;
  authorAgentId: string | null;
  content: string;
  done: boolean;
}

export interface ThreadToolActivity {
  toolCallId: string;
  toolName: string;
  status: "running" | "success" | "error";
  argsSummary?: string;
  result?: string;
  error?: string;
  duration?: number;
  turnId: string | null;
  authorAgentId: string | null;
}

export interface ThreadApprovalState {
  approval: ApprovalAskEvent | null;
  proveIt: ProveItChallengeEvent | null;
  resolved: Readonly<Record<string, ApprovalResolvedEvent["resolution"]>>;
}

export interface ThreadReadState {
  status: "idle" | "marking" | "marked" | "error";
  /** Prevents hidden/early effects and duplicate marks for one hydration. */
  requestedForRoomId: string | null;
}

export interface ThreadRoomControllerState {
  roomId: string | null;
  parentRoomId: string | null;
  phase: "closed" | "hydrating" | "ready" | "error";
  visible: boolean;
  connected: boolean;
  detail: ThreadDetailResponse | null;
  anchor: ThreadDetailResponse["anchor"] | null;
  messages: readonly ThreadRoomMessage[];
  /** Canonical ordered Assistant UI projection for the child transcript. */
  runtimeMessages: readonly ThreadMessageLike[];
  streams: Readonly<Record<string, ThreadStreamBuffer>>;
  activeJobIds: readonly string[];
  stopping: boolean;
  tools: Readonly<Record<string, ThreadToolActivity>>;
  approvals: ThreadApprovalState;
  draft: string;
  send: {
    status: "idle" | "sending" | "error";
    requestId: string | null;
    retryableDraft: string | null;
    error: string | null;
  };
  read: ThreadReadState;
  /** In-flight child-only reaction toggles, keyed by local operation id. */
  reactionOperations: Readonly<Record<string, ThreadReactionOperation>>;
  error: string | null;
}

export interface ThreadReactionOperation {
  roomId: string;
  messageId: number;
  emoji: string;
  delta: 1 | -1;
  actorId: string;
}

export const initialThreadRoomControllerState: ThreadRoomControllerState = {
  roomId: null,
  parentRoomId: null,
  phase: "closed",
  visible: false,
  connected: false,
  detail: null,
  anchor: null,
  messages: [],
  runtimeMessages: [],
  streams: {},
  activeJobIds: [],
  stopping: false,
  tools: {},
  approvals: { approval: null, proveIt: null, resolved: {} },
  draft: "",
  send: { status: "idle", requestId: null, retryableDraft: null, error: null },
  read: { status: "idle", requestedForRoomId: null },
  reactionOperations: {},
  error: null,
};

export type ThreadRoomAction =
  | { type: "open"; roomId: string; visible: boolean; connected: boolean }
  | { type: "close" }
  | { type: "visibility.changed"; visible: boolean }
  | { type: "connection.changed"; connected: boolean }
  | {
      type: "hydrated";
      roomId: string;
      detail: ThreadDetailResponse;
      messages: readonly ThreadRoomMessage[];
      runtimeMessages: readonly ThreadMessageLike[];
      activeJobIds: readonly string[];
    }
  | { type: "hydrate.failed"; roomId: string; error: string }
  | {
      type: "history.aroundMerged";
      roomId: string;
      messages: readonly ThreadRoomMessage[];
      runtimeMessages: readonly ThreadMessageLike[];
    }
  | { type: "draft.changed"; draft: string }
  | {
      type: "send.started";
      requestId: string;
      content: string;
      createdAt: string;
      replyToMessageId?: number;
    }
  | {
      type: "send.succeeded";
      requestId: string;
      messageId: number | null;
    }
  | { type: "send.failed"; requestId: string; error: string }
  | { type: "stop.started" }
  | { type: "stop.finished"; activeJobIds: readonly string[] }
  | { type: "stop.failed"; error: string }
  | { type: "approval.localCleared"; kind: "ask" | "proveIt"; approvalId?: string }
  | { type: "read.started"; roomId: string }
  | { type: "read.finished"; roomId: string }
  | { type: "read.failed"; roomId: string }
  /**
   * Both local optimistic toggles and room-scoped WS echoes use this exact
   * child-room action. Keeping the target room on the action makes a late
   * failed request harmless after the drawer has switched to a sibling.
   */
  | {
      type: "reaction.optimistic";
      operationId: string;
      roomId: string;
      messageId: number;
      emoji: string;
      delta: 1 | -1;
      actorId: string;
    }
  | { type: "reaction.succeeded"; roomId: string; operationId: string }
  | { type: "reaction.failed"; roomId: string; operationId: string }
  | { type: "event.received"; event: ServerEvent; resolveRoomId?: ThreadRoomIdResolver };

export type ThreadRoomIdResolver = (laneKey: string) => string | null;

function defaultThreadRoomIdResolver(laneKey: string): string | null {
  const match = /^room:([^:]+)/.exec(laneKey);
  return match?.[1] ?? null;
}

function eventRoomId(event: ServerEvent, resolveRoomId: ThreadRoomIdResolver): string | null {
  if ("laneKey" in event && typeof event.laneKey === "string") {
    return resolveRoomId(event.laneKey);
  }
  return null;
}

/**
 * Strict child-lane admission gate. Unknown provenance does not mutate the
 * drawer. The only lane-less exception is a job event already learned while
 * this child was open, which permits its terminal status to retire safely.
 */
function isThreadEventForRoom(
  state: Pick<ThreadRoomControllerState, "roomId" | "parentRoomId" | "activeJobIds" | "anchor">,
  event: ServerEvent,
  resolveRoomId: ThreadRoomIdResolver = defaultThreadRoomIdResolver,
): boolean {
  if (isProtectedMessageRealtimeEventV2(event)) return false;
  if (!state.roomId || event.type === "thread.summary.changed") return false;
  if (event.type === "message.deleted" && eventRoomId(event, resolveRoomId) === state.parentRoomId
    && state.anchor?.id === String(event.messageId)) return true;
  if (event.type === "message.updated") {
    const roomId = eventRoomId(event, resolveRoomId);
    const anchorMatch =
      state.anchor?.logicalMessageKey === event.logicalMessageKey &&
      roomId === state.parentRoomId;
    return anchorMatch || roomId === state.roomId;
  }
  if (![
    "message.new",
    "message.updated",
    "message.tokens",
    "message.deleted",
    "reaction.added",
    "reaction.removed",
    "job.dispatched",
    "job.status",
    "job.progress",
    "tool.start",
    "tool.end",
    "approval.ask",
    "approval.resolved",
    "prove_it.challenge",
  ].includes(event.type)) return false;
  const roomId = eventRoomId(event, resolveRoomId);
  if (roomId !== null) return roomId === state.roomId;
  return (
    (event.type === "job.status" || event.type === "job.progress") &&
    state.activeJobIds.includes(event.jobId)
  );
}

function applyReactionToRuntimeMessages(
  messages: readonly ThreadMessageLike[],
  messageId: number,
  emoji: string,
  delta: 1 | -1,
  actorId: string,
): readonly ThreadMessageLike[] {
  const targetId = String(messageId);
  const index = messages.findIndex((message) => String(message.id) === targetId);
  if (index < 0) return messages;

  const previous = messages[index];
  const metadata = (previous.metadata ?? {}) as { custom?: Record<string, unknown> };
  const custom = metadata.custom ?? {};
  const current = Array.isArray(custom.reactions)
    ? custom.reactions as ReactionAggregate[]
    : [];
  const reactions = applyActorReaction(current, emoji, delta, actorId);
  return messages.map((message, candidateIndex) => candidateIndex === index
    ? {
        ...previous,
        metadata: { ...metadata, custom: { ...custom, reactions } },
      } as ThreadMessageLike
    : message,
  );
}

function addOrReplaceMessage(
  messages: readonly ThreadRoomMessage[],
  message: ThreadRoomMessage,
): readonly ThreadRoomMessage[] {
  const existingIndex = messages.findIndex((candidate) => candidate.id === message.id);
  if (existingIndex >= 0) {
    return messages.map((candidate, index) => (index === existingIndex ? { ...candidate, ...message } : candidate));
  }
  return [...messages, message];
}

function messageText(message: ThreadMessageLike): string {
  const content = message.content as unknown;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && (part as { type?: string }).type === "text"
      ? ((part as { text?: string }).text ?? "")
      : "")
    .join("");
}

function optimisticRequestId(message: ThreadMessageLike): string | undefined {
  const custom = (message.metadata as { custom?: { optimisticRequestId?: unknown } } | undefined)?.custom;
  return typeof custom?.optimisticRequestId === "string" ? custom.optimisticRequestId : undefined;
}

function runtimeTextMessage(message: ThreadRoomMessage): ThreadMessageLike {
  const custom: Record<string, unknown> = { sentAt: message.createdAt };
  if (message.assistantMessageKey) custom.assistantMessageKey = message.assistantMessageKey;
  if (message.sourceUserId) custom.sourceUserId = message.sourceUserId;
  if (message.authorAgentId) custom.authorAgentId = message.authorAgentId;
  if (message.logicalMessageKey) {
    custom.logicalMessageKey = message.logicalMessageKey;
  }
  if (typeof message.editRevision === "number") {
    custom.editRevision = message.editRevision;
  }
  if (message.editedAt !== undefined) custom.editedAt = message.editedAt;
  if (message.optimisticRequestId) custom.optimisticRequestId = message.optimisticRequestId;
  if (typeof message.replyToMessageId === "number") custom.replyToMessageId = message.replyToMessageId;
  if (message.attachments !== undefined) {
    custom[MESSAGE_ATTACHMENTS_METADATA_KEY] = message.attachments;
  }
  return {
    id: message.id,
    role: message.role as "user" | "assistant" | "system",
    content: [{ type: "text", text: message.content }],
    ...(Object.keys(custom).length > 0 ? { metadata: { custom } } : {}),
  };
}

function reconcileRuntimeMessage(
  messages: readonly ThreadMessageLike[],
  message: ThreadRoomMessage,
  streamId?: string,
): readonly ThreadMessageLike[] {
  const projected = runtimeTextMessage(message);
  const exact = messages.findIndex((candidate) => String(candidate.id) === message.id);
  if (exact >= 0) return messages.map((candidate, index) => index === exact ? projected : candidate);
  const optimistic = messages.findIndex((candidate) =>
    optimisticRequestId(candidate) !== undefined &&
    candidate.role === projected.role &&
    messageText(candidate) === message.content,
  );
  if (optimistic >= 0) return messages.map((candidate, index) => index === optimistic ? projected : candidate);
  if (streamId) {
    const stream = messages.findIndex((candidate) => String(candidate.id) === streamId);
    if (stream >= 0) return messages.map((candidate, index) => index === stream ? projected : candidate);
  }
  return [...messages, projected];
}

function reconcilePersistedMessage(
  messages: readonly ThreadRoomMessage[],
  message: ThreadRoomMessage,
): readonly ThreadRoomMessage[] {
  if (messages.some((candidate) => candidate.id === message.id)) {
    return addOrReplaceMessage(messages, message);
  }
  // A WS echo can arrive before the POST response. Pick the earliest matching
  // optimistic row, making duplicate same-text sends deterministic.
  const optimisticIndex = messages.findIndex(
    (candidate) =>
      candidate.optimisticRequestId !== undefined &&
      candidate.content === message.content &&
      candidate.role === message.role,
  );
  if (optimisticIndex < 0) return [...messages, message];
  return messages.map((candidate, index) =>
    index === optimisticIndex ? message : candidate,
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "Thread request failed.";
}

function applyThreadEvent(
  state: ThreadRoomControllerState,
  event: ServerEvent,
): ThreadRoomControllerState {
  if (isProtectedMessageRealtimeEventV2(event)) return state;
  switch (event.type) {
    case "message.updated": {
      const updateMessage = (message: ThreadRoomMessage): ThreadRoomMessage =>
        message.logicalMessageKey === event.logicalMessageKey &&
        event.editRevision > (message.editRevision ?? 0)
          ? {
              ...message,
              content: event.content,
              editedAt: event.editedAt,
              editRevision: event.editRevision,
            }
          : message;
      const updateRuntimeMessage = (message: ThreadMessageLike): ThreadMessageLike => {
        const metadata =
          (message.metadata ?? {}) as { custom?: Record<string, unknown> };
        const custom = metadata.custom ?? {};
        if (
          custom.logicalMessageKey !== event.logicalMessageKey ||
          event.editRevision <=
            (typeof custom.editRevision === "number" ? custom.editRevision : 0)
        ) {
          return message;
        }
        return {
          ...message,
          content: [{ type: "text", text: event.content }],
          metadata: {
            ...metadata,
            custom: {
              ...custom,
              editedAt: event.editedAt,
              editRevision: event.editRevision,
            },
          },
        } as ThreadMessageLike;
      };
      const anchor =
        state.anchor?.role !== "system" && state.anchor?.logicalMessageKey === event.logicalMessageKey &&
        event.editRevision > (state.anchor.editRevision ?? 0)
          ? {
              ...state.anchor,
              content: event.content,
              editedAt: event.editedAt,
              editRevision: event.editRevision,
            }
          : state.anchor;
      return {
        ...state,
        anchor,
        messages: state.messages.map(updateMessage),
        runtimeMessages: state.runtimeMessages.map(updateRuntimeMessage),
      };
    }
    case "message.new": {
      // Protected structural notifications carry no renderable content. The
      // authenticated history/realtime projection will deliver the actual
      // payload; never manufacture an empty sibling or compare null streams.
      if (typeof event.content !== "string") return state;
      const role = event.role === "ai" ? "assistant" : event.role === "human" ? "user" : event.role;
      const persistedMessage: ThreadRoomMessage = {
        id: event.messageId,
        ...(event.assistantMessageKey ? { assistantMessageKey: event.assistantMessageKey } : {}),
        ...(event.logicalMessageKey
          ? { logicalMessageKey: event.logicalMessageKey }
          : {}),
        role,
        content: event.content,
        createdAt: event.createdAt ?? "",
        ...(typeof event.editRevision === "number"
          ? { editRevision: event.editRevision }
          : {}),
        ...(event.sourceUserId ? { sourceUserId: event.sourceUserId } : {}),
        ...(event.authorAgentId ? { authorAgentId: event.authorAgentId } : {}),
        ...(event.replyToMessageId !== undefined ? { replyToMessageId: event.replyToMessageId } : {}),
        ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
      };
      const messages = reconcilePersistedMessage(state.messages, persistedMessage);
      const reconciledMessage =
        messages.find((message) => message.id === persistedMessage.id) ?? persistedMessage;
      // The persisted row is authoritative. A final WS row can be longer than
      // the last token chunk, so reconcile by the same author when its content
      // extends the in-flight buffer as well as on exact equality. This keeps
      // one bubble through stream → persisted reconciliation.
      const matchesStream = (stream: ThreadStreamBuffer) => {
        if (role !== "assistant") return false;
        if (event.assistantMessageKey && stream.assistantMessageKey) return event.assistantMessageKey === stream.assistantMessageKey;
        if (event.authorAgentId && stream.authorAgentId && event.authorAgentId !== stream.authorAgentId) return false;
        return stream.content === event.content || (stream.content.length > 0 && event.content.startsWith(stream.content));
      };
      const matchingStream = Object.values(state.streams).find(matchesStream);
      const streams = Object.fromEntries(
        Object.entries(state.streams).filter(([, stream]) => stream !== matchingStream),
      );
      return {
        ...state,
        messages,
        runtimeMessages: reconcileRuntimeMessage(state.runtimeMessages, reconciledMessage, matchingStream?.id),
        streams,
        // A newly persisted child message means the previous read watermark
        // is stale. The visible-only effect will mark this child again.
        // Keep this reset even while hidden. The effect remains visible-only,
        // then marks the child when the drawer next becomes visible.
        read: { status: "idle", requestedForRoomId: null },
      };
    }
    case "message.tokens": {
      const previous = Object.values(state.streams).find((stream) =>
        (event.assistantMessageKey ? stream.assistantMessageKey === event.assistantMessageKey : !stream.done) &&
        stream.turnId === (event.turnId ?? null) &&
        stream.authorAgentId === (event.authorAgentId ?? null),
      );
      const id = previous?.id ?? `stream:${event.turnId ?? event.authorAgentId ?? "assistant"}:${state.runtimeMessages.length}`;
      const content = `${previous?.content ?? ""}${event.content}`;
      const streamMessage: ThreadRoomMessage = {
        id,
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
        ...(event.assistantMessageKey ? { assistantMessageKey: event.assistantMessageKey } : {}),
        ...(event.authorAgentId ? { authorAgentId: event.authorAgentId } : {}),
      };
      return {
        ...state,
        runtimeMessages: reconcileRuntimeMessage(state.runtimeMessages, streamMessage),
        streams: {
          ...state.streams,
          [id]: {
            id,
            ...(event.assistantMessageKey ? { assistantMessageKey: event.assistantMessageKey } : {}),
            turnId: event.turnId ?? null,
            authorAgentId: event.authorAgentId ?? null,
            content,
            done: event.done,
          },
        },
      };
    }
    case "message.deleted": {
      if (state.anchor?.id === String(event.messageId)) {
        const anchor = { id: state.anchor.id, role: "system", content: "Message removed by moderation", createdAt: state.anchor.createdAt,
          replyCount: state.anchor.replyCount, lastReplyAt: state.anchor.lastReplyAt, summaryRevision: state.anchor.summaryRevision };
        return { ...state, anchor, detail: state.detail ? { ...state.detail, anchor } : null };
      }
      return {
        ...state,
        messages: state.messages.filter((message) => message.id !== String(event.messageId)),
        runtimeMessages: state.runtimeMessages.filter((message) => String(message.id) !== String(event.messageId)),
      };
    }
    case "reaction.added":
      return {
        ...state,
        runtimeMessages: applyReactionToRuntimeMessages(
          state.runtimeMessages,
          event.messageId,
          event.emoji,
          1,
          event.actorId,
        ),
      };
    case "reaction.removed":
      return {
        ...state,
        runtimeMessages: applyReactionToRuntimeMessages(
          state.runtimeMessages,
          event.messageId,
          event.emoji,
          -1,
          event.actorId,
        ),
      };
    case "job.dispatched":
      return state.activeJobIds.includes(event.jobId)
        ? state
        : { ...state, activeJobIds: [...state.activeJobIds, event.jobId] };
    case "job.status": {
      const terminal = event.status === "completed" || event.status === "failed" || event.status === "timed_out" || event.status === "cancelled";
      const activeJobIds = terminal
        ? state.activeJobIds.filter((jobId) => jobId !== event.jobId)
        : state.activeJobIds.includes(event.jobId)
          ? state.activeJobIds
          : [...state.activeJobIds, event.jobId];
      return { ...state, activeJobIds, stopping: terminal ? false : state.stopping };
    }
    case "tool.start": {
      if (event.toolName === "react") return state;
      const args = projectToolArgsForCardDisplay(
        parseSerializedToolArgsForDisplay(event.argsSummary),
      );
      const argsSummary = Object.keys(args).length > 0 ? JSON.stringify(args) : undefined;
      const toolMessage: ThreadMessageLike = {
        id: `tool-${event.toolCallId}`,
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: args as Record<string, never>,
        }],
        ...(event.authorAgentId ? { metadata: { custom: { authorAgentId: event.authorAgentId } } } : {}),
      };
      const activeStreams = Object.fromEntries(Object.entries(state.streams).filter(([, stream]) =>
        !(stream.turnId === (event.turnId ?? null) && stream.authorAgentId === (event.authorAgentId ?? null)),
      ));
      return {
        ...state,
        runtimeMessages: state.runtimeMessages.some((message) => String(message.id) === String(toolMessage.id))
          ? state.runtimeMessages
          : [...state.runtimeMessages, toolMessage],
        streams: activeStreams,
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: "running",
            ...(argsSummary ? { argsSummary } : {}),
            turnId: event.turnId ?? null,
            authorAgentId: event.authorAgentId ?? null,
          },
        },
      };
    }
    case "tool.end": {
      if (event.toolName === "react") return state;
      const prior = state.tools[event.toolCallId];
      const toolId = `tool-${event.toolCallId}`;
      const displayResult = preserveComputerUseResultForCard(event.toolName, event.result)
        ?? preserveConnectedAppResultForCard(event.toolName, event.result)
        ?? projectToolResultTextForDisplay(event.result);
      const displayError = projectToolResultTextForDisplay(event.error);
      const runtimeMessages = state.runtimeMessages.map((message) => {
        if (String(message.id) !== toolId) return message;
        const content: unknown = message.content;
        const part: unknown = Array.isArray(content) ? content[0] : undefined;
        if (!part || typeof part !== "object" || (part as { type?: string }).type !== "tool-call") return message;
        const toolPart = part as {
          type: "tool-call";
          toolCallId?: string;
          toolName: string;
          args?: Record<string, never>;
          result?: string;
          isError?: boolean;
        };
        return {
          ...message,
          content: [{
            ...toolPart,
            result: event.status === "error"
              ? (displayResult ?? `Error: ${displayError ?? "unknown"}`)
              : (displayResult ?? `Done (${event.duration}ms)`),
            isError: event.status === "error",
          }],
        } as ThreadMessageLike;
      });
      return {
        ...state,
        runtimeMessages,
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: event.status,
            ...(prior?.argsSummary ? { argsSummary: prior.argsSummary } : {}),
            ...(displayResult ? { result: displayResult } : {}),
            ...(displayError ? { error: displayError } : {}),
            duration: event.duration,
            turnId: event.turnId ?? prior?.turnId ?? null,
            authorAgentId: event.authorAgentId ?? prior?.authorAgentId ?? null,
          },
        },
      };
    }
    case "approval.ask":
      return { ...state, approvals: { ...state.approvals, approval: event } };
    case "prove_it.challenge":
      return { ...state, approvals: { ...state.approvals, proveIt: event } };
    case "approval.resolved": {
      const resolved = { ...state.approvals.resolved, [event.approvalId]: event.resolution };
      return {
        ...state,
        approvals: {
          approval: state.approvals.approval?.approvalId === event.approvalId ? null : state.approvals.approval,
          proveIt: state.approvals.proveIt,
          resolved,
        },
      };
    }
    default:
      return state;
  }
}

/** Shared history/live reconciliation for secondary Room views. */
export function reconcileThreadRoomHistory(
  state: ThreadRoomControllerState,
  messages: readonly ThreadRoomMessage[],
  runtimeMessages: readonly ThreadMessageLike[],
): ThreadRoomControllerState {
  const hydratedMessages = messages.filter(
    (message) => typeof message.content === "string",
  );
  const hydratedRuntimeMessages = runtimeMessages.filter(
    (message) => message.content != null,
  );
  const persistedToolIds = new Set(hydratedRuntimeMessages.flatMap(message =>
    typeof message.content === "string" ? [] : message.content.filter(part => part.type === "tool-call").map(part => part.toolCallId)));
  const reconciledStreamIds = new Set(
    Object.values(state.streams)
      .filter((stream) =>
        stream.done &&
        hydratedMessages.some((message) =>
          message.role === "assistant" &&
          !state.messages.some(previous => previous.id === message.id) &&
          message.content.startsWith(stream.content) &&
          (
            !stream.authorAgentId ||
            !message.authorAgentId ||
            message.authorAgentId === stream.authorAgentId
          ),
        ),
      )
      .map((stream) => stream.id),
  );
  return {
    ...state,
    phase: "ready",
    // A Room websocket frame can legitimately arrive while the
    // detail/history request is still pending. The snapshot remains
    // authoritative for matching canonical ids, but must not replace a
    // live-only persisted row (or stream/tool projection) outright.
    messages: mergeHydratedRoomMessages(hydratedMessages, state.messages),
    runtimeMessages: mergeHydratedRoomMessages(
      hydratedRuntimeMessages,
      state.runtimeMessages.filter(
        (message) => !reconciledStreamIds.has(String(message.id)) && !(
          String(message.id).startsWith("tool-") && persistedToolIds.has(String(message.id).slice(5))
        ),
      ),
    ),
    streams: Object.fromEntries(
      Object.entries(state.streams).filter(
        ([streamId]) => !reconciledStreamIds.has(streamId),
      ),
    ),
    error: null,
  };
}

export function threadRoomReducer(
  state: ThreadRoomControllerState,
  action: ThreadRoomAction,
): ThreadRoomControllerState {
  switch (action.type) {
    case "open":
      if (state.roomId === action.roomId) {
        return { ...state, visible: action.visible, connected: action.connected };
      }
      return {
        ...initialThreadRoomControllerState,
        roomId: action.roomId,
        phase: "hydrating",
        visible: action.visible,
        connected: action.connected,
      };
    case "close":
      // Closing is purely visual. The caller must explicitly request `stop`.
      return initialThreadRoomControllerState;
    case "visibility.changed":
      return { ...state, visible: action.visible };
    case "connection.changed":
      return { ...state, connected: action.connected };
    case "hydrated": {
      if (state.roomId !== action.roomId) return state;
      return {
        ...reconcileThreadRoomHistory(state, action.messages, action.runtimeMessages),
        parentRoomId: action.detail.parentRoomId,
        detail: action.detail,
        anchor: action.detail.anchor,
        activeJobIds: action.activeJobIds,
      };
    }

    case "hydrate.failed":
      return state.roomId === action.roomId
        ? { ...state, phase: "error", error: action.error }
        : state;
    case "history.aroundMerged":
      if (state.roomId !== action.roomId) return state;
      return {
        ...state,
        // The live child controller remains authoritative for overlapping
        // optimistic, streaming, reaction, and tool objects.
        messages: mergeHydratedRoomMessages(action.messages, state.messages),
        runtimeMessages: mergeHydratedRoomMessages(action.runtimeMessages, state.runtimeMessages),
      };
    case "draft.changed":
      return { ...state, draft: action.draft, send: { ...state.send, error: null } };
    case "send.started":
      if (state.phase !== "ready" || !state.roomId) return state;
      return {
        ...state,
        messages: [...state.messages, {
          id: `optimistic:${action.requestId}`,
          role: "user",
          content: action.content,
          createdAt: action.createdAt,
          optimisticRequestId: action.requestId,
          ...(action.replyToMessageId !== undefined
            ? { replyToMessageId: action.replyToMessageId }
            : {}),
        }],
        runtimeMessages: [...state.runtimeMessages, runtimeTextMessage({
          id: `optimistic:${action.requestId}`,
          role: "user",
          content: action.content,
          createdAt: action.createdAt,
          optimisticRequestId: action.requestId,
          ...(action.replyToMessageId !== undefined
            ? { replyToMessageId: action.replyToMessageId }
            : {}),
        })],
        draft: "",
        send: { status: "sending", requestId: action.requestId, retryableDraft: null, error: null },
      };
    case "send.succeeded": {
      if (state.send.requestId !== action.requestId) return state;
      const id = action.messageId === null ? null : String(action.messageId);
      const messages = id === null
        ? state.messages
        : state.messages.filter(message => message.optimisticRequestId !== action.requestId || !state.messages.some(candidate => candidate.id === id)).map((message) =>
            message.optimisticRequestId === action.requestId
              ? { ...message, id, optimisticRequestId: undefined }
              : message,
          );
      const runtimeMessages = id === null
        ? state.runtimeMessages
        : state.runtimeMessages.filter(message => optimisticRequestId(message) !== action.requestId || !state.runtimeMessages.some(candidate => String(candidate.id) === id)).map((message) => optimisticRequestId(message) === action.requestId
          ? { ...message, id, metadata: { ...(message.metadata ?? {}), custom: { ...((message.metadata as { custom?: Record<string, unknown> } | undefined)?.custom ?? {}), optimisticRequestId: undefined } } } as ThreadMessageLike
          : message);
      return {
        ...state,
        messages,
        runtimeMessages,
        send: { status: "idle", requestId: null, retryableDraft: null, error: null },
      };
    }
    case "send.failed": {
      if (state.send.requestId !== action.requestId) return state;
      const optimistic = state.messages.find((message) => message.optimisticRequestId === action.requestId);
      return {
        ...state,
        messages: state.messages.filter((message) => message.optimisticRequestId !== action.requestId),
        runtimeMessages: state.runtimeMessages.filter((message) => optimisticRequestId(message) !== action.requestId),
        draft: optimistic?.content ?? state.draft,
        send: { status: "error", requestId: null, retryableDraft: optimistic?.content ?? null, error: action.error },
      };
    }
    case "stop.started":
      return state.roomId ? { ...state, stopping: true } : state;
    case "stop.finished":
      return { ...state, stopping: false, activeJobIds: action.activeJobIds };
    case "stop.failed":
      return { ...state, stopping: false, error: action.error };
    case "approval.localCleared":
      return {
        ...state,
        approvals: {
          ...state.approvals,
          ...(action.kind === "ask"
            ? {
                approval: action.approvalId === undefined || state.approvals.approval?.approvalId === action.approvalId
                  ? null
                  : state.approvals.approval,
              }
            : { proveIt: null }),
        },
      };
    case "read.started":
      return state.roomId === action.roomId && state.phase === "ready" && state.visible
        ? { ...state, read: { status: "marking", requestedForRoomId: action.roomId } }
        : state;
    case "read.finished":
      return state.roomId === action.roomId
        ? { ...state, read: { status: "marked", requestedForRoomId: action.roomId } }
        : state;
    case "read.failed":
      return state.roomId === action.roomId
        ? { ...state, read: { status: "error", requestedForRoomId: null } }
        : state;
    case "reaction.optimistic":
      return state.roomId === action.roomId
        ? {
            ...state,
            reactionOperations: {
              ...state.reactionOperations,
              [action.operationId]: {
                roomId: action.roomId,
                messageId: action.messageId,
                emoji: action.emoji,
                delta: action.delta,
                actorId: action.actorId,
              },
            },
            runtimeMessages: applyReactionToRuntimeMessages(
              state.runtimeMessages,
              action.messageId,
              action.emoji,
              action.delta,
              action.actorId,
            ),
          }
        : state;
    case "reaction.succeeded": {
      const operation = state.reactionOperations[action.operationId];
      if (state.roomId !== action.roomId || operation?.roomId !== action.roomId) return state;
      const { [action.operationId]: _completed, ...reactionOperations } = state.reactionOperations;
      return { ...state, reactionOperations };
    }
    case "reaction.failed": {
      const operation = state.reactionOperations[action.operationId];
      if (state.roomId !== action.roomId || operation?.roomId !== action.roomId) return state;
      const { [action.operationId]: _failed, ...reactionOperations } = state.reactionOperations;
      // A later toggle of this exact child reaction already owns the displayed
      // state. Let that request settle rather than undoing its newer intent.
      const superseded = Object.values(reactionOperations).some((candidate) =>
        candidate.roomId === operation.roomId &&
        candidate.messageId === operation.messageId &&
        candidate.emoji === operation.emoji,
      );
      return {
        ...state,
        reactionOperations,
        runtimeMessages: superseded
          ? state.runtimeMessages
          : applyReactionToRuntimeMessages(
              state.runtimeMessages,
              operation.messageId,
              operation.emoji,
              operation.delta === 1 ? -1 : 1,
              operation.actorId,
            ),
      };
    }
    case "event.received": {
      const resolver = action.resolveRoomId ?? defaultThreadRoomIdResolver;
      return isThreadEventForRoom(state, action.event, resolver)
        ? applyThreadEvent(state, action.event)
        : state;
    }
    default:
      return state;
  }
}

export { errorMessage };
