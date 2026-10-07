import { describe, expect, test } from "bun:test";

import type {
  DirectDatabase,
  ParkedProtectedTaskAdditionalAuthority,
  ProtectedTaskRunOutputBinding,
} from "@nautilo/db";
import type { TaskScopeMemoryBinding } from "@nautilo/lattice-bridge/server";
import type {
  NamespaceMemoryEnvelope,
  PolicyResolver,
} from "@nautilo/trust";

import {
  createProtectedTaskRuntimeParkedMemoryPlanResolver,
  type ParkedProtectedTaskRuntimeMemoryMetadata,
} from "../../src/routes/protected-task-runtime-parked-memory-plan";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const PEER_USER = "30000000-0000-4000-8000-000000000003";
const PEER_HUMAN = "40000000-0000-4000-8000-000000000004";
const AGENT = "50000000-0000-4000-8000-000000000005";
const TASK = "60000000-0000-4000-8000-000000000006";
const RUN = "70000000-0000-4000-8000-000000000007";
const SOURCE_ROOM = "80000000-0000-4000-8000-000000000008";
const TARGET_ROOM = "90000000-0000-4000-8000-000000000009";
const SHARED_ROOM = "a0000000-0000-4000-8000-00000000000a";
const CONTENT = "b0000000-0000-4000-8000-00000000000b";
const TARGET_NAMESPACE = "c0000000-0000-4000-8000-00000000000c";
const SHARED_NAMESPACE = "d0000000-0000-4000-8000-00000000000d";
const WIDE_PRIVATE_NAMESPACE = "e0000000-0000-4000-8000-00000000000e";
const SCOPE = "f0000000-0000-4000-8000-00000000000f";

function expected(
  callingRoomId: string | null = TARGET_ROOM,
): ParkedProtectedTaskAdditionalAuthority {
  return {
    occurrence: {
      task: {
        id: TASK,
        ownerId: USER,
        requestorId: USER,
        agentId: AGENT,
        callingRoomId,
        scheduleKind: "now",
        status: "awaiting",
        contentRepresentation: "protected",
        contentNamespaceId: CONTENT,
        contentRevision: 1,
        cryptoObjectId: "task-definition:v1:fixture",
        cryptoAccessRevision: 0,
        cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
      },
      run: {
        id: RUN,
        taskId: TASK,
        jobId: "01000000-0000-4000-8000-000000000010",
        graphThreadId: `task:${TASK}:${RUN}`,
        status: "awaiting",
        startedAt: new Date(1_800_000_000_000),
      },
    },
    priorJob: {
      id: "01000000-0000-4000-8000-000000000010",
      generation: 0,
      parkedAt: new Date(1_800_000_001_000),
      interrupts: [],
      reference: {
        kind: "protected_task_run_v1",
        taskId: TASK,
        taskRunId: RUN,
        inputObjectId: "task-definition:v1:fixture",
        resultObjectId: "task-run-result:v1:fixture",
        authorizationRequestId: "prior-request",
        policyRevision: 1,
        executionSegment: 1,
      },
    },
  } as unknown as ParkedProtectedTaskAdditionalAuthority;
}

function output(
  destinationRoomId: string | null = TARGET_ROOM,
  destinationNamespaceId: string | null = TARGET_NAMESPACE,
): ProtectedTaskRunOutputBinding {
  return {
    taskRunId: RUN,
    bindingId: `task-run-output:${RUN}`,
    deliveryMode: destinationRoomId === null ? "none" : "wake",
    destinationRoomId,
    destinationNamespaceId,
    resultOperationId: `task-run-result:${RUN}`,
    resultObjectId: "task-run-result:v1:fixture",
    messageOperationId: null,
    wakeOperationId: destinationRoomId === null
      ? null
      : `task-run-delivery-wake:${RUN}`,
    acceptedPolicyRevision: 1,
    acceptedAt: new Date(1_799_999_999_000),
    resultTerminalAt: null,
    resultAttachedAt: null,
    messageId: null,
    messagePublishedAt: null,
    wakeJobId: null,
    wakeScheduledAt: null,
    completedAt: null,
  };
}

