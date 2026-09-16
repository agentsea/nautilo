import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LogtoAdminClient } from "@nautilo/trust";
import { mintLogtoBearerSessionAfterTrustedAuth } from "../../src/lib/logto-bearer-session-after-trusted-auth";

describe("mintLogtoBearerSessionAfterTrustedAuth", () => {
  const saved = {
    LOGTO_ENDPOINT: process.env["LOGTO_ENDPOINT"],
    LOGTO_TUI_APP_ID: process.env["LOGTO_TUI_APP_ID"],
    LOGTO_RESOURCE: process.env["LOGTO_RESOURCE"],
  };
  let origFetch: typeof fetch;

  beforeEach(() => {
    process.env["LOGTO_ENDPOINT"] = "http://localhost:3301";
    process.env["LOGTO_TUI_APP_ID"] = "tui-client";
    process.env["LOGTO_RESOURCE"] = "https://api.nautilo.test";
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = origFetch;
  });

  test("returns tokens when PAT + token exchange succeed", async () => {
    const logto = {
      async createPersonalAccessToken() {
        return { value: "pat_test_value", name: "nautilo-claim" };
      },
    } as unknown as LogtoAdminClient;

    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://localhost:3301/oidc/token");
      const body = init?.body;
      expect(typeof body).toBe("string");
      const bodyStr = typeof body === "string" ? body : "";
      expect(bodyStr).toContain(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
      );
      expect(bodyStr).toContain("subject_token=pat_test_value");
      return new Response(
        JSON.stringify({
          access_token: "at-jwt",
          refresh_token: "rt",
          expires_in: 3600,
          id_token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJsb2d0by11MSJ9.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await mintLogtoBearerSessionAfterTrustedAuth({
      logto,
      logtoSub: "logto-u1",
    });
    expect(out).toEqual({
      accessToken: "at-jwt",
      refreshToken: "rt",
      expiresIn: 3600,
      idToken: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJsb2d0by11MSJ9.",
    });
  });

  test("returns access-token session when exchange omits refresh_token", async () => {
    const logto = {
      async createPersonalAccessToken() {
        return { value: "pat_x", name: "x" };
      },
    } as unknown as LogtoAdminClient;

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ access_token: "only-access", token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    expect(
      await mintLogtoBearerSessionAfterTrustedAuth({ logto, logtoSub: "u" }),
    ).toEqual({
      accessToken: "only-access",
      expiresIn: 3600,
    });
  });
});
