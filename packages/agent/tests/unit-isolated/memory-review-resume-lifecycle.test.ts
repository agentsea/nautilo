import { beforeEach, expect, mock, test } from "bun:test";
import type { StreamEventProcessor } from "../../src/graph/resume-approval";
let streamFails = false;
let preparationFails = false;
let streamCalls = 0;
let preparationOrder: string[] = [];
const checkpoint = { values: { turnId: "original-turn", messages: [] }, tasks: [] };
mock.module("../../src/agent/graph", () => ({ createNautiloGraph: () => ({
  getState: async () => checkpoint,
  async *streamEvents() { streamCalls += 1; yield {}; if (streamFails) throw new Error("resume_failed"); },
}) }));
mock.module("../../src/checkpoints/checkpoint-saver", () => ({ createCheckpointSaver: () => ({}) }));
mock.module("../../src/graph/protected-memory-resume-deps", () => ({
  identityEnrollmentToolCallIds: () => [],
  bindProtectedMemoryResumeDeps: (deps: unknown) => ({
    deps,
    restoreCheckpoint: async () => {
      preparationOrder.push("restore");
      if (preparationFails) throw new Error("projection_restore_failed");
    },
    bindCheckpoint: () => { preparationOrder.push("bind"); },
  }),
}));
const { resumeGraphWithApproval } = await import("../../src/graph/resume-approval");
const { resumeGraphWithAskReply } = await import("../../src/graph/resume-approval-ask");
const { resumeGraphWithIdentity } = await import("../../src/graph/resume-identity");
const { resumeGraphWithHostChoice } = await import("../../src/graph/resume-host-choice");
const { resumeGraphWithConnectedWebAction } = await import("../../src/graph/resume-connected-web-action");
const { resumeGraphWithHumanReply } = await import("../../src/graph/resume-human-reply");
const paths: Array<[string, (processor: StreamEventProcessor) => Promise<unknown>]> = [
  ["approval", p => resumeGraphWithApproval("fork", true, p)],
  ["ask", p => resumeGraphWithAskReply("fork", "once", p)],
  ["identity", p => resumeGraphWithIdentity("fork", { memoryAccess: {} } as never, "agent", p)],
  ["host", p => resumeGraphWithHostChoice("fork", { choiceId: "choice", selector: "host" }, p)],
  ["connected web", p => resumeGraphWithConnectedWebAction("fork", { toolCallId: "tool", decision: "done" }, {} as never, "user", p)],
  ["Human reply", p => resumeGraphWithHumanReply("fork", "answer", "user", p)],
];
beforeEach(() => { streamFails = false; preparationFails = false; streamCalls = 0; preparationOrder = []; });
for (const [name, resume] of paths) {
  test(`${name} reconnects original turn and waits for persisted events before completion`, async () => {
    const order: string[] = [];
    await resume({
      async beginResume(thread, turn) { expect([thread, turn]).toEqual(["fork", "original-turn"]); order.push("begin"); },
      async process() { await Promise.resolve(); order.push("persisted"); },
      async finishResume(state) { expect(state).toEqual(checkpoint); order.push("completed"); },
      flush() {},
    });
    expect(order).toEqual(["begin", "persisted", "completed"]);
  });
  test(`${name} records interruption on stream failure`, async () => {
    streamFails = true;
    const failed = mock(async () => {});
    const finished = mock(async () => {});
    expect(resume({ process() {}, flush() {}, failResume: failed, finishResume: finished })).rejects.toThrow("resume_failed");
    expect(failed).toHaveBeenCalledTimes(1);
    expect(finished).not.toHaveBeenCalled();
  });
}

const protectedPaths: Array<[string, (processor: StreamEventProcessor, denied?: boolean) => Promise<void>]> = [
  ["approval", (processor, denied) => resumeGraphWithApproval(
    "fork", !denied, processor, undefined, undefined, undefined, undefined, {},
  )],
  ["ask", (processor, denied) => {
    const args: Parameters<typeof resumeGraphWithAskReply> = ["fork", denied ? "deny" : "once", processor];
    args[16] = {};
    return resumeGraphWithAskReply(...args);
  }],
];
for (const [name, resume] of protectedPaths) {
  test(`${name} records interruption when protected preparation fails before streaming`, async () => {
    preparationFails = true;
    const failure = await resume({
      async beginResume(thread, turn) {
        expect([thread, turn]).toEqual(["fork", "original-turn"]);
        preparationOrder.push("begin");
      },
      async failResume() { preparationOrder.push("fail"); },
      async finishResume() { preparationOrder.push("finish"); },
      process() { preparationOrder.push("stream"); },
      flush() {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("projection_restore_failed");
    expect(preparationOrder).toEqual(["begin", "restore", "fail"]);
    expect(streamCalls).toBe(0);
  });
  test(`${name} denial binds the checkpoint without restoring a stale projection`, async () => {
    preparationFails = true;
    await resume({
      async beginResume() { preparationOrder.push("begin"); },
      async failResume() { preparationOrder.push("fail"); },
      async finishResume() { preparationOrder.push("finish"); },
      process() { preparationOrder.push("stream"); },
      flush() {},
    }, true);
    expect(preparationOrder).toEqual(["begin", "bind", "stream", "finish"]);
    expect(streamCalls).toBe(1);
  });
}
