/**
 * D103 P4d.8 — tests for `canonicalizeServerUrl`.
 */
import { describe, expect, test } from "bun:test";
import { canonicalServerScope, canonicalizeServerUrl, loopbackDedupeKey } from "../../electron/url-canonical";
import { canonicalizeRecentServerUrl } from "../../electron/recent-servers-schema";

describe("canonicalizeServerUrl (D103 P4d.8)", () => {
  test("127.0.0.1 input + localhost declared → rewrites to localhost", () => {
    expect(
      canonicalizeServerUrl("http://127.0.0.1:3001", "http://localhost:3001"),
    ).toBe("http://localhost:3001");
  });

  test("localhost input + 127.0.0.1 declared → rewrites to 127.0.0.1", () => {
    expect(
      canonicalizeServerUrl("http://localhost:3001", "http://127.0.0.1:3001"),
    ).toBe("http://127.0.0.1:3001");
  });

  test("localhost input + localhost declared → unchanged", () => {
    expect(
      canonicalizeServerUrl("http://localhost:3001", "http://localhost:3001"),
    ).toBe("http://localhost:3001");
  });

  test("non-loopback host (LAN IP) + loopback declared → unchanged", () => {
    expect(
      canonicalizeServerUrl(
        "http://192.168.1.10:3001",
        "http://localhost:3001",
      ),
    ).toBe("http://192.168.1.10:3001");
  });

  test("nautilo.local + localhost declared → unchanged (only loopback↔loopback rewrites)", () => {
    expect(
      canonicalizeServerUrl(
        "http://nautilo.local:3001",
        "http://localhost:3001",
      ),
    ).toBe("http://nautilo.local:3001");
  });

  test("cloud URL + null declared → unchanged", () => {
    expect(canonicalizeServerUrl("https://demo.nautilo.dev", null)).toBe(
      "https://demo.nautilo.dev",
    );
  });

  test("cloud URL + cloud declared → unchanged (no loopback involvement)", () => {
    expect(
      canonicalizeServerUrl("https://demo.nautilo.dev", "https://demo.nautilo.dev"),
    ).toBe("https://demo.nautilo.dev");
  });

  test("trailing slash on input is stripped", () => {
    expect(
      canonicalizeServerUrl("http://localhost:3001/", "http://localhost:3001"),
    ).toBe("http://localhost:3001");
  });

  test("trailing slash + canonicalization happen together", () => {
    expect(
      canonicalizeServerUrl("http://127.0.0.1:3001/", "http://localhost:3001"),
    ).toBe("http://localhost:3001");
  });

  test("malformed declared URL → falls back to input (with trailing-slash strip)", () => {
    expect(
      canonicalizeServerUrl("http://127.0.0.1:3001", "not a url"),
    ).toBe("http://127.0.0.1:3001");
  });

  test("path on URL is preserved", () => {
    expect(
      canonicalizeServerUrl(
        "http://127.0.0.1:3001/some/path",
        "http://localhost:3001",
      ),
    ).toBe("http://localhost:3001/some/path");
  });

  test("https + loopback canonicalization works the same", () => {
    expect(
      canonicalizeServerUrl("https://127.0.0.1:3001", "https://localhost:3001"),
    ).toBe("https://localhost:3001");
  });

  test("port mismatch between input and declared does NOT trigger rewrite by itself", () => {
    // Different ports = different services. Don't touch the port; only
    // the loopback-host name is the canonicalization axis.
    expect(
      canonicalizeServerUrl("http://localhost:8080", "http://localhost:3001"),
    ).toBe("http://localhost:8080");
  });

  test("127.0.0.1 vs localhost with mismatched ports does NOT rewrite host", () => {
    expect(
      canonicalizeServerUrl("http://127.0.0.1:3001", "http://localhost:8080"),
    ).toBe("http://127.0.0.1:3001");

    expect(
      canonicalizeServerUrl("http://localhost:8080", "http://127.0.0.1:3001"),
    ).toBe("http://localhost:8080");
  });

  test("[::1] input + localhost declared → rewrites to localhost", () => {
    expect(
      canonicalizeServerUrl("http://[::1]:3001", "http://localhost:3001"),
    ).toBe("http://localhost:3001");
  });

  test("localhost input + [::1] declared → rewrites to [::1]", () => {
    expect(
      canonicalizeServerUrl("http://localhost:3001", "http://[::1]:3001"),
    ).toBe("http://[::1]:3001");
  });

  test("[::1] input + [::1] declared → unchanged", () => {
    expect(
      canonicalizeServerUrl("http://[::1]:3001", "http://[::1]:3001"),
    ).toBe("http://[::1]:3001");
  });

  test("path on IPv6 loopback URL is preserved", () => {
    expect(
      canonicalizeServerUrl(
        "http://[::1]:3001/some/path",
        "http://localhost:3001",
      ),
    ).toBe("http://localhost:3001/some/path");
  });

  test("protocol mismatch between input and declared does NOT rewrite host", () => {
    expect(
      canonicalizeServerUrl("https://127.0.0.1:3001", "http://localhost:3001"),
    ).toBe("https://127.0.0.1:3001");
  });
});

