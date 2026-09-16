import {
  MAINTENANCE_BACKUP_KINDS,
  type MaintenanceBackupKind,
  type MaintenanceBackupReference,
  type MaintenanceProviderWorkflowCheckpoint,
  type MaintenanceProviderWorkflowOperation,
} from "@nautilo/hosting";

import type { RailwayExecutorTransport } from "./executor";
import {
  railwayDeployment,
  railwayDeploymentStop,
  railwayVolumeInstanceBackupCreate,
  railwayVolumeInstanceBackupList,
  railwayVolumeInstanceBackupLock,
  railwayVolumeInstanceBackupRestore,
  railwayWorkflowStatus,
  type RailwayVolumeInstanceBackup,
  type RailwayWorkflowStatus,
} from "./operations";

const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_WORKFLOW_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}|[A-Za-z][A-Za-z0-9]{0,63}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SAFE_BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,127}$/;

export interface RailwayMaintenanceScheduler {
  wait(milliseconds: number): Promise<void>;
}

export interface RailwayMaintenancePollPolicy {
  readonly intervalMs: number;
  readonly maxAttempts: number;
}

export type RailwayVolumeMaintenanceFailureCode =
  | "invalid-input"
  | "transport-failed"
  | "invalid-response"
  | "workflow-error"
  | "workflow-not-found"
  | "workflow-timeout"
  | "backup-not-found"
  | "backup-ambiguous"
  | "create-unknown"
  | "lock-unknown"
  | "restore-unknown"
  | "quiescence-unknown"
  | "checkpoint-failed";

export type RailwayVolumeMaintenanceResult<Value> =
  | { readonly outcome: "complete"; readonly value: Value }
  | { readonly outcome: "failure"; readonly code: RailwayVolumeMaintenanceFailureCode };

export interface RailwayVolumeBackupExecutorOptions {
  readonly transport: RailwayExecutorTransport;
  readonly persistWorkflow: (
    checkpoint: MaintenanceProviderWorkflowCheckpoint,
  ) => Promise<void>;
  readonly scheduler?: RailwayMaintenanceScheduler | undefined;
  readonly poll?: Partial<RailwayMaintenancePollPolicy> | undefined;
}

export interface CreateAndLockRailwayVolumeBackupInput {
  readonly volumeInstanceId: string;
  readonly name: string;
  /** Previously persisted pending workflow; resume polls it and never creates again. */
  readonly workflowId?: string | undefined;
  readonly workflowOperation: Extract<
    MaintenanceProviderWorkflowOperation,
    `backup-${string}`
  >;
}

export interface RestoreRailwayVolumeBackupInput {
  readonly volumeInstanceId: string;
  readonly backupId: string;
  /** Previously persisted pending workflow; resume polls it and never restores again. */
  readonly workflowId?: string | undefined;
  readonly workflowOperation: Extract<
    MaintenanceProviderWorkflowOperation,
    `restore-${string}`
  >;
}

export interface RailwayMaintenanceBackupTarget {
  readonly kind: MaintenanceBackupKind;
  readonly volumeInstanceId: string;
  readonly backupName: string;
}

export interface CreateRailwayMaintenanceBackupSetInput {
  readonly applicationDeploymentId: string;
  readonly logtoDeploymentId: string;
  readonly targets: readonly RailwayMaintenanceBackupTarget[];
}

export type RailwayMaintenanceBackupBoundary =
  | "application-quiescence"
  | "logto-quiescence"
  | MaintenanceBackupKind;

export type RailwayMaintenanceBackupSetResult =
  | {
      readonly outcome: "complete";
      readonly backups: readonly MaintenanceBackupReference[];
    }
  | {
      readonly outcome: "failure";
      readonly boundary: RailwayMaintenanceBackupBoundary;
      readonly code: RailwayVolumeMaintenanceFailureCode;
    };

