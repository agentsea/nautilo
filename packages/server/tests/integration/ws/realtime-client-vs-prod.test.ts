import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import WebSocket from "ws";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createWsRealtimeClient } from "@nautilo/realtime-client";
import { eventBus } from "@nautilo/runtime";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { withListeningServer } from "../helpers/request-helpers";
import { httpBaseToWsUrl } from "./helpers/ws-test-client";

let origWebSocket: typeof globalThis.WebSocket;

beforeAll(() => {
  origWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
});

afterAll(() => {
  globalThis.WebSocket = origWebSocket;
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitUntil timeout (${label}) after ${timeoutMs}ms`);
}

describe("realtime-client vs production /ws (integration)", () => {
  test("first-frame auth + delivery of bus events after open", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsrc1" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const received: unknown[] = [];
        const states: string[] = [];
        const errs: Error[] = [];
        const client = createWsRealtimeClient(httpBaseToWsUrl(base, "/ws"), {
          getToken: async () => token,
          heartbeatIntervalMs: 0,
          heartbeatTimeoutMs: 120_000,
          reconnectBaseMs: 50,
          reconnectMaxMs: 200,
          onStateChange: (s) => states.push(s),
          onError: (e) => errs.push(e),
          onEvent: (e) => received.push(e),
        });
        try {
          await new Promise((r) => setTimeout(r, 800));
          if (!states.includes("open")) {
            throw new Error(
              `expected open state; states=${JSON.stringify(states)} errs=${errs.map((e) => e.message).join(";")}`,
            );
          }
          eventBus.emit({
            type: "worker.complete",
            jobId: "rtc-1",
            result: "success",
          });
          await new Promise((r) => setTimeout(r, 400));
          expect(errs).toEqual([]);
          expect(
            received.some(
              (e) =>
                typeof e === "object" &&
                e !== null &&
                (e as { type?: string }).type === "worker.complete" &&
                (e as { jobId?: string }).jobId === "rtc-1",
            ),
          ).toBe(true);
        } finally {
          client.close();
          await new Promise((r) => setTimeout(r, 100));
        }
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("heartbeat ping/pong with small interval (no stale close)", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsrc2" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const errors: Error[] = [];
        const states: string[] = [];
        const client = createWsRealtimeClient(httpBaseToWsUrl(base, "/ws"), {
          getToken: async () => token,
          heartbeatIntervalMs: 150,
          heartbeatTimeoutMs: 5_000,
          reconnectBaseMs: 50,
          reconnectMaxMs: 200,
          onError: (e) => errors.push(e),
          onStateChange: (s) => states.push(s),
          onEvent: () => {},
        });
        try {
          await waitUntil(() => states.includes("open"), 15_000, "ws open");
          await new Promise((r) => setTimeout(r, 600));
          expect(errors.find((e) => /stale/i.test(e.message))).toBeUndefined();
        } finally {
          client.close();
          await new Promise((r) => setTimeout(r, 100));
        }
      });
    } finally {
      await fx.cleanup();
    }
  });

});
