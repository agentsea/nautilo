import type {
  PortableExportJobInput,
  PortableRestoreJobInput,
  PortableTransferAuthority,
  PortableTransferJobObservation,
  PortableTransferJobReference,
  PortableTransferTarget,
} from "@nautilo/hosting";

import type { RailwayDeployment, RailwayServiceInstance } from "./operations";

const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_DEPLOYMENT_BASELINE = 256;
const MAX_START_ATTEMPTS = 8;
const MAX_DATABASE_URL_LENGTH = 16 * 1024;
const REGION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUCKET = /^(?![0-9]+(?:\.[0-9]+){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9](?:[a-z0-9.-]{1,61})?[a-z0-9]$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9!_.*'()-]{0,127}$/;
const TERMINAL_INSTANCE_FAILURES = new Set(["CRASHED", "STOPPED", "SKIPPED"]);
const TERMINAL_DEPLOYMENT_FAILURES = new Set(["CRASHED", "FAILED", "REMOVED", "SKIPPED"]);

export interface RailwayPortableMaintenanceBinding {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly image: string;
  readonly direction: "export" | "restore";
  readonly operationId: string;
  readonly objectId: string;
  readonly sourceReleaseId: string;
  readonly appDatabaseUrl: string;
  readonly logtoDatabaseUrl: string;
  readonly expectedSha256?: string | undefined;
  readonly storagePrefix?: string | undefined;
  readonly storageSessionToken?: string | undefined;
}

export type RailwayPortableMaintenanceTargetCheckpoint =
  | {
      readonly state: "prepared";
      readonly attempt: number;
      readonly operationId: string;
      readonly direction: "export" | "restore";
      readonly objectId: string;
      readonly projectId: string;
      readonly environmentId: string;
      readonly serviceId: string;
      readonly image: string;
      readonly sourceReleaseId: string;
      readonly command: string;
      readonly startEffect: "connect" | "deploy";
    }
  | {
      readonly state: "start-pending";
      readonly attempt: number;
      readonly operationId: string;
      readonly direction: "export" | "restore";
      readonly objectId: string;
      readonly projectId: string;
      readonly environmentId: string;
      readonly serviceId: string;
      readonly image: string;
      readonly sourceReleaseId: string;
      readonly command: string;
      readonly startEffect: "connect" | "deploy";
      readonly baselineDeploymentIds: readonly string[];
    }
  | {
      readonly state: "start-unknown";
      readonly attempt: number;
      readonly operationId: string;
      readonly direction: "export" | "restore";
      readonly objectId: string;
      readonly projectId: string;
      readonly environmentId: string;
      readonly serviceId: string;
      readonly image: string;
      readonly sourceReleaseId: string;
      readonly command: string;
      readonly startEffect: "connect" | "deploy";
      readonly baselineDeploymentIds: readonly string[];
    }
  | {
      readonly state: "started";
      readonly attempt: number;
      readonly operationId: string;
      readonly direction: "export" | "restore";
      readonly objectId: string;
      readonly projectId: string;
      readonly environmentId: string;
      readonly serviceId: string;
      readonly image: string;
      readonly sourceReleaseId: string;
      readonly command: string;
      readonly jobId: string;
      readonly startEffect: "connect" | "deploy";
    };

export interface RailwayPortableMaintenanceExecutor {
  upsertVariables(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly variables: Readonly<Record<string, string>> }): Promise<void>;
  setServiceStartCommand(input: { readonly serviceId: string; readonly environmentId: string; readonly startCommand: string | null }): Promise<void>;
  getServiceInstance(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayServiceInstance | null>;
  listDeploymentsRaw(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }): Promise<readonly RailwayDeployment[]>;
  createDeployment(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayDeployment>;
  connectService(input: { readonly serviceId: string; readonly environmentId: string; readonly image: string }): Promise<RailwayServiceInstance>;
  getDeployment(input: { readonly deploymentId: string }): Promise<RailwayDeployment>;
}

export interface PortableRecoveryDescriptor {
  readonly operationId: string;
  readonly objectId: string;
  readonly ciphertextSha256: string;
  readonly ciphertextBytes: number;
  readonly sourceReleaseId: string;
  readonly completedAt: string;
}

export interface RailwayPortableMaintenanceDescriptorProbe {
  observe(input: {
    readonly operationId: string;
    readonly objectId: string;
    readonly authority: PortableTransferAuthority;
    readonly prefix: string;
    /** Optional short-lived S3 credential retained only in request memory. */
    readonly sessionToken?: string | undefined;
  }): Promise<{ readonly state: "not-found" | "inconsistent" } | { readonly state: "complete"; readonly descriptor: PortableRecoveryDescriptor }>;
}

export interface RailwayPortableMaintenanceTargetOptions {
  readonly binding: RailwayPortableMaintenanceBinding;
  /** Request-memory storage/encryption authority; never included in a checkpoint. */
  readonly authority: PortableTransferAuthority;
  readonly executor: RailwayPortableMaintenanceExecutor;
  readonly descriptorProbe: RailwayPortableMaintenanceDescriptorProbe;
  readonly loadCheckpoint: (operationId: string) => Promise<RailwayPortableMaintenanceTargetCheckpoint | undefined>;
  readonly persistCheckpoint: (checkpoint: RailwayPortableMaintenanceTargetCheckpoint) => Promise<void>;
  readonly deploymentObservationAttempts?: number | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
}

export class RailwayPortableMaintenanceTargetError extends Error {
  constructor() {
    super("Railway portable maintenance target failed");
    this.name = "RailwayPortableMaintenanceTargetError";
  }
}

function fail(): never {
  throw new RailwayPortableMaintenanceTargetError();
}

function digestImage(value: string): boolean {
  const parts = value.split("@");
  return parts.length === 2 && parts[0] !== "" && /^sha256:[a-f0-9]{64}$/.test(parts[1] ?? "") && !/\s/.test(value);
}

function exactTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function snapshotAuthority(authority: PortableTransferAuthority): PortableTransferAuthority {
  return Object.freeze({
    endpoint: `${authority.endpoint}`,
    region: `${authority.region}`,
    bucket: `${authority.bucket}`,
    accessKeyId: `${authority.accessKeyId}`,
    secretAccessKey: `${authority.secretAccessKey}`,
    encryptionKey: Uint8Array.from(authority.encryptionKey),
  });
}

function validAuthority(authority: PortableTransferAuthority): boolean {
  let endpoint: URL;
  try { endpoint = new URL(authority.endpoint); } catch { return false; }
  return authority.endpoint.length > 0 && authority.endpoint.trim() === authority.endpoint
    && endpoint.protocol === "https:" && endpoint.username === "" && endpoint.password === "" && endpoint.hostname.length > 0
    && endpoint.search === "" && endpoint.hash === "" && (endpoint.pathname === "" || endpoint.pathname === "/")
    && byteLength(authority.region) <= 64 && authority.region.trim() === authority.region && REGION.test(authority.region)
    && authority.bucket.trim() === authority.bucket && BUCKET.test(authority.bucket)
    && byteLength(authority.accessKeyId) > 0 && byteLength(authority.accessKeyId) <= 2 * 1024 && authority.accessKeyId.trim() === authority.accessKeyId
    && byteLength(authority.secretAccessKey) > 0 && byteLength(authority.secretAccessKey) <= 8 * 1024 && authority.secretAccessKey.trim() === authority.secretAccessKey
    && authority.encryptionKey.byteLength === 32;
}

function validPrefix(value: string): boolean {
  return value === "" || (byteLength(value) <= 256 && value.trim() === value && !value.startsWith("/") && !value.endsWith("/")
    && !value.includes("//") && value.split("/").every((segment) => PREFIX_SEGMENT.test(segment)));
}

function checkpointMatches(checkpoint: RailwayPortableMaintenanceTargetCheckpoint, binding: RailwayPortableMaintenanceBinding, command: string): boolean {
  if (checkpoint.state !== "prepared" && checkpoint.state !== "start-pending" && checkpoint.state !== "start-unknown" && checkpoint.state !== "started") return false;
  const expectedKeys = ["attempt", "command", "direction", "environmentId", "image", "objectId", "operationId", "projectId", "serviceId", "sourceReleaseId", "startEffect", "state",
    ...((checkpoint.state === "start-pending" || checkpoint.state === "start-unknown") ? ["baselineDeploymentIds"] : checkpoint.state === "started" ? ["jobId"] : [])].sort();
  const actualKeys = Object.keys(checkpoint).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index])
    && checkpoint.operationId === binding.operationId
    && checkpoint.direction === binding.direction
    && checkpoint.objectId === binding.objectId
    && checkpoint.projectId === binding.projectId
    && checkpoint.environmentId === binding.environmentId
    && checkpoint.serviceId === binding.serviceId
    && checkpoint.image === binding.image
    && checkpoint.sourceReleaseId === binding.sourceReleaseId
    && checkpoint.command === command
    && Number.isSafeInteger(checkpoint.attempt) && checkpoint.attempt >= 1 && checkpoint.attempt <= MAX_START_ATTEMPTS
    && ((checkpoint.state !== "start-pending" && checkpoint.state !== "start-unknown") || validBaseline(checkpoint.baselineDeploymentIds))
    && (checkpoint.startEffect === "connect" || checkpoint.startEffect === "deploy")
    && (checkpoint.state !== "started" || SAFE_PROVIDER_ID.test(checkpoint.jobId));
}

