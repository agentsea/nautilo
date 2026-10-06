import { bytesToHex } from "@noble/hashes/utils.js";
import {
  acquireEncryptionConsumptionFence,
  eq,
  jobs,
  taskRuns,
  tasks,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  type LatticeCrypto,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  withCurrentAcceptedTaskRuntimeAuthority,
  type ConversationProductCanonicalTransactionRunner,
  type CryptoPostgresHandle,
  type CurrentTaskRuntimeAuthority,
  type TaskRuntimeAuthoritySubject,
} from "@nautilo/lattice-bridge/server";
import {
  assertProtectedTaskJobReferenceV1,
  isCurrentProtectedTaskRunForGrant,
  PostgresBackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskJobReferenceV1,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";

import {
  acceptedTaskRuntimeRecord,
  destroyAcceptedTaskRuntimeRecord,
  loadCurrentProtectedTaskRuntimeFacts,
} from "./task-runtime-current-authority";

export type ProtectedTaskMemoryAuthorityInput = Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  subject: TaskRuntimeAuthoritySubject;
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  evidence: TaskRuntimeExecutionEvidence;
  jobId: string;
  executionRoomId: string;
  reference: ProtectedTaskJobReferenceV1;
  now(): number;
  signal: AbortSignal;
}>;

export type CurrentProtectedTaskMemoryPolicy = Readonly<{
  mode: "shadow_encryption" | "encrypted_only";
  shadowBehavior: "fallback" | "strict";
  revision: number;
}>;

export type HeldProtectedTaskMemoryAuthority = Readonly<{
  policy: CurrentProtectedTaskMemoryPolicy;
  currentRuntime: CurrentTaskRuntimeAuthority;
  assertCurrent(): Promise<void>;
}>;

export type HeldProtectedTaskMemoryWriterAuthority = Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidence;
  restricted: PostgresJsBridgeConnection;
  restrictedHandle: CryptoPostgresHandle;
  assertCurrent(): Promise<void>;
}>;

class TaskMemoryAuthorityUnavailable extends Error {}

type HeldState = {
  active: boolean;
  input: ProtectedTaskMemoryAuthorityInput;
  acceptedAuthorizationExpiresAt: number;
  authority: CurrentTaskRuntimeAuthority;
  policy: CurrentProtectedTaskMemoryPolicy;
  restricted: PostgresJsBridgeConnection | null;
  restrictedHandle: CryptoPostgresHandle | null;
};

const heldStates = new WeakMap<HeldProtectedTaskMemoryAuthority, HeldState>();

