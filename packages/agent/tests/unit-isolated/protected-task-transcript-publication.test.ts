import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  EncryptedCheckpointSaver,
  InlineCheckpointCellSerializer,
} from "../../src/checkpoints/encrypted-checkpoint-saver";
import { triggerCheckpointCompactionDouble } from "./support/checkpoint-compaction-double";

let graphCreateCalls = 0;
let ordinaryAppendCalls = 0;
let emittedEvents: unknown[] = [];
let streamEvents: unknown[] = [];
let finalMessages: BaseMessage[] = [];
let finalTasks: Array<Record<string, unknown>> = [];

let runScopeSubagentUntilPause: (
  opts: import("../../src/subagents/scope-subagent/run").RunScopeSubagentOpts,
) => Promise<import("../../src/subagents/scope-subagent/run").RunScopeSubagentResult>;

beforeAll(async () => {
  mock.module("../../src/checkpoints/checkpoint-saver", () => ({
    createCheckpointSaver: () => ({}),
    triggerCheckpointCompaction: triggerCheckpointCompactionDouble,
  }));
  mock.module("../../src/agent/post-model-deps", () => ({
    defaultPostModelDeps: {},
  }));
  mock.module("../../src/store/session-store", () => ({
    SUBAGENT_GRAPH_THREAD_PREFIX: "subagent:",
    appendTranscriptMessages: async () => {
      ordinaryAppendCalls += 1;
      return {
        insertedRows: [{ id: 41, role: "assistant", content: "ordinary body" }],
      };
    },
  }));
  mock.module("../../src/runtime-hooks", () => ({
    AgentToolCallTracker: class {
      toolStart(...args: unknown[]) {
        return { type: "tool.start", args };
      }

      toolEnd(...args: unknown[]) {
        return { type: "tool.end", args };
      }
    },
    emitAgentEvent: (event: unknown) => {
      emittedEvents.push(event);
    },
  }));
  mock.module("../../src/agent/graph", () => ({
    createNautiloGraph: () => {
      graphCreateCalls += 1;
      return {
        streamEvents: async function* () {
          for (const event of streamEvents) yield event;
        },
        getState: async () => ({
          values: { messages: finalMessages },
          tasks: finalTasks,
        }),
      };
    },
  }));

  ({ runScopeSubagentUntilPause } = await import("../../src/subagents/scope-subagent/run"));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  graphCreateCalls = 0;
  ordinaryAppendCalls = 0;
  emittedEvents = [];
  streamEvents = [];
  finalMessages = [new AIMessage("done")];
  finalTasks = [];
});

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

const baseOpts = {
  parentThreadId: "parent-thread",
  parentTurnId: "turn-1",
  parentOwnerId: "owner-1",
  brief: "perform the task",
  subEnvelope,
  actorRole: "owner" as const,
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
};

function encryptedSaver(): EncryptedCheckpointSaver {
  const serializer = new InlineCheckpointCellSerializer();
  return new EncryptedCheckpointSaver({
    operationStoreFactory: {
      serializer,
      schema: "langchain",
      create: () => {
        throw new Error("not used by graph wiring test");
      },
      end: () => Promise.resolve(),
    },
    crypto: {} as never,
    scope: {
      logicalThreadId: "subagent:parent-thread:protected",
      namespaceId: "namespace-1",
      keyClass: "ai",
      expectedAccessRevision: 1,
      expectedPolicyRevision: 1,
      authorizationSession: Object.freeze({ id: "session-1" }),
    },
  });
}

