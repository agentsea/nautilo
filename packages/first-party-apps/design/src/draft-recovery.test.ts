import { describe, expect, test } from "bun:test";
import {
  createDesignDraftRecoveryRecord,
  designDraftRecoveryStateAdapter,
  draftRecoveryBaseMatches,
  parseDesignDraftRecoveryRecord,
  readDesignDraftRecoveryState,
} from "./draft-recovery";

describe("design draft recovery", () => {
  test("round-trips exact serialized content and base evidence for the same scope", () => {
    const record = createDesignDraftRecoveryRecord(
      "document:hero",
      "<html>exact draft</html>",
      { sha256: "base-sha", revision: 7 },
    );
    expect(parseDesignDraftRecoveryRecord(record, "document:hero")).toEqual(record);
  });

  test("rejects records from another document scope", () => {
    const record = createDesignDraftRecoveryRecord(
      "document:hero",
      "<html>hero draft</html>",
      { sha256: "base-sha", revision: 7 },
    );
    expect(parseDesignDraftRecoveryRecord(record, "document:other")).toBeNull();
  });

  test("rejects malformed records without substituting partial content", () => {
    expect(
      parseDesignDraftRecoveryRecord(
        {
          version: 1,
          scope: "document:hero",
          content: "<html>draft</html>",
          base: { sha256: "sha", revision: 1.5 },
        },
        "document:hero",
      ),
    ).toBeNull();
  });

  test("preserves a divergent base as conflict evidence", () => {
    const record = createDesignDraftRecoveryRecord(
      "document:hero",
      "<html>draft</html>",
      { sha256: "old", revision: 3 },
    );
    expect(draftRecoveryBaseMatches(record, { sha256: "old", revision: 3 })).toBe(true);
    expect(draftRecoveryBaseMatches(record, { sha256: "new", revision: 4 })).toBe(false);
  });

  test("requires an explicit non-empty scope", () => {
    expect(() =>
      createDesignDraftRecoveryRecord("", "<html>draft</html>", {
        sha256: null,
        revision: null,
      }),
    ).toThrow("document scope");
  });

  test("wires caller-selected host state without cross-scope fallback", async () => {
    const values = new Map<string, unknown>();
    const state = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    };
    const adapter = designDraftRecoveryStateAdapter(state, "caller.selected.key");
    const record = createDesignDraftRecoveryRecord(
      "document:hero",
      "<html>draft</html>",
      { sha256: "base", revision: 2 },
    );
    await adapter.write(record);
    expect(
      await readDesignDraftRecoveryState(state, "caller.selected.key", "document:hero"),
    ).toEqual(record);
    expect(
      await readDesignDraftRecoveryState(state, "caller.selected.key", "document:other"),
    ).toBeNull();
    await adapter.write(null);
    expect(
      await readDesignDraftRecoveryState(state, "caller.selected.key", "document:hero"),
    ).toBeNull();
  });
});
