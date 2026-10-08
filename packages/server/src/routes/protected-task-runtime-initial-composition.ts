import { log } from "@nautilo/logger";
import { createProtectedTaskPublishedResultRecovery } from
  "./protected-task-published-result-recovery";
import {
  createProtectedTaskCancellationRecovery,
  type ProtectedTaskCancellationRecoveryCursor,
} from "./protected-task-cancellation-recovery";
import {
  createProtectedTaskPreexecutionRecovery,
  type ProtectedTaskPreexecutionRecoveryPageCursor,
} from "./protected-task-preexecution-recovery";
import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  acceptProtectedTaskRunOutputBinding,
  createPostgresJsBridgeConnection,
  getSharedDirectCryptoDb,
  rooms,
  startProtectedTaskRun,
  taskRuns,
  tasks,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  type ProtectedTaskRunOutputRecoveryCursor,
} from "@nautilo/db";
import {
  LatticeCrypto,
  type TaskRuntimeRecipientRegistry,
} from "@nautilo/lattice-crypto";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import type {
  EncryptionDataOperationOwner,
  ProtectedAgentMemoryEmbeddingPort,
} from "@nautilo/lattice-bridge";
import { verifyCryptoPostgresHandle } from "@nautilo/lattice-bridge/server";
import {
  createProtectedTaskOccurrenceCoordinator,
  createTaskRuntimeGrantClaim,
  PostgresBackgroundAuthorizationRepository,
  TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
  type ProtectedTaskOccurrence,
  type ProtectedTaskOccurrenceCoordinator,
  type ProtectedTaskOccurrenceJobManager,
} from "@nautilo/runtime";
import type { PolicyResolver } from "@nautilo/trust";

import { createHumanProductTransactionContext } from
  "./human-message-product-store";
import { createProductionProtectedTaskNativeExecution } from
  "./protected-task-native-execution-composition";
import type { ProtectedTaskNativeFixedMemorySegmentInput } from
  "./protected-task-native-fixed-memory-segment";
import { createProductionProtectedTaskPredispatch } from
  "./protected-task-predispatch-composition";
import {
  createProtectedTaskRuntimeInitialDeviceAuthorization,
} from "./protected-task-runtime-initial-device-authorization";
import { createProtectedTaskRuntimeNamespaceAuthorityResolver } from
  "./protected-task-runtime-namespace-authority";
import { createProtectedTaskRuntimeRecipientAuthorityPort } from
  "./protected-task-runtime-recipient-authority";
import { createProtectedTaskRuntimeGrantPlanBuilder } from
  "./protected-task-runtime-grant-plan";
import { createProtectedTaskScopeMemoryInventoryResolver } from
  "./protected-task-scope-memory-inventory";
import {
  createCurrentProtectedTaskRuntimeAuthorityPort,
  createCurrentProtectedTaskRuntimeClaimAuthorityPort,
} from "./task-runtime-current-authority";
import type { createProductionBackgroundAuthorizationComposition } from
  "./background-authorization-composition";

type DeviceHooks = Required<Pick<NonNullable<Parameters<
  typeof createProductionBackgroundAuthorizationComposition
>[0]>, "bindTaskRecipient" | "withTaskAuthority" | "isTaskRecipientActive">>;

export type ProductionProtectedTaskRuntimeInitialCompositionInput = Readonly<{
  db: DirectDatabase;
  resolver: PolicyResolver;
  convergeCreatedRoomCatalog:
    Parameters<typeof createProductionProtectedTaskPredispatch>[0]["convergeCreatedRoomCatalog"];
  owner: EncryptionDataOperationOwner;
  recipients: TaskRuntimeRecipientRegistry;
  jobManager: ProtectedTaskOccurrenceJobManager;
  kick(): void;
  restricted?: PostgresJsBridgeConnection;
  crypto?: LatticeCrypto;
  serverScope?: string;
  embedding?: ProtectedAgentMemoryEmbeddingPort;
  createDedicatedPool?: ProtectedTaskNativeFixedMemorySegmentInput["createDedicatedPool"];
  now?: () => number;
}>;

export type ProductionProtectedTaskRuntimeInitialComposition = Readonly<
  DeviceHooks & {
    coordinator: ProtectedTaskOccurrenceCoordinator;
    wakeProtectedTask(): void;
  }
>;

