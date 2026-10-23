import { describe, expect, test } from "bun:test";

import {
  evaluateNetworkEgress,
  normalizeHost,
  type NetworkPolicy,
} from "../../src/network";

const allowlist: NetworkPolicy = {
  mode: "proxy-allowlist",
  allow: [
    { type: "domain", host: "api.openai.com" },
    { type: "wildcard", suffix: "github.com" },
    { type: "domain", host: "registry.npmjs.org", ports: [443, 80] },
    { type: "cidr", cidr: "192.0.2.0/24", ports: [443] },
    { type: "cidr", cidr: "2001:db8::/32", ports: [443] },
  ],
};

const nonCanonicalIpv4 = [
  "0xc000022a",
  "3221226026",
  "192.0.554",
  "192.554",
  "0300.0.02.052",
  "0xc0.0x00.0x02.0x2a",
  "１９２.０.２.４２",
  "%31%39%32.0.2.42",
] as const;

describe("normalizeHost", () => {
  test("normalizes case, trailing dot, brackets, and IDN", () => {
    expect(normalizeHost("API.OPENAI.COM.")).toBe("api.openai.com");
    expect(normalizeHost("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeHost("bücher.example")).toBe("xn--bcher-kva.example");
  });

  test("rejects empty / invalid names", () => {
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
  });

  test("does not treat non-four-part IPv4 spellings as IP literals", () => {
    // ipaddr.js intentionally accepts legacy IPv4 forms like 0x7f000001.
    // Nautilo policy keeps IP literals boring + auditable: four-part
    // decimal IPv4 or normal IPv6 only.
    expect(normalizeHost("0x7f000001")).toBe("0x7f000001");
  });

  test("does not promote IDNA-normalized numeric spellings to IP literals", () => {
    for (const host of nonCanonicalIpv4) {
      expect(normalizeHost(host)).toBe(host);
    }
    expect(normalizeHost(" 0XC000022A. ")).toBe("0xc000022a");
    expect(normalizeHost("127.1")).toBe("127.1");
  });
});

describe("evaluateNetworkEgress", () => {
  test("host mode allows everything", () => {
    expect(evaluateNetworkEgress({ mode: "host" }, "evil.example", 666).allowed).toBe(true);
  });

  test("isolated mode denies everything", () => {
    expect(evaluateNetworkEgress({ mode: "isolated" }, "api.openai.com", 443)).toEqual({
      allowed: false,
      reason: "network policy is isolated",
    });
  });

  test("exact domain defaults to port 443", () => {
    expect(evaluateNetworkEgress(allowlist, "api.openai.com", 443).allowed).toBe(true);
    expect(evaluateNetworkEgress(allowlist, "api.openai.com", 80).allowed).toBe(false);
  });

  test("explicit ports override default", () => {
    expect(evaluateNetworkEgress(allowlist, "registry.npmjs.org", 80).allowed).toBe(true);
  });

  test("wildcard matches only subdomains, not siblings or bare domain", () => {
    expect(evaluateNetworkEgress(allowlist, "api.github.com", 443).allowed).toBe(true);
    expect(evaluateNetworkEgress(allowlist, "github.com", 443).allowed).toBe(false);
    expect(evaluateNetworkEgress(allowlist, "api.github.com.evil.org", 443).allowed).toBe(false);
  });

  test("preserves Unicode DNS normalization for exact and wildcard permissions", () => {
    const policy: NetworkPolicy = {
      mode: "proxy-allowlist",
      allow: [
        { type: "domain", host: "xn--bcher-kva.example" },
        { type: "wildcard", suffix: "bücher.example" },
      ],
    };
    expect(evaluateNetworkEgress(policy, "BÜCHER。EXAMPLE.", 443).allowed).toBe(true);
    expect(evaluateNetworkEgress(policy, "api.xn--bcher-kva.example", 443).allowed).toBe(true);
    expect(evaluateNetworkEgress(policy, "bücher.example.evil.org", 443).allowed).toBe(false);
    expect(evaluateNetworkEgress(policy, "bücher.example", 80).allowed).toBe(false);
  });

  test("IPv4 and IPv6 CIDR rules match same-family addresses only", () => {
    expect(evaluateNetworkEgress(allowlist, "192.0.2.42", 443).allowed).toBe(true);
    expect(evaluateNetworkEgress(allowlist, "203.0.113.42", 443).allowed).toBe(false);
    expect(evaluateNetworkEgress(allowlist, "2001:db8:1234::1", 443).allowed).toBe(true);
    expect(evaluateNetworkEgress(allowlist, "2001:db9::1", 443).allowed).toBe(false);
  });

  test("CIDR matching rejects legacy/non-canonical IPv4 spellings", () => {
    const policy: NetworkPolicy = {
      mode: "proxy-allowlist",
      allow: [{ type: "cidr", cidr: "192.0.2.0/24" }],
    };
    expect(evaluateNetworkEgress(policy, "0xc000022a", 443).allowed).toBe(false);
    for (const host of nonCanonicalIpv4) {
      expect(evaluateNetworkEgress(policy, host, 443).allowed).toBe(false);
      expect(evaluateNetworkEgress({
        mode: "proxy-allowlist",
        allow: [{ type: "domain", host: "192.0.2.42" }],
      }, host, 443).allowed).toBe(false);
    }
    expect(
      evaluateNetworkEgress(
        { mode: "proxy-allowlist", allow: [{ type: "cidr", cidr: "0xc0000200/24" }] },
        "192.0.2.42",
        443,
      ).allowed,
    ).toBe(false);
  });

  test("keeps an explicitly allowed legacy domain distinct from a canonical IP", () => {
    const policy: NetworkPolicy = {
      mode: "proxy-allowlist",
      allow: [{ type: "domain", host: "0xc000022a" }],
    };
    expect(evaluateNetworkEgress(policy, "0XC000022A", 443).allowed).toBe(true);
    expect(evaluateNetworkEgress(policy, "192.0.2.42", 443).allowed).toBe(false);
  });

  test("invalid ports and hosts deny", () => {
    expect(evaluateNetworkEgress(allowlist, "api.openai.com", 0).allowed).toBe(false);
    expect(evaluateNetworkEgress(allowlist, "api.openai.com", 70000).allowed).toBe(false);
    expect(evaluateNetworkEgress(allowlist, "", 443).allowed).toBe(false);
  });
});
