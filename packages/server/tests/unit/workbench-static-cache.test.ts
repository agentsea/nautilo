import { describe, expect, test } from "bun:test";
import {
  WORKBENCH_FINGERPRINTED_CACHE_CONTROL,
  WORKBENCH_FINGERPRINTED_MAX_AGE,
  WORKBENCH_FINGERPRINTED_MAX_AGE_SECONDS,
  WORKBENCH_HTML_CACHE_CONTROL,
  buildWorkbenchAssetsStaticOptions,
  buildWorkbenchSpaFallbackSendFileOptions,
  buildWorkbenchSpaRootStaticOptions,
  isWorkbenchAssetRequest,
  workbenchCacheControlForPath,
} from "../../src/lib/workbench-static-cache";

describe("workbench static cache policy (M214 Phase 13)", () => {
  test("fingerprinted assets plugin opts use an unambiguous one-year immutable maxAge", () => {
    const opts = buildWorkbenchAssetsStaticOptions("/opt/workbench/dist/assets");
    expect(opts).toEqual({
      root: "/opt/workbench/dist/assets",
      prefix: "/assets/",
      decorateReply: false,
      wildcard: true,
      maxAge: WORKBENCH_FINGERPRINTED_MAX_AGE,
      immutable: true,
    });
    expect(WORKBENCH_FINGERPRINTED_MAX_AGE).toBe("365d");
    expect(WORKBENCH_FINGERPRINTED_MAX_AGE_SECONDS).toBe(365 * 24 * 60 * 60);
    expect(WORKBENCH_FINGERPRINTED_CACHE_CONTROL).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("SPA root plugin opts disable immutable caching", () => {
    const opts = buildWorkbenchSpaRootStaticOptions("/opt/workbench/dist");
    const { allowedPath, ...staticOptions } = opts;
    expect(staticOptions).toEqual({
      root: "/opt/workbench/dist",
      prefix: "/",
      decorateReply: false,
      wildcard: false,
      globIgnore: ["assets/**"],
      maxAge: 0,
      immutable: false,
    });
    expect(allowedPath("/index.html")).toBe(true);
    expect(allowedPath("/favicon.ico")).toBe(true);
    expect(allowedPath("/assets/index-abc123.js")).toBe(false);
  });

  test("SPA fallback sendFile opts disable immutable caching", () => {
    expect(buildWorkbenchSpaFallbackSendFileOptions()).toEqual({
      maxAge: 0,
      immutable: false,
    });
  });

  test("missing Workbench assets are excluded from the SPA fallback", () => {
    expect(isWorkbenchAssetRequest("/assets/docx_parser_bg-missing.wasm")).toBe(true);
    expect(isWorkbenchAssetRequest("/assets/chunk-missing.js?v=1")).toBe(true);
    expect(isWorkbenchAssetRequest("/assets")).toBe(true);
    expect(isWorkbenchAssetRequest("/genie/room-abc")).toBe(false);
  });

  test("workbenchCacheControlForPath classifies fingerprinted assets", () => {
    expect(workbenchCacheControlForPath("/assets/index-abc123.js")).toBe(
      WORKBENCH_FINGERPRINTED_CACHE_CONTROL,
    );
    expect(workbenchCacheControlForPath("/assets/index-abc123.js.map")).toBe(
      WORKBENCH_FINGERPRINTED_CACHE_CONTROL,
    );
    expect(workbenchCacheControlForPath("/assets/logo-xyz.woff2?v=1")).toBe(
      WORKBENCH_FINGERPRINTED_CACHE_CONTROL,
    );
  });

  test("workbenchCacheControlForPath keeps HTML and deep links revalidatable", () => {
    expect(workbenchCacheControlForPath("/")).toBe(WORKBENCH_HTML_CACHE_CONTROL);
    expect(workbenchCacheControlForPath("/index.html")).toBe(WORKBENCH_HTML_CACHE_CONTROL);
    expect(workbenchCacheControlForPath("/genie/room-abc")).toBe(WORKBENCH_HTML_CACHE_CONTROL);
    expect(workbenchCacheControlForPath("/admin/providers")).toBe(WORKBENCH_HTML_CACHE_CONTROL);
  });

  test("workbenchCacheControlForPath leaves API and WS outside static policy", () => {
    expect(workbenchCacheControlForPath("/api/health")).toBeNull();
    expect(workbenchCacheControlForPath("/api/workspace/artifacts/events")).toBeNull();
    expect(workbenchCacheControlForPath("/ws")).toBeNull();
    expect(workbenchCacheControlForPath("/ws/chat")).toBeNull();
  });

  test("root misc static files are not immutable", () => {
    expect(workbenchCacheControlForPath("/favicon.ico")).toBe(WORKBENCH_HTML_CACHE_CONTROL);
    expect(workbenchCacheControlForPath("/manifest.webmanifest")).toBe(
      WORKBENCH_HTML_CACHE_CONTROL,
    );
  });
});