type Dependencies = Readonly<{
  productContext: typeof createHumanProductTransactionContext;
  nativeExecution: typeof createProductionProtectedTaskNativeExecution;
}>;

const productionDependencies: Dependencies = Object.freeze({
  productContext: createHumanProductTransactionContext,
  nativeExecution: createProductionProtectedTaskNativeExecution,
});

function projectOccurrence(
  row: Readonly<{
    task: Readonly<{
      id: string;
      ownerId: string;
      requestorId: string;
      agentId: string;
      callingRoomId: string | null;
      scheduleKind: "now" | "one_shot" | "cron";
      contentRepresentation: "ordinary" | "dual" | "protected";
      contentNamespaceId: string | null;
      contentRevision: number;
      cryptoObjectId: string | null;
      cryptoAccessRevision: number;
      cryptoRequiredNamespaceFingerprint: Uint8Array | null;
      cryptoMappingState: string;
      status: string;
    }>;
    run: Readonly<{
      id: string;
      taskId: string;
      jobId: string | null;
      graphThreadId: string;
      status: string;
      startedAt: Date;
      modelId: string | null;
      completedAt: Date | null;
      resultRepresentation: string;
      resultContentNamespaceId: string | null;
      resultRevision: number;
      resultCryptoObjectId: string | null;
      resultCryptoAccessRevision: number;
      resultCryptoRequiredNamespaceFingerprint: Uint8Array | null;
      resultCryptoMappingState: string;
    }>;
  }>,
): ProtectedTaskOccurrence | null {
  const { task, run } = row;
  if ((task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected")
    || task.contentNamespaceId === null
    || task.cryptoObjectId === null
    || task.cryptoRequiredNamespaceFingerprint === null
    || task.cryptoRequiredNamespaceFingerprint.length !== 32
    || task.cryptoMappingState !== "verified"
    || !["pending", "awaiting", "running"].includes(task.status)
    || run.taskId !== task.id
    || run.status !== "awaiting"
    || run.jobId !== null
    || run.modelId !== null
    || run.completedAt !== null
    || run.resultRepresentation !== "ordinary"
    || run.resultContentNamespaceId !== null
    || run.resultRevision !== 0
    || run.resultCryptoObjectId !== null
    || run.resultCryptoAccessRevision !== 0
    || run.resultCryptoRequiredNamespaceFingerprint !== null
    || run.resultCryptoMappingState !== "unmapped") return null;
  return Object.freeze({
    task: Object.freeze({
      id: task.id,
      ownerId: task.ownerId,
      requestorId: task.requestorId,
      agentId: task.agentId,
      callingRoomId: task.callingRoomId,
      scheduleKind: task.scheduleKind,
      contentRepresentation: task.contentRepresentation,
      contentNamespaceId: task.contentNamespaceId,
      contentRevision: task.contentRevision,
      cryptoObjectId: task.cryptoObjectId,
      cryptoAccessRevision: task.cryptoAccessRevision,
      cryptoRequiredNamespaceFingerprint:
        new Uint8Array(task.cryptoRequiredNamespaceFingerprint),
    }),
    run: Object.freeze({
      id: run.id,
      taskId: run.taskId,
      jobId: null,
      graphThreadId: run.graphThreadId,
      status: "awaiting" as const,
      startedAt: new Date(run.startedAt.getTime()),
    }),
  });
}

/** Operational-only exact lookup used by initial device request recovery. */
export async function loadInitialProtectedTaskOccurrence(
  db: DirectDatabase,
  input: Readonly<{ taskRunId: string; authorizationRequestId: string }>,
): Promise<ProtectedTaskOccurrence | null> {
  if (input.authorizationRequestId
    !== `task-run-authorization:${input.taskRunId}`) return null;
  const rows = await db.select({
    task: {
      id: tasks.id,
      ownerId: tasks.ownerId,
      requestorId: tasks.requestorId,
      agentId: tasks.agentId,
      callingRoomId: tasks.callingRoomId,
      scheduleKind: tasks.scheduleKind,
      contentRepresentation: tasks.contentRepresentation,
      contentNamespaceId: tasks.contentNamespaceId,
      contentRevision: tasks.contentRevision,
      cryptoObjectId: tasks.cryptoObjectId,
      cryptoAccessRevision: tasks.cryptoAccessRevision,
      cryptoRequiredNamespaceFingerprint:
        tasks.cryptoRequiredNamespaceFingerprint,
      cryptoMappingState: tasks.cryptoMappingState,
      status: tasks.status,
    },
    run: {
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      jobId: taskRuns.jobId,
      graphThreadId: taskRuns.graphThreadId,
      status: taskRuns.status,
      startedAt: taskRuns.startedAt,
      modelId: taskRuns.modelId,
      completedAt: taskRuns.completedAt,
      resultRepresentation: taskRuns.resultRepresentation,
      resultContentNamespaceId: taskRuns.resultContentNamespaceId,
      resultRevision: taskRuns.resultRevision,
      resultCryptoObjectId: taskRuns.resultCryptoObjectId,
      resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
      resultCryptoRequiredNamespaceFingerprint:
        taskRuns.resultCryptoRequiredNamespaceFingerprint,
      resultCryptoMappingState: taskRuns.resultCryptoMappingState,
    },
  }).from(taskRuns).innerJoin(tasks, eq(tasks.id, taskRuns.taskId)).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.status, "awaiting"),
    isNull(taskRuns.jobId),
    inArray(tasks.status, ["pending", "awaiting", "running"]),
    inArray(tasks.contentRepresentation, ["dual", "protected"]),
    eq(tasks.cryptoMappingState, "verified"),
  )).limit(2);
  return rows.length === 1 ? projectOccurrence(rows[0]!) : null;
}

