import { describe, expect, it } from "bun:test";
import {
  buildSearchUrl,
  DEFAULT_SEARCH_TEMPLATE,
  resolveAddressInput,
} from "./web-address";

const DUCKDUCKGO_PREFIX = "https://duckduckgo.com/?q=";

describe("resolveAddressInput", () => {
  describe("URL passthrough with explicit scheme", () => {
    it("leaves https URLs unchanged", () => {
      expect(resolveAddressInput("https://x.com")).toEqual({
        kind: "url",
        url: "https://x.com",
      });
    });

    it("leaves http URLs unchanged", () => {
      expect(resolveAddressInput("http://a")).toEqual({
        kind: "url",
        url: "http://a",
      });
    });

    it("leaves about: URLs unchanged", () => {
      expect(resolveAddressInput("about:blank")).toEqual({
        kind: "url",
        url: "about:blank",
      });
    });
  });

  describe("schemeless domains resolve to https URLs", () => {
    it("resolves example.com", () => {
      expect(resolveAddressInput("example.com")).toEqual({
        kind: "url",
        url: "https://example.com",
      });
    });

    it("resolves docs.google.com with path", () => {
      expect(resolveAddressInput("docs.google.com/document/u/0/")).toEqual({
        kind: "url",
        url: "https://docs.google.com/document/u/0/",
      });
    });

    it("resolves sub.domain.co.uk", () => {
      expect(resolveAddressInput("sub.domain.co.uk")).toEqual({
        kind: "url",
        url: "https://sub.domain.co.uk",
      });
    });
  });

  describe("localhost resolves to http URLs", () => {
    it("resolves localhost", () => {
      expect(resolveAddressInput("localhost")).toEqual({
        kind: "url",
        url: "http://localhost",
      });
    });

    it("resolves localhost with port", () => {
      expect(resolveAddressInput("localhost:3000")).toEqual({
        kind: "url",
        url: "http://localhost:3000",
      });
    });

    it("resolves localhost with port and path", () => {
      expect(resolveAddressInput("localhost:3000/path")).toEqual({
        kind: "url",
        url: "http://localhost:3000/path",
      });
    });
  });

  describe("IPv4 resolves to https URLs", () => {
    it("resolves 127.0.0.1", () => {
      expect(resolveAddressInput("127.0.0.1")).toEqual({
        kind: "url",
        url: "https://127.0.0.1",
      });
    });

    it("resolves IPv4 with port and path", () => {
      expect(resolveAddressInput("192.168.0.1:8080/x")).toEqual({
        kind: "url",
        url: "https://192.168.0.1:8080/x",
      });
    });
  });

  describe("search queries", () => {
    it("treats input with spaces as search", () => {
      const result = resolveAddressInput("nautilo docs");
      expect(result.kind).toBe("search");
      expect(result.url).toBe(
        `${DUCKDUCKGO_PREFIX}${encodeURIComponent("nautilo docs")}`,
      );
    });

    it("treats multi-word queries as search", () => {
      const result = resolveAddressInput("what is rust");
      expect(result.kind).toBe("search");
      expect(result.url.startsWith(DUCKDUCKGO_PREFIX)).toBe(true);
    });

    it("treats a TLD-less single word as search", () => {
      const result = resolveAddressInput("example");
      expect(result.kind).toBe("search");
      expect(result.url.startsWith(DUCKDUCKGO_PREFIX)).toBe(true);
      expect(result.url).toBe(`${DUCKDUCKGO_PREFIX}${encodeURIComponent("example")}`);
    });
  });
});

describe("buildSearchUrl", () => {
  it("encodes spaces and special characters", () => {
    expect(buildSearchUrl("a b&c")).toBe(
      `${DEFAULT_SEARCH_TEMPLATE}${encodeURIComponent("a b&c")}`,
    );
    expect(buildSearchUrl("a b&c")).toBe(
      "https://duckduckgo.com/?q=a%20b%26c",
    );
  });

  it("honors a custom search template", () => {
    const template = "https://search.example.test/?query=";
    expect(buildSearchUrl("hello world", template)).toBe(
      `${template}${encodeURIComponent("hello world")}`,
    );
    expect(resolveAddressInput("hello world", template)).toEqual({
      kind: "search",
      url: `${template}${encodeURIComponent("hello world")}`,
    });
  });
});
