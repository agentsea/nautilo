import type { RailwayDeployment, RailwayServiceInstance } from "./operations";

const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const IMAGE_DIGEST = /@sha256:[a-f0-9]{64}$/;
const MAX_BASELINE = 256;
const MAX_ATTEMPTS = 8;
const MAX_VARIABLES = 512;
const MAX_VARIABLE_VALUE = 64 * 1024;
const FAILED_DEPLOYMENTS = new Set(["CRASHED", "FAILED", "REMOVED", "SKIPPED"]);
const FAILED_INSTANCES = new Set(["CRASHED", "EXITED", "REMOVED", "SKIPPED", "STOPPED"]);

export interface RailwayExactServiceActivationBinding {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly image: string;
  readonly effect: "connect" | "deploy";
}

interface CheckpointIdentity {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly image: string;
  readonly effect: "connect" | "deploy";
  readonly startEffect: "connect" | "deploy";
  readonly attempt: number;
}

export type RailwayExactServiceActivationCheckpoint = CheckpointIdentity & (
  | { readonly state: "prepared" }
  | { readonly state: "start-pending"; readonly baselineDeploymentIds: readonly string[] }
  | { readonly state: "start-unknown"; readonly baselineDeploymentIds: readonly string[] }
  | { readonly state: "started"; readonly jobId: string }
  | { readonly state: "complete"; readonly jobId: string }
);

export interface RailwayExactServiceActivationExecutor {
  upsertVariables(input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly variables: Readonly<Record<string, string>>;
  }): Promise<void>;
  getServiceInstance(input: {
    readonly serviceId: string;
    readonly environmentId: string;
  }): Promise<RailwayServiceInstance | null>;
  listDeploymentsRaw(input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
  }): Promise<readonly RailwayDeployment[]>;
  createDeployment(input: {
    readonly serviceId: string;
    readonly environmentId: string;
  }): Promise<RailwayDeployment>;
  connectService(input: {
    readonly serviceId: string;
    readonly environmentId: string;
    readonly image: string;
  }): Promise<RailwayServiceInstance>;
  getDeployment(input: { readonly deploymentId: string }): Promise<RailwayDeployment>;
}

export interface RailwayExactServiceActivationOptions {
  readonly binding: RailwayExactServiceActivationBinding;
  readonly executor: RailwayExactServiceActivationExecutor;
  /** Durable proof from the separate maintenance-cleanup primitive. */
  readonly maintenanceCleanupComplete: () => Promise<boolean>;
  readonly loadCheckpoint: () => Promise<RailwayExactServiceActivationCheckpoint | undefined>;
  readonly persistCheckpoint: (checkpoint: RailwayExactServiceActivationCheckpoint) => Promise<void>;
  readonly deploymentObservationAttempts?: number | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
}

export interface RailwayExactServiceActivationJob {
  readonly jobId: string;
}

export type RailwayExactServiceActivationObservation =
  | { readonly state: "running" }
  | { readonly state: "complete" }
  | { readonly state: "error" };

export class RailwayExactServiceActivationError extends Error {
  constructor() {
    super("Railway exact service activation failed");
    this.name = "RailwayExactServiceActivationError";
  }
}

function fail(): never {
  throw new RailwayExactServiceActivationError();
}

function snapshotBinding(input: RailwayExactServiceActivationBinding): RailwayExactServiceActivationBinding {
  return Object.freeze({
    projectId: `${input.projectId}`,
    environmentId: `${input.environmentId}`,
    serviceId: `${input.serviceId}`,
    image: `${input.image}`,
    effect: input.effect,
  });
}

function validBinding(binding: RailwayExactServiceActivationBinding): boolean {
  return [binding.projectId, binding.environmentId, binding.serviceId].every((value) => SAFE_PROVIDER_ID.test(value))
    && binding.image.split("@").length === 2 && IMAGE_DIGEST.test(binding.image) && !/\s/.test(binding.image)
    && (binding.effect === "connect" || binding.effect === "deploy");
}

