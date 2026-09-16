import type { RailwayDeployment, RailwayDeploymentStatus, RailwayEnvironmentVariables, RailwayService, RailwayServiceDomain } from "./operations";
import type { RailwayTransientBootstrapIntent } from "./topology";

/** Versioned, durable, deliberately non-secret bootstrap progress. */
export const RAILWAY_BOOTSTRAP_LIFECYCLE_SCHEMA_VERSION = 1;

export type RailwayBootstrapLifecycleStage =
  | "inventory"
  | "create"
  | "variables"
  | "start-deployment"
  | "observe-deployment"
  | "handoff-domain"
  | "handoff-fetch"
  | "handoff-apply"
  | "checkpoint-success"
  | "delete"
  | "verify-absent";

export interface RailwayBootstrapLifecycleTarget {
  readonly projectId: string;
  readonly environmentId: string;
  readonly intent: RailwayTransientBootstrapIntent;
}

/**
 * This is intentionally the whole serializable state shape. In particular it
 * has no variable names, variable values, URLs, raw errors, or OAuth material.
 */
export interface RailwayBootstrapLifecycleCheckpoint {
  readonly schemaVersion: typeof RAILWAY_BOOTSTRAP_LIFECYCLE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceName: "nautilo-bootstrap";
  /** Digest-only content identity; never the registry reference. */
  readonly imageDigest: string;
  readonly serviceId?: string | undefined;
  readonly variablesApplied?: true | undefined;
  readonly deploymentId?: string | undefined;
  readonly successfulDeploymentId?: string | undefined;
  readonly failedDeploymentId?: string | undefined;
  readonly handoffDomainId?: string | undefined;
  readonly handoffDomain?: string | undefined;
  readonly handoffApplied?: true | undefined;
}

export interface RailwayBootstrapHandoffOutput {
  readonly "logto-workbench-app-id": string;
  readonly "logto-tui-app-id": string;
  readonly "logto-tui-loopback-app-id": string;
  readonly "logto-desktop-app-id": string;
  readonly "logto-mobile-app-id": string;
  readonly "logto-mobile-web-app-id": string;
  readonly "logto-m2m-app-id": string;
  readonly "logto-m2m-app-secret": string;
  readonly "logto-resource": string;
}

/** The narrow, safe deployment projection required by this coordinator. */
export interface RailwayBootstrapDeployment {
  readonly id: string;
  readonly status: RailwayDeploymentStatus;
  readonly deploymentStopped?: RailwayDeployment["deploymentStopped"];
  readonly instances?: RailwayDeployment["instances"];
}

/**
 * Railway-facing effects are injected so this module has no transport, receipt
 * store, logging, sleep, or secret-retention implementation. A real adapter
 * must create an empty service with no source. It applies variables before the
 * `startDeployment` primitive connects the certified immutable image and
 * observes the resulting deployment. Railway's current public API documents
 * empty-service creation and source-only image attachment. The start primitive
 * receives the same request-memory variables so the concrete adapter can
 * re-apply them after attaching the source and before creating the deployment.
 * This prevents Railway from snapshotting unresolved cross-service references
 * during an atomic connect-and-deploy operation.
 */
export interface RailwayBootstrapLifecycleExecutor {
  readonly inventoryServices: (input: { readonly projectId: string }) => Promise<readonly RailwayService[]>;
  readonly createService: (input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly name: "nautilo-bootstrap";
  }) => Promise<RailwayService>;
  /** Values exist only in this call's request memory and must not be logged. */
  readonly applyServiceVariables: (input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly variables: RailwayEnvironmentVariables;
  }) => Promise<void>;
  readonly inventoryDeployments: (input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
  }) => Promise<readonly RailwayBootstrapDeployment[]>;
  readonly startDeployment: (input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly image: string;
    readonly variables: RailwayEnvironmentVariables;
  }) => Promise<RailwayBootstrapDeployment>;
  readonly observeDeployment: (input: { readonly deploymentId: string }) => Promise<RailwayBootstrapDeployment>;
  readonly listDomains?: ((input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
  }) => Promise<readonly RailwayServiceDomain[]>) | undefined;
  readonly createDomain?: ((input: {
    readonly serviceId: string;
    readonly environmentId: string;
    readonly targetPort: number;
  }) => Promise<RailwayServiceDomain>) | undefined;
  /** Performs bounded HTTPS readiness/retry and never logs the token/body. */
  readonly fetchHandoff?: ((input: {
    readonly origin: string;
    readonly token: string;
  }) => Promise<RailwayBootstrapHandoffOutput>) | undefined;
  readonly deleteService: (input: {
    readonly serviceId: string;
    readonly environmentId: string;
  }) => Promise<void>;
}

