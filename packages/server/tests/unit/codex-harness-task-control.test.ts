import { describe, expect, test } from "bun:test";
import { HarnessControlPlane } from "@nautilo/runtime";
import {
  CodexHarnessTaskControlFailure,
  steerCodexHarnessTask,
} from "../../src/codex/harness-task-control";
import {
  CODEX_HARNESS_DESCRIPTOR,
} from "../../src/codex/harness-driver";

const task = {
  id: "task",
  ownerId: "owner",
  requestorId: "owner",
  agentId: "agent",
  parentTaskId: null,
  callingRoomId: "room",
  targetRoomId: "room",
  prompt: "Work",
  requestedModelId: null,
  metadata: {
    execution: {
      version: 1,
      harnessId: "codex",
      source: "genie",
      collaborationMode: "work",
      harnessModelId: "gpt-5.6-sol",
      readiness: {
        relayId: "relay",
        pairingGenerationRef: "pairing-1",
        capabilityRevision: 4,
      },
    },
  },
};

function harness(options: { active?: boolean; steer?: boolean } = {}) {
  const steers: unknown[] = [];
  const execution = {
    async *start() {},
    ...(options.steer === false
      ? {}
      : {
          async steer(input: unknown) {
            steers.push(input);
          },
        }),
  };
  const controlPlane = new HarnessControlPlane([{
    descriptor: CODEX_HARNESS_DESCRIPTOR,
    createDriver: () => ({
      execution,
      probeCapabilities: () => Promise.resolve({
        execution: "supported" as const,
        steer: options.steer === false ? "unsupported" as const : "supported" as const,
      }),
    }),
  }]);
  return {
    deps: {
      tasks: { getTask: async () => task },
      controlPlane,
      execution: {
        activeTurnForTask: () => options.active === false
          ? null
          : {
              bindingId: "binding",
              bindingGeneration: "1",
              vendorSessionId: "thread",
              vendorTurnId: "turn",
            },
      },
    },
    steers,
  };
}

describe("steerCodexHarnessTask", () => {
  test("constructs one exact driver steer from server-resolved Task authority", async () => {
    const h = harness();
    const result = await steerCodexHarnessTask(h.deps, {
      taskId: "task",
      ownerId: "owner",
      agentId: "agent",
      roomId: "room",
      text: "Focus on the failure",
    });
    expect(result).toEqual({ ok: true, status: "steered" });
    expect(h.steers).toEqual([{
      bindingId: "binding",
      bindingGeneration: "1",
      vendorSessionId: "thread",
      vendorTurnId: "turn",
      text: "Focus on the failure",
    }]);
  });

  test("fails closed for foreign Task authority, no active turn, and unsupported steer", async () => {
    const foreign = harness();
    foreign.deps.tasks.getTask = async () => ({ ...task, ownerId: "other" });
    await expectFailure(steerCodexHarnessTask(foreign.deps, {
      taskId: "task", ownerId: "owner", agentId: "agent", roomId: "room", text: "x",
    }), "CODEX_TASK_FORBIDDEN");

    const inactive = harness({ active: false });
    await expectFailure(steerCodexHarnessTask(inactive.deps, {
      taskId: "task", ownerId: "owner", agentId: "agent", roomId: "room", text: "x",
    }), "CODEX_TURN_UNAVAILABLE");

    const unsupported = harness({ steer: false });
    await expectFailure(steerCodexHarnessTask(unsupported.deps, {
      taskId: "task", ownerId: "owner", agentId: "agent", roomId: "room", text: "x",
    }), "CODEX_STEER_UNAVAILABLE");
  });
});

async function expectFailure(
  promise: Promise<unknown>,
  code: CodexHarnessTaskControlFailure["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexHarnessTaskControlFailure);
    expect((error as CodexHarnessTaskControlFailure).code).toBe(code);
  }
}
