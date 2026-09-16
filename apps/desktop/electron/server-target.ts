/**
 * D514 Phase 1 — pure server-target policy.
 *
 * This is deliberately a planner, not a probe.  It is the sole place where
 * human input becomes a candidate transport; a caller still has to contact a
 * candidate and prove that the answering origin is safe to promote.
 */

import { isLoopbackHostname } from "@nautilo/config/loopback-origin";

export type ServerTargetFailureCode =
  | "empty-target"
  | "unsupported-scheme"
  | "invalid-target"
  | "target-must-be-an-origin";

export type ServerTargetFailure = {
  ok: false;
  code: ServerTargetFailureCode;
};

export type TransportScheme = "http" | "https";

export type TransportCandidate = {
  origin: string;
  scheme: TransportScheme;
  reason: "explicit" | "bare-https" | "local-http-fallback";
};

export type NormalizedServerTarget = {
  ok: true;
  enteredTarget: string;
  canonicalOrigin: string;
  explicitScheme: TransportScheme | null;
  candidates: readonly TransportCandidate[];
  /** HTTP fallback is deliberately unavailable after prior HTTPS proof. */
  previousHttpsEvidence: boolean;
  requiresExplicitDowngradeConfirmation: boolean;
};

export type ServerTargetPlan = NormalizedServerTarget | ServerTargetFailure;

export type ServerTargetOptions = {
  /** A previously verified origin for this same logical target, if any. */
  previousVerifiedOrigin?: string | null;
};

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return false;
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
}

/**
 * Does not use DNS: names such as `my-nas.local` can resolve off-LAN and are
 * not enough evidence for an automatic clear-text fallback.  Literal
 * loopback, RFC1918/link-local IPv4, and local IPv6 addresses are.
 */
export function isDeterministicallyLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return isLoopbackHostname(normalized) ||
    isPrivateIpv4(normalized) ||
    /^fe[89ab][0-9a-f]:/i.test(normalized) ||
    /^f[cd][0-9a-f]{2}:/i.test(normalized);
}

function canonicalOrigin(url: URL): string {
  return url.origin;
}

function previousHttpsEvidence(
  canonical: string,
  previousVerifiedOrigin: string | null | undefined,
): boolean {
  if (!previousVerifiedOrigin) return false;
  try {
    const previous = new URL(previousVerifiedOrigin);
    const current = new URL(canonical);
    return previous.protocol === "https:" &&
      previous.hostname === current.hostname &&
      previous.port === current.port;
  } catch {
    return false;
  }
}

/**
 * Parse a human target into safe transport candidates.  Explicit `http` is
 * preserved as a human choice; only an *automatic* fallback is forbidden by
 * previous HTTPS evidence.
 */
export function planServerTarget(
  input: string,
  options: ServerTargetOptions = {},
): ServerTargetPlan {
  const enteredTarget = input.trim();
  if (!enteredTarget) return { ok: false, code: "empty-target" };

  const explicitMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(enteredTarget);
  if (explicitMatch && !/^(https?)$/i.test(explicitMatch[1] ?? "")) {
    return { ok: false, code: "unsupported-scheme" };
  }
  // A colon before a slash is a scheme, not a host:port target. `http:` is
  // intentionally rejected too; requiring `://` avoids ambiguous parsing.
  if (!explicitMatch && /^[a-z][a-z0-9+.-]*:/i.test(enteredTarget) && !/^[^/]+:\d+$/.test(enteredTarget)) {
    return { ok: false, code: "unsupported-scheme" };
  }

  let parsed: URL;
  try {
    parsed = new URL(explicitMatch ? enteredTarget : `https://${enteredTarget}`);
  } catch {
    return { ok: false, code: "invalid-target" };
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "")) {
    return { ok: false, code: "target-must-be-an-origin" };
  }

  const explicitScheme = explicitMatch ? parsed.protocol.slice(0, -1) as TransportScheme : null;
  const canonical = canonicalOrigin(parsed);
  const httpsEvidence = previousHttpsEvidence(canonical, options.previousVerifiedOrigin);
  const local = isDeterministicallyLocalHostname(parsed.hostname);
  const candidates: TransportCandidate[] = [];

  if (explicitScheme) {
    candidates.push({ origin: canonical, scheme: explicitScheme, reason: "explicit" });
  } else {
    candidates.push({ origin: canonical, scheme: "https", reason: "bare-https" });
    if (local && !httpsEvidence) {
      const http = new URL(canonical);
      http.protocol = "http:";
      candidates.push({
        origin: canonicalOrigin(http),
        scheme: "http",
        reason: "local-http-fallback",
      });
    }
  }

  return {
    ok: true,
    enteredTarget,
    canonicalOrigin: canonical,
    explicitScheme,
    candidates,
    previousHttpsEvidence: httpsEvidence,
    requiresExplicitDowngradeConfirmation: explicitScheme === "http" && httpsEvidence,
  };
}

/**
 * Promotion is origin-bound. Redirects may be followed while observing, but a
 * response from another origin cannot silently become this attempt's pairing.
 */
export function isSafePromotionOrigin(
  candidateOrigin: string,
  answeringUrl: string,
): boolean {
  try {
    return new URL(candidateOrigin).origin === new URL(answeringUrl).origin;
  } catch {
    return false;
  }
}
