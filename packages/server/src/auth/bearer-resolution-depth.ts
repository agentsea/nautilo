import type { ResolutionDepth } from "./resolve-bearer";

/**
 * M213 — explicit minimum bearer resolution depth per route.
 * Only exact `GET /api/auth/whoami` uses `rbac`; all other protected
 * routes remain full `policy` until deliberately reclassified.
 */
export function bearerResolutionDepthForRoute(
  method: string,
  routePath: string,
): ResolutionDepth {
  if (method === "GET" && routePath === "/api/auth/whoami") {
    return "rbac";
  }
  return "policy";
}
