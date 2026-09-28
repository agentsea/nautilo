import { describe, expect, test } from "bun:test";
import type { DirectDatabase, Task } from "@nautilo/db";
import {
  createScopeMemoryEnvelopeWithOrigin,
  type NamespaceMemoryEnvelope,
  type PolicyResolver,
  type TargetUsersEnvelopeResult,
  type WideEnvelopeResult,
} from "@nautilo/trust";
import {
  resolveTaskMemoryEnvelope,
  type TaskMemoryEnvelopeResolutionDependencies,
} from "../../src/tasks/resolve-task-memory-envelope";

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  actor: "20000000-0000-4000-8000-000000000002",
  peerUser: "30000000-0000-4000-8000-000000000003",
  peerActor: "40000000-0000-4000-8000-000000000004",
  agent: "50000000-0000-4000-8000-000000000005",
  task: "60000000-0000-4000-8000-000000000006",
  room: "70000000-0000-4000-8000-000000000007",
  callingRoom: "80000000-0000-4000-8000-000000000008",
  namespace: "90000000-0000-4000-8000-000000000009",
  callingNamespace: "a0000000-0000-4000-8000-00000000000a",
  targetNamespace: "b0000000-0000-4000-8000-00000000000b",
  scope: "c0000000-0000-4000-8000-00000000000c",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.user,
    requestorId: ids.user,
    agentId: ids.agent,
    prompt: "inspect the latest notes",
    scopeId: null,
    useScope: false,
    preset: "in_background",
    callingRoomId: ids.callingRoom,
    metadata: {},
    ...overrides,
  } as Task;
}

function namespaceEnvelope(overrides: Partial<NamespaceMemoryEnvelope> = {}): NamespaceMemoryEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: ids.user,
    actorId: ids.actor,
    agentId: ids.agent,
    roomId: ids.room,
    readableNamespaces: [ids.namespace],
    mutableNamespaces: [ids.namespace],
    writableNamespaces: [ids.namespace],
    toolPolicy: { search_memory: "allow" },
    ...overrides,
  };
}

function policyResolver(
  buildEnvelope: PolicyResolver["buildEnvelope"],
): PolicyResolver {
  return { buildEnvelope } as PolicyResolver;
}

function dependencies(
  overrides: Partial<TaskMemoryEnvelopeResolutionDependencies> = {},
): TaskMemoryEnvelopeResolutionDependencies {
  return {
    findActorByOwnerId: async (ownerId) => ownerId === ids.peerUser
      ? { id: ids.peerActor, displayName: "Peer", trustState: "trusted" }
      : { id: ids.actor, displayName: "Requester", trustState: "trusted" },
    buildEnvelopeForTargetUsers: async () => ({
      ok: true,
      envelope: namespaceEnvelope({
        roomId: ids.callingRoom,
        readableNamespaces: [ids.targetNamespace],
        mutableNamespaces: [ids.targetNamespace],
        writableNamespaces: [ids.targetNamespace],
      }),
      namespaceRoomId: ids.callingRoom,
      minted: false,
    }),
    buildWideEnvelopeForSpeaker: async () => ({
      ok: true,
      envelope: namespaceEnvelope(),
      privateRoomId: ids.room,
    }),
    createScope: async () => ({ scopeId: ids.scope, name: `task:${ids.task}` }),
    createScopeMemoryEnvelopeWithOrigin,
    getRoomWithAccess: async () => null,
    updateTask: async () => undefined,
    log: () => {},
    ...overrides,
  };
}

const db = {} as DirectDatabase;