function connection(
  executor: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  return {
    query: executor.query.bind(executor),
    transaction: use => use(executor),
    transactionOnce: use => use(executor),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactReference(
  value: unknown,
  expected: ProtectedTaskJobReferenceV1,
): boolean {
  try {
    assertProtectedTaskJobReferenceV1(value);
  } catch {
    return false;
  }
  return Object.entries(expected).every(
    ([key, entry]) => (value as Record<string, unknown>)[key] === entry,
  );
}

/** Compare the complete live grant, not just one selected Memory Namespace. */
export function taskMemoryAuthorityMatchesEvidence(
  authority: CurrentTaskRuntimeAuthority,
  evidence: TaskRuntimeExecutionEvidence,
): boolean {
  const plan = authority.plan;
  return authority.policyRevision === evidence.policyRevision
    && plan.authorizationId === evidence.requestId
    && plan.sessionId === evidence.episodeId
    && plan.roomId === evidence.sourceRoomId
    && plan.hostAuthorizationRevision === evidence.hostAuthorizationRevision
    && plan.recipientKind === "runtime"
    && plan.recipientPrincipalId === "nautilo_task_runtime"
    && plan.recipientAuthorizationRevision
      === evidence.recipientAuthorizationRevision
    && plan.recipientRuntimeGeneration === evidence.recipientGeneration
    && plan.recipientKeyId === evidence.recipientKeyId
    && authority.namespaceRequirements.length
      === evidence.namespaceRequirements.length
    && authority.namespaceRequirements.every((entry, index) => {
      const expected = evidence.namespaceRequirements[index];
      return expected !== undefined
        && entry.ordinal === expected.ordinal
        && entry.namespaceId === expected.namespaceId
        && entry.domainId === expected.domainId
        && entry.expectedAccessRevision === expected.expectedAccessRevision
        && entry.expectedPolicyRevision === expected.expectedPolicyRevision
        && entry.operations.join(",") === expected.operations.join(",");
    })
    && authority.domains.length === evidence.domainRequirements.length
    && authority.domains.every(entry => {
      const matches = evidence.domainRequirements.filter(
        expected => expected.domainId === entry.domainId,
      );
      const expected = matches[0];
      return matches.length === 1
        && expected !== undefined
        && entry.keyClass === "ai"
        && entry.sourceNamespaceId === expected.sourceNamespaceId
        && entry.domainKeyGeneration === expected.domainKeyGeneration
        && entry.authorizationRevision === expected.authorizationRevision
        && entry.participantCount === expected.participantCount
        && entry.activeNamespaceBindingCount
          === expected.activeNamespaceBindingCount
        && sameBytes(entry.participantDigest, expected.participantDigest)
        && sameBytes(entry.headDigest, expected.headDigest)
        && sameBytes(
          entry.activeNamespaceBindingSetDigest,
          expected.activeNamespaceBindingSetDigest,
        );
    });
}

function assertInputBinding(
  input: ProtectedTaskMemoryAuthorityInput,
  checkedAt: number,
  acceptedAuthorizationExpiresAt?: number,
): void {
  input.signal.throwIfAborted();
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  assertProtectedTaskJobReferenceV1(input.reference);
  const { evidence, reference, occurrence, record, request } = input;
  const snapshot = record.snapshot;
  if (
    reference.taskId !== occurrence.task.id
    || reference.taskRunId !== occurrence.run.id
    || reference.inputObjectId !== occurrence.task.cryptoObjectId
    || reference.resultObjectId !== evidence.result.objectId
    || reference.authorizationRequestId !== evidence.requestId
    || reference.policyRevision !== evidence.policyRevision
    || evidence.result.taskId !== occurrence.task.id
    || evidence.result.taskRunId !== occurrence.run.id
    || evidence.workId !== occurrence.run.id
    || evidence.result.signerAgentId !== occurrence.task.agentId
    || evidence.result.namespace.namespaceId
      !== occurrence.task.contentNamespaceId
    || occurrence.task.requestorId !== input.subject.userId
    || (snapshot.state !== "claimed" && snapshot.state !== "running")
    || snapshot.requestId !== evidence.requestId
    || snapshot.workId !== evidence.workId
    || snapshot.claimId !== evidence.claimId
    || snapshot.claimExpiresAt !== evidence.claimExpiresAt
    || snapshot.recipientGeneration !== evidence.recipientGeneration
    || snapshot.recipient?.recipientKeyId !== evidence.recipientKeyId
    || snapshot.recipient.expiresAt !== evidence.recipientExpiresAt
    || snapshot.acceptedResponse?.responseDigest
      !== bytesToHex(evidence.authorizationDigest)
    || record.expectedPolicyRevision !== evidence.policyRevision
    || request.requestId !== evidence.requestId
    || request.workId !== evidence.workId
    || request.episodeId !== evidence.episodeId
    || request.sourceRoomId !== evidence.sourceRoomId
    || input.jobId.length === 0
    || input.executionRoomId.length === 0
    || !Number.isSafeInteger(checkedAt)
    || checkedAt < request.issuedAt
    || checkedAt >= request.deadlineAt
    || checkedAt >= evidence.expiresAt
    || snapshot.claimExpiresAt === null
    || checkedAt >= snapshot.claimExpiresAt
    || snapshot.recipient === null
    || checkedAt >= snapshot.recipient.expiresAt
    || (acceptedAuthorizationExpiresAt !== undefined
      && checkedAt >= acceptedAuthorizationExpiresAt)
  ) throw new TaskMemoryAuthorityUnavailable();

  const bytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  try {
    if (record.descriptorBytes === null
      || !sameBytes(bytes, record.descriptorBytes)) {
      throw new TaskMemoryAuthorityUnavailable();
    }
  } finally {
    bytes.fill(0);
  }
}

function stateFor(
  held: HeldProtectedTaskMemoryAuthority,
): HeldState {
  const state = heldStates.get(held);
  if (state === undefined || !state.active) {
    throw new TypeError("Task Memory authority is not active");
  }
  return state;
}

function assertHeldCurrentSync(
  held: HeldProtectedTaskMemoryAuthority,
): void {
  const state = stateFor(held);
  const checkedAt = state.input.now();
  assertInputBinding(
    state.input,
    checkedAt,
    state.acceptedAuthorizationExpiresAt,
  );
  if (state.policy.revision !== state.input.evidence.policyRevision
    || !taskMemoryAuthorityMatchesEvidence(
      state.authority,
      state.input.evidence,
    )) throw new TaskMemoryAuthorityUnavailable();
}

function assertHeldActiveSync(
  held: HeldProtectedTaskMemoryAuthority,
): void {
  stateFor(held);
}

function assertHeldCurrent(
  held: HeldProtectedTaskMemoryAuthority,
): Promise<void> {
  assertHeldCurrentSync(held);
  return Promise.resolve();
}

function guardedRestrictedExecutor(
  held: HeldProtectedTaskMemoryAuthority,
  executor: PostgresJsBridgeExecutor,
  callbackActive: () => boolean,
): PostgresJsBridgeExecutor {
  return Object.freeze({
    async query<Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: Parameters<PostgresJsBridgeExecutor["query"]>[1],
    ): Promise<readonly Row[]> {
      if (!callbackActive()) {
        throw new TypeError("Task Memory restricted transaction is not active");
      }
      assertHeldActiveSync(held);
      const rows = await executor.query<Row>(statement, parameters);
      if (!callbackActive()) {
        throw new TypeError("Task Memory restricted transaction is not active");
      }
      assertHeldActiveSync(held);
      return rows;
    },
  }) as PostgresJsBridgeExecutor;
}

function guardedRestrictedConnection(
  held: HeldProtectedTaskMemoryAuthority,
  restricted: PostgresJsBridgeConnection,
): PostgresJsBridgeConnection {
  const transaction = async <Value>(
    start: (
      callback: (executor: PostgresJsBridgeExecutor) => Promise<Value>,
      options?: Parameters<PostgresJsBridgeConnection["transaction"]>[1],
    ) => Promise<Value>,
    use: (executor: PostgresJsBridgeExecutor) => Promise<Value>,
    options?: Parameters<PostgresJsBridgeConnection["transaction"]>[1],
  ): Promise<Value> => {
    assertHeldActiveSync(held);
    const value = await start(async executor => {
      assertHeldActiveSync(held);
      let callbackOpen = true;
      const guarded = guardedRestrictedExecutor(
        held,
        executor,
        () => callbackOpen,
      );
      try {
        assertHeldActiveSync(held);
        const result = await use(guarded);
        assertHeldActiveSync(held);
        return result;
      } finally {
        callbackOpen = false;
      }
    }, options);
    assertHeldActiveSync(held);
    return value;
  };
  const executor = guardedRestrictedExecutor(held, restricted, () => true);
  return Object.freeze({
    query: <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: Parameters<PostgresJsBridgeExecutor["query"]>[1],
    ): Promise<readonly Row[]> => executor.query<Row>(statement, parameters),
    transaction: <Value>(
      use: (executor: PostgresJsBridgeExecutor) => Promise<Value>,
      options?: Parameters<PostgresJsBridgeConnection["transaction"]>[1],
    ) => transaction(
      (callback, currentOptions) => restricted.transaction(
        callback,
        currentOptions,
      ),
      use,
      options,
    ),
    transactionOnce: <Value>(
      use: (executor: PostgresJsBridgeExecutor) => Promise<Value>,
      options?: Parameters<PostgresJsBridgeConnection["transaction"]>[1],
    ) => transaction(
      (callback, currentOptions) => restricted.transactionOnce(
        callback,
        currentOptions,
      ),
      use,
      options,
    ),
  });
}

