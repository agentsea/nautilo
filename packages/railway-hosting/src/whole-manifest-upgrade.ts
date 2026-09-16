import type { RailwayDeployment, RailwayServiceInstance } from "./operations";
import type { RailwayFinalServiceName } from "./topology";

export const RAILWAY_WHOLE_MANIFEST_UPGRADE_SCHEMA_VERSION = 1 as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SERVICE_ORDER = ["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"] as const;
const COMPLETED_SERVICE_ORDER = ["app-postgres", "logto-postgres", "logto", "nautilo-server"] as const;
const FAILED_DEPLOYMENTS = new Set(["CRASHED", "FAILED", "REMOVED", "REMOVING", "SKIPPED"]);
const FAILED_INSTANCES = new Set(["CRASHED", "EXITED", "REMOVED", "REMOVING", "SKIPPED", "STOPPED"]);
const MAX_BASELINE = 256;
const MAX_ATTEMPTS = 8;
const ABSENCE_OBSERVATIONS_BEFORE_RETRY = 2;
const MIGRATION_ABSENCE_OBSERVATIONS_BEFORE_TERMINAL = 3;
const MIGRATION_SERVICE_INDEX = 4;
const MIGRATION_FAILED_INSTANCES = new Set(["CRASHED", "REMOVED", "REMOVING", "SKIPPED", "STOPPED"]);

export interface RailwayWholeManifestUpgradeService {
  readonly name: RailwayFinalServiceName;
  readonly serviceId: string;
  readonly oldImage: string;
  readonly newImage: string;
  readonly kind: "long-lived" | "run-once";
}

/** Deterministic execution identity makes a lost migration response recoverable. */
export interface RailwayWholeManifestMigration {
  readonly migrationId: string;
  readonly executionId: string;
}

export interface RailwayWholeManifestUpgradeBinding {
  readonly releaseId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly services: readonly RailwayWholeManifestUpgradeService[];
  readonly migration: RailwayWholeManifestMigration;
}

export type RailwayWholeManifestUpgradeStage =
  | "verify-old"
  | "source-ready"
  | "source-pending"
  | "source-unknown"
  | "source-updated"
  | "start-ready"
  | "start-pending"
  | "start-unknown"
  | "start-ambiguous"
  | "started"
  | "migration-ready"
  | "migration-source-pending"
  | "migration-command-ready"
  | "migration-command-pending"
  | "migration-start-ready"
  | "migration-start-pending"
  | "migration-start-unknown"
  | "migration-start-ambiguous"
  | "migration-start-unresolved"
  | "migration-started"
  | "migration-reset-ready"
  | "migration-reset-pending"
  | "migration-proven"
  | "verify-final"
  | "complete";

export interface RailwayWholeManifestUpgradeCheckpoint {
  readonly schemaVersion: typeof RAILWAY_WHOLE_MANIFEST_UPGRADE_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly services: readonly RailwayWholeManifestUpgradeService[];
  readonly migrationId: string;
  readonly migrationExecutionId: string;
  /** Exact successful long-lived deployments, in causal manifest order. */
  readonly completedDeployments: readonly RailwayWholeManifestUpgradeCompletedDeployment[];
  readonly stage: RailwayWholeManifestUpgradeStage;
  readonly serviceIndex?: number | undefined;
  readonly attempt?: number | undefined;
  readonly observations?: number | undefined;
  readonly baselineDeploymentIds?: readonly string[] | undefined;
  /** Exact sorted post-baseline identities that make a deployment start terminally ambiguous. */
  readonly ambiguousDeploymentIds?: readonly string[] | undefined;
  readonly deploymentId?: string | undefined;
  /** Exact one-shot migration deployment retained for fallback teardown custody. */
  readonly migrationDeploymentId?: string | undefined;
}

export interface RailwayWholeManifestUpgradeCompletedDeployment {
  readonly name: (typeof COMPLETED_SERVICE_ORDER)[number];
  readonly serviceId: string;
  readonly deploymentId: string;
}

