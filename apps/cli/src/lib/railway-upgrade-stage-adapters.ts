import {
  PortableTransferCoordinator,
  type MaintenanceProviderWorkflowCheckpoint,
  type MaintenanceReceipt,
  type PortableTransferAuthority,
} from "@nautilo/hosting";
import {
  RailwayGraphqlReconcileExecutor,
  RailwayGraphqlWholeManifestUpgradeExecutor,
  RailwayPortableMaintenanceCleanup,
  RailwayPortableMaintenanceTarget,
  RailwayVolumeBackupExecutor,
  runRailwayWholeManifestUpgrade,
  waitForRailwayHttpsReadiness,
  type RailwayDesiredStateTarget,
  type RailwayMaintenanceBackupTarget,
  type RailwayPortableMaintenanceBinding,
  type RailwayReconcileExecutorTransport,
  type RailwayTopology,
  type RailwayVariableProjectionInputs,
  type RailwayWholeManifestUpgradeBinding,
  type RailwayRestoredTargetActivationFailureCode,
} from "@nautilo/railway-hosting";

import { createRailwayPostUpgradeSourceState, RailwayMaintenanceStateStoreError } from "./railway-maintenance-state";
import { S3RailwayPortableMaintenanceDescriptorProbe } from "./railway-portable-maintenance-descriptor-probe";
import type { RailwayRecoveryConfig } from "./railway-recovery-config";
import { runRailwayRestorePreparationFromState } from "./railway-restore-preparation-runner";
import { runRailwayRestoredTargetActivationFromState } from "./railway-restored-target-activation-runner";
import type {
  RailwayUpgradeReceiptStageContext,
  RailwayUpgradeStageAdapters,
  RailwayUpgradeStageContext,
  RailwayUpgradeStageOutcome,
} from "./railway-upgrade-runner";

const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface RailwayUpgradeBackupBinding {
  readonly targets: readonly RailwayMaintenanceBackupTarget[];
}

export interface RailwayUpgradePortableBinding {
  readonly exportOperationId: string;
  readonly objectId: string;
  readonly sourceMaintenanceImage: string;
  readonly targetMaintenanceImage: string;
  readonly sourceAppDatabaseUrl: string;
  readonly sourceLogtoDatabaseUrl: string;
  readonly targetAppDatabaseUrl: string;
  readonly targetLogtoDatabaseUrl: string;
}

/** Keep export on the receipt-owned source image; only restore uses the verified target image. */
export function selectRailwayPortableMaintenanceImage(
  binding: RailwayUpgradePortableBinding,
  direction: "export" | "restore",
): string {
  return direction === "export" ? binding.sourceMaintenanceImage : binding.targetMaintenanceImage;
}

