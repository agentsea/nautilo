/**
 * M120 — reset-password handoff URL must start a Logto OIDC interaction.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildResetPasswordAuthorizeUrl,
  resolveRecoveryRedirectBase,
} from "../../src/lib/logto-recover-with-code";

const PREV_WORKBENCH_APP_ID = process.env["LOGTO_WORKBENCH_APP_ID"];
const PREV_PUBLIC_BASE_URL = process.env["NAUTILO_PUBLIC_BASE_URL"];

afterEach(() => {
  if (PREV_WORKBENCH_APP_ID === undefined) delete process.env["LOGTO_WORKBENCH_APP_ID"];
  else process.env["LOGTO_WORKBENCH_APP_ID"] = PREV_WORKBENCH_APP_ID;
  if (PREV_PUBLIC_BASE_URL === undefined) delete process.env["NAUTILO_PUBLIC_BASE_URL"];
  else process.env["NAUTILO_PUBLIC_BASE_URL"] = PREV_PUBLIC_BASE_URL;
});

describe("buildResetPasswordAuthorizeUrl", () => {
  test("builds OIDC authorize URL for Logto reset-password first screen", () => {
    process.env["LOGTO_WORKBENCH_APP_ID"] = "workbench-client";
    process.env["NAUTILO_PUBLIC_BASE_URL"] = "http://localhost:3101";

    const url = new URL(
      buildResetPasswordAuthorizeUrl({
        logtoEndpoint: "http://localhost:3401",
        email: "test-user@nautilo.local",
      }),
    );

    expect(url.origin).toBe("http://localhost:3401");
    expect(url.pathname).toBe("/oidc/auth");
    expect(url.searchParams.get("client_id")).toBe("workbench-client");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3101/auth/callback");
    expect(url.searchParams.get("first_screen")).toBe("reset_password");
    expect(url.searchParams.get("identifier")).toBe("email");
    expect(url.searchParams.get("login_hint")).toBe("test-user@nautilo.local");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});

describe("resolveRecoveryRedirectBase", () => {
  test("returns NAUTILO_PUBLIC_BASE_URL when set (highest precedence)", () => {
    expect(
      resolveRecoveryRedirectBase(
        {
          NAUTILO_PUBLIC_BASE_URL: "http://public.example",
          NAUTILO_SERVER_URL: "http://server.example",
        },
        "http://fallback.example",
      ),
    ).toBe("http://public.example");
  });

  test("returns NAUTILO_SERVER_URL when PUBLIC_BASE_URL is absent", () => {
    expect(
      resolveRecoveryRedirectBase(
        { NAUTILO_SERVER_URL: "http://localhost:4401" },
        "http://fallback.example",
      ),
    ).toBe("http://localhost:4401");
  });

  test("returns NAUTILO_SERVER_URL when PUBLIC_BASE_URL is empty", () => {
    expect(
      resolveRecoveryRedirectBase(
        {
          NAUTILO_PUBLIC_BASE_URL: "",
          NAUTILO_SERVER_URL: "http://localhost:4401",
        },
        "http://fallback.example",
      ),
    ).toBe("http://localhost:4401");
  });

  test("returns the fallbackServerUrl arg when both env vars are absent", () => {
    expect(
      resolveRecoveryRedirectBase({}, "http://localhost:4401"),
    ).toBe("http://localhost:4401");
  });

  test("trims whitespace from env values", () => {
    expect(
      resolveRecoveryRedirectBase(
        { NAUTILO_PUBLIC_BASE_URL: "  http://public.example  " },
        "http://fallback.example",
      ),
    ).toBe("http://public.example");
    expect(
      resolveRecoveryRedirectBase(
        { NAUTILO_SERVER_URL: "  http://localhost:4401  " },
        "http://fallback.example",
      ),
    ).toBe("http://localhost:4401");
  });

  test("treats whitespace-only env values as absent", () => {
    expect(
      resolveRecoveryRedirectBase(
        {
          NAUTILO_PUBLIC_BASE_URL: "   ",
          NAUTILO_SERVER_URL: "   ",
        },
        "http://localhost:4401",
      ),
    ).toBe("http://localhost:4401");
  });
});