/**
 * Validate and expose only the restricted bindings needed by the sealed object
 * writer. The WeakMap lookup prevents a cast object or no-op assertion from
 * standing in for a live held Task authority.
 */
export function requireHeldProtectedTaskMemoryWriterAuthority(
  held: HeldProtectedTaskMemoryAuthority,
): HeldProtectedTaskMemoryWriterAuthority {
  const state = stateFor(held);
  if (state.restricted === null || state.restrictedHandle === null) {
    throw new TypeError("Task Memory restricted authority is unavailable");
  }
  return Object.freeze({
    crypto: state.input.crypto,
    evidence: state.input.evidence,
    restricted: state.restricted,
    restrictedHandle: state.restrictedHandle,
    assertCurrent: () => assertHeldCurrent(held),
  });
}

/**
 * Hold current Task Memory authority in the established lock order: global
 * policy; Task, Run and Job; accepted-owner policy and Namespace locks; exact
 * Task/source facts; request claim; then device/group, Namespace and Domain
 * authority. The callback must do only bounded database/crypto publication
 * work with an already-prepared payload.
 */
export async function withCurrentProtectedTaskMemoryAuthority<Value>(
  input: ProtectedTaskMemoryAuthorityInput,
  use: (held: HeldProtectedTaskMemoryAuthority) => Promise<Value>,
): Promise<Value | null> {
  if (input.runner.role !== "nautilo") {
    throw new TypeError(
      "Task Memory publication requires the complete product role",
    );
  }
  assertInputBinding(input, input.now());
  const accepted = acceptedTaskRuntimeRecord(input.record);
  if (accepted === null) return null;
  try {
    try {
      assertInputBinding(input, input.now(), accepted.authorizationExpiresAt);
      return await input.runner.transaction(async (tx, executor) => {
        const policy = await acquireEncryptionConsumptionFence(tx);
        if (policy.mode === "plaintext_only"
          || policy.revision !== input.evidence.policyRevision) return null;

        const [task] = await tx.select({ id: tasks.id }).from(tasks)
          .where(eq(tasks.id, input.occurrence.task.id)).limit(1).for("update");
        const [run] = await tx.select({
          id: taskRuns.id,
          taskId: taskRuns.taskId,
          jobId: taskRuns.jobId,
        }).from(taskRuns).where(eq(taskRuns.id, input.occurrence.run.id))
          .limit(1).for("update");
        const [job] = await tx.select({
          id: jobs.id,
          ownerId: jobs.ownerId,
          requestorId: jobs.requestorId,
          laneKey: jobs.laneKey,
          roomId: jobs.roomId,
          type: jobs.type,
          status: jobs.status,
          input: jobs.input,
          completedAt: jobs.completedAt,
        }).from(jobs).where(eq(jobs.id, input.jobId))
          .limit(1).for("update");
        if (task === undefined
          || run === undefined
          || job === undefined
          || run.taskId !== task.id
          || run.jobId !== job.id
          || job.ownerId !== input.subject.userId
          || job.requestorId !== input.subject.userId
          || job.laneKey !== `task:${task.id}`
          || job.type !== "foreground"
          || job.roomId !== input.executionRoomId
          || job.status !== "running"
          || job.completedAt !== null
          || !exactReference(job.input, input.reference)) return null;

        const product = connection(executor);
        const productHandle = await verifyConversationProductPostgresHandle(
          product,
        );
        const productRunner = bindConversationProductCanonicalTransactionRunner(
          productHandle,
          { transaction: callback => callback(tx, executor) },
        );
        const restricted: PostgresJsBridgeConnection = {
          query: input.restricted.query.bind(input.restricted),
          transaction: input.restricted.transaction.bind(input.restricted),
          transactionOnce: async callback => {
            const facts = await loadCurrentProtectedTaskRuntimeFacts({
              product,
              occurrence: input.occurrence,
            });
            if (facts === null || !isCurrentProtectedTaskRunForGrant({
              occurrence: input.occurrence,
              task: facts.task,
              run: facts.run,
              requestorUserId: input.subject.userId,
              requestWorkId: input.request.workId,
              sourceRoomId: input.request.sourceRoomId,
              requesterPrivateRoom: facts.requesterPrivateRoom,
              phase: "running",
            })) throw new TaskMemoryAuthorityUnavailable();

            return input.restricted.transactionOnce(async restrictedExecutor => {
              const restrictedConnection = connection(restrictedExecutor);
              const restrictedHandle = await verifyCryptoPostgresHandle(
                restrictedConnection,
              );
              const repository = new PostgresBackgroundAuthorizationRepository(
                restrictedHandle,
              );
              const result = await repository
                .withCurrentTaskRuntimeExecutionClaim({
                  expected: input.record,
                  now: input.now,
                  use: async () => callback(restrictedExecutor),
                });
              if (result === null) throw new TaskMemoryAuthorityUnavailable();
              return result;
            }, { isolationLevel: "read committed" });
          },
        };

        return withCurrentAcceptedTaskRuntimeAuthority({
          runner: productRunner,
          restricted,
          crypto: input.crypto,
          serverScope: input.serverScope,
          subject: input.subject,
          accepted,
          now: input.now,
          signal: input.signal,
          use: async (currentRuntime, _product, currentRestricted) => {
            const heldPolicy = Object.freeze({
              mode: policy.mode,
              shadowBehavior: policy.shadowBehavior,
              revision: policy.revision,
            }) as CurrentProtectedTaskMemoryPolicy;
            const mutableHeld = {
              policy: heldPolicy,
              currentRuntime,
              assertCurrent: () => assertHeldCurrent(mutableHeld),
            };
            const held: HeldProtectedTaskMemoryAuthority = Object.freeze(
              mutableHeld,
            );
            const state: HeldState = {
              active: true,
              input,
              acceptedAuthorizationExpiresAt:
                accepted.authorizationExpiresAt,
              authority: currentRuntime,
              policy: heldPolicy,
              restricted: null,
              restrictedHandle: null,
            };
            heldStates.set(held, state);
            try {
              const restricted = guardedRestrictedConnection(
                held,
                currentRestricted,
              );
              state.restricted = restricted;
              assertHeldCurrentSync(held);
              state.restrictedHandle = await verifyCryptoPostgresHandle(
                restricted,
              );
              assertHeldCurrentSync(held);
              const value = await use(held);
              assertHeldCurrentSync(held);
              return value;
            } finally {
              state.active = false;
              heldStates.delete(held);
            }
          },
        });
      }, { isolationLevel: "read committed" });
    } catch (error) {
      if (error instanceof TaskMemoryAuthorityUnavailable) return null;
      throw error;
    }
  } finally {
    destroyAcceptedTaskRuntimeRecord(accepted);
  }
}
