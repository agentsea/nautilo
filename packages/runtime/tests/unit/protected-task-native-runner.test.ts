import { describe, expect, test } from "bun:test";
import type { RunScopeSubagentOpts } from "@nautilo/agent";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

import {
  runProtectedTaskNativeSegment,
  type ProtectedTaskNativeRunnerDependencies,
  type RunProtectedTaskNativeSegmentInput,
} from "../../src/tasks/protected-task-native-runner";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const REQUESTOR_ID = "20000000-0000-4000-8000-000000000002";
const AGENT_ID = "30000000-0000-4000-8000-000000000003";
const TASK_ID = "40000000-0000-4000-8000-000000000004";
const RUN_ID = "50000000-0000-4000-8000-000000000005";
const ROOM_ID = "60000000-0000-4000-8000-000000000006";
const NAMESPACE_ID = "70000000-0000-4000-8000-000000000007";
const GRAPH_THREAD_ID = `subagent:task:${TASK_ID}:protected`;

function envelope(): MemoryAccessEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: REQUESTOR_ID,
    actorId: "80000000-0000-4000-8000-000000000008",
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    readableNamespaces: [NAMESPACE_ID],
    mutableNamespaces: [NAMESPACE_ID],
    writableNamespaces: [NAMESPACE_ID],
    toolPolicy: {},
  };
}

function memoryHandoff(): NonNullable<
  RunScopeSubagentOpts["protectedTaskMemoryHandoff"]
> {
  const unavailable = async () => ({
    status: "unavailable" as const,
    reason: "authorization_required" as const,
  });
  return Object.freeze({
    search: Object.freeze({ search: unavailable }),
    repository: Object.freeze({
      search: unavailable,
      save: unavailable,
      replace: unavailable,
      setTier: unavailable,
    }),
    access: Object.freeze({ change: unavailable }),
    projection: Object.freeze({
      prepare: unavailable,
      publish: unavailable,
    }),
    fullEncryptionOnly: false,
  });
}

function fixture(
  overrides: Partial<RunProtectedTaskNativeSegmentInput> = {},
) {
  const published: unknown[] = [];
  const checkpointSaver = Object.freeze({ kind: "encrypted-task-saver" });
  const transcriptPort = Object.freeze({
    publishBatch: async () => undefined,
  });
  const resultPublication = Object.freeze({
    publish: async (payload: unknown) => {
      published.push(payload);
    },
  });
  const protectedMemory = memoryHandoff();
  const input = {
    mode: "native" as const,
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    graphThreadId: GRAPH_THREAD_ID,
    signal: new AbortController().signal,
    checkpointSaver: checkpointSaver as never,
    transcriptPort,
    memoryHandoff: protectedMemory,
    transientInput: {
      taskId: TASK_ID,
      currentTaskId: TASK_ID,
      taskRunId: RUN_ID,
      turnId: RUN_ID,
      graphThreadId: GRAPH_THREAD_ID,
      protectedTaskResultPublication: resultPublication,
    },
    execution: {
      parentThreadId: `task:${TASK_ID}`,
      parentTurnId: RUN_ID,
      parentOwnerId: OWNER_ID,
      causalHumanUserId: REQUESTOR_ID,
      brief: "Run the protected task",
      expectedOutput: "Return one concise result",
      toolWhitelist: ["search_memory"],
      subEnvelope: envelope(),
      actorRole: "owner",
      assistantName: "Protected Genie",
      soulFile: "",
      modelId: "model-protected",
      currentFolder: "",
      workspacePath: "",
      subagentDepth: 2,
      subagentMaxDepth: 5,
      roomRoster: [],
      roomId: ROOM_ID,
      callingRoomId: ROOM_ID,
      awaitReply: {
        roomId: ROOM_ID,
        fromUserIds: [REQUESTOR_ID],
        ownerId: OWNER_ID,
      },
      modelFallbackMode: "none" as const,
    },
    ...overrides,
  } satisfies RunProtectedTaskNativeSegmentInput;
  return {
    input,
    checkpointSaver,
    transcriptPort,
    resultPublication,
    protectedMemory,
    published,
  };
}

