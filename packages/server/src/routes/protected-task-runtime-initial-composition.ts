import { log } from "@nautilo/logger";
import { createProtectedTaskCancellationComposition } from "./protected-task-cancellation-composition";
import { createProtectedTaskTerminalMessageComposition } from "./protected-task-terminal-message-composition";
import { createProtectedTaskRunningRecovery } from "./protected-task-running-recovery";
import { createProtectedTaskOutputReadComposition } from "./protected-task-output-read-composition";
import { createProtectedTaskWakeForegroundComposition } from "./protected-task-wake-foreground-composition";
import { createProtectedTaskWakeForegroundServices } from "./protected-task-wake-foreground-services";
import { inspectProtectedTaskLocalExecutionReadiness } from "./protected-task-local-execution";
import { createDedicatedEncryptedCheckpointPool } from "@nautilo/agent";
import { createProtectedTaskRuntimeParkedContinuation } from "./protected-task-runtime-parked-continuation";
import { createProtectedTaskParkedAuthorizationSettlement } from "./protected-task-parked-authorization-settlement";
import { createProtectedTaskParkedPreexecutionRecovery } from "./protected-task-parked-preexecution-recovery";
import { createProtectedTaskRuntimeParkedPreparation } from "./protected-task-runtime-parked-preparation";
import { createProtectedTaskRuntimeParkedDeviceAuthorization } from "./protected-task-runtime-parked-device-authorization";
import { createProtectedTaskPublishedResultRecovery } from
  "./protected-task-published-result-recovery";
import { createProtectedTaskUnmappedResultRecovery } from
  "./protected-task-unmapped-result-recovery";
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
  listProtectedTaskWakeExecutionCandidates,
  type ProtectedTaskWakeDiscoveryCursor,
  rooms,
  startProtectedTaskRun,
  taskRuns,
  tasks,
  protectedTaskDefinitionHistoricalRepairProjection,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  type ProtectedTaskRunOutputRecoveryCursor,
  type ProtectedTaskCancellationOutputDiscoveryCursor,
  type ProtectedTaskRunningRecoveryCursor,
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
import { parseTaskHistoricalRepairProvenanceV1 } from "@nautilo/lattice-bridge";
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
import { createProtectedTaskWakeForegroundAdmission } from "./protected-task-wake-foreground-admission";
import { createProtectedTaskCheckpointPauseRecovery } from "./protected-task-checkpoint-pause-recovery";
import { createProtectedTaskRuntimeMappedHeadReplan } from "./protected-task-runtime-mapped-head-replan";
import { createProtectedTaskExecutionPreparation } from "./protected-task-execution-preparation";
import type { ProductionProtectedTaskNativeExecution } from
  "./protected-task-native-execution-composition";
import type { ProtectedTaskCheckpointPauseRecoveryCursor } from "@nautilo/db";

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
  authorizationRequested?(requestorUserId: string): void | Promise<void>;
  restricted?: PostgresJsBridgeConnection;
  crypto?: LatticeCrypto;
  serverScope?: string;
  embedding?: ProtectedAgentMemoryEmbeddingPort;
  createDedicatedPool?: ProtectedTaskNativeFixedMemorySegmentInput["createDedicatedPool"];
  now?: () => number;
  prepareExternalExecution?: Pick<Parameters<typeof createProtectedTaskExecutionPreparation>[0], "claude" | "codex" | "hermes" | "opencode" | "deepResearch">;
  wakeForeground?: Pick<Parameters<typeof createProtectedTaskWakeForegroundComposition>[0],
    "jobManager" | "executor" | "onDiagnostic"> & Readonly<{ wakeEffectRecovery(): void }>;
}>;

export type ProductionProtectedTaskRuntimeInitialComposition = Readonly<
  DeviceHooks & {
    coordinator: ProtectedTaskOccurrenceCoordinator;
    wakeProtectedTask(): void;
    close(): Promise<void>;
  }
>;

type Dependencies = Readonly<{
  productContext: typeof createHumanProductTransactionContext;
  nativeExecution: typeof createProductionProtectedTaskNativeExecution;
  unmappedResultRecovery: typeof createProtectedTaskUnmappedResultRecovery;
  terminalMessageComposition: typeof createProtectedTaskTerminalMessageComposition;
  localExecutionReadiness: typeof inspectProtectedTaskLocalExecutionReadiness;
  grantClaim: typeof createTaskRuntimeGrantClaim;
}>;

