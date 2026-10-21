import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY,
  settleAbandonedProtectedTaskRun,
  listProtectedTaskRunningRecoveryCandidates,
} from "../../src/queries/protected-task-running-recovery";
import { protectedTaskRunResultObjectId } from
  "../../src/queries/protected-task-output-binding-identities";
import { encryptionTransitionPolicy } from
  "../../src/schema/encryption-transition";
import { jobs } from "../../src/schema/jobs";
import { protectedTaskRunOutputBindings } from
  "../../src/schema/protected-task-run-output-bindings";
import { taskDefinitionCryptoRevisions } from
  "../../src/schema/task-definition-crypto-revisions";
import { taskRunResultCryptoRevisions } from
  "../../src/schema/task-run-result-crypto-revisions";
import { taskRuns } from "../../src/schema/task-runs";
import { tasks } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  requestor: "40000000-0000-4000-8000-000000000004",
  namespace: "50000000-0000-4000-8000-000000000005",
};
const definitionObject = `task-definition:v1:${"a".repeat(64)}`;
const resultObject = protectedTaskRunResultObjectId(ids.task, ids.run);
const fingerprint = new Uint8Array(32).fill(7);
const startedAt = new Date("2026-10-12T08:00:00.000Z");
const settledAt = new Date("2026-10-12T09:00:00.000Z");

function reference() {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: definitionObject,
    resultObjectId: resultObject,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 7,
    executionSegment: 1,
  };
}

type State = ReturnType<typeof initialState>;
function initialState() {
  const definition = {
    taskId: ids.task, contentNamespaceId: ids.namespace, contentRevision: 1,
    cryptoObjectId: definitionObject, representation: "protected",
    payloadVersion: 1, cryptoAccessRevision: 0,
    requiredNamespaceFingerprint: fingerprint, anchorNamespaceId: ids.namespace,
    completion: "complete", disposition: "mapped", failureCode: null,
    historicalRepair: null as Record<string, unknown> | null,
  };
  return {
    policy: { mode: "encrypted_only", revision: 8 },
    task: {
      id: ids.task, requestorId: ids.requestor, scheduleKind: "now",
      status: "running", contentRepresentation: "protected",
      pauseRequestId: null as string | null,
      contentNamespaceId: ids.namespace, contentRevision: 1,
      cryptoObjectId: definitionObject, cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: fingerprint,
      cryptoMappingState: "verified",
      promptIsEmpty: true, expectedOutputIsNull: true, lastErrorIsNull: true,
    },
    run: {
      id: ids.run, taskId: ids.task, jobId: ids.job, status: "running",
      startedAt, completedAt: null as Date | null,
      resultTextIsNull: true, lastErrorIsNull: true,
      resultRepresentation: "ordinary", resultContentNamespaceId: null,
      resultRevision: 0, resultCryptoObjectId: null,
      resultCryptoAccessRevision: 0,
      resultCryptoRequiredNamespaceFingerprint: null,
      resultCryptoMappingState: "unmapped",
    },
    job: {
      id: ids.job, ownerId: ids.requestor, requestorId: ids.requestor,
      laneKey: `task:${ids.task}`, type: "foreground", status: "running",
      input: reference(), resultIsNull: true, messageIsNull: true,
      startedAt, completedAt: null as Date | null,
      metadata: {} as Record<string, unknown>,
    },
    definition,
    retainedDefinitions: [] as Array<typeof definition>,
    binding: {
      taskRunId: ids.run, bindingId: `task-run-output:${ids.run}`,
      deliveryMode: "none", destinationRoomId: null,
      destinationNamespaceId: null, resultRevision: 1,
      resultOperationId: `task-run-result:${ids.run}`, resultObjectId: resultObject,
      messageOperationId: null, wakeOperationId: null,
      acceptedPolicyRevision: 7, acceptedAt: startedAt,
      resultTerminalAt: null, resultAttachedAt: null,
      messageId: null, messagePublishedAt: null, wakeJobId: null,
      wakeScheduledAt: null, completedAt: null,
    },
    reservations: [] as unknown[],
    newestRunId: ids.run,
  };
}

