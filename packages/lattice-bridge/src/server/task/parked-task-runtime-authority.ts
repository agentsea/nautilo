import {
  and,
  eq,
  jobs,
  parseParkedProtectedTaskAdditionalAuthority,
  parkedTaskAdditionalAuthorityTaskProjection,
  parkedTaskAdditionalAuthorityRunProjection,
  parkedTaskAdditionalAuthorityJobProjection,
  readProtectedTaskExecutionContinuationProof,
  sameParkedProtectedTaskAdditionalAuthority,
  sql,
  taskRuns,
  tasks,
  rooms,
  type ParkedProtectedTaskAdditionalAuthority,
  type ParkedProtectedTaskAdditionalAuthorityJobRow,
  type ParkedProtectedTaskAdditionalAuthorityRunRow,
  type ParkedProtectedTaskAdditionalAuthorityTaskRow,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
} from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
} from "../message/postgres-conversation-product-store.ts";
import {
  readCurrentTaskScopeMemoryNamespaceInventory,
  type TaskScopeMemoryBinding,
} from "./task-scope-memory-metadata.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ParkedTaskRuntimeCurrentRoutingFacts = Readonly<{
  taskId: string;
  taskRunId: string;
  ownerId: string;
  requestorId: string;
  agentId: string;
  callingRoomId: string | null;
  scheduleKind: "now" | "one_shot" | "cron";
  graphThreadId: string;
  startedAt: Date;
  sourceRoomId: string;
  targetRoomId: string;
  targetUserIds: readonly string[];
  memoryMode: "scope" | "wide" | "namespace";
  wideBringBack: boolean;
  scopeId: string | null;
  contentRepresentation: "dual" | "protected";
  contentNamespaceId: string;
  contentRevision: number;
  contentObjectId: string;
  contentAccessRevision: number;
  requiredNamespaceFingerprint: Uint8Array;
}>;

export type ParkedTaskRuntimeLockedRoutingTask = Readonly<{
    id: string;
    ownerId: string;
    requestorId: string;
    agentId: string;
    callingRoomId: string | null;
    scheduleKind: "now" | "one_shot" | "cron";
    contentRepresentation: "ordinary" | "dual" | "protected";
    contentNamespaceId: string;
    contentRevision: number;
    cryptoObjectId: string | null;
    cryptoAccessRevision: number;
    cryptoRequiredNamespaceFingerprint: Uint8Array | null;
    preset: string;
    targetUserIds: unknown;
    useScope: boolean;
    scopeId: string | null;
    targetChat: string;
    targetRoomId: string | null;
    wideBringBack: boolean;
  }>;

export type ParkedTaskRuntimeExpectedNamespaceParticipants =
  readonly Readonly<{
    namespaceId: string;
    match: "exact" | "includes";
    participantHumanIds: readonly string[];
  }>[];

const parkedTaskRuntimeRoutingTaskProjection = {
  ...parkedTaskAdditionalAuthorityTaskProjection,
  preset: tasks.preset,
  targetUserIds: tasks.targetUserIds,
  useScope: tasks.useScope,
  scopeId: tasks.scopeId,
  targetChat: tasks.targetChat,
  targetRoomId: tasks.targetRoomId,
  wideBringBack:
    sql<boolean>`(${tasks.metadata} -> 'bringBack') IS DISTINCT FROM 'false'::jsonb`
      .mapWith(Boolean).as("wide_bring_back"),
} as const;

export function copyParkedTaskRuntimeExpectedNamespaceParticipants(
  value: unknown,
): ParkedTaskRuntimeExpectedNamespaceParticipants | null {
  if (!Array.isArray(value) || value.length < 1) return null;
  const entries: readonly unknown[] = value;
  const copied: Array<ParkedTaskRuntimeExpectedNamespaceParticipants[number]> = [];
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== "object"
      || Object.keys(entry).sort().join(",")
        !== "match,namespaceId,participantHumanIds") return null;
    const record = entry as Record<string, unknown>;
    const namespaceId = record["namespaceId"];
    const match = record["match"];
    const participantValues = record["participantHumanIds"];
    if (typeof namespaceId !== "string" || !UUID.test(namespaceId)
      || match !== "exact" && match !== "includes"
      || index > 0 && copied[index - 1]!.namespaceId >= namespaceId
      || !Array.isArray(participantValues)
      || participantValues.length < 1) return null;
    const participantHumanIds: string[] = [];
    for (const participant of participantValues as readonly unknown[]) {
      const previous = participantHumanIds.at(-1);
      if (typeof participant !== "string" || !UUID.test(participant)
        || previous !== undefined && previous >= participant) return null;
      participantHumanIds.push(participant);
    }
    copied.push(Object.freeze({
      namespaceId,
      match,
      participantHumanIds: Object.freeze(participantHumanIds),
    }));
  }
  return Object.freeze(copied);
}

