/**
 * M169 (R3 + R4) — lock the subagent runner's stream-entry invariants.
 *
 * `runScopeSubagentUntilPause` has exactly four entry modes and this test
 * asserts the SHAPE of the value handed to `graph.streamEvents(...)` for each,
 * so a future edit that turns a resume into a rebuilt `messages` array (a
 * behavior change — ISSUE-M169 §7) fails here:
 *   - R3 cold start → the freshly-built `graphInput` with `messages.length === 1`
 *     (the brief only); never a transcript/checkpoint history concat.
 *   - R4 `continueFromCheckpoint` → a literal `null` input, or a state-only
 *     `Command` for a narrowly authorized legacy lifecycle repair; never a
 *     rebuilt array.
 *   - protected Human resume → the exact interrupt reply plus fresh authority,
 *     optionally with the same narrow legacy lifecycle repair.
 *   - R4 `resume` → a `Command` (interrupt reply), NOT a rebuilt array.
 *
 * Lives in unit-isolated because it mocks `createNautiloGraph` process-globally
 * (`mock.module`). No server / DB / API keys.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { ShareMemoryApprovalPreview } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import {
  EncryptedCheckpointSaver,
  InlineCheckpointCellSerializer,
} from "../../src/checkpoints/encrypted-checkpoint-saver";
import { triggerCheckpointCompactionDouble } from "./support/checkpoint-compaction-double";
import {
  getCurrentInitiatingClientSurface,
  runWithInitiatingClientSurface,
} from "../../src/runtime/initiating-client-surface-context";
import * as shareApprovalPreview from
  "../../src/post-model/share-approval-preview";
import {
  protectedMemoryAccessApprovalPreview,
  protectedMemoryAccessRequestDigest,
  type ProtectedMemoryAccessSnapshot,
} from "../../src/tools/memory/protected-task-access-sharing";

let capturedStreamInput: unknown;
let capturedCheckpointSaver: unknown;
let capturedGraphDeps: import("../../src/agent/graph").NautiloGraphDeps;
let capturedInitiatingSurface: string;
let ordinaryAppendCalls: number;
let checkpointValues: Record<string, unknown>;
let checkpointTasks: Array<Record<string, unknown>>;

const protectedTaskTranscriptPort = {
  publishBatch: async () => {},
};

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
    appendTranscriptMessages: async () => {
      ordinaryAppendCalls += 1;
      return { insertedRows: [] };
    },
  }));
  mock.module("../../src/agent/graph", () => ({
    createNautiloGraph: (
      checkpointSaver: unknown,
      _policyResolver: unknown,
      graphDeps: import("../../src/agent/graph").NautiloGraphDeps,
    ) => {
      capturedCheckpointSaver = checkpointSaver;
      capturedGraphDeps = graphDeps;
      return {
      streamEvents: async function* (input: unknown) {
        capturedStreamInput = input;
        capturedInitiatingSurface = getCurrentInitiatingClientSurface();
        // A single inert event so the run drains immediately and falls through
        // to the post-run getState below; we only assert the captured input.
        yield { event: "noop" };
      },
      getState: async () => ({
        values: { messages: [new AIMessage("done")], ...checkpointValues },
        tasks: checkpointTasks,
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
  ordinaryAppendCalls = 0;
  checkpointValues = {};
  checkpointTasks = [];
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

function protectedAccessCheckpoint(
  verb: "once" | "deny",
): Readonly<{
  snapshot: ProtectedMemoryAccessSnapshot;
  preview: ShareMemoryApprovalPreview;
  binding: import("../../src/graph/protected-task-human-resume")
    .ProtectedTaskHumanResumeBindingV1;
}> {
  const call = {
    id: "share-call-1",
    name: "share_memory",
    args: {
      mode: "attach",
      memory_id: "memory-1",
      target_handle: "bob",
      sensitivity: "normal",
    },
  };
  const reference = {
    referenceVersion: 1 as const,
    referenceId: "access-reference-1",
    toolCallId: call.id,
    requesterUserId: "owner-1",
    agentId: "agent-1",
    taskContinuation: {
      kind: "protected_task_v1" as const,
      requesterActorId: "actor-1",
      createdAt: 1,
      sealedPreparation: "sealed-access-preparation",
    },
  };
  const snapshot: ProtectedMemoryAccessSnapshot = {
    snapshotVersion: 1,
    kind: "protected_task_access",
    toolCallId: call.id,
    requesterUserId: "owner-1",
    requesterActorId: "actor-1",
    agentId: "agent-1",
    requestDigest: protectedMemoryAccessRequestDigest(call)!,
    reference,
  };
  const preview: ShareMemoryApprovalPreview = {
    protectedApprovalDigest: reference.referenceId,
    memoryContentSnippet: "Saved private note",
    memoryType: "note",
    targetHandle: "bob",
    targetDisplayName: "Bob",
    roomLabel: null,
    wouldCreate: true,
    sensitivity: "normal",
  };
  checkpointValues = {
    taskRun: true,
    subagentRun: true,
    trustedExecutionEntrypoint: "background.task",
    currentTaskId: "task-1",
    currentTaskRunId: "task-run-1",
    currentThreadId: "subagent:parent-thread:protected",
    langgraphThreadId: "subagent:parent-thread:protected",
    turnId: "task-run-1",
    userId: "owner-1",
    causalHumanUserId: "owner-1",
    agentId: "agent-1",
    roomId: "room-1",
    callingRoomId: "room-1",
    actorRole: "owner",
    approvalLaneKey: "task:task-1",
    memoryAccessEnvelope: {
      ...subEnvelope,
      readableNamespaces: ["stale-read"],
      mutableNamespaces: ["stale-mutable"],
      writableNamespaces: ["stale-write"],
    },
    memoryBrief: "",
    memoryDelta: "",
    verifiedOrdinaryOrigin: null,
    relayCapabilities: {},
    messages: [new AIMessage({ content: "", tool_calls: [call] })],
    protectedMemoryAccessSnapshots: [snapshot],
  };
  checkpointTasks = [{
    interrupts: [{
      id: "interrupt-access-1",
      value: {
        type: "approval_ask",
        approvalId: "approval-access-1",
        tools: [{ ...call, shareMemoryPreview: preview }],
        reason: "Share this Memory?",
        reasonCode: "destructive-tool",
        allowedVerbs: ["once", "deny"],
      },
    }],
  }];
  return {
    snapshot,
    preview,
    binding: {
      kind: "approval",
      interruptId: "interrupt-access-1",
      requestId: "approval-access-1",
      verb,
    },
  };
}

function protectedMemoryHandoff(
  restoreApproval: (...args: unknown[]) => unknown,
): import("../../src/subagents/protected-task-memory-graph-deps")
  .ProtectedTaskMemoryGraphHandoff {
  return {
    search: { search: async () => ({ status: "unavailable", reason: "authorization_required" }) },
    repository: {
      search: async () => ({ status: "unavailable", reason: "authorization_required" }),
      save: async () => ({ status: "unavailable", reason: "authorization_required" }),
      replace: async () => ({ status: "unavailable", reason: "authorization_required" }),
      setTier: async () => ({ status: "unavailable", reason: "authorization_required" }),
    },
    access: {
      prepareApproval: async () => ({ status: "unavailable", reason: "authorization_required" }),
      restoreApproval,
      planChange: async () => ({ status: "unavailable", reason: "authorization_required" }),
      changeAuthorized: async () => ({ status: "unavailable", reason: "authorization_required" }),
    },
    fullEncryptionOnly: true,
  } as import("../../src/subagents/protected-task-memory-graph-deps")
    .ProtectedTaskMemoryGraphHandoff;
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

  test("R4 — legacy exec-only checkpoint gains only its currently authorized lifecycle companion", async () => {
    checkpointValues = {
      toolWhitelist: ["read_artifact_events", "exec_command"],
      activatedToolNames: ["read_artifact_events", "exec_command"],
    };
    await runScopeSubagentUntilPause({
      ...baseOpts,
      toolWhitelist: ["exec_command", "write_stdin"],
      continueFromCheckpoint: true,
      subagentThreadId: "subagent:parent-thread:reuse-legacy-exec",
    });

    expect(capturedStreamInput instanceof Command).toBe(true);
    expect((capturedStreamInput as Command).resume).toBeUndefined();
    expect((capturedStreamInput as Command).update).toEqual({
      toolWhitelist: ["read_artifact_events", "exec_command", "write_stdin"],
      activatedToolNames: ["read_artifact_events", "exec_command", "write_stdin"],
    });
  });

  test("R4 — current denial does not widen a legacy exec-only checkpoint", async () => {
    checkpointValues = {
      toolWhitelist: ["exec_command"],
      activatedToolNames: ["exec_command"],
    };
    await runScopeSubagentUntilPause({
      ...baseOpts,
      toolWhitelist: ["exec_command"],
      continueFromCheckpoint: true,
      subagentThreadId: "subagent:parent-thread:reuse-denied-write",
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

  test("R4 — interrupt reply preserves its resume payload while repairing a legacy lifecycle pair", async () => {
    checkpointValues = {
      toolWhitelist: ["exec_command"],
      activatedToolNames: ["exec_command"],
    };
    const resume = { approved: true };
    await runScopeSubagentUntilPause({
      ...baseOpts,
      toolWhitelist: ["exec_command", "write_stdin"],
      resume,
      subagentThreadId: "subagent:parent-thread:reuse-approved-exec",
    });

    expect(capturedStreamInput instanceof Command).toBe(true);
    expect((capturedStreamInput as Command).resume).toEqual(resume);
    expect((capturedStreamInput as Command).update).toEqual({
      toolWhitelist: ["exec_command", "write_stdin"],
      activatedToolNames: ["exec_command", "write_stdin"],
    });
  });

  test("protected Human resume preserves exact reply and fresh authority while repairing a legacy lifecycle pair", async () => {
    const subagentThreadId = "subagent:parent-thread:protected";
    const approvalLaneKey = "task:task-1";
    checkpointValues = {
      taskRun: true,
      subagentRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      currentThreadId: subagentThreadId,
      langgraphThreadId: subagentThreadId,
      turnId: "task-run-1",
      userId: "owner-1",
      causalHumanUserId: "owner-1",
      agentId: "agent-1",
      roomId: "room-1",
      callingRoomId: "room-1",
      actorRole: "owner",
      approvalLaneKey,
      memoryAccessEnvelope: {
        ...subEnvelope,
        readableNamespaces: ["stale"],
        mutableNamespaces: ["stale"],
        writableNamespaces: ["stale"],
      },
      relayCapabilities: { staleRelay: true },
      toolWhitelist: ["exec_command"],
      activatedToolNames: ["exec_command"],
    };
    checkpointTasks = [{
      interrupts: [{
        id: "interrupt-1",
        value: { type: "prove_it_challenge", tools: [] },
      }],
    }];

    await runScopeSubagentUntilPause({
      ...baseOpts,
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      causalHumanUserId: "owner-1",
      roomId: "room-1",
      callingRoomId: "room-1",
      approvalLaneKey,
      subagentThreadId,
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort,
      toolWhitelist: ["exec_command", "write_stdin"],
      relayCapabilities: { freshRelay: true },
      protectedTaskHumanResume: {
        kind: "prove_it",
        interruptId: "interrupt-1",
        approved: true,
      },
    });

    expect(capturedStreamInput instanceof Command).toBe(true);
    expect((capturedStreamInput as Command).resume).toEqual({
      "interrupt-1": { approved: true },
    });
    expect((capturedStreamInput as Command).update).toEqual({
      memoryAccessEnvelope: subEnvelope,
      relayCapabilities: { freshRelay: true },
      toolWhitelist: ["exec_command", "write_stdin"],
      activatedToolNames: ["exec_command", "write_stdin"],
    });
  });

  test("protected Task approval resume restores the exact access snapshot under fresh custody before streaming", async () => {
    const prepared = protectedAccessCheckpoint("once");
    const target = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue(null);
    const room = spyOn(
      shareApprovalPreview,
      "resolveShareApprovalTargetRoomPreview",
    ).mockResolvedValue({
      targetDisplayName: "Bob",
      roomLabel: null,
      wouldCreate: true,
    });
    const restoreApproval = mock(async (_request: unknown) => ({
      status: "success" as const,
      value: { content: "Saved private note", type: "note" },
    }));
    try {
      await runScopeSubagentUntilPause({
        ...baseOpts,
        parentTurnId: "task-run-1",
        taskRun: true,
        trustedExecutionEntrypoint: "background.task",
        currentTaskId: "task-1",
        currentTaskRunId: "task-run-1",
        causalHumanUserId: "owner-1",
        roomId: "room-1",
        callingRoomId: "room-1",
        approvalLaneKey: "task:task-1",
        subagentThreadId: "subagent:parent-thread:protected",
        taskRunCheckpointSaver: encryptedSaver(),
        protectedTaskTranscriptPort,
        protectedTaskMemoryHandoff: protectedMemoryHandoff(restoreApproval),
        protectedTaskHumanResume: prepared.binding,
      });

      expect(restoreApproval).toHaveBeenCalledTimes(1);
      expect(restoreApproval.mock.calls[0]?.[0]).toMatchObject({
        authority: {
          mode: "namespace",
          readableNamespaceIds: ["n1"],
          mutableNamespaceIds: ["n1"],
          writableNamespaceId: "n1",
        },
        reference: prepared.snapshot.reference,
        memoryId: "memory-1",
        action: { kind: "grant_user", userHandle: "bob" },
      });
      const reloadedSnapshot = structuredClone(prepared.snapshot);
      const reloadedState = {
        ...checkpointValues,
        memoryAccessEnvelope: subEnvelope,
      } as NautiloState;
      const graphPort = capturedGraphDeps.protectedMemoryAccessPortForState?.(
        reloadedState,
      );
      if (graphPort === undefined) throw new Error("graph access port missing");
      expect(protectedMemoryAccessApprovalPreview(
        reloadedSnapshot,
        graphPort,
      )).toMatchObject({ protectedApprovalDigest: "access-reference-1" });
      expect(capturedStreamInput instanceof Command).toBe(true);
    } finally {
      target.mockRestore();
      room.mockRestore();
    }
  });

  test("protected Task denial replays its authenticated preview without reading current Memory", async () => {
    const prepared = protectedAccessCheckpoint("deny");
    const restoreApproval = mock(async (_request: unknown) => {
      throw new Error("denial must not read current Memory");
    });

    await runScopeSubagentUntilPause({
      ...baseOpts,
      parentTurnId: "task-run-1",
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      causalHumanUserId: "owner-1",
      roomId: "room-1",
      callingRoomId: "room-1",
      approvalLaneKey: "task:task-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort,
      protectedTaskMemoryHandoff: protectedMemoryHandoff(restoreApproval),
      protectedTaskHumanResume: prepared.binding,
    });

    expect(restoreApproval).not.toHaveBeenCalled();
    expect((capturedStreamInput as Command).resume).toEqual({
      "interrupt-access-1": { approved: false, verb: "deny" },
    });
  });

  test("protected Task identity continuation restores its pending attach preview", async () => {
    protectedAccessCheckpoint("once");
    checkpointTasks = [{
      interrupts: [{
        id: "interrupt-identity-1",
        value: {
          type: "identity_challenge",
          mode: "enrollPin",
          enrollmentToolCallIds: ["share-call-1"],
          protectedMemoryTools: [{
            toolCallId: "share-call-1",
            mode: "attach",
          }],
        },
      }],
    }];
    const target = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue(null);
    const room = spyOn(
      shareApprovalPreview,
      "resolveShareApprovalTargetRoomPreview",
    ).mockResolvedValue({
      targetDisplayName: "Bob",
      roomLabel: null,
      wouldCreate: true,
    });
    const restoreApproval = mock(async (_request: unknown) => ({
      status: "success" as const,
      value: { content: "Saved private note", type: "note" },
    }));
    try {
      await runScopeSubagentUntilPause({
        ...baseOpts,
        parentTurnId: "task-run-1",
        taskRun: true,
        trustedExecutionEntrypoint: "background.task",
        currentTaskId: "task-1",
        currentTaskRunId: "task-run-1",
        causalHumanUserId: "owner-1",
        roomId: "room-1",
        callingRoomId: "room-1",
        approvalLaneKey: "task:task-1",
        subagentThreadId: "subagent:parent-thread:protected",
        taskRunCheckpointSaver: encryptedSaver(),
        protectedTaskTranscriptPort,
        protectedTaskMemoryHandoff: protectedMemoryHandoff(restoreApproval),
        protectedTaskHumanResume: {
          kind: "identity",
          interruptId: "interrupt-identity-1",
          verified: true,
        },
      });

      expect(restoreApproval).toHaveBeenCalledTimes(1);
      expect((capturedStreamInput as Command).resume).toEqual({
        "interrupt-identity-1": { verified: true },
      });
    } finally {
      target.mockRestore();
      room.mockRestore();
    }
  });

  test("a later additional-authority resume does not reopen stale access previews", async () => {
    protectedAccessCheckpoint("once");
    const restoreApproval = mock(async (_request: unknown) => {
      throw new Error("additional-authority resume must not restore a preview");
    });
    const resume = { "additional-interrupt": { granted: true } };

    await runScopeSubagentUntilPause({
      ...baseOpts,
      parentTurnId: "task-run-1",
      taskRun: true,
      trustedExecutionEntrypoint: "background.task",
      currentTaskId: "task-1",
      currentTaskRunId: "task-run-1",
      causalHumanUserId: "owner-1",
      roomId: "room-1",
      callingRoomId: "room-1",
      approvalLaneKey: "task:task-1",
      subagentThreadId: "subagent:parent-thread:protected",
      taskRunCheckpointSaver: encryptedSaver(),
      protectedTaskTranscriptPort,
      protectedTaskMemoryHandoff: protectedMemoryHandoff(restoreApproval),
      resume,
    });

    expect(restoreApproval).not.toHaveBeenCalled();
    expect((capturedStreamInput as Command).resume).toEqual(resume);
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
      protectedTaskTranscriptPort,
    });

    expect(capturedCheckpointSaver).toBe(saver);
    expect(ordinaryAppendCalls).toBe(0);
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
      protectedTaskTranscriptPort,
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
