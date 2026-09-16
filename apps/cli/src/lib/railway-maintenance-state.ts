import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { isIP } from "node:net";

import {
  parseMaintenanceReceipt,
  validateLaunchReceiptTransition,
  validateMaintenanceReceiptTransition,
  type HostingResourceReference,
  type MaintenanceReceipt,
  type LaunchReceipt,
} from "@nautilo/hosting";
import {
  isRailwayDestroyCheckpoint,
  isRailwayDestroyCheckpointTransition,
  isRailwayWholeManifestUpgradeCheckpoint,
  isRailwayWholeManifestUpgradeCheckpointTransition,
  type RailwayWholeManifestUpgradeBinding,
  RailwayDestroyCheckpoint,
  RailwayBootstrapLifecycleCheckpoint,
  RailwayExactServiceActivationCheckpoint,
  RailwayPortableMaintenanceCleanupCheckpoint,
  RailwayPortableMaintenanceTargetCheckpoint,
  RailwayRestoredTargetActivationCheckpoint,
  RailwayWholeManifestUpgradeCheckpoint,
  type RailwayTopology,
} from "@nautilo/railway-hosting";

import {
  parseRailwayDeploymentDriverState,
  type RailwayDeploymentDriverState,
} from "./railway-deployment-runner";

export const RAILWAY_MAINTENANCE_STATE_SCHEMA_VERSION = 1 as const;

/** Provider-proven short name used for a receipt-owned replacement project. */
export function railwayRecoveryProjectName(maintenanceId: string): string {
  const suffix = maintenanceId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (suffix.length !== 12) throw new RailwayMaintenanceStateStoreError("invalid-state");
  return `nautilo-recovery-${suffix}`;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_BYTES = 1024 * 1024;
const MAX_REVISION = 999_999_999;
/** Far above a normal maintenance run, while bounding hostile directory work. */
const MAX_DIRECTORY_ENTRIES = 1024;
const MAX_PUBLISHED_REVISIONS = 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST_ID = /^sha256:[a-f0-9]{64}$/;
const IMAGE = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const REVISION_FILE = /^revision-([0-9]{10})\.json$/;
const TEMP_FILE = /^\.revision-([0-9]{10})\.[0-9]+\.[A-Za-z0-9-]+\.tmp$/;
const SECRET_BYTES = /(?:\bBearer\s+\S+|:\/\/[^\s/:@"]+:[^\s/@"]+@|"(?:token|secret|password|credential|authorization|cookie|api[_-]?key|url)"\s*:|"path"\s*:(?!\s*"\/health")|\b(?:sk|pk|rk|gsk|tvly|xi|dop)[_-][A-Za-z0-9_-]{8,}\b|\brailway_(?!(?:PRIVATE|PUBLIC)_DOMAIN\b)[A-Za-z0-9_-]{8,}\b)/i;

type Plain = Record<string, unknown>;

export interface RailwayRestoredLogtoBootstrapState {
  readonly lifecycle: RailwayBootstrapLifecycleCheckpoint;
  readonly exactActivation?: RailwayExactServiceActivationCheckpoint | undefined;
}

export interface RailwayPortableOperationState {
  readonly target: RailwayPortableMaintenanceTargetCheckpoint;
  readonly cleanup?: RailwayPortableMaintenanceCleanupCheckpoint | undefined;
}

/** The eventual active projection is selected once and is never repointed. */
export interface RailwayMaintenanceActiveLaunch {
  readonly kind: "source" | "restore-target";
  readonly launchId: string;
  readonly releaseId: string;
  readonly selectedAt: string;
}

/** The terminal candidate outcome that irrevocably selected fresh-target fallback. */
export interface RailwayMaintenanceFallbackDecision {
  readonly reason: "candidate-upgrade" | "candidate-verification";
  readonly decidedAt: string;
}

/** Explicit operator authority to abandon exactly one receipt-owned replacement. */
export interface RailwayRestoreTargetDisposition {
  readonly schemaVersion: 1;
  readonly state: "discard-authorized";
  readonly reason: "operator-discard";
  readonly targetLaunchId: string;
  readonly targetProjectId: string;
  readonly teardownReceiptSha256: string;
  readonly authorizedAt: string;
}

/** Exact deployment created only to return a quiesced source service to use. */
export interface RailwaySourceRecoveryDeployment {
  readonly serviceName: "app-postgres" | "logto-postgres" | "logto" | "nautilo-server";
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly recordedAt: string;
}

/** One atomic, non-secret recovery truth for a Railway maintenance operation. */
export interface RailwayMaintenanceStateV1 {
  readonly schemaVersion: typeof RAILWAY_MAINTENANCE_STATE_SCHEMA_VERSION;
  readonly revision: number;
  readonly maintenanceId: string;
  readonly sourceLaunchId: string;
  readonly authorityGenerationId: string;
  readonly sourceManagedWorkbenchHostname: string;
  readonly sourceLaunchState: RailwayDeploymentDriverState;
  /** Verified target topology frozen before the first provider mutation. */
  readonly targetTopology?: RailwayTopology | undefined;
  readonly targetTopologySha256?: string | undefined;
  readonly targetTopologyMac?: string | undefined;
  readonly maintenanceReceipt: MaintenanceReceipt;
  /** Exact checkpoint for the in-place five-service, migration-aware candidate. */
  readonly candidateUpgrade?: RailwayWholeManifestUpgradeCheckpoint | undefined;
  /** Full target-release projection for a successfully upgraded source launch. */
  readonly postUpgradeSourceState?: RailwayDeploymentDriverState | undefined;
  /** Retained independently from later fallback failures so recovery remains causal. */
  readonly fallbackDecision?: RailwayMaintenanceFallbackDecision | undefined;
  readonly restoreTargetDisposition?: RailwayRestoreTargetDisposition | undefined;
  /** Append-only custody for recovery deployments outside the candidate ledger. */
  readonly sourceRecoveryDeployments?: readonly RailwaySourceRecoveryDeployment[] | undefined;
  /** Immutable selection after candidate verification or restore cutover. */
  readonly activeLaunch?: RailwayMaintenanceActiveLaunch | undefined;
  /** Receipt-owned destruction state is deliberately independent for both launches. */
  readonly sourceTeardown?: RailwayDestroyCheckpoint | undefined;
  readonly restoreTargetTeardown?: RailwayDestroyCheckpoint | undefined;
  /** Durable launch-driver progress for the sole fresh fallback target. */
  readonly restoreTargetPreparation?: RailwayDeploymentDriverState | undefined;
  readonly restoreTargetState?: RailwayDeploymentDriverState | undefined;
  readonly targetNautiloHostname?: string | undefined;
  readonly targetLogtoHostname?: string | undefined;
  readonly portableExport?: RailwayPortableOperationState | undefined;
  readonly portableRestore?: RailwayPortableOperationState | undefined;
  readonly logtoActivation?: RailwayExactServiceActivationCheckpoint | undefined;
  readonly restoredLogtoBootstrap?: RailwayRestoredLogtoBootstrapState | undefined;
  readonly nautiloActivation?: RailwayExactServiceActivationCheckpoint | undefined;
  readonly restoredTargetActivation?: RailwayRestoredTargetActivationCheckpoint | undefined;
}

export type RailwayMaintenanceState = RailwayMaintenanceStateV1;

export type RailwayMaintenanceStateStoreErrorCode =
  | "unsafe-path" | "unsafe-permissions" | "unsafe-owner" | "state-too-large"
  | "invalid-json" | "invalid-state" | "invalid-chain" | "revision-conflict"
  | "invalid-transition" | "io-failure" | "publish-unknown";

export class RailwayMaintenanceStateStoreError extends Error {
  readonly code: RailwayMaintenanceStateStoreErrorCode;
  constructor(code: RailwayMaintenanceStateStoreErrorCode) {
    super(`Railway maintenance state store failed: ${code}`);
    this.name = "RailwayMaintenanceStateStoreError";
    this.code = code;
  }
}

export interface RailwayMaintenanceStateWriteHooks {
  readonly afterTempSync?: (() => void | Promise<void>) | undefined;
  readonly afterPublish?: (() => void | Promise<void>) | undefined;
  readonly afterDirectorySync?: (() => void | Promise<void>) | undefined;
}

export interface WriteRailwayMaintenanceStateOptions {
  readonly hooks?: RailwayMaintenanceStateWriteHooks | undefined;
}

export interface UpdateRailwayMaintenanceStateOptions extends WriteRailwayMaintenanceStateOptions {
  readonly expectedRevision: number;
}

function plain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, keys: readonly string[]): value is Plain {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeId(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value); }
function sha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function integer(value: unknown, minimum = 0, maximum = MAX_REVISION): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function validPortableTransfer(value: unknown): value is RailwayPortableMaintenanceTargetCheckpoint {
  if (!plain(value) || !["prepared", "start-pending", "start-unknown", "started"].includes(String(value["state"]))) return false;
  const baseline = value["state"] === "start-pending" || value["state"] === "start-unknown";
  const started = value["state"] === "started";
  if (!exact(value, ["state", "attempt", "operationId", "direction", "objectId", "projectId", "environmentId", "serviceId", "image", "sourceReleaseId", "command", "startEffect", ...(baseline ? ["baselineDeploymentIds"] : []), ...(started ? ["jobId"] : [])])) return false;
  const ids = value["baselineDeploymentIds"];
  const command = `bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts ${String(value["direction"])} ${String(value["operationId"])} ${String(value["objectId"])}`;
  return integer(value["attempt"], 1, 8) && [value["operationId"], value["objectId"], value["projectId"], value["environmentId"], value["serviceId"], value["sourceReleaseId"]].every(safeId)
    && (value["direction"] === "export" || value["direction"] === "restore")
    && typeof value["image"] === "string" && IMAGE.test(value["image"])
    && value["command"] === command && (value["startEffect"] === "connect" || value["startEffect"] === "deploy")
    && (!baseline || Array.isArray(ids) && ids.length <= 256 && ids.every(safeId) && new Set(ids).size === ids.length)
    && (!started || safeId(value["jobId"]));
}

