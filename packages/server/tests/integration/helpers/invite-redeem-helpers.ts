import { randomUUID } from "node:crypto";
import {
  actors,
  agents,
  profiles,
  credentials,
  channelIdentities,
  groupMembers,
  roomMembers,
  rooms,
  namespaces,
  recoveryCodes,
  users,
  eq,
  inArray,
  sql as dsql,
} from "@nautilo/db";
import { redeemInviteAtomically, type RedeemInviteDeps } from "../../../src/lib/redeem-invite.ts";
import type { AppFixture } from "./app-fixture.ts";

function fakeLogtoAdminClient() {
  return {
    findUserByEmailOrUsername: () => Promise.resolve(null),
    createUser: () => Promise.resolve({ id: randomUUID() }),
    deleteUser: () => Promise.resolve(),
  };
}

export async function redeemServerInviteToken(
  token: string,
  handle: string,
  opts?: { displayName?: string; pin?: string; password?: string; onHumanRoomJoined?: RedeemInviteDeps["onHumanRoomJoined"] },
) {
  const normalized = handle
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 20);
  const safeHandle = normalized.length > 0 ? normalized : `u${Date.now().toString(36).slice(-8)}`;
  return redeemInviteAtomically(
    token,
    {
      handle: safeHandle,
      displayName: opts?.displayName ?? `Invitee ${safeHandle}`,
      password: opts?.password ?? "Str0ng!Pass-w0rd",
      pin: opts?.pin ?? "847291",
    },
    {
      logto: fakeLogtoAdminClient() as never,
      allowLogtoSessionMint: false,
      onHumanRoomJoined: opts?.onHumanRoomJoined,
    },
  );
}

/**
 * Cascade-delete everything redeem-invite creates for a new user. Use in
 * test teardown — `users` has no ON DELETE CASCADE on `profiles.user_id`
 * (and several other tables), so a naive `DELETE FROM users` trips an FK.
 * Safe to call when rows don't exist (each DELETE is filtered).
 */
export async function cleanupInvitee(
  fx: AppFixture,
  userId: string,
): Promise<void> {
  const db = fx.db;

  const userActors = await db
    .select({ id: actors.id, agentId: actors.agentId })
    .from(actors)
    .where(eq(actors.ownerId, userId));
  const actorIds = userActors.map((a) => a.id);
  const agentIds = userActors
    .map((a) => a.agentId)
    .filter((x): x is string => x !== null);

  if (actorIds.length > 0) {
    await db.delete(roomMembers).where(inArray(roomMembers.actorId, actorIds));
  }
  const userRooms = await db
    .select({ id: rooms.id, namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.ownerId, userId));
  const roomIds = userRooms.map((r) => r.id);
  const roomNsIds = userRooms.map((r) => r.namespaceId).filter((x): x is string => x !== null);
  if (roomIds.length > 0) {
    await db.delete(roomMembers).where(inArray(roomMembers.roomId, roomIds));
    await db.delete(rooms).where(inArray(rooms.id, roomIds));
  }
  if (roomNsIds.length > 0) {
    await db.delete(namespaces).where(inArray(namespaces.id, roomNsIds));
  }

  await db.delete(groupMembers).where(eq(groupMembers.userId, userId));
  await db.delete(channelIdentities).where(eq(channelIdentities.userId, userId));
  await db.delete(credentials).where(eq(credentials.userId, userId));
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await db.delete(profiles).where(eq(profiles.userId, userId));

  if (actorIds.length > 0) {
    await db.delete(actors).where(inArray(actors.id, actorIds));
  }
  if (agentIds.length > 0) {
    await db.delete(agents).where(inArray(agents.id, agentIds));
  }

  // Sweep anything else that points at the user via best-effort raw SQL
  // — sessions, jobs, standing_approvals etc. ON DELETE CASCADE where
  // defined; defensive no-op otherwise.
  await db.execute(dsql`DELETE FROM "sessions" WHERE "owner_id" = ${userId}`);
  await db.execute(dsql`DELETE FROM "jobs" WHERE "owner_id" = ${userId}`);

  await db.delete(users).where(eq(users.id, userId));
}
