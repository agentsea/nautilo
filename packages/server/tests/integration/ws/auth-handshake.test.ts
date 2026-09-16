import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import WebSocket from "ws";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { withListeningServer } from "../helpers/request-helpers";
import {
  connectWsTestClient,
  httpBaseToWsUrl,
  openWsAwaitingAuth,
  WS_AUTH_CLOSE_CODE,
} from "./helpers/ws-test-client";

describe("/ws M058 auth handshake (integration)", () => {
  test("valid token → auth.accepted then connection stays open", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsh1" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const token = await fx.mintOwnerBearer();
        const client = await connectWsTestClient({
          url: httpBaseToWsUrl(base, "/ws"),
          token,
        });
        expect(client.events.some((e) => (e as { type?: string }).type === "auth.accepted")).toBe(
          true,
        );
        expect(client.ws.readyState).toBe(WebSocket.OPEN);
        await client.close();
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("bad token → auth.rejected then 4401", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsh2" });
    try {
      await withListeningServer(fx.app, async (base) => {
        let rejectionMessage: string | null = null;
        try {
          await connectWsTestClient({
            url: httpBaseToWsUrl(base, "/ws"),
            token: "not-a-real-session-token",
            waitForHandshakeMs: 5_000,
          });
        } catch (err) {
          rejectionMessage = err instanceof Error ? err.message : String(err);
        }
        expect(rejectionMessage).toMatch(/auth\.rejected: invalid_token/);

        const frames: unknown[] = [];
        const close = await new Promise<{ code: number; reason: string }>((resolve) => {
          const ws = new WebSocket(httpBaseToWsUrl(base, "/ws"));
          ws.on("message", (d) => {
            try {
              const text = Buffer.isBuffer(d)
                ? d.toString("utf8")
                : typeof d === "string"
                  ? d
                  : Array.isArray(d)
                    ? Buffer.concat(d).toString("utf8")
                    : Buffer.from(d).toString("utf8");
              frames.push(JSON.parse(text));
            } catch {
              /* ignore */
            }
          });
          ws.on("open", () => {
            ws.send(JSON.stringify({ type: "auth", token: "bogus" }));
          });
          ws.on("close", (code, reason) => {
            resolve({ code, reason: reason.toString() });
          });
        });
        expect(close.code).toBe(WS_AUTH_CLOSE_CODE);
        const rej = frames.find(
          (e) => (e as { type?: string }).type === "auth.rejected",
        ) as { error?: string } | undefined;
        expect(rej?.error).toBe("invalid_token");
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("wrong first JSON shape → auth_required + 4401", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsh3" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const raw = await openWsAwaitingAuth(httpBaseToWsUrl(base, "/ws"));
        raw.ws.send(JSON.stringify({ hello: "world" }));
        await new Promise<void>((r, j) => {
          const t = setTimeout(() => j(new Error("close timeout")), 5_000);
          raw.ws.once("close", (code) => {
            clearTimeout(t);
            expect(code).toBe(WS_AUTH_CLOSE_CODE);
            r();
          });
        });
        const rej = raw.events.find(
          (e) => (e as { type?: string }).type === "auth.rejected",
        ) as { error?: string } | undefined;
        expect(rej?.error).toBe("auth_required");
        await raw.close();
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("non-JSON first frame → 1003 non_json (no auth.rejected payload)", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsh4" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const raw = await openWsAwaitingAuth(httpBaseToWsUrl(base, "/ws"));
        raw.ws.send(Buffer.from("not json {"));
        const code = await new Promise<number>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("close timeout")), 5_000);
          raw.ws.once("close", (c) => {
            clearTimeout(t);
            resolve(c);
          });
        });
        expect(code).toBe(1003);
        const rejected = raw.events.some(
          (e) => (e as { type?: string }).type === "auth.rejected",
        );
        expect(rejected).toBe(false);
        await raw.close();
      });
    } finally {
      await fx.cleanup();
    }
  });

  test("auth_timeout when first frame is late", async () => {
    const prev = process.env["NAUTILO_WS_AUTH_TIMEOUT_MS"];
    process.env["NAUTILO_WS_AUTH_TIMEOUT_MS"] = "400";
    const fx = await setupOwnerAppFixture({ suiteName: "wsh5" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const raw = await openWsAwaitingAuth(httpBaseToWsUrl(base, "/ws"));
        // Attach the close listener BEFORE waiting past the (short) auth
        // timeout — otherwise the server's auth_timeout close fires while
        // we're still in setTimeout(900) and `ws.once("close")` misses the
        // already-emitted event, which manifests as a phantom timeout.
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("close timeout")), 8_000);
          if (
            raw.ws.readyState === WebSocket.CLOSED ||
            raw.ws.readyState === WebSocket.CLOSING
          ) {
            clearTimeout(t);
            resolve();
            return;
          }
          raw.ws.once("close", () => {
            clearTimeout(t);
            resolve();
          });
        });
        const rej = raw.events.find(
          (e) => (e as { type?: string }).type === "auth.rejected",
        ) as { error?: string } | undefined;
        expect(rej?.error).toBe("auth_timeout");
        await raw.close();
      });
    } finally {
      if (prev === undefined) delete process.env["NAUTILO_WS_AUTH_TIMEOUT_MS"];
      else process.env["NAUTILO_WS_AUTH_TIMEOUT_MS"] = prev;
      await fx.cleanup();
    }
  });
});