function validCleanup(value: unknown): value is RailwayPortableMaintenanceCleanupCheckpoint {
  if (!plain(value) || !["deleting", "delete-pending", "reset-pending", "complete"].includes(String(value["state"]))) return false;
  const pending = value["state"] === "delete-pending";
  if (!exact(value, ["schemaVersion", "projectId", "environmentId", "serviceId", "operationId", "imageDigest", "commandSha256", "state", "completedDeletes", ...(pending ? ["deleteIndex"] : [])])) return false;
  const count = value["completedDeletes"];
  return value["schemaVersion"] === 1 && [value["projectId"], value["environmentId"], value["serviceId"], value["operationId"]].every(safeId)
    && sha(value["imageDigest"]) && sha(value["commandSha256"]) && integer(count, 0, 12)
    && (!pending || value["deleteIndex"] === count && (count) < 12)
    && ((value["state"] !== "reset-pending" && value["state"] !== "complete") || count === 12);
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function validPortableOperation(value: unknown, direction: "export" | "restore", receipt: MaintenanceReceipt): value is RailwayPortableOperationState {
  if (!plain(value)) return false;
  const hasCleanup = value["cleanup"] !== undefined;
  if (!exact(value, ["target", ...(hasCleanup ? ["cleanup"] : [])]) || !validPortableTransfer(value["target"])) return false;
  const target = value["target"];
  if (target.direction !== direction) return false;
  if (!hasCleanup) return true;
  if (!validCleanup(value["cleanup"]) || target.state !== "started") return false;
  const cleanup = value["cleanup"];
  const workflow = receipt.providerWorkflows?.find((candidate) =>
    candidate.operation === `${direction}-portable` && candidate.workflowId === target.jobId && candidate.state === "complete");
  const imageDigest = target.image.split("@sha256:")[1];
  return workflow !== undefined && cleanup.projectId === target.projectId && cleanup.environmentId === target.environmentId
    && cleanup.serviceId === target.serviceId && cleanup.operationId === target.operationId
    && cleanup.imageDigest === imageDigest && cleanup.commandSha256 === hash(target.command);
}

function validExactActivation(value: unknown): value is RailwayExactServiceActivationCheckpoint {
  if (!plain(value) || !["prepared", "start-pending", "start-unknown", "started", "complete"].includes(String(value["state"]))) return false;
  const baseline = value["state"] === "start-pending" || value["state"] === "start-unknown";
  const job = value["state"] === "started" || value["state"] === "complete";
  if (!exact(value, ["projectId", "environmentId", "serviceId", "image", "effect", "startEffect", "attempt", "state", ...(baseline ? ["baselineDeploymentIds"] : []), ...(job ? ["jobId"] : [])])) return false;
  const ids = value["baselineDeploymentIds"];
  return [value["projectId"], value["environmentId"], value["serviceId"]].every(safeId)
    && typeof value["image"] === "string" && IMAGE.test(value["image"])
    && (value["effect"] === "connect" || value["effect"] === "deploy")
    && (value["startEffect"] === "connect" || value["startEffect"] === "deploy")
    && integer(value["attempt"], 1, 8)
    && (value["effect"] === "connect" || value["startEffect"] === "deploy")
    && (value["attempt"] !== 1 || value["startEffect"] === value["effect"])
    && (!baseline || Array.isArray(ids) && ids.length <= 256 && ids.every(safeId) && new Set(ids).size === ids.length)
    && (!job || safeId(value["jobId"]));
}

function validBootstrap(value: unknown): value is RailwayBootstrapLifecycleCheckpoint {
  if (!plain(value)) return false;
  const optional = ["serviceId", "variablesApplied", "deploymentId", "successfulDeploymentId", "failedDeploymentId", "handoffDomainId", "handoffDomain", "handoffApplied"];
  const present = optional.filter((key) => value[key] !== undefined);
  if (!exact(value, ["schemaVersion", "projectId", "environmentId", "serviceName", "imageDigest", ...present])) return false;
  if (value["schemaVersion"] !== 1 || !safeId(value["projectId"]) || !safeId(value["environmentId"])
    || value["serviceName"] !== "nautilo-bootstrap" || typeof value["imageDigest"] !== "string" || !DIGEST_ID.test(value["imageDigest"])) return false;
  for (const key of ["serviceId", "deploymentId", "successfulDeploymentId", "failedDeploymentId", "handoffDomainId"] as const) {
    if (value[key] !== undefined && !safeId(value[key])) return false;
  }
  if (value["variablesApplied"] !== undefined && value["variablesApplied"] !== true) return false;
  if (value["handoffApplied"] !== undefined && value["handoffApplied"] !== true) return false;
  if (value["handoffDomain"] !== undefined && (typeof value["handoffDomain"] !== "string" || !HOSTNAME.test(value["handoffDomain"]))) return false;
  const hasDeployment = value["deploymentId"] !== undefined;
  const successful = value["successfulDeploymentId"];
  const failed = value["failedDeploymentId"];
  const hasDomain = value["handoffDomainId"] !== undefined || value["handoffDomain"] !== undefined;
  return (value["variablesApplied"] === undefined || value["serviceId"] !== undefined)
    && (!hasDeployment || (value["serviceId"] !== undefined && value["variablesApplied"] === true))
    && (successful === undefined || successful === value["deploymentId"])
    && (failed === undefined || failed === value["deploymentId"])
    && !(successful !== undefined && failed !== undefined)
    && (!hasDomain || (value["handoffDomainId"] !== undefined && value["handoffDomain"] !== undefined && value["serviceId"] !== undefined))
    && (value["handoffApplied"] !== true || (hasDomain && successful !== undefined));
}

function validRestoredActivation(value: unknown): value is RailwayRestoredTargetActivationCheckpoint {
  if (!plain(value) || !["gates", "logto-start", "logto-observe", "bootstrap-nautilo-start", "nautilo-observe", "readiness", "complete"].includes(String(value["stage"]))) return false;
  const optional = ["logtoDeploymentId", "nautiloDeploymentId"].filter((key) => value[key] !== undefined);
  if (!exact(value, ["schemaVersion", "releaseId", "projectId", "environmentId", "logtoServiceId", "nautiloServiceId", "logtoImageDigest", "nautiloImageDigest", "bootstrapImageDigest", "authorityGenerationId", "intentSha256", "effectSha256", "stage", ...optional])) return false;
  const stages = ["gates", "logto-start", "logto-observe", "bootstrap-nautilo-start", "nautilo-observe", "readiness", "complete"];
  const stageIndex = stages.indexOf(String(value["stage"]));
  const logtoIndex = stages.indexOf("logto-observe");
  const nautiloIndex = stages.indexOf("nautilo-observe");
  return value["schemaVersion"] === 1
    && [value["releaseId"], value["projectId"], value["environmentId"], value["logtoServiceId"], value["nautiloServiceId"], value["authorityGenerationId"]].every(safeId)
    && [value["logtoImageDigest"], value["nautiloImageDigest"], value["bootstrapImageDigest"], value["intentSha256"], value["effectSha256"]].every(sha)
    && (value["logtoDeploymentId"] === undefined || safeId(value["logtoDeploymentId"]))
    && (value["nautiloDeploymentId"] === undefined || safeId(value["nautiloDeploymentId"]))
    && (stageIndex >= logtoIndex ? value["logtoDeploymentId"] !== undefined : value["logtoDeploymentId"] === undefined)
    && (stageIndex >= nautiloIndex ? value["nautiloDeploymentId"] !== undefined : value["nautiloDeploymentId"] === undefined);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function candidateBinding(value: unknown, projectId: string, environmentId: string, releaseId: string): RailwayWholeManifestUpgradeBinding | undefined {
  if (!plain(value) || !Array.isArray(value["services"]) || !safeId(value["migrationId"]) || !safeId(value["migrationExecutionId"])) return undefined;
  const services = value["services"] as RailwayWholeManifestUpgradeBinding["services"];
  if (!services.every(plain)) return undefined;
  if (new Set(services.map((service) => service.serviceId)).size !== 5) return undefined;
  return { releaseId, projectId, environmentId, services,
    migration: { migrationId: value["migrationId"], executionId: value["migrationExecutionId"] } };
}

function validCandidateUpgrade(value: unknown, projectId: string, environmentId: string, releaseId: string): value is RailwayWholeManifestUpgradeCheckpoint {
  const binding = candidateBinding(value, projectId, environmentId, releaseId);
  if (binding === undefined || !isRailwayWholeManifestUpgradeCheckpoint(value, binding)) return false;
  if (value.stage === "started") return !value.completedDeployments.some((entry) => entry.deploymentId === value.deploymentId);
  return value.stage !== "start-ambiguous" || value.ambiguousDeploymentIds!.every((id) => (
    !value.completedDeployments.some((entry) => entry.deploymentId === id)
  ));
}

function validPostUpgradeSourceState(value: unknown, source: RailwayDeploymentDriverState, receipt: MaintenanceReceipt, candidate: RailwayWholeManifestUpgradeCheckpoint | undefined): value is RailwayDeploymentDriverState {
  let parsed: RailwayDeploymentDriverState;
  try { parsed = parseRailwayDeploymentDriverState(value); } catch { return false; }
  if (candidate?.stage !== "complete" || candidate.completedDeployments.length !== 4
    || parsed.launchId !== source.launchId || parsed.releaseId !== receipt.targetReleaseId
    || !stableIdentity(source as unknown as Plain, parsed as unknown as Plain, ["schemaVersion", "launchId", "providers", "target", "workflow", "databaseBootstrap", "logtoBootstrap", "destroy"])
    || !same(source.reconcile.pending, parsed.reconcile.pending)) return false;
  const before = source.reconcile.receipt; const after = parsed.reconcile.receipt;
  if (after.launchId !== before.launchId || after.backend !== before.backend || after.stage !== before.stage
    || after.cleanup.state !== before.cleanup.state || after.createdAt !== before.createdAt
    || after.revision !== before.revision + 1 || Date.parse(after.updatedAt) < Date.parse(before.updatedAt)) return false;
  return same(after.resources, postUpgradeResources(before.resources, candidate));
}

function candidateDeploymentResources(candidate: RailwayWholeManifestUpgradeCheckpoint | undefined): readonly { readonly kind: "railway.deployment"; readonly id: string; readonly name: string }[] {
  if (candidate === undefined) return [];
  const completed = candidate.completedDeployments.map((entry) => ({ kind: "railway.deployment" as const, id: entry.deploymentId, name: entry.name }));
  const withMigration = candidate.migrationDeploymentId === undefined || completed.some((entry) => entry.id === candidate.migrationDeploymentId)
    ? completed : [...completed, { kind: "railway.deployment" as const, id: candidate.migrationDeploymentId, name: "nautilo-server-migration" }];
  if (candidate.stage === "migration-start-ambiguous") {
    return [...withMigration, ...candidate.ambiguousDeploymentIds!.map((id, index) => ({
      kind: "railway.deployment" as const, id, name: `nautilo-server-migration-ambiguous-${String(index)}`,
    }))];
  }
  if (candidate.stage === "start-ambiguous" && candidate.serviceIndex !== undefined) {
    const service = candidate.services[candidate.serviceIndex];
    if (service === undefined || service.name === "logto-seed") return withMigration;
    return [...withMigration, ...candidate.ambiguousDeploymentIds!.map((id, index) => ({
      kind: "railway.deployment" as const, id, name: `${service.name}-ambiguous-${String(index)}`,
    }))];
  }
  if (candidate.stage !== "started" || candidate.deploymentId === undefined || candidate.serviceIndex === undefined) return withMigration;
  const service = candidate.services[candidate.serviceIndex];
  return service === undefined || service.name === "logto-seed" || withMigration.some((entry) => entry.id === candidate.deploymentId)
    ? withMigration : [...withMigration, { kind: "railway.deployment", id: candidate.deploymentId, name: service.name }];
}

function validSourceRecoveryDeployments(
  value: unknown,
  source: RailwayDeploymentDriverState,
): value is readonly RailwaySourceRecoveryDeployment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!exact(entry, ["serviceName", "serviceId", "deploymentId", "recordedAt"])
      || typeof entry["serviceName"] !== "string"
      || !["app-postgres", "logto-postgres", "logto", "nautilo-server"].includes(entry["serviceName"])
      || !safeId(entry["serviceId"]) || !safeId(entry["deploymentId"]) || !validTimestamp(entry["recordedAt"])
      || ids.has(entry["deploymentId"])) return false;
    ids.add(entry["deploymentId"]);
    return source.reconcile.receipt.resources.filter((resource) => resource.kind === "railway.service"
      && resource.name === entry["serviceName"] && resource.id === entry["serviceId"]).length === 1;
  });
}

