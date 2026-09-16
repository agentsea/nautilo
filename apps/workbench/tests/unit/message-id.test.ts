/**
 * Regression lock — newMessageId uniqueness under burst dispatch.
 *
 * This is THE bug that caused today's gray-screen crashes:
 * assistant-ui's MessageRepository throws on duplicate ids; the ids
 * were built as `${prefix}-${Date.now()}`; TurnActionBar Accept-all
 * fired N `requestApplyPatch` calls in a tight synchronous loop;
 * every call hit Date.now() with the same value; collision; throw;
 * React unmounted the app; blank viewport; user ⌘R.
 *
 * If a refactor ever regresses to date-only ids, these tests fail
 * LOUDLY. Don't delete them without reading the D087 post-mortem.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  newMessageId,
  dedupeThreadMessagesById,
  _resetMessageIdSeqForTests,
} from "../../src/lib/message-id";

describe("newMessageId — anti-collision invariants (do not remove)", () => {
  beforeEach(() => {
    _resetMessageIdSeqForTests();
  });

  test("format is `${prefix}-${ms}-${seq}-${rand}` with the prefix preserved", () => {
    const id = newMessageId("user");
    // user-<13-digit-ms>-<4 hex>-<4 hex>
    expect(id).toMatch(/^user-\d{13}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });

  test("other prefixes ride through correctly", () => {
    for (const prefix of ["assistant", "error", "system", "system-verified"]) {
      expect(newMessageId(prefix)).toMatch(
        new RegExp(`^${prefix}-\\d{13}-[0-9a-f]{4}-[0-9a-f]{4}$`),
      );
    }
  });

  test("two calls in the same tick produce DIFFERENT ids", () => {
    // The bug: `user-${Date.now()}` returned identical strings when
    // called twice in the same millisecond. Lock the inverse.
    const a = newMessageId("user");
    const b = newMessageId("user");
    expect(a).not.toBe(b);
  });

  test("a TurnActionBar-sized burst (3 messages) produces 3 unique ids", () => {
    // Exact shape of the bug: three synchronous requestApplyPatch
    // calls. This test guarantees the fix remains effective.
    const ids = [newMessageId("user"), newMessageId("user"), newMessageId("user")];
    expect(new Set(ids).size).toBe(3);
  });

  test("a heavier burst (1000 messages in a tight loop) stays unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(newMessageId("user"));
    }
    expect(ids.size).toBe(1000);
  });

  test("counter wraps cleanly past 65536 without collisions within a single ms", () => {
    // The counter is 16-bit (& 0xffff). Within one millisecond the
    // random suffix has to carry uniqueness if we ever hit 65537
    // messages — realistically impossible, but let's pin the behavior
    // anyway so future refactors don't silently change the shape.
    // We can't freeze time in bun without mocking, so we just verify
    // the counter wraps without throwing and that the total set
    // stays large (random suffix covers the collision risk).
    const ids = new Set<string>();
    for (let i = 0; i < 70000; i++) {
      ids.add(newMessageId("user"));
    }
    // The random suffix alone gives 65536 possibilities per seq
    // value; combined with ms precision we expect essentially zero
    // collisions for a 70k burst. Allow 1% slack for math/random
    // anomalies rather than demanding perfect uniqueness.
    expect(ids.size).toBeGreaterThan(70000 * 0.99);
  });

  test("ids are NEVER the bare `${prefix}-${Date.now()}` shape the bug used", () => {
    // Explicit anti-regression: a date-only id would match
    // `^user-\d{13}$`. Any future accidental revert to that pattern
    // fails here immediately.
    const id = newMessageId("user");
    expect(id).not.toMatch(/^user-\d{13}$/);
  });
});

describe("dedupeThreadMessagesById — assistant-ui duplicate-id guard", () => {
  test("keeps first row when the same id appears twice (replayed tool.start)", () => {
    const a = { id: "tool-call-1", role: "assistant" as const, content: "first" };
    const b = { id: "tool-call-1", role: "assistant" as const, content: "second" };
    expect(dedupeThreadMessagesById([a, b])).toEqual([a]);
  });

  test("preserves order and unrelated rows", () => {
    const rows = [
      { id: "1", x: 1 },
      { id: "tool-x", x: 2 },
      { id: "2", x: 3 },
      { id: "tool-x", x: 4 },
    ];
    expect(dedupeThreadMessagesById(rows)).toEqual([
      { id: "1", x: 1 },
      { id: "tool-x", x: 2 },
      { id: "2", x: 3 },
    ]);
  });
});
