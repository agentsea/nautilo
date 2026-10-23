import { isDeepStrictEqual } from "node:util";
import {
  createPostgresJsBridgeConnection, eq, getSharedDirectCryptoDb,
  protectedTaskRunOutputBindings, taskRuns, tasks, withCurrentProtectedTaskWakeContinuation,
  type DirectDatabase, type PostgresJsBridgeConnection, type ProtectedTaskWakeContinuationReceipt,
  type VerifiedProtectedTaskWakeContinuation,
} from "@nautilo/db";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { verifyCryptoPostgresHandle } from "@nautilo/lattice-bridge/server";
import { LatticeCrypto, type TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  PostgresBackgroundAuthorizationRepository, sameBackgroundAuthorizationRecord,
  sameTaskRuntimeAuthorityPlan, type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskOutputReadReplacementRepository, type BackgroundAuthorizationTaskWakeParkRepository,
} from "@nautilo/runtime";
import { verifyProtectedTaskWakeCheckpointIntegrity } from "./protected-task-wake-checkpoint-integrity";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import type { ProtectedTaskOutputReadAuthorityPort } from "./protected-task-output-read-authority";
import { createProtectedTaskOutputReadPlan, type ProtectedTaskOutputReadPlan } from "./protected-task-output-read-plan";
import { readProtectedTaskOutputReadIntent, readCommittedProtectedTaskWakePark } from "./protected-task-output-read-product";
import type { ProtectedTaskOutputReadParkCompletion } from "./protected-task-output-read-claim";
import {
  notifyProtectedTaskAuthorizationRequestedAfterCommit,
  type ProtectedTaskAuthorizationRequested,
} from "./protected-task-authorization-requested";

type Coordinates = Readonly<{ taskId: string; taskRunId: string; kind: "raw" | "wake" }>;
type Repository = BackgroundAuthorizationTaskOutputReadReplacementRepository & BackgroundAuthorizationTaskWakeParkRepository;
export type ProtectedTaskOutputReadPreparationResult = Readonly<{
  status: "created" | "exact_replay";
  plan: ProtectedTaskOutputReadPlan;
}> | Readonly<{ status: "inactive" | "not_ready" | "conflict" }>;
type Dependencies = Readonly<{
  readIntent: typeof readProtectedTaskOutputReadIntent;
  withContinuation: typeof withCurrentProtectedTaskWakeContinuation;
  verifyCheckpoint: typeof verifyProtectedTaskWakeCheckpointIntegrity;
  productContext: typeof createHumanProductTransactionContext;
  repository(connection: PostgresJsBridgeConnection): Promise<Repository>;
  requester(coordinates: Coordinates): Promise<string | null>;
  coordinates(record: BackgroundAuthorizationTaskRuntimeRecordV3): Promise<Coordinates | null>;
}>;

function outputReadRecord(record: BackgroundAuthorizationRecord): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && (record.workKind === "task.deliver_result" || record.workKind === "task.delivery_wake")
    && record.purpose === record.workKind;
}
function samePlan(record: BackgroundAuthorizationTaskRuntimeRecordV3, plan: ProtectedTaskOutputReadPlan): boolean {
  return record.snapshot.requestId === plan.initialRecord.snapshot.requestId
    && record.snapshot.workId === plan.initialRecord.snapshot.workId
    && record.idempotencyKey === plan.initialRecord.idempotencyKey
    && sameTaskRuntimeAuthorityPlan(record, plan.initialRecord);
}

