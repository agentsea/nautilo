import { expect, test } from "bun:test";

import type {
  DirectDatabase,
  PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  LatticeCrypto,
  TaskRuntimeRecipientRegistry,
} from "@nautilo/lattice-crypto";
import { createTaskRuntimeGrantClaim } from "@nautilo/runtime";

import {
  createProductionProtectedTaskRuntimeInitialComposition,
  createProtectedTaskRuntimeInitialExecutionPreparation,
  loadInitialProtectedTaskOccurrence,
} from "../../src/routes/protected-task-runtime-initial-composition";
import type { ProductionProtectedTaskNativeExecution } from
  "../../src/routes/protected-task-native-execution-composition";

const USER = "10000000-0000-4000-8000-000000000001";
const AGENT = "20000000-0000-4000-8000-000000000002";
const TASK = "30000000-0000-4000-8000-000000000003";
const RUN = "40000000-0000-4000-8000-000000000004";
const ROOM = "50000000-0000-4000-8000-000000000005";
const NAMESPACE = "60000000-0000-4000-8000-000000000006";

function row(jobId: string | null = null) {
  return {
    task: {
      id: TASK,
      ownerId: USER,
      requestorId: USER,
      agentId: AGENT,
      callingRoomId: ROOM,
      scheduleKind: "now" as const,
      contentRepresentation: "protected" as const,
      contentNamespaceId: NAMESPACE,
      contentRevision: 2,
      cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(7),
      cryptoMappingState: "verified",
      status: "awaiting",
    },
    run: {
      id: RUN,
      taskId: TASK,
      jobId,
      graphThreadId: `subagent:task:${TASK}:${RUN}`,
      status: "awaiting",
      startedAt: new Date(2_000_000_000_000),
      modelId: null,
      completedAt: null,
      resultRepresentation: "ordinary",
      resultContentNamespaceId: null,
      resultRevision: 0,
      resultCryptoObjectId: null,
      resultCryptoAccessRevision: 0,
      resultCryptoRequiredNamespaceFingerprint: null,
      resultCryptoMappingState: "unmapped",
    },
  };
}

function database(
  rows: readonly ReturnType<typeof row>[],
  selected?: (projection: Record<string, unknown>) => void,
): DirectDatabase {
  return {
    select: (projection: Record<string, unknown>) => {
      selected?.(projection);
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: () => query,
        limit: async () => rows,
      };
      return query;
    },
  } as never;
}

test("loads only the exact operational initial occurrence", async () => {
  let projection: Record<string, unknown> | null = null;
  const db = database([row()], value => {
    projection = value;
  });
  const occurrence = await loadInitialProtectedTaskOccurrence(db, {
    taskRunId: RUN,
    authorizationRequestId: `task-run-authorization:${RUN}`,
  });
  expect(occurrence).toMatchObject({
    task: { id: TASK, contentNamespaceId: NAMESPACE },
    run: { id: RUN, taskId: TASK, jobId: null, status: "awaiting" },
  });
  expect(occurrence?.task.cryptoRequiredNamespaceFingerprint)
    .not.toBe(row().task.cryptoRequiredNamespaceFingerprint);
  expect(projection).not.toBeNull();
  const selectedTask = (projection as unknown as Record<string, unknown>)[
    "task"
  ] as Record<string, unknown>;
  const selectedRun = (projection as unknown as Record<string, unknown>)[
    "run"
  ] as Record<string, unknown>;
  expect(selectedTask).not.toHaveProperty("prompt");
  expect(selectedTask).not.toHaveProperty("expectedOutput");
  expect(selectedTask).not.toHaveProperty("metadata");
  expect(selectedRun).not.toHaveProperty("resultText");

  expect(await loadInitialProtectedTaskOccurrence(db, {
    taskRunId: RUN,
    authorizationRequestId: `task-run-authorization:${TASK}`,
  })).toBeNull();
  expect(await loadInitialProtectedTaskOccurrence(database([row(TASK)]), {
    taskRunId: RUN,
    authorizationRequestId: `task-run-authorization:${RUN}`,
  })).toBeNull();
});