export interface RailwayBootstrapLifecycleRequest {
  readonly target: RailwayBootstrapLifecycleTarget;
  /** Request-only values. This object is never returned, persisted, or logged. */
  readonly variables: RailwayEnvironmentVariables;
  readonly checkpoint?: RailwayBootstrapLifecycleCheckpoint | undefined;
  readonly executor: RailwayBootstrapLifecycleExecutor;
  /** The caller owns durable receipt persistence; this receives safe state only. */
  readonly persistCheckpoint: (checkpoint: RailwayBootstrapLifecycleCheckpoint) => Promise<void>;
  readonly handoff?: {
    /** Request-memory only; never copied into a checkpoint or result. */
    readonly token: string;
    readonly targetPort: number;
    /** Must be idempotent: retry may follow a lost persistence response. */
    readonly applyOutput: (output: RailwayBootstrapHandoffOutput) => Promise<void>;
  } | undefined;
}

export type RailwayBootstrapLifecycleFailureCode =
  | "invalid-target"
  | "invalid-checkpoint"
  | "executor-failure"
  | "ambiguous-service"
  | "checkpoint-service-missing"
  | "ambiguous-deployment"
  | "deployment-mismatch"
  | "invalid-handoff"
  | "ambiguous-handoff-domain"
  | "handoff-output-invalid"
  | "handoff-authorization-rejected"
  | "handoff-client-rejected"
  | "handoff-response-invalid"
  | "handoff-transient-exhausted"
  | "bootstrap-deployment-failed"
  | "cleanup-service-still-present";

export type RailwayBootstrapHandoffFetchFailureCode =
  | "authorization-rejected"
  | "client-rejected"
  | "response-invalid"
  | "transient-exhausted";

/** Safe classification only: never carries the bearer, provider body, or URL. */
export class RailwayBootstrapHandoffFetchError extends Error {
  constructor(readonly code: RailwayBootstrapHandoffFetchFailureCode) {
    super("Railway bootstrap handoff fetch failed");
    this.name = "RailwayBootstrapHandoffFetchError";
  }
}

/** Safe control signal: the idempotent handoff started durable child work that is not complete yet. */
export class RailwayBootstrapHandoffPendingError extends Error {
  constructor() {
    super("Railway bootstrap handoff is pending");
    this.name = "RailwayBootstrapHandoffPendingError";
  }
}

export interface RailwayBootstrapLifecycleFailure {
  readonly outcome: "failure";
  readonly stage: RailwayBootstrapLifecycleStage;
  readonly code: RailwayBootstrapLifecycleFailureCode;
  readonly checkpoint?: RailwayBootstrapLifecycleCheckpoint | undefined;
}

interface RailwayBootstrapLifecyclePending {
  readonly outcome: "pending";
  readonly stage: "observe-deployment" | "handoff-apply";
  readonly checkpoint: RailwayBootstrapLifecycleCheckpoint;
}

export type RailwayBootstrapLifecycleResult =
  | RailwayBootstrapLifecyclePending
  | {
      readonly outcome: "complete";
      readonly checkpoint: RailwayBootstrapLifecycleCheckpoint;
    }
  | RailwayBootstrapLifecycleFailure;

const TERMINAL_FAILURE_STATUSES = new Set<RailwayDeploymentStatus>([
  "CRASHED",
  "FAILED",
  "REMOVED",
  "SKIPPED",
]);

function bootstrapImageDigest(image: string): string | null {
  const match = /@(sha256:[a-f0-9]{64})$/.exec(image);
  return match?.[1] ?? null;
}

function baseCheckpoint(
  target: RailwayBootstrapLifecycleTarget,
  imageDigest: string,
): RailwayBootstrapLifecycleCheckpoint {
  return {
    schemaVersion: RAILWAY_BOOTSTRAP_LIFECYCLE_SCHEMA_VERSION,
    projectId: target.projectId,
    environmentId: target.environmentId,
    serviceName: target.intent.serviceName,
    imageDigest,
  };
}

