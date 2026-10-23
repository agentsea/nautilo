import { describe, expect, test } from "bun:test";
import type {
  ConversationProductCanonicalTransactionRunner,
  ConversationProductPostgresHandle,
  NativeTaskNamespaceSource,
  PostgresHumanDeviceSignerHistory,
} from "@nautilo/lattice-bridge/server";
import { encryptionTransitionPolicy, jobs, rooms, sessions, taskRuns, tasks } from
  "@nautilo/db";

import {
  createProtectedTaskNativeTranscriptPublisher,
} from "../../src/routes/protected-task-native-transcript-composition";

const ids = Object.freeze({
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  requestor: "50000000-0000-4000-8000-000000000005",
  requesterHuman: "51000000-0000-4000-8000-000000000005",
  agent: "60000000-0000-4000-8000-000000000006",
  room: "70000000-0000-4000-8000-000000000007",
  sourceRoom: "71000000-0000-4000-8000-000000000007",
  roomNamespace: "80000000-0000-4000-8000-000000000008",
  contentNamespace: "90000000-0000-4000-8000-000000000009",
  session: "a0000000-0000-4000-8000-00000000000a",
});
const NOW = 2_000_000_000_000;
const graphThreadId = `subagent:task:${ids.task}:${ids.run}`;
const inputObjectId = "task-definition:v1:input";
const resultObjectId = "task-run-result:v1:result";

type Factory = ReturnType<typeof createProtectedTaskNativeTranscriptPublisher>;
type Segment = Parameters<Factory>[0];

function segment(
  runner: ConversationProductCanonicalTransactionRunner,
  signal: AbortSignal,
): Segment {
  const occurrence = Object.freeze({
    task: Object.freeze({
      id: ids.task,
      ownerId: ids.owner,
      requestorId: ids.requestor,
      agentId: ids.agent,
      callingRoomId: null,
      scheduleKind: "now" as const,
      contentRepresentation: "dual" as const,
      contentNamespaceId: ids.contentNamespace,
      contentRevision: 1,
      cryptoObjectId: inputObjectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(3),
    }),
    run: Object.freeze({
      id: ids.run,
      taskId: ids.task,
      jobId: ids.job,
      graphThreadId,
      status: "running" as const,
      startedAt: new Date(NOW - 1_000),
    }),
  });
  const reference = Object.freeze({
    kind: "protected_task_run_v1" as const,
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId,
    resultObjectId,
    authorizationRequestId: "request-1",
    policyRevision: 4,
    executionSegment: 1,
  });
  const current = {
    runner,
    restricted: Object.freeze({}),
    crypto: Object.freeze({}),
    serverScope: "https://server.example.test",
    subject: Object.freeze({
      userId: ids.requestor,
      humanActorId: ids.requesterHuman,
    }),
    occurrence,
    reference,
    evidence: Object.freeze({
      requestId: reference.authorizationRequestId,
      policyRevision: reference.policyRevision,
      expiresAt: NOW + 60_000,
      result: Object.freeze({ objectId: resultObjectId }),
    }),
    jobId: ids.job,
    executionRoomId: ids.room,
    signal,
    now: () => NOW,
  } as unknown as Segment["current"];
  return Object.freeze({
    occurrence,
    policy: { mode: "shadow_encryption", shadowBehavior: "strict", revision: 4 },
    record: Object.freeze({}),
    request: Object.freeze({ sourceRoomId: ids.sourceRoom }),
    current,
    humanTurnId: `task-segment-turn:${ids.run}:1`,
    assertCurrentTaskAuthority: () => Promise.resolve(),
    domains: Object.freeze([]),
    signer: Object.freeze({
      runtime: Object.freeze({ agentId: ids.agent }),
      signerPublication: Object.freeze({ agentId: ids.agent }),
      agentAuthorizationRevision: 9,
    }),
    resolveHistoricalSignerPublicationManager: async () => null,
  }) as unknown as Segment;
}

