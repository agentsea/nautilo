// D369 Phase 6 — pure chat model. ALL conversation logic (lane matching,
// DTO→view normalizers, streaming reducer) lives here, React-free, so it
// unit-tests in isolation. The screen (@/app/chat/[roomId].tsx) is wiring
// only — it feeds ServerEvents into `applyStreamEvent` and renders the
// resulting ChatItem[]. This file is the primary audit target.
//
// Reconciliation rules (mirror the workbench):
//   - `message.tokens` finds the in-flight assistant bubble keyed by
//     `turnId` (preferred) or laneKey, appends `content`, and — when
//     `done` — leaves it settled in place. The bubble keeps its
//     `streaming:<key>` id until `message.new` finalizes it with the
//     persisted `messageId`. Empty content chunks are ignored (desktop
//     parity) so reaction-only turns do not materialize blank bubbles.
//   - `message.new` for `role: "ai"` finalizes the streaming bubble
//     (replaces its id with `messageId`, freezes text to the persisted
//     `content`) or — if no streaming bubble exists — appends a fresh
//     assistant message. For `role: "user"/"human"` we replace the
//     most-recent pending optimistic user item (the server does NOT
//     echo our own `message.new` back to our socket per D124 B3, so
//     the screen marks the optimistic item sent on send-return; this
//     branch is a safety net for peers/other-socket echoes and for
//     dedupe of any future reload). System rows are appended. All
//     branches dedupe by `messageId` first.
//   - `tool.start` inserts a running tool card keyed by `toolCallId`
//     if absent. `tool.end` patches the matching card → status from
//     `event.status`, sets `result`/`error`. A `tool.end` with no
//     matching `tool.start` inserts a settled card (race recovery).
//   - All other ServerEvent types are returned unchanged.
//
// Determinism: every branch returns a fresh array (no in-place mutation).
// Synthesized timestamps use `new Date().toISOString()` for streaming/
// tool cards because the wire events carry no `createdAt`; tests mock
// `Date` for determinism (same pattern as the workbench reducer).
import {
  isProtectedMessageRealtimeEventV2,
  type MessageArtifactOpenRef,
  type ServerEvent,
} from "@nautilo/types";

export type ChatRole = "user" | "assistant" | "system";

/** D408 — aggregated reaction row on a persisted message bubble. */
export type MessageReaction = {
  emoji: string;
  count: number;
  /** True when the viewer has reacted with this emoji. */
  mine?: boolean;
};

export type ChatItem =
  | {
      kind: "message";
      id: string;
      role: ChatRole;
      text: string;
      /**
       * Raw persisted Human prose when the server supplies a distinct display
       * projection. Editors must prefer this over `text`; other roles do not
       * expose an editable source body.
       */
      editContent?: string;
      createdAt: string;
      /** Authoritative server send time; absent for locally timed/legacy rows. */
      sentAt?: string;
      /**
       * Delivery state of the row. `pending` = optimistic, not yet
       * acknowledged by the server; `sent` = persisted/echoed; `failed`
       * = send threw and the user can retry. Absent for streaming
       * assistant bubbles (the bubble is rendered without opacity).
       */
      status?: "pending" | "sent" | "failed";
      /** Optimistic-only correlation id (client-generated). */
      clientId?: string;
      /** M178 turn correlation for the streaming assistant bubble. */
      turnId?: string;
      /**
       * React-only identity retained while a streaming row receives its
       * persisted server id. Keeping this distinct from `id` avoids a
       * FlatList remount without retaining a synthetic message id for
       * reactions, replies, or other model lookups.
       */
      presentationKey?: string;
      /** D300 stable assistant author id (multi-agent rooms). */
      authorAgentId?: string;
      /** D124 — human author id for multi-human rooms. */
      sourceUserId?: string;
      /** M230 — stable identity shared by every projection of one Human turn. */
      logicalMessageKey?: string;
      /** M230 — authoritative revision; absent means editing authority is unknown. */
      editRevision?: number;
      /** M230 — authoritative edit timestamp; null means never edited. */
      editedAt?: string | null;
      /**
       * D382/D391 — image attachment previews rendered above the text.
       * Optimistic sends use a local `file://` uri (no headers). History-
       * loaded rows (D391) use the authed byte-route URL + an `Authorization`
       * header so `<Image>` can fetch the server-side blob.
       */
      attachments?: MessageAttachmentPreview[];
      /** D424 — server-authorized artifact cards linked to this user message. */
      artifacts?: MessageArtifactOpenRef[];
      /** D408 — only on persisted (server-id) messages, not optimistic rows. */
      reactions?: MessageReaction[];
      /** D408 — inline quote-reply target (persisted server message id). */
      replyToMessageId?: number;
      /** D426 — canonical child-thread summary for this parent message. */
      replyCount?: number;
      summaryRevision?: number;
    }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      argsSummary?: string;
      status: "running" | "success" | "error";
      result?: string;
      resultTruncated?: boolean;
      error?: string;
      createdAt: string;
    };

