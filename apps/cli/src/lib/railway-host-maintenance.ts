import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { createMaintenanceReceipt } from "@nautilo/hosting";
import {
  destroyRailwayDeployment,
  RailwayGraphqlReconcileExecutor,
  RAILWAY_POSTGRES_PORT,
  type RailwayDestroyExecutor,
  type RailwayDestroyPollPolicy,
  type RailwayDestroyResult,
  type RailwayReconcileExecutorTransport,
  type RailwayTopology,
  type RailwayVariableProjectionInputs,
  type RailwayWholeManifestUpgradeBinding,
} from "@nautilo/railway-hosting";

import type { RailwayDeploymentDriverState } from "./railway-deployment-runner";
import {
  railwayRecoveryProjectName,
  createRailwayRestoreTargetTeardownReceipt,
  railwayRestoreTargetTeardownReceiptSha256,
  RailwayMaintenanceStateStoreError,
  readRailwayMaintenanceState,
  updateRailwayMaintenanceState,
  writeRailwayMaintenanceState,
  type RailwayMaintenanceState,
} from "./railway-maintenance-state";
import type { RailwayRecoveryConfig } from "./railway-recovery-config";
import { createRailwayUpgradeStageAdapters } from "./railway-upgrade-stage-adapters";
import { runRailwayUpgradeFromState } from "./railway-upgrade-runner";