const productionDependencies: Dependencies = Object.freeze({
  productContext: createHumanProductTransactionContext,
  nativeExecution: createProductionProtectedTaskNativeExecution,
  unmappedResultRecovery: createProtectedTaskUnmappedResultRecovery,
  terminalMessageComposition: createProtectedTaskTerminalMessageComposition,
  localExecutionReadiness: inspectProtectedTaskLocalExecutionReadiness,
  grantClaim: createTaskRuntimeGrantClaim,
});

export function createProtectedTaskRuntimeInitialExecutionPreparation(
  db: DirectDatabase,
  nativeExecution: ProductionProtectedTaskNativeExecution,
  external?: ProductionProtectedTaskRuntimeInitialCompositionInput[
    "prepareExternalExecution"
  ],
) {
  return createProtectedTaskExecutionPreparation({
    db,
    native: nativeExecution.prepareExecution,
    ...(external === undefined ? {} : external),
    repoDocs: nativeExecution.prepareRepoDocsExecution,
  });
}

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
      definitionHistoricalRepair?: Readonly<Record<string, unknown>> | null;
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
      ...(task.definitionHistoricalRepair == null ? {} : {
        definitionHistoricalRepair: parseTaskHistoricalRepairProvenanceV1(task.definitionHistoricalRepair),
      }),
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
      definitionHistoricalRepair: protectedTaskDefinitionHistoricalRepairProjection,
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
  const cryptoHandle = await verifyCryptoPostgresHandle(restricted);
  const repository = new PostgresBackgroundAuthorizationRepository(
    cryptoHandle,
  );
  const parkedRecovery = createProtectedTaskParkedPreexecutionRecovery({
    db: input.db, repository, now,
  });
  const recovery = createProtectedTaskPreexecutionRecovery({
    db: input.db, repository, now, recoverParked: parkedRecovery.recoverDiscovered,
  });
  let recoveryCursor: ProtectedTaskPreexecutionRecoveryPageCursor | undefined;
  const cancellation = createProtectedTaskCancellationRecovery({
    db: input.db, repository, recipients: input.recipients, now,
  });
  let cancellationCursor: ProtectedTaskCancellationRecoveryCursor | undefined;
  const cancellationOutput = createProtectedTaskCancellationComposition({
    db: input.db, restricted, crypto, owner: input.owner, serverScope,
    recipients: input.recipients,
    authorizationRequested: input.authorizationRequested,
    recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS, now,
  });
  let cancellationOutputCursor: ProtectedTaskCancellationOutputDiscoveryCursor | undefined;
  const outputRead = createProtectedTaskOutputReadComposition({
    db: input.db, restricted, crypto, owner: input.owner, serverScope,
    recipients: input.recipients,
    authorizationRequested: input.authorizationRequested,
    recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS, now,
    canonicalWakeForegroundAdmission: createProtectedTaskWakeForegroundAdmission({
      db: input.db, resolver: input.resolver,
    }),
    ...(input.wakeForeground === undefined ? {} : {
      createWakePublication: authority => createProtectedTaskWakeForegroundComposition({
        ...input.wakeForeground!, restricted, crypto, owner: input.owner, serverScope,
        resolver: input.resolver, authority,
        createProtectedServices: operation => createProtectedTaskWakeForegroundServices({ ...operation,
          crypto, restricted, serverScope, wakeEffectRecovery: input.wakeForeground!.wakeEffectRecovery,
          ...(input.embedding === undefined ? {} : { embedding: input.embedding }) }),
      }),
    }),
  });
  let wakeCursor: ProtectedTaskWakeDiscoveryCursor | undefined;
  let closed = false;
  const activeWakes = new Map<string, Readonly<{ controller: AbortController; completion: Promise<void> }>>();
  const observeWakes = async (limit: number) => {
    if (closed || input.wakeForeground === undefined || limit <= activeWakes.size) return;
    const observe = async () => {
      const page = await listProtectedTaskWakeExecutionCandidates(input.db, {
        limit: limit - activeWakes.size,
        throughTime: wakeCursor?.throughTime ?? new Date(now()),
        ...(wakeCursor === undefined ? {} : { cursor: wakeCursor }),
      });
      wakeCursor = page.next ?? undefined;
      for (const candidate of page.candidates) {
        if (closed || candidate.state !== "awaiting_authority" || activeWakes.has(candidate.jobId)) continue;
        const controller = new AbortController();
        // Keep the claim and all grant custody owned until the adopted Job drains.
        // Reuse the observer's existing pass budget to bound process-local owners.
        const completion = outputRead.executeWake({ taskId: candidate.taskId, taskRunId: candidate.taskRunId }, controller.signal)
          .then(() => undefined, error => {
            input.wakeForeground?.onDiagnostic?.("agent_input", error);
            if (!closed) log("[task-observer] protected wake deferred code=PROTECTED_WAKE_RETRY");
          }).finally(() => {
            if (activeWakes.get(candidate.jobId)?.controller === controller) activeWakes.delete(candidate.jobId);
          });
        activeWakes.set(candidate.jobId, { controller, completion });
      }
    };
    await input.owner.runMutation({ ordinary: () => Promise.resolve(), protected: observe, dual: observe });
  };
  const terminalMessageOutput = dependencies.terminalMessageComposition({
    db: input.db, restricted, crypto, owner: input.owner, serverScope,
    recipients: input.recipients,
    authorizationRequested: input.authorizationRequested,
    recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS, now,
    deliverResult: outputRead.deliverResult,
  });
  let terminalMessageOutputCursor: ProtectedTaskRunOutputRecoveryCursor | undefined;
  const unmapped = dependencies.unmappedResultRecovery({
    db: input.db,
    restricted,
    crypto,
    cryptoHandle,
    serverScope,
    recipients: input.recipients,
    now,
  }, { createProductContext: dependencies.productContext });
  const published = createProtectedTaskPublishedResultRecovery({
    db: input.db,
    repository,
    recipients: input.recipients,
    recoverUnmapped: unmapped.recover,
    now,
  });
  let publishedCursor: ProtectedTaskRunOutputRecoveryCursor | undefined;
  const checkpointPauses = createProtectedTaskCheckpointPauseRecovery({ db: input.db });
  let checkpointPauseCursor: ProtectedTaskCheckpointPauseRecoveryCursor | undefined;
  const abandoned = createProtectedTaskRunningRecovery({
    db: input.db, repository, recipients: input.recipients, now,
  });
  let abandonedCursor: Readonly<{
    through: ProtectedTaskRunningRecoveryCursor;
    after: ProtectedTaskRunningRecoveryCursor;
  }> | undefined;
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
  const prepareExecution = createProtectedTaskRuntimeInitialExecutionPreparation(
    input.db,
    nativeExecution,
    input.prepareExternalExecution,
  );
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
    prepareExecution,
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
  const claim = dependencies.grantClaim({
    repository,
    recipients: input.recipients,
    plan,
    withCurrentAuthority,
    withCurrentClaimAuthority,
    authorizationRequested: occurrence =>
      input.authorizationRequested?.(occurrence.task.requestorId),
    now,
  });
  const parked = createProtectedTaskRuntimeParkedContinuation({
    db: input.db, restricted, crypto, serverScope, resolver: input.resolver,
    recipients: input.recipients, repository, withCurrentAuthority,
    prepareExecution,
    publishResult: nativeExecution.publishResult,
    createDedicatedPool: input.createDedicatedPool ?? createDedicatedEncryptedCheckpointPool,
    recoverUnstarted: parkedRecovery,
    recoverClaim: parkedRecovery.recoverClaim,
    now,
  });
  const parkedSettlement = createProtectedTaskParkedAuthorizationSettlement({
    db: input.db, repository, recipients: input.recipients,
  });
  const prepareParked = createProtectedTaskRuntimeParkedPreparation({
    resolver: input.resolver, recipients: input.recipients,
    authorizationRequested: input.authorizationRequested,
  }, { db: input.db, crypto, serverScope, now,
    restricted: () => restricted, productContext: dependencies.productContext });
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
    mappedHeadReplan: createProtectedTaskRuntimeMappedHeadReplan({
      db: input.db, crypto, serverScope, recipients: input.recipients, now,
    }),
    now,
  });
  const parkedHooks = createProtectedTaskRuntimeParkedDeviceAuthorization({
    resolver: input.resolver, recipients: input.recipients,
  }, { db: input.db, crypto, serverScope, now,
    productContext: dependencies.productContext });
  const isInitialRequest = (record: Parameters<DeviceHooks["isTaskRecipientActive"]>[0]) =>
    record.snapshot.requestId === `task-run-authorization:${record.snapshot.workId}`;
  const coordinator = createProtectedTaskOccurrenceCoordinator({
    authorization: {
      prepareOrClaimExact: async occurrence => {
        const localExecution = await dependencies.localExecutionReadiness({
          db: input.db, occurrence,
        });
        if (localExecution.status === "waiting") {
          return Object.freeze({ status: "awaiting_authorization" as const });
        }
        if (occurrence.run.jobId === null) return claim.prepareOrClaimExact(occurrence);
        const settled = await parkedSettlement.settle(occurrence);
        if (settled !== "settled") {
          return Object.freeze({ status: settled === "inactive"
            ? "inactive" as const : "awaiting_authorization" as const });
        }
        await parkedRecovery.recoverExpiredClaim(occurrence);
        await prepareParked(occurrence);
        return parked.prepareOrClaimExact(occurrence);
      },
    },
    recoverBeforeObservation: async limit => {
      await observeWakes(limit);
      const cancelled = await cancellation.recoverPage({
        limit,
        ...(cancellationCursor === undefined ? {} : { after: cancellationCursor }),
      });
      cancellationCursor = cancelled.next;
      if (cancelled.failures > 0) {
        log("[task-observer] protected cancellation recovery deferred code=PROTECTED_STOP_RECOVERY_RETRY");
      }
      const stoppedOutputs = await cancellationOutput.recoverPage({
        limit, ...(cancellationOutputCursor === undefined ? {} : { after: cancellationOutputCursor }),
      });
      cancellationOutputCursor = stoppedOutputs.next;
      if (stoppedOutputs.failures > 0) {
        log("[task-observer] protected cancellation output deferred code=PROTECTED_STOP_OUTPUT_RETRY");
      }
      const terminalMessages = await terminalMessageOutput.recoverPage({
        limit, ...(terminalMessageOutputCursor === undefined ? {} : { after: terminalMessageOutputCursor }),
      });
      terminalMessageOutputCursor = terminalMessages.next;
      if (terminalMessages.failures > 0) {
        log("[task-observer] protected terminal delivery deferred code=PROTECTED_TERMINAL_DELIVERY_RETRY");
      }
      const publications = await published.recoverPage({
        limit,
        ...(publishedCursor === undefined ? {} : { after: publishedCursor }),
      });
      publishedCursor = publications.next;
      if (publications.failures > 0) {
        log("[task-observer] protected result settlement deferred code=PROTECTED_RESULT_SETTLEMENT_RETRY");
      }
      const abandonedRuns = await abandoned.recoverPage({
        limit, ...(abandonedCursor === undefined ? {} : abandonedCursor),
      });
      abandonedCursor = abandonedRuns.next;
      if (abandonedRuns.failures > 0) {
        log("[task-observer] protected abandoned execution deferred code=PROTECTED_RUNNING_RECOVERY_RETRY");
      }
      const page = await recovery.recoverPage({
        limit, ...(recoveryCursor === undefined ? {} : { after: recoveryCursor }),
      });
      recoveryCursor = page.next;
      if (page.failures > 0) {
        log("[task-observer] protected pre-execution recovery deferred code=PROTECTED_START_RECOVERY_RETRY");
      }
      const pauses = await checkpointPauses.recoverPage({
        limit, ...(checkpointPauseCursor === undefined ? {} : { after: checkpointPauseCursor }),
      });
      checkpointPauseCursor = pauses.next ?? undefined;
      if (pauses.failures > 0) {
        log("[task-observer] protected checkpoint pause deferred code=PROTECTED_PAUSE_RECOVERY_RETRY");
      }
    },
    jobManager: input.jobManager,
    kick: input.kick,
  });
  const deviceHooks = (record: Parameters<DeviceHooks["isTaskRecipientActive"]>[0]) =>
    record.workKind === "task.deliver_result" || record.workKind === "task.delivery_wake" ? outputRead
      : record.workKind === "task.deliver_message" ? terminalMessageOutput
      : record.workKind === "task.cancel_result" ? cancellationOutput
      : isInitialRequest(record) ? hooks : parkedHooks;
  return Object.freeze({
    coordinator,
    bindTaskRecipient: operation => deviceHooks(operation.record)
      .bindTaskRecipient(operation),
    withTaskAuthority: operation => deviceHooks(operation.record)
      .withTaskAuthority(operation),
    isTaskRecipientActive: record => deviceHooks(record)
      .isTaskRecipientActive(record),
    wakeProtectedTask: () => coordinator.authorizationAccepted(),
    close: async () => {
      closed = true;
      const current = [...activeWakes.values()];
      for (const operation of current) operation.controller.abort();
      await Promise.allSettled(current.map(operation => operation.completion));
      activeWakes.clear();
    },
  });
}