function checkpointMatchesTarget(
  checkpoint: RailwayBootstrapLifecycleCheckpoint,
  target: RailwayBootstrapLifecycleTarget,
  imageDigest: string,
): boolean {
  const hasService = checkpoint.serviceId !== undefined;
  const hasVariables = checkpoint.variablesApplied === true;
  const hasDeployment = checkpoint.deploymentId !== undefined;
  const hasSuccessfulDeployment = checkpoint.successfulDeploymentId !== undefined;
  const hasFailedDeployment = checkpoint.failedDeploymentId !== undefined;
  const hasHandoffDomain = checkpoint.handoffDomainId !== undefined || checkpoint.handoffDomain !== undefined;

  return checkpoint.schemaVersion === RAILWAY_BOOTSTRAP_LIFECYCLE_SCHEMA_VERSION
    && checkpoint.projectId === target.projectId
    && checkpoint.environmentId === target.environmentId
    && checkpoint.serviceName === target.intent.serviceName
    && checkpoint.imageDigest === imageDigest
    && (!hasVariables || hasService)
    && (!hasDeployment || (hasService && hasVariables))
    && (!hasSuccessfulDeployment || (hasDeployment && checkpoint.successfulDeploymentId === checkpoint.deploymentId))
    && (!hasFailedDeployment || (hasDeployment && checkpoint.failedDeploymentId === checkpoint.deploymentId))
    && !(hasSuccessfulDeployment && hasFailedDeployment)
    && (!hasHandoffDomain || (checkpoint.handoffDomainId !== undefined && checkpoint.handoffDomain !== undefined && hasService))
    && (!checkpoint.handoffApplied || (hasHandoffDomain && hasSuccessfulDeployment));
}

function failure(
  stage: RailwayBootstrapLifecycleStage,
  code: RailwayBootstrapLifecycleFailureCode,
  checkpoint?: RailwayBootstrapLifecycleCheckpoint,
): RailwayBootstrapLifecycleFailure {
  return checkpoint === undefined
    ? { outcome: "failure", stage, code }
    : { outcome: "failure", stage, code, checkpoint };
}

async function persist(
  request: RailwayBootstrapLifecycleRequest,
  checkpoint: RailwayBootstrapLifecycleCheckpoint,
  stage: RailwayBootstrapLifecycleStage,
): Promise<RailwayBootstrapLifecycleFailure | null> {
  try {
    await request.persistCheckpoint(checkpoint);
    return null;
  } catch {
    return failure(stage, "executor-failure", checkpoint);
  }
}

async function inventoryServices(
  request: RailwayBootstrapLifecycleRequest,
  checkpoint: RailwayBootstrapLifecycleCheckpoint,
): Promise<readonly RailwayService[] | RailwayBootstrapLifecycleFailure> {
  try {
    return await request.executor.inventoryServices({ projectId: request.target.projectId });
  } catch {
    return failure("inventory", "executor-failure", checkpoint);
  }
}

function isFailure(value: unknown): value is RailwayBootstrapLifecycleFailure {
  return typeof value === "object" && value !== null && (value as { readonly outcome?: unknown }).outcome === "failure";
}

function namedBootstrapServices(services: readonly RailwayService[]): readonly RailwayService[] {
  return services.filter((service) => service.name === "nautilo-bootstrap");
}

function validHandoffOutput(value: RailwayBootstrapHandoffOutput): boolean {
  return Object.values(value).length === 9
    && Object.values(value).every((entry) => typeof entry === "string" && entry.length > 0);
}

function validHandoffRequest(request: RailwayBootstrapLifecycleRequest): boolean {
  const handoff = request.handoff;
  return handoff === undefined || (
    handoff.token.length >= 32
    && Number.isSafeInteger(handoff.targetPort)
    && handoff.targetPort > 0
    && handoff.targetPort <= 65_535
    && request.executor.listDomains !== undefined
    && request.executor.createDomain !== undefined
    && request.executor.fetchHandoff !== undefined
  );
}

