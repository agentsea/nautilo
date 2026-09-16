import { describe, expect, test } from "bun:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  isSafeBlobId,
  requestIsVersioned,
  setMediaCacheHeaders,
} from "../../src/routes/_helpers/avatar";

/**
 * D243 Phase 2/3 — the avatar/icon cache policy lives in one place
 * (`setMediaCacheHeaders`) so the private avatar routes and the public
 * server-icon route can't drift apart again. These are pure-function tests
 * (no app/DB), so they live in the shared `tests/unit` process.
 */
function fakeReply(): { reply: FastifyReply; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const reply = {
    header(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, headers };
}

function fakeRequest(query: Record<string, unknown>): FastifyRequest {
  return { query } as unknown as FastifyRequest;
}

describe("setMediaCacheHeaders (D243 Phase 2/3 policy matrix)", () => {
  test("private + unversioned → revalidate every read, viewer-scoped", () => {
    const { reply, headers } = fakeReply();
    setMediaCacheHeaders(reply, { visibility: "private" });
    expect(headers["cache-control"]).toBe("private, no-cache");
    expect(headers["vary"]).toBe("Authorization");
  });

  test("public + unversioned → short shareable cache, no Vary", () => {
    const { reply, headers } = fakeReply();
    setMediaCacheHeaders(reply, { visibility: "public" });
    expect(headers["cache-control"]).toBe("public, max-age=86400");
    expect(headers["vary"]).toBeUndefined();
  });

  test("private + versioned → immutable, still viewer-scoped", () => {
    const { reply, headers } = fakeReply();
    setMediaCacheHeaders(reply, { visibility: "private", versioned: true });
    expect(headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(headers["vary"]).toBe("Authorization");
  });

  test("public + versioned → immutable, no Vary", () => {
    const { reply, headers } = fakeReply();
    setMediaCacheHeaders(reply, { visibility: "public", versioned: true });
    expect(headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(headers["vary"]).toBeUndefined();
  });

  test("etag is quoted when provided", () => {
    const { reply, headers } = fakeReply();
    setMediaCacheHeaders(reply, { visibility: "public", etag: "blob123", versioned: true });
    expect(headers["etag"]).toBe('"blob123"');
  });
});

describe("requestIsVersioned", () => {
  test("true only for a non-empty string ?v", () => {
    expect(requestIsVersioned(fakeRequest({ v: "abc" }))).toBe(true);
    expect(requestIsVersioned(fakeRequest({ v: "" }))).toBe(false);
    expect(requestIsVersioned(fakeRequest({}))).toBe(false);
    expect(requestIsVersioned(fakeRequest({ v: ["abc"] }))).toBe(false);
    expect(requestIsVersioned(fakeRequest({ v: 1 }))).toBe(false);
  });
});

describe("isSafeBlobId (path-traversal jail)", () => {
  test("accepts uuid/blob-ish ids, rejects traversal", () => {
    expect(isSafeBlobId("a1b2-c3d4.thumb")).toBe(true);
    expect(isSafeBlobId("../etc/passwd")).toBe(false);
    expect(isSafeBlobId("a/b")).toBe(false);
    expect(isSafeBlobId("a b")).toBe(false);
    expect(isSafeBlobId("")).toBe(false);
  });
});
