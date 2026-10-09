import { randomUUID } from "node:crypto";

import {
  and,
  eq,
  isNull,
  jobs,
  taskRunResultCryptoRevisions,
  taskRuns,
  tasks,
  type DirectDatabase,
  type ExactProtectedTaskRunResultPublicationProof,
  type PostgresJsBridgeConnection,
  type ProtectedTaskRunResultPublicationTransaction,
} from "@nautilo/db";
import {
  sameTaskContentCoordinateV1,
  type TaskContentAuthorityV1,
  type TaskContentCryptoRevisionReferenceV1,
} from "@nautilo/lattice-bridge";
import type {
  LatticeCrypto,
  TaskRuntimeRecipientRegistry,
} from "@nautilo/lattice-crypto";
import {
  PostgresHumanDeviceSignerHistory,
  createPostgresTaskContentCryptoCompletion,
  reconcilePostgresTaskRunResultPublication,
  verifyCryptoPostgresHandle,
  type ConversationProductCanonicalTransactionRunner,
  type CryptoPostgresHandle,
  type TaskRunResultRecoveryOutcome,
} from "@nautilo/lattice-bridge/server";
import {
  failBackgroundAuthorizationRequest,
  isExactIntegrityFailedTaskRuntimeSuccessor,
  assertProtectedTaskJobReferenceV1,
  parseBackgroundAuthorizationRecord,
  PostgresBackgroundAuthorizationRepository,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";

import { createHumanProductTransactionContext } from
  "./human-message-product-store";
import {
  createProtectedTaskHistoricalHumanDeviceSigningKeyResolver,
} from "./protected-task-historical-human-device-signing-key";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";
import {
  isExactProtectedTaskPublishedResultRecord,
  type ProtectedTaskPublishedResultJob,
} from "./protected-task-published-result-recovery";

type ProductContext = Readonly<{
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
}>;

type RecoveryCoordinates = Readonly<{
  taskId: string;
  taskRunId: string;
  requesterUserId: string;
  requesterHumanId: string;
  agentId: string;
  contentNamespaceId: string;
}>;

type GrantRepository = Pick<
  BackgroundAuthorizationRepository,
  "get" | "compareAndSwap"
>;

type Dependencies = Readonly<{
  loadCoordinates(
    publication: ProtectedTaskPublishedResultJob,
  ): Promise<RecoveryCoordinates | null>;
  resolveRequesterPrivateRoom: ProtectedTaskRequesterPrivateRoomResolver;
  createProductContext(userId: string, db: DirectDatabase): Promise<ProductContext>;
  reconcile: typeof reconcilePostgresTaskRunResultPublication;
  createLeaseToken(): string;
  verify(
    reference: TaskContentCryptoRevisionReferenceV1,
    authority: TaskContentAuthorityV1,
  ): ReturnType<ReturnType<
    typeof createPostgresTaskContentCryptoCompletion
  >["verify"]>;
  createGrantRepository(
    restricted: PostgresJsBridgeConnection,
  ): Promise<GrantRepository>;
}>;

function exactTerminalIntegrityFailure(
  record: BackgroundAuthorizationRecord,
): boolean {
  return record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.snapshot.state === "terminal_failure"
    && record.snapshot.terminalReason === "integrity_failure"
    && record.finishedAt === record.snapshot.updatedAt;
}

/**
 * Close the exact grant and Job after result integrity retries are exhausted.
 * The caller holds the exact Task/Run publication proof; the unattached output
 * binding remains incomplete and is excluded by its quarantined ledger state.
 */
export async function settleProtectedTaskUnmappedResultIntegrityFailure(
  input: Readonly<{
  transaction: ProtectedTaskRunResultPublicationTransaction;
  proof: ExactProtectedTaskRunResultPublicationProof;
  repository: GrantRepository;
  now(): number;
  }>,
): Promise<BackgroundAuthorizationTaskRuntimeRecordV3 | null> {
  const { proof } = input;
  if (proof.job.status === "completed") return null;

  const raw = await input.repository.get(
    proof.reference.authorizationRequestId,
  );
  const current = raw === null ? null : parseBackgroundAuthorizationRecord(raw);
  assertProtectedTaskJobReferenceV1(proof.reference);
  if (!isExactProtectedTaskPublishedResultRecord(
    current,
    proof.reference,
    {
      contentNamespaceId: proof.lifecycle.contentNamespaceId,
      requesterHumanId: proof.lifecycle.requesterHumanId,
    },
  )) return null;

  let failed: BackgroundAuthorizationTaskRuntimeRecordV3 | null = null;
  if (exactTerminalIntegrityFailure(current)) {
    failed = current;
  } else {
    if (current.finishedAt !== null
      || (current.snapshot.state !== "running"
        && current.snapshot.state !== "publication_reconciliation")) return null;
    const failedAt = input.now();
    const next = parseBackgroundAuthorizationRecord({
      ...current,
      snapshot: failBackgroundAuthorizationRequest(
        current.snapshot,
        "integrity_failure",
        failedAt,
      ),
      finishedAt: failedAt,
    });
    let stored: BackgroundAuthorizationRecord | null;
    try {
      const result = await input.repository.compareAndSwap({
        expectedRequestRevision: current.snapshot.requestRevision,
        next,
      });
      stored = result.status === "updated" ? result.record : result.current;
    } catch {
      stored = await input.repository.get(current.snapshot.requestId);
    }
    if (!isExactIntegrityFailedTaskRuntimeSuccessor(stored, current)) return null;
    failed = stored as BackgroundAuthorizationTaskRuntimeRecordV3;
  }

  const completedAt = new Date(failed.snapshot.updatedAt);
  if (proof.job.status === "running") {
    const [updatedJob] = await input.transaction.update(jobs).set({
      status: "failed",
      completedAt,
    }).where(and(
      eq(jobs.id, proof.job.id),
      eq(jobs.input, proof.reference),
      eq(jobs.ownerId, proof.task.requestorId),
      eq(jobs.requestorId, proof.task.requestorId),
      eq(jobs.laneKey, `task:${proof.task.id}`),
      eq(jobs.type, "foreground"),
      eq(jobs.status, "running"),
      eq(jobs.startedAt, proof.job.startedAt),
      isNull(jobs.completedAt),
      isNull(jobs.result),
      isNull(jobs.message),
    )).returning({ id: jobs.id });
    if (updatedJob === undefined) {
      throw new Error("Task result integrity settlement lost its Job");
    }
  }

  return failed;
}

/** Recover one exact terminal result without re-running work or opening bytes. */
export function createProtectedTaskUnmappedResultRecovery(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  cryptoHandle: CryptoPostgresHandle;
  serverScope: string;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  now?: () => number;
}>, overrides: Partial<Dependencies> = {}) {
  const now = input.now ?? Date.now;
  const resolveRequesterPrivateRoom = overrides.resolveRequesterPrivateRoom
    ?? createProtectedTaskRequesterPrivateRoomResolver(input.db);
  const createProductContext = overrides.createProductContext
    ?? createHumanProductTransactionContext;
  const reconcile = overrides.reconcile
    ?? reconcilePostgresTaskRunResultPublication;
  const verify = overrides.verify ?? ((reference, authority) => {
    const history = new PostgresHumanDeviceSignerHistory({
      handle: input.cryptoHandle,
      crypto: input.crypto,
    });
    const crypto = createPostgresTaskContentCryptoCompletion({
      handle: input.cryptoHandle,
      crypto: input.crypto,
      resolveCurrentAuthority: coordinate => Promise.resolve(
        sameTaskContentCoordinateV1(coordinate, reference.coordinate)
          ? authority
          : null,
      ),
      resolveHistoricalAgentSignerAuthority:
        history.resolveAgentRuntimeSignerManager,
      resolveHistoricalHumanDeviceSigningPublicKey:
        createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(
          input.cryptoHandle,
        ),
    });
    return crypto.verify(reference);
  });
  const loadCoordinates = overrides.loadCoordinates ?? (async (
    publication: ProtectedTaskPublishedResultJob,
  ): Promise<RecoveryCoordinates | null> => {
    const rows = await input.db.select({
      taskId: tasks.id,
      taskRunId: taskRuns.id,
      requesterUserId: tasks.requestorId,
      requesterHumanId: taskRunResultCryptoRevisions.requesterHumanId,
      agentId: tasks.agentId,
      contentNamespaceId: taskRunResultCryptoRevisions.contentNamespaceId,
    }).from(tasks)
      .innerJoin(taskRuns, and(
        eq(taskRuns.taskId, tasks.id),
        eq(taskRuns.id, publication.reference.taskRunId),
      ))
      .innerJoin(taskRunResultCryptoRevisions, and(
        eq(taskRunResultCryptoRevisions.taskId, tasks.id),
        eq(taskRunResultCryptoRevisions.taskRunId, taskRuns.id),
        eq(taskRunResultCryptoRevisions.resultRevision, 1),
      ))
      .where(and(
        eq(tasks.id, publication.reference.taskId),
        eq(taskRuns.jobId, publication.jobId),
      )).limit(2);
    return rows.length === 1 ? Object.freeze(rows[0]!) : null;
  });
  const createLeaseToken = overrides.createLeaseToken ?? randomUUID;
  const createGrantRepository = overrides.createGrantRepository
    ?? (async restricted => new PostgresBackgroundAuthorizationRepository(
      await verifyCryptoPostgresHandle(restricted),
    ));

  return Object.freeze({
    async recover(
      publication: ProtectedTaskPublishedResultJob,
    ): Promise<TaskRunResultRecoveryOutcome> {
      const coordinates = await loadCoordinates(publication);
      if (coordinates === null) return "pending";
      const room = await resolveRequesterPrivateRoom(
        coordinates.requesterUserId,
        coordinates.agentId,
        coordinates.contentNamespaceId,
      );
      if (room === null
        || room.namespaceId !== coordinates.contentNamespaceId) return "pending";
      const product = await createProductContext(
        coordinates.requesterUserId,
        input.db,
      );
      let released: Readonly<{
        requestId: string;
        generation: number;
      }> | undefined;
      const outcome = await reconcile({
        authority: Object.freeze({
          runner: product.canonicalRunner,
          restricted: input.restricted,
          crypto: input.crypto,
          serverScope: input.serverScope,
          taskId: coordinates.taskId,
          requesterUserId: coordinates.requesterUserId,
          requesterHumanId: coordinates.requesterHumanId,
          agentId: coordinates.agentId,
          contentNamespaceId: coordinates.contentNamespaceId,
          sourceRoomId: room.roomId,
          expectedPolicyRevision: publication.reference.policyRevision,
        }),
        publication,
        leaseToken: createLeaseToken(),
        verify,
        settleIntegrityFailure: async (transaction, proof, restricted) => {
          const repository = await createGrantRepository(restricted);
          const failed = await settleProtectedTaskUnmappedResultIntegrityFailure({
            transaction,
            proof,
            repository,
            now,
          });
          if (failed === null) return false;
          released = {
            requestId: failed.snapshot.requestId,
            generation: failed.snapshot.recipientGeneration,
          };
          return true;
        },
      });
      if (outcome === "quarantined" && released !== undefined) {
        input.recipients.delete(released.requestId, released.generation);
      }
      return outcome;
    },
  });
}
