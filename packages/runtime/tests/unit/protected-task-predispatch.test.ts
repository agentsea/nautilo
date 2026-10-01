import { describe, expect, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

import {
  planProtectedTaskPredispatch,
  type ProtectedTaskPredispatchPorts,
  type ProtectedTaskPredispatchRunFacts,
  type ProtectedTaskPredispatchTaskFacts,
} from "../../src/tasks/protected-task-predispatch";

const OWNER = "11111111-1111-4111-8111-111111111111";
const TASK_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const ROOM = "55555555-5555-4555-8555-555555555555";
const NAMESPACE = "66666666-6666-4666-8666-666666666666";
const PEER = "77777777-7777-4777-8777-777777777777";

function task(
  overrides: Partial<ProtectedTaskPredispatchTaskFacts> = {},
): ProtectedTaskPredispatchTaskFacts {
  return {
    id: TASK,
    ownerId: TASK_OWNER,
    requestorId: OWNER,
    agentId: AGENT,
    callingRoomId: null,
    scheduleKind: "now",
    status: "awaiting",
    preset: "task",
    targetChat: "last_in_namespace",
    targetChatHandle: null,
    targetRoomId: null,
    targetUserIds: [],
    useScope: false,
    scopeId: null,
    contentRepresentation: "protected",
    contentNamespaceId: NAMESPACE,
    contentRevision: 3,
    cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    cryptoAccessRevision: 2,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x31),
    cryptoMappingState: "verified",
    ...overrides,
  };
}

function run(
  overrides: Partial<ProtectedTaskPredispatchRunFacts> = {},
): ProtectedTaskPredispatchRunFacts {
  return {
    id: RUN,
    taskId: TASK,
    jobId: null,
    graphThreadId: `subagent:task:${TASK}:one`,
    status: "awaiting",
    modelId: null,
    resultText: null,
    startedAt: new Date("2026-09-25T09:00:00.000Z"),
    completedAt: null,
    lastError: null,
    resultRepresentation: "ordinary",
    resultContentNamespaceId: null,
    resultRevision: 0,
    resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
    ...overrides,
  };
}

function namespaceEnvelope(): MemoryAccessEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: OWNER,
    actorId: "88888888-8888-4888-8888-888888888888",
    agentId: AGENT,
    roomId: ROOM,
    readableNamespaces: [NAMESPACE],
    mutableNamespaces: [NAMESPACE],
    writableNamespaces: [NAMESPACE],
    toolPolicy: {},
  };
}

function ports(events: string[] = []): ProtectedTaskPredispatchPorts {
  return {
    assertCurrentAuthority: async () => {
      events.push("authority");
    },
    resolveTargetRoom: async () => {
      events.push("target");
      return { roomId: ROOM, targetUserIds: [PEER] };
    },
    resolveMemoryEnvelope: async (input) => {
      events.push(`memory:${input.sessionRoomId}`);
      return {
        envelope: namespaceEnvelope(),
        mode: "namespace",
        authorityStatus: "exact",
        provenance: "target_users_namespace",
      };
    },
  };
}