export function parkedTaskRuntimeNamespaceParticipantsMatch(
  namespaceId: string,
  participantHumanIds: readonly string[],
  expected: ParkedTaskRuntimeExpectedNamespaceParticipants | undefined,
): boolean {
  const requirement = expected?.find(value => value.namespaceId === namespaceId);
  return requirement === undefined
    || (requirement.match === "exact"
      ? participantHumanIds.length === requirement.participantHumanIds.length
        && participantHumanIds.every((id, index) =>
          id === requirement.participantHumanIds[index])
      : requirement.participantHumanIds.every(id =>
        participantHumanIds.some(candidate => candidate === id)));
}

export function currentParkedTaskRuntimeRoutingFacts(input: Readonly<{
  sourceRoomId: string;
  targetRoomId: string;
  task: ParkedTaskRuntimeLockedRoutingTask;
  current: ParkedProtectedTaskAdditionalAuthority;
}>): ParkedTaskRuntimeCurrentRoutingFacts | null {
  const { task, current } = input;
  const occurrence = current.occurrence;
  const fingerprint = task.cryptoRequiredNamespaceFingerprint;
  const targetUserIds: string[] = [];
  if (!Array.isArray(task.targetUserIds)) return null;
  for (const targetUserId of task.targetUserIds as readonly unknown[]) {
    if (typeof targetUserId !== "string" || !UUID.test(targetUserId)) {
      return null;
    }
    targetUserIds.push(targetUserId);
  }
  const memoryMode = task.useScope
    ? "scope" as const
    : task.preset === "in_private_namespace"
      ? "wide" as const
      : "namespace" as const;
  if (task.id !== occurrence.task.id
    || task.ownerId !== occurrence.task.ownerId
    || task.requestorId !== occurrence.task.requestorId
    || task.agentId !== occurrence.task.agentId
    || task.callingRoomId !== occurrence.task.callingRoomId
    || task.scheduleKind !== occurrence.task.scheduleKind
    || task.targetRoomId !== input.targetRoomId
    || typeof task.wideBringBack !== "boolean"
    || new Set(targetUserIds).size !== targetUserIds.length
    || task.contentRepresentation !== occurrence.task.contentRepresentation
    || task.contentNamespaceId !== occurrence.task.contentNamespaceId
    || task.contentRevision !== occurrence.task.contentRevision
    || task.cryptoObjectId !== occurrence.task.cryptoObjectId
    || task.cryptoAccessRevision !== occurrence.task.cryptoAccessRevision
    || !(fingerprint instanceof Uint8Array)
    || fingerprint.length !== 32
    || fingerprint.length
      !== occurrence.task.cryptoRequiredNamespaceFingerprint.length
    || !fingerprint.every((byte, index) =>
      byte === occurrence.task.cryptoRequiredNamespaceFingerprint[index])
    || (memoryMode === "scope"
      ? task.scopeId === null || !UUID.test(task.scopeId)
      : false)) return null;
  return Object.freeze({
    taskId: task.id,
    taskRunId: occurrence.run.id,
    ownerId: task.ownerId,
    requestorId: task.requestorId,
    agentId: task.agentId,
    callingRoomId: task.callingRoomId,
    scheduleKind: task.scheduleKind,
    graphThreadId: occurrence.run.graphThreadId,
    startedAt: new Date(occurrence.run.startedAt.getTime()),
    sourceRoomId: input.sourceRoomId,
    targetRoomId: input.targetRoomId,
    targetUserIds: Object.freeze([
      ...new Set([task.requestorId, ...targetUserIds]),
    ].sort()),
    memoryMode,
    wideBringBack: task.wideBringBack,
    scopeId: memoryMode === "scope" ? task.scopeId : null,
    contentRepresentation: occurrence.task.contentRepresentation,
    contentNamespaceId: occurrence.task.contentNamespaceId,
    contentRevision: occurrence.task.contentRevision,
    contentObjectId: occurrence.task.cryptoObjectId,
    contentAccessRevision: occurrence.task.cryptoAccessRevision,
    requiredNamespaceFingerprint: new Uint8Array(fingerprint),
  });
}