async function ensureHandoffDomain(
  request: RailwayBootstrapLifecycleRequest,
  checkpoint: RailwayBootstrapLifecycleCheckpoint,
): Promise<RailwayBootstrapLifecycleCheckpoint | RailwayBootstrapLifecycleFailure> {
  if (!request.handoff) return checkpoint;
  const listDomains = request.executor.listDomains;
  const createDomain = request.executor.createDomain;
  if (!listDomains || !createDomain || !checkpoint.serviceId) {
    return failure("handoff-domain", "invalid-handoff", checkpoint);
  }
  let domains: readonly RailwayServiceDomain[];
  try {
    domains = await listDomains({
      projectId: request.target.projectId,
      environmentId: request.target.environmentId,
      serviceId: checkpoint.serviceId,
    });
  } catch {
    return failure("handoff-domain", "executor-failure", checkpoint);
  }
  if (checkpoint.handoffDomainId && checkpoint.handoffDomain) {
    return domains.some((domain) => domain.id === checkpoint.handoffDomainId
      && domain.domain === checkpoint.handoffDomain
      && domain.targetPort === request.handoff?.targetPort)
      ? checkpoint
      : failure("handoff-domain", "ambiguous-handoff-domain", checkpoint);
  }
  const matching = domains.filter((domain) => domain.targetPort === request.handoff?.targetPort);
  if (matching.length > 1) return failure("handoff-domain", "ambiguous-handoff-domain", checkpoint);
  let domain = matching[0];
  if (!domain) {
    try {
      domain = await createDomain({
        serviceId: checkpoint.serviceId,
        environmentId: request.target.environmentId,
        targetPort: request.handoff.targetPort,
      });
    } catch {
      return failure("handoff-domain", "executor-failure", checkpoint);
    }
  }
  if (!domain.domain || domain.targetPort !== request.handoff.targetPort) {
    return failure("handoff-domain", "ambiguous-handoff-domain", checkpoint);
  }
  const next = { ...checkpoint, handoffDomainId: domain.id, handoffDomain: domain.domain };
  const persistenceFailure = await persist(request, next, "handoff-domain");
  return persistenceFailure ?? next;
}

async function applyHandoff(
  request: RailwayBootstrapLifecycleRequest,
  checkpoint: RailwayBootstrapLifecycleCheckpoint,
): Promise<RailwayBootstrapLifecycleCheckpoint | RailwayBootstrapLifecycleFailure | RailwayBootstrapLifecyclePending> {
  if (!request.handoff || checkpoint.handoffApplied) return checkpoint;
  if (!request.executor.fetchHandoff || !checkpoint.handoffDomain) {
    return failure("handoff-fetch", "invalid-handoff", checkpoint);
  }
  let output: RailwayBootstrapHandoffOutput;
  try {
    output = await request.executor.fetchHandoff({
      origin: `https://${checkpoint.handoffDomain}`,
      token: request.handoff.token,
    });
  } catch (error) {
    if (error instanceof RailwayBootstrapHandoffFetchError) {
      return failure("handoff-fetch", `handoff-${error.code}`, checkpoint);
    }
    return failure("handoff-fetch", "executor-failure", checkpoint);
  }
  if (!validHandoffOutput(output)) return failure("handoff-fetch", "handoff-output-invalid", checkpoint);
  try {
    await request.handoff.applyOutput(output);
  } catch (error) {
    if (error instanceof RailwayBootstrapHandoffPendingError) {
      return { outcome: "pending", stage: "handoff-apply", checkpoint };
    }
    return failure("handoff-apply", "executor-failure", checkpoint);
  }
  const next = { ...checkpoint, handoffApplied: true as const };
  const persistenceFailure = await persist(request, next, "handoff-apply");
  return persistenceFailure ?? next;
}

/**
 * Delete the exact checkpointed service, then prove both its ID and its unique
 * bootstrap name are absent. A vanished service is already clean on retry.
 */
