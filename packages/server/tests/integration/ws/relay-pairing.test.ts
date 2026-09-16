import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import WebSocket from "ws";
import { RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { authedInject, withListeningServer } from "../helpers/request-helpers";
import { httpBaseToWsUrl } from "./helpers/ws-test-client";

describe("relay pair + /relay WebSocket (integration)", () => {
  test("POST /api/relay/pair then relay:register yields relay:registered", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsrl1" });
    try {
      await withListeningServer(fx.app, async (base) => {
        const bearer = await fx.mintOwnerBearer();
        const pair = await authedInject(fx.app, {
          method: "POST",
          url: "/api/relay/pair",
          bearer,
          payload: { deviceLabel: "integration harness" },
        });
        expect(pair.statusCode).toBe(200);
        const { relayToken } = JSON.parse(pair.body) as { relayToken?: string };
        expect(typeof relayToken).toBe("string");
        expect(relayToken?.startsWith("rty_")).toBe(true);

        const wsUrl = httpBaseToWsUrl(base, "/relay");
        const ws = new WebSocket(wsUrl);
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("relay ws open timeout")), 15_000);
          ws.once("open", () => {
            clearTimeout(t);
            resolve();
          });
          ws.once("error", (e) => {
            clearTimeout(t);
            reject(e);
          });
        });

        const registered = new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("relay:registered timeout")), 15_000);
          ws.on("message", (data) => {
            const text = Buffer.isBuffer(data)
              ? data.toString("utf8")
              : typeof data === "string"
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data).toString("utf8")
                  : Buffer.from(data).toString("utf8");
            const msg = JSON.parse(text) as { type?: string; relayId?: string };
            if (msg.type === "relay:registered") {
              clearTimeout(t);
              resolve();
            }
            if (msg.type === "relay:error") {
              clearTimeout(t);
              reject(new Error("relay:error"));
            }
          });
        });

        const relayId = `int-relay-${Date.now()}`;
        const regPayload = JSON.stringify({
          type: "relay:register",
          relayId,
          userId: fx.ownerId,
          capabilities: { profile: "device-relay" },
          protocolVersion: RELAY_PROTOCOL_VERSION,
          token: relayToken,
        });
        ws.send(regPayload);

        await registered;
        ws.close();
      });
    } finally {
      await fx.cleanup();
    }
  });
});
