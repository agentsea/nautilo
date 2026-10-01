import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { createProtectedTaskTranscriptPort } from "../../src/tasks/protected-task-transcript-port";

const identity = Object.freeze({
  taskId: "task-1",
  taskRunId: "run-1",
  graphThreadId: "thread-1",
  roomId: "room-1",
  humanTurnId: "turn-1",
  agentId: "agent-1",
});

async function expectRejection(work: Promise<void>, message: string): Promise<void> {
  let rejected = false;
  try {
    await work;
  } catch (error) {
    rejected = true;
    expect(String(error)).toContain(message);
  }
  expect(rejected).toBe(true);
}

describe("protected Task transcript port", () => {
  test("publishes exact Agent payloads in order with stable retry identities", async () => {
    const calls: Array<{ key: string; role: string; content: string }> = [];
    const port = createProtectedTaskTranscriptPort({
      identity,
      signal: new AbortController().signal,
      publish: async ({ idempotencyKey, payload }) => {
        calls.push({ key: idempotencyKey, role: payload.role, content: payload.content });
      },
    });
    const messages = [
      new AIMessage({ content: "working" }),
      new ToolMessage({ content: "private output", tool_call_id: "call-1" }),
    ];
    await port.publishBatch({ ...identity, messages });
    const first = [...calls];
    await port.publishBatch({ ...identity, messages });
    expect(calls.slice(0, 2)).toEqual(first);
    expect(calls.slice(2)).toEqual(first);
    expect(first.map((call) => call.role)).toEqual(["assistant", "tool"]);
    expect(first.map((call) => call.content)).toEqual(["working", "private output"]);
    expect(first.every((call) => call.key.startsWith("task-transcript:run-1:fp:v1:"))).toBe(true);
  });

  test("refuses a different segment and Human messages before publication", async () => {
    let publications = 0;
    const port = createProtectedTaskTranscriptPort({
      identity,
      signal: new AbortController().signal,
      publish: async () => { publications += 1; },
    });
    await expectRejection(port.publishBatch({
      ...identity, taskRunId: "run-2", messages: [new AIMessage("secret")],
    }), "identity changed");
    await expectRejection(port.publishBatch({
      ...identity, messages: [new HumanMessage("secret")],
    }), "Human messages require coordinate-first");
    expect(publications).toBe(0);
  });

  test("does not advance a failed batch and refuses publication after abort", async () => {
    const controller = new AbortController();
    const attempts: string[] = [];
    let failOnce = true;
    const port = createProtectedTaskTranscriptPort({
      identity,
      signal: controller.signal,
      publish: async ({ idempotencyKey }) => {
        attempts.push(idempotencyKey);
        if (failOnce && attempts.length === 2) {
          failOnce = false;
          throw new Error("publish failed");
        }
      },
    });
    const batch = {
      ...identity,
      messages: [new AIMessage("first"), new AIMessage("second")],
    };
    await expectRejection(port.publishBatch(batch), "publish failed");
    await port.publishBatch(batch);
    expect(attempts).toEqual([attempts[0]!, attempts[1]!, attempts[0]!, attempts[1]!]);
    controller.abort();
    await expectRejection(port.publishBatch(batch), "aborted");
    expect(attempts).toHaveLength(4);
  });
});
