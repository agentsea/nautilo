import {
  parseLaunchReceipt,
  type LaunchReceipt,
  type SignedReleaseManifest,
} from "@nautilo/hosting";
import {
  RailwayGraphqlBootstrapExecutor,
  RailwayGraphqlReconcileExecutor,
  RAILWAY_LOGTO_BOOTSTRAP_PORT,
  isRailwayDestroyCheckpoint,
  reconcileRailwayResources,
  runRailwayBootstrapLifecycle,
  runRailwayDeploymentWorkflow,
  runRailwayTemplateAdoptionRelease,
  isRailwayTemplateAdoptionReleaseCheckpoint,
  type RailwayBootstrapLifecycleCheckpoint,
  type RailwayBootstrapLifecycleResult,
  type RailwayBootstrapHandoffOutput,
  type RailwayDeploymentWorkflowCheckpoint,
  type RailwayDesiredStateTarget,
  type RailwayDestroyCheckpoint,
  type RailwayReconcileCheckpoint,
  type RailwayReconcileEffectKind,
  type RailwayReconcileResult,
  type RailwayReconcileDesiredState,
  type RailwayReconcileExecutorTransport,
  type RailwayDeployment,
  type RailwayTopology,
  type RailwayVariableProjectionInputs,
  type RailwayWorkflowStepResult,
  type RailwayTemplateAdoptionReleaseCheckpoint,
  type RailwayTemplateAdoptionReleasedService,
} from "@nautilo/railway-hosting";

import { RAILWAY_RUNTIME_PROVIDERS } from "./host-provider-config";

export const RAILWAY_DEPLOYMENT_DRIVER_STATE_SCHEMA_VERSION = 1 as const;

export type RailwayLaunchLifecycle =
  | { readonly state: "owner-bound"; readonly updatedAt: string }
  | { readonly state: "active"; readonly updatedAt: string; readonly maintenanceId?: string | undefined }
  | { readonly state: "superseded"; readonly updatedAt: string; readonly supersededByLaunchId: string; readonly maintenanceId: string }
  | { readonly state: "destroyed"; readonly updatedAt: string };

export interface RailwayDeploymentDriverState {
  readonly schemaVersion: typeof RAILWAY_DEPLOYMENT_DRIVER_STATE_SCHEMA_VERSION;
  readonly launchId: string;
  readonly releaseId: string;
  readonly releaseManifest?: SignedReleaseManifest | undefined;
  readonly providers: readonly string[];
  readonly target: RailwayDesiredStateTarget;
  readonly reconcile: RailwayReconcileCheckpoint;
  readonly workflow?: RailwayDeploymentWorkflowCheckpoint | undefined;
  readonly databaseBootstrap?: RailwayBootstrapLifecycleCheckpoint | undefined;
  readonly logtoBootstrap?: RailwayBootstrapLifecycleCheckpoint | undefined;
  readonly templateAdoption?: RailwayTemplateAdoptionDriverCheckpoint | undefined;
  readonly destroy?: RailwayDestroyCheckpoint | undefined;
  readonly lifecycle?: RailwayLaunchLifecycle | undefined;
}

export interface RailwayTemplateAdoptionDriverCheckpoint {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly setupImage?: string | undefined;
  readonly heldDeploymentIds: Readonly<Record<RailwayTemplateAdoptionReleasedService, string>>;
  readonly releases: Partial<Readonly<Record<RailwayTemplateAdoptionReleasedService, RailwayTemplateAdoptionReleaseCheckpoint>>>;
}

export type RailwayDeploymentDriverResult =
  | { readonly outcome: "complete"; readonly state: RailwayDeploymentDriverState }
  | { readonly outcome: "pending"; readonly state: RailwayDeploymentDriverState }
  | { readonly outcome: "failure"; readonly state: RailwayDeploymentDriverState; readonly failureCode: string };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RUNTIME_PROVIDER_SET = new Set<string>(RAILWAY_RUNTIME_PROVIDERS);
