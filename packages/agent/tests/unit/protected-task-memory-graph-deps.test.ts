import { describe, expect, test } from "bun:test";
import type { NautiloState } from "../../src/agent/state";
import {
  createProtectedTaskMemoryGraphDeps,
  type ProtectedTaskMemoryGraphHandoff,
  type ProtectedTaskMemoryGraphIdentity,
} from "../../src/subagents/protected-task-memory-graph-deps";

const TASK_ID = "task-1";
const RUN_ID = "run-1";
const THREAD_ID = "subagent:task:task-1:run-1";
const OWNER_ID = "owner-1";
const AGENT_ID = "agent-1";
const ROOM_ID = "room-1";
const NAMESPACE_ID = "namespace-1";
const TURN_ID = "turn-1";

const unavailable = async () => Object.freeze({
  status: "unavailable" as const,
  reason: "authorization_required" as const,
});

function handoff(
  fullEncryptionOnly = false,
): ProtectedTaskMemoryGraphHandoff {
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
    fullEncryptionOnly,
  });
}

function identity(): ProtectedTaskMemoryGraphIdentity {
  return Object.freeze({
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    graphThreadId: THREAD_ID,
    ownerId: OWNER_ID,
    causalHumanUserId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    callingRoomId: ROOM_ID,
    turnId: TURN_ID,
    approvalLaneKey: `task:${TASK_ID}`,
    actorRole: "owner",
    envelope: Object.freeze({
      memoryMode: "namespace" as const,
      ownerId: OWNER_ID,
      actorId: "actor-1",
      agentId: AGENT_ID,
      roomId: "memory-room-1",
      readableNamespaces: [NAMESPACE_ID],
      mutableNamespaces: [NAMESPACE_ID],
      writableNamespaces: [NAMESPACE_ID],
      toolPolicy: { search_memory: "allow" as const },
    }),
  });
}

function state(): NautiloState {
  const expected = identity();
  return {
    taskRun: true,
    subagentRun: true,
    trustedExecutionEntrypoint: "background.task",
    currentTaskId: TASK_ID,
    currentTaskRunId: RUN_ID,
    currentThreadId: THREAD_ID,
    langgraphThreadId: THREAD_ID,
    userId: OWNER_ID,
    causalHumanUserId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    callingRoomId: ROOM_ID,
    turnId: TURN_ID,
    approvalLaneKey: `task:${TASK_ID}`,
    actorRole: "owner",
    verifiedOrdinaryOrigin: null,
    memoryBrief: "",
    memoryDelta: "",
    memoryAccessEnvelope: {
      ...expected.envelope,
      readableNamespaces: [NAMESPACE_ID],
      mutableNamespaces: [NAMESPACE_ID],
      writableNamespaces: [NAMESPACE_ID],
      toolPolicy: { search_memory: "allow" },
    },
  } as unknown as NautiloState;
}

