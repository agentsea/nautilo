import { describe, expect, test } from "bun:test";
import type { TaskCreateInput } from "@nautilo/runtime";
import {
  CLAUDE_CODE_HARNESS_ID,
  createClaudeHarnessTask,
  type CreateClaudeHarnessTaskInput,
  type ClaudeHarnessTaskDeps,
} from "../../src/claude/harness-task";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const PROFILE = "44444444-4444-4444-8444-444444444444";
const TASK = "55555555-5555-4555-8555-555555555555";

const request: CreateClaudeHarnessTaskInput = Object.freeze({
  ownerId: OWNER,
  requestorId: OWNER,
  agentId: AGENT,
  prompt: "Repair the room summary",
  callingRoomId: ROOM,
  harness: CLAUDE_CODE_HARNESS_ID,
  profileRef: PROFILE,
  catalogModelId: "claude-sonnet",
  selectedModel: "claude-sonnet-4",
});

const admitted = Object.freeze({
  profileRef: PROFILE,
  catalogModelId: "claude-sonnet",
  selectedModel: "claude-sonnet-4",
  scope: Object.freeze({
    relayId: "relay-1",
    relaySessionId: "session-1",
    desktopSessionId: "desktop-1",
    pairingGenerationRef: "pairing-1",
    selectedProtocolVersion: 18,
    capabilityRevision: 1,
  }),
});

type FixtureOptions = Readonly<{
  facts?: ClaudeHarnessTaskDeps["facts"];
  admit?: ClaudeHarnessTaskDeps["admission"]["admitExecution"];
  create?: ClaudeHarnessTaskDeps["createTask"];
}>;

