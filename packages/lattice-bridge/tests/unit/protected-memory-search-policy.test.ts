import { describe, expect, test } from "bun:test";

import {
  planProtectedMemorySearch,
} from "../../src/memory/protected-search-policy.ts";

describe("protected Memory search policy", () => {
  test("permits only embedding-ranked semantic search", () => {
    expect(planProtectedMemorySearch("vector")).toEqual({ kind: "semantic" });
  });

  test("never falls back to the legacy plaintext body for text search", () => {
    expect(planProtectedMemorySearch("text")).toEqual({
      kind: "unavailable",
      code: "plaintext_text_search_unavailable",
    });
  });
});
