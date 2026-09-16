import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

const base = "http://127.0.0.1:9";
const account = {
  id: "11111111-1111-4111-8111-111111111111",
  service: "Notion",
  origin: "https://www.notion.so",
  label: "Notion",
  status: "connected" as const,
  lastVerifiedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const login = { account, login: { liveViewUrl: "https://live.browser-use.com/?token=opaque", expiresAt: "2026-09-01T01:00:00.000Z" }, createdNewAccount: true };

function url(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("Connected web accounts client contract", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("uses only owner-scoped lifecycle routes and never needs provider fields", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("human-token");
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const requestUrl = url(input);
      seen.push({ url: requestUrl, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const method = init?.method ?? "GET";
      const payload = requestUrl.includes("/connected-web-operations/") ? requestUrl.endsWith("/watch")
        ? { liveViewUrl: "https://live.browser-use.com/?token=opaque" }
        : requestUrl.endsWith("/stop")
          ? { operation: { operationId: account.id, driver: "checking", lifecycle: "running", controlEpoch: 1, activity: { phase: "checking", code: "stop_reconciliation_scheduled", summary: "Stop was requested; Nautilo is reconciling the connected website operation." }, receipt: null, canWatch: false, canStop: false, result: null } }
          : { operationId: account.id, driver: "hosted", lifecycle: "running", controlEpoch: 1, activity: { phase: "working", code: "browsing", summary: "Reading and navigating the website." }, receipt: null, canWatch: true, canStop: true, result: null }
        : requestUrl.endsWith("/activity") ? { deliveryId: "tool-call", accountId: account.id, action: "save_item", stage: "browsing", canWatch: true, canStop: true, terminal: null }
        : requestUrl.endsWith("/connected-web-action-reply") ? { ok: true }
        : requestUrl.endsWith("/watch") ? { liveViewUrl: "https://live.browser-use.com/?token=opaque" }
        : requestUrl.endsWith("/stop") ? { activity: { deliveryId: "tool-call", accountId: account.id, action: "save_item", stage: "finishing", canWatch: false, canStop: false, terminal: "ambiguous" } }
        : requestUrl.endsWith("/read-activity") ? { accountId: account.id, stage: "browsing", canWatch: true }
        : requestUrl.endsWith("/watch-read") ? { liveViewUrl: "https://live.browser-use.com/?token=opaque" }
        : requestUrl.endsWith("/cancel-read") ? { account }
        : requestUrl.endsWith("/finish") ? account
        : requestUrl.endsWith("/close-page") ? { account }
        : requestUrl.endsWith("/cancel-login") ? { account }
        : method === "DELETE" ? { account, websiteSessionWarning: "Disconnecting Nautilo does not sign you out of the website. Use the website's sign out other sessions control if needed." }
        : requestUrl.endsWith("/connected-web-accounts") && method === "GET" ? { accounts: [account], providerSetupStatus: "ready" }
        : login;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    expect(await client.listConnectedWebAccounts()).toEqual({ accounts: [account], providerSetupStatus: "ready" });
    expect(await client.createConnectedWebAccount({ service: "Notion", origin: account.origin, label: "Notion", createAnother: false })).toEqual(login);
    await client.finishConnectedWebAccount(account.id);
    await client.reconnectConnectedWebAccount(account.id);
    await client.openConnectedWebAccountPage(account.id);
    await client.closeConnectedWebAccountPage(account.id);
    await client.cancelConnectedWebAccountLogin(account.id);
    await client.getConnectedWebAccountReadActivity(account.id);
    await client.watchConnectedWebAccountRead(account.id);
    await client.cancelConnectedWebAccountRead(account.id);
    await client.getConnectedWebAccountActionActivity("tool-call");
    await client.watchConnectedWebAccountAction("tool-call");
    await client.stopConnectedWebAccountAction("tool-call");
    await client.getConnectedWebOperation(account.id);
    await client.watchConnectedWebOperation(account.id);
    await client.stopConnectedWebOperation(account.id);
    await client.replyConnectedWebActionAttention({ threadId: "thread-1", laneKey: "lane-1", toolCallId: "tool-call", decision: "done" }, { clientActionSessionId: "session-1", authorizationDeviceId: "device-1" });
    await client.disconnectConnectedWebAccount(account.id);

    expect(seen.map(({ url: requestUrl, method, body }) => ({ url: requestUrl, method, body }))).toEqual([
      { url: `${base}/api/connected-web-accounts`, method: "GET", body: undefined },
      { url: `${base}/api/connected-web-accounts`, method: "POST", body: { service: "Notion", origin: account.origin, label: "Notion", createAnother: false } },
      { url: `${base}/api/connected-web-accounts/${account.id}/finish`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-accounts/${account.id}/reconnect`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-accounts/${account.id}/open-page`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-accounts/${account.id}/close-page`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-accounts/${account.id}/cancel-login`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-accounts/${account.id}/read-activity`, method: "GET", body: undefined },
      { url: `${base}/api/connected-web-accounts/${account.id}/watch-read`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-accounts/${account.id}/cancel-read`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-actions/tool-call/activity`, method: "GET", body: undefined },
      { url: `${base}/api/connected-web-actions/tool-call/watch`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-actions/tool-call/stop`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-operations/${account.id}`, method: "GET", body: undefined },
      { url: `${base}/api/connected-web-operations/${account.id}/watch`, method: "POST", body: {} },
      { url: `${base}/api/connected-web-operations/${account.id}/stop`, method: "POST", body: {} },
      { url: `${base}/api/auth/connected-web-action-reply`, method: "POST", body: { threadId: "thread-1", laneKey: "lane-1", toolCallId: "tool-call", decision: "done", clientActionSessionId: "session-1", authorizationDeviceId: "device-1" } },
      { url: `${base}/api/connected-web-accounts/${account.id}`, method: "DELETE", body: undefined },
    ]);
  });

  test("rejects an action activity response with provider fields", async () => {
    const client = new NautiloApiClient(base);
    globalThis.fetch = (async () => new Response(JSON.stringify({
      deliveryId: "tool-call", accountId: account.id, action: "save_item",
      stage: "browsing", canWatch: true, canStop: true, terminal: null,
      providerRunId: "must-not-reach-browser",
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    let rejected = false;
    try {
      await client.getConnectedWebAccountActionActivity("tool-call");
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
