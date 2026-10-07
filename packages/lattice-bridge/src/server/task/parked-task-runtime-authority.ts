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
  type ParkedProtectedTaskAdditionalAuthority,
  type ParkedProtectedTaskAdditionalAuthorityJobRow,
  type ParkedProtectedTaskAdditionalAuthorityRunRow,
  type ParkedProtectedTaskAdditionalAuthorityTaskRow,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
} from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

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
export async function lockCurrentParkedTaskAdditionalAuthority(input: Readonly<{
  transaction: ParkedTaskAuthorityTransaction;
  expected: ParkedProtectedTaskAdditionalAuthority;
}>): Promise<ParkedProtectedTaskAdditionalAuthority | null> {
  const expected = copyParkedTaskRuntimeAuthority(input.expected);

  const taskRows = await input.transaction.select(
    parkedTaskAdditionalAuthorityTaskProjection,
  ).from(tasks).where(eq(tasks.id, expected.occurrence.task.id))
    .limit(2).for("update");
  const task = taskRows.length === 1
    ? taskRows[0] as ParkedProtectedTaskAdditionalAuthorityTaskRow
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
    ? current
    : null;
}
