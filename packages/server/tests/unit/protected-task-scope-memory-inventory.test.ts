import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type {
  ProtectedTaskOccurrence,
  ProtectedTaskPredispatchPlan,
} from "@nautilo/runtime";
import type { ScopeMemoryEnvelopeWithOrigin } from "@nautilo/trust";

import {
  createProtectedTaskScopeMemoryInventoryResolver,
} from "../../src/routes/protected-task-scope-memory-inventory";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const TARGET_ROOM = "60000000-0000-4000-8000-000000000006";
const MEMORY_ROOM = "70000000-0000-4000-8000-000000000007";
const SOURCE_ROOM = "80000000-0000-4000-8000-000000000008";
const CONTENT = "90000000-0000-4000-8000-000000000009";
const ORIGIN = "a0000000-0000-4000-8000-00000000000a";
const SEED = "b0000000-0000-4000-8000-00000000000b";
const SCOPE = "c0000000-0000-4000-8000-00000000000c";

function occurrence(): ProtectedTaskOccurrence {
  return {
    task: {
      id: TASK,
      ownerId: USER,
      requestorId: USER,
      agentId: AGENT,
      callingRoomId: TARGET_ROOM,
      scheduleKind: "now",
      contentRepresentation: "protected",
      contentNamespaceId: CONTENT,
      contentRevision: 1,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1({
        kind: "definition",
        taskId: TASK,
        contentRevision: 1,
      }),
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
    },
    run: {
      id: RUN,
      taskId: TASK,
      jobId: null,
      graphThreadId: `task:${TASK}:${RUN}`,
      status: "awaiting",
      startedAt: new Date(1_800_000_000_000),
    },
  };
}

function predispatch(
  current: ProtectedTaskOccurrence,
): ProtectedTaskPredispatchPlan {
  const scopeEnvelope: ScopeMemoryEnvelopeWithOrigin = {
    memoryMode: "scope",
    ownerId: USER,
    actorId: HUMAN,
    agentId: AGENT,
    roomId: MEMORY_ROOM,
    scopeId: SCOPE,
    originWritableNamespaceId: ORIGIN,
    toolPolicy: {},
  };
  return {
    occurrence: current,
    scheduling: {
      ownerId: USER,
      requestorId: USER,
      agentId: AGENT,
      roomId: TARGET_ROOM,
      callingRoomId: TARGET_ROOM,
      graphThreadId: current.run.graphThreadId,
    },
    target: { roomId: TARGET_ROOM, targetUserIds: [USER] },
    memory: {
      mode: "scope",
      authorityStatus: "exact",
      provenance: "scope_existing",
      envelope: scopeEnvelope,
    },
  };
}

function resolver(overrides: Readonly<{
  sourceNamespaceId?: string;
  discover?: (input: unknown) => Promise<Readonly<{
    scopeId: string;
    originWritableNamespaceId: string;
    readableNamespaceIds: readonly string[];
  }> | null>;
}> = {}) {
  const transaction = {};
  return createProtectedTaskScopeMemoryInventoryResolver({
    db: {} as DirectDatabase,
    resolveRequesterHuman: async () => ({ id: HUMAN }),
    resolveRequesterPrivateRoom: async (_userId, _agentId, namespaceId) => {
      expect(namespaceId).toBe(CONTENT);
      return {
        roomId: SOURCE_ROOM,
        namespaceId: overrides.sourceNamespaceId ?? CONTENT,
      };
    },
    createProductContext: async () => ({
      canonicalRunner: {
        role: "nautilo",
        transaction: async (use: (
          value: typeof transaction,
          executor: never,
        ) => Promise<unknown>, options: unknown) => {
          expect(options).toEqual({ isolationLevel: "serializable" });
          return use(transaction, undefined as never);
        },
      },
    }) as never,
    discoverInventory: (overrides.discover ?? (async () => ({
      scopeId: SCOPE,
      originWritableNamespaceId: ORIGIN,
      readableNamespaceIds: [ORIGIN, SEED].sort(),
    }))) as never,
  });
}

