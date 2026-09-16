import type { ThreadMessageLike } from "@assistant-ui/react";

/** M178 — per-stream assistant bubble accumulator keyed by composite stream id. */
export type StreamState = { readonly bubbleId: string; acc: string };

export type StreamKeyInput = {
  readonly assistantMessageKey?: string;
  readonly turnId?: string;
  readonly laneKey: string;
  readonly authorAgentId?: string;
};

/**
 * Composite stream key: turnId separates concurrent forks of the same bot;
 * authorAgentId separates concurrent bots woken for one shared turn (M134).
 * Legacy fallback when turnId is absent: one stream per (lane, author).
 */
export function streamKey(ev: StreamKeyInput): string {
  if (ev.assistantMessageKey) return `message:${ev.assistantMessageKey}`;
  const author = ev.authorAgentId ?? "";
  if (ev.turnId) return `turn:${ev.turnId}|${author}`;
  return `lane:${ev.laneKey}|${author}`;
}

/** Stable lookup key for reconciling `done:true` frames whose `turnId` drifted. */
export function laneAuthorStreamLookupKey(ev: Pick<StreamKeyInput, "laneKey" | "authorAgentId">): string {
  return `lane:${ev.laneKey}|${ev.authorAgentId ?? ""}`;
}

export function anyStreamHasVisibleOutput(
  streams: ReadonlyMap<string, StreamState>,
): boolean {
  for (const entry of streams.values()) {
    if (entry.acc.trim().length > 0) return true;
  }
  return false;
}

export type ApplyTokensChunkInput = {
  readonly streams: Map<string, StreamState>;
  readonly key: string;
  readonly content: string;
  readonly newBubbleId: string;
};

/** Pure reducer for `message.tokens` content chunks (no React side effects). */
export function applyTokensContentChunk(input: ApplyTokensChunkInput): {
  bubbleId: string;
  acc: string;
  createdBubble: boolean;
} {
  const { streams, key, content, newBubbleId } = input;
  let entry = streams.get(key);
  let createdBubble = false;
  if (!entry) {
    entry = { bubbleId: newBubbleId, acc: "" };
    streams.set(key, entry);
    createdBubble = true;
  }
  entry.acc += content;
  return { bubbleId: entry.bubbleId, acc: entry.acc, createdBubble };
}

export type FinalizeTokensDoneInput = {
  readonly streams: Map<string, StreamState>;
  readonly key: string;
};

/** Returns finalized acc + bubbleId and removes the stream entry on done. */
export function finalizeTokensDone(input: FinalizeTokensDoneInput): {
  bubbleId: string | null;
  acc: string;
} {
  const entry = input.streams.get(input.key);
  if (!entry) return { bubbleId: null, acc: "" };
  const { bubbleId, acc } = entry;
  input.streams.delete(input.key);
  return { bubbleId, acc };
}

export type MessageNewReconcileInput = {
  readonly messages: readonly ThreadMessageLike[];
  readonly content: string;
  readonly authorAgentId?: string;
  readonly assistantMessageKey?: string;
};

function messageTextContent(msg: ThreadMessageLike): string | null {
  const parts = (msg as { content?: unknown }).content;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string };
    if (p.type === "text" && typeof p.text === "string") return p.text;
  }
  return null;
}