const TERMINAL_FAILURES = new Set(["CRASHED", "FAILED", "REMOVED", "SKIPPED"]);
const FORBIDDEN_STATE_KEY = /(?:token|secret|password|credential|authorization|variables?|environment-map)/i;
const SECRET_LIKE_STATE_VALUE = /^(?:sk|pk|rk|gsk|tvly|xi|dop|railway)[_-][A-Za-z0-9_-]{8,}$/i;
const RECONCILE_PENDING_KINDS = new Set<string>([
  "project-create",
  "environment-create",
  "service-create",
  "volume-create",
  "variables-upsert",
  "service-connect",
  "domain-create",
  "deployment-create",
] satisfies readonly RailwayReconcileEffectKind[]);
const DIGEST_IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?@sha256:[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function validLifecycle(value: unknown): value is RailwayLaunchLifecycle {
  if (!record(value) || !validTimestamp(value["updatedAt"])) return false;
  const state = value["state"];
  if (state === "owner-bound" || state === "destroyed") return Object.keys(value).length === 2;
  if (state === "active") return Object.keys(value).every((key) => ["state", "updatedAt", "maintenanceId"].includes(key))
    && (value["maintenanceId"] === undefined || typeof value["maintenanceId"] === "string" && SAFE_ID.test(value["maintenanceId"]));
  return state === "superseded" && Object.keys(value).length === 4
    && typeof value["supersededByLaunchId"] === "string" && SAFE_ID.test(value["supersededByLaunchId"])
    && typeof value["maintenanceId"] === "string" && SAFE_ID.test(value["maintenanceId"]);
}

function containsSecretMaterial(value: unknown): boolean {
  if (typeof value === "string") return SECRET_LIKE_STATE_VALUE.test(value);
  if (Array.isArray(value)) return value.some(containsSecretMaterial);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, entry]) => (
    (FORBIDDEN_STATE_KEY.test(key) && !(key === "variablesApplied" && entry === true))
    || containsSecretMaterial(entry)
  ));
}

function validTemplateAdoption(value: unknown, state: Record<string, unknown>, receipt: LaunchReceipt): value is RailwayTemplateAdoptionDriverCheckpoint {
  if (!record(value) || Object.keys(value).sort().join("\0") !== ["heldDeploymentIds", "releaseId", "releases", "schemaVersion",
    ...(value["setupImage"] === undefined ? [] : ["setupImage"])].sort().join("\0")
    || value["schemaVersion"] !== 1 || value["releaseId"] !== state["releaseId"]
    || !record(value["heldDeploymentIds"]) || !record(value["releases"])) return false;
  if (value["setupImage"] !== undefined && (typeof value["setupImage"] !== "string" || !digestImageReference(value["setupImage"]))) return false;
  const services = ["logto-seed", "logto", "nautilo-server"] as const;
  if (Object.keys(value["heldDeploymentIds"]).sort().join("\0") !== [...services].sort().join("\0")
    || Object.keys(value["releases"]).some((key) => !services.includes(key as RailwayTemplateAdoptionReleasedService))) return false;
  const held = value["heldDeploymentIds"];
  const releases = value["releases"];
  for (const service of services) {
    const id = held[service];
    const receiptId = receipt.resources.find((entry) => entry.kind === "railway.deployment" && entry.name === service)?.id;
    const release = releases[service];
    const releasedId = record(release) && release["state"] === "complete" ? release["deploymentId"] : undefined;
    if (typeof id !== "string" || !SAFE_ID.test(id) || (receiptId !== id && receiptId !== releasedId)) return false;
    if (release !== undefined && (!isRailwayTemplateAdoptionReleaseCheckpoint(release)
      || release.service !== service
      || release.releaseId !== value["releaseId"]
      || release.heldDeploymentId !== id)) return false;
  }
  const stage = record(state["workflow"]) ? state["workflow"]["stage"] : undefined;
  const stageName = typeof stage === "string" ? stage : "";
  const stageOrder = [
    "databases", "database-bootstrap", "logto-seed", "logto-seed-ready", "public-scaffold",
    "logto-core", "logto-core-ready", "logto-bootstrap", "server-ready", "complete",
  ] as const;
  const stageIndex = stageOrder.findIndex((candidate) => candidate === stageName);
  const releaseStage: Readonly<Record<RailwayTemplateAdoptionReleasedService, typeof stageOrder[number]>> = {
    "logto-seed": "logto-seed",
    logto: "logto-core",
    "nautilo-server": "logto-bootstrap",
  };
  for (const service of services) {
    if (releases[service] !== undefined && stageIndex < stageOrder.indexOf(releaseStage[service])) return false;
  }
  const complete = (service: RailwayTemplateAdoptionReleasedService) => (
    isRailwayTemplateAdoptionReleaseCheckpoint(releases[service]) && releases[service].state === "complete"
  );
  if (["logto-seed-ready", "public-scaffold", "logto-core", "logto-core-ready", "logto-bootstrap", "server-ready", "complete"].includes(stageName)
    && !complete("logto-seed")) return false;
  if (["logto-core-ready", "logto-bootstrap", "server-ready", "complete"].includes(stageName) && !complete("logto")) return false;
  return !(["server-ready", "complete"].includes(stageName) && !complete("nautilo-server"));
}

