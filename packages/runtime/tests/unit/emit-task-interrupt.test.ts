import { describe, test, expect, mock } from "bun:test";
import type { LocalExecutionDelegation, ServerEvent } from "@nautilo/types";
import {
  buildTaskInterruptEvent,
  emitTaskInterruptEvent,
  patchTaskApprovalEvent,
  taskApprovalRecipient,
  replayTaskInterruptEvents,
  type TaskInterruptContext,
} from "../../src/tasks/emit-task-interrupt";

/**
 * Task/subagent approval interrupt surfacing. These assert the pure
 * mapping + patching contract (no DB, no graph): the executor's parked
 * interrupt becomes an owner-scoped, Task-tagged WS event the workbench can
 * route past active-room filtering, and the orphan `room`-verb strip (orphan Task).
 */

const baseCtx = (over: Partial<TaskInterruptContext> = {}): TaskInterruptContext => ({
  taskId: "task-1",
  taskRunId: "run-1",
  ownerId: "owner-1",
  graphThreadId: "subagent:thread-1",
  laneKey: "task:task-1",
  hasRoom: true,
  interrupt: {},
  ...over,
});

describe("emit-task-interrupt — buildTaskInterruptEvent", () => {
  test("approval_ask → owner-scoped, task-tagged approval.ask (room kept when hasRoom)", () => {
    const event = buildTaskInterruptEvent(
      baseCtx({
        interrupt: {
          type: "approval_ask",
          approvalId: "ap1",
          tools: [{ name: "run_shell", args: { cmd: "rm -rf x" } }],
          reason: "destructive",
          reasonCode: "destructive-tool",
          allowedVerbs: ["once", "room", "always", "deny"],
          userId: "owner-1",
        },
      }),
    );
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      type: "approval.ask",
      threadId: "subagent:thread-1",
      laneKey: "task:task-1",
      userId: "owner-1",
      taskId: "task-1",
      taskRunId: "run-1",
      origin: "task",
    });
    // hasRoom = true → `room` verb preserved.
    expect((event as Extract<ServerEvent, { type: "approval.ask" }>).allowedVerbs).toEqual([
      "once",
      "room",
      "always",
      "deny",
    ]);
  });

  test("orphan approval_ask (no room) drops the unpersistable `room` verb (orphan Task)", () => {
    const event = buildTaskInterruptEvent(
      baseCtx({
        hasRoom: false,
        interrupt: {
          type: "approval_ask",
          approvalId: "ap1",
          tools: [],
          reason: "destructive",
          reasonCode: "destructive-tool",
          allowedVerbs: ["once", "room", "always", "deny"],
        },
      }),
    );
    const ask = event as Extract<ServerEvent, { type: "approval.ask" }>;
    expect(ask.allowedVerbs).toEqual(["once", "always", "deny"]);
    expect(ask.origin).toBe("task");
  });

  test("prove_it_challenge → owner-scoped, task-tagged prove_it.challenge", () => {
    const event = buildTaskInterruptEvent(
      baseCtx({
        interrupt: {
          type: "prove_it_challenge",
          tools: [{ name: "run_shell", args: {} }],
          userId: "owner-1",
        },
      }),
    );
    expect(event).toMatchObject({
      type: "prove_it.challenge",
      userId: "owner-1",
      taskId: "task-1",
      taskRunId: "run-1",
      origin: "task",
    });
  });

  test("identity_challenge (enrollPin) → owner-scoped, task-tagged identity.challenge", () => {
    const event = buildTaskInterruptEvent(
      baseCtx({
        interrupt: {
          type: "identity_challenge",
          mode: "enrollPin",
          userId: "owner-1",
        },
      }),
    );
    expect(event).toMatchObject({
      type: "identity.challenge",
      mode: "enrollPin",
      userId: "owner-1",
      taskId: "task-1",
      taskRunId: "run-1",
      origin: "task",
    });
  });

  test("await_human_reply interrupt is NOT surfaced here (not an approval event)", () => {
    const event = buildTaskInterruptEvent(
      baseCtx({
        interrupt: {
          type: "await_human_reply",
          targetRoomId: "room-1",
          awaitingFromUserIds: ["owner-1"],
          ownerId: "owner-1",
        },
      }),
    );
    expect(event).toBeNull();
  });

  test("unknown / empty interrupt → null", () => {
    expect(buildTaskInterruptEvent(baseCtx({ interrupt: {} }))).toBeNull();
    expect(
      buildTaskInterruptEvent(baseCtx({ interrupt: { type: "nonsense" } })),
    ).toBeNull();
  });

  test("forces userId = ownerId even if the interrupt carried a different userId", () => {
    const event = buildTaskInterruptEvent(
      baseCtx({
        ownerId: "owner-1",
        interrupt: {
          type: "prove_it_challenge",
          tools: [],
          userId: "someone-else",
        },
      }),
    );
    expect((event as Extract<ServerEvent, { type: "prove_it.challenge" }>).userId).toBe(
      "owner-1",
    );
  });
});

