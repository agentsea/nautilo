import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { expect, test } from "bun:test";

import {
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunCancelledResultOperationId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
  type PostgresJsBridgeConnection, type ProtectedTaskWakeContinuationReceipt,
  tasks, taskRuns, jobs, protectedTaskRunOutputBindings, protectedTaskWakeContinuationReceipts,
  withCurrentProtectedTaskWakeContinuation, readLatestProtectedTaskWakeContinuation,
  protectedTaskSemanticAuthorityRequirementsDigest,
} from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import {
  createProtectedTaskOutputReadProductProofLoader,
  createProtectedTaskWakeSettledProductProofLoader,
  withCommittedProtectedTaskWakeSettlement,
  withCommittedProtectedTaskWakePark, readCommittedProtectedTaskWakePark,
  createProtectedTaskWakeParkingProductProofLoader, createProtectedTaskWakeParkedProductProofLoader,
  createProtectedTaskOutputReadRecoveryProductProofLoader,
  readProtectedTaskOutputReadIntent,
  type ProtectedTaskOutputReadClosedProof,
  type ProtectedTaskOutputReadIntent,
} from "../../src/routes/protected-task-output-read-product";

const TASK = "10000000-0000-4000-8000-000000000101";
const RUN = "20000000-0000-4000-8000-000000000102";
const USER = "30000000-0000-4000-8000-000000000103";
const HUMAN = "40000000-0000-4000-8000-000000000104";
const AGENT = "50000000-0000-4000-8000-000000000105";
const ROOM = "60000000-0000-4000-8000-000000000106";
const ROOM_OWNER = "70000000-0000-4000-8000-000000000107";
const CONTENT_NAMESPACE = "80000000-0000-4000-8000-000000000108";
const DESTINATION_NAMESPACE = "90000000-0000-4000-8000-000000000109";
const SESSION = "a0000000-0000-4000-8000-000000000110";
const TERMINAL_AT = new Date("2026-10-12T08:00:00.000Z");
const GENESIS = new Uint8Array(32).fill(0x45);
const REQUIRED = new Uint8Array(32).fill(0x46);

function binding(input: Readonly<{
  revision?: 1 | 2;
  mode?: "raw" | "raw_and_wake" | "wake";
  overrides?: Record<string, unknown>;
}> = {}) {
  const revision = input.revision ?? 1;
  const mode = input.mode ?? "raw";
  return {
    taskRunId: RUN,
    bindingId: protectedTaskRunOutputBindingId(RUN),
    deliveryMode: mode,
    destinationRoomId: ROOM,
    destinationNamespaceId: DESTINATION_NAMESPACE,
    resultRevision: revision,
    resultOperationId: revision === 1
      ? protectedTaskRunResultOperationId(RUN)
      : protectedTaskRunCancelledResultOperationId(RUN),
    resultObjectId: revision === 1
      ? protectedTaskRunResultObjectId(TASK, RUN)
      : protectedTaskRunCancelledResultObjectId(TASK, RUN),
    messageOperationId: mode === "wake"
      ? null : protectedTaskRunMessageOperationId(RUN),
    wakeOperationId: mode === "raw"
      ? null : protectedTaskRunWakeOperationId(RUN),
    acceptedPolicyRevision: 8,
    acceptedAt: new Date(TERMINAL_AT.getTime() - 5_000),
    resultTerminalAt: TERMINAL_AT,
    resultAttachedAt: TERMINAL_AT,
    messageId: null,
    messagePublishedAt: null,
    wakeJobId: mode === "raw" ? null : protectedTaskRunWakeJobId(RUN),
    wakeScheduledAt: mode === "raw" ? null : new Date(TERMINAL_AT.getTime() + 1_000),
    completedAt: mode === "raw" ? null : new Date(TERMINAL_AT.getTime() + 1_000),
    ...input.overrides,
  };
}

type FixtureOptions = Readonly<{
  revision?: 1 | 2;
  mode?: "raw" | "raw_and_wake" | "wake";
  policyMode?: "encrypted_only" | "shadow_encryption";
  representation?: "protected" | "dual";
  task?: Record<string, unknown>;
  binding?: Record<string, unknown> | null;
  run?: Record<string, unknown>;
  ledger?: Record<string, unknown>;
  session?: Record<string, unknown> | null;
  createSession?: boolean;
  job?: Record<string, unknown>;
}>;

