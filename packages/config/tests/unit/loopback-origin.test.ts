import { describe, expect, test } from "bun:test";
import {
  buildRedirectUri,
  canonicalizeLoopbackOrigin,
  isLoopbackHostname,
} from "@nautilo/config/loopback-origin";

describe("@nautilo/config/loopback-origin sub-path", () => {
  describe("isLoopbackHostname", () => {
    test("recognizes approved loopback host literals", () => {
      expect(isLoopbackHostname("localhost")).toBe(true);
      expect(isLoopbackHostname("127.0.0.1")).toBe(true);
      expect(isLoopbackHostname("[::1]")).toBe(true);
      expect(isLoopbackHostname("::1")).toBe(true);
    });

    test("rejects malicious lookalikes and non-loopback hosts", () => {
      expect(isLoopbackHostname("localhost.evil")).toBe(false);
      expect(isLoopbackHostname("127.0.0.1.evil")).toBe(false);
      expect(isLoopbackHostname("workbench.example.test")).toBe(false);
      expect(isLoopbackHostname("192.168.1.1")).toBe(false);
    });
  });

  describe("canonicalizeLoopbackOrigin", () => {
    test("rewrites 127.0.0.1 to localhost on the same protocol and port", () => {
      expect(
        canonicalizeLoopbackOrigin("http://127.0.0.1:3001", [
          "http://localhost:3001",
          "http://localhost:3000",
        ]),
      ).toBe("http://localhost:3001");
    });

    test("rewrites localhost to 127.0.0.1 when the trusted origin declares it", () => {
      expect(
        canonicalizeLoopbackOrigin("http://localhost:3001", [
          "http://127.0.0.1:3001",
        ]),
      ).toBe("http://127.0.0.1:3001");
    });

    test("rewrites IPv6 loopback to a trusted loopback origin on same protocol and port", () => {
      expect(
        canonicalizeLoopbackOrigin("http://[::1]:3001", [
          "http://localhost:3001",
        ]),
      ).toBe("http://localhost:3001");

      expect(
        canonicalizeLoopbackOrigin("http://localhost:3001", [
          "http://[::1]:3001",
        ]),
      ).toBe("http://[::1]:3001");
    });

    test("does not rewrite when ports differ", () => {
      expect(
        canonicalizeLoopbackOrigin("http://127.0.0.1:3000", [
          "http://localhost:3001",
        ]),
      ).toBe("http://127.0.0.1:3000");
    });

    test("does not rewrite when protocols differ", () => {
      expect(
        canonicalizeLoopbackOrigin("https://127.0.0.1:3001", [
          "http://localhost:3001",
        ]),
      ).toBe("https://127.0.0.1:3001");

      expect(
        canonicalizeLoopbackOrigin("http://127.0.0.1:3001", [
          "https://localhost:3001",
        ]),
      ).toBe("http://127.0.0.1:3001");
    });

    test("does not rewrite unsupported protocols", () => {
      expect(
        canonicalizeLoopbackOrigin("ftp://127.0.0.1:21", [
          "ftp://localhost:21",
        ]),
      ).toBe("ftp://127.0.0.1:21");

      expect(
        canonicalizeLoopbackOrigin("http://127.0.0.1:3001", [
          "ftp://localhost:3001",
          "http://localhost:3001",
        ]),
      ).toBe("http://localhost:3001");
    });

    test("does not rewrite non-loopback origins", () => {
      expect(
        canonicalizeLoopbackOrigin("https://workbench.example.test", [
          "http://localhost:3001",
        ]),
      ).toBe("https://workbench.example.test");

      expect(
        canonicalizeLoopbackOrigin("http://192.168.1.10:3001", [
          "http://localhost:3001",
        ]),
      ).toBe("http://192.168.1.10:3001");
    });

    test("does not treat malicious lookalikes as loopback", () => {
      expect(
        canonicalizeLoopbackOrigin("http://localhost.evil:3001", [
          "http://localhost:3001",
        ]),
      ).toBe("http://localhost.evil:3001");

      expect(
        canonicalizeLoopbackOrigin("http://127.0.0.1.evil:3001", [
          "http://127.0.0.1:3001",
        ]),
      ).toBe("http://127.0.0.1.evil:3001");
    });

    test("returns malformed current origin unchanged", () => {
      expect(
        canonicalizeLoopbackOrigin("not a url", ["http://localhost:3001"]),
      ).toBe("not a url");

      expect(canonicalizeLoopbackOrigin("", ["http://localhost:3001"])).toBe(
        "",
      );
    });

    test("ignores non-loopback or malformed canonical origins", () => {
      expect(
        canonicalizeLoopbackOrigin("http://127.0.0.1:3001", [
          "https://workbench.example.test",
          "not a url",
          "http://localhost:3001",
        ]),
      ).toBe("http://localhost:3001");
    });
  });

  describe("buildRedirectUri", () => {
    test("builds /auth/callback from the canonical origin", () => {
      expect(
        buildRedirectUri("/auth/callback", "http://127.0.0.1:3001", [
          "http://localhost:3001",
        ]),
      ).toBe("http://localhost:3001/auth/callback");
    });

    test("builds /settings/security from the canonical origin", () => {
      expect(
        buildRedirectUri("/settings/security", "http://localhost:3001", [
          "http://127.0.0.1:3001",
        ]),
      ).toBe("http://127.0.0.1:3001/settings/security");
    });

    test("normalizes paths missing a leading slash", () => {
      expect(
        buildRedirectUri("auth/callback", "http://127.0.0.1:3001", [
          "http://localhost:3001",
        ]),
      ).toBe("http://localhost:3001/auth/callback");

      expect(
        buildRedirectUri("settings/security", "http://localhost:3001", [
          "http://127.0.0.1:3001",
        ]),
      ).toBe("http://127.0.0.1:3001/settings/security");
    });
  });
});
