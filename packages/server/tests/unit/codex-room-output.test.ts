import { describe, expect, test } from "bun:test";
import type { AIMessage } from "@langchain/core/messages";
import { appendTranscriptMessages } from "@nautilo/agent";
import type { HarnessExecutionOutput, TaskExecutionRouteFacts } from "@nautilo/runtime";
import {
  CodexRoomOutputProjector,
} from "../../src/codex/room-output";

const facts: TaskExecutionRouteFacts = {
  taskId: "11111111-1111-4111-8111-111111111111",
  taskRunId: "22222222-2222-4222-8222-222222222222",
  parentTaskId: null,
  ownerId: "33333333-3333-4333-8333-333333333333",
  requestorId: "33333333-3333-4333-8333-333333333333",
  agentId: "44444444-4444-4444-8444-444444444444",
  roomId: "55555555-5555-4555-855555555555",
  laneKey: "task:11111111-1111-4111-8111-111111111111",
  graphThreadId: "room:55555555-5555-4555-855555555555:bot:44444444-4444-4444-8444-444444444444",
};

const context = { jobId: "job-1", laneKey: facts.laneKey, facts } as const;

function completion(itemId = "item-1", text = "Authoritative answer") {
  return {
    kind: "assistant_completed",
    text,
    attribution: {
      bindingId: "binding-1",
      bindingGeneration: "7",
      taskId: facts.taskId,
      roomId: facts.roomId,
      vendorSessionId: "thread-1",
      vendorTurnId: "turn-1",
      vendorItemId: itemId,
    },
  } as const satisfies Extract<HarnessExecutionOutput, { readonly kind: "assistant_completed" }>;
}

function delta(text = "provisional"): HarnessExecutionOutput {
  return {
    kind: "output_delta",
    text,
    attribution: { ...completion().attribution, vendorItemId: "item-1" },
  };
}

function terminal(): HarnessExecutionOutput {
  return {
    kind: "terminal",
    status: "completed",
    attribution: { ...completion().attribution, vendorItemId: null },
  };
}

function progress(kind: "progress" | "command_summary" | "patch_summary"): HarnessExecutionOutput {
  const attribution = { ...completion().attribution, vendorItemId: null };
  if (kind === "progress") {
    return { kind, message: "Codex thinking", attribution };
  }
  if (kind === "command_summary") {
    return {
      kind,
      commands: [{ summary: "rg -n TODO", status: "completed" }],
      attribution,
    };
  }
  return { kind, files: [], summary: "Updated two files", attribution };
}

function commandRequest(): HarnessExecutionOutput {
  return {
    kind: "command_approval_required",
    requestId: "request-ref",
    vendorRequestId: "native-id-must-not-leave-server",
    ownerId: facts.ownerId,
    expiresAt: "2026-07-29T12:00:00.000Z",
    attribution: { ...completion().attribution, vendorItemId: null },
    options: ["approve", "deny"],
    reason: "host_local_only",
    command: { detail: "host_local_only", actionKinds: ["search"] },
  };
}

function userInputRequest(multiSelect = false): HarnessExecutionOutput {
  return {
    kind: "user_input_required",
    requestId: "input-request-ref",
    vendorRequestId: null,
    ownerId: facts.ownerId,
    expiresAt: "2099-07-29T12:00:00.000Z",
    attribution: { ...completion().attribution, vendorItemId: "input-item" },
    questions: [{
      id: "target",
      header: "Target",
      prompt: "Which target?",
      secret: false,
      multiSelect,
      allowOther: true,
      options: [{ id: "tests", label: "Tests", description: null }],
    }],
    autoResolutionMs: 10_000,
  };
}

function fakeAppend(input: {
  readonly insertedRows?: Array<{
    id: string;
    role: string;
    content: string;
    fingerprint: string | null;
    replyToMessageId: number | null;
  }>;
  readonly throw?: Error;
}) {
  const calls: Array<{
    readonly threadId: string;
    readonly ownerId: string;
    readonly personaId: string;
    readonly message: AIMessage;
    readonly options: { readonly agentId?: string; readonly roomId?: string };
  }> = [];
  const append = (async (...args: Parameters<typeof appendTranscriptMessages>) => {
    if (input.throw) throw input.throw;
    calls.push({
      threadId: args[0],
      ownerId: args[1],
      personaId: args[2],
      message: args[3][0] as AIMessage,
      options: args[4] ?? {},
    });
    return {
      failedIndices: [],
      insertedCount: input.insertedRows?.length ?? 0,
      insertedRows: input.insertedRows ?? [],
    };
  }) as typeof appendTranscriptMessages;
  return { append, calls };
}