function recoveryDeploymentResources(recovery: readonly RailwaySourceRecoveryDeployment[] | undefined) {
  return (recovery ?? []).map((entry, index) => ({
    kind: "railway.deployment" as const,
    id: entry.deploymentId,
    name: `${entry.serviceName}-recovery-${String(index)}`,
  }));
}

function postUpgradeResources(resources: LaunchReceipt["resources"], candidate: RailwayWholeManifestUpgradeCheckpoint): LaunchReceipt["resources"] {
  return [...resources.filter((resource) => resource.kind !== "railway.deployment"),
    ...candidate.completedDeployments.map((entry) => ({ kind: "railway.deployment" as const, id: entry.deploymentId, name: entry.name }))];
}

export function createRailwayPostUpgradeSourceState(
  source: RailwayDeploymentDriverState,
  candidate: RailwayWholeManifestUpgradeCheckpoint,
  targetReleaseId: string,
  now: string,
): RailwayDeploymentDriverState {
  return { ...source, releaseId: targetReleaseId, reconcile: { ...source.reconcile, receipt: {
    ...source.reconcile.receipt, revision: source.reconcile.receipt.revision + 1, updatedAt: now,
    resources: postUpgradeResources(source.reconcile.receipt.resources, candidate),
  } } };
}

export function createRailwaySourceTeardownReceipt(
  source: RailwayDeploymentDriverState,
  candidate: RailwayWholeManifestUpgradeCheckpoint | undefined,
  recovery?: readonly RailwaySourceRecoveryDeployment[],
): LaunchReceipt {
  const additions = [...candidateDeploymentResources(candidate), ...recoveryDeploymentResources(recovery)];
  const replacedNames = new Set(additions.map((addition) => addition.name));
  return { ...source.reconcile.receipt, resources: [
    ...source.reconcile.receipt.resources.filter((resource) => resource.kind !== "railway.deployment"
      || resource.name === undefined || !replacedNames.has(resource.name)),
    ...additions,
  ] };
}

function restoreTargetSupplementalResources(
  state: RailwayMaintenanceState,
  includeBootstrapCustody: boolean,
): LaunchReceipt["resources"] {
  const target = state.restoreTargetState ?? state.restoreTargetPreparation;
  const ids: string[] = [];
  const add = (value: string | undefined): void => {
    if (value !== undefined && !ids.includes(value)) ids.push(value);
  };
  const portable = state.portableRestore?.target;
  if (portable?.state === "started") add(portable.jobId);
  const addActivation = (value: RailwayExactServiceActivationCheckpoint | undefined): void => {
    if (value?.state === "started" || value?.state === "complete") add(value.jobId);
  };
  addActivation(state.logtoActivation);
  addActivation(state.restoredLogtoBootstrap?.exactActivation);
  addActivation(state.nautiloActivation);
  const bootstrap = state.restoredLogtoBootstrap?.lifecycle;
  add(bootstrap?.deploymentId);
  add(bootstrap?.successfulDeploymentId);
  add(bootstrap?.failedDeploymentId);
  add(state.restoredTargetActivation?.logtoDeploymentId);
  add(state.restoredTargetActivation?.nautiloDeploymentId);
  add(target?.databaseBootstrap?.deploymentId);
  add(target?.databaseBootstrap?.successfulDeploymentId);
  add(target?.databaseBootstrap?.failedDeploymentId);
  add(target?.logtoBootstrap?.deploymentId);
  add(target?.logtoBootstrap?.successfulDeploymentId);
  add(target?.logtoBootstrap?.failedDeploymentId);
  const retained = new Set(target?.reconcile.receipt.resources
    .filter((resource) => resource.kind === "railway.deployment").map((resource) => resource.id) ?? []);
  const deployments = ids.filter((id) => !retained.has(id)).map((id, index) => ({
    kind: "railway.deployment" as const,
    id,
    name: `restore-maintenance-${String(index)}`,
  }));
  if (!includeBootstrapCustody) return deployments;
  const lifecycle = state.restoredLogtoBootstrap?.lifecycle;
  const retainedResources = target?.reconcile.receipt.resources ?? [];
  const bootstrapResources: Array<LaunchReceipt["resources"][number]> = [];
  if (lifecycle?.serviceId !== undefined && !retainedResources.some((resource) => (
    resource.kind === "railway.service" && resource.id === lifecycle.serviceId
  ))) {
    bootstrapResources.push({ kind: "railway.service", id: lifecycle.serviceId, name: "nautilo-bootstrap" });
  }
  if (lifecycle?.handoffDomainId !== undefined && !retainedResources.some((resource) => (
    resource.kind === "railway.domain" && resource.id === lifecycle.handoffDomainId
  ))) {
    bootstrapResources.push({ kind: "railway.domain", id: lifecycle.handoffDomainId, name: "nautilo-bootstrap" });
  }
  return [...deployments, ...bootstrapResources];
}

