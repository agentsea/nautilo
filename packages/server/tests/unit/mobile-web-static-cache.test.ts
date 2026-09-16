import { describe, expect, test } from "bun:test";
import {
  buildMobileWebAssetsStaticOptions,
  buildMobileWebFallbackSendFileOptions,
  buildMobileWebRouteResolver,
  isMobileWebAssetRequest,
  isMobileWebTraversalAttempt,
  mobileWebCacheControlForPath,
  MOBILE_WEB_FINGERPRINTED_CACHE_CONTROL,
  MOBILE_WEB_FINGERPRINTED_MAX_AGE,
  MOBILE_WEB_NAVIGATION_CACHE_CONTROL,
} from "../../src/lib/mobile-web-static-cache";

describe("mobile web static cache policy (D515)", () => {
  test("generated Expo and assets mounts are immutable for one year", () => {
    expect(buildMobileWebAssetsStaticOptions("/opt/mobile/_expo/static", "/mobile/_expo/static/")).toEqual({
      root: "/opt/mobile/_expo/static",
      prefix: "/mobile/_expo/static/",
      decorateReply: false,
      wildcard: true,
      maxAge: MOBILE_WEB_FINGERPRINTED_MAX_AGE,
      immutable: true,
    });
    expect(buildMobileWebAssetsStaticOptions("/opt/mobile/assets", "/mobile/assets/").prefix).toBe(
      "/mobile/assets/",
    );
  });

  test("navigation fallback preserves an explicit no-store header", () => {
    expect(buildMobileWebFallbackSendFileOptions()).toEqual({
      maxAge: 0,
      immutable: false,
      cacheControl: false,
    });
  });

  test("classifies emitted and file-like requests as assets", () => {
    for (const url of [
      "/mobile/_expo/static/js/web/index.js",
      "/mobile/_expo/.routes.json",
      "/mobile/assets/font.woff2",
      "/mobile/missing.wasm",
      "/mobile/missing.js?v=1",
      "/mobile/manifest.json",
      "/mobile/site.webmanifest",
      "/mobile/metadata.xml",
      "/mobile/icon.png",
      "/mobile/style.css",
    ]) expect(isMobileWebAssetRequest(url)).toBe(true);
    expect(isMobileWebAssetRequest("/mobile/chat/room-1")).toBe(false);
  });

  test("detects encoded traversal and malformed escapes", () => {
    expect(isMobileWebTraversalAttempt("/mobile/%2e%2e/api/health")).toBe(true);
    expect(isMobileWebTraversalAttempt("/mobile/a%5Cb")).toBe(true);
    expect(isMobileWebTraversalAttempt("/mobile/%ZZ")).toBe(true);
    expect(isMobileWebTraversalAttempt("/mobile/chat/room-1")).toBe(false);
  });

  test("resolves only emitted exact and one-segment bracket HTML routes", () => {
    const resolveRoute = buildMobileWebRouteResolver([
      "index.html",
      "callback.html",
      "chat/[roomId].html",
      "tasks/[taskId].html",
      "files/artifact/[id].html",
      "(drawer)/chat/[roomId].html",
      "+not-found.html",
      "_sitemap.html",
    ]);
    expect(resolveRoute("/mobile/")).toBe("index.html");
    expect(resolveRoute("/mobile/callback")).toBe("callback.html");
    expect(resolveRoute("/mobile/callback/")).toBe("callback.html");
    expect(resolveRoute("/mobile/chat/room-1")).toBe("chat/[roomId].html");
    expect(resolveRoute("/mobile/files/artifact/123")).toBe("files/artifact/[id].html");
    expect(resolveRoute("/mobile/files/artifact/123/")).toBe("files/artifact/[id].html");
    expect(resolveRoute("/mobile/chat/one/two")).toBeNull();
    expect(resolveRoute("/mobile/tasks/b487068d-9720-4f0f-a7a0-e84d9e4bff54")).toBe("tasks/[taskId].html");
    expect(resolveRoute("/mobile/tasks/b487068d-9720-4f0f-a7a0-e84d9e4bff54/")).toBe("tasks/[taskId].html");
    expect(resolveRoute("/mobile/tasks/not-a-uuid")).toBeNull();
    expect(resolveRoute("/mobile/tasks/b487068d-9720-4f0f-a7a0-e84d9e4bff54/extra")).toBeNull();
    expect(resolveRoute("/mobile/not-emitted")).toBeNull();
    expect(resolveRoute("/mobile/%2e%2e/api/health")).toBeNull();
  });

  test("only generated fingerprinted assets are immutable", () => {
    expect(mobileWebCacheControlForPath("/mobile/_expo/static/js/web/index.js")).toBe(
      MOBILE_WEB_FINGERPRINTED_CACHE_CONTROL,
    );
    expect(mobileWebCacheControlForPath("/mobile/assets/font.woff2")).toBe(
      MOBILE_WEB_FINGERPRINTED_CACHE_CONTROL,
    );
    expect(mobileWebCacheControlForPath("/mobile/chat/room-1")).toBe(
      MOBILE_WEB_NAVIGATION_CACHE_CONTROL,
    );
    expect(mobileWebCacheControlForPath("/api/health")).toBeNull();
  });
});