function product(runner: ConversationProductCanonicalTransactionRunner) {
  return Object.freeze({
    handle: Object.freeze({ role: "nautilo" }) as
      ConversationProductPostgresHandle,
    canonicalRunner: runner,
  });
}

function admitted(mode: "shadow_encryption" | "encrypted_only" = "shadow_encryption") {
  const session = Object.freeze({
    sessionId: ids.session,
    ownerId: ids.owner,
    roomId: ids.room,
    namespaceId: ids.roomNamespace,
  });
  return Object.freeze({
    session,
    authority: Object.freeze({
      taskId: ids.task,
      taskRunId: ids.run,
      jobId: ids.job,
      taskOwnerId: ids.owner,
      graphThreadId,
      sessionId: ids.session,
      sessionOwnerId: ids.owner,
      executionRoomId: ids.room,
      roomId: ids.room,
      namespaceId: ids.roomNamespace,
      contentNamespaceId: ids.contentNamespace,
      contentRevision: 1,
      requiredNamespaceFingerprint: new Uint8Array(32).fill(3),
      agentId: ids.agent,
      requestorId: ids.requestor,
      requesterHumanId: ids.requesterHuman,
      inputObjectId,
      resultObjectId,
      authorizationRequestId: "request-1",
      executionSegment: 1,
      policyRevision: 4,
      definitionRepresentation: "dual" as const,
      representation: mode === "encrypted_only" ? "protected" as const : "dual" as const,
      authorizationExpiresAt: NOW + 60_000,
      signal: new AbortController().signal,
    }),
  });
}

type SessionRow = Readonly<{
  id: string;
  ownerId: string;
  personaId: string;
  agentId: string;
  roomId: string;
  threadId: string;
}>;