/** Exact replacement-project custody, including every checkpoint-owned maintenance deployment. */
export function createRailwayRestoreTargetTeardownReceipt(state: RailwayMaintenanceState): LaunchReceipt {
  const target = state.restoreTargetState ?? state.restoreTargetPreparation;
  if (target === undefined) throw new RailwayMaintenanceStateStoreError("invalid-state");
  return {
    ...target.reconcile.receipt,
    resources: [
      ...target.reconcile.receipt.resources,
      ...restoreTargetSupplementalResources(state, true),
    ],
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => {
    const member = value[key];
    if (member === undefined) throw new RailwayMaintenanceStateStoreError("invalid-state");
    return `${JSON.stringify(key)}:${canonicalJson(member)}`;
  }).join(",")}}`;
  throw new RailwayMaintenanceStateStoreError("invalid-state");
}

/** Canonical binding used by explicit discard authority and every cleanup resume. */
export function railwayRestoreTargetTeardownReceiptSha256(state: RailwayMaintenanceState): string {
  return createHash("sha256").update(canonicalJson(createRailwayRestoreTargetTeardownReceipt(state)), "utf8").digest("hex");
}

function createLegacyRailwayRestoreTargetTeardownReceipt(state: RailwayMaintenanceState): LaunchReceipt {
  const target = state.restoreTargetState ?? state.restoreTargetPreparation;
  if (target === undefined) throw new RailwayMaintenanceStateStoreError("invalid-state");
  return {
    ...target.reconcile.receipt,
    resources: [
      ...target.reconcile.receipt.resources,
      ...restoreTargetSupplementalResources(state, false),
    ],
  };
}

function isLegacyRestoreTargetTeardown(state: RailwayMaintenanceState): boolean {
  return state.restoreTargetTeardown?.stage === "validate"
    && same(state.restoreTargetTeardown.receipt, createLegacyRailwayRestoreTargetTeardownReceipt(state));
}

function validActiveLaunch(value: unknown, source: RailwayDeploymentDriverState | undefined, target: RailwayDeploymentDriverState | undefined): value is RailwayMaintenanceActiveLaunch {
  if (!exact(value, ["kind", "launchId", "releaseId", "selectedAt"]) || !validTimestamp(value["selectedAt"])) return false;
  if (value["kind"] === "source") return source !== undefined && value["launchId"] === source.launchId && value["releaseId"] === source.releaseId;
  return value["kind"] === "restore-target" && target !== undefined && value["launchId"] === target.launchId && value["releaseId"] === target.releaseId;
}

function validFallbackDecision(
  value: unknown,
  candidate: RailwayWholeManifestUpgradeCheckpoint | undefined,
  postSource: RailwayDeploymentDriverState | undefined,
): value is RailwayMaintenanceFallbackDecision {
  if (!exact(value, ["reason", "decidedAt"]) || !validTimestamp(value["decidedAt"])) return false;
  if (value["reason"] === "candidate-upgrade") return candidate !== undefined && candidate.stage !== "complete";
  return value["reason"] === "candidate-verification" && candidate?.stage === "complete" && postSource !== undefined;
}

function validRestoreTargetDisposition(
  value: unknown,
  state: RailwayMaintenanceState,
  target: RailwayDeploymentDriverState | undefined,
  receipt: MaintenanceReceipt,
): value is RailwayRestoreTargetDisposition {
  if (target === undefined || !exact(value, ["schemaVersion", "state", "reason", "targetLaunchId", "targetProjectId", "teardownReceiptSha256", "authorizedAt"])
    || value["schemaVersion"] !== 1 || value["state"] !== "discard-authorized" || value["reason"] !== "operator-discard"
    || value["targetLaunchId"] !== target.launchId || !safeId(value["targetProjectId"])
    || !sha(value["teardownReceiptSha256"]) || !validTimestamp(value["authorizedAt"])
    || receipt.stage === "cutover" || receipt.stage === "complete" || state.activeLaunch !== undefined) return false;
  const projects = target.reconcile.receipt.resources.filter((resource) => resource.kind === "railway.project");
  return projects.length === 1 && projects[0]?.id === value["targetProjectId"]
    && value["teardownReceiptSha256"] === railwayRestoreTargetTeardownReceiptSha256(state);
}

function validTeardown(value: unknown, expected: LaunchReceipt): value is RailwayDestroyCheckpoint {
  return isRailwayDestroyCheckpoint(value, expected);
}

function serialized(value: unknown): string | undefined {
  try {
    const bytes = JSON.stringify(value);
    return Buffer.byteLength(bytes, "utf8") <= MAX_BYTES && !SECRET_BYTES.test(bytes) ? bytes : undefined;
  } catch { return undefined; }
}

const ENVELOPE_KEYS = ["schemaVersion", "revision", "maintenanceId", "sourceLaunchId", "authorityGenerationId", "sourceManagedWorkbenchHostname", "sourceLaunchState", "maintenanceReceipt"] as const;
const CHILD_KEYS = ["targetTopology", "targetTopologySha256", "targetTopologyMac", "candidateUpgrade", "postUpgradeSourceState", "fallbackDecision", "restoreTargetDisposition", "sourceRecoveryDeployments", "activeLaunch", "sourceTeardown", "restoreTargetTeardown", "restoreTargetPreparation", "restoreTargetState", "targetNautiloHostname", "targetLogtoHostname", "portableExport", "portableRestore", "logtoActivation", "restoredLogtoBootstrap", "nautiloActivation", "restoredTargetActivation"] as const;

function validStoredTopology(value: unknown, releaseId: string, digest: unknown): value is RailwayTopology {
  const bytes = serialized(value);
  if (!plain(value) || bytes === undefined || !sha(digest)
    || createHash("sha256").update(bytes, "utf8").digest("hex") !== digest
    || value["schemaVersion"] !== 1 || value["releaseId"] !== releaseId
    || !Array.isArray(value["finalServices"]) || !Array.isArray(value["mounts"])
    || !Array.isArray(value["generatedPublicDomains"]) || !Array.isArray(value["qualifications"])
    || !plain(value["transientBootstrap"]) || !plain(value["transientLogtoBootstrap"])) return false;
  const names = value["finalServices"].map((service) => plain(service) ? service["name"] : undefined);
  if (JSON.stringify(names) !== JSON.stringify(["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"])) return false;
  return value["finalServices"].every((service) => plain(service) && typeof service["image"] === "string" && IMAGE.test(service["image"]))
    && [value["transientBootstrap"], value["transientLogtoBootstrap"]].every((child) => typeof child["image"] === "string" && IMAGE.test(child["image"]));
}

function validPublicHostname(value: unknown): value is string {
  return typeof value === "string" && HOSTNAME.test(value) && value.includes(".") && isIP(value) === 0 && value !== "localhost";
}

function validRestoreTargetState(value: unknown, envelope: Plain, receipt: MaintenanceReceipt): value is RailwayDeploymentDriverState {
  let target: RailwayDeploymentDriverState;
  try { target = parseRailwayDeploymentDriverState(value); } catch { return false; }
  if (receipt.restoreTarget === undefined || target.launchId === envelope["sourceLaunchId"]
    || target.releaseId !== receipt.targetReleaseId || target.reconcile.receipt.stage !== "claimable"
    || !successfulRestoreDatabaseBootstrap(target) || !validRestorePreparationChildren(target)) return false;
  const resources = target.reconcile.receipt.resources;
  const exact = (kind: string, name: string, id?: string): boolean => {
    const matches = resources.filter((resource) => resource.kind === kind && resource.name === name);
    return matches.length === 1 && (id === undefined || matches[0]?.id === id);
  };
  const exactId = (kind: string, id: string): boolean => resources.filter((resource) => resource.kind === kind && resource.id === id).length === 1;
  return exactId("railway.project", receipt.restoreTarget.projectId)
    && exactId("railway.environment", receipt.restoreTarget.environmentId)
    && exact("railway.service", "logto") && exact("railway.service", "nautilo-server")
    && exact("railway.domain", "nautilo-public") && exact("railway.domain", "logto-public");
}

function validRestoreTargetPreparation(value: unknown, envelope: Plain, receipt: MaintenanceReceipt): value is RailwayDeploymentDriverState {
  let target: RailwayDeploymentDriverState;
  try { target = parseRailwayDeploymentDriverState(value); } catch { return false; }
  return target.launchId !== envelope["sourceLaunchId"] && target.releaseId === receipt.targetReleaseId
    && validRestorePreparationChildren(target);
}

function validRestorePreparationChildren(target: RailwayDeploymentDriverState): boolean {
  const bootstrap = target.databaseBootstrap;
  if (target.workflow !== undefined || target.logtoBootstrap !== undefined || target.destroy !== undefined) return false;
  if (bootstrap === undefined) return true;
  const resources = target.reconcile.receipt.resources;
  const exactResource = (kind: string, name: string): HostingResourceReference | undefined => {
    const matches = resources.filter((resource) => resource.kind === kind && resource.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  return validBootstrap(bootstrap)
    && bootstrap.handoffDomainId === undefined && bootstrap.handoffDomain === undefined
    && bootstrap.handoffApplied === undefined
    && exactResource("railway.project", target.target.projectName)?.id === bootstrap.projectId
    && exactResource("railway.environment", target.target.environmentName)?.id === bootstrap.environmentId
    && ["app-postgres", "logto-postgres"].every((name) => (
      exactResource("railway.service", name) !== undefined
      && exactResource("railway.service-image", name) !== undefined
      && exactResource("railway.variable-collection", `variables-${name}`) !== undefined
      && exactResource("railway.deployment", name) !== undefined
    ))
    && ["app-postgres-data", "logto-postgres-data"].every((name) => exactResource("railway.volume", name) !== undefined);
}

function successfulRestoreDatabaseBootstrap(target: RailwayDeploymentDriverState): boolean {
  const bootstrap = target.databaseBootstrap;
  return bootstrap !== undefined
    && bootstrap.successfulDeploymentId !== undefined
    && bootstrap.successfulDeploymentId === bootstrap.deploymentId
    && bootstrap.failedDeploymentId === undefined;
}

function validSourceLaunchState(value: unknown, envelope: Plain, receipt: MaintenanceReceipt): value is RailwayDeploymentDriverState {
  let source: RailwayDeploymentDriverState;
  try { source = parseRailwayDeploymentDriverState(value); } catch { return false; }
  if (source.launchId !== envelope["sourceLaunchId"] || source.releaseId !== receipt.sourceReleaseId) return false;
  const resources = source.reconcile.receipt.resources;
  return ["railway.project", "railway.environment"].every((kind) => resources.filter((resource) => resource.kind === kind).length === 1)
    && ["logto", "nautilo-server"].every((name) => resources.filter((resource) => resource.kind === "railway.service" && resource.name === name).length === 1)
    && resources.filter((resource) => resource.kind === "railway.domain" && resource.name === "nautilo-public").length === 1;
}

function validateState(value: unknown): RailwayMaintenanceState | undefined {
  if (!plain(value)) return undefined;
  const children = CHILD_KEYS.filter((key) => value[key] !== undefined);
  if (!exact(value, [...ENVELOPE_KEYS, ...children]) || serialized(value) === undefined) return undefined;
  const parsed = parseMaintenanceReceipt(value["maintenanceReceipt"]);
  if (!parsed.ok || value["schemaVersion"] !== RAILWAY_MAINTENANCE_STATE_SCHEMA_VERSION
    || !integer(value["revision"]) || !safeId(value["maintenanceId"]) || !safeId(value["sourceLaunchId"])
    || !safeId(value["authorityGenerationId"]) || !validPublicHostname(value["sourceManagedWorkbenchHostname"])
    || parsed.receipt.maintenanceId !== value["maintenanceId"] || parsed.receipt.launchId !== value["sourceLaunchId"]
    || !validSourceLaunchState(value["sourceLaunchState"], value, parsed.receipt)
    || ((value["targetTopology"] === undefined) !== (value["targetTopologySha256"] === undefined))
    || ((value["targetTopology"] === undefined) !== (value["targetTopologyMac"] === undefined))
    || (value["targetTopologyMac"] !== undefined && !sha(value["targetTopologyMac"]))
    || (value["targetTopology"] !== undefined && !validStoredTopology(value["targetTopology"], parsed.receipt.targetReleaseId, value["targetTopologySha256"]))
    || (value["candidateUpgrade"] !== undefined && !validCandidateUpgrade(value["candidateUpgrade"],
      value["sourceLaunchState"].reconcile.receipt.resources.find((resource) => resource.kind === "railway.project")!.id,
      value["sourceLaunchState"].reconcile.receipt.resources.find((resource) => resource.kind === "railway.environment")!.id,
      parsed.receipt.targetReleaseId))
    || (value["postUpgradeSourceState"] !== undefined && !validPostUpgradeSourceState(value["postUpgradeSourceState"], value["sourceLaunchState"], parsed.receipt, value["candidateUpgrade"]))
    || (value["fallbackDecision"] !== undefined && !validFallbackDecision(
      value["fallbackDecision"], value["candidateUpgrade"], value["postUpgradeSourceState"],
    ))
    || (value["sourceRecoveryDeployments"] !== undefined
      && !validSourceRecoveryDeployments(value["sourceRecoveryDeployments"], value["sourceLaunchState"]))
    || (value["restoreTargetPreparation"] !== undefined && !validRestoreTargetPreparation(value["restoreTargetPreparation"], value, parsed.receipt))
    || (value["sourceTeardown"] !== undefined && !isRailwayDestroyCheckpoint(value["sourceTeardown"],
      createRailwaySourceTeardownReceipt(value["sourceLaunchState"], value["candidateUpgrade"], value["sourceRecoveryDeployments"])))
    || (value["portableExport"] !== undefined && !validPortableOperation(value["portableExport"], "export", parsed.receipt))
    || (value["portableRestore"] !== undefined && !validPortableOperation(value["portableRestore"], "restore", parsed.receipt))
    || (value["logtoActivation"] !== undefined && !validExactActivation(value["logtoActivation"]))
    || (value["nautiloActivation"] !== undefined && !validExactActivation(value["nautiloActivation"]))
    || (value["restoredTargetActivation"] !== undefined && !validRestoredActivation(value["restoredTargetActivation"]))) return undefined;
  if (value["sourceTeardown"]?.stage === "validate" && !same(value["sourceTeardown"].receipt,
    createRailwaySourceTeardownReceipt(value["sourceLaunchState"], value["candidateUpgrade"], value["sourceRecoveryDeployments"]))) return undefined;
  const restoreTargetTeardown = value["restoreTargetTeardown"] as RailwayDestroyCheckpoint | undefined;
  if (restoreTargetTeardown?.stage === "validate"
    && !same(restoreTargetTeardown.receipt, createRailwayRestoreTargetTeardownReceipt(value as unknown as RailwayMaintenanceState))
    && !isLegacyRestoreTargetTeardown(value as unknown as RailwayMaintenanceState)) return undefined;
  const fallback = value["fallbackDecision"];
  const failure = parsed.receipt.lastFailure;
  if (failure?.retryable === false && (failure.operation === "candidate-upgrade" || failure.operation === "candidate-verification")
    && fallback?.reason !== failure.operation) return undefined;
  if (fallback !== undefined && (failure?.retryable !== false || ![
    fallback.reason, "restore-target-preparation", "restore-portable", "restore-maintenance-cleanup", "restore-activation", "restore-verification",
  ].includes(failure.operation))) return undefined;
  const hasTargetState = value["restoreTargetState"] !== undefined;
  const hasNautiloHostname = value["targetNautiloHostname"] !== undefined;
  const hasLogtoHostname = value["targetLogtoHostname"] !== undefined;
  if (hasTargetState !== hasNautiloHostname || hasTargetState !== hasLogtoHostname
    || (hasTargetState && (!validPublicHostname(value["targetNautiloHostname"]) || !validPublicHostname(value["targetLogtoHostname"])
    || value["targetNautiloHostname"] === value["sourceManagedWorkbenchHostname"]
    || value["targetLogtoHostname"] === value["sourceManagedWorkbenchHostname"]
    || value["targetLogtoHostname"] === value["targetNautiloHostname"]
    || !validRestoreTargetState(value["restoreTargetState"], value, parsed.receipt)))) return undefined;
  const targetState = value["restoreTargetState"] as RailwayDeploymentDriverState | undefined;
  const targetPreparation = value["restoreTargetPreparation"];
  if (targetState !== undefined && targetPreparation !== undefined && !same(targetState, targetPreparation)) return undefined;
  const postSource = value["postUpgradeSourceState"];
  const disposition = value["restoreTargetDisposition"];
  if (disposition !== undefined && !validRestoreTargetDisposition(
    disposition,
    value as unknown as RailwayMaintenanceState,
    targetState ?? targetPreparation,
    parsed.receipt,
  )) return undefined;
  if ((value["restoreTargetTeardown"] !== undefined && ((targetState ?? targetPreparation) === undefined
    || (!validTeardown(value["restoreTargetTeardown"], createRailwayRestoreTargetTeardownReceipt(value as unknown as RailwayMaintenanceState))
      && !isLegacyRestoreTargetTeardown(value as unknown as RailwayMaintenanceState))))
    || (value["activeLaunch"] !== undefined && !validActiveLaunch(value["activeLaunch"], postSource, targetState))) return undefined;
  const active = value["activeLaunch"];
  if (active?.kind === "source" && value["sourceRecoveryDeployments"] !== undefined) return undefined;
  if ((active?.kind === "source" && (parsed.receipt.stage !== "complete" || postSource === undefined || targetState !== undefined))
    || (active?.kind === "restore-target" && !["cutover", "complete"].includes(parsed.receipt.stage))
    || (active?.kind === "restore-target" && value["sourceTeardown"] === undefined)) return undefined;
  if (parsed.receipt.stage === "cutover" && (active?.kind !== "restore-target" || targetState === undefined || value["sourceTeardown"] === undefined)) return undefined;
  if (parsed.receipt.stage === "complete") {
    if (targetState === undefined) {
      if (active?.kind !== "source" || postSource === undefined || value["candidateUpgrade"]?.stage !== "complete") return undefined;
    } else if (active?.kind !== "restore-target" || value["sourceTeardown"] === undefined) return undefined;
  }
  const restored = value["restoredLogtoBootstrap"];
  if (restored !== undefined) {
    const hasActivation = plain(restored) && restored["exactActivation"] !== undefined;
    if (!exact(restored, ["lifecycle", ...(hasActivation ? ["exactActivation"] : [])])
      || !validBootstrap(restored["lifecycle"])
      || (hasActivation && !validExactActivation(restored["exactActivation"]))) return undefined;
    const lifecycle = restored["lifecycle"];
    const activation = restored["exactActivation"] as RailwayExactServiceActivationCheckpoint | undefined;
    const needsActivation = lifecycle.deploymentId !== undefined || lifecycle.successfulDeploymentId !== undefined
      || lifecycle.failedDeploymentId !== undefined || lifecycle.handoffDomainId !== undefined
      || lifecycle.handoffDomain !== undefined || lifecycle.handoffApplied !== undefined;
    if ((activation !== undefined && (lifecycle.serviceId === undefined || lifecycle.variablesApplied !== true))
      || (needsActivation && activation === undefined)) return undefined;
    if (activation !== undefined && (activation.projectId !== lifecycle.projectId
      || activation.environmentId !== lifecycle.environmentId || activation.serviceId !== lifecycle.serviceId
      || !activation.image.endsWith(`@${lifecycle.imageDigest}`))) return undefined;
  }
  const restoredState = restored as RailwayRestoredLogtoBootstrapState | undefined;
  const restore = value["portableRestore"];
  const exported = value["portableExport"];
  const logto = value["logtoActivation"];
  const sourceState = value["sourceLaunchState"];
  const sourceResources = sourceState.reconcile.receipt.resources;
  const sourceProjectId = sourceResources.find((resource) => resource.kind === "railway.project")!.id;
  const sourceEnvironmentId = sourceResources.find((resource) => resource.kind === "railway.environment")!.id;
  const sourceNautiloServiceId = sourceResources.find((resource) => resource.kind === "railway.service" && resource.name === "nautilo-server")!.id;
  if (exported !== undefined && (exported.target.projectId !== sourceProjectId || exported.target.environmentId !== sourceEnvironmentId
    || exported.target.serviceId !== sourceNautiloServiceId || exported.target.sourceReleaseId !== parsed.receipt.sourceReleaseId)) return undefined;
  if ((restore !== undefined || logto !== undefined || restored !== undefined || value["nautiloActivation"] !== undefined || value["restoredTargetActivation"] !== undefined) && !hasTargetState) return undefined;
  if (hasTargetState) {
    const targetState = value["restoreTargetState"] as RailwayDeploymentDriverState;
    const resources = targetState.reconcile.receipt.resources;
    const resourceId = (kind: string, name: string): string | undefined => resources.find((resource) => resource.kind === kind && resource.name === name)?.id;
    const targetReceipt = parsed.receipt.restoreTarget;
    const logtoServiceId = resourceId("railway.service", "logto");
    const nautiloServiceId = resourceId("railway.service", "nautilo-server");
    if (targetReceipt === undefined || logtoServiceId === undefined || nautiloServiceId === undefined) return undefined;
    const exactTarget = (checkpoint: RailwayExactServiceActivationCheckpoint | undefined, serviceId: string): boolean => checkpoint === undefined
      || checkpoint.projectId === targetReceipt.projectId && checkpoint.environmentId === targetReceipt.environmentId && checkpoint.serviceId === serviceId;
    if (!exactTarget(logto, logtoServiceId)
      || !exactTarget(value["nautiloActivation"], nautiloServiceId)
      || (restore !== undefined && (restore.target.projectId !== targetReceipt.projectId
        || restore.target.environmentId !== targetReceipt.environmentId || restore.target.serviceId !== nautiloServiceId
        || restore.target.sourceReleaseId !== parsed.receipt.sourceReleaseId))) return undefined;
    const outer = value["restoredTargetActivation"];
    if (outer !== undefined && (outer.projectId !== targetReceipt.projectId || outer.environmentId !== targetReceipt.environmentId
      || outer.logtoServiceId !== logtoServiceId || outer.nautiloServiceId !== nautiloServiceId
      || outer.authorityGenerationId !== value["authorityGenerationId"] || outer.releaseId !== parsed.receipt.targetReleaseId
      || (logto !== undefined && !logto.image.endsWith(`@sha256:${outer.logtoImageDigest}`))
      || (value["nautiloActivation"] !== undefined && !(value["nautiloActivation"]).image.endsWith(`@sha256:${outer.nautiloImageDigest}`))
      || (restoredState?.exactActivation !== undefined && !restoredState.exactActivation.image.endsWith(`@sha256:${outer.bootstrapImageDigest}`)))) return undefined;
    if (restoredState !== undefined && (restoredState.lifecycle.projectId !== targetReceipt.projectId
      || restoredState.lifecycle.environmentId !== targetReceipt.environmentId)) return undefined;
  }
  if ((logto !== undefined || restored !== undefined || value["nautiloActivation"] !== undefined || value["restoredTargetActivation"] !== undefined)
    && restore?.cleanup?.state !== "complete") return undefined;
  if (restored !== undefined && logto?.state !== "complete") return undefined;
  const nautilo = value["nautiloActivation"];
  if (nautilo !== undefined && (restoredState?.exactActivation?.state !== "complete"
    || restoredState.lifecycle.successfulDeploymentId === undefined || restoredState.lifecycle.handoffDomainId === undefined
    || restoredState.lifecycle.handoffDomain === undefined)) return undefined;
  if (restoredState?.lifecycle.handoffApplied === true && nautilo?.state !== "complete") return undefined;
  const outer = value["restoredTargetActivation"];
  if (outer !== undefined) {
    const rank = ["gates", "logto-start", "logto-observe", "bootstrap-nautilo-start", "nautilo-observe", "readiness", "complete"].indexOf(outer.stage);
    if ((rank >= 2 && logto === undefined) || (rank >= 3 && logto?.state !== "complete")
      || (rank >= 4 && (restoredState === undefined || nautilo === undefined))
      || (rank >= 5 && (nautilo?.state !== "complete" || restoredState?.lifecycle.handoffApplied !== true))) return undefined;
  }
  return structuredClone(value) as unknown as RailwayMaintenanceState;
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function stableIdentity(previous: Plain, next: Plain, keys: readonly string[]): boolean {
  return keys.every((key) => same(previous[key], next[key]));
}

function validRestoreProjectNameCorrection(
  previous: RailwayDeploymentDriverState,
  next: RailwayDeploymentDriverState,
  maintenanceId: string,
): boolean {
  const pending = previous.reconcile.pending;
  if (pending?.kind !== "project-create" || (pending.attempt ?? 1) !== 2
    || previous.reconcile.receipt.resources.length !== 0
    || Buffer.byteLength(previous.target.projectName, "utf8") <= 32) return false;
  const projectName = railwayRecoveryProjectName(maintenanceId);
  const expected: RailwayDeploymentDriverState = {
    ...previous,
    target: { ...previous.target, projectName },
    reconcile: { ...previous.reconcile, pending: { kind: "project-create", logicalName: projectName, attempt: 1 } },
  };
  return same(next, expected);
}

function exactActivationTransition(previous: RailwayExactServiceActivationCheckpoint, next: RailwayExactServiceActivationCheckpoint): boolean {
  if (!stableIdentity(previous as unknown as Plain, next as unknown as Plain, ["projectId", "environmentId", "serviceId", "image", "effect"])) return false;
  if (next.attempt === previous.attempt + 1) return next.state === "prepared";
  if (next.attempt !== previous.attempt) return false;
  if (next.startEffect !== previous.startEffect) return false;
  const rank = { prepared: 0, "start-pending": 1, "start-unknown": 2, started: 3, complete: 4 } as const;
  return rank[next.state] >= rank[previous.state];
}

function portableTransferTransition(previous: RailwayPortableMaintenanceTargetCheckpoint, next: RailwayPortableMaintenanceTargetCheckpoint): boolean {
  if (!stableIdentity(previous as unknown as Plain, next as unknown as Plain, ["operationId", "direction", "objectId", "projectId", "environmentId", "serviceId", "image", "sourceReleaseId", "command"])) return false;
  if (next.attempt === previous.attempt + 1) return next.state === "prepared";
  if (next.attempt !== previous.attempt || next.startEffect !== previous.startEffect) return false;
  const rank = { prepared: 0, "start-pending": 1, "start-unknown": 2, started: 3 } as const;
  return rank[next.state] >= rank[previous.state];
}

function cleanupTransition(previous: RailwayPortableMaintenanceCleanupCheckpoint, next: RailwayPortableMaintenanceCleanupCheckpoint): boolean {
  if (!stableIdentity(previous as unknown as Plain, next as unknown as Plain, ["schemaVersion", "projectId", "environmentId", "serviceId", "operationId", "imageDigest", "commandSha256"])) return false;
  if (same(previous, next)) return true;
  if (previous.state === "deleting" && previous.completedDeletes < 12) {
    return next.state === "delete-pending" && next.completedDeletes === previous.completedDeletes;
  }
  if (previous.state === "delete-pending") {
    return next.state === "deleting" && next.completedDeletes === previous.completedDeletes + 1;
  }
  if (previous.state === "deleting" && previous.completedDeletes === 12) return next.state === "reset-pending";
  return previous.state === "reset-pending" && next.state === "complete";
}

function portableOperationTransition(previous: RailwayPortableOperationState, next: RailwayPortableOperationState): boolean {
  return portableTransferTransition(previous.target, next.target)
    && !(previous.cleanup !== undefined && next.cleanup === undefined)
    && !(previous.cleanup === undefined && next.cleanup !== undefined
      && (next.cleanup.state !== "deleting" || next.cleanup.completedDeletes !== 0))
    && (previous.cleanup === undefined || cleanupTransition(previous.cleanup, next.cleanup!));
}

function restoreBootstrapTransition(
  previous: RailwayBootstrapLifecycleCheckpoint | undefined,
  next: RailwayBootstrapLifecycleCheckpoint | undefined,
): boolean {
  if (next === undefined) return previous === undefined;
  if (!validBootstrap(next) || next.handoffDomainId !== undefined || next.handoffDomain !== undefined
    || next.handoffApplied !== undefined) return false;
  if (previous === undefined) {
    return next.serviceId !== undefined && next.variablesApplied === undefined
      && next.deploymentId === undefined && next.successfulDeploymentId === undefined
      && next.failedDeploymentId === undefined;
  }
  if (!validBootstrap(previous) || !stableIdentity(
    previous as unknown as Plain,
    next as unknown as Plain,
    ["schemaVersion", "projectId", "environmentId", "serviceName", "imageDigest", "serviceId"],
  )) return false;
  if (same(previous, next)) return true;
  if (previous.variablesApplied === undefined) {
    return next.variablesApplied === true && next.deploymentId === undefined
      && next.successfulDeploymentId === undefined && next.failedDeploymentId === undefined;
  }
  if (previous.deploymentId === undefined) {
    return next.variablesApplied === true && next.deploymentId !== undefined
      && next.successfulDeploymentId === undefined && next.failedDeploymentId === undefined;
  }
  if (previous.successfulDeploymentId === undefined && previous.failedDeploymentId === undefined) {
    return next.variablesApplied === true && next.deploymentId === previous.deploymentId
      && ((next.successfulDeploymentId === previous.deploymentId && next.failedDeploymentId === undefined)
        || (next.failedDeploymentId === previous.deploymentId && next.successfulDeploymentId === undefined));
  }
  return false;
}

function childTransition(previous: RailwayMaintenanceState, next: RailwayMaintenanceState): boolean {
  for (const key of CHILD_KEYS) if (previous[key] !== undefined && next[key] === undefined) return false;
  if (previous.restoreTargetDisposition !== undefined) {
    if (!same(previous.restoreTargetDisposition, next.restoreTargetDisposition)
      || !same(previous.maintenanceReceipt, next.maintenanceReceipt)) return false;
    for (const key of CHILD_KEYS) {
      if (key !== "restoreTargetDisposition" && key !== "restoreTargetTeardown"
        && !same(previous[key], next[key])) return false;
    }
  } else if (next.restoreTargetDisposition !== undefined) {
    if (!same(previous.maintenanceReceipt, next.maintenanceReceipt)) return false;
    for (const key of CHILD_KEYS) {
      if (key !== "restoreTargetDisposition" && !same(previous[key], next[key])) return false;
    }
  }
  if (previous.restoreTargetState !== undefined && (!same(previous.restoreTargetState, next.restoreTargetState)
    || previous.targetNautiloHostname !== next.targetNautiloHostname
    || previous.targetLogtoHostname !== next.targetLogtoHostname)) return false;
  if (previous.restoreTargetPreparation !== undefined) {
    const before = previous.restoreTargetPreparation;
    const after = next.restoreTargetPreparation!;
    if (!stableIdentity(before as unknown as Plain, after as unknown as Plain,
      ["schemaVersion", "launchId", "releaseId", "providers"])
      || (!same(before.target, after.target) && !validRestoreProjectNameCorrection(before, after, previous.maintenanceId))) return false;
  }
  if (previous.restoreTargetPreparation !== undefined && !same(previous.restoreTargetPreparation.reconcile.receipt, next.restoreTargetPreparation!.reconcile.receipt)
    && !validateLaunchReceiptTransition(previous.restoreTargetPreparation.reconcile.receipt, next.restoreTargetPreparation!.reconcile.receipt).ok) return false;
  if (previous.restoreTargetPreparation !== undefined
    && previous.restoreTargetPreparation.reconcile.receipt.stage === "provisioning"
    && next.restoreTargetPreparation!.reconcile.receipt.stage === "bootstrapping"
    && !successfulRestoreDatabaseBootstrap(next.restoreTargetPreparation!)) return false;
  if (previous.restoreTargetPreparation !== undefined
    && previous.restoreTargetPreparation.reconcile.receipt.stage === "bootstrapping"
    && next.restoreTargetPreparation!.reconcile.receipt.stage === "claimable"
    && !successfulRestoreDatabaseBootstrap(next.restoreTargetPreparation!)) return false;
  if (previous.restoreTargetPreparation !== undefined && !restoreBootstrapTransition(
    previous.restoreTargetPreparation.databaseBootstrap,
    next.restoreTargetPreparation!.databaseBootstrap,
  )) return false;
  if (previous.restoreTargetPreparation !== undefined
    && previous.restoreTargetPreparation.databaseBootstrap === undefined
    && next.restoreTargetPreparation?.databaseBootstrap !== undefined
    && !same(previous.restoreTargetPreparation.reconcile, next.restoreTargetPreparation.reconcile)) return false;
  if (previous.activeLaunch !== undefined && !same(previous.activeLaunch, next.activeLaunch)) return false;
  if (previous.postUpgradeSourceState !== undefined && !same(previous.postUpgradeSourceState, next.postUpgradeSourceState)) return false;
  if (previous.fallbackDecision !== undefined && !same(previous.fallbackDecision, next.fallbackDecision)) return false;
  if (previous.fallbackDecision === undefined && next.fallbackDecision !== undefined) {
    const failure = next.maintenanceReceipt.lastFailure;
    if (failure?.retryable !== false || failure.operation !== next.fallbackDecision.reason) return false;
  }
  if (previous.sourceRecoveryDeployments !== undefined) {
    if (next.sourceRecoveryDeployments === undefined
      || next.sourceRecoveryDeployments.length < previous.sourceRecoveryDeployments.length
      || next.sourceRecoveryDeployments.length > previous.sourceRecoveryDeployments.length + 1
      || !previous.sourceRecoveryDeployments.every((entry, index) => same(entry, next.sourceRecoveryDeployments![index]))) return false;
  } else if (next.sourceRecoveryDeployments !== undefined && next.sourceRecoveryDeployments.length !== 1) return false;
  if (previous.sourceTeardown !== undefined && !same(previous.sourceTeardown, next.sourceTeardown)
    && !isRailwayDestroyCheckpointTransition(previous.sourceTeardown, next.sourceTeardown!)) return false;
  if (previous.restoreTargetTeardown !== undefined && !same(previous.restoreTargetTeardown, next.restoreTargetTeardown)) {
    if (next.restoreTargetDisposition === undefined) return false;
    const repairsLegacyCustody = isLegacyRestoreTargetTeardown(previous)
      && next.restoreTargetTeardown?.stage === "validate"
      && same(next.restoreTargetTeardown.receipt, createRailwayRestoreTargetTeardownReceipt(previous));
    if (!repairsLegacyCustody
      && !isRailwayDestroyCheckpointTransition(previous.restoreTargetTeardown, next.restoreTargetTeardown!)) return false;
  }
  if (previous.sourceTeardown === undefined && next.sourceTeardown !== undefined
    && (next.sourceTeardown.stage !== "validate" || !same(next.sourceTeardown.receipt,
      createRailwaySourceTeardownReceipt(previous.sourceLaunchState, previous.candidateUpgrade, previous.sourceRecoveryDeployments)))) return false;
  if (previous.restoreTargetTeardown === undefined && next.restoreTargetTeardown !== undefined
    && (next.restoreTargetDisposition === undefined
      || (previous.restoreTargetState ?? previous.restoreTargetPreparation) === undefined || next.restoreTargetTeardown.stage !== "validate"
      || (!same(next.restoreTargetTeardown.receipt, createRailwayRestoreTargetTeardownReceipt(previous))
        && !isLegacyRestoreTargetTeardown(next)))) return false;
  if (previous.restoreTargetPreparation === undefined && next.restoreTargetPreparation !== undefined
    && (next.restoreTargetPreparation.reconcile.receipt.stage !== "authorized"
      || next.restoreTargetPreparation.reconcile.receipt.resources.length !== 0
      || next.restoreTargetPreparation.reconcile.pending !== undefined
      || next.restoreTargetPreparation.workflow !== undefined
      || next.restoreTargetPreparation.databaseBootstrap !== undefined
      || next.restoreTargetPreparation.logtoBootstrap !== undefined
      || next.restoreTargetPreparation.destroy !== undefined)) return false;
  if (previous.candidateUpgrade !== undefined && !same(previous.candidateUpgrade, next.candidateUpgrade)) {
    if (!isRailwayWholeManifestUpgradeCheckpointTransition(previous.candidateUpgrade, next.candidateUpgrade!)) return false;
  }
  if (previous.candidateUpgrade === undefined && next.candidateUpgrade !== undefined && next.candidateUpgrade.stage !== "verify-old") return false;
  if (previous.portableExport === undefined && next.portableExport !== undefined
    && (next.portableExport.target.state !== "prepared" || next.portableExport.cleanup !== undefined)) return false;
  if (previous.portableRestore === undefined && next.portableRestore !== undefined
    && (next.portableRestore.target.state !== "prepared" || next.portableRestore.cleanup !== undefined)) return false;
  if (previous.portableExport !== undefined && !portableOperationTransition(previous.portableExport, next.portableExport!)) return false;
  if (previous.portableRestore !== undefined && !portableOperationTransition(previous.portableRestore, next.portableRestore!)) return false;
  if (previous.logtoActivation !== undefined && !exactActivationTransition(previous.logtoActivation, next.logtoActivation!)) return false;
  if (previous.nautiloActivation !== undefined && !exactActivationTransition(previous.nautiloActivation, next.nautiloActivation!)) return false;
  if (previous.restoredLogtoBootstrap !== undefined) {
    const before = previous.restoredLogtoBootstrap; const after = next.restoredLogtoBootstrap!;
    if (!stableIdentity(before.lifecycle as unknown as Plain, after.lifecycle as unknown as Plain, ["schemaVersion", "projectId", "environmentId", "serviceName", "imageDigest"])) return false;
    if (before.exactActivation !== undefined && (after.exactActivation === undefined || !exactActivationTransition(before.exactActivation, after.exactActivation))) return false;
    for (const sticky of ["serviceId", "variablesApplied", "successfulDeploymentId", "handoffDomainId", "handoffDomain", "handoffApplied"] as const) {
      if (before.lifecycle[sticky] !== undefined && !same(before.lifecycle[sticky], after.lifecycle[sticky])) return false;
    }
  }
  if (previous.restoredTargetActivation !== undefined) {
    const before = previous.restoredTargetActivation; const after = next.restoredTargetActivation!;
    if (!stableIdentity(before as unknown as Plain, after as unknown as Plain, ["schemaVersion", "releaseId", "projectId", "environmentId", "logtoServiceId", "nautiloServiceId", "logtoImageDigest", "nautiloImageDigest", "bootstrapImageDigest", "authorityGenerationId", "intentSha256", "effectSha256"])) return false;
    const rank = { gates: 0, "logto-start": 1, "logto-observe": 2, "bootstrap-nautilo-start": 3, "nautilo-observe": 4, readiness: 5, complete: 6 } as const;
    if (rank[after.stage] < rank[before.stage] && !(before.stage === "logto-observe" && after.stage === "logto-start")) return false;
  }
  return true;
}

function transition(previous: RailwayMaintenanceState, next: RailwayMaintenanceState): boolean {
  if (next.revision !== previous.revision + 1
    || !stableIdentity(previous as unknown as Plain, next as unknown as Plain, ["schemaVersion", "maintenanceId", "sourceLaunchId", "authorityGenerationId", "sourceManagedWorkbenchHostname", "sourceLaunchState", "targetTopology", "targetTopologySha256", "targetTopologyMac"])) return false;
  if (!same(previous.maintenanceReceipt, next.maintenanceReceipt)) {
    if (next.maintenanceReceipt.revision < previous.maintenanceReceipt.revision) return false;
    if (!validateMaintenanceReceiptTransition(previous.maintenanceReceipt, next.maintenanceReceipt).ok) return false;
  } else if (next.maintenanceReceipt.revision !== previous.maintenanceReceipt.revision) return false;
  return childTransition(previous, next);
}

/**
 * Reads exact pre-disposition cleanup history without granting that history any
 * authority to advance. New publications always use the strict transition.
 */
function legacyRestoreTeardownReadTransition(previous: RailwayMaintenanceState, next: RailwayMaintenanceState): boolean {
  if (previous.restoreTargetDisposition !== undefined || next.restoreTargetDisposition !== undefined
    || next.revision !== previous.revision + 1
    || !same(previous.maintenanceReceipt, next.maintenanceReceipt)
    || !stableIdentity(previous as unknown as Plain, next as unknown as Plain,
      ["schemaVersion", "maintenanceId", "sourceLaunchId", "authorityGenerationId", "sourceManagedWorkbenchHostname", "sourceLaunchState", "targetTopology", "targetTopologySha256", "targetTopologyMac"])) return false;
  for (const key of CHILD_KEYS) {
    if (key !== "restoreTargetTeardown" && !same(previous[key], next[key])) return false;
  }
  if (same(previous.restoreTargetTeardown, next.restoreTargetTeardown) || next.restoreTargetTeardown === undefined) return false;
  if (previous.restoreTargetTeardown === undefined) {
    return next.restoreTargetTeardown.stage === "validate"
      && (same(next.restoreTargetTeardown.receipt, createRailwayRestoreTargetTeardownReceipt(previous))
        || isLegacyRestoreTargetTeardown(next));
  }
  const repairsLegacyCustody = isLegacyRestoreTargetTeardown(previous)
    && next.restoreTargetTeardown.stage === "validate"
    && same(next.restoreTargetTeardown.receipt, createRailwayRestoreTargetTeardownReceipt(previous));
  return repairsLegacyCustody
    || isRailwayDestroyCheckpointTransition(previous.restoreTargetTeardown, next.restoreTargetTeardown);
}

function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function redacted(error: unknown): RailwayMaintenanceStateStoreError {
  return error instanceof RailwayMaintenanceStateStoreError ? error : new RailwayMaintenanceStateStoreError("io-failure");
}
function assertPaths(root: string, path: string): void {
  if (!isAbsolute(root) || resolve(root) !== root || !isAbsolute(path) || resolve(path) !== path
    || path.length > 4096 || root.length > 4096 || dirname(path) !== root
    || !SAFE_ID.test(basename(path)) || !path.startsWith(`${root}${sep}`)) throw new RailwayMaintenanceStateStoreError("unsafe-path");
}
function assertOwned(status: Awaited<ReturnType<typeof lstat>>): void {
  if (process.platform === "win32") return;
  if ((Number(status.mode) & 0o777) !== (status.isDirectory() ? DIRECTORY_MODE : FILE_MODE)) throw new RailwayMaintenanceStateStoreError("unsafe-permissions");
  const uid = process.getuid?.();
  if (uid !== undefined && status.uid !== uid) throw new RailwayMaintenanceStateStoreError("unsafe-owner");
}
async function ownedDirectory(path: string, create: boolean): Promise<boolean> {
  if (create) { try { await mkdir(path, { mode: DIRECTORY_MODE }); } catch (error) { if (!isCode(error, "EEXIST")) throw error; } }
  let status;
  try { status = await lstat(path); } catch (error) { if (!create && isCode(error, "ENOENT")) return false; throw error; }
  if (status.isSymbolicLink() || !status.isDirectory()) throw new RailwayMaintenanceStateStoreError("unsafe-path");
  assertOwned(status); return true;
}

async function storeDirectory(root: string, path: string, create: boolean): Promise<boolean> {
  assertPaths(root, path);
  const rootExists = await ownedDirectory(root, create);
  if (!rootExists) return false;
  return ownedDirectory(path, create);
}
function revisionName(revision: number): string {
  if (!integer(revision)) throw new RailwayMaintenanceStateStoreError("invalid-state");
  return `revision-${String(revision).padStart(10, "0")}.json`;
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function inventory(path: string): Promise<readonly { revision: number; path: string }[]> {
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > MAX_DIRECTORY_ENTRIES) throw new RailwayMaintenanceStateStoreError("state-too-large");
  const revisions: { revision: number; path: string }[] = [];
  for (const entry of entries) {
    const final = REVISION_FILE.exec(entry.name); const temp = TEMP_FILE.exec(entry.name);
    if (final === null && temp === null) throw new RailwayMaintenanceStateStoreError("unsafe-path");
    const itemPath = `${path}/${entry.name}`; let status;
    try { status = await lstat(itemPath); } catch (error) {
      // A concurrent publisher may remove its private temp after readdir. Final
      // revisions are immutable, so disappearance is safe only for temp files.
      if (temp !== null && isCode(error, "ENOENT")) continue;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isFile()) throw new RailwayMaintenanceStateStoreError("unsafe-path");
    assertOwned(status); if (status.size > MAX_BYTES) throw new RailwayMaintenanceStateStoreError("state-too-large");
    if (final !== null) revisions.push({ revision: Number(final[1]), path: itemPath });
  }
  revisions.sort((a, b) => a.revision - b.revision);
  if (revisions.length > MAX_PUBLISHED_REVISIONS) throw new RailwayMaintenanceStateStoreError("state-too-large");
  for (let index = 0; index < revisions.length; index += 1) if (revisions[index]?.revision !== index) throw new RailwayMaintenanceStateStoreError("invalid-chain");
  return revisions;
}

async function readOne(path: string, revision: number): Promise<RailwayMaintenanceState> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new RailwayMaintenanceStateStoreError("unsafe-path");
  assertOwned(before); if (before.size > MAX_BYTES) throw new RailwayMaintenanceStateStoreError("state-too-large");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    if (status.dev !== before.dev || status.ino !== before.ino || !status.isFile()) throw new RailwayMaintenanceStateStoreError("unsafe-path");
    assertOwned(status); if (status.size > MAX_BYTES) throw new RailwayMaintenanceStateStoreError("state-too-large");
    const payload = await handle.readFile(); const bytes = payload.toString("utf8");
    if (SECRET_BYTES.test(bytes)) throw new RailwayMaintenanceStateStoreError("invalid-state");
    let value: unknown; try { value = JSON.parse(bytes); } catch { throw new RailwayMaintenanceStateStoreError("invalid-json"); }
    const state = validateState(value);
    if (state === undefined || state.revision !== revision) throw new RailwayMaintenanceStateStoreError("invalid-state");
    return state;
  } finally { await handle.close(); }
}

export async function readRailwayMaintenanceState(root: string, path: string): Promise<RailwayMaintenanceState | null> {
  try {
    if (!await storeDirectory(root, path, false)) return null;
    const items = await inventory(path); let previous: RailwayMaintenanceState | undefined;
    for (const item of items) {
      const current = await readOne(item.path, item.revision);
      if (previous === undefined ? current.revision !== 0
        : !transition(previous, current) && !legacyRestoreTeardownReadTransition(previous, current)) {
        throw new RailwayMaintenanceStateStoreError("invalid-chain");
      }
      previous = current;
    }
    return previous ?? null;
  } catch (error) { throw redacted(error); }
}

async function publish(path: string, state: RailwayMaintenanceState, options: WriteRailwayMaintenanceStateOptions): Promise<void> {
  const finalPath = `${path}/${revisionName(state.revision)}`;
  const temporary = `${path}/.${revisionName(state.revision).slice(0, -5)}.${String(process.pid)}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", FILE_MODE); let closed = false; let published = false;
  try {
    const bytes = serialized(state); if (bytes === undefined) throw new RailwayMaintenanceStateStoreError("invalid-state");
    await handle.writeFile(`${bytes}\n`, "utf8"); await handle.chmod(FILE_MODE); await handle.sync(); await handle.close(); closed = true;
    await options.hooks?.afterTempSync?.();
    try { await link(temporary, finalPath); } catch (error) { if (isCode(error, "EEXIST")) throw new RailwayMaintenanceStateStoreError("revision-conflict"); throw error; }
    published = true; await options.hooks?.afterPublish?.(); await syncDirectory(path); await options.hooks?.afterDirectorySync?.();
    try { await unlink(temporary); } catch { /* orphan is safe */ } await syncDirectory(path);
  } catch (error) {
    if (error instanceof RailwayMaintenanceStateStoreError) throw error;
    throw new RailwayMaintenanceStateStoreError(published ? "publish-unknown" : "io-failure");
  } finally {
    if (!closed) try { await handle.close(); } catch { /* preserve primary */ }
    if (!published) try { await unlink(temporary); } catch { /* kill-shaped orphan */ }
  }
}

