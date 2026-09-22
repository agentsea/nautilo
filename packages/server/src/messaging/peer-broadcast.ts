import { randomUUID } from "node:crypto";
import {
  appendTranscriptMessages,
  buildForegroundUserHumanMessage,
  getDefaultModel,
} from "@nautilo/agent";
import { and, db, eq, isNull, rooms, sessionMessages, sessions, sessionMessageRecipientState } from "@nautilo/db";
import { log } from "@nautilo/logger";
import { eventBus } from "@nautilo/runtime";
import type { RoomDetailPayload } from "@nautilo/trust";
import {
  logicalMessageKey,
  type ChatAttachmentStatus,
  type ChatMultimodalImagePart,
  type MessageAttachmentRef,
  type MessageArtifactOpenRef,
} from "@nautilo/types";
import {
  hydrateMessageArtifactOpenRefs,
  persistMessageArtifactOpenRefs,
} from "./artifact-refs";
import { linkAndLoadRetainedAttachmentRefs } from "./retained-attachment-refs";

/**
 * D426 — structural view of the root anchor summary that
 * `appendTranscriptMessages` returns when it writes Subthread child rows.
 * Mirrors `AppendTranscriptResult["rootSummary"]` from `@nautilo/agent`
 * (which is not re-exported); kept structural so this module stays decoupled
 * from the agent package's internal types.
 */
export interface RootSummaryDelta {
  parentRoomId: string;
  anchorMessageId: number;
  replyCount: number;
  lastReplyAt: Date | null;
  revision: number;
}

/** Finalize recipient delivery for an already-persisted protected-only Human row. */
export async function finalizeProtectedHumanPeerMessage(args: {
  room: RoomDetailPayload;
  senderUserId: string;
  messageId: number;
  operationId: string;
  attachmentStatuses: ChatAttachmentStatus[];
}): Promise<{ messageId: number; attachments: ChatAttachmentStatus[]; coalesced: true; humanTurnId: string }> {
  const rows = await db.select({
    id: sessionMessages.id,
    role: sessionMessages.role,
    ordinaryContentAbsent: isNull(sessionMessages.content),
    editRevision: sessionMessages.editRevision,
    fingerprint: sessionMessages.fingerprint,
    humanTurnId: sessionMessages.humanTurnId,
    ownerId: sessions.ownerId,
  }).from(sessionMessages).innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId)).where(and(
    eq(sessionMessages.id, args.messageId),
    eq(sessions.roomId, args.room.id),
  )).limit(2);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined || row.role !== "user" || row.ordinaryContentAbsent !== true
    || row.editRevision !== 0 || row.ownerId !== args.senderUserId
    || row.fingerprint !== args.operationId || row.humanTurnId !== args.operationId) {
    throw new Error("Protected Human peer publication identity is unavailable");
  }
  const now = new Date();
  for (const member of args.room.members) {
    if (member.kind !== "user" || !member.userId || member.userId === args.senderUserId) continue;
    await db.insert(sessionMessageRecipientState).values({
      messageId: args.messageId, recipientId: member.userId, deliveredAt: now, readAt: null,
    }).onConflictDoNothing();
  }
  return { messageId: args.messageId, attachments: args.attachmentStatuses, coalesced: true,
    humanTurnId: args.operationId };
}

/**
 * Human-only room: persist one HumanMessage, write recipient-state rows
 * for peer users, emit `message.new` on `room:<id>` (MR4/MR5).
 */
