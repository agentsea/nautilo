import { describe, expect, test } from "bun:test";
import { startChatGPTLoopback } from "../../../src/lib/chatgpt-plan/loopback";
import { CHATGPT_ISSUER, type ChatGPTSession } from "../../../src/lib/chatgpt-plan/oauth";
const hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
const session: ChatGPTSession = { identity: { issuer: CHATGPT_ISSUER, subject: "synthetic-subject", hostId, clientId: "oaiapp_fixture" },
  accessToken: "synthetic-access", refreshToken: "synthetic-refresh", idToken: "synthetic-id", scopes: ["chatgpt.tokens.use.direct"], expiresAt: 1, receivedAt: 0 };
function callback(url: string) {
  const query = new URL(url).searchParams;
  const result = new URL(query.get("redirect_uri")!);
  result.search = new URLSearchParams({ state: query.get("state")!, code: "synthetic-code", client_id: "oaiapp_fixture" }).toString();
  return result;
}

describe("loopback authorization lifecycle", () => {
  test("binds loopback, rejects unrelated traffic, and only completes one exchange", async () => {
    const controller = new AbortController(); let exchanges = 0; let saves = 0;
    const flow = await startChatGPTLoopback({ hostId, signal: controller.signal,
      oauth: { exchange: async () => { exchanges++; return session; } }, complete: async () => { saves++; } });
    try {
      const good = callback(flow.url); expect(good.hostname).toBe("127.0.0.1");
      const bad = new URL(good); bad.searchParams.set("state", "wrong");
      const rejected = await fetch(bad); expect(rejected.status).toBe(400);
      expect(exchanges).toBe(0);
      const accepted = await fetch(good); expect(accepted.status).toBe(200);
      expect(accepted.headers.get("cache-control")).toBe("no-store");
      expect(await accepted.text()).not.toContain("synthetic-access");
      expect(await flow.result).toEqual({ status: "connected" });
      expect(exchanges).toBe(1); expect(saves).toBe(1);
    } finally { flow.cancel(); controller.abort(); }
  });
  test("cancel and expiry do not save credentials", async () => {
    const controller = new AbortController(); let saved = false;
    const flow = await startChatGPTLoopback({ hostId, signal: controller.signal, complete: async () => { saved = true; } });
    controller.abort();
    expect(await flow.result).toEqual({ status: "failed", code: "authorization_expired" });
    expect(saved).toBe(false);
    const second = await startChatGPTLoopback({ hostId, signal: new AbortController().signal, complete: async () => { saved = true; } });
    second.cancel(); expect(await second.result).toEqual({ status: "cancelled" }); expect(saved).toBe(false);
  });
  test("denied consent stops the attempt without token exchange", async () => {
    let exchanged = false;
    const flow = await startChatGPTLoopback({ hostId, signal: new AbortController().signal,
      oauth: { exchange: async () => { exchanged = true; return session; } }, complete: async () => {} });
    try {
      const url = callback(flow.url); url.searchParams.set("error", "access_denied");
      await fetch(url);
      expect(await flow.result).toEqual({ status: "failed", code: "authorization_denied" }); expect(exchanged).toBe(false);
    } finally { flow.cancel(); }
  });
});

test("loopback saves an issued client before a failing token exchange", async () => {
  const order: string[] = [];
  const flow = await startChatGPTLoopback({ hostId, signal: new AbortController().signal,
    issued: async clientId => { expect(clientId).toBe("oaiapp_fixture"); order.push("registration"); },
    oauth: { exchange: async () => { order.push("exchange"); throw new Error("synthetic"); } },
    complete: async () => { order.push("connected"); } });
  try {
    await fetch(callback(flow.url));
    expect(await flow.result).toEqual({ status: "failed", code: "provider_unavailable" });
    expect(order).toEqual(["registration", "exchange"]);
  } finally { flow.cancel(); }
});
