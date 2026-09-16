import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import { eventBus } from "@nautilo/runtime";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { withListeningServer } from "../helpers/request-helpers";
import { connectWsTestClient, httpBaseToWsUrl } from "./helpers/ws-test-client";

describe("/ws multi-client broadcast (integration)", () => {
  test("two sockets on the same server both receive identical global bus payloads", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsm1" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const url = httpBaseToWsUrl(base, "/ws");
        const c1 = await connectWsTestClient({ url, token });
        const c2 = await connectWsTestClient({ url, token });
        eventBus.emit({
          type: "worker.complete",
          jobId: "fanout-job-1",
          result: "success",
        });
        const p = (e: unknown): e is { type: string; jobId?: string } =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "worker.complete" &&
          (e as { jobId?: string }).jobId === "fanout-job-1";
        const [a, b] = await Promise.all([
          c1.waitForEvent(p),
          c2.waitForEvent(p),
        ]);
        expect(a).toEqual(b);
        await c1.close();
        await c2.close();
      });
    } finally {
      await fx.cleanup();
    }
  });

  /**
   * M075 routes most chat/runtime events by `laneKey` room id and user-scoped
   * interrupts by `userId`. Global events (`session.persistence_failed`, etc.)
   * still reach every open socket.
   */
  test("two session tokens for the same owner both see the same broadcast", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsm2" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const url = httpBaseToWsUrl(base, "/ws");
        const t1 = await fx.mintOwnerBearer();
        const t2 = await fx.mintOwnerBearer();
        const c1 = await connectWsTestClient({ url, token: t1 });
        const c2 = await connectWsTestClient({ url, token: t2 });
        eventBus.emit({
          type: "worker.complete",
          jobId: "global-1",
          result: "success",
        });
        const pred = (e: unknown): e is { type: string; jobId?: string } =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "worker.complete" &&
          (e as { jobId?: string }).jobId === "global-1";
        await Promise.all([c1.waitForEvent(pred), c2.waitForEvent(pred)]);
        await c1.close();
        await c2.close();
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("tool.start with room laneKey is delivered to both tabs for the same member", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsmc3", withDefaultAgentGraph: true });
    try {
      const rid = fx.defaultRoomId;
      if (!rid) throw new Error("room");
      await withListeningServer(fx.app, async (base) => {
        const url = httpBaseToWsUrl(base, "/ws");
        const t = await fx.mintOwnerBearer();
        const c1 = await connectWsTestClient({ url, token: t });
        const c2 = await connectWsTestClient({ url, token: t });
        const toolCallId = `wsmc3-${Date.now()}`;
        eventBus.emit({
          type: "tool.start",
          laneKey: `room:${rid}`,
          toolCallId,
          toolName: "noop",
        });
        const pred = (e: unknown): e is { type: string; toolCallId?: string } =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "tool.start" &&
          (e as { toolCallId?: string }).toolCallId === toolCallId;
        await Promise.all([c1.waitForEvent(pred), c2.waitForEvent(pred)]);
        await c1.close();
        await c2.close();
      });
    } finally {
      await fx.cleanup();
    }
  });
});