function fixture(options: FixtureOptions = {}) {
  let continuation: ProtectedTaskWakeContinuationReceipt | undefined;
  const revision = options.revision ?? 1;
  const mode = options.mode ?? "raw";
  const representation = options.representation ?? "protected";
  const objectId = revision === 1
    ? protectedTaskRunResultObjectId(TASK, RUN)
    : protectedTaskRunCancelledResultObjectId(TASK, RUN);
  const operationId = revision === 1
    ? protectedTaskRunResultOperationId(RUN)
    : protectedTaskRunCancelledResultOperationId(RUN);
  const outputBinding = options.binding === null ? null
    : { ...binding({ revision, mode }), ...options.binding };
  const graphThreadId = `room:${ROOM}:bot:${AGENT}`;
  const reference = {
    kind: "protected_task_delivery_v1",
    taskId: TASK,
    taskRunId: RUN,
    bindingId: protectedTaskRunOutputBindingId(RUN),
    resultObjectId: objectId,
    wakeOperationId: protectedTaskRunWakeOperationId(RUN),
  };
  const rows: readonly (readonly unknown[])[] = [
    [{ mode: options.policyMode ?? (representation === "protected"
      ? "encrypted_only" : "shadow_encryption"), revision: 9 }],
    [{ id: TASK, ownerId: USER, requesterUserId: USER, agentId: AGENT,
      callingRoomId: ROOM, resultDelivery: mode,
      status: revision === 2 ? "cancelled" : "pending",
      cancelledAt: revision === 2 ? TERMINAL_AT : null,
      representation, contentNamespaceId: CONTENT_NAMESPACE,
      contentRevision: 3, cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
      cryptoAccessRevision: 0, cryptoRequiredNamespaceFingerprint: REQUIRED,
      cryptoMappingState: "verified", promptIsEmpty: representation === "protected",
      expectedOutputIsNull: representation === "protected", lastErrorIsNull: true,
      ...options.task }],
    [{ id: RUN, taskId: TASK,
      status: revision === 2 ? "cancelled" : "completed",
      completedAt: TERMINAL_AT, representation,
      contentNamespaceId: CONTENT_NAMESPACE, revision, objectId,
      accessRevision: 0, requiredNamespaceFingerprint: REQUIRED,
      mappingState: "verified", resultTextIsNull: representation === "protected",
      resultTextIsCancelled: revision === 2 && representation === "dual",
      lastErrorIsNull: true, ...options.run }],
    outputBinding === null ? [] : [outputBinding],
    [{ taskId: TASK, taskRunId: RUN, revision, operationId,
      requestDigest: GENESIS, requesterHumanId: HUMAN,
      contentNamespaceId: CONTENT_NAMESPACE, anchorNamespaceId: CONTENT_NAMESPACE,
      objectId, representation, payloadVersion: 1, accessRevision: 0,
      requiredNamespaceFingerprint: REQUIRED, completion: "complete",
      disposition: "mapped", nextAttemptAt: null, leaseToken: null,
      leaseExpiresAt: null, failureCode: null, cryptoCompletedAt: TERMINAL_AT,
      ...options.ledger }],
    [{ id: ROOM, ownerId: ROOM_OWNER, namespaceId: DESTINATION_NAMESPACE,
      graphThreadId: "thread", archivedAt: null }],
    [
      { kind: "user", ownerId: USER, agentId: null },
      { kind: "user", ownerId: ROOM_OWNER, agentId: null },
      { kind: "agent", ownerId: ROOM_OWNER, agentId: AGENT },
    ],
    options.session === null ? [] : [{ id: SESSION, ownerId: ROOM_OWNER,
      agentId: AGENT, roomId: ROOM, threadId: graphThreadId,
      personaId: "owner", endedAt: null, ...options.session }],
    ...(options.createSession === true ? [[{ id: SESSION, ownerId: ROOM_OWNER,
      agentId: AGENT, roomId: ROOM, threadId: graphThreadId,
      personaId: "owner" }]] : []),
    ...(mode === "raw" ? [] : [[{ id: protectedTaskRunWakeJobId(RUN),
      ownerId: USER, requestorId: USER, laneKey: `room:${ROOM}`, roomId: ROOM,
      type: "foreground", status: "queued", input: reference,
      resultIsNull: true, messageIsNull: true, metadataIsEmpty: true,
      createdAt: new Date(TERMINAL_AT.getTime() + 1_000),
      startedAt: null, completedAt: null, ...options.job }], []]),
  ];
  let index = 0;
  const events: string[] = [];
  const projections: (readonly string[] | null)[] = [];
  const tx = {
    insert() {
      return { values(value: Record<string, unknown>) {
        expect(value).toEqual({ ownerId: ROOM_OWNER, agentId: AGENT, roomId: ROOM,
          threadId: graphThreadId, personaId: "owner", title: null });
        return { onConflictDoNothing: async () => { events.push("insert-session"); } };
      } };
    },
    select(projection?: Record<string, unknown>) {
      projections.push(projection === undefined ? null : Object.keys(projection));
      const nominal = projection === undefined && mode !== "raw" && index >= rows.length - 1;
      const selected = nominal ? [] : rows[index++];
      if (selected === undefined) throw new Error("Unexpected product read");
      let table: unknown;
      let priorReceiptQuery = false;
      const finish = (lock?: string) => {
        events.push(lock ?? "read");
        if (nominal) {
          const task = rows[1]![0] as Record<string, unknown>;
          const run = rows[2]![0] as Record<string, unknown>;
          const job = rows.at(-2)![0] as Record<string, unknown>;
          if (table === protectedTaskWakeContinuationReceipts) return Promise.resolve(priorReceiptQuery || continuation === undefined ? [] : [continuation]);
          if (table === tasks) return Promise.resolve([{ ...task, requestorId: USER,
            contentRepresentation: representation }]);
          if (table === taskRuns) return Promise.resolve([{ ...run, resultRepresentation: representation,
            resultCryptoMappingState: run["mappingState"], resultRevision: run["revision"],
            resultCryptoObjectId: run["objectId"], resultContentNamespaceId: CONTENT_NAMESPACE }]);
          if (table === protectedTaskRunOutputBindings) return Promise.resolve(outputBinding === null ? [] : [outputBinding]);
          if (table === jobs) return Promise.resolve([{ ...job, result: null, message: null, metadata: {} }]);
          throw new Error("Unknown nominal proof table");
        }
        return Promise.resolve(selected);
      };
      const chain = {
        from: (value: unknown) => { table = value; return chain; },
        innerJoin: () => chain,
        orderBy: () => chain,
        where: (condition: SQL) => { priorReceiptQuery = new PgDialect().sqlToQuery(condition).sql.includes(" < "); return chain; },
        limit: () => chain,
        for: (lock: string) => finish(lock),
        then: (resolve: (value: readonly unknown[]) => unknown,
          reject?: (reason: unknown) => unknown) => finish().then(resolve, reject),
      };
      return chain;
    },
  } as unknown as CanonicalTranscriptTx;
  return { tx, events, projections,
    setContinuation(value: ProtectedTaskWakeContinuationReceipt | undefined) { continuation = value; index = 0; },
    setWakeJob(value: Record<string, unknown>) {
      const row = rows.at(-2)?.[0];
      if (mode === "raw" || typeof row !== "object" || row === null) throw new Error("Wake fixture required");
      Object.assign(row, value); index = 0;
    },
  };
}

