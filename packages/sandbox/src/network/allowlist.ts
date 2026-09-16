import { domainToASCII } from "node:url";
import ipaddr from "ipaddr.js";

import {
  DEFAULT_NETWORK_PORT,
  type NetworkAllowRule,
  type NetworkDecision,
  type NetworkPolicy,
} from "./policy";

/**
 * Decide whether host:port is allowed by the policy.
 *
 * SECURITY NOTE: This function only decides policy. Enforcement must
 * happen elsewhere (Seatbelt/bwrap/proxy path). In particular, a
 * positive decision here is not a sandbox unless the child process is
 * forced through the checked path.
 */
export function evaluateNetworkEgress(
  policy: NetworkPolicy,
  inputHost: string,
  inputPort?: number,
): NetworkDecision {
  if (policy.mode === "host") {
    return { allowed: true, reason: "network policy is host" };
  }
  if (policy.mode === "isolated") {
    return { allowed: false, reason: "network policy is isolated" };
  }

  const host = normalizeHost(inputHost);
  if (host === null) {
    return { allowed: false, reason: "invalid host" };
  }

  const port = inputPort ?? policy.defaultPort ?? DEFAULT_NETWORK_PORT;
  if (!isValidPort(port)) {
    return { allowed: false, reason: "invalid port" };
  }

  for (const rule of policy.allow) {
    if (!portAllowed(rule, port, policy.defaultPort ?? DEFAULT_NETWORK_PORT)) {
      continue;
    }
    if (ruleMatchesHost(rule, host)) {
      return {
        allowed: true,
        reason: "matched allow rule",
        matchedRule: rule,
      };
    }
  }

  return { allowed: false, reason: "no allow rule matched" };
}

export function normalizeHost(input: string): string | null {
  const trimmed = input.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (trimmed.length === 0) return null;
  const ip = parseStrictIpLiteral(trimmed);
  if (ip !== null) return ip.toString();
  const ascii = domainToASCII(trimmed.toLowerCase());
  return ascii.length > 0 ? ascii : null;
}

function ruleMatchesHost(rule: NetworkAllowRule, host: string): boolean {
  switch (rule.type) {
    case "domain":
      return normalizeHost(rule.host) === host;
    case "wildcard": {
      const suffix = normalizeHost(rule.suffix);
      if (suffix === null) return false;
      // Boundary semantics: *.example.com matches api.example.com,
      // never api.example.com.evil.org, and not the bare example.com.
      return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
    }
    case "cidr":
      return cidrMatches(rule.cidr, host);
  }
}

function cidrMatches(cidr: string, host: string): boolean {
  const addr = parseStrictIpLiteral(host);
  const range = parseStrictCidr(cidr);
  if (addr === null || range === null) return false;
  return addr.kind() === range[0].kind() && addr.match(range);
}

function parseStrictIpLiteral(host: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  if (ipaddr.IPv4.isValidFourPartDecimal(host)) {
    return ipaddr.IPv4.parse(host);
  }
  if (ipaddr.IPv6.isValid(host)) {
    return ipaddr.IPv6.parse(host);
  }
  return null;
}

function parseStrictCidr(cidr: string): [ipaddr.IPv4 | ipaddr.IPv6, number] | null {
  if (ipaddr.IPv4.isValidCIDRFourPartDecimal(cidr)) {
    return ipaddr.IPv4.parseCIDR(cidr);
  }
  if (ipaddr.IPv6.isValidCIDR(cidr)) {
    return ipaddr.IPv6.parseCIDR(cidr);
  }
  return null;
}

function portAllowed(
  rule: NetworkAllowRule,
  port: number,
  defaultPort: number,
): boolean {
  const ports = rule.ports ?? [defaultPort];
  return ports.includes(port);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}
