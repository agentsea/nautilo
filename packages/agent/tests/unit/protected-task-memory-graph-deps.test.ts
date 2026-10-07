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
const SCOPE_ID = "scope-1";
const SCOPE_ROOM_ID = "scope-room-1";
const ORIGIN_NAMESPACE_ID = "namespace-origin-1";
const TURN_ID = "turn-1";

const unavailable = async () => Object.freeze({
  status: "unavailable" as const,
  reason: "authorization_required" as const,
});

function handoff(
  fullEncryptionOnly = false,
): ProtectedTaskMemoryGraphHandoff & Required<Pick<
  ProtectedTaskMemoryGraphHandoff,
  "access" | "projection"
>> {
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

function fixedHandoff(
  fullEncryptionOnly = false,
): ProtectedTaskMemoryGraphHandoff {
  const complete = handoff(fullEncryptionOnly);
  return Object.freeze({
    search: complete.search,
    repository: complete.repository,
    fullEncryptionOnly,
  });
}

function namespaceEnvelope(
  withMemoryMode = true,
): ProtectedTaskMemoryGraphIdentity["envelope"] {
  return Object.freeze({
    ...(withMemoryMode ? { memoryMode: "namespace" as const } : {}),
    ownerId: OWNER_ID,
    actorId: "actor-1",
    agentId: AGENT_ID,
    roomId: "memory-room-1",
    readableNamespaces: [NAMESPACE_ID],
    mutableNamespaces: [NAMESPACE_ID],
    writableNamespaces: [NAMESPACE_ID],
    toolPolicy: { search_memory: "allow" as const },
  });
}

function scopeEnvelope(
  withOrigin = true,
): ProtectedTaskMemoryGraphIdentity["envelope"] {
  return Object.freeze({
    memoryMode: "scope" as const,
    ownerId: OWNER_ID,
    actorId: "actor-1",
    agentId: AGENT_ID,
    roomId: SCOPE_ROOM_ID,
    scopeId: SCOPE_ID,
    ...(withOrigin
      ? { originWritableNamespaceId: ORIGIN_NAMESPACE_ID }
      : {}),
    toolPolicy: { search_memory: "allow" as const },
  });
}

function identity(
  envelope = namespaceEnvelope(),
): ProtectedTaskMemoryGraphIdentity {
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
    envelope,
  });
}

function state(
  envelope = namespaceEnvelope(),
): NautiloState {
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
    memoryAccessEnvelope: envelope,
  } as unknown as NautiloState;
}

describe("protected Task Memory graph handoff", () => {
  test("leaves an ordinary graph unchanged when no handoff is supplied", () => {
    expect(createProtectedTaskMemoryGraphDeps({
      ...identity(),
      taskId: "",
      envelope: scopeEnvelope(),
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

  test("binds Namespace and Scope fixed ports without inventing dynamic authority", () => {
    for (const envelope of [
      namespaceEnvelope(),
      namespaceEnvelope(false),
      scopeEnvelope(),
      scopeEnvelope(false),
    ]) {
      const expectedHandoff = fixedHandoff(true);
      const deps = createProtectedTaskMemoryGraphDeps(
        identity(envelope),
        expectedHandoff,
      );
      const current = state(envelope);
      expect(deps.protectedMemorySearchForState?.(current))
        .toBe(expectedHandoff.search);
      expect(deps.protectedMemoryRepositoryForState?.(current))
        .toBe(expectedHandoff.repository);
      expect(deps.fullEncryptionOnlyForState?.(current)).toBe(true);
      expect("protectedMemoryAccessPortForState" in deps).toBe(false);
      expect("protectedMemoryProjectionPortForState" in deps).toBe(false);
    }
  });

  test("binds access and projection independently when each is supplied", () => {
    const complete = handoff();
    for (const [field, expectedPort, absentField] of [
      ["access", complete.access, "protectedMemoryProjectionPortForState"],
      ["projection", complete.projection, "protectedMemoryAccessPortForState"],
    ] as const) {
      const deps = createProtectedTaskMemoryGraphDeps(identity(scopeEnvelope()), {
        ...fixedHandoff(),
        [field]: expectedPort,
      });
      const current = state(scopeEnvelope());
      const resolver = field === "access"
        ? deps.protectedMemoryAccessPortForState
        : deps.protectedMemoryProjectionPortForState;
      expect(resolver?.(current)).toBe(expectedPort);
      expect(absentField in deps).toBe(false);
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

  test("rejects absent fixed ports and malformed supplied dynamic ports", () => {
    for (const [field, replacement] of [
      ["search", undefined],
      ["search", {}],
      ["repository", undefined],
      ["repository", { search: unavailable }],
      ["access", {}],
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

  test("rejects unknown initial envelope fields instead of checkpointing them", () => {
    for (const envelope of [namespaceEnvelope(), scopeEnvelope()]) {
      expect(() => createProtectedTaskMemoryGraphDeps(identity({
        ...envelope,
        substitutedCapability: "must-not-be-retained",
      } as never), fixedHandoff())).toThrow(
        "Protected Task Memory envelope shape changed",
      );
    }
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

  test("binds the exact presence of the optional Namespace discriminator", () => {
    for (const withMemoryMode of [false, true]) {
      const envelope = namespaceEnvelope(withMemoryMode);
      const deps = createProtectedTaskMemoryGraphDeps(
        identity(envelope),
        fixedHandoff(),
      );
      const substituted = withMemoryMode
        ? Object.fromEntries(Object.entries(envelope).filter(
            ([key]) => key !== "memoryMode",
          ))
        : { ...envelope, memoryMode: "namespace" as const };
      expect(() => deps.protectedMemoryRepositoryForState?.(
        state(substituted as never),
      )).toThrow("Protected Task Memory graph identity changed");
    }
  });

  test("rejects substituted Scope identity, origin presence, policy, and shape", () => {
    const envelope = scopeEnvelope();
    const deps = createProtectedTaskMemoryGraphDeps(
      identity(envelope),
      fixedHandoff(),
    );
    const resolve = deps.protectedMemoryRepositoryForState!;
    const substitutions = [
      { ...envelope, ownerId: "substituted-owner" },
      { ...envelope, actorId: "substituted-actor" },
      { ...envelope, agentId: "substituted-agent" },
      { ...envelope, roomId: "substituted-room" },
      { ...envelope, scopeId: "substituted-scope" },
      { ...envelope, originWritableNamespaceId: "substituted-origin" },
      Object.fromEntries(Object.entries(envelope).filter(
        ([key]) => key !== "originWritableNamespaceId",
      )),
      { ...envelope, toolPolicy: { search_memory: "forbidden" as const } },
      { ...envelope, unknown: "field" },
    ];
    for (const substituted of substitutions) {
      expect(() => resolve(state(substituted as never))).toThrow(
        "Protected Task Memory graph identity changed",
      );
    }

    const withoutOrigin = scopeEnvelope(false);
    const withoutOriginDeps = createProtectedTaskMemoryGraphDeps(
      identity(withoutOrigin),
      fixedHandoff(),
    );
    expect(() => withoutOriginDeps.protectedMemoryRepositoryForState?.(state({
      ...withoutOrigin,
      originWritableNamespaceId: ORIGIN_NAMESPACE_ID,
    } as never))).toThrow("Protected Task Memory graph identity changed");
  });
});
