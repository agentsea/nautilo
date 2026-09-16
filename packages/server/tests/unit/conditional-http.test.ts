import { describe, expect, test } from "bun:test";
import {
  ifNoneMatchEquals,
  PRIVATE_NO_STORE_CACHE_CONTROL,
  sha256Base64Url,
  VARY_AUTHORIZATION,
  weakETagFromDigestInput,
} from "../../src/http/conditional-http";

describe("conditional-http helpers (M213)", () => {
  test("weakETagFromDigestInput is opaque W/\"base64url\" without embedding input", () => {
    const etag = weakETagFromDigestInput('{"apps":[{"id":"test-canvas"}]}');
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(etag).not.toContain("test-canvas");
  });

  test("sha256Base64Url is stable for identical input", () => {
    const input = "generation:1:{\"apps\":[]}";
    expect(sha256Base64Url(input)).toBe(sha256Base64Url(input));
    expect(weakETagFromDigestInput(input)).toBe(weakETagFromDigestInput(input));
  });

  test("exposes private no-store cache contract constants", () => {
    expect(PRIVATE_NO_STORE_CACHE_CONTROL).toBe("private, no-store");
    expect(VARY_AUTHORIZATION).toBe("Authorization");
  });
});

describe("ifNoneMatchEquals", () => {
  const etag = 'W/"abc123"';

  test("exact single-value match", () => {
    expect(ifNoneMatchEquals(etag, etag)).toBe(true);
    expect(ifNoneMatchEquals(`  ${etag}  `, etag)).toBe(true);
  });

  test("exact match among comma-separated tokens", () => {
    expect(ifNoneMatchEquals('W/"other", W/"abc123"', etag)).toBe(true);
  });

  test("no match for missing, empty, different, or wildcard headers", () => {
    expect(ifNoneMatchEquals(undefined, etag)).toBe(false);
    expect(ifNoneMatchEquals("", etag)).toBe(false);
    expect(ifNoneMatchEquals('W/"different"', etag)).toBe(false);
    expect(ifNoneMatchEquals("*", etag)).toBe(false);
  });

  test("accepts string[] header values", () => {
    expect(ifNoneMatchEquals([etag], etag)).toBe(true);
    expect(ifNoneMatchEquals(['W/"x"', 'W/"y"'], etag)).toBe(false);
  });
});