describe("canonicalServerScope (M161 Phase 1)", () => {
  test("trailing slash is stripped", () => {
    expect(canonicalServerScope("https://example.com/")).toBe("https://example.com");
  });

  test("mixed-case host lowercases to match canonicalizeRecentServerUrl", () => {
    expect(canonicalServerScope("HTTPS://Example.COM/MyPath")).toBe(
      "https://example.com/MyPath",
    );
  });

  test("round-trips identically to canonicalizeRecentServerUrl for non-loopback host", () => {
    const inputs = [
      "https://Example.COM",
      "https://example.com/",
      "HTTPS://Example.COM/MyPath/",
      "https://demo.nautilo.dev",
    ];
    for (const input of inputs) {
      expect(canonicalServerScope(input)).toBe(canonicalizeRecentServerUrl(input));
    }
  });

  test("loopback rewrite matches canonicalizeServerUrl when declared URL supplied", () => {
    expect(canonicalServerScope("http://127.0.0.1:3001", "http://localhost:3001")).toBe(
      "http://localhost:3001",
    );
    expect(canonicalServerScope("http://localhost:3001/", "http://127.0.0.1:3001")).toBe(
      "http://127.0.0.1:3001",
    );
  });

  test("non-loopback host with declared loopback URL is unchanged", () => {
    expect(canonicalServerScope("http://192.168.1.10:3001", "http://localhost:3001")).toBe(
      "http://192.168.1.10:3001",
    );
  });

  test("idempotent — feeding the output back in yields the same string", () => {
    const cases = [
      "https://Example.COM/",
      "http://127.0.0.1:3001",
      "https://demo.nautilo.dev/path/",
    ];
    for (const c of cases) {
      const once = canonicalServerScope(c);
      expect(canonicalServerScope(once)).toBe(once);
    }
  });

  test("trims surrounding whitespace before parsing", () => {
    expect(canonicalServerScope("  https://example.com/  ")).toBe("https://example.com");
  });
});

describe("loopbackDedupeKey (M161 Phase 6.4)", () => {
  test("normalizes 127.0.0.1 and [::1] to localhost while preserving protocol + port", () => {
    expect(loopbackDedupeKey("http://localhost:3001")).toBe("http://localhost:3001");
    expect(loopbackDedupeKey("http://127.0.0.1:3001")).toBe("http://localhost:3001");
    expect(loopbackDedupeKey("http://[::1]:3001")).toBe("http://localhost:3001");
    expect(loopbackDedupeKey("http://[::1]:3001/")).toBe("http://localhost:3001");
  });

  test("preserves protocol (https loopback stays https)", () => {
    expect(loopbackDedupeKey("https://127.0.0.1:3001")).toBe("https://localhost:3001");
    expect(loopbackDedupeKey("https://[::1]:3001")).toBe("https://localhost:3001");
  });

  test("port differences remain distinct (no cross-port collapse)", () => {
    expect(loopbackDedupeKey("http://localhost:3000")).toBe("http://localhost:3000");
    expect(loopbackDedupeKey("http://localhost:3001")).toBe("http://localhost:3001");
    expect(loopbackDedupeKey("http://127.0.0.1:3000")).not.toBe(
      loopbackDedupeKey("http://127.0.0.1:3001"),
    );
  });

  test("protocol differences remain distinct (http vs https)", () => {
    expect(loopbackDedupeKey("http://localhost:3001")).not.toBe(
      loopbackDedupeKey("https://localhost:3001"),
    );
  });

  test("non-loopback hosts round-trip through canonicalServerScope (no host rewrite)", () => {
    expect(loopbackDedupeKey("https://Example.COM/")).toBe("https://example.com");
    expect(loopbackDedupeKey("https://nautilo.example.test")).toBe("https://nautilo.example.test");
    expect(loopbackDedupeKey("https://upgrade.example.test")).toBe("https://upgrade.example.test");
    expect(loopbackDedupeKey("https://nautilo.example.test")).not.toBe(
      loopbackDedupeKey("https://upgrade.example.test"),
    );
  });

  test("idempotent — feeding the output back in yields the same string", () => {
    const cases = [
      "http://127.0.0.1:3001",
      "http://[::1]:3001/",
      "https://localhost:3001",
      "https://example.com/",
    ];
    for (const c of cases) {
      const once = loopbackDedupeKey(c);
      expect(loopbackDedupeKey(once)).toBe(once);
    }
  });

  test("same loopback alias forms collapse to one key (the live/recent duplicate-row case)", () => {
    const a = loopbackDedupeKey("http://localhost:3001");
    const b = loopbackDedupeKey("http://127.0.0.1:3001");
    const c = loopbackDedupeKey("http://[::1]:3001");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