function digestImageReference(value: string): boolean {
  if (!DIGEST_IMAGE_REFERENCE.test(value)) return false;
  const repository = value.slice(0, value.indexOf("@"));
  return !repository.slice(repository.lastIndexOf("/") + 1).includes(":");
}

/**
 * Persisted state is an untrusted resume input. Keep its before-effect marker
 * structurally identical to RailwayReconcilePendingEffect so a hand-edited
 * receipt cannot smuggle a private-registry field back into the controller.
 */
function validReconcilePendingEffect(value: unknown): boolean {
  if (!record(value)
    || Object.keys(value).some((key) => key !== "kind" && key !== "logicalName" && key !== "image" && key !== "attempt")
    || typeof value["kind"] !== "string"
    || !RECONCILE_PENDING_KINDS.has(value["kind"])
    || typeof value["logicalName"] !== "string"
    || value["logicalName"].length === 0) {
    return false;
  }
  const image = value["image"];
  const attempt = value["attempt"];
  if (value["kind"] === "project-create") {
    return image === undefined && (attempt === undefined || attempt === 1 || attempt === 2);
  }
  if (attempt !== undefined) return false;
  if (value["kind"] !== "service-connect") return image === undefined;
  return typeof image === "string" && digestImageReference(image);
}

export function classifyRailwayServiceReadiness(
  service: "app-postgres" | "logto-postgres" | "logto-seed" | "logto" | "nautilo-server",
  deployment: RailwayDeployment,
): RailwayWorkflowStepResult {
  if (TERMINAL_FAILURES.has(deployment.status)) return { outcome: "failure", code: "railway.readiness.failed" };
  if (deployment.status !== "SUCCESS"
    || deployment.deploymentStopped === undefined
    || deployment.instances === undefined
    || deployment.instances.length === 0) {
    return { outcome: "pending" };
  }
  const statuses = deployment.instances.map((instance) => instance.status);
  if (service === "logto-seed") {
    if (statuses.some((status) => status === "CRASHED" || status === "STOPPED" || status === "SKIPPED")) {
      return { outcome: "failure", code: "railway.readiness.failed" };
    }
    return deployment.deploymentStopped && statuses.every((status) => status === "EXITED")
      ? { outcome: "complete" }
      : { outcome: "pending" };
  }
  if (deployment.deploymentStopped
    || statuses.some((status) => status === "CRASHED" || status === "EXITED" || status === "STOPPED" || status === "SKIPPED")) {
    return { outcome: "failure", code: "railway.readiness.failed" };
  }
  return statuses.some((status) => status === "RUNNING")
    ? { outcome: "complete" }
    : { outcome: "pending" };
}

/**
 * An uncertain Railway mutation is resumable only when its durable before-
 * effect marker survives. The next pass inventories before it mutates, so it
 * may adopt the provider result without duplicating it.
 */
export function classifyRailwayReconcileStepResult(
  result: RailwayReconcileResult,
): RailwayWorkflowStepResult {
  if (result.outcome === "complete") return { outcome: "complete" };
  return result.code === "executor-failure" && result.checkpoint.pending !== undefined
    ? { outcome: "pending" }
    : { outcome: "failure", code: `railway.reconcile.${result.stage}.${result.code}` };
}

/**
 * Bootstrap image attachment has a unique checkpointed service identity.
 * A lost start response is therefore resumable: inventory that exact service
 * before any retry, then adopt its sole deployment if Railway accepted it.
 */