export function parkedTaskRuntimeScopeBindingMatches(input: Readonly<{
  task: ParkedTaskRuntimeLockedRoutingTask;
  sourceRoomId: string;
  namespaceIds: readonly string[];
  scopeMemory: TaskScopeMemoryBinding | undefined;
}>): boolean {
  const { task, scopeMemory } = input;
  if (!task.useScope) return scopeMemory === undefined;
  return task.scopeId !== null
    && scopeMemory !== undefined
    && scopeMemory.scopeId === task.scopeId
    && scopeMemory.memoryRoomId === (task.targetChat === "orphan"
      ? input.sourceRoomId
      : task.targetRoomId)
    && scopeMemory.readableNamespaceIds.every(namespaceId =>
      input.namespaceIds.includes(namespaceId));
}

export async function exactCurrentParkedTaskScopeMemory(input: Readonly<{
  product: PostgresJsBridgeConnection;
  task: ParkedTaskRuntimeLockedRoutingTask;
  sourceRoomId: string;
  requesterHumanId: string;
  scopeMemory: TaskScopeMemoryBinding | undefined;
}>): Promise<boolean> {
  const { task, scopeMemory } = input;
  if (scopeMemory === undefined) return !task.useScope;
  const memoryRoomRows = await executeTypedConversationProductQuery(
    input.product,
    conversationProductTypedDb.select({
      id: rooms.id,
      namespace_id: rooms.namespaceId,
      archived_at: rooms.archivedAt,
    }).from(rooms).where(eq(rooms.id, scopeMemory.memoryRoomId))
      .limit(2).for("share"),
  );
  const memoryRoom = memoryRoomRows[0];
  if (memoryRoomRows.length !== 1 || memoryRoom === undefined
    || memoryRoom.id !== scopeMemory.memoryRoomId
    || memoryRoom.namespace_id !== scopeMemory.originWritableNamespaceId
    || memoryRoom.archived_at !== null) return false;
  const current = await readCurrentTaskScopeMemoryNamespaceInventory({
    transaction: input.product,
    coordinates: {
      taskId: task.id,
      requesterUserId: task.requestorId,
      agentId: task.agentId,
      scopeId: scopeMemory.scopeId,
      memoryRoomId: scopeMemory.memoryRoomId,
      originWritableNamespaceId: scopeMemory.originWritableNamespaceId,
    },
    sourceRoomId: input.sourceRoomId,
    requesterHumanId: input.requesterHumanId,
  });
  return current !== null
    && current.scopeId === scopeMemory.scopeId
    && current.originWritableNamespaceId === scopeMemory.originWritableNamespaceId
    && current.readableNamespaceIds.length === scopeMemory.readableNamespaceIds.length
    && current.readableNamespaceIds.every((id, index) =>
      id === scopeMemory.readableNamespaceIds[index]);
}

type ParkedTaskAuthorityTransaction = Pick<CanonicalTranscriptTx, "select">;