describe("protected Task predispatch", () => {
  test("binds peer-dispatched identity, target, and current Memory authority before claim", async () => {
    const events: string[] = [];
    const fingerprint = task().cryptoRequiredNamespaceFingerprint!;
    const envelope = namespaceEnvelope();
    const base = ports(events);
    const value = await planProtectedTaskPredispatch({
      task: task(),
      run: run(),
      ports: {
        ...base,
        resolveMemoryEnvelope: async (input) => {
          events.push(`memory:${input.sessionRoomId}`);
          return {
            envelope,
            mode: "namespace",
            authorityStatus: "exact",
            provenance: "target_users_namespace",
          };
        },
      },
    });

    expect(events).toEqual(["authority", "target", `memory:${ROOM}`]);
    expect(value.scheduling).toEqual({
      ownerId: TASK_OWNER,
      requestorId: OWNER,
      agentId: AGENT,
      roomId: ROOM,
      callingRoomId: null,
      graphThreadId: `subagent:task:${TASK}:one`,
    });
    expect(value.target.targetUserIds).toEqual([OWNER, PEER]);
    expect(value.occurrence).toMatchObject({
      task: {
        id: TASK,
        scheduleKind: "now",
        contentNamespaceId: NAMESPACE,
        contentRevision: 3,
        cryptoAccessRevision: 2,
      },
      run: { id: RUN, taskId: TASK, status: "awaiting" },
    });
    expect(value.occurrence.task.cryptoRequiredNamespaceFingerprint)
      .not.toBe(fingerprint);
    expect(value.memory.envelope).not.toBe(envelope);
  });

  test("never reads protected prompt or metadata from a wider Task row", async () => {
    const wider = task() as ProtectedTaskPredispatchTaskFacts & {
      readonly prompt: string;
      readonly metadata: Record<string, unknown>;
    };
    Object.defineProperties(wider, {
      prompt: { get: () => { throw new Error("prompt opened"); } },
      metadata: { get: () => { throw new Error("metadata opened"); } },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().resolves
    await expect(planProtectedTaskPredispatch({
      task: wider,
      run: run(),
      ports: ports(),
    })).resolves.toMatchObject({ scheduling: { roomId: ROOM } });
  });

  test("uses an empty transcript Room for orphan Memory resolution", async () => {
    const sessionRoomIds: string[] = [];
    const base = ports();
    await planProtectedTaskPredispatch({
      task: task({ targetChat: "orphan" }),
      run: run(),
      ports: {
        ...base,
        resolveMemoryEnvelope: async (input) => {
          sessionRoomIds.push(input.sessionRoomId);
          return base.resolveMemoryEnvelope(input);
        },
      },
    });
    expect(sessionRoomIds).toEqual([""]);
  });

  test("rejects stale identity before any authority or resolution work", async () => {
    for (const invalid of [
      { task: task({ contentRepresentation: "ordinary" }), run: run() },
      { task: task({ cryptoMappingState: "stale" }), run: run() },
      { task: task(), run: run({ taskId: "99999999-9999-4999-8999-999999999999" }) },
      { task: task(), run: run({ jobId: "99999999-9999-4999-8999-999999999999" }) },
      { task: task(), run: run({ status: "running" }) },
      { task: task({ useScope: true, scopeId: null }), run: run() },
    ]) {
      const events: string[] = [];
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(planProtectedTaskPredispatch({
        task: invalid.task,
        run: invalid.run,
        ports: ports(events),
      })).rejects.toThrow("Protected Task predispatch identity is invalid");
      expect(events).toEqual([]);
    }
  });

  test("rejects target substitution before Memory resolution", async () => {
    const events: string[] = [];
    const base = ports(events);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(planProtectedTaskPredispatch({
      task: task({ targetRoomId: ROOM, targetUserIds: [PEER] }),
      run: run(),
      ports: {
        ...base,
        resolveTargetRoom: async () => {
          events.push("target");
          return {
            roomId: "99999999-9999-4999-8999-999999999999",
            targetUserIds: [],
          };
        },
      },
    })).rejects.toThrow("Protected Task target resolution is invalid");
    expect(events).toEqual(["authority", "target"]);
  });

  test("does not resolve or mutate routing after current authority is denied", async () => {
    const events: string[] = [];
    const base = ports(events);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(planProtectedTaskPredispatch({
      task: task(),
      run: run(),
      ports: {
        ...base,
        assertCurrentAuthority: async () => {
          events.push("authority");
          throw new Error("denied");
        },
      },
    })).rejects.toThrow("denied");
    expect(events).toEqual(["authority"]);
  });

  test("rejects fallback, crossed, or empty Memory authority", async () => {
    const cases = [
      {
        envelope: namespaceEnvelope(),
        mode: "namespace" as const,
        authorityStatus: "fallback" as const,
        provenance: "base_namespace_fallback" as const,
      },
      {
        envelope: namespaceEnvelope(),
        mode: "wide" as const,
        authorityStatus: "exact" as const,
        provenance: "wide_private_namespace" as const,
      },
      {
        envelope: { ...namespaceEnvelope(), readableNamespaces: [] },
        mode: "namespace" as const,
        authorityStatus: "exact" as const,
        provenance: "target_users_namespace" as const,
      },
    ];
    for (const resolution of cases) {
      const base = ports();
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(planProtectedTaskPredispatch({
        task: task(),
        run: run(),
        ports: {
          ...base,
          resolveMemoryEnvelope: async () => resolution,
        },
      })).rejects.toThrow("Protected Task Memory authority is not exact");
    }
  });

  test("accepts only an existing exact Scope without creating it from content", async () => {
    const scopeId = "99999999-9999-4999-8999-999999999999";
    const base = ports();
    const value = await planProtectedTaskPredispatch({
      task: task({ useScope: true, scopeId }),
      run: run(),
      ports: {
        ...base,
        resolveMemoryEnvelope: async () => ({
          envelope: {
            memoryMode: "scope",
            ownerId: OWNER,
            actorId: "88888888-8888-4888-8888-888888888888",
            agentId: AGENT,
            roomId: ROOM,
            scopeId,
            originWritableNamespaceId: NAMESPACE,
            toolPolicy: {},
          },
          mode: "scope",
          authorityStatus: "exact",
          provenance: "scope_existing",
        }),
      },
    });
    expect(value.memory).toMatchObject({
      mode: "scope",
      envelope: { scopeId, originWritableNamespaceId: NAMESPACE },
    });
  });

  test("rejects a Scope without its exact writable origin Namespace", async () => {
    const scopeId = "99999999-9999-4999-8999-999999999999";
    const base = ports();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(planProtectedTaskPredispatch({
      task: task({ useScope: true, scopeId }),
      run: run(),
      ports: {
        ...base,
        resolveMemoryEnvelope: async () => ({
          envelope: {
            memoryMode: "scope",
            ownerId: OWNER,
            actorId: "88888888-8888-4888-8888-888888888888",
            agentId: AGENT,
            roomId: ROOM,
            scopeId,
            toolPolicy: {},
          },
          mode: "scope",
          authorityStatus: "exact",
          provenance: "scope_existing",
        }),
      },
    })).rejects.toThrow("Protected Task Memory authority is not exact");
  });
});
