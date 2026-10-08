import { createHash } from "node:crypto";

import { bytesToHex } from "@noble/hashes/utils.js";
import {
  acquireEncryptionConsumptionFence,
  agentScopes,
  and,
  eq,
  jobs,
  rooms,
  taskRuns,
  tasks,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
} from "@nautilo/db";
import type {
  ProtectedMemoryAuthority,
  ProtectedMemorySaveCandidateSelection,
} from "@nautilo/lattice-bridge";
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
  adoptLegacyTaskScopeMemoryOrigin,
  reservePostgresTaskNamespaceMemoryRepairSource,
  reservePostgresTaskScopeMemoryRepairSource,
  attachPostgresTaskNamespaceMemoryRepair,
  attachPostgresTaskScopeMemoryRepair,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  isForegroundProductChangedError,
  type TaskNamespaceMemoryRepairSource,
  type TaskScopeMemoryRepairSource,
  type TaskScopeMemoryOriginAdoptionResult,
  bindConversationProductCanonicalTransactionRunner,
  copyTaskScopeMemoryBinding,
  type TaskScopeMemoryBinding,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  withCurrentAcceptedTaskRuntimeAuthority,
  type ConversationProductCanonicalTransactionRunner,
  type CryptoPostgresHandle,
  type CurrentTaskRuntimeAuthority,
  type TaskRuntimeAuthoritySubject,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import {
  assertProtectedTaskJobReferenceV1,
  isCurrentProtectedTaskRunForGrant,
  PostgresBackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskJobReferenceV1,
  type ProtectedTaskRunningOccurrence,
} from "@nautilo/runtime";

import {
  acceptedTaskRuntimeRecord,
  destroyAcceptedTaskRuntimeRecord,
  loadCurrentProtectedTaskRuntimeLifecycleFacts,
  loadCurrentProtectedTaskRuntimeRequesterRoomFacts,
  type CurrentProtectedTaskRuntimeLifecycleFacts,
} from "./task-runtime-current-authority";

export type ProtectedTaskMemoryAuthorityInput = Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  subject: TaskRuntimeAuthoritySubject;
  occurrence: ProtectedTaskRunningOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  evidence: TaskRuntimeExecutionEvidence;
  jobId: string;
  executionRoomId: string;
  /** Fixed preclaim Scope inventory and resolved output, never inferred from execution Room. */
  scopeMemory?: Readonly<{
    binding: TaskScopeMemoryBinding;
    targetRoomId: string;
    workIdentity: string;
  }>;
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
  product: PostgresJsBridgeConnection;
  transaction: CanonicalTranscriptTx;
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
    occurrence.run.status !== "running"
    || typeof occurrence.run.jobId !== "string"
    || occurrence.run.jobId.length === 0
    || reference.taskId !== occurrence.task.id
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
    || typeof input.jobId !== "string"
    || input.jobId.length === 0
    || input.jobId !== occurrence.run.jobId
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

function scopeWorkIdentityMatches(input: ProtectedTaskMemoryAuthorityInput): boolean {
  const scope = input.scopeMemory;
  if (scope === undefined) return true;
  if (typeof scope.workIdentity !== "string") return false;
  const digest = createHash("sha256").update(scope.workIdentity).digest();
  if (!sameBytes(digest, input.record.workIdentityHash)) return false;
  try {
    const identity = JSON.parse(scope.workIdentity) as Record<string, unknown>;
    const binding = copyTaskScopeMemoryBinding(identity["scopeMemory"] as TaskScopeMemoryBinding);
    return identity["taskId"] === input.occurrence.task.id
      && identity["taskRunId"] === input.occurrence.run.id
      && identity["targetRoomId"] === scope.targetRoomId
      && binding.scopeId === scope.binding.scopeId
      && binding.memoryRoomId === scope.binding.memoryRoomId
      && binding.originWritableNamespaceId === scope.binding.originWritableNamespaceId
      && binding.readableNamespaceIds.length === scope.binding.readableNamespaceIds.length
      && binding.readableNamespaceIds.every((id, index) =>
        id === scope.binding.readableNamespaceIds[index]);
  } catch { return false; }
}

/**
 * Hold current Task Memory authority in the established lock order: global
 * policy; Task, Run and Job; accepted-owner policy and Namespace locks; exact
 * Task/source facts; request claim; then device/group, Namespace and Domain
 * authority. The callback must do only bounded database/crypto publication
 * work with an already-prepared payload.
 */