function canonicalRunnerFixture(options: Readonly<{
  missingTask?: boolean;
  initialSession?: SessionRow;
  racedSession?: SessionRow;
  roomOwnerId?: string;
  roomType?: string;
  roomKind?: string;
  roomHumanActorIds?: readonly string[];
  finalRoomOwnerId?: string;
  finalRoomType?: string;
  finalRoomKind?: string;
  finalRoomHumanActorIds?: readonly string[];
  sourceNamespaceId?: string;
  finalSourceHumanActorIds?: readonly string[];
  guardRoomNamespaceId?: string;
}> = {}) {
  const trace: string[] = [];
  const session: SessionRow = Object.freeze({
    id: ids.session,
    ownerId: ids.owner,
    personaId: "owner",
    agentId: ids.agent,
    roomId: options.roomKind === undefined || options.roomKind === "task"
      ? ids.sourceRoom : ids.room,
    threadId: graphThreadId,
  });
  const room = Object.freeze({
    id: ids.room,
    ownerId: options.roomOwnerId ?? ids.owner,
    namespaceId: ids.roomNamespace,
    type: options.roomType ?? "private",
    kind: options.roomKind ?? "task",
    parentRoomId: null,
    humanActorIds: [...(options.roomHumanActorIds ?? [])],
    archivedAt: null,
  });
  const sourceRoom = Object.freeze({
    id: ids.sourceRoom,
    ownerId: ids.requestor,
    namespaceId: options.sourceNamespaceId ?? ids.contentNamespace,
    type: "private",
    kind: "private",
    parentRoomId: null,
    humanActorIds: [ids.requesterHuman],
    archivedAt: null,
  });
  let inserted = false;
  let projectedSessionReads = 0;
  let projectedRoomReads = 0;
  let guardRoomReads = 0;
  const rowsFor = (table: unknown, projected: boolean): readonly unknown[] => {
    if (table === rooms && projected) {
      projectedRoomReads += 1;
      const hidden = room.kind === "task";
      if (hidden && projectedRoomReads % 2 === 0) return [{
        ...sourceRoom,
        humanActorIds: projectedRoomReads > 2
          ? [...(options.finalSourceHumanActorIds
            ?? sourceRoom.humanActorIds)]
          : sourceRoom.humanActorIds,
      }];
      const finalRead = hidden
        ? projectedRoomReads > 2
        : projectedRoomReads > 1;
      return [{
        ...room,
        ownerId: finalRead
          ? options.finalRoomOwnerId ?? room.ownerId
          : room.ownerId,
        type: finalRead
          ? options.finalRoomType ?? room.type
          : room.type,
        kind: finalRead
          ? options.finalRoomKind ?? room.kind
          : room.kind,
        humanActorIds: finalRead
          ? [...(options.finalRoomHumanActorIds ?? room.humanActorIds)]
          : room.humanActorIds,
      }];
    }
    if (table === sessions && projected) {
      projectedSessionReads += 1;
      if (projectedSessionReads === 1) {
        return options.initialSession === undefined ? [] : [options.initialSession];
      }
      return [options.racedSession ?? session];
    }
    if (table === encryptionTransitionPolicy) {
      return [{ id: "server", mode: "shadow_encryption", shadowBehavior: "strict", revision: 4 }];
    }
    if (table === tasks) return options.missingTask === true ? [] : [{
      id: ids.task,
      ownerId: ids.owner,
      requestorId: ids.requestor,
      agentId: ids.agent,
      targetRoomId: ids.room,
      contentRepresentation: "dual",
      contentNamespaceId: ids.contentNamespace,
      contentRevision: 1,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(3),
      cryptoObjectId: inputObjectId,
      cryptoMappingState: "verified",
      lastError: null,
      status: "running",
      scheduleKind: "now",
    }];
    if (table === taskRuns) return [{
      id: ids.run,
      taskId: ids.task,
      jobId: ids.job,
      graphThreadId,
      status: "running",
      completedAt: null,
      resultText: null,
      lastError: null,
    }];
    if (table === jobs) return [{
      id: ids.job,
      ownerId: ids.requestor,
      requestorId: ids.requestor,
      laneKey: `task:${ids.task}`,
      type: "foreground",
      status: "running",
      result: null,
      message: null,
      input: {
        kind: "protected_task_run_v1",
        taskId: ids.task,
        taskRunId: ids.run,
        inputObjectId,
        resultObjectId,
        authorizationRequestId: "request-1",
        executionSegment: 1,
        policyRevision: 4,
      },
    }];
    if (table === sessions) return [session];
    if (table === rooms) {
      guardRoomReads += 1;
      const selected = room.kind === "task" && guardRoomReads % 2 === 0
        ? sourceRoom : room;
      return [{
        ...selected,
        namespaceId: options.guardRoomNamespaceId ?? selected.namespaceId,
      }];
    }
    throw new Error("unexpected canonical transcript table");
  };
  const tx = {
    select(fields?: unknown) {
      return {
        from(table: unknown) {
          const projected = fields !== undefined;
          trace.push(`select:${table === rooms ? "rooms"
            : table === sessions ? "sessions"
              : table === encryptionTransitionPolicy ? "policy"
                : table === tasks ? "tasks"
                  : table === taskRuns ? "taskRuns"
                    : table === jobs ? "jobs" : "unknown"}${projected ? ":projection" : ""}`);
          const result = rowsFor(table, projected);
          const chain = {
            where() { return chain; },
            limit() { return chain; },
            for(lock: string) {
              if (table === tasks && projected) trace.push(`lock:tasks:${lock}`);
              return Promise.resolve(result);
            },
            then(
              onFulfilled: (value: readonly unknown[]) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) {
              return Promise.resolve(result).then(onFulfilled, onRejected);
            },
          };
          return chain;
        },
      };
    },
    insert(table: unknown) {
      expect(table).toBe(sessions);
      trace.push("insert:sessions");
      return {
        values(value: unknown) {
          expect(value).toMatchObject({
            ownerId: session.ownerId,
            agentId: ids.agent,
            roomId: session.roomId,
            threadId: graphThreadId,
            personaId: "owner",
          });
          return {
            onConflictDoNothing(conflict: unknown) {
              expect(conflict).toBeDefined();
              inserted = true;
              return Promise.resolve();
            },
          };
        },
      };
    },
    execute() {
      trace.push("lock:policy");
      return Promise.resolve([]);
    },
  };
  const runner = Object.freeze({
    role: "nautilo" as const,
    async transaction<Result>(
      callback: (transaction: unknown, executor: unknown) => Promise<Result>,
      transactionOptions: Readonly<{ isolationLevel: string }>,
    ): Promise<Result> {
      expect(transactionOptions).toEqual({ isolationLevel: "read committed" });
      trace.push("transaction:begin");
      try {
        const result = await callback(tx, Object.freeze({}));
        trace.push("transaction:commit");
        return result;
      } catch (error) {
        trace.push("transaction:rollback");
        throw error;
      }
    },
  }) as unknown as ConversationProductCanonicalTransactionRunner;
  return { runner, trace, wasInserted: () => inserted, session };
}