describe("CodexRoomOutputProjector", () => {
  test("commits answer-free input facts before it projects an actionable owner event", async () => {
    const order: string[] = [];
    const subject = new CodexRoomOutputProjector({
      append: fakeAppend({}).append,
      persistUserInputRequest: async (input) => {
        order.push("persist");
        expect(input).toMatchObject({
          requestRef: "input-request-ref",
          userId: facts.ownerId,
          sourceAgentId: facts.agentId,
          taskId: facts.taskId,
          taskRunId: facts.taskRunId,
          jobId: "job-1",
          bindingId: "binding-1",
          bindingGeneration: 7,
          codexThreadId: "thread-1",
          codexTurnId: "turn-1",
          codexItemId: "input-item",
          questions: [{ question: "Which target?", isOther: true, isSecret: false }],
        });
        expect(JSON.stringify(input)).not.toContain("answer");
        return { status: "created", state: "awaiting_human" };
      },
    });

    const event = await subject.project(userInputRequest(), context);

    order.push("event");
    expect(order).toEqual(["persist", "event"]);
    expect(event).toMatchObject({
      type: "codex.request",
      requestId: "input-request-ref",
      request: { kind: "user_input_required" },
    });
  });

  test("suppresses input cards when the durable binding fact is stale or conflicts", async () => {
    for (const status of ["stale_binding", "conflict", "expired"] as const) {
      const subject = new CodexRoomOutputProjector({
        append: fakeAppend({}).append,
        persistUserInputRequest: async () => ({ status }),
      });
      expect(await subject.project(userInputRequest(), context)).toBeNull();
    }
  });

  test("replayed user-input frames remain actionable only for an existing awaiting fact", async () => {
    for (const [status, state, expected] of [
      ["existing", "awaiting_human", true],
      ["existing", "submitted", false],
      ["existing", "unavailable", false],
      ["existing", "terminal", false],
    ] as const) {
      const subject = new CodexRoomOutputProjector({
        append: fakeAppend({}).append,
        persistUserInputRequest: async () => ({ status, state }),
      });
      const event = await subject.project(userInputRequest(), context);
      expect(event !== null).toBe(expected);
    }
  });

  test("keeps durable input bytes unchanged but projects Claude input live without persistence", async () => {
    let durablePersisted = false;
    const durable = new CodexRoomOutputProjector({
      append: fakeAppend({}).append,
      persistUserInputRequest: async () => {
        durablePersisted = true;
        return { status: "created", state: "awaiting_human" };
      },
    });
    const durableEvent = await durable.project(userInputRequest(false), context);
    expect(durableEvent).toMatchObject({ request: { kind: "user_input_required", questions: [{ id: "target" }] } });
    expect((durableEvent as { request: { questions: readonly Record<string, unknown>[] } }).request.questions[0]).not.toHaveProperty("multiSelect");
    expect(durablePersisted).toBe(true);
    expect(await new CodexRoomOutputProjector({ append: fakeAppend({}).append }).project(userInputRequest(), context)).toBeNull();

    let persisted = false;
    const ephemeral = new CodexRoomOutputProjector({
      append: fakeAppend({}).append,
      requestMode: "ephemeral",
      persistUserInputRequest: async () => { persisted = true; return { status: "created", state: "awaiting_human" }; },
    });
    const event = await ephemeral.project(userInputRequest(true), context);
    expect(event).toMatchObject({ request: { kind: "user_input_required", questions: [{ multiSelect: true }] } });
    expect(persisted).toBe(false);
  });

  test("projects semantic permission selection without a durable input fact", async () => {
    const subject = new CodexRoomOutputProjector({ requestMode: "ephemeral", append: fakeAppend({}).append });
    const event = await subject.project({
      kind: "permission_selection_required",
      detail: { state: "shown", text: "Read\n/workspace/example.txt" },
      requestId: "permission-ref",
      vendorRequestId: "desktop-ref",
      ownerId: facts.ownerId,
      expiresAt: null,
      attribution: { ...completion().attribution, vendorItemId: "desktop-ref" },
      options: [{ id: "allow_once", label: "Allow once", semanticHint: null }, { id: "deny", label: "Deny", semanticHint: null }],
      tool: { title: "Read", kind: null },
    }, context);
    expect(event).toEqual({
      type: "codex.request", ownerId: facts.ownerId, requestId: "permission-ref", taskId: facts.taskId,
      jobId: "job-1", roomId: facts.roomId, expiresAt: null,
      request: {
        kind: "permission_selection_required",
        detail: { state: "shown", text: "Read\n/workspace/example.txt" },
        options: [{ id: "allow_once", label: "Allow once", semanticHint: null }, { id: "deny", label: "Deny", semanticHint: null }],
        tool: { title: "Read", kind: null },
      },
    });
    expect(await new CodexRoomOutputProjector({ append: fakeAppend({}).append }).project({
      kind: "permission_selection_required",
      requestId: "permission-ref",
      vendorRequestId: "desktop-ref",
      ownerId: facts.ownerId,
      expiresAt: null,
      attribution: { ...completion().attribution, vendorItemId: "desktop-ref" },
      options: [{ id: "allow_once", label: "Allow once", semanticHint: null }],
      tool: { title: "Read", kind: null },
    }, context)).toBeNull();
  });

  test("projects native requests as owner-private semantic events without host/vendor detail", async () => {
    const fake = fakeAppend({});
    const subject = new CodexRoomOutputProjector({ append: fake.append });

    const event = await subject.project(commandRequest(), context);

    expect(event).toEqual({
      type: "codex.request",
      ownerId: facts.ownerId,
      requestId: "request-ref",
      taskId: facts.taskId,
      jobId: "job-1",
      roomId: facts.roomId,
      expiresAt: "2026-07-29T12:00:00.000Z",
      request: {
        kind: "command_approval_required",
        options: ["approve", "deny"],
        reason: "host_local_only",
        command: { detail: "host_local_only", actionKinds: ["search"] },
      },
    });
    expect(JSON.stringify(event)).not.toContain("native-id-must-not-leave-server");
    expect(fake.calls).toEqual([]);
  });

  test("projects provisional response deltas to one append-only owner-private activity", async () => {
    const fake = fakeAppend({});
    const subject = new CodexRoomOutputProjector({ append: fake.append });

    expect(await subject.project(delta("Hello "), context)).toMatchObject({
      type: "task.progress",
      taskId: facts.taskId,
      taskRunId: facts.taskRunId,
      detail: "Writing response",
      ownerId: facts.ownerId,
      activity: {
        id: "item-1",
        kind: "status",
        name: "assistant_response",
        status: "running",
        args: {},
        result: "Hello ",
        appendResult: true,
        appendResultSeparator: "",
      },
    });
    expect(await subject.project(delta("world"), context)).toMatchObject({
      type: "task.progress",
      activity: { id: "item-1", result: "world" },
    });
    expect(await subject.project(terminal(), context)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  test("uses one stable provider-neutral response identity when Claude has no item id", async () => {
    const subject = new CodexRoomOutputProjector();
    const attribution = {
      ...completion().attribution,
      vendorSessionId: "claude-execution-1",
      vendorTurnId: null,
      vendorItemId: null,
    };
    const first = await subject.project({ kind: "output_delta", text: "Hello ", attribution }, context);
    const second = await subject.project({ kind: "output_delta", text: "world", attribution }, context);
    expect(first).toMatchObject({ detail: "Writing response", activity: { id: "claude-execution-1:turn:response", name: "assistant_response", appendResult: true, appendResultSeparator: "" } });
    expect(second).toMatchObject({ activity: { id: "claude-execution-1:turn:response", name: "assistant_response" } });
  });

  test("projects bounded semantic harness activity onto the owner-private Task lane", async () => {
    const fake = fakeAppend({});
    const subject = new CodexRoomOutputProjector({ append: fake.append });

    expect(await subject.project(progress("progress"), context)).toMatchObject({
      type: "task.progress",
      taskId: facts.taskId,
      taskRunId: facts.taskRunId,
      detail: "Codex thinking",
      ownerId: facts.ownerId,
      activity: {
        id: "turn-1:status",
        kind: "status",
        name: "harness_status",
        status: "running",
        args: { detail: "Codex thinking" },
      },
    });
    expect(await subject.project(progress("command_summary"), context)).toMatchObject({
      type: "task.progress",
      detail: "rg -n TODO",
    });
    expect(await subject.project(progress("patch_summary"), context)).toMatchObject({
      type: "task.progress",
      detail: "Updated two files",
    });
    expect(fake.calls).toEqual([]);
  });

  test("keeps a bounded process-local activity snapshot for the exact calling Room", async () => {
    const subject = new CodexRoomOutputProjector({ append: fakeAppend({}).append });
    for (let index = 0; index < 24; index += 1) {
      await subject.project({
        kind: "command_summary",
        attribution: { ...completion().attribution, vendorItemId: `command-${index}` },
        commands: [{ summary: `Command completed\ncommand-${index}\n${"x".repeat(4_000)}`, status: "completed" }],
      }, context);
    }
    const snapshot = subject.inspectLiveActivity({
      taskId: facts.taskId,
      ownerId: facts.ownerId,
      agentId: facts.agentId,
      roomId: facts.roomId,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.taskRunId).toBe(facts.taskRunId);
    expect(snapshot?.jobId).toBe("job-1");
    expect(snapshot?.activity.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(snapshot?.activity), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(subject.inspectLiveActivity({
      taskId: facts.taskId,
      ownerId: facts.ownerId,
      agentId: facts.agentId,
      roomId: "another-room",
    })).toBeNull();
  });

  test("retains only the newest in-flight activity without fabricating a terminal frame", async () => {
    const subject = new CodexRoomOutputProjector({ append: fakeAppend({}).append });
    for (const itemId of ["one", "two"] as const) {
      await subject.project({
        kind: "command_summary",
        attribution: { ...completion().attribution, vendorItemId: itemId },
        commands: [{ summary: `Command running\n${itemId}`, status: "running" }],
      }, context);
    }
    const activity = subject.inspectLiveActivity({
      taskId: facts.taskId,
      ownerId: facts.ownerId,
      agentId: facts.agentId,
      roomId: facts.roomId,
    })?.activity ?? [];
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ id: "two", status: "running" });
  });

  test("evicts the least-recent task snapshot after 100 tasks without a timer", async () => {
    const subject = new CodexRoomOutputProjector({ append: fakeAppend({}).append });
    for (let index = 0; index < 101; index += 1) {
      const taskId = `task-${index}`;
      const taskContext = {
        ...context,
        jobId: `job-${index}`,
        facts: { ...facts, taskId, taskRunId: `run-${index}` },
      };
      const output = {
        kind: "progress" as const,
        message: `Codex ${index}`,
        attribution: { ...completion().attribution, taskId },
      } satisfies Extract<HarnessExecutionOutput, { readonly kind: "progress" }>;
      await subject.project(output, taskContext);
    }
    expect(subject.inspectLiveActivity({
      taskId: "task-0", ownerId: facts.ownerId, agentId: facts.agentId, roomId: facts.roomId,
    })).toBeNull();
    expect(subject.inspectLiveActivity({
      taskId: "task-100", ownerId: facts.ownerId, agentId: facts.agentId, roomId: facts.roomId,
    })).toMatchObject({ taskRunId: "run-100", jobId: "job-100" });
  });

  test("resets activity when the same Task receives a replacement TaskRun/job", async () => {
    const subject = new CodexRoomOutputProjector({ append: fakeAppend({}).append });
    await subject.project({
      kind: "command_summary",
      attribution: { ...completion().attribution, vendorItemId: "old-command" },
      commands: [{ summary: "Command running\nold", status: "running" }],
    }, context);
    const replacement = {
      ...context,
      jobId: "job-2",
      facts: { ...facts, taskRunId: "replacement-run" },
    };
    await subject.project({
      kind: "command_summary",
      attribution: { ...completion().attribution, vendorItemId: "new-command" },
      commands: [{ summary: "Command running\nnew", status: "running" }],
    }, replacement);
    const snapshot = subject.inspectLiveActivity({
      taskId: facts.taskId, ownerId: facts.ownerId, agentId: facts.agentId, roomId: facts.roomId,
    });
    expect(snapshot).toMatchObject({ taskRunId: "replacement-run", jobId: "job-2" });
    expect(snapshot?.activity).toMatchObject([{ id: "new-command" }]);
  });

  test("strictly bounds one pathological semantic activity including args and JSON overhead", async () => {
    const subject = new CodexRoomOutputProjector({ append: fakeAppend({}).append });
    await subject.project({
      kind: "command_summary",
      attribution: { ...completion().attribution, vendorItemId: "pathological" },
      commands: [{
        summary: `Command running\n${"a".repeat(100_000)}\n${"b".repeat(100_000)}`,
        status: "running",
      }],
    }, context);
    const activity = subject.inspectLiveActivity({
      taskId: facts.taskId, ownerId: facts.ownerId, agentId: facts.agentId, roomId: facts.roomId,
    })?.activity ?? [];
    expect(activity).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(activity), "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  test("persists completed harness activity into the existing subagent transcript", async () => {
    const fake = fakeAppend({});
    const subject = new CodexRoomOutputProjector({ append: fake.append });
    const output: HarnessExecutionOutput = {
      kind: "command_summary",
      attribution: { ...completion().attribution, vendorItemId: "command-1" },
      commands: [{
        summary: "Command completed\nbun test\ncwd: /workspace\nexit: 0",
        status: "completed",
      }],
    };

    const event = await subject.project(output, context);

    expect(event).toMatchObject({
      type: "task.progress",
      activity: {
        id: "command-1",
        name: "run_command",
        status: "completed",
      },
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      threadId: facts.graphThreadId,
      ownerId: facts.ownerId,
      options: {
        agentId: facts.agentId,
        roomId: facts.roomId,
      },
    });
    expect(fake.calls[0]?.message).toMatchObject({
      name: "run_command",
      tool_call_id: `harness:${facts.taskRunId}:command-1`,
      content: "Harness run_command completed.",
    });
  });

  test("keeps bounded secret-shaped command output in the Human event only", async () => {
    const fake = fakeAppend({});
    const subject = new CodexRoomOutputProjector({ append: fake.append });
    const secret = "sk_live_51NautiloDoNotPersist";
    const event = await subject.project({
      kind: "command_summary",
      attribution: { ...completion().attribution, vendorItemId: "secret-command" },
      commands: [{
        summary: `Command completed\nprintenv\n${secret}`,
        status: "completed",
      }],
    }, context);

    // The owner-private task.progress event remains the bounded Human UI lane.
    expect(event).toMatchObject({ type: "task.progress" });
    if (event === null || event.type !== "task.progress") throw new Error("expected task progress event");
    expect(event.detail).toContain(secret);
    const inspection = subject.inspectLiveActivity({
      taskId: facts.taskId,
      ownerId: facts.ownerId,
      agentId: facts.agentId,
      roomId: facts.roomId,
    });
    expect(JSON.stringify(inspection)).not.toContain(secret);
    expect(inspection?.activity).toMatchObject([{
      id: "secret-command",
      name: "run_command",
      status: "completed",
      args: {},
    }]);
    expect(inspection?.activity[0]).not.toHaveProperty("result");
    expect(inspection?.activity[0]).not.toHaveProperty("appendResult");
    expect(JSON.stringify(fake.calls)).not.toContain(secret);
    expect(fake.calls[0]?.message).toMatchObject({
      content: "Harness run_command completed.",
    });
  });

  test("keeps streamed command output from replacing the command arguments", async () => {
    const fake = fakeAppend({});
    const subject = new CodexRoomOutputProjector({ append: fake.append });
    const output: HarnessExecutionOutput = {
      kind: "command_summary",
      attribution: { ...completion().attribution, vendorItemId: "command-1" },
      commands: [{
        summary: "Command output\nstreamed stdout",
        status: "running",
      }],
    };

    expect(await subject.project(output, context)).toMatchObject({
      type: "task.progress",
      activity: {
        id: "command-1",
        name: "run_command",
        status: "running",
        args: {},
        appendResult: true,
      },
    });
  });

  test("leaves authoritative assistant delivery to canonical Task report-back", async () => {
    const fake = fakeAppend({});
    const subject = new CodexRoomOutputProjector({ append: fake.append });

    expect(await subject.project(completion(), context)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

});
