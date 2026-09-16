import { describe, expect, test } from "bun:test";
import { createBrowserResearchUrlPolicy } from "../../electron/browser-research-url-policy";

function resolver(addressesByHost: Record<string, readonly string[]>) {
  return {
    resolve: async (host: string) => addressesByHost[host] ?? [],
    clear: () => undefined,
  };
}

describe("browser research URL policy", () => {
  test("allows public HTTP(S) destinations", async () => {
    const policy = createBrowserResearchUrlPolicy(resolver({ "example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] }));
    expect((await policy.assertAllowed("https://example.com/article")).href).toBe("https://example.com/article");
  });

  test("rejects local names, credentials, and non-HTTP protocols", async () => {
    const policy = createBrowserResearchUrlPolicy(resolver({}));
    for (const url of [
      "http://localhost/private",
      "http://localhost./private",
      "http://service.local/private",
      "http://intranet/private",
      "https://user:pass@example.com/",
      "file:///etc/passwd",
    ]) {
      expect(policy.assertAllowed(url)).rejects.toThrow();
    }
  });

  test("rejects every non-public IP family and mixed DNS answers", async () => {
    for (const addresses of [
      ["127.0.0.1"],
      ["10.0.0.1"],
      ["169.254.169.254"],
      ["192.168.1.10"],
      ["::1"],
      ["fe80::1"],
      ["fc00::1"],
      ["::ffff:127.0.0.1"],
      ["93.184.216.34", "10.0.0.1"],
    ]) {
      const policy = createBrowserResearchUrlPolicy(resolver({ "example.com": addresses }));
      expect(policy.assertAllowed("https://example.com")).rejects.toThrow("non-public");
    }
  });

  test("admits a globally routable IPv6 literal while still resolving and classifying it", async () => {
    const address = "2606:2800:220:1:248:1893:25c8:1946";
    const policy = createBrowserResearchUrlPolicy(resolver({ [address]: [address] }));
    expect((await policy.assertAllowed(`https://[${address}]/article`)).hostname).toBe(`[${address}]`);
  });

  test("fails closed when DNS yields no usable addresses", async () => {
    const policy = createBrowserResearchUrlPolicy(resolver({ "example.com": [] }));
    expect(policy.assertAllowed("https://example.com")).rejects.toThrow("non-public");
  });

  test("bounds document navigation hosts without rejecting public rendering subresources", async () => {
    const records = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [`asset-${index}.example.com`, ["93.184.216.34"]]),
    );
    const policy = createBrowserResearchUrlPolicy(resolver(records));

    for (let index = 0; index < 130; index += 1) {
      await expect(policy.assertAllowed(`https://asset-${index}.example.com/pixel`, "subresource")).resolves.toBeInstanceOf(URL);
    }
    for (let index = 0; index < 128; index += 1) {
      await expect(policy.assertAllowed(`https://asset-${index}.example.com/page`, "navigation")).resolves.toBeInstanceOf(URL);
    }
    await expect(policy.assertAllowed("https://asset-128.example.com/page", "navigation"))
      .rejects.toThrow("too many hosts");
  });
});