function editedCronState(): State {
  const state = initialState();
  state.task.scheduleKind = "cron";
  state.task.status = "pending";
  state.retainedDefinitions.push(structuredClone(state.definition));
  state.task.contentRevision = 2;
  state.task.cryptoObjectId = `task-definition:v1:${"b".repeat(64)}`;
  state.task.cryptoRequiredNamespaceFingerprint = new Uint8Array(32).fill(8);
  state.definition = {
    ...state.definition,
    contentRevision: state.task.contentRevision,
    cryptoObjectId: state.task.cryptoObjectId,
    requiredNamespaceFingerprint: state.task.cryptoRequiredNamespaceFingerprint,
  };
  return state;
}

function fakeDatabase(state: State): DirectDatabase {
  const transaction = async <T>(use: (tx: unknown) => Promise<T>): Promise<T> => {
    const snapshot = structuredClone(state);
    const rows = (table: unknown): unknown[] => {
      if (table === encryptionTransitionPolicy) return [state.policy];
      if (table === tasks) return [state.task];
      if (table === jobs) return [state.job];
      if (table === taskDefinitionCryptoRevisions) {
        return [state.definition, ...state.retainedDefinitions];
      }
      if (table === protectedTaskRunOutputBindings) return [state.binding];
      if (table === taskRunResultCryptoRevisions) return state.reservations;
      if (table === taskRuns) {
        return selectCount === 1 ? [state.run] : [{ id: state.newestRunId }];
      }
      return [];
    };
    let selectCount = 0;
    const tx = {
      select: () => ({
        from(table: unknown) {
          if (table === taskRuns) selectCount += 1;
          const result = () => rows(table);
          const chain: Record<string, unknown> = {};
          for (const method of ["where", "orderBy", "limit"] as const) {
            chain[method] = () => chain;
          }
          chain["for"] = async () => result();
          chain["then"] = (
            resolve: (value: unknown[]) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => Promise.resolve(result()).then(resolve, reject);
          return chain;
        },
      }),
      update(table: unknown) {
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                return {
                  async returning() {
                    const target = table === jobs ? state.job
                      : table === taskRuns ? state.run : state.task;
                    if (table === jobs && target.id !== ids.job) return [];
                    Object.assign(target, values);
                    return [{ id: target.id }];
                  },
                };
              },
            };
          },
        };
      },
    };
    try {
      return await use(tx);
    } catch (error) {
      Object.assign(state, snapshot);
      throw error;
    }
  };
  return { transaction } as unknown as DirectDatabase;
}