function validBaseline(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_DEPLOYMENT_BASELINE || !value.every((id): id is string => typeof id === "string" && SAFE_PROVIDER_ID.test(id))) return false;
  const ids: readonly string[] = value;
  return new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || ids[index - 1]! < id);
}

export class RailwayPortableMaintenanceTarget implements PortableTransferTarget {
  readonly #binding: RailwayPortableMaintenanceBinding;
  readonly #executor: RailwayPortableMaintenanceExecutor;
  readonly #descriptorProbe: RailwayPortableMaintenanceDescriptorProbe;
  readonly #loadCheckpoint: RailwayPortableMaintenanceTargetOptions["loadCheckpoint"];
  readonly #persistCheckpoint: RailwayPortableMaintenanceTargetOptions["persistCheckpoint"];
  readonly #command: string;
  readonly #authority: PortableTransferAuthority;
  readonly #deploymentObservationAttempts: number;
  readonly #wait: (milliseconds: number) => Promise<void>;

  constructor(options: RailwayPortableMaintenanceTargetOptions) {
    const input = options.binding;
    this.#binding = Object.freeze({
      projectId: `${input.projectId}`, environmentId: `${input.environmentId}`, serviceId: `${input.serviceId}`,
      image: `${input.image}`, direction: input.direction, operationId: `${input.operationId}`, objectId: `${input.objectId}`,
      sourceReleaseId: `${input.sourceReleaseId}`, appDatabaseUrl: `${input.appDatabaseUrl}`, logtoDatabaseUrl: `${input.logtoDatabaseUrl}`,
      ...(input.expectedSha256 === undefined ? {} : { expectedSha256: `${input.expectedSha256}` }),
      storagePrefix: input.storagePrefix === undefined ? "" : `${input.storagePrefix}`,
      storageSessionToken: input.storageSessionToken === undefined ? "" : `${input.storageSessionToken}`,
    });
    this.#authority = snapshotAuthority(options.authority);
    this.#executor = options.executor;
    this.#descriptorProbe = options.descriptorProbe;
    this.#loadCheckpoint = options.loadCheckpoint;
    this.#persistCheckpoint = options.persistCheckpoint;
    this.#deploymentObservationAttempts = options.deploymentObservationAttempts ?? 3;
    this.#wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#command = `bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts ${this.#binding.direction} ${this.#binding.operationId} ${this.#binding.objectId}`;
    if ((this.#binding.direction !== "export" && this.#binding.direction !== "restore")
      || ![this.#binding.projectId, this.#binding.environmentId, this.#binding.serviceId, this.#binding.sourceReleaseId].every((value) => SAFE_PROVIDER_ID.test(value))
      || ![this.#binding.operationId, this.#binding.objectId].every((value) => SAFE_COMMAND_ID.test(value))
      || !digestImage(this.#binding.image)
      || !validAuthority(this.#authority)
      || !validPrefix(this.#binding.storagePrefix ?? "")
      || byteLength(this.#binding.storageSessionToken ?? "") > 16 * 1024
      || ((this.#binding.storageSessionToken ?? "") !== "" && (this.#binding.storageSessionToken ?? "").trim() !== this.#binding.storageSessionToken)
      || !Number.isSafeInteger(this.#deploymentObservationAttempts) || this.#deploymentObservationAttempts < 1 || this.#deploymentObservationAttempts > 100
      || !this.#binding.appDatabaseUrl || this.#binding.appDatabaseUrl.length > MAX_DATABASE_URL_LENGTH || this.#binding.appDatabaseUrl.trim() !== this.#binding.appDatabaseUrl
      || !this.#binding.logtoDatabaseUrl || this.#binding.logtoDatabaseUrl.length > MAX_DATABASE_URL_LENGTH || this.#binding.logtoDatabaseUrl.trim() !== this.#binding.logtoDatabaseUrl
      || (this.#binding.direction === "restore" ? !SHA256.test(this.#binding.expectedSha256 ?? "") : this.#binding.expectedSha256 !== undefined)) fail();
  }

  async #raw(): Promise<readonly RailwayDeployment[]> {
    const deployments = await this.#executor.listDeploymentsRaw({ projectId: this.#binding.projectId, environmentId: this.#binding.environmentId, serviceId: this.#binding.serviceId });
    const ids = deployments.map(({ id }) => id).sort();
    if (!validBaseline(ids)) fail();
    return deployments;
  }

  async #recover(checkpoint: Extract<RailwayPortableMaintenanceTargetCheckpoint, { state: "start-pending" | "start-unknown" }>): Promise<PortableTransferJobReference | undefined> {
    const instance = await this.#executor.getServiceInstance({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId });
    if (instance === null || instance.startCommand !== this.#command) fail();
    const sourceExact = instance.source?.image === this.#binding.image && (instance.source.repo ?? null) === null;
    const sourceEmpty = instance.source === null || instance.source === undefined || ((instance.source.image ?? null) === null && (instance.source.repo ?? null) === null);
    if (checkpoint.startEffect === "deploy" ? !sourceExact : (!sourceExact && !sourceEmpty)) fail();
    const baseline = new Set(checkpoint.baselineDeploymentIds);
    let jobId: string | undefined;
    for (let attempt = 0; attempt < this.#deploymentObservationAttempts; attempt += 1) {
      const current = await this.#raw();
      const added = current.filter((entry) => !baseline.has(entry.id));
      if (added.length > 1) fail();
      if (added.length === 1) {
        if (!sourceExact) fail();
        jobId = added[0]!.id; break;
      }
      if (attempt + 1 < this.#deploymentObservationAttempts) {
        try { await this.#wait(250); } catch { fail(); }
      }
    }
    if (jobId === undefined) return undefined;
    await this.#persistCheckpoint({
      state: "started", attempt: checkpoint.attempt, operationId: checkpoint.operationId, direction: checkpoint.direction,
      objectId: checkpoint.objectId, projectId: checkpoint.projectId, environmentId: checkpoint.environmentId,
      serviceId: checkpoint.serviceId, image: checkpoint.image, sourceReleaseId: checkpoint.sourceReleaseId,
      command: checkpoint.command, jobId, startEffect: checkpoint.startEffect,
    });
    return { jobId };
  }

  async #persistStartUnknown(checkpoint: Extract<RailwayPortableMaintenanceTargetCheckpoint, { state: "start-pending" }>): Promise<void> {
    await this.#persistCheckpoint({ ...checkpoint, state: "start-unknown" });
  }

  async find(operationId: string): Promise<PortableTransferJobReference | undefined> {
    if (operationId !== this.#binding.operationId) fail();
    const checkpoint = await this.#loadCheckpoint(operationId);
    if (checkpoint === undefined) return undefined;
    if (!checkpointMatches(checkpoint, this.#binding, this.#command)) fail();
    if (checkpoint.state === "prepared") return undefined;
    if (checkpoint.state === "started") {
      const instance = await this.#executor.getServiceInstance({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId });
      if (instance === null || instance.startCommand !== this.#command || instance.source?.image !== this.#binding.image || (instance.source.repo ?? null) !== null) fail();
      const deployment = await this.#executor.getDeployment({ deploymentId: checkpoint.jobId });
      if (deployment.id !== checkpoint.jobId) fail();
      const failed = TERMINAL_DEPLOYMENT_FAILURES.has(deployment.status) || deployment.instances?.some(({ status }) => TERMINAL_INSTANCE_FAILURES.has(status)) === true;
      if (!failed) return { jobId: checkpoint.jobId };
      if (this.#binding.direction === "export") {
        const descriptor = await this.#exactDescriptor();
        if (descriptor === null) fail();
        if (descriptor !== undefined) return { jobId: checkpoint.jobId };
        fail();
      }
      if (checkpoint.attempt >= MAX_START_ATTEMPTS) fail();
      await this.#persistCheckpoint({
        state: "prepared", attempt: checkpoint.attempt + 1, operationId: checkpoint.operationId, direction: checkpoint.direction,
        objectId: checkpoint.objectId, projectId: checkpoint.projectId, environmentId: checkpoint.environmentId,
        serviceId: checkpoint.serviceId, image: checkpoint.image, sourceReleaseId: checkpoint.sourceReleaseId, command: checkpoint.command,
        startEffect: "deploy",
      });
      return undefined;
    }
    if (checkpoint.state === "start-pending") {
      const recovered = await this.#recover(checkpoint);
      if (recovered !== undefined) return recovered;
      await this.#persistStartUnknown(checkpoint);
      fail();
    }
    const recovered = await this.#recover(checkpoint);
    if (recovered !== undefined) return recovered;
    if (checkpoint.attempt >= MAX_START_ATTEMPTS) fail();
    const instance = await this.#executor.getServiceInstance({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId });
    if (instance === null || instance.startCommand !== this.#command) fail();
    const exact = instance.source?.image === this.#binding.image && (instance.source.repo ?? null) === null;
    const empty = instance.source === null || instance.source === undefined
      || ((instance.source.image ?? null) === null && (instance.source.repo ?? null) === null);
    const startEffect = exact ? "deploy" : empty ? "connect" : fail();
    await this.#persistCheckpoint({
      state: "prepared", attempt: checkpoint.attempt + 1, operationId: checkpoint.operationId, direction: checkpoint.direction,
      objectId: checkpoint.objectId, projectId: checkpoint.projectId, environmentId: checkpoint.environmentId,
      serviceId: checkpoint.serviceId, image: checkpoint.image, sourceReleaseId: checkpoint.sourceReleaseId, command: checkpoint.command, startEffect,
    });
    return undefined;
  }

  async #start(input: PortableExportJobInput | PortableRestoreJobInput): Promise<PortableTransferJobReference> {
    if (input.operationId !== this.#binding.operationId || input.objectId !== this.#binding.objectId) fail();
    const expected = "expectedSha256" in input ? `${input.expectedSha256}` : undefined;
    if (this.#binding.direction === "restore" ? expected !== this.#binding.expectedSha256 : expected !== undefined) fail();
    const authority = snapshotAuthority(input.authority);
    if (authority.endpoint !== this.#authority.endpoint || authority.region !== this.#authority.region
      || authority.bucket !== this.#authority.bucket || authority.accessKeyId !== this.#authority.accessKeyId
      || authority.secretAccessKey !== this.#authority.secretAccessKey
      || authority.encryptionKey.length !== this.#authority.encryptionKey.length
      || authority.encryptionKey.some((byte, index) => byte !== this.#authority.encryptionKey[index])) fail();
    const variables = Object.freeze({
      NAUTILO_RECOVERY_S3_ENDPOINT: authority.endpoint,
      NAUTILO_RECOVERY_S3_REGION: authority.region,
      NAUTILO_RECOVERY_S3_BUCKET: authority.bucket,
      NAUTILO_RECOVERY_S3_PREFIX: this.#binding.storagePrefix ?? "",
      NAUTILO_RECOVERY_S3_ACCESS_KEY_ID: authority.accessKeyId,
      NAUTILO_RECOVERY_S3_SECRET_ACCESS_KEY: authority.secretAccessKey,
      NAUTILO_RECOVERY_S3_SESSION_TOKEN: this.#binding.storageSessionToken ?? "",
      NAUTILO_RECOVERY_KEY: Buffer.from(authority.encryptionKey).toString("base64url"),
      NAUTILO_RECOVERY_SOURCE_RELEASE_ID: this.#binding.sourceReleaseId,
      NAUTILO_RECOVERY_EXPECTED_SHA256: expected ?? "",
      NAUTILO_RECOVERY_APP_DATABASE_URL: this.#binding.appDatabaseUrl,
      NAUTILO_RECOVERY_LOGTO_DATABASE_URL: this.#binding.logtoDatabaseUrl,
    });
    const existingCheckpoint = await this.#loadCheckpoint(this.#binding.operationId);
    if (existingCheckpoint !== undefined && !checkpointMatches(existingCheckpoint, this.#binding, this.#command)) fail();
    if (existingCheckpoint !== undefined && existingCheckpoint.state !== "prepared") fail();
    const attempt = existingCheckpoint?.state === "prepared" ? existingCheckpoint.attempt : 1;
    let startEffect = existingCheckpoint?.state === "prepared" ? existingCheckpoint.startEffect : undefined;
    if (startEffect === undefined) {
      const initial = await this.#executor.getServiceInstance({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId });
      if (initial === null || initial.serviceId !== this.#binding.serviceId || initial.environmentId !== this.#binding.environmentId) fail();
      const exact = initial.source?.image === this.#binding.image && (initial.source.repo ?? null) === null;
      const empty = initial.source === null || initial.source === undefined
        || ((initial.source.image ?? null) === null && (initial.source.repo ?? null) === null);
      startEffect = exact ? "deploy" : empty ? "connect" : fail();
    }
    const prepared: Extract<RailwayPortableMaintenanceTargetCheckpoint, { state: "prepared" }> = {
      state: "prepared", attempt, operationId: this.#binding.operationId, direction: this.#binding.direction,
      objectId: this.#binding.objectId, projectId: this.#binding.projectId, environmentId: this.#binding.environmentId,
      serviceId: this.#binding.serviceId, image: this.#binding.image, sourceReleaseId: this.#binding.sourceReleaseId, command: this.#command, startEffect,
    };
    await this.#persistCheckpoint(prepared);
    await this.#executor.upsertVariables({ projectId: this.#binding.projectId, environmentId: this.#binding.environmentId, serviceId: this.#binding.serviceId, variables });
    await this.#executor.setServiceStartCommand({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId, startCommand: this.#command });
    const instance = await this.#executor.getServiceInstance({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId });
    if (instance === null || instance.startCommand !== this.#command) fail();
    const source = instance.source;
    const connect = startEffect === "connect";
    const sourceEmpty = source === null || source === undefined || ((source.image ?? null) === null && (source.repo ?? null) === null);
    const sourceExact = source?.image === this.#binding.image && (source.repo ?? null) === null;
    if (connect ? !sourceEmpty : !sourceExact) fail();
    const baseline = (await this.#raw()).map(({ id }) => id).sort();
    const pending: Extract<RailwayPortableMaintenanceTargetCheckpoint, { state: "start-pending" }> = {
      state: "start-pending", attempt, operationId: this.#binding.operationId, direction: this.#binding.direction,
      objectId: this.#binding.objectId, projectId: this.#binding.projectId, environmentId: this.#binding.environmentId,
      serviceId: this.#binding.serviceId, image: this.#binding.image, sourceReleaseId: this.#binding.sourceReleaseId,
      command: this.#command, startEffect, baselineDeploymentIds: baseline,
    };
    await this.#persistCheckpoint(pending);
    try {
      if (connect) await this.#executor.connectService({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId, image: this.#binding.image });
      else await this.#executor.createDeployment({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId });
    } catch {
      const recovered = await this.#recover(pending);
      if (recovered !== undefined) return recovered;
      await this.#persistStartUnknown(pending);
      fail();
    }
    const recovered = await this.#recover(pending);
    if (recovered !== undefined) return recovered;
    await this.#persistStartUnknown(pending);
    fail();
  }

  startExport(input: PortableExportJobInput): Promise<PortableTransferJobReference> {
    if (this.#binding.direction !== "export") fail();
    return this.#start(input);
  }

  startRestore(input: PortableRestoreJobInput): Promise<PortableTransferJobReference> {
    if (this.#binding.direction !== "restore") fail();
    return this.#start(input);
  }

  async #exactDescriptor(): Promise<PortableRecoveryDescriptor | undefined | null> {
    const observed = await this.#descriptorProbe.observe({
      operationId: this.#binding.operationId,
      objectId: this.#binding.objectId,
      authority: snapshotAuthority(this.#authority),
      prefix: this.#binding.storagePrefix ?? "",
      ...((this.#binding.storageSessionToken ?? "") === "" ? {} : { sessionToken: this.#binding.storageSessionToken }),
    });
    if (observed.state === "not-found") return undefined;
    // S3-compatible stores may briefly expose one side of the descriptor-last
    // publication pair. Never accept that partial state, but keep observing it
    // instead of terminalizing a successful one-shot job.
    if (observed.state !== "complete") return undefined;
    const descriptor = observed.descriptor;
    if (descriptor.operationId !== this.#binding.operationId || descriptor.objectId !== this.#binding.objectId
      || descriptor.sourceReleaseId !== this.#binding.sourceReleaseId || !SHA256.test(descriptor.ciphertextSha256)
      || !Number.isSafeInteger(descriptor.ciphertextBytes) || descriptor.ciphertextBytes < 1
      || !exactTimestamp(descriptor.completedAt)
      || (this.#binding.direction === "restore" && descriptor.ciphertextSha256 !== this.#binding.expectedSha256)) return null;
    return Object.freeze({ ...descriptor });
  }

  async observe(jobId: string): Promise<PortableTransferJobObservation> {
    if (!SAFE_PROVIDER_ID.test(jobId)) fail();
    const checkpoint = await this.#loadCheckpoint(this.#binding.operationId);
    if (checkpoint?.state !== "started" || !checkpointMatches(checkpoint, this.#binding, this.#command) || checkpoint.jobId !== jobId) fail();
    const instance = await this.#executor.getServiceInstance({ serviceId: this.#binding.serviceId, environmentId: this.#binding.environmentId });
    if (instance === null || instance.startCommand !== this.#command || instance.source?.image !== this.#binding.image || (instance.source.repo ?? null) !== null) fail();
    const deployment = await this.#executor.getDeployment({ deploymentId: jobId });
    if (deployment.id !== jobId) fail();
    const descriptor = await this.#exactDescriptor();
    if (descriptor === null) return { state: "error" };
    if (this.#binding.direction === "export" && descriptor !== undefined) return { state: "complete", objectId: descriptor.objectId, sha256: descriptor.ciphertextSha256, completedAt: descriptor.completedAt };
    if (TERMINAL_DEPLOYMENT_FAILURES.has(deployment.status) || deployment.instances?.some(({ status }) => TERMINAL_INSTANCE_FAILURES.has(status))) return { state: "error" };
    const terminal = deployment.status === "SUCCESS" && deployment.instances !== undefined && deployment.instances.length > 0 && deployment.instances.every(({ status }) => status === "EXITED");
    if (!terminal) return { state: "running" };
    if (descriptor === undefined) return { state: "running" };
    return { state: "complete", objectId: descriptor.objectId, sha256: descriptor.ciphertextSha256, completedAt: descriptor.completedAt };
  }
}
