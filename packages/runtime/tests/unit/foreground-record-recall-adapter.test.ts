import { describe, expect, test } from "bun:test";

import { createForegroundRecordRecallPort } from "../../src/reflection/foreground-record-recall-adapter";

describe("foreground Record recall adapter", () => {
  test("binds Room authority outside model arguments and maps search", async () => {
    const seen: unknown[] = [];
    const port = createForegroundRecordRecallPort({
      bindingRef: "room-binding",
      search: {
        async search(input) {
          seen.push(input);
          return {
            status: "available",
            results: [{
              recordRef: "record-1",
              statement: "Postgres was selected after comparing operations.",
              score: 0.9,
              structuralHeight: 2,
              lifecycle: "current",
              directParentRecordRefs: [],
              backlinksTruncated: false,
            }],
          };
        },
      },
      evidence: { async expand() { return { status: "unavailable", reason: "unauthorized" }; } },
    });
    expect(await port.search({ query: "why postgres", limit: 4 })).toEqual({
      status: "ok",
      records: [{
        recordRef: "record-1",
        statement: "Postgres was selected after comparing operations.",
        structuralHeight: 2,
        freshness: "current",
      }],
    });
    expect(seen).toEqual([{
      query: "why postgres",
      limit: 4,
      searchBindingRef: "room-binding",
    }]);
  });

  test("maps exact changed evidence without retry amplification", async () => {
    const port = createForegroundRecordRecallPort({
      bindingRef: "room-binding",
      search: { async search() { return { status: "available", results: [] }; } },
      evidence: { async expand() { return { status: "unavailable", reason: "source_changed" }; } },
    });
    expect(await port.expand({ recordRef: "record-1" })).toEqual({
      status: "unavailable",
      reason: "changed",
    });
  });

  test("preserves structural continuation on an empty authorized page", async () => {
    const port = createForegroundRecordRecallPort({
      bindingRef: "room-binding",
      search: {
        async search() { return { status: "available", results: [] }; },
        async searchStructural() {
          return {
            status: "available",
            results: [],
            continuation: "opaque-next-page",
          };
        },
      },
      evidence: { async expand() { return { status: "unavailable", reason: "unauthorized" }; } },
    });

    expect(await port.searchStructural({ query: "decision", limit: 5 })).toEqual({
      status: "ok",
      records: [],
      continuation: "opaque-next-page",
    });
  });
});