export function classifyRailwayBootstrapStepResult(
  result: RailwayBootstrapLifecycleResult,
): RailwayWorkflowStepResult {
  if (result.outcome === "complete" || result.outcome === "pending") {
    return { outcome: result.outcome };
  }
  return result.code === "executor-failure"
    && result.stage === "start-deployment"
    && result.checkpoint?.serviceId !== undefined
    && result.checkpoint.variablesApplied === true
    && result.checkpoint.deploymentId === undefined
    ? { outcome: "pending" }
    : { outcome: "failure", code: `railway.bootstrap.${result.stage}.${result.code}` };
}

/** Adds only exact provider IDs already checkpointed by the transient lifecycle. */
export function mergeRailwayBootstrapCleanupResources(
  receipt: LaunchReceipt,
  state: Pick<RailwayDeploymentDriverState, "databaseBootstrap" | "logtoBootstrap">,
): LaunchReceipt {
  const bootstrap = state.logtoBootstrap?.serviceId === undefined
    ? state.databaseBootstrap
    : state.logtoBootstrap;
  if (bootstrap?.serviceId === undefined) return receipt;
  const additions = [
    { kind: "railway.service", id: bootstrap.serviceId, name: "nautilo-bootstrap" },
    ...(bootstrap.handoffDomainId === undefined
      ? []
      : [{ kind: "railway.domain", id: bootstrap.handoffDomainId, name: "nautilo-bootstrap-handoff" }]),
  ];
  return {
    ...receipt,
    resources: [
      ...receipt.resources,
      ...additions.filter((addition) => !receipt.resources.some((resource) => (
        resource.kind === addition.kind && resource.id === addition.id
      ))),
    ],
  };
}

/** Strict outer validation; package coordinators revalidate every nested checkpoint before effects. */
export function parseRailwayDeploymentDriverState(value: unknown): RailwayDeploymentDriverState {
  if (!record(value) || containsSecretMaterial(value)
    || Object.keys(value).some((key) => ![
      "schemaVersion", "launchId", "releaseId", "providers", "target", "reconcile", "workflow",
      "databaseBootstrap", "logtoBootstrap", "destroy", "lifecycle",
      "templateAdoption", "releaseManifest",
    ].includes(key))
    || value["schemaVersion"] !== RAILWAY_DEPLOYMENT_DRIVER_STATE_SCHEMA_VERSION
    || typeof value["launchId"] !== "string" || !SAFE_ID.test(value["launchId"])
    || typeof value["releaseId"] !== "string" || !SAFE_ID.test(value["releaseId"])
    || !Array.isArray(value["providers"])
    || value["providers"].some((provider) => typeof provider !== "string" || !RUNTIME_PROVIDER_SET.has(provider))
    || new Set(value["providers"]).size !== value["providers"].length
    || !record(value["target"]) || !record(value["reconcile"])
    || (value["lifecycle"] !== undefined && !validLifecycle(value["lifecycle"]))) {
    throw new Error("Invalid Railway deployment state");
  }
  const target = value["target"];
  const releaseManifest = value["releaseManifest"];
  // Structural admission only. Host resume re-verifies the original signature before effects.
  if (releaseManifest !== undefined && (!record(releaseManifest) || !record(releaseManifest["manifest"])
    || releaseManifest["manifest"]["releaseId"] !== value["releaseId"] || !record(releaseManifest["signature"]))) {
    throw new Error("Invalid Railway deployment state");
  }
  if (Object.keys(target).sort().join("\0") !== ["workspaceId", "projectName", "environmentName"].sort().join("\0")
    || [target["workspaceId"], target["projectName"], target["environmentName"]]
      .some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("Invalid Railway deployment state");
  }
  const reconcile = value["reconcile"];
  if (Object.keys(reconcile).some((key) => key !== "receipt" && key !== "pending")) {
    throw new Error("Invalid Railway deployment state");
  }
  if (reconcile["pending"] !== undefined && !validReconcilePendingEffect(reconcile["pending"])) {
    throw new Error("Invalid Railway deployment state");
  }
  const parsedReceipt = parseLaunchReceipt(reconcile["receipt"]);
  if (!parsedReceipt.ok || parsedReceipt.receipt.backend !== "railway"
    || parsedReceipt.receipt.launchId !== value["launchId"]
    || parsedReceipt.receipt.stage === "planned") {
    throw new Error("Invalid Railway deployment state");
  }
  const verifiedDestroy = parsedReceipt.receipt.cleanup.state === "verified"
    && parsedReceipt.receipt.resources.length === 0
    && isRailwayDestroyCheckpoint(value["destroy"], parsedReceipt.receipt)
    && value["destroy"].receipt.cleanup.state === "verified";
  if (value["templateAdoption"] !== undefined && !verifiedDestroy
    && !validTemplateAdoption(value["templateAdoption"], value, parsedReceipt.receipt)) {
    throw new Error("Invalid Railway deployment state");
  }
  const lifecycle = value["lifecycle"];
  if (lifecycle !== undefined) {
    const destroyed = lifecycle.state === "destroyed";
    if (destroyed) {
      if (!isRailwayDestroyCheckpoint(value["destroy"], parsedReceipt.receipt)
        || value["destroy"].receipt.cleanup.state !== "verified") throw new Error("Invalid Railway deployment state");
    } else if (parsedReceipt.receipt.stage !== "claimable") {
      throw new Error("Invalid Railway deployment state");
    }
    if (lifecycle.state === "superseded" && lifecycle.supersededByLaunchId === value["launchId"]) {
      throw new Error("Invalid Railway deployment state");
    }
    const workflow = value["workflow"];
    if ((lifecycle.state === "owner-bound" || lifecycle.state === "active" && lifecycle.maintenanceId === undefined)
      && (!record(workflow) || workflow["stage"] !== "complete")) throw new Error("Invalid Railway deployment state");
  }
  return value as unknown as RailwayDeploymentDriverState;
}