describe("protected Task running recovery product owner", () => {
  test("settles an exact pristine run without writing content siblings", async () => {
    const state = initialState();
    let proof: unknown;
    const result = await settleAbandonedProtectedTaskRun(
      fakeDatabase(state), { taskId: ids.task, taskRunId: ids.run },
      value => {
        proof = value;
        return Promise.resolve({ requestRevision: 12, recipientGeneration: 3, settledAt });
      },
    );
    expect(result).toEqual({
      status: "settled",
      cleanup: { requestId: `task-run-authorization:${ids.run}`, generation: 3 },
    });
    expect(proof).toEqual({
      taskId: ids.task, taskRunId: ids.run, jobId: ids.job,
      jobStatus: "running", authorizationRequestId: `task-run-authorization:${ids.run}`,
      contentNamespaceId: ids.namespace, acceptedPolicyRevision: 7,
      executionSegment: 1,
    });
    expect(state.run).toMatchObject({ status: "errored", completedAt: settledAt,
      resultTextIsNull: true, lastErrorIsNull: true });
    expect(state.task).toMatchObject({ status: "errored", lastErrorIsNull: true });
    expect(state.job).toMatchObject({
      status: "failed", completedAt: settledAt, resultIsNull: true, messageIsNull: true,
    });
    expect(state.job.metadata[PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY])
      .toEqual({
        version: 1, taskId: ids.task, taskRunId: ids.run,
        authorizationRequestId: `task-run-authorization:${ids.run}`,
        requestRevision: 12, recipientGeneration: 3, executionSegment: 1,
        reason: "provider_outcome_unknown", settledAt: settledAt.toISOString(),
        parentTaskTerminalized: true,
      });
  });

  test("a revision-one result reservation returns before authorization settlement", async () => {
    const state = initialState();
    state.reservations.push({ sequence: 1 });
    let calls = 0;
    const result = await settleAbandonedProtectedTaskRun(
      fakeDatabase(state), { taskId: ids.task, taskRunId: ids.run }, async () => {
        calls += 1;
        return { requestRevision: 12, recipientGeneration: 3, settledAt };
      },
    );
    expect(result).toEqual({ status: "reserved" });
    expect(calls).toBe(0);
    expect(state.run.status).toBe("running");
  });

  test("exact receipt replay never invokes authorization settlement again", async () => {
    const state = initialState();
    const db = fakeDatabase(state);
    await settleAbandonedProtectedTaskRun(
      db, { taskId: ids.task, taskRunId: ids.run },
      async () => ({ requestRevision: 12, recipientGeneration: 3, settledAt }),
    );
    let calls = 0;
    const replay = await settleAbandonedProtectedTaskRun(
      db, { taskId: ids.task, taskRunId: ids.run }, async () => {
        calls += 1;
        return null;
      },
    );
    expect(replay).toEqual({ status: "exact_replay", cleanup: {
      requestId: `task-run-authorization:${ids.run}`, generation: 3,
    } });
    expect(calls).toBe(0);
  });

  test.each(["failed", "timed_out", "cancelled"])(
    "preserves an already-terminal exact Job while settling its running Run (%s)",
    async jobStatus => {
      const state = initialState();
      const jobCompletedAt = new Date("2026-10-12T08:30:00.000Z");
      state.job.status = jobStatus;
      state.job.completedAt = jobCompletedAt;
      const result = await settleAbandonedProtectedTaskRun(
        fakeDatabase(state), { taskId: ids.task, taskRunId: ids.run },
        async () => ({ requestRevision: 12, recipientGeneration: 3, settledAt }),
      );
      expect(result.status).toBe("settled");
      expect(state.job.status).toBe(jobStatus);
      expect(state.job.completedAt).toEqual(jobCompletedAt);
    },
  );

  test("Plain and incompatible policy never invoke the authorization owner", async () => {
    for (const mutate of [
      (state: State) => { state.task.contentRepresentation = "ordinary"; },
      (state: State) => { state.policy.mode = "shadow_encryption"; },
      (state: State) => { state.policy.revision = 6; },
    ]) {
      const state = initialState();
      mutate(state);
      let calls = 0;
      const result = await settleAbandonedProtectedTaskRun(
        fakeDatabase(state), { taskId: ids.task, taskRunId: ids.run }, async () => {
          calls += 1;
          return { requestRevision: 12, recipientGeneration: 3, settledAt };
        },
      );
      expect(["inactive", "policy_wait"]).toContain(result.status);
      expect(calls).toBe(0);
      expect(state.run.status).toBe("running");
    }
  });

  test("older cron run closes without terminalizing the parent or its future schedule", async () => {
    const state = initialState();
    state.task.scheduleKind = "cron";
    state.task.status = "pending";
    state.newestRunId = "20000000-0000-4000-8000-000000000099";
    const result = await settleAbandonedProtectedTaskRun(
      fakeDatabase(state), { taskId: ids.task, taskRunId: ids.run },
      async () => ({ requestRevision: 12, recipientGeneration: 3, settledAt }),
    );
    expect(result.status).toBe("settled");
    expect(state.task.status).toBe("pending");
    expect(state.run.status).toBe("errored");
    expect(state.job.metadata[PROTECTED_TASK_RUN_ABANDONMENT_RECEIPT_METADATA_KEY])
      .toMatchObject({ parentTaskTerminalized: false });
  });

  test.each(["protected", "dual"])(
    "an edited pending cron Task settles its retained execution input (%s)",
    async representation => {
      const state = editedCronState();
      state.task.contentRepresentation = representation;
      state.definition.representation = representation;
      state.retainedDefinitions[0]!.representation = representation;
      if (representation === "dual") {
        state.policy.mode = "shadow_encryption";
        state.task.promptIsEmpty = false;
        state.task.expectedOutputIsNull = false;
      }
      const currentTask = structuredClone(state.task);
      const result = await settleAbandonedProtectedTaskRun(
        fakeDatabase(state), { taskId: ids.task, taskRunId: ids.run },
        async () => ({ requestRevision: 12, recipientGeneration: 3, settledAt }),
      );
      expect(result.status).toBe("settled");
      expect(state.task).toEqual(currentTask);
      expect(state.run.status).toBe("errored");
      expect(state.job.input.inputObjectId).toBe(definitionObject);
    },
  );

  test("retained execution input and current definition must both remain exact mapped proofs", async () => {
    const mutations: Array<(state: State) => void> = [
      state => { state.job.input.inputObjectId = `task-definition:v1:${"c".repeat(64)}`; },
      state => { state.retainedDefinitions[0]!.taskId = ids.run; },
      state => { state.retainedDefinitions[0]!.contentNamespaceId = ids.run; },
      state => { state.retainedDefinitions[0]!.anchorNamespaceId = ids.run; },
      state => { state.retainedDefinitions[0]!.representation = "dual"; },
      state => { state.retainedDefinitions[0]!.disposition = "active"; },
      state => { state.retainedDefinitions[0]!.completion = "pending"; },
      state => { state.retainedDefinitions[0]!.contentRevision = 3; },
      state => { state.retainedDefinitions[0]!.requiredNamespaceFingerprint = new Uint8Array(0); },
      state => { state.definition.disposition = "active"; },
      state => { state.definition.requiredNamespaceFingerprint = fingerprint; },
      state => { state.task.cryptoMappingState = "unmapped"; },
      state => { state.job.requestorId = ids.run; },
    ];
    for (const mutate of mutations) {
      const state = editedCronState();
      mutate(state);
      let calls = 0;
      const result = await settleAbandonedProtectedTaskRun(
        fakeDatabase(state), { taskId: ids.task, taskRunId: ids.run }, async () => {
          calls += 1;
          return { requestRevision: 12, recipientGeneration: 3, settledAt };
        },
      );
      expect(result.status).toBe("inactive");
      expect(calls).toBe(0);
      expect(state.run.status).toBe("running");
    }
  });

  test("product rollback leaves no abandonment receipt for a committed authorization CAS", async () => {
    const state = initialState();
    const db = fakeDatabase(state);
    // Corrupt the locked job after authorization succeeds so the product CAS throws.
    let authorized = false;
    const promise = settleAbandonedProtectedTaskRun(
      db, { taskId: ids.task, taskRunId: ids.run }, async () => {
        authorized = true;
        state.job.id = "lost";
        return { requestRevision: 12, recipientGeneration: 3, settledAt };
      },
    );
    expect(promise).rejects.toThrow("lost its Job");
    expect(authorized).toBe(true);
    expect(state.run.status).toBe("running");
    expect(state.job.metadata).toEqual({});
  });
});


