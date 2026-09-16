import { readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

/** D515 — fail-closed static-delivery policy for the optional Mobile Web export. */

export const MOBILE_WEB_FINGERPRINTED_MAX_AGE = "365d" as const;
export const MOBILE_WEB_FINGERPRINTED_CACHE_CONTROL =
  "public, max-age=31536000, immutable" as const;
export const MOBILE_WEB_NAVIGATION_CACHE_CONTROL = "no-store" as const;

const MOBILE_WEB_FILE_EXTENSIONS = new Set([
  ".avif", ".bin", ".bmp", ".css", ".eot", ".gif", ".ico", ".jpeg", ".jpg",
  ".js", ".json", ".map", ".mjs", ".mp3", ".mp4", ".ogg", ".otf", ".pdf",
  ".png", ".svg", ".ttf", ".txt", ".wav", ".webm", ".webmanifest", ".webp",
  ".woff", ".woff2", ".wasm", ".xml",
]);
const EXPO_FINGERPRINT_BASENAME_RE = /[-.][0-9a-f]{32}(?:@[0-9]+x)?\.[^.]+$/;
const UUID_PATH_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MobileWebAssetsStaticPluginOptions {
  readonly root: string;
  readonly prefix: "/mobile/_expo/static/" | "/mobile/assets/";
  readonly decorateReply: false;
  readonly wildcard: true;
  readonly maxAge: typeof MOBILE_WEB_FINGERPRINTED_MAX_AGE;
  readonly immutable: true;
}

export interface MobileWebFallbackSendFileOptions {
  readonly maxAge: 0;
  readonly immutable: false;
  readonly cacheControl: false;
}

export type MobileWebRouteResolver = (url: string) => string | null;

export interface MobileWebExportInventory {
  readonly invalidFingerprintFiles: readonly string[];
  readonly resolveHtmlRoute: MobileWebRouteResolver;
}

export function buildMobileWebAssetsStaticOptions(
  assetsRoot: string,
  prefix: "/mobile/_expo/static/" | "/mobile/assets/",
): MobileWebAssetsStaticPluginOptions {
  return {
    root: assetsRoot,
    prefix,
    decorateReply: false,
    wildcard: true,
    maxAge: MOBILE_WEB_FINGERPRINTED_MAX_AGE,
    immutable: true,
  };
}

export function buildMobileWebFallbackSendFileOptions(): MobileWebFallbackSendFileOptions {
  // sendFile otherwise overwrites the route's explicit `no-store` header.
  return { maxAge: 0, immutable: false, cacheControl: false };
}

/** Query-stripped pathname shared by Mobile classification and Workbench guards. */
export function pathnameWithoutQuery(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

function decodedPathname(url: string): string | null {
  try {
    return decodeURIComponent(pathnameWithoutQuery(url));
  } catch {
    return null;
  }
}

function isMobileWebGeneratedAssetRequest(url: string): boolean {
  const pathname = decodedPathname(url);
  if (pathname === null) return true;
  return (
    pathname === "/mobile/_expo" ||
    pathname.startsWith("/mobile/_expo/") ||
    pathname === "/mobile/assets" ||
    pathname.startsWith("/mobile/assets/")
  );
}

/** True for generated Mobile assets and every file-like request under /mobile. */
export function isMobileWebAssetRequest(url: string): boolean {
  if (isMobileWebGeneratedAssetRequest(url)) return true;
  const pathname = decodedPathname(url);
  if (pathname === null) return true;
  const finalSegment = pathname.slice(pathname.lastIndexOf("/") + 1).toLowerCase();
  const dot = finalSegment.lastIndexOf(".");
  return dot > 0 && MOBILE_WEB_FILE_EXTENSIONS.has(finalSegment.slice(dot));
}

/** Reject encoded traversal and Windows separators before route resolution. */
export function isMobileWebTraversalAttempt(url: string): boolean {
  const pathname = decodedPathname(url);
  if (pathname === null || pathname.includes("\\")) return true;
  return pathname.split("/").some((segment) => segment === ".." || segment === ".");
}

function routePathForHtmlFile(htmlFile: string): string | null {
  const normalized = htmlFile.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized.endsWith(".html") ||
    segments.some((segment) => segment.startsWith("(")) ||
    normalized === "+not-found.html" ||
    normalized === "_sitemap.html"
  ) return null;
  const withoutExtension = normalized.slice(0, -".html".length);
  const routeSegments = withoutExtension === "index"
    ? []
    : withoutExtension.split("/").flatMap((segment, index, source) =>
      segment === "index" && index === source.length - 1 ? [] : [segment]
    );
  return `/mobile/${routeSegments.join("/")}`.replace(/\/$/, "/");
}

function routeTemplateRegex(routePath: string): RegExp | null {
  if (!routePath.includes("[")) return null;
  const segments = routePath.split("/");
  const isParameter = (segment: string) => {
    const name = segment.slice(1, -1);
    return segment.startsWith("[") && segment.endsWith("]") && name.length > 0 &&
      !name.includes("[") && !name.includes("]") && !name.includes("/");
  };
  if (segments.some((segment) =>
    (segment.includes("[") || segment.includes("]")) && !isParameter(segment)
  )) return null;
  const parts = segments.map((segment) => {
    if (isParameter(segment)) return "[^/]+";
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${parts.join("/")}$`);
}

/**
 * Maps only emitted non-group Expo HTML routes. Exact paths win over bracket
 * templates, and each `[param]` matches exactly one path segment.
 */
export function buildMobileWebRouteResolver(htmlFiles: readonly string[]): MobileWebRouteResolver {
  const exact = new Map<string, string>();
  const templates: Array<{ htmlFile: string; matcher: RegExp; staticSegments: number; accepts: (pathname: string) => boolean }> = [];
  for (const htmlFile of htmlFiles) {
    const routePath = routePathForHtmlFile(htmlFile);
    if (routePath === null) continue;
    const matcher = routeTemplateRegex(routePath);
    if (matcher === null) {
      exact.set(routePath, htmlFile);
      continue;
    }
    templates.push({
      htmlFile,
      matcher,
      staticSegments: routePath.split("/").filter((segment) => !segment.startsWith("[")).length,
      accepts: htmlFile === "tasks/[taskId].html"
        ? (pathname) => UUID_PATH_SEGMENT_RE.test(pathname.slice("/mobile/tasks/".length))
        : () => true,
    });
  }
  templates.sort((left, right) => right.staticSegments - left.staticSegments);
  return (url) => {
    if (isMobileWebTraversalAttempt(url)) return null;
    const pathname = decodedPathname(url);
    if (pathname === null) return null;
    const normalizedPathname = pathname !== "/mobile/" && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
    const exactMatch = exact.get(normalizedPathname);
    if (exactMatch !== undefined) return exactMatch;
    return templates.find((template) => template.matcher.test(normalizedPathname) && template.accepts(normalizedPathname))?.htmlFile ?? null;
  };
}

function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

/** Inventory the export once at mount time; malformed cacheable assets fail closed. */
export function inspectMobileWebExport(distRoot: string): MobileWebExportInventory {
  const files = listFiles(distRoot);
  const relativeFiles = files.map((file) => relative(distRoot, file).replaceAll("\\", "/"));
  const invalidFingerprintFiles = relativeFiles.filter((file) =>
    (file.startsWith("_expo/static/") || file.startsWith("assets/")) &&
    !EXPO_FINGERPRINT_BASENAME_RE.test(basename(file)),
  );
  return {
    invalidFingerprintFiles,
    resolveHtmlRoute: buildMobileWebRouteResolver(relativeFiles.filter((file) => file.endsWith(".html"))),
  };
}

export function mobileWebCacheControlForPath(pathname: string): string | null {
  const path = pathnameWithoutQuery(pathname);
  if (path.startsWith("/mobile/_expo/static/") || path.startsWith("/mobile/assets/")) {
    return MOBILE_WEB_FINGERPRINTED_CACHE_CONTROL;
  }
  if (path === "/mobile" || path === "/mobile/" || path.startsWith("/mobile/")) {
    return MOBILE_WEB_NAVIGATION_CACHE_CONTROL;
  }
  return null;
}