describe("protected Task transcript publication", () => {
  test("retains every sorted protected interrupt coordinate without its value", async () => {
    const firstInterrupt = {
      id: "interrupt-z",
      value: {
        type: "approval_ask",
        approvalId: "approval-opaque",
        reason: "private reason",
      },
    };
    finalTasks = [{
      interrupts: [
        firstInterrupt,
        {
          id: "interrupt-a",
          value: { type: "await_human_reply", targetRoomId: "room-private" },
        },
        {
          id: "interrupt-m",
          value: { type: "identity_challenge", challengeId: "challenge-opaque" },
        },
        {
          id: "interrupt-b",
          value: { type: "prove_it_challenge", tools: [{ private: "body" }] },
        },
      ],
    }];

    const result = await runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort: { publishBatch: async () => {} },
    });

    expect(result).toEqual({
      status: "interrupted",
      threadId: "subagent:parent-thread:protected",
      interrupt: firstInterrupt.value,
      interruptCoordinates: [
        { id: "interrupt-a", kind: "await_reply" },
        { id: "interrupt-b", kind: "prove_it" },
        { id: "interrupt-m", kind: "identity", requestId: "challenge-opaque" },
        { id: "interrupt-z", kind: "approval", requestId: "approval-opaque" },
      ],
    });
    if (result.status !== "interrupted") throw new Error("expected interruption");
    expect(JSON.stringify(result.interruptCoordinates)).not.toContain("private");
  });

  test.each([
    ["missing id", [{ value: { type: "await_human_reply" } }]],
    ["unknown type", [{ id: "interrupt-1", value: { type: "future_interrupt" } }]],
    ["duplicate id", [
      { id: "interrupt-1", value: { type: "prove_it_challenge" } },
      { id: "interrupt-1", value: { type: "await_human_reply" } },
    ]],
  ] as const)("fails closed for a protected %s", async (_label, interrupts) => {
    finalTasks = [{ interrupts: [...interrupts] }];

    let failure: unknown;
    try {
      await runScopeSubagentUntilPause({
        ...baseOpts,
        taskRun: true,
        trustedExecutionEntrypoint: "background.task",
        currentTaskId: "task-1",
        currentTaskRunId: "task-run-1",
        subagentThreadId: "subagent:parent-thread:protected",
        taskRunCheckpointSaver: encryptedSaver(),
        protectedTaskTranscriptPort: { publishBatch: async () => {} },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain("Protected Task interrupt");
  });

  test("keeps the ordinary interrupted result shape unchanged", async () => {
    const interrupt = { type: "future_interrupt", privateBody: "ordinary value" };
    finalTasks = [{ interrupts: [{ value: interrupt }] }];

    const result = await runScopeSubagentUntilPause({ ...baseOpts });

    if (result.status !== "interrupted") throw new Error("expected interruption");
    expect(result.threadId.startsWith("subagent:parent-thread:")).toBe(true);
    expect(result.interrupt).toBe(interrupt);
    expect(Object.keys(result).sort()).toEqual(["interrupt", "status", "threadId"]);
    expect("interruptCoordinates" in result).toBe(false);
  });

  test("requires the protected publication port before graph construction", async () => {
    try {
      await runScopeSubagentUntilPause({
        ...baseOpts,
        taskRun: true,
        trustedExecutionEntrypoint: "background.task",
        currentTaskId: "task-1",
        currentTaskRunId: "task-run-1",
        subagentThreadId: "subagent:parent-thread:protected",
        taskRunCheckpointSaver: encryptedSaver(),
      });
      throw new Error("expected protected transcript publication validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain("requires protected transcript publication");
    }

    expect(graphCreateCalls).toBe(0);
  });

  test("rejects the protected port outside an exact background Task context", async () => {
    try {
      await runScopeSubagentUntilPause({
        ...baseOpts,
        subagentThreadId: "subagent:parent-thread:protected",
        taskRunCheckpointSaver: encryptedSaver(),
        protectedTaskTranscriptPort: { publishBatch: async () => {} },
      });
      throw new Error("expected protected Task identity validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain(
        "requires an exact trusted background Task identity and graph thread",
      );
    }

    expect(graphCreateCalls).toBe(0);
  });

  test("rejects the protected port without Task-run checkpoint authority", async () => {
    try {
      await runScopeSubagentUntilPause({
        ...baseOpts,
        taskRun: true,
        trustedExecutionEntrypoint: "background.task",
        currentTaskId: "task-1",
        currentTaskRunId: "task-run-1",
        subagentThreadId: "subagent:parent-thread:protected",
        protectedTaskTranscriptPort: { publishBatch: async () => {} },
      });
      throw new Error("expected Task-run checkpoint authority validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain(
        "requires Task-run checkpoint authority",
      );
    }

    expect(graphCreateCalls).toBe(0);
  });

  test("publishes each protected message batch once and bypasses ordinary transcript and Room events", async () => {
    const assistant = new AIMessage({
      content: "protected assistant body",
      tool_calls: [{
        id: "call-1",
        name: "file",
        args: { path: "/private/input" },
        type: "tool_call",
      }],
    });
    const tool = new ToolMessage({
      content: "protected tool body",
      tool_call_id: "call-1",
      name: "file",
    });
    const chainEnd = {
      event: "on_chain_end",
      name: "tools",
      data: {
        input: { messages: [] },
        output: { messages: [assistant, tool] },
      },
    };
    streamEvents = [
      { event: "on_chat_model_stream", data: { chunk: { content: "protected token" } } },
      chainEnd,
      chainEnd,
    ];
    finalMessages = [assistant, tool];
    const published: Array<{
      taskId: string;
      taskRunId: string;
      graphThreadId: string;
      roomId: string;
      humanTurnId: string;
      agentId: string;
      messages: readonly BaseMessage[];
    }> = [];

    await runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort: {
        publishBatch: async (input) => {
          published.push(input);
        },
      },
      assistantArtifactExternalIds: ["artifact-that-must-not-be-authored"],
    });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      taskId: "task-1",
      taskRunId: "task-run-1",
      graphThreadId: "subagent:parent-thread:protected",
      roomId: baseOpts.roomId,
      humanTurnId: "turn-1",
      agentId: "agent-1",
    });
    expect(published[0]?.messages).toEqual([assistant, tool]);
    expect(Object.isFrozen(published[0])).toBe(true);
    expect(Object.isFrozen(published[0]?.messages)).toBe(true);
    expect(ordinaryAppendCalls).toBe(0);
    expect(emittedEvents).toEqual([]);
  });

  test("keeps the ordinary transcript path when the protected port is absent", async () => {
    const assistant = new AIMessage("ordinary assistant body");
    streamEvents = [{
      event: "on_chain_end",
      name: "agent",
      data: {
        input: { messages: [] },
        output: { messages: [assistant] },
      },
    }];
    finalMessages = [assistant];

    await runScopeSubagentUntilPause({ ...baseOpts });

    expect(ordinaryAppendCalls).toBe(1);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      type: "message.new",
      content: "ordinary body",
    }));
  });
});
