import type { FastifyInstance } from "fastify";
import {
  eq,
  getSharedDirectDb,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import {
  blockHuman,
  getHumanBlockStatus,
  isUuidString,
  listBlockedHumanUserIds,
  unblockHuman,
} from "@nautilo/trust";
import type {
  HumanBlockListResponse,
  HumanBlockStatusResponse,
} from "@nautilo/types";

export type HumanBlockRoutesDeps = Readonly<{
  db?: DirectDatabase;
}>;

function callerSafeStatus(
  userId: string,
  status: Awaited<ReturnType<typeof getHumanBlockStatus>>,
): HumanBlockStatusResponse {
  return {
    userId,
    blockedByViewer: status.blockedByViewer,
    directInteractionBlocked:
      status.blockedByViewer || status.viewerBlockedByPeer,
  };
}

export function humanBlockRoutes(
  app: FastifyInstance,
  deps: HumanBlockRoutesDeps = {},
): void {
  const db = deps.db ?? getSharedDirectDb();

  app.get("/api/human-blocks", async (request, reply) => {
    const callerUserId = request.sessionUserId;
    if (!callerUserId) return reply.code(401).send({ error: "Unauthorized" });
    const response: HumanBlockListResponse = {
      blockedUserIds: await listBlockedHumanUserIds(db, callerUserId),
    };
    return reply.send(response);
  });

  app.get<{ Params: { userId: string } }>(
    "/api/human-blocks/:userId",
    async (request, reply) => {
      const callerUserId = request.sessionUserId;
      if (!callerUserId) return reply.code(401).send({ error: "Unauthorized" });
      const peerUserId = request.params.userId;
      if (!isUuidString(peerUserId) || peerUserId === callerUserId) {
        return reply.code(400).send({ error: "invalid_human_block_target" });
      }
      const status = await getHumanBlockStatus(db, callerUserId, peerUserId);
      return reply.send(callerSafeStatus(peerUserId, status));
    },
  );

  app.put<{ Params: { userId: string } }>(
    "/api/human-blocks/:userId",
    async (request, reply) => {
      const callerUserId = request.sessionUserId;
      if (!callerUserId) return reply.code(401).send({ error: "Unauthorized" });
      const peerUserId = request.params.userId;
      if (!isUuidString(peerUserId) || peerUserId === callerUserId) {
        return reply.code(400).send({ error: "invalid_human_block_target" });
      }
      const [peer] = await db
        .select({ id: users.id, server: users.server })
        .from(users)
        .where(eq(users.id, peerUserId))
        .limit(1);
      if (!peer) return reply.code(404).send({ error: "human_not_found" });
      if (peer.server !== null) {
        return reply.code(422).send({ error: "federated_human_block_unsupported" });
      }
      await blockHuman(db, callerUserId, peerUserId);
      const status = await getHumanBlockStatus(db, callerUserId, peerUserId);
      return reply.send(callerSafeStatus(peerUserId, status));
    },
  );

  app.delete<{ Params: { userId: string } }>(
    "/api/human-blocks/:userId",
    async (request, reply) => {
      const callerUserId = request.sessionUserId;
      if (!callerUserId) return reply.code(401).send({ error: "Unauthorized" });
      const peerUserId = request.params.userId;
      if (!isUuidString(peerUserId) || peerUserId === callerUserId) {
        return reply.code(400).send({ error: "invalid_human_block_target" });
      }
      await unblockHuman(db, callerUserId, peerUserId);
      const status = await getHumanBlockStatus(db, callerUserId, peerUserId);
      return reply.send(callerSafeStatus(peerUserId, status));
    },
  );
}
