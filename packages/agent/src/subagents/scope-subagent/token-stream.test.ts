import { describe, expect, test } from "bun:test";
import type { MessageTokensEvent } from "@nautilo/types";
import {
  ScopeSubagentTokenStream,
  scopeSubagentVisibleToken,
} from "./token-stream";

describe("ScopeSubagentTokenStream", () => {
  test("streams a task reply on the explicit room and returns its reconciliation key", () => {
    const events: MessageTokensEvent[] = [];
    const stream = new ScopeSubagentTokenStream({
      laneKey: "room:room-1",
      authorAgentId: "agent-nova",
      turnId: "task-run-1",
      emit: (event) => events.push(event),
      maxChars: 1,
    });

    stream.noteStreamEvent({
      event: "on_chat_model_stream",
      data: { chunk: { content: "Hello" } },
    });
    const assistantMessageKey = stream.completeMessage();

    expect(assistantMessageKey).toBe("assistant:task-run-1:0");
    expect(events).toEqual([
      {
        type: "message.tokens",
        laneKey: "room:room-1",
        content: "Hello",
        chunkSequence: 1,
        done: false,
        authorAgentId: "agent-nova",
        turnId: "task-run-1",
        assistantMessageKey: "assistant:task-run-1:0",
      },
      {
        type: "message.tokens",
        laneKey: "room:room-1",
        content: "",
        chunkSequence: 2,
        done: true,
        authorAgentId: "agent-nova",
        turnId: "task-run-1",
        assistantMessageKey: "assistant:task-run-1:0",
      },
    ]);
  });

  test("assigns a distinct key and fresh sequence to each assistant message", () => {
    const events: MessageTokensEvent[] = [];
    const stream = new ScopeSubagentTokenStream({
      laneKey: "room:room-1",
      authorAgentId: "agent-nova",
      turnId: "task-run-1",
      emit: (event) => events.push(event),
    });

    for (const content of ["First", "Second"]) {
      stream.noteStreamEvent({
        event: "on_chat_model_stream",
        data: { chunk: { content } },
      });
      stream.completeMessage();
    }

    expect(events.map((event) => event.assistantMessageKey)).toEqual([
      "assistant:task-run-1:0",
      "assistant:task-run-1:1",
    ]);
    expect(events.map((event) => event.chunkSequence)).toEqual([1, 1]);
    expect(events.every((event) => event.done)).toBe(true);
  });
});

describe("scopeSubagentVisibleToken", () => {
  test("keeps visible multimodal text and suppresses reasoning blocks", () => {
    expect(scopeSubagentVisibleToken({
      event: "on_chat_model_stream",
      data: {
        chunk: {
          content: [
            { type: "reasoning", text: "private chain" },
            { type: "text", text: "Visible answer" },
          ],
        },
      },
    })).toBe("Visible answer");
  });

  test("ignores unrelated graph events", () => {
    expect(scopeSubagentVisibleToken({
      event: "on_chain_end",
      data: { chunk: { content: "not a token" } },
    })).toBe("");
  });
});
