import { expect, test } from "bun:test";

import { stageProtectedPromptMemoryBrief } from
  "../../src/conversation/protected-prompt-memory-staging";

const createdAt = new Date("2026-01-01T00:00:00.000Z");

test("pages beyond an oversized Memory and retains only packed bodies", async () => {
  let loads = 0;
  let opens = 0;
  const result = await stageProtectedPromptMemoryBrief({
    loadPage: async (cursor) => {
      loads += 1;
      if (cursor === undefined) return {
        memories: Array.from({ length: 64 }, (_, index) => ({
          representation: "structural" as const,
          id: index === 0 ? "oversized" : `first-${index}`,
          contentRevision: 1,
          type: null,
          importance: 1,
          tier: 1 as const,
          createdAt,
        })),
        nextCursor: { importance: 1, createdAt, id: "first-63" },
      };
      return {
        memories: [{
          representation: "structural" as const,
          id: "later-small",
          contentRevision: 1,
          type: null,
          importance: 0.5,
          tier: 1 as const,
          createdAt,
        }],
      };
    },
    openPage: async (page) => {
      opens += 1;
      return page.map((memory) => ({
        ...memory,
        type: "authenticated-type",
        content: memory.id === "oversized" ? "x".repeat(8_100) : "small",
      }));
    },
  });
  expect(loads).toBe(2);
  expect(opens).toBe(2);
  expect(result.overflowIds).toContain("oversized");
  expect(result.memories.map((memory) => memory.id)).toContain("later-small");
  expect(result.memories.every((memory) => memory.type === "authenticated-type")).toBe(true);
});

test("cancellation rejects without returning a partial protected prompt", async () => {
  const controller = new AbortController();
  let protectedOpenCalls = 0;
  const failure: unknown = await stageProtectedPromptMemoryBrief({
    signal: controller.signal,
    loadPage: async () => ({
      memories: [{
        representation: "structural" as const,
        id: "one",
        contentRevision: 1,
        type: null,
        importance: 1,
        tier: 1 as const,
        createdAt,
      }],
      nextCursor: { importance: 1, createdAt, id: "one" },
    }),
    openPage: async (page) => {
      protectedOpenCalls += 1;
      controller.abort();
      return page.map((memory) => ({ ...memory, type: "fact", content: "opened" }));
    },
  }).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeDefined();
  expect(protectedOpenCalls).toBe(1);
});
