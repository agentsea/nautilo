import { describe, expect, test } from "bun:test";
import type { RunScopeSubagentOpts } from "@nautilo/agent";
import { protectedTaskSemanticAuthorityRequirementsDigest } from "@nautilo/db";
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
    access: Object.freeze({
      prepareApproval: unavailable,
      restoreApproval: unavailable,
      planChange: unavailable,
      changeAuthorized: unavailable,
    }),
    projection: Object.freeze({
      prepare: unavailable,
      restore: unavailable,
      planPublication: unavailable,
      publishAuthorized: unavailable,
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
  test("admits repo docs only with the fixed file-only graph and process-local semantic port", async () => {
    const base = fixture();
    const executionPort = Object.freeze({
      plan: async () => null,
      execute: async () => { throw new Error("unused"); },
      inspect: async () => ({ status: "absent" as const }),
    });
    const projectFilePort = Object.freeze({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      agentId: AGENT_ID,
      humanUserId: OWNER_ID,
      relayId: "relay",
      workspaceRoot: "/captured/project/nautilo-repo-docs/task-run-run",
      dispatch: async () => ({ ok: false as const, message: "unused" }),
    });
    let captured: RunScopeSubagentOpts | undefined;
    const result = await runProtectedTaskNativeSegment({
      ...base.input,
      mode: "repo_docs",
      execution: {
        ...base.input.execution,
        toolWhitelist: ["file"],
        protectedRepoDocs: {
          selection: { target: "https://example.test/repo.git", mode: "auto", publish: "branch" },
          executionPort,
          createProjectFilePort: () => projectFilePort,
        },
      },
    }, { runScopeSubagent: async options => {
      captured = options;
      return { status: "completed", threadId: GRAPH_THREAD_ID,
        finalText: "internal", finalResponseText: "docs committed" };
    } });
    expect(result).toEqual({ formatVersion: 1, resultText: "docs committed", lastError: null });
    expect(captured?.toolWhitelist).toEqual(["file"]);
    expect(captured?.protectedRepoDocs?.executionPort).toBe(executionPort);
    expect(captured?.protectedRepoDocs?.createProjectFilePort("workdir")).toBe(projectFilePort);
    expect(base.input.transientInput).not.toHaveProperty("protectedRepoDocs");

    for (const toolWhitelist of [undefined, [], ["file", "exec_command"]]) {
      await expectRejected(runProtectedTaskNativeSegment({
        ...base.input, mode: "repo_docs",
        execution: { ...base.input.execution, ...(toolWhitelist === undefined ? {} : { toolWhitelist }),
          protectedRepoDocs: { selection: { target: "repo", mode: "auto", publish: "branch" }, executionPort,
            createProjectFilePort: () => projectFilePort } },
      }), "exact supported segment");
    }
    await expectRejected(runProtectedTaskNativeSegment({
      ...base.input,
      mode: "repo_docs",
      execution: {
        ...base.input.execution,
        toolWhitelist: ["file"],
        protectedRepoDocs: {
          selection: { target: "repo", mode: "auto", publish: "branch" },
          executionPort,
          createProjectFilePort: () => projectFilePort,
        },
        taskReportBackContinuation: {
          status: "available", relayId: "relay", relaySessionId: "socket",
          desktopSessionId: "desktop", pairingGeneration: "pairing",
          currentFolder: "/captured/project", workspacePath: "",
        },
      },
    }), "exact supported segment");
  });
  test("passes the exact delegated local execution port without serializing it", async () => {
    const port = Object.freeze({ taskId: TASK_ID, taskRunId: RUN_ID,
      signal: new AbortController().signal,
      withAdmission: async <T>(_operation: "read", work: (value: never) => Promise<T>) => work({} as never) });
    const base = fixture();
    const scenario = fixture({ execution: { ...base.input.execution,
      delegatedLocalExecutionPort: port } });
    let captured: RunScopeSubagentOpts | undefined;
    await runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async options => {
        captured = options;
        return { status: "completed", threadId: GRAPH_THREAD_ID,
          finalText: "internal", finalResponseText: "complete" };
      },
    });
    expect(captured?.delegatedLocalExecutionPort).toBe(port);
    expect(scenario.input.transientInput).not.toHaveProperty("delegatedLocalExecutionPort");
  });
  test("passes process-local caller funding custody to the graph without copying it", async () => {
    const fundingSession = Object.freeze({
      kind: "personal" as const,
      recheckAttempt: async () => {},
      runAttempt: async <T>(
        _modelId: string,
        callback: (attempt: never) => Promise<T>,
      ) => callback({} as never),
    });
    const base = fixture();
    const scenario = fixture({
      execution: {
        ...base.input.execution,
        foregroundChatFundingSession: fundingSession,
      },
    });
    let captured: RunScopeSubagentOpts | undefined;
    await runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async options => {
        captured = options;
        return {
          status: "completed",
          threadId: GRAPH_THREAD_ID,
          finalText: "internal",
          finalResponseText: "complete",
        };
      },
    });

    expect(captured?.foregroundChatFundingSession).toBe(fundingSession);
    expect(scenario.input.transientInput).not.toHaveProperty(
      "foregroundChatFundingSession",
    );
  });

  test("passes the exact protected Task authority and returns the canonical result without terminalizing", async () => {
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
    expect(scenario.published).toEqual([]);
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

  test("runs with identity-only transient input and leaves publication to the closing owner", async () => {
    const scenario = fixture();
    const { protectedTaskResultPublication: _publication, ...identityOnly } = scenario.input.transientInput;
    const result = await runProtectedTaskNativeSegment({ ...scenario.input, transientInput: identityOnly }, {
      runScopeSubagent: async () => ({
        status: "completed", threadId: GRAPH_THREAD_ID,
        finalText: "internal", finalResponseText: "Complete",
      }),
    });
    expect(result).toEqual({ formatVersion: 1, resultText: "Complete", lastError: null });
    expect(scenario.published).toEqual([]);
  });

  test("carries an exact interrupt-keyed additional-authority resume", async () => {
    const resume = Object.freeze({
      "interrupt-exact": Object.freeze({
        type: "protected_task_additional_authority_granted_v1" as const,
        authorizationRequestId: `task-run-authorization:${RUN_ID}`,
        effectDisposition: "not_started_v1" as const,
        operationId: "memory-operation-exact",
        requestDigest: new Uint8Array(32).fill(11),
        requiredAuthorityDigest: new Uint8Array(32).fill(19),
      }),
    });
    const scenario = fixture({
      execution: { ...fixture().input.execution, resume },
    });
    let captured: RunScopeSubagentOpts | undefined;
    await runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async options => {
        captured = options;
        return {
          status: "completed",
          threadId: GRAPH_THREAD_ID,
          finalText: "internal transcript",
          finalResponseText: "Protected result",
        };
      },
    });

    expect(captured?.resume).toBe(resume);
    expect(captured?.continueFromCheckpoint).toBeUndefined();
  });

  test("passes one typed protected Human resume to the graph runner", async () => {
    const protectedTaskHumanResume = Object.freeze({
      kind: "approval" as const,
      interruptId: "interrupt-exact",
      requestId: "approval-exact",
      verb: "once" as const,
    });
    const scenario = fixture({
      execution: {
        ...fixture().input.execution,
        protectedTaskHumanResume,
      },
    });
    let captured: RunScopeSubagentOpts | undefined;
    await runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async options => {
        captured = options;
        return {
          status: "completed",
          threadId: GRAPH_THREAD_ID,
          finalText: "internal transcript",
          finalResponseText: "Protected result",
        };
      },
    });

    expect(captured?.protectedTaskHumanResume).toBe(protectedTaskHumanResume);
    expect(captured?.resume).toBeUndefined();
    expect(captured?.continueFromCheckpoint).toBeUndefined();
    expect(captured?.subEnvelope).toBe(scenario.input.execution.subEnvelope);
  });

  test("returns a protected error payload without ordinary report-back", async () => {
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
    expect(scenario.published).toEqual([]);
  });

  test("returns a safe protected error for a substituted graph result", async () => {
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
    expect(scenario.published).toEqual([]);
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

  test("passes through a cooperative checkpoint pause without publishing a result", async () => {
    const controller = {
      request: () => true,
      currentRequestedReason: () => "manual_pause" as const,
    };
    const scenario = fixture({
      protectedTaskCheckpointPauseController: controller,
    });
    const result = await runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async options => {
        expect(options.protectedTaskCheckpointPauseController)
          .toBe(controller);
        return { status: "checkpoint_paused", threadId: GRAPH_THREAD_ID,
          reason: "manual_pause" };
      },
    });
    expect(result).toEqual({ status: "checkpoint_paused",
      threadId: GRAPH_THREAD_ID, reason: "manual_pause" });
    expect(scenario.published).toEqual([]);
  });

  test("extracts one detached pre-effect additional-authority continuation", async () => {
    const { awaitReply: _awaitReply, ...continuedExecution } =
      fixture().input.execution;
    const scenario = fixture({
      execution: {
        ...continuedExecution,
        continueFromCheckpoint: true,
      },
    });
    const requestDigest = new Uint8Array(32).fill(11);
    const semanticAuthorityRequirements = [{
      namespaceId: NAMESPACE_ID,
      operations: ["decrypt"] as const,
    }];
    const requiredAuthorityDigest =
      protectedTaskSemanticAuthorityRequirementsDigest(
        semanticAuthorityRequirements,
      );
    const result = await runProtectedTaskNativeSegment(scenario.input, {
      runScopeSubagent: async options => {
        expect(options.continueFromCheckpoint).toBe(true);
        return {
          status: "interrupted",
          threadId: GRAPH_THREAD_ID,
          interrupt: { type: "protected_task_additional_authority" },
          interruptCoordinates: [{
            id: "interrupt-1",
            kind: "additional_authority",
            requestId: "task-runtime-request-2",
            effectDisposition: "not_started_v1",
            operationId: "memory-operation-1",
            requestDigest,
            requiredAuthorityDigest,
            semanticAuthorityRequirements,
          }],
        };
      },
    });

    expect(result).toMatchObject({
      status: "interrupted",
      interruptCoordinates: [{
        id: "interrupt-1",
        kind: "additional_authority",
        requestId: "task-runtime-request-2",
      }],
      additionalAuthority: {
        kind: "pre_effect_interrupt_v1",
        reason: "additional_authority",
        effectDisposition: "not_started_v1",
        interruptId: "interrupt-1",
        operationId: "memory-operation-1",
      },
    });
    expect("interrupt" in result).toBe(false);
    if (!("additionalAuthority" in result)
      || result.additionalAuthority === undefined) {
      throw new Error("expected additional authority continuation");
    }
    expect(result.additionalAuthority.requestDigest).toEqual(requestDigest);
    expect(result.additionalAuthority.requestDigest).not.toBe(requestDigest);
    expect(result.additionalAuthority.requiredAuthorityDigest)
      .not.toBe(requiredAuthorityDigest);
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
    ["approval without categorical authority", [
      { id: "interrupt-1", kind: "approval" as const,
        requestId: "approval:1" },
    ]],
    ["approval with duplicated categorical authority", [
      { id: "interrupt-1", kind: "approval" as const,
        requestId: "approval:1", allowedVerbs: ["once", "once", "deny"] as const },
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

    for (const conflictingContinuation of [
      {
        protectedTaskHumanResume: {
          kind: "prove_it" as const,
          interruptId: "interrupt-exact",
          approved: true,
        },
        resume: { approved: true },
      },
      {
        protectedTaskHumanResume: {
          kind: "identity" as const,
          interruptId: "interrupt-exact",
          verified: true as const,
        },
        continueFromCheckpoint: true,
      },
    ]) {
      const humanConflict = fixture({
        execution: {
          ...fixture().input.execution,
          ...conflictingContinuation,
        },
      });
      graphStarted = false;
      await expectRejected(runProtectedTaskNativeSegment(humanConflict.input, {
        runScopeSubagent: async () => {
          graphStarted = true;
          throw new Error("must not run");
        },
      }), "exact supported segment");
      expect(graphStarted).toBe(false);
    }

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
