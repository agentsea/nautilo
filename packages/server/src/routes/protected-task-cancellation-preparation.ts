import {
  and,
  createPostgresJsBridgeConnection,
  eq,
  getSharedDirectCryptoDb,
  getEncryptionTransitionPolicy,
  prepareProtectedTaskCancellationOutput,
  taskRunResultCryptoRevisions,
  taskRuns,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  type PrepareProtectedTaskCancellationOutputResult,
  type ProtectedTaskCancellationOutputIntent,
} from "@nautilo/db";
import {
  LatticeCrypto,
  type TaskRuntimeRecipientRegistry,
} from "@nautilo/lattice-crypto";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  hasTaskCancellationCryptoPublication,
  inspectTaskContentNamespaceAuthority,
  verifyCryptoPostgresHandle,
  withTaskContentNamespaceAuthority,
} from "@nautilo/lattice-bridge/server";
import {
  advanceBackgroundAuthorizationGeneration,
  buildUnclaimedTaskCancellationAuthorityReplacement,
  PostgresBackgroundAuthorizationRepository,
  sameBackgroundAuthorizationRecord,
  sameTaskRuntimeAuthorityPlan,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskCancellationReplacementRepository,
  type BackgroundAuthorizationTaskRuntimeCancellationSettlementRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import { findActorByOwnerId } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from
  "./human-message-product-store";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";
import {
  createProtectedTaskCancellationPlan,
  protectedTaskCancellationRequestId,
  protectedTaskCancellationIdempotencyKey,
  type ProtectedTaskCancellationPlan,
} from "./protected-task-cancellation-plan";
import { validateCurrentProtectedTaskCancellationIntent } from
  "./protected-task-cancellation-authority";
import {
  notifyProtectedTaskAuthorizationRequestedAfterCommit,
  type ProtectedTaskAuthorizationRequested,
} from "./protected-task-authorization-requested";

export type ProtectedTaskCancellationPreparationResult =
  | Readonly<{
    status: "created" | "exact_replay";
    plan: ProtectedTaskCancellationPlan;
  }>
  | Readonly<{
    status: "inactive" | "not_ready" | "conflict";
  }>;

export type ProtectedTaskCancellationPreparation = Readonly<{
  prepare(input: Readonly<{
    taskId: string;
    taskRunId: string;
  }>): Promise<ProtectedTaskCancellationPreparationResult>;
  resolvePlan(
    record: BackgroundAuthorizationTaskRuntimeRecordV3,
  ): Promise<ProtectedTaskCancellationPlan | null>;
}>;

type Dependencies = Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  serverScope: string;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  recipientTtlMs: number;
  now(): number;
  restricted(): PostgresJsBridgeConnection;
  repository(connection: PostgresJsBridgeConnection): Promise<
    BackgroundAuthorizationTaskRuntimeCancellationSettlementRepository
      & BackgroundAuthorizationTaskCancellationReplacementRepository
  >;
  readPolicy: typeof getEncryptionTransitionPolicy;
  prepareOutput: typeof prepareProtectedTaskCancellationOutput;
  resolveRequesterHuman(userId: string): Promise<Readonly<{ id: string }> | null>;
  resolveRequesterPrivateRoom: ProtectedTaskRequesterPrivateRoomResolver;
  productContext: typeof createHumanProductTransactionContext;
  inspectContentAuthority: typeof inspectTaskContentNamespaceAuthority;
  withContentAuthority: typeof withTaskContentNamespaceAuthority;
  validateCurrentIntent: typeof validateCurrentProtectedTaskCancellationIntent;
  hasCancellationPublication(
    restricted: PostgresJsBridgeConnection,
    intent: Pick<
      ProtectedTaskCancellationOutputIntent,
      "taskRunId" | "resultObjectId"
    >,
  ): Promise<boolean>;
  hasCancellationReservation(
    transaction: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
    intent: ProtectedTaskCancellationOutputIntent,
  ): Promise<boolean>;
  readTaskId(taskRunId: string): Promise<string | null>;
}>;

