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
    { type: "cidr", cidr: "192.168.1.0/24", ports: [443] },
    { type: "cidr", cidr: "2001:db8::/32", ports: [443] },
  ],
};

const noncanonicalIpv4Hosts = [
  "0xc0a8012a", // hexadecimal integer
  "3232235818", // decimal integer
  "0300.0250.0001.0052", // octal components
  "192.168.298", // abbreviated
  "192.11010346", // two components
  "192.168.1.0x2a", // mixed decimal and hexadecimal
  "192.168.001.042", // leading zero components
  "[0xc0a8012a]", // brackets cannot make legacy IPv4 strict
  "0xc0a8012a.", // nor can a trailing dot
  "１９２.１６８.１.４２", // IDNA digit conversion
  "０ｘｃ０ａ８０１２ａ", // IDNA can also yield a legacy spelling
  "192。168。1。42", // IDNA separator conversion
  "%31%39%32.168.1.42", // URL byte decoding
];

describe("normalizeHost", () => {
  test("normalizes case, trailing dot, brackets, and IDN", () => {
    expect(normalizeHost("API.OPENAI.COM.")).toBe("api.openai.com");
    expect(normalizeHost("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeHost("bücher.example")).toBe("xn--bcher-kva.example");
    expect(normalizeHost("192.168.1.42")).toBe("192.168.1.42");
    expect(normalizeHost("192.168.1.42.")).toBe("192.168.1.42");
    expect(normalizeHost("[::ffff:192.168.1.42]")).toBe("::ffff:c0a8:12a");
    expect(normalizeHost("123.example")).toBe("123.example");
  });

  test("rejects empty / invalid names", () => {
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
  });

  test.each(noncanonicalIpv4Hosts)("rejects noncanonical IPv4 host %s", (host) => {
    expect(normalizeHost(host)).toBeNull();
  });

  test.each(["0x7f000001", "0177.0.0.1", "127.1", "2130706433"])(
    "rejects legacy loopback host %s", (host) => {
      expect(normalizeHost(host)).toBeNull();
      expect(evaluateNetworkEgress({
        mode: "proxy-allowlist", allow: [{ type: "cidr", cidr: "127.0.0.0/8" }],
      }, host, 443).allowed).toBe(false);
    },
  );
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

  test("IPv4 and IPv6 CIDR rules match same-family addresses only", () => {
    expect(evaluateNetworkEgress(allowlist, "192.168.1.42", 443).allowed).toBe(true);
    expect(evaluateNetworkEgress(allowlist, "192.168.2.42", 443).allowed).toBe(false);
    expect(evaluateNetworkEgress(allowlist, "2001:db8:1234::1", 443).allowed).toBe(true);
    expect(evaluateNetworkEgress(allowlist, "2001:db9::1", 443).allowed).toBe(false);
  });

  test("CIDR matching rejects legacy/non-canonical IPv4 spellings", () => {
    const policy: NetworkPolicy = {
      mode: "proxy-allowlist",
      allow: [{ type: "cidr", cidr: "192.168.1.0/24" }],
    };
    for (const host of noncanonicalIpv4Hosts) {
      expect(evaluateNetworkEgress(policy, host, 443).allowed).toBe(false);
      expect(evaluateNetworkEgress({
        mode: "proxy-allowlist",
        allow: [{ type: "domain", host: "192.168.1.42" }],
      }, host, 443).allowed).toBe(false);
      expect(evaluateNetworkEgress({
        mode: "proxy-allowlist",
        allow: [{ type: "domain", host }],
      }, "192.168.1.42", 443).allowed).toBe(false);
    }
    expect(
      evaluateNetworkEgress(
        { mode: "proxy-allowlist", allow: [{ type: "cidr", cidr: "0xc0a80100/24" }] },
        "192.168.1.42",
        443,
      ).allowed,
    ).toBe(false);
  });

  test("invalid ports and hosts deny", () => {
    expect(evaluateNetworkEgress(allowlist, "api.openai.com", 0).allowed).toBe(false);
    expect(evaluateNetworkEgress(allowlist, "api.openai.com", 70000).allowed).toBe(false);
    expect(evaluateNetworkEgress(allowlist, "", 443).allowed).toBe(false);
  });
});
