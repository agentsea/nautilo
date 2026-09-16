import { describe, expect, test } from "bun:test";

import {
  MOBILE_WEB_CALLBACK_PATH,
  mobileWebAuthBootstrap,
  mobileWebCallbackCleanupUrl,
  ownsMobileWebCallback,
  sanitizeMobileWebReturnPath,
} from "./browser-auth-contract";

const origin = "https://alpha.example.test";

describe("Mobile Web browser auth contract", () => {
  test("uses only the dedicated SPA client and exact callback", () => {
    const config = mobileWebAuthBootstrap({
      status: "ok",
      logtoEndpoint: "https://auth.nautilo.dev",
      logtoWorkbenchAppId: "workbench",
      logtoMobileAppId: "native-mobile",
      logtoMobileWebAppId: "mobile-web",
      logtoResource: "https://api.nautilo.local",
      serverUrl: origin,
    }, origin);

    expect(config?.logto.appId).toBe("mobile-web");
    expect(config?.redirectUri).toBe(`${origin}${MOBILE_WEB_CALLBACK_PATH}`);
    expect(config?.postLogoutRedirectUri).toBe(`${origin}/mobile`);
  });

  test("fails closed for missing dedicated configuration or origin drift", () => {
    expect(mobileWebAuthBootstrap({ status: "ok" }, origin)).toBeNull();
    expect(mobileWebAuthBootstrap({
      status: "ok",
      logtoEndpoint: "https://auth.nautilo.dev",
      logtoMobileWebAppId: "mobile-web",
      logtoResource: "https://api.nautilo.local",
      serverUrl: "https://other.nautilo.dev",
    }, origin)).toBeNull();
  });

  test("accepts only equivalent loopback aliases used by exact bootstrap registrations", () => {
    const config = mobileWebAuthBootstrap({
      status: "ok",
      logtoEndpoint: "http://localhost:3301",
      logtoMobileWebAppId: "mobile-web",
      logtoResource: "https://api.nautilo.local",
      serverUrl: "http://localhost:3001",
    }, "http://127.0.0.1:3001");
    expect(config?.redirectUri).toBe("http://127.0.0.1:3001/mobile/callback");
    expect(mobileWebAuthBootstrap({
      status: "ok",
      logtoEndpoint: "http://localhost:3301",
      logtoMobileWebAppId: "mobile-web",
      logtoResource: "https://api.nautilo.local",
      serverUrl: "http://localhost:3001",
    }, "http://127.0.0.1:3002")).toBeNull();
  });

  test("owns only the exact same-origin callback path", () => {
    expect(ownsMobileWebCallback(`${origin}/mobile/callback?code=x`, origin)).toBe(true);
    expect(ownsMobileWebCallback(`${origin}/mobile/callback/extra`, origin)).toBe(false);
    expect(ownsMobileWebCallback("https://evil.example/mobile/callback", origin)).toBe(false);
  });

  test("retains ordinary Mobile routes but rejects redirects and OAuth material", () => {
    expect(sanitizeMobileWebReturnPath("/mobile/chat/room-1?panel=files#message", origin))
      .toBe("/mobile/chat/room-1?panel=files#message");
    expect(sanitizeMobileWebReturnPath("https://evil.example/mobile", origin)).toBe("/mobile");
    expect(sanitizeMobileWebReturnPath("/mobile/chat/room-1?code=secret", origin)).toBe("/mobile");
    expect(sanitizeMobileWebReturnPath("/mobile#access_token=secret", origin)).toBe("/mobile");
    expect(sanitizeMobileWebReturnPath("/settings", origin)).toBe("/mobile");
  });

  test("scrubs callback history back to a non-secret Mobile URL", () => {
    expect(mobileWebCallbackCleanupUrl(origin)).toBe(`${origin}/mobile`);
  });
});