export interface RailwayWholeManifestUpgradeExecutor {
  getServiceInstance(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayServiceInstance | null>;
  listDeploymentsRaw(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }): Promise<readonly RailwayDeployment[]>;
  updateServiceSource(input: { readonly serviceId: string; readonly environmentId: string; readonly image: string }): Promise<RailwayServiceInstance>;
  createDeployment(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayDeployment>;
  getDeployment(input: { readonly deploymentId: string }): Promise<RailwayDeployment>;
  setServiceStartCommand(input: { readonly serviceId: string; readonly environmentId: string; readonly startCommand: string | null }): Promise<void>;
}

export interface RailwayWholeManifestUpgradeOptions {
  readonly binding: RailwayWholeManifestUpgradeBinding;
  readonly executor: RailwayWholeManifestUpgradeExecutor;
  readonly loadCheckpoint: () => Promise<RailwayWholeManifestUpgradeCheckpoint | undefined>;
  readonly persistCheckpoint: (checkpoint: RailwayWholeManifestUpgradeCheckpoint) => Promise<void>;
}

export type RailwayWholeManifestUpgradeFailureCode =
  | "invalid-input"
  | "invalid-checkpoint"
  | "source-drift"
  | "source-update-unknown"
  | "deployment-ambiguous"
  | "deployment-unknown"
  | "deployment-terminal"
  | "migration-unknown"
  | "migration-start-unresolved"
  | "migration-terminal"
  | "executor-failure"
  | "persistence-failure";

export type RailwayWholeManifestUpgradeResult =
  | { readonly outcome: "pending"; readonly checkpoint: RailwayWholeManifestUpgradeCheckpoint; readonly code?: RailwayWholeManifestUpgradeFailureCode | undefined }
  | { readonly outcome: "complete"; readonly checkpoint: RailwayWholeManifestUpgradeCheckpoint }
  | { readonly outcome: "failure"; readonly code: RailwayWholeManifestUpgradeFailureCode; readonly fallbackRequired: true; readonly checkpoint?: RailwayWholeManifestUpgradeCheckpoint | undefined };

export class RailwayWholeManifestUpgradeError extends Error {
  constructor() {
    super("Railway whole manifest upgrade failed");
    this.name = "RailwayWholeManifestUpgradeError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysExactly(value: Record<string, unknown>, required: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validId(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value); }
function validMigrationId(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && SAFE_MIGRATION_ID.test(value);
}
function validImage(value: unknown): value is string {
  if (typeof value !== "string" || /\s/.test(value)) return false;
  const parts = value.split("@");
  if (parts.length !== 2 || !/^sha256:[a-f0-9]{64}$/.test(parts[1] ?? "")) return false;
  const repository = parts[0]!;
  const lastSegment = repository.slice(repository.lastIndexOf("/") + 1);
  return /^[a-z0-9][a-z0-9._:/-]*$/.test(repository) && lastSegment.length > 0 && !lastSegment.includes(":");
}
function validIndex(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < SERVICE_ORDER.length; }
function validAttempt(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ATTEMPTS; }
function validObservations(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < ABSENCE_OBSERVATIONS_BEFORE_RETRY; }

function sourceExact(instance: RailwayServiceInstance, image: string): boolean {
  return instance.source?.image === image && (instance.source.repo ?? null) === null;
}

function validServices(value: unknown): value is readonly RailwayWholeManifestUpgradeService[] {
  if (!Array.isArray(value) || value.length !== SERVICE_ORDER.length) return false;
  return value.every((entry, index) => record(entry)
    && keysExactly(entry, ["name", "serviceId", "oldImage", "newImage", "kind"])
    && entry["name"] === SERVICE_ORDER[index] && validId(entry["serviceId"])
    && validImage(entry["oldImage"]) && validImage(entry["newImage"])
    && (entry["kind"] === "long-lived") === (entry["name"] !== "logto-seed"));
}

function validBaseline(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_BASELINE && value.every(validId)
    && new Set(value).size === value.length && value.every((id, index) => index === 0 || value[index - 1]! < id);
}

function validAmbiguousDeployments(value: unknown, baseline: unknown, completed: unknown): value is readonly string[] {
  if (!validBaseline(value) || value.length <= 1 || !validBaseline(baseline)) return false;
  const before = new Set(baseline);
  const owned = new Set(Array.isArray(completed)
    ? completed.map((entry) => record(entry) ? entry["deploymentId"] : undefined)
    : []);
  return value.every((id) => !before.has(id) && !owned.has(id));
}

function validCompletedDeployments(
  value: unknown,
  services: readonly RailwayWholeManifestUpgradeService[],
): value is readonly RailwayWholeManifestUpgradeCompletedDeployment[] {
  if (!Array.isArray(value) || value.length > COMPLETED_SERVICE_ORDER.length) return false;
  const valid = value.every((entry, index) => {
    const name = COMPLETED_SERVICE_ORDER[index];
    const service = services.find((candidate) => candidate.name === name);
    return record(entry) && keysExactly(entry, ["name", "serviceId", "deploymentId"])
      && entry["name"] === name && service !== undefined && entry["serviceId"] === service.serviceId
      && validId(entry["deploymentId"]);
  });
  return valid && new Set(value.map((entry) => (entry as RailwayWholeManifestUpgradeCompletedDeployment).deploymentId)).size === value.length;
}

function expectedCompletedCount(value: Record<string, unknown>): number | undefined {
  const stage = value["stage"];
  if (stage === "verify-old") return 0;
  if (stage === "verify-final" || stage === "complete") return 4;
  if (typeof stage !== "string") return undefined;
  if (stage.startsWith("migration-")) return 2;
  const index = value["serviceIndex"];
  if (!validIndex(index)) return undefined;
  return index === 0 ? 0 : index === 1 ? 1 : index === 2 || index === 3 ? 2 : 3;
}

export function isRailwayWholeManifestUpgradeCheckpoint(value: unknown, binding: RailwayWholeManifestUpgradeBinding): value is RailwayWholeManifestUpgradeCheckpoint {
  if (!record(value)) return false;
  const identity = ["schemaVersion", "releaseId", "projectId", "environmentId", "services", "migrationId", "migrationExecutionId", "completedDeployments", "stage"];
  const stage = value["stage"];
  const serviceOnly = [...identity, "serviceIndex"];
  const layouts: Readonly<Record<RailwayWholeManifestUpgradeStage, readonly string[]>> = {
    "verify-old": identity,
    "source-ready": serviceOnly,
    "source-pending": serviceOnly,
    "source-unknown": [...serviceOnly, "observations"],
    "source-updated": serviceOnly,
    "start-ready": [...serviceOnly, "attempt"],
    "start-pending": [...serviceOnly, "attempt", "baselineDeploymentIds"],
    "start-unknown": [...serviceOnly, "attempt", "observations", "baselineDeploymentIds"],
    "start-ambiguous": [...serviceOnly, "attempt", "baselineDeploymentIds", "ambiguousDeploymentIds"],
    started: [...serviceOnly, "attempt", "deploymentId"],
    "migration-ready": identity,
    "migration-source-pending": identity,
    "migration-command-ready": identity,
    "migration-command-pending": identity,
    "migration-start-ready": identity,
    "migration-start-pending": [...identity, "baselineDeploymentIds"],
    "migration-start-unknown": [...identity, "baselineDeploymentIds", "observations"],
    "migration-start-ambiguous": [...identity, "baselineDeploymentIds", "ambiguousDeploymentIds"],
    "migration-start-unresolved": [...identity, "baselineDeploymentIds", "observations"],
    "migration-started": identity,
    "migration-reset-ready": identity,
    "migration-reset-pending": identity,
    "migration-proven": identity,
    "verify-final": identity,
    complete: identity,
  };
  if (typeof stage !== "string" || !(stage in layouts)) return false;
  const carriesMigration = stage === "migration-started" || stage === "migration-reset-ready"
    || stage === "migration-reset-pending" || stage === "migration-proven"
    || stage === "verify-final" || stage === "complete"
    || ((stage.startsWith("source-") || stage.startsWith("start-") || stage === "started")
      && typeof value["serviceIndex"] === "number" && value["serviceIndex"] >= 2);
  const layout = carriesMigration ? [...layouts[stage as RailwayWholeManifestUpgradeStage], "migrationDeploymentId"]
    : layouts[stage as RailwayWholeManifestUpgradeStage];
  if (!keysExactly(value, layout)) return false;
  if (value["schemaVersion"] !== RAILWAY_WHOLE_MANIFEST_UPGRADE_SCHEMA_VERSION
    || value["releaseId"] !== binding.releaseId || value["projectId"] !== binding.projectId
    || value["environmentId"] !== binding.environmentId || value["migrationId"] !== binding.migration.migrationId
    || value["migrationExecutionId"] !== binding.migration.executionId || !validServices(value["services"])
    || !validMigrationId(value["migrationId"]) || !validMigrationId(value["migrationExecutionId"])
    || JSON.stringify(value["services"]) !== JSON.stringify(binding.services)
    || !validCompletedDeployments(value["completedDeployments"], binding.services)
    || value["completedDeployments"].length !== expectedCompletedCount(value)) return false;
  if (stage.startsWith("source-") || stage.startsWith("start-") || stage === "started") {
    if (!validIndex(value["serviceIndex"])) return false;
  }
  if (stage === "start-ready" || stage === "start-pending" || stage === "start-unknown" || stage === "start-ambiguous" || stage === "started") {
    if (!validAttempt(value["attempt"]) || value["serviceIndex"] === 2) return false;
  }
  if ((stage === "source-unknown" || stage === "start-unknown")
    && !validObservations(value["observations"])) return false;
  if ((stage === "start-pending" || stage === "start-unknown") && !validBaseline(value["baselineDeploymentIds"])) return false;
  if (stage === "start-ambiguous"
    && !validAmbiguousDeployments(value["ambiguousDeploymentIds"], value["baselineDeploymentIds"], value["completedDeployments"])) return false;
  if ((stage === "migration-start-pending" || stage === "migration-start-unknown" || stage === "migration-start-unresolved")
    && !validBaseline(value["baselineDeploymentIds"])) return false;
  if ((stage === "migration-start-unknown" || stage === "migration-start-unresolved")
    && (typeof value["observations"] !== "number" || !Number.isSafeInteger(value["observations"])
      || value["observations"] < 0 || value["observations"] > MIGRATION_ABSENCE_OBSERVATIONS_BEFORE_TERMINAL)) return false;
  if (stage === "migration-start-unknown"
    && (typeof value["observations"] !== "number" || value["observations"] >= MIGRATION_ABSENCE_OBSERVATIONS_BEFORE_TERMINAL)) return false;
  if (stage === "migration-start-unresolved" && value["observations"] !== MIGRATION_ABSENCE_OBSERVATIONS_BEFORE_TERMINAL) return false;
  if (stage === "migration-start-ambiguous"
    && !validAmbiguousDeployments(value["ambiguousDeploymentIds"], value["baselineDeploymentIds"], value["completedDeployments"])) return false;
  if (carriesMigration && !validId(value["migrationDeploymentId"])) return false;
  return stage !== "started" || validId(value["deploymentId"]);
}
export function isRailwayWholeManifestUpgradeCheckpointTransition(
  before: RailwayWholeManifestUpgradeCheckpoint,
  after: RailwayWholeManifestUpgradeCheckpoint,
): boolean {
  const binding: RailwayWholeManifestUpgradeBinding = {
    releaseId: before.releaseId,
    projectId: before.projectId,
    environmentId: before.environmentId,
    services: before.services,
    migration: { migrationId: before.migrationId, executionId: before.migrationExecutionId },
  };
  if (!isRailwayWholeManifestUpgradeCheckpoint(before, binding)
    || !isRailwayWholeManifestUpgradeCheckpoint(after, binding)) return false;
  const sameService = before.serviceIndex === after.serviceIndex;
  const sameAttempt = before.attempt === after.attempt;
  const sameCompleted = JSON.stringify(before.completedDeployments) === JSON.stringify(after.completedDeployments);
  if (before.migrationDeploymentId !== undefined && after.migrationDeploymentId !== before.migrationDeploymentId) return false;
  const appendedCurrentDeployment = (): boolean => {
    if (before.stage !== "started" || before.serviceIndex === undefined || before.deploymentId === undefined) return false;
    const service = before.services[before.serviceIndex];
    if (service === undefined || service.name === "logto-seed") return false;
    const expectedName = COMPLETED_SERVICE_ORDER[before.completedDeployments.length];
    const appended = after.completedDeployments[before.completedDeployments.length];
    return after.completedDeployments.length === before.completedDeployments.length + 1
      && after.completedDeployments.slice(0, -1).every((entry, index) => JSON.stringify(entry) === JSON.stringify(before.completedDeployments[index]))
      && expectedName === service.name && appended?.name === service.name
      && appended.serviceId === service.serviceId && appended.deploymentId === before.deploymentId;
  };
  const afterService = (index: number): boolean => {
    if (index === 0) return after.stage === "source-ready" && after.serviceIndex === 1;
    if (index === 1) return after.stage === "migration-ready";
    if (index === 2) return after.stage === "source-ready" && after.serviceIndex === 3;
    if (index === 3) return after.stage === "source-ready" && after.serviceIndex === 4;
    return after.stage === "verify-final";
  };
  if (before.stage === "started") return appendedCurrentDeployment() && afterService(before.serviceIndex!);
  if (!sameCompleted) return false;
  if (before.stage === "verify-old") return after.stage === "source-ready" && after.serviceIndex === 0;
  if (before.stage === "source-ready") return sameService && (after.stage === "source-pending" || after.stage === "source-updated");
  if (before.stage === "source-pending") return sameService && (after.stage === "source-updated"
    || (after.stage === "source-unknown" && after.observations === 0));
  if (before.stage === "source-unknown") return sameService && (after.stage === "source-updated"
    || (after.stage === "source-unknown" && after.observations === before.observations! + 1)
    || (after.stage === "source-ready" && before.observations === ABSENCE_OBSERVATIONS_BEFORE_RETRY - 1));
  if (before.stage === "source-updated") return before.serviceIndex === 2
    ? afterService(2)
    : after.stage === "start-ready" && sameService && after.attempt === 1;
  if (before.stage === "start-ready") return after.stage === "start-pending" && sameService && sameAttempt;
  if (before.stage === "start-pending") return sameService && sameAttempt && (after.stage === "started"
    || after.stage === "start-ambiguous" && JSON.stringify(after.baselineDeploymentIds) === JSON.stringify(before.baselineDeploymentIds)
    || (after.stage === "start-unknown" && after.observations === 0));
  if (before.stage === "start-unknown") return sameService && (after.stage === "started" && sameAttempt
    || after.stage === "start-ambiguous" && sameAttempt
      && JSON.stringify(after.baselineDeploymentIds) === JSON.stringify(before.baselineDeploymentIds)
    || after.stage === "start-unknown" && sameAttempt && after.observations === before.observations! + 1
    || after.stage === "start-ready" && before.observations === ABSENCE_OBSERVATIONS_BEFORE_RETRY - 1
      && after.attempt === before.attempt! + 1);
  if (before.stage === "migration-ready") return after.stage === "migration-source-pending";
  if (before.stage === "migration-source-pending") return after.stage === "migration-command-ready";
  if (before.stage === "migration-command-ready") return after.stage === "migration-command-pending";
  if (before.stage === "migration-command-pending") return after.stage === "migration-start-ready";
  if (before.stage === "migration-start-ready") return after.stage === "migration-start-pending";
  if (before.stage === "migration-start-pending") return after.stage === "migration-started"
      && after.migrationDeploymentId !== undefined && !before.baselineDeploymentIds!.includes(after.migrationDeploymentId)
    || after.stage === "migration-start-ambiguous"
      && JSON.stringify(after.baselineDeploymentIds) === JSON.stringify(before.baselineDeploymentIds)
    || after.stage === "migration-start-unknown" && after.observations === 0
      && JSON.stringify(after.baselineDeploymentIds) === JSON.stringify(before.baselineDeploymentIds);
  if (before.stage === "migration-start-unknown") return after.stage === "migration-started"
      && after.migrationDeploymentId !== undefined && !before.baselineDeploymentIds!.includes(after.migrationDeploymentId)
    || after.stage === "migration-start-ambiguous"
      && JSON.stringify(after.baselineDeploymentIds) === JSON.stringify(before.baselineDeploymentIds)
    || after.stage === "migration-start-unknown" && after.observations === before.observations! + 1
      && JSON.stringify(after.baselineDeploymentIds) === JSON.stringify(before.baselineDeploymentIds)
    || after.stage === "migration-start-unresolved"
      && before.observations === MIGRATION_ABSENCE_OBSERVATIONS_BEFORE_TERMINAL - 1
      && JSON.stringify(after.baselineDeploymentIds) === JSON.stringify(before.baselineDeploymentIds);
  if (before.stage === "migration-started") return after.stage === "migration-started"
    || after.stage === "migration-reset-ready" && after.migrationDeploymentId === before.migrationDeploymentId;
  if (before.stage === "migration-reset-ready") return after.stage === "migration-reset-pending" && after.migrationDeploymentId === before.migrationDeploymentId;
  if (before.stage === "migration-reset-pending") return after.stage === "migration-proven" && after.migrationDeploymentId === before.migrationDeploymentId;
  if (before.stage === "migration-proven") return after.stage === "source-ready" && after.serviceIndex === 2;
  if (before.stage === "start-ambiguous") return false;
  if (before.stage === "verify-final") return after.stage === "complete";
  return before.stage === "complete" && after.stage === "complete";
}

function snapshotBinding(input: RailwayWholeManifestUpgradeBinding): RailwayWholeManifestUpgradeBinding | undefined {
  try {
    const services = Object.freeze(input.services.map((service) => Object.freeze({
      name: service.name, serviceId: `${service.serviceId}`, oldImage: `${service.oldImage}`,
      newImage: `${service.newImage}`, kind: service.kind,
    })));
    const binding: RailwayWholeManifestUpgradeBinding = Object.freeze({
      releaseId: `${input.releaseId}`, projectId: `${input.projectId}`, environmentId: `${input.environmentId}`, services,
      migration: Object.freeze({ migrationId: `${input.migration.migrationId}`, executionId: `${input.migration.executionId}` }),
    });
    return validId(binding.releaseId) && validId(binding.projectId) && validId(binding.environmentId)
      && validMigrationId(binding.migration.migrationId) && validMigrationId(binding.migration.executionId)
      && validServices(binding.services) && new Set(binding.services.map(({ serviceId }) => serviceId)).size === SERVICE_ORDER.length
      ? binding : undefined;
  } catch { return undefined; }
}

function snapshotExecutor(input: RailwayWholeManifestUpgradeExecutor): RailwayWholeManifestUpgradeExecutor {
  return Object.freeze({
    getServiceInstance: input.getServiceInstance.bind(input), listDeploymentsRaw: input.listDeploymentsRaw.bind(input),
    updateServiceSource: input.updateServiceSource.bind(input), createDeployment: input.createDeployment.bind(input),
    getDeployment: input.getDeployment.bind(input), setServiceStartCommand: input.setServiceStartCommand.bind(input),
  });
}

function clone(checkpoint: RailwayWholeManifestUpgradeCheckpoint): RailwayWholeManifestUpgradeCheckpoint {
  return structuredClone(checkpoint);
}

export class RailwayWholeManifestUpgrade {
  readonly #binding: RailwayWholeManifestUpgradeBinding | undefined;
  readonly #executor: RailwayWholeManifestUpgradeExecutor;
  readonly #load: RailwayWholeManifestUpgradeOptions["loadCheckpoint"];
  readonly #persist: RailwayWholeManifestUpgradeOptions["persistCheckpoint"];
  #migrationDeploymentId: string | undefined;

  constructor(options: RailwayWholeManifestUpgradeOptions) {
    this.#binding = snapshotBinding(options.binding);
    this.#executor = snapshotExecutor(options.executor);
    this.#load = options.loadCheckpoint;
    this.#persist = options.persistCheckpoint;
  }

  #checkpoint(
    stage: RailwayWholeManifestUpgradeStage,
    completedDeployments: readonly RailwayWholeManifestUpgradeCompletedDeployment[] = [],
    extra: Partial<RailwayWholeManifestUpgradeCheckpoint> = {},
  ): RailwayWholeManifestUpgradeCheckpoint {
    const binding = this.#binding!;
    const carriesMigration = stage === "migration-started" || stage === "migration-reset-ready"
      || stage === "migration-reset-pending" || stage === "migration-proven" || stage === "verify-final" || stage === "complete"
      || ((stage.startsWith("source-") || stage.startsWith("start-") || stage === "started")
        && typeof extra.serviceIndex === "number" && extra.serviceIndex >= 2);
    return { schemaVersion: RAILWAY_WHOLE_MANIFEST_UPGRADE_SCHEMA_VERSION, releaseId: binding.releaseId,
      projectId: binding.projectId, environmentId: binding.environmentId, services: binding.services,
      migrationId: binding.migration.migrationId, migrationExecutionId: binding.migration.executionId,
      completedDeployments, stage, ...(carriesMigration ? { migrationDeploymentId: this.#migrationDeploymentId } : {}), ...extra };
  }

  #pending(checkpoint: RailwayWholeManifestUpgradeCheckpoint, code?: RailwayWholeManifestUpgradeFailureCode): RailwayWholeManifestUpgradeResult {
    return { outcome: "pending", checkpoint: clone(checkpoint), ...(code === undefined ? {} : { code }) };
  }

  #failure(code: RailwayWholeManifestUpgradeFailureCode, checkpoint?: RailwayWholeManifestUpgradeCheckpoint): RailwayWholeManifestUpgradeResult {
    return { outcome: "failure", code, fallbackRequired: true, ...(checkpoint === undefined ? {} : { checkpoint: clone(checkpoint) }) };
  }

  async #save(next: RailwayWholeManifestUpgradeCheckpoint, durable: RailwayWholeManifestUpgradeCheckpoint): Promise<RailwayWholeManifestUpgradeResult | undefined> {
    if (!isRailwayWholeManifestUpgradeCheckpointTransition(durable, next)) {
      return this.#failure("invalid-checkpoint", durable);
    }
    try { await this.#persist(clone(next)); return undefined; } catch { return this.#pending(durable, "persistence-failure"); }
  }

  async #instance(service: RailwayWholeManifestUpgradeService): Promise<RailwayServiceInstance | undefined> {
    try {
      const instance = await this.#executor.getServiceInstance({ serviceId: service.serviceId, environmentId: this.#binding!.environmentId });
      return instance !== null && instance.serviceId === service.serviceId && instance.environmentId === this.#binding!.environmentId ? instance : undefined;
    } catch { return undefined; }
  }

  async #raw(service: RailwayWholeManifestUpgradeService): Promise<readonly RailwayDeployment[] | undefined> {
    try {
      const value = await this.#executor.listDeploymentsRaw({ projectId: this.#binding!.projectId, environmentId: this.#binding!.environmentId, serviceId: service.serviceId });
      return validBaseline(value.map(({ id }) => id).sort()) ? value : undefined;
    } catch { return undefined; }
  }