/**
 * Connects the initial protected occurrence, device grant and native execution
 * owners. Construction is inert; the caller decides when to mount each hook.
 */
export async function createProductionProtectedTaskRuntimeInitialComposition(
  input: ProductionProtectedTaskRuntimeInitialCompositionInput,
  overrides: Partial<Dependencies> = {},
): Promise<ProductionProtectedTaskRuntimeInitialComposition> {
  const dependencies = Object.freeze({ ...productionDependencies, ...overrides });
  const crypto = input.crypto ?? new LatticeCrypto();
  const restricted = input.restricted
    ?? createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
  const serverScope = input.serverScope
    ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim()
      || "http://localhost:3001");
  const now = input.now ?? Date.now;
  const repository = new PostgresBackgroundAuthorizationRepository(
    await verifyCryptoPostgresHandle(restricted),
  );
  const recovery = createProtectedTaskPreexecutionRecovery({
    db: input.db, repository, now,
  });
  let recoveryCursor: ProtectedTaskPreexecutionRecoveryPageCursor | undefined;
  const cancellation = createProtectedTaskCancellationRecovery({
    db: input.db, repository, recipients: input.recipients, now,
  });
  let cancellationCursor: ProtectedTaskCancellationRecoveryCursor | undefined;
  const published = createProtectedTaskPublishedResultRecovery({
    db: input.db, repository, recipients: input.recipients, now,
  });
  let publishedCursor: ProtectedTaskRunOutputRecoveryCursor | undefined;
  const predispatch = createProductionProtectedTaskPredispatch({
    db: input.db,
    resolver: input.resolver,
    convergeCreatedRoomCatalog: input.convergeCreatedRoomCatalog,
  });
  const nativeExecution = dependencies.nativeExecution({
    db: input.db,
    restricted,
    crypto,
    serverScope,
    owner: input.owner,
    ...(input.embedding === undefined ? {} : { embedding: input.embedding }),
    ...(input.createDedicatedPool === undefined
      ? {}
      : { createDedicatedPool: input.createDedicatedPool }),
    ...(input.now === undefined ? {} : { now }),
  });
  const plan = createProtectedTaskRuntimeGrantPlanBuilder({
    crypto,
    recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
    predispatch,
    resolveScopeMemoryInventory:
      createProtectedTaskScopeMemoryInventoryResolver({ db: input.db }),
    resolveNamespaceAuthority:
      createProtectedTaskRuntimeNamespaceAuthorityResolver({
        db: input.db,
        crypto,
        serverScope,
        restricted: () => restricted,
      }),
    resolveOutputDestination: async occurrence => {
      if (occurrence.task.callingRoomId === null) return null;
      const rows = await input.db.select({
        roomId: rooms.id,
        namespaceId: rooms.namespaceId,
      }).from(rooms).where(and(
        eq(rooms.id, occurrence.task.callingRoomId),
        isNull(rooms.archivedAt),
      )).limit(2);
      return rows.length === 1 ? Object.freeze(rows[0]!) : null;
    },
    acceptOutputBinding: value =>
      acceptProtectedTaskRunOutputBinding(input.db, value),
    prepareExecution: nativeExecution.prepareExecution,
    startProtectedTaskRun: value => startProtectedTaskRun(input.db, value),
    deferBeforeExecution: value => recovery.recover(value, { immediate: true }),
    publishResult: nativeExecution.publishResult,
    now,
  });
  const current = createCurrentProtectedTaskRuntimeAuthorityPort();
  const currentClaim = createCurrentProtectedTaskRuntimeClaimAuthorityPort();
  const withCurrentAuthority: Parameters<
    typeof createTaskRuntimeGrantClaim
  >[0]["withCurrentAuthority"] = async operation => {
    const parsed = parseDomainForegroundAuthorizationPlanV2(
      operation.request.authorizationPlanBytes,
    );
    if (parsed === null) return null;
    try {
      const product = await dependencies.productContext(
        operation.occurrence.task.requestorId,
        input.db,
      );
      return current({
        ...operation,
        runner: product.canonicalRunner,
        restricted,
        crypto,
        serverScope,
        subject: Object.freeze({
          userId: operation.occurrence.task.requestorId,
          humanActorId: parsed.subjectHumanId,
          deviceId: parsed.committerDeviceId,
        }),
        now,
      });
    } finally {
      destroyDomainForegroundAuthorizationPlanV2(parsed);
    }
  };
  const withCurrentClaimAuthority: Parameters<
    typeof createTaskRuntimeGrantClaim
  >[0]["withCurrentClaimAuthority"] = async operation => {
    const parsed = parseDomainForegroundAuthorizationPlanV2(
      operation.request.authorizationPlanBytes,
    );
    if (parsed === null) return null;
    try {
      const product = await dependencies.productContext(
        operation.occurrence.task.requestorId,
        input.db,
      );
      return currentClaim({
        ...operation,
        runner: product.canonicalRunner,
        restricted,
        crypto,
        serverScope,
        subject: Object.freeze({
          userId: operation.occurrence.task.requestorId,
          humanActorId: parsed.subjectHumanId,
          deviceId: parsed.committerDeviceId,
        }),
      });
    } finally {
      destroyDomainForegroundAuthorizationPlanV2(parsed);
    }
  };
  const claim = createTaskRuntimeGrantClaim({
    repository,
    recipients: input.recipients,
    plan,
    withCurrentAuthority,
    withCurrentClaimAuthority,
    now,
  });
  const recipientAuthority = createProtectedTaskRuntimeRecipientAuthorityPort({
    db: input.db,
    crypto,
    serverScope,
    restricted: () => restricted,
  });
  const hooks = createProtectedTaskRuntimeInitialDeviceAuthorization({
    recipients: input.recipients,
    claim,
    plan,
    resolveOccurrence: coordinates =>
      loadInitialProtectedTaskOccurrence(input.db, coordinates),
    withRecipientAuthority: recipientAuthority,
    now,
  });
  const coordinator = createProtectedTaskOccurrenceCoordinator({
    authorization: claim,
    recoverBeforeObservation: async limit => {
      const cancelled = await cancellation.recoverPage({
        limit,
        ...(cancellationCursor === undefined ? {} : { after: cancellationCursor }),
      });
      cancellationCursor = cancelled.next;
      if (cancelled.failures > 0) {
        log("[task-observer] protected cancellation recovery deferred code=PROTECTED_STOP_RECOVERY_RETRY");
      }
      const publications = await published.recoverPage({
        limit,
        ...(publishedCursor === undefined ? {} : { after: publishedCursor }),
      });
      publishedCursor = publications.next;
      if (publications.failures > 0) {
        log("[task-observer] protected result settlement deferred code=PROTECTED_RESULT_SETTLEMENT_RETRY");
      }
      const page = await recovery.recoverPage({
        limit, ...(recoveryCursor === undefined ? {} : { after: recoveryCursor }),
      });
      recoveryCursor = page.next;
      if (page.failures > 0) {
        log("[task-observer] protected pre-execution recovery deferred code=PROTECTED_START_RECOVERY_RETRY");
      }
    },
    jobManager: input.jobManager,
    kick: input.kick,
  });
  return Object.freeze({
    coordinator,
    ...hooks,
    wakeProtectedTask: () => coordinator.authorizationAccepted(),
  });
}
