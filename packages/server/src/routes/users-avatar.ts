import type { FastifyInstance } from "fastify";
import { SHELL_AVATAR_REF, type AvatarRef } from "@nautilo/types";
import { actors, and, db, eq, roomMembers, sql, users } from "@nautilo/db";
import { getProfile } from "@nautilo/agent";
import { userHasCapability } from "@nautilo/trust";
import { sendAvatar } from "./_helpers/avatar";

/**
 * D206 — cross-user avatar fetch route. Powers the `<UserAvatar>`
 * component used by Slack-shape multi-author message rendering and
 * eventually any other surface that needs to display another user's
 * avatar (room members panel, presence dots, etc.).
 *
 * Privacy contract preserved: respects the same `publicProfile` gate
 * as `GET /api/profile/avatar`. Non-admin callers outside a shared room
 * see SHELL unless the target user has opted into `publicProfile=true`.
 * Guests and strangers always see SHELL.
 *
 * D243 (Stack 42) — the response-side helpers (variant selector, lazy
 * thumbnail backfill, cache headers, SHELL fallback) now live in
 * `_helpers/avatar.ts` and are shared with `profile-avatar.ts`. The
 * pre-D243 duplication comment that lived here has been retired
 * because the hoist it asked for is done.
 */

export function usersAvatarRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/users/:id/avatar", async (request, reply) => {
    const viewerId = request.sessionUserId;
    if (!viewerId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const targetId = request.params.id;
    if (typeof targetId !== "string" || targetId.length === 0) {
      return reply.code(400).send({ error: "invalid id" });
    }

    const avatar = await resolveVisibleAvatarFor(targetId, viewerId);
    return sendAvatar(request, reply, avatar);
  });
}

/**
 * D206 + post-D208 smoke — when caller and target share at least one
 * room, room membership IS the trust signal: an admin already admitted
 * both of them. The rest of this resolver applies the privacy-by-default
 * gate for cross-user lookups *outside* shared rooms (directory pickers,
 * presence dots in non-overlapping namespaces, etc.). Without the
 * shared-room exception, unverified household members render as colored
 * initials inside chats they're already members of — the gate strictly
 * worsens the experience compared to every consumer chat app.
 */
async function callerSharesRoomWithTarget(
  callerUserId: string,
  targetUserId: string,
): Promise<boolean> {
  if (callerUserId === targetUserId) return true;
  const [row] = await db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(
      and(
        eq(actors.kind, "user"),
        eq(actors.ownerId, callerUserId),
        sql`${roomMembers.roomId} IN (
          SELECT rm.room_id FROM room_members rm
          INNER JOIN actors a ON rm.actor_id = a.id
          WHERE a.kind = 'user' AND a.owner_id = ${targetUserId}
        )`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function resolveVisibleAvatarFor(
  targetUserId: string,
  callerUserId: string,
): Promise<AvatarRef> {
  // D208 — read humanAvatarRef from users, not profiles.avatar_ref.
  // The latter is the agent avatar (Jeannie/Genie), wrong source for
  // human-author rendering surfaces.
  const [row] = await db
    .select({
      humanAvatarRef: users.humanAvatarRef,
    })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!row) return SHELL_AVATAR_REF;

  // Fast paths: self, server admin, or shared-room participants get the
  // real human avatar. Outside those trust edges, only public profiles
  // expose the real avatar.
  if (
    callerUserId === targetUserId ||
    (await userHasCapability(callerUserId, "manage_members")) ||
    (await callerSharesRoomWithTarget(callerUserId, targetUserId))
  ) {
    const ref = row.humanAvatarRef as AvatarRef | null;
    return ref ?? SHELL_AVATAR_REF;
  }

  // No shared room → fall back to the privacy gate for directory /
  // explorer / pre-room-add surfaces.
  const profile = await getProfile(targetUserId);
  if (!profile?.publicProfile) return SHELL_AVATAR_REF;

  // Cast: jsonb column is typed as `unknown` by drizzle; AvatarRef
  // shape comes from @nautilo/types. Validate minimally.
  const ref = row.humanAvatarRef as AvatarRef | null;
  return ref ?? SHELL_AVATAR_REF;
}