async function expectRejected(
  work: Promise<unknown>,
  message: string,
): Promise<void> {
  const outcome = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain(message);
}

describe("protected Task native runner", () => {
  test("passes the exact protected Task authority and publishes only the canonical result", async () => {
    const scenario = fixture();
    let captured: RunScopeSubagentOpts | undefined;
    const dependencies: ProtectedTaskNativeRunnerDependencies = {
      runScopeSubagent: async (options) => {
        captured = options;
        return {
          status: "completed",
          threadId: GRAPH_THREAD_ID,
          finalText: "internal transcript",
          finalResponseText: "Protected result",
        };
      },
    };

    const result = await runProtectedTaskNativeSegment(
      scenario.input,
      dependencies,
    );

    expect(result).toEqual({
      formatVersion: 1,
      resultText: "Protected result",
      lastError: null,
    });
    expect(scenario.published).toEqual([result]);
    expect(captured).toBeDefined();
    expect(captured).toMatchObject({
      parentThreadId: `task:${TASK_ID}`,
      parentTurnId: RUN_ID,
      parentOwnerId: OWNER_ID,
      causalHumanUserId: REQUESTOR_ID,
      brief: "Run the protected task",
      expectedOutput: "Return one concise result",
      toolWhitelist: ["search_memory"],
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: TASK_ID,
      currentTaskRunId: RUN_ID,
      subagentThreadId: GRAPH_THREAD_ID,
      approvalLaneKey: `task:${TASK_ID}`,
      awaitResponse: true,
      awaitTaskId: TASK_ID,
      awaitTaskRunId: RUN_ID,
      securityAuditClientMeta: null,
    });
    expect(captured?.taskRunCheckpointSaver).toBe(
      scenario.input.checkpointSaver,
    );
    expect(captured?.protectedTaskTranscriptPort).toBe(
      scenario.transcriptPort,
    );
    expect(captured?.protectedTaskMemoryHandoff).toBe(
      scenario.protectedMemory,
    );
    expect(captured?.signal).toBe(scenario.input.signal);
    expect("invocationCheckpointSaver" in captured!).toBe(false);
    expect("assistantArtifactExternalIds" in captured!).toBe(false);
    expect("progressTaskId" in captured!).toBe(false);
    expect("deferAssistantOutputToReportBack" in captured!).toBe(false);
  });

  test("publishes a protected error payload without ordinary report-back", async () => {
    const scenario = fixture();
    const result = await runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async () => {
        throw new Error("provider rejected protected run");
      },
    });

    expect(result).toEqual({
      formatVersion: 1,
      resultText: null,
      lastError: "Protected Task execution failed",
    });
    expect(scenario.published).toEqual([result]);
  });

  test("terminalizes a substituted graph result with a safe protected error", async () => {
    const scenario = fixture();
    const result = await runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async () => ({
        status: "completed",
        threadId: "substituted-thread",
        finalText: "discarded transcript",
        finalResponseText: "discarded result",
      }),
    });

    expect(result).toEqual({
      formatVersion: 1,
      resultText: null,
      lastError: "Protected Task execution failed",
    });
    expect(scenario.published).toEqual([result]);
  });

  test("returns interruptions and aborts in memory without publishing a result", async () => {
    const interrupted = fixture();
    const interrupt = { kind: "await_human_reply" };
    const interruptCoordinates = Object.freeze([
      Object.freeze({ id: "interrupt-1", kind: "await_reply" as const }),
    ]);
    const interruptedResult = await runProtectedTaskNativeSegment(
      interrupted.input,
      {
        runScopeSubagent: async () => ({
          status: "interrupted",
          threadId: GRAPH_THREAD_ID,
          interrupt,
          interruptCoordinates,
        }),
      },
    );
    expect(interruptedResult).toEqual({
      status: "interrupted",
      threadId: GRAPH_THREAD_ID,
      interrupt,
      interruptCoordinates,
    });
    expect(interrupted.published).toEqual([]);

    const controller = new AbortController();
    const aborted = fixture({ signal: controller.signal });
    let calls = 0;
    const abortedResult = await runProtectedTaskNativeSegment(aborted.input, {
      runScopeSubagent: async () => {
        calls += 1;
        controller.abort();
        return {
          status: "completed",
          threadId: GRAPH_THREAD_ID,
          finalText: "discarded transcript",
          finalResponseText: "discarded result",
        };
      },
    });
    expect(abortedResult).toEqual({ status: "aborted" });
    expect(calls).toBe(1);
    expect(aborted.published).toEqual([]);
  });

  test("rejects a protected interruption without content-free coordinates", async () => {
    const scenario = fixture();
    await expectRejected(runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async () => ({
        status: "interrupted",
        threadId: GRAPH_THREAD_ID,
        interrupt: { type: "await_human_reply" },
      }),
    }), "durable coordinates");
    expect(scenario.published).toEqual([]);
  });

  test.each([
    ["empty", []],
    ["duplicate", [
      { id: "interrupt-1", kind: "prove_it" as const },
      { id: "interrupt-1", kind: "await_reply" as const },
    ]],
    ["approval without request id", [
      { id: "interrupt-1", kind: "approval" as const },
    ]],
    ["prove-it with request id", [
      { id: "interrupt-1", kind: "prove_it" as const, requestId: "not-allowed" },
    ]],
    ["await-reply with request id", [
      { id: "interrupt-1", kind: "await_reply" as const, requestId: "not-allowed" },
    ]],
  ] as const)("rejects %s injected protected interrupt coordinates", async (_label, interruptCoordinates) => {
    const scenario = fixture();
    await expectRejected(runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async () => ({
        status: "interrupted",
        threadId: GRAPH_THREAD_ID,
        interrupt: { type: "await_human_reply" },
        interruptCoordinates: [...interruptCoordinates],
      }),
    }), "coordinates");
    expect(scenario.published).toEqual([]);
  });

  test("rejects unsupported execution modes and conflicting continuation input before graph start", async () => {
    for (const mode of [
      "external",
      "repo_docs",
      "deep_research",
      "complex",
    ] as const) {
      const scenario = fixture({ mode });
      let graphStarted = false;
      await expectRejected(runProtectedTaskNativeSegment(scenario.input, {
        runScopeSubagent: async () => {
          graphStarted = true;
          throw new Error("must not run");
        },
      }), "exact supported segment");
      expect(graphStarted).toBe(false);
      expect(scenario.published).toEqual([]);
    }

    const conflicting = fixture({
      execution: {
        ...fixture().input.execution,
        resume: { approved: true },
        continueFromCheckpoint: true,
      },
    });
    let graphStarted = false;
    await expectRejected(runProtectedTaskNativeSegment(conflicting.input, {
      runScopeSubagent: async () => {
        graphStarted = true;
        throw new Error("must not run");
      },
    }), "exact supported segment");
    expect(graphStarted).toBe(false);
    expect(conflicting.published).toEqual([]);

    const missingPublicationBase = fixture();
    const {
      protectedTaskResultPublication: _publication,
      ...identityOnlyInput
    } = missingPublicationBase.input.transientInput;
    const missingPublication = fixture({ transientInput: identityOnlyInput });
    await expectRejected(runProtectedTaskNativeSegment(missingPublication.input, {
      runScopeSubagent: async () => {
        graphStarted = true;
        throw new Error("must not run");
      },
    }), "result publication authority");
    expect(graphStarted).toBe(false);
    expect(missingPublication.published).toEqual([]);

    const missingMemory = fixture({ memoryHandoff: undefined as never });
    await expectRejected(runProtectedTaskNativeSegment(missingMemory.input, {
      runScopeSubagent: async () => {
        graphStarted = true;
        throw new Error("must not run");
      },
    }), "exact supported segment");
    expect(graphStarted).toBe(false);
    expect(missingMemory.published).toEqual([]);

    const disguisedResearch = fixture({
      execution: {
        ...fixture().input.execution,
        toolWhitelist: ["security_scan"],
      },
    });
    await expectRejected(runProtectedTaskNativeSegment(disguisedResearch.input, {
      runScopeSubagent: async () => {
        graphStarted = true;
        throw new Error("must not run");
      },
    }), "exact supported segment");
    expect(graphStarted).toBe(false);
    expect(disguisedResearch.published).toEqual([]);
  });
});