async function withCurrentProtectedTaskMemoryAuthorityTransaction<Value>(
  input: ProtectedTaskMemoryAuthorityInput,
  use: (held: HeldProtectedTaskMemoryAuthority) => Promise<Value>,
  isolationLevel: "read committed" | "serializable",
): Promise<Value | null> {
  if (input.runner.role !== "nautilo") {
    throw new TypeError(
      "Task Memory publication requires the complete product role",
    );
  }
  if (input.scopeMemory !== undefined) {
    input = Object.freeze({ ...input, scopeMemory: Object.freeze({
      binding: copyTaskScopeMemoryBinding(input.scopeMemory.binding),
      targetRoomId: input.scopeMemory.targetRoomId,
      workIdentity: input.scopeMemory.workIdentity,
    }) });
  }
  assertInputBinding(input, input.now());
  if (!scopeWorkIdentityMatches(input)) return null;
  const accepted = acceptedTaskRuntimeRecord(input.record);
  if (accepted === null) return null;
  try {
    try {
      assertInputBinding(input, input.now(), accepted.authorizationExpiresAt);
      return await input.runner.transaction(async (tx, executor) => {
        const policy = await acquireEncryptionConsumptionFence(tx);
        if (policy.mode === "plaintext_only"
          || policy.revision !== input.evidence.policyRevision) return null;

        const [task] = await tx.select({
          id: tasks.id,
          useScope: tasks.useScope,
          scopeId: tasks.scopeId,
          targetChat: tasks.targetChat,
          targetRoomId: tasks.targetRoomId,
        }).from(tasks)
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

        const scopeMemory = input.scopeMemory?.binding;
        if (task.useScope === true && scopeMemory === undefined) return null;
        if (scopeMemory !== undefined && (
          task.useScope !== true || task.scopeId !== scopeMemory.scopeId
          || task.targetRoomId !== input.scopeMemory?.targetRoomId
          || scopeMemory.memoryRoomId !== (task.targetChat === "orphan"
            ? input.request.sourceRoomId : task.targetRoomId)
          || scopeMemory.readableNamespaceIds.some(namespaceId =>
            !input.evidence.namespaceRequirements.some(requirement =>
              requirement.namespaceId === namespaceId
              && requirement.operations.includes("decrypt")))
          || !input.evidence.namespaceRequirements.some(requirement =>
            requirement.namespaceId === scopeMemory.originWritableNamespaceId
            && requirement.operations.includes("encrypt"))
        )) return null;

        const product = connection(executor);
        const productHandle = await verifyConversationProductPostgresHandle(
          product,
        );
        const productRunner = bindConversationProductCanonicalTransactionRunner(
          productHandle,
          { transaction: callback => callback(tx, executor) },
        );
        let lifecycle: CurrentProtectedTaskRuntimeLifecycleFacts | null = null;
        const restricted: PostgresJsBridgeConnection = {
          query: input.restricted.query.bind(input.restricted),
          transaction: input.restricted.transaction.bind(input.restricted),
          transactionOnce: async callback => {
            const currentLifecycle = lifecycle;
            if (currentLifecycle === null) {
              throw new TaskMemoryAuthorityUnavailable();
            }
            const room = await loadCurrentProtectedTaskRuntimeRequesterRoomFacts({
              product,
              task: currentLifecycle.task,
            });
            if (room === null || !isCurrentProtectedTaskRunForGrant({
              occurrence: input.occurrence,
              task: currentLifecycle.task,
              run: currentLifecycle.run,
              requestorUserId: input.subject.userId,
              requestWorkId: input.request.workId,
              sourceRoomId: input.request.sourceRoomId,
              requesterPrivateRoom: room.requesterPrivateRoom,
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
          validateCurrentProduct: async currentProduct => {
            lifecycle = await loadCurrentProtectedTaskRuntimeLifecycleFacts({
              product: currentProduct,
              occurrence: input.occurrence,
            });
            return lifecycle !== null;
          },
          use: async (currentRuntime, _product, currentRestricted) => {
            if (scopeMemory !== undefined) {
              // Canonical Namespace locks precede this Room fence. Do not take
              // Scope SHARE here: the nested Agent publisher owns Scope UPDATE.
              const [memoryRoom] = await tx.select({
                namespaceId: rooms.namespaceId,
                archivedAt: rooms.archivedAt,
              }).from(rooms).where(eq(rooms.id, scopeMemory.memoryRoomId))
                .limit(1).for("share");
              if (memoryRoom === undefined || memoryRoom.archivedAt !== null
                || memoryRoom.namespaceId
                  !== scopeMemory.originWritableNamespaceId) return null;
            }
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
              product,
              transaction: tx,
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
      }, { isolationLevel });
    } catch (error) {
      if (error instanceof TaskMemoryAuthorityUnavailable) return null;
      throw error;
    }
  } finally {
    destroyAcceptedTaskRuntimeRecord(accepted);
  }
}

export function withCurrentProtectedTaskMemoryAuthority<Value>(
  input: ProtectedTaskMemoryAuthorityInput,
  use: (held: HeldProtectedTaskMemoryAuthority) => Promise<Value>,
): Promise<Value | null> {
  return withCurrentProtectedTaskMemoryAuthorityTransaction(
    input,
    use,
    "read committed",
  );
}

/** Resolve legacy provenance for the exact repair candidate under the live Task
 * owner. This records authority only; mapping/body repair happens afterwards. */
export async function adoptProtectedTaskScopeMemoryOrigin(
  input: ProtectedTaskMemoryAuthorityInput,
  memoryId: string,
): Promise<TaskScopeMemoryOriginAdoptionResult> {
  if (input.scopeMemory === undefined) return "stale";
  const scopeMemory = Object.freeze({
    binding: copyTaskScopeMemoryBinding(input.scopeMemory.binding),
    targetRoomId: input.scopeMemory.targetRoomId,
      workIdentity: input.scopeMemory.workIdentity,
  });
  const scope = scopeMemory.binding;
  const result = await withCurrentProtectedTaskMemoryAuthority(
    Object.freeze({ ...input, scopeMemory }),
    async held => {
      await held.assertCurrent();
      const state = stateFor(held);
      const outcome = await adoptLegacyTaskScopeMemoryOrigin({
        transaction: state.product,
        memoryId,
        coordinates: {
          taskId: state.input.occurrence.task.id,
          requesterUserId: state.input.subject.userId,
          agentId: state.input.occurrence.task.agentId,
          scopeId: scope.scopeId,
          memoryRoomId: scope.memoryRoomId,
          originWritableNamespaceId: scope.originWritableNamespaceId,
        },
      });
      await held.assertCurrent();
      return outcome;
    },
  );
  return result ?? "stale";
}

/** The repair owns Scope SHARE on the same product transaction; it never nests
 * the Agent publisher. Provider/crypto work must run after this callback exits. */
async function withCurrentTaskScopeRepair<Value>(
  input: ProtectedTaskMemoryAuthorityInput,
  use: (state: HeldState, scope: TaskScopeMemoryBinding) => Promise<Value>,
): Promise<Value | null> {
  if (input.scopeMemory === undefined) return null;
  return withCurrentProtectedTaskMemoryAuthority(input, async held => {
    const state = stateFor(held);
    const scope = state.input.scopeMemory?.binding;
    if (held.policy.mode !== "shadow_encryption" || scope === undefined) return null;
    const rows = await executeTypedConversationProductQuery(state.product,
      conversationProductTypedDb.select({ id: agentScopes.id })
        .from(agentScopes).where(and(
          eq(agentScopes.id, scope.scopeId),
          eq(agentScopes.parentAgentId, state.input.occurrence.task.agentId),
          eq(agentScopes.speakerUserId, state.input.subject.userId),
          eq(agentScopes.lifecycleState, "open"),
        )).limit(1).for("share"));
    if (rows.length !== 1 || rows[0]?.id !== scope.scopeId) return null;
    await held.assertCurrent();
    const value = await use(state, scope);
    await held.assertCurrent();
    return value;
  });
}

function canonicalIds(ids: readonly string[]): readonly string[] | null {
  const sorted = [...new Set(ids)].sort();
  return sorted.length === ids.length
      && sorted.every((id, index) => id === ids[index])
    ? sorted
    : null;
}

function currentTaskOrdinaryFallbackAuthority(
  state: HeldState,
  authority: ProtectedMemoryAuthority,
): boolean {
  if (authority.subjectUserId !== state.input.subject.userId
    || authority.agentId !== state.input.occurrence.task.agentId) return false;
  const requirements = new Map<string, readonly ("decrypt" | "encrypt")[]>();
  for (const requirement of state.input.evidence.namespaceRequirements) {
    if (requirements.has(requirement.namespaceId)) return false;
    requirements.set(requirement.namespaceId, requirement.operations);
  }
  const has = (namespaceId: string, operation: "decrypt" | "encrypt") =>
    requirements.get(namespaceId)?.includes(operation) === true;
  if (authority.mode === "scope") {
    const scope = state.input.scopeMemory?.binding;
    return scope !== undefined
      && scope.scopeId === authority.scopeId
      && scope.originWritableNamespaceId
        === authority.originWritableNamespaceId
      && scope.readableNamespaceIds.every(id => has(id, "decrypt"))
      && has(authority.originWritableNamespaceId, "encrypt");
  }
  return state.input.scopeMemory === undefined
    && canonicalIds(authority.readableNamespaceIds) !== null
    && canonicalIds(authority.mutableNamespaceIds) !== null
    && authority.mutableNamespaceIds.every(id =>
      authority.readableNamespaceIds.includes(id)
      && has(id, "decrypt")
      && has(id, "encrypt"))
    && authority.readableNamespaceIds.every(id => has(id, "decrypt"))
    && (authority.writableNamespaceId === null
      || (authority.mutableNamespaceIds.includes(authority.writableNamespaceId)
        && has(authority.writableNamespaceId, "encrypt")));
}

/**
 * Run the exact ordinary Shadow fallback on the already-held product
 * transaction. This role owns both the semantic Memory rows and the crypto
 * lifecycle receipt, so the two outcomes commit or roll back together.
 */
export async function withCurrentProtectedTaskMemoryOrdinaryFallback<Value>(
  input: ProtectedTaskMemoryAuthorityInput,
  authority: ProtectedMemoryAuthority,
  use: (transaction: CanonicalTranscriptTx) => Promise<Value>,
): Promise<Value | null> {
  return withCurrentProtectedTaskMemoryAuthorityTransaction(input, async held => {
    const state = stateFor(held);
    if (held.policy.mode !== "shadow_encryption"
      || held.policy.shadowBehavior !== "fallback"
      || !currentTaskOrdinaryFallbackAuthority(state, authority)) return null;
    await held.assertCurrent();
    const value = await use(state.transaction);
    await held.assertCurrent();
    return value;
  }, "serializable");
}

function currentTaskNamespaceRepairAuthority(
  state: HeldState,
  authority: ProtectedMemoryAuthority,
  sourceNamespaceIds?: readonly string[],
): authority is Extract<ProtectedMemoryAuthority, { mode: "namespace" }> {
  if (state.input.scopeMemory !== undefined
    || authority.mode !== "namespace"
    || authority.subjectUserId !== state.input.subject.userId
    || authority.agentId !== state.input.occurrence.task.agentId
    || canonicalIds(authority.readableNamespaceIds) === null
    || canonicalIds(authority.mutableNamespaceIds) === null
    || (authority.writableNamespaceId !== null
      && (!authority.readableNamespaceIds.includes(authority.writableNamespaceId)
        || !authority.mutableNamespaceIds.includes(
          authority.writableNamespaceId,
        )))) {
    return false;
  }
  if (sourceNamespaceIds === undefined) return true;
  const sourceIds = canonicalIds(sourceNamespaceIds);
  return sourceIds !== null
    && sourceIds.length > 0
    && sourceIds.every(namespaceId =>
      authority.mutableNamespaceIds.includes(namespaceId)
      && state.authority.namespaceRequirements.some(requirement =>
        requirement.namespaceId === namespaceId
        && requirement.operations.includes("encrypt")));
}

/** Hold live Namespace/Wide authority around one bounded repair database step. */
async function withCurrentTaskNamespaceRepair<Value>(
  input: ProtectedTaskMemoryAuthorityInput,
  authority: ProtectedMemoryAuthority,
  use: (state: HeldState) => Promise<Value>,
): Promise<Value | null> {
  if (input.scopeMemory !== undefined) return null;
  return withCurrentProtectedTaskMemoryAuthority(input, async held => {
    const state = stateFor(held);
    if (held.policy.mode !== "shadow_encryption"
      || !currentTaskNamespaceRepairAuthority(state, authority)) return null;
    await held.assertCurrent();
    const value = await use(state);
    await held.assertCurrent();
    return value;
  });
}

export async function reserveProtectedTaskNamespaceMemoryRepair(
  input: ProtectedTaskMemoryAuthorityInput,
  authority: ProtectedMemoryAuthority,
  selection: ProtectedMemorySaveCandidateSelection,
): Promise<TaskNamespaceMemoryRepairSource | null> {
  if (selection.memoryId !== selection.repair.id) return null;
  const selected = Object.freeze({ ...selection, repair: Object.freeze({
    ...selection.repair, createdAt: new Date(selection.repair.createdAt),
  }) });
  let reserved: TaskNamespaceMemoryRepairSource | null = null;
  let delivered = false;
  try {
    const result = await withCurrentTaskNamespaceRepair(
      input,
      authority,
      async state => {
        reserved = await reservePostgresTaskNamespaceMemoryRepairSource({
          transaction: state.product,
          crypto: state.input.crypto,
          selection: selected.repair,
          expectedContentRevision: selected.contentRevision,
        });
        if (!currentTaskNamespaceRepairAuthority(
          state,
          authority,
          reserved.accessNamespaceIds,
        )) throw new TaskMemoryAuthorityUnavailable();
        return reserved;
      },
    );
    delivered = result !== null;
    return result;
  } catch (error) {
    if (isForegroundProductChangedError(error)
      || error instanceof TaskMemoryAuthorityUnavailable) return null;
    throw error;
  } finally {
    if (!delivered) {
      const retained = reserved as TaskNamespaceMemoryRepairSource | null;
      retained?.plaintextBytes?.fill(0);
      retained?.requestCommitment.fill(0);
    }
  }
}

export async function attachProtectedTaskNamespaceMemoryRepair(
  input: ProtectedTaskMemoryAuthorityInput,
  authority: ProtectedMemoryAuthority,
  source: TaskNamespaceMemoryRepairSource,
  objectId: string,
): Promise<"attached" | "replayed" | "conflict" | null> {
  try {
    return await withCurrentTaskNamespaceRepair(input, authority, state => {
      if (!currentTaskNamespaceRepairAuthority(
        state,
        authority,
        source.accessNamespaceIds,
      )) return Promise.resolve("conflict" as const);
      return attachPostgresTaskNamespaceMemoryRepair({
        transaction: state.product,
        source,
        objectId,
        requestCommitment: source.requestCommitment,
      });
    });
  } catch (error) {
    if (isForegroundProductChangedError(error)) return "conflict";
    if (error instanceof TaskMemoryAuthorityUnavailable) return null;
    throw error;
  }
}

export async function reserveProtectedTaskScopeMemoryRepair(
  input: ProtectedTaskMemoryAuthorityInput,
  selection: ProtectedMemorySaveCandidateSelection,
): Promise<TaskScopeMemoryRepairSource | null> {
  if (selection.memoryId !== selection.repair.id) return null;
  const selected = Object.freeze({ ...selection, repair: Object.freeze({
    ...selection.repair, createdAt: new Date(selection.repair.createdAt),
  }) });
  let reserved: TaskScopeMemoryRepairSource | null = null;
  let delivered = false;
  try {
    const result = await withCurrentTaskScopeRepair(input, async (state, scope) => {
      reserved = await reservePostgresTaskScopeMemoryRepairSource({
        transaction: state.product,
        crypto: state.input.crypto,
        selection: selected.repair,
        expectedContentRevision: selected.contentRevision,
        scopeId: scope.scopeId,
        expectedScopeOriginNamespaceId: scope.originWritableNamespaceId,
      });
      return reserved;
    });
    delivered = result !== null;
    return result;
  } catch (error) {
    if (isForegroundProductChangedError(error)
      || error instanceof TaskMemoryAuthorityUnavailable) return null;
    throw error;
  } finally {
    if (!delivered) {
      const retained = reserved as TaskScopeMemoryRepairSource | null;
      retained?.source.plaintextBytes?.fill(0);
      retained?.source.requestCommitment.fill(0);
    }
  }
}

export async function attachProtectedTaskScopeMemoryRepair(
  input: ProtectedTaskMemoryAuthorityInput,
  source: TaskScopeMemoryRepairSource,
  objectId: string,
): Promise<"attached" | "replayed" | "conflict" | null> {
  try {
    return await withCurrentTaskScopeRepair(input, (state, scope) => {
      if (source.scopeId !== scope.scopeId
        || source.expectedScopeOriginNamespaceId !== scope.originWritableNamespaceId) {
        return Promise.resolve("conflict" as const);
      }
      return attachPostgresTaskScopeMemoryRepair({
        transaction: state.product,
        source,
        objectId,
        requestCommitment: source.source.requestCommitment,
      });
    });
  } catch (error) {
    // Mutation failures are normalized only after the outer transaction has
    // unwound. A caught inner CAS failure must never commit a partial mapping.
    if (isForegroundProductChangedError(error)) return "conflict";
    if (error instanceof TaskMemoryAuthorityUnavailable) return null;
    throw error;
  }
}
