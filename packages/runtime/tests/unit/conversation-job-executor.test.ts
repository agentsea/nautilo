import { describe, expect, test } from "bun:test";

import type { ServerEvent } from "@nautilo/types";

import type {
  ActiveConversationRepository,
  ProtectedConversationProductReadAuthorization,
} from "../../src/conversation/active-conversation-repository";
import type {
  ConversationExecutionServices,
  ProtectedConversationExecutionServices,
} from "../../src/conversation/conversation-execution-services";
import {
  createLegacyConversationComposition,
  createProtectedTestShadowConversationComposition,
} from "../../src/conversation/conversation-composition";
import {
  resolveConversationJobExecutor,
  type ConversationJobRunner,
  type ProtectedConversationInvocation,
} from "../../src/conversation/conversation-job-executor";
import { createProtectedTestShadowAuthorityForTests } from "../../src/conversation/testing/protected-test-shadow-authority";
import type { JobExecutor } from "../../src/job";
import { createDormantEncryptedCheckpointSaverForTests } from "./support/encrypted-checkpoint-saver";

function services(label: string): ConversationExecutionServices {
  const repository = Object.freeze({
    label,
    allocateHumanAppend: async () =>
      Object.freeze({ status: "conflict" as const }),
    allocateHumanEdit: async () =>
      Object.freeze({ status: "conflict" as const }),
    completeHumanRevision: async () =>
      Object.freeze({
        status: "orphaned" as const,
        reason: "stale_mapping" as const,
        messageId: 1,
        revision: 0,
        cryptoObjectId: "message:test",
      }),
    appendPreparedAgent: async () =>
      Object.freeze({ status: "committed" as const }),
    hardDelete: async () => Object.freeze({
      status: "committed" as const,
      disposition: "deleted" as const,
      effects: Object.freeze({
        roomId: "room:test",
        wasUnread: false,
        orphanedTurnId: null,
        rootSummary: null,
      }),
    }),
    readHumanMessages: async () =>
      Object.freeze({ status: "available" as const, messages: [] }),
    withAgentTranscript: async <Value>(
      input: Parameters<ActiveConversationRepository["withAgentTranscript"]>[0],
    ) => Object.freeze({
      status: "executed" as const,
      value: await input.execute([]) as Value,
    }),
  }) satisfies ActiveConversationRepository & { readonly label: string };
  return Object.freeze({ repository });
}

function createProtectedServices(
  label: string,
): ProtectedConversationExecutionServices {
  return Object.freeze({
    ...services(label),
    authorization: Object.freeze({}) as never,
    checkpointSavers: Object.freeze({
      createForInvocation: ({ logicalThreadId }: {
        readonly logicalThreadId: string;
      }) => createDormantEncryptedCheckpointSaverForTests(logicalThreadId),
    }),
    protectedAgentMessagePreparer: Object.freeze({
      prepare: async () => Object.freeze({
        status: "unavailable" as const,
        reason: "signing_capability_unavailable" as const,
      }),
    }),
  });
}

const noServerEvents: readonly ServerEvent[] = Object.freeze([]);
const productReadAuthorization =
  Object.freeze({}) as ProtectedConversationProductReadAuthorization;
const protectedInvocation = Object.freeze({
  sessionId: "10000000-0000-4000-8000-000000000001",
  namespaceId: "namespace-test-shadow",
  productReadAuthorization,
});

async function drain(executor: JobExecutor, input: Record<string, unknown>) {
  for await (
    const _event of executor(
      input,
      "job-1",
      "room:room-1",
      new AbortController().signal,
    )
  ) {
    // These wiring spies intentionally emit no runtime events.
  }
}

