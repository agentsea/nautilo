import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  PROTECTED_TASK_CANCELLED_RESULT,
  settleProtectedTaskCancellationOutput,
} from "../../src/queries/protected-task-cancellation-output";
import {
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunCancelledResultOperationId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
} from "../../src/queries/protected-task-output-binding-identities";
import { encryptionTransitionPolicy } from
  "../../src/schema/encryption-transition";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../../src/schema/protected-task-run-output-bindings";
import {
  taskDefinitionCryptoRevisions,
  type TaskDefinitionCryptoRevision,
} from "../../src/schema/task-definition-crypto-revisions";
import {
  taskRunResultCryptoRevisions,
  type TaskRunResultCryptoRevision,
} from "../../src/schema/task-run-result-crypto-revisions";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";
import { actors, type Actor } from "../../src/schema/trust";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  owner: "30000000-0000-4000-8000-000000000003",
  human: "40000000-0000-4000-8000-000000000004",
  agent: "50000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006",
  room: "70000000-0000-4000-8000-000000000007",
};
const terminalAt = new Date("2026-10-12T08:00:00.000Z");
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId = protectedTaskRunCancelledResultObjectId(
  ids.task,
  ids.run,
);
const authorityFingerprint = new Uint8Array(32).fill(7);
const namespaceFingerprint = new Uint8Array(32).fill(8);

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    callingRoomId: null,
    resultDelivery: "none",
    status: "cancelled",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: namespaceFingerprint,
    cryptoMappingState: "verified",
    cancelledAt: terminalAt,
    prompt: "",
    expectedOutput: null,
    lastError: null,
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: null,
    status: "cancelled",
    completedAt: terminalAt,
    resultRepresentation: "protected",
    resultContentNamespaceId: ids.namespace,
    resultRevision: 2,
    resultCryptoObjectId: resultObjectId,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: namespaceFingerprint,
    resultCryptoMappingState: "verified",
    resultText: null,
    lastError: null,
    ...overrides,
  } as TaskRun;
}

function binding(
  overrides: Partial<ProtectedTaskRunOutputBinding> = {},
): ProtectedTaskRunOutputBinding {
  return {
    taskRunId: ids.run,
    bindingId: protectedTaskRunOutputBindingId(ids.run),
    deliveryMode: "none",
    destinationRoomId: null,
    destinationNamespaceId: null,
    resultRevision: 2,
    resultOperationId: protectedTaskRunCancelledResultOperationId(ids.run),
    resultObjectId,
    messageOperationId: null,
    wakeOperationId: null,
    acceptedPolicyRevision: 9,
    acceptedAt: terminalAt,
    resultTerminalAt: terminalAt,
    resultAttachedAt: null,
    messageId: null,
    messagePublishedAt: null,
    wakeJobId: null,
    wakeScheduledAt: null,
    completedAt: null,
    ...overrides,
  };
}

function definition(
  representation: "protected" | "dual" = "protected",
): TaskDefinitionCryptoRevision {
  return {
    taskId: ids.task,
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: definitionObjectId,
    representation,
    payloadVersion: 1,
    cryptoAccessRevision: 0,
    requiredNamespaceFingerprint: namespaceFingerprint,
    completion: "complete",
    disposition: "mapped",
    failureCode: null,
  } as TaskDefinitionCryptoRevision;
}

function reservation(
  representation: "protected" | "dual" = "protected",
  overrides: Partial<TaskRunResultCryptoRevision> = {},
): TaskRunResultCryptoRevision {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    contentNamespaceId: ids.namespace,
    anchorNamespaceId: ids.namespace,
    resultRevision: 2,
    operationId: protectedTaskRunCancelledResultOperationId(ids.run),
    requestDigest: new Uint8Array(32).fill(6),
    authorityFingerprint,
    requesterHumanId: ids.human,
    cryptoObjectId: resultObjectId,
    representation,
    payloadVersion: 1,
    cryptoAccessRevision: 0,
    requiredNamespaceFingerprint: namespaceFingerprint,
    completion: "complete",
    disposition: "mapped",
    failureCode: null,
    ...overrides,
  } as TaskRunResultCryptoRevision;
}

type FixtureOptions = Readonly<{
  task?: Task;
  run?: TaskRun;
  binding?: ProtectedTaskRunOutputBinding | null;
  definition?: TaskDefinitionCryptoRevision | null;
  reservation?: TaskRunResultCryptoRevision | null;
  policyRevision?: number;
  policyMode?: string;
  actor?: Actor | null;
}>;