function metadata(
  overrides: Partial<ParkedProtectedTaskRuntimeMemoryMetadata> = {},
): ParkedProtectedTaskRuntimeMemoryMetadata {
  return {
    taskId: TASK,
    requesterUserId: USER,
    agentId: AGENT,
    targetRoomId: TARGET_ROOM,
    targetUserIds: [PEER_USER],
    useScope: false,
    scopeId: null,
    preset: "task",
    targetChat: "last_dm",
    wideBringBack: true,
    ...overrides,
  };
}

function envelope(
  roomId: string,
  writableNamespaces: string[],
  readableNamespaces: string[] = writableNamespaces,
): NamespaceMemoryEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: USER,
    actorId: HUMAN,
    agentId: AGENT,
    roomId,
    readableNamespaces: [...readableNamespaces],
    mutableNamespaces: [...readableNamespaces],
    writableNamespaces: [...writableNamespaces],
    toolPolicy: { memory_search: "allow" },
  };
}

function build(overrides: Readonly<{
  metadata?: ParkedProtectedTaskRuntimeMemoryMetadata;
  missingPeer?: boolean;
  buildTargetUsersEnvelope?: (input: Record<string, unknown>) => Promise<unknown>;
  buildWideEnvelope?: (input: Record<string, unknown>) => Promise<unknown>;
  resolveScopeMemoryInventory?: (
    input: Record<string, unknown>,
  ) => Promise<TaskScopeMemoryBinding>;
  buildEnvelope?: (
    actorId: string,
    laneKey: string,
    agentId: string | undefined,
    roomId?: string,
  ) => Promise<NamespaceMemoryEnvelope>;
}> = {}) {
  return createProtectedTaskRuntimeParkedMemoryPlanResolver({
    db: {} as DirectDatabase,
    resolver: {
      buildEnvelope: overrides.buildEnvelope ?? (async (
        _actorId,
        _laneKey,
        _agentId,
        roomId,
      ) => roomId === SOURCE_ROOM
        ? envelope(SOURCE_ROOM, [CONTENT])
        : envelope(TARGET_ROOM, [TARGET_NAMESPACE])),
    } as PolicyResolver,
    readCurrentMetadata: async () => overrides.metadata ?? metadata(),
    resolveRequesterHuman: async userId => userId === USER
      ? { id: HUMAN }
      : userId === PEER_USER && !overrides.missingPeer
        ? { id: PEER_HUMAN }
        : null,
    resolveRequesterPrivateRoom: async () => ({
      roomId: SOURCE_ROOM,
      namespaceId: CONTENT,
    }),
    buildTargetUsersEnvelope: (overrides.buildTargetUsersEnvelope
      ?? (async () => ({
        ok: true,
        minted: false,
        namespaceRoomId: SHARED_ROOM,
        envelope: envelope(SHARED_ROOM, [SHARED_NAMESPACE]),
      }))) as never,
    buildWideEnvelope: (overrides.buildWideEnvelope ?? (async () => ({
      ok: true,
      privateRoomId: SOURCE_ROOM,
      envelope: envelope(
        SOURCE_ROOM,
        [TARGET_NAMESPACE, WIDE_PRIVATE_NAMESPACE],
        [CONTENT, TARGET_NAMESPACE, WIDE_PRIVATE_NAMESPACE],
      ),
    }))) as never,
    resolveScopeMemoryInventory: (overrides.resolveScopeMemoryInventory
      ?? (async () => ({
        scopeId: SCOPE,
        memoryRoomId: TARGET_ROOM,
        originWritableNamespaceId: TARGET_NAMESPACE,
        readableNamespaceIds: [TARGET_NAMESPACE],
      }))) as never,
  });
}

