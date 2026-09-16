import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import { eventBus } from "@nautilo/runtime";
import { namespaces, roomMembers, rooms } from "@nautilo/db";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { authedInject, withListeningServer } from "../helpers/request-helpers";
import { connectWsTestClient, httpBaseToWsUrl } from "./helpers/ws-test-client";

describe("/ws approval.ask + HTTP approval-reply (integration)", () => {
  test("WS receives approval.ask; POST /api/auth/approval-reply returns 200", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsap1" });
    const approvalId = "ap-int-1";
    const threadId = "thread-int-1";
    const [ns] = await fx.db
      .insert(namespaces)
      .values({ scope: "room", label: `ws-ap-${Date.now()}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("namespace");
    const [rm] = await fx.db
      .insert(rooms)
      .values({
        ownerId: fx.ownerId,
        type: "private",
        label: "WS approval int",
        graphThreadId: threadId,
        namespaceId: ns.id,
        humanActorIds: [fx.ownerActorId],
      })
      .returning({ id: rooms.id });
    if (!rm) throw new Error("room");
    await fx.db.insert(roomMembers).values({
      roomId: rm.id,
      actorId: fx.ownerActorId,
      roomRole: "member",
    });

    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const client = await connectWsTestClient({
          url: httpBaseToWsUrl(base, "/ws"),
          token,
        });

        eventBus.emit({
          type: "approval.ask",
          approvalId,
          threadId,
          laneKey: threadId,
          userId: fx.ownerId,
          tools: [{ name: "run_shell", args: { cmd: "echo" } }],
          reason: "integration harness",
          reasonCode: "destructive-tool",
          allowedVerbs: ["once", "room", "always", "deny"],
        });

        const ask = await client.waitForEvent(
          (e): e is { type: string; approvalId?: string } =>
            typeof e === "object" &&
            e !== null &&
            (e as { type?: string }).type === "approval.ask" &&
            (e as { approvalId?: string }).approvalId === approvalId,
        );
        expect(ask.type).toBe("approval.ask");

        const res = await authedInject(fx.app, {
          method: "POST",
          url: "/api/auth/approval-reply",
          bearer: token,
          payload: {
            verb: "once",
            threadId,
            laneKey: threadId,
            approvalId,
          },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { ok?: boolean };
        expect(body.ok).toBe(true);

        await client.close();
      });
    } finally {
      await fx.cleanup();
    }
  });
});
