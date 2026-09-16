import type { RailwayDeployment, RailwayServiceInstance } from "./operations";
import {
  RAILWAY_LOGTO_HOLD_COMMAND,
  RAILWAY_LOGTO_SEED_HOLD_COMMAND,
  RAILWAY_NAUTILO_HOLD_COMMAND,
  RAILWAY_NAUTILO_SETUP_HOLD_COMMAND,
} from "./template-held-scaffold";

export const RAILWAY_TEMPLATE_ADOPTION_RELEASE_SCHEMA_VERSION = 1 as const;

export type RailwayTemplateAdoptionReleasedService = "logto-seed" | "logto" | "nautilo-server";

interface RailwayTemplateAdoptionReleaseIdentity {
  readonly schemaVersion: typeof RAILWAY_TEMPLATE_ADOPTION_RELEASE_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly service: RailwayTemplateAdoptionReleasedService;
  readonly image: string;
  readonly setupImage?: string | undefined;
  readonly heldDeploymentId: string;
}

export type RailwayTemplateAdoptionReleaseCheckpoint = RailwayTemplateAdoptionReleaseIdentity & (
  | { readonly state: "source-pending" }
  | { readonly state: "command-pending" }
  | { readonly state: "command-applied" }
  | { readonly state: "start-pending"; readonly baselineDeploymentIds: readonly string[] }
  | { readonly state: "started"; readonly deploymentId: string }
  | { readonly state: "complete"; readonly deploymentId: string }
);