describe("conversation-aware job executor", () => {
  test("default and explicit legacy selection return the exact existing executor", () => {
    const legacyServices = services("legacy");
    const legacyExecutor: JobExecutor = async function* () {
      yield* noServerEvents;
    };

    const omitted = resolveConversationJobExecutor({
      defaultLegacyExecutor: legacyExecutor,
      defaultLegacyServices: legacyServices,
    });
    const explicit = resolveConversationJobExecutor({
      defaultLegacyExecutor: legacyExecutor,
      defaultLegacyServices: legacyServices,
      composition: createLegacyConversationComposition(legacyServices),
    });

    expect(omitted).toBe(legacyExecutor);
    expect(explicit).toBe(legacyExecutor);
  });

  test("custom protected executor dispatches ordinary and fork jobs to the correct runner", async () => {
    const legacyServices = services("legacy");
    const protectedServices = createProtectedServices("protected");
    const composition = createProtectedTestShadowConversationComposition({
      authority: createProtectedTestShadowAuthorityForTests(),
      namespaceId: "namespace-test-shadow",
      legacyServices,
      protectedServices,
    });
    const calls: Array<Readonly<{
      readonly runner: "main" | "fork";
      readonly services: ConversationExecutionServices;
      readonly invocation: ProtectedConversationInvocation;
      readonly jobId: string;
      readonly laneKey: string | null;
    }>> = [];
    const mainRunner: ConversationJobRunner = async function* (
      _input,
      jobId,
      laneKey,
      _signal,
      executionServices,
      invocation,
    ): AsyncGenerator<ServerEvent> {
      calls.push({
        runner: "main",
        services: executionServices,
        invocation,
        jobId,
        laneKey,
      });
      yield* noServerEvents;
    };
    const forkRunner: ConversationJobRunner = async function* (
      _input,
      jobId,
      laneKey,
      _signal,
      executionServices,
      invocation,
    ): AsyncGenerator<ServerEvent> {
      calls.push({
        runner: "fork",
        services: executionServices,
        invocation,
        jobId,
        laneKey,
      });
      yield* noServerEvents;
    };
    const executor = resolveConversationJobExecutor({
      defaultLegacyExecutor: async function* () {
        yield* noServerEvents;
        throw new Error("legacy executor must not run");
      },
      defaultLegacyForkExecutor: async function* () {
        yield* noServerEvents;
        throw new Error("legacy fork executor must not run");
      },
      defaultLegacyServices: legacyServices,
      composition,
      resolveProtectedInvocation: () => protectedInvocation,
      protectedRunners: {
        main: mainRunner,
        fork: forkRunner,
      },
    });

    await drain(executor, { roomId: "room-1" });
    await drain(executor, {
      roomId: "room-1",
      forkRun: {
        mode: "fork",
        parentThreadId: "thread-parent",
      },
    });

    expect(calls).toEqual([
      {
        runner: "main",
        services: protectedServices,
        invocation: protectedInvocation,
        jobId: "job-1",
        laneKey: "room:room-1",
      },
      {
        runner: "fork",
        services: protectedServices,
        invocation: protectedInvocation,
        jobId: "job-1",
        laneKey: "room:room-1",
      },
    ]);
  });

  test("fork dispatch checks the explicit fork marker instead of object presence", async () => {
    const legacyServices = services("legacy");
    const protectedServices = createProtectedServices("protected");
    const composition = createProtectedTestShadowConversationComposition({
      authority: createProtectedTestShadowAuthorityForTests(),
      namespaceId: "namespace-test-shadow",
      legacyServices,
      protectedServices,
    });
    const calls: string[] = [];
    const runner = (name: string): ConversationJobRunner =>
      async function* (): AsyncGenerator<ServerEvent> {
        calls.push(name);
        yield* noServerEvents;
      };
    const executor = resolveConversationJobExecutor({
      defaultLegacyExecutor: async function* () {
        calls.push("legacy");
        yield* noServerEvents;
      },
      defaultLegacyForkExecutor: async function* () {
        calls.push("legacy-fork");
        yield* noServerEvents;
      },
      defaultLegacyServices: legacyServices,
      composition,
      resolveProtectedInvocation: () => protectedInvocation,
      protectedRunners: {
        main: runner("main"),
        fork: runner("fork"),
      },
    });

    await drain(executor, { forkRun: {} });
    await drain(executor, { forkRun: { mode: "main" } });
    await drain(executor, { forkRun: { mode: "fork" } });

    expect(calls).toEqual(["main", "main", "fork"]);
  });

  test("a custom executor preserves legacy main and fork dispatch for every other Namespace", async () => {
    const legacyServices = services("legacy");
    const protectedServices = createProtectedServices("protected");
    const composition = createProtectedTestShadowConversationComposition({
      authority: createProtectedTestShadowAuthorityForTests(),
      namespaceId: "namespace-test-shadow",
      legacyServices,
      protectedServices,
    });
    const calls: string[] = [];
    const legacyRunner = (name: string): JobExecutor =>
      async function* (): AsyncGenerator<ServerEvent> {
        calls.push(name);
        yield* noServerEvents;
      };
    const protectedRunner = (name: string): ConversationJobRunner =>
      async function* (): AsyncGenerator<ServerEvent> {
        calls.push(name);
        yield* noServerEvents;
      };
    const executor = resolveConversationJobExecutor({
      defaultLegacyExecutor: legacyRunner("legacy-main"),
      defaultLegacyForkExecutor: legacyRunner("legacy-fork"),
      defaultLegacyServices: legacyServices,
      composition,
      resolveProtectedInvocation: () => ({
        ...protectedInvocation,
        namespaceId: "namespace-other-room",
      }),
      protectedRunners: {
        main: protectedRunner("protected-main"),
        fork: protectedRunner("protected-fork"),
      },
    });

    await drain(executor, { roomId: "room-other" });
    await drain(executor, {
      roomId: "room-other",
      forkRun: { mode: "fork" },
    });

    expect(calls).toEqual(["legacy-main", "legacy-fork"]);
  });
});
