import { describe, expect, test } from "bun:test";
import { buildRoutingView } from "../../src/conductor/routing-view";

describe("buildRoutingView (D302 R12)", () => {
  test("keeps short content unmodified", () => {
    const view = buildRoutingView("hello world");
    expect(view.content).toBe("hello world");
    expect(view.truncated).toBe(false);
    expect(view.originalLength).toBe(11);
  });

  test("truncates long content with head/tail marker", () => {
    const view = buildRoutingView("a".repeat(20) + "b".repeat(20), {
      perMessageHeadChars: 5,
      perMessageTailChars: 5,
      packetBudgetChars: 80,
    });
    expect(view.truncated).toBe(true);
    expect(view.content).toContain("aaaaa");
    expect(view.content).toContain("bbbbb");
    expect(view.content).toContain("truncated");
  });

  test("preserves attachment descriptors only", () => {
    const view = buildRoutingView("see attached", {
      attachments: [{ id: "att-1", filename: "report.pdf", decision: "accept", kind: "pdf" }],
    });
    expect(view.attachments).toEqual([
      { id: "att-1", filename: "report.pdf", decision: "accept", kind: "pdf" },
    ]);
  });
});
