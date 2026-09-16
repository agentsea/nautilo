import { describe, expect, test } from "bun:test";
import type { TaskRunTranscriptMessage } from "@nautilo/types";
import { stepLineFor, taskRunToVMs } from "../transcript-vm";

describe("subagent transcript tool argument projection", () => {
  test("removes credentials before persisted tool calls reach L1 or ToolCard inputs", () => {
    const sessionSecret = "subagent-session-secret";
    const nestedSecret = "subagent-nested-secret";
    const messages: TaskRunTranscriptMessage[] = [{
      role: "assistant",
      content: "",
      createdAt: "2026-08-12T00:00:00.000Z",
      toolCalls: [{
        id: "inspect-1",
        name: "inspect_open_design",
        args: {
          sessionToken: sessionSecret,
          cursor: "page:2",
          nested: { api_key: nestedSecret, intent: "inspect" },
        },
      }],
    }];

    const projected = taskRunToVMs(messages);
    expect(projected[0]?.args).toEqual({
      nested: { intent: "inspect" },
    });
    expect(stepLineFor(projected[0]!)).not.toContain(sessionSecret);
    expect(JSON.stringify(projected)).not.toContain(sessionSecret);
    expect(JSON.stringify(projected)).not.toContain(nestedSecret);
    expect(messages[0]?.toolCalls?.[0]?.args).toMatchObject({ sessionToken: sessionSecret });
  });
});
