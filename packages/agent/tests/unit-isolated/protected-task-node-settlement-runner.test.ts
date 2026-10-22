import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { Annotation, END, MemorySaver, START, StateGraph } from
  "@langchain/langgraph";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  EncryptedCheckpointSaver,
  InlineCheckpointCellSerializer,
} from "../../src/checkpoints/encrypted-checkpoint-saver";
import type { NautiloGraphDeps } from "../../src/agent/graph";
import { triggerCheckpointCompactionDouble } from
  "./support/checkpoint-compaction-double";
import {
  createProtectedTaskCheckpointPauseController,
  createProtectedTaskNodeSettlementScope,
  isProtectedTaskCheckpointPauseInterruption,
} from "../../src/graph/protected-task-node-settlement-scope";

let capturedGraphDeps: NautiloGraphDeps | undefined;
let protectedHandlerStarted = Promise.withResolvers<void>();
let releaseProtectedHandler = Promise.withResolvers<void>();
let getStateCalled = false;
let graphMode: "abort" | "consumer_failure" | "pause_next" | "stream_failure"
  | "drain_then_pause" = "abort";
let pausedNodeBodyCalls = 0;
let streamFailure = new Error("protected graph stream failed");

const protectedTaskTranscriptPort = {
  publishBatch: async () => {},
};

const subEnvelope: MemoryAccessEnvelope = {
  memoryMode: "namespace",
  ownerId: "owner-1",
  actorId: "actor-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: [],
  mutableNamespaces: [],
  writableNamespaces: [],
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
  mock.module("../../src/store/session-store", () => ({
    SUBAGENT_GRAPH_THREAD_PREFIX: "subagent:",
    appendTranscriptMessages: async () => ({ insertedRows: [] }),
  }));
  mock.module("../../src/agent/graph", () => ({
    createNautiloGraph: (
      _checkpointSaver: unknown,
      _policyResolver: unknown,
      deps?: NautiloGraphDeps,
    ) => {
      capturedGraphDeps = deps;
      return {
        streamEvents: async function* (
          _input: unknown,
          config: { signal?: AbortSignal },
        ) {
          const scope = deps?.protectedTaskNodeSettlementScope;
          if (scope === undefined) {
            yield { event: "ordinary" };
            return;
          }
          if (graphMode === "stream_failure") throw streamFailure;
          if (graphMode === "pause_next") {
            await scope.run("pre_model", () => {
              pausedNodeBodyCalls += 1;
            });
            return;
          }
          if (graphMode === "consumer_failure") {
            const assistant = new AIMessage("protected assistant body");
            await scope.run("agent", () => ({ messages: [assistant] }));
            yield {
              event: "on_chain_end",
              name: "agent",
              data: {
                input: { messages: [] },
                output: { messages: [assistant] },
              },
            };
            await scope.run("post_model", () => {
              pausedNodeBodyCalls += 1;
            }).catch(() => {
              throw new Error("incidental graph shutdown failure");
            });
            return;
          }
          if (graphMode === "drain_then_pause") {
            const admitted = scope.run("tools", async () => {
              protectedHandlerStarted.resolve();
              await releaseProtectedHandler.promise;
            });
            yield { event: "protected" };
            await admitted;
            await scope.run("agent", () => {
              pausedNodeBodyCalls += 1;
            });
            return;
          }
          void scope.run("tools", async () => {
            protectedHandlerStarted.resolve();
            await releaseProtectedHandler.promise;
          }).catch(() => {});
          yield { event: "protected" };
          if (config.signal?.aborted !== true) {
            await new Promise<void>((resolve) => {
              config.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { event: "after_abort" };
        },
        getState: async () => {
          getStateCalled = true;
          return {
            values: { messages: [new AIMessage("done")] },
            tasks: [],
            next: ["pre_model"],
            config: { configurable: {
              thread_id: "subagent:parent-thread:protected",
              checkpoint_id: "checkpoint-ready",
            } },
          };
        },
      };
    },
  }));

  ({ runScopeSubagentUntilPause } = await import(
    "../../src/subagents/scope-subagent/run"
  ));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  capturedGraphDeps = undefined;
  protectedHandlerStarted = Promise.withResolvers<void>();
  releaseProtectedHandler = Promise.withResolvers<void>();
  getStateCalled = false;
  graphMode = "abort";
  pausedNodeBodyCalls = 0;
  streamFailure = new Error("protected graph stream failed");
});

const baseOpts = {
  parentThreadId: "parent-thread",
  parentTurnId: "turn-1",
  parentOwnerId: "owner-1",
  causalHumanUserId: "owner-1",
  brief: "complete the protected Task",
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

describe("protected Task node settlement in the scope runner", () => {
  test("keeps the saver owner waiting for a started node after graph cancellation", async () => {
    const controller = new AbortController();
    let saverOwnerFinished = false;
    const run = (async () => {
      try {
        return await runScopeSubagentUntilPause({
          ...baseOpts,
          signal: controller.signal,
          taskRun: true,
          trustedExecutionEntrypoint: "background.task",
          currentTaskId: "task-1",
          currentTaskRunId: "task-run-1",
          subagentThreadId: "subagent:parent-thread:protected",
          taskRunCheckpointSaver: encryptedSaver(),
          protectedTaskTranscriptPort,
        });
      } finally {
        saverOwnerFinished = true;
      }
    })();

    await protectedHandlerStarted.promise;
    expect(capturedGraphDeps?.confidential).toBe(true);
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(saverOwnerFinished).toBe(false);
    expect(getStateCalled).toBe(false);

    releaseProtectedHandler.resolve();
    await run;
    expect(getStateCalled).toBe(true);
    expect(saverOwnerFinished).toBe(true);
  });

  test("does not install a settlement scope on the Plain graph path", async () => {
    await runScopeSubagentUntilPause(baseOpts);
    expect(capturedGraphDeps).not.toHaveProperty("confidential");
    expect(capturedGraphDeps).not.toHaveProperty(
      "protectedTaskNodeSettlementScope",
    );
  });

  test("returns a protected pause only after a resumable checkpoint and before the next node body", async () => {
    graphMode = "pause_next";
    const pause = createProtectedTaskCheckpointPauseController();
    pause.request("manual_pause");
    const result = await runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort,
      protectedTaskCheckpointPauseController: pause,
    });
    expect(result).toEqual({ status: "checkpoint_paused",
      threadId: "subagent:parent-thread:protected", reason: "manual_pause" });
    expect(pausedNodeBodyCalls).toBe(0);
    expect(getStateCalled).toBe(true);
  });

  test("drains an admitted node before stopping the next node at its checkpoint", async () => {
    graphMode = "drain_then_pause";
    const pause = createProtectedTaskCheckpointPauseController();
    let settled = false;
    const running = runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort,
      protectedTaskCheckpointPauseController: pause,
    }).finally(() => { settled = true; });
    await protectedHandlerStarted.promise;
    pause.request("grant_refresh");
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseProtectedHandler.resolve();
    expect(await running).toEqual({ status: "checkpoint_paused",
      threadId: "subagent:parent-thread:protected", reason: "grant_refresh" });
    expect(pausedNodeBodyCalls).toBe(0);
  });

  test("fences the graph before a node after protected transcript failure", async () => {
    graphMode = "consumer_failure";
    const publicationFailure = new Error(
      "protected transcript publication failed",
    );
    const failure = await runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort: {
        publishBatch: async () => {
          throw publicationFailure;
        },
      },
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBe(publicationFailure);
    expect(pausedNodeBodyCalls).toBe(0);
    expect(getStateCalled).toBe(false);
  });

  test("preserves a protected graph rejection before its first event", async () => {
    graphMode = "stream_failure";
    const failure = await runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBe(streamFailure);
    expect(pausedNodeBodyCalls).toBe(0);
    expect(getStateCalled).toBe(false);
  });

  test("authorization abort wins over an already requested pause", async () => {
    graphMode = "pause_next";
    const pause = createProtectedTaskCheckpointPauseController();
    pause.request("time_limit");
    const authorization = new AbortController();
    authorization.abort(new Error("authorization expired"));
    const failure = await runScopeSubagentUntilPause({
      ...baseOpts,
      signal: authorization.signal,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort,
      protectedTaskCheckpointPauseController: pause,
    }).then(() => null, (error: unknown) => error);
    expect(failure).toEqual(new Error("authorization expired"));
    expect(pausedNodeBodyCalls).toBe(0);
    expect(getStateCalled).toBe(false);
  });
});

