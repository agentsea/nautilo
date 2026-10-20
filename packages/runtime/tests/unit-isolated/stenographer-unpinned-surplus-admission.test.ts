import { afterAll, expect, mock, test } from "bun:test";
import * as agent from "@nautilo/agent";

const invoke = mock(async (..._args: unknown[]) => ({
  response: { content: "memory result" },
  modelUsed: "openrouter:minimax/minimax-m3",
}));

mock.module("@nautilo/agent", () => ({
  ...agent,
  invokeChatModelWithFallback: invoke,
  runWithUsageContext: async (_context: unknown, run: () => Promise<unknown>) => run(),
}));

const { createRoomSideModelInvoker } = await import("../../src/stenographer/model-invoker");

afterAll(() => mock.restore());

test("room-side invoker forwards only an explicit unpinned Surplus admission", async () => {
  const admitted = createRoomSideModelInvoker({
    modelId: "openrouter:minimax/minimax-m3",
    roomId: "room-1",
    laneKey: "room:room-1:extraction",
    callType: "room_stenographer",
    operationId: "batch-1",
    allowUnpinnedSurplusRetry: true,
  });
  const pinned = createRoomSideModelInvoker({
    modelId: "openrouter:minimax/minimax-m3",
    roomId: "room-1",
    laneKey: "room:room-1:extraction",
    callType: "room_stenographer",
    operationId: "batch-2",
  });

  expect(await admitted("summarize")).toBe("memory result");
  expect(await pinned("summarize")).toBe("memory result");
  expect(invoke.mock.calls[0]?.[7]).toMatchObject({
    serverFundedService: "shared_memory_maintenance",
    allowUnpinnedSurplusRetry: true,
  });
  expect(invoke.mock.calls[1]?.[7]).not.toHaveProperty("allowUnpinnedSurplusRetry");
});