/** Fresh result reads are prepared through the same policy owner as execution. */
export function createProtectedTaskOutputReadPreparation(input: Readonly<{
  db: DirectDatabase;
  owner: EncryptionDataOperationOwner;
  authority: ProtectedTaskOutputReadAuthorityPort;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  recipientTtlMs: number;
  authorizationRequested?: ProtectedTaskAuthorizationRequested | undefined;
  crypto?: LatticeCrypto;
  restricted?: () => PostgresJsBridgeConnection;
  now?: () => number;
}>, overrides: Partial<Dependencies> = {}) {
  const crypto = input.crypto ?? new LatticeCrypto();
  const now = input.now ?? Date.now;
  const restricted = input.restricted ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const context = overrides.productContext ?? createHumanProductTransactionContext;
  const readIntent = overrides.readIntent ?? readProtectedTaskOutputReadIntent;
  const withContinuation = overrides.withContinuation ?? withCurrentProtectedTaskWakeContinuation;
  const verifyCheckpoint = overrides.verifyCheckpoint ?? verifyProtectedTaskWakeCheckpointIntegrity;
  async function withCheckedContinuation<Value>(transaction: Parameters<typeof withContinuation>[0],
    receipt: ProtectedTaskWakeContinuationReceipt,
    use: (proof: VerifiedProtectedTaskWakeContinuation) => Promise<Value>): Promise<Value | null> {
    return withContinuation(transaction, { wakeJobId: receipt.wakeJobId, segment: receipt.segment,
      wakeAuthorizationRequestId: receipt.wakeAuthorizationRequestId,
      priorRecipientGeneration: receipt.priorRecipientGeneration, jobState: "queued" }, async proof => {
      if (!await verifyCheckpoint(proof.receipt)) return null;
      await proof.assertCurrent();
      return use(proof);
    });
  }
  const repository = overrides.repository ?? (async connection =>
    new PostgresBackgroundAuthorizationRepository(await verifyCryptoPostgresHandle(connection)));
  const requester = overrides.requester ?? (async (coordinates: Coordinates) => {
    const [task] = await input.db.select({ requesterUserId: tasks.requestorId }).from(tasks)
      .where(eq(tasks.id, coordinates.taskId)).limit(1);
    return task?.requesterUserId ?? null;
  });
  const resolveCoordinates = overrides.coordinates ?? (async record => {
    const kind = record.workKind === "task.deliver_result" ? "raw" as const : "wake" as const;
    const rows = kind === "raw"
      ? await input.db.select({ taskId: taskRuns.taskId, taskRunId: taskRuns.id }).from(taskRuns)
        .where(eq(taskRuns.id, record.snapshot.workId)).limit(2)
      : await input.db.select({ taskId: taskRuns.taskId, taskRunId: taskRuns.id })
        .from(protectedTaskRunOutputBindings).innerJoin(taskRuns,
          eq(taskRuns.id, protectedTaskRunOutputBindings.taskRunId))
        .where(eq(protectedTaskRunOutputBindings.wakeJobId, record.snapshot.workId)).limit(2);
    return rows.length === 1 ? { ...rows[0]!, kind } : null;
  });

  async function prepareSelected(coordinates: Coordinates, representation: "protected" | "dual",
    create: boolean, selected?: BackgroundAuthorizationTaskRuntimeRecordV3,
    park?: ProtectedTaskOutputReadParkCompletion): Promise<ProtectedTaskOutputReadPreparationResult> {
    const userId = await requester(coordinates);
    if (userId === null) return { status: "not_ready" };
    const product = await context(userId, input.db);
    // Commit the canonical structural Session before a grant can name it.
    // This phase never reads or copies any protected content.
    const intent = await product.canonicalRunner.transaction(transaction => readIntent(transaction, coordinates,
      { ensureDestinationSession: create }), { isolationLevel: "read committed" });
    if (intent === null || intent.requesterUserId !== userId || intent.representation !== representation
      || coordinates.kind === "raw" && intent.result.contentRevision !== 1) return { status: "not_ready" };
    if (park !== undefined && (intent.initialState !== "wake_queued" || !isDeepStrictEqual(
      structuredClone(intent.continuation), readCommittedProtectedTaskWakePark(park.receipt,
        park.plan.intent, park.record.snapshot.recipientGeneration)))) return { status: "conflict" };
    const cleanup: Array<readonly [string, number]> = [];
    let authorizationRequestChanged = false;
    const result = await input.authority.withPlanning<ProtectedTaskOutputReadPreparationResult>({ intent,
      subject: { userId: intent.requesterUserId, humanActorId: intent.requesterHumanId },
      restricted: restricted(),
      use: async (current, _product, _transaction, scoped) => {
        const plan = createProtectedTaskOutputReadPlan({ intent, authority: current.namespaceAuthority,
          crypto, now: now(), recipientTtlMs: input.recipientTtlMs });
        const store = await repository(scoped);
        const existing = await store.get(plan.initialRecord.snapshot.requestId);
        if (existing === null) {
          if (!create || selected !== undefined || intent.continuation !== undefined) return { status: "not_ready" as const };
          const created = await store.create(plan.initialRecord);
          if (created.status === "created") {
            authorizationRequestChanged = true;
            return { status: "created" as const, plan };
          }
          return outputReadRecord(created.record) && samePlan(created.record, plan)
            ? { status: "exact_replay" as const, plan } : { status: "conflict" as const };
        }
        if (!outputReadRecord(existing) || selected !== undefined && !sameBackgroundAuthorizationRecord(selected, existing)
          || park !== undefined && existing.snapshot.recipientGeneration === park.record.snapshot.recipientGeneration
            && !sameBackgroundAuthorizationRecord(existing, park.record)
          || existing.finishedAt !== null || existing.expectedPolicyRevision > intent.expectedPolicyRevision) {
          return { status: "conflict" as const };
        }
        const exact = samePlan(existing, plan);
        const recipientExpired = existing.snapshot.recipient !== null && now() >= existing.snapshot.recipient.expiresAt;
        const continuation = intent.continuation;
        if (exact && !recipientExpired) {
          if (continuation !== undefined) {
            if (existing.snapshot.recipientGeneration < continuation.segment) return { status: "conflict" as const };
            if (intent.initialState === "wake_queued"
              && await withCheckedContinuation(_transaction, continuation, () => Promise.resolve(true)) !== true) return { status: "conflict" as const };
            cleanup.push([existing.snapshot.requestId, continuation.priorRecipientGeneration]);
          }
          return { status: "exact_replay" as const, plan };
        }
        if (continuation !== undefined) {
          if (intent.initialState === "wake_queued"
            && ["awaiting_recipient", "awaiting_device", "grant_ready"].includes(existing.snapshot.state)) {
            const renewed = await withCheckedContinuation(_transaction, continuation,
              proof => store.renewParkedTaskWakeRecipient({ expected: existing, replacement: plan.initialRecord, proof, now: now() }));
            if (renewed?.status !== "rotated" || !samePlan(renewed.record, plan)
              || renewed.record.snapshot.recipientGeneration < continuation.segment) return { status: "conflict" as const };
            authorizationRequestChanged = true;
            cleanup.push([existing.snapshot.requestId, renewed.releasedRecipientGeneration]);
            return { status: "exact_replay" as const, plan };
          }
          if (intent.invocation.kind !== "wake" || intent.initialState !== "wake_queued"
            || existing.snapshot.state !== "running"
            || existing.snapshot.recipientGeneration !== continuation.priorRecipientGeneration) {
            return { status: "conflict" as const };
          }
          const parked = await withCheckedContinuation(_transaction, continuation, async proof => store.parkTaskWakeForAdditionalAuthority({
            expected: existing, replacement: plan.initialRecord, proof, now: now(),
          }));
          if (parked === null || parked.status === "stale" || !samePlan(parked.record, plan)
            || parked.record.snapshot.recipientGeneration !== continuation.segment) return { status: "conflict" as const };
          authorizationRequestChanged = parked.status === "parked";
          cleanup.push([existing.snapshot.requestId, existing.snapshot.recipientGeneration]);
          return { status: "exact_replay" as const, plan };
        }
        // An admitted raw write needs the separate no-staging recovery fence;
        // a wake may already have effects. Neither is blindly renewed here.
        if (existing.snapshot.state === "claimed" || existing.snapshot.state === "running") {
          return { status: "conflict" as const };
        }
        const replaced = await store.replaceUnclaimedTaskOutputReadAuthority({
          expected: existing, replacement: plan.initialRecord, now: now(),
        });
        if (replaced.status !== "replaced" || !samePlan(replaced.record, plan)) return { status: "conflict" as const };
        authorizationRequestChanged = true;
        cleanup.push([existing.snapshot.requestId, existing.snapshot.recipientGeneration]);
        return { status: "exact_replay" as const, plan };
      },
    });
    // A recipient remains usable until the held authority transaction commits.
    if (result !== null) {
      if (result.status === "created" || result.status === "exact_replay") {
        for (const [requestId, generation] of cleanup) input.recipients.delete(requestId, generation);
      }
      if (authorizationRequestChanged) {
        await notifyProtectedTaskAuthorizationRequestedAfterCommit(
          input.authorizationRequested,
          userId,
        );
      }
    }
    return result ?? { status: "not_ready" };
  }
  function throughPolicy(coordinates: Coordinates, create: boolean, record?: BackgroundAuthorizationTaskRuntimeRecordV3,
    park?: ProtectedTaskOutputReadParkCompletion) {
    return input.owner.runMutation({
      ordinary: () => Promise.resolve({ status: "inactive" as const }),
      protected: () => prepareSelected(coordinates, "protected", create, record, park),
      dual: () => prepareSelected(coordinates, "dual", create, record, park),
    });
  }
  return Object.freeze({
    prepare: (coordinates: Coordinates) => throughPolicy(coordinates, true),
    async finishParkedWake(park: ProtectedTaskOutputReadParkCompletion): Promise<BackgroundAuthorizationTaskRuntimeRecordV3 | null> {
      const receipt = readCommittedProtectedTaskWakePark(park.receipt, park.plan.intent, park.record.snapshot.recipientGeneration);
      if (park.record.workKind !== "task.delivery_wake" || park.record.snapshot.state !== "running"
        || park.record.snapshot.requestId !== receipt.wakeAuthorizationRequestId
        || park.record.snapshot.workId !== receipt.wakeJobId) return null;
      const result = await throughPolicy({ taskId: receipt.taskId, taskRunId: receipt.taskRunId, kind: "wake" }, false, undefined, park);
      if (result.status !== "exact_replay") return null;
      const current = await (await repository(restricted())).get(receipt.wakeAuthorizationRequestId);
      return current !== null && outputReadRecord(current) && samePlan(current, result.plan)
        && current.snapshot.state === "awaiting_recipient" && current.snapshot.recipientGeneration >= receipt.segment
        && current.finishedAt === null ? current : null;
    },
    async resolvePlan(record: BackgroundAuthorizationTaskRuntimeRecordV3): Promise<ProtectedTaskOutputReadPlan | null> {
      if (!outputReadRecord(record)) return null;
      const coordinates = await resolveCoordinates(record);
      if (coordinates === null) return null;
      const result = await throughPolicy(coordinates, false, record);
      return result.status === "created" || result.status === "exact_replay" ? result.plan : null;
    },
  });
}
