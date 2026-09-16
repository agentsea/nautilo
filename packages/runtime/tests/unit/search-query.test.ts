import { describe, expect, test } from "bun:test";
import {
  buildSearchQueryLadder,
  normalizeSearchQuery,
  normalizeSearchTerms,
} from "../../src/conductor/search-query";

describe("conductor search query normalization (D302 P11)", () => {
  test("keeps topic terms and drops search meta words", () => {
    expect(normalizeSearchTerms("stock crash conversation history")).toEqual([
      "stock",
      "crash",
    ]);
  });

  test("cleans user phrasing without relying on history-intent regexes", () => {
    expect(
      normalizeSearchTerms(
        "Who the fuck was I talking to about the damn stock crash earlier?",
      ),
    ).toEqual(["stock", "crash"]);
  });

  test("builds a progressive relaxation ladder", () => {
    expect(buildSearchQueryLadder(["stock", "crash", "soxl"])).toEqual([
      "stock crash soxl",
      "stock crash",
      "crash soxl",
      "stock",
      "crash",
      "soxl",
    ]);
  });

  test("returns normalized terms and query ladder together", () => {
    expect(normalizeSearchQuery("damn stock crash discussion")).toEqual({
      terms: ["stock", "crash"],
      ladder: ["stock crash", "stock", "crash"],
    });
  });
});
