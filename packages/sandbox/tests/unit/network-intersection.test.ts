import { describe, expect, test } from "bun:test";
import { intersectNetworkPolicies } from "../../src/network/intersection";
import { evaluateNetworkEgress } from "../../src/network/allowlist";
import type { NetworkPolicy } from "../../src/network/policy";

describe("local network ceiling intersection", () => {
  test("host ceiling cannot broaden a local isolated profile", () => {
    expect(intersectNetworkPolicies({ mode: "isolated" }, { mode: "host" })).toEqual({ mode: "isolated" });
    expect(intersectNetworkPolicies({ mode: "host" }, { mode: "isolated" })).toEqual({ mode: "isolated" });
  });
  test("domains, wildcards, CIDRs and ports require both policies", () => {
    const profile: NetworkPolicy = { mode: "proxy-allowlist", allow: [
      { type: "wildcard", suffix: "example.com", ports: [443, 8443] },
      { type: "cidr", cidr: "10.0.0.0/8", ports: [443] },
      { type: "cidr", cidr: "2001:db8::/32" },
    ] };
    const ceiling: NetworkPolicy = { mode: "proxy-allowlist", allow: [
      { type: "domain", host: "api.example.com", ports: [443] },
      { type: "wildcard", suffix: "nested.example.com", ports: [8443] },
      { type: "cidr", cidr: "10.1.0.0/16" },
      { type: "cidr", cidr: "2001:db8:1::/48" },
    ] };
    const effective = intersectNetworkPolicies(profile, ceiling);
    for (const host of ["api.example.com", "other.example.com", "example.com", "nested.example.com",
      "x.nested.example.com", "api.example.com.evil.test", "10.1.2.3", "10.2.0.1", "2001:db8:1::1", "2001:db8:2::1"]) {
      for (const port of [80, 443, 8443]) {
        expect(evaluateNetworkEgress(effective, host, port).allowed).toBe(
          evaluateNetworkEgress(profile, host, port).allowed && evaluateNetworkEgress(ceiling, host, port).allowed);
      }
    }
  });
  test("empty overlap denies and result cannot mutate source policy", () => {
    const profile: NetworkPolicy = { mode: "proxy-allowlist", allow: [{ type: "domain", host: "one.example" }] };
    const effective = intersectNetworkPolicies(profile, { mode: "host" });
    expect(effective).not.toBe(profile);
    expect(intersectNetworkPolicies(profile, { mode: "proxy-allowlist", allow: [{ type: "cidr", cidr: "10.0.0.0/8" }] }))
      .toEqual({ mode: "proxy-allowlist", allow: [] });
  });
});
