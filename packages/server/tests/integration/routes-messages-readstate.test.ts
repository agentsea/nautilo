/**
 * D124 — POST/GET /api/messages/:id/read-state (integration).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect } from "bun:test";
import { eq, sessions, sessionMessages } from "@nautilo/db";
import { setupOwnerAppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("D124 messages read-state routes", () => {
  test("POST read + GET read-state happy path", async () => {
    if (process.env["AUTH_MODE"] === "logto") {
      return;
    }
    const fx = await setupOwnerAppFixture({
      suiteName: "mrs",
      withDefaultAgentGraph: true,
    });
    let sessionId: string | null = null;
    let messageId: number | null = null;
    try {
      const roomId = fx.defaultRoomId!;
      const [sess] = await fx.db
        .insert(sessions)
        .values({
          threadId: `room:${roomId}`,
          ownerId: fx.ownerId,
          personaId: "owner",
          agentId: fx.defaultAgentId!,
          roomId,
          channel: "tui",
        })
        .returning({ id: sessions.id });
      if (!sess) throw new Error("sess");
      sessionId = sess.id;
      const [msg] = await fx.db
        .insert(sessionMessages)
        .values({ sessionId: sess.id, role: "assistant", content: "body" })
        .returning({ id: sessionMessages.id });
      if (!msg) throw new Error("msg");
      messageId = msg.id;

      const token = await fx.mintOwnerBearer();
      const post = await authedInject(fx.app, {
        method: "POST",
        url: `/api/messages/${msg.id}/read`,
        bearer: token,
        payload: {},
      });
      expect(post.statusCode).toBe(200);

      const get = await authedInject(fx.app, {
        method: "GET",
        url: `/api/messages/${msg.id}/read-state`,
        bearer: token,
      });
      expect(get.statusCode).toBe(200);
      const body = JSON.parse(get.body) as { selfRead: boolean; shape: string };
      expect(body.shape).toBe("1:1");
      expect(body.selfRead).toBe(true);
    } finally {
      if (messageId != null) {
        await fx.db.delete(sessionMessages).where(eq(sessionMessages.id, messageId));
      }
      if (sessionId) {
        await fx.db.delete(sessions).where(eq(sessions.id, sessionId));
      }
      await fx.cleanup();
    }
  });
});
