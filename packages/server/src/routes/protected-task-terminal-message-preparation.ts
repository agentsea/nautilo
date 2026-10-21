import {
  createPostgresJsBridgeConnection, eq, getEncryptionTransitionPolicy,
  getSharedDirectCryptoDb, PROTECTED_TASK_CANCELLED_RESULT, taskRuns,
  type DirectDatabase, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  encodeMessagePayloadV2, type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import {
  type CryptoPostgresHandle,
  withTaskDeliveryNamespaceAuthority,
  withUnstagedTaskTerminalMessagePublication,
} from "@nautilo/lattice-bridge/server";
import { LatticeCrypto, type TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  advanceBackgroundAuthorizationGeneration,
  buildUnclaimedTaskTerminalMessageAuthorityReplacement,
  PostgresBackgroundAuthorizationRepository,
  sameBackgroundAuthorizationRecord, sameTaskRuntimeAuthorityPlan,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskTerminalMessageReplacementRepository,
} from "@nautilo/runtime";
import { findActorByOwnerId } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import {
  lockExactProtectedTaskTerminalMessageAllocation,
  type LockedProtectedTaskTerminalMessageAllocation,
} from "./protected-task-terminal-message-allocation";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";
import {
  createProtectedTaskTerminalMessagePlan,
  protectedTaskTerminalMessageRequestId,
  type ProtectedTaskTerminalMessagePlan,
} from "./protected-task-terminal-message-plan";
import {
  readProtectedTaskTerminalMessageIntent,
  refreshUnstagedProtectedTaskTerminalMessagePolicy,
  resolveProtectedTaskTerminalMessageDestination,
  sameProtectedTaskTerminalMessageIntent,
  type ProtectedTaskTerminalMessageIntent,
} from "./protected-task-terminal-message-product";
import { withProtectedTaskTerminalMessageProductStore } from
  "./protected-task-terminal-message-store";
import {
  notifyProtectedTaskAuthorizationRequestedAfterCommit,
  type ProtectedTaskAuthorizationRequested,
} from "./protected-task-authorization-requested";

export type ProtectedTaskTerminalMessagePreparationResult =
  | Readonly<{
    status: "created" | "exact_replay";
    plan: ProtectedTaskTerminalMessagePlan;
  }>
  | Readonly<{ status: "inactive" | "not_ready" | "conflict" }>;

export type ProtectedTaskTerminalMessagePreparation = Readonly<{
  prepare(input: Readonly<{ taskId: string; taskRunId: string }>):
    Promise<ProtectedTaskTerminalMessagePreparationResult>;
  resolvePlan(record: BackgroundAuthorizationTaskRuntimeRecordV3):
    Promise<ProtectedTaskTerminalMessagePlan | null>;
}>;

type Repository = BackgroundAuthorizationTaskTerminalMessageReplacementRepository;

type Dependencies = Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  serverScope: string;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  recipientTtlMs: number;
  now(): number;
  restricted(): PostgresJsBridgeConnection;
  readPolicy: typeof getEncryptionTransitionPolicy;
  readIntent: typeof readProtectedTaskTerminalMessageIntent;
  resolveDestination: typeof resolveProtectedTaskTerminalMessageDestination;
  refreshPolicy: typeof refreshUnstagedProtectedTaskTerminalMessagePolicy;
  withDeliveryAuthority: typeof withTaskDeliveryNamespaceAuthority;
  withUnstagedPublication: typeof withUnstagedTaskTerminalMessagePublication;
  withProductStore: typeof withProtectedTaskTerminalMessageProductStore;
  resolveRequesterHuman(userId: string): Promise<Readonly<{ id: string }> | null>;
  resolveRequesterPrivateRoom: ProtectedTaskRequesterPrivateRoomResolver;
  productContext: typeof createHumanProductTransactionContext;
  repository(handle: CryptoPostgresHandle): Repository;
  lockAllocation: typeof lockExactProtectedTaskTerminalMessageAllocation;
  readTaskId(taskRunId: string): Promise<string | null>;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function terminalRecord(
  record: BackgroundAuthorizationRecord,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.workKind === "task.deliver_message"
    && record.purpose === "task.deliver_message";
}

function exactPlan(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  plan: ProtectedTaskTerminalMessagePlan,
): boolean {
  return terminalRecord(record)
    && record.snapshot.requestId === plan.initialRecord.snapshot.requestId
    && record.snapshot.workId === plan.intent.taskRunId
    && record.idempotencyKey === plan.initialRecord.idempotencyKey
    && sameTaskRuntimeAuthorityPlan(record, plan.initialRecord);
}

function allocationPlan(
  locked: LockedProtectedTaskTerminalMessageAllocation,
  publicationPolicyRevision: number,
) {
  return Object.freeze({
    sessionId: locked.lifecycle.sessionId,
    messageId: locked.lifecycle.messageId,
    revision: 0 as const,
    objectId: locked.lifecycle.cryptoObjectId,
    createdAt: locked.createdAt,
    publicationPolicyRevision,
  });
}

/** Prepare one fixed terminal Message allocation and its fresh encrypt-only request. */
export function createProtectedTaskTerminalMessagePreparation(
  input: Readonly<{
    db?: DirectDatabase;
    crypto?: LatticeCrypto;
    owner: EncryptionDataOperationOwner;
    serverScope?: string;
    recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
    recipientTtlMs: number;
    now?: () => number;
    restricted?: () => PostgresJsBridgeConnection;
    authorizationRequested?: ProtectedTaskAuthorizationRequested | undefined;
  }>,
  overrides: Partial<Dependencies> = {},
): ProtectedTaskTerminalMessagePreparation {
  const db = overrides.db ?? input.db ?? getServerDirectDb();
  const crypto = overrides.crypto ?? input.crypto ?? new LatticeCrypto();
  const restricted = overrides.restricted ?? input.restricted
    ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const authorizationRequested = input.authorizationRequested;
  const dependencies: Dependencies = {
    db, crypto, owner: overrides.owner ?? input.owner,
    serverScope: overrides.serverScope ?? input.serverScope
      ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim()
        || "http://localhost:3001"),
    recipients: overrides.recipients ?? input.recipients,
    recipientTtlMs: overrides.recipientTtlMs ?? input.recipientTtlMs,
    now: overrides.now ?? input.now ?? Date.now,
    restricted,
    readPolicy: overrides.readPolicy ?? getEncryptionTransitionPolicy,
    readIntent: overrides.readIntent ?? readProtectedTaskTerminalMessageIntent,
    resolveDestination: overrides.resolveDestination
      ?? resolveProtectedTaskTerminalMessageDestination,
    refreshPolicy: overrides.refreshPolicy
      ?? refreshUnstagedProtectedTaskTerminalMessagePolicy,
    withDeliveryAuthority: overrides.withDeliveryAuthority
      ?? withTaskDeliveryNamespaceAuthority,
    withUnstagedPublication: overrides.withUnstagedPublication
      ?? withUnstagedTaskTerminalMessagePublication,
    withProductStore: overrides.withProductStore
      ?? withProtectedTaskTerminalMessageProductStore,
    resolveRequesterHuman: overrides.resolveRequesterHuman ?? findActorByOwnerId,
    resolveRequesterPrivateRoom: overrides.resolveRequesterPrivateRoom
      ?? createProtectedTaskRequesterPrivateRoomResolver(db),
    productContext: overrides.productContext
      ?? createHumanProductTransactionContext,
    repository: overrides.repository
      ?? (handle => new PostgresBackgroundAuthorizationRepository(handle)),
    lockAllocation: overrides.lockAllocation
      ?? lockExactProtectedTaskTerminalMessageAllocation,
    readTaskId: overrides.readTaskId ?? (async taskRunId => {
      const rows = await db.select({ taskId: taskRuns.taskId }).from(taskRuns)
        .where(eq(taskRuns.id, taskRunId)).limit(2);
      return rows.length === 1 ? rows[0]!.taskId : null;
    }),
  };

  async function detachedIntent(coordinates: Readonly<{
    taskId: string;
    taskRunId: string;
  }>): Promise<ProtectedTaskTerminalMessageIntent | null> {
    return dependencies.db.transaction(transaction =>
      dependencies.readIntent(transaction, coordinates));
  }

  async function prepareSelected(
    coordinates: Readonly<{ taskId: string; taskRunId: string }>,
    representation: "protected" | "dual",
    allowAllocate: boolean,
    supplied?: BackgroundAuthorizationTaskRuntimeRecordV3,
  ): Promise<ProtectedTaskTerminalMessagePreparationResult> {
    const [initialIntent, initialPolicy] = await Promise.all([
      detachedIntent(coordinates),
      dependencies.readPolicy(dependencies.db),
    ]);
    if (initialIntent === null) {
      return Object.freeze({ status: "not_ready" as const });
    }
    const expectedMode = representation === "protected"
      ? "encrypted_only" : "shadow_encryption";
    if (initialIntent.representation !== representation
      || initialPolicy.mode !== expectedMode
      || initialPolicy.revision < initialIntent.acceptedPolicyRevision) {
      return Object.freeze({ status: "conflict" as const });
    }
    const [initialHuman, initialRoom] = await Promise.all([
      dependencies.resolveRequesterHuman(initialIntent.requesterUserId),
      dependencies.resolveRequesterPrivateRoom(
        initialIntent.requesterUserId, initialIntent.agentId,
        initialIntent.contentNamespaceId,
      ),
    ]);
    if (initialHuman === null || initialRoom === null
      || initialRoom.namespaceId !== initialIntent.contentNamespaceId) {
      return Object.freeze({ status: "not_ready" as const });
    }

    // Phase one owns only the product allocation. It must commit before any
    // durable crypto request can refer to its sequence-derived Message ID.
    const initialContext = await dependencies.productContext(
      initialIntent.requesterUserId, dependencies.db,
    );
    const allocated = await dependencies.withDeliveryAuthority({
      runner: initialContext.canonicalRunner,
      restricted: dependencies.restricted(),
      crypto: dependencies.crypto,
      serverScope: dependencies.serverScope,
      taskId: initialIntent.taskId,
      requesterUserId: initialIntent.requesterUserId,
      requesterHumanId: initialHuman.id,
      agentId: initialIntent.agentId,
      contentNamespaceId: initialIntent.contentNamespaceId,
      sourceRoomId: initialRoom.roomId,
      destinationRoomId: initialIntent.destinationRoomId,
      destinationNamespaceId: initialIntent.destinationNamespaceId,
      expectedPolicyRevision: initialPolicy.revision,
      validateCurrentTaskRun: async (_product, transaction) => {
        const current = await dependencies.readIntent(transaction, coordinates);
        return current !== null
          && sameProtectedTaskTerminalMessageIntent(initialIntent, current);
      },
      use: async (_namespaceAuthority, product, transaction) => {
        const current = await dependencies.readIntent(transaction, coordinates);
        if (current === null
          || !sameProtectedTaskTerminalMessageIntent(initialIntent, current)) {
          return Object.freeze({ status: "not_ready" as const });
        }
        const destination = await dependencies.resolveDestination(transaction, current);
        if (destination === null) {
          return Object.freeze({ status: "not_ready" as const });
        }
        const encoded = encodeMessagePayloadV2({
          role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT,
        });
        const digest = dependencies.crypto.hash(encoded);
        try {
          return await dependencies.withProductStore({
            product, transaction, intent: current, destination,
            publicationPolicyRevision: initialPolicy.revision,
            use: async store => {
              let locked = await dependencies.lockAllocation({
                transaction, intent: current, sessionId: destination.sessionId,
                expectedPayloadDigest: digest, phase: "staged_or_mapped",
              });
              if (locked === null) {
                if (!allowAllocate) {
                  return Object.freeze({ status: "not_ready" as const });
                }
                const allocated = await store.appendAllocated({
                  sessionId: destination.sessionId,
                  idempotencyKey: current.messageOperationId,
                  content: representation === "protected"
                    ? null : PROTECTED_TASK_CANCELLED_RESULT,
                  publicationPolicy: {
                    expectedRevision: initialPolicy.revision,
                    representation: representation === "protected"
                      ? "protected_only" : "ordinary_and_protected",
                  },
                  keyClass: "ai", authorRole: "assistant",
                  toolCalls: null, toolName: null, fingerprint: null,
                  humanTurnId: null, transcriptOrigin: "subagent",
                  parentThreadId: null, scopeId: null, metadata: null,
                  subthreadRoomId: null, replyToMessageId: null,
                  notificationContext: {
                    mentionedHumanUserIds: Object.freeze([]),
                    causalHumanUserId: null, causalHumanTurnId: null,
                  },
                  structuralProjection: {
                    notificationEligibility: "excluded",
                    subthreadReplyClassification: "excluded",
                  },
                  requestDigest: digest,
                });
                if (allocated.status === "conflict") {
                  return Object.freeze({ status: "conflict" as const });
                }
                locked = await dependencies.lockAllocation({
                  transaction, intent: current,
                  sessionId: destination.sessionId,
                  expectedPayloadDigest: digest, phase: "pristine",
                });
                if (locked === null
                  || allocated.lifecycle.sessionId !== locked.lifecycle.sessionId
                  || allocated.lifecycle.messageId !== locked.lifecycle.messageId
                  || allocated.lifecycle.cryptoObjectId
                    !== locked.lifecycle.cryptoObjectId
                  || !sameBytes(
                    locked.lifecycle.allocationRequestDigest, digest,
                  )) return Object.freeze({ status: "conflict" as const });
              }
              if (locked.lifecycle.completion !== "pending"
                || locked.lifecycle.disposition !== "active") {
                return Object.freeze({ status: "not_ready" as const });
              }
              return Object.freeze({ status: "durable" as const, locked });
            },
          });
        } finally {
          encoded.fill(0);
          digest.fill(0);
        }
      },
    });
    if (allocated === null || allocated.status !== "durable") {
      return allocated ?? Object.freeze({ status: "not_ready" as const });
    }

    // Phase two reacquires current Task, destination, policy and allocation
    // authority. Only this phase may create or rotate the crypto request.
    const [intent, policy] = await Promise.all([
      detachedIntent(coordinates),
      dependencies.readPolicy(dependencies.db),
    ]);
    if (intent === null
      || !sameProtectedTaskTerminalMessageIntent(initialIntent, intent)) {
      return Object.freeze({ status: "not_ready" as const });
    }
    if (intent.representation !== representation || policy.mode !== expectedMode
      || policy.revision < intent.acceptedPolicyRevision) {
      return Object.freeze({ status: "conflict" as const });
    }
    const [human, room] = await Promise.all([
      dependencies.resolveRequesterHuman(intent.requesterUserId),
      dependencies.resolveRequesterPrivateRoom(
        intent.requesterUserId, intent.agentId, intent.contentNamespaceId,
      ),
    ]);
    if (human === null || room === null
      || room.namespaceId !== intent.contentNamespaceId) {
      return Object.freeze({ status: "not_ready" as const });
    }
    const productContext = await dependencies.productContext(
      intent.requesterUserId, dependencies.db,
    );
    const cleanup: Array<readonly [string, number]> = [];
    let authorizationChanged = false;
    const held = await dependencies.withDeliveryAuthority({
      runner: productContext.canonicalRunner,
      restricted: dependencies.restricted(),
      crypto: dependencies.crypto,
      serverScope: dependencies.serverScope,
      taskId: intent.taskId,
      requesterUserId: intent.requesterUserId,
      requesterHumanId: human.id,
      agentId: intent.agentId,
      contentNamespaceId: intent.contentNamespaceId,
      sourceRoomId: room.roomId,
      destinationRoomId: intent.destinationRoomId,
      destinationNamespaceId: intent.destinationNamespaceId,
      expectedPolicyRevision: policy.revision,
      validateCurrentTaskRun: async (_product, transaction) => {
        const current = await dependencies.readIntent(transaction, coordinates);
        return current !== null
          && sameProtectedTaskTerminalMessageIntent(intent, current);
      },
      use: async (namespaceAuthority, product, transaction, scoped) => {
        const current = await dependencies.readIntent(transaction, coordinates);
        if (current === null
          || !sameProtectedTaskTerminalMessageIntent(intent, current)) {
          return Object.freeze({ status: "not_ready" as const });
        }
        const destination = await dependencies.resolveDestination(transaction, current);
        if (destination === null
          || destination.sessionId !== allocated.locked.lifecycle.sessionId) {
          return Object.freeze({ status: "conflict" as const });
        }
        const encoded = encodeMessagePayloadV2({
          role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT,
        });
        const digest = dependencies.crypto.hash(encoded);
        try {
          return await dependencies.withProductStore({
            product, transaction, intent: current, destination,
            publicationPolicyRevision: policy.revision,
            use: async () => {
              let locked = await dependencies.lockAllocation({
                transaction, intent: current, sessionId: destination.sessionId,
                expectedPayloadDigest: digest, phase: "pristine",
                expected: {
                  messageId: allocated.locked.lifecycle.messageId,
                  revision: 0,
                  objectId: allocated.locked.lifecycle.cryptoObjectId,
                  createdAt: allocated.locked.createdAt,
                  publicationPolicyRevision:
                    allocated.locked.lifecycle.publicationPolicyRevision
                      ?? policy.revision,
                },
              });
              if (locked === null) {
                return Object.freeze({ status: "conflict" as const });
              }
              const requestId = protectedTaskTerminalMessageRequestId(current.taskRunId);
              const unstaged = await dependencies.withUnstagedPublication({
                restricted: scoped, requestId,
                objectId: locked.lifecycle.cryptoObjectId,
                use: async (handle, unstagedAuthority) => {
                  const repository = dependencies.repository(handle);
                  const existing = await repository.get(requestId);
                  if (existing !== null && !terminalRecord(existing)) {
                    return Object.freeze({ status: "conflict" as const });
                  }
                  if (representation === "protected"
                    && locked!.lifecycle.publicationPolicyRevision
                      !== policy.revision) {
                    if (existing !== null
                      && (existing.snapshot.state === "claimed"
                        || existing.snapshot.state === "running")
                      && (existing.snapshot.claimExpiresAt === null
                        || dependencies.now()
                          < existing.snapshot.claimExpiresAt)) {
                      return Object.freeze({ status: "conflict" as const });
                    }
                    const previousPolicy = locked!.lifecycle
                      .publicationPolicyRevision;
                    if (previousPolicy === null
                      || previousPolicy > policy.revision) {
                      return Object.freeze({ status: "conflict" as const });
                    }
                    const refreshed = await dependencies.refreshPolicy({
                      transaction, intent: current,
                      sessionId: locked!.lifecycle.sessionId,
                      messageId: locked!.lifecycle.messageId,
                      objectId: locked!.lifecycle.cryptoObjectId,
                      createdAt: locked!.createdAt,
                      allocationRequestDigest:
                        locked!.lifecycle.allocationRequestDigest,
                      expectedPolicyRevision: previousPolicy,
                      nextPolicyRevision: policy.revision,
                      unstagedAuthority,
                    });
                    if (refreshed === "conflict") {
                      return Object.freeze({ status: "conflict" as const });
                    }
                    locked = await dependencies.lockAllocation(
                      { transaction, intent: current,
                        sessionId: destination.sessionId,
                        expectedPayloadDigest: digest, phase: "pristine",
                        expected: {
                          messageId: allocated.locked.lifecycle.messageId,
                          revision: 0,
                          objectId: allocated.locked.lifecycle.cryptoObjectId,
                          createdAt: allocated.locked.createdAt,
                          publicationPolicyRevision: policy.revision,
                        } },
                    );
                    if (locked === null
                      || locked.lifecycle.publicationPolicyRevision
                        !== policy.revision
                      || !sameBytes(
                        locked.lifecycle.allocationRequestDigest, digest,
                      )) return Object.freeze({ status: "conflict" as const });
                  }
                  const plan = createProtectedTaskTerminalMessagePlan({
                    intent: current,
                    allocation: allocationPlan(
                      locked!, policy.revision,
                    ),
                    lifecycle: locked!.lifecycle,
                    namespaceAuthority,
                    crypto: dependencies.crypto,
                    now: dependencies.now(),
                    recipientTtlMs: dependencies.recipientTtlMs,
                  });
                  if (existing === null) {
                    if (supplied !== undefined) {
                      return Object.freeze({ status: "not_ready" as const });
                    }
                    const created = await repository.create(plan.initialRecord);
                    if (created.status === "created") {
                      authorizationChanged = true;
                      return Object.freeze({
                        status: "created" as const, plan,
                      });
                    }
                    if (terminalRecord(created.record)
                      && exactPlan(created.record, plan)) {
                      return Object.freeze({
                        status: "exact_replay" as const, plan,
                      });
                    }
                    return Object.freeze({ status: "conflict" as const });
                  }
                  if (!terminalRecord(existing)
                    || supplied !== undefined
                      && (!terminalRecord(supplied)
                        || supplied.snapshot.requestId !== requestId
                        || !sameBackgroundAuthorizationRecord(
                          supplied, existing,
                        ))) {
                    return Object.freeze({ status: "conflict" as const });
                  }
                  const reconciled = await reconcileAuthorization({
                    repository, existing, plan, now: dependencies.now(),
                    cleanup,
                    authorizationChanged: changed => {
                      authorizationChanged = changed;
                    },
                  });
                  if (reconciled === "conflict") {
                    return Object.freeze({ status: "conflict" as const });
                  }
                  return Object.freeze({
                    status: "exact_replay" as const,
                    plan,
                  });
                },
              });
              return unstaged.status === "publication_exists"
                ? Object.freeze({ status: "not_ready" as const })
                : unstaged.value;
            },
          });
        } finally {
          encoded.fill(0);
          digest.fill(0);
        }
      },
    });
    if (held === null) return Object.freeze({ status: "not_ready" as const });
    for (const [requestId, generation] of cleanup) {
      dependencies.recipients.delete(requestId, generation);
    }
    if (authorizationChanged) {
      await notifyProtectedTaskAuthorizationRequestedAfterCommit(
        authorizationRequested,
        intent.requesterUserId,
      );
    }
    return held;
  }

  return Object.freeze({
    prepare: coordinates => dependencies.owner.runMutation({
      ordinary: () => Promise.resolve(Object.freeze({
        status: "inactive" as const,
      })),
      protected: () => prepareSelected(coordinates, "protected", true),
      dual: () => prepareSelected(coordinates, "dual", true),
    }),
    async resolvePlan(record) {
      if (!terminalRecord(record)) return null;
      const taskId = await dependencies.readTaskId(record.snapshot.workId);
      if (taskId === null) return null;
      const result = await dependencies.owner.runMutation({
        ordinary: () => Promise.resolve(Object.freeze({
          status: "inactive" as const,
        })),
        protected: () => prepareSelected({
          taskId, taskRunId: record.snapshot.workId,
        }, "protected", false, record),
        dual: () => prepareSelected({
          taskId, taskRunId: record.snapshot.workId,
        }, "dual", false, record),
      });
      return result.status === "created" || result.status === "exact_replay"
        ? result.plan : null;
    },
  });
}

