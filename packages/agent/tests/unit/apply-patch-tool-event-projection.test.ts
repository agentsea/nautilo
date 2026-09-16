import { describe, expect, test } from "bun:test";

import { AgentToolCallTracker } from "../../src/runtime-hooks";

const result = JSON.stringify({
  status: "applied",
  partial: false,
  runtimeVersion: "apply-patch-1",
  turnId: "turn-448",
  operationCounts: { add: 0, update: 30, move: 0, delete: 0 },
  pathResults: Array.from({ length: 30 }, (_, index) => ({
    operation: "update",
    path: `src/${index}.ts`,
    status: "applied",
    revisionId: `rev-${index}`,
  })),
  changedFiles: Array.from({ length: 30 }, (_, index) => ({
    operation: "update",
    path: `src/${index}.ts`,
    status: "applied",
    revisionId: `rev-${index}`,
  })),
  revisionIds: Array.from({ length: 30 }, (_, index) => `rev-${index}`),
  unifiedDiff: Array.from({ length: 30 }, (_, index) => `diff --git a/${index} b/${index}\n+${"x".repeat(500)}\n`).join(""),
});

type Projection = {
  eventProjection: {
    kind: string;
    totalPaths: number;
    shownPaths: number;
    totalChangedFiles: number;
    shownChangedFiles: number;
    totalDiffChars: number;
    shownDiffChars: number;
    truncated: boolean;
  };
};

describe("D448 apply_patch tool lifecycle event projection", () => {
  test("keeps the model result authoritative while emitting a JSON-safe event view", () => {
    const tracker = new AgentToolCallTracker("room-1", "agent-1", "turn-448");
    tracker.toolStart("call-1", "apply_patch");
    const event = tracker.toolEnd("call-1", "apply_patch", "success", undefined, result);
    expect(event.resultTruncated).toBe(true);
    expect(event.result).not.toBe(result);
    const projected = JSON.parse(event.result!) as unknown as Projection;
    expect(projected.eventProjection.kind).toBe("apply_patch");
    expect(projected.eventProjection.totalPaths).toBe(30);
    expect(projected.eventProjection.shownPaths).toBeGreaterThan(0);
    expect(projected.eventProjection.totalChangedFiles).toBe(30);
    expect(projected.eventProjection.shownChangedFiles).toBeGreaterThan(0);
    expect(projected.eventProjection.totalDiffChars).toBeGreaterThan(0);
    expect(projected.eventProjection.shownDiffChars).toBeGreaterThan(0);
    expect(projected.eventProjection.truncated).toBe(true);
    expect(result).toContain("src/0.ts");
  });
});
