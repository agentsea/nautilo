/**
 * ISSUE-D440 Phase 0 task 0.3.1
 *
 * Pins the security-sensitive ordering of an ask-gated run_shell call across
 * the real graph checkpoint/resume path. The relay dispatch callback is the
 * first observable side-effect boundary; it must remain strictly after the
 * approval decision and tool.start, and strictly before tool.end.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  __setStubModelForTests,
  resumeGraphWithAskReply,
  setAgentEventSink,
  setOrdinaryHostResolver,
  setRelayRegistry,
  type ToolRelayRegistry,
} from "@nautilo/agent";
import { setConfigOverrides } from "@nautilo/config";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createAcceptedInvocationAuthority,
  initPolicyResolver,
  PinChallengeProvider,
} from "@nautilo/trust";
import type { ServerEvent } from "@nautilo/types";
import { eventBus } from "../../src/event-bus";
import { createPersistingProcessor } from "../../src/executors/persisting-processor";
import { JobManager } from "../../src/job-manager";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { createApprovalVerbTestPolicy } from "./helpers/approval-verb-test-policy";
import { createStubProvider } from "./helpers/stub-provider";
import {
  cleanupTestUserWithDestructivePermission,
  closeDirectDb,
  pollUntilComplete,
  waitForRunningForegroundJob,
} from "./helpers";

const fastCoalesce = {
  coalescerWindowMs: 45,
  coalescerFirstSegmentQuietMs: 45,
} as const;

type TraceEntry = {
  readonly order: number;
  readonly kind:
    | "approval.ask"
    | "approval.decision"
    | "job.dispatched"
    | "job.status"
    | "tool.start"
    | "side-effect-started"
    | "tool.end";
  readonly approvalId?: string;
  readonly jobId?: string;
  readonly jobStatus?: string;
  readonly toolCallId?: string;
};

let userId: string;
let agentId: string;
let jobManager: JobManager;
let workspaceRoot: string;
let trace: TraceEntry[];
let nextOrder: number;
let dispatchCount: number;

function record(entry: Omit<TraceEntry, "order">): void {
  trace.push({ order: nextOrder++, ...entry });
}

function eventRecorder(event: ServerEvent): void {
  if (event.type === "approval.ask") {
    const toolCallId = event.tools[0]?.id;
    record({
      kind: "approval.ask",
      approvalId: event.approvalId,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    });
  } else if (event.type === "job.dispatched") {
    record({ kind: "job.dispatched", jobId: event.jobId });
  } else if (event.type === "job.status") {
    record({
      kind: "job.status",
      jobId: event.jobId,
      jobStatus: event.status,
    });
  } else if (event.type === "tool.start" && event.toolName === "run_shell") {
    record({ kind: "tool.start", toolCallId: event.toolCallId });
  } else if (event.type === "tool.end" && event.toolName === "run_shell") {
    record({ kind: "tool.end", toolCallId: event.toolCallId });
  }
}

function mockRelayRegistry(): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => ["d440-relay"],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
      allowedRoots: ["/"],
      securityLevel: "standard",
    }),
    dispatch: async () => {
      dispatchCount += 1;
      record({ kind: "side-effect-started", toolCallId: "d440-shell-call" });
      return { status: "ok" as const, result: "d440-shell-ok\n" };
    },
  };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  setConfigOverrides({ nautilo_security_level: "standard" });
  setAgentEventSink({ emit: (event) => eventBus.emit(event) });

  jobManager = new JobManager(fastCoalesce);
  const env = await setupAgentTestEnv("d440-approval-event-order");
  userId = env.userId;
  agentId = env.agentId;
  // Install the live relay projection after the shared Agent fixture has
  // finished bootstrapping its runtime globals. The progressive catalog takes
  // this snapshot when the foreground executor starts.
  setRelayRegistry(mockRelayRegistry());
  setOrdinaryHostResolver({
    resolve: async () => ({
      status: "selected",
      host: {
        relayId: "d440-relay",
        pairingGeneration: "d440-pairing",
        desktopSessionId: "d440-desktop-session",
        capabilityRevision: 1,
        workspaceRoot,
        currentFolderRoot: workspaceRoot,
      },
    }),
  });
  initPolicyResolver(createApprovalVerbTestPolicy(userId));
  await new PinChallengeProvider({ persistPath: null }).enroll(userId, "1234");

  workspaceRoot = join(tmpdir(), `d440-approval-${Date.now()}`);
  await fsp.mkdir(workspaceRoot, { recursive: true });
});

beforeEach(() => {
  trace = [];
  nextOrder = 0;
  dispatchCount = 0;
  __setStubModelForTests(null);
  eventBus.on(eventRecorder);
});

afterEach(() => {
  eventBus.off(eventRecorder);
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setRelayRegistry(null);
  setOrdinaryHostResolver(null);
  setAgentEventSink(null);
  setConfigOverrides({});
  await cleanupTestUserWithDestructivePermission(userId);
  await closeDirectDb();
  await closeAgentDb();
  await fsp.rm(workspaceRoot, { recursive: true, force: true });
});

describe("D440 run_shell approval event ordering", () => {
  test("approval decision precedes dispatch and one side effect", async () => {
    const stub = createStubProvider({
      responses: [
        {
          type: "tool_call",
          name: "run_shell",
          args: { command: "printf d440-approval-order" },
          id: "d440-shell-call",
        },
        { type: "text", content: "approved shell completed" },
      ],
    });
    __setStubModelForTests(stub.asChatModel());

    const threadId = `d440-approval-${Date.now()}`;
    const laneKey = `lane:${threadId}`;
    const turnId = randomUUID();

    await jobManager.createForegroundJob(userId, userId, laneKey, {
      // The current progressive-exposure contract activates shell tools from
      // an explicit Human request, before the model can call run_shell.
      message: "Use run_shell to run the approval-order shell fixture.",
      ownerId: userId,
      agentId,
      actorRole: "owner",
      threadId,
      workspacePath: workspaceRoot,
      currentFolder: workspaceRoot,
      verifiedOrdinaryOrigin: {
        kind: "local_electron",
        userId,
        actorId: userId,
        relayId: "d440-relay",
        desktopSessionId: "d440-desktop-session",
        pairingGeneration: "d440-pairing",
        requestId: "d440-request",
      },
      turnId,
    });
    const originalJob = await waitForRunningForegroundJob(jobManager);
    await pollUntilComplete(originalJob, 90_000);

    const asksBeforeDecision = trace.filter((entry) => entry.kind === "approval.ask");
    expect(asksBeforeDecision).toHaveLength(1);
    const askEntry = asksBeforeDecision[0]!;
    expect(typeof askEntry.approvalId).toBe("string");
    expect(askEntry.approvalId).not.toBe("");
    expect(askEntry.toolCallId).toBe("d440-shell-call");
    expect(dispatchCount).toBe(0);
    expect(trace.filter((entry) => entry.kind === "tool.start")).toHaveLength(0);
    expect(trace.filter((entry) => entry.kind === "tool.end")).toHaveLength(0);

    const approvalId = askEntry.approvalId as string;
    record({
      kind: "approval.decision",
      approvalId,
      toolCallId: "d440-shell-call",
    });
    const processor = createPersistingProcessor({
      threadId,
      ownerId: userId,
      agentId,
      laneKey,
      eventBus,
      humanTurnId: turnId,
    });
    await jobManager.runResumeJobLifecycle({
      laneKey,
      roomId: "",
      graphThreadId: threadId,
      humanUserId: userId,
    }, () => resumeGraphWithAskReply(threadId, "once", processor, laneKey),
      createAcceptedInvocationAuthority(userId),
    );

    const decision = trace.find((entry) => entry.kind === "approval.decision")!;
    const resumeDispatch = trace.find(
      (entry) =>
        entry.kind === "job.dispatched" &&
        entry.jobId !== originalJob.id &&
        entry.order > decision.order,
    )!;
    const resumeRunning = trace.find(
      (entry) =>
        entry.kind === "job.status" &&
        entry.jobId === resumeDispatch.jobId &&
        entry.jobStatus === "running",
    )!;
    const toolStart = trace.find((entry) => entry.kind === "tool.start")!;
    const sideEffect = trace.find((entry) => entry.kind === "side-effect-started")!;
    const toolEnd = trace.find((entry) => entry.kind === "tool.end")!;
    const resumeCompleted = trace.find(
      (entry) =>
        entry.kind === "job.status" &&
        entry.jobId === resumeDispatch.jobId &&
        entry.jobStatus === "completed",
    )!;

    const observedOrder = [
      decision.order,
      resumeDispatch.order,
      resumeRunning.order,
      toolStart.order,
      sideEffect.order,
      toolEnd.order,
      resumeCompleted.order,
    ];
    expect(observedOrder).toEqual([...observedOrder].sort((a, b) => a - b));
    expect(toolStart.toolCallId).toBe("d440-shell-call");
    expect(sideEffect.toolCallId).toBe("d440-shell-call");
    expect(toolEnd.toolCallId).toBe("d440-shell-call");
    expect(dispatchCount).toBe(1);
    expect(trace.filter((entry) => entry.kind === "approval.ask")).toHaveLength(1);
    expect(trace.filter((entry) => entry.kind === "tool.start")).toHaveLength(1);
    expect(trace.filter((entry) => entry.kind === "side-effect-started")).toHaveLength(1);
    expect(trace.filter((entry) => entry.kind === "tool.end")).toHaveLength(1);
    expect(stub.remaining).toBe(0);

    process.stdout.write(`[d440-approval-trace] ${JSON.stringify(trace)}\n`);
  });
});