function validBaseline(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_BASELINE
    || !value.every((entry): entry is string => typeof entry === "string" && SAFE_PROVIDER_ID.test(entry))) return false;
  const ids: readonly string[] = value;
  return new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || ids[index - 1]! < id);
}

function checkpointMatches(
  checkpoint: RailwayExactServiceActivationCheckpoint,
  binding: RailwayExactServiceActivationBinding,
): boolean {
  if (checkpoint.state !== "prepared" && checkpoint.state !== "start-pending"
    && checkpoint.state !== "start-unknown" && checkpoint.state !== "started" && checkpoint.state !== "complete") return false;
  const expectedKeys = ["attempt", "effect", "environmentId", "image", "projectId", "serviceId", "startEffect", "state",
    ...((checkpoint.state === "start-pending" || checkpoint.state === "start-unknown")
      ? ["baselineDeploymentIds"] : checkpoint.state === "started" || checkpoint.state === "complete" ? ["jobId"] : [])].sort();
  const actualKeys = Object.keys(checkpoint).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index])
    && checkpoint.projectId === binding.projectId && checkpoint.environmentId === binding.environmentId
    && checkpoint.serviceId === binding.serviceId && checkpoint.image === binding.image && checkpoint.effect === binding.effect
    && Number.isSafeInteger(checkpoint.attempt) && checkpoint.attempt >= 1 && checkpoint.attempt <= MAX_ATTEMPTS
    && (checkpoint.startEffect === "connect" || checkpoint.startEffect === "deploy")
    && (binding.effect === "connect" || checkpoint.startEffect === "deploy")
    && (checkpoint.attempt !== 1 || checkpoint.startEffect === binding.effect)
    && ((checkpoint.state !== "start-pending" && checkpoint.state !== "start-unknown")
      || validBaseline(checkpoint.baselineDeploymentIds))
    && ((checkpoint.state !== "started" && checkpoint.state !== "complete") || SAFE_PROVIDER_ID.test(checkpoint.jobId));
}

function snapshotVariables(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(input);
  if (entries.length > MAX_VARIABLES || entries.some(([name, value]) => !VARIABLE_NAME.test(name)
    || typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_VARIABLE_VALUE)) fail();
  return Object.freeze(Object.fromEntries(entries.map(([name, value]) => [name, `${value}`])));
}

function sourceEmpty(instance: RailwayServiceInstance): boolean {
  return instance.source === null || instance.source === undefined
    || ((instance.source.image ?? null) === null && (instance.source.repo ?? null) === null);
}

function sourceExact(instance: RailwayServiceInstance, binding: RailwayExactServiceActivationBinding): boolean {
  return instance.source?.image === binding.image && (instance.source.repo ?? null) === null;
}

export class RailwayExactServiceActivation {
  readonly #binding: RailwayExactServiceActivationBinding;
  readonly #executor: RailwayExactServiceActivationExecutor;
  readonly #maintenanceCleanupComplete: RailwayExactServiceActivationOptions["maintenanceCleanupComplete"];
  readonly #loadCheckpoint: RailwayExactServiceActivationOptions["loadCheckpoint"];
  readonly #persistCheckpoint: RailwayExactServiceActivationOptions["persistCheckpoint"];
  readonly #deploymentObservationAttempts: number;
  readonly #wait: (milliseconds: number) => Promise<void>;

  constructor(options: RailwayExactServiceActivationOptions) {
    this.#binding = snapshotBinding(options.binding);
    this.#executor = options.executor;
    this.#maintenanceCleanupComplete = options.maintenanceCleanupComplete;
    this.#loadCheckpoint = options.loadCheckpoint;
    this.#persistCheckpoint = options.persistCheckpoint;
    this.#deploymentObservationAttempts = options.deploymentObservationAttempts ?? 3;
    this.#wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (!validBinding(this.#binding) || !Number.isSafeInteger(this.#deploymentObservationAttempts)
      || this.#deploymentObservationAttempts < 1 || this.#deploymentObservationAttempts > 100) fail();
  }