test("Session creation is explicit, structural and restricted to detached preparation", async () => {
  const missing = fixture({ session: null });
  expect(await readProtectedTaskOutputReadIntent(missing.tx, { taskId: TASK, taskRunId: RUN, kind: "raw" })).toBeNull();
  expect(missing.events).not.toContain("insert-session");
  const creating = fixture({ session: null, createSession: true });
  expect((await readProtectedTaskOutputReadIntent(creating.tx,
    { taskId: TASK, taskRunId: RUN, kind: "raw" }, { ensureDestinationSession: true }))?.invocation.sessionId).toBe(SESSION);
  expect(creating.events.filter(event => event === "insert-session")).toHaveLength(1);
});

test("loads mapped revision-one raw result from the durable genesis digest in canonical lock order", async () => {
  const { tx, events, projections } = fixture();
  const intent = await readProtectedTaskOutputReadIntent(tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  });
  expect(intent?.result.terminalStatus).toBe("completed");
  expect(intent?.result.contentRevision).toBe(1);
  expect(intent?.result.genesisManifestHash).toEqual(GENESIS);
  expect(intent?.requesterHumanId).toBe(HUMAN);
  expect(intent?.invocation).toEqual({
    kind: "raw", bindingId: protectedTaskRunOutputBindingId(RUN),
    operationId: protectedTaskRunMessageOperationId(RUN),
    roomId: ROOM, sessionId: SESSION,
  });
  expect(events).toEqual([
    "share", "no key update", "update", "update", "share",
    "share", "share", "share",
  ]);
  expect(projections.flatMap(value => value ?? [])).not.toContain("prompt");
  expect(projections.flatMap(value => value ?? [])).not.toContain("resultText");
  expect(projections.flatMap(value => value ?? [])).not.toContain("lastError");

  const errored = fixture({ run: { status: "errored" } });
  expect((await readProtectedTaskOutputReadIntent(errored.tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  }))?.result.terminalStatus).toBe("errored");

  const shadowError = fixture({ representation: "dual",
    policyMode: "shadow_encryption", task: { lastErrorIsNull: false },
    run: { status: "errored", resultTextIsNull: true, lastErrorIsNull: false } });
  expect((await readProtectedTaskOutputReadIntent(shadowError.tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  }))?.result.terminalStatus).toBe("errored");

  const oldCompleted = fixture({ representation: "dual",
    policyMode: "shadow_encryption", task: { status: "cancelled",
      cancelledAt: new Date(TERMINAL_AT.getTime() + 5_000), lastErrorIsNull: false } });
  expect((await readProtectedTaskOutputReadIntent(oldCompleted.tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  }))?.result.terminalStatus).toBe("completed");

  const malformedFull = fixture({ task: { lastErrorIsNull: false } });
  expect(await readProtectedTaskOutputReadIntent(malformedFull.tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  })).toBeNull();
});

test("loads exact revision-two cancellation and rejects malformed product coordinates", async () => {
  const exact = fixture({ revision: 2, representation: "dual",
    policyMode: "shadow_encryption" });
  const intent = await readProtectedTaskOutputReadIntent(exact.tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  });
  expect(intent?.result.terminalStatus).toBe("cancelled");
  expect(intent?.result.contentRevision).toBe(2);

  for (const options of [
    { binding: null },
    { binding: { taskRunId: "20000000-0000-4000-8000-000000000999" } },
    { run: { taskId: "20000000-0000-4000-8000-000000000999" } },
    { run: { mappingState: "unmapped" } },
    { ledger: { requestDigest: new Uint8Array(31) } },
    { ledger: { disposition: "active" } },
    { ledger: { leaseToken: "b0000000-0000-4000-8000-000000000111",
      leaseExpiresAt: new Date(TERMINAL_AT.getTime() + 60_000) } },
    { ledger: { operationId: protectedTaskRunResultOperationId(RUN) } },
  ] satisfies FixtureOptions[]) {
    const current = fixture({ revision: 2, representation: "dual",
      policyMode: "shadow_encryption", ...options });
    expect(await readProtectedTaskOutputReadIntent(current.tx, {
      taskId: TASK, taskRunId: RUN, kind: "raw",
    })).toBeNull();
  }
});

test("requires the current canonical Session and exact queued wake reference", async () => {
  const current = fixture({ mode: "wake" });
  const intent = await readProtectedTaskOutputReadIntent(current.tx, {
    taskId: TASK, taskRunId: RUN, kind: "wake",
  });
  expect(intent?.initialState).toBe("wake_queued");
  expect(intent?.invocation.kind).toBe("wake");
  if (intent?.invocation.kind !== "wake") throw new Error("wake expected");
  expect(intent.invocation.jobId).toBe(protectedTaskRunWakeJobId(RUN));
  expect(Object.keys(intent.invocation.reference).sort()).toEqual([
    "bindingId", "kind", "resultObjectId", "taskId", "taskRunId",
    "wakeOperationId",
  ]);

  const activeSession = fixture({ mode: "wake", session: { endedAt: TERMINAL_AT } });
  expect((await readProtectedTaskOutputReadIntent(activeSession.tx, {
    taskId: TASK, taskRunId: RUN, kind: "wake",
  }))?.initialState).toBe("wake_queued");
  const wrongSession = fixture({ mode: "wake", session: {
    roomId: "60000000-0000-4000-8000-000000000999",
  } });
  expect(await readProtectedTaskOutputReadIntent(wrongSession.tx, {
    taskId: TASK, taskRunId: RUN, kind: "wake",
  })).toBeNull();
  const wrongReference = fixture({ mode: "wake", job: { input: {
    kind: "protected_task_delivery_v1", taskId: TASK, taskRunId: RUN,
  } } });
  expect(await readProtectedTaskOutputReadIntent(wrongReference.tx, {
    taskId: TASK, taskRunId: RUN, kind: "wake",
  })).toBeNull();
  const uncertain = fixture({ mode: "wake", job: { status: "running",
    startedAt: TERMINAL_AT } });
  expect((await readProtectedTaskOutputReadIntent(uncertain.tx, {
    taskId: TASK, taskRunId: RUN, kind: "wake",
  }))?.initialState).toBe("wake_running");
  for (const status of ["completed", "failed"] as const) {
    const terminal = fixture({ mode: "wake", job: { status,
      startedAt: TERMINAL_AT, completedAt: TERMINAL_AT } });
    expect(await readProtectedTaskOutputReadIntent(terminal.tx, {
      taskId: TASK, taskRunId: RUN, kind: "wake",
    })).toBeNull();
  }
});