describe("protected Task native transcript composition", () => {
  test("creates and validates the canonical Task Session in one transaction", async () => {
    const fixture = canonicalRunnerFixture();
    const active = segment(fixture.runner, new AbortController().signal);
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    }, {
      verifyCryptoHandle: async () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as unknown as PostgresHumanDeviceSignerHistory,
    });
    await create(active);
    expect(fixture.wasInserted()).toBe(true);
    expect(fixture.trace).toEqual([
      "transaction:begin",
      "lock:policy",
      "select:policy:projection",
      "select:tasks:projection",
      "lock:tasks:share",
      "select:rooms:projection",
      "select:rooms:projection",
      "select:sessions:projection",
      "insert:sessions",
      "select:sessions:projection",
      "select:policy",
      "select:tasks",
      "select:taskRuns",
      "select:jobs",
      "select:sessions",
      "select:rooms",
      "select:rooms",
      "select:rooms:projection",
      "select:rooms:projection",
      "select:sessions:projection",
      "transaction:commit",
    ]);
  });

  test("locks the Task before Room admission and refuses a missing Task without creating a Session", async () => {
    const fixture = canonicalRunnerFixture({ missingTask: true });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    });
    await Promise.resolve(expect(create(segment(
      fixture.runner,
      new AbortController().signal,
    ))).rejects.toThrow("transcript Session is unavailable"));
    expect(fixture.wasInserted()).toBe(false);
    expect(fixture.trace).toEqual([
      "transaction:begin",
      "lock:policy",
      "select:policy:projection",
      "select:tasks:projection",
      "lock:tasks:share",
      "transaction:commit",
    ]);
  });

  test("re-reads the winning exact Session after a create conflict", async () => {
    const fixture = canonicalRunnerFixture();
    const active = segment(fixture.runner, new AbortController().signal);
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    }, {
      verifyCryptoHandle: async () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as unknown as PostgresHumanDeviceSignerHistory,
    });
    await create(active);
    expect(fixture.trace.filter(value => value === "select:sessions:projection"))
      .toHaveLength(3);
    expect(fixture.trace.at(-1)).toBe("transaction:commit");
  });

  test("rejects an existing Session attached to another Room", async () => {
    const fixture = canonicalRunnerFixture({
      initialSession: Object.freeze({
        id: ids.session,
        ownerId: ids.owner,
        personaId: "owner",
        agentId: ids.agent,
        roomId: "70000000-0000-4000-8000-000000000099",
        threadId: graphThreadId,
      }),
    });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    });
    await Promise.resolve(expect(create(segment(
      fixture.runner,
      new AbortController().signal,
    ))).rejects.toThrow("transcript Session is unavailable"));
    expect(fixture.wasInserted()).toBe(false);
    expect(fixture.trace.at(-1)).toBe("transaction:commit");
  });

  test.each([
    { roomType: "private", roomKind: "private" },
    { roomType: "private", roomKind: "group" },
    { roomType: "public", roomKind: "open" },
  ])("preserves an already admitted non-Task execution Room topology", async topology => {
    const fixture = canonicalRunnerFixture({
      roomOwnerId: ids.requestor,
      ...topology,
      roomHumanActorIds: [ids.requestor],
    });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    }, {
      verifyCryptoHandle: async () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as unknown as PostgresHumanDeviceSignerHistory,
    });
    await create(segment(
      fixture.runner,
      new AbortController().signal,
    ));
    expect(fixture.wasInserted()).toBe(true);
    expect(fixture.trace.at(-1)).toBe("transaction:commit");
  });

  test.each([
    { roomOwnerId: ids.requestor },
    { roomType: "public" },
    { roomHumanActorIds: [ids.requestor] },
  ])("rejects an invalid hidden Task Room before Session creation", async options => {
    const fixture = canonicalRunnerFixture(options);
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    });
    await Promise.resolve(expect(create(segment(
      fixture.runner,
      new AbortController().signal,
    ))).rejects.toThrow("transcript Session is unavailable"));
    expect(fixture.wasInserted()).toBe(false);
    expect(fixture.trace).toEqual([
      "transaction:begin",
      "lock:policy",
      "select:policy:projection",
      "select:tasks:projection",
      "lock:tasks:share",
      "select:rooms:projection",
      "transaction:commit",
    ]);
  });

  test("rolls back provisional Session metadata when the product guard rejects", async () => {
    const fixture = canonicalRunnerFixture({
      guardRoomNamespaceId: "80000000-0000-4000-8000-000000000099",
    });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    });
    await Promise.resolve(expect(create(segment(
      fixture.runner,
      new AbortController().signal,
    ))).rejects.toThrow("product authority changed"));
    expect(fixture.wasInserted()).toBe(true);
    expect(fixture.trace.at(-1)).toBe("transaction:rollback");
  });

  test("rolls back a provisional Session when the locked Room shape changed", async () => {
    const fixture = canonicalRunnerFixture({ finalRoomKind: "private" });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    });
    await Promise.resolve(expect(create(segment(
      fixture.runner,
      new AbortController().signal,
    ))).rejects.toThrow("transcript Session is unavailable"));
    expect(fixture.wasInserted()).toBe(true);
    expect(fixture.trace.slice(-3)).toEqual([
      "select:rooms:projection",
      "select:sessions:projection",
      "transaction:rollback",
    ]);
  });

  test("rolls back a provisional Session when an admitted Room topology changed", async () => {
    const fixture = canonicalRunnerFixture({
      roomOwnerId: ids.requestor,
      roomType: "public",
      roomKind: "open",
      roomHumanActorIds: [ids.requestor],
      finalRoomHumanActorIds: [ids.owner],
    });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    });
    await Promise.resolve(expect(create(segment(
      fixture.runner,
      new AbortController().signal,
    ))).rejects.toThrow("transcript Session is unavailable"));
    expect(fixture.wasInserted()).toBe(true);
    expect(fixture.trace.at(-1)).toBe("transaction:rollback");
  });

  test("rejects a substituted source Room Namespace before Session creation", async () => {
    const fixture = canonicalRunnerFixture({
      sourceNamespaceId: ids.roomNamespace,
    });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    });
    await Promise.resolve(expect(create(segment(
      fixture.runner,
      new AbortController().signal,
    ))).rejects.toThrow("transcript Session is unavailable"));
    expect(fixture.wasInserted()).toBe(false);
  });

  test("rolls back when the requester-private source audience changes", async () => {
    const fixture = canonicalRunnerFixture({
      finalSourceHumanActorIds: [ids.owner],
    });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(fixture.runner),
    });
    await Promise.resolve(expect(create(segment(
      fixture.runner,
      new AbortController().signal,
    ))).rejects.toThrow("transcript Session is unavailable"));
    expect(fixture.wasInserted()).toBe(true);
    expect(fixture.trace.at(-1)).toBe("transaction:rollback");
  });

  test.each(["shadow_encryption", "encrypted_only"] as const)("binds retained dual input to current %s transcript output", async mode => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const signal = new AbortController().signal;
    const current = { ...segment(runner, signal),
      policy: { mode, shadowBehavior: "strict" as const, revision: 4 } };
    const sourceBytes = [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
    ];
    let namespaceOpen = false;
    let published = 0;
    let validatedAuthority: Record<string, unknown> | null = null;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      admitTranscript: async (actualRunner, actual) => {
        expect(actualRunner).toBe(runner);
        expect(actual).toBe(current);
        const result = admitted(mode);
        validatedAuthority = result.authority as unknown as Record<string, unknown>;
        return result;
      },
      verifyCryptoHandle: async () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as unknown as PostgresHumanDeviceSignerHistory,
      withNamespaceSource: async (request, use) => {
        expect(request.namespaceId).toBe(ids.roomNamespace);
        expect(request.requiredOperations).toEqual(["decrypt", "encrypt"]);
        namespaceOpen = true;
        const source = {
          bindingBytes: sourceBytes[0]!,
          expectedBindingDigest: new Uint8Array([5]),
          issuerSigningPublicKey: sourceBytes[1]!,
        } as unknown as NativeTaskNamespaceSource;
        try {
          return await use(source);
        } finally {
          namespaceOpen = false;
          sourceBytes.forEach(bytes => bytes.fill(0));
        }
      },
      createPublication: publication => {
        expect(namespaceOpen).toBe(true);
        expect(publication.preparation.namespace.bindingBytes)
          .toBe(sourceBytes[0]!);
        expect(publication.authority.productAuthority.namespaceId)
          .toBe(ids.roomNamespace);
        expect(publication.authority.productAuthority.contentNamespaceId)
          .toBe(ids.contentNamespace);
        return async request => {
          expect(namespaceOpen).toBe(true);
          expect(request.signal).toBe(signal);
          published += 1;
        };
      },
    });

    const publish = await create(current);
    expect(validatedAuthority).toMatchObject({
      definitionRepresentation: "dual",
      representation: mode === "encrypted_only" ? "protected" : "dual",
      sessionId: ids.session,
      sessionOwnerId: ids.owner,
      roomId: ids.room,
      namespaceId: ids.roomNamespace,
      contentNamespaceId: ids.contentNamespace,
    });
    await publish(Object.freeze({
      identity: Object.freeze({
        taskId: ids.task,
        taskRunId: ids.run,
        graphThreadId,
        roomId: ids.room,
        humanTurnId: current.humanTurnId,
        agentId: ids.agent,
      }),
      idempotencyKey: `task-transcript:${ids.run}:fp:v1:test`,
      fingerprint: "fp:v1:test",
      payload: Object.freeze({ role: "assistant", content: "secret" }),
      signal,
    }));
    expect(published).toBe(1);
    expect(namespaceOpen).toBe(false);
    expect(sourceBytes).toEqual([new Uint8Array(2), new Uint8Array(2)]);
  });

  test("refuses a mismatched existing Session before product or Namespace use", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const current = segment(runner, new AbortController().signal);
    let admissionAttempts = 0;
    let namespaceUses = 0;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      admitTranscript: async () => {
        admissionAttempts += 1;
        return null;
      },
      withNamespaceSource: async () => {
        namespaceUses += 1;
        throw new Error("must not open Namespace");
      },
    });
    await Promise.resolve(expect(create(current)).rejects.toThrow(
      "transcript Session is unavailable",
    ));
    expect(admissionAttempts).toBe(1);
    expect(namespaceUses).toBe(0);
  });

  test("rejects an expired grant before creating a Session", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const active = segment(runner, new AbortController().signal);
    const expired = {
      ...active,
      current: {
        ...active.current,
        evidence: { ...active.current.evidence, expiresAt: NOW },
      },
    } as Segment;
    let sessionUses = 0;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      admitTranscript: async () => {
        sessionUses += 1;
        return admitted();
      },
    });
    await Promise.resolve(expect(create(expired)).rejects.toThrow(
      "transcript identity is unavailable",
    ));
    expect(sessionUses).toBe(0);
  });

  test("stops a stale execution Room Namespace before opening its secrets", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const active = segment(runner, new AbortController().signal);
    let namespaceUses = 0;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      admitTranscript: async () => {
        throw new TypeError("Room Namespace changed");
      },
      withNamespaceSource: async () => {
        namespaceUses += 1;
        throw new Error("must not open Namespace");
      },
    });
    await Promise.resolve(expect(create(active)).rejects.toThrow(
      "Room Namespace changed",
    ));
    expect(namespaceUses).toBe(0);
  });

  test("denied Namespace authority never constructs a publication", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const active = segment(runner, new AbortController().signal);
    let publications = 0;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      admitTranscript: async () => admitted(),
      verifyCryptoHandle: async () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as unknown as PostgresHumanDeviceSignerHistory,
      withNamespaceSource: async request => {
        expect(request.requiredOperations).toEqual(["decrypt", "encrypt"]);
        throw new TypeError("Namespace grant is unavailable");
      },
      createPublication: () => {
        publications += 1;
        return async () => undefined;
      },
    });
    const publish = await create(active);
    await Promise.resolve(expect(publish({
      identity: {
        taskId: ids.task,
        taskRunId: ids.run,
        graphThreadId,
        roomId: ids.room,
        humanTurnId: active.humanTurnId,
        agentId: ids.agent,
      },
      idempotencyKey: `task-transcript:${ids.run}:fp:v1:denied`,
      fingerprint: "fp:v1:denied",
      payload: { role: "assistant", content: "secret" },
      signal: active.current.signal,
    })).rejects.toThrow("Namespace grant is unavailable"));
    expect(publications).toBe(0);
  });

  test("keeps overlapping publication sources separate and wipes each one", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const active = segment(runner, new AbortController().signal);
    const buffers: Uint8Array[] = [];
    let entered = 0;
    let releasePublications: (() => void) | undefined;
    let reportEntered: (() => void) | undefined;
    const publicationGate = new Promise<void>(resolve => {
      releasePublications = resolve;
    });
    const bothEntered = new Promise<void>(resolve => {
      reportEntered = resolve;
    });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      admitTranscript: async () => admitted(),
      verifyCryptoHandle: async () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as unknown as PostgresHumanDeviceSignerHistory,
      withNamespaceSource: async (_request, use) => {
        const bytes = new Uint8Array([buffers.length + 1]);
        buffers.push(bytes);
        try {
          return await use({
            bindingBytes: bytes,
            expectedBindingDigest: new Uint8Array([7]),
            issuerSigningPublicKey: new Uint8Array([8]),
          } as unknown as NativeTaskNamespaceSource);
        } finally {
          bytes.fill(0);
        }
      },
      createPublication: publication => {
        const bytes = publication.preparation.namespace.bindingBytes;
        return async () => {
          expect(bytes[0]).toBeGreaterThan(0);
          entered += 1;
          if (entered === 2) reportEntered?.();
          await publicationGate;
          expect(bytes[0]).toBeGreaterThan(0);
        };
      },
    });
    const publish = await create(active);
    const request = (fingerprint: string) => ({
      identity: {
        taskId: ids.task,
        taskRunId: ids.run,
        graphThreadId,
        roomId: ids.room,
        humanTurnId: active.humanTurnId,
        agentId: ids.agent,
      },
      idempotencyKey: `task-transcript:${ids.run}:${fingerprint}`,
      fingerprint,
      payload: { role: "assistant" as const, content: "secret" },
      signal: active.current.signal,
    });
    const first = publish(request("fp:v1:first"));
    const second = publish(request("fp:v1:second"));
    await bothEntered;
    expect(buffers).toHaveLength(2);
    expect(buffers[0]).not.toBe(buffers[1]);
    expect(buffers.map(bytes => bytes[0])).toEqual([1, 2]);
    releasePublications?.();
    await Promise.all([first, second]);
    expect(buffers.map(bytes => bytes[0])).toEqual([0, 0]);
  });
});
