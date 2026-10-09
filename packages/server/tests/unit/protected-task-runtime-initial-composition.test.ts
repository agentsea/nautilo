import { expect, test } from "bun:test";

import type {
  DirectDatabase,
  PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  LatticeCrypto,
  TaskRuntimeRecipientRegistry,
} from "@nautilo/lattice-crypto";

import {
  createProductionProtectedTaskRuntimeInitialComposition,
  loadInitialProtectedTaskOccurrence,
} from "../../src/routes/protected-task-runtime-initial-composition";

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

test("constructs inert coordinator and initial device hooks over shared custody", async () => {
  let kicks = 0;
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
    restricted,
    crypto,
    serverScope: "https://server.example.test",
  });

  expect(typeof composition.coordinator.observeProtectedTaskOccurrence)
    .toBe("function");
  expect(typeof composition.bindTaskRecipient).toBe("function");
  expect(typeof composition.withTaskAuthority).toBe("function");
  expect(typeof composition.isTaskRecipientActive).toBe("function");
  composition.wakeProtectedTask();
  expect(kicks).toBe(1);
});
