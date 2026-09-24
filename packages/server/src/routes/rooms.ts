import type { FastifyInstance, FastifyRequest } from "fastify";
import { homedir } from "node:os";
import { join } from "node:path";
import { warn } from "@nautilo/logger";
import {
  addReaction,
  removeReaction,
  listReactionsForMessage,
} from "@nautilo/agent";
import type {
  ListRoomsResponse,
  CreateRoomRequest,
  RenameRoomRequest,
  SetRoomVisibilityRequest,
  SetRoomConductorModeRequest,
  SetRoomConductorModeResponse,
  UpdateRoomMemberRequest,
  UpdateRoomMemberResponse,
  ThreadDetailResponse,
  EditRoomMessageRequest,
  RoomMembershipSystemEventPayload,
} from "@nautilo/types";
import { isProtectedTopLevelRoomKind, logicalMessageKey } from "@nautilo/types";
import { isValidEmojiString, SHELL_AVATAR_REF } from "@nautilo/types";
import {
  listRoomsForActor,
  getRoomDetailForMember,
  getSubthreadDetailForMember,
  getSubthreadDetailForMemberWithDb,
  createRoomForOwner,
  renamePrivateRoomForOwner,
  listManageableRoomsForUser,
  getRoomDetailForManager,
  isUuidString,
  userHasCapability,
  getUserCapabilities,
  type RoomSummaryRow,
  type RoomDetailPayload,
  type SubthreadDetailPayload,
  addRoomMember,
  removeRoomMember,
  updateRoomMemberAgentResponseMode,
  updateRoomConductorMode,
  listAddableUsersForRoom,
  listAddableAgentsForRoom,
  listDirectoryHumans,
  searchDirectory,
  findAgentById,
  findActorById,
  findActorByOwnerId,
  MembershipOpError,
  ModerationError,
  findPersonalAgentsForUser,
  assertCanCreateRoomMembers,
  CreateRoomReachabilityError,
  listDiscoverableRoomsForUser,
  joinOpenRoom,
  createOpenRoom,
  findOtherAdminMembers,
  findRoomOwnerUserId,
  findCanonicalActiveServerOwner,
  findOrCreateHumanOnlyDirectRoom,
  loadActiveFoci,
  loadRecentFocusBotActorIds,
  openOrExtendFocus,
  clearFocus,
  isMessageInRoom as isMessageInRoomQuery,
  markRoomRead,
  assertUserCanDeleteMessage,
  MessageDeleteError,
  editHumanRoomMessage,
  MessageEditError,
  humanPairIsBlocked,
} from "@nautilo/trust";
import {
  actors,
  EncryptionPublicationPolicyError,
  acquireEncryptionConsumptionFence,
  encryptionTransitionPolicy,
  getSharedDirectDb,
  eq,
  profiles,
  roomMembers,
  rooms,
} from "@nautilo/db";
import {
  createRoomFromMembers,
  createSubthreadRoom,
  listSubthreadsForRoom,
  updateRoomMemberRole,
  updateRoomVisibility,
} from "../../../trust/src/queries";
import {
  setRoomSilence,
  clearRoomSilence,
  loadActiveRoomSilence,
  finalizeExpiredSilenceWindows,
  scheduleSilenceWindowExpiry,
  cancelAllSilenceWindowExpiryForRoom,
  type ActiveRoomSilenceDto,
} from "../../../trust/src/room-silence";
import type { HumanMembershipEventProducer } from "../event-feed/membership-producer";
import {
  assertCallerCanManageRoom,
  ManageForbiddenError,
  type RoomManagementAuthority,
} from "../lib/agent-room-authz";
import { writeSecurityAuditEvent, type SecurityAuditEvent } from "../lib/security-audit-log";
import { sendAvatar } from "./_helpers/avatar";
import {
  refreshRoomSubscriptionsForUser,
  convergeHumanRoomCatalogs,
  publishRoomCatalogChanged,
  publishRoomMembersChanged,
  publishRoomSilenceChanged,
  publishRoomConductorModeChanged,
  recomputeAndPublishNotificationState,
  publishMessageUpdated,
} from "../realtime/ws-publisher";
import { eventBus } from "@nautilo/runtime";
import { dispatchRoomMessageSend, type RoomPostMessageBody } from "../messaging/dispatch";
import {
  admitOrdinaryOrigin,
  ELECTRON_ORDINARY_ORIGIN_HEADER,
  MOBILE_ORDINARY_ORIGIN_HEADER,
} from "../remote-control/ordinary-origin-admission";
import { deleteMessageWithConvergence } from "../messaging/message-deletion";
import {
  requireAgentInvocation,
  type AssertCanInvokeAgent,
} from "../lib/agent-invocation-admission";
import { liveShadowLargeRequestRouteOptions } from
  "./live-shadow-request-boundary";
import {
  humanMessageEditPlanRequestV1Schema,
  humanMessageEditPreparedRequestV1Schema,
  type HumanMessageEditPlanResponseV1,
  type HumanMessageEditPreparedResponseV1,
} from "@nautilo/api-client";

/**
 * M259 — Room participation is location authority, not Memory authority.
 * These routes separately prove exact Actor membership through their query;
 * this predicate only rejects anonymous/invalid-bearer callers before that
 * membership lookup. Never reintroduce a Role or `read_memories` proxy here.
 */
function viewerIsAuthenticatedHuman(userId: string | null | undefined): boolean {
  return typeof userId === "string" && userId.length > 0;
}