function closedIntent(kind: "raw" | "wake"): ProtectedTaskOutputReadIntent {
  const objectId = protectedTaskRunResultObjectId(TASK, RUN);
  const common: Omit<ProtectedTaskOutputReadClosedProof, "invocation"> = {
    requesterUserId: USER, requesterHumanId: HUMAN, agentId: AGENT,
    contentNamespaceId: CONTENT_NAMESPACE, representation: "protected",
    expectedPolicyRevision: 9, acceptedPolicyRevision: 8,
    result: { taskId: TASK, taskRunId: RUN, terminalStatus: "completed",
      contentRevision: 1, objectId, cryptoAccessRevision: 0,
      genesisManifestHash: GENESIS, signerAgentId: AGENT },
  };
  return Object.freeze({ ...common,
    initialState: kind === "raw" ? "raw_unpublished" : "wake_running",
    invocation: kind === "raw" ? {
      kind, bindingId: protectedTaskRunOutputBindingId(RUN),
      operationId: protectedTaskRunMessageOperationId(RUN),
      roomId: ROOM, sessionId: SESSION,
    } : {
      kind, bindingId: protectedTaskRunOutputBindingId(RUN),
      operationId: protectedTaskRunWakeOperationId(RUN),
      roomId: ROOM, sessionId: SESSION,
      jobId: protectedTaskRunWakeJobId(RUN),
      reference: { kind: "protected_task_delivery_v1" as const, taskId: TASK,
        taskRunId: RUN, bindingId: protectedTaskRunOutputBindingId(RUN),
        resultObjectId: objectId,
        wakeOperationId: protectedTaskRunWakeOperationId(RUN) },
    },
  });
}

