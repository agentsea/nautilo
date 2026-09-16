import { describe, expect, test } from "bun:test";

import {
  buildMobileWebContentSecurityPolicy,
  buildMobileWebSecurityHeaders,
  MOBILE_WEB_EXPO_HYDRATION_SCRIPT_BODY,
  MOBILE_WEB_EXPO_HYDRATION_SCRIPT_SHA256,
} from "../../src/lib/mobile-web-security-headers";

describe("mobile web security headers (D515)", () => {
  test("pins the sole Expo inline hydration script to a SHA-256 source", () => {
    expect(MOBILE_WEB_EXPO_HYDRATION_SCRIPT_BODY).toBe(
      "globalThis.__EXPO_ROUTER_HYDRATE__=true;",
    );
    expect(MOBILE_WEB_EXPO_HYDRATION_SCRIPT_SHA256).toBe(
      "sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8=",
    );
  });

  test("uses a closed document policy with only the configured HTTPS identity origin", () => {
    expect(buildMobileWebContentSecurityPolicy("https://Auth.Example.test/oidc/")).toBe([
      "default-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "form-action 'self'",
      `script-src 'self' '${MOBILE_WEB_EXPO_HYDRATION_SCRIPT_SHA256}' 'wasm-unsafe-eval'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' blob:",
      "worker-src 'self' blob: data:",
      "manifest-src 'self'",
      "connect-src 'self' https://auth.example.test",
    ].join("; "));
  });

  test("allows HTTP identity only for exact loopback origins", () => {
    for (const endpoint of [
      "http://localhost:4301",
      "http://127.0.0.1:4301",
      "http://[::1]:4301",
    ]) {
      expect(buildMobileWebContentSecurityPolicy(endpoint)).toContain(
        `connect-src 'self' ${new URL(endpoint).origin}`,
      );
    }
  });

  test("rejects unsafe, credentialed, and non-loopback HTTP identity values", () => {
    for (const endpoint of [
      "http://auth.example.test",
      "https://person:secret@auth.example.test",
      "ftp://auth.example.test",
      "javascript:alert(1)",
      "not a URL",
    ]) {
      const policy = buildMobileWebContentSecurityPolicy(endpoint);
      expect(policy).toContain("connect-src 'self'");
      expect(policy).not.toContain("auth.example.test");
      expect(policy).not.toContain("person");
    }
  });

  test("adds non-sniffing, no-referrer, anti-frame, and same-origin resource headers", () => {
    const headers = buildMobileWebSecurityHeaders();
    expect(headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "cross-origin-resource-policy": "same-origin",
    });
    expect(headers["content-security-policy"]).not.toContain("'unsafe-eval'");
    expect(headers["content-security-policy"]).not.toContain("https:");
  });
});