async function cleanup(
  request: RailwayBootstrapLifecycleRequest,
  checkpoint: RailwayBootstrapLifecycleCheckpoint,
): Promise<RailwayBootstrapLifecycleFailure | null> {
  if (!checkpoint.serviceId) {
    return failure("delete", "checkpoint-service-missing", checkpoint);
  }

  const before = await inventoryServices(request, checkpoint);
  if (isFailure(before)) return before;
  const service = before.find((candidate) => candidate.id === checkpoint.serviceId);
  if (service !== undefined) {
    if (service.name !== "nautilo-bootstrap") {
      return failure("delete", "checkpoint-service-missing", checkpoint);
    }
    try {
      await request.executor.deleteService({
        serviceId: checkpoint.serviceId,
        environmentId: request.target.environmentId,
      });
    } catch {
      return failure("delete", "executor-failure", checkpoint);
    }
  }

  const after = await inventoryServices(request, checkpoint);
  if (isFailure(after)) return after;
  if (after.some((candidate) => candidate.id === checkpoint.serviceId)
    || namedBootstrapServices(after).length > 0) {
    return failure("verify-absent", "cleanup-service-still-present", checkpoint);
  }
  return null;
}

async function observeOrCleanup(
  request: RailwayBootstrapLifecycleRequest,
  checkpoint: RailwayBootstrapLifecycleCheckpoint,
): Promise<RailwayBootstrapLifecycleResult> {
  if (!checkpoint.deploymentId) {
    return failure("observe-deployment", "deployment-mismatch", checkpoint);
  }

  let deployment: RailwayBootstrapDeployment;
  try {
    deployment = await request.executor.observeDeployment({ deploymentId: checkpoint.deploymentId });
  } catch {
    return failure("observe-deployment", "executor-failure", checkpoint);
  }
  if (deployment.id !== checkpoint.deploymentId) {
    return failure("observe-deployment", "deployment-mismatch", checkpoint);
  }

  const instanceStatuses = deployment.instances?.map((instance) => instance.status);
  const runtimeFailed = instanceStatuses?.some((status) => (
    status === "CRASHED" || status === "STOPPED" || status === "SKIPPED"
  )) === true;
  if (runtimeFailed) {
    const failed: RailwayBootstrapLifecycleCheckpoint = {
      ...checkpoint,
      failedDeploymentId: deployment.id,
    };
    const persistenceFailure = await persist(request, failed, "observe-deployment");
    if (persistenceFailure) return persistenceFailure;
    const cleanupFailure = await cleanup(request, failed);
    return cleanupFailure ?? failure("observe-deployment", "bootstrap-deployment-failed", failed);
  }

  const runtimeReady = request.handoff === undefined
    ? deployment.deploymentStopped === true
      && instanceStatuses !== undefined
      && instanceStatuses.length > 0
      && instanceStatuses.every((status) => status === "EXITED")
    : deployment.deploymentStopped === false
      && instanceStatuses?.some((status) => status === "RUNNING") === true;

  if (deployment.status === "SUCCESS" && runtimeReady) {
    let succeeded: RailwayBootstrapLifecycleCheckpoint = {
      ...checkpoint,
      successfulDeploymentId: deployment.id,
    };
    const persistenceFailure = await persist(request, succeeded, "checkpoint-success");
    if (persistenceFailure) return persistenceFailure;
    const applied = await applyHandoff(request, succeeded);
    if (isFailure(applied) || "outcome" in applied) return applied;
    succeeded = applied;
    const cleanupFailure = await cleanup(request, succeeded);
    return cleanupFailure ?? { outcome: "complete", checkpoint: succeeded };
  }

  if (TERMINAL_FAILURE_STATUSES.has(deployment.status)) {
    const failed: RailwayBootstrapLifecycleCheckpoint = {
      ...checkpoint,
      failedDeploymentId: deployment.id,
    };
    const persistenceFailure = await persist(request, failed, "observe-deployment");
    if (persistenceFailure) return persistenceFailure;
    const cleanupFailure = await cleanup(request, failed);
    return cleanupFailure ?? failure("observe-deployment", "bootstrap-deployment-failed", failed);
  }

  return { outcome: "pending", stage: "observe-deployment", checkpoint };
}

/**
 * Reconciles only Railway's temporary database bootstrap service. It never
 * creates a project, final service, domain, volume, or receipt store.
 */
