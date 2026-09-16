import { describe, expect, test } from "bun:test";
import {
  ClaudeHarnessTaskControlFailure,
  steerClaudeHarnessTask,
} from "../../src/claude/harness-task-control";

const task = {
  id: "task", ownerId: "owner", requestorId: "owner", agentId: "agent", parentTaskId: null,
  callingRoomId: "room", targetRoomId: "room", prompt: "Work",
  metadata: { execution: {
    version: 1, harnessId: "claude-code", source: "genie", profileRef: "profile", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4",
  } },
};

function harness(options: { active?: boolean; reject?: boolean } = {}) {
  const calls: unknown[] = [];
  return {
    deps: {
      tasks: { getTask: async () => task },
      execution: {
        async steerActiveTask(input: unknown) {
          calls.push(input);
          if (options.reject) throw new Error("provider rejected");
          return options.active !== false;
        },
      },
    },
    calls,
  };
}

const input = { taskId: "task", ownerId: "owner", agentId: "agent", roomId: "room", text: "Change direction" } as const;

describe("steerClaudeHarnessTask", () => {
  test("re-derives exact Task authority and sealed Claude admission before one steer", async () => {
    const h = harness();
    expect(await steerClaudeHarnessTask(h.deps, input)).toEqual({ ok: true, status: "steered" });
    expect(h.calls).toEqual([{
      taskId: "task", ownerId: "owner", roomId: "room", profileRef: "profile",
      catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4", text: "Change direction",
    }]);
  });

  test("fails closed for every Task authority mismatch and near-match harness metadata", async () => {
    const variants = [
      { ownerId: "other" }, { requestorId: "other" }, { agentId: "other" }, { parentTaskId: "parent" },
      { callingRoomId: "other" }, { targetRoomId: "other" },
      { metadata: { execution: { ...task.metadata.execution, harnessId: "codex" } } },
      { metadata: { execution: { ...task.metadata.execution, selectedModel: "" } } },
    ];
    for (const variant of variants) {
      const h = harness();
      h.deps.tasks.getTask = async () => ({ ...task, ...variant } as never);
      await expectFailure(steerClaudeHarnessTask(h.deps, input), "CLAUDE_TASK_FORBIDDEN");
      expect(h.calls).toEqual([]);
    }
  });

  test("rejects a missing persisted Task before any execution lookup", async () => {
    const h = harness();
    h.deps.tasks.getTask = (async () => null) as never;
    await expectFailure(steerClaudeHarnessTask(h.deps, input), "CLAUDE_TASK_FORBIDDEN");
    expect(h.calls).toEqual([]);
  });

  test("maps inactive execution and provider rejection without starting or retrying a turn", async () => {
    const inactive = harness({ active: false });
    await expectFailure(steerClaudeHarnessTask(inactive.deps, input), "CLAUDE_TURN_UNAVAILABLE");
    expect(inactive.calls).toHaveLength(1);

    const rejected = harness({ reject: true });
    await expectFailure(steerClaudeHarnessTask(rejected.deps, input), "CLAUDE_STEER_UNAVAILABLE");
    expect(rejected.calls).toHaveLength(1);
  });
});

async function expectFailure(promise: Promise<unknown>, code: ClaudeHarnessTaskControlFailure["code"]): Promise<void> {
  try {
    await promise;
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHarnessTaskControlFailure);
    expect((error as ClaudeHarnessTaskControlFailure).code).toBe(code);
  }
}
