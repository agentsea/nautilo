import { beforeEach, expect, mock, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
const row = { id: "reservation", threadId: "parent", agentId: "agent", turnId: "original-turn", roomId: "room",
  ownerId: "original-owner", actorId: "original-actor", accessScope: "original-scope", checkpointThreadId: "parent:fork:1" };
let reservation: typeof row | undefined = row;
const lookup = mock(async () => reservation);
const finish = mock(async (_input: unknown) => {});
mock.module("../../src/memory-review/admission", () => ({
  findResumedMemoryReviewAdmission: lookup, finishMemoryReviewTurn: finish,
  memoryReviewCompletionState: (state: { tasks?: Array<{ interrupts?: unknown[] }> } | undefined) =>
    !Array.isArray(state?.tasks) ? "pending" : state.tasks.some(task => task.interrupts?.length) ? "awaiting" : "completed",
}));
const persist = mock(async (..._args: unknown[]) => {});
mock.module("../../src/executors/persist-messages", () => ({ persistMessages: persist, sanitizeMessageForTranscript: (message: unknown) => message }));
mock.module("../../src/executors/langgraph-executor", () => ({ processStreamEvent: () => ({ events: [], messagesToPersist: [new AIMessage("resumed output")] }) }));
const { createPersistingProcessor } = await import("../../src/executors/persisting-processor");
beforeEach(() => { reservation = row; lookup.mockClear(); finish.mockClear(); persist.mockClear(); });
const make = () => createPersistingProcessor({ threadId: "parent", ownerId: "transcript-owner", agentId: "agent", laneKey: "lane", eventBus: { emit() {} } });
test("resumed fork persists the original scope, turn and admitted Room before final coverage", async () => {
  const processor = make();
  await processor.beginResume("parent:fork:1", "original-turn");
  expect(lookup).toHaveBeenCalledWith({ checkpointThreadId: "parent:fork:1", turnId: "original-turn", threadId: "parent", transcriptOwnerId: "transcript-owner", agentId: "agent" });
  await processor.process({});
  expect(persist.mock.calls[0]?.[4]).toMatchObject({ roomId: "room", humanTurnId: "original-turn", memoryReview: {
    ownerId: "original-owner", actorId: "original-actor", accessScope: "original-scope", checkpointThreadId: "parent:fork:1",
  } });
  for (const checkpoint of [{ tasks: [{ interrupts: [{}] }] }, { tasks: [] }, undefined]) await processor.finishResume(checkpoint);
  await processor.failResume();
  expect(finish.mock.calls.map(call => call[0])).toEqual(["pending", "awaiting", "completed", "pending", "interrupted"].map(state => ({
    reviewTurnId: "reservation", threadId: "parent", agentId: "agent", turnId: "original-turn", state,
  })));
});
test("task or legacy resumes without an admitted Memory turn never gain Memory work", async () => {
  reservation = undefined;
  const processor = make();
  await processor.beginResume("task-checkpoint", "task-turn");
  await processor.process({});
  await processor.finishResume({ tasks: [] });
  expect(persist.mock.calls[0]?.[4]).not.toHaveProperty("memoryReview");
  expect(finish).not.toHaveBeenCalled();
});


test("a best-effort transcript append failure cannot advance Memory completion", async () => {
  const processor = make();
  await processor.beginResume("parent:fork:1", "original-turn");
  await processor.process({});
  const options = persist.mock.calls[0]![4] as { eventBus: { emit(event: { type: string }): void } };
  options.eventBus.emit({ type: "session.persistence_failed" });
  await processor.finishResume({ tasks: [{ interrupts: [{}] }] });
  expect(finish.mock.calls.at(-1)?.[0]).toMatchObject({ state: "awaiting" });
  await processor.finishResume(undefined);
  expect(finish.mock.calls.at(-1)?.[0]).toMatchObject({ state: "pending" });
  await processor.finishResume({ tasks: [] });
  expect(finish.mock.calls.at(-1)?.[0]).toMatchObject({ state: "interrupted", reviewTurnId: "reservation" });
  await processor.beginResume("parent:fork:1", "original-turn");
  await processor.finishResume({ tasks: [] });
  expect(finish.mock.calls.at(-1)?.[0]).toMatchObject({ state: "completed" });
});