test("running discovery binds both timestamp cursor comparisons through the column codec", async () => {
  let predicate: SQL | undefined;
  const query = {
    from() { return query; }, innerJoin() { return query; },
    where(value: SQL) { predicate = value; return query; },
    orderBy() { return query; }, async limit() { return []; },
  };
  await listProtectedTaskRunningRecoveryCandidates({ select: () => query } as unknown as DirectDatabase, {
    limit: 10,
    through: { startedAt: settledAt, taskRunId: ids.run },
    after: { startedAt, taskRunId: ids.run },
  });
  const compiled = new PgDialect().sqlToQuery(predicate!);
  expect(compiled.params.filter(value => value instanceof Date)).toEqual([]);
  expect(compiled.params.filter(value => value === settledAt.toISOString())).toHaveLength(2);
  expect(compiled.params.filter(value => value === startedAt.toISOString())).toHaveLength(2);
});


test("abandoned Run settlement preserves a pending aggregate pause", async () => {
  const state = initialState();
  state.task.pauseRequestId = ids.run;
  const result = await settleAbandonedProtectedTaskRun(fakeDatabase(state), {
    taskId: ids.task, taskRunId: ids.run,
  }, async () => ({ requestRevision: 12, recipientGeneration: 3, settledAt }));
  expect(result.status).toBe("settled");
  expect(state.run.status).toBe("errored");
  expect(state.task.status).toBe("running");
});


