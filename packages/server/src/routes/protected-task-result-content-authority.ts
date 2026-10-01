import {
  and,
  createPostgresJsBridgeConnection,
  eq,
  getEncryptionTransitionPolicy,
  getSharedDirectCryptoDb,
  taskRuns,
  tasks,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  type TaskContentAuthorityV1,
  type TaskContentCoordinateV1,
} from "@nautilo/lattice-bridge";
import {
  inspectInitialTaskRuntimeNamespaceAuthority,
} from "@nautilo/lattice-bridge/server";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  findActorByOwnerId,
  findAgentOwnerPrivateRoom,
} from "@nautilo/trust";

import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from
  "./human-message-product-store";

type TaskFacts = Readonly<{
  id: string;
  ownerId: string;
  requestorId: string;
  agentId: string;
  scheduleKind: "now" | "one_shot" | "cron";
  status: string;
  contentRepresentation: "ordinary" | "dual" | "protected";
  contentNamespaceId: string | null;
  contentRevision: number;
  cryptoObjectId: string | null;
  cryptoAccessRevision: number;
  cryptoRequiredNamespaceFingerprint: Uint8Array | null;
  cryptoMappingState: string;
}>;

type RunFacts = Readonly<{
  id: string;
  taskId: string;
  jobId: string | null;
  status: string;
  completedAt: Date | null;
  resultRepresentation: "ordinary" | "dual" | "protected";
  resultContentNamespaceId: string | null;
  resultRevision: number;
  resultCryptoObjectId: string | null;
  resultCryptoAccessRevision: number;
  resultCryptoRequiredNamespaceFingerprint: Uint8Array | null;
  resultCryptoMappingState: string;
}>;

type ProductContext = Awaited<ReturnType<
  typeof createHumanProductTransactionContext
>>;

export type ProtectedTaskResultContentAuthorityDependencies = Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  serverScope: string;
  restricted(): PostgresJsBridgeConnection;
  readPolicy(): Promise<Readonly<{
    mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    revision: number;
  }>>;
  loadTask(taskId: string): Promise<TaskFacts | null>;
  loadRun(taskId: string, taskRunId: string): Promise<RunFacts | null>;
  resolveRequesterHuman(userId: string): Promise<Readonly<{
    id: string;
  }> | null>;
  resolveRequesterPrivateRoom(
    userId: string,
    agentId: string,
  ): Promise<Readonly<{
    roomId: string;
    namespaceId: string;
  }> | null>;
  createProductContext(
    userId: string,
    database: DirectDatabase,
  ): Promise<ProductContext>;
  inspectAuthority: typeof inspectInitialTaskRuntimeNamespaceAuthority;
}>;

function sameNullableBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.length === right.length
      && left.every((value, index) => value === right[index]);
}

function sameTask(left: TaskFacts, right: TaskFacts): boolean {
  return left.id === right.id
    && left.ownerId === right.ownerId
    && left.requestorId === right.requestorId
    && left.agentId === right.agentId
    && left.scheduleKind === right.scheduleKind
    && left.status === right.status
    && left.contentRepresentation === right.contentRepresentation
    && left.contentNamespaceId === right.contentNamespaceId
    && left.contentRevision === right.contentRevision
    && left.cryptoObjectId === right.cryptoObjectId
    && left.cryptoAccessRevision === right.cryptoAccessRevision
    && sameNullableBytes(
      left.cryptoRequiredNamespaceFingerprint,
      right.cryptoRequiredNamespaceFingerprint,
    )
    && left.cryptoMappingState === right.cryptoMappingState;
}

function sameRun(left: RunFacts, right: RunFacts): boolean {
  return left.id === right.id
    && left.taskId === right.taskId
    && left.jobId === right.jobId
    && left.status === right.status
    && left.completedAt?.getTime() === right.completedAt?.getTime()
    && left.resultRepresentation === right.resultRepresentation
    && left.resultContentNamespaceId === right.resultContentNamespaceId
    && left.resultRevision === right.resultRevision
    && left.resultCryptoObjectId === right.resultCryptoObjectId
    && left.resultCryptoAccessRevision === right.resultCryptoAccessRevision
    && sameNullableBytes(
      left.resultCryptoRequiredNamespaceFingerprint,
      right.resultCryptoRequiredNamespaceFingerprint,
    )
    && left.resultCryptoMappingState === right.resultCryptoMappingState;
}