export async function runRailwayBootstrapLifecycle(
  request: RailwayBootstrapLifecycleRequest,
): Promise<RailwayBootstrapLifecycleResult> {
  const imageDigest = bootstrapImageDigest(request.target.intent.image);
  if (!imageDigest) {
    return failure("inventory", "invalid-target");
  }
  if (!validHandoffRequest(request)) return failure("inventory", "invalid-handoff");
  let checkpoint = request.checkpoint ?? baseCheckpoint(request.target, imageDigest);
  if (!checkpointMatchesTarget(checkpoint, request.target, imageDigest)) {
    return failure("inventory", "invalid-checkpoint");
  }

  if (checkpoint.failedDeploymentId) {
    const cleanupFailure = await cleanup(request, checkpoint);
    return cleanupFailure ?? failure("observe-deployment", "bootstrap-deployment-failed", checkpoint);
  }

  const services = await inventoryServices(request, checkpoint);
  if (isFailure(services)) return services;
  const knownService = checkpoint.serviceId === undefined
    ? undefined
    : services.find((service) => service.id === checkpoint.serviceId);
  const namedServices = namedBootstrapServices(services);

  if (namedServices.length > 1) {
    return failure("inventory", "ambiguous-service", checkpoint);
  }

  if (checkpoint.successfulDeploymentId) {
    if (knownService !== undefined && knownService.name !== "nautilo-bootstrap") {
      return failure("delete", "checkpoint-service-missing", checkpoint);
    }
    const applied = await applyHandoff(request, checkpoint);
    if (isFailure(applied) || "outcome" in applied) return applied;
    const cleanupFailure = await cleanup(request, applied);
    return cleanupFailure ?? { outcome: "complete", checkpoint: applied };
  }

  if (checkpoint.serviceId !== undefined && knownService === undefined) {
    return failure("inventory", "checkpoint-service-missing", checkpoint);
  }
  if (knownService !== undefined && knownService.name !== "nautilo-bootstrap") {
    return failure("inventory", "checkpoint-service-missing", checkpoint);
  }

  let service = knownService;
  if (service === undefined) {
    service = namedServices[0];
  }
  if (service === undefined) {
    try {
      service = await request.executor.createService({
        projectId: request.target.projectId,
        environmentId: request.target.environmentId,
        name: request.target.intent.serviceName,
      });
    } catch {
      return failure("create", "executor-failure", checkpoint);
    }
    if (service.name !== "nautilo-bootstrap") {
      return failure("create", "checkpoint-service-missing", checkpoint);
    }
  }

  if (checkpoint.serviceId !== service.id) {
    checkpoint = { ...checkpoint, serviceId: service.id };
    const persistenceFailure = await persist(request, checkpoint, "create");
    if (persistenceFailure) return persistenceFailure;
  }

  if (!checkpoint.variablesApplied) {
    try {
      await request.executor.applyServiceVariables({
        projectId: request.target.projectId,
        environmentId: request.target.environmentId,
        serviceId: service.id,
        variables: request.variables,
      });
    } catch {
      return failure("variables", "executor-failure", checkpoint);
    }
    checkpoint = { ...checkpoint, variablesApplied: true };
    const persistenceFailure = await persist(request, checkpoint, "variables");
    if (persistenceFailure) return persistenceFailure;
  }

  if (!checkpoint.deploymentId) {
    let deployments: readonly RailwayBootstrapDeployment[];
    try {
      deployments = await request.executor.inventoryDeployments({
        projectId: request.target.projectId,
        environmentId: request.target.environmentId,
        serviceId: service.id,
      });
    } catch {
      return failure("start-deployment", "executor-failure", checkpoint);
    }
    if (deployments.length > 1) {
      return failure("start-deployment", "ambiguous-deployment", checkpoint);
    }
    if (deployments.length === 1) {
      checkpoint = { ...checkpoint, deploymentId: deployments[0]!.id };
      const persistenceFailure = await persist(request, checkpoint, "start-deployment");
      if (persistenceFailure) return persistenceFailure;
    } else {
      let deployment: RailwayBootstrapDeployment;
      try {
        deployment = await request.executor.startDeployment({
          projectId: request.target.projectId,
          environmentId: request.target.environmentId,
          serviceId: service.id,
          image: request.target.intent.image,
          variables: request.variables,
        });
      } catch {
        return failure("start-deployment", "executor-failure", checkpoint);
      }
      checkpoint = { ...checkpoint, deploymentId: deployment.id };
      const persistenceFailure = await persist(request, checkpoint, "start-deployment");
      if (persistenceFailure) return persistenceFailure;
    }
  }
  const domainCheckpoint = await ensureHandoffDomain(request, checkpoint);
  if (isFailure(domainCheckpoint)) return domainCheckpoint;
  return observeOrCleanup(request, domainCheckpoint);
}
