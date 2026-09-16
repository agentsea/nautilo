/**
 * D112 — allowlist for `recommendedSetupSurface.url` before rendering
 * navigation targets from server-derived setup status (defense in depth).
 */
import { canonicalizeLoopbackOrigin } from "@nautilo/config/loopback-origin";

function normalizeBase(u: string): string {
  const t = u.trim();
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

/**
 * Returns a safe href, or `null` if the URL must not be used as a link target.
 */
export function sanitizeRecommendedSetupUrl(
  raw: string | null | undefined,
  opts: { serverUrl: string; workbenchOrigin: string },
): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (s === "") return null;

  if (s.startsWith("/") && !s.startsWith("//")) {
    return s;
  }

  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  let serverOrigin: string;
  try {
    serverOrigin = new URL(normalizeBase(opts.serverUrl) + "/").origin;
  } catch {
    return null;
  }

  let workbenchOriginResolved: string | null = null;
  const rawWorkbench = opts.workbenchOrigin.trim();
  if (rawWorkbench !== "") {
    try {
      workbenchOriginResolved = new URL(normalizeBase(rawWorkbench) + "/").origin;
    } catch {
      workbenchOriginResolved = null;
    }
  }

  const allowedOrigins =
    workbenchOriginResolved === null
      ? [serverOrigin]
      : [serverOrigin, workbenchOriginResolved];
  const parsedOrigin = canonicalizeLoopbackOrigin(parsed.origin, allowedOrigins);

  if (allowedOrigins.includes(parsed.origin) || allowedOrigins.includes(parsedOrigin)) {
    return parsed.toString();
  }

  return null;
}
