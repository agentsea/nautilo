/**
 * M057 — `runDeviceFlow` state-machine tests with a stubbed fetch.
 *
 * Covers every RFC 8628 branch:
 *   - device-code request failure (network + non-2xx)
 *   - `authorization_pending` polling loop
 *   - `slow_down` interval bump
 *   - `expired_token` recoverable termination
 *   - `access_denied` recoverable termination
 *   - success path
 *   - abort signal mid-poll
 *
 * Plus the `refreshAccessToken` happy + sad paths.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __setDeviceFlowFetch,
  __setDeviceFlowSleep,
  refreshAccessToken,
  runDeviceFlow,
  type DeviceFlowEvent,
} from "../../src/device-flow";

interface QueuedResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

function jsonResponse({ ok, status, body }: QueuedResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
    statusText: ok ? "OK" : "Error",
  });
}

let queue: QueuedResponse[] = [];
let calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  queue = [];
  calls = [];
  __setDeviceFlowFetch(async (url, init) => {
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return jsonResponse(next);
  });
  __setDeviceFlowSleep(async () => {
    /* tests skip real sleeps so slow_down's +5s bump doesn't block. */
  });
});

afterEach(() => {
  __setDeviceFlowFetch(null);
  __setDeviceFlowSleep(null);
});

const codeBody = {
  device_code: "dev-123",
  user_code: "ABCD-EFGH",
  verification_uri: "https://logto.example/activate",
  verification_uri_complete: "https://logto.example/activate?user_code=ABCD-EFGH",
  expires_in: 600,
  interval: 0, // 0 → 0ms sleep so tests don't hang
};

const config = {
  endpoint: "http://logto",
  appId: "tui-app",
  resource: "https://api.nautilo.local",
};

async function collect(
  gen: AsyncGenerator<DeviceFlowEvent>,
  max = 20,
): Promise<DeviceFlowEvent[]> {
  const out: DeviceFlowEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (out.length >= max) break;
  }
  return out;
}

describe("runDeviceFlow", () => {
  test("device-code non-2xx → unrecoverable error", async () => {
    queue.push({ ok: false, status: 500, body: {} });
    const events = await collect(runDeviceFlow(config));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      message: "Device code request failed: 500",
      recoverable: false,
    });
  });

  test("M060 — device-auth request includes prompt=consent (gates offline_access grant)", async () => {
    // Phase 1 evidence: Logto OSS first-party auto-consent path drops
    // `offline_access` from `code.scopes` unless the request carries
    // `prompt=consent`. Without it, `issueRefreshToken` returns false
    // and the client returns users to the device-code prompt
    // every hour. Lock the param so a future refactor can't silently
    // regress.
    queue.push({ ok: true, status: 200, body: codeBody });
    const gen = runDeviceFlow(config);
    await gen.next(); // pull the device-code event
    const body =
      typeof calls[0]?.init?.body === "string" ? calls[0]?.init?.body : "";
    expect(body).toContain("prompt=consent");
    expect(body).toContain("scope=openid+offline_access+profile+email");
  });

  test("authorization_pending → slow_down → success", async () => {
    queue.push({ ok: true, status: 200, body: codeBody });
    queue.push({ ok: false, status: 400, body: { error: "authorization_pending" } });
    queue.push({ ok: false, status: 400, body: { error: "slow_down" } });
    queue.push({
      ok: true,
      status: 200,
      body: {
        access_token: "at-1",
        refresh_token: "rt-1",
        id_token: "header.eyJzdWIiOiJ1LTEifQ.sig",
        expires_in: 3600,
      },
    });

    const events = await collect(runDeviceFlow(config));
    expect(events.map((e) => e.type)).toEqual([
      "code",
      "polling",
      "polling",
      "polling",
      "success",
    ]);
    const last = events.at(-1);
    expect(last?.type).toBe("success");
    if (last?.type === "success") {
      expect(last.data.access_token).toBe("at-1");
      expect(last.data.refresh_token).toBe("rt-1");
    }
    // slow_down bumped the interval by 5_000ms
    // slow_down adds 5s to the current interval. With Logto's
    // omitted-interval default of 5s (RFC 8628 §3.2 fallback), that
    // means the post-`slow_down` polling event reports 10_000ms.
    expect((events[3] as Extract<DeviceFlowEvent, { type: "polling" }>).intervalMs).toBe(10_000);
  });

  test("expired_token returns recoverable error", async () => {
    queue.push({ ok: true, status: 200, body: codeBody });
    queue.push({ ok: false, status: 400, body: { error: "expired_token" } });
    const events = await collect(runDeviceFlow(config));
    const errs = events.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ recoverable: true });
  });

  test("access_denied returns recoverable error", async () => {
    queue.push({ ok: true, status: 200, body: codeBody });
    queue.push({ ok: false, status: 400, body: { error: "access_denied" } });
    const events = await collect(runDeviceFlow(config));
    const errs = events.filter((e) => e.type === "error");
    expect(errs[0]).toMatchObject({ recoverable: true });
    expect((errs[0] as { message: string }).message).toContain("cancelled");
  });

  test("unknown error → unrecoverable", async () => {
    queue.push({ ok: true, status: 200, body: codeBody });
    queue.push({ ok: false, status: 400, body: { error: "borked" } });
    const events = await collect(runDeviceFlow(config));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "error", recoverable: false });
  });

  test("abort signal halts polling", async () => {
    queue.push({ ok: true, status: 200, body: { ...codeBody, interval: 1 } });
    const ctrl = new AbortController();
    const gen = runDeviceFlow({ ...config, signal: ctrl.signal });
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: "code" });
    ctrl.abort();
    const second = await gen.next();
    // On abort, sleep rejects → generator returns; OR the post-sleep
    // signal.aborted check trips. Either way we expect no further
    // events.
    expect(second.done).toBe(true);
  });

  test("fetch throw on device-code → recoverable error", async () => {
    __setDeviceFlowFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const events = await collect(runDeviceFlow(config));
    expect(events[0]).toMatchObject({ type: "error", recoverable: true });
  });
});