export interface RailwayTemplateAdoptionReleaseExecutor {
  getServiceInstance(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayServiceInstance | null>;
  updateServiceSource?(input: { readonly serviceId: string; readonly environmentId: string; readonly image: string }): Promise<RailwayServiceInstance>;
  setServiceStartCommand(input: { readonly serviceId: string; readonly environmentId: string; readonly startCommand: string | null }): Promise<void>;
  listDeploymentsRaw(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }): Promise<readonly RailwayDeployment[]>;
  createDeployment(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayDeployment>;
  getDeployment(input: { readonly deploymentId: string }): Promise<RailwayDeployment>;
}

export type RailwayTemplateAdoptionReleaseResult =
  | { readonly outcome: "complete"; readonly checkpoint: RailwayTemplateAdoptionReleaseCheckpoint; readonly deploymentId: string }
  | { readonly outcome: "pending"; readonly checkpoint: RailwayTemplateAdoptionReleaseCheckpoint }
  | { readonly outcome: "failure"; readonly checkpoint?: RailwayTemplateAdoptionReleaseCheckpoint | undefined; readonly code: "invalid-binding" | "invalid-checkpoint" | "identity-mismatch" | "ambiguous-start" | "deployment-failed" | "executor-failure" | "persistence-failure" };

export interface RailwayTemplateAdoptionReleaseBinding {
  readonly releaseId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly service: RailwayTemplateAdoptionReleasedService;
  readonly image: string;
  /** Present only for the server's held setup image; old receipts keep their original path. */
  readonly setupImage?: string | undefined;
  readonly heldDeploymentId: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?@sha256:[a-f0-9]{64}$/;
const MAX_DEPLOYMENTS = 256;
const FAILED_DEPLOYMENTS = new Set(["CRASHED", "FAILED", "REMOVED", "SKIPPED"]);
const FAILED_INSTANCES = new Set(["CRASHED", "REMOVED", "SKIPPED", "STOPPED"]);

const COMMANDS = {
  "logto-seed": { held: RAILWAY_LOGTO_SEED_HOLD_COMMAND, target: "npm run cli db seed -- --swe" },
  logto: { held: RAILWAY_LOGTO_HOLD_COMMAND, target: null },
  "nautilo-server": { held: RAILWAY_NAUTILO_HOLD_COMMAND, target: null },
} as const;

function imageValid(value: string): boolean {
  if (!IMAGE.test(value)) return false;
  return !value.slice(0, value.indexOf("@")).slice(value.lastIndexOf("/") + 1).includes(":");
}

function bindingValid(binding: RailwayTemplateAdoptionReleaseBinding): boolean {
  return [binding.releaseId, binding.projectId, binding.environmentId, binding.serviceId, binding.heldDeploymentId]
    .every((value) => SAFE_ID.test(value))
    && (binding.service === "logto-seed" || binding.service === "logto" || binding.service === "nautilo-server")
    && imageValid(binding.image)
    && (binding.setupImage === undefined || binding.service === "nautilo-server"
      && imageValid(binding.setupImage) && binding.setupImage !== binding.image);
}

function baselineValid(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_DEPLOYMENTS
    && value.every((entry): entry is string => typeof entry === "string" && SAFE_ID.test(entry))
    && new Set(value).size === value.length
    && value.every((entry, index) => index === 0 || value[index - 1]! < entry);
}

export function isRailwayTemplateAdoptionReleaseCheckpoint(
  value: unknown,
  binding?: RailwayTemplateAdoptionReleaseBinding,
): value is RailwayTemplateAdoptionReleaseCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  const state = checkpoint["state"];
  if (state !== "source-pending" && state !== "command-pending" && state !== "command-applied" && state !== "start-pending"
    && state !== "started" && state !== "complete") return false;
  const extra = state === "start-pending" ? ["baselineDeploymentIds"]
    : state === "started" || state === "complete" ? ["deploymentId"] : [];
  const keys = ["schemaVersion", "releaseId", "projectId", "environmentId", "serviceId", "service", "image", "heldDeploymentId", "state", ...extra,
    ...(checkpoint["setupImage"] === undefined ? [] : ["setupImage"])].sort();
  const actual = Object.keys(checkpoint).sort();
  if (keys.length !== actual.length || !keys.every((key, index) => key === actual[index])) return false;
  const candidate = checkpoint as unknown as RailwayTemplateAdoptionReleaseCheckpoint;
  if (candidate.schemaVersion !== 1 || !bindingValid(candidate)
    || state === "source-pending" && candidate.setupImage === undefined) return false;
  if (state === "start-pending" && !baselineValid(checkpoint["baselineDeploymentIds"])) return false;
  if ((state === "started" || state === "complete")
    && (typeof checkpoint["deploymentId"] !== "string" || !SAFE_ID.test(checkpoint["deploymentId"])
      || checkpoint["deploymentId"] === checkpoint["heldDeploymentId"])) return false;
  return binding === undefined || ["releaseId", "projectId", "environmentId", "serviceId", "service", "image", "setupImage", "heldDeploymentId"]
    .every((key) => candidate[key as keyof RailwayTemplateAdoptionReleaseIdentity] === binding[key as keyof RailwayTemplateAdoptionReleaseBinding]);
}

function identity(binding: RailwayTemplateAdoptionReleaseBinding): RailwayTemplateAdoptionReleaseIdentity {
  return { schemaVersion: 1, ...binding };
}

function exactSource(instance: RailwayServiceInstance | null, binding: RailwayTemplateAdoptionReleaseBinding): boolean {
  return instance !== null && instance.serviceId === binding.serviceId && instance.environmentId === binding.environmentId
    && instance.source?.image === binding.image && (instance.source.repo ?? null) === null;
}

function command(instance: RailwayServiceInstance | null): string | null | undefined {
  return instance?.startCommand;
}

function deploymentComplete(service: RailwayTemplateAdoptionReleasedService, deployment: RailwayDeployment): boolean {
  if (deployment.status !== "SUCCESS" || deployment.instances === undefined || deployment.instances.length === 0) return false;
  if (service === "logto-seed") {
    return deployment.deploymentStopped === true && deployment.instances.every(({ status }) => status === "EXITED");
  }
  return deployment.deploymentStopped === false && deployment.instances.every(({ status }) => status === "RUNNING");
}

function deploymentFailed(service: RailwayTemplateAdoptionReleasedService, deployment: RailwayDeployment): boolean {
  return FAILED_DEPLOYMENTS.has(deployment.status)
    || deployment.instances?.some(({ status }) => FAILED_INSTANCES.has(status)
      || service !== "logto-seed" && status === "EXITED") === true
    || service !== "logto-seed" && deployment.status === "SUCCESS" && deployment.deploymentStopped === true;
}

export async function runRailwayTemplateAdoptionRelease(input: {
  readonly binding: RailwayTemplateAdoptionReleaseBinding;
  readonly checkpoint?: RailwayTemplateAdoptionReleaseCheckpoint | undefined;
  readonly executor: RailwayTemplateAdoptionReleaseExecutor;
  readonly persistCheckpoint: (checkpoint: RailwayTemplateAdoptionReleaseCheckpoint) => Promise<void>;
}): Promise<RailwayTemplateAdoptionReleaseResult> {
  const binding = Object.freeze({ ...input.binding });
  if (!bindingValid(binding)) return { outcome: "failure", code: "invalid-binding" };
  let checkpoint = input.checkpoint;
  if (checkpoint !== undefined && !isRailwayTemplateAdoptionReleaseCheckpoint(checkpoint, binding)) {
    return { outcome: "failure", code: "invalid-checkpoint", checkpoint };
  }
  const persist = async (next: RailwayTemplateAdoptionReleaseCheckpoint): Promise<boolean> => {
    try {
      await input.persistCheckpoint(next);
      checkpoint = next;
      return true;
    } catch {
      return false;
    }
  };
  const instance = async (): Promise<RailwayServiceInstance | null | undefined> => {
    try { return await input.executor.getServiceInstance({ serviceId: binding.serviceId, environmentId: binding.environmentId }); }
    catch { return undefined; }
  };
  const current = await instance();
  if (current === undefined) return { outcome: "failure", code: "executor-failure", ...(checkpoint === undefined ? {} : { checkpoint }) };
  const sourcePending = checkpoint === undefined || checkpoint.state === "source-pending";
  const setupSource = (observed: RailwayServiceInstance | null): boolean => binding.setupImage !== undefined
    && exactSource(observed, { ...binding, image: binding.setupImage });
  if (!exactSource(current, binding) && !(sourcePending && setupSource(current))) {
    return { outcome: "failure", code: "identity-mismatch", ...(checkpoint === undefined ? {} : { checkpoint }) };
  }
  const expected = binding.setupImage === undefined ? COMMANDS[binding.service]
    : { held: RAILWAY_NAUTILO_SETUP_HOLD_COMMAND, target: null };

  if (checkpoint === undefined) {
    if (command(current) !== expected.held) return { outcome: "failure", code: "identity-mismatch" };
    if (binding.setupImage !== undefined && !setupSource(current)) return { outcome: "failure", code: "identity-mismatch" };
    const next: RailwayTemplateAdoptionReleaseCheckpoint = { ...identity(binding),
      state: binding.setupImage === undefined ? "command-pending" : "source-pending" };
    if (!await persist(next)) return { outcome: "failure", code: "persistence-failure" };
  }

  if (checkpoint!.state === "source-pending") {
    if (command(current) !== expected.held) return { outcome: "failure", code: "identity-mismatch", checkpoint: checkpoint! };
    if (setupSource(current)) {
      if (input.executor.updateServiceSource === undefined) return { outcome: "failure", code: "executor-failure", checkpoint: checkpoint! };
      try {
        await input.executor.updateServiceSource({ serviceId: binding.serviceId, environmentId: binding.environmentId, image: binding.image });
      } catch {
        return { outcome: "pending", checkpoint: checkpoint! };
      }
    }
    const confirmed = await instance();
    if (confirmed === undefined) return { outcome: "pending", checkpoint: checkpoint! };
    if (!exactSource(confirmed, binding) || command(confirmed) !== expected.held) {
      return { outcome: "failure", code: "identity-mismatch", checkpoint: checkpoint! };
    }
    if (!await persist({ ...identity(binding), state: "command-pending" })) {
      return { outcome: "failure", code: "persistence-failure", checkpoint: checkpoint! };
    }
  }

  if (checkpoint!.state === "command-pending") {
    const observed = await instance();
    if (observed === undefined) return { outcome: "pending", checkpoint: checkpoint! };
    if (!exactSource(observed, binding) || (command(observed) !== expected.held && command(observed) !== expected.target)) {
      return { outcome: "failure", code: "identity-mismatch", checkpoint: checkpoint! };
    }
    if (command(observed) === expected.held) {
      try {
        await input.executor.setServiceStartCommand({ serviceId: binding.serviceId, environmentId: binding.environmentId, startCommand: expected.target });
      } catch {
        return { outcome: "pending", checkpoint: checkpoint! };
      }
      const confirmed = await instance();
      if (confirmed === undefined) return { outcome: "pending", checkpoint: checkpoint! };
      if (!exactSource(confirmed, binding) || command(confirmed) !== expected.target) {
        return { outcome: "failure", code: "identity-mismatch", checkpoint: checkpoint! };
      }
    }
    const next: RailwayTemplateAdoptionReleaseCheckpoint = { ...identity(binding), state: "command-applied" };
    if (!await persist(next)) return { outcome: "failure", code: "persistence-failure", checkpoint: checkpoint! };
  }

  if (checkpoint!.state === "command-applied") {
    let deployments: readonly RailwayDeployment[];
    try { deployments = await input.executor.listDeploymentsRaw({ projectId: binding.projectId, environmentId: binding.environmentId, serviceId: binding.serviceId }); }
    catch { return { outcome: "failure", code: "executor-failure", checkpoint: checkpoint! }; }
    const baseline = deployments.map(({ id }) => id).sort();
    if (!baselineValid(baseline) || !baseline.includes(binding.heldDeploymentId)) {
      return { outcome: "failure", code: "identity-mismatch", checkpoint: checkpoint! };
    }
    const pending: RailwayTemplateAdoptionReleaseCheckpoint = { ...identity(binding), state: "start-pending", baselineDeploymentIds: baseline };
    if (!await persist(pending)) return { outcome: "failure", code: "persistence-failure", checkpoint: checkpoint! };
    try {
      const created = await input.executor.createDeployment({ serviceId: binding.serviceId, environmentId: binding.environmentId });
      if (!SAFE_ID.test(created.id) || baseline.includes(created.id)) return { outcome: "failure", code: "identity-mismatch", checkpoint: checkpoint! };
      const started: RailwayTemplateAdoptionReleaseCheckpoint = { ...identity(binding), state: "started", deploymentId: created.id };
      if (!await persist(started)) return { outcome: "failure", code: "persistence-failure", checkpoint: checkpoint! };
    } catch {
      return { outcome: "pending", checkpoint: checkpoint! };
    }
  }

  if (checkpoint!.state === "start-pending") {
    let deployments: readonly RailwayDeployment[];
    try { deployments = await input.executor.listDeploymentsRaw({ projectId: binding.projectId, environmentId: binding.environmentId, serviceId: binding.serviceId }); }
    catch { return { outcome: "pending", checkpoint: checkpoint! }; }
    const baseline = new Set(checkpoint!.baselineDeploymentIds);
    const added = deployments.filter(({ id }) => !baseline.has(id));
    if (added.length === 0) return { outcome: "pending", checkpoint: checkpoint! };
    if (added.length !== 1 || !SAFE_ID.test(added[0]!.id)) return { outcome: "failure", code: "ambiguous-start", checkpoint: checkpoint! };
    const started: RailwayTemplateAdoptionReleaseCheckpoint = { ...identity(binding), state: "started", deploymentId: added[0]!.id };
    if (!await persist(started)) return { outcome: "failure", code: "persistence-failure", checkpoint: checkpoint! };
  }

  if (checkpoint!.state === "started") {
    let deployment: RailwayDeployment;
    try { deployment = await input.executor.getDeployment({ deploymentId: checkpoint!.deploymentId }); }
    catch { return { outcome: "pending", checkpoint: checkpoint! }; }
    if (deployment.id !== checkpoint!.deploymentId) return { outcome: "failure", code: "identity-mismatch", checkpoint: checkpoint! };
    if (deploymentFailed(binding.service, deployment)) return { outcome: "failure", code: "deployment-failed", checkpoint: checkpoint! };
    if (!deploymentComplete(binding.service, deployment)) return { outcome: "pending", checkpoint: checkpoint! };
    const complete: RailwayTemplateAdoptionReleaseCheckpoint = { ...identity(binding), state: "complete", deploymentId: deployment.id };
    if (!await persist(complete)) return { outcome: "failure", code: "persistence-failure", checkpoint: checkpoint! };
  }

  if (checkpoint!.state !== "complete") return { outcome: "pending", checkpoint: checkpoint! };
  const finalInstance = await instance();
  if (finalInstance === undefined) return { outcome: "pending", checkpoint: checkpoint! };
  if (!exactSource(finalInstance, binding) || command(finalInstance) !== expected.target) {
    return { outcome: "failure", code: "identity-mismatch", checkpoint: checkpoint! };
  }
  let finalDeployment: RailwayDeployment;
  try { finalDeployment = await input.executor.getDeployment({ deploymentId: checkpoint!.deploymentId }); }
  catch { return { outcome: "pending", checkpoint: checkpoint! }; }
  return deploymentComplete(binding.service, finalDeployment)
    ? { outcome: "complete", checkpoint: checkpoint!, deploymentId: checkpoint!.deploymentId }
    : deploymentFailed(binding.service, finalDeployment)
      ? { outcome: "failure", code: "deployment-failed", checkpoint: checkpoint! }
      : { outcome: "pending", checkpoint: checkpoint! };
}
