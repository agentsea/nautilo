import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  actors,
  and,
  db,
  eq,
  roomMembers,
  rooms,
  sql,
  users,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { userHasCapability } from "@nautilo/trust";
import { writeSecurityAuditEvent, type SecurityAuditEvent } from "../lib/security-audit-log";

function auditPath(): string {
  return join(homedir(), ".nautilo", "logs", "security-audit.log");
}

function audit(request: FastifyRequest, event: Record<string, unknown>): void {
  try {
    writeSecurityAuditEvent(auditPath(), {
      ...event,
      ts: new Date().toISOString(),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    } as SecurityAuditEvent);
  } catch (err) {
    warn(`[admin-rooms] audit write failed: ${String(err)}`);
  }
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const userId = request.sessionUserId;
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  if (!(await userHasCapability(userId, "manage_members"))) {
    reply.code(403).send({ error: "Forbidden" });
    return null;
  }
  return userId;
}

interface SharedRoomMember {
  userId: string;
  handle: string | null;
  displayName: string;
  federated: boolean;
}

interface OwnedSharedRoom {
  roomId: string;
  label: string;
  /** Other human members eligible to receive ownership (non-federated only). */
  eligibleNewOwners: SharedRoomMember[];
}

/**
 * Rooms OWNED by `targetUserId` that have at least one OTHER human member —
 * exactly the set that triggers the `owns_shared_rooms` delete blocker. For
 * each, list the other human members (federated flagged + excluded from the
 * eligible-owner list, since a foreign stub can't own a local room).
 */
async function getOwnedSharedRooms(targetUserId: string): Promise<OwnedSharedRoom[]> {
  const rows = await db
    .select({
      roomId: rooms.id,
      label: rooms.label,
      memberUserId: actors.ownerId,
      handle: users.handle,
      displayName: users.name,
      server: users.server,
    })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .innerJoin(users, eq(users.id, actors.ownerId))
    .where(
      and(
        eq(rooms.ownerId, targetUserId),
        eq(actors.kind, "user"),
        sql`${actors.ownerId} <> ${targetUserId}`,
      ),
    );

  const byRoom = new Map<string, OwnedSharedRoom>();
  for (const r of rows) {
    if (!r.memberUserId) continue;
    let entry = byRoom.get(r.roomId);
    if (!entry) {
      entry = { roomId: r.roomId, label: r.label, eligibleNewOwners: [] };
      byRoom.set(r.roomId, entry);
    }
    const federated = r.server !== null;
    if (!entry.eligibleNewOwners.some((m) => m.userId === r.memberUserId)) {
      entry.eligibleNewOwners.push({
        userId: r.memberUserId,
        handle: r.handle,
        displayName: r.displayName,
        federated,
      });
    }
  }
  // Drop federated members from the eligible list (cannot own a local room).
  for (const entry of byRoom.values()) {
    entry.eligibleNewOwners = entry.eligibleNewOwners.filter((m) => !m.federated);
  }
  return [...byRoom.values()];
}

