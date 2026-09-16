/**
 * D307 — task.progress stream-tap on scope-subagent runs. Lives in
 * unit-isolated because it mocks createNautiloGraph (process-global mock.module).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { NoProgressError } from "../../src/graph/no-progress";
import type { ServerEvent } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { setAgentEventSink } from "../../src/runtime-hooks";

const captured: ServerEvent[] = [];
let includeAssistantStream = false;
let insertAssistantRow = false;
let terminalReceipt: ToolMessage | null = null;
const persisted: Array<{ threadId: string; ownerId: string; messages: BaseMessage[]; meta: Record<string, unknown> }> = [];

const subEnvelope: MemoryAccessEnvelope = {
  memoryMode: "namespace",
  ownerId: "owner-1",
  actorId: "actor-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: ["n1"],
  mutableNamespaces: ["n1"],
  writableNamespaces: ["n1"],
  toolPolicy: {},
};

let runScopeSubagentUntilPause: (
  opts: import("../../src/subagents/scope-subagent/run").RunScopeSubagentOpts,
) => Promise<import("../../src/subagents/scope-subagent/run").RunScopeSubagentResult>;

beforeAll(async () => {
  mock.module("../../src/checkpoints/checkpoint-saver", () => ({
    createCheckpointSaver: () => ({}),
  }));
  mock.module("../../src/agent/post-model-deps", () => ({
    defaultPostModelDeps: {},
  }));
  mock.module("../../src/store/session-store", () => ({
    SUBAGENT_GRAPH_THREAD_PREFIX: "subagent:",
    appendTranscriptMessages: async (threadId: string, ownerId: string, _role: string, messages: BaseMessage[], meta: Record<string, unknown>) => {
      persisted.push({ threadId, ownerId, messages, meta });
      return {
      insertedRows: insertAssistantRow
        ? [{
            id: "message-1",
            role: "assistant",
            content: "Streamed answer",
            fingerprint: "fp-1",
            replyToMessageId: null,
          }]
        : [],
      };
    },
  }));
  mock.module("../../src/agent/graph", () => ({
    createNautiloGraph: () => ({
      streamEvents: async function* () {
        if (terminalReceipt) {
          const call = new AIMessage({ content: "", tool_calls: [{ id: terminalReceipt.tool_call_id, name: "security_scan", args: { operation: "results", finalize: true } }] });
          yield { event: "on_chain_end", name: "tools", data: { input: { messages: [call] }, output: { messages: [call, terminalReceipt] } } };
          throw new NoProgressError({ toolName: "security_scan", operationDiscriminator: "results", normalizedError: "research_incomplete" });
        }
        yield {
          event: "on_tool_start",
          name: "run_shell",
          data: { input: { command: 'rg "retry"' } },
        };
        yield {
          event: "on_tool_start",
          name: "grep_files",
          data: { input: { pattern: "TODO" } },
        };
        yield {
          event: "on_tool_start",
          name: "read_file",
          data: { input: { path: "/tmp/x" } },
        };
        if (includeAssistantStream) {
          yield {
            event: "on_chat_model_stream",
            data: { chunk: { content: "Streamed answer" } },
          };
          yield {
            event: "on_chain_end",
            name: "agent",
            data: {
              input: { messages: [] },
              output: { messages: [new AIMessage("Streamed answer")] },
            },
          };
        }
      },
      getState: async () => ({
        values: { messages: [new AIMessage("done")] },
        tasks: [],
      }),
    }),
  }));

  ({ runScopeSubagentUntilPause } = await import("../../src/subagents/scope-subagent/run"));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  captured.length = 0;
  includeAssistantStream = false;
  insertAssistantRow = false;
  terminalReceipt = null;
  persisted.length = 0;
  setAgentEventSink({ emit: (e) => captured.push(e) });
});

describe("D307 — task.progress stream tap (PR3)", () => {
  test("terminal no-progress propagates only after its exact receipt is persisted to the same scoped transcript", async () => {
    const content = JSON.stringify({ ok: false, error: { code: "research_incomplete", continuation: "Review unit unit_http: repair the exact section link." } });
    terminalReceipt = new ToolMessage({ content, name: "security_scan", tool_call_id: "terminal-results",
      additional_kwargs: { nautilo_tool_status: "error", fixture_protected_receipt: true } });
    const failure = await runScopeSubagentUntilPause({ parentThreadId: "parent-thread", parentTurnId: "turn-terminal",
      parentOwnerId: "owner-1", transcriptOwnerId: "transcript-owner", subagentThreadId: "subagent:terminal", scopeId: "private-scope",
      brief: "audit", subEnvelope, actorRole: "owner", assistantName: "Genie", soulFile: "", modelId: "anthropic:claude-sonnet-4-6",
      currentFolder: "/tmp", workspacePath: "/tmp", subagentDepth: 1, subagentMaxDepth: 5, securityAuditClientMeta: null,
      roomRoster: [], roomId: "00000000-0000-0000-0000-000000000101",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NoProgressError);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ threadId: "subagent:terminal", ownerId: "transcript-owner",
      meta: { scopeId: "private-scope", parentThreadId: "parent-thread", roomId: "00000000-0000-0000-0000-000000000101" } });
    expect(persisted[0]?.messages).toHaveLength(1);
    expect(persisted[0]?.messages[0]?.content).toBe(content);
    expect(persisted[0]?.messages[0]?.additional_kwargs["fixture_protected_receipt"]).toBe(true);
    expect((failure as NoProgressError).message).toBe("no_progress");
  });

  test("task run with progress ids emits coalesced task.progress", async () => {
    await runScopeSubagentUntilPause({
      parentThreadId: "parent-thread",
      parentTurnId: "turn-1",
      parentOwnerId: "owner-1",
      brief: "audit",
      subEnvelope,
      actorRole: "owner",
      assistantName: "Genie",
      soulFile: "",
      modelId: "anthropic:claude-sonnet-4-6",
      currentFolder: "/tmp",
      workspacePath: "/tmp",
      subagentDepth: 1,
      subagentMaxDepth: 5,
      securityAuditClientMeta: null,
      roomRoster: [],
      roomId: "00000000-0000-0000-0000-000000000101",
      progressTaskId: "task-1",
      progressTaskRunId: "run-1",
      progressOwnerId: "owner-1",
    });

    const progress = captured.filter((e) => e.type === "task.progress");
    expect(progress.length).toBe(2);
    expect(progress[0]).toMatchObject({
      type: "task.progress",
      taskId: "task-1",
      taskRunId: "run-1",
      ownerId: "owner-1",
    });
    expect(progress[0]!.detail).toContain("run_shell");
    expect(progress[1]!.detail).toContain("read_file");
  });

  test("no progress ids — M084 in-chat runs do not emit task.progress", async () => {
    await runScopeSubagentUntilPause({
      parentThreadId: "parent-thread",
      parentTurnId: "turn-1",
      parentOwnerId: "owner-1",
      brief: "audit",
      subEnvelope,
      actorRole: "owner",
      assistantName: "Genie",
      soulFile: "",
      modelId: "anthropic:claude-sonnet-4-6",
      currentFolder: "/tmp",
      workspacePath: "/tmp",
      subagentDepth: 1,
      subagentMaxDepth: 5,
      securityAuditClientMeta: null,
      roomRoster: [],
      roomId: "00000000-0000-0000-0000-000000000101",
    });

    expect(captured.some((e) => e.type === "task.progress")).toBe(false);
  });

  test("no tool.* or token events leak on the parent room lane", async () => {
    includeAssistantStream = true;
    await runScopeSubagentUntilPause({
      parentThreadId: "parent-thread",
      parentTurnId: "turn-1",
      parentOwnerId: "owner-1",
      brief: "audit",
      subEnvelope,
      actorRole: "owner",
      assistantName: "Genie",
      soulFile: "",
      modelId: "anthropic:claude-sonnet-4-6",
      currentFolder: "/tmp",
      workspacePath: "/tmp",
      subagentDepth: 1,
      subagentMaxDepth: 5,
      securityAuditClientMeta: null,
      roomRoster: [],
      roomId: "00000000-0000-0000-0000-000000000101",
      progressTaskId: "task-1",
      progressTaskRunId: "run-1",
      progressOwnerId: "owner-1",
    });

    expect(captured.some((e) => e.type === "tool.start" || e.type === "tool.end")).toBe(
      false,
    );
    expect(captured.some((e) => e.type === "message.tokens")).toBe(false);
    expect(captured.some((e) => e.type === "message.new")).toBe(false);
  });

  test("background Task prose streams on its Room lane and reconciles the durable row", async () => {
    includeAssistantStream = true;
    insertAssistantRow = true;
    await runScopeSubagentUntilPause({
      parentThreadId: "parent-thread",
      parentTurnId: "run-1",
      parentOwnerId: "owner-1",
      brief: "audit",
      subEnvelope,
      actorRole: "owner",
      assistantName: "Genie",
      soulFile: "",
      modelId: "anthropic:claude-sonnet-4-6",
      currentFolder: "/tmp",
      workspacePath: "/tmp",
      subagentDepth: 1,
      subagentMaxDepth: 5,
      securityAuditClientMeta: null,
      roomRoster: [],
      roomId: "00000000-0000-0000-0000-000000000101",
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
    });

    const tokens = captured.filter((event) => event.type === "message.tokens");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      laneKey: "room:00000000-0000-0000-0000-000000000101",
      content: "Streamed answer",
      done: true,
      authorAgentId: "agent-1",
      turnId: "run-1",
      assistantMessageKey: "assistant:run-1:0",
    });

    const durable = captured.find((event) => event.type === "message.new");
    expect(durable).toMatchObject({
      laneKey: "room:00000000-0000-0000-0000-000000000101",
      messageId: "message-1",
      content: "Streamed answer",
      authorAgentId: "agent-1",
      assistantMessageKey: "assistant:run-1:0",
    });
  });
});

test("persisted tool activity follows explicit native or legacy errors without classifying successful content", async () => {
  const cases = [
    { status: "error" as const, additional_kwargs: {}, content: "Context recovery is active. Finalization has not executed.", expected: "error" },
    { additional_kwargs: { nautilo_tool_status: "error" }, content: "Legacy pre-execution denial", expected: "error" },
    { status: "success" as const, additional_kwargs: { nautilo_tool_status: "success" }, content: "Error: successfully retrieved source text", expected: "success" },
    { additional_kwargs: {}, content: "Unmarked legacy result", expected: "success" },
  ];
  for (const [index, value] of cases.entries()) {
    captured.length = 0;
    persisted.length = 0;
    terminalReceipt = new ToolMessage({ tool_call_id: `receipt-${index}`, name: "security_scan", ...value });
    const outcome = await runScopeSubagentUntilPause({ parentThreadId: "parent-thread", parentTurnId: `turn-${index}`,
      parentOwnerId: "owner-1", transcriptOwnerId: "transcript-owner", subagentThreadId: `subagent:status-${index}`,
      brief: "audit", subEnvelope, actorRole: "owner", assistantName: "Genie", soulFile: "", modelId: "anthropic:claude-sonnet-4-6",
      currentFolder: "/tmp", workspacePath: "/tmp", subagentDepth: 1, subagentMaxDepth: 5, securityAuditClientMeta: null,
      roomRoster: [], roomId: "00000000-0000-0000-0000-000000000101",
    }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(NoProgressError);
    const ends = captured.filter((event) => event.type === "tool.end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ toolCallId: `receipt-${index}`, toolName: "security_scan", status: value.expected, result: value.content });
    expect(persisted[0]?.messages[0]).toBe(terminalReceipt);
  }
});