async function reconcileAuthorization(input: Readonly<{
  repository: Repository;
  existing: BackgroundAuthorizationTaskRuntimeRecordV3;
  plan: ProtectedTaskTerminalMessagePlan;
  now: number;
  cleanup: Array<readonly [string, number]>;
  authorizationChanged(changed: boolean): void;
}>): Promise<"ready" | "conflict"> {
  let current = input.existing;
  const exact = exactPlan(current, input.plan);
  if (current.expectedPolicyRevision > input.plan.publicationPolicyRevision
    || current.finishedAt !== null) return "conflict";
  const recipientState = current.snapshot.state === "awaiting_device"
    || current.snapshot.state === "grant_ready";
  const claimState = current.snapshot.state === "claimed"
    || current.snapshot.state === "running";
  if (!recipientState && !claimState
    && current.snapshot.state !== "awaiting_recipient") return "conflict";
  let expired = false;
  let reason: "attempt_expired" | "claim_expired" | null = null;
  if (recipientState) {
    if (current.snapshot.recipient === null) return "conflict";
    expired = input.now >= current.snapshot.recipient.expiresAt;
    reason = "attempt_expired";
  } else if (claimState) {
    if (current.snapshot.claimExpiresAt === null) return "conflict";
    expired = input.now >= current.snapshot.claimExpiresAt;
    reason = "claim_expired";
  }
  if (exact && !expired) return "ready";
  if (!exact && claimState && !expired) return "conflict";
  if (expired && reason !== null) {
    const rotated: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...current,
      snapshot: advanceBackgroundAuthorizationGeneration(current.snapshot, {
        reason, now: input.now, nextAttemptAt: input.now,
      }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      descriptorBytes: null, acceptedMaterial: null,
    };
    if (!exact) {
      buildUnclaimedTaskTerminalMessageAuthorityReplacement({
        expected: rotated,
        replacement: input.plan.initialRecord,
        now: input.now,
      });
    }
    const result = await input.repository.compareAndSwap({
      expectedRequestRevision: current.snapshot.requestRevision,
      next: rotated,
    });
    if (result.status !== "updated" || !terminalRecord(result.record)
      || !sameBackgroundAuthorizationRecord(result.record, rotated)) {
      return "conflict";
    }
    input.cleanup.push([
      current.snapshot.requestId, current.snapshot.recipientGeneration,
    ]);
    input.authorizationChanged(true);
    current = result.record;
    if (exact) return "ready";
  }
  const replaced = await input.repository
    .replaceUnclaimedTaskTerminalMessageAuthority({
      expected: current,
      replacement: input.plan.initialRecord,
      now: input.now,
    });
  if (replaced.status !== "replaced") {
    return "conflict";
  }
  if (!exactPlan(replaced.record, input.plan)) {
    input.authorizationChanged(false);
    return "conflict";
  }
  if (!expired && current.snapshot.state !== "awaiting_recipient") {
    input.cleanup.push([
      current.snapshot.requestId, current.snapshot.recipientGeneration,
    ]);
  }
  input.authorizationChanged(true);
  return "ready";
}
