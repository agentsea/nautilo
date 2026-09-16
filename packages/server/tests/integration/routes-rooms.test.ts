/**
 * Regression guard for core /api/rooms flows (integration, real DB).
 * @see rooms-post-create.integration.test.ts
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect } from "bun:test";
import { eq, roomMembers, rooms } from "@nautilo/db";
import { setupOwnerAppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("POST /api/rooms (integration, routes-rooms)", () => {
  test("owner with default agent graph gets 201 and room-shaped payload", async () => {
    if (process.env["AUTH_MODE"] === "logto") {
      return;
    }
    const fx = await setupOwnerAppFixture({
      suiteName: "routes-rooms",
      withDefaultAgentGraph: true,
    });
    let newRoomId: string | null = null;
    try {
      const token = await fx.mintOwnerBearer();
      const label = `it-room-${Date.now().toString(36).slice(-10)}`;
      const res = await authedInject(fx.app, {
        method: "POST",
        url: "/api/rooms",
        bearer: token,
        payload: { label },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as {
        id: string;
        label: string;
        type: string;
        kind: string;
        graphThreadId: string;
      };
      newRoomId = body.id;
      expect(body.label).toBe(label);
      expect(body.type).toBe("private");
      expect(body.kind).toBe("private");
      expect(body.graphThreadId).toBe(`room:${body.id}`);
      expect(fx.defaultAgentId).toBeDefined();
    } finally {
      if (newRoomId) {
        await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, newRoomId));
        await fx.db.delete(rooms).where(eq(rooms.id, newRoomId));
      }
      await fx.cleanup();
    }
  });
});