describe("renewed checkpoint running recovery policy provenance", () => {
  function renewedState() {
    const state = initialState();
    const continuation = Buffer.from(new Uint8Array(32).fill(9)).toString("base64url");
    Object.assign(state.job.input, { executionSegment: 2, policyRevision: 8,
      authorizationRequestId: `task-checkpoint-continuation:${ids.run}:2:${continuation}`,
      resumeContinuationFingerprint: continuation });
    state.policy.revision = 9;
    return state;
  }
  test("adopts the actual later execution grant while retaining original binding revision", async () => {
    const state = renewedState();
    const result = await settleAbandonedProtectedTaskRun(fakeDatabase(state), {
      taskId: ids.task, taskRunId: ids.run,
    }, async proof => {
      expect(proof.acceptedPolicyRevision).toBe(8);
      expect(proof.executionSegment).toBe(2);
      expect(proof.authorizationRequestId).toBe(state.job.input.authorizationRequestId);
      return { requestRevision: 12, recipientGeneration: 3, settledAt };
    });
    expect(result.status).toBe("settled");
    expect(state.binding.acceptedPolicyRevision).toBe(7);
    expect((await settleAbandonedProtectedTaskRun(fakeDatabase(state), {
      taskId: ids.task, taskRunId: ids.run,
    }, async () => { throw new Error("settled replay must not re-adopt"); })).status).toBe("exact_replay");
  });
  test("older current fence, newer binding, or incompatible mode never adopts", async () => {
    for (const mutate of [
      (state: State) => { state.policy.revision = 7; },
      (state: State) => { state.binding.acceptedPolicyRevision = 9; },
      (state: State) => { state.policy.mode = "shadow_encryption"; },
      (state: State) => { state.policy.mode = "plaintext_only"; },
    ]) {
      const state = renewedState(); mutate(state);
      let calls = 0;
      const result = await settleAbandonedProtectedTaskRun(fakeDatabase(state), {
        taskId: ids.task, taskRunId: ids.run,
      }, async () => { calls += 1; return { requestRevision: 12, recipientGeneration: 3, settledAt }; });
      expect(["inactive", "policy_wait"]).toContain(result.status);
      expect(calls).toBe(0);
      expect(state.run.status).toBe("running");
    }
  });
});


test("uncertain-outcome recovery accepts retained dual input under Full without changing it", async () => {
  const state = initialState();
  state.task.contentRepresentation = "dual";
  state.task.promptIsEmpty = false;
  state.task.expectedOutputIsNull = false;
  state.definition.representation = "dual";
  let calls = 0;
  expect((await settleAbandonedProtectedTaskRun(fakeDatabase(state),
    { taskId: ids.task, taskRunId: ids.run }, async () => {
      calls += 1;
      return { requestRevision: 12, recipientGeneration: 3, settledAt };
    })).status).toBe("settled");
  expect(calls).toBe(1);
  expect(state.task.contentRepresentation).toBe("dual");
  expect(state.task.promptIsEmpty).toBe(false);
  expect(state.run.resultTextIsNull).toBe(true);
});


test("historical head-one unknown-effect cleanup remains metadata-only and exact", async () => {
  const historical = () => {
    const state = initialState();
    state.task.contentRepresentation = "dual";
    state.task.promptIsEmpty = false;
    state.task.cryptoAccessRevision = 1;
    state.definition.representation = "dual";
    const objectId = `task-historical:v1:${"c".repeat(64)}`;
    state.task.cryptoObjectId = objectId;
    state.definition.cryptoObjectId = objectId;
    state.job.input.inputObjectId = objectId;
    state.definition.historicalRepair = { version: 2, claimId: ids.run,
      publisherDeviceId: "test-device", sourceRevision: 0,
      signedRequestDigest: "d".repeat(64), sourceDigest: "e".repeat(64),
      sourcePayloadHash: "f".repeat(64), genesisManifestHash: "a".repeat(64) };
    return state;
  };
  const state = historical();
  expect((await settleAbandonedProtectedTaskRun(fakeDatabase(state),
    { taskId: ids.task, taskRunId: ids.run }, async () => ({
      requestRevision: 12, recipientGeneration: 3, settledAt,
    }))).status).toBe("settled");
  expect(state.task.cryptoAccessRevision).toBe(1);
  expect(state.definition.cryptoAccessRevision).toBe(0);
  for (const mutate of [
    (s: State) => { s.definition.historicalRepair = null; },
    (s: State) => { s.definition.historicalRepair!["version"] = 1; },
    (s: State) => { s.definition.historicalRepair!["sourceDigest"] = "invalid"; },
    (s: State) => { s.job.input.inputObjectId = `task-historical:v1:${"b".repeat(64)}`; },
    (s: State) => { s.definition.cryptoObjectId = `task-historical:v1:${"b".repeat(64)}`; },
    (s: State) => { s.definition.contentNamespaceId = ids.run; },
  ]) {
    const changed = historical(); mutate(changed);
    expect((await settleAbandonedProtectedTaskRun(fakeDatabase(changed),
      { taskId: ids.task, taskRunId: ids.run }, async () => {
        throw new Error("invalid input cannot reach authorization settlement");
      })).status).toBe("inactive");
  }
});