describe("Task Memory-envelope resolution", () => {
  test("creates and persists a scope with the existing plaintext-purpose behavior", async () => {
    const createdScopes: Array<Record<string, unknown>> = [];
    const updates: Array<{ id: string; scopeId: string | null | undefined }> = [];
    const longPrompt = "p".repeat(240);
    const result = await resolveTaskMemoryEnvelope(
      {
        task: makeTask({ useScope: true, preset: "in_scope", prompt: longPrompt }),
        db,
        resolver: policyResolver(async () => namespaceEnvelope()),
        laneKey: `task:${ids.task}`,
        sessionRoomId: ids.room,
        targetUserIds: [],
      },
      dependencies({
        createScope: async (params) => {
          createdScopes.push(params);
          return { scopeId: ids.scope, name: params.name };
        },
        updateTask: async (_db, id, patch) => {
          updates.push({ id, scopeId: patch.scopeId });
          return undefined;
        },
      }),
    );

    expect(result.mode).toBe("scope");
    expect(result.authorityStatus).toBe("exact");
    expect(result.provenance).toBe("scope_created_from_plaintext_prompt");
    expect(createdScopes).toEqual([{
      parentAgentId: ids.agent,
      speakerUserId: ids.user,
      name: `task:${ids.task}`,
      purpose: longPrompt.slice(0, 200),
    }]);
    expect(updates).toEqual([{ id: ids.task, scopeId: ids.scope }]);
    expect(result.envelope).toMatchObject({
      memoryMode: "scope",
      scopeId: ids.scope,
      originWritableNamespaceId: ids.namespace,
    });
  });

  test("makes an existing scope without a canonical origin namespace unresolved", async () => {
    const base = namespaceEnvelope({
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
    });
    const result = await resolveTaskMemoryEnvelope(
      {
        task: makeTask({
          useScope: true,
          preset: "in_scope",
          scopeId: ids.scope,
        }),
        db,
        resolver: policyResolver(async () => base),
        laneKey: `task:${ids.task}`,
        sessionRoomId: "",
        targetUserIds: [],
      },
      dependencies(),
    );

    expect(result.authorityStatus).toBe("unresolved");
    expect(result.provenance).toBe("scope_without_origin_namespace");
    expect(result.envelope).toMatchObject({
      memoryMode: "scope",
      scopeId: ids.scope,
    });
    expect(result.envelope).not.toHaveProperty("originWritableNamespaceId");
  });

  test("derives exact namespace authority from the fresh target-user set", async () => {
    const targetCalls: Array<Record<string, unknown>> = [];
    const exactEnvelope = namespaceEnvelope({
      roomId: ids.callingRoom,
      readableNamespaces: [ids.targetNamespace],
      mutableNamespaces: [ids.targetNamespace],
      writableNamespaces: [ids.targetNamespace],
    });
    const result = await resolveTaskMemoryEnvelope(
      {
        task: makeTask(),
        db,
        resolver: policyResolver(async () => namespaceEnvelope()),
        laneKey: `task:${ids.task}`,
        sessionRoomId: "",
        targetUserIds: [ids.user, ids.peerUser, ids.peerUser],
      },
      dependencies({
        buildEnvelopeForTargetUsers: async (params) => {
          targetCalls.push(params);
          return {
            ok: true,
            envelope: exactEnvelope,
            namespaceRoomId: ids.callingRoom,
            minted: false,
          } satisfies TargetUsersEnvelopeResult;
        },
      }),
    );

    expect(result).toEqual({
      envelope: exactEnvelope,
      mode: "namespace",
      authorityStatus: "exact",
      provenance: "target_users_namespace",
    });
    expect(targetCalls).toHaveLength(1);
    expect(targetCalls[0]?.["requester"]).toEqual({ userId: ids.user, actorId: ids.actor });
    expect(targetCalls[0]?.["targetUsers"]).toEqual([
      { userId: ids.user, actorId: ids.actor },
      { userId: ids.peerUser, actorId: ids.peerActor },
    ]);
  });

  test("distinguishes an exactly rechecked calling Room from generic namespace fallback", async () => {
    const rooms: Array<string | undefined> = [];
    const logs: unknown[][] = [];
    const base = namespaceEnvelope({ roomId: "", writableNamespaces: [] });
    const calling = namespaceEnvelope({
      roomId: ids.callingRoom,
      readableNamespaces: [ids.callingNamespace],
      mutableNamespaces: [ids.callingNamespace],
      writableNamespaces: [ids.callingNamespace],
    });
    const result = await resolveTaskMemoryEnvelope(
      {
        task: makeTask(),
        db,
        resolver: policyResolver(async (_actorId, _laneKey, _agentId, roomId) => {
          rooms.push(roomId);
          return roomId === ids.callingRoom ? calling : base;
        }),
        laneKey: `task:${ids.task}`,
        sessionRoomId: "",
        targetUserIds: [],
      },
      dependencies({
        buildEnvelopeForTargetUsers: async () => ({ ok: false, reason: "no_namespace" }),
        log: (...args) => logs.push(args),
      }),
    );

    expect(rooms).toEqual(["", ids.callingRoom]);
    expect(result).toEqual({
      envelope: calling,
      mode: "namespace",
      authorityStatus: "exact",
      provenance: "authorized_calling_room_fallback",
    });
    expect(String(logs[0]?.[0])).toContain("using authorized calling-room namespace");
  });

  test("flags the generic base namespace recovery as fallback authority", async () => {
    const base = namespaceEnvelope({ roomId: "", writableNamespaces: [] });
    const result = await resolveTaskMemoryEnvelope(
      {
        task: makeTask(),
        db,
        resolver: policyResolver(async () => base),
        laneKey: `task:${ids.task}`,
        sessionRoomId: "",
        targetUserIds: [],
      },
      dependencies({
        buildEnvelopeForTargetUsers: async () => ({ ok: false, reason: "no_namespace" }),
      }),
    );

    expect(result).toEqual({
      envelope: base,
      mode: "namespace",
      authorityStatus: "fallback",
      provenance: "base_namespace_fallback",
    });
  });

  test("preserves private-wide authority and the calling-Room return namespace", async () => {
    const wideCalls: Array<Record<string, unknown>> = [];
    const wideEnvelope = namespaceEnvelope({
      readableNamespaces: [ids.namespace, ids.callingNamespace],
      mutableNamespaces: [ids.namespace, ids.callingNamespace],
      writableNamespaces: [ids.callingNamespace, ids.namespace],
    });
    const result = await resolveTaskMemoryEnvelope(
      {
        task: makeTask({ preset: "in_private_namespace" }),
        db,
        resolver: policyResolver(async () => namespaceEnvelope()),
        laneKey: `task:${ids.task}`,
        sessionRoomId: "",
        targetUserIds: [],
      },
      dependencies({
        getRoomWithAccess: async () => ({
          namespaceId: ids.callingNamespace,
        }) as never,
        buildWideEnvelopeForSpeaker: async (params) => {
          wideCalls.push(params);
          return {
            ok: true,
            envelope: wideEnvelope,
            privateRoomId: ids.room,
          } satisfies WideEnvelopeResult;
        },
      }),
    );

    expect(result).toEqual({
      envelope: wideEnvelope,
      mode: "wide",
      authorityStatus: "exact",
      provenance: "wide_private_namespace",
    });
    expect(wideCalls).toEqual([{
      speakerActorId: ids.actor,
      speakerUserId: ids.user,
      agentId: ids.agent,
      toolPolicy: { search_memory: "allow" },
      returnRoomNamespaceId: ids.callingNamespace,
    }]);
  });

  test("preserves a failed wide lookup while making its fallback observable", async () => {
    const logs: unknown[][] = [];
    const base = namespaceEnvelope();
    const result = await resolveTaskMemoryEnvelope(
      {
        task: makeTask({ preset: "in_private_namespace" }),
        db,
        resolver: policyResolver(async () => base),
        laneKey: `task:${ids.task}`,
        sessionRoomId: ids.room,
        targetUserIds: [],
      },
      dependencies({
        buildWideEnvelopeForSpeaker: async () => ({
          ok: false,
          reason: "no_private_room",
        } satisfies WideEnvelopeResult),
        log: (...args) => logs.push(args),
      }),
    );

    expect(result).toEqual({
      envelope: base,
      mode: "wide",
      authorityStatus: "fallback",
      provenance: "wide_base_namespace_fallback",
    });
    expect(String(logs[0]?.[0])).toContain("falling back to namespace envelope");
  });

  test("retains the base namespace when no requestor actor exists", async () => {
    const base = namespaceEnvelope();
    const result = await resolveTaskMemoryEnvelope(
      {
        task: makeTask(),
        db,
        resolver: policyResolver(async (actorId) => {
          expect(actorId).toBe(ids.user);
          return base;
        }),
        laneKey: `task:${ids.task}`,
        sessionRoomId: ids.room,
        targetUserIds: [ids.peerUser],
      },
      dependencies({ findActorByOwnerId: async () => null }),
    );

    expect(result).toEqual({
      envelope: base,
      mode: "namespace",
      authorityStatus: "fallback",
      provenance: "base_namespace_without_requestor_actor",
    });
  });
});
