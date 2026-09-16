import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { projectAccountInfo, projectClaudeExecutionMessage, projectSupportedModels } from "../../src/index";

describe("Claude Agent SDK projector", () => {
  test("projects root assistant message boundaries without exposing message content", () => {
    expect(projectClaudeExecutionMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "private" }] } },
    })).toEqual([{ kind: "output_message_started" }]);
    expect(projectClaudeExecutionMessage({
      type: "stream_event",
      parent_tool_use_id: "child",
      event: { type: "message_start", message: { role: "assistant", content: [] } },
    })).toEqual([]);
  });

  test("preserves bounded discovery account and catalog facts", () => {
    expect(projectAccountInfo({
      email: "writer@example.test",
      organization: "Nautilo",
      subscriptionType: "max",
      tokenSource: "oauth",
      apiKeySource: "none",
      apiProvider: "firstParty",
    })).toEqual({
      state: "connected",
      email: "writer@example.test",
      organization: "Nautilo",
      subscriptionType: "max",
      tokenSource: "oauth",
      apiKeySource: "none",
      apiProvider: "firstParty",
    });
    const models = Array.from({ length: 13 }, (_, index) => ({
      value: `claude-${index}`,
      displayName: "Fable",
      description: "Frontier",
    }));
    expect(projectSupportedModels(models as never)).toHaveLength(13);
  });

  test("projects setup/root tool activity and no assistant prose or tool input", () => {
    expect(projectClaudeExecutionMessage({ type: "system", subtype: "hook_started" } as unknown as SDKMessage)).toEqual([
      { kind: "activity", activity: "hook", state: "started" },
    ]);
    const observations = projectClaudeExecutionMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "private" }, { type: "tool_use", name: "Read", input: { path: "/secret" } }] },
    } as unknown as SDKMessage);
    expect(observations).toEqual([{ kind: "activity", activity: "tool", state: "requested", toolName: "Read" }]);
    expect(JSON.stringify(observations)).not.toContain("private");
    expect(projectClaudeExecutionMessage({
      type: "assistant",
      parent_tool_use_id: "child",
      message: { content: [{ type: "tool_use", name: "Read" }] },
    } as unknown as SDKMessage)).toEqual([]);
  });

  test("accepts observed aliases and classifies only official result facts", () => {
    expect(projectClaudeExecutionMessage({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-alias",
      claude_code_version: "2.1.235",
    } as unknown as SDKMessage)).toEqual([
      { kind: "initialized", model: "claude-sonnet-alias", claudeCodeVersion: "2.1.235" },
    ]);
    expect(projectClaudeExecutionMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "finished",
      terminal_reason: null,
    } as unknown as SDKMessage)).toEqual([{ kind: "result", outcome: "succeeded", candidate: "finished" }]);
    expect(projectClaudeExecutionMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Created the requested file.\n\nIt is ready.",
      terminal_reason: null,
    } as unknown as SDKMessage)).toEqual([{
      kind: "result", outcome: "succeeded", candidate: "Created the requested file.\n\nIt is ready.",
    }]);
    expect(projectClaudeExecutionMessage({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_tools",
      error: "private diagnostic",
    } as unknown as SDKMessage)).toEqual([{ kind: "result", outcome: "interrupted" }]);
  });

  test("projects only root text partials and keeps provider fields out of the preview", () => {
    expect(projectClaudeExecutionMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello\nworld" } },
      uuid: "private-uuid",
      session_id: "private-session",
    } as unknown as SDKMessage)).toEqual([{ kind: "output_delta", text: "Hello\nworld" }]);
    expect(projectClaudeExecutionMessage({
      type: "stream_event",
      parent_tool_use_id: "subagent",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "private child" } },
    } as unknown as SDKMessage)).toEqual([]);
    expect(projectClaudeExecutionMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"path\":\"/private\"}" } },
    } as unknown as SDKMessage)).toEqual([]);
    const projected = projectClaudeExecutionMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(48 * 1024 + 1) } },
    } as unknown as SDKMessage);
    expect(projected).toBeNull();
    expect(projectClaudeExecutionMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "private\u0001" } },
    } as unknown as SDKMessage)).toBeNull();
    expect(JSON.stringify(projected)).not.toContain("private");
  });

  test("fails closed on accessors and malformed candidate data without imposing a result ceiling", () => {
    const hostile: unknown = Object.create(null, {
      type: { enumerable: true, value: "result" },
      subtype: { enumerable: true, value: "success" },
      is_error: { enumerable: true, value: false },
      result: { enumerable: true, get: () => { throw new Error("getter"); } },
    });
    expect(projectClaudeExecutionMessage(hostile)).toBeNull();
    expect(projectClaudeExecutionMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "\ud800",
      terminal_reason: null,
    } as unknown as SDKMessage)).toBeNull();
    expect(projectClaudeExecutionMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "finished\0private",
      terminal_reason: null,
    } as unknown as SDKMessage)).toBeNull();
    expect(projectClaudeExecutionMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "x".repeat(64 * 1024 + 1),
      terminal_reason: null,
    } as unknown as SDKMessage)).toEqual([{
      kind: "result", outcome: "succeeded", candidate: "x".repeat(64 * 1024 + 1),
    }]);
  });
});