function cancellationRecord(
  record: BackgroundAuthorizationRecord,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.workKind === "task.cancel_result"
    && record.purpose === "task.cancel_result";
}

function exactCancellationPlan(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  plan: ProtectedTaskCancellationPlan,
): boolean {
  return cancellationRecord(record)
    && record.idempotencyKey === plan.initialRecord.idempotencyKey
    && sameTaskRuntimeAuthorityPlan(record, plan.initialRecord);
}

/**
 * Prepare only: settle prior execution authority, reserve revision 2 and
 * create its fresh encrypt-only request. This never creates or resumes a Job.
 */
export function createProtectedTaskCancellationPreparation(
  input: Readonly<{
    db?: DirectDatabase;
    crypto?: LatticeCrypto;
    serverScope?: string;
    recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
    recipientTtlMs: number;
    now?: () => number;
    restricted?: () => PostgresJsBridgeConnection;
    authorizationRequested?: ProtectedTaskAuthorizationRequested | undefined;
  }>,
  overrides: Partial<Dependencies> = {},
): ProtectedTaskCancellationPreparation {
  const db = overrides.db ?? input.db ?? getServerDirectDb();
  const crypto = overrides.crypto ?? input.crypto ?? new LatticeCrypto();
  const serverScope = overrides.serverScope ?? input.serverScope
    ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim()
      || "http://localhost:3001");
  const restricted = overrides.restricted ?? input.restricted
    ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const authorizationRequested = input.authorizationRequested;
  const dependencies: Dependencies = {
    db,
    crypto,
    serverScope,
    recipients: overrides.recipients ?? input.recipients,
    recipientTtlMs: overrides.recipientTtlMs ?? input.recipientTtlMs,
    now: overrides.now ?? input.now ?? Date.now,
    restricted,
    repository: overrides.repository ?? (async connection =>
      new PostgresBackgroundAuthorizationRepository(
        await verifyCryptoPostgresHandle(connection),
      )),
    readPolicy: overrides.readPolicy ?? getEncryptionTransitionPolicy,
    prepareOutput: overrides.prepareOutput
      ?? prepareProtectedTaskCancellationOutput,
    resolveRequesterHuman: overrides.resolveRequesterHuman
      ?? findActorByOwnerId,
    resolveRequesterPrivateRoom: overrides.resolveRequesterPrivateRoom
      ?? createProtectedTaskRequesterPrivateRoomResolver(db),
    productContext: overrides.productContext
      ?? createHumanProductTransactionContext,
    inspectContentAuthority: overrides.inspectContentAuthority
      ?? inspectTaskContentNamespaceAuthority,
    withContentAuthority: overrides.withContentAuthority
      ?? withTaskContentNamespaceAuthority,
    validateCurrentIntent: overrides.validateCurrentIntent
      ?? validateCurrentProtectedTaskCancellationIntent,
    hasCancellationPublication: overrides.hasCancellationPublication
      ?? (async (connection, intent) => hasTaskCancellationCryptoPublication(
        await verifyCryptoPostgresHandle(connection),
        {
          requestId: protectedTaskCancellationRequestId(intent.taskRunId),
          objectId: intent.resultObjectId,
        },
      )),
    hasCancellationReservation: overrides.hasCancellationReservation
      ?? (async (transaction, intent) => {
        const rows = await transaction.select({
          sequence: taskRunResultCryptoRevisions.sequence,
        }).from(taskRunResultCryptoRevisions).where(and(
          eq(taskRunResultCryptoRevisions.taskId, intent.taskId),
          eq(taskRunResultCryptoRevisions.taskRunId, intent.taskRunId),
          eq(taskRunResultCryptoRevisions.resultRevision, 2),
        )).limit(1);
        return rows.length !== 0;
      }),
    readTaskId: overrides.readTaskId ?? (async taskRunId => {
      const rows = await db.select({ taskId: taskRuns.taskId }).from(taskRuns)
        .where(eq(taskRuns.id, taskRunId)).limit(2);
      return rows.length === 1 ? rows[0]!.taskId : null;
    }),
  };

  function publicationIdentity(input: Readonly<{
    taskId: string;
    taskRunId: string;
  }>) {
    return Object.freeze({
      taskRunId: input.taskRunId,
      resultObjectId: deriveTaskContentCryptoObjectIdV1({
        kind: "run_result",
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        contentRevision: 2,
      }),
    });
  }

  async function hasDetachedCancellationPublication(
    intent: Pick<
      ProtectedTaskCancellationOutputIntent,
      "taskRunId" | "resultObjectId"
    >,
  ): Promise<boolean> {
    return dependencies.hasCancellationPublication(
      dependencies.restricted(),
      intent,
    );
  }

  async function currentCoordinates(
    intent: ProtectedTaskCancellationOutputIntent,
  ) {
    const [human, room] = await Promise.all([
      dependencies.resolveRequesterHuman(intent.requesterUserId),
      dependencies.resolveRequesterPrivateRoom(
        intent.requesterUserId,
        intent.agentId,
        intent.contentNamespaceId,
      ),
    ]);
    if (human === null || room === null
      || room.namespaceId !== intent.contentNamespaceId) return null;
    const product = await dependencies.productContext(
      intent.requesterUserId,
      dependencies.db,
    );
    return Object.freeze({ human, room, product });
  }

  async function planForIntent(
    intent: ProtectedTaskCancellationOutputIntent,
  ): Promise<ProtectedTaskCancellationPlan | null> {
    if (await hasDetachedCancellationPublication(intent)) return null;
    const coordinates = await currentCoordinates(intent);
    if (coordinates === null) return null;
    const authority = await dependencies.inspectContentAuthority({
      runner: coordinates.product.canonicalRunner,
      restricted: dependencies.restricted(),
      crypto: dependencies.crypto,
      serverScope: dependencies.serverScope,
      taskId: intent.taskId,
      requesterUserId: intent.requesterUserId,
      requesterHumanId: coordinates.human.id,
      agentId: intent.agentId,
      contentNamespaceId: intent.contentNamespaceId,
      sourceRoomId: coordinates.room.roomId,
      expectedPolicyRevision: intent.policyRevision,
    });
    if (authority === null) return null;
    return createProtectedTaskCancellationPlan({
      intent,
      namespaceAuthority: authority,
      crypto: dependencies.crypto,
      now: dependencies.now(),
      recipientTtlMs: dependencies.recipientTtlMs,
    });
  }

  async function rotateExpiredRecipient(
    intent: ProtectedTaskCancellationOutputIntent,
    selected: BackgroundAuthorizationTaskRuntimeRecordV3,
    plan: ProtectedTaskCancellationPlan,
  ): Promise<"rotated" | "not_due" | "inactive" | "stale"> {
    const recipientExpired = selected.snapshot.state === "awaiting_device"
      || selected.snapshot.state === "grant_ready";
    const claimExpired = selected.snapshot.state === "claimed"
      || selected.snapshot.state === "running";
    if (!recipientExpired && !claimExpired) return "inactive";
    const observedAt = dependencies.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new TypeError("Cancellation recipient clock is invalid");
    }
    if (recipientExpired) {
      if (selected.snapshot.recipient === null) return "inactive";
      if (observedAt < selected.snapshot.recipient.expiresAt) return "not_due";
    } else if (selected.snapshot.claimExpiresAt === null
      || observedAt < selected.snapshot.claimExpiresAt) return "not_due";
    const coordinates = await currentCoordinates(intent);
    if (coordinates === null) return "stale";
    const result = await dependencies.withContentAuthority({
      runner: coordinates.product.canonicalRunner,
      restricted: dependencies.restricted(),
      crypto: dependencies.crypto,
      serverScope: dependencies.serverScope,
      taskId: intent.taskId,
      requesterUserId: intent.requesterUserId,
      requesterHumanId: coordinates.human.id,
      agentId: intent.agentId,
      contentNamespaceId: intent.contentNamespaceId,
      sourceRoomId: coordinates.room.roomId,
      expectedPolicyRevision: intent.policyRevision,
      validateCurrentTaskRun: product => dependencies.validateCurrentIntent({
        product,
        intent,
      }),
      use: async (authority, _product, transaction, scoped) => {
        if (await dependencies.hasCancellationPublication(scoped, intent)) {
          return "stale" as const;
        }
        const currentPlan = createProtectedTaskCancellationPlan({
          intent,
          namespaceAuthority: authority,
          crypto: dependencies.crypto,
          now: dependencies.now(),
          recipientTtlMs: dependencies.recipientTtlMs,
        });
        if (!exactCancellationPlan(selected, currentPlan)
          || !exactCancellationPlan(selected, plan)) return "stale" as const;
        const repository = await dependencies.repository(scoped);
        const loaded = await repository.get(selected.snapshot.requestId);
        if (loaded === null
          || !cancellationRecord(loaded)
          || !exactCancellationPlan(loaded, currentPlan)
          || loaded.snapshot.requestRevision
            !== selected.snapshot.requestRevision) return "stale" as const;
        const now = dependencies.now();
        if (!Number.isSafeInteger(now) || now < observedAt) {
          throw new TypeError("Cancellation recipient clock regressed");
        }
        let reason: "attempt_expired" | "claim_expired";
        if (recipientExpired) {
          if ((loaded.snapshot.state !== "awaiting_device"
              && loaded.snapshot.state !== "grant_ready")
            || loaded.snapshot.recipient === null) return "stale" as const;
          if (now < loaded.snapshot.recipient.expiresAt) {
            return "not_due" as const;
          }
          reason = "attempt_expired";
        } else {
          if ((loaded.snapshot.state !== "claimed"
              && loaded.snapshot.state !== "running")
            || loaded.snapshot.claimExpiresAt === null) return "stale" as const;
          if (now < loaded.snapshot.claimExpiresAt) return "not_due" as const;
          // A reserved revision-2 product may have been committed immediately
          // before the worker died. Recovery must reconcile that immutable
          // reservation; it must never rotate the authorization that signed it.
          if (await dependencies.hasCancellationReservation(
            transaction,
            intent,
          )) return "stale" as const;
          reason = "claim_expired";
        }
        const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
          ...loaded,
          snapshot: advanceBackgroundAuthorizationGeneration(
            loaded.snapshot,
            { reason, now, nextAttemptAt: now },
          ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
          descriptorBytes: null,
          acceptedMaterial: null,
        };
        const rotated = await repository.compareAndSwap({
          expectedRequestRevision: loaded.snapshot.requestRevision,
          next,
        });
        if (rotated.status !== "updated"
          || !cancellationRecord(rotated.record)
          || rotated.record.snapshot.state !== "awaiting_recipient"
          || rotated.record.snapshot.recipientGeneration
            !== loaded.snapshot.recipientGeneration + 1
          || rotated.record.snapshot.recipient !== null
          || rotated.record.descriptorBytes !== null
          || rotated.record.acceptedMaterial !== null
          || !exactCancellationPlan(rotated.record, currentPlan)) {
          return "stale" as const;
        }
        dependencies.recipients.delete(
          loaded.snapshot.requestId,
          loaded.snapshot.recipientGeneration,
        );
        return "rotated" as const;
      },
    });
    const committed = result ?? "stale";
    if (committed === "rotated") {
      await notifyProtectedTaskAuthorizationRequestedAfterCommit(
        authorizationRequested,
        intent.requesterUserId,
      );
    }
    return committed;
  }

  async function replaceDriftedPreclaimAuthority(
    intent: ProtectedTaskCancellationOutputIntent,
    supplied: BackgroundAuthorizationTaskRuntimeRecordV3,
  ): Promise<Readonly<{
    status: "ready";
    plan: ProtectedTaskCancellationPlan;
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
  }> | Readonly<{ status: "stale" }> | Readonly<{ status: "conflict" }>> {
    const selected = structuredClone(supplied);
    if (selected.expectedPolicyRevision > intent.policyRevision) {
      return Object.freeze({ status: "conflict" as const });
    }
    const coordinates = await currentCoordinates(intent);
    if (coordinates === null) {
      return Object.freeze({ status: "stale" as const });
    }
    let authorizationChanged = false;
    const result = await dependencies.withContentAuthority({
      runner: coordinates.product.canonicalRunner,
      restricted: dependencies.restricted(),
      crypto: dependencies.crypto,
      serverScope: dependencies.serverScope,
      taskId: intent.taskId,
      requesterUserId: intent.requesterUserId,
      requesterHumanId: coordinates.human.id,
      agentId: intent.agentId,
      contentNamespaceId: intent.contentNamespaceId,
      sourceRoomId: coordinates.room.roomId,
      expectedPolicyRevision: intent.policyRevision,
      validateCurrentTaskRun: product => dependencies.validateCurrentIntent({
        product,
        intent,
      }),
      use: async (authority, _product, transaction, scoped) => {
        if (await dependencies.hasCancellationPublication(scoped, intent)) {
          return Object.freeze({ status: "stale" as const });
        }
        const currentPlan = createProtectedTaskCancellationPlan({
          intent,
          namespaceAuthority: authority,
          crypto: dependencies.crypto,
          now: dependencies.now(),
          recipientTtlMs: dependencies.recipientTtlMs,
        });
        if (await dependencies.hasCancellationReservation(
          transaction,
          intent,
        )) return Object.freeze({ status: "stale" as const });
        const repository = await dependencies.repository(scoped);
        const loaded = await repository.get(selected.snapshot.requestId);
        if (loaded === null || !cancellationRecord(loaded)) {
          return Object.freeze({ status: "stale" as const });
        }
        if (exactCancellationPlan(loaded, currentPlan)) {
          return Object.freeze({
            status: "ready" as const,
            plan: currentPlan,
            record: loaded,
          });
        }
        if (loaded.expectedPolicyRevision > intent.policyRevision) {
          return Object.freeze({ status: "conflict" as const });
        }
        const now = dependencies.now();
        if (!Number.isSafeInteger(now) || now < 0) {
          throw new TypeError("Cancellation authority refresh clock is invalid");
        }
        let replaceable = loaded;
        if (loaded.snapshot.state === "claimed"
          || loaded.snapshot.state === "running") {
          if (loaded.snapshot.claimExpiresAt === null
            || now < loaded.snapshot.claimExpiresAt) {
            return Object.freeze({ status: "conflict" as const });
          }
          const rotated: BackgroundAuthorizationTaskRuntimeRecordV3 = {
            ...loaded,
            snapshot: advanceBackgroundAuthorizationGeneration(
              loaded.snapshot,
              { reason: "claim_expired", now, nextAttemptAt: now },
            ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
            descriptorBytes: null,
            acceptedMaterial: null,
          };
          // Validate the whole stable cancellation identity and current-policy
          // replacement before durably fencing the expired old grant.
          buildUnclaimedTaskCancellationAuthorityReplacement({
            expected: rotated,
            replacement: currentPlan.initialRecord,
            now,
          });
          const rotation = await repository.compareAndSwap({
            expectedRequestRevision: loaded.snapshot.requestRevision,
            next: rotated,
          });
          if (rotation.status !== "updated"
            || !cancellationRecord(rotation.record)
            || !sameBackgroundAuthorizationRecord(rotation.record, rotated)) {
            return Object.freeze({ status: "stale" as const });
          }
          dependencies.recipients.delete(
            loaded.snapshot.requestId,
            loaded.snapshot.recipientGeneration,
          );
          replaceable = rotation.record;
          authorizationChanged = true;
        } else if (loaded.snapshot.state !== "awaiting_recipient"
          && loaded.snapshot.state !== "awaiting_device"
          && loaded.snapshot.state !== "grant_ready") {
          return Object.freeze({ status: "conflict" as const });
        }
        const replaced = await repository
          .replaceUnclaimedTaskCancellationAuthority({
            expected: replaceable,
            replacement: currentPlan.initialRecord,
            now,
          });
        if (replaced.status !== "replaced") {
          return Object.freeze({ status: "stale" as const });
        }
        if (!exactCancellationPlan(replaced.record, currentPlan)) {
          authorizationChanged = false;
          return Object.freeze({ status: "stale" as const });
        }
        if (replaceable === loaded) {
          dependencies.recipients.delete(
            loaded.snapshot.requestId,
            loaded.snapshot.recipientGeneration,
          );
        }
        authorizationChanged = true;
        return Object.freeze({
          status: "ready" as const,
          plan: currentPlan,
          record: replaced.record,
        });
      },
    });
    if (result !== null && authorizationChanged) {
      await notifyProtectedTaskAuthorizationRequestedAfterCommit(
        authorizationRequested,
        intent.requesterUserId,
      );
    }
    return result ?? Object.freeze({ status: "stale" as const });
  }

  async function reconcileExisting(
    intent: ProtectedTaskCancellationOutputIntent,
    selected: BackgroundAuthorizationTaskRuntimeRecordV3,
    detachedPlan: ProtectedTaskCancellationPlan,
  ): Promise<Readonly<{
    status: "ready";
    plan: ProtectedTaskCancellationPlan;
  }> | Readonly<{ status: "stale" }> | Readonly<{ status: "conflict" }>> {
    if (await hasDetachedCancellationPublication(intent)) {
      return Object.freeze({ status: "stale" as const });
    }
    let plan = detachedPlan;
    let record = selected;
    if (!exactCancellationPlan(record, plan)) {
      const refreshed = await replaceDriftedPreclaimAuthority(intent, record);
      if (refreshed.status !== "ready") return refreshed;
      plan = refreshed.plan;
      record = refreshed.record;
    }
    const rotation = await rotateExpiredRecipient(intent, record, plan);
    return rotation === "stale"
      ? Object.freeze({ status: "stale" as const })
      : Object.freeze({ status: "ready" as const, plan });
  }

  async function prepareStoppedOutput(input: Readonly<{
    taskId: string;
    taskRunId: string;
  }>): Promise<PrepareProtectedTaskCancellationOutputResult> {
    const policy = await dependencies.readPolicy(dependencies.db);
    if (policy.mode === "plaintext_only") {
      return Object.freeze({ status: "rejected", reason: "not_ready" });
    }
    let repository: Awaited<ReturnType<Dependencies["repository"]>> | null = null;
    const getRepository = async () => repository ??= await dependencies
      .repository(dependencies.restricted());
    return dependencies.prepareOutput(dependencies.db, {
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      requiredPolicyRevision: policy.revision,
    }, async previous => {
      if (await hasDetachedCancellationPublication(
        publicationIdentity(previous),
      )) return false;
      const settled = await (await getRepository())
        .settleTaskRuntimeExecutionAuthorities({
          workId: previous.taskRunId,
          namespaceId: previous.contentNamespaceId,
          now: dependencies.now(),
        });
      if (settled.status !== "settled") return false;
      for (const recipient of settled.recipients) {
        dependencies.recipients.delete(
          recipient.requestId,
          recipient.recipientGeneration,
        );
      }
      return previous.jobAuthorizationRequestId === null
        || settled.recipients.some(recipient =>
          recipient.requestId === previous.jobAuthorizationRequestId);
    }, async ({ previousIntent }) => {
      // Task/Run locks fence the old publisher while this cross-role custody
      // check runs. Refresh only the binding here; replace its request after commit.
      if (await hasDetachedCancellationPublication(previousIntent)) return false;
      const record = await (await getRepository()).get(
        protectedTaskCancellationRequestId(previousIntent.taskRunId),
      );
      if (record === null) return true;
      if (!cancellationRecord(record)
        || record.snapshot.requestId !== protectedTaskCancellationRequestId(previousIntent.taskRunId)
        || record.snapshot.workId !== previousIntent.taskRunId
        || record.snapshot.namespaceId !== previousIntent.contentNamespaceId
        || record.idempotencyKey !== protectedTaskCancellationIdempotencyKey(previousIntent)
        || record.expectedPolicyRevision < 1
        || record.expectedPolicyRevision > previousIntent.policyRevision
        || record.finishedAt !== null) return false;
      if (record.snapshot.state === "claimed" || record.snapshot.state === "running") {
        return record.snapshot.claimExpiresAt !== null
          && dependencies.now() >= record.snapshot.claimExpiresAt;
      }
      return record.snapshot.state === "awaiting_recipient"
        || record.snapshot.state === "awaiting_device"
        || record.snapshot.state === "grant_ready";
    });
  }

  async function reconstruct(input: Readonly<{
    taskId: string;
    taskRunId: string;
  }>): Promise<ProtectedTaskCancellationPlan | null> {
    if (await hasDetachedCancellationPublication(publicationIdentity(input))) {
      return null;
    }
    const prepared = await prepareStoppedOutput(input);
    if (prepared.status !== "prepared"
      && prepared.status !== "exact_replay") return null;
    return planForIntent(prepared.intent);
  }

  return Object.freeze({
    async prepare(coordinates) {
      const policy = await dependencies.readPolicy(dependencies.db);
      if (policy.mode === "plaintext_only") {
        return Object.freeze({ status: "inactive" as const });
      }
      if (await hasDetachedCancellationPublication(
        publicationIdentity(coordinates),
      )) {
        return Object.freeze({ status: "not_ready" as const });
      }
      const prepared = await prepareStoppedOutput(coordinates);
      if (prepared.status === "rejected") {
        return Object.freeze({
          status: prepared.reason === "not_ready"
            ? "not_ready" as const
            : "conflict" as const,
        });
      }
      const plan = await planForIntent(prepared.intent);
      if (plan === null) {
        return Object.freeze({ status: "not_ready" as const });
      }
      const repository = await dependencies.repository(
        dependencies.restricted(),
      );
      const existing = await repository.get(plan.initialRecord.snapshot.requestId);
      if (existing !== null) {
        if (!cancellationRecord(existing)) {
          return Object.freeze({ status: "conflict" as const });
        }
        const reconciled = await reconcileExisting(
          prepared.intent,
          existing,
          plan,
        );
        if (reconciled.status === "stale") {
          return Object.freeze({ status: "not_ready" as const });
        }
        if (reconciled.status === "conflict") {
          return Object.freeze({ status: "conflict" as const });
        }
        return Object.freeze({
          status: "exact_replay" as const,
          plan: reconciled.plan,
        });
      }
      if (await hasDetachedCancellationPublication(prepared.intent)) {
        return Object.freeze({ status: "not_ready" as const });
      }
      try {
        const created = await repository.create(plan.initialRecord);
        if (created.status === "created") {
          await notifyProtectedTaskAuthorizationRequestedAfterCommit(
            authorizationRequested,
            prepared.intent.requesterUserId,
          );
          return Object.freeze({ status: "created" as const, plan });
        }
        if (cancellationRecord(created.record)
          && exactCancellationPlan(created.record, plan)) {
          return Object.freeze({ status: "exact_replay" as const, plan });
        }
      } catch {
        const current = await repository.get(
          plan.initialRecord.snapshot.requestId,
        );
        if (current !== null && cancellationRecord(current)) {
          const reconciled = await reconcileExisting(
            prepared.intent,
            current,
            plan,
          );
          if (reconciled.status === "stale") {
            return Object.freeze({ status: "not_ready" as const });
          }
          if (reconciled.status === "conflict") {
            return Object.freeze({ status: "conflict" as const });
          }
          return Object.freeze({
            status: "exact_replay" as const,
            plan: reconciled.plan,
          });
        }
      }
      return Object.freeze({ status: "conflict" as const });
    },
    async resolvePlan(record) {
      if (!cancellationRecord(record)) return null;
      const taskId = await dependencies.readTaskId(record.snapshot.workId);
      if (taskId === null) return null;
      const plan = await reconstruct({
        taskId,
        taskRunId: record.snapshot.workId,
      });
      if (plan === null) return null;
      const reconciled = await reconcileExisting(
        plan.intent,
        record,
        plan,
      );
      return reconciled.status === "ready" ? reconciled.plan : null;
    },
  });
}