test("LangGraph persists the prior superstep and resumes one sentinel-stopped node exactly once", async () => {
  const schema = Annotation.Root({ value: Annotation<number>() });
  const pause = createProtectedTaskCheckpointPauseController();
  let settlement = createProtectedTaskNodeSettlementScope(undefined, pause);
  let nextBodyCalls = 0;
  const graph = new StateGraph(schema)
    .addNode("prior", () => settlement.run("pre_model", () => {
      pause.request("manual_pause");
      return { value: 1 };
    }))
    .addNode("next", () => settlement.run("agent", () => {
      nextBodyCalls += 1;
      return { value: 2 };
    }))
    .addEdge(START, "prior").addEdge("prior", "next")
    .addEdge("next", END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: "checkpoint-pause-real" },
    version: "v2" as const };
  let interruption: unknown;
  try {
    for await (const _event of graph.streamEvents({ value: 0 }, config)) {
      // Drain the real stream until the branded boundary interruption.
    }
  } catch (error: unknown) { interruption = error; }
  expect(isProtectedTaskCheckpointPauseInterruption(interruption)).toBe(true);
  await settlement.closeAndWait();
  const parked = await graph.getState(config);
  expect(parked.next).toEqual(["next"]);
  expect(parked.values).toEqual({ value: 1 });
  expect(parked.config.configurable?.["checkpoint_id"]).toBeString();
  expect(nextBodyCalls).toBe(0);

  settlement = createProtectedTaskNodeSettlementScope();
  for await (const _event of graph.streamEvents(null, config)) {
    // Resume the saved physical checkpoint without reinjecting input.
  }
  expect(nextBodyCalls).toBe(1);
  expect((await graph.getState(config)).values).toEqual({ value: 2 });
});
