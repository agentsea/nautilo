import ipaddr from "ipaddr.js";
import { normalizeHost, evaluateNetworkEgress } from "./allowlist";
import { DEFAULT_NETWORK_PORT, type NetworkAllowRule, type NetworkPolicy } from "./policy";

/** Intersect the two existing policy languages; never union destination grants. */
export function intersectNetworkPolicies(profile: NetworkPolicy, ceiling: NetworkPolicy): NetworkPolicy {
  if (profile.mode === "isolated" || ceiling.mode === "isolated") return { mode: "isolated" };
  if (ceiling.mode === "host") return structuredClone(profile);
  if (profile.mode === "host") return structuredClone(ceiling);
  const allow: NetworkAllowRule[] = [];
  for (const left of profile.allow) for (const right of ceiling.allow) {
    const ports = (left.ports ?? [profile.defaultPort ?? DEFAULT_NETWORK_PORT])
      .filter(port => (right.ports ?? [ceiling.defaultPort ?? DEFAULT_NETWORK_PORT]).includes(port));
    if (ports.length === 0) continue;
    const destination = intersectDestination(left, right);
    if (destination) allow.push({ ...destination, ports });
  }
  return { mode: "proxy-allowlist", allow };
}

function intersectDestination(left: NetworkAllowRule, right: NetworkAllowRule): NetworkAllowRule | null {
  if (left.type === "domain") {
    const host = normalizeHost(left.host);
    return host && evaluateNetworkEgress({ mode: "proxy-allowlist", allow: [{ ...right, ports: [DEFAULT_NETWORK_PORT] }] }, host).allowed
      ? { type: "domain", host } : null;
  }
  if (right.type === "domain") return intersectDestination(right, left);
  if (left.type === "wildcard" && right.type === "wildcard") {
    const a = normalizeHost(left.suffix), b = normalizeHost(right.suffix);
    if (!a || !b) return null;
    if (a === b || a.endsWith(`.${b}`)) return { type: "wildcard", suffix: a };
    if (b.endsWith(`.${a}`)) return { type: "wildcard", suffix: b };
    return null;
  }
  // A CIDR matches an IP literal; a wildcard matches a DNS name. DNS resolution
  // never turns a hostname denied by either policy into an allowed request.
  if (left.type !== "cidr" || right.type !== "cidr") return null;
  try {
    const [a, aBits] = ipaddr.parseCIDR(left.cidr), [b, bBits] = ipaddr.parseCIDR(right.cidr);
    if (a.kind() !== b.kind()) return null;
    if (aBits >= bBits && a.match(b, bBits)) return { type: "cidr", cidr: left.cidr };
    if (bBits >= aBits && b.match(a, aBits)) return { type: "cidr", cidr: right.cidr };
  } catch { /* Invalid policy has no allowed intersection. */ }
  return null;
}