async function withScopedRestrictedConnection<Value>(
  restricted: PostgresJsBridgeConnection,
  use: (connection: PostgresJsBridgeConnection) => Promise<Value>,
): Promise<Value> {
  let active = true;
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  const assertActive = (): void => {
    if (!active) {
      throw new TypeError("Parked Task Runtime authority is not active");
    }
  };
  const track = <Result>(operation: Promise<Result>): Promise<Result> => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      reason => {
        pending.delete(operation);
        failures.push(reason);
      },
    );
    return operation;
  };
  const guardExecutor = (
    executor: PostgresJsBridgeExecutor,
    callbackActive: () => boolean,
  ): PostgresJsBridgeExecutor => Object.freeze({
    query<Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: Parameters<PostgresJsBridgeExecutor["query"]>[1],
    ): Promise<readonly Row[]> {
      assertActive();
      if (!callbackActive()) {
        throw new TypeError("Parked Task Runtime transaction is not active");
      }
      return track((async () => {
        const rows = await executor.query<Row>(statement, parameters);
        assertActive();
        if (!callbackActive()) {
          throw new TypeError("Parked Task Runtime transaction is not active");
        }
        return rows;
      })());
    },
  });
  const transaction = async <Result>(
    start: (
      callback: (executor: PostgresJsBridgeExecutor) => Promise<Result>,
      options?: Parameters<PostgresJsBridgeConnection["transaction"]>[1],
    ) => Promise<Result>,
    callback: (executor: PostgresJsBridgeExecutor) => Promise<Result>,
    options?: Parameters<PostgresJsBridgeConnection["transaction"]>[1],
  ): Promise<Result> => {
    assertActive();
    const result = await start(async executor => {
      assertActive();
      let callbackOpen = true;
      const guarded = guardExecutor(executor, () => callbackOpen);
      try {
        const value = await callback(guarded);
        assertActive();
        return value;
      } finally {
        callbackOpen = false;
      }
    }, options);
    assertActive();
    return result;
  };
  const executor = guardExecutor(restricted, () => true);
  const connection: PostgresJsBridgeConnection = Object.freeze({
    query: <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: Parameters<PostgresJsBridgeExecutor["query"]>[1],
    ): Promise<readonly Row[]> => executor.query<Row>(statement, parameters),
    transaction: <Result>(
      callback: (executor: PostgresJsBridgeExecutor) => Promise<Result>,
      options?: Parameters<PostgresJsBridgeConnection["transaction"]>[1],
    ): Promise<Result> => {
      assertActive();
      return track(transaction(
        (current, currentOptions) => restricted.transaction(
          current,
          currentOptions,
        ),
        callback,
        options,
      ));
    },
    transactionOnce: <Result>(
      callback: (executor: PostgresJsBridgeExecutor) => Promise<Result>,
      options?: Parameters<PostgresJsBridgeConnection["transaction"]>[1],
    ): Promise<Result> => {
      assertActive();
      return track(transaction(
        (current, currentOptions) => restricted.transactionOnce(
          current,
          currentOptions,
        ),
        callback,
        options,
      ));
    },
  });

  let useFailed = false;
  let useError: unknown;
  let result: Value;
  try {
    result = await use(connection);
  } catch (error) {
    useFailed = true;
    useError = error;
    result = undefined as Value;
  }
  active = false;
  await Promise.allSettled([...pending]);
  if (useFailed) throw useError;
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Parked Task Runtime operations failed while closing authority",
    );
  }
  return result;
}

export async function withParkedTaskRuntimeRestrictedAuthority<Value>(
  restricted: PostgresJsBridgeConnection,
  use: (connection: PostgresJsBridgeConnection) => Promise<Value>,
): Promise<Value> {
  return withScopedRestrictedConnection(restricted, use);
}

export function copyParkedTaskRuntimeAuthority(
  expected: ParkedProtectedTaskAdditionalAuthority,
): ParkedProtectedTaskAdditionalAuthority {
  try {
    const task = expected.occurrence.task;
    const run = expected.occurrence.run;
    const priorJob = expected.priorJob;
    const copy = parseParkedProtectedTaskAdditionalAuthority({
      task: {
        ...task,
        cryptoRequiredNamespaceFingerprint:
          task.cryptoRequiredNamespaceFingerprint.slice(),
        cryptoMappingState: "verified",
        contentPristine: true,
      },
      run: {
        ...run,
        startedAt: new Date(run.startedAt.getTime()),
        pristine: true,
      },
      job: {
        id: priorJob.id,
        ownerId: task.requestorId,
        requestorId: task.requestorId,
        laneKey: `task:${task.id}`,
        type: "foreground",
        status: "completed",
        startedAt: new Date(run.startedAt.getTime()),
        completedAt: new Date(priorJob.parkedAt.getTime()),
        reference: { ...priorJob.reference },
        parkReceipt: {
          version: 1,
          taskId: task.id,
          taskRunId: run.id,
          jobId: priorJob.id,
          graphThreadId: run.graphThreadId,
          generation: priorJob.generation,
          executionSegment: priorJob.reference.executionSegment,
          interrupts: priorJob.interrupts.map(interrupt => ({ ...interrupt })),
          parkedAt: priorJob.parkedAt.toISOString(),
        },
        pristine: true,
      },
      proof: expected.proof,
      authorizationRequestId: expected.authorizationRequestId,
    });
    if (copy === null
      || !sameParkedProtectedTaskAdditionalAuthority(expected, copy)) {
      throw new TypeError("Parked Task Runtime authority descriptor is invalid");
    }
    return copy;
  } catch (error) {
    if (error instanceof TypeError
      && error.message === "Parked Task Runtime authority descriptor is invalid") {
      throw error;
    }
    throw new TypeError(
      "Parked Task Runtime authority descriptor is invalid",
      { cause: error },
    );
  }
}