test("routes repo docs through the initial native owner for fresh and parked preparation", async () => {
  type Preparation = Parameters<
    ProductionProtectedTaskNativeExecution["prepareExecution"]
  >[0];
  const prepared = Object.freeze({ occurrence: { task: {
    id: TASK,
    ownerId: USER,
    requestorId: USER,
    agentId: AGENT,
    contentRevision: 2,
    cryptoObjectId: "definition",
    contentNamespaceId: NAMESPACE,
  } } }) as Preparation;
  const nativeResult = Object.freeze({ kind: "native" });
  const repoDocsResult = Object.freeze({ kind: "repo_docs" });
  const calls: unknown[] = [];
  const native = {
    prepareExecution: async (value: Preparation) => {
      calls.push({ kind: "native", value });
      return nativeResult as never;
    },
    prepareRepoDocsExecution: async (selection, value) => {
      calls.push({ kind: "repo_docs", selection, value });
      return repoDocsResult as never;
    },
    publishResult: async () => {},
  } satisfies ProductionProtectedTaskNativeExecution;
  let rows: readonly Record<string, unknown>[] = [{
    native: false,
    claude: null,
    codex: null,
    hermes: null,
    deepResearch: null,
    repoDocs: { mode: "auto", publish: "pr" },
  }];
  const db = {
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        limit: async () => rows,
      };
      return query;
    },
  } as unknown as DirectDatabase;
  const prepare = createProtectedTaskRuntimeInitialExecutionPreparation(
    db,
    native,
  );

  const repoDocsActual: unknown = await prepare(prepared);
  expect(repoDocsActual).toBe(repoDocsResult);
  expect(calls).toEqual([{ kind: "repo_docs", selection: {
    mode: "auto", publish: "pr",
  }, value: prepared }]);

  calls.length = 0;
  rows = [{ native: true, claude: null, codex: null, hermes: null,
    deepResearch: null, repoDocs: null }];
  const nativeActual: unknown = await prepare(prepared);
  expect(nativeActual).toBe(nativeResult);
  expect(calls).toEqual([{ kind: "native", value: prepared }]);
});

test("constructs inert coordinator and initial device hooks over shared custody", async () => {
  let kicks = 0;
  const requestedUsers: string[] = [];
  let authorizationRequested: Parameters<
    typeof createTaskRuntimeGrantClaim
  >[0]["authorizationRequested"];
  const crypto = new LatticeCrypto();
  const restricted = {
    query: async () => [{
      current_user: "nautilo_crypto",
      session_user: "nautilo_crypto",
    }],
    transaction: async () => {
      throw new Error("unexpected transaction");
    },
    transactionOnce: async () => {
      throw new Error("unexpected transaction");
    },
  } as unknown as PostgresJsBridgeConnection;
  const composition = await createProductionProtectedTaskRuntimeInitialComposition({
    db: database([]),
    resolver: {} as never,
    convergeCreatedRoomCatalog: async () => {},
    owner: {} as never,
    recipients: new TaskRuntimeRecipientRegistry(crypto),
    jobManager: {
      createProtectedTaskJob: async () => ({ id: TASK, virtualJobId: RUN }),
    },
    kick: () => {
      kicks += 1;
    },
    authorizationRequested: requestorUserId => {
      requestedUsers.push(requestorUserId);
    },
    restricted,
    crypto,
    serverScope: "https://server.example.test",
  }, {
    grantClaim: dependencies => {
      authorizationRequested = dependencies.authorizationRequested;
      return createTaskRuntimeGrantClaim(dependencies);
    },
  });

  expect(typeof composition.coordinator.observeProtectedTaskOccurrence)
    .toBe("function");
  expect(typeof composition.bindTaskRecipient).toBe("function");
  expect(typeof composition.withTaskAuthority).toBe("function");
  expect(typeof composition.isTaskRecipientActive).toBe("function");
  composition.wakeProtectedTask();
  expect(kicks).toBe(1);
  await authorizationRequested?.({
    task: { requestorId: USER },
  } as never, {} as never);
  expect(requestedUsers).toEqual([USER]);
});
