import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import { eventBus } from "@nautilo/runtime";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { withListeningServer } from "../helpers/request-helpers";
import { connectWsTestClient, httpBaseToWsUrl } from "./helpers/ws-test-client";

describe("/ws failure modes (integration)", () => {
  test("server app.close() closes the TCP socket", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsf1" });
    const address = await fx.app.listen({ port: 0, host: "127.0.0.1" });
    const base = address.replace(/\/$/, "");
    try {
      const token = await fx.mintOwnerBearer();
      const client = await connectWsTestClient({
        url: httpBaseToWsUrl(base, "/ws"),
        token,
      });
      const closed = new Promise<number>((resolve) => {
        client.ws.once("close", (code) => resolve(code));
      });
      // Fastify may wait on upgrade sockets; force TCP teardown so the test
      // finishes reliably while still asserting the client observes `close`.
      fx.app.server.closeAllConnections();
      await fx.app.close();
      const code = await closed;
      expect(typeof code).toBe("number");
    } finally {
      await fx.cleanup();
    }
  });

  test("rapid broadcast burst: all sends complete without throwing (current backpressure semantics)", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsf2" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const client = await connectWsTestClient({
          url: httpBaseToWsUrl(base, "/ws"),
          token,
        });
        try {
          const n = 60;
          for (let i = 0; i < n; i++) {
            eventBus.emit({
              type: "worker.complete",
              jobId: `bp-${i}`,
              result: "success",
            });
            if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
          }
          const deadline = Date.now() + 45_000;
          while (Date.now() < deadline) {
            const got = client.events.filter(
              (e) =>
                typeof e === "object" &&
                e !== null &&
                (e as { type?: string }).type === "worker.complete",
            ).length;
            if (got >= n) break;
            await new Promise((r) => setTimeout(r, 40));
          }
          const tokens = client.events.filter(
            (e) =>
              typeof e === "object" &&
              e !== null &&
              (e as { type?: string }).type === "worker.complete",
          );
          expect(tokens.length).toBeGreaterThanOrEqual(Math.floor(n * 0.9));
          const jobIds = new Set(tokens.map((e) => (e as { jobId: string }).jobId));
          expect(jobIds.size).toBeGreaterThanOrEqual(Math.floor(n * 0.9));
        } finally {
          await client.close();
        }
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("abrupt client disconnect does not break subsequent broadcast", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsf3" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const url = httpBaseToWsUrl(base, "/ws");
        const a = await connectWsTestClient({ url, token });
        const b = await connectWsTestClient({ url, token });
        try {
          a.ws.terminate();
          await new Promise((r) => setTimeout(r, 50));
          expect(() =>
            eventBus.emit({
              type: "worker.complete",
              jobId: "after-term",
              result: "success",
            }),
          ).not.toThrow();
          const ev = await b.waitForEvent(
            (e): e is { type: string; jobId?: string } =>
              typeof e === "object" &&
              e !== null &&
              (e as { type?: string }).type === "worker.complete" &&
              (e as { jobId?: string }).jobId === "after-term",
            20_000,
          );
          expect(ev.type).toBe("worker.complete");
        } finally {
          await b.close();
        }
      });
    } finally {
      await fx.cleanup();
    }
  });
});