describe("refreshAccessToken", () => {
  const resource = "https://api.nautilo.local";

  test("ok path returns { kind: \"ok\", tokens }", async () => {
    queue.push({
      ok: true,
      status: 200,
      body: {
        access_token: "new",
        refresh_token: "rt-new",
        id_token: "h.b.s",
        expires_in: 3600,
      },
    });
    const out = await refreshAccessToken({
      endpoint: "http://logto",
      appId: "tui",
      refreshToken: "rt",
      resource,
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.tokens.access_token).toBe("new");
      expect(out.tokens.refresh_token).toBe("rt-new");
    }
  });

  test("400 + invalid_grant returns { kind: \"invalid_grant\" }", async () => {
    queue.push({ ok: false, status: 400, body: { error: "invalid_grant" } });
    const out = await refreshAccessToken({
      endpoint: "http://logto",
      appId: "tui",
      refreshToken: "rt",
      resource,
    });
    expect(out).toEqual({ kind: "invalid_grant" });
  });

  test("400 + other error returns transient", async () => {
    queue.push({ ok: false, status: 400, body: { error: "invalid_request" } });
    const out = await refreshAccessToken({
      endpoint: "http://logto",
      appId: "tui",
      refreshToken: "rt",
      resource,
    });
    expect(out).toEqual({ kind: "transient", reason: "400 invalid_request" });
  });

  test("fetch throws returns transient", async () => {
    __setDeviceFlowFetch(async () => {
      throw new Error("offline");
    });
    const out = await refreshAccessToken({
      endpoint: "http://logto",
      appId: "tui",
      refreshToken: "rt",
      resource,
    });
    expect(out).toEqual({ kind: "transient", reason: "offline" });
  });

  test("500 returns transient", async () => {
    queue.push({ ok: false, status: 500, body: {} });
    const out = await refreshAccessToken({
      endpoint: "http://logto",
      appId: "tui",
      refreshToken: "rt",
      resource,
    });
    expect(out).toEqual({ kind: "transient", reason: "http 500" });
  });

  test("200 + missing refresh_token returns transient", async () => {
    queue.push({
      ok: true,
      status: 200,
      body: { access_token: "only-access", expires_in: 3600 },
    });
    const out = await refreshAccessToken({
      endpoint: "http://logto",
      appId: "tui",
      refreshToken: "rt",
      resource,
    });
    expect(out).toEqual({ kind: "transient", reason: "missing tokens in response" });
  });
});