const defaultScheduler: RailwayMaintenanceScheduler = {
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function failure<Value>(
  code: RailwayVolumeMaintenanceFailureCode,
): RailwayVolumeMaintenanceResult<Value> {
  return { outcome: "failure", code };
}

function safeProviderId(value: unknown): value is string {
  return typeof value === "string" && SAFE_PROVIDER_ID.test(value);
}

function safeWorkflowId(value: unknown): value is string {
  return typeof value === "string" && SAFE_WORKFLOW_ID.test(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function optionalNonnegativeInteger(value: unknown): value is number | null | undefined {
  return value === undefined || value === null
    || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function parseBackup(value: unknown): RailwayVolumeInstanceBackup | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Partial<RailwayVolumeInstanceBackup>;
  if (!safeProviderId(item.id) || !validTimestamp(item.createdAt)) return undefined;
  if (item.name !== undefined && item.name !== null && typeof item.name !== "string") return undefined;
  if (item.expiresAt !== undefined && item.expiresAt !== null && !validTimestamp(item.expiresAt)) {
    return undefined;
  }
  if (!optionalNonnegativeInteger(item.usedMB) || !optionalNonnegativeInteger(item.referencedMB)) {
    return undefined;
  }
  return {
    id: item.id,
    createdAt: item.createdAt,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
    ...(item.usedMB === undefined ? {} : { usedMB: item.usedMB }),
    ...(item.referencedMB === undefined ? {} : { referencedMB: item.referencedMB }),
  };
}

function parseWorkflowStatus(value: unknown): RailwayWorkflowStatus | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const status = (value as { readonly status?: unknown }).status;
  return status === "Complete" || status === "Error"
    || status === "NotFound" || status === "Running"
    ? status
    : undefined;
}

function parseWorkflowId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const workflowId = (value as { readonly workflowId?: unknown }).workflowId;
  return safeWorkflowId(workflowId) ? workflowId : undefined;
}

/**
 * Redaction-safe Railway volume maintenance boundary. Provider error strings
 * are deliberately ignored; only stable local failure codes cross this API.
 */
export class RailwayVolumeBackupExecutor {
  readonly #transport: RailwayExecutorTransport;
  readonly #persistWorkflow: RailwayVolumeBackupExecutorOptions["persistWorkflow"];
  readonly #scheduler: RailwayMaintenanceScheduler;
  readonly #poll: RailwayMaintenancePollPolicy;

  constructor(options: RailwayVolumeBackupExecutorOptions) {
    this.#transport = options.transport;
    this.#persistWorkflow = options.persistWorkflow;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#poll = {
      intervalMs: options.poll?.intervalMs ?? 1_000,
      maxAttempts: options.poll?.maxAttempts ?? 180,
    };
  }

  async list(
    volumeInstanceId: string,
  ): Promise<RailwayVolumeMaintenanceResult<readonly RailwayVolumeInstanceBackup[]>> {
    if (!safeProviderId(volumeInstanceId)) return failure("invalid-input");
    const result = await this.#transport.execute(railwayVolumeInstanceBackupList, {
      volumeInstanceId,
    });
    if (result.outcome !== "success") return failure("transport-failed");
    const raw = result.data.volumeInstanceBackupList;
    if (!Array.isArray(raw)) return failure("invalid-response");
    const backups = raw.map(parseBackup);
    if (backups.some((backup) => backup === undefined)) return failure("invalid-response");
    return {
      outcome: "complete",
      value: backups as readonly RailwayVolumeInstanceBackup[],
    };
  }

  async #waitForWorkflow(workflowId: string): Promise<RailwayVolumeMaintenanceResult<true>> {
    if (!safeWorkflowId(workflowId) || !Number.isSafeInteger(this.#poll.maxAttempts)
        || this.#poll.maxAttempts < 1 || !Number.isSafeInteger(this.#poll.intervalMs)
        || this.#poll.intervalMs < 0) {
      return failure("invalid-input");
    }
    for (let attempt = 0; attempt < this.#poll.maxAttempts; attempt += 1) {
      const result = await this.#transport.execute(railwayWorkflowStatus, { workflowId });
      if (result.outcome !== "success") return failure("transport-failed");
      const status = parseWorkflowStatus(result.data.workflowStatus);
      if (status === undefined) return failure("invalid-response");
      if (status === "Complete") return { outcome: "complete", value: true };
      if (status === "Error") return failure("workflow-error");
      if (status === "NotFound") return failure("workflow-not-found");
      if (attempt + 1 < this.#poll.maxAttempts) {
        await this.#scheduler.wait(this.#poll.intervalMs);
      }
    }
    return failure("workflow-timeout");
  }

  async #checkpointWorkflow(
    checkpoint: MaintenanceProviderWorkflowCheckpoint,
  ): Promise<RailwayVolumeMaintenanceResult<true>> {
    try {
      await this.#persistWorkflow(checkpoint);
      return { outcome: "complete", value: true };
    } catch {
      return failure("checkpoint-failed");
    }
  }

  async #completeWorkflow(
    operation: MaintenanceProviderWorkflowOperation,
    workflowId: string,
  ): Promise<RailwayVolumeMaintenanceResult<true>> {
    const completed = await this.#waitForWorkflow(workflowId);
    if (completed.outcome === "failure") return completed;
    return this.#checkpointWorkflow({
      operation,
      workflowId,
      state: "complete",
      completedAt: new Date().toISOString(),
    });
  }

  async #findNamedBackup(
    volumeInstanceId: string,
    name: string,
  ): Promise<RailwayVolumeMaintenanceResult<RailwayVolumeInstanceBackup | undefined>> {
    const listed = await this.list(volumeInstanceId);
    if (listed.outcome === "failure") return listed;
    const matching = listed.value.filter((backup) => backup.name === name);
    if (matching.length > 1) return failure("backup-ambiguous");
    return { outcome: "complete", value: matching[0] };
  }

  async #lock(
    volumeInstanceId: string,
    backup: RailwayVolumeInstanceBackup,
  ): Promise<RailwayVolumeMaintenanceResult<RailwayVolumeInstanceBackup>> {
    const result = await this.#transport.execute(railwayVolumeInstanceBackupLock, {
      volumeInstanceBackupId: backup.id,
      volumeInstanceId,
    });
    if (result.outcome === "success" && result.data.volumeInstanceBackupLock === true) {
      return { outcome: "complete", value: backup };
    }
    const observed = await this.list(volumeInstanceId);
    if (observed.outcome === "complete") {
      const current = observed.value.find((candidate) => candidate.id === backup.id);
      if (current?.expiresAt === null) return { outcome: "complete", value: current };
    }
    return failure("lock-unknown");
  }

  async createAndLock(
    input: CreateAndLockRailwayVolumeBackupInput,
  ): Promise<RailwayVolumeMaintenanceResult<RailwayVolumeInstanceBackup>> {
    if (!safeProviderId(input.volumeInstanceId) || !SAFE_BACKUP_NAME.test(input.name)) {
      return failure("invalid-input");
    }
    if (input.workflowId !== undefined) {
      if (!safeWorkflowId(input.workflowId)) return failure("invalid-input");
      const resumed = await this.#completeWorkflow(input.workflowOperation, input.workflowId);
      if (resumed.outcome === "failure") {
        // Railway may authorize the backup mutation but deny or expire access to
        // its workflow-status record. The exact maintenance-scoped backup name
        // on the exact volume is an authoritative, replay-safe observation of
        // the effect; never issue another create while a workflow is pending.
        const recovered = await this.#findNamedBackup(input.volumeInstanceId, input.name);
        if (recovered.outcome === "failure") return recovered;
        if (recovered.value === undefined) return resumed;
        const checkpointed = await this.#checkpointWorkflow({
          operation: input.workflowOperation,
          workflowId: input.workflowId,
          state: "complete",
          completedAt: new Date().toISOString(),
        });
        if (checkpointed.outcome === "failure") return checkpointed;
        return this.#lock(input.volumeInstanceId, recovered.value);
      }
      const observed = await this.#findNamedBackup(input.volumeInstanceId, input.name);
      if (observed.outcome === "failure") return observed;
      if (observed.value === undefined) return failure("backup-not-found");
      return this.#lock(input.volumeInstanceId, observed.value);
    }
    const existing = await this.#findNamedBackup(input.volumeInstanceId, input.name);
    if (existing.outcome === "failure") return existing;
    if (existing.value !== undefined) return this.#lock(input.volumeInstanceId, existing.value);

    const created = await this.#transport.execute(railwayVolumeInstanceBackupCreate, {
      volumeInstanceId: input.volumeInstanceId,
      name: input.name,
    });
    if (created.outcome !== "success") return failure("create-unknown");
    const workflowId = parseWorkflowId(created.data.volumeInstanceBackupCreate);
    if (workflowId === undefined) return failure("invalid-response");
    const pending = await this.#checkpointWorkflow({
      operation: input.workflowOperation,
      workflowId,
      state: "pending",
    });
    if (pending.outcome === "failure") return pending;
    const checkpointed = await this.#completeWorkflow(input.workflowOperation, workflowId);
    if (checkpointed.outcome === "failure") return checkpointed;
    const observed = await this.#findNamedBackup(input.volumeInstanceId, input.name);
    if (observed.outcome === "failure") return observed;
    if (observed.value === undefined) return failure("backup-not-found");
    return this.#lock(input.volumeInstanceId, observed.value);
  }

  async restore(
    input: RestoreRailwayVolumeBackupInput,
  ): Promise<RailwayVolumeMaintenanceResult<true>> {
    if (!safeProviderId(input.volumeInstanceId) || !safeProviderId(input.backupId)) {
      return failure("invalid-input");
    }
    const listed = await this.list(input.volumeInstanceId);
    if (listed.outcome === "failure") return listed;
    if (!listed.value.some((backup) => backup.id === input.backupId)) {
      return failure("backup-not-found");
    }
    if (input.workflowId !== undefined) {
      if (!safeWorkflowId(input.workflowId)) return failure("invalid-input");
      return this.#completeWorkflow(input.workflowOperation, input.workflowId);
    }
    const restored = await this.#transport.execute(railwayVolumeInstanceBackupRestore, {
      volumeInstanceBackupId: input.backupId,
      volumeInstanceId: input.volumeInstanceId,
    });
    if (restored.outcome !== "success") return failure("restore-unknown");
    const workflowId = parseWorkflowId(restored.data.volumeInstanceBackupRestore);
    if (workflowId === undefined) return failure("invalid-response");
    const pending = await this.#checkpointWorkflow({
      operation: input.workflowOperation,
      workflowId,
      state: "pending",
    });
    if (pending.outcome === "failure") return pending;
    return this.#completeWorkflow(input.workflowOperation, workflowId);
  }

  async quiesceDeployment(deploymentId: string): Promise<RailwayVolumeMaintenanceResult<true>> {
    if (!safeProviderId(deploymentId)) return failure("invalid-input");
    const already = await this.#deploymentStopped(deploymentId);
    if (already.outcome === "complete" && already.value) return { outcome: "complete", value: true };
    if (already.outcome === "failure") return already;

    const stopped = await this.#transport.execute(railwayDeploymentStop, { id: deploymentId });
    if (stopped.outcome !== "success" || stopped.data.deploymentStop !== true) {
      const observed = await this.#deploymentStopped(deploymentId);
      return observed.outcome === "complete" && observed.value
        ? { outcome: "complete", value: true }
        : failure("quiescence-unknown");
    }
    for (let attempt = 0; attempt < this.#poll.maxAttempts; attempt += 1) {
      const observed = await this.#deploymentStopped(deploymentId);
      if (observed.outcome === "failure") return observed;
      if (observed.value) return { outcome: "complete", value: true };
      if (attempt + 1 < this.#poll.maxAttempts) {
        await this.#scheduler.wait(this.#poll.intervalMs);
      }
    }
    return failure("workflow-timeout");
  }

  async #deploymentStopped(
    deploymentId: string,
  ): Promise<RailwayVolumeMaintenanceResult<boolean>> {
    const result = await this.#transport.execute(railwayDeployment, { id: deploymentId });
    if (result.outcome !== "success") return failure("transport-failed");
    const deployment = result.data.deployment;
    if (typeof deployment !== "object" || deployment === null
        || deployment.id !== deploymentId || typeof deployment.deploymentStopped !== "boolean") {
      return failure("invalid-response");
    }
    return { outcome: "complete", value: deployment.deploymentStopped };
  }
}

