import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import { eventBus } from "@nautilo/runtime";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { withListeningServer, authedInject } from "../helpers/request-helpers";
import { connectWsTestClient, httpBaseToWsUrl } from "./helpers/ws-test-client";

describe("/ws room membership churn (integration)", () => {
  test("POST /api/rooms refreshes subscriptions so new room lane events arrive", async () => {
    const fx = await setupOwnerAppFixture({
      suiteName: "wschurn",
      withDefaultAgentGraph: true,
    });
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const url = httpBaseToWsUrl(base, "/ws");
        const client = await connectWsTestClient({ url, token });

        const create = await authedInject(fx.app, {
          method: "POST",
          url: "/api/rooms",
          bearer: token,
          payload: { label: `churn-${Date.now().toString(36).slice(-6)}` },
        });
        expect(create.statusCode).toBe(201);
        const { id: newRoomId } = JSON.parse(create.body) as { id: string };

        const toolCallId = `churn-tc-${Date.now()}`;
        eventBus.emit({
          type: "tool.start",
          laneKey: `room:${newRoomId}`,
          toolCallId,
          toolName: "noop",
        });

        const churnEv = await client.waitForEvent(
          (e): e is { type: string; toolCallId?: string } =>
            typeof e === "object" &&
            e !== null &&
            (e as { type?: string }).type === "tool.start" &&
            (e as { toolCallId?: string }).toolCallId === toolCallId,
          8_000,
        );
        expect(churnEv).toMatchObject({ type: "tool.start" });

        await client.close();
      });
    } finally {
      await fx.cleanup();
    }
  });
});