test("two-phase proof exposes nothing early and permits only its own safe progression", async () => {
  const intent = closedIntent("raw");
  const currentBinding = binding();
  const trace: string[] = [];
  let state: "raw_unpublished" | "raw_published" = "raw_unpublished";
  const loader = createProtectedTaskOutputReadProductProofLoader(intent, {
    loadProduct: async () => {
      trace.push("product");
      return { proof: { ...intent, result: intent.result },
        binding: currentBinding, terminalAt: TERMINAL_AT };
    },
    loadForeground: async () => {
      trace.push("foreground");
      return { invocation: intent.invocation, state };
    },
  });
  const tx = {} as CanonicalTranscriptTx;
  const product = {} as PostgresJsBridgeConnection;
  expect(await loader.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(loader.readCurrent()).toBeNull();
  expect(await loader.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(true);
  expect(loader.readCurrent()).not.toBeNull();
  state = "raw_published";
  expect(await loader.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await loader.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(true);
  expect(trace).toEqual(["product", "foreground", "product", "foreground"]);

  const fresh = createProtectedTaskOutputReadProductProofLoader(intent, {
    loadProduct: async () => ({ proof: { ...intent, result: intent.result },
      binding: currentBinding, terminalAt: TERMINAL_AT }),
    loadForeground: async () => ({ invocation: intent.invocation,
      state: "raw_published" as const }),
  });
  expect(await fresh.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await fresh.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(false);
  expect(fresh.readCurrent()).toBeNull();
  expect(await fresh.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await fresh.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(false);
});

test("receipt recovery admits published metadata without enabling another fresh read", async () => {
  const intent = closedIntent("raw");
  const product = {} as PostgresJsBridgeConnection;
  const tx = {} as CanonicalTranscriptTx;
  const dependencies = {
    loadProduct: async () => ({ proof: intent, binding: binding(), terminalAt: TERMINAL_AT }),
    loadForeground: async () => ({ invocation: intent.invocation, state: "raw_published" as const }),
  };
  const recovery = createProtectedTaskOutputReadRecoveryProductProofLoader(intent, dependencies);
  expect(await recovery.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(recovery.readCurrent()).toBeNull();
  expect(await recovery.validateCurrentForeground(product, tx, { destinationRoomId: ROOM,
    destinationNamespaceId: DESTINATION_NAMESPACE, foregroundNamespaceIds: [DESTINATION_NAMESPACE] })).toBe(true);
  expect(recovery.readCurrent()?.result.genesisManifestHash).toEqual(GENESIS);
  const fresh = createProtectedTaskOutputReadProductProofLoader(intent, dependencies);
  expect(await fresh.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await fresh.validateCurrentForeground(product, tx, { destinationRoomId: ROOM,
    destinationNamespaceId: DESTINATION_NAMESPACE, foregroundNamespaceIds: [DESTINATION_NAMESPACE] })).toBe(false);
  expect(() => createProtectedTaskOutputReadRecoveryProductProofLoader(closedIntent("wake"), dependencies)).toThrow(TypeError);
});

test("proof rejects a changed invocation, transaction, or current digest", async () => {
  const intent = closedIntent("wake");
  const product = {} as PostgresJsBridgeConnection;
  const tx = {} as CanonicalTranscriptTx;
  const otherTx = {} as CanonicalTranscriptTx;
  const make = (digest = GENESIS, sessionId = SESSION) =>
    createProtectedTaskOutputReadProductProofLoader(intent, {
      loadProduct: async () => ({ proof: { ...intent,
        result: { ...intent.result, genesisManifestHash: digest } },
      binding: binding({ mode: "wake" }), terminalAt: TERMINAL_AT }),
      loadForeground: async () => ({ invocation: { ...intent.invocation,
        sessionId } as typeof intent.invocation, state: "wake_running" as const }),
    });
  const wrongDigest = make(new Uint8Array(32).fill(1));
  expect(await wrongDigest.validateCurrentTaskRun(product, tx)).toBe(false);
  expect(wrongDigest.readCurrent()).toBeNull();
  const wrongInvocation = make(GENESIS, ROOM);
  expect(await wrongInvocation.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await wrongInvocation.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(false);
  expect(wrongInvocation.readCurrent()).toBeNull();
  const loader = make();
  expect(await loader.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await loader.validateCurrentForeground(product, otherTx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(false);
  expect(loader.readCurrent()).toBeNull();
});

test("wake proof permits only queued-to-running or running-to-terminal progression", async () => {
  const product = {} as PostgresJsBridgeConnection;
  const tx = {} as CanonicalTranscriptTx;
  const currentBinding = binding({ mode: "wake" });

  const queuedIntent = Object.freeze({ ...closedIntent("wake"),
    initialState: "wake_queued" as const });
  let queuedState: "wake_queued" | "wake_running" | "wake_completed" = "wake_queued";
  const queued = createProtectedTaskOutputReadProductProofLoader(queuedIntent, {
    loadProduct: async () => ({ proof: { ...queuedIntent, result: queuedIntent.result },
      binding: currentBinding, terminalAt: TERMINAL_AT }),
    loadForeground: async () => ({ invocation: queuedIntent.invocation,
      state: queuedState }),
  });
  expect(await queued.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await queued.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(true);
  queuedState = "wake_running";
  expect(await queued.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await queued.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(true);
  queuedState = "wake_completed";
  expect(await queued.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await queued.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(false);

  const runningIntent = closedIntent("wake");
  let runningState: "wake_running" | "wake_failed" = "wake_running";
  const running = createProtectedTaskOutputReadProductProofLoader(runningIntent, {
    loadProduct: async () => ({ proof: { ...runningIntent, result: runningIntent.result },
      binding: currentBinding, terminalAt: TERMINAL_AT }),
    loadForeground: async () => ({ invocation: runningIntent.invocation,
      state: runningState }),
  });
  expect(await running.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await running.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(true);
  runningState = "wake_failed";
  expect(await running.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await running.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(true);

  const freshTerminal = createProtectedTaskOutputReadProductProofLoader(runningIntent, {
    loadProduct: async () => ({ proof: { ...runningIntent, result: runningIntent.result },
      binding: currentBinding, terminalAt: TERMINAL_AT }),
    loadForeground: async () => ({ invocation: runningIntent.invocation,
      state: "wake_failed" as const }),
  });
  expect(await freshTerminal.validateCurrentTaskRun(product, tx)).toBe(true);
  expect(await freshTerminal.validateCurrentForeground(product, tx, {
    destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
    foregroundNamespaceIds: [DESTINATION_NAMESPACE],
  })).toBe(false);
});


const wakeStartedAt = new Date(TERMINAL_AT.getTime() + 2_000);
const wakeCompletedAt = new Date(TERMINAL_AT.getTime() + 3_000);
const wakeForeground = { destinationRoomId: ROOM, destinationNamespaceId: DESTINATION_NAMESPACE,
  foregroundNamespaceIds: [DESTINATION_NAMESPACE] };
const productHandle = {} as PostgresJsBridgeConnection;
async function validateWake(loader: ReturnType<typeof createProtectedTaskOutputReadProductProofLoader>, tx: CanonicalTranscriptTx) {
  if (!await loader.validateCurrentTaskRun(productHandle, tx)) return false;
  return loader.validateCurrentForeground(productHandle, tx, wakeForeground);
}
async function committedWake(status: "completed" | "failed" = "completed") {
  const intent = closedIntent("wake");
  const current = fixture({ mode: "wake", job: { status: "running", startedAt: wakeStartedAt } });
  const loader = createProtectedTaskOutputReadProductProofLoader(intent);
  return { intent, ...(await withCommittedProtectedTaskWakeSettlement(async capture => {
    expect(await validateWake(loader, current.tx)).toBe(true);
    current.setWakeJob({ status, completedAt: wakeCompletedAt });
    expect(await validateWake(loader, current.tx)).toBe(true);
    capture(loader);
    return "committed";
  })) };
}

for (const status of ["completed", "failed"] as const) test(`committed ${status} proof permits exact fresh-transaction revalidation only`, async () => {
  const { intent, receipt, value } = await committedWake(status);
  expect(value).toBe("committed");
  expect(receipt).not.toBeNull();
  if (receipt === null) throw new Error("Receipt missing");
  const terminal = () => fixture({ mode: "wake", job: { status,
    startedAt: wakeStartedAt, completedAt: wakeCompletedAt } });
  const fresh = createProtectedTaskOutputReadProductProofLoader(intent);
  expect(await validateWake(fresh, terminal().tx)).toBe(false);
  const settled = createProtectedTaskWakeSettledProductProofLoader(intent, receipt);
  expect(await validateWake(settled, terminal().tx)).toBe(true);
  expect(settled.readCurrent()?.result.genesisManifestHash).toEqual(GENESIS);
  expect(await readProtectedTaskOutputReadIntent(terminal().tx,
    { taskId: TASK, taskRunId: RUN, kind: "wake" })).toBeNull();
  expect(() => createProtectedTaskWakeSettledProductProofLoader(intent, { ...receipt })).toThrow(TypeError);
  expect(() => createProtectedTaskWakeSettledProductProofLoader({ ...intent,
    result: { ...intent.result, genesisManifestHash: new Uint8Array(32) } }, receipt)).toThrow(TypeError);
  expect(() => createProtectedTaskWakeSettledProductProofLoader(closedIntent("raw"), receipt)).toThrow(TypeError);
  for (const options of [
    { job: { status: "running", startedAt: wakeStartedAt } },
    { job: { status: status === "completed" ? "failed" : "completed", startedAt: wakeStartedAt, completedAt: wakeCompletedAt } },
    { job: { status, startedAt: TERMINAL_AT, completedAt: wakeCompletedAt } },
    { job: { status, startedAt: wakeStartedAt, completedAt: new Date(wakeCompletedAt.getTime() + 1) } },
    { job: { status, startedAt: wakeStartedAt, completedAt: wakeCompletedAt }, ledger: { requestDigest: new Uint8Array(32) } },
    { job: { status, startedAt: wakeStartedAt, completedAt: wakeCompletedAt }, session: { id: ROOM } },
  ]) {
    expect(await validateWake(createProtectedTaskWakeSettledProductProofLoader(intent, receipt),
      fixture({ mode: "wake", ...options }).tx)).toBe(false);
  }
});

test("settlement capture rejects fake, override, reset and transaction-substituted loaders", async () => {
  const intent = closedIntent("wake");
  const fake = createProtectedTaskOutputReadProductProofLoader(intent, {
    loadProduct: async () => { throw new Error("unused"); },
    loadForeground: async () => { throw new Error("unused"); },
  });
  for (const loader of [fake, { ...fake }]) {
    let denied = false;
    try { await withCommittedProtectedTaskWakeSettlement(async capture => { capture(loader); }); }
    catch (error) { denied = error instanceof TypeError; }
    expect(denied).toBe(true);
  }
  const current = fixture({ mode: "wake", job: { status: "running", startedAt: wakeStartedAt } });
  const loader = createProtectedTaskOutputReadProductProofLoader(intent);
  expect(await validateWake(loader, current.tx)).toBe(true);
  const other = fixture({ mode: "wake", job: { status: "completed", startedAt: wakeStartedAt, completedAt: wakeCompletedAt } });
  expect(await validateWake(loader, other.tx)).toBe(false);
  let denied = false;
  try { await withCommittedProtectedTaskWakeSettlement(async capture => { capture(loader); }); }
  catch (error) { denied = error instanceof TypeError; }
  expect(denied).toBe(true);
  loader.reset();
  denied = false;
  try { await withCommittedProtectedTaskWakeSettlement(async capture => { capture(loader); }); }
  catch (error) { denied = error instanceof TypeError; }
  expect(denied).toBe(true);
});

test("rollback produces no receipt and capture cannot escape the commit callback", async () => {
  const current = fixture({ mode: "wake", job: { status: "running", startedAt: wakeStartedAt } });
  const loader = createProtectedTaskOutputReadProductProofLoader(closedIntent("wake"));
  let escaped: ((value: typeof loader) => void) | undefined;
  let committed = false;
  try {
    await withCommittedProtectedTaskWakeSettlement(async capture => {
      escaped = capture;
      expect(await validateWake(loader, current.tx)).toBe(true);
      current.setWakeJob({ status: "completed", completedAt: wakeCompletedAt });
      expect(await validateWake(loader, current.tx)).toBe(true);
      capture(loader);
      throw new Error("product commit rejected");
    });
    committed = true;
  } catch (error) { expect((error as Error).message).toBe("product commit rejected"); }
  expect(committed).toBe(false);
  expect(() => escaped?.(loader)).toThrow(TypeError);
  const empty = await withCommittedProtectedTaskWakeSettlement(async () => "no terminal observation");
  expect(empty.receipt).toBeNull();
});

test("continuation product proof uses the real closed receipt owner and rejects changed or vanished receipts", async () => {
  const base = closedIntent("wake");
  if (base.invocation.kind !== "wake") throw new Error("wake fixture");
  const semanticAuthorityRequirements = [{ namespaceId: DESTINATION_NAMESPACE, operations: ["decrypt"] as const },
    { namespaceId: SESSION, operations: ["encrypt"] as const }];
  const receipt: ProtectedTaskWakeContinuationReceipt = {
    taskId: TASK, taskRunId: RUN, wakeJobId: base.invocation.jobId, bindingId: base.invocation.bindingId,
    wakeOperationId: base.invocation.operationId, segment: 1, priorRecipientGeneration: 0,
    wakeAuthorizationRequestId: `task-wake-authorization:${base.invocation.jobId}`,
    additionalAuthorizationRequestId: "projection:authorization", operationId: "projection:operation",
    interruptId: "projection:interrupt", requestDigest: Buffer.alloc(32, 1),
    semanticAuthorityRequirements, requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(semanticAuthorityRequirements),
    retainedSourceNamespaceIds: [DESTINATION_NAMESPACE], sourceEnvelopeDigest: Buffer.alloc(32, 2),
    initialPolicyRevision: 8, initialAgentAuthorizationRevision: 4,
    destinationRoomId: SESSION, destinationNamespaceId: SESSION, destinationAuthorityDigest: Buffer.alloc(32, 3),
    checkpointThreadId: "wake:checkpoint", checkpointContract: "encrypted_langgraph_v1",
    expectedCheckpointCount: 1, checkpointOrderedDigest: Buffer.alloc(32, 4), expectedBlobCount: 0,
    blobOrderedDigest: Buffer.alloc(32, 5), expectedPendingWriteCount: 0,
    pendingWriteOrderedDigest: Buffer.alloc(32, 6), sealedAt: TERMINAL_AT,
  };
  const selected = { ...base, continuation: structuredClone(receipt) };
  const currentBinding = binding({ mode: "wake" });
  const tableRows = new Map<unknown, unknown[]>([
    [tasks, [{ id: TASK, ownerId: USER, requestorId: USER, contentRepresentation: "protected",
      contentNamespaceId: CONTENT_NAMESPACE, contentRevision: 1, cryptoMappingState: "verified", cryptoObjectId: "definition" }]],
    [taskRuns, [{ id: RUN, taskId: TASK, status: "completed", completedAt: TERMINAL_AT,
      resultRepresentation: "protected", resultCryptoMappingState: "verified", resultRevision: 1,
      resultCryptoObjectId: base.result.objectId, resultContentNamespaceId: CONTENT_NAMESPACE }]],
    [protectedTaskRunOutputBindings, [currentBinding]],
    [jobs, [{ id: base.invocation.jobId, ownerId: USER, requestorId: USER, roomId: ROOM, laneKey: `room:${ROOM}`,
      type: "foreground", status: "running", startedAt: TERMINAL_AT, completedAt: null,
      result: null, message: null, metadata: {}, input: base.invocation.reference }]],
    [protectedTaskWakeContinuationReceipts, [receipt]],
  ]);
  const locked: unknown[] = [];
  const tx = { select() {
    let table: unknown;
    let priorReceiptQuery = false;
    const query = { from(value: unknown) { table = value; return query; },
      where: (condition: SQL) => { priorReceiptQuery = new PgDialect().sqlToQuery(condition).sql.includes(" < "); return query; },
      orderBy: () => query, limit: () => query,
      for: () => { locked.push(table); return Promise.resolve(priorReceiptQuery ? [] : tableRows.get(table) ?? []); },
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(priorReceiptQuery ? [] : tableRows.get(table) ?? []).then(resolve) };
    return query;
  } } as unknown as CanonicalTranscriptTx;
  const loader = createProtectedTaskOutputReadProductProofLoader(selected, {
    loadProduct: async () => ({ proof: base, binding: currentBinding, terminalAt: TERMINAL_AT }),
    loadForeground: async () => ({ state: "wake_running", invocation: base.invocation }),
    readContinuation: readLatestProtectedTaskWakeContinuation,
    withContinuation: withCurrentProtectedTaskWakeContinuation,
  });
  const product = {} as PostgresJsBridgeConnection;
  const validate = async () => await loader.validateCurrentTaskRun(product, tx)
    && await loader.validateCurrentForeground(product, tx, { destinationRoomId: ROOM,
      destinationNamespaceId: DESTINATION_NAMESPACE, foregroundNamespaceIds: [DESTINATION_NAMESPACE] });
  expect(await validate()).toBe(true);
  expect(locked).toEqual([tasks, taskRuns, protectedTaskRunOutputBindings, jobs]);
  const observed = loader.readCurrent()!;
  observed.continuation!.requestDigest.fill(0);
  expect(loader.readCurrent()!.continuation!.requestDigest).toEqual(new Uint8Array(32).fill(1));
  receipt.requestDigest[0] = 9;
  expect(await validate()).toBe(false); expect(loader.readCurrent()).toBeNull();
  receipt.requestDigest[0] = 1;
  tableRows.set(protectedTaskWakeContinuationReceipts, []);
  expect(await validate()).toBe(false);
  tableRows.set(protectedTaskWakeContinuationReceipts, [receipt]);
  Object.assign(tableRows.get(jobs)![0]!, { status: "completed", completedAt: TERMINAL_AT });
  expect(await validate()).toBe(false);
});

function parkReceipt(): ProtectedTaskWakeContinuationReceipt {
  const semanticAuthorityRequirements = [{ namespaceId: DESTINATION_NAMESPACE, operations: ["decrypt"] as const },
    { namespaceId: SESSION, operations: ["encrypt"] as const }];
  return {
    taskId: TASK, taskRunId: RUN, wakeJobId: protectedTaskRunWakeJobId(RUN), bindingId: protectedTaskRunOutputBindingId(RUN),
    wakeOperationId: protectedTaskRunWakeOperationId(RUN), segment: 1, priorRecipientGeneration: 0,
    wakeAuthorizationRequestId: `task-wake-authorization:${protectedTaskRunWakeJobId(RUN)}`,
    additionalAuthorizationRequestId: "projection:authorization", operationId: "projection:operation",
    interruptId: "projection:interrupt", requestDigest: new Uint8Array(32).fill(1),
    semanticAuthorityRequirements, requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(semanticAuthorityRequirements),
    retainedSourceNamespaceIds: [DESTINATION_NAMESPACE], sourceEnvelopeDigest: new Uint8Array(32).fill(2),
    initialPolicyRevision: 8, initialAgentAuthorizationRevision: 4,
    destinationRoomId: SESSION, destinationNamespaceId: SESSION, destinationAuthorityDigest: new Uint8Array(32).fill(3),
    checkpointThreadId: "wake:checkpoint", checkpointContract: "encrypted_langgraph_v1",
    expectedCheckpointCount: 1, checkpointOrderedDigest: new Uint8Array(32).fill(4), expectedBlobCount: 0,
    blobOrderedDigest: new Uint8Array(32).fill(5), expectedPendingWriteCount: 0,
    pendingWriteOrderedDigest: new Uint8Array(32).fill(6), sealedAt: TERMINAL_AT,
  };
}

test("committed park captures genuine same-transaction progression and only re-proves the old grant", async () => {
  const intent = closedIntent("wake");
  const state = fixture({ mode: "wake", job: { status: "running", startedAt: wakeStartedAt } });
  const loader = createProtectedTaskWakeParkingProductProofLoader(intent);
  const receipt = parkReceipt();
  const committed = await withCommittedProtectedTaskWakePark(async capture => {
    expect(await validateWake(loader, state.tx)).toBe(true);
    state.setWakeJob({ status: "queued", startedAt: null }); state.setContinuation(receipt);
    expect(await validateWake(loader, state.tx)).toBe(true);
    expect(loader.readCurrent()?.continuation).toBeUndefined();
    capture(loader); return "committed";
  });
  expect(committed.value).toBe("committed");
  if (committed.receipt === null) throw new Error("Missing committed park");
  const token = committed.receipt;
  expect(readCommittedProtectedTaskWakePark(token, intent, 0)).toEqual(receipt);
  expect(() => readCommittedProtectedTaskWakePark(token, intent, 1)).toThrow(TypeError);
  expect(() => readCommittedProtectedTaskWakePark({ ...token }, intent, 0)).toThrow(TypeError);
  expect(() => readCommittedProtectedTaskWakePark(token, { ...intent,
    result: { ...intent.result, genesisManifestHash: new Uint8Array(32) } }, 0)).toThrow(TypeError);
  const copy = readCommittedProtectedTaskWakePark(token, intent, 0); copy.requestDigest.fill(0);
  expect(readCommittedProtectedTaskWakePark(token, intent, 0).requestDigest).toEqual(receipt.requestDigest);
  const queued = () => { const f = fixture({ mode: "wake" }); f.setContinuation(receipt); return f; };
  expect(await validateWake(createProtectedTaskOutputReadProductProofLoader(intent), queued().tx)).toBe(false);
  const reproof = createProtectedTaskWakeParkedProductProofLoader(intent, token);
  expect(await validateWake(reproof, queued().tx)).toBe(true);
  expect(reproof.readCurrent()?.continuation).toBeUndefined();
  const changed = queued(); changed.setContinuation({ ...receipt, requestDigest: new Uint8Array(32) });
  expect(await validateWake(reproof, changed.tx)).toBe(false);
  const restarted = queued(); restarted.setWakeJob({ status: "running", startedAt: wakeStartedAt });
  expect(await validateWake(reproof, restarted.tx)).toBe(false);
});

test("park capture rejects rollback, fake loaders, foreign transaction and missing durable receipt", async () => {
  const intent = closedIntent("wake");
  const state = fixture({ mode: "wake", job: { status: "running", startedAt: wakeStartedAt } });
  const loader = createProtectedTaskWakeParkingProductProofLoader(intent);
  const other = fixture({ mode: "wake" }); other.setContinuation(parkReceipt());
  expect(await validateWake(loader, state.tx)).toBe(true);
  expect(await validateWake(loader, other.tx)).toBe(false);
  await Promise.resolve(expect(withCommittedProtectedTaskWakePark(async capture => { capture(loader); })).rejects.toBeInstanceOf(TypeError));
  state.setWakeJob({ status: "running", startedAt: wakeStartedAt });
  expect(await validateWake(loader, state.tx)).toBe(true);
  state.setWakeJob({ status: "queued", startedAt: null });
  expect(await validateWake(loader, state.tx)).toBe(false);
  state.setWakeJob({ status: "running", startedAt: wakeStartedAt });
  expect(await validateWake(loader, state.tx)).toBe(true);
  state.setWakeJob({ status: "queued", startedAt: null }); state.setContinuation(parkReceipt());
  expect(await validateWake(loader, state.tx)).toBe(true);
  let escaped: ((value: typeof loader) => void) | undefined;
  await Promise.resolve(expect(withCommittedProtectedTaskWakePark(async capture => {
    escaped = capture; capture(loader); throw new Error("commit rejected");
  })).rejects.toThrow("commit rejected"));
  expect(() => escaped?.(loader)).toThrow(TypeError);
  await Promise.resolve(expect(withCommittedProtectedTaskWakePark(async capture => { capture({ ...loader }); })).rejects.toBeInstanceOf(TypeError));
  loader.reset();
  await Promise.resolve(expect(withCommittedProtectedTaskWakePark(async capture => { capture(loader); })).rejects.toBeInstanceOf(TypeError));
});


test("raw delivery reads retained dual definition and protected Full result independently", async () => {
  const f = fixture({ task: { representation: "dual", promptIsEmpty: false,
    expectedOutputIsNull: false } });
  const intent = await readProtectedTaskOutputReadIntent(f.tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  });
  expect(intent?.representation).toBe("protected");
  expect(intent?.result.genesisManifestHash).toEqual(GENESIS);
  const changed = fixture({ task: { representation: "dual" }, ledger: { representation: "dual" } });
  expect(await readProtectedTaskOutputReadIntent(changed.tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  })).toBeNull();
});


test("Full result delivery opens retained dual result metadata but plans protected output", async () => {
  const f = fixture({ representation: "dual", policyMode: "encrypted_only" });
  const intent = await readProtectedTaskOutputReadIntent(f.tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  });
  expect(intent?.representation).toBe("protected");
  expect(intent?.result.genesisManifestHash).toEqual(GENESIS);
  const downgrade = fixture({ policyMode: "shadow_encryption" });
  expect(await readProtectedTaskOutputReadIntent(downgrade.tx, {
    taskId: TASK, taskRunId: RUN, kind: "raw",
  })).toBeNull();
});


test.each(["raw", "wake"] as const)("%s delivery pins a repaired mapped result head independently of immutable genesis", async kind => {
  const value = fixture({ mode: kind, run: { accessRevision: 2 } });
  const intent = await readProtectedTaskOutputReadIntent(value.tx, { taskId: TASK, taskRunId: RUN, kind });
  expect(intent?.result.cryptoAccessRevision).toBe(2);
  expect(intent?.result.genesisManifestHash).toEqual(GENESIS);
  const invalidLedger = fixture({ mode: kind, run: { accessRevision: 2 }, ledger: { accessRevision: 2 } });
  expect(await readProtectedTaskOutputReadIntent(invalidLedger.tx, { taskId: TASK, taskRunId: RUN, kind })).toBeNull();
  for (const accessRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = fixture({ mode: kind, run: { accessRevision } });
    expect(await readProtectedTaskOutputReadIntent(invalid.tx, { taskId: TASK, taskRunId: RUN, kind })).toBeNull();
  }
});


test("a captured result-read intent cannot adopt a later mapped head", async () => {
  const original = closedIntent("raw");
  const loader = createProtectedTaskOutputReadProductProofLoader(original);
  const repaired = fixture({ run: { accessRevision: 1 } });
  expect(await loader.validateCurrentTaskRun({} as PostgresJsBridgeConnection, repaired.tx)).toBe(false);
  expect(loader.readCurrent()).toBeNull();
});