  async #call<T>(effect: () => Promise<T>): Promise<T> {
    try { return await effect(); } catch { fail(); }
  }

  async #instance(): Promise<RailwayServiceInstance> {
    const instance = await this.#call(() => this.#executor.getServiceInstance({
      serviceId: this.#binding.serviceId,
      environmentId: this.#binding.environmentId,
    }));
    if (instance === null || instance.serviceId !== this.#binding.serviceId
      || instance.environmentId !== this.#binding.environmentId || instance.startCommand !== null) fail();
    return instance;
  }

  async #raw(): Promise<readonly RailwayDeployment[]> {
    const deployments = await this.#call(() => this.#executor.listDeploymentsRaw({
      projectId: this.#binding.projectId,
      environmentId: this.#binding.environmentId,
      serviceId: this.#binding.serviceId,
    }));
    const ids = deployments.map(({ id }) => id).sort();
    if (!validBaseline(ids)) fail();
    return deployments;
  }

  async #recover(
    checkpoint: Extract<RailwayExactServiceActivationCheckpoint, { state: "start-pending" | "start-unknown" }>,
  ): Promise<RailwayExactServiceActivationJob | undefined> {
    const instance = await this.#instance();
    const exact = sourceExact(instance, this.#binding);
    if (checkpoint.startEffect === "deploy" ? !exact : (!exact && !sourceEmpty(instance))) fail();
    const baseline = new Set(checkpoint.baselineDeploymentIds);
    let jobId: string | undefined;
    for (let attempt = 0; attempt < this.#deploymentObservationAttempts; attempt += 1) {
      const added = (await this.#raw()).filter(({ id }) => !baseline.has(id));
      if (added.length > 1) fail();
      if (added.length === 1) {
        if (!exact) fail();
        jobId = added[0]!.id;
        break;
      }
      if (attempt + 1 < this.#deploymentObservationAttempts) await this.#call(() => this.#wait(250));
    }
    if (jobId === undefined) return undefined;
    const started: RailwayExactServiceActivationCheckpoint = {
      state: "started", attempt: checkpoint.attempt, projectId: checkpoint.projectId,
      environmentId: checkpoint.environmentId, serviceId: checkpoint.serviceId,
      image: checkpoint.image, effect: checkpoint.effect, startEffect: checkpoint.startEffect, jobId,
    };
    await this.#call(() => this.#persistCheckpoint(started));
    return { jobId };
  }

  async find(): Promise<RailwayExactServiceActivationJob | undefined> {
    const checkpoint = await this.#call(() => this.#loadCheckpoint());
    if (checkpoint === undefined) return undefined;
    if (!checkpointMatches(checkpoint, this.#binding)) fail();
    if (checkpoint.state === "prepared") return undefined;
    if (checkpoint.state === "complete") return { jobId: checkpoint.jobId };
    if (checkpoint.state === "started") {
      const instance = await this.#instance();
      if (!sourceExact(instance, this.#binding)) fail();
      const deployment = await this.#call(() => this.#executor.getDeployment({ deploymentId: checkpoint.jobId }));
      if (deployment.id !== checkpoint.jobId) fail();
      if (FAILED_DEPLOYMENTS.has(deployment.status)
        || deployment.deploymentStopped === true
        || deployment.instances?.some(({ status }) => FAILED_INSTANCES.has(status)) === true) {
        if (checkpoint.attempt >= MAX_ATTEMPTS) fail();
        await this.#call(() => this.#persistCheckpoint({
          state: "prepared", attempt: checkpoint.attempt + 1,
          projectId: checkpoint.projectId, environmentId: checkpoint.environmentId,
          serviceId: checkpoint.serviceId, image: checkpoint.image, effect: checkpoint.effect, startEffect: "deploy",
        }));
        return undefined;
      }
      return { jobId: checkpoint.jobId };
    }
    const recovered = await this.#recover(checkpoint);
    if (recovered !== undefined) return recovered;
    if (checkpoint.state === "start-pending") {
      await this.#call(() => this.#persistCheckpoint({ ...checkpoint, state: "start-unknown" }));
      fail();
    }
    if (checkpoint.attempt >= MAX_ATTEMPTS) fail();
    const instance = await this.#instance();
    const startEffect = sourceExact(instance, this.#binding) ? "deploy"
      : this.#binding.effect === "connect" && sourceEmpty(instance) ? "connect" : fail();
    await this.#call(() => this.#persistCheckpoint({
      state: "prepared", attempt: checkpoint.attempt + 1,
      projectId: checkpoint.projectId, environmentId: checkpoint.environmentId,
      serviceId: checkpoint.serviceId, image: checkpoint.image, effect: checkpoint.effect, startEffect,
    }));
    return undefined;
  }

  async start(input: { readonly variables: Readonly<Record<string, string>> }): Promise<RailwayExactServiceActivationJob> {
    const variables = snapshotVariables({ ...input.variables });
    const cleanupComplete = await this.#call(() => this.#maintenanceCleanupComplete());
    if (!cleanupComplete) fail();
    const existing = await this.#call(() => this.#loadCheckpoint());
    if (existing !== undefined && !checkpointMatches(existing, this.#binding)) fail();
    if (existing !== undefined && existing.state !== "prepared") fail();
    const attempt = existing?.state === "prepared" ? existing.attempt : 1;
    const startEffect = existing?.state === "prepared" ? existing.startEffect : this.#binding.effect;
    const prepared: RailwayExactServiceActivationCheckpoint = {
      state: "prepared", attempt, projectId: this.#binding.projectId, environmentId: this.#binding.environmentId,
      serviceId: this.#binding.serviceId, image: this.#binding.image, effect: this.#binding.effect, startEffect,
    };
    await this.#call(() => this.#persistCheckpoint(prepared));
    await this.#call(() => this.#executor.upsertVariables({
      projectId: this.#binding.projectId, environmentId: this.#binding.environmentId,
      serviceId: this.#binding.serviceId, variables,
    }));
    const before = await this.#instance();
    if (startEffect === "connect" ? !sourceEmpty(before) : !sourceExact(before, this.#binding)) fail();
    const baseline = (await this.#raw()).map(({ id }) => id).sort();
    const pending: RailwayExactServiceActivationCheckpoint = {
      ...prepared, state: "start-pending", baselineDeploymentIds: baseline,
    };
    await this.#call(() => this.#persistCheckpoint(pending));
    try {
      if (startEffect === "connect") {
        await this.#executor.connectService({
          serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId, image: this.#binding.image,
        });
      } else {
        await this.#executor.createDeployment({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId });
      }
    } catch {
      const recovered = await this.#recover(pending);
      if (recovered !== undefined) return recovered;
      await this.#call(() => this.#persistCheckpoint({ ...pending, state: "start-unknown" }));
      fail();
    }
    const recovered = await this.#recover(pending);
    if (recovered !== undefined) return recovered;
    await this.#call(() => this.#persistCheckpoint({ ...pending, state: "start-unknown" }));
    fail();
  }

  async observe(jobId: string): Promise<RailwayExactServiceActivationObservation> {
    if (!SAFE_PROVIDER_ID.test(jobId)) fail();
    const checkpoint = await this.#call(() => this.#loadCheckpoint());
    if (checkpoint === undefined || !checkpointMatches(checkpoint, this.#binding)
      || (checkpoint.state !== "started" && checkpoint.state !== "complete") || checkpoint.jobId !== jobId) fail();
    const instance = await this.#instance();
    if (!sourceExact(instance, this.#binding)) fail();
    const deployment = await this.#call(() => this.#executor.getDeployment({ deploymentId: jobId }));
    if (deployment.id !== jobId) fail();
    if (FAILED_DEPLOYMENTS.has(deployment.status) || deployment.deploymentStopped === true
      || deployment.instances?.some(({ status }) => FAILED_INSTANCES.has(status)) === true) return { state: "error" };
    if (checkpoint.state === "complete") return { state: "complete" };
    if (deployment.status !== "SUCCESS" || deployment.instances === undefined || deployment.instances.length === 0
      || !deployment.instances.every(({ status }) => status === "RUNNING")) return { state: "running" };
    await this.#call(() => this.#persistCheckpoint({ ...checkpoint, state: "complete" }));
    return { state: "complete" };
  }
}
