import type { FastifyInstance } from "fastify";
import { warn } from "@nautilo/logger";
import { getUserLastSeenAt } from "@nautilo/trust";

/**
 * D124 — counterpart presence read-side route.
 *
 * Returns `{ lastSeenAt: ISO-8601 string | null }` for `users.id`.
 * `null` covers both "user does not exist" AND "user has no recorded
 * presence yet" — we do NOT distinguish (existence-leak guard, mirrors
 * the read-state route's 404-for-everything pattern).
 *
 * The `last_seen_at` column is bumped by the per-request preHandler
 * `scheduleLastSeenBump` (coalesced 30s per user). The client polls
 * this route every 30s via `useLastSeen`.
 *
 * TODO(stack-3 follow-up): gate on shared-room membership so users
 * can't enumerate presence for arbitrary user ids. M1 ships ungated
 * (auth-only) — same threat surface as any "online status" indicator.
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
