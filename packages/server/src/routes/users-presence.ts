import type { FastifyInstance } from "fastify";
import { warn } from "@nautilo/logger";
import { getUserLastSeenAt } from "@nautilo/trust";

/**
 * Legacy last-seen read route. The current Room member UIs do not call it.
 *
 * Returns `{ lastSeenAt: ISO-8601 string | null }` for `users.id`.
 * `null` covers both "user does not exist" AND "user has no recorded
 * presence yet" — we do NOT distinguish (existence-leak guard, mirrors
 * the read-state route's 404-for-everything pattern).
 *
 * The `last_seen_at` column is bumped by authenticated HTTP requests,
 * coalesced per user. It is historical request activity, not a live
 * online/idle/offline signal.
 *
 * This legacy route is auth-only. A Room member-presence view must enforce
 * current Room membership rather than rely on this per-user read.
 */
export function usersPresenceRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/users/:id/presence", async (request, reply) => {
    const viewerId = request.sessionUserId;
    if (!viewerId) return reply.code(401).send({ error: "Unauthorized" });

    const targetId = request.params.id;
    if (typeof targetId !== "string" || targetId.length === 0) {
      return reply.code(400).send({ error: "invalid id" });
    }

    try {
      const lastSeen = await getUserLastSeenAt(targetId);
      return reply.send({ lastSeenAt: lastSeen ? lastSeen.toISOString() : null });
    } catch (err) {
      warn(
        `users presence: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      return reply.code(500).send({ error: "internal error" });
    }
  });
}