describe("protected Task parked Memory plan", () => {
  test("resolves every Namespace target Human without minting and closes the plan", async () => {
    let received: Record<string, unknown> | null = null;
    const plan = await build({
      buildTargetUsersEnvelope: async input => {
        received = input;
        return {
          ok: true,
          minted: false,
          namespaceRoomId: SHARED_ROOM,
          envelope: envelope(
            SHARED_ROOM,
            [SHARED_NAMESPACE],
            [SHARED_NAMESPACE, TARGET_NAMESPACE],
          ),
        };
      },
    })({ expected: expected(), output: output() });

    expect(received).toMatchObject({
      requester: { userId: USER, actorId: HUMAN },
      targetUsers: [
        { userId: USER, actorId: HUMAN },
        { userId: PEER_USER, actorId: PEER_HUMAN },
      ],
      agentId: AGENT,
      allowMint: false,
    });
    expect(plan).toMatchObject({
      routing: {
        targetRoomId: TARGET_ROOM,
        targetUserIds: [USER, PEER_USER].sort(),
        memoryMode: "namespace",
        scopeId: null,
        targetChat: "last_dm",
        wideBringBack: true,
        widePrivateNamespaceId: null,
      },
      resolution: {
        mode: "namespace",
        authorityStatus: "exact",
        provenance: "target_users_namespace",
      },
      expectedNamespaceParticipants: [
        {
          namespaceId: TARGET_NAMESPACE,
          match: "includes",
          participantHumanIds: [HUMAN, PEER_HUMAN].sort(),
        },
        {
          namespaceId: SHARED_NAMESPACE,
          match: "exact",
          participantHumanIds: [HUMAN, PEER_HUMAN].sort(),
        },
      ],
    });
    expect(Object.isFrozen(plan)).toBeTrue();
    expect(Object.isFrozen(plan!.routing)).toBeTrue();
    expect(Object.isFrozen(plan!.routing.targetUserIds)).toBeTrue();
    expect(Object.isFrozen(plan!.resolution.envelope)).toBeTrue();
    expect(Object.isFrozen(plan!.expectedNamespaceParticipants)).toBeTrue();
    for (const expectedAudience of plan!.expectedNamespaceParticipants!) {
      expect(Object.isFrozen(expectedAudience)).toBeTrue();
      expect(Object.isFrozen(expectedAudience.participantHumanIds)).toBeTrue();
    }
  });

  test("copies the Namespace audience before the envelope builder can mutate aliases", async () => {
    const plan = await build({
      buildTargetUsersEnvelope: async input => {
        const targets = input["targetUsers"] as Array<{
          userId: string;
          actorId: string;
        }>;
        targets.reverse();
        targets[0]!.actorId = AGENT;
        targets.pop();
        return {
          ok: true,
          minted: false,
          namespaceRoomId: SHARED_ROOM,
          envelope: envelope(SHARED_ROOM, [SHARED_NAMESPACE]),
        };
      },
    })({ expected: expected(), output: output() });

    expect(plan?.expectedNamespaceParticipants).toEqual([{
      namespaceId: SHARED_NAMESPACE,
      match: "exact",
      participantHumanIds: [HUMAN, PEER_HUMAN].sort(),
    }]);
  });

  test("returns null rather than skipping a missing target Human or minting", async () => {
    let called = false;
    const plan = await build({
      missingPeer: true,
      buildTargetUsersEnvelope: async () => {
        called = true;
        throw new Error("must not build");
      },
    })({ expected: expected(), output: output() });

    expect(plan).toBeNull();
    expect(called).toBeFalse();
  });

  test("pins the actual Wide private Namespace and the current bring-back input", async () => {
    let received: Record<string, unknown> | null = null;
    const plan = await build({
      metadata: metadata({
        targetUserIds: [],
        preset: "in_private_namespace",
      }),
      buildWideEnvelope: async input => {
        received = input;
        return {
          ok: true,
          privateRoomId: SOURCE_ROOM,
          envelope: envelope(
            SOURCE_ROOM,
            [TARGET_NAMESPACE, WIDE_PRIVATE_NAMESPACE],
            [CONTENT, TARGET_NAMESPACE, WIDE_PRIVATE_NAMESPACE],
          ),
        };
      },
    })({ expected: expected(), output: output() });

    expect(received).toMatchObject({
      speakerActorId: HUMAN,
      speakerUserId: USER,
      agentId: AGENT,
      returnRoomNamespaceId: TARGET_NAMESPACE,
    });
    expect(plan?.routing).toMatchObject({
      memoryMode: "wide",
      wideBringBack: true,
      widePrivateNamespaceId: WIDE_PRIVATE_NAMESPACE,
      outputNamespaceId: TARGET_NAMESPACE,
    });
    expect(plan?.resolution.envelope).toMatchObject({
      writableNamespaces: [TARGET_NAMESPACE, WIDE_PRIVATE_NAMESPACE],
    });
    expect(Object.hasOwn(plan ?? {}, "expectedNamespaceParticipants"))
      .toBeFalse();

    let noBringBackInput: Record<string, unknown> | null = null;
    const noBringBack = await build({
      metadata: metadata({
        targetUserIds: [],
        preset: "in_private_namespace",
        wideBringBack: false,
      }),
      buildWideEnvelope: async input => {
        noBringBackInput = input;
        return {
          ok: true,
          privateRoomId: SOURCE_ROOM,
          envelope: envelope(
            SOURCE_ROOM,
            [WIDE_PRIVATE_NAMESPACE],
            [CONTENT, WIDE_PRIVATE_NAMESPACE],
          ),
        };
      },
    })({ expected: expected(), output: output() });
    expect(noBringBackInput).not.toHaveProperty("returnRoomNamespaceId");
    expect(noBringBack?.routing.wideBringBack).toBeFalse();
  });

  test("uses the target Room for existing Scope inventory and the source for orphan", async () => {
    let scopeInput: Record<string, unknown> | null = null;
    const plan = await build({
      metadata: metadata({ useScope: true, scopeId: SCOPE }),
      resolveScopeMemoryInventory: async input => {
        scopeInput = input;
        return {
          scopeId: SCOPE,
          memoryRoomId: TARGET_ROOM,
          originWritableNamespaceId: TARGET_NAMESPACE,
          readableNamespaceIds: [TARGET_NAMESPACE],
        };
      },
    })({ expected: expected(), output: output() });
    expect(scopeInput as unknown).toEqual({
      coordinates: {
        taskId: TASK,
        taskRunId: RUN,
        requesterUserId: USER,
        agentId: AGENT,
        contentNamespaceId: CONTENT,
        scopeId: SCOPE,
        memoryRoomId: TARGET_ROOM,
        originWritableNamespaceId: TARGET_NAMESPACE,
        requesterActorId: HUMAN,
      },
    });
    expect(plan).toMatchObject({
      routing: {
        memoryMode: "scope",
        scopeId: SCOPE,
        widePrivateNamespaceId: null,
      },
      resolution: {
        mode: "scope",
        provenance: "scope_existing",
        envelope: {
          roomId: TARGET_ROOM,
          originWritableNamespaceId: TARGET_NAMESPACE,
        },
      },
      scopeMemory: {
        memoryRoomId: TARGET_ROOM,
        originWritableNamespaceId: TARGET_NAMESPACE,
      },
    });
    expect(Object.hasOwn(plan ?? {}, "expectedNamespaceParticipants"))
      .toBeFalse();

    let orphanInput: Record<string, unknown> | null = null;
    const orphan = await build({
      metadata: metadata({
        useScope: true,
        scopeId: SCOPE,
        targetChat: "orphan",
      }),
      resolveScopeMemoryInventory: async input => {
        orphanInput = input;
        return {
          scopeId: SCOPE,
          memoryRoomId: SOURCE_ROOM,
          originWritableNamespaceId: CONTENT,
          readableNamespaceIds: [CONTENT],
        };
      },
    })({ expected: expected(), output: output() });
    expect(orphanInput).toMatchObject({
      coordinates: {
        memoryRoomId: SOURCE_ROOM,
        originWritableNamespaceId: CONTENT,
      },
    });
    expect(orphan?.resolution.envelope).toMatchObject({
      roomId: SOURCE_ROOM,
      originWritableNamespaceId: CONTENT,
    });
  });

  test("returns null for output drift, unresolved target metadata, or a minted Namespace", async () => {
    expect(await build()({
      expected: expected(),
      output: { ...output(), resultObjectId: "changed" },
    })).toBeNull();
    expect(await build({
      metadata: metadata({ targetRoomId: null }),
    })({ expected: expected(), output: output() })).toBeNull();
    expect(await build({
      buildTargetUsersEnvelope: async () => ({
        ok: true,
        minted: true,
        namespaceRoomId: SHARED_ROOM,
        envelope: envelope(SHARED_ROOM, [SHARED_NAMESPACE]),
      }),
    })({ expected: expected(), output: output() })).toBeNull();
    expect(await build({
      metadata: metadata({ useScope: true, scopeId: SCOPE }),
      resolveScopeMemoryInventory: async () => {
        throw new TypeError("source authority is unavailable");
      },
    })({ expected: expected(), output: output() })).toBeNull();
  });
});