export function adminRoomsRoutes(app: FastifyInstance): void {
  // D298 — list the shared rooms owned by a user that block their deletion,
  // plus the members eligible to receive ownership. Powers the admin delete
  // resolution UI.
  app.get<{ Params: { userId: string } }>(
    "/api/admin/users/:userId/owned-shared-rooms",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;
      const sharedRooms = await getOwnedSharedRooms(request.params.userId);
      return reply.send({ rooms: sharedRooms });
    },
  );

  // D298 — transfer ownership of a single room to another human member. The
  // recovery path for `owns_shared_rooms`: once a user owns no shared rooms,
  // the delete guard clears naturally.
  app.post<{ Params: { roomId: string }; Body: { newOwnerUserId?: unknown } }>(
    "/api/admin/rooms/:roomId/transfer-owner",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;

      const newOwnerUserId = request.body?.newOwnerUserId;
      if (typeof newOwnerUserId !== "string" || newOwnerUserId.trim() === "") {
        return reply.code(400).send({ error: "newOwnerUserId is required" });
      }

      const [room] = await db
        .select({ id: rooms.id, ownerId: rooms.ownerId })
        .from(rooms)
        .where(eq(rooms.id, request.params.roomId))
        .limit(1);
      if (!room) return reply.code(404).send({ error: "room_not_found" });

      if (room.ownerId === newOwnerUserId) {
        return reply.code(409).send({ code: "already_owner" });
      }

      // The new owner must be a non-federated human member of THIS room.
      const [target] = await db
        .select({ id: users.id, server: users.server })
        .from(users)
        .where(eq(users.id, newOwnerUserId))
        .limit(1);
      if (!target) return reply.code(404).send({ error: "user_not_found" });
      if (target.server !== null) {
        return reply.code(422).send({ code: "federated_user" });
      }

      const [membership] = await db
        .select({ actorId: roomMembers.actorId })
        .from(roomMembers)
        .innerJoin(actors, eq(actors.id, roomMembers.actorId))
        .where(
          and(
            eq(roomMembers.roomId, request.params.roomId),
            eq(actors.kind, "user"),
            eq(actors.ownerId, newOwnerUserId),
          ),
        )
        .limit(1);
      if (!membership) {
        return reply.code(409).send({ code: "not_a_member" });
      }

      const fromUserId = room.ownerId;
      // Single-statement UPDATE — the shared neon-http `db` handles this fine
      // (it only lacks multi-statement transactions). No cascade here: the new
      // owner is already a member, so humanActorIds / membership are unchanged.
      await db
        .update(rooms)
        .set({ ownerId: newOwnerUserId, updatedAt: new Date() })
        .where(eq(rooms.id, request.params.roomId));

      audit(request, {
        kind: "room_ownership_transferred",
        actorId: callerUserId,
        roomId: request.params.roomId,
        fromUserId,
        toUserId: newOwnerUserId,
      });

      return reply.send({ ok: true });
    },
  );

  // D298 — archive a room: migrate ownership to the acting admin (caretaker)
  // and freeze it so it survives the original owner's cascade delete.
  app.post<{ Params: { roomId: string } }>(
    "/api/admin/rooms/:roomId/archive",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;

      const [room] = await db
        .select({ id: rooms.id, ownerId: rooms.ownerId, archivedAt: rooms.archivedAt })
        .from(rooms)
        .where(eq(rooms.id, request.params.roomId))
        .limit(1);
      if (!room) return reply.code(404).send({ error: "room_not_found" });

      if (room.archivedAt != null) {
        return reply.code(409).send({ code: "already_archived" });
      }

      const fromUserId = room.ownerId;
      await db
        .update(rooms)
        .set({ archivedAt: new Date(), ownerId: callerUserId, updatedAt: new Date() })
        .where(eq(rooms.id, request.params.roomId));

      audit(request, {
        kind: "room_archived",
        actorId: callerUserId,
        roomId: request.params.roomId,
        fromUserId,
        byUserId: callerUserId,
      });

      return reply.send({ ok: true });
    },
  );

  // D298 — unarchive a room: restore read-write; ownership stays with caretaker.
  app.post<{ Params: { roomId: string } }>(
    "/api/admin/rooms/:roomId/unarchive",
    async (request, reply) => {
      const callerUserId = await requireAdmin(request, reply);
      if (!callerUserId) return;

      const [room] = await db
        .select({ id: rooms.id, ownerId: rooms.ownerId, archivedAt: rooms.archivedAt })
        .from(rooms)
        .where(eq(rooms.id, request.params.roomId))
        .limit(1);
      if (!room) return reply.code(404).send({ error: "room_not_found" });

      if (room.archivedAt == null) {
        return reply.code(409).send({ code: "not_archived" });
      }

      await db
        .update(rooms)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(eq(rooms.id, request.params.roomId));

      audit(request, {
        kind: "room_unarchived",
        actorId: callerUserId,
        roomId: request.params.roomId,
        byUserId: callerUserId,
      });

      return reply.send({ ok: true });
    },
  );
}