export async function writeRailwayMaintenanceState(root: string, path: string, value: RailwayMaintenanceState, options: WriteRailwayMaintenanceStateOptions = {}): Promise<void> {
  try {
    const state = validateState(value); if (state === undefined || state.revision !== 0) throw new RailwayMaintenanceStateStoreError("invalid-state");
    await storeDirectory(root, path, true); if ((await inventory(path)).length !== 0) throw new RailwayMaintenanceStateStoreError("revision-conflict");
    await publish(path, state, options);
  } catch (error) { throw redacted(error); }
}

export async function updateRailwayMaintenanceState(
  root: string,
  path: string,
  options: UpdateRailwayMaintenanceStateOptions,
  update: (current: RailwayMaintenanceState) => RailwayMaintenanceState,
): Promise<RailwayMaintenanceState> {
  try {
    await storeDirectory(root, path, false); const current = await readRailwayMaintenanceState(root, path);
    if (current === null || current.revision !== options.expectedRevision) throw new RailwayMaintenanceStateStoreError("revision-conflict");
    let candidate: unknown; try { candidate = update(structuredClone(current)); } catch { throw new RailwayMaintenanceStateStoreError("invalid-transition"); }
    const next = validateState(candidate); if (next === undefined || !transition(current, next)) throw new RailwayMaintenanceStateStoreError("invalid-transition");
    await publish(path, next, options); return next;
  } catch (error) { throw redacted(error); }
}