/** Production dependencies. Secret-bearing values are request-memory only. */
export interface RailwayUpgradeStageAdaptersInput {
  readonly stateRoot: string;
  readonly statePath: string;
  readonly operationId: string;
  readonly authorityGenerationId: string;
  readonly transport: RailwayReconcileExecutorTransport;
  readonly recoveryConfig: RailwayRecoveryConfig;
  readonly backup: RailwayUpgradeBackupBinding;
  readonly portable: RailwayUpgradePortableBinding;
  readonly candidate: RailwayWholeManifestUpgradeBinding;
  readonly targetLaunchId: string;
  readonly providers: readonly string[];
  readonly topology: RailwayTopology;
  readonly projectionInputs: RailwayVariableProjectionInputs;
  readonly target: RailwayDesiredStateTarget;
  readonly now: () => string;
  readonly fetch?: typeof fetch | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly readinessAttempts?: number | undefined;
  readonly readinessDelayMs?: number | undefined;
  readonly readinessTimeoutMs?: number | undefined;
  readonly deploymentObservationAttempts?: number | undefined;
  readonly interrupted?: (() => boolean) | undefined;
  readonly signal?: AbortSignal | undefined;
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function outcome(value: "pending" | "complete" | "terminal-failure"): RailwayUpgradeStageOutcome {
  return { outcome: value };
}

export function classifyRailwayActivationAdapterFailure(code: RailwayRestoredTargetActivationFailureCode): RailwayUpgradeStageOutcome {
  return outcome(["executor-failure", "persistence-failure", "readiness-failed"].includes(code) ? "pending" : "terminal-failure");
}

export function createRailwayAuthorityGuardedFetch(
  loadState: RailwayUpgradeStageContext["loadState"],
  request: typeof fetch,
  interrupted: () => boolean = () => false,
  parentSignal?: AbortSignal,
): typeof fetch {
  return Object.assign(async (...args: Parameters<typeof fetch>) => {
    if (interrupted()) throw new Error("Railway maintenance interrupted");
    await loadState();
    if (interrupted()) throw new Error("Railway maintenance interrupted");
    const init = args[1];
    const signals = [parentSignal, init?.signal].filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
    if (signals.length === 0) return request(...args);
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    return request(args[0], { ...init, signal });
  }, { preconnect: request.preconnect });
}

function throwCaptured(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new RailwayMaintenanceStateStoreError("invalid-state");
}

function receiptAt(receipt: MaintenanceReceipt, stage: MaintenanceReceipt["stage"], now: string, extra: Partial<MaintenanceReceipt>): MaintenanceReceipt {
  return { ...receipt, ...extra, revision: receipt.revision + 1, stage, updatedAt: now };
}

function exactResourceId(context: RailwayUpgradeStageContext, kind: string, name: string): string {
  const matches = context.state.sourceLaunchState.reconcile.receipt.resources.filter((resource) => resource.kind === kind && resource.name === name);
  if (matches.length !== 1) throw new RailwayMaintenanceStateStoreError("invalid-state");
  return matches[0]!.id;
}

function authorityTransport(input: RailwayUpgradeStageAdaptersInput, context: RailwayUpgradeStageContext): RailwayReconcileExecutorTransport {
  const execute: RailwayReconcileExecutorTransport["execute"] = async (operation, variables) => {
    if (input.interrupted?.() === true) throw new Error("Railway maintenance interrupted");
    const state = await context.loadState();
    if (state.maintenanceId !== input.operationId || state.authorityGenerationId !== input.authorityGenerationId) {
      throw new RailwayMaintenanceStateStoreError("invalid-state");
    }
    if (input.interrupted?.() === true) throw new Error("Railway maintenance interrupted");
    return input.transport.execute(operation, variables, input.signal === undefined ? undefined : { signal: input.signal });
  };
  return Object.freeze({ execute });
}

function authority(input: RailwayUpgradeStageAdaptersInput): PortableTransferAuthority {
  return Object.freeze({
    endpoint: `${input.recoveryConfig.endpoint}`,
    region: `${input.recoveryConfig.region}`,
    bucket: `${input.recoveryConfig.bucket}`,
    accessKeyId: `${input.recoveryConfig.accessKeyId}`,
    secretAccessKey: `${input.recoveryConfig.secretAccessKey}`,
    encryptionKey: new Uint8Array(input.recoveryConfig.encryptionKey),
  });
}

async function persistWorkflow(
  context: RailwayUpgradeReceiptStageContext,
  now: () => string,
  intended: MaintenanceProviderWorkflowCheckpoint,
): Promise<void> {
  const state = await context.loadState();
  const previous = state.maintenanceReceipt.providerWorkflows ?? [];
  const workflows = mergeRailwayUpgradeWorkflow(previous, intended);
  if (workflows === previous) return;
  const stage = state.maintenanceReceipt.stage === "quiesced" && intended.operation.startsWith("backup-")
    ? "provider-backup"
    : state.maintenanceReceipt.stage;
  await context.persistReceipt(receiptAt(state.maintenanceReceipt, stage, now(), { providerWorkflows: workflows }));
}

export function mergeRailwayUpgradeWorkflow(
  previous: readonly MaintenanceProviderWorkflowCheckpoint[],
  intended: MaintenanceProviderWorkflowCheckpoint,
): readonly MaintenanceProviderWorkflowCheckpoint[] {
  const index = previous.findIndex((entry) => entry.operation === intended.operation);
  if (index >= 0 && same(previous[index], intended)) return previous;
  if (index >= 0 && previous[index]!.workflowId !== intended.workflowId) throw new RailwayMaintenanceStateStoreError("invalid-state");
  if (index >= 0 && previous[index]!.state === "complete" && intended.state === "pending") return previous;
  return index < 0 ? [...previous, intended] : previous.map((entry, at) => at === index ? intended : entry);
}

function pendingVolume(code: string): boolean {
  return ["transport-failed", "workflow-timeout", "create-unknown", "lock-unknown", "quiescence-unknown", "checkpoint-failed"].includes(code);
}

function pendingPortable(code: string): boolean {
  return ["target-failed", "start-unknown", "checkpoint-failed", "job-timeout"].includes(code);
}

function maintenanceImageExact(input: RailwayUpgradeStageAdaptersInput): boolean {
  const services: readonly { readonly name: string; readonly image: string }[] = Array.isArray(input.topology.finalServices)
    ? input.topology.finalServices : [];
  const server = services.filter(({ name }) => name === "nautilo-server");
  return input.topology.releaseId === input.candidate.releaseId && server.length === 1
    && server[0]!.image === input.portable.targetMaintenanceImage
    && input.candidate.services.filter(({ name }) => name === "nautilo-server").length === 1
    && input.candidate.services.find(({ name }) => name === "nautilo-server")!.oldImage === input.portable.sourceMaintenanceImage;
}

function candidateImagesExact(input: RailwayUpgradeStageAdaptersInput): boolean {
  if (!maintenanceImageExact(input) || input.candidate.services.length !== 5) return false;
  return input.candidate.services.every((service) => {
    const intended = input.topology.finalServices.filter(({ name }) => name === service.name);
    return intended.length === 1 && intended[0]!.image === service.newImage;
  });
}

function sourcePortableBinding(input: RailwayUpgradeStageAdaptersInput, context: RailwayUpgradeStageContext): RailwayPortableMaintenanceBinding {
  const source = context.state.sourceLaunchState;
  return {
    projectId: exactResourceId(context, "railway.project", source.target.projectName),
    environmentId: exactResourceId(context, "railway.environment", source.target.environmentName),
    serviceId: exactResourceId(context, "railway.service", "nautilo-server"),
    image: selectRailwayPortableMaintenanceImage(input.portable, "export"),
    direction: "export",
    operationId: input.portable.exportOperationId,
    objectId: input.portable.objectId,
    sourceReleaseId: context.state.maintenanceReceipt.sourceReleaseId,
    appDatabaseUrl: input.portable.sourceAppDatabaseUrl,
    logtoDatabaseUrl: input.portable.sourceLogtoDatabaseUrl,
    storagePrefix: input.recoveryConfig.objectPrefix,
    storageSessionToken: input.recoveryConfig.sessionToken,
  };
}

function targetPortableBinding(input: RailwayUpgradeStageAdaptersInput, context: RailwayUpgradeStageContext): RailwayPortableMaintenanceBinding {
  const state = context.state;
  const target = state.restoreTargetState;
  const exported = state.maintenanceReceipt.portableExport;
  const restoreTarget = state.maintenanceReceipt.restoreTarget;
  if (target === undefined || exported === undefined || restoreTarget === undefined) throw new RailwayMaintenanceStateStoreError("invalid-state");
  const resources = target.reconcile.receipt.resources;
  const services = resources.filter((resource) => resource.kind === "railway.service" && resource.name === "nautilo-server");
  if (services.length !== 1) throw new RailwayMaintenanceStateStoreError("invalid-state");
  return {
    projectId: restoreTarget.projectId,
    environmentId: restoreTarget.environmentId,
    serviceId: services[0]!.id,
    image: selectRailwayPortableMaintenanceImage(input.portable, "restore"),
    direction: "restore",
    // The operation ID is part of the immutable S3 object key and descriptor
    // authority. Restore must read the exact object published by export; its
    // separate durable checkpoint slot already distinguishes the direction.
    operationId: input.portable.exportOperationId,
    objectId: exported.objectId,
    sourceReleaseId: state.maintenanceReceipt.sourceReleaseId,
    expectedSha256: exported.sha256,
    appDatabaseUrl: input.portable.targetAppDatabaseUrl,
    logtoDatabaseUrl: input.portable.targetLogtoDatabaseUrl,
    storagePrefix: input.recoveryConfig.objectPrefix,
    storageSessionToken: input.recoveryConfig.sessionToken,
  };
}

function cleanupBinding(binding: RailwayPortableMaintenanceBinding) {
  return { ...binding, command: `bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts ${binding.direction} ${binding.operationId} ${binding.objectId}` };
}

/** Builds the non-public production adapter composition used by the durable coordinator. */
export function createRailwayUpgradeStageAdapters(source: RailwayUpgradeStageAdaptersInput): RailwayUpgradeStageAdapters {
  const input: RailwayUpgradeStageAdaptersInput = Object.freeze({
    ...source,
    stateRoot: `${source.stateRoot}`, statePath: `${source.statePath}`, operationId: `${source.operationId}`,
    authorityGenerationId: `${source.authorityGenerationId}`,
    recoveryConfig: Object.freeze({ ...source.recoveryConfig, encryptionKey: new Uint8Array(source.recoveryConfig.encryptionKey) }),
    backup: Object.freeze({ targets: structuredClone(source.backup.targets) }),
    portable: Object.freeze(structuredClone(source.portable)),
    candidate: Object.freeze(structuredClone(source.candidate)),
    providers: Object.freeze([...source.providers]),
    topology: structuredClone(source.topology),
    projectionInputs: {
      generatedSecrets: new Map(source.projectionInputs.generatedSecrets),
      generatedPublicDomains: new Map(source.projectionInputs.generatedPublicDomains),
      bootstrapOutputs: new Map(source.projectionInputs.bootstrapOutputs),
      externalProviderSecrets: new Map(source.projectionInputs.externalProviderSecrets),
    },
    target: structuredClone(source.target),
    transport: Object.freeze({ execute: source.transport.execute.bind(source.transport) }),
  });
  const rawWait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const wait = async (milliseconds: number): Promise<void> => {
    if (input.interrupted?.() === true) throw new Error("Railway maintenance interrupted");
    await rawWait(milliseconds);
    if (input.interrupted?.() === true) throw new Error("Railway maintenance interrupted");
  };
  const probe = new S3RailwayPortableMaintenanceDescriptorProbe();

  const volumeExecutor = (context: RailwayUpgradeReceiptStageContext, failed: (error: unknown) => void): RailwayVolumeBackupExecutor => (
    new RailwayVolumeBackupExecutor({
      transport: authorityTransport(input, context),
      persistWorkflow: async (checkpoint) => {
        try { await persistWorkflow(context, input.now, checkpoint); } catch (error) { failed(error); throw error; }
      },
      scheduler: { wait },
    })
  );

  const transfer = async (
    direction: "export" | "restore",
    context: Parameters<RailwayUpgradeStageAdapters["exportPortable"]>[0] | Parameters<RailwayUpgradeStageAdapters["restorePortable"]>[0],
  ): Promise<RailwayUpgradeStageOutcome> => {
    if (!maintenanceImageExact(input)) return outcome("terminal-failure");
    const binding = direction === "export" ? sourcePortableBinding(input, context) : targetPortableBinding(input, context);
    const executor = new RailwayGraphqlReconcileExecutor({ transport: authorityTransport(input, context), sleep: wait });
    const persistChild = "persistPortableExport" in context ? context.persistPortableExport : context.persistPortableRestore;
    let stateFailure: unknown;
    const target = new RailwayPortableMaintenanceTarget({
      binding,
      authority: authority(input),
      executor,
      descriptorProbe: { observe: async (descriptorInput) => {
        if (input.interrupted?.() === true) throw new Error("Railway maintenance interrupted");
        await context.loadState();
        if (input.interrupted?.() === true) throw new Error("Railway maintenance interrupted");
        return probe.observe(descriptorInput, input.signal);
      } },
      deploymentObservationAttempts: input.deploymentObservationAttempts,
      wait,
      loadCheckpoint: async () => (direction === "export" ? (await context.loadState()).portableExport : (await context.loadState()).portableRestore)?.target,
      persistCheckpoint: async (checkpoint) => {
        try {
          const current = await context.loadState();
          const existing = direction === "export" ? current.portableExport : current.portableRestore;
          await persistChild({ target: checkpoint, ...(existing?.cleanup === undefined ? {} : { cleanup: existing.cleanup }) });
        } catch (error) { stateFailure = error; throw error; }
      },
    });
    const coordinator = new PortableTransferCoordinator({
      target,
      scheduler: { wait },
      maxAttempts: input.readinessAttempts ?? DEFAULT_ATTEMPTS,
      intervalMs: input.readinessDelayMs ?? DEFAULT_DELAY_MS,
      persistWorkflow: async (checkpoint) => {
        try { await persistWorkflow(context, input.now, checkpoint); } catch (error) { stateFailure = error; throw error; }
      },
    });
    const existing = direction === "export" ? context.state.portableExport : context.state.portableRestore;
    const resumeJobId = existing?.target.state === "started" ? existing.target.jobId : undefined;
    if (direction === "export") {
      const result = await coordinator.export({ operationId: binding.operationId, objectId: binding.objectId, authority: authority(input) }, resumeJobId);
      if (stateFailure !== undefined) throwCaptured(stateFailure);
      if (result.outcome === "failure") return outcome(pendingPortable(result.code) ? "pending" : "terminal-failure");
      const current = await context.loadState();
      await context.persistReceipt(receiptAt(current.maintenanceReceipt, "portable-export", input.now(), {
        portableExport: result.checkpoint,
        lastFailure: undefined,
      }));
      return outcome("complete");
    }
    const result = await coordinator.restore({ operationId: binding.operationId, objectId: binding.objectId,
      expectedSha256: binding.expectedSha256!, authority: authority(input) }, resumeJobId);
    if (stateFailure !== undefined) throwCaptured(stateFailure);
    if (result.outcome === "failure") return outcome(pendingPortable(result.code) ? "pending" : "terminal-failure");
    const current = await context.loadState();
    await context.persistReceipt(receiptAt(current.maintenanceReceipt, "restore", input.now(), {}));
    return outcome("complete");
  };

  const cleanup = async (
    direction: "export" | "restore",
    context: Parameters<RailwayUpgradeStageAdapters["cleanupSourceMaintenance"]>[0] | Parameters<RailwayUpgradeStageAdapters["cleanupRestoreMaintenance"]>[0],
  ): Promise<RailwayUpgradeStageOutcome> => {
    if (!maintenanceImageExact(input)) return outcome("terminal-failure");
    const binding = direction === "export" ? sourcePortableBinding(input, context) : targetPortableBinding(input, context);
    const executor = new RailwayGraphqlReconcileExecutor({ transport: authorityTransport(input, context), sleep: wait });
    const persisted = "persistPortableExport" in context ? context.persistPortableExport : context.persistPortableRestore;
    const operation = direction === "export" ? context.state.portableExport : context.state.portableRestore;
    if (operation?.target.state !== "started") return outcome("terminal-failure");
    const started = operation.target;
    let stateFailure: unknown;
    const runner = new RailwayPortableMaintenanceCleanup({
      binding: cleanupBinding(binding), executor,
      durableTransferComplete: async ({ operationId }) => {
        const state = await context.loadState();
        const checkpoint = direction === "export" ? state.portableExport : state.portableRestore;
        const transferTarget = checkpoint?.target;
        return transferTarget?.state === "started" && transferTarget.operationId === operationId
          && state.maintenanceReceipt.providerWorkflows?.some((entry) => entry.operation === `${direction}-portable`
            && entry.workflowId === transferTarget.jobId && entry.state === "complete") === true;
      },
      persistCheckpoint: async (checkpoint) => {
        try { await persisted({ target: started, cleanup: checkpoint }); } catch (error) { stateFailure = error; throw error; }
      },
    });
    const result = await runner.run(operation.cleanup);
    if (stateFailure !== undefined) throwCaptured(stateFailure);
    if (result.outcome === "complete") return outcome("complete");
    return outcome(["executor-failure", "persistence-failure", "cleanup-pending"].includes(result.code) ? "pending" : "terminal-failure");
  };

  const verify = async (subject: "candidate" | "restore-target", context: RailwayUpgradeReceiptStageContext): Promise<RailwayUpgradeStageOutcome> => {
    const state = await context.loadState();
    const hostname = subject === "candidate" ? state.sourceManagedWorkbenchHostname : state.targetNautiloHostname;
    if (hostname === undefined) return outcome("terminal-failure");
    const guardedFetch = createRailwayAuthorityGuardedFetch(context.loadState, input.fetch ?? fetch, input.interrupted, input.signal);
    const result = await waitForRailwayHttpsReadiness({
      origin: `https://${hostname}`,
      fetch: guardedFetch,
      wait,
      requestTimeoutMs: input.readinessTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      retryDelayMs: input.readinessDelayMs ?? DEFAULT_DELAY_MS,
      maxAttempts: input.readinessAttempts ?? DEFAULT_ATTEMPTS,
    });
    if (result.outcome === "failure") {
      return outcome(result.code === "retry-exhausted" || result.code === "wait-failed" ? "pending" : "terminal-failure");
    }
    const latest = await context.loadState();
    const stage = subject === "candidate" ? "verification" : "restore-verification";
    await context.persistReceipt(receiptAt(latest.maintenanceReceipt, stage, input.now(), { verification: { subject, verifiedAt: input.now() } }));
    return outcome("complete");
  };

  const adapters: RailwayUpgradeStageAdapters = {
    quiesce: async (context) => {
      let stateFailure: unknown;
      const executor = volumeExecutor(context, (error) => { stateFailure = error; });
      for (const name of ["nautilo-server", "logto"] as const) {
        const result = await executor.quiesceDeployment(exactResourceId(context, "railway.deployment", name));
        if (stateFailure !== undefined) throwCaptured(stateFailure);
        if (result.outcome === "failure") return outcome(pendingVolume(result.code) ? "pending" : "terminal-failure");
      }
      const current = await context.loadState();
      await context.persistReceipt(receiptAt(current.maintenanceReceipt, "quiesced", input.now(), {}));
      return outcome("complete");
    },
    backupExactlyThree: async (context) => {
      const kinds = input.backup.targets.map(({ kind }) => kind);
      if (input.backup.targets.length !== 3 || new Set(kinds).size !== 3
        || !["application-postgres", "logto-postgres", "server-volume"].every((kind) => kinds.includes(kind as typeof kinds[number]))) {
        return outcome("terminal-failure");
      }
      let stateFailure: unknown;
      const executor = volumeExecutor(context, (error) => { stateFailure = error; });
      const backups = [];
      for (const target of input.backup.targets) {
        const current = await context.loadState();
        const operation = `backup-${target.kind}` as const;
        const checkpoint = current.maintenanceReceipt.providerWorkflows?.find((entry) => entry.operation === operation);
        const result = await executor.createAndLock({ volumeInstanceId: target.volumeInstanceId, name: target.backupName,
          workflowOperation: operation, ...(checkpoint?.state === "pending" ? { workflowId: checkpoint.workflowId } : {}) });
        if (stateFailure !== undefined) throwCaptured(stateFailure);
        if (result.outcome === "failure") return outcome(pendingVolume(result.code) ? "pending" : "terminal-failure");
        const observed = await context.loadState();
        if (!observed.maintenanceReceipt.providerWorkflows?.some((entry) => entry.operation === operation)) {
          await persistWorkflow(context, input.now, {
            operation,
            workflowId: result.value.id,
            state: "complete",
            completedAt: input.now(),
          });
        }
        backups.push({ kind: target.kind, backupId: result.value.id });
      }
      const current = await context.loadState();
      await context.persistReceipt(receiptAt(current.maintenanceReceipt, "provider-backup", input.now(), {
        backupSet: { backups, completedAt: input.now() },
      }));
      return outcome("complete");
    },
    exportPortable: (context) => transfer("export", context),
    cleanupSourceMaintenance: (context) => cleanup("export", context),
    candidateUpgrade: async (context) => {
      const state = await context.loadState();
      const sourceProjectId = exactResourceId(context, "railway.project", state.sourceLaunchState.target.projectName);
      const sourceEnvironmentId = exactResourceId(context, "railway.environment", state.sourceLaunchState.target.environmentName);
      const boundServices = input.candidate.services.every((service) => {
        const matches = state.sourceLaunchState.reconcile.receipt.resources.filter((resource) => (
          resource.kind === "railway.service" && resource.name === service.name && resource.id === service.serviceId
        ));
        return matches.length === 1;
      });
      if (!candidateImagesExact(input) || input.candidate.projectId !== sourceProjectId || input.candidate.environmentId !== sourceEnvironmentId
        || input.candidate.releaseId !== state.maintenanceReceipt.targetReleaseId || !boundServices) {
        return outcome("terminal-failure");
      }
      const executor = new RailwayGraphqlWholeManifestUpgradeExecutor({ transport: authorityTransport(input, context), sleep: wait });
      const result = await runRailwayWholeManifestUpgrade({ binding: input.candidate, executor,
        loadCheckpoint: async () => (await context.loadState()).candidateUpgrade,
        persistCheckpoint: async (checkpoint) => { await context.persistCandidateUpgrade(checkpoint); } });
      if (result.outcome === "pending") return outcome("pending");
      if (result.outcome === "failure") return outcome("terminal-failure");
      await context.persistPostUpgradeSourceState(createRailwayPostUpgradeSourceState(state.sourceLaunchState, result.checkpoint,
        state.maintenanceReceipt.targetReleaseId, input.now()));
      return outcome("complete");
    },
    verifyCandidateHttps: (context) => verify("candidate", context),
    prepareFreshRestoreTarget: (context) => runRailwayRestorePreparationFromState({ context, operationId: input.operationId,
      authorityGenerationId: input.authorityGenerationId, targetLaunchId: input.targetLaunchId, providers: input.providers,
      topology: input.topology, projectionInputs: input.projectionInputs, target: input.target,
      transport: authorityTransport(input, context), now: input.now }),
    restorePortable: (context) => transfer("restore", context),
    cleanupRestoreMaintenance: (context) => cleanup("restore", context),
    activateRestoredTarget: async (context) => {
      const activationFetch = createRailwayAuthorityGuardedFetch(context.loadState, input.fetch ?? fetch, input.interrupted, input.signal);
      const result = await runRailwayRestoredTargetActivationFromState({ stateRoot: input.stateRoot, statePath: input.statePath,
        operationId: input.operationId, authorityGenerationId: input.authorityGenerationId, topology: input.topology,
        projectionInputs: input.projectionInputs, transport: authorityTransport(input, context), fetch: activationFetch, wait,
        readinessAttempts: input.readinessAttempts, readinessDelayMs: input.readinessDelayMs,
        readinessTimeoutMs: input.readinessTimeoutMs });
      if (result.outcome === "pending") return outcome("pending");
      if (result.outcome === "failure") return classifyRailwayActivationAdapterFailure(result.code);
      await context.assertRestoredActivationComplete();
      return outcome("complete");
    },
    verifyRestoredTargetHttps: (context) => verify("restore-target", context),
  };
  const guard = <Context extends RailwayUpgradeStageContext>(adapter: (context: Context) => Promise<RailwayUpgradeStageOutcome>) =>
    async (context: Context): Promise<RailwayUpgradeStageOutcome> => {
      if (input.interrupted?.() === true) return outcome("pending");
      return adapter(context);
    };
  return Object.freeze({
    quiesce: guard(adapters.quiesce), backupExactlyThree: guard(adapters.backupExactlyThree),
    exportPortable: guard(adapters.exportPortable), cleanupSourceMaintenance: guard(adapters.cleanupSourceMaintenance),
    candidateUpgrade: guard(adapters.candidateUpgrade), verifyCandidateHttps: guard(adapters.verifyCandidateHttps),
    prepareFreshRestoreTarget: guard(adapters.prepareFreshRestoreTarget), restorePortable: guard(adapters.restorePortable),
    cleanupRestoreMaintenance: guard(adapters.cleanupRestoreMaintenance), activateRestoredTarget: guard(adapters.activateRestoredTarget),
    verifyRestoredTargetHttps: guard(adapters.verifyRestoredTargetHttps),
  });
}
