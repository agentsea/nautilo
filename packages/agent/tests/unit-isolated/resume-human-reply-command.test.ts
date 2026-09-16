/**
 * M169 (R4) — lock the `await_human_reply` resume invariant.
 *
 * `resumeGraphWithHumanReply` (M151) must resume the parked checkpoint with a
 * `Command({ resume: { reply, fromUserId } })` — it injects the human reply
 * into the live checkpoint and NEVER rebuilds a `messages` array from
 * transcript/checkpoint history. This test asserts the value handed to
 * `graph.streamEvents(...)` is a `Command`, so a future rebuild-from-transcript
 * rewrite (explicitly rejected — spec decision 10.2.3, ISSUE-M169 §7) fails here.
 *
 * Lives in unit-isolated because it mocks `createNautiloGraph` process-globally.
 * No server / DB / API keys.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

let capturedResumeInput: unknown;

let resumeGraphWithHumanReply: typeof import(
  "../../src/graph/resume-human-reply"
)["resumeGraphWithHumanReply"];

beforeAll(async () => {
  mock.module("../../src/checkpoints/checkpoint-saver", () => ({
    createCheckpointSaver: () => ({}),
  }));
  mock.module("../../src/agent/post-model-deps", () => ({
    defaultPostModelDeps: {},
  }));
  mock.module("../../src/store/session-store", () => ({
    SUBAGENT_GRAPH_THREAD_PREFIX: "subagent:",
    appendTranscriptMessages: async () => ({ insertedRows: [] }),
  }));
  mock.module("../../src/agent/graph", () => ({
    createNautiloGraph: () => ({
      streamEvents: async function* (input: unknown) {
        capturedResumeInput = input;
        // A single inert event so the resume drains immediately; the post-run
        // getState (no pending interrupt) drives a non-reparked completion.
        yield { event: "noop" };
      },
      getState: async () => ({
        values: { messages: [new AIMessage("here is your answer")] },
        tasks: [],
      }),
    }),
  }));

  ({ resumeGraphWithHumanReply } = await import("../../src/graph/resume-human-reply"));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  capturedResumeInput = undefined;
});

describe("resumeGraphWithHumanReply stream-entry invariant (M169 R4)", () => {
  test("streams a Command into the parked thread, never a rebuilt messages array", async () => {
    const processor = { process() {}, flush() {} };

    const result = await resumeGraphWithHumanReply(
      "subagent:parent:await-1",
      "yes, proceed with option B",
      "user-2",
      processor,
    );

    expect(capturedResumeInput instanceof Command).toBe(true);
    expect((capturedResumeInput as { messages?: unknown }).messages).toBeUndefined();
    // The resume completed (no chained interrupt) and surfaced final text.
    expect(result.reparked).toBe(false);
    expect(result.finalText).toContain("here is your answer");
  });
});