/** D391 — attachment ref carried on a history message DTO. */
export type HistoryAttachmentRef = {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type MessageAttachmentPreview =
  | Readonly<{ kind: "local"; uri: string }>
  | Readonly<HistoryAttachmentRef & { kind: "retained"; uri: string; headers?: Record<string, string> }>;

/** D424 — server-authorized artifact pointer carried on history messages. */
export type HistoryArtifactOpenRef = MessageArtifactOpenRef;

/** Row shape returned by `getLatestSession` / `getOlderRoomMessages`. */
export type HistoryMessageDto = {
  id: string;
  logicalMessageKey?: string;
  role: string;
  content: string;
  toolCalls?: string | null;
  toolName?: string | null;
  displayContent?: string;
  createdAt: string;
  editedAt?: string | null;
  editRevision?: number;
  authorAgentId?: string;
  /** D124 — human author id for multi-human rooms. */
  sourceUserId?: string;
  /** D391 — retained attachments linked to this turn (images now). */
  attachments?: HistoryAttachmentRef[];
  /** D424 — safe artifact-open refs; never inferred from message content. */
  artifacts?: HistoryArtifactOpenRef[];
  /** D408 — inlined when non-empty (M121 aggregate shape). */
  reactions?: { emoji: string; count: number; actorIds?: readonly string[] }[];
  /** D124 — inline quote-reply target message id. */
  replyToMessageId?: number | null;
  /** D426 — canonical child-thread summary for a parent message. */
  replyCount?: number;
  summaryRevision?: number;
};

/** Resolves a history attachment ref to a renderable `<Image>` source. */
export type AttachmentResolver = (ref: HistoryAttachmentRef) => Extract<MessageAttachmentPreview, { kind: "retained" }>;

/**
 * The server relation is unique, but collapse duplicate refs defensively so a
 * history/event reconciliation can never render duplicate open cards.
 */
function uniqueArtifacts(
  artifacts: readonly MessageArtifactOpenRef[] | undefined,
): MessageArtifactOpenRef[] | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  const seen = new Set<string>();
  const unique = artifacts.filter((artifact) => {
    const key = `${artifact.roomId}:${artifact.artifactInternalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length > 0 ? unique : undefined;
}

/**
 * Extract the `roomId` from a `room:<id>[:conductor-suffixes]` laneKey.
 * Returns null for absent / non-`room:` lanes so callers can branch.
 * Mirrors the workbench lane matcher exactly.
 */
export function roomIdFromLaneKey(laneKey: string | undefined): string | null {
  if (!laneKey) return null;
  const m = /^room:([^:]+)/.exec(laneKey);
  return m ? m[1] : null;
}

/**
 * Map server roles to the client view union. `ai`→assistant,
 * `human`/`user`→user, `system`→system; default assistant for any
 * unknown tag (forward-compat with new server roles).
 */
function normalizeRole(raw: string): ChatRole {
  switch (raw) {
    case "user":
    case "human":
      return "user";
    case "system":
      return "system";
    case "ai":
    case "assistant":
      return "assistant";
    default:
      return "assistant";
  }
}

/**
 * Normalize a history row into a ChatItem. Assistant rows remain text
 * messages even when their `toolCalls` declaration is present; only actual
 * `tool` result rows become tool cards. Sorts ascending by `createdAt`
 * (oldest first) so the screen can reverse for the inverted FlatList.
 */
/** Map server aggregates to the mobile view model (sets `mine` from actorIds). */
function mapHistoryReactions(
  aggregates:
    | readonly { emoji: string; count: number; actorIds?: readonly string[] }[]
    | undefined,
  viewerActorId?: string | null,
): MessageReaction[] | undefined {
  if (!aggregates || aggregates.length === 0) return undefined;
  const mapped = aggregates
    .filter((r) => r.count > 0)
    .map((r) => ({
      emoji: r.emoji,
      count: r.count,
      ...(viewerActorId && r.actorIds?.includes(viewerActorId)
        ? { mine: true as const }
        : {}),
    }));
  return mapped.length > 0 ? mapped : undefined;
}

export function fromHistoryMessages(
  dtos: HistoryMessageDto[],
  resolveAttachment?: AttachmentResolver,
  viewerActorId?: string | null,
): ChatItem[] {
  const items: ChatItem[] = dtos.flatMap<ChatItem>((d): ChatItem[] => {
    const role = normalizeRole(d.role);
    if (d.role === "tool") {
      // displayContent is intentionally only the server's compact status line
      // (for example, `⚙ file [success]`). Recover its presentation metadata
      // before retaining the server-projected persisted content for the
      // explicit result disclosure, matching Workbench rehydration.
      const compactDisplay = d.displayContent?.match(
        /^⚙\s+(.+?)\s+\[(success|error)(?:\s+\d+ms)?\]/u,
      );
      const persistedToolName = d.toolName?.trim() || compactDisplay?.[1]?.trim() || "tool";
      const persistedStatus = compactDisplay?.[2] === "error" ? "error" : "success";
      const result = d.content ?? "";
      const item: ChatItem = {
        kind: "tool",
        // The DTO has no separate tool-call id; reuse the row id for v1
        // dedup. A future wire shape with toolCallId will slot in here.
        toolCallId: d.id,
        toolName: persistedToolName,
        status: persistedStatus,
        createdAt: d.createdAt,
      };
      if (result.length > 0) item.result = result;
      return [item];
    }
    const text =
      d.displayContent != null && d.displayContent.trim().length > 0
        ? d.displayContent
        : (d.content ?? "");
    // An assistant declaration may carry toolCalls alongside visible prose.
    // The matching tool result arrives as its own `role: "tool"` row, so do
    // not manufacture a duplicate tool card here.
    if (role === "assistant" && text.trim().length === 0) return [];
    const msg: ChatItem = {
      kind: "message",
      id: d.id,
      role,
      text,
      createdAt: d.createdAt,
      sentAt: d.createdAt,
      status: "sent",
    };
    if (role === "user" && text !== d.content) msg.editContent = d.content;
    if (d.authorAgentId) msg.authorAgentId = d.authorAgentId;
    if (d.sourceUserId) msg.sourceUserId = d.sourceUserId;
    if (role === "user") {
      if (typeof d.logicalMessageKey === "string") {
        msg.logicalMessageKey = d.logicalMessageKey;
      }
      if (typeof d.editRevision === "number") msg.editRevision = d.editRevision;
      if (typeof d.editedAt === "string" || d.editedAt === null) {
        msg.editedAt = d.editedAt;
      }
    }
    // D391 — render retained attachments from history via the authed byte route.
    if (resolveAttachment && d.attachments && d.attachments.length > 0) {
      msg.attachments = d.attachments.map(resolveAttachment);
    }
    const artifacts = uniqueArtifacts(d.artifacts);
    if (artifacts) msg.artifacts = artifacts;
    const reactions = mapHistoryReactions(d.reactions, viewerActorId);
    if (reactions) msg.reactions = reactions;
    if (d.replyToMessageId != null) msg.replyToMessageId = d.replyToMessageId;
    if (typeof d.replyCount === "number") msg.replyCount = d.replyCount;
    if (typeof d.summaryRevision === "number") msg.summaryRevision = d.summaryRevision;
    return [msg];
  });
  items.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  return items;
}

/**
 * Build an optimistic user message for the given client-generated id.
 * The screen inserts this immediately on send; `sendRoomMessage`'s
 * returned `messageId` later updates the id (or — if the server ever
 * echoes our own row — `applyStreamEvent` reconciles it).
 */
export function makeOptimisticUserItem(
  clientId: string,
  text: string,
  now: string,
  attachments?: { uri: string }[],
  sourceUserId?: string,
): ChatItem {
  const item: ChatItem = {
    kind: "message",
    id: clientId,
    role: "user",
    text,
    createdAt: now,
    status: "pending",
    clientId,
    // The REST acknowledgement replaces `id` with the persisted server id.
    // Retain a React-only identity so FlatList updates this row in place
    // instead of visibly unmounting/remounting it after every send.
    presentationKey: clientId,
  };
  if (attachments && attachments.length > 0) item.attachments = attachments.map((attachment) => ({ kind: "local", ...attachment }));
  if (sourceUserId) item.sourceUserId = sourceUserId;
  return item;
}

/** Apply the server's absolute, revisioned child-thread summary to its parent. */
export function applyThreadSummaryEvent(
  items: ChatItem[],
  event: {
    anchorMessageId: number;
    replyCount: number;
    summaryRevision: number;
  },
): ChatItem[] {
  const index = items.findIndex(
    (item): item is Extract<ChatItem, { kind: "message" }> =>
      item.kind === "message" && String(item.id) === String(event.anchorMessageId),
  );
  if (index < 0) return items;
  const current = items[index] as Extract<ChatItem, { kind: "message" }>;
  if ((current.summaryRevision ?? -1) >= event.summaryRevision) return items;
  const next = items.slice();
  next[index] = {
    ...current,
    replyCount: event.replyCount,
    summaryRevision: event.summaryRevision,
  };
  return next;
}

/** Model id / dedup key for a ChatItem. */
export function chatItemKey(item: ChatItem): string {
  return item.kind === "tool" ? `tool:${item.toolCallId}` : `msg:${item.id}`;
}

/** Stable FlatList key while a streaming message receives its server id. */
export function chatItemPresentationKey(item: ChatItem): string {
  return item.kind === "tool"
    ? `tool:${item.toolCallId}`
    : `msg:${item.presentationKey ?? item.id}`;
}

/**
 * Reconcile a latest-page catch-up without replacing the mounted transcript.
 * Existing older/paged and in-flight rows remain in place; authoritative
 * history overwrites matching persisted rows while retaining their React-only
 * presentation identity. This is intentionally different from the first
 * room load, which starts from an empty transcript.
 */
export function reconcileLatestHistoryItems(
  current: readonly ChatItem[],
  latest: readonly ChatItem[],
): ChatItem[] {
  const next = [...current];
  const indexByKey = new Map(next.map((item, index) => [chatItemKey(item), index]));

  for (const canonical of latest) {
    const key = chatItemKey(canonical);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, next.length);
      next.push(canonical);
      continue;
    }
    const existing = next[index];
    if (existing?.kind === "message" && canonical.kind === "message") {
      const retainCurrentEdit = isIncomingEditRevisionStale(
        existing,
        canonical.editRevision,
      );
      const replacement: MessageItem = {
        ...canonical,
        ...(existing.presentationKey
          ? { presentationKey: existing.presentationKey }
          : {}),
      };
      if (retainCurrentEdit) copyEditProjection(replacement, existing);
      next[index] = replacement;
    } else {
      next[index] = canonical;
    }
  }

  return next.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

/**
 * Reconcile the exact persisted Human row returned by an around-message read.
 * This is confirmation-only: if the optimistic row has since vanished, a late
 * response must not resurrect it.
 */
export function reconcilePersistedHumanMessage(
  items: ChatItem[],
  incoming: MessageItem,
): ChatItem[] {
  const index = items.findIndex(
    (item): item is MessageItem =>
      item.kind === "message" && item.id === incoming.id,
  );
  if (index < 0) return items;
  const current = items[index] as MessageItem;
  const replacement: MessageItem = {
    ...incoming,
    status: "sent",
    clientId: undefined,
    ...(current.presentationKey
      ? { presentationKey: current.presentationKey }
      : {}),
    ...(incoming.attachments === undefined && current.attachments !== undefined
      ? { attachments: current.attachments }
      : {}),
    ...(incoming.reactions === undefined && current.reactions !== undefined
      ? { reactions: current.reactions }
      : {}),
  };
  if (isIncomingEditRevisionStale(current, incoming.editRevision)) {
    copyEditProjection(replacement, current);
  }
  delete replacement.clientId;
  const next = [...items];
  next[index] = replacement;
  return next;
}

/** Find the rightmost index matching `pred` (-1 if none). ES2023-free. */
function findLastIndex<T>(
  arr: readonly T[],
  pred: (value: T, index: number) => boolean,
): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i], i)) return i;
  }
  return -1;
}

export type MessageItem = Extract<ChatItem, { kind: "message" }>;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** An absent incoming revision can never supersede a known mounted revision. */
function isIncomingEditRevisionStale(
  current: MessageItem,
  incomingRevision: number | undefined,
): boolean {
  return (
    typeof current.editRevision === "number" &&
    (typeof incomingRevision !== "number" ||
      incomingRevision < current.editRevision)
  );
}

/** Copy only the revision-governed fields, removing stale optional values. */
function copyEditProjection(target: MessageItem, source: MessageItem): void {
  target.text = source.text;
  if (source.editContent === undefined) delete target.editContent;
  else target.editContent = source.editContent;
  if (source.logicalMessageKey === undefined) delete target.logicalMessageKey;
  else target.logicalMessageKey = source.logicalMessageKey;
  if (source.editRevision === undefined) delete target.editRevision;
  else target.editRevision = source.editRevision;
  if (source.editedAt === undefined) delete target.editedAt;
  else target.editedAt = source.editedAt;
}

type OrdinaryMessageNewEvent = Extract<
  ServerEvent,
  { type: "message.new"; content: string }
>;

/** Apply only editing coordinates actually carried by ordinary message.new. */
function applyMessageNewEditMetadata(
  target: MessageItem,
  event: OrdinaryMessageNewEvent,
  stale: boolean,
): void {
  if (target.role !== "user") return;
  if (
    typeof event.logicalMessageKey === "string" &&
    (!stale || target.logicalMessageKey === undefined)
  ) {
    target.logicalMessageKey = event.logicalMessageKey;
  }
  if (typeof event.editRevision === "number" && !stale) {
    target.editRevision = event.editRevision;
  }
}

/** Persisted server rows only — optimistic / streaming bubbles skip reactions. */
function isPersistedMessage(item: MessageItem): boolean {
  return item.clientId === undefined && !item.id.startsWith("streaming:");
}

function findPersistedMessageIndex(
  items: ChatItem[],
  messageId: string,
): number {
  return items.findIndex(
    (it): it is MessageItem =>
      it.kind === "message" &&
      String(it.id) === messageId &&
      isPersistedMessage(it),
  );
}

/**
 * Apply a single +1 / -1 reaction delta to one message's aggregate list.
 * Idempotent for the viewer's own reactions so optimistic toggles and WS
 * echoes collapse to a single count change (mirrors desktop applyActorReaction).
 */
function applyReactionDeltaToList(
  current: MessageReaction[] | undefined,
  emoji: string,
  delta: 1 | -1,
  actorId: string,
  viewerActorId?: string | null,
): MessageReaction[] {
  const isViewer = viewerActorId != null && actorId === viewerActorId;
  const next = (current ?? []).map((r) => ({ ...r }));
  const hit = next.find((r) => r.emoji === emoji);

  if (delta > 0) {
    if (isViewer && hit?.mine) return next.filter((r) => r.count > 0);
    if (hit) {
      hit.count += 1;
      if (isViewer) hit.mine = true;
    } else {
      next.push({ emoji, count: 1, ...(isViewer ? { mine: true } : {}) });
    }
  } else if (hit) {
    if (isViewer && !hit.mine) return next.filter((r) => r.count > 0);
    hit.count -= 1;
    if (isViewer) hit.mine = false;
  }

  return next.filter((r) => r.count > 0);
}

function patchMessageReactions(
  items: ChatItem[],
  messageId: string,
  emoji: string,
  delta: 1 | -1,
  actorId: string,
  viewerActorId?: string | null,
): ChatItem[] {
  const idx = findPersistedMessageIndex(items, messageId);
  if (idx === -1) return items;
  const target = items[idx] as MessageItem;
  const reactions = applyReactionDeltaToList(
    target.reactions,
    emoji,
    delta,
    actorId,
    viewerActorId,
  );
  const next = items.slice();
  next[idx] = {
    ...target,
    reactions: reactions.length > 0 ? reactions : undefined,
  };
  return next;
}

/** WS reducer — apply `reaction.added` / `reaction.removed` to the list. */
export function applyReactionEvent(
  items: ChatItem[],
  event:
    | {
        type: "reaction.added";
        messageId: number | string;
        actorId: string;
        emoji: string;
      }
    | {
        type: "reaction.removed";
        messageId: number | string;
        actorId: string;
        emoji: string;
      },
  viewerActorId?: string | null,
): ChatItem[] {
  const delta = event.type === "reaction.added" ? 1 : -1;
  return patchMessageReactions(
    items,
    String(event.messageId),
    event.emoji,
    delta,
    event.actorId,
    viewerActorId,
  );
}

/** Optimistic local toggle before the REST call returns. */
export function applyOptimisticReaction(
  items: ChatItem[],
  messageId: string,
  emoji: string,
  adding: boolean,
  viewerActorId: string,
): ChatItem[] {
  return patchMessageReactions(
    items,
    messageId,
    emoji,
    adding ? 1 : -1,
    viewerActorId,
    viewerActorId,
  );
}

/** Reconcile a message's reactions from the REST response aggregates. */
export function reconcileMessageReactions(
  items: ChatItem[],
  messageId: string,
  aggregates: readonly {
    emoji: string;
    count: number;
    actorIds?: readonly string[];
  }[],
  viewerActorId?: string | null,
): ChatItem[] {
  const idx = findPersistedMessageIndex(items, messageId);
  if (idx === -1) return items;
  const target = items[idx] as MessageItem;
  const reactions = mapHistoryReactions(aggregates, viewerActorId);
  const next = items.slice();
  next[idx] = { ...target, reactions };
  return next;
}

function isStreamingAssistant(item: ChatItem): item is MessageItem {
  return (
    item.kind === "message" &&
    item.role === "assistant" &&
    typeof item.turnId === "string" &&
    item.id.startsWith("streaming:")
  );
}

/** In-flight assistant bubble with no visible text yet. */
function isEmptyStreamingAssistantBubble(item: ChatItem): item is MessageItem {
  return (
    item.kind === "message" &&
    item.role === "assistant" &&
    item.id.startsWith("streaming:") &&
    item.text.trim().length === 0
  );
}

/**
 * D408 — drop a reaction-only empty streaming placeholder after `react`
 * completes. Matches by `turnId` when present; otherwise falls back to a
 * single unambiguous empty stream or an `authorAgentId` match. Never removes
 * bubbles with visible text or unrelated agents' streams.
 */
export function removeEmptyStreamingAssistantPlaceholder(
  items: ChatItem[],
  opts: { turnId?: string; authorAgentId?: string },
): ChatItem[] {
  const { turnId, authorAgentId } = opts;
  const emptyStreams = items.filter(isEmptyStreamingAssistantBubble);
  if (emptyStreams.length === 0) return items;

  const shouldRemove = (item: MessageItem): boolean => {
    if (turnId !== undefined) {
      if (item.turnId !== turnId) return false;
      if (
        authorAgentId !== undefined &&
        item.authorAgentId !== undefined &&
        item.authorAgentId !== authorAgentId
      ) {
        return false;
      }
      return true;
    }
    if (authorAgentId !== undefined) {
      return item.authorAgentId === authorAgentId;
    }
    return emptyStreams.length === 1 && emptyStreams[0] === item;
  };

  let removed = false;
  const next = items.filter((item) => {
    if (!isEmptyStreamingAssistantBubble(item)) return true;
    if (shouldRemove(item)) {
      removed = true;
      return false;
    }
    return true;
  });
  return removed ? next : items;
}

/**
 * PURE reducer: apply a single ServerEvent to the current ChatItem[] and
 * return a new array. Never mutates the input. The screen has already
 * filtered the event to this room (via `roomIdFromLaneKey` / `event.roomId`)
 * before calling this — the reducer only does model-level reconciliation.
 */
export function applyStreamEvent(
  items: ChatItem[],
  event: ServerEvent,
): ChatItem[] {
  if (isProtectedMessageRealtimeEventV2(event)) return items;

  switch (event.type) {
    case "message.deleted": {
      // The room subscription may receive our own delete after local state
      // already converged. Filtering is therefore deliberately idempotent.
      const next = items.filter(
        (item) => item.kind !== "message" || item.id !== String(event.messageId),
      );
      return next.length === items.length ? items : next;
    }

    case "message.tokens": {
      const turnId = event.turnId;
      const content = event.content ?? "";
      // Desktop parity: only materialize a stream bubble on non-empty content.
      // Reaction-only turns emit empty token frames; the reaction chip is the
      // durable acknowledgement and must not leave a blank assistant bubble.
      if (content.length === 0) return items;
      const idx =
        turnId !== undefined
          ? items.findIndex(
              (it): it is MessageItem =>
                it.kind === "message" &&
                it.role === "assistant" &&
                it.turnId === turnId,
            )
          : findLastIndex(
              items,
              (it): it is MessageItem =>
                it.kind === "message" && it.role === "assistant",
            );
      if (idx === -1) {
        const key = turnId ?? event.laneKey ?? "anon";
        const presentationKey = nextStreamingPresentationKey(items, key);
        const now = new Date().toISOString();
        const bubble: MessageItem = {
          kind: "message",
          id: `streaming:${key}`,
          presentationKey,
          role: "assistant",
          text: content,
          createdAt: now,
          turnId: turnId,
        };
        if (event.authorAgentId) bubble.authorAgentId = event.authorAgentId;
        return [...items, bubble];
      }
      const existing = items[idx] as MessageItem;
      const updated: MessageItem = {
        ...existing,
        text: existing.text + content,
      };
      // `done` marks the stream settled; the bubble keeps its streaming
      // id until `message.new` finalizes it with the persisted id.
      const next = items.slice();
      next[idx] = updated;
      return next;
    }

    case "message.new": {
      const role = normalizeRole(event.role);
      const text = event.content ?? "";
      // A history load can race the authoritative WS event. Merge its complete
      // message fields into the existing row while retaining client-only
      // attachment preview URIs and reaction state that the event does not send.
      const persistedIdx = items.findIndex(
        (it): it is MessageItem =>
          it.kind === "message" && it.id === event.messageId,
      );
      if (persistedIdx !== -1) {
        const target = items[persistedIdx] as MessageItem;
        const staleEdit = isIncomingEditRevisionStale(
          target,
          event.editRevision,
        );
        const replacement: MessageItem = {
          ...target,
          sentAt: event.createdAt ?? target.sentAt,
          role,
          text: staleEdit ? target.text : text,
          status: "sent",
          clientId: undefined,
          turnId: undefined,
        };
        if (!staleEdit) delete replacement.editContent;
        applyMessageNewEditMetadata(replacement, event, staleEdit);
        if (role === "user" && typeof event.sourceUserId === "string") {
          replacement.sourceUserId = event.sourceUserId;
        }
        if (role === "assistant" && typeof event.authorAgentId === "string") {
          replacement.authorAgentId = event.authorAgentId;
        }
        if (typeof event.replyToMessageId === "number") {
          replacement.replyToMessageId = event.replyToMessageId;
        }
        if (event.artifacts !== undefined) {
          replacement.artifacts = uniqueArtifacts(event.artifacts);
        }
        const next = items.slice();
        next[persistedIdx] = replacement;
        return next;
      }

      if (role === "user") {
        // Reconcile our own echoed message with the optimistic bubble. We match
        // any un-reconciled optimistic item (one that still carries a clientId),
        // NOT just `status === "pending"` — the local send may have already
        // flipped it to "sent", and the send API can return a null messageId
        // (so id-matching alone misses and we'd append a duplicate). Prefer an
        // exact text match; fall back to the oldest outstanding optimistic.
        // Clearing clientId marks it reconciled so a re-delivery can't match twice.
        const byText = findLastIndex(
          items,
          (it): it is MessageItem =>
            it.kind === "message" &&
            it.role === "user" &&
            it.clientId !== undefined &&
            it.text === text,
        );
        const reconcileIdx =
          byText !== -1
            ? byText
            : items.findIndex(
                (it): it is MessageItem =>
                  it.kind === "message" &&
                  it.role === "user" &&
                  it.clientId !== undefined,
              );
        if (reconcileIdx !== -1) {
          const target = items[reconcileIdx] as MessageItem;
          // D382 — preserve optimistic `attachments` (server echo carries
          // no URIs); the spread keeps them on the replacement.
          const replacement: MessageItem = {
            ...target,
            sentAt: event.createdAt,
            id: event.messageId,
            text,
            status: "sent",
            clientId: undefined,
          };
          applyMessageNewEditMetadata(replacement, event, false);
          if (
            typeof event.sourceUserId === "string" &&
            event.sourceUserId.length > 0
          ) {
            replacement.sourceUserId = event.sourceUserId;
          }
          if (typeof event.replyToMessageId === "number") {
            replacement.replyToMessageId = event.replyToMessageId;
          }
          if (event.artifacts !== undefined) {
            replacement.artifacts = uniqueArtifacts(event.artifacts);
          }
          const next = items.slice();
          next[reconcileIdx] = replacement;
          return next;
        }
        const now = new Date().toISOString();
        const fresh: MessageItem = {
          kind: "message",
          id: event.messageId,
          role,
          text,
          createdAt: now,
          sentAt: event.createdAt,
          status: "sent",
        };
        applyMessageNewEditMetadata(fresh, event, false);
        if (
          typeof event.sourceUserId === "string" &&
          event.sourceUserId.length > 0
        ) {
          fresh.sourceUserId = event.sourceUserId;
        }
        if (typeof event.replyToMessageId === "number") {
          fresh.replyToMessageId = event.replyToMessageId;
        }
        const artifacts = uniqueArtifacts(event.artifacts);
        if (artifacts) fresh.artifacts = artifacts;
        return [...items, fresh];
      }

      if (role === "assistant") {
        // Finalize the most-recent streaming assistant bubble, if any.
        const streamIdx = findLastIndex(items, isStreamingAssistant);
        if (streamIdx !== -1) {
          const target = items[streamIdx] as MessageItem;
          const replacement: MessageItem = {
            ...target,
            sentAt: event.createdAt,
            id: event.messageId,
            text,
            status: "sent",
            turnId: undefined,
          };
          applyMessageNewEditMetadata(replacement, event, false);
          if (event.authorAgentId)
            replacement.authorAgentId = event.authorAgentId;
          if (typeof event.replyToMessageId === "number") {
            replacement.replyToMessageId = event.replyToMessageId;
          }
          const next = items.slice();
          next[streamIdx] = replacement;
          return next;
        }
        const now = new Date().toISOString();
        const fresh: MessageItem = {
          kind: "message",
          id: event.messageId,
          role,
          text,
          createdAt: now,
          sentAt: event.createdAt,
          status: "sent",
        };
        applyMessageNewEditMetadata(fresh, event, false);
        if (event.authorAgentId) fresh.authorAgentId = event.authorAgentId;
        if (typeof event.replyToMessageId === "number") {
          fresh.replyToMessageId = event.replyToMessageId;
        }
        return [...items, fresh];
      }

      // system
      const now = new Date().toISOString();
      const fresh: MessageItem = {
        kind: "message",
        id: event.messageId,
        role,
        text,
        createdAt: now,
        status: "sent",
      };
      applyMessageNewEditMetadata(fresh, event, false);
      if (typeof event.replyToMessageId === "number") {
        fresh.replyToMessageId = event.replyToMessageId;
      }
      return [...items, fresh];
    }

    case "message.updated": {
      let changed = false;
      const next = items.map((item) => {
        if (
          item.kind !== "message" ||
          item.logicalMessageKey !== event.logicalMessageKey ||
          (typeof item.editRevision === "number" &&
            event.editRevision <= item.editRevision)
        ) {
          return item;
        }
        changed = true;
        const replacement: MessageItem = {
          ...item,
          text: event.content,
          editRevision: event.editRevision,
          editedAt: event.editedAt,
        };
        delete replacement.editContent;
        return replacement;
      });
      return changed ? next : items;
    }

    case "tool.start": {
      const exists = items.some(
        (it) => it.kind === "tool" && it.toolCallId === event.toolCallId,
      );
      if (exists) return items;
      const now = new Date().toISOString();
      const card: ToolItem = {
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "running",
        createdAt: now,
      };
      if (event.argsSummary) card.argsSummary = event.argsSummary;
      return [...items, card];
    }

    case "tool.end": {
      const idx = items.findIndex(
        (it) => it.kind === "tool" && it.toolCallId === event.toolCallId,
      );
      if (idx === -1) {
        // tool.end with no matching tool.start (race / late-arriving start):
        // insert a settled card so the user sees the outcome.
        const now = new Date().toISOString();
        const card: ToolItem = {
          kind: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: event.status,
          createdAt: now,
        };
        if (event.result) card.result = event.result;
        if (event.resultTruncated === true) card.resultTruncated = true;
        if (event.error) card.error = event.error;
        return [...items, card];
      }
      const target = items[idx] as ToolItem;
      const replacement: ToolItem = {
        ...target,
        toolName: event.toolName ?? target.toolName,
        status: event.status,
      };
      if (event.result !== undefined) replacement.result = event.result;
      if (event.resultTruncated !== undefined) replacement.resultTruncated = event.resultTruncated;
      if (event.error !== undefined) replacement.error = event.error;
      const next = items.slice();
      next[idx] = replacement;
      return next;
    }

    default:
      return items;
  }
}

/**
 * One model turn may contain several assistant phases separated by Tool calls.
 * Each phase eventually becomes its own persisted row, so retaining only the
 * turn id as the React presentation key makes the next phase collide with the
 * finalized first phase. Keep the original key for the first phase and add a
 * deterministic ordinal only when that turn already owns a presentation row.
 */
function nextStreamingPresentationKey(
  items: readonly ChatItem[],
  key: string,
): string {
  const base = `streaming:${key}`;
  const used = new Set(
    items.flatMap((item) =>
      item.kind === "message" && item.presentationKey
        ? [item.presentationKey]
        : [],
    ),
  );
  if (!used.has(base)) return base;
  let ordinal = 1;
  while (used.has(`${base}:${ordinal}`)) ordinal += 1;
  return `${base}:${ordinal}`;
}

/** D408 — per-message grouping flags for Telegram-style sender runs. */
export type MessageGroupingFlags = {
  isFirstOfRun: boolean;
  isLastOfRun: boolean;
  showName: boolean;
  showAvatar: boolean;
  isSelf: boolean;
};

function messageSenderKey(item: MessageItem): string | null {
  if (item.role === "system") return null;
  if (item.role === "user") {
    return item.sourceUserId
      ? `user:${item.sourceUserId}`
      : `unknown-user:${item.id}`;
  }
  if (item.role === "assistant") {
    // Legacy assistant rows can lack an author id. Keep each such row in
    // its own run: merging them would attribute potentially different agents
    // to one sender (and imply a real agent avatar that we cannot resolve).
    return item.authorAgentId
      ? `agent:${item.authorAgentId}`
      : `unknown:${item.id}`;
  }
  return null;
}

export function isSelfUserMessage(
  item: MessageItem,
  viewerUserId?: string | null,
): boolean {
  return item.role === "user"
    && viewerUserId != null
    && item.sourceUserId != null
    && item.sourceUserId === viewerUserId;
}

/**
 * Annotate persisted message rows with run-boundary flags. Operates on the
 * ascending (oldest-first) list; callers look up by `message.id`.
 * Tool cards and system rows break consecutive runs.
 */
export function computeMessageGroupings(
  items: readonly ChatItem[],
  viewerUserId?: string | null,
): Map<string, MessageGroupingFlags> {
  const result = new Map<string, MessageGroupingFlags>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "message" || it.role === "system") continue;
    const item = it;
    const senderKey = messageSenderKey(item);
    if (!senderKey) continue;

    // Use direct neighbors in the original ordered list. A tool card or
    // system row therefore breaks a run instead of being filtered out and
    // accidentally joining the messages on either side.
    const previous = items[i - 1];
    const following = items[i + 1];
    const prevSender =
      previous?.kind === "message" && previous.role !== "system"
        ? messageSenderKey(previous)
        : null;
    const nextSender =
      following?.kind === "message" && following.role !== "system"
        ? messageSenderKey(following)
        : null;

    const isFirstOfRun = senderKey !== prevSender;
    const isLastOfRun = senderKey !== nextSender;
    const isSelf = isSelfUserMessage(item, viewerUserId);

    result.set(item.id, {
      isFirstOfRun,
      isLastOfRun,
      showName: isFirstOfRun && !isSelf,
      showAvatar: isLastOfRun && !isSelf,
      isSelf,
    });
  }

  return result;
}