function terminalCoordinateIsCurrent(
  coordinate: Extract<TaskContentCoordinateV1, { kind: "run_result" }>,
  task: TaskFacts,
  run: RunFacts,
): task is TaskFacts & Readonly<{
  contentRepresentation: "dual" | "protected";
  contentNamespaceId: string;
}> {
  if (task.id !== coordinate.taskId
    || run.id !== coordinate.taskRunId
    || run.taskId !== coordinate.taskId
    || run.jobId === null
    || (task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected")
    || task.contentNamespaceId === null
    || !Number.isSafeInteger(task.contentRevision)
    || task.contentRevision < 1
    || task.cryptoObjectId === null
    || !Number.isSafeInteger(task.cryptoAccessRevision)
    || task.cryptoAccessRevision < 0
    || task.cryptoRequiredNamespaceFingerprint?.length !== 32
    || task.cryptoMappingState !== "verified"
    || (run.status !== "completed" && run.status !== "errored")
    || run.completedAt === null
    || (task.scheduleKind === "cron"
      ? task.status !== "pending"
      : task.status !== run.status)) return false;

  if (run.resultRevision === coordinate.contentRevision) {
    return run.resultContentNamespaceId === task.contentNamespaceId
      && (run.resultRepresentation === "dual"
        || run.resultRepresentation === "protected")
      && run.resultCryptoObjectId !== null
      && Number.isSafeInteger(run.resultCryptoAccessRevision)
      && run.resultCryptoAccessRevision >= 0
      && run.resultCryptoRequiredNamespaceFingerprint?.length === 32
      && sameNullableBytes(
        run.resultCryptoRequiredNamespaceFingerprint,
        task.cryptoRequiredNamespaceFingerprint,
      )
      && run.resultCryptoMappingState === "verified";
  }
  return run.resultRevision === coordinate.contentRevision - 1
    && run.resultRevision === 0
    && run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped";
}

/**
 * Dark repository authority for a protected Task result after terminalization.
 * A RUNNING grant is intentionally absent: execution admission has ended, and
 * the repository's serializable final CAS remains the exact TaskRun mapping
 * owner after this current Namespace/Domain authority check.
 */
export function createProtectedTaskResultContentAuthorityResolver(
  coordinate: Extract<TaskContentCoordinateV1, { kind: "run_result" }>,
  overrides: Partial<ProtectedTaskResultContentAuthorityDependencies> = {},
): (expected: Readonly<{
  requesterHumanId: string;
  namespaceId: string;
}>) => Promise<TaskContentAuthorityV1 | null> {
  const db = overrides.db ?? getServerDirectDb();
  const crypto = overrides.crypto ?? new LatticeCrypto();
  const serverScope = overrides.serverScope
    ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim()
      || "http://localhost:3001");
  const restricted = overrides.restricted
    ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const readPolicy = overrides.readPolicy
    ?? (() => getEncryptionTransitionPolicy(db));
  const loadTask = overrides.loadTask ?? (async (taskId): Promise<TaskFacts | null> => {
    const rows = await db.select({
      id: tasks.id,
      ownerId: tasks.ownerId,
      requestorId: tasks.requestorId,
      agentId: tasks.agentId,
      scheduleKind: tasks.scheduleKind,
      status: tasks.status,
      contentRepresentation: tasks.contentRepresentation,
      contentNamespaceId: tasks.contentNamespaceId,
      contentRevision: tasks.contentRevision,
      cryptoObjectId: tasks.cryptoObjectId,
      cryptoAccessRevision: tasks.cryptoAccessRevision,
      cryptoRequiredNamespaceFingerprint:
        tasks.cryptoRequiredNamespaceFingerprint,
      cryptoMappingState: tasks.cryptoMappingState,
    }).from(tasks).where(eq(tasks.id, taskId)).limit(2);
    return rows.length === 1 ? rows[0]! : null;
  });
  const loadRun = overrides.loadRun ?? (async (
    taskId,
    taskRunId,
  ): Promise<RunFacts | null> => {
    const rows = await db.select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      jobId: taskRuns.jobId,
      status: taskRuns.status,
      completedAt: taskRuns.completedAt,
      resultRepresentation: taskRuns.resultRepresentation,
      resultContentNamespaceId: taskRuns.resultContentNamespaceId,
      resultRevision: taskRuns.resultRevision,
      resultCryptoObjectId: taskRuns.resultCryptoObjectId,
      resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
      resultCryptoRequiredNamespaceFingerprint:
        taskRuns.resultCryptoRequiredNamespaceFingerprint,
      resultCryptoMappingState: taskRuns.resultCryptoMappingState,
    }).from(taskRuns).where(and(
      eq(taskRuns.id, taskRunId),
      eq(taskRuns.taskId, taskId),
    )).limit(2);
    return rows.length === 1 ? rows[0]! : null;
  });
  const resolveRequesterHuman = overrides.resolveRequesterHuman
    ?? findActorByOwnerId;
  const resolveRequesterPrivateRoom = overrides.resolveRequesterPrivateRoom
    ?? findAgentOwnerPrivateRoom;
  const createProductContext = overrides.createProductContext
    ?? createHumanProductTransactionContext;
  const inspectAuthority = overrides.inspectAuthority
    ?? inspectInitialTaskRuntimeNamespaceAuthority;

  if (coordinate.kind !== "run_result"
    || coordinate.contentRevision < 1) {
    throw new TypeError("Protected Task result coordinate is invalid");
  }

  return async (expected) => {
    const [task, run, policy] = await Promise.all([
      loadTask(coordinate.taskId),
      loadRun(coordinate.taskId, coordinate.taskRunId),
      readPolicy(),
    ]);
    if (task === null || run === null
      || !terminalCoordinateIsCurrent(coordinate, task, run)
      || policy.mode === "plaintext_only") return null;

    const [human, room] = await Promise.all([
      resolveRequesterHuman(task.requestorId),
      resolveRequesterPrivateRoom(task.requestorId, task.agentId),
    ]);
    if (human === null || room === null
      || expected.requesterHumanId !== human.id
      || expected.namespaceId !== task.contentNamespaceId
      || room.namespaceId !== task.contentNamespaceId) return null;

    const product = await createProductContext(task.requestorId, db);
    const inspected = await inspectAuthority({
      runner: product.canonicalRunner,
      restricted: restricted(),
      crypto,
      serverScope,
      taskId: task.id,
      requesterUserId: task.requestorId,
      requesterHumanId: human.id,
      agentId: task.agentId,
      contentNamespaceId: task.contentNamespaceId,
      sourceRoomId: room.roomId,
      namespaceIds: Object.freeze([task.contentNamespaceId]),
      expectedPolicyRevision: policy.revision,
    });
    if (inspected === null
      || inspected.sourceRoomId !== room.roomId
      || inspected.sourceNamespaceId !== task.contentNamespaceId
      || inspected.facts.length !== 1) return null;
    const fact = inspected.facts[0]!;
    if (fact.namespaceId !== task.contentNamespaceId
      || fact.expectedPolicyRevision !== policy.revision) return null;

    const [currentTask, currentRun] = await Promise.all([
      loadTask(coordinate.taskId),
      loadRun(coordinate.taskId, coordinate.taskRunId),
    ]);
    if (currentTask === null || currentRun === null
      || !sameTask(task, currentTask)
      || !sameRun(run, currentRun)
      || !terminalCoordinateIsCurrent(coordinate, currentTask, currentRun)) {
      return null;
    }
    return Object.freeze({
      authorityVersion: 1,
      kind: "requester_private_namespace",
      keyClass: "ai",
      requesterHumanId: human.id,
      namespaceId: fact.namespaceId,
      domainId: fact.domainId,
      expectedAccessRevision: fact.expectedAccessRevision,
      expectedPolicyRevision: fact.expectedPolicyRevision,
    });
  };
}
