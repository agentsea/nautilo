import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import { eventBus } from "@nautilo/runtime";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { withListeningServer } from "../helpers/request-helpers";
import {
  connectWsTestClient,
  httpBaseToWsUrl,
  openWsAwaitingAuth,
} from "./helpers/ws-test-client";

describe("/ws event flow (integration)", () => {
  test("after auth, eventBus.emit delivers global worker.complete to client", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wse1" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const client = await connectWsTestClient({
          url: httpBaseToWsUrl(base, "/ws"),
          token,
        });
        try {
          eventBus.emit({
            type: "worker.complete",
            jobId: "int-ws-1",
            result: "success",
          });
          await new Promise((r) => setTimeout(r, 0));
          const ev = await client.waitForEvent(
            (e): e is { type: string; jobId?: string } =>
              typeof e === "object" &&
              e !== null &&
              (e as { type?: string }).type === "worker.complete" &&
              (e as { jobId?: string }).jobId === "int-ws-1",
          );
          expect(ev.type).toBe("worker.complete");
        } finally {
          await client.close();
          await new Promise((r) => setTimeout(r, 50));
        }
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("pre-auth socket does not receive broadcast; post-auth does", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wse2" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const raw = await openWsAwaitingAuth(httpBaseToWsUrl(base, "/ws"));
        try {
          eventBus.emit({
            type: "worker.complete",
            jobId: "before-auth",
            result: "success",
          });
          await new Promise((r) => setTimeout(r, 80));
          const token = await fx.mintOwnerBearer();
          raw.ws.send(JSON.stringify({ type: "auth", token }));
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("auth.accepted timeout")), 10_000);
            const onMsg = () => {
              if (
                raw.events.some(
                  (e) => (e as { type?: string }).type === "auth.accepted",
                )
              ) {
                clearTimeout(t);
                raw.ws.off("message", onMsg);
                resolve();
              }
            };
            raw.ws.on("message", onMsg);
            onMsg();
          });
          eventBus.emit({
            type: "worker.complete",
            jobId: "after-auth",
            result: "success",
          });
          await new Promise((r) => setTimeout(r, 150));
          const ids = raw.events
            .map((e) => (e as { jobId?: string }).jobId)
            .filter(Boolean);
          expect(ids).not.toContain("before-auth");
          expect(ids).toContain("after-auth");
        } finally {
          await raw.close();
          await new Promise((r) => setTimeout(r, 50));
        }
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("client ping after auth → server pong with numeric timestamp", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wse3" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const client = await connectWsTestClient({
          url: httpBaseToWsUrl(base, "/ws"),
          token,
        });
        try {
          client.send({ type: "ping" });
          await new Promise((r) => setTimeout(r, 0));
          const pong = await client.waitForEvent(
            (e): e is { type: string; timestamp?: number } =>
              typeof e === "object" &&
              e !== null &&
              (e as { type?: string }).type === "pong",
          );
          expect(pong.type).toBe("pong");
          expect(typeof pong.timestamp).toBe("number");
        } finally {
          await client.close();
          await new Promise((r) => setTimeout(r, 50));
        }
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("before auth, server sends no frames in a short window", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wse4" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const raw = await openWsAwaitingAuth(httpBaseToWsUrl(base, "/ws"));
        try {
          await new Promise((r) => setTimeout(r, 250));
          expect(raw.events.length).toBe(0);
        } finally {
          await raw.close();
          await new Promise((r) => setTimeout(r, 50));
        }
      });
    } finally {
      await fx.cleanup();
    }
  });
});