function messageAuthorAgentId(msg: ThreadMessageLike): string | undefined {
  const meta = (msg.metadata ?? {}) as { custom?: Record<string, unknown> };
  const id = meta.custom?.authorAgentId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function messageAssistantKey(msg: ThreadMessageLike): string | undefined {
  const meta = (msg.metadata ?? {}) as { custom?: Record<string, unknown> };
  const key = meta.custom?.assistantMessageKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/**
 * Scan from the end for an assistant bubble whose text matches `content`.
 * When both sides carry `authorAgentId`, they must match (M178 multi-bot).
 */
export function findAssistantReconcileIndex(
  input: MessageNewReconcileInput,
): number {
  if (input.assistantMessageKey) {
    for (let i = input.messages.length - 1; i >= 0; i -= 1) {
      const message = input.messages[i];
      if (
        message?.role === "assistant" &&
        messageAssistantKey(message) === input.assistantMessageKey
      ) {
        return i;
      }
    }
    return -1;
  }
  const eventAuthor =
    typeof input.authorAgentId === "string" && input.authorAgentId.length > 0
      ? input.authorAgentId
      : undefined;
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const m = input.messages[i];
    if (m.role !== "assistant") continue;
    if (messageTextContent(m) !== input.content) continue;
    if (eventAuthor !== undefined) {
      const bubbleAuthor = messageAuthorAgentId(m);
      if (bubbleAuthor !== undefined && bubbleAuthor !== eventAuthor) continue;
    }
    return i;
  }
  return -1;
}

/**
 * Applies durable identity and metadata to an assistant bubble that was
 * rendered first by streaming or the protected live-shadow path. Durable
 * `message.new` metadata is authoritative and must not be discarded merely
 * because the visible text already exists.
 */
export function reconcileAssistantDurableMessage(input: Readonly<{
  messages: readonly ThreadMessageLike[];
  index: number;
  messageId: string;
  custom: Readonly<Record<string, unknown>>;
}>): readonly ThreadMessageLike[] {
  const current = input.messages[input.index];
  if (!current) return input.messages;
  const metadata = (current.metadata ?? {}) as Record<string, unknown> & {
    custom?: Record<string, unknown>;
  };
  const nextCustom = {
    ...(metadata.custom ?? {}),
    ...input.custom,
  };
  const idChanged = String(current.id) !== input.messageId;
  const metadataChanged = Object.entries(input.custom).some(
    ([key, value]) => metadata.custom?.[key] !== value,
  );
  if (!idChanged && !metadataChanged) return input.messages;
  return [
    ...input.messages.slice(0, input.index),
    {
      ...current,
      id: input.messageId,
      metadata: {
        ...metadata,
        custom: nextCustom,
      },
    } as ThreadMessageLike,
    ...input.messages.slice(input.index + 1),
  ];
}

export type FinalizeStreamsOnJobCancelInput = {
  readonly streams: Map<string, StreamState>;
};

/** Finalize every live stream in place (cancelled job). */
export function finalizeAllStreamsOnCancel(
  input: FinalizeStreamsOnJobCancelInput,
): readonly { bubbleId: string; acc: string }[] {
  const out: { bubbleId: string; acc: string }[] = [];
  for (const entry of input.streams.values()) {
    out.push({ bubbleId: entry.bubbleId, acc: entry.acc });
  }
  input.streams.clear();
  return out;
}

export type FinalizeSingleStreamWithErrorInput = {
  readonly streams: Map<string, StreamState>;
  readonly messageBody: string;
};

/**
 * Failed job: append error to the sole live stream when unambiguous; otherwise
 * finalize partials and return a standalone error message body (if any streams).
 */
export function resolveFailedJobStreamFinalization(
  input: FinalizeSingleStreamWithErrorInput,
): {
  readonly updates: readonly { bubbleId: string; content: string }[];
  readonly standaloneError: string | null;
} {
  const { streams, messageBody } = input;
  if (streams.size === 1) {
    const entry = [...streams.values()][0];
    streams.clear();
    return {
      updates: [
        {
          bubbleId: entry.bubbleId,
          content: `${entry.acc}\n\n${messageBody}`,
        },
      ],
      standaloneError: null,
    };
  }
  if (streams.size === 0) {
    return { updates: [], standaloneError: messageBody };
  }
  const updates: { bubbleId: string; content: string }[] = [];
  for (const entry of streams.values()) {
    updates.push({ bubbleId: entry.bubbleId, content: entry.acc });
  }
  streams.clear();
  return { updates, standaloneError: messageBody };
}

const PLANNED_SHUTDOWN_CANCELLATION_REASON =
  "Cancelled because the server is shutting down for planned maintenance";

/**
 * Translate the one deliberate-restart terminal into stable Room-visible
 * state after a websocket gap. Other terminal Jobs retain their existing
 * realtime projection; this helper must not turn arbitrary persisted error
 * text into a cross-user chat bubble.
 */
export function plannedShutdownReconnectMessage(input: Readonly<{
  status: string;
  message: string | null;
}>): string | null {
  return input.status === "cancelled"
      && input.message === PLANNED_SHUTDOWN_CANCELLATION_REASON
    ? "**Error:** The server restarted before this response finished. Please try again."
    : null;
}
