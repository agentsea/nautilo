import { describe, expect, test } from "bun:test";

import { createDnsResolver, DnsResolutionError } from "../../src/network";

describe("createDnsResolver", () => {
  test("normalizes and caches DNS answers until TTL expires", async () => {
    let now = 1_000;
    let calls = 0;
    const resolver = createDnsResolver({
      ttlMs: 100,
      now: () => now,
      lookup: async (host) => {
        calls++;
        expect(host).toBe("example.com");
        return ["192.168.1.2", "192.168.1.2"];
      },
    });

    expect(await resolver.resolve("EXAMPLE.COM.")).toEqual(["192.168.1.2"]);
    expect(await resolver.resolve("example.com")).toEqual(["192.168.1.2"]);
    expect(calls).toBe(1);
    now = 1_101;
    expect(await resolver.resolve("example.com")).toEqual(["192.168.1.2"]);
    expect(calls).toBe(2);
  });

  test("IP literals bypass lookup", async () => {
    const resolver = createDnsResolver({
      lookup: async () => {
        throw new Error("should not lookup IP literals");
      },
    });
    expect(await resolver.resolve("[2001:db8::1]")).toEqual(["2001:db8::1"]);
    expect(await resolver.resolve("192.168.1.1")).toEqual(["192.168.1.1"]);
  });

  test("empty lookup results throw DnsResolutionError", async () => {
    const resolver = createDnsResolver({ lookup: async () => [] });
    let thrown: unknown;
    try {
      await resolver.resolve("example.com");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DnsResolutionError);
  });

  test("invalid host throws DnsResolutionError", async () => {
    const resolver = createDnsResolver();
    let thrown: unknown;
    try {
      await resolver.resolve("");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DnsResolutionError);
  });
});
