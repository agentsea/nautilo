/**
 * M169 (R3 + R4) — lock the subagent runner's stream-entry invariants.
 *
 * `runScopeSubagentUntilPause` has exactly three entry modes and this test
 * asserts the SHAPE of the value handed to `graph.streamEvents(...)` for each,
 * so a future edit that turns a resume into a rebuilt `messages` array (a
 * behavior change — ISSUE-M169 §7) fails here:
 *   - R3 cold start → the freshly-built `graphInput` with `messages.length === 1`
 *     (the brief only); never a transcript/checkpoint history concat.
 *   - R4 `continueFromCheckpoint` → a literal `null` input (resume the parked
 *     checkpoint), NOT a rebuilt array.
 *   - R4 `resume` → a `Command` (interrupt reply), NOT a rebuilt array.
 *
 * Lives in unit-isolated because it mocks `createNautiloGraph` process-globally
 * (`mock.module`). No server / DB / API keys.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  EncryptedCheckpointSaver,
  InlineCheckpointCellSerializer,
} from "../../src/checkpoints/encrypted-checkpoint-saver";
import { triggerCheckpointCompactionDouble } from "./support/checkpoint-compaction-double";
import {
  getCurrentInitiatingClientSurface,
  runWithInitiatingClientSurface,
} from "../../src/runtime/initiating-client-surface-context";

let capturedStreamInput: unknown;
let capturedCheckpointSaver: unknown;
let capturedInitiatingSurface: string;

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
    triggerCheckpointCompaction: triggerCheckpointCompactionDouble,
  }));
  mock.module("../../src/agent/post-model-deps", () => ({
    defaultPostModelDeps: {},
  }));
  mock.module("../../src/store/session-store", () => ({
    SUBAGENT_GRAPH_THREAD_PREFIX: "subagent:",
    appendTranscriptMessages: async () => ({ insertedRows: [] }),
  }));
  mock.module("../../src/agent/graph", () => ({
    createNautiloGraph: (checkpointSaver: unknown) => {
      capturedCheckpointSaver = checkpointSaver;
      return {
      streamEvents: async function* (input: unknown) {
        capturedStreamInput = input;
        capturedInitiatingSurface = getCurrentInitiatingClientSurface();
        // A single inert event so the run drains immediately and falls through
        // to the post-run getState below; we only assert the captured input.
        yield { event: "noop" };
      },
      getState: async () => ({
        values: { messages: [new AIMessage("done")] },
        tasks: [],
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
  capturedStreamInput = undefined;
  capturedCheckpointSaver = undefined;
  capturedInitiatingSurface = "unknown";
});

const baseOpts = {
  parentThreadId: "parent-thread",
  parentTurnId: "turn-1",
  parentOwnerId: "owner-1",
  brief: "audit the deploy logs",
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

describe("runScopeSubagentUntilPause stream-entry invariants (M169 R3/R4)", () => {
  test("R3 — cold start streams graphInput with EXACTLY the brief (messages.length === 1)", async () => {
    await runScopeSubagentUntilPause({ ...baseOpts });

    expect(capturedStreamInput).not.toBeNull();
    expect(capturedStreamInput instanceof Command).toBe(false);
    expect(capturedStreamInput).toMatchObject({ noProgressStreaks: new Map(), noProgressPendingCorrection: null, noProgressPendingStop: null });
    const input = capturedStreamInput as { messages?: unknown };
    expect(Array.isArray(input.messages)).toBe(true);
    const messages = input.messages as unknown[];
    // The cold-start guard: exactly one message (the brief), no prepended
    // transcript / checkpoint history.
    expect(messages).toHaveLength(1);
    expect(HumanMessage.isInstance(messages[0])).toBe(true);
    const content = (messages[0] as HumanMessage).content as string;
    expect(content).toContain("audit the deploy logs");
  });

  test("a cold-start whitelist seeds its deferred tools for the first model step", async () => {
    await runScopeSubagentUntilPause({
      ...baseOpts,
      toolWhitelist: ["read_artifact_events"],
    });

    const input = capturedStreamInput as {
      toolWhitelist?: string[];
      activatedToolNames?: string[];
    };
    expect(input.toolWhitelist).toEqual(["read_artifact_events"]);
    expect(input.activatedToolNames).toEqual(["read_artifact_events"]);
  });

  test("R4 — continueFromCheckpoint streams a literal null (not a rebuilt array)", async () => {
    await runScopeSubagentUntilPause({
      ...baseOpts,
      continueFromCheckpoint: true,
      subagentThreadId: "subagent:parent-thread:reuse-1",
    });

    expect(capturedStreamInput).toBeNull();
  });

  test("R4 — resume streams a Command (not a rebuilt array)", async () => {
    await runScopeSubagentUntilPause({
      ...baseOpts,
      resume: { approved: true },
      subagentThreadId: "subagent:parent-thread:reuse-2",
    });

    expect(capturedStreamInput instanceof Command).toBe(true);
    expect(capturedStreamInput).not.toBeNull();
    // A Command is NOT a `{ messages: [...] }` rebuilt-history input.
    expect((capturedStreamInput as { messages?: unknown }).messages).toBeUndefined();
    expect((capturedStreamInput as Command).update).toBeUndefined();
  });

  test("a subagent resets a known parent initiating surface to unknown", async () => {
    await runWithInitiatingClientSurface("mobile.web", () => runScopeSubagentUntilPause({ ...baseOpts }));
    expect(capturedInitiatingSurface).toBe("unknown");
  });

  test("invocation-bound protected child uses the exact child-thread saver", async () => {
    const saver = encryptedSaver();

    await runScopeSubagentUntilPause({
      ...baseOpts,
      subagentThreadId: "subagent:parent-thread:protected",
      invocationCheckpointSaver: saver,
    });

    expect(capturedCheckpointSaver).toBe(saver);
  });

  test("background child cannot inherit foreground checkpoint authority", () => {
    const saver = encryptedSaver();

    return expect(runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      subagentThreadId: "subagent:parent-thread:protected",
      invocationCheckpointSaver: saver,
    })).rejects.toThrow("cannot inherit foreground checkpoint authority");
  });

  test("trusted background Task run uses its independently acquired checkpoint saver", async () => {
    const saver = encryptedSaver();

    await runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: saver,
    });

    expect(capturedCheckpointSaver).toBe(saver);
  });

  test.each([
    ["missing Task stamp", { taskRun: false, trustedExecutionEntrypoint: "background.task", currentTaskId: "task-1", currentTaskRunId: "task-run-1", subagentThreadId: "subagent:parent-thread:protected" }],
    ["missing trusted entrypoint", { taskRun: true, currentTaskId: "task-1", currentTaskRunId: "task-run-1", subagentThreadId: "subagent:parent-thread:protected" }],
    ["missing Task id", { taskRun: true, trustedExecutionEntrypoint: "background.task", currentTaskRunId: "task-run-1", subagentThreadId: "subagent:parent-thread:protected" }],
    ["missing TaskRun id", { taskRun: true, trustedExecutionEntrypoint: "background.task", currentTaskId: "task-1", subagentThreadId: "subagent:parent-thread:protected" }],
    ["missing graph thread", { taskRun: true, trustedExecutionEntrypoint: "background.task", currentTaskId: "task-1", currentTaskRunId: "task-run-1" }],
  ] as const)("Task-run checkpoint saver rejects %s", (_label, identity) => {
    return expect(runScopeSubagentUntilPause({
      ...baseOpts,
      ...identity,
      taskRunCheckpointSaver: encryptedSaver(),
    })).rejects.toThrow("requires an exact trusted background Task identity and graph thread");
  });

  test("forged Task-run saver fails before graph construction", () => {
    return expect(runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      taskRunCheckpointSaver: {} as never,
    })).rejects.toThrow("Task-run subagent requires an encrypted checkpoint saver");
  });

  test("supplying both protected saver channels fails before graph construction", () => {
    return expect(runScopeSubagentUntilPause({
      ...baseOpts,
      invocationCheckpointSaver: encryptedSaver(),
      taskRunCheckpointSaver: encryptedSaver(),
    })).rejects.toThrow("cannot receive both invocation and Task-run checkpoint savers");
  });

  test("forged protected child saver fails before graph construction", () => {
    return expect(runScopeSubagentUntilPause({
      ...baseOpts,
      invocationCheckpointSaver: {} as never,
    })).rejects.toThrow("requires an encrypted checkpoint saver");
  });

});