  async #deploymentDelta(checkpoint: RailwayWholeManifestUpgradeCheckpoint, service: RailwayWholeManifestUpgradeService): Promise<"error" | "zero" | { readonly deploymentIds: readonly string[] }> {
    const raw = await this.#raw(service);
    if (raw === undefined || checkpoint.baselineDeploymentIds === undefined) return "error";
    const baseline = new Set(checkpoint.baselineDeploymentIds);
    const added = raw.map(({ id }) => id).filter((id) => !baseline.has(id)).sort();
    return added.length === 0 ? "zero" : { deploymentIds: added };
  }

  async #ambiguous(
    checkpoint: RailwayWholeManifestUpgradeCheckpoint,
    deploymentIds: readonly string[],
  ): Promise<RailwayWholeManifestUpgradeResult> {
    const terminal = this.#checkpoint("start-ambiguous", checkpoint.completedDeployments, {
      serviceIndex: checkpoint.serviceIndex,
      attempt: checkpoint.attempt,
      baselineDeploymentIds: checkpoint.baselineDeploymentIds,
      ambiguousDeploymentIds: deploymentIds,
    });
    return await this.#save(terminal, checkpoint) ?? this.#failure("deployment-ambiguous", terminal);
  }

  #afterService(index: number, completedDeployments: readonly RailwayWholeManifestUpgradeCompletedDeployment[]): RailwayWholeManifestUpgradeCheckpoint {
    if (index === 0) return this.#checkpoint("source-ready", completedDeployments, { serviceIndex: 1 });
    if (index === 1) return this.#checkpoint("migration-ready", completedDeployments);
    if (index === 2) return this.#checkpoint("source-ready", completedDeployments, { serviceIndex: 3 });
    if (index === 3) return this.#checkpoint("source-ready", completedDeployments, { serviceIndex: 4 });
    return this.#checkpoint("verify-final", completedDeployments);
  }

  #migrationCommand(): string {
    return `bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts migrate ${this.#binding!.migration.migrationId} ${this.#binding!.migration.executionId}`;
  }

  async run(): Promise<RailwayWholeManifestUpgradeResult> {
    if (this.#binding === undefined) return this.#failure("invalid-input");
    let checkpoint: RailwayWholeManifestUpgradeCheckpoint;
    try {
      const loaded = await this.#load();
      if (loaded !== undefined && !isRailwayWholeManifestUpgradeCheckpoint(loaded, this.#binding)) return this.#failure("invalid-checkpoint");
      if (loaded === undefined) {
        checkpoint = this.#checkpoint("verify-old");
        // Bind the exact release/service/image intent durably before any
        // provider observation or mutation. Composite stores admit a new
        // candidate only at verify-old; skipping directly to source-ready
        // makes the first CAS invalid and leaves the upgrade unable to start.
        try { await this.#persist(clone(checkpoint)); }
        catch { return this.#pending(checkpoint, "persistence-failure"); }
        return this.#pending(checkpoint);
      }
      checkpoint = clone(loaded);
      this.#migrationDeploymentId = checkpoint.migrationDeploymentId;
    } catch { return this.#pending(this.#checkpoint("verify-old"), "executor-failure"); }

    if (checkpoint.stage === "complete") return { outcome: "complete", checkpoint };
    if (checkpoint.stage === "start-ambiguous") return this.#failure("deployment-ambiguous", checkpoint);
    if (checkpoint.stage === "verify-old") {
      for (const service of this.#binding.services) {
        const instance = await this.#instance(service);
        if (instance === undefined) return this.#pending(checkpoint, "executor-failure");
        if (!sourceExact(instance, service.oldImage)) return this.#failure("source-drift", checkpoint);
      }
      const next = this.#checkpoint("source-ready", checkpoint.completedDeployments, { serviceIndex: 0 });
      return await this.#save(next, checkpoint) ?? this.#pending(next);
    }

    if (checkpoint.stage.startsWith("migration-")) {
      const service = this.#binding.services[MIGRATION_SERVICE_INDEX]!;
      const command = this.#migrationCommand();
      if (checkpoint.stage === "migration-ready" || checkpoint.stage === "migration-source-pending") {
        const durable = checkpoint.stage === "migration-ready"
          ? this.#checkpoint("migration-source-pending", checkpoint.completedDeployments) : checkpoint;
        if (checkpoint.stage === "migration-ready") {
          const saveFailure = await this.#save(durable, checkpoint); if (saveFailure !== undefined) return saveFailure;
        }
        let instance = await this.#instance(service);
        if (instance === undefined) return this.#pending(durable, "executor-failure");
        if (!sourceExact(instance, service.newImage)) {
          if (!sourceExact(instance, service.oldImage)) return this.#failure("source-drift", durable);
          try { await this.#executor.updateServiceSource({ serviceId: service.serviceId, environmentId: this.#binding.environmentId, image: service.newImage }); } catch { /* observe */ }
          instance = await this.#instance(service);
        }
        if (instance === undefined || !sourceExact(instance, service.newImage)) return this.#pending(durable, "source-update-unknown");
        const next = this.#checkpoint("migration-command-ready", checkpoint.completedDeployments);
        return await this.#save(next, durable) ?? this.#pending(next);
      }
      if (checkpoint.stage === "migration-command-ready" || checkpoint.stage === "migration-command-pending") {
        const durable = checkpoint.stage === "migration-command-ready"
          ? this.#checkpoint("migration-command-pending", checkpoint.completedDeployments) : checkpoint;
        if (checkpoint.stage === "migration-command-ready") {
          const saveFailure = await this.#save(durable, checkpoint); if (saveFailure !== undefined) return saveFailure;
        }
        let instance = await this.#instance(service);
        if (instance === undefined || !sourceExact(instance, service.newImage)) return this.#failure("source-drift", durable);
        if ((instance.startCommand ?? null) !== command) {
          try { await this.#executor.setServiceStartCommand({ serviceId: service.serviceId, environmentId: this.#binding.environmentId, startCommand: command }); } catch { /* observe */ }
          instance = await this.#instance(service);
        }
        if (instance === undefined || (instance.startCommand ?? null) !== command) return this.#pending(durable, "migration-unknown");
        const next = this.#checkpoint("migration-start-ready", checkpoint.completedDeployments);
        return await this.#save(next, durable) ?? this.#pending(next);
      }
      if (checkpoint.stage === "migration-start-ready") {
        const raw = await this.#raw(service);
        if (raw === undefined) return this.#pending(checkpoint, "executor-failure");
        const pending = this.#checkpoint("migration-start-pending", checkpoint.completedDeployments,
          { baselineDeploymentIds: raw.map(({ id }) => id).sort() });
        const saveFailure = await this.#save(pending, checkpoint); if (saveFailure !== undefined) return saveFailure;
        try { await this.#executor.createDeployment({ serviceId: service.serviceId, environmentId: this.#binding.environmentId }); } catch { /* raw delta */ }
        checkpoint = pending;
      }
      if (checkpoint.stage === "migration-start-pending" || checkpoint.stage === "migration-start-unknown") {
        const delta = await this.#deploymentDelta(checkpoint, service);
        if (delta === "error") return this.#pending(checkpoint, "executor-failure");
        if (delta === "zero") {
          const observations = checkpoint.stage === "migration-start-pending" ? 0 : checkpoint.observations! + 1;
          const next = observations >= MIGRATION_ABSENCE_OBSERVATIONS_BEFORE_TERMINAL
            ? this.#checkpoint("migration-start-unresolved", checkpoint.completedDeployments,
              { baselineDeploymentIds: checkpoint.baselineDeploymentIds, observations })
            : this.#checkpoint("migration-start-unknown", checkpoint.completedDeployments,
              { baselineDeploymentIds: checkpoint.baselineDeploymentIds, observations });
          const saveFailure = await this.#save(next, checkpoint); if (saveFailure !== undefined) return saveFailure;
          return next.stage === "migration-start-unresolved"
            ? this.#failure("migration-start-unresolved", next)
            : this.#pending(next, "migration-unknown");
        }
        if (delta.deploymentIds.length > 1) {
          const terminal = this.#checkpoint("migration-start-ambiguous", checkpoint.completedDeployments,
            { baselineDeploymentIds: checkpoint.baselineDeploymentIds, ambiguousDeploymentIds: delta.deploymentIds });
          return await this.#save(terminal, checkpoint) ?? this.#failure("deployment-ambiguous", terminal);
        }
        this.#migrationDeploymentId = delta.deploymentIds[0];
        const next = this.#checkpoint("migration-started", checkpoint.completedDeployments);
        return await this.#save(next, checkpoint) ?? this.#pending(next);
      }
      if (checkpoint.stage === "migration-start-ambiguous") return this.#failure("deployment-ambiguous", checkpoint);
      if (checkpoint.stage === "migration-start-unresolved") return this.#failure("migration-start-unresolved", checkpoint);
      if (checkpoint.stage === "migration-started") {
        let deployment: RailwayDeployment;
        try { deployment = await this.#executor.getDeployment({ deploymentId: checkpoint.migrationDeploymentId! }); }
        catch { return this.#pending(checkpoint, "executor-failure"); }
        if (deployment.id !== checkpoint.migrationDeploymentId) return this.#pending(checkpoint, "executor-failure");
        if (FAILED_DEPLOYMENTS.has(deployment.status)
          || deployment.instances?.some(({ status }) => status !== "EXITED" && MIGRATION_FAILED_INSTANCES.has(status)) === true) {
          return this.#failure("migration-terminal", checkpoint);
        }
        if (deployment.status !== "SUCCESS" || deployment.deploymentStopped !== true
          || deployment.instances === undefined || deployment.instances.length === 0
          || !deployment.instances.every(({ status }) => status === "EXITED")) return this.#pending(checkpoint);
        const next = this.#checkpoint("migration-reset-ready", checkpoint.completedDeployments);
        return await this.#save(next, checkpoint) ?? this.#pending(next);
      }
      if (checkpoint.stage === "migration-reset-ready" || checkpoint.stage === "migration-reset-pending") {
        const durable = checkpoint.stage === "migration-reset-ready"
          ? this.#checkpoint("migration-reset-pending", checkpoint.completedDeployments) : checkpoint;
        if (checkpoint.stage === "migration-reset-ready") {
          const saveFailure = await this.#save(durable, checkpoint); if (saveFailure !== undefined) return saveFailure;
        }
        let instance = await this.#instance(service);
        if (instance === undefined) return this.#pending(durable, "executor-failure");
        if ((instance.startCommand ?? null) !== null) {
          try { await this.#executor.setServiceStartCommand({ serviceId: service.serviceId, environmentId: this.#binding.environmentId, startCommand: null }); } catch { /* observe */ }
          instance = await this.#instance(service);
        }
        if (instance === undefined || (instance.startCommand ?? null) !== null) return this.#pending(durable, "migration-unknown");
        const next = this.#checkpoint("migration-proven", checkpoint.completedDeployments);
        return await this.#save(next, durable) ?? this.#pending(next);
      }
    }
    if (checkpoint.stage === "migration-proven") {
      const next = this.#checkpoint("source-ready", checkpoint.completedDeployments, { serviceIndex: 2 });
      return await this.#save(next, checkpoint) ?? this.#pending(next);
    }
    if (checkpoint.stage === "verify-final") {
      for (const service of this.#binding.services) {
        const instance = await this.#instance(service);
        if (instance === undefined) return this.#pending(checkpoint, "executor-failure");
        if (!sourceExact(instance, service.newImage)) return this.#failure("source-drift", checkpoint);
      }
      const next = this.#checkpoint("complete", checkpoint.completedDeployments);
      return await this.#save(next, checkpoint) ?? { outcome: "complete", checkpoint: next };
    }

    const service = this.#binding.services[checkpoint.serviceIndex!];
    if (service === undefined) return this.#failure("invalid-checkpoint", checkpoint);

    if (checkpoint.stage === "source-ready") {
      const instance = await this.#instance(service);
      if (instance === undefined) return this.#pending(checkpoint, "executor-failure");
      if (sourceExact(instance, service.newImage)) {
        const next = this.#checkpoint("source-updated", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex });
        return await this.#save(next, checkpoint) ?? this.#pending(next);
      }
      if (!sourceExact(instance, service.oldImage)) return this.#failure("source-drift", checkpoint);
      const pending = this.#checkpoint("source-pending", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex });
      const saveFailure = await this.#save(pending, checkpoint);
      if (saveFailure !== undefined) return saveFailure;
      try { await this.#executor.updateServiceSource({ serviceId: service.serviceId, environmentId: this.#binding.environmentId, image: service.newImage }); } catch { /* exact observation below */ }
      const after = await this.#instance(service);
      if (after !== undefined && sourceExact(after, service.newImage)) {
        const next = this.#checkpoint("source-updated", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex });
        return await this.#save(next, pending) ?? this.#pending(next);
      }
      const unknown = this.#checkpoint("source-unknown", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, observations: 0 });
      return await this.#save(unknown, pending) ?? this.#pending(unknown, "source-update-unknown");
    }
    if (checkpoint.stage === "source-pending" || checkpoint.stage === "source-unknown") {
      const instance = await this.#instance(service);
      if (instance === undefined) return this.#pending(checkpoint, "executor-failure");
      if (sourceExact(instance, service.newImage)) {
        const next = this.#checkpoint("source-updated", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex });
        return await this.#save(next, checkpoint) ?? this.#pending(next);
      }
      if (!sourceExact(instance, service.oldImage)) return this.#failure("source-drift", checkpoint);
      if (checkpoint.stage === "source-pending") {
        const next = this.#checkpoint("source-unknown", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, observations: 0 });
        return await this.#save(next, checkpoint) ?? this.#pending(next, "source-update-unknown");
      }
      const observations = checkpoint.observations! + 1;
      const next = observations >= ABSENCE_OBSERVATIONS_BEFORE_RETRY
        ? this.#checkpoint("source-ready", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex })
        : this.#checkpoint("source-unknown", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, observations });
      return await this.#save(next, checkpoint) ?? this.#pending(next, "source-update-unknown");
    }
    if (checkpoint.stage === "source-updated") {
      const instance = await this.#instance(service);
      if (instance === undefined) return this.#pending(checkpoint, "executor-failure");
      if (!sourceExact(instance, service.newImage)) return this.#failure("source-drift", checkpoint);
      const next = service.name === "logto-seed" ? this.#afterService(checkpoint.serviceIndex!, checkpoint.completedDeployments)
        : this.#checkpoint("start-ready", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, attempt: 1 });
      return await this.#save(next, checkpoint) ?? this.#pending(next);
    }
    if (checkpoint.stage === "start-ready") {
      const raw = await this.#raw(service);
      if (raw === undefined) return this.#pending(checkpoint, "executor-failure");
      const pending = this.#checkpoint("start-pending", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, attempt: checkpoint.attempt,
        baselineDeploymentIds: raw.map(({ id }) => id).sort() });
      const saveFailure = await this.#save(pending, checkpoint);
      if (saveFailure !== undefined) return saveFailure;
      try { await this.#executor.createDeployment({ serviceId: service.serviceId, environmentId: this.#binding.environmentId }); } catch { /* raw delta is authoritative */ }
      const delta = await this.#deploymentDelta(pending, service);
      if (typeof delta === "object" && delta.deploymentIds.length === 1) {
        const next = this.#checkpoint("started", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, attempt: checkpoint.attempt, deploymentId: delta.deploymentIds[0] });
        return await this.#save(next, pending) ?? this.#pending(next);
      }
      if (typeof delta === "object") return this.#ambiguous(pending, delta.deploymentIds);
      const unknown = this.#checkpoint("start-unknown", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, attempt: checkpoint.attempt,
        observations: 0, baselineDeploymentIds: pending.baselineDeploymentIds });
      return await this.#save(unknown, pending) ?? this.#pending(unknown, delta === "error" ? "executor-failure" : "deployment-unknown");
    }
    if (checkpoint.stage === "start-pending" || checkpoint.stage === "start-unknown") {
      const instance = await this.#instance(service);
      if (instance === undefined) return this.#pending(checkpoint, "executor-failure");
      if (!sourceExact(instance, service.newImage)) return this.#failure("source-drift", checkpoint);
      const delta = await this.#deploymentDelta(checkpoint, service);
      if (typeof delta === "object" && delta.deploymentIds.length === 1) {
        const next = this.#checkpoint("started", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, attempt: checkpoint.attempt, deploymentId: delta.deploymentIds[0] });
        return await this.#save(next, checkpoint) ?? this.#pending(next);
      }
      if (typeof delta === "object") return this.#ambiguous(checkpoint, delta.deploymentIds);
      if (delta === "error") return this.#pending(checkpoint, "executor-failure");
      if (checkpoint.stage === "start-pending") {
        const next = this.#checkpoint("start-unknown", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, attempt: checkpoint.attempt,
          observations: 0, baselineDeploymentIds: checkpoint.baselineDeploymentIds });
        return await this.#save(next, checkpoint) ?? this.#pending(next, "deployment-unknown");
      }
      const observations = checkpoint.observations! + 1;
      if (observations >= ABSENCE_OBSERVATIONS_BEFORE_RETRY && checkpoint.attempt! >= MAX_ATTEMPTS) {
        return this.#failure("deployment-terminal", checkpoint);
      }
      const next = observations >= ABSENCE_OBSERVATIONS_BEFORE_RETRY
        ? this.#checkpoint("start-ready", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, attempt: checkpoint.attempt! + 1 })
        : this.#checkpoint("start-unknown", checkpoint.completedDeployments, { serviceIndex: checkpoint.serviceIndex, attempt: checkpoint.attempt,
          observations, baselineDeploymentIds: checkpoint.baselineDeploymentIds });
      return await this.#save(next, checkpoint) ?? this.#pending(next, "deployment-unknown");
    }
    if (checkpoint.stage === "started") {
      const instance = await this.#instance(service);
      if (instance === undefined) return this.#pending(checkpoint, "executor-failure");
      if (!sourceExact(instance, service.newImage)) return this.#failure("source-drift", checkpoint);
      let deployment: RailwayDeployment;
      try { deployment = await this.#executor.getDeployment({ deploymentId: checkpoint.deploymentId! }); }
      catch { return this.#pending(checkpoint, "executor-failure"); }
      if (deployment.id !== checkpoint.deploymentId) return this.#pending(checkpoint, "executor-failure");
      if (FAILED_DEPLOYMENTS.has(deployment.status)) {
        return this.#failure("deployment-terminal", checkpoint);
      }
      // Railway may retain an EXITED predecessor instance while a rolling
      // deployment is still DEPLOYING. Instance terminality is authoritative
      // only after the deployment itself reaches SUCCESS; before that, wait.
      if (deployment.status !== "SUCCESS") return this.#pending(checkpoint);
      if (deployment.deploymentStopped === true
        || deployment.instances?.some(({ status }) => FAILED_INSTANCES.has(status)) === true) {
        return this.#failure("deployment-terminal", checkpoint);
      }
      if (deployment.deploymentStopped !== false
        || deployment.instances === undefined || deployment.instances.length === 0
        || !deployment.instances.every(({ status }) => status === "RUNNING")) return this.#pending(checkpoint);
      if (service.name === "logto-seed") return this.#failure("invalid-checkpoint", checkpoint);
      const completedDeployments = [
        ...checkpoint.completedDeployments,
        { name: service.name, serviceId: service.serviceId, deploymentId: checkpoint.deploymentId },
      ];
      const next = this.#afterService(checkpoint.serviceIndex!, completedDeployments);
      return await this.#save(next, checkpoint) ?? this.#pending(next);
    }
    return this.#failure("invalid-checkpoint", checkpoint);
  }
}

export async function runRailwayWholeManifestUpgrade(options: RailwayWholeManifestUpgradeOptions): Promise<RailwayWholeManifestUpgradeResult> {
  return new RailwayWholeManifestUpgrade(options).run();
}