export function createRailwayDeploymentDriverState(input: {
  readonly launchId: string;
  readonly releaseId: string;
  readonly releaseManifest?: SignedReleaseManifest | undefined;
  readonly providers: readonly string[];
  readonly target: RailwayDesiredStateTarget;
  readonly now: string;
}): RailwayDeploymentDriverState {
  if (!SAFE_ID.test(input.launchId) || !SAFE_ID.test(input.releaseId)
    || input.providers.some((provider) => !RUNTIME_PROVIDER_SET.has(provider))) {
    throw new Error("Invalid Railway deployment state");
  }
  const receipt: LaunchReceipt = {
    schemaVersion: 1,
    launchId: input.launchId,
    backend: "railway",
    revision: 1,
    stage: "authorized",
    resources: [],
    cleanup: { state: "not-required" },
    createdAt: input.now,
    updatedAt: input.now,
  };
  return parseRailwayDeploymentDriverState({
    schemaVersion: RAILWAY_DEPLOYMENT_DRIVER_STATE_SCHEMA_VERSION,
    launchId: input.launchId,
    releaseId: input.releaseId,
    ...(input.releaseManifest === undefined ? {} : { releaseManifest: input.releaseManifest }),
    providers: [...input.providers].sort(),
    target: input.target,
    reconcile: { receipt },
  });
}

function resourceId(state: RailwayDeploymentDriverState, kind: string, name?: string): string | undefined {
  return state.reconcile.receipt.resources.find((resource) => (
    resource.kind === kind && (name === undefined || resource.name === name)
  ))?.id;
}

/** The public bootstrap handoff is not applied until its secret output has durable launch custody. */
export async function applyRailwayLogtoBootstrapOutput(input: {
  readonly state: RailwayDeploymentDriverState;
  readonly output: RailwayBootstrapHandoffOutput;
  readonly persistOutput?: ((input: {
    readonly state: RailwayDeploymentDriverState;
    readonly output: RailwayBootstrapHandoffOutput;
  }) => Promise<void>) | undefined;
  readonly applyOutput: (output: RailwayBootstrapHandoffOutput) => Promise<void>;
}): Promise<void> {
  await input.persistOutput?.({ state: input.state, output: input.output });
  await input.applyOutput(input.output);
}