/** D279 Phase 3.6 — precise expiry: finalize rows + push WS (timer callback). */
async function handleRoomSilenceExpiry(roomId: string): Promise<void> {
  const db = getSharedDirectDb();
  try {
    const now = new Date();
    await finalizeExpiredSilenceWindows(db, roomId, now);
    const silence = await loadActiveRoomSilence(db, roomId, now);
    publishRoomSilenceChanged(roomId, silence);
  } catch (err) {
    warn(
      `[rooms] silence expiry handler failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
  }
}

function publishAndScheduleRoomSilence(
  roomId: string,
  silence: ActiveRoomSilenceDto,
  now: Date,
): void {
  publishRoomSilenceChanged(roomId, silence);
  scheduleSilenceWindowExpiry({
    roomId,
    windowId: silence.id,
    expiresAt: new Date(silence.expiresAt),
    now,
    onExpired: (rid) => {
      void handleRoomSilenceExpiry(rid);
    },
  });
}

export type RoomsRouteService = {
  /** Optional authorization seam for focused route tests. */
  userHasCapability?: typeof userHasCapability;
  assertCanInvokeAgent?: AssertCanInvokeAgent;
  /** M297 — injected so route tests stay database-free. */
  humanPairIsBlocked?: (firstUserId: string, secondUserId: string) => Promise<boolean>;
  listRoomsForActor: (actorId: string) => Promise<RoomSummaryRow[]>;
  getRoomDetailForMember: (
    roomId: string,
    requesterActorId: string,
  ) => Promise<RoomDetailPayload | null>;
  /** Optional so existing hermetic route fixtures remain narrowly scoped. */
  getSubthreadDetailForMember?: (
    subthreadRoomId: string,
    requesterActorId: string,
  ) => Promise<SubthreadDetailPayload | null>;
  getFencedSubthreadDetailForMember?: (
    subthreadRoomId: string,
    requesterActorId: string,
  ) => Promise<Readonly<{
    status: "available";
    detail: SubthreadDetailPayload | null;
  }> | Readonly<{ status: "unsupported_protected_policy" }>>;
  createRoomForOwner: typeof createRoomForOwner;
  /** Optional so hermetic route unit tests can omit it; production uses `defaultService`. */
  createRoomFromMembers?: typeof createRoomFromMembers;
  renamePrivateRoomForOwner: typeof renamePrivateRoomForOwner;
  listManageableRoomsForUser: typeof listManageableRoomsForUser;
  getRoomDetailForManager: typeof getRoomDetailForManager;
  /** M124 — public rooms. Optional so hermetic route unit tests can omit them. */
  listDiscoverableRoomsForUser?: typeof listDiscoverableRoomsForUser;
  joinOpenRoom?: typeof joinOpenRoom;
  createOpenRoom?: typeof createOpenRoom;
  findOtherAdminMembers?: typeof findOtherAdminMembers;
  findRoomOwnerUserId?: typeof findRoomOwnerUserId;
  findCanonicalActiveServerOwner?: typeof findCanonicalActiveServerOwner;
  findOrCreateHumanOnlyDirectRoom?: typeof findOrCreateHumanOnlyDirectRoom;
  /** Optional so focused route fixtures can inject exact Human resolution. */
  findActorByOwnerId?: typeof findActorByOwnerId;
  /** M121 — message-in-room check for reaction routes. Optional for hermetic unit-test mocks. */
  isMessageInRoom?: (args: { messageId: number; roomId: string }) => Promise<boolean>;
  /** M314 — content-free protected membership wake-up; optional in fixtures. */
  resolveProtectedRecipientSyncNamespace?: (
    roomId: string,
  ) => Promise<string | null>;
};

async function getFencedSubthreadDetailForMember(
  subthreadRoomId: string,
  requesterActorId: string,
): Promise<Readonly<{
  status: "available";
  detail: SubthreadDetailPayload | null;
}> | Readonly<{ status: "unsupported_protected_policy" }>> {
  return getSharedDirectDb().transaction(async (tx) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode === "encrypted_only"
      || (policy.mode === "shadow_encryption" && policy.shadowBehavior === "strict")) {
      // A deleted anchor has no protected body. Its content-free placeholder
      // can be returned without attempting an ordinary history read.
      const tombstone = await getSubthreadDetailForMemberWithDb(tx, subthreadRoomId, requesterActorId, true);
      if (tombstone) return { status: "available" as const, detail: tombstone };
      return { status: "unsupported_protected_policy" as const };
    }
    return {
      status: "available" as const,
      detail: await getSubthreadDetailForMemberWithDb(
        tx,
        subthreadRoomId,
        requesterActorId,
      ),
    };
  });
}

export interface ProtectedHumanMessageEditRouteService {
  plan(input: Readonly<{
    roomId: string;
    messageId: number;
    userId: string;
    actorId: string;
    clientDeviceId: string;
    expectedRevision: number;
    clientIdempotencyKey: string;
  }>): Promise<HumanMessageEditPlanResponseV1>;
  publish(input: Readonly<{
    roomId: string;
    messageId: number;
    userId: string;
    actorId: string;
    prepared: ReturnType<typeof humanMessageEditPreparedRequestV1Schema.parse>;
  }>): Promise<HumanMessageEditPreparedResponseV1>;
}

async function resolveProtectedRecipientSyncNamespace(
  roomId: string,
): Promise<string | null> {
  const db = getSharedDirectDb();
  const [policy] = await db
    .select({ mode: encryptionTransitionPolicy.mode })
    .from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, "server"))
    .limit(1);
  if (
    policy?.mode !== "shadow_encryption"
    && policy?.mode !== "encrypted_only"
  ) return null;
  const [room] = await db
    .select({
      namespaceId: rooms.namespaceId,
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      archivedAt: rooms.archivedAt,
      humanActorIds: rooms.humanActorIds,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (
    room === undefined
    || !isProtectedTopLevelRoomKind(room.kind)
    || room.parentRoomId !== null
    || room.archivedAt !== null
  ) return null;
  const members = await db
    .select({ actorId: roomMembers.actorId, kind: actors.kind })
    .from(roomMembers)
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(eq(roomMembers.roomId, roomId));
  const humanIds = members
    .filter((member) => member.kind === "user")
    .map((member) => member.actorId)
    .sort();
  const storedHumans = [...room.humanActorIds].sort();
  if (
    humanIds.length < 1
    || humanIds.length !== storedHumans.length
    || humanIds.some((id, index) => id !== storedHumans[index])
  ) return null;
  return room.namespaceId;
}

const defaultService: RoomsRouteService = {
  userHasCapability,
  listRoomsForActor,
  getRoomDetailForMember,
  getSubthreadDetailForMember,
  getFencedSubthreadDetailForMember,
  createRoomForOwner,
  createRoomFromMembers,
  renamePrivateRoomForOwner,
  listManageableRoomsForUser,
  getRoomDetailForManager,
  listDiscoverableRoomsForUser,
  joinOpenRoom,
  createOpenRoom,
  findOtherAdminMembers,
  findRoomOwnerUserId,
  findCanonicalActiveServerOwner,
  findOrCreateHumanOnlyDirectRoom,
  findActorByOwnerId,
  isMessageInRoom: isMessageInRoomQuery,
  resolveProtectedRecipientSyncNamespace,
};

function roomAuditPath(): string {
  return join(homedir(), ".nautilo", "logs", "security-audit.log");
}

function roomAudit(request: FastifyRequest, event: Record<string, unknown>): void {
  try {
    writeSecurityAuditEvent(roomAuditPath(), {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    } as SecurityAuditEvent);
  } catch (err) {
    warn(`[rooms] audit write failed: ${String(err)}`);
  }
}

function toListResponse(rows: RoomSummaryRow[]): ListRoomsResponse {
  return {
    rooms: rows.map((r) => ({
      id: r.id,
      label: r.label,
      type: r.type,
      graphThreadId: r.graphThreadId,
      createdAt: r.createdAt,
      memberCount: r.memberCount,
      messageCount: r.messageCount,
      lastMessageAt: r.lastMessageAt,
      unreadCount: r.unreadCount,
      kind: r.kind,
      parentRoomId: r.parentRoomId,
      threadRootMessageId: r.threadRootMessageId,
      // D246 Wave 2 — fold the compact roster projection through only when the
      // producer populated it (`listRoomsForActor` and manageable catalogues
      // do; discoverable producers intentionally do not).
      ...(r.roster ? { roster: r.roster } : {}),
    })),
  };
}

function isStrictPersonalAgentRoom(row: RoomSummaryRow, viewerActorId: string): boolean {
  const roster = row.roster;
  if (!roster || roster.length !== 2) return false;
  return (
    roster.some((member) => member.kind === "user" && member.actorId === viewerActorId) &&
    roster.filter((member) => member.kind === "agent").length === 1
  );
}

/** M259 — deterministic server-owned ranking for the public landing fallback. */
export function pickLargestLandingOpenRoom(rows: RoomSummaryRow[]): RoomSummaryRow | null {
  return [...rows].sort((left, right) => {
    const countOrder = right.memberCount - left.memberCount;
    if (countOrder !== 0) return countOrder;
    const createdOrder = left.createdAt.localeCompare(right.createdAt);
    return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
  })[0] ?? null;
}

/**
 * A newly-created Room changes both the WS subscription set and the visible
 * catalogue for every Human member. Refresh subscriptions first so subsequent
 * room-scoped frames cannot race ahead of membership, then send one private,
 * identifier-free invalidation to each affected user's clients.
 */
async function convergeCreatedRoomCatalog(
  detail: RoomDetailPayload,
  creator: { userId: string; actorId: string },
): Promise<void> {
  const humans = new Map<string, { userId: string; actorId: string }>();
  humans.set(creator.userId, creator);
  // Injected hermetic route fixtures historically returned partial details;
  // production payloads always include members, while the creator fallback
  // keeps this side effect safe for those narrow fixtures.
  for (const member of detail.members ?? []) {
    if (member.kind !== "user" || !member.userId) continue;
    humans.set(member.userId, { userId: member.userId, actorId: member.actorId });
  }

  await convergeHumanRoomCatalogs([...humans.values()]);
}

/** Refresh one Human's WS audience before publishing a private catalogue invalidation. */
async function convergeHumanRoomCatalog(userId: string, actorId: string): Promise<void> {
  await refreshRoomSubscriptionsForUser(userId, actorId);
  publishRoomCatalogChanged(userId);
}

export function roomsRoutes(
  app: FastifyInstance,
  service: RoomsRouteService = defaultService,
  protectedEdit?: ProtectedHumanMessageEditRouteService,
  produceHumanMembershipEvent?: HumanMembershipEventProducer,
) {
  const produceMembershipEvent = async (
    change: Parameters<HumanMembershipEventProducer>[0],
  ): Promise<void> => {
    try {
      await produceHumanMembershipEvent?.(change);
    } catch (error) {
      warn(
        `[rooms] membership event producer failed roomId=${change.roomId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  const prepareMembershipChangedPublish = (
    roomId: string,
    event: RoomMembershipSystemEventPayload,
    hasHumanMembershipTransition: boolean,
  ): (() => Promise<string | null>) => {
    const namespaceId = hasHumanMembershipTransition
      ? (async () => {
          try {
            return await service
              .resolveProtectedRecipientSyncNamespace?.(roomId) ?? null;
          } catch (error) {
            // Membership is canonical and has already committed. V2 Domain and
            // Namespace convergence is subordinate: losing this wake-up leaves the
            // predecessor-bound head pending for later Room access/retry, never
            // turns a successful ordinary membership mutation into an HTTP failure.
            warn(
              `[rooms] protected recipient sync wake-up unavailable roomId=${roomId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          }
        })()
      : Promise.resolve(null);
    return async () => {
      const resolvedNamespaceId = await namespaceId;
      if (resolvedNamespaceId === null) {
        publishRoomMembersChanged(roomId, event);
      } else {
        publishRoomMembersChanged(roomId, event, resolvedNamespaceId);
      }
      return resolvedNamespaceId;
    };
  };
  const publishMembershipChanged = async (
    roomId: string,
    event: RoomMembershipSystemEventPayload,
    hasHumanMembershipTransition: boolean,
  ): Promise<string | null> => prepareMembershipChangedPublish(
    roomId,
    event,
    hasHumanMembershipTransition,
  )();
  const convergeThenPublishMembershipChanged = async (
    roomId: string,
    event: RoomMembershipSystemEventPayload,
    hasHumanMembershipTransition: boolean,
    converge: () => Promise<void>,
  ): Promise<string | null> => {
    const publish = prepareMembershipChangedPublish(
      roomId,
      event,
      hasHumanMembershipTransition,
    );
    try {
      await converge();
    } catch (error) {
      // The canonical membership transaction has already committed. A stale
      // local subscription can recover on reconnect; it must neither report
      // the ordinary mutation as failed nor suppress recipient convergence.
      warn(
        `[rooms] membership catalogue convergence unavailable roomId=${roomId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // Successful catalogue convergence still precedes realtime publication.
    return await publish();
  };
  /** M068 — rooms the caller may manage members for (admin: all; else owned). */
  app.get("/api/rooms/manageable", async (request, reply) => {
    const userId = request.sessionUserId;
    // Match `GET /api/rooms` guest semantics: no signed-in user → empty list, not 401.
    // (Stale/invalid bearer still falls through preHandler as guest with null userId.)
    if (!userId) {
      return reply.send(toListResponse([]));
    }
    const admin = await userHasCapability(userId, "manage_rooms");
    const includeArchived =
      (request.query as { includeArchived?: string }).includeArchived === "true";
    const rows = await service.listManageableRoomsForUser(userId, {
      isAdmin: admin,
      includeArchived,
    });
    return reply.send(toListResponse(rows));
  });

  /** M068 — room roster for members UI when caller manages the room (admin or owner). */
  app.get<{ Params: { id: string } }>("/api/rooms/:id/manage-detail", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) {
      return reply.code(400).send({ error: "invalid room id" });
    }
    try {
      await assertCallerCanManageRoom(userId, roomId);
    } catch (e) {
      if (e instanceof ManageForbiddenError) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      throw e;
    }
    const admin = await userHasCapability(userId, "manage_rooms");
    const detail = await service.getRoomDetailForManager(roomId, userId, { isAdmin: admin });
    if (!detail) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.send(detail);
  });

  app.get("/api/rooms", async (request, reply) => {
    if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
      return reply.send(toListResponse([]));
    }
    const actorId = request.sessionActorId;
    if (!actorId) {
      return reply.send(toListResponse([]));
    }
    const rows = await service.listRoomsForActor(actorId);
    return reply.send(toListResponse(rows));
  });

  /**
   * M259 — resolve a safe initial Room without delegating public-Room ranking
   * or administrator choice to the client. Existing exact membership wins;
   * otherwise the largest eligible open Room is joined idempotently, then a
   * Human-only DM with the canonical active Server owner is resolved/created.
   */
  app.post("/api/rooms/resolve-landing", async (request, reply) => {
    const userId = request.sessionUserId;
    const actorId = request.sessionActorId;
    if (!userId || !actorId) {
      return reply.code(401).send({ error: "authentication_required" });
    }

    const canInvokeAgents = await (service.userHasCapability ?? userHasCapability)(
      userId,
      "invoke_agents",
    );
    const memberRooms = await service.listRoomsForActor(actorId);
    const existing = memberRooms.find(
      (room) => canInvokeAgents || !isStrictPersonalAgentRoom(room, actorId),
    );
    if (existing) {
      if (existing.kind === "open") {
        const join = service.joinOpenRoom ?? joinOpenRoom;
        let joined: Awaited<ReturnType<typeof joinOpenRoom>>;
        try {
          joined = await join({ userId, actorId, roomId: existing.id });
        } catch (e) {
          if (e instanceof ModerationError && e.code === "active_ban") {
            return reply.code(403).send({ code: "active_ban" });
          }
          throw e;
        }
        if (joined.membershipEvent && joined.membershipMessageId !== undefined) {
          await produceMembershipEvent({
            type: "room.member_joined",
            roomId: existing.id,
            subjectUserId: userId,
            initiatorActorId: actorId,
            initiatorUserId: userId,
            membershipMessageId: joined.membershipMessageId,
          });
        }
        if (!joined.membershipEvent && joined.repairedSubthreadIds.length > 0) {
          await refreshRoomSubscriptionsForUser(userId, actorId);
        }
        if (joined.membershipEvent) {
          await convergeThenPublishMembershipChanged(
            existing.id,
            joined.membershipEvent,
            joined.humanMembershipTransitions?.[0] !== undefined,
            () => refreshRoomSubscriptionsForUser(userId, actorId),
          );
          roomAudit(request, {
            kind: "landing_room_self_joined",
            actorId,
            roomId: existing.id,
          });
        }
        if (joined.repairedSubthreadEvent) {
          for (const subthreadRoomId of joined.repairedSubthreadIds) {
            publishRoomMembersChanged(
              subthreadRoomId,
              joined.repairedSubthreadEvent,
            );
          }
        }
      }
      const detail = await service.getRoomDetailForMember(existing.id, actorId);
      if (detail) return reply.send(detail);
    }

    const listOpen = service.listDiscoverableRoomsForUser ?? listDiscoverableRoomsForUser;
    const publicRoom = pickLargestLandingOpenRoom(await listOpen(userId));
    if (publicRoom) {
      const join = service.joinOpenRoom ?? joinOpenRoom;
      let joined: Awaited<ReturnType<typeof joinOpenRoom>>;
      try {
        joined = await join({ userId, actorId, roomId: publicRoom.id });
      } catch (e) {
        if (e instanceof ModerationError && e.code === "active_ban") {
          return reply.code(403).send({ code: "active_ban" });
        }
        throw e;
      }
      if (joined.membershipEvent && joined.membershipMessageId !== undefined) {
        await produceMembershipEvent({
          type: "room.member_joined",
          roomId: publicRoom.id,
          subjectUserId: userId,
          initiatorActorId: actorId,
          initiatorUserId: userId,
          membershipMessageId: joined.membershipMessageId,
        });
      }
      if (!joined.membershipEvent && joined.repairedSubthreadIds.length > 0) {
        await refreshRoomSubscriptionsForUser(userId, actorId);
      }
      if (joined.membershipEvent) {
        await convergeThenPublishMembershipChanged(
          publicRoom.id,
          joined.membershipEvent,
          joined.humanMembershipTransitions?.[0] !== undefined,
          () => refreshRoomSubscriptionsForUser(userId, actorId),
        );
        roomAudit(request, {
          kind: "landing_room_self_joined",
          actorId,
          roomId: publicRoom.id,
        });
      }
      if (joined.repairedSubthreadEvent) {
        for (const subthreadRoomId of joined.repairedSubthreadIds) {
          publishRoomMembersChanged(
            subthreadRoomId,
            joined.repairedSubthreadEvent,
          );
        }
      }
      const detail = await service.getRoomDetailForMember(publicRoom.id, actorId);
      if (detail) return reply.send(detail);
    }

    const owner = await (
      service.findCanonicalActiveServerOwner ?? findCanonicalActiveServerOwner
    )();
    if (!owner || owner.userId === userId || owner.actorId === actorId) {
      return reply.code(409).send({
        error: "landing_room_unavailable",
        code: "landing_room_unavailable",
      });
    }
    const resolveAdminDm =
      service.findOrCreateHumanOnlyDirectRoom ?? findOrCreateHumanOnlyDirectRoom;
    const detail = await resolveAdminDm({
      ownerUserId: owner.userId,
      ownerActorId: owner.actorId,
      guestActorId: actorId,
      label: owner.displayName,
    });
    return reply.send(detail);
  });

  // M122 — mark every visible message in a room as read for the caller, up to an
  // optional `upToMessageId`. Idempotent; 404s for non-members. Publishes a
  // canonical viewer-private notification delta only when rows flipped (D196).
  app.post<{
    Params: { roomId: string };
    Body: { upToMessageId?: number };
  }>(
    "/api/rooms/:roomId/read",
    {
      schema: {
        params: {
          type: "object",
          required: ["roomId"],
          properties: { roomId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: { upToMessageId: { type: "integer", minimum: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const userId = request.sessionUserId;
      const actorId = request.sessionActorId;
      if (!userId || !actorId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const { roomId } = request.params;
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      // Membership gate (MR5) — same check sibling room routes use.
      const detail = await service.getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }

      const upToMessageId = request.body?.upToMessageId ?? null;
      const { marked } = await markRoomRead({ roomId, userId, upToMessageId });

      if (marked > 0) {
        await recomputeAndPublishNotificationState({
          roomId,
          recipientUserIds: [userId],
        }).catch((err) => {
          warn(
            `[rooms] M122 unread publish failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
          );
        });
      }

      return reply.send({ ok: true, marked });
    },
  );

  // D279 Phase 3.5 / D190 — room silence windows (mute + deaf).
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/silence",
    async (request, reply) => {
      const userId = request.sessionUserId;
      const actorId = request.sessionActorId;
      if (!userId || !actorId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const { roomId } = request.params;
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      const detail = await service.getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      let canManage = false;
      try {
        await assertCallerCanManageRoom(userId, roomId);
        canManage = true;
      } catch (e) {
        if (!(e instanceof ManageForbiddenError)) {
          throw e;
        }
      }
      const db = getSharedDirectDb();
      const silence = await loadActiveRoomSilence(db, roomId, new Date());
      return reply.send({ silence, canManage } satisfies {
        silence: ActiveRoomSilenceDto | null;
        canManage: boolean;
      });
    },
  );

  app.post<{
    Params: { roomId: string };
    Body: { kind?: string; botActorId?: string | null; durationMs?: number };
  }>(
    "/api/rooms/:roomId/silence",
    {
      schema: {
        params: {
          type: "object",
          required: ["roomId"],
          properties: { roomId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["mute", "deaf"] },
            botActorId: { type: ["string", "null"], format: "uuid" },
            durationMs: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const userId = request.sessionUserId;
      const actorId = request.sessionActorId;
      if (!userId || !actorId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const { roomId } = request.params;
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      try {
        await assertCallerCanManageRoom(userId, roomId);
      } catch (e) {
        if (e instanceof ManageForbiddenError) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        throw e;
      }
      const detail = await service.getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const kind = request.body?.kind;
      if (kind !== "mute" && kind !== "deaf") {
        return reply.code(400).send({ error: "kind must be mute or deaf" });
      }
      const rawBotActorId = request.body?.botActorId;
      const botActorId =
        rawBotActorId === null || rawBotActorId === undefined
          ? null
          : typeof rawBotActorId === "string" && isUuidString(rawBotActorId)
            ? rawBotActorId
            : undefined;
      if (botActorId === undefined) {
        return reply.code(400).send({ error: "invalid botActorId" });
      }
      if (botActorId != null) {
        const isAgentMember = detail.members.some(
          (m) => m.kind === "agent" && m.actorId === botActorId,
        );
        if (!isAgentMember) {
          return reply
            .code(400)
            .send({ error: "botActorId must be an agent member of the room" });
        }
      }
      const db = getSharedDirectDb();
      const now = new Date();
      const silence = await setRoomSilence(db, {
        roomId,
        setByUserId: userId,
        kind,
        botActorId,
        now,
        ...(request.body?.durationMs != null
          ? { durationMs: request.body.durationMs }
          : {}),
      });
      publishAndScheduleRoomSilence(roomId, silence, now);
      return reply.send({ silence });
    },
  );

  app.delete<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/silence",
    async (request, reply) => {
      const userId = request.sessionUserId;
      const actorId = request.sessionActorId;
      if (!userId || !actorId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const { roomId } = request.params;
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      try {
        await assertCallerCanManageRoom(userId, roomId);
      } catch (e) {
        if (e instanceof ManageForbiddenError) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        throw e;
      }
      const detail = await service.getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const db = getSharedDirectDb();
      cancelAllSilenceWindowExpiryForRoom(roomId);
      const { cleared } = await clearRoomSilence(db, { roomId });
      const silence = await loadActiveRoomSilence(db, roomId, new Date());
      publishRoomSilenceChanged(roomId, silence);
      return reply.send({ ok: true, cleared, silence });
    },
  );

  // M124 (MR5) — server-wide public-room directory. Any authenticated user
  // can browse; gate is purely "signed in" (`sessionUserId != null`).
  // Deliberately does NOT consult `policyContext.actorRole` — that's the
  // per-Agent relationship axis, which is the wrong axis for Server-level
  // discovery. Unauthenticated → 401.
  app.get("/api/rooms/discoverable", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const list = service.listDiscoverableRoomsForUser ?? listDiscoverableRoomsForUser;
    const rows = await list(userId);
    return reply.send(toListResponse(rows));
  });

  // M124 (MR6) — self-join an open room. Any authenticated user; does NOT
  // consult `policyContext.actorRole`. Idempotent: re-joining returns the
  // same 200 detail with no duplicate parent publish/audit. A rejoin may
  // still repair historical child-membership drift and publish only those
  // real child changes (D196 watchpoint).
  app.post<{ Params: { id: string } }>("/api/rooms/:id/join", async (request, reply) => {
    const sessionUserId = request.sessionUserId;
    const actorId = request.sessionActorId;
    if (!sessionUserId || !actorId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) {
      return reply.code(400).send({ error: "invalid room id" });
    }
    const join = service.joinOpenRoom ?? joinOpenRoom;
    let membershipEvent;
    let membershipMessageId: number | undefined;
    let humanMembershipTransitions;
    let repairedSubthreadIds: string[] = [];
    let repairedSubthreadEvent: RoomMembershipSystemEventPayload | null = null;
    try {
      ({
        membershipEvent,
        membershipMessageId,
        humanMembershipTransitions,
        repairedSubthreadIds,
        repairedSubthreadEvent,
      } = await join({ userId: sessionUserId, actorId, roomId }));
    } catch (e) {
      if (e instanceof ModerationError && e.code === "active_ban") {
        return reply.code(403).send({ code: "active_ban" });
      }
      if (e instanceof MembershipOpError && e.opCode === "not_open") {
        return reply.code(403).send({ code: "not_open" });
      }
      if (e instanceof MembershipOpError && e.opCode === "not_found") {
        return reply.code(404).send({ error: "not_found" });
      }
      throw e;
    }

    if (membershipEvent && membershipMessageId !== undefined) {
      await produceMembershipEvent({
        type: "room.member_joined",
        roomId,
        subjectUserId: sessionUserId,
        initiatorActorId: actorId,
        initiatorUserId: sessionUserId,
        membershipMessageId,
      });
    }

    // Parent publish/audit occurs only on a fresh parent join. Subscription
    // refresh and child publishes also occur for real child-only repairs.
    if (membershipEvent) {
      await convergeThenPublishMembershipChanged(
        roomId,
        membershipEvent,
        humanMembershipTransitions?.[0] !== undefined,
        () => convergeHumanRoomCatalog(sessionUserId, actorId),
      );
    } else if (repairedSubthreadIds.length > 0) {
      await refreshRoomSubscriptionsForUser(sessionUserId, actorId);
    }
    if (membershipEvent) {
      roomAudit(request, {
        kind: "room_member_self_joined",
        actorId: request.sessionActorId,
        roomId,
      });
    }
    if (repairedSubthreadEvent) {
      for (const subthreadRoomId of repairedSubthreadIds) {
        publishRoomMembersChanged(subthreadRoomId, repairedSubthreadEvent);
      }
    }

    const detail = await service.getRoomDetailForMember(roomId, actorId);
    if (!detail) {
      // Should not happen — the caller is a member in both branches — but
      // fail loud rather than send a malformed 200.
      return reply.code(500).send({ error: "room_not_visible_after_join" });
    }
    return reply.send(detail);
  });

  app.get<{ Params: { id: string } }>("/api/rooms/:id", async (request, reply) => {
    if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const actorId = request.sessionActorId;
    const roomId = request.params.id;
    if (!actorId || !isUuidString(roomId)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const detail = await service.getRoomDetailForMember(roomId, actorId);
    if (!detail) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.send(detail);
  });

  app.get<{ Params: { id: string; agentId: string } }>(
    "/api/rooms/:id/agents/:agentId/avatar",
    async (request, reply) => {
      if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const actorId = request.sessionActorId;
      const roomId = request.params.id;
      const agentId = request.params.agentId;
      if (!actorId || !isUuidString(roomId) || !isUuidString(agentId)) {
        return reply.code(404).send({ error: "Not found" });
      }

      const detail = await service.getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const agentMember = detail.members.find(
        (m) => m.kind === "agent" && m.agentId === agentId,
      );
      if (!agentMember) {
        return reply.code(404).send({ error: "Not found" });
      }

      const db = getSharedDirectDb();
      const [row] = await db
        .select({ avatarRef: profiles.avatarRef })
        .from(profiles)
        .where(eq(profiles.agentId, agentId))
        .limit(1);
      return sendAvatar(request, reply, row?.avatarRef ?? SHELL_AVATAR_REF);
    },
  );

  app.get<{ Params: { id: string } }>("/api/rooms/:id/subthreads", async (request, reply) => {
    if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const actorId = request.sessionActorId;
    const roomId = request.params.id;
    if (!actorId || !isUuidString(roomId)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const subthreads = await listSubthreadsForRoom(roomId, actorId);
    return reply.send({ subthreads });
  });

  app.get<{ Params: { id: string } }>(
    "/api/rooms/:id/thread-detail",
    async (request, reply) => {
      if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const actorId = request.sessionActorId;
      const roomId = request.params.id;
      if (!actorId || !isUuidString(roomId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const fenced = service.getFencedSubthreadDetailForMember === undefined
        ? {
            status: "available" as const,
            detail: await (service.getSubthreadDetailForMember ?? getSubthreadDetailForMember)(
              roomId,
              actorId,
            ),
          }
        : await service.getFencedSubthreadDetailForMember(roomId, actorId);
      if (fenced.status === "unsupported_protected_policy") {
        return reply.code(409).send({
          error: "Protected Subthread anchor hydration is not supported",
          reason: "protected_representation_required",
        });
      }
      const detail = fenced.detail;
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      if (detail.anchor.content === null) {
        return reply.code(409).send({
          error: "The anchor's ordinary representation is unavailable",
          reason: "protected_representation_required",
        });
      }
      const response: ThreadDetailResponse = {
        parentRoomId: detail.parentRoomId,
        subthreadRoomId: detail.subthreadRoomId,
        anchor: {
          id: String(detail.anchor.id),
          logicalMessageKey: logicalMessageKey(detail.anchor),
          role: detail.anchor.role,
          content: detail.anchor.content,
          toolCalls: detail.anchor.toolCalls,
          toolName: detail.anchor.toolName,
          createdAt: detail.anchor.createdAt.toISOString(),
          editedAt: detail.anchor.editedAt?.toISOString() ?? null,
          editRevision: detail.anchor.editRevision,
          replyToMessageId: detail.anchor.replyToMessageId,
          replyCount: detail.anchor.replyCount,
          lastReplyAt: detail.anchor.lastReplyAt?.toISOString() ?? null,
          summaryRevision: detail.anchor.summaryRevision,
          sourceUserId: detail.anchor.sourceUserId,
          ...(detail.anchor.authorAgentId
            ? { authorAgentId: detail.anchor.authorAgentId }
            : {}),
        },
        summary: {
          replyCount: detail.summary.replyCount,
          lastReplyAt: detail.summary.lastReplyAt?.toISOString() ?? null,
          summaryRevision: detail.summary.summaryRevision,
        },
      };
      return reply.send(response);
    },
  );

  app.post<{
    Params: { id: string; messageId: string };
    Body: { label?: string };
  }>("/api/rooms/:id/messages/:messageId/subthreads", async (request, reply) => {
    if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const actorId = request.sessionActorId;
    const roomId = request.params.id;
    if (!actorId || !isUuidString(roomId)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const messageIdNum = Number(request.params.messageId);
    if (!Number.isInteger(messageIdNum)) {
      return reply.code(400).send({ error: "invalid messageId" });
    }
    const label =
      typeof request.body?.label === "string" ? request.body.label.trim() : undefined;
    try {
      const result = await createSubthreadRoom({
        parentRoomId: roomId,
        anchorMessageId: messageIdNum,
        label: label && label.length > 0 ? label : null,
        requesterActorId: actorId,
      });
      const child = await service.getRoomDetailForMember(result.subthreadRoomId, actorId);
      if (!child || child.kind !== "subthread") {
        return reply.code(500).send({ error: "subthread_not_visible_after_create" });
      }
      const inheritedHumans = new Map<string, { userId: string; actorId: string }>();
      for (const member of child.members) {
        if (member.kind !== "user" || !member.userId) continue;
        inheritedHumans.set(`${member.userId}:${member.actorId}`, {
          userId: member.userId,
          actorId: member.actorId,
        });
      }
      await Promise.all(
        [...inheritedHumans.values()].map(({ userId, actorId: humanActorId }) =>
          refreshRoomSubscriptionsForUser(userId, humanActorId),
        ),
      );
      if (result.repairedMembership) {
        for (const repairedRoomId of result.repairedSubthreadIds ?? [
          result.subthreadRoomId,
        ]) {
          publishRoomMembersChanged(repairedRoomId, result.repairedMembership);
        }
      }
      return reply.code(201).send({ subthreadRoomId: result.subthreadRoomId });
    } catch (e) {
      if (e instanceof MembershipOpError) {
        if (e.opCode === "subthread_not_visible") {
          return reply.code(404).send({ error: "Not found" });
        }
        if (e.opCode === "subthread_anchor_exists") {
          return reply.code(409).send({ error: e.opCode });
        }
        return reply.code(400).send({ error: e.opCode, message: e.message });
      }
      throw e;
    }
  });

  // D287 — soft-archive a room (hide from lists; retain data). Manager-only;
  // does NOT trip the self-leave `room_owner_last_admin` guard.
  app.post<{ Params: { id: string } }>("/api/rooms/:id/archive", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) {
      return reply.code(400).send({ error: "invalid room id" });
    }
    try {
      await assertCallerCanManageRoom(userId, roomId);
    } catch (e) {
      if (e instanceof ManageForbiddenError) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      throw e;
    }

    const db = getSharedDirectDb();
    const [row] = await db
      .select({ archivedAt: rooms.archivedAt })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!row) {
      return reply.code(404).send({ error: "Not found" });
    }
    if (row.archivedAt == null) {
      await db
        .update(rooms)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(rooms.id, roomId));
      roomAudit(request, {
        kind: "room_archived",
        actorId: request.sessionActorId,
        roomId,
      });
    }
    return reply.send({ ok: true });
  });

  // D287 — restore a soft-archived room to member lists / discovery.
  app.post<{ Params: { id: string } }>("/api/rooms/:id/unarchive", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) {
      return reply.code(400).send({ error: "invalid room id" });
    }
    try {
      await assertCallerCanManageRoom(userId, roomId);
    } catch (e) {
      if (e instanceof ManageForbiddenError) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      throw e;
    }

    const db = getSharedDirectDb();
    const [row] = await db
      .select({ archivedAt: rooms.archivedAt })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!row) {
      return reply.code(404).send({ error: "Not found" });
    }
    if (row.archivedAt != null) {
      await db
        .update(rooms)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(eq(rooms.id, roomId));
      roomAudit(request, {
        kind: "room_unarchived",
        actorId: request.sessionActorId,
        roomId,
      });
    }
    return reply.send({ ok: true });
  });

  // D194 — flip room visibility (open ↔ group). Gated on `manage_rooms`
  // (same axis as M124 public-room creation); room ownership alone is not
  // sufficient.
  app.post<{ Params: { id: string }; Body: SetRoomVisibilityRequest }>(
    "/api/rooms/:id/visibility",
    async (request, reply) => {
      const sessionUserId = request.sessionUserId;
      if (!sessionUserId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const roomId = request.params.id;
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      if (typeof request.body?.public !== "boolean") {
        return reply.code(400).send({ error: "public is required" });
      }

      const admin = await userHasCapability(sessionUserId, "manage_rooms");
      if (!admin) {
        return reply.code(403).send({ error: "forbidden", code: "admin_required" });
      }

      const targetKind = request.body.public ? "open" : "group";
      try {
        const changed = await updateRoomVisibility(roomId, targetKind);
        if (changed) {
          roomAudit(request, {
            kind: "room_visibility_changed",
            actorId: request.sessionActorId,
            roomId,
            newKind: targetKind,
          });
        }
        return reply.send({ ok: true });
      } catch (e) {
        if (e instanceof MembershipOpError) {
          if (e.opCode === "not_found") {
            return reply.code(404).send({ error: "Not found" });
          }
          if (e.opCode === "invalid_kind_for_visibility") {
            return reply.code(409).send({
              error: "invalid kind for visibility",
              code: "invalid_kind_for_visibility",
            });
          }
        }
        throw e;
      }
    },
  );

  // D302 P5b — persistent smart-routing policy (`advanced` | `standard`).
  app.post<{ Params: { id: string }; Body: SetRoomConductorModeRequest }>(
    "/api/rooms/:id/conductor-mode",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const roomId = request.params.id;
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      const mode = request.body?.conductorMode;
      if (mode !== "advanced" && mode !== "standard") {
        return reply.code(400).send({ error: "conductorMode must be advanced or standard" });
      }

      try {
        await assertCallerCanManageRoom(userId, roomId);
      } catch (e) {
        if (e instanceof ManageForbiddenError) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        throw e;
      }

      const changed = await updateRoomConductorMode(roomId, mode);
      if (!changed) {
        return reply.code(404).send({ error: "Not found" });
      }
      publishRoomConductorModeChanged(roomId, mode);
      roomAudit(request, {
        kind: "room_conductor_mode_updated",
        actorId: request.sessionActorId,
        roomId,
        conductorMode: mode,
      });
      const response: SetRoomConductorModeResponse = { conductorMode: mode };
      return reply.send(response);
    },
  );

  app.patch<{ Params: { id: string }; Body: RenameRoomRequest }>(
    "/api/rooms/:id",
    async (request, reply) => {
      const sessionUserId = request.sessionUserId;
      const actorId = request.sessionActorId;
      const roomId = request.params.id;
      if (!sessionUserId || !actorId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      // M128 — was hard-gated on `actorRole === "owner"` (legacy
      // single-tenant semantics). Now: admin OR `manage_rooms` cap
      // OR per-room ownership (rooms.owner_id). Members renaming
      // their own rooms work; non-owner Members cannot rename
      // someone else's rooms unless they hold the global cap.
      let authz: RoomManagementAuthority;
      try {
        authz = await assertCallerCanManageRoom(sessionUserId, roomId);
      } catch (e) {
        if (e instanceof ManageForbiddenError) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        throw e;
      }
      const label =
        typeof request.body?.label === "string" ? request.body.label.trim() : "";
      if (!label) {
        return reply.code(400).send({ error: "label is required" });
      }
      if (label.length > 80) {
        return reply.code(400).send({ error: "label must be at most 80 characters" });
      }
      const detail = await service.renamePrivateRoomForOwner({
        roomId,
        ownerUserId: sessionUserId,
        requesterActorId: actorId,
        label,
        allowNonOwner: authz.role !== "room_owner",
      });
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.send(detail);
    },
  );

  app.post<{ Body: CreateRoomRequest }>("/api/rooms", async (request, reply) => {
    // M128 unify (2026-05-29) — replaces the legacy
    // `actorRole IN {owner, household, teammate}` gate (which broke
    // every member/superuser/contributor caller post-M128 because
    // those slugs don't resolve any more).
    //
    // Two-tier authz aligned with the user's directive:
    //   * No-explicit-members ("self + my Genie" personal room):
    //     authentication is enough; downstream `createRoomForOwner`
    //     uses the caller's own personal Agent. No capability gate.
    //   * Explicit-members (multi-actor / cross-Human room):
    //     requires `manage_rooms` capability OR server admin.
    //     `createRoomFromMembers` further enforces that the caller
    //     is one of the listed members + that every other member is
    //     reachable.
    const sessionUserId = request.sessionUserId;
    const actorId = request.sessionActorId;
    if (!sessionUserId || !actorId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
    if (!label) {
      return reply.code(400).send({ error: "label is required" });
    }
    if (label.length > 80) {
      return reply.code(400).send({ error: "label must be at most 80 characters" });
    }
    if (
      request.body?.catalogueKind !== undefined &&
      request.body.catalogueKind !== "chat" &&
      request.body.catalogueKind !== "room"
    ) {
      return reply.code(400).send({ error: "catalogueKind must be chat or room" });
    }
    const rawPersonalAgentId = request.body?.personalAgentId;
    if (
      rawPersonalAgentId !== undefined &&
      (typeof rawPersonalAgentId !== "string" || !isUuidString(rawPersonalAgentId))
    ) {
      return reply.code(400).send({ error: "personalAgentId must be a UUID string" });
    }
    const requestedPersonalAgentId = rawPersonalAgentId ?? "";
    const rawDirectHumanUserId = request.body?.directHumanUserId;
    if (
      rawDirectHumanUserId !== undefined &&
      (typeof rawDirectHumanUserId !== "string" || !isUuidString(rawDirectHumanUserId))
    ) {
      return reply.code(400).send({ error: "directHumanUserId must be a UUID string" });
    }
    const directHumanUserId = rawDirectHumanUserId ?? "";
    if (directHumanUserId === sessionUserId) {
      return reply.code(400).send({ error: "directHumanUserId must identify another Human" });
    }
    if (requestedPersonalAgentId && directHumanUserId) {
      return reply.code(400).send({
        error: "personalAgentId cannot be combined with directHumanUserId",
      });
    }
    const exactPrivateTarget = requestedPersonalAgentId || directHumanUserId;
    if (exactPrivateTarget && request.body?.kind === "open") {
      return reply.code(400).send({
        error: `${requestedPersonalAgentId ? "personalAgentId" : "directHumanUserId"} requires a private room`,
      });
    }
    // M124 / D473 — public-room creation is always gated by `manage_rooms`.
    // An omitted roster remains the creator-only public room. A supplied
    // roster follows the same entity/reachability rules as private/group
    // creation and must explicitly include the creator exactly once.
    if (request.body?.kind === "open") {
      const canManageRooms = await userHasCapability(sessionUserId, "manage_rooms");
      if (!canManageRooms) {
        return reply.code(403).send({ error: "forbidden", code: "admin_required" });
      }
      const rawMembers = request.body?.members;
      // Preserve creator-only open-room compatibility: an empty roster is
      // equivalent to omission, not an invalid creator-less roster.
      const explicitMembers = Array.isArray(rawMembers) && rawMembers.length > 0 ? rawMembers : null;
      if (explicitMembers !== null) {
        for (const m of explicitMembers) {
          if (m?.kind !== "user" && m?.kind !== "agent") {
            return reply.code(400).send({ error: "members[].kind must be user or agent" });
          }
          if (typeof m?.id !== "string" || !isUuidString(m.id)) {
            return reply.code(400).send({ error: "members[].id must be a UUID string" });
          }
        }
        const memberKeys = explicitMembers.map((m) => `${m.kind}:${m.id}`);
        if (new Set(memberKeys).size !== memberKeys.length) {
          return reply.code(400).send({ error: "members[] must not contain duplicates" });
        }
        const creatorCount = explicitMembers.filter(
          (m) => m.kind === "user" && m.id === sessionUserId,
        ).length;
        if (creatorCount !== 1) {
          return reply
            .code(400)
            .send({ error: "members[] must include the creator exactly once" });
        }
        const caps = await getUserCapabilities(sessionUserId);
        try {
          await assertCanCreateRoomMembers({
            callerUserId: sessionUserId,
            members: explicitMembers.map((m) => ({ kind: m.kind, id: m.id })),
            // `manage_members` is the elevated reachability bypass; merely
            // holding `manage_rooms` still requires an existing relationship.
            isAdmin: caps.includes("manage_members"),
          });
        } catch (e) {
          if (e instanceof CreateRoomReachabilityError) {
            if (e.code === "user_not_found" || e.code === "agent_not_found") {
              return reply.code(404).send({
                error: e.code,
                memberKind: e.memberKind,
                memberId: e.memberId,
              });
            }
            return reply.code(403).send({
              error: e.code,
              memberKind: e.memberKind,
              memberId: e.memberId,
            });
          }
          throw e;
        }
      }
      try {
        const mintOpenRoom = service.createOpenRoom ?? createOpenRoom;
        const detail = await mintOpenRoom({
          creatorUserId: sessionUserId,
          creatorActorId: actorId,
          label,
          ...(explicitMembers !== null
            ? {
                members: explicitMembers.map((m) => ({
                  kind: m.kind,
                  id: m.id,
                })),
              }
            : {}),
        });
        await convergeCreatedRoomCatalog(detail, { userId: sessionUserId, actorId });
        return reply.code(201).send(detail);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: msg });
      }
    }

    const rawMembers = request.body?.members;
    if (exactPrivateTarget && Array.isArray(rawMembers)) {
      return reply.code(400).send({
        error: `${requestedPersonalAgentId ? "personalAgentId" : "directHumanUserId"} cannot be combined with members`,
      });
    }
    if (
      exactPrivateTarget &&
      (request.body?.kind === "group" || request.body?.catalogueKind === "room")
    ) {
      return reply.code(400).send({
        error: `${requestedPersonalAgentId ? "personalAgentId" : "directHumanUserId"} requires a private room`,
      });
    }
    if (directHumanUserId) {
      const directPairBlocked = service.humanPairIsBlocked
        ? await service.humanPairIsBlocked(sessionUserId, directHumanUserId)
        : await humanPairIsBlocked(getSharedDirectDb(), sessionUserId, directHumanUserId);
      if (directPairBlocked) {
        return reply.code(403).send({
          error: "direct_human_interaction_blocked",
          code: "direct_human_interaction_blocked",
        });
      }
      try {
        await assertCanCreateRoomMembers({
          callerUserId: sessionUserId,
          members: [{ kind: "user", id: directHumanUserId }],
          isAdmin: false,
        });
      } catch (e) {
        if (e instanceof CreateRoomReachabilityError) {
          return reply.code(e.code === "user_not_found" ? 404 : 403).send({
            error: e.code,
            memberKind: e.memberKind,
            memberId: e.memberId,
          });
        }
        throw e;
      }
      const targetActor = await (service.findActorByOwnerId ?? findActorByOwnerId)(
        directHumanUserId,
      );
      if (!targetActor) {
        return reply.code(404).send({ error: "user_not_found" });
      }
      try {
        const resolveDirect =
          service.findOrCreateHumanOnlyDirectRoom ?? findOrCreateHumanOnlyDirectRoom;
        const detail = await resolveDirect({
          ownerUserId: sessionUserId,
          ownerActorId: actorId,
          guestActorId: targetActor.id,
          label,
        });
        await convergeCreatedRoomCatalog(detail, { userId: sessionUserId, actorId });
        return reply.code(201).send(detail);
      } catch (error) {
        warn(
          `[rooms] direct Human resolve failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return reply.code(500).send({ error: "direct_room_resolution_failed" });
      }
    }
    const explicitMembers = Array.isArray(rawMembers) ? rawMembers : null;
    if (explicitMembers && explicitMembers.length > 0) {
      // D543 — ordinary shared Room creation gates on `create_rooms`;
      // solo "me + my Genie" rooms (the no-explicit-members branch below)
      // intentionally do NOT need it. The reachability bypass
      // (`isAdmin` → `assertCanCreateRoomMembers` skips the share-a-room
      // check) is the higher server-admin tier `manage_members` (the
      // issue's lowercase "admin"); a `manage_rooms`-only superuser still
      // has member reachability enforced. Pre-D219 this was the
      // `server_role='admin'` bypass.
      const caps = await getUserCapabilities(sessionUserId);
      if (!caps.includes("create_rooms") && !caps.includes("manage_rooms")) {
        return reply.code(403).send({
          error: "forbidden",
          code: "create_rooms_required",
        });
      }
      const admin = caps.includes("manage_members");
      for (const m of explicitMembers) {
        if (m?.kind !== "user" && m?.kind !== "agent") {
          return reply.code(400).send({ error: "members[].kind must be user or agent" });
        }
        if (typeof m?.id !== "string" || !isUuidString(m.id)) {
          return reply.code(400).send({ error: "members[].id must be a UUID string" });
        }
      }
      try {
        await assertCanCreateRoomMembers({
          callerUserId: sessionUserId,
          members: explicitMembers.map((m) => ({ kind: m.kind, id: m.id })),
          isAdmin: admin,
        });
      } catch (e) {
        if (e instanceof CreateRoomReachabilityError) {
          if (e.code === "user_not_found" || e.code === "agent_not_found") {
            return reply.code(404).send({
              error: e.code,
              memberKind: e.memberKind,
              memberId: e.memberId,
            });
          }
          return reply.code(403).send({
            error: e.code,
            memberKind: e.memberKind,
            memberId: e.memberId,
          });
        }
        throw e;
      }
      try {
        const createFromMembers = service.createRoomFromMembers ?? createRoomFromMembers;
        const detail = await createFromMembers({
          ownerUserId: sessionUserId,
          ownerActorId: actorId,
          label,
          members: explicitMembers.map((m) => ({
            kind: m.kind,
            id: m.id,
          })),
          ...(request.body.catalogueKind === "room" ? { roomType: "room" as const } : {}),
        });
        await convergeCreatedRoomCatalog(detail, { userId: sessionUserId, actorId });
        return reply.code(201).send(detail);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: msg });
      }
    }

    // M125 Phase 1.2: the no-explicit-members "New chat" path uses the
    // CALLER'S own primary agent (deterministic owned[0] after Phase 0)
    // instead of borrowing the bootstrap default. Without this, every
    // non-operator user's new room landed the operator's agent as the
    // sole agent member.
    let defaultAgentId: string;
    try {
      const personal = await findPersonalAgentsForUser(sessionUserId);
      const first = personal[0];
      if (!first?.agentId) {
        return reply.code(400).send({
          error: "no_default_agent",
          code: "no_default_agent",
        });
      }
      if (requestedPersonalAgentId) {
        const requested = personal.find((agent) => agent.agentId === requestedPersonalAgentId);
        if (!requested) {
          return reply.code(403).send({
            error: "personal_agent_required",
            code: "personal_agent_required",
          });
        }
        defaultAgentId = requested.agentId;
      } else {
        defaultAgentId = first.agentId;
      }
    } catch (e) {
      warn(
        `[rooms] findPersonalAgentsForUser failed for ${sessionUserId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return reply.code(500).send({
        error: "agent_resolution_failed",
        code: "agent_resolution_failed",
      });
    }
    if (!(await requireAgentInvocation(
      { humanUserId: sessionUserId, origin: "room_message", agentId: defaultAgentId },
      reply,
      service.assertCanInvokeAgent,
    ))) return;
    try {
      const detail = await service.createRoomForOwner({
        ownerUserId: sessionUserId,
        ownerActorId: actorId,
        defaultAgentId,
        label,
      });
      await convergeCreatedRoomCatalog(detail, { userId: sessionUserId, actorId });
      return reply.code(201).send(detail);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ error: msg });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { kind?: string; userId?: string; agentId?: string; roomRole?: string };
  }>("/api/rooms/:id/members", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) {
      return reply.code(400).send({ error: "invalid room id" });
    }
    let authz: RoomManagementAuthority;
    try {
      authz = await assertCallerCanManageRoom(userId, roomId);
    } catch (e) {
      if (e instanceof ManageForbiddenError) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      throw e;
    }

    const kind = request.body?.kind;
    const roomRole =
      request.body?.roomRole === "admin" || request.body?.roomRole === "member"
        ? request.body.roomRole
        : null;
    if (!roomRole) {
      return reply.code(400).send({ error: "roomRole must be admin or member" });
    }

    if (kind === "user") {
      const targetUserId = typeof request.body?.userId === "string" ? request.body.userId : "";
      if (!targetUserId) {
        return reply.code(400).send({ error: "userId is required" });
      }
      if (authz.role !== "server_room_admin") {
        try {
          await assertCanCreateRoomMembers({
            callerUserId: userId,
            members: [{ kind: "user", id: targetUserId }],
            isAdmin: false,
          });
        } catch (e) {
          if (e instanceof CreateRoomReachabilityError) {
            if (e.code === "user_not_found") {
              return reply.code(404).send({ error: e.code });
            }
            return reply.code(403).send({ error: e.code });
          }
          throw e;
        }
      }
      try {
        const {
          actorId,
          kind: k,
          membershipEvent,
          membershipMessageId,
          humanMembershipTransitions,
        } = await addRoomMember(roomId, { userId: targetUserId }, roomRole);
        if (membershipEvent && membershipMessageId !== undefined) {
          await produceMembershipEvent({
            type: "room.member_joined",
            roomId,
            subjectUserId: targetUserId,
            initiatorActorId: request.sessionActorId!,
            initiatorUserId: userId,
            membershipMessageId,
          });
        }
        let protectedNamespaceId: string | null = null;
        if (membershipEvent) {
          protectedNamespaceId = await convergeThenPublishMembershipChanged(
            roomId,
            membershipEvent,
            humanMembershipTransitions?.[0] !== undefined,
            () => convergeHumanRoomCatalog(targetUserId, actorId),
          );
        } else {
          await convergeHumanRoomCatalog(targetUserId, actorId);
        }
        roomAudit(request, {
          kind: "room_member_added",
          actorId: request.sessionActorId,
          targetActorId: actorId,
          targetActorKind: k,
          targetUserId,
          roomId,
          roomRole,
        });
        return reply.send({
          ok: true,
          actorId,
          kind: k,
          protectedEncryption: humanMembershipTransitions?.[0] === undefined
              || protectedNamespaceId === null
            ? undefined
            : {
                status: "pending",
                namespaceId: protectedNamespaceId,
                accessRevision:
                  humanMembershipTransitions[0].current
                    .namespaceAccessRevision,
              },
        });
      } catch (e) {
        if (e instanceof ModerationError && e.code === "active_ban") {
          return reply.code(403).send({ code: "active_ban" });
        }
        if (e instanceof MembershipOpError && e.opCode === "already_member") {
          return reply.code(409).send({ code: "already_member" });
        }
        if (e instanceof MembershipOpError && e.opCode === "subthread_member_not_in_parent") {
          return reply.code(400).send({ error: e.opCode, message: e.message });
        }
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ error: msg });
      }
    }

    if (kind === "agent") {
      const agentId = typeof request.body?.agentId === "string" ? request.body.agentId : "";
      if (!agentId) {
        return reply.code(400).send({ error: "agentId is required" });
      }
      if (authz.role !== "server_room_admin") {
        try {
          await assertCanCreateRoomMembers({
            callerUserId: userId,
            members: [{ kind: "agent", id: agentId }],
            isAdmin: false,
          });
        } catch (e) {
          if (e instanceof CreateRoomReachabilityError) {
            if (e.code === "agent_not_found") {
              return reply.code(404).send({ error: e.code });
            }
            return reply.code(403).send({ error: e.code });
          }
          throw e;
        }
      }
      const agent = await findAgentById(agentId);
      if (!agent) {
        return reply.code(404).send({ error: "agent_not_found" });
      }
      try {
        const { actorId, kind: k, membershipEvent } = await addRoomMember(roomId, { agentId }, roomRole);
        if (membershipEvent) {
          await publishMembershipChanged(roomId, membershipEvent, false);
        }
        roomAudit(request, {
          kind: "room_member_added",
          actorId: request.sessionActorId,
          targetActorId: actorId,
          targetActorKind: k,
          targetAgentId: agentId,
          roomId,
          roomRole,
        });
        return reply.send({ ok: true, actorId, kind: k });
      } catch (e) {
        if (e instanceof MembershipOpError && e.opCode === "already_member") {
          return reply.code(409).send({ code: "already_member" });
        }
        if (e instanceof MembershipOpError && e.opCode === "subthread_member_not_in_parent") {
          return reply.code(400).send({ error: e.opCode, message: e.message });
        }
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ error: msg });
      }
    }

    return reply.code(400).send({ error: "kind must be user or agent" });
  });

  app.get<{ Params: { id: string } }>("/api/rooms/:id/addable-users", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) {
      return reply.code(400).send({ error: "invalid room id" });
    }
    try {
      await assertCallerCanManageRoom(userId, roomId);
    } catch (e) {
      if (e instanceof ManageForbiddenError) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      throw e;
    }
    const admin = await userHasCapability(userId, "manage_rooms");
    const users = await listAddableUsersForRoom(roomId, { forAdmin: admin });
    return reply.send({ users });
  });

  app.get<{ Params: { id: string } }>("/api/rooms/:id/addable-agents", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const roomId = request.params.id;
    if (!isUuidString(roomId)) {
      return reply.code(400).send({ error: "invalid room id" });
    }
    try {
      await assertCallerCanManageRoom(userId, roomId);
    } catch (e) {
      if (e instanceof ManageForbiddenError) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      throw e;
    }
    const agents = await listAddableAgentsForRoom(roomId, userId);
    return reply.send({ agents });
  });

  // D193 follow-up — directory of humans visible to the caller. Powers the
  // "New conversation" picker so admins can bootstrap a first shared room
  // with users they don't yet share any room with. Non-admins get the
  // room-roster union (same scope as the previous client-side fan-out).
  app.get("/api/directory/humans", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    // The direct-message picker must not advertise Humans whom the caller
    // cannot actually reach. `manage_rooms` alone can create/manage room
    // containers, but only `manage_members` is the directory-wide
    // reachability bypass used by POST /api/rooms below.
    const isAdmin = await userHasCapability(userId, "manage_members");
    const users = await listDirectoryHumans(userId, { isAdmin });
    return reply.send({ users });
  });

  // D187 (Stack 129) — unified, recency-ranked directory search for the
  // "New conversation" member picker. Searches humans + agents in one call
  // so the client no longer loads the whole directory. See
  // `searchDirectory` in @nautilo/trust for scoping + recency derivation.
  app.get<{
    Querystring: {
      q?: string;
      kind?: string;
      limit?: string;
      offset?: string;
      agentScope?: string;
    };
  }>("/api/directory/search", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const rawKind = (request.query.kind ?? "both").trim().toLowerCase();
    if (rawKind !== "user" && rawKind !== "agent" && rawKind !== "both") {
      return reply.code(400).send({ error: "invalid kind" });
    }
    const rawLimit = Number.parseInt(request.query.limit ?? "", 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20;
    const rawOffset = Number.parseInt(request.query.offset ?? "", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const q = (request.query.q ?? "").trim();
    const rawAgentScope = request.query.agentScope?.trim().toLowerCase();
    if (rawAgentScope !== undefined && rawAgentScope !== "owned") {
      return reply.code(400).send({ error: "invalid agentScope" });
    }
    const isAdmin = await userHasCapability(userId, "manage_members");
    const canInvokeAgents = await userHasCapability(userId, "invoke_agents");
    const results = await searchDirectory(userId, {
      isAdmin,
      canInvokeAgents,
      q,
      kind: rawKind,
      limit,
      offset,
      ...(rawAgentScope === "owned" ? { agentScope: rawAgentScope } : {}),
    });
    return reply.send({ results });
  });

  app.delete<{ Params: { id: string; actorId: string }; Querystring: { bypass?: string } }>(
    "/api/rooms/:id/members/:actorId",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const roomId = request.params.id;
      const actorId = request.params.actorId;
      if (!isUuidString(roomId) || !isUuidString(actorId)) {
        return reply.code(400).send({ error: "invalid id" });
      }

      // M124 (MR8) — self-leave. When the caller removes their OWN actor we
      // skip `assertCallerCanManageRoom` (you don't need manage rights to
      // leave). Guard: the room creator (`rooms.owner_id === sessionUserId`)
      // is blocked with 409 `room_owner_last_admin` until another admin
      // exists, so we never orphan a room without an admin. Mirrors the
      // existing `room_owner` 409 on third-party removal.
      if (actorId === request.sessionActorId) {
        const actorRow = await findActorById(actorId);
        if (!actorRow) {
          return reply.code(404).send({ error: "actor_not_found" });
        }
        const ownerLookup = service.findRoomOwnerUserId ?? findRoomOwnerUserId;
        const ownerId = await ownerLookup(roomId);
        if (ownerId === null) {
          return reply.code(404).send({ error: "room_not_found" });
        }
        const isOwner = ownerId === userId;
        if (isOwner) {
          const otherAdmins = await (service.findOtherAdminMembers ?? findOtherAdminMembers)(
            roomId,
            actorId,
          );
          if (otherAdmins.length === 0) {
            return reply.code(409).send({ code: "room_owner_last_admin" });
          }
        }
        try {
          // `allowOrphanBypass: isOwner` lets the owner's own row be removed
          // after we've confirmed another admin exists (removeRoomMember
          // otherwise throws `room_owner`). Non-owner self-leave never trips
          // that guard, so the flag is a no-op there.
          const {
            kind,
            membershipEvent,
            membershipMessageId,
            humanMembershipTransitions,
          } = await removeRoomMember(roomId, actorId, {
            allowOrphanBypass: isOwner,
          });
          if (
            kind === "user"
            && membershipEvent
            && membershipMessageId !== undefined
          ) {
            await produceMembershipEvent({
              type: "room.member_left",
              roomId,
              subjectUserId: actorRow.ownerId,
              initiatorActorId: request.sessionActorId,
              initiatorUserId: userId,
              membershipMessageId,
            });
          }
          let protectedNamespaceId: string | null = null;
          if (membershipEvent) {
            protectedNamespaceId = await convergeThenPublishMembershipChanged(
              roomId,
              membershipEvent,
              humanMembershipTransitions?.[0] !== undefined,
              () => convergeHumanRoomCatalog(actorRow.ownerId, actorId),
            );
          } else {
            await convergeHumanRoomCatalog(actorRow.ownerId, actorId);
          }
          roomAudit(request, {
            kind: "room_member_self_left",
            actorId: request.sessionActorId,
            roomId,
          });
          return reply.send({
            ok: true,
            kind,
            protectedEncryption: humanMembershipTransitions?.[0] === undefined
                || protectedNamespaceId === null
              ? undefined
              : {
                  status: "pending",
                  namespaceId: protectedNamespaceId,
                  accessRevision:
                    humanMembershipTransitions[0].current
                      .namespaceAccessRevision,
                },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("is not in room")) {
            return reply.code(404).send({ error: "not_in_room" });
          }
          return reply.code(500).send({ error: msg });
        }
      }

      let authz: RoomManagementAuthority;
      try {
        authz = await assertCallerCanManageRoom(userId, roomId);
      } catch (e) {
        if (e instanceof ManageForbiddenError) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        throw e;
      }

      const actorRow = await findActorById(actorId);
      if (!actorRow) {
        return reply.code(404).send({ error: "actor_not_found" });
      }

      const bypass = request.query.bypass === "true";
      const allowOrphanBypass = authz.role === "server_room_admin" && bypass;

      try {
        const {
          kind,
          membershipEvent,
          membershipMessageId,
          humanMembershipTransitions,
        } = await removeRoomMember(roomId, actorId, { allowOrphanBypass });
        if (
          kind === "user"
          && actorRow.kind === "user"
          && request.sessionActorId !== null
          && membershipEvent
          && membershipMessageId !== undefined
        ) {
          await produceMembershipEvent({
            type: "room.member_left",
            roomId,
            subjectUserId: actorRow.ownerId,
            initiatorActorId: request.sessionActorId,
            initiatorUserId: userId,
            membershipMessageId,
          });
        }
        let protectedNamespaceId: string | null = null;
        if (actorRow.kind === "user") {
          if (membershipEvent) {
            protectedNamespaceId = await convergeThenPublishMembershipChanged(
              roomId,
              membershipEvent,
              humanMembershipTransitions?.[0] !== undefined,
              () => convergeHumanRoomCatalog(actorRow.ownerId, actorId),
            );
          } else {
            await convergeHumanRoomCatalog(actorRow.ownerId, actorId);
          }
        } else if (membershipEvent) {
          protectedNamespaceId = await publishMembershipChanged(
            roomId,
            membershipEvent,
            false,
          );
        }
        roomAudit(request, {
          kind: "room_member_removed",
          actorId: request.sessionActorId,
          targetActorId: actorId,
          targetActorKind: kind,
          roomId,
          bypassedRail: allowOrphanBypass,
        });
        return reply.send({
          ok: true,
          kind,
          protectedEncryption: humanMembershipTransitions?.[0] === undefined
              || protectedNamespaceId === null
            ? undefined
            : {
                status: "pending",
                namespaceId: protectedNamespaceId,
                accessRevision:
                  humanMembershipTransitions[0].current
                    .namespaceAccessRevision,
              },
        });
      } catch (e) {
        if (e instanceof MembershipOpError && e.opCode === "room_owner") {
          return reply.code(409).send({ code: "room_owner" });
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("is not in room")) {
          return reply.code(404).send({ error: "not_in_room" });
        }
        return reply.code(500).send({ error: msg });
      }
    },
  );

  /**
   * D128 / D194 C2 — patch a room member's agent mode OR human room-role.
   *
   * Body (exactly one field):
   *   - `{ agentResponseMode: "active" | "mention_only" | "observe" }` — agent rows
   *   - `{ roomRole: "admin" | "member" }` — user rows
   *
   * Manager-only (owner / server-admin) per the existing manage-rooms RBAC.
   *
   * 4xx semantics:
   *   - 400 invalid id / invalid body
   *   - 401 not signed in
   *   - 403 caller cannot manage this room
   *   - 404 (room, actor) row not found OR actor kind mismatch
   */
  app.patch<{ Params: { id: string; actorId: string }; Body: UpdateRoomMemberRequest }>(
    "/api/rooms/:id/members/:actorId",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const roomId = request.params.id;
      const actorId = request.params.actorId;
      if (!isUuidString(roomId) || !isUuidString(actorId)) {
        return reply.code(400).send({ error: "invalid id" });
      }

      const body = request.body;
      const mode = body?.agentResponseMode;
      const roomRole = body?.roomRole;
      const hasValidMode =
        mode === "active" || mode === "mention_only" || mode === "observe";
      const hasValidRole = roomRole === "admin" || roomRole === "member";
      if (!hasValidMode && !hasValidRole) {
        return reply.code(400).send({
          error:
            "provide agentResponseMode ('active' | 'mention_only' | 'observe') or roomRole ('admin' | 'member')",
        });
      }
      if (hasValidMode && hasValidRole) {
        return reply.code(400).send({
          error: "provide agentResponseMode or roomRole, not both",
        });
      }

      try {
        await assertCallerCanManageRoom(userId, roomId);
      } catch (e) {
        if (e instanceof ManageForbiddenError) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        throw e;
      }

      if (hasValidRole) {
        try {
          await updateRoomMemberRole(roomId, actorId, roomRole);
        } catch (e) {
          if (e instanceof MembershipOpError && e.opCode === "not_member") {
            return reply.code(404).send({ error: "not_in_room" });
          }
          if (e instanceof MembershipOpError && e.opCode === "not_agent") {
            return reply.code(404).send({ error: "not_user" });
          }
          throw e;
        }

        roomAudit(request, {
          kind: "room_member_role_updated",
          actorId: request.sessionActorId,
          targetActorId: actorId,
          roomId,
          roomRole,
        });

        const response: UpdateRoomMemberResponse = { actorId, roomRole };
        return reply.send(response);
      }

      try {
        await updateRoomMemberAgentResponseMode(roomId, actorId, mode!);
      } catch (e) {
        if (e instanceof MembershipOpError && e.opCode === "not_member") {
          return reply.code(404).send({ error: "not_in_room" });
        }
        if (e instanceof MembershipOpError && e.opCode === "not_agent") {
          return reply.code(404).send({ error: "not_agent" });
        }
        throw e;
      }

      roomAudit(request, {
        kind: "room_member_response_mode_updated",
        actorId: request.sessionActorId,
        targetActorId: actorId,
        roomId,
        mode: mode!,
      });

      const response: UpdateRoomMemberResponse = {
        actorId,
        agentResponseMode: mode as "active" | "mention_only" | "observe",
      };
      return reply.send(response);
    },
  );

  /**
   * M134 Phase 4 — the requesting user's active focus links in this room.
   * Private to the requester (other members never see your foci). Includes
   * `focusId` (the DELETE route is keyed by it). Calls the lazy expiry sweep.
   */
  app.get<{ Params: { id: string } }>(
    "/api/rooms/:id/focus",
    async (request, reply) => {
      const actorId = request.sessionActorId;
      if (!actorId || !viewerIsAuthenticatedHuman(request.sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const roomId = request.params.id;
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      const detail = await service.getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const handleByActor = new Map(
        detail.members
          .filter((m) => m.kind === "agent")
          .map((m) => [m.actorId, m.handle ?? ""]),
      );
      const eligibleBotActorIds = new Set(
        detail.members
          .filter((m) => m.kind === "agent" && m.agentResponseMode !== "observe")
          .map((m) => m.actorId),
      );
      const db = getSharedDirectDb();
      const foci = await loadActiveFoci(db, roomId, actorId, new Date());
      const recentBotActorIds = (await loadRecentFocusBotActorIds(db, actorId))
        .filter((botActorId) => eligibleBotActorIds.has(botActorId));
      return reply.send({
        foci: foci.map((f) => ({
          focusId: f.focusId,
          botActorId: f.botActorId,
          handle: handleByActor.get(f.botActorId) ?? "",
          expiresAt: f.expiresAt.toISOString(),
          source: f.openedSource,
        })),
        recentBotActorIds,
      });
    },
  );

  /**
   * M134 Phase 4 — open (or extend) a focus on a bot via the UI, no message
   * sent. `source: "ui"`. Body `{ botActorId }` must be an agent member.
   */
  app.post<{ Params: { id: string }; Body: { botActorId?: string } }>(
    "/api/rooms/:id/focus",
    async (request, reply) => {
      const actorId = request.sessionActorId;
      if (!actorId || !viewerIsAuthenticatedHuman(request.sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const roomId = request.params.id;
      if (!isUuidString(roomId)) {
        return reply.code(400).send({ error: "invalid room id" });
      }
      const botActorId = request.body?.botActorId;
      if (typeof botActorId !== "string" || !isUuidString(botActorId)) {
        return reply.code(400).send({ error: "botActorId must be a uuid" });
      }
      const detail = await service.getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const isAgentMember = detail.members.some(
        (m) => m.kind === "agent" && m.actorId === botActorId,
      );
      if (!isAgentMember) {
        return reply
          .code(400)
          .send({ error: "botActorId must be an agent member of the room" });
      }
      const db = getSharedDirectDb();
      const now = new Date();
      const activeFoci = await loadActiveFoci(db, roomId, actorId, now);
      const cleared: string[] = [];
      for (const focus of activeFoci) {
        if (focus.botActorId === botActorId) continue;
        const { botActorId: clearedBotActorId } = await clearFocus(db, {
          roomId,
          userActorId: actorId,
          focusId: focus.focusId,
          reason: "ui selection switched focus",
          now,
        });
        if (!clearedBotActorId) continue;
        cleared.push(clearedBotActorId);
        eventBus.emit({
          type: "conductor.focus_changed",
          laneKey: `room:${roomId}`,
          roomId,
          userActorId: actorId,
          change: "cleared",
          botActorId: clearedBotActorId,
          source: null,
          reason: null,
        });
      }
      const { focusId, expiresAt, created } = await openOrExtendFocus(db, {
        roomId,
        userActorId: actorId,
        botActorId,
        source: "ui",
        reason: "ui selection",
        now,
      });
      eventBus.emit({
        type: "conductor.focus_changed",
        laneKey: `room:${roomId}`,
        roomId,
        userActorId: actorId,
        change: created ? "opened" : "extended",
        botActorId,
        source: "ui",
        reason: "ui selection",
      });
      return reply.send({
        focusId,
        botActorId,
        expiresAt: expiresAt.toISOString(),
        clearedBotActorIds: cleared,
      });
    },
  );

  /**
   * M134 Phase 4 — explicitly clear one of the requester's focus links.
   */
  app.delete<{ Params: { id: string; focusId: string } }>(
    "/api/rooms/:id/focus/:focusId",
    async (request, reply) => {
      const actorId = request.sessionActorId;
      if (!actorId || !viewerIsAuthenticatedHuman(request.sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const roomId = request.params.id;
      const focusId = request.params.focusId;
      if (!isUuidString(roomId) || !isUuidString(focusId)) {
        return reply.code(400).send({ error: "invalid id" });
      }
      const detail = await service.getRoomDetailForMember(roomId, actorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const db = getSharedDirectDb();
      const { botActorId } = await clearFocus(db, {
        roomId,
        userActorId: actorId,
        focusId,
        reason: "user cleared",
        now: new Date(),
      });
      if (botActorId) {
        eventBus.emit({
          type: "conductor.focus_changed",
          laneKey: `room:${roomId}`,
          roomId,
          userActorId: actorId,
          change: "cleared",
          botActorId,
          source: null,
          reason: null,
        });
      }
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { roomId: string }; Body: RoomPostMessageBody }>(
    "/api/rooms/:roomId/messages",
    liveShadowLargeRequestRouteOptions,
    async (request, reply) => {
      // M254 — Guests intentionally hold no Capabilities, but a Guest seated
      // in the canonical guests Group is still a verified room participant.
      // Keep unseated/no-Role callers on the non-leaking 404 path, then let
      // exact Room membership and invocation admission decide the send.
      if (!request.rbacProjection?.highestRole) {
        return reply.code(404).send({ error: "Not found" });
      }
      const actorId = request.sessionActorId;
      if (!actorId) {
        return reply.code(404).send({ error: "Not found" });
      }
      const ordinaryAdmission = await admitOrdinaryOrigin({
        mobileHeader: request.headers[MOBILE_ORDINARY_ORIGIN_HEADER],
        electronHeader: request.headers[ELECTRON_ORDINARY_ORIGIN_HEADER],
        sessionUserId: request.sessionUserId!,
        sessionActorId: actorId,
        method: "POST",
        path: `/api/rooms/${encodeURIComponent(request.params.roomId)}/messages`,
        body: request.body,
      });
      // D566 — origin proof is optional provenance for later host-scoped work,
      // not authority to send an authenticated Room message. A stale, revoked,
      // malformed, or replayed proof therefore contributes no origin. The
      // host-scoped path still fails closed because only a verified origin is
      // forwarded to dispatch.
      await dispatchRoomMessageSend(app, request, reply, {
        roomId: request.params.roomId,
        body: request.body,
        getRoomDetailForMember: service.getRoomDetailForMember,
        ...(service.humanPairIsBlocked
          ? { humanPairIsBlocked: service.humanPairIsBlocked }
          : {}),
        ...(ordinaryAdmission.status === "verified"
          ? { ordinaryOrigin: ordinaryAdmission.origin }
          : {}),
      });
    },
  );

  app.put<{ Params: { roomId: string; messageId: string; emoji: string } }>(
    "/api/rooms/:roomId/messages/:messageId/reactions/:emoji",
    async (request, reply) => {
      if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const sessionActorId = request.sessionActorId;
      const sessionUserId = request.sessionUserId;
      if (!sessionActorId || !sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { roomId, messageId: messageIdRaw, emoji: emojiRaw } = request.params;
      if (!isUuidString(roomId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const messageId = Number.parseInt(messageIdRaw, 10);
      if (
        !Number.isSafeInteger(messageId) ||
        messageId <= 0 ||
        messageId > 2_147_483_647
      ) {
        return reply.code(404).send({ error: "Not found" });
      }
      const emoji = decodeURIComponent(emojiRaw);
      if (!isValidEmojiString(emoji)) {
        return reply.code(400).send({ error: "invalid emoji" });
      }
      const detail = await service.getRoomDetailForMember(roomId, sessionActorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const messageInRoom = service.isMessageInRoom ?? isMessageInRoomQuery;
      const inRoom = await messageInRoom({ messageId, roomId });
      if (!inRoom) {
        return reply.code(404).send({ error: "Not found" });
      }
      const ctx = { userId: sessionUserId, agentId: null };
      await addReaction({ messageId, actorId: sessionActorId, emoji, roomId, ctx });
      const reactions = await listReactionsForMessage({ messageId, ctx });
      return reply.send({ reactions });
    },
  );

  app.delete<{ Params: { roomId: string; messageId: string; emoji: string } }>(
    "/api/rooms/:roomId/messages/:messageId/reactions/:emoji",
    async (request, reply) => {
      if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const sessionActorId = request.sessionActorId;
      const sessionUserId = request.sessionUserId;
      if (!sessionActorId || !sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { roomId, messageId: messageIdRaw, emoji: emojiRaw } = request.params;
      if (!isUuidString(roomId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const messageId = Number.parseInt(messageIdRaw, 10);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return reply.code(404).send({ error: "Not found" });
      }
      const emoji = decodeURIComponent(emojiRaw);
      if (!isValidEmojiString(emoji)) {
        return reply.code(400).send({ error: "invalid emoji" });
      }
      const detail = await service.getRoomDetailForMember(roomId, sessionActorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const messageInRoom = service.isMessageInRoom ?? isMessageInRoomQuery;
      const inRoom = await messageInRoom({ messageId, roomId });
      if (!inRoom) {
        return reply.code(404).send({ error: "Not found" });
      }
      const ctx = { userId: sessionUserId, agentId: null };
      await removeReaction({ messageId, actorId: sessionActorId, emoji, roomId, ctx });
      const reactions = await listReactionsForMessage({ messageId, ctx });
      return reply.send({ reactions });
    },
  );

  // M230 — edit one logical Human turn with optimistic concurrency.
  app.post<{
    Params: { roomId: string; messageId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/messages/:messageId/edit-plan",
    liveShadowLargeRequestRouteOptions,
    async (request, reply) => {
      if (!request.sessionActorId || !request.sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { roomId, messageId: rawMessageId } = request.params;
      const messageId = Number.parseInt(rawMessageId, 10);
      const parsed = humanMessageEditPlanRequestV1Schema.safeParse(request.body);
      if (
        protectedEdit === undefined
        || !isUuidString(roomId)
        || !/^\d+$/u.test(rawMessageId)
        || !Number.isSafeInteger(messageId)
        || messageId < 1
        || !parsed.success
      ) return reply.code(400).send({ error: "invalid_protected_message_edit" });
      return reply.send(await protectedEdit.plan({
        roomId,
        messageId,
        userId: request.sessionUserId,
        actorId: request.sessionActorId,
        clientDeviceId: parsed.data.clientDeviceId,
        expectedRevision: parsed.data.expectedRevision,
        clientIdempotencyKey: parsed.data.clientIdempotencyKey,
      }));
    },
  );

  app.patch<{
    Params: { roomId: string; messageId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/messages/:messageId/protected",
    liveShadowLargeRequestRouteOptions,
    async (request, reply) => {
      if (!request.sessionActorId || !request.sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { roomId, messageId: rawMessageId } = request.params;
      const messageId = Number.parseInt(rawMessageId, 10);
      const parsed = humanMessageEditPreparedRequestV1Schema.safeParse(request.body);
      if (
        protectedEdit === undefined
        || !isUuidString(roomId)
        || !/^\d+$/u.test(rawMessageId)
        || !Number.isSafeInteger(messageId)
        || messageId < 1
        || !parsed.success
      ) return reply.code(400).send({ error: "invalid_protected_message_edit" });
      return reply.send(await protectedEdit.publish({
        roomId,
        messageId,
        userId: request.sessionUserId,
        actorId: request.sessionActorId,
        prepared: parsed.data,
      }));
    },
  );

  app.patch<{
    Params: { roomId: string; messageId: string };
    Body: EditRoomMessageRequest;
  }>(
    "/api/rooms/:roomId/messages/:messageId",
    async (request, reply) => {
      const sessionActorId = request.sessionActorId;
      const sessionUserId = request.sessionUserId;
      if (!sessionActorId || !sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!viewerIsAuthenticatedHuman(sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const { roomId, messageId: messageIdRaw } = request.params;
      if (!isUuidString(roomId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      if (!/^\d+$/.test(messageIdRaw)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const messageId = Number.parseInt(messageIdRaw, 10);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return reply.code(404).send({ error: "Not found" });
      }
      const body = request.body;
      if (
        !body ||
        typeof body.content !== "string" ||
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 0 ||
        body.expectedRevision > 2_147_483_647
      ) {
        return reply.code(400).send({ error: "invalid_message_edit" });
      }

      try {
        const message = await editHumanRoomMessage({
          roomId,
          messageId,
          callerUserId: sessionUserId,
          callerActorId: sessionActorId,
          content: body.content,
          expectedRevision: body.expectedRevision,
        });
        try {
          publishMessageUpdated({ roomId, ...message });
        } catch (err) {
          warn(
            `[rooms] edit message: publish failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
          );
        }
        return reply.send({ message });
      } catch (err) {
        if (err instanceof EncryptionPublicationPolicyError) {
          return reply.code(409).send({
            error: "encryption_policy_conflict",
            code: err.reason,
          });
        }
        if (err instanceof MessageEditError) {
          switch (err.reason) {
            case "not_found":
              return reply.code(404).send({ error: "Not found" });
            case "forbidden":
              return reply.code(403).send({ error: "forbidden" });
            case "room_archived":
              return reply
                .code(403)
                .send({ error: "This room is archived (read-only).", code: "room_archived" });
            case "message_edit_conflict":
              return reply
                .code(409)
                .send({ error: "message_edit_conflict", current: err.current });
            case "invalid_message_content":
            case "ineligible":
              return reply.code(400).send({ error: err.reason });
          }
        }
        warn(
          `[rooms] edit message failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        );
        return reply.code(500).send({ error: "internal error" });
      }
    },
  );

  // ISSUE-M172 — hard-delete a single room message. Sibling of the reaction
  // DELETE route so it carries `roomId` for the room-lane WS emit. The row is
  // physically removed; CASCADE/SET-NULL FKs clean up reactions, recipient
  // read-state, quote-reply links, and focus/subthread anchors. A message that
  // anchors a subthread is refused (409) to avoid violating
  // rooms_subthread_invariant.
  app.delete<{ Params: { roomId: string; messageId: string } }>(
    "/api/rooms/:roomId/messages/:messageId",
    async (request, reply) => {
      if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const sessionActorId = request.sessionActorId;
      const sessionUserId = request.sessionUserId;
      if (!sessionActorId || !sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { roomId, messageId: messageIdRaw } = request.params;
      if (!isUuidString(roomId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const messageId = Number.parseInt(messageIdRaw, 10);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return reply.code(404).send({ error: "Not found" });
      }
      const detail = await service.getRoomDetailForMember(roomId, sessionActorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const messageInRoom = service.isMessageInRoom ?? isMessageInRoomQuery;
      const inRoom = await messageInRoom({ messageId, roomId });
      if (!inRoom) {
        return reply.code(404).send({ error: "Not found" });
      }

      let authority: Awaited<ReturnType<typeof assertUserCanDeleteMessage>>;
      try {
        authority = await assertUserCanDeleteMessage(messageId, sessionUserId);
      } catch (err) {
        if (err instanceof MessageDeleteError) {
          return err.reason === "forbidden"
            ? reply.code(403).send({ error: "forbidden" })
            : reply.code(404).send({ error: "Not found" });
        }
        warn(
          `[rooms] delete message: assert failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        );
        return reply.code(500).send({ error: "internal error" });
      }

      try {
        await deleteMessageWithConvergence({
          roomId,
          messageId,
          actorUserId: sessionUserId,
          actorId: sessionActorId,
          source: "room_message",
          authority,
        });
      } catch (err) {
        if (err instanceof MessageDeleteError) {
          if (err.reason === "message_anchors_thread") {
            return reply.code(409).send({ error: "message_anchors_thread" });
          }
          // "not_found": the row vanished between the assert and the delete.
          return reply.code(404).send({ error: "Not found" });
        }
        warn(
          `[rooms] delete message: deleteMessageHard failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        );
        return reply.code(500).send({ error: "internal error" });
      }

      return reply.send({ ok: true });
    },
  );

  app.get<{ Params: { roomId: string; messageId: string } }>(
    "/api/rooms/:roomId/messages/:messageId/reactions",
    async (request, reply) => {
      if (!viewerIsAuthenticatedHuman(request.sessionUserId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const sessionActorId = request.sessionActorId;
      const sessionUserId = request.sessionUserId;
      if (!sessionActorId || !sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const { roomId, messageId: messageIdRaw } = request.params;
      if (!isUuidString(roomId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const messageId = Number.parseInt(messageIdRaw, 10);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return reply.code(404).send({ error: "Not found" });
      }
      const detail = await service.getRoomDetailForMember(roomId, sessionActorId);
      if (!detail) {
        return reply.code(404).send({ error: "Not found" });
      }
      const messageInRoom = service.isMessageInRoom ?? isMessageInRoomQuery;
      const inRoom = await messageInRoom({ messageId, roomId });
      if (!inRoom) {
        return reply.code(404).send({ error: "Not found" });
      }
      const ctx = { userId: sessionUserId, agentId: null };
      const reactions = await listReactionsForMessage({ messageId, ctx });
      return reply.send({ reactions });
    },
  );
}