function fixture(options: FixtureOptions = {}) {
  let admissionCalls = 0;
  let createCalls = 0;
  let created: TaskCreateInput | undefined;
  const deps: ClaudeHarnessTaskDeps = {
    facts: options.facts ?? {
      roomExists: async () => true,
      getAgentOwner: async () => OWNER,
      isAgentMember: async () => true,
    },
    admission: {
      admitExecution: async (ownerId, selection) => {
        admissionCalls += 1;
        if (options.admit) return options.admit(ownerId, selection);
        return admitted;
      },
    },
    createTask: async (input) => {
      createCalls += 1;
      created = input;
      if (options.create) return options.create(input);
      return { taskId: TASK, status: "pending", nextFireAt: new Date("2026-08-27T10:00:00.000Z") };
    },
  };
  return { deps, created: () => created, admissionCalls: () => admissionCalls, createCalls: () => createCalls };
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("createClaudeHarnessTask", () => {
  test("creates one explicit immediate same-Room ordinary Task with sealed Claude metadata", async () => {
    const h = fixture();
    expect(await createClaudeHarnessTask(h.deps, request)).toEqual({
      taskId: TASK,
      status: "pending",
      execution: "claude-code",
      model: { catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4" },
    });
    expect(h.created()).toEqual({
      ownerId: OWNER,
      requestorId: OWNER,
      agentId: AGENT,
      prompt: "Repair the room summary",
      scheduleKind: "now",
      targetChat: "last_in_namespace",
      targetRoomId: ROOM,
      callingRoomId: ROOM,
      targetUserIds: [OWNER],
      toolsMode: "none",
      toolsWhitelist: [],
      resultDelivery: "raw_and_wake",
      requestedModelId: null,
      metadata: {
        execution: {
          version: 1,
          harnessId: "claude-code",
          source: "genie",
          profileRef: PROFILE,
          catalogModelId: "claude-sonnet",
          selectedModel: "claude-sonnet-4",
        },
      },
    });
    const serialized = JSON.stringify(h.created()!.metadata);
    expect(serialized).not.toMatch(/relay|scope|session|path|readiness/i);
    expect(h.admissionCalls()).toBe(1);
    expect(h.createCalls()).toBe(1);
  });

  test("denies requestor, Room, Agent, and root-shape failures before controller admission or Task write", async () => {
    const initialFailures: readonly [string, CreateClaudeHarnessTaskInput, FixtureOptions][] = [
      ["foreign requestor", { ...request, requestorId: "66666666-6666-4666-8666-666666666666" }, {}],
      ["missing Room", request, { facts: { roomExists: async () => false, getAgentOwner: async () => OWNER, isAgentMember: async () => true } }],
      ["foreign Agent", request, { facts: { roomExists: async () => true, getAgentOwner: async () => "other", isAgentMember: async () => true } }],
      ["nonmember Agent", request, { facts: { roomExists: async () => true, getAgentOwner: async () => OWNER, isAgentMember: async () => false } }],
    ];
    for (const [name, input, options] of initialFailures) {
      const h = fixture(options);
      await expectFailure(createClaudeHarnessTask(h.deps, input), name === "missing Room" ? "CLAUDE_ROOM_UNAVAILABLE" : "CLAUDE_SOURCE_FORBIDDEN");
      expect(h.admissionCalls(), name).toBe(0);
      expect(h.createCalls(), name).toBe(0);
    }

    for (const invalid of [
      { ...request, parentTaskId: null },
      { ...request, depth: 0 },
      { ...request, targetRoomId: ROOM },
      { ...request, prompt: "x".repeat(16 * 1024 + 1) },
    ]) {
      const h = fixture();
      await expectFailure(createClaudeHarnessTask(h.deps, invalid as CreateClaudeHarnessTaskInput), "CLAUDE_HARNESS_UNAVAILABLE");
      expect(h.admissionCalls()).toBe(0);
      expect(h.createCalls()).toBe(0);
    }
  });

  test("rechecks Room membership after admission and rejects unavailable or mismatched admission without a write", async () => {
    let roomChecks = 0;
    const roomDrift = fixture({
      facts: {
        roomExists: async () => (roomChecks += 1) === 1,
        getAgentOwner: async () => OWNER,
        isAgentMember: async () => true,
      },
    });
    await expectFailure(createClaudeHarnessTask(roomDrift.deps, request), "CLAUDE_ROOM_UNAVAILABLE");
    expect(roomDrift.admissionCalls()).toBe(1);
    expect(roomDrift.createCalls()).toBe(0);

    let memberChecks = 0;
    const drift = fixture({
      facts: {
        roomExists: async () => true,
        getAgentOwner: async () => OWNER,
        isAgentMember: async () => (memberChecks += 1) === 1,
      },
    });
    await expectFailure(createClaudeHarnessTask(drift.deps, request), "CLAUDE_SOURCE_FORBIDDEN");
    expect(drift.admissionCalls()).toBe(1);
    expect(drift.createCalls()).toBe(0);

    for (const admit of [
      async () => null,
      async () => { throw new Error("controller unavailable"); },
      async () => ({ ...admitted, selectedModel: "other" }),
    ]) {
      const h = fixture({ admit });
      await expectFailure(createClaudeHarnessTask(h.deps, request), "CLAUDE_HARNESS_UNAVAILABLE");
      expect(h.admissionCalls()).toBe(1);
      expect(h.createCalls()).toBe(0);
    }
  });

  test("rejects malformed pending create results without claiming outward success", async () => {
    const results: readonly unknown[] = [
      { taskId: TASK, status: "pending", nextFireAt: undefined },
      { taskId: TASK, status: "pending", nextFireAt: new Date("invalid") },
      { taskId: TASK, status: "running", nextFireAt: new Date() },
      { taskId: TASK, status: "pending", nextFireAt: new Date(), extra: true },
      { taskId: TASK, status: "pending" },
    ];
    for (const result of results) {
      const h = fixture({ create: async () => result as ReturnType<ClaudeHarnessTaskDeps["createTask"]> extends Promise<infer Value> ? Value : never });
      await expectFailure(createClaudeHarnessTask(h.deps, request), "CLAUDE_HARNESS_UNAVAILABLE");
      expect(h.createCalls()).toBe(1);
    }
  });

  test("captures a valid direct DTO once before admission can observe later caller mutation", async () => {
    let promptReads = 0;
    const mutable = { ...request } as Record<string, unknown>;
    Object.defineProperty(mutable, "prompt", {
      enumerable: true,
      get: () => {
        promptReads += 1;
        return promptReads === 1 ? "Captured once" : "changed";
      },
    });
    const h = fixture();
    await createClaudeHarnessTask(h.deps, mutable as unknown as CreateClaudeHarnessTaskInput);
    expect(promptReads).toBe(1);
    expect(h.created()!.prompt).toBe("Captured once");
  });
});
