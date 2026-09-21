import type { FastifyInstance } from "fastify";
import type { AdvancedVideoWorkcardContinuation, MessageArtifactOpenRef } from "@nautilo/types";
import type {
  ChatSearchPage,
  RoomMessageSearchCursor,
  RoomMessageSearchMode,
  RoomMessageSearchPage,
} from "@nautilo/types";
import {
  roomHistoryShadowReadAcknowledgementRequestV1Schema,
  roomHistoryShadowReadIntentV1Schema,
  roomMessageShadowReadRequestV1Schema,
} from "@nautilo/api-client";
import {
  getLatestSession,
  getLatestSessionForRoom,
  getLatestSessionForRoomAcrossMembers,
  getLatestSessionMessages,
  getRoomMessagesAcrossMemberSessions,
  getRoomMessagesAcrossMemberSessionsWithSelection,
  getRoomMessagesAround,
  normalizeRoomMessageSearchQuery,
  searchChats,
  searchRoomMessages,
  getSessionMessages,
  listReactionsForMessageIds,
  type RoomHistorySelectedMessageCoordinate,
  type ReactionAggregate,
} from "@nautilo/agent";
import {
  getRoomDetailForMember,
  getRoomGraphThreadForViewer,
  getUserCapabilities,
  isUuidString,
} from "@nautilo/trust";
import { getRoomNamespaceId, hydrateMessageArtifacts } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { enrichSessionMessagesForDisplay } from "../lib/session-messages-display.js";
import { canViewOwnSessionTranscripts } from "../lib/session-transcript-access.js";
import { currentStrictShadowPolicy } from "../lib/strict-shadow-policy.js";
import {
  createProductionRoomHistoryShadowReadComposition,
  type RoomHistoryShadowReadComposition,
} from "./room-history-shadow-read-composition.js";

import { selectRoomHistoryResponseMetadata } from "./room-history-response-metadata.js";

export interface SessionRoutesDeps {
  getLatestSession: typeof getLatestSession;
  getLatestSessionForRoom: typeof getLatestSessionForRoom;
  getLatestSessionForRoomAcrossMembers?: typeof getLatestSessionForRoomAcrossMembers;
  getLatestSessionMessages: typeof getLatestSessionMessages;
  getRoomMessagesAcrossMemberSessions: typeof getRoomMessagesAcrossMemberSessions;
  getRoomMessagesAcrossMemberSessionsWithSelection?:
    typeof getRoomMessagesAcrossMemberSessionsWithSelection;
  roomHistoryShadowRead?: RoomHistoryShadowReadComposition;
  getRoomMessagesAround: typeof getRoomMessagesAround;
  searchChats: typeof searchChats;
  searchRoomMessages: typeof searchRoomMessages;
  getSessionMessages: typeof getSessionMessages;
  /**
   * M125 Phase 2.5 — viewer-scoped graph-thread resolver. Pre-M125 the
   * dep was `getRoomGraphThreadForOwnerSession` which required a
   * caller-supplied `defaultAgentId`; routes passed the bootstrap
   * default which scoped the membership join to the operator's agent
   * and 404'd every non-operator room owner.
   */
  getRoomGraphThreadForViewer: typeof getRoomGraphThreadForViewer;
  getRoomDetailForMember: typeof getRoomDetailForMember;
  strictShadowPolicyReader?: typeof currentStrictShadowPolicy;
}

const defaultSessionRoutesDeps: SessionRoutesDeps = {
  getLatestSession,
  getLatestSessionForRoom,
  getLatestSessionForRoomAcrossMembers,
  getLatestSessionMessages,
  getRoomMessagesAcrossMemberSessions,
  getRoomMessagesAcrossMemberSessionsWithSelection,
  getRoomMessagesAround,
  searchChats,
  searchRoomMessages,
  getSessionMessages,
  getRoomGraphThreadForViewer,
  getRoomDetailForMember,
};

let productionHistoryShadowRead: RoomHistoryShadowReadComposition | null = null;
const lazyProductionHistoryShadowRead: RoomHistoryShadowReadComposition = {
  project: (input) => {
    productionHistoryShadowRead ??=
      createProductionRoomHistoryShadowReadComposition();
    return productionHistoryShadowRead.project(input);
  },
  acknowledge: (input) => {
    productionHistoryShadowRead ??=
      createProductionRoomHistoryShadowReadComposition();
    return productionHistoryShadowRead.acknowledge(input);
  },
};
defaultSessionRoutesDeps.roomHistoryShadowRead =
  lazyProductionHistoryShadowRead;

/**
 * M121 — batch-fetch reactions for a message page. Fail-soft: reactions are an
 * additive enrichment, so a read error must never 500 the messages endpoint
 * (and keeps hermetic route unit tests that don't stub the store green).
 */