export interface RailwayHostMaintenanceInput {
  readonly stateRoot: string;
  readonly source: RailwayDeploymentDriverState;
  readonly targetTopology: RailwayTopology;
  readonly projectionInputs: RailwayVariableProjectionInputs;
  readonly recoveryConfig: RailwayRecoveryConfig;
  readonly authorityGenerationId: string;
  readonly transport: RailwayReconcileExecutorTransport;
  readonly backupNames: Readonly<Record<"application-postgres" | "logto-postgres" | "server-volume", string>>;
  readonly confirmed: boolean;
  readonly operationId?: string | undefined;
  readonly now: () => string;
  readonly fetch?: typeof fetch | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly interrupted?: (() => boolean) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type RailwayHostMaintenanceResult =
  | { readonly outcome: "unconfirmed"; readonly phase: "confirmation" }
  | { readonly outcome: "pending" | "terminal-failure"; readonly phase: string }
  | { readonly outcome: "complete"; readonly active: "source" | "restore-target" };

export function railwayFailedMaintenanceCleanupComplete(state: RailwayMaintenanceState): boolean {
  return (state.restoreTargetState ?? state.restoreTargetPreparation) !== undefined
    && state.restoreTargetTeardown?.receipt.cleanup.state === "verified"
    && state.restoreTargetTeardown.receipt.resources.length === 0;
}

/** Keeps only causal tips; parallel or unlinked tips remain visibly ambiguous. */
export function latestRailwayMaintenanceStates(states: readonly RailwayMaintenanceState[]): readonly RailwayMaintenanceState[] {
  const superseded = new Set<string>();
  for (const state of states) {
    const lifecycle = state.sourceLaunchState.lifecycle;
    const prior = lifecycle !== undefined && "maintenanceId" in lifecycle ? lifecycle.maintenanceId : undefined;
    if (prior !== undefined && states.some((candidate) => (
      candidate.maintenanceId === prior && candidate.sourceLaunchId === state.sourceLaunchId
    ))) superseded.add(prior);
  }
  return states.filter((state) => !superseded.has(state.maintenanceId));
}

/** Persists exact operator discard authority as an isolated CAS transition. */
export async function authorizeRailwayRestoreTargetDiscard(input: {
  readonly stateRoot: string;
  readonly statePath: string;
  readonly operationId: string;
  readonly now: () => string;
}): Promise<RailwayMaintenanceState> {
  const current = await readRailwayMaintenanceState(input.stateRoot, input.statePath);
  if (current === null || current.maintenanceId !== input.operationId) throw new Error("Railway replacement discard is unavailable");
  if (current.restoreTargetDisposition !== undefined) return current;
  const target = current.restoreTargetState ?? current.restoreTargetPreparation;
  if (target === undefined || current.activeLaunch !== undefined
    || current.maintenanceReceipt.stage === "cutover" || current.maintenanceReceipt.stage === "complete") {
    throw new Error("Railway replacement discard is unavailable");
  }
  const projects = target.reconcile.receipt.resources.filter((resource) => resource.kind === "railway.project");
  if (projects.length !== 1) throw new Error("Railway replacement discard is unavailable");
  const intended = {
    ...current,
    revision: current.revision + 1,
    restoreTargetDisposition: {
      schemaVersion: 1 as const,
      state: "discard-authorized" as const,
      reason: "operator-discard" as const,
      targetLaunchId: target.launchId,
      targetProjectId: projects[0]!.id,
      teardownReceiptSha256: railwayRestoreTargetTeardownReceiptSha256(current),
      authorizedAt: input.now(),
    },
  };
  try {
    return await updateRailwayMaintenanceState(input.stateRoot, input.statePath, { expectedRevision: current.revision }, () => intended);
  } catch (error) {
    const landed = await readRailwayMaintenanceState(input.stateRoot, input.statePath);
    if (landed !== null && landed.maintenanceId === input.operationId
      && JSON.stringify(landed.restoreTargetDisposition) === JSON.stringify(intended.restoreTargetDisposition)) return landed;
    throw error;
  }
}

export async function cleanupAuthorizedRailwayRestoreTarget(input: {
  readonly stateRoot: string;
  readonly statePath: string;
  readonly operationId: string;
  readonly executor: RailwayDestroyExecutor;
  readonly poll: RailwayDestroyPollPolicy;
  readonly now: () => string;
}): Promise<RailwayDestroyResult> {
  const load = async (): Promise<RailwayMaintenanceState> => {
    const state = await readRailwayMaintenanceState(input.stateRoot, input.statePath);
    const disposition = state?.restoreTargetDisposition;
    if (state === null || state.maintenanceId !== input.operationId || disposition === undefined
      || disposition.teardownReceiptSha256 !== railwayRestoreTargetTeardownReceiptSha256(state)) {
      throw new Error("Railway maintenance cleanup is unavailable");
    }
    return state;
  };
  const persist = async (checkpoint: RailwayMaintenanceState["restoreTargetTeardown"]): Promise<void> => {
    if (checkpoint === undefined) throw new Error("Railway maintenance cleanup is unavailable");
    const current = await load();
    if (JSON.stringify(current.restoreTargetTeardown) === JSON.stringify(checkpoint)) return;
    try {
      await updateRailwayMaintenanceState(input.stateRoot, input.statePath, { expectedRevision: current.revision }, (state) => ({
        ...state,
        revision: state.revision + 1,
        restoreTargetTeardown: checkpoint,
      }));
    } catch (error) {
      if (!(error instanceof RailwayMaintenanceStateStoreError)
        || !["revision-conflict", "publish-unknown"].includes(error.code)
        || JSON.stringify((await load()).restoreTargetTeardown) !== JSON.stringify(checkpoint)) throw error;
    }
  };
  const initial = await load();
  const expectedReceipt = createRailwayRestoreTargetTeardownReceipt(initial);
  const project = expectedReceipt.resources.filter((resource) => resource.kind === "railway.project");
  if (project.length !== 1) throw new Error("Railway maintenance cleanup is unavailable");
  const repairsLegacyCustody = initial.restoreTargetTeardown?.stage === "validate"
    && JSON.stringify(initial.restoreTargetTeardown.receipt) !== JSON.stringify(expectedReceipt);
  const checkpoint = initial.restoreTargetTeardown === undefined || repairsLegacyCustody ? {
    schemaVersion: 1 as const,
    receipt: expectedReceipt,
    stage: "validate" as const,
  } : initial.restoreTargetTeardown;
  if (initial.restoreTargetTeardown === undefined || repairsLegacyCustody) await persist(checkpoint);
  if (initial.restoreTargetDisposition?.targetProjectId !== project[0]!.id) throw new Error("Railway maintenance cleanup is unavailable");
  return destroyRailwayDeployment({ checkpoint, confirmProjectId: initial.restoreTargetDisposition.targetProjectId, executor: input.executor,
    poll: input.poll, now: input.now, persistCheckpoint: persist });
}

/** Authenticates the frozen target before any resumed provider or projection effect. */
export function verifyRailwayMaintenanceRecoveryBinding(input: {
  readonly state: RailwayMaintenanceState;
  readonly recoveryConfig: RailwayRecoveryConfig;
  readonly authorityGenerationId: string;
}): RailwayTopology {
  const topology = input.state.targetTopology;
  const digest = input.state.targetTopologySha256;
  const mac = input.state.targetTopologyMac;
  if (topology === undefined || digest === undefined || mac === undefined
    || input.state.authorityGenerationId !== input.authorityGenerationId
    || input.state.maintenanceReceipt.targetReleaseId !== topology.releaseId) {
    throw new Error("Railway maintenance target release is unavailable");
  }
  const bytes = JSON.stringify(topology);
  if (createHash("sha256").update(bytes, "utf8").digest("hex") !== digest) {
    throw new Error("Railway maintenance target release is unavailable");
  }
  const intended = createHmac("sha256", input.recoveryConfig.encryptionKey).update(bytes, "utf8").digest();
  const stored = Buffer.from(mac, "hex");
  if (stored.length !== intended.length || !timingSafeEqual(stored, intended)) {
    throw new Error("Railway maintenance target release is unavailable");
  }
  return topology;
}

function resource(state: RailwayDeploymentDriverState, kind: string, name?: string): string {
  const matches = state.reconcile.receipt.resources.filter((item) => item.kind === kind && (name === undefined || item.name === name));
  if (matches.length !== 1) throw new Error("Railway maintenance input is invalid");
  return matches[0]!.id;
}

function hostname(domains: readonly { readonly id: string; readonly domain: string }[], id: string): string {
  const matches = domains.filter((domain) => domain.id === id);
  if (matches.length !== 1) throw new Error("Railway maintenance input is invalid");
  return matches[0]!.domain;
}

export function resolveRailwayMaintenanceDatabaseUrls(inputs: RailwayVariableProjectionInputs): { app: string; logto: string } {
  const app = inputs.generatedSecrets.get("app-postgres-superuser-password");
  const logto = inputs.generatedSecrets.get("logto-postgres-superuser-password");
  if (app === undefined || logto === undefined) throw new Error("Railway maintenance custody is unavailable");
  return {
    app: `postgres://postgres:${app}@\${{app-postgres.RAILWAY_PRIVATE_DOMAIN}}:${RAILWAY_POSTGRES_PORT}/nautilo`,
    logto: `postgres://postgres:${logto}@\${{logto-postgres.RAILWAY_PRIVATE_DOMAIN}}:${RAILWAY_POSTGRES_PORT}/logto_nautilo`,
  };
}

function candidateBinding(
  source: RailwayDeploymentDriverState,
  topology: RailwayTopology,
  sources: ReadonlyMap<string, string>,
  projectId: string,
  environmentId: string,
  operationId: string,
): RailwayWholeManifestUpgradeBinding {
  return {
    releaseId: topology.releaseId, projectId, environmentId,
    services: topology.finalServices.map((service) => {
      const serviceId = resource(source, "railway.service", service.name);
      const oldImage = sources.get(serviceId);
      if (oldImage === undefined) throw new Error("Railway maintenance input is invalid");
      return { name: service.name, serviceId, oldImage, newImage: service.image, kind: service.kind };
    }),
    migration: { migrationId: `migration-${operationId}`, executionId: `execution-${operationId}` },
  };
}

export async function discoverRailwayMaintenanceStates(root: string): Promise<readonly RailwayMaintenanceState[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  if (entries.length > 1024) throw new Error("Railway maintenance discovery failed");
  const found: RailwayMaintenanceState[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Railway maintenance discovery failed");
    const state = await readRailwayMaintenanceState(root, join(root, entry.name));
    if (state !== null) {
      if (state.maintenanceId !== entry.name) throw new Error("Railway maintenance discovery failed");
      found.push(state);
    }
  }
  return found;
}

/** Executes one durable public maintenance phase using only exact retained/provider-observed identities. */
export async function runRailwayHostMaintenance(input: RailwayHostMaintenanceInput): Promise<RailwayHostMaintenanceResult> {
  if (!input.confirmed) return { outcome: "unconfirmed", phase: "confirmation" };
  const operationId = input.operationId ?? randomUUID();
  const path = join(input.stateRoot, operationId);
  let state = await readRailwayMaintenanceState(input.stateRoot, path);
  const projectId = resource(input.source, "railway.project");
  const environmentId = resource(input.source, "railway.environment");
  const guardedTransport: RailwayReconcileExecutorTransport = { execute: async (operation, variables) => {
    if (input.interrupted?.() === true) throw new Error("Railway maintenance interrupted");
    const result = await input.transport.execute(operation, variables, input.signal === undefined ? undefined : { signal: input.signal });
    if (input.interrupted?.() === true) throw new Error("Railway maintenance interrupted");
    return result;
  } };
  const executor = new RailwayGraphqlReconcileExecutor({ transport: guardedTransport, sleep: input.wait });
  if (state === null) {
    const nautiloServiceId = resource(input.source, "railway.service", "nautilo-server");
    const domains = await executor.listDomains({ projectId, environmentId, serviceId: nautiloServiceId });
    const sourceHostname = hostname(domains, resource(input.source, "railway.domain", "nautilo-public"));
    const now = input.now();
    const targetTopology = structuredClone(input.targetTopology);
    const targetTopologyBytes = JSON.stringify(targetTopology);
    state = {
      schemaVersion: 1, revision: 0, maintenanceId: operationId, sourceLaunchId: input.source.launchId,
      authorityGenerationId: input.authorityGenerationId, sourceManagedWorkbenchHostname: sourceHostname,
      sourceLaunchState: input.source,
      targetTopology,
      targetTopologySha256: createHash("sha256").update(targetTopologyBytes, "utf8").digest("hex"),
      targetTopologyMac: createHmac("sha256", input.recoveryConfig.encryptionKey).update(targetTopologyBytes, "utf8").digest("hex"),
      maintenanceReceipt: createMaintenanceReceipt({ maintenanceId: operationId, launchId: input.source.launchId, backend: "railway",
        sourceReleaseId: input.source.releaseId, targetReleaseId: input.targetTopology.releaseId, now }),
    };
    await writeRailwayMaintenanceState(input.stateRoot, path, state);
  }
  const topology = verifyRailwayMaintenanceRecoveryBinding({ state, recoveryConfig: input.recoveryConfig,
    authorityGenerationId: input.authorityGenerationId });
  if (state.sourceLaunchId !== input.source.launchId || state.authorityGenerationId !== input.authorityGenerationId
  ) throw new Error("Railway maintenance input is invalid");
  if (state.maintenanceReceipt.stage === "complete" && state.activeLaunch !== undefined) {
    return { outcome: "complete", active: state.activeLaunch.kind };
  }
  const recoveryProjectName = railwayRecoveryProjectName(operationId);
  const retainedPreparation = state.restoreTargetPreparation;
  if (retainedPreparation?.reconcile.pending?.kind === "project-create"
    && (retainedPreparation.reconcile.pending.attempt ?? 1) === 2
    && retainedPreparation.reconcile.receipt.resources.length === 0
    && retainedPreparation.target.projectName !== recoveryProjectName) {
    await updateRailwayMaintenanceState(input.stateRoot, path, { expectedRevision: state.revision }, (current) => ({
      ...current,
      revision: current.revision + 1,
      restoreTargetPreparation: {
        ...current.restoreTargetPreparation!,
        target: { ...current.restoreTargetPreparation!.target, projectName: recoveryProjectName },
        reconcile: {
          ...current.restoreTargetPreparation!.reconcile,
          pending: { kind: "project-create", logicalName: recoveryProjectName, attempt: 1 },
        },
      },
    }));
    return { outcome: "pending", phase: "restore-target" };
  }
  const volumes = await executor.listVolumeInstances({ projectId, environmentId });
  const volumeTarget = (name: string): string => {
    const volumeId = resource(input.source, "railway.volume", name); const matches = volumes.filter((volume) => volume.volumeId === volumeId);
    if (matches.length !== 1) throw new Error("Railway maintenance input is invalid"); return matches[0]!.id;
  };
  const serviceSources = new Map<string, string>();
  for (const service of topology.finalServices) {
    const serviceId = resource(input.source, "railway.service", service.name); const instance = await executor.getServiceInstance({ serviceId, environmentId });
    if (instance?.source?.image === undefined || instance.source.image === null || (instance.source.repo ?? null) !== null) throw new Error("Railway maintenance input is invalid");
    serviceSources.set(serviceId, instance.source.image);
  }
  const candidate = state.candidateUpgrade === undefined
    ? candidateBinding(input.source, topology, serviceSources, projectId, environmentId, operationId)
    : { releaseId: state.candidateUpgrade.releaseId, projectId: state.candidateUpgrade.projectId,
      environmentId: state.candidateUpgrade.environmentId, services: state.candidateUpgrade.services,
      migration: { migrationId: state.candidateUpgrade.migrationId, executionId: state.candidateUpgrade.migrationExecutionId } };
  const urls = resolveRailwayMaintenanceDatabaseUrls(input.projectionInputs);
  const target = { ...input.source.target, projectName: recoveryProjectName };
  const adapters = createRailwayUpgradeStageAdapters({ stateRoot: input.stateRoot, statePath: path, operationId,
    authorityGenerationId: input.authorityGenerationId, transport: guardedTransport, recoveryConfig: input.recoveryConfig,
    backup: { targets: [
      { kind: "application-postgres", volumeInstanceId: volumeTarget("app-postgres-data"), backupName: input.backupNames["application-postgres"] },
      { kind: "logto-postgres", volumeInstanceId: volumeTarget("logto-postgres-data"), backupName: input.backupNames["logto-postgres"] },
      { kind: "server-volume", volumeInstanceId: volumeTarget("nautilo-data"), backupName: input.backupNames["server-volume"] },
    ] }, portable: { exportOperationId: `export-${operationId}`, objectId: `bundle-${operationId}`,
      sourceMaintenanceImage: candidate.services.find(({ name }) => name === "nautilo-server")!.oldImage,
      targetMaintenanceImage: topology.finalServices.find(({ name }) => name === "nautilo-server")!.image,
      sourceAppDatabaseUrl: urls.app, sourceLogtoDatabaseUrl: urls.logto, targetAppDatabaseUrl: urls.app, targetLogtoDatabaseUrl: urls.logto },
    candidate, targetLaunchId: `restore-${operationId}`, providers: input.source.providers, topology,
    projectionInputs: input.projectionInputs, target, now: input.now, fetch: input.fetch, wait: input.wait,
    interrupted: input.interrupted, signal: input.signal });
  const result = await runRailwayUpgradeFromState({ stateRoot: input.stateRoot, statePath: path, operationId,
    authorityGenerationId: input.authorityGenerationId, adapters, now: input.now });
  return result.outcome === "complete" ? { outcome: "complete", active: (await readRailwayMaintenanceState(input.stateRoot, path))!.activeLaunch!.kind }
    : { outcome: result.outcome, phase: result.stage };
}
