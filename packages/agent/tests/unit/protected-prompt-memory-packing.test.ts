import { expect, test } from "bun:test";

import { matchesPromptBriefMemoryStructuralSelection,
  packOpenedPromptBriefMemories } from "../../src/store/memory-store";

test("ordinary prompt loading rejects a concurrently changed content revision", () => {
  const selected = { representation: "structural" as const, id: "memory-1",
    contentRevision: 4, type: null, importance: 0.8, tier: 1 as const,
    createdAt: new Date("2026-01-01T00:00:00.000Z") };
  expect(matchesPromptBriefMemoryStructuralSelection(selected, {
    ...selected, contentRevision: 5,
  })).toBe(false);
});

test("protected prompt packing scans beyond one physical page after an oversized candidate", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const rows = [
    {
      id: "oversized",
      type: "fact",
      content: "x".repeat(8_100),
      importance: 1,
      tier: 1,
      createdAt,
    },
    ...Array.from({ length: 64 }, (_, index) => ({
      id: `small-${index.toString().padStart(2, "0")}`,
      type: "fact",
      content: `small ${index}`,
      importance: 0.9,
      tier: 1,
      createdAt,
    })),
  ];

  const packed = packOpenedPromptBriefMemories(rows);
  expect(packed.overflowIds).toContain("oversized");
  expect(packed.memories.map((memory) => memory.id)).toContain("small-63");
});
