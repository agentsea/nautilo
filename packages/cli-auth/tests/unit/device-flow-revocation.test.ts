/**
 * M062 — `revokeRefreshToken` (RFC 7009) with stubbed fetch + logger.
 *
 * `mock.module` must run before importing `device-flow-client` (see
 * `packages/server/tests/unit/approval-reply-dispatch.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const warns: string[] = [];
mock.module("@nautilo/logger", () => ({
  warn: (m: string) => {
    warns.push(m);
  },
}));

import {
  __setDeviceFlowFetch,
  revokeRefreshToken,
} from "../../src/device-flow";

let calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  warns.length = 0;
  calls = [];
  __setDeviceFlowFetch(async (url, init) => {
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    return new Response(null, { status: 200 });
  });
});

afterEach(() => {
  __setDeviceFlowFetch(null);
});

describe("revokeRefreshToken", () => {
  test("200 → resolves; POST body has client_id, token, token_type_hint", async () => {
    await revokeRefreshToken({
      endpoint: "http://logto:3301",
      appId: "tui-app",
      refreshToken: "rt-secret",
    });
    expect(warns).toEqual([]);
    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first?.url).toBe("http://logto:3301/oidc/token/revocation");
    const body = typeof first?.init?.body === "string" ? first.init.body : "";
    const params = new URLSearchParams(body);
    expect(params.get("client_id")).toBe("tui-app");
    expect(params.get("token")).toBe("rt-secret");
    expect(params.get("token_type_hint")).toBe("refresh_token");
  });

  test("204 → resolves silently", async () => {
    __setDeviceFlowFetch(async (url) => {
      calls.push({ url });
      return new Response(null, { status: 204 });
    });
    await revokeRefreshToken({
      endpoint: "http://logto",
      appId: "a",
      refreshToken: "r",
    });
    expect(warns).toEqual([]);
  });

  test("4xx → logs warn, resolves", async () => {
    __setDeviceFlowFetch(async (url, init) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });
    await revokeRefreshToken({
      endpoint: "http://logto",
      appId: "a",
      refreshToken: "r",
    });
    expect(warns.some((w) => w.includes("HTTP 400"))).toBe(true);
  });

  test("network error → logs warn, resolves (no throw)", async () => {
    __setDeviceFlowFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await revokeRefreshToken({
      endpoint: "http://logto",
      appId: "a",
      refreshToken: "r",
    });
    expect(warns.some((w) => w.includes("ECONNREFUSED"))).toBe(true);
  });
});