async function safeReactionsForMessages(
  messages: Array<{ id: string }>,
  userId: string,
): Promise<Map<number, ReactionAggregate[]>> {
  try {
    return await listReactionsForMessageIds({
      messageIds: messages
        .map((m) => Number(m.id))
        .filter((n) => Number.isFinite(n)),
      ctx: { userId, agentId: null },
    });
  } catch {
    return new Map();
  }
}

/**
 * D424 — hydrate server-authored ArtifactOpenCards for a message page. The
 * viewer's room membership is already verified by the route; this re-validates
 * artifact attachment to the canonical room namespace + not-deleted and
 * projects pointer-only `MessageArtifactOpenRef[]` per message. Fail-soft: a
 * read error never 500s the messages endpoint (mirrors reactions).
 */
async function safeArtifactsForMessages(
  messages: Array<{ id: string }>,
  roomId: string,
): Promise<Map<number, MessageArtifactOpenRef[]>> {
  const ids = messages
    .map((m) => Number(m.id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0 || !roomId) return new Map();
  try {
    const canonicalRoomNamespaceId = await getRoomNamespaceId(roomId);
    if (!canonicalRoomNamespaceId) return new Map();
    return await hydrateMessageArtifacts({
      messageIds: ids,
      canonicalRoomNamespaceId,
      roomId,
    });
  } catch {
    return new Map();
  }
}

function pageInfoFromMessages(
  messages: Array<{ id: string; createdAt: Date | string }>,
  hasMoreBefore: boolean,
) {
  const oldest = messages[0];
  return {
    hasMoreBefore,
    oldestCursor: oldest
      ? {
          id: oldest.id,
          createdAt:
            oldest.createdAt instanceof Date
              ? oldest.createdAt.toISOString()
              : oldest.createdAt,
        }
      : null,
  };
}

function isoFromMessageTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type RoomSearchCursorInput = { createdAt: Date; messageId: number } | null;

function positiveIntegerQuery(value: string | undefined, maximum: number): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function parseCompleteCursor(
  query: Record<string, string>,
  createdAtKey: string,
  messageIdKey: string,
): RoomSearchCursorInput | "invalid" {
  const rawCreatedAt = query[createdAtKey];
  const rawMessageId = query[messageIdKey];
  if (rawCreatedAt === undefined && rawMessageId === undefined) return null;
  if (rawCreatedAt === undefined || rawMessageId === undefined) return "invalid";
  const createdAt = new Date(rawCreatedAt);
  const messageId = positiveIntegerQuery(rawMessageId, Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== rawCreatedAt || !messageId) {
    return "invalid";
  }
  return { createdAt, messageId };
}

function serializeRoomSearchCursor(cursor: RoomSearchCursorInput): RoomMessageSearchCursor | null {
  return cursor
    ? { createdAt: cursor.createdAt.toISOString(), messageId: String(cursor.messageId) }
    : null;
}

type AroundDisplayMessage = {
  id: string;
  logicalMessageKey?: string;
  role: string;
  content: string | null;
  toolCalls: string | null;
  createdAt?: Date | string;
  editedAt?: Date | string | null;
  editRevision?: number;
  toolName?: string | null;
  displayContent?: string;
  replyToMessageId?: number | null;
  replyCount?: number;
  lastReplyAt?: Date | string | null;
  summaryRevision?: number;
  sourceUserId?: string;
  authorAgentId?: string;
  authorHarnessId?: string;
  workcardContinuation?: AdvancedVideoWorkcardContinuation | undefined;
};

function serializeRoomMessageForAround(message: AroundDisplayMessage) {
  return {
    id: message.id,
    ...(message.logicalMessageKey ? { logicalMessageKey: message.logicalMessageKey } : {}),
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    createdAt: isoFromMessageTimestamp(message.createdAt ?? null),
    ...(message.editedAt !== undefined
      ? { editedAt: isoFromMessageTimestamp(message.editedAt) }
      : {}),
    ...(typeof message.editRevision === "number"
      ? { editRevision: message.editRevision }
      : {}),
    ...(message.toolName != null && message.toolName !== "" ? { toolName: message.toolName } : {}),
    ...(message.displayContent !== undefined ? { displayContent: message.displayContent } : {}),
    ...(message.replyToMessageId != null ? { replyToMessageId: message.replyToMessageId } : {}),
    ...(typeof message.replyCount === "number" ? { replyCount: message.replyCount } : {}),
    ...(message.lastReplyAt !== undefined ? { lastReplyAt: isoFromMessageTimestamp(message.lastReplyAt) } : {}),
    ...(typeof message.summaryRevision === "number" ? { summaryRevision: message.summaryRevision } : {}),
    ...(typeof message.sourceUserId === "string" && message.sourceUserId.length > 0
      ? { sourceUserId: message.sourceUserId }
      : {}),
    ...(typeof message.authorAgentId === "string" && message.authorAgentId.length > 0
      ? { authorAgentId: message.authorAgentId }
      : {}),
    ...(typeof message.authorHarnessId === "string" && message.authorHarnessId.length > 0
      ? { authorHarnessId: message.authorHarnessId }
      : {}),
    ...(message.workcardContinuation ? { workcardContinuation: message.workcardContinuation } : {}),
  };
}

function isEncryptedOnlyMode(mode: string): boolean {
  return mode === "encrypted_only";
}

export function sessionRoutes(
  app: FastifyInstance,
  deps: SessionRoutesDeps = defaultSessionRoutesDeps,
) {
  app.get("/api/sessions/latest", async (request, reply) => {
    const sessionUserId =
      request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    if (!sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const transitionPolicy = await (deps.strictShadowPolicyReader ?? currentStrictShadowPolicy)();
    if (isEncryptedOnlyMode(transitionPolicy.mode)) {
      return reply.code(503).send({
        code: "protected_history_read_required",
        error: "protected history read is required",
      });
    }

    const query = request.query as Record<string, string>;
    const limit = Math.min(200, Math.max(1, parseInt(query["limit"] ?? "100", 10) || 100));
    const explicitOffset = query["offset"] !== undefined;
    const rawOffset = Math.max(0, parseInt(query["offset"] ?? "0", 10) || 0);
    const roomIdParam = query["roomId"];

    let session: Awaited<ReturnType<typeof getLatestSession>>;
    let roomPage: Awaited<ReturnType<typeof getRoomMessagesAcrossMemberSessions>> | null = null;

    // D106 — opt-in room-scoped history for room switchers. Validate access
    // through the Room graph-thread resolver, then load by sessions.room_id so
    // legacy thread_id shapes backfilled into the Room remain visible.
    if (roomIdParam && isUuidString(roomIdParam)) {
      const sessionActorId = request.sessionActorId;
      const detail = sessionActorId
        ? await deps.getRoomDetailForMember(roomIdParam, sessionActorId)
        : null;
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const loadAcrossMembers = deps.getLatestSessionForRoomAcrossMembers;
      session = loadAcrossMembers
        ? await loadAcrossMembers(sessionUserId, roomIdParam)
        : await deps.getLatestSessionForRoom(sessionUserId, roomIdParam);
      if (session && loadAcrossMembers) {
        roomPage = await deps.getRoomMessagesAcrossMemberSessions({
          ownerId: sessionUserId,
          roomId: roomIdParam,
          beforeCreatedAt: new Date(Date.now() + 60_000),
          beforeId: 2_147_483_647,
          limit,
        });
      }
    } else {
      // The unscoped legacy reader can span Rooms, so it remains Memory-
      // capability gated. Exact Room reads above are authorized by current
      // membership instead (M259).
      const caps = await getUserCapabilities(sessionUserId);
      if (!canViewOwnSessionTranscripts(caps)) {
        return reply.send({ session: null, messages: [] });
      }
      // Pick the owner's most recent session regardless of thread_id
      // convention. Prior to M042B every owner session used the
      // literal thread_id "app:default"; M042B's seedDefaultRoom
      // rewrites that to "room:<roomId>" at boot, and sessions that
      // started life as guests (then got verified) retain their
      // "guest:<id>" thread_id. All three shapes are legitimate owner
      // history — filtering on any single literal silently hides
      // valid sessions (data-loss-on-restore regression). Guest
      // isolation is already enforced by the role check above.
      session = await deps.getLatestSession(sessionUserId);
    }

    if (!session) {
      return reply.send({ session: null, messages: [] });
    }

    const rows = roomPage
      ? roomPage.messages
      : explicitOffset
        ? await deps.getSessionMessages(session.sessionId, limit, rawOffset)
        : await deps.getLatestSessionMessages(session.sessionId, limit);
    const messages = enrichSessionMessagesForDisplay(rows);
    const reactionsByMessage = await safeReactionsForMessages(
      messages,
      request.sessionUserId ?? "",
    );
    // D424 — hydrate ArtifactOpenCards only for the room-scoped latest path
    // (where the canonical room namespace is known). The non-room latest path
    // has no room context on this route; cards are omitted there.
    const artifactsByMessage = roomIdParam && isUuidString(roomIdParam)
      ? await safeArtifactsForMessages(messages, roomIdParam)
      : new Map<number, MessageArtifactOpenRef[]>();

    return reply.send({
      session: {
        id: session.sessionId,
        threadId: session.threadId,
        title: session.title,
        messageCount: session.messageCount,
        startedAt: session.startedAt,
      },
      messages: messages.map((m) => ({
        id: m.id,
        ...(m.logicalMessageKey ? { logicalMessageKey: m.logicalMessageKey } : {}),
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        createdAt: m.createdAt,
        ...(m.editedAt !== undefined
          ? { editedAt: isoFromMessageTimestamp(m.editedAt) }
          : {}),
        ...(typeof m.editRevision === "number"
          ? { editRevision: m.editRevision }
          : {}),
        ...(m.toolName != null && m.toolName !== "" ? { toolName: m.toolName } : {}),
        ...(m.displayContent !== undefined ? { displayContent: m.displayContent } : {}),
        ...(m.replyToMessageId != null && m.replyToMessageId !== undefined
          ? { replyToMessageId: m.replyToMessageId }
          : {}),
        ...(typeof m.sourceUserId === "string" && m.sourceUserId.length > 0
          ? { sourceUserId: m.sourceUserId }
          : {}),
        ...(typeof m.authorAgentId === "string" && m.authorAgentId.length > 0
          ? { authorAgentId: m.authorAgentId }
          : {}),
        ...(typeof m.authorHarnessId === "string" && m.authorHarnessId.length > 0
          ? { authorHarnessId: m.authorHarnessId }
          : {}),
        ...(m.workcardContinuation ? { workcardContinuation: m.workcardContinuation } : {}),
        ...(() => {
          const reactions = reactionsByMessage.get(Number(m.id));
          return reactions && reactions.length > 0 ? { reactions } : {};
        })(),
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        ...(() => {
          const arts = artifactsByMessage.get(Number(m.id));
          return arts && arts.length > 0 ? { artifacts: arts } : {};
        })(),
      })),
      pageInfo: pageInfoFromMessages(
        messages,
        roomPage?.hasMoreBefore ?? (!explicitOffset && messages.length === limit),
      ),
    });
  });

  app.get<{ Params: { id: string } }>("/api/rooms/:id/messages", async (request, reply) => {
    const sessionUserId =
      request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    const sessionActorId = request.sessionActorId;
    if (!sessionUserId || !sessionActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) {
      return reply.code(400).send({ error: "invalid room id" });
    }

    const query = request.query as Record<string, string>;
    const hasShadowReadIntent = query["shadowReadVersion"] !== undefined
      || query["shadowReadRequestKey"] !== undefined
      || query["shadowReadDeviceId"] !== undefined;
    const shadowReadIntent = hasShadowReadIntent
      ? roomHistoryShadowReadIntentV1Schema.safeParse({
        requestVersion: Number(query["shadowReadVersion"]),
        clientRequestKey: query["shadowReadRequestKey"],
        ...(query["shadowReadDeviceId"] === undefined
          ? {}
          : { readerDeviceId: query["shadowReadDeviceId"] }),
      })
      : null;
    if (shadowReadIntent !== null && !shadowReadIntent.success) {
      return reply.code(400).send({ error: "invalid Shadow history read intent" });
    }
    const beforeId = Number.parseInt(query["beforeId"] ?? "", 10);
    const beforeCreatedAtRaw = query["beforeCreatedAt"];
    const beforeCreatedAt =
      beforeCreatedAtRaw !== undefined ? new Date(beforeCreatedAtRaw) : null;
    const limit = Math.min(
      shadowReadIntent === null ? 200 : 50,
      Math.max(1, parseInt(query["limit"] ?? "50", 10) || 50),
    );

    if (
      !Number.isInteger(beforeId) ||
      beforeId <= 0 ||
      !beforeCreatedAt ||
      !Number.isFinite(beforeCreatedAt.getTime())
    ) {
      return reply.code(400).send({ error: "valid beforeId and beforeCreatedAt are required" });
    }

    // D181 cross-member loader fix: gate on ROOM MEMBERSHIP, not on
    // the caller owning their own session in the room. The legacy
    // `getRoomGraphThreadForOwnerSession` check (kept above for the
    // deprecated `/api/sessions/latest?roomId=` route) returns null
    // for any caller that hasn't written messages in the room — which
    // is the entire point of D181's cross-member surface (Casey
    // reloading a two-Human DM as the non-author). Use the same
    // membership check D174's dispatcher uses (`getRoomDetailForMember`)
    // so this route's auth contract matches `POST /api/rooms/:id/messages`.
    const detail = await deps.getRoomDetailForMember(roomId, sessionActorId);
    if (!detail) {
      return reply.code(404).send({ error: "Not found" });
    }

    const transitionPolicy = await (deps.strictShadowPolicyReader ?? currentStrictShadowPolicy)();
    const protectedOnly = isEncryptedOnlyMode(transitionPolicy.mode);
    if (protectedOnly && shadowReadIntent?.success !== true) {
      return reply.code(503).send({
        code: "protected_history_read_intent_required",
        error: "protected history read intent is required",
      });
    }
    if (
      protectedOnly
      && (deps.getRoomMessagesAcrossMemberSessionsWithSelection === undefined
        || deps.roomHistoryShadowRead === undefined)
    ) {
      return reply.code(503).send({
        code: "protected_history_read_unavailable",
        error: "protected history read is unavailable",
      });
    }

    const selectedPage = (protectedOnly || shadowReadIntent !== null)
        && deps.getRoomMessagesAcrossMemberSessionsWithSelection !== undefined
      ? await deps.getRoomMessagesAcrossMemberSessionsWithSelection({
        ownerId: sessionUserId,
        roomId,
        beforeCreatedAt,
        beforeId,
        limit,
        ...(protectedOnly ? { contentRepresentation: "structural" as const } : {}),
      })
      : null;
    const page = selectedPage ?? await deps.getRoomMessagesAcrossMemberSessions({
        ownerId: sessionUserId,
        roomId,
        beforeCreatedAt,
        beforeId,
        limit,
      });
    const selectedCoordinates:
      readonly RoomHistorySelectedMessageCoordinate[] | null =
        selectedPage?.selectedCoordinates ?? null;
    const messages = enrichSessionMessagesForDisplay(page.messages);
    const reactionsByMessage = await safeReactionsForMessages(
      messages,
      request.sessionUserId ?? "",
    );
    // D424 — hydrate server-authored ArtifactOpenCards. Viewer room membership
    // is verified above (`getRoomDetailForMember`); this re-validates artifact
    // attachment to the canonical room namespace + not-deleted, pointer-only.
    const artifactsByMessage = await safeArtifactsForMessages(messages, roomId);
    let shadowEncryption;
    if (
      shadowReadIntent?.success === true
      && deps.roomHistoryShadowRead !== undefined
      && selectedCoordinates !== null
      && messages.length > 0
    ) {
      try {
        shadowEncryption = selectRoomHistoryResponseMetadata(await deps.roomHistoryShadowRead.project({
          authority: {
            userId: sessionUserId,
            humanActorId: sessionActorId,
          },
          roomId,
          readerDeviceId:
            shadowReadIntent.data.readerDeviceId ?? null,
          clientRequestKey: shadowReadIntent.data.clientRequestKey,
          selectedCoordinates,
          now: Date.now(),
        }), request.query);
      } catch (error) {
        // The ordinary Room page is authoritative during Shadow transition.
        // Unexpected protected-path failures must never replace it with a 500.
        warn(
          `[history-read] projection failed for Room ${roomId}: ${
            error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"
          }`,
        );
        request.log.warn({
          err: error,
          roomId,
        }, "Room history Shadow projection failed; serving ordinary page");
      }
    }
    return reply.send({
      messages: messages.map((m) => ({
        id: m.id,
        ...(m.logicalMessageKey ? { logicalMessageKey: m.logicalMessageKey } : {}),
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        createdAt: m.createdAt,
        ...(m.editedAt !== undefined
          ? { editedAt: isoFromMessageTimestamp(m.editedAt) }
          : {}),
        ...(typeof m.editRevision === "number"
          ? { editRevision: m.editRevision }
          : {}),
        ...(m.toolName != null && m.toolName !== "" ? { toolName: m.toolName } : {}),
        ...(m.displayContent !== undefined ? { displayContent: m.displayContent } : {}),
        ...(m.replyToMessageId != null && m.replyToMessageId !== undefined
          ? { replyToMessageId: m.replyToMessageId }
          : {}),
        ...(typeof m.replyCount === "number" ? { replyCount: m.replyCount } : {}),
        ...(m.lastReplyAt !== undefined
          ? { lastReplyAt: isoFromMessageTimestamp(m.lastReplyAt) }
          : {}),
        ...(typeof m.summaryRevision === "number"
          ? { summaryRevision: m.summaryRevision }
          : {}),
        ...(typeof m.sourceUserId === "string" && m.sourceUserId.length > 0
          ? { sourceUserId: m.sourceUserId }
          : {}),
        ...(typeof m.authorAgentId === "string" && m.authorAgentId.length > 0
          ? { authorAgentId: m.authorAgentId }
          : {}),
        ...(typeof m.authorHarnessId === "string" && m.authorHarnessId.length > 0
          ? { authorHarnessId: m.authorHarnessId }
          : {}),
        ...(m.workcardContinuation ? { workcardContinuation: m.workcardContinuation } : {}),
        ...(() => {
          const reactions = reactionsByMessage.get(Number(m.id));
          return reactions && reactions.length > 0 ? { reactions } : {};
        })(),
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        ...(() => {
          const arts = artifactsByMessage.get(Number(m.id));
          return arts && arts.length > 0 ? { artifacts: arts } : {};
        })(),
      })),
      pageInfo: pageInfoFromMessages(messages, page.hasMoreBefore),
      ...(shadowEncryption === undefined ? {} : { shadowEncryption }),
    });
  });

  app.post<{
    Params: { id: string };
    Body: unknown;
  }>("/api/rooms/:id/messages/shadow-read", async (request, reply) => {
    const sessionUserId = request.sessionUserId;
    const sessionActorId = request.sessionActorId;
    if (!sessionUserId || !sessionActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!isUuidString(request.params.id)) {
      return reply.code(400).send({ error: "invalid room id" });
    }
    const parsed = roomMessageShadowReadRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid exact history read" });
    const detail = await deps.getRoomDetailForMember(request.params.id, sessionActorId);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    if (deps.roomHistoryShadowRead === undefined) {
      return reply.code(503).send({ error: "history read unavailable" });
    }
    return reply.send(selectRoomHistoryResponseMetadata(await deps.roomHistoryShadowRead.project({
      authority: { userId: sessionUserId, humanActorId: sessionActorId },
      roomId: request.params.id,
      readerDeviceId: parsed.data.intent.readerDeviceId ?? null,
      clientRequestKey: parsed.data.intent.clientRequestKey,
      selectedCoordinates: [parsed.data.coordinate],
      now: Date.now(),
    }), request.query));
  });

  app.post<{
    Params: { id: string; operationId: string };
    Body: unknown;
  }>(
    "/api/rooms/:id/messages/shadow-read/:operationId/ack",
    async (request, reply) => {
      const sessionUserId = request.sessionUserId;
      const sessionActorId = request.sessionActorId;
      if (!sessionUserId || !sessionActorId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!isUuidString(request.params.id)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      const parsed = roomHistoryShadowReadAcknowledgementRequestV1Schema
        .safeParse(request.body);
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.operationId
      ) return reply.code(400).send({ error: "invalid history read acknowledgement" });
      const detail = await deps.getRoomDetailForMember(
        request.params.id,
        sessionActorId,
      );
      if (!detail) return reply.code(404).send({ error: "Not found" });
      if (deps.roomHistoryShadowRead === undefined) {
        return reply.code(503).send({ error: "history read acknowledgement unavailable" });
      }
      const result = await deps.roomHistoryShadowRead.acknowledge({
        authority: { userId: sessionUserId, humanActorId: sessionActorId },
        roomId: request.params.id,
        operationId: request.params.operationId,
        request: parsed.data,
        now: Date.now(),
      });
      return result === null
        ? reply.code(409).send({ error: "history read acknowledgement conflict" })
        : reply.send(result);
    },
  );

  app.get<{ Params: { id: string } }>("/api/rooms/:id/messages/search", async (request, reply) => {
    const sessionUserId = request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    const sessionActorId = request.sessionActorId;
    if (!sessionUserId || !sessionActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const transitionPolicy = await (deps.strictShadowPolicyReader ?? currentStrictShadowPolicy)();
    if (isEncryptedOnlyMode(transitionPolicy.mode)) {
      return reply.code(503).send({ code: "protected_search_unavailable", error: "protected search is unavailable" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) return reply.code(400).send({ error: "invalid room id" });

    const query = request.query as Record<string, string>;
    const mode = query["mode"];
    const searchText = query["query"];
    const ignoreCase = query["ignoreCase"] === undefined || query["ignoreCase"] === "true"
      ? true
      : query["ignoreCase"] === "false"
        ? false
        : null;
    const limit = query["limit"] === undefined ? 20 : positiveIntegerQuery(query["limit"], 50);
    const cursor = parseCompleteCursor(query, "cursorCreatedAt", "cursorMessageId");
    const asOf = parseCompleteCursor(query, "asOfCreatedAt", "asOfMessageId");
    const normalizedSearch = searchText === undefined ? null : normalizeRoomMessageSearchQuery(searchText);
    if (mode !== "whole" && mode !== "prefix") return reply.code(400).send({ code: "invalid_search_mode", error: "valid mode is required" });
    if (ignoreCase === null) return reply.code(400).send({ code: "invalid_search_case", error: "ignoreCase must be true or false" });
    if (!normalizedSearch?.ok) return reply.code(400).send({ code: "invalid_search_query", error: "valid query is required" });
    if (!limit) return reply.code(400).send({ code: "invalid_search_limit", error: "valid limit is required" });
    if (cursor === "invalid" || asOf === "invalid") return reply.code(400).send({ code: "invalid_search_cursor", error: "complete cursor and asOf tuples are required" });
    if ((cursor === null) !== (asOf === null)) return reply.code(400).send({ code: "invalid_search_as_of", error: "cursor and asOf must appear together" });
    const validatedSearchText = normalizedSearch.query.wholeText;
    const validatedMode: RoomMessageSearchMode = mode;

    const detail = await deps.getRoomDetailForMember(roomId, sessionActorId);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    const page = await deps.searchRoomMessages({
      ownerId: sessionUserId,
      roomId,
      query: validatedSearchText,
      mode: validatedMode,
      ignoreCase,
      limit,
      cursor,
      asOf,
    });
    if ("validationError" in page) return reply.code(400).send({ code: "invalid_search_query", error: page.validationError.message });
    const response: RoomMessageSearchPage = {
      hits: page.hits.map((hit) => ({
        messageId: String(hit.messageId),
        createdAt: hit.createdAt.toISOString(),
        role: hit.role,
        snippet: hit.snippet,
        ...(hit.toolName ? { toolName: hit.toolName } : {}),
        ...(hit.sourceUserId ? { sourceUserId: hit.sourceUserId } : {}),
        ...(hit.authorAgentId ? { authorAgentId: hit.authorAgentId } : {}),
        ...(hit.authorActorId ? { authorActorId: hit.authorActorId } : {}),
        ...(hit.authorDisplayName ? { authorDisplayName: hit.authorDisplayName } : {}),
        ...(hit.authorHandle ? { authorHandle: hit.authorHandle } : {}),
      })),
      asOf: serializeRoomSearchCursor(page.asOf),
      nextOlderCursor: serializeRoomSearchCursor(page.nextOlderCursor),
      hasMoreOlder: page.hasMoreOlder,
    };
    return reply.send(response);
  });

  /** D470 — fetch exactly one authorized, cursor-paged Chats-wide search page. */
  app.get("/api/rooms/search", async (request, reply) => {
    const sessionUserId = request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    const sessionActorId = request.sessionActorId;
    if (!sessionUserId || !sessionActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (isEncryptedOnlyMode((await (deps.strictShadowPolicyReader ?? currentStrictShadowPolicy)()).mode)) {
      return reply.code(503).send({ code: "protected_search_unavailable", error: "protected search is unavailable" });
    }
    const caps = await getUserCapabilities(sessionUserId);
    if (!canViewOwnSessionTranscripts(caps)) {
      return reply.send({
        conversations: [],
        conversationsTruncated: false,
        messages: [],
        messageAsOf: null,
        nextOlderMessageCursor: null,
        hasMoreOlderMessages: false,
      } satisfies ChatSearchPage);
    }

    const query = request.query as Record<string, string>;
    const mode = query["mode"];
    const archiveScope = query["archiveScope"] ?? "active";
    const searchText = query["query"];
    const ignoreCase = query["ignoreCase"] === undefined || query["ignoreCase"] === "true"
      ? true
      : query["ignoreCase"] === "false"
        ? false
        : null;
    const limit = query["limit"] === undefined ? 20 : positiveIntegerQuery(query["limit"], 50);
    const cursor = parseCompleteCursor(query, "cursorCreatedAt", "cursorMessageId");
    const asOf = parseCompleteCursor(query, "asOfCreatedAt", "asOfMessageId");
    const normalizedSearch = searchText === undefined ? null : normalizeRoomMessageSearchQuery(searchText);
    if (mode !== "whole" && mode !== "prefix") return reply.code(400).send({ code: "invalid_search_mode", error: "valid mode is required" });
    if (archiveScope !== "active" && archiveScope !== "archived" && archiveScope !== "all") {
      return reply.code(400).send({ code: "invalid_search_archive_scope", error: "valid archiveScope is required" });
    }
    if (ignoreCase === null) return reply.code(400).send({ code: "invalid_search_case", error: "ignoreCase must be true or false" });
    if (!normalizedSearch?.ok) return reply.code(400).send({ code: "invalid_search_query", error: "valid query is required" });
    if (!limit) return reply.code(400).send({ code: "invalid_search_limit", error: "valid limit is required" });
    if (cursor === "invalid" || asOf === "invalid") return reply.code(400).send({ code: "invalid_search_cursor", error: "complete cursor and asOf tuples are required" });
    if ((cursor === null) !== (asOf === null)) return reply.code(400).send({ code: "invalid_search_as_of", error: "cursor and asOf must appear together" });

    const page = await deps.searchChats({
      ownerId: sessionUserId,
      viewerActorId: sessionActorId,
      query: normalizedSearch.query.wholeText,
      mode,
      archiveScope,
      ignoreCase,
      limit,
      cursor,
      asOf,
    });
    if ("validationError" in page) {
      return reply.code(400).send({ code: "invalid_search_query", error: page.validationError.message });
    }
    const response: ChatSearchPage = {
      conversations: page.conversations.map((hit) => ({
        room: {
          id: hit.room.id,
          label: hit.room.label,
          type: hit.room.type,
          graphThreadId: hit.room.graphThreadId,
          createdAt: hit.room.createdAt.toISOString(),
          memberCount: hit.room.memberCount,
          kind: hit.room.kind,
          parentRoomId: hit.room.parentRoomId,
          threadRootMessageId: hit.room.threadRootMessageId,
          roster: hit.room.roster.map((member) => ({
            actorId: member.actorId,
            kind: member.kind,
            displayName: member.displayName,
            handle: member.handle,
            ...(member.userId ? { userId: member.userId } : {}),
            ...(member.agentId ? { agentId: member.agentId } : {}),
          })),
        },
        matchedBy: hit.matchedBy,
      })),
      conversationsTruncated: page.conversationsTruncated,
      messages: page.messages.map((hit) => ({
        messageId: String(hit.messageId),
        createdAt: hit.createdAt.toISOString(),
        role: hit.role,
        snippet: hit.snippet,
        ...(hit.toolName ? { toolName: hit.toolName } : {}),
        ...(hit.sourceUserId ? { sourceUserId: hit.sourceUserId } : {}),
        ...(hit.authorAgentId ? { authorAgentId: hit.authorAgentId } : {}),
        ...(hit.authorActorId ? { authorActorId: hit.authorActorId } : {}),
        ...(hit.authorDisplayName ? { authorDisplayName: hit.authorDisplayName } : {}),
        ...(hit.authorHandle ? { authorHandle: hit.authorHandle } : {}),
        roomId: hit.roomId,
        roomLabel: hit.roomLabel,
        roomKind: hit.roomKind,
        ...(hit.parentRoomId ? { parentRoomId: hit.parentRoomId } : {}),
        ...(hit.parentRoomLabel ? { parentRoomLabel: hit.parentRoomLabel } : {}),
      })),
      messageAsOf: serializeRoomSearchCursor(page.messageAsOf),
      nextOlderMessageCursor: serializeRoomSearchCursor(page.nextOlderMessageCursor),
      hasMoreOlderMessages: page.hasMoreOlderMessages,
    };
    return reply.send(response);
  });

  app.get<{ Params: { id: string; messageId: string } }>("/api/rooms/:id/messages/:messageId/around", async (request, reply) => {
    const sessionUserId = request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    const sessionActorId = request.sessionActorId;
    if (!sessionUserId || !sessionActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (isEncryptedOnlyMode((await (deps.strictShadowPolicyReader ?? currentStrictShadowPolicy)()).mode)) {
      return reply.code(503).send({ code: "protected_history_read_required", error: "protected history read is required" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) return reply.code(400).send({ error: "invalid room id" });

    const messageId = positiveIntegerQuery(request.params.messageId, Number.MAX_SAFE_INTEGER);
    const query = request.query as Record<string, string>;
    const hasShadowReadIntent = query["shadowReadVersion"] !== undefined
      || query["shadowReadRequestKey"] !== undefined
      || query["shadowReadDeviceId"] !== undefined;
    const shadowReadIntent = hasShadowReadIntent
      ? roomHistoryShadowReadIntentV1Schema.safeParse({
        requestVersion: Number(query["shadowReadVersion"]),
        clientRequestKey: query["shadowReadRequestKey"],
        ...(query["shadowReadDeviceId"] === undefined ? {} : { readerDeviceId: query["shadowReadDeviceId"] }),
      })
      : null;
    if (shadowReadIntent !== null && !shadowReadIntent.success) return reply.code(400).send({ error: "invalid shadow read intent" });
    const limit = query["limit"] === undefined ? 100 : positiveIntegerQuery(query["limit"], 100);
    if (!messageId) return reply.code(400).send({ code: "invalid_message_id", error: "valid message id is required" });
    if (!limit) return reply.code(400).send({ code: "invalid_around_limit", error: "valid limit is required" });

    const detail = await deps.getRoomDetailForMember(roomId, sessionActorId);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    const page = await deps.getRoomMessagesAround({ ownerId: sessionUserId, roomId, messageId, limit });
    if (!page) return reply.code(404).send({ error: "Not found" });
    const messages = enrichSessionMessagesForDisplay(page.messages);
    const shadowEncryption = shadowReadIntent?.success === true && deps.roomHistoryShadowRead !== undefined
      ? selectRoomHistoryResponseMetadata(await deps.roomHistoryShadowRead.project({
        authority: { userId: sessionUserId, humanActorId: sessionActorId },
        roomId,
        readerDeviceId: shadowReadIntent.data.readerDeviceId ?? null,
        clientRequestKey: shadowReadIntent.data.clientRequestKey,
        selectedCoordinates: page.selectedCoordinates,
        now: Date.now(),
      }), request.query)
      : undefined;
    // D430 1.2b deliberately does not hydrate attachments/artifacts; the
    // around reader's bounded transcript shape is sufficient for navigation.
    return reply.send({
      messages: messages.map(serializeRoomMessageForAround),
      target: serializeRoomSearchCursor(page.target),
      includedToolCallCompanion: page.includedToolCallCompanion,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      ...(shadowEncryption === undefined ? {} : { shadowEncryption }),
    });
  });
}
