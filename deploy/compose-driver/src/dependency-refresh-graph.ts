import type { ComposeDriverProfile } from "./types.ts";

/**
 * D427 (Wave 3 task 3.1.2) — deterministic dependency refresh graph.
 *
 * Compose recreates a service when ITS OWN config/image changes, but it does
 * NOT automatically recreate a dependent when an UPSTREAM's image changes. A
 * proxy that resolves its upstream by DNS at startup (Caddy reverse-proxy)
 * can keep a stale IP after the upstream is replaced.
 *
 * M215 retired the nginx `db-host` / `neon-proxy` multiplexer; the graph now
 * covers only Caddy (edge TLS reverse proxy) under letsencrypt profiles.
 */
export const DEPENDENCY_REFRESH_GRAPH: ReadonlyArray<{
  dependent: string;
  upstreams: readonly string[];
}> = [{ dependent: "caddy", upstreams: ["nautilo-server", "logto"] }];

/** Upstreams a full `nautilo deploy` may have changed (source `--build` path). */
export const FULL_DEPLOY_CHANGED_UPSTREAMS: readonly string[] = [
  "nautilo-server",
  "logto",
];

/**
 * Compute the ordered, de-duplicated list of dependent services that MUST be
 * force-recreated because one of their upstreams changed. Caddy is omitted
 * for non-letsencrypt profiles (it is not in the stack).
 */
export function computeDependencyRefreshRecreate(
  changedUpstreams: Iterable<string>,
  profile: Pick<ComposeDriverProfile, "https">,
): string[] {
  const changed = new Set(changedUpstreams);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const edge of DEPENDENCY_REFRESH_GRAPH) {
    if (!edge.upstreams.some((u) => changed.has(u))) continue;
    if (edge.dependent === "caddy" && profile.https !== "letsencrypt") continue;
    if (seen.has(edge.dependent)) continue;
    seen.add(edge.dependent);
    out.push(edge.dependent);
  }
  return out;
}

/**
 * Read-only adjacency for diagnostics/tests: which upstreams, if changed,
 * would force a given dependent to recreate. Returns `[]` for unknown
 * dependents or dependents omitted by the profile (e.g. caddy under non-LE).
 */
export function refreshUpstreamsFor(
  dependent: string,
  profile: Pick<ComposeDriverProfile, "https">,
): readonly string[] {
  if (dependent === "caddy" && profile.https !== "letsencrypt") return [];
  const edge = DEPENDENCY_REFRESH_GRAPH.find((e) => e.dependent === dependent);
  return edge ? edge.upstreams : [];
}