describe("emit-task-interrupt — emitTaskInterruptEvent", () => {
  test("emits the patched event through the injected sink and returns it", () => {
    const emitted: ServerEvent[] = [];
    const event = emitTaskInterruptEvent(
      baseCtx({
        interrupt: {
          type: "approval_ask",
          approvalId: "ap1",
          tools: [],
          reason: "x",
          reasonCode: "destructive-tool",
          allowedVerbs: ["once", "room", "always", "deny"],
        },
      }),
      (e) => emitted.push(e),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe(event!);
    expect(emitted[0]).toMatchObject({ type: "approval.ask", origin: "task" });
  });

  test("does not emit for a non-approval interrupt", () => {
    const emitted: ServerEvent[] = [];
    const event = emitTaskInterruptEvent(
      baseCtx({ interrupt: { type: "await_human_reply", ownerId: "owner-1" } }),
      (e) => emitted.push(e),
    );
    expect(event).toBeNull();
    expect(emitted).toHaveLength(0);
  });
});

describe("emit-task-interrupt — patchTaskApprovalEvent (passthrough)", () => {
  test("non-approval-trio events are returned unchanged", () => {
    const ev: ServerEvent = {
      type: "task.completed",
      taskId: "task-1",
      taskRunId: "run-1",
      status: "completed",
      ownerId: "owner-1",
    };
    expect(
      patchTaskApprovalEvent(ev, {
        taskId: "task-1",
        taskRunId: "run-1",
        ownerId: "owner-1",
        hasRoom: true,
      }),
    ).toBe(ev);
  });
});

describe("pending Task attention replay", () => {
  test("rebuilds only approval-trio events with exact owner/task/run identity", async () => {
    const read = mock(async (): Promise<ServerEvent[]> => [
      {
        type: "approval.ask" as const,
        approvalId: "approval-1",
        threadId: "subagent:1",
        laneKey: "task:old",
        tools: [],
        reason: "Approval required",
        reasonCode: "destructive-tool" as const,
        allowedVerbs: ["once", "room", "deny"] as const,
      },
      {
        type: "task.progress" as const,
        taskId: "other",
        taskRunId: "other-run",
        ownerId: "owner-1",
        detail: "x",
      },
    ]);
    const events = await replayTaskInterruptEvents({
      taskId: "task-1",
      taskRunId: "run-1",
      ownerId: "owner-1",
      graphThreadId: "subagent:1",
      laneKey: "task:task-1",
      hasRoom: false,
    }, read);

    expect(read).toHaveBeenCalledWith("subagent:1", "task:task-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval.ask",
      approvalId: "approval-1",
      userId: "owner-1",
      taskId: "task-1",
      taskRunId: "run-1",
      origin: "task",
      laneKey: "task:old",
      allowedVerbs: ["once", "deny"],
    });
  });

  test("preserves canonical prove-it identity and projection expiry from checkpoint replay", async () => {
    const read = mock(async (): Promise<ServerEvent[]> => [{
      type: "prove_it.challenge",
      challengeId: "interrupt-exact",
      threadId: "subagent:1",
      laneKey: "task:old",
      tools: [{
        id: "tool-1",
        name: "share_memory",
        args: { mode: "project" },
        shareMemoryPreview: {
          memoryContentSnippet: "summary",
          memoryType: "fact",
          roomLabel: "Team",
          sensitivity: "sensitive",
          targetDisplayName: "Team",
          targetHandle: "@team",
          wouldCreate: true,
          projection: {
            audienceWarning: "Shared with Team",
            content: "sanitized",
            expiresAt: 1234,
            memberCount: 2,
            mode: "project",
            roomKind: "group",
            roomLabel: "Team",
          },
        },
      }],
    }]);
    const [event] = await replayTaskInterruptEvents({
      taskId: "task-1",
      taskRunId: "run-1",
      ownerId: "owner-1",
      graphThreadId: "subagent:1",
      laneKey: "task:task-1",
      hasRoom: true,
    }, read);

    expect(event).toMatchObject({
      type: "prove_it.challenge",
      challengeId: "interrupt-exact",
      taskId: "task-1",
      taskRunId: "run-1",
      origin: "task",
      tools: [{ shareMemoryPreview: { projection: { expiresAt: 1234 } } }],
    });
  });
});