/**
 * Establishes one coordinated Railway recovery barrier. Application writes are
 * stopped before the application database and server volume; Logto is stopped
 * before its database. The services intentionally remain quiesced for the
 * subsequent export/release transaction.
 */
export async function createRailwayMaintenanceBackupSet(
  executor: RailwayVolumeBackupExecutor,
  input: CreateRailwayMaintenanceBackupSetInput,
): Promise<RailwayMaintenanceBackupSetResult> {
  const byKind = new Map(input.targets.map((target) => [target.kind, target]));
  if (input.targets.length !== MAINTENANCE_BACKUP_KINDS.length
      || byKind.size !== MAINTENANCE_BACKUP_KINDS.length
      || !MAINTENANCE_BACKUP_KINDS.every((kind) => byKind.has(kind))
      || !safeProviderId(input.applicationDeploymentId)
      || !safeProviderId(input.logtoDeploymentId)
      || input.targets.some((target) => !safeProviderId(target.volumeInstanceId)
        || !SAFE_BACKUP_NAME.test(target.backupName))) {
    return { outcome: "failure", boundary: "application-quiescence", code: "invalid-input" };
  }

  const application = await executor.quiesceDeployment(input.applicationDeploymentId);
  if (application.outcome === "failure") {
    return { ...application, boundary: "application-quiescence" };
  }
  const logto = await executor.quiesceDeployment(input.logtoDeploymentId);
  if (logto.outcome === "failure") return { ...logto, boundary: "logto-quiescence" };

  const backups: MaintenanceBackupReference[] = [];
  for (const kind of MAINTENANCE_BACKUP_KINDS) {
    const target = byKind.get(kind);
    if (target === undefined) return { outcome: "failure", boundary: kind, code: "invalid-input" };
    const created = await executor.createAndLock({
      volumeInstanceId: target.volumeInstanceId,
      name: target.backupName,
      workflowOperation: `backup-${kind}`,
    });
    if (created.outcome === "failure") return { ...created, boundary: kind };
    backups.push({ kind, backupId: created.value.id });
  }
  return { outcome: "complete", backups };
}