export async function peerBroadcastHumanMessage(args: {
  room: RoomDetailPayload;
  senderUserId: string;
  content: string;
  attachmentTextBlocks: string[];
  multimodalImages: ChatMultimodalImagePart[];
  replyToMessageId?: number | undefined;
  /** M233 — validated current Human recipients selected by composer directives. */
  mentionedHumanUserIds?: readonly string[] | undefined;
  /** Structured Room-wide Human mention intent. */
  mentionEveryone?: boolean | undefined;
  /** Pre-normalized attachment statuses for HTTP response */
  attachmentStatuses: ChatAttachmentStatus[];
  /**
   * D424 — external workspace-artifact ids (legacy `artifactRefs` +
   * `focusedResources` kind `workspace-artifact`) that may become
   * ArtifactOpenCards for this message. Local-file / message-attachment focus
   * refs are never included here.
   */
  workspaceArtifactExternalIds?: readonly string[] | undefined;
  /**
   * D424 — canonical room namespace id (`rooms.namespace_id`) gating which
   * artifacts become cards (only those attached to this namespace). Absent ⇒
   * no cards are authored.
   */
  canonicalRoomNamespaceId?: string | null | undefined;
  /**
   * M295 — exact row already inserted by the Human-peer Shadow admission.
   * Supplying it skips the ordinary writer but preserves the canonical
   * recipient-state, artifact-card, and realtime projection below.
   */
  persistedMessage?: Readonly<{
    createdAt?: string;
    messageId: number;
    content: string;
    fingerprint: string;
    humanTurnId: string;
  }>;
}): Promise<{
  messageId: number;
  attachments: ChatAttachmentStatus[];
  coalesced: boolean;
  /** D302 R13 — the turn fingerprint of this persisted human row. An ask_user
   *  resume reuses it as the bot-turn `sharedTurnId` so the read-time collapse
   *  (getRoomMessagesAcrossMemberSessions) dedupes the re-sent human row. */
  humanTurnId: string;
  /**
   * D426 — present when this append wrote Subthread child rows AND a COUNTED
   * reply was newly inserted, so the root anchor summary was authoritatively
   * recomputed in the same transaction. Carries the post-update
   * `reply_count` / `last_reply_at` / `summary_revision` so a later phase can
   * publish a single authoritative parent-summary delta. Absent on replay
   * (dedup), on non-counted batches, and on non-Subthread rooms.
   */
  rootSummary?: RootSummaryDelta;
}> {
  const { room, senderUserId, content, attachmentTextBlocks, multimodalImages, replyToMessageId } =
    args;
  const humanTurnId = args.persistedMessage?.humanTurnId ?? randomUUID();
  const result: Awaited<ReturnType<typeof appendTranscriptMessages>> = args.persistedMessage === undefined
    ? await appendTranscriptMessages(
      room.graphThreadId,
      senderUserId,
      "owner",
      [buildForegroundUserHumanMessage({
        userText: content,
        attachmentTextBlocks,
        multimodalImages,
        modelId: getDefaultModel().id,
        replyToMessageId: replyToMessageId ?? null,
      })],
      {
        roomId: room.id,
        humanTurnId,
        ...(room.kind === "subthread" ? { subthreadRoomId: room.id } : {}),
        notificationContext: {
          mentionedHumanUserIds: [...(args.mentionedHumanUserIds ?? [])],
          ...(args.mentionEveryone === true ? { mentionEveryone: true } : {}),
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    )
    : {
        failedIndices: [],
        insertedCount: 0,
        insertedRows: [{
          id: String(args.persistedMessage.messageId),
          role: "user",
          content: args.persistedMessage.content,
          fingerprint: args.persistedMessage.fingerprint,
          ...(args.persistedMessage.createdAt ? { createdAt: args.persistedMessage.createdAt } : {}),
          replyToMessageId: replyToMessageId ?? null,
        }],
      };

  const first = result.insertedRows[0];
  if (!first) {
    throw new Error("peerBroadcastHumanMessage: no row inserted (dedup or empty batch)");
  }
  if (first.content === null) {
    throw new Error("Ordinary peer broadcast cannot publish an absent Message representation");
  }
  const messageId = Number(first.id);
  if (!Number.isInteger(messageId) || messageId < 1) {
    throw new Error(`peerBroadcastHumanMessage: invalid message id ${first.id}`);
  }

  const now = new Date();
  for (const m of room.members) {
    if (m.kind !== "user" || !m.userId || m.userId === senderUserId) continue;
    await db
      .insert(sessionMessageRecipientState)
      .values({
        messageId,
        recipientId: m.userId,
        deliveredAt: now,
        readAt: null,
      })
      .onConflictDoNothing();
  }

  // D424 — author ArtifactOpenCards for this user message: persist the
  // durable, pointer-only relation (gated on canonical-room-namespace
  // attachment), then hydrate safe current metadata for the `message.new`
  // event. Best-effort; never blocks the send. Assistant cards are never
  // authored here (this is the human-only path).
  const artifactExternalIds = args.workspaceArtifactExternalIds ?? [];
  const canonicalRoomNamespaceId = args.canonicalRoomNamespaceId ?? null;
  if (artifactExternalIds.length > 0 && canonicalRoomNamespaceId) {
    await persistMessageArtifactOpenRefs({
      messageId,
      externalArtifactIds: artifactExternalIds,
      canonicalRoomNamespaceId,
    });
  }
  let artifacts: MessageArtifactOpenRef[] | undefined;
  if (artifactExternalIds.length > 0 && canonicalRoomNamespaceId) {
    const hydrated = await hydrateMessageArtifactOpenRefs({
      messageId,
      canonicalRoomNamespaceId,
      roomId: room.id,
    });
    if (hydrated.length > 0) artifacts = hydrated;
  }

  let attachments: MessageAttachmentRef[] = [];
  try {
    attachments = await linkAndLoadRetainedAttachmentRefs({
      messageId,
      statuses: args.attachmentStatuses,
      canonicalRoomNamespaceId,
    });
  } catch (error) {
    log(
      `[attachments] retained attachment delivery projection failed for saved message ${messageId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  eventBus.emit({
    type: "message.new",
    laneKey: `room:${room.id}`,
    messageId: String(messageId),
    ...(first.createdAt ? { createdAt: first.createdAt } : {}),
    logicalMessageKey: logicalMessageKey(first),
    editRevision: 0,
    role: "user",
    content: first.content,
    sourceUserId: senderUserId,
    senderUserId: senderUserId,
    ...(replyToMessageId != null ? { replyToMessageId } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
  });

  if (result.rootSummary) {
    eventBus.emit({
      type: "thread.summary.changed",
      laneKey: `room:${result.rootSummary.parentRoomId}`,
      anchorMessageId: result.rootSummary.anchorMessageId,
      replyCount: result.rootSummary.replyCount,
      lastReplyAt: result.rootSummary.lastReplyAt?.toISOString() ?? null,
      summaryRevision: result.rootSummary.revision,
    });
  }

  return {
    messageId,
    attachments: args.attachmentStatuses,
    coalesced: true,
    humanTurnId,
    ...(result.rootSummary ? { rootSummary: result.rootSummary } : {}),
  };
}

export async function roomRowExists(roomId: string): Promise<boolean> {
  const rows = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return rows.length > 0;
}

/**
 * D298 — true when the room is archived (frozen / read-only). Archived rooms
 * reject new messages and the agent turns they would trigger.
 */
export async function roomIsArchived(roomId: string): Promise<boolean> {
  const rows = await db
    .select({ archivedAt: rooms.archivedAt })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  return rows[0]?.archivedAt != null;
}