/**
 * Re-read one discovered additional-authority continuation while holding the
 * canonical product lifecycle locks. Call this only after the global policy
 * fence and before acquiring any Namespace or restricted crypto lock.
 */
export async function lockCurrentParkedTaskAdditionalAuthorityWithRouting(
  input: Readonly<{
  transaction: ParkedTaskAuthorityTransaction;
  expected: ParkedProtectedTaskAdditionalAuthority;
}>,
): Promise<Readonly<{
  current: ParkedProtectedTaskAdditionalAuthority;
  task: ParkedProtectedTaskAdditionalAuthorityTaskRow
    & ParkedTaskRuntimeLockedRoutingTask;
}> | null> {
  const expected = copyParkedTaskRuntimeAuthority(input.expected);

  const taskRows = await input.transaction.select(
    parkedTaskRuntimeRoutingTaskProjection,
  ).from(tasks).where(eq(tasks.id, expected.occurrence.task.id))
    .limit(2).for("update");
  const task = taskRows.length === 1
    ? taskRows[0] as ParkedProtectedTaskAdditionalAuthorityTaskRow
      & ParkedTaskRuntimeLockedRoutingTask
    : undefined;
  if (task === undefined) return null;

  const runRows = await input.transaction.select(
    parkedTaskAdditionalAuthorityRunProjection,
  ).from(taskRuns).where(and(
    eq(taskRuns.id, expected.occurrence.run.id),
    eq(taskRuns.taskId, task.id),
  )).limit(2).for("update");
  const run = runRows.length === 1
    ? runRows[0] as ParkedProtectedTaskAdditionalAuthorityRunRow
    : undefined;
  if (run === undefined || run.jobId !== expected.priorJob.id) return null;

  const jobRows = await input.transaction.select(
    parkedTaskAdditionalAuthorityJobProjection,
  ).from(jobs).where(and(
    eq(jobs.id, expected.priorJob.id),
    sql`${jobs.input} ->> 'kind' = 'protected_task_run_v1'`,
  )).limit(2).for("update");
  const job = jobRows.length === 1
    ? jobRows[0] as ParkedProtectedTaskAdditionalAuthorityJobRow
    : undefined;
  if (job === undefined) return null;

  const proof = await readProtectedTaskExecutionContinuationProof(
    input.transaction,
    {
      taskId: task.id,
      taskRunId: run.id,
      jobId: job.id,
      executionSegment: expected.priorJob.reference.executionSegment,
    },
  );
  const current = parseParkedProtectedTaskAdditionalAuthority({
    task,
    run,
    job,
    proof,
    authorizationRequestId: expected.authorizationRequestId,
  });
  return current !== null
      && sameParkedProtectedTaskAdditionalAuthority(expected, current)
    ? Object.freeze({ current, task })
    : null;
}

export async function lockCurrentParkedTaskAdditionalAuthority(input: Readonly<{
  transaction: ParkedTaskAuthorityTransaction;
  expected: ParkedProtectedTaskAdditionalAuthority;
}>): Promise<ParkedProtectedTaskAdditionalAuthority | null> {
  return (await lockCurrentParkedTaskAdditionalAuthorityWithRouting(input))
    ?.current ?? null;
}
