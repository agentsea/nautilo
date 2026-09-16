import type { FastifyInstance } from "fastify";
import { warn } from "@nautilo/logger";
import {
  assertUserCanAccessMessage,
  getHumanSenderUserIdForMessageBroadcast,
  getMessageReadState,
  markDelivered,
  markRead,
  MessageAccessError,
} from "@nautilo/trust";
import { recomputeAndPublishNotificationState } from "../realtime/ws-publisher";

export function messagesReadStateRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>("/api/messages/:id/read", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const messageId = Number(request.params.id);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return reply.code(400).send({ error: "invalid id" });
    }
    try {
      await assertUserCanAccessMessage(messageId, userId);
    } catch (err) {
      if (err instanceof MessageAccessError) {
        return reply.code(404).send({ error: "Not found" });
      }
      warn(`messages read-state: assert failed (read): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return reply.code(500).send({ error: "internal error" });
    }

    // Stack 3 cold-review Blocker 3 — sender cannot self-stamp read on their own
    // message. Idempotent 200-noop (matches Slack/Matrix patterns; doesn't break
    // clients that broadcast read events from the sender's own action).
    let humanSenderUserId: string | null = null;
    try {
      humanSenderUserId = await getHumanSenderUserIdForMessageBroadcast(messageId);
    } catch (err) {
      warn(`messages read-state: getHumanSenderUserIdForMessageBroadcast failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return reply.code(500).send({ error: "internal error" });
    }
    if (humanSenderUserId !== null && humanSenderUserId === userId) {
      return reply.send({ ok: true, noop: "self_stamp_ignored" });
    }

    try {
      const { flipped, roomId } = await markRead(messageId, userId);
      // M122 — publish a viewer-scoped unread delta only when the read actually
      // moved (D196 emit-on-change watchpoint). Best-effort; never fail the
      // read on a publish error.
      if (flipped && roomId) {
        await recomputeAndPublishNotificationState({
          roomId,
          recipientUserIds: [userId],
        }).catch(
          (err) => {
            warn(
              `messages read-state: unread publish failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
            );
          },
        );
      }
    } catch (err) {
      warn(`messages read-state: markRead failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return reply.code(500).send({ error: "internal error" });
    }
    return reply.send({ ok: true });
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id/read-state", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const messageId = Number(request.params.id);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return reply.code(400).send({ error: "invalid id" });
    }
    try {
      await assertUserCanAccessMessage(messageId, userId);
    } catch (err) {
      if (err instanceof MessageAccessError) {
        return reply.code(404).send({ error: "Not found" });
      }
      warn(`messages read-state: assert failed (get): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return reply.code(500).send({ error: "internal error" });
    }
    try {
      const state = await getMessageReadState(messageId, userId);
      return reply.send(state);
    } catch (err) {
      warn(`messages read-state: getMessageReadState failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return reply.code(500).send({ error: "internal error" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/delivered", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const messageId = Number(request.params.id);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return reply.code(400).send({ error: "invalid id" });
    }
    try {
      await assertUserCanAccessMessage(messageId, userId);
    } catch (err) {
      if (err instanceof MessageAccessError) {
        return reply.code(404).send({ error: "Not found" });
      }
      warn(`messages read-state: assert failed (delivered): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return reply.code(500).send({ error: "internal error" });
    }

    // Stack 3 cold-review Blocker 3 — sender cannot self-stamp delivered on their own
    // message. Idempotent 200-noop (matches Slack/Matrix patterns; doesn't break
    // clients that broadcast read events from the sender's own action).
    let humanSenderUserId: string | null = null;
    try {
      humanSenderUserId = await getHumanSenderUserIdForMessageBroadcast(messageId);
    } catch (err) {
      warn(`messages read-state: getHumanSenderUserIdForMessageBroadcast failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return reply.code(500).send({ error: "internal error" });
    }
    if (humanSenderUserId !== null && humanSenderUserId === userId) {
      return reply.send({ ok: true, noop: "self_stamp_ignored" });
    }

    try {
      await markDelivered(messageId, userId);
    } catch (err) {
      warn(`messages read-state: markDelivered failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return reply.code(500).send({ error: "internal error" });
    }
    return reply.send({ ok: true });
  });
}
