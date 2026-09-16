/**
 * D426 Phase 1 §1.1 — executable contract for which child transcript rows
 * contribute to a root's denormalized reply summary. This is the pure
 * (DB-free) half; the SQL aggregate in `recomputeRootSummary` mirrors it,
 * and the live-DB persistence test in
 * `tests/integration/d426-subthread-summary-persistence.integration.test.ts`
 * proves the two never drift.
 */
import { describe, expect, test } from "bun:test";
import { isCountedReplyRow } from "../../src/store/session-store";

describe("D426 §1.1 isCountedReplyRow contract", () => {
  test("counts visible human rows regardless of content", () => {
    expect(isCountedReplyRow({ role: "user", content: "hi" })).toBe(true);
    expect(isCountedReplyRow({ role: "user", content: "" })).toBe(true);
  });

  test("counts non-empty Genie (assistant) rows", () => {
    expect(isCountedReplyRow({ role: "assistant", content: "here's an answer" })).toBe(true);
  });

  test("excludes empty assistant rows (pure tool-call turns)", () => {
    expect(isCountedReplyRow({ role: "assistant", content: "" })).toBe(false);
  });

  test("excludes tool / system / unknown rows", () => {
    expect(isCountedReplyRow({ role: "tool", content: "result" })).toBe(false);
    expect(isCountedReplyRow({ role: "system", content: "prompt" })).toBe(false);
    expect(isCountedReplyRow({ role: "unknown", content: "x" })).toBe(false);
  });

  test("excludes transient Task report-back rows (metadata.originatedBy='task')", () => {
    expect(
      isCountedReplyRow({ role: "user", content: "synthetic", originatedBy: "task" }),
    ).toBe(false);
    expect(
      isCountedReplyRow({ role: "assistant", content: "synthetic", originatedBy: "task" }),
    ).toBe(false);
  });

  test("non-task originatedBy does not exclude", () => {
    expect(
      isCountedReplyRow({ role: "user", content: "real", originatedBy: null }),
    ).toBe(true);
    expect(
      isCountedReplyRow({ role: "user", content: "real" }),
    ).toBe(true);
  });

  test("quiet browser supervision is audit, not another conversation reply", () => {
    for (const role of ["user", "assistant", "tool"]) {
      expect(isCountedReplyRow({ role, content: "Inspecting", originatedBy: "connected_web_operation" })).toBe(false);
    }
    expect(isCountedReplyRow({ role: "assistant", content: "The final answer" })).toBe(true);
  });
});