describe("protected Task Memory graph handoff", () => {
  test("leaves an ordinary graph unchanged when no handoff is supplied", () => {
    expect(createProtectedTaskMemoryGraphDeps({
      ...identity(),
      taskId: "",
      envelope: {
        memoryMode: "scope",
        ownerId: OWNER_ID,
        actorId: "actor-1",
        agentId: AGENT_ID,
        roomId: "scope-room-1",
        scopeId: "scope-1",
        toolPolicy: {},
      },
    }, undefined)).toEqual({});
  });

  test("returns every exact protected port while preserving the policy-owned Full decision", () => {
    for (const fullEncryptionOnly of [false, true]) {
      const expectedHandoff = handoff(fullEncryptionOnly);
      const deps = createProtectedTaskMemoryGraphDeps(
        identity(),
        expectedHandoff,
      );
      const current = state();
      expect(deps.protectedMemorySearchForState?.(current))
        .toBe(expectedHandoff.search);
      expect(deps.protectedMemoryRepositoryForState?.(current))
        .toBe(expectedHandoff.repository);
      expect(deps.protectedMemoryAccessPortForState?.(current))
        .toBe(expectedHandoff.access);
      expect(deps.protectedMemoryProjectionPortForState?.(current))
        .toBe(expectedHandoff.projection);
      expect(deps.fullEncryptionOnlyForState?.(current))
        .toBe(fullEncryptionOnly);
    }
  });

  test("retains the originally validated ports and policy decision", () => {
    const original = handoff(false);
    const supplied = { ...original };
    const deps = createProtectedTaskMemoryGraphDeps(identity(), supplied);
    const replacement = handoff(true);
    supplied.search = replacement.search;
    supplied.repository = replacement.repository;
    supplied.access = replacement.access;
    supplied.projection = replacement.projection;
    supplied.fullEncryptionOnly = true;

    const current = state();
    expect(deps.protectedMemorySearchForState?.(current)).toBe(original.search);
    expect(deps.protectedMemoryRepositoryForState?.(current))
      .toBe(original.repository);
    expect(deps.protectedMemoryAccessPortForState?.(current))
      .toBe(original.access);
    expect(deps.protectedMemoryProjectionPortForState?.(current))
      .toBe(original.projection);
    expect(deps.fullEncryptionOnlyForState?.(current)).toBe(false);
  });

  test("rejects every absent or malformed required handoff port at runtime", () => {
    for (const [field, replacement] of [
      ["search", undefined],
      ["search", {}],
      ["repository", undefined],
      ["repository", { search: unavailable }],
      ["access", undefined],
      ["access", {}],
      ["projection", undefined],
      ["projection", { prepare: unavailable }],
      ["fullEncryptionOnly", undefined],
      ["fullEncryptionOnly", "false"],
    ] as const) {
      expect(() => createProtectedTaskMemoryGraphDeps(identity(), {
        ...handoff(),
        [field]: replacement,
      } as never)).toThrow("Protected Task Memory");
    }
  });

  test("rejects Scope handoff until protected Scope execution is composed", () => {
    expect(() => createProtectedTaskMemoryGraphDeps({
      ...identity(),
      envelope: {
        memoryMode: "scope",
        ownerId: OWNER_ID,
        actorId: "actor-1",
        agentId: AGENT_ID,
        roomId: "scope-room-1",
        scopeId: "scope-1",
        toolPolicy: {},
      },
    }, handoff())).toThrow("Scope Memory graph handoff is unavailable");
  });

  test("rejects substituted Task and Memory state before exposing any port", () => {
    const deps = createProtectedTaskMemoryGraphDeps(identity(), handoff());
    const resolvers = [
      deps.protectedMemorySearchForState,
      deps.protectedMemoryRepositoryForState,
      deps.protectedMemoryAccessPortForState,
      deps.protectedMemoryProjectionPortForState,
      deps.fullEncryptionOnlyForState,
    ];
    const substituted = [
      { ...state(), currentTaskId: "substituted-task" },
      { ...state(), currentTaskRunId: "substituted-run" },
      { ...state(), currentThreadId: "substituted-thread" },
      { ...state(), userId: "substituted-owner" },
      { ...state(), approvalLaneKey: undefined },
      { ...state(), verifiedOrdinaryOrigin: undefined },
      { ...state(), verifiedOrdinaryOrigin: { deviceId: "ordinary-device" } },
      {
        ...state(),
        memoryAccessEnvelope: {
          ...state().memoryAccessEnvelope!,
          readableNamespaces: ["substituted-namespace"],
        },
      },
      {
        ...state(),
        memoryAccessEnvelope: {
          ...state().memoryAccessEnvelope!,
          toolPolicy: { search_memory: "forbidden" as const },
        },
      },
    ] as NautiloState[];
    for (const current of substituted) {
      for (const resolve of resolvers) {
        expect(() => resolve?.(current)).toThrow(
          "Protected Task Memory graph identity changed",
        );
      }
    }
  });
});