test("canonical delegated recipient routes approval, PIN and replay without changing management owner", async () => {
  const delegation = {
    version: 1, humanUserId: "requestor", agentId: "agent", sourceRoomId: "room", sourceConversationId: "thread",
    rootTaskId: "task", target: { instanceId: "", relayId: "relay", pairingGeneration: "pair", serverOrigin: "https://server.invalid", serverFingerprint: "fingerprint" },
    projectGrantId: "project", ceiling: "basic", profile: null,
  } satisfies LocalExecutionDelegation;
  const task = { ownerId: "owner", requestorId: "requestor", agentId: "agent", localExecutionDelegation: delegation };
  expect(taskApprovalRecipient(task)).toBe("requestor");
  expect(taskApprovalRecipient({ ...task, localExecutionDelegation: null })).toBe("owner");
  const recipientForPersistedValue = (localExecutionDelegation: unknown) => taskApprovalRecipient({
    ...task,
    // Persisted JSON may be malformed despite the statically typed DB row.
    localExecutionDelegation,
  } as unknown as Parameters<typeof taskApprovalRecipient>[0]);
  for (const localExecutionDelegation of [{}, { ...delegation, humanUserId: "owner" }, { ...delegation, agentId: "other" }]) {
    expect(recipientForPersistedValue(localExecutionDelegation)).toBeNull();
  }
  const ctx = baseCtx({ ownerId: task.ownerId, approvalRecipientId: taskApprovalRecipient(task)! });
  for (const interrupt of [{ type: "approval_ask", approvalId: "ask", tools: [], allowedVerbs: ["once", "deny"], reason: "Review" },
    { type: "prove_it_challenge", tools: [], challengeId: "proof" }, { type: "identity_challenge", mode: "enrollPin" }]) {
    expect(buildTaskInterruptEvent({ ...ctx, interrupt })).toMatchObject({ userId: task.requestorId, origin: "task" });
  }
  const { approvalRecipientId, ...legacyCtx } = ctx;
  expect(approvalRecipientId).toBe(task.requestorId);
  const events = await replayTaskInterruptEvents(ctx, async () => [buildTaskInterruptEvent({ ...legacyCtx,
    interrupt: { type: "identity_challenge", mode: "enrollPin" } })!]);
  expect(events).toMatchObject([{ userId: task.requestorId }]);
  expect(ctx.ownerId).toBe("owner");
});


test("invalid canonical delegated recipients cannot fall back to management-owner events", async () => {
  const ctx = baseCtx({ approvalRecipientId: null, interrupt: { type: "identity_challenge", mode: "enrollPin" } });
  expect(buildTaskInterruptEvent(ctx)).toBeNull();
  const emit = mock(() => {}); expect(emitTaskInterruptEvent(ctx, emit)).toBeNull(); expect(emit).not.toHaveBeenCalled();
  const read = mock(async () => [] as ServerEvent[]);
  expect(await replayTaskInterruptEvents(ctx, read)).toEqual([]); expect(read).not.toHaveBeenCalled();
  expect(() => patchTaskApprovalEvent({ type: "identity.challenge", mode: "enrollPin", challengeId: "challenge",
    expiresAt: "2099-01-01T00:00:00.000Z", threadId: "thread", laneKey: "task:task-1", userId: "owner" }, ctx))
    .toThrow("recipient unavailable");
});
