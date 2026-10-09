import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  EncryptedCheckpointSaver,
  InlineCheckpointCellSerializer,
} from "../../src/checkpoints/encrypted-checkpoint-saver";
import type { NautiloGraphDeps } from "../../src/agent/graph";
import { triggerCheckpointCompactionDouble } from
  "./support/checkpoint-compaction-double";

let capturedGraphDeps: NautiloGraphDeps | undefined;
let protectedHandlerStarted = Promise.withResolvers<void>();
let releaseProtectedHandler = Promise.withResolvers<void>();
let getStateCalled = false;

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
    expect(capturedGraphDeps).not.toHaveProperty(
      "protectedTaskNodeSettlementScope",
    );
  });
});
