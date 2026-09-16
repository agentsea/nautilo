/**
 * Preflight probes for first-run "connect to existing Nautilo" mode
 * (D057 2a.2).
 *
 * Bun preflight is intentionally NOT here. D134 made the packaged app a
 * connect-to-server client: first-run probes only the user-supplied
 * server URL. Users no longer need to think about Bun while pairing.
 */

import { URL_PROBE_TIMEOUT_MS } from "./constants";

export type UrlProbe =
  | { ok: true; statusCode: number; reachableAt: string; elapsedMs: number }
  | { ok: false; reason: UrlProbeFailReason; detail?: string; elapsedMs: number };

export type UrlProbeFailReason =
  | "invalid-url"
  | "timeout"
  | "network-error"
  | "tls-error"
  | "bad-status"
  | "not-nautilo";

/**
 * Probe the server's readiness endpoint. Safer than hitting `/` because
 * the readiness endpoint is canonical (D059) and distinguishes
 * "something is listening here" from "this is actually Nautilo."
 *
 * Accepts the server's base URL as the user types it (e.g.
 * "https://home.arjuna.dev" or "http://192.168.1.10:3001"). Appends
 * `/health/ready` if missing (M051 fix: was `/api/health/ready` which
 * 404s — the actual route lives under `/health/*`). Follows redirects.
 *
 * Returns a discriminated union so the UI can render an actionable
 * message per failure mode. Never throws.
 */
export async function probeUrl(input: string): Promise<UrlProbe> {
  const start = Date.now();
  let url: URL;
  try {
    url = new URL(input.trim());
    if (!["http:", "https:"].includes(url.protocol)) {
      return {
        ok: false,
        reason: "invalid-url",
        detail: `unsupported scheme: ${url.protocol}`,
        elapsedMs: 0,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: "invalid-url",
      detail: err instanceof Error ? err.message : String(err),
      elapsedMs: 0,
    };
  }

  // Build the probe URL — attach readiness path if the user gave us a
  // bare host. If they gave us an explicit path already, leave it.
  const probeHref = (() => {
    if (url.pathname === "/" || url.pathname === "") {
      return new URL("/health/ready", url).toString();
    }
    // User provided a path — respect it.
    return url.toString();
  })();

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort("timeout"), URL_PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(probeHref, {
      redirect: "follow",
      signal: ac.signal,
      headers: { accept: "application/json,text/plain,*/*" },
    });
    clearTimeout(timeout);
    const elapsedMs = Date.now() - start;

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, reason: "bad-status", detail: `HTTP ${res.status}`, elapsedMs };
    }

    // Light identity check — D059 readiness returns
    // `{ status: "ready" | "starting", components: {...} }`. Any 200 is
    // accepted as "something responded", but a payload that doesn't look
    // like ours is a hint the user entered a neighbour's URL.
    //
    // M051 fix: previously checked `body["ready"]` which has never existed
    // on `/health/ready` — combined with the wrong route path, this branch
    // was never reachable. Now keys on the canonical `status` field.
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const status = body["status"];
      if (status !== "ready" && status !== "starting") {
        return {
          ok: false,
          reason: "not-nautilo",
          detail: "response did not match Nautilo's /health/ready shape",
          elapsedMs,
        };
      }
    } catch {
      // Not JSON — probably not Nautilo but don't fail hard; the URL
      // itself is reachable, which is some signal.
      return {
        ok: true,
        statusCode: res.status,
        reachableAt: probeHref,
        elapsedMs,
      };
    }

    return {
      ok: true,
      statusCode: res.status,
      reachableAt: probeHref,
      elapsedMs,
    };
  } catch (err) {
    clearTimeout(timeout);
    const elapsedMs = Date.now() - start;
    if (ac.signal.aborted) {
      return { ok: false, reason: "timeout", detail: `${URL_PROBE_TIMEOUT_MS}ms`, elapsedMs };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/self[- ]signed|UNABLE_TO_VERIFY|certificate|TLS|SSL/i.test(message)) {
      return { ok: false, reason: "tls-error", detail: message, elapsedMs };
    }
    return { ok: false, reason: "network-error", detail: message, elapsedMs };
  }
}