function fixture(options: FixtureOptions = {}) {
  const taskRow = options.task ?? task();
  const runRow = options.run ?? run();
  let bindingRow = options.binding === undefined ? binding() : options.binding;
  const definitionRow = options.definition === undefined
    ? definition(taskRow.contentRepresentation as "protected" | "dual")
    : options.definition;
  const reservationRow = options.reservation === undefined
    ? reservation(taskRow.contentRepresentation as "protected" | "dual")
    : options.reservation;
  const policyRow = {
    id: "server",
    revision: options.policyRevision ?? 9,
    mode: options.policyMode ?? (taskRow.contentRepresentation === "dual"
      ? "shadow_encryption"
      : "encrypted_only"),
  };
  const actorRow = options.actor === undefined
    ? ({ id: ids.human, kind: "user", ownerId: ids.owner } as Actor)
    : options.actor;
  const locks: Array<{ table: unknown; kind: string }> = [];
  const updates: Record<string, unknown>[] = [];
  const rows = (table: unknown): unknown[] => {
    if (table === encryptionTransitionPolicy) return [policyRow];
    if (table === tasks) return [{
      ...taskRow,
      promptIsEmpty: taskRow.prompt === "",
      expectedOutputIsNull: taskRow.expectedOutput === null,
      lastErrorIsNull: taskRow.lastError === null,
    }];
    if (table === taskRuns) return [{
      ...runRow,
      resultTextIsNull: runRow.resultText === null,
      resultTextIsCancelled:
        runRow.resultText === PROTECTED_TASK_CANCELLED_RESULT,
      lastErrorIsNull: runRow.lastError === null,
    }];
    if (table === protectedTaskRunOutputBindings) {
      return bindingRow === null ? [] : [bindingRow];
    }
    if (table === taskDefinitionCryptoRevisions) {
      return definitionRow === null ? [] : [definitionRow];
    }
    if (table === taskRunResultCryptoRevisions) {
      return reservationRow === null ? [] : [reservationRow];
    }
    if (table === actors) {
      return actorRow !== null
          && actorRow.id === ids.human
          && actorRow.kind === "user"
          && actorRow.ownerId === ids.owner
        ? [actorRow]
        : [];
    }
    throw new Error("unexpected settlement table");
  };
  const tx = {
    select: (_projection?: unknown) => ({
      from: (table: unknown) => {
        const query = {
          where: (_condition: unknown) => query,
          limit: (_limit: number) => query,
          for: async (kind: string) => {
            locks.push({ table, kind });
            return rows(table);
          },
        };
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            if (table !== protectedTaskRunOutputBindings || bindingRow === null) {
              throw new Error("unexpected settlement update");
            }
            updates.push(patch);
            bindingRow = { ...bindingRow, ...patch };
            return [bindingRow];
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) =>
      operation(tx),
  } as unknown as DirectDatabase;
  return { db, locks, updates };
}

const input = { taskId: ids.task, taskRunId: ids.run } as const;

describe("protected Task cancellation output settlement", () => {
  test("settles authorization before attaching and completing no-delivery output", async () => {
    const state = fixture();
    let callbackExited = false;
    const result = await settleProtectedTaskCancellationOutput(
      state.db,
      input,
      async proof => {
        expect(state.updates).toEqual([]);
        expect(proof).toMatchObject({
          intent: {
            taskId: ids.task,
            taskRunId: ids.run,
            requesterUserId: ids.owner,
            agentId: ids.agent,
            contentNamespaceId: ids.namespace,
            representation: "protected",
            policyRevision: 9,
            resultRevision: 2,
            resultObjectId,
            terminalAt,
          },
          requesterHumanId: ids.human,
          currentPolicyRevision: 9,
          cryptoAccessRevision: 0,
        });
        expect(proof.authorityFingerprint).toEqual(authorityFingerprint);
        expect(proof.requiredNamespaceFingerprint)
          .toEqual(namespaceFingerprint);
        callbackExited = true;
        return true;
      },
    );
    expect(callbackExited).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      binding: {
        resultAttachedAt: terminalAt,
        completedAt: terminalAt,
      },
    });
    expect(state.updates).toEqual([{
      resultAttachedAt: terminalAt,
      completedAt: terminalAt,
    }]);
    expect(state.locks.map(({ table }) => table)).toEqual([
      encryptionTransitionPolicy,
      tasks,
      taskRuns,
      protectedTaskRunOutputBindings,
      taskDefinitionCryptoRevisions,
      taskRunResultCryptoRevisions,
      actors,
    ]);
  });

  test("replays an attached Shadow result without taking over delivery", async () => {
    const state = fixture({
      task: task({
        callingRoomId: ids.room,
        resultDelivery: "raw",
        contentRepresentation: "dual",
        prompt: "ordinary shadow",
      }),
      run: run({
        resultRepresentation: "dual",
        resultText: PROTECTED_TASK_CANCELLED_RESULT,
      }),
      binding: binding({
        deliveryMode: "raw",
        destinationRoomId: ids.room,
        destinationNamespaceId: ids.namespace,
        messageOperationId: protectedTaskRunMessageOperationId(ids.run),
        resultAttachedAt: terminalAt,
      }),
    });
    expect(await settleProtectedTaskCancellationOutput(
      state.db,
      input,
      () => Promise.resolve(true),
    )).toMatchObject({
      status: "exact_replay",
      binding: { completedAt: null, messagePublishedAt: null },
    });
    expect(state.updates).toEqual([]);
  });

  test("leaves the product untouched when authorization is not settled", async () => {
    const state = fixture();
    expect(await settleProtectedTaskCancellationOutput(
      state.db,
      input,
      () => Promise.resolve(false),
    )).toEqual({ status: "rejected", reason: "not_ready" });
    expect(state.updates).toEqual([]);
  });

  test("settles old immutable intent only under an explicit newer same-mode policy", async () => {
    const state = fixture({ policyRevision: 10 });
    const revisions: number[] = [];
    expect(await settleProtectedTaskCancellationOutput(
      state.db,
      { ...input, currentPolicyRevision: 10 },
      proof => {
        revisions.push(proof.currentPolicyRevision);
        expect(proof.intent.policyRevision).toBe(9);
        return Promise.resolve(true);
      },
    )).toMatchObject({ status: "completed" });
    expect(revisions).toEqual([10]);

    const strict = fixture({ policyRevision: 10 });
    expect(await settleProtectedTaskCancellationOutput(
      strict.db,
      input,
      () => Promise.resolve(true),
    )).toEqual({ status: "rejected", reason: "authority_changed" });

    const crossMode = fixture({ policyRevision: 10, policyMode: "shadow_encryption" });
    expect(await settleProtectedTaskCancellationOutput(
      crossMode.db,
      { ...input, currentPolicyRevision: 10 },
      () => Promise.resolve(true),
    )).toEqual({ status: "rejected", reason: "authority_changed" });

    const backwards = fixture({ policyRevision: 8 });
    expect(await settleProtectedTaskCancellationOutput(
      backwards.db,
      { ...input, currentPolicyRevision: 8 },
      () => Promise.resolve(true),
    )).toEqual({ status: "rejected", reason: "authority_changed" });
  });

  test("rejects Plain, stale authority, incomplete crypto, and conflicting receipts", async () => {
    const cases = [
      fixture({ task: task({ contentRepresentation: "ordinary" }) }),
      fixture({ policyRevision: 10 }),
      fixture({ reservation: reservation("protected", {
        completion: "pending",
        disposition: "active",
      }) }),
      fixture({ binding: binding({
        resultAttachedAt: terminalAt,
        messageId: 42,
        messagePublishedAt: null,
      }) }),
      fixture({ actor: { id: ids.human, kind: "user",
        ownerId: ids.room } as Actor }),
    ];
    for (const state of cases) {
      let callbackCalled = false;
      const result = await settleProtectedTaskCancellationOutput(
        state.db,
        input,
        () => {
          callbackCalled = true;
          return Promise.resolve(true);
        },
      );
      expect(result.status).toBe("rejected");
      expect(callbackCalled).toBe(false);
      expect(state.updates).toEqual([]);
    }
  });

  test("rejects malformed coordinates before locking", async () => {
    const state = fixture();
    expect(settleProtectedTaskCancellationOutput(
      state.db,
      { ...input, taskRunId: "invalid" },
      () => Promise.resolve(true),
    )).rejects.toThrow("malformed");
    expect(state.locks).toEqual([]);
  });
});
