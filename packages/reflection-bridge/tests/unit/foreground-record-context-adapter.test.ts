import { describe, expect, test } from "bun:test";

import { createForegroundRecordContextPort } from "../../src/server";

describe("foreground Record context adapter", () => {
  test("selects protected Record coordinates without opening statements", async () => {
    let ordinaryCalls = 0;
    const port = createForegroundRecordContextPort({
      bindingRef: "binding:room",
      representation: "protected",
      search: {
        async search() {
          ordinaryCalls += 1;
          throw new Error("ordinary search must not run");
        },
        async searchStructural(input) {
          expect(input.searchBindingRef).toBe("binding:room");
          return { status: "available", results: [{
            recordRef: "record:decision",
            score: 0.91,
            structuralHeight: 2,
          }] };
        },
      },
    });
    expect(await port.selectStructural?.({ query: "why postgres", limit: 5 }))
      .toEqual({
        status: "available",
        representation: "protected",
        queryEmbeddingStatus: "available",
        candidateCount: 1,
        records: [{
          representation: "structural",
          recordRef: "record:decision",
          structuralHeight: 2,
        }],
      });
    expect(ordinaryCalls).toBe(0);
  });

  test("uses exactly one first-page authority-filtered search and ignores continuation", async () => {
    const calls: unknown[] = [];
    const port = createForegroundRecordContextPort({
      bindingRef: "binding:room",
      representation: "ordinary",
      search: {
        async search(input) {
          calls.push(input);
          return {
            status: "available",
            results: [{
              recordRef: "record:decision",
              statement: "Use Postgres.",
              score: 0.91,
              structuralHeight: 2,
              lifecycle: "stale",
              directParentRecordRefs: ["record:hidden"],
              backlinksTruncated: true,
            }],
            continuation: "must-not-be-followed",
          };
        },
      },
    });
    const result = await port.select({ query: "why postgres", limit: 5 });
    expect(calls).toEqual([{
      query: "why postgres",
      limit: 5,
      searchBindingRef: "binding:room",
    }]);
    expect(result).toEqual({
      status: "available",
      representation: "ordinary",
      queryEmbeddingStatus: "available",
      candidateCount: 1,
      records: [{
        recordRef: "record:decision",
        statement: "Use Postgres.",
        lifecycle: "stale",
        structuralHeight: 2,
      }],
    });
    expect(JSON.stringify(result)).not.toContain("score");
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  test("preserves typed unavailability and cancellation without retry", async () => {
    let calls = 0;
    const port = createForegroundRecordContextPort({
      bindingRef: "binding:room",
      representation: "protected",
      search: {
        async search() {
          calls += 1;
          return { status: "unavailable", reason: "exact_scan_timeout" };
        },
      },
    });
    expect(await port.select({ query: "q", limit: 5 })).toEqual({
      status: "unavailable",
      representation: "protected",
      queryEmbeddingStatus: "available",
      reason: "exact_scan_timeout",
    });
    const controller = new AbortController();
    controller.abort();
    expect(await port.select({ query: "q", limit: 5, signal: controller.signal })).toEqual({
      status: "unavailable",
      representation: "protected",
      queryEmbeddingStatus: "unavailable",
      reason: "cancelled",
    });
    expect(calls).toBe(1);
  });

  test("redacts thrown failures to one fixed classification", async () => {
    const port = createForegroundRecordContextPort({
      bindingRef: "binding:room",
      representation: "ordinary",
      search: { search: () => Promise.reject(new Error("secret query and Room")) },
    });
    expect(await port.select({ query: "secret query", limit: 5 })).toEqual({
      status: "unavailable",
      representation: "ordinary",
      queryEmbeddingStatus: "unavailable",
      reason: "internal_error",
    });
  });
});