export async function runRailwayDeploymentDriver(input: {
  readonly state: RailwayDeploymentDriverState;
  readonly topology: RailwayTopology;
  readonly projectionInputs: RailwayVariableProjectionInputs;
  readonly transport: RailwayReconcileExecutorTransport;
  readonly persistState: (state: RailwayDeploymentDriverState) => Promise<void>;
  readonly now: () => string;
  /** Request-memory output is committed to launch-bound credential custody before handoff completion. */
  readonly persistLogtoBootstrapOutput?: ((input: {
    readonly state: RailwayDeploymentDriverState;
    readonly output: RailwayBootstrapHandoffOutput;
  }) => Promise<void>) | undefined;
  /** Observation only: runs after the durable checkpoint write succeeds. */
  readonly onWorkflowStageTransition?: (input: {
    readonly previous?: RailwayDeploymentWorkflowCheckpoint["stage"] | undefined;
    readonly next: RailwayDeploymentWorkflowCheckpoint["stage"];
  }) => void;
}): Promise<RailwayDeploymentDriverResult> {
  let state = parseRailwayDeploymentDriverState(input.state);
  if (state.releaseId !== input.topology.releaseId) return { outcome: "failure", state, failureCode: "railway.driver.release-drift" };
  if (state.templateAdoption?.setupImage !== undefined
    && state.templateAdoption.setupImage !== input.topology.finalServices.find(({ name }) => name === "logto")?.image) {
    return { outcome: "failure", state, failureCode: "railway.driver.release-drift" };
  }
  const executorOptions = { transport: input.transport };
  const resources = new RailwayGraphqlReconcileExecutor(executorOptions);
  const bootstrap = new RailwayGraphqlBootstrapExecutor(executorOptions);

  const persist = async (next: RailwayDeploymentDriverState): Promise<void> => {
    const previousWorkflowStage = state.workflow?.stage;
    const validated = parseRailwayDeploymentDriverState(next);
    await input.persistState(validated);
    state = validated;
    if (validated.workflow?.stage !== undefined && validated.workflow.stage !== previousWorkflowStage) {
      try {
        input.onWorkflowStageTransition?.({ previous: previousWorkflowStage, next: validated.workflow.stage });
      } catch {
        // Progress rendering is never allowed to alter a durable reconcile.
      }
    }
  };

  const reconcile = async (desired: RailwayReconcileDesiredState): Promise<RailwayWorkflowStepResult> => {
    if (state.templateAdoption !== undefined) {
      const structureOnly: RailwayReconcileDesiredState = {
        ...desired,
        services: desired.services.map(({ name, variables }) => ({ name, variables, deploy: false })),
      };
      const prepared = await reconcileRailwayResources({
        desired: structureOnly,
        checkpoint: state.reconcile,
        executor: resources,
        now: input.now,
        persistCheckpoint: (checkpoint) => persist({ ...state, reconcile: checkpoint }),
      });
      const preparedResult = classifyRailwayReconcileStepResult(prepared);
      if (preparedResult.outcome !== "complete") return preparedResult;
      const projectId = resourceId(state, "railway.project");
      const environmentId = resourceId(state, "railway.environment");
      if (projectId === undefined || environmentId === undefined) return { outcome: "failure", code: "railway.template-adoption.failed" };
      for (const intent of desired.services) {
        if (intent.name !== "logto-seed" && intent.name !== "logto" && intent.name !== "nautilo-server") continue;
        if (intent.image === undefined || intent.deploy !== true) continue;
        const serviceId = resourceId(state, "railway.service", intent.name);
        if (serviceId === undefined) return { outcome: "failure", code: "railway.template-adoption.failed" };
        const result = await runRailwayTemplateAdoptionRelease({
          binding: {
            releaseId: state.releaseId,
            projectId,
            environmentId,
            serviceId,
            service: intent.name,
            image: intent.image,
            ...(intent.name !== "nautilo-server" || state.templateAdoption.setupImage === undefined
              ? {} : { setupImage: state.templateAdoption.setupImage }),
            heldDeploymentId: state.templateAdoption.heldDeploymentIds[intent.name],
          },
          checkpoint: state.templateAdoption.releases[intent.name],
          executor: resources,
          persistCheckpoint: (release) => persist({
            ...state,
            templateAdoption: {
              ...state.templateAdoption!,
              releases: { ...state.templateAdoption!.releases, [intent.name]: release },
            },
          }),
        });
        if (result.outcome === "pending") return { outcome: "pending" };
        if (result.outcome === "failure") return { outcome: "failure", code: "railway.template-adoption.failed" };
        const recorded = resourceId(state, "railway.deployment", intent.name);
        if (recorded !== result.deploymentId) {
          const now = input.now();
          await persist({
            ...state,
            reconcile: {
              receipt: {
                ...state.reconcile.receipt,
                revision: state.reconcile.receipt.revision + 1,
                updatedAt: now,
                resources: state.reconcile.receipt.resources.map((entry) => (
                  entry.kind === "railway.deployment" && entry.name === intent.name
                    ? { ...entry, id: result.deploymentId }
                    : entry
                )),
              },
            },
          });
        }
      }
    }
    const result = await reconcileRailwayResources({
      desired,
      checkpoint: state.reconcile,
      executor: resources,
      now: input.now,
      persistCheckpoint: (checkpoint) => persist({ ...state, reconcile: checkpoint }),
    });
    return classifyRailwayReconcileStepResult(result);
  };

  const bootstrapTarget = () => {
    const projectId = resourceId(state, "railway.project");
    const environmentId = resourceId(state, "railway.environment");
    return projectId === undefined || environmentId === undefined ? undefined : { projectId, environmentId };
  };

  const runBootstrap = async (
    kind: "database" | "logto",
    variables: Readonly<Record<string, string>>,
    handoff?: {
      readonly token: string;
      readonly applyOutput: (output: RailwayBootstrapHandoffOutput) => Promise<void>;
    },
  ): Promise<RailwayWorkflowStepResult> => {
    const target = bootstrapTarget();
    if (target === undefined) return { outcome: "failure", code: "railway.bootstrap.inventory.invalid-target" };
    const checkpoint = kind === "database" ? state.databaseBootstrap : state.logtoBootstrap;
    const result = await runRailwayBootstrapLifecycle({
      target: {
        ...target,
        intent: kind === "database" ? input.topology.transientBootstrap : input.topology.transientLogtoBootstrap,
      },
      variables,
      checkpoint,
      executor: bootstrap,
      persistCheckpoint: (next) => persist({
        ...state,
        ...(kind === "database" ? { databaseBootstrap: next } : { logtoBootstrap: next }),
      }),
      ...(handoff === undefined ? {} : { handoff: { ...handoff, targetPort: RAILWAY_LOGTO_BOOTSTRAP_PORT } }),
    });
    return classifyRailwayBootstrapStepResult(result);
  };

  const result = await runRailwayDeploymentWorkflow({
    topology: input.topology,
    projectionInputs: input.projectionInputs,
    target: state.target,
    checkpoint: state.workflow,
    persistCheckpoint: (workflow) => persist({ ...state, workflow }),
    executor: {
      reconcile,
      runDatabaseBootstrap: (variables) => runBootstrap("database", variables),
      waitForService: async (service) => {
        const deploymentId = resourceId(state, "railway.deployment", service);
        if (deploymentId === undefined) return { outcome: "failure", code: "railway.readiness.failed" };
        try {
          const deployment = await resources.getDeployment({ deploymentId });
          return classifyRailwayServiceReadiness(service, deployment);
        } catch {
          return { outcome: "failure", code: "railway.readiness.failed" };
        }
      },
      runLogtoBootstrap: ({ variables, token, applyOutput }) => runBootstrap(
        "logto",
        variables,
        { token, applyOutput: (output) => applyRailwayLogtoBootstrapOutput({
          state,
          output,
          persistOutput: input.persistLogtoBootstrapOutput,
          applyOutput,
        }) },
      ),
    },
  });
  if (result.outcome === "complete") {
    if (state.reconcile.receipt.stage === "provisioning") {
      const now = input.now();
      await persist({
        ...state,
        reconcile: {
          receipt: {
            ...state.reconcile.receipt,
            revision: state.reconcile.receipt.revision + 1,
            stage: "bootstrapping",
            updatedAt: now,
          },
        },
      });
    }
    if (state.reconcile.receipt.stage === "bootstrapping") {
      const now = input.now();
      await persist({
        ...state,
        reconcile: {
          receipt: {
            ...state.reconcile.receipt,
            revision: state.reconcile.receipt.revision + 1,
            stage: "claimable",
            updatedAt: now,
            claimableAt: now,
          },
        },
      });
    }
  }
  return result.outcome === "failure"
    ? { outcome: "failure", state, failureCode: result.stepCode ?? `railway.workflow.${result.code}` }
    : { outcome: result.outcome, state };
}