describe("protected Task Scope Memory inventory", () => {
  test("discovers a copied fixed binding through the complete product role", async () => {
    const current = occurrence();
    let received: Record<string, unknown> | null = null;
    const binding = await resolver({
      discover: async input => {
        received = input as Record<string, unknown>;
        return {
          scopeId: SCOPE,
          originWritableNamespaceId: ORIGIN,
          readableNamespaceIds: [ORIGIN, SEED].sort(),
        };
      },
    })({ occurrence: current, predispatch: predispatch(current) });

    expect(received).toMatchObject({
      sourceRoomId: SOURCE_ROOM,
      requesterHumanId: HUMAN,
      coordinates: {
        taskId: TASK,
        requesterUserId: USER,
        agentId: AGENT,
        scopeId: SCOPE,
        memoryRoomId: MEMORY_ROOM,
        originWritableNamespaceId: ORIGIN,
      },
    });
    expect(binding).toEqual({
      scopeId: SCOPE,
      memoryRoomId: MEMORY_ROOM,
      originWritableNamespaceId: ORIGIN,
      readableNamespaceIds: [ORIGIN, SEED].sort(),
    });
    expect(Object.isFrozen(binding)).toBeTrue();
    expect(Object.isFrozen(binding.readableNamespaceIds)).toBeTrue();
  });

  test("accepts closed coordinates without materializing a Task or predispatch plan", async () => {
    let received: Record<string, unknown> | null = null;
    const binding = await resolver({
      discover: async input => {
        received = input as Record<string, unknown>;
        return {
          scopeId: SCOPE,
          originWritableNamespaceId: ORIGIN,
          readableNamespaceIds: [ORIGIN, SEED].sort(),
        };
      },
    })({
      coordinates: {
        taskId: TASK,
        taskRunId: RUN,
        requesterUserId: USER,
        agentId: AGENT,
        contentNamespaceId: CONTENT,
        scopeId: SCOPE,
        memoryRoomId: MEMORY_ROOM,
        originWritableNamespaceId: ORIGIN,
        requesterActorId: HUMAN,
      },
    });

    expect(received).toMatchObject({
      sourceRoomId: SOURCE_ROOM,
      requesterHumanId: HUMAN,
      coordinates: {
        taskId: TASK,
        requesterUserId: USER,
        agentId: AGENT,
        scopeId: SCOPE,
        memoryRoomId: MEMORY_ROOM,
        originWritableNamespaceId: ORIGIN,
      },
    });
    expect(binding).toEqual({
      scopeId: SCOPE,
      memoryRoomId: MEMORY_ROOM,
      originWritableNamespaceId: ORIGIN,
      readableNamespaceIds: [ORIGIN, SEED].sort(),
    });
  });

  test("rejects a Namespace plan and a non-private content source", async () => {
    const current = occurrence();
    const namespacePlan: ProtectedTaskPredispatchPlan = {
      ...predispatch(current),
      memory: {
        mode: "namespace",
        authorityStatus: "exact",
        provenance: "target_users_namespace",
        envelope: {
          memoryMode: "namespace",
          ownerId: USER,
          actorId: HUMAN,
          agentId: AGENT,
          roomId: MEMORY_ROOM,
          readableNamespaces: [ORIGIN],
          mutableNamespaces: [ORIGIN],
          writableNamespaces: [ORIGIN],
          toolPolicy: {},
        },
      },
    };
    await Promise.resolve(expect(resolver()({
      occurrence: current,
      predispatch: namespacePlan,
    })).rejects.toThrow("coordinates are invalid"));
    await Promise.resolve(expect(resolver({ sourceNamespaceId: SEED })({
      occurrence: current,
      predispatch: predispatch(current),
    })).rejects.toThrow("source authority is unavailable"));
  });

  test("rejects inventory substitution and caller mutation across discovery", async () => {
    const current = occurrence();
    await Promise.resolve(expect(resolver({
      discover: async () => ({
        scopeId: SCOPE,
        originWritableNamespaceId: SEED,
        readableNamespaceIds: [SEED],
      }),
    })({ occurrence: current, predispatch: predispatch(current) }))
      .rejects.toThrow("inventory changed"));

    const plan = predispatch(current);
    await Promise.resolve(expect(resolver({
      discover: async () => {
        (plan.memory.envelope as { roomId: string }).roomId = TARGET_ROOM;
        return {
          scopeId: SCOPE,
          originWritableNamespaceId: ORIGIN,
          readableNamespaceIds: [ORIGIN],
        };
      },
    })({ occurrence: current, predispatch: plan }))
      .rejects.toThrow("inventory changed"));
  });
});
