/**
 * M214 Phase 13 — Workbench static delivery cache policy.
 *
 * Fingerprinted Vite assets under `/assets/` are content-addressed and safe to
 * cache immutably for one year. The HTML shell (`index.html`), SPA deep-link
 * fallback, and other non-fingerprinted root static files must revalidate and
 * must never receive `immutable`. API responses are outside this module.
 *
 * Options mirror `@fastify/static` / `@fastify/send` (`maxAge`, `immutable`)
 * so production wiring stays on the supported plugin path rather than ad-hoc
 * `setHeaders` hacks.
 */

/**
 * `@fastify/send` accepts duration strings or numeric milliseconds. Keep this
 * as a duration string so the one-year policy cannot be misread as 31,536,000
 * milliseconds; `"365d"` emits `max-age=31536000`.
 */
export const WORKBENCH_FINGERPRINTED_MAX_AGE = "365d" as const;

/** One year in seconds — matches the emitted `Cache-Control` header. */
export const WORKBENCH_FINGERPRINTED_MAX_AGE_SECONDS = 31536000;

/** Expected Cache-Control for fingerprinted `/assets/*` responses. */
export const WORKBENCH_FINGERPRINTED_CACHE_CONTROL =
  "public, max-age=31536000, immutable" as const;

/**
 * Expected Cache-Control for HTML shell + SPA fallback responses.
 * `max-age=0` with `immutable: false` (via send options) yields revalidation
 * semantics without marking the document immutable.
 */
export const WORKBENCH_HTML_CACHE_CONTROL = "public, max-age=0" as const;

export interface WorkbenchAssetsStaticPluginOptions {
  readonly root: string;
  readonly prefix: "/assets/";
  readonly decorateReply: false;
  readonly wildcard: true;
  readonly maxAge: typeof WORKBENCH_FINGERPRINTED_MAX_AGE;
  readonly immutable: true;
}

export interface WorkbenchSpaRootStaticPluginOptions {
  readonly root: string;
  readonly prefix: "/";
  readonly decorateReply: false;
  readonly wildcard: false;
  readonly globIgnore: string[];
  readonly maxAge: 0;
  readonly immutable: false;
  readonly allowedPath: (pathName: string) => boolean;
}

export interface WorkbenchSpaFallbackSendFileOptions {
  readonly maxAge: 0;
  readonly immutable: false;
}

/** Plugin options for hashed Workbench chunks under `/assets/`. */
export function buildWorkbenchAssetsStaticOptions(
  assetsRoot: string,
): WorkbenchAssetsStaticPluginOptions {
  return {
    root: assetsRoot,
    prefix: "/assets/",
    decorateReply: false,
    wildcard: true,
    maxAge: WORKBENCH_FINGERPRINTED_MAX_AGE,
    immutable: true,
  };
}

/** Plugin options for the Workbench SPA root (non-immutable HTML + misc static). */
export function buildWorkbenchSpaRootStaticOptions(
  distRoot: string,
): WorkbenchSpaRootStaticPluginOptions {
  return {
    root: distRoot,
    prefix: "/",
    decorateReply: false,
    wildcard: false,
    // wildcard:false enumerates exact routes at registration time. Without
    // this exclusion those exact /assets routes outrank the dedicated
    // /assets/* mount and inherit the HTML cache policy.
    globIgnore: ["assets/**"],
    maxAge: 0,
    immutable: false,
    // The root plugin can discover nested files even with wildcard:false.
    // Exclude /assets so the dedicated immutable-cache mount is the sole
    // owner of fingerprinted Workbench chunks.
    allowedPath: (pathName) => !isWorkbenchAssetRequest(pathName),
  };
}

/** Per-response overrides for SPA deep-link `index.html` fallback. */
export function buildWorkbenchSpaFallbackSendFileOptions(): WorkbenchSpaFallbackSendFileOptions {
  return {
    maxAge: 0,
    immutable: false,
  };
}

/**
 * Static asset requests must never fall through to the SPA HTML shell. A
 * missing hashed JS/WASM/font asset is a hard 404, otherwise loaders receive a
 * successful HTML response and report misleading parser/module failures.
 */
export function isWorkbenchAssetRequest(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/assets" || pathname.startsWith("/assets/");
}

/**
 * Pure path classifier for cache-policy tests and documentation.
 * Returns `null` for non-Workbench-static paths (API, WS, etc.).
 */
export function workbenchCacheControlForPath(pathname: string): string | null {
  const path = pathname.split("?", 1)[0] ?? pathname;
  if (path.startsWith("/assets/")) {
    return WORKBENCH_FINGERPRINTED_CACHE_CONTROL;
  }
  if (path.startsWith("/api/") || path.startsWith("/ws")) {
    return null;
  }
  if (path === "/" || path === "/index.html" || path.endsWith(".html")) {
    return WORKBENCH_HTML_CACHE_CONTROL;
  }
  // Root-level misc static (favicon, manifest, …) — not fingerprinted.
  if (path.startsWith("/")) {
    return WORKBENCH_HTML_CACHE_CONTROL;
  }
  return null;
}
