import {
  railwayDeployment,
  railwayDeployments,
  railwayDomains,
  railwayEnvironmentCreate,
  railwayEnvironmentVolumeInstances,
  railwayEnvironments,
  railwayProject,
  railwayProjectCreate,
  railwayProjects,
  railwayProjectServices,
  railwayProjectVolumes,
  railwayServiceConnect,
  railwayServiceCreate,
  railwayServiceDelete,
  railwayServiceDomainCreate,
  railwayServiceInstance,
  railwayServiceInstanceLatestDeployment,
  railwayServiceInstanceDeploy,
  railwayServiceInstanceUpdate,
  railwayVariableDelete,
  railwayVariableCollectionUpsert,
  railwayVolumeCreate,
  type RailwayDeployment,
  type RailwayEnvironment,
  type RailwayProject,
  type RailwayService,
  type RailwayServiceDomain,
  type RailwayServiceInstance,
  type RailwayServiceSource,
  type RailwayVolume,
  type RailwayVolumeInstance,
} from "./operations";
import { paginateRailwayConnection } from "./pagination";
import type {
  RailwayReconcileExecutor,
  RailwayReconcileProjectIntent,
  RailwayReconcileSurvivingResource,
} from "./reconcile-types";
import type {
  RailwayConnection,
  RailwayGraphqlVariables,
  RailwayOperation,
  RailwayOperationData,
  RailwayOperationVariables,
  RailwayPaginationVariables,
  RailwayTransportResult,
} from "./types";

/** The live Railway connection page size used by the resource driver. */
export const RAILWAY_RECONCILE_PAGE_SIZE = 100;
/** A provider response cannot keep one reconciliation invocation paging forever. */
export const RAILWAY_RECONCILE_MAX_PAGES = 100;
/** Railway source changes create deployments asynchronously. */
const RAILWAY_DEPLOYMENT_OBSERVATION_ATTEMPTS = 60;
/** Thirty seconds total by default, while remaining injectable in tests. */
const RAILWAY_DEPLOYMENT_OBSERVATION_INTERVAL_MS = 500;

/**
 * Intentionally redacted adapter error. Railway errors and variable values can
 * contain provider-controlled or secret-bearing data, so the reconciler gets
 * only a stable failure signal and inventories surviving exact-ID resources.
 */
export class RailwayReconcileExecutorError extends Error {
  constructor() {
    super("Railway reconciliation operation did not complete safely.");
    this.name = "RailwayReconcileExecutorError";
  }
}

/** The typed transport used by the concrete reconcile adapter. */
export interface RailwayReconcileExecutorTransport {
  execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>>;
}

export interface RailwayGraphqlReconcileExecutorOptions {
  readonly transport: RailwayReconcileExecutorTransport;
  /** Kept injectable for qualified tests; a production caller uses the pinned default. */
  readonly pageSize?: number | undefined;
  /** Limits a single resource-inventory walk even if Railway keeps returning cursors. */
  readonly maxPages?: number | undefined;
  /** Bounds eventual-consistency observation after Railway accepts a source. */
  readonly deploymentObservationAttempts?: number | undefined;
  /** Kept injectable so qualification tests do not sleep. */
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
}

function validBound(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null || value === undefined ? value : undefined;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function project(value: unknown): RailwayProject | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as { readonly id?: unknown; readonly name?: unknown; readonly primaryEnvironmentId?: unknown; readonly workspaceId?: unknown; readonly deletedAt?: unknown };
  const id = requiredString(candidate.id);
  const name = requiredString(candidate.name);
  if (id === undefined || name === undefined) return undefined;
  const primaryEnvironmentId = optionalString(candidate.primaryEnvironmentId);
  const workspaceId = optionalString(candidate.workspaceId);
  const deletedAt = optionalString(candidate.deletedAt);
  if (primaryEnvironmentId === undefined && candidate.primaryEnvironmentId !== undefined) return undefined;
  if (workspaceId === undefined && candidate.workspaceId !== undefined) return undefined;
  if (deletedAt === undefined && candidate.deletedAt !== undefined) return undefined;
  return {
    id,
    name,
    ...(primaryEnvironmentId === undefined ? {} : { primaryEnvironmentId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}

function environment(value: unknown): RailwayEnvironment | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as { readonly id?: unknown; readonly name?: unknown };
  const id = requiredString(candidate.id);
  const name = requiredString(candidate.name);
  return id === undefined || name === undefined ? undefined : { id, name };
}

function service(value: unknown): RailwayService | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly templateId?: unknown;
    readonly templateServiceId?: unknown;
    readonly templateThreadSlug?: unknown;
  };
  const id = requiredString(candidate.id);
  const name = requiredString(candidate.name);
  const templateId = optionalString(candidate.templateId);
  const templateServiceId = optionalString(candidate.templateServiceId);
  const templateThreadSlug = optionalString(candidate.templateThreadSlug);
  if (id === undefined || name === undefined
    || (templateId === undefined && candidate.templateId !== undefined)
    || (templateServiceId === undefined && candidate.templateServiceId !== undefined)
    || (templateThreadSlug === undefined && candidate.templateThreadSlug !== undefined)) return undefined;
  return {
    id,
    name,
    ...(candidate.templateId === undefined ? {} : { templateId }),
    ...(candidate.templateServiceId === undefined ? {} : { templateServiceId }),
    ...(candidate.templateThreadSlug === undefined ? {} : { templateThreadSlug }),
  };
}

function serviceSource(value: unknown): RailwayServiceSource | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const candidate = value as { readonly image?: unknown; readonly repo?: unknown };
  const image = optionalString(candidate.image);
  const repo = optionalString(candidate.repo);
  if (image === undefined && candidate.image !== undefined) return undefined;
  if (repo === undefined && candidate.repo !== undefined) return undefined;
  return {
    ...(image === undefined ? {} : { image }),
    ...(repo === undefined ? {} : { repo }),
  };
}

function serviceInstance(value: unknown): RailwayServiceInstance | undefined {
  if (value === null || !isRecord(value)) return undefined;
  const candidate = value as { readonly id?: unknown; readonly serviceId?: unknown; readonly environmentId?: unknown; readonly source?: unknown; readonly startCommand?: unknown; readonly latestDeployment?: unknown };
  const id = requiredString(candidate.id);
  const serviceId = requiredString(candidate.serviceId);
  const environmentId = requiredString(candidate.environmentId);
  const source = serviceSource(candidate.source);
  const rawStartCommand = optionalString(candidate.startCommand);
  // Railway's public API represents a cleared image start-command override as
  // the empty string. Keep the package contract provider-neutral: callers see
  // the canonical null state used by cleanup and normal-service activation.
  const startCommand = rawStartCommand === "" ? null : rawStartCommand;
  const latestDeployment = candidate.latestDeployment === null ? null : deployment(candidate.latestDeployment);
  if (id === undefined || serviceId === undefined || environmentId === undefined || source === undefined) return undefined;
  if (startCommand === undefined && candidate.startCommand !== undefined) return undefined;
  if (latestDeployment === undefined && candidate.latestDeployment !== undefined) return undefined;
  return {
    id,
    serviceId,
    environmentId,
    source,
    ...(startCommand === undefined ? {} : { startCommand }),
    ...(latestDeployment === undefined ? {} : { latestDeployment }),
  };
}

function volume(value: unknown): RailwayVolume | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as { readonly id?: unknown; readonly name?: unknown; readonly projectId?: unknown };
  const id = requiredString(candidate.id);
  const name = requiredString(candidate.name);
  const projectId = requiredString(candidate.projectId);
  return id === undefined || name === undefined || projectId === undefined ? undefined : { id, name, projectId };
}

function volumeInstance(value: unknown): RailwayVolumeInstance | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as { readonly id?: unknown; readonly volumeId?: unknown; readonly mountPath?: unknown; readonly serviceId?: unknown; readonly deletedAt?: unknown; readonly isPendingDeletion?: unknown };
  const id = requiredString(candidate.id);
  const volumeId = requiredString(candidate.volumeId);
  const mountPath = requiredString(candidate.mountPath);
  const serviceId = optionalString(candidate.serviceId);
  const deletedAt = optionalString(candidate.deletedAt);
  if (id === undefined || volumeId === undefined || mountPath === undefined) return undefined;
  if (serviceId === undefined && candidate.serviceId !== undefined) return undefined;
  if (deletedAt === undefined && candidate.deletedAt !== undefined) return undefined;
  if (candidate.isPendingDeletion !== undefined && typeof candidate.isPendingDeletion !== "boolean") return undefined;
  return {
    id,
    volumeId,
    mountPath,
    ...(serviceId === undefined ? {} : { serviceId }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
    ...(candidate.isPendingDeletion === undefined ? {} : { isPendingDeletion: candidate.isPendingDeletion }),
  };
}

function domain(value: unknown): RailwayServiceDomain | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as { readonly id?: unknown; readonly domain?: unknown; readonly targetPort?: unknown };
  const id = requiredString(candidate.id);
  const name = requiredString(candidate.domain);
  const targetPort = candidate.targetPort;
  if (id === undefined || name === undefined) return undefined;
  if (targetPort !== undefined && targetPort !== null && (typeof targetPort !== "number" || !Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65_535)) return undefined;
  return { id, domain: name, ...(targetPort === undefined ? {} : { targetPort }) };
}

const deploymentStatuses = new Set<RailwayDeployment["status"]>([
  "BUILDING", "CRASHED", "DEPLOYING", "FAILED", "INITIALIZING", "NEEDS_APPROVAL", "QUEUED",
  "REMOVED", "REMOVING", "SKIPPED", "SLEEPING", "SUCCESS", "WAITING",
]);

function deployment(value: unknown): RailwayDeployment | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as { readonly id?: unknown; readonly status?: unknown; readonly url?: unknown; readonly staticUrl?: unknown; readonly deploymentStopped?: unknown; readonly instances?: unknown };
  const id = requiredString(candidate.id);
  const status = candidate.status;
  const url = optionalString(candidate.url);
  const staticUrl = optionalString(candidate.staticUrl);
  if (id === undefined || typeof status !== "string" || !deploymentStatuses.has(status as RailwayDeployment["status"])) return undefined;
  if (url === undefined && candidate.url !== undefined) return undefined;
  if (staticUrl === undefined && candidate.staticUrl !== undefined) return undefined;
  if (candidate.deploymentStopped !== undefined && typeof candidate.deploymentStopped !== "boolean") return undefined;
  let instances: RailwayDeployment["instances"];
  if (candidate.instances !== undefined) {
    if (!Array.isArray(candidate.instances)) return undefined;
    const allowed = new Set(["CRASHED", "CREATED", "EXITED", "INITIALIZING", "REMOVED", "REMOVING", "RESTARTING", "RUNNING", "SKIPPED", "STOPPED"]);
    const parsed = candidate.instances.map((entry) => {
      if (!isRecord(entry)) return undefined;
      const instanceId = requiredString(entry["id"]);
      const instanceStatus = entry["status"];
      return instanceId !== undefined && typeof instanceStatus === "string" && allowed.has(instanceStatus)
        ? { id: instanceId, status: instanceStatus as NonNullable<RailwayDeployment["instances"]>[number]["status"] }
        : undefined;
    });
    if (parsed.some((entry) => entry === undefined)) return undefined;
    instances = parsed as NonNullable<RailwayDeployment["instances"]>;
  }
  return {
    id,
    status: status as RailwayDeployment["status"],
    ...(url === undefined ? {} : { url }),
    ...(staticUrl === undefined ? {} : { staticUrl }),
    ...(candidate.deploymentStopped === undefined ? {} : { deploymentStopped: candidate.deploymentStopped }),
    ...(instances === undefined ? {} : { instances }),
  };
}

function connection<Node>(value: unknown): RailwayConnection<Node> | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as { readonly edges?: unknown; readonly pageInfo?: unknown };
  if (!Array.isArray(candidate.edges) || !isRecord(candidate.pageInfo)) return undefined;
  const pageInfo = candidate.pageInfo as { readonly hasNextPage?: unknown; readonly endCursor?: unknown };
  if (typeof pageInfo.hasNextPage !== "boolean") return undefined;
  const endCursor = optionalString(pageInfo.endCursor);
  if (endCursor === undefined && pageInfo.endCursor !== undefined) return undefined;
  const edges: Array<{ readonly cursor: string; readonly node: Node }> = [];
  for (const edge of candidate.edges) {
    if (!isRecord(edge)) return undefined;
    const edgeCandidate = edge as { readonly cursor?: unknown; readonly node?: unknown };
    const cursor = requiredString(edgeCandidate.cursor);
    if (cursor === undefined || !("node" in edge)) return undefined;
    edges.push({ cursor, node: edgeCandidate.node as Node });
  }
  return { edges, pageInfo: { hasNextPage: pageInfo.hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) } };
}

function requireInputId(value: string): void {
  if (value.length === 0) throw new RailwayReconcileExecutorError();
}

function requireDigestImageReference(value: string): void {
  if (/\s/.test(value)) throw new RailwayReconcileExecutorError();
  const parts = value.split("@");
  if (parts.length !== 2) throw new RailwayReconcileExecutorError();
  const [repository, digest] = parts;
  const lastSegment = repository?.slice(repository.lastIndexOf("/") + 1);
  if (!repository || !digest || !/^sha256:[a-f0-9]{64}$/.test(digest) || !lastSegment || lastSegment.includes(":")) {
    throw new RailwayReconcileExecutorError();
  }
}

function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

/**
 * Executes only the pinned, evidence-backed Railway documents in operations.ts.
 * It has no logging surface and never observes variable values after upsert.
 */
export class RailwayGraphqlReconcileExecutor implements RailwayReconcileExecutor {
  readonly #transport: RailwayReconcileExecutorTransport;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #deploymentObservationAttempts: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: RailwayGraphqlReconcileExecutorOptions) {
    const pageSize = options.pageSize ?? RAILWAY_RECONCILE_PAGE_SIZE;
    const maxPages = options.maxPages ?? RAILWAY_RECONCILE_MAX_PAGES;
    const deploymentObservationAttempts = options.deploymentObservationAttempts ?? RAILWAY_DEPLOYMENT_OBSERVATION_ATTEMPTS;
    if (!validBound(pageSize) || !validBound(maxPages) || !validBound(deploymentObservationAttempts)) throw new RailwayReconcileExecutorError();
    this.#transport = options.transport;
    this.#pageSize = pageSize;
    this.#maxPages = maxPages;
    this.#deploymentObservationAttempts = deploymentObservationAttempts;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async #execute<Variables extends RailwayGraphqlVariables, Data>(
    operation: RailwayOperation<string, Variables, Data>,
    variables: Variables,
  ): Promise<Data> {
    let result: RailwayTransportResult<Data>;
    try {
      result = await this.#transport.execute(operation, variables);
    } catch {
      throw new RailwayReconcileExecutorError();
    }
    if (result.outcome !== "success") throw new RailwayReconcileExecutorError();
    return result.data;
  }

  async #pages<Variables extends RailwayPaginationVariables & RailwayGraphqlVariables, Node, Data>(
    operation: RailwayOperation<string, Variables, Data>,
    initialVariables: Variables,
    select: (data: Data) => unknown,
    parse: (value: unknown) => Node | undefined,
  ): Promise<readonly Node[]> {
    let pages = 0;
    const result = await paginateRailwayConnection({
      initialVariables,
      fetchPage: async (variables) => {
        if (pages >= this.#maxPages) {
          return { outcome: "failure", failure: { kind: "invalid-response", operation: operation.name } };
        }
        pages += 1;
        let data: Data;
        try {
          data = await this.#execute(operation, variables);
        } catch {
          return { outcome: "failure", failure: { kind: "network-failure", operation: operation.name } };
        }
        let selected: unknown;
        try {
          selected = select(data);
        } catch {
          return { outcome: "failure", failure: { kind: "invalid-response", operation: operation.name } };
        }
        const parsed = connection<Node>(selected);
        if (parsed === undefined) {
          return { outcome: "failure", failure: { kind: "invalid-response", operation: operation.name } };
        }
        return { outcome: "success", data: parsed, metadata: { httpStatus: 200, rateLimit: {} } };
      },
    });
    if (result.outcome !== "success") throw new RailwayReconcileExecutorError();
    const parsed = result.nodes.map(parse);
    if (parsed.some((node) => node === undefined)) throw new RailwayReconcileExecutorError();
    return parsed as Node[];
  }

  async listProjects(input: { readonly workspaceId: string }): Promise<readonly RailwayProject[]> {
    requireInputId(input.workspaceId);
    const projects = await this.#pages(railwayProjects, {
      workspaceId: input.workspaceId,
      includeDeleted: false,
      first: this.#pageSize,
    }, (data) => data.projects, project);
    if (projects.some((entry) => entry.workspaceId !== input.workspaceId)) throw new RailwayReconcileExecutorError();
    return projects.filter((entry) => entry.deletedAt === undefined || entry.deletedAt === null);
  }

  async getProject(input: { readonly projectId: string }): Promise<RailwayProject | null> {
    requireInputId(input.projectId);
    const data = await this.#execute(railwayProject, { id: input.projectId });
    const projectValue = field(data, "project");
    if (projectValue === null) return null;
    const result = project(projectValue);
    if (result === undefined || result.id !== input.projectId) throw new RailwayReconcileExecutorError();
    return result.deletedAt === undefined || result.deletedAt === null ? result : null;
  }

  async createProject(input: RailwayReconcileProjectIntent): Promise<RailwayProject> {
    requireInputId(input.workspaceId);
    requireInputId(input.name);
    const data = await this.#execute(railwayProjectCreate, { input: { name: input.name, workspaceId: input.workspaceId } });
    const result = project(field(data, "projectCreate"));
    if (result === undefined || result.name !== input.name || result.workspaceId !== input.workspaceId) throw new RailwayReconcileExecutorError();
    return result;
  }

  async listEnvironments(input: { readonly projectId: string }): Promise<readonly RailwayEnvironment[]> {
    requireInputId(input.projectId);
    return this.#pages(railwayEnvironments, { projectId: input.projectId, first: this.#pageSize }, (data) => data.environments, environment);
  }

  async getEnvironment(input: { readonly projectId: string; readonly environmentId: string }): Promise<RailwayEnvironment | null> {
    requireInputId(input.projectId);
    requireInputId(input.environmentId);
    const data = await this.#execute(railwayEnvironmentVolumeInstances, {
      environmentId: input.environmentId,
      projectId: input.projectId,
      first: 1,
    });
    // This query is deliberately not an environment identity lookup: the live
    // schema exposes its project-scoped volume-instance inventory, which proves
    // the exact environment ID is usable at the recorded project scope.
    const environmentValue = field(data, "environment");
    if (environmentValue === null) return null;
    const result = environment(environmentValue);
    if (result === undefined || result.id !== input.environmentId) throw new RailwayReconcileExecutorError();
    return result;
  }

  async createEnvironment(input: { readonly projectId: string; readonly name: string }): Promise<RailwayEnvironment> {
    requireInputId(input.projectId);
    requireInputId(input.name);
    const data = await this.#execute(railwayEnvironmentCreate, { input: { projectId: input.projectId, name: input.name, skipInitialDeploys: true } });
    const result = environment(field(data, "environmentCreate"));
    if (result === undefined || result.name !== input.name) throw new RailwayReconcileExecutorError();
    return result;
  }

  async listServices(input: { readonly projectId: string }): Promise<readonly RailwayService[]> {
    requireInputId(input.projectId);
    return this.#pages(railwayProjectServices, { projectId: input.projectId, first: this.#pageSize }, (data) => data.project.services, service);
  }

  async createService(input: { readonly projectId: string; readonly environmentId: string; readonly name: string }): Promise<RailwayService> {
    requireInputId(input.projectId);
    requireInputId(input.environmentId);
    requireInputId(input.name);
    const data = await this.#execute(railwayServiceCreate, { input: { projectId: input.projectId, environmentId: input.environmentId, name: input.name } });
    const result = service(field(data, "serviceCreate"));
    if (result === undefined || result.name !== input.name) throw new RailwayReconcileExecutorError();
    return result;
  }

  async getServiceInstance(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayServiceInstance | null> {
    requireInputId(input.serviceId);
    requireInputId(input.environmentId);
    const data = await this.#execute(railwayServiceInstance, input);
    const instanceValue = field(data, "serviceInstance");
    if (instanceValue === null) return null;
    const result = serviceInstance(instanceValue);
    if (result === undefined || result.serviceId !== input.serviceId || result.environmentId !== input.environmentId) {
      throw new RailwayReconcileExecutorError();
    }
    return result;
  }

  async getLatestDeployment(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayDeployment | null> {
    requireInputId(input.serviceId);
    requireInputId(input.environmentId);
    const data = await this.#execute(railwayServiceInstanceLatestDeployment, input);
    const value = field(data, "serviceInstance");
    if (value === null || !isRecord(value)) return null;
    const latest = value["latestDeployment"];
    if (latest === null) return null;
    const result = deployment(latest);
    if (result === undefined) throw new RailwayReconcileExecutorError();
    return result;
  }

  /** Mutates source only; the caller separately owns any deployment start. */
  async updateServiceSource(input: { readonly serviceId: string; readonly environmentId: string; readonly image: string }): Promise<RailwayServiceInstance> {
    requireInputId(input.serviceId);
    requireInputId(input.environmentId);
    requireDigestImageReference(input.image);
    try {
      const data = await this.#execute(railwayServiceInstanceUpdate, {
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        input: { source: { image: input.image } },
      });
      if (field(data, "serviceInstanceUpdate") !== true) throw new RailwayReconcileExecutorError();
    } catch {
      // A lost mutation response is resolved only by exact configuration observation.
    }
    const observed = await this.getServiceInstance(input);
    if (observed === null || observed.source?.image !== input.image || (observed.source.repo ?? null) !== null) {
      throw new RailwayReconcileExecutorError();
    }
    return observed;
  }

  async waitForLatestDeployment(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayDeployment | null> {
    for (let attempt = 1; attempt <= this.#deploymentObservationAttempts; attempt += 1) {
      const deployment = await this.getLatestDeployment(input);
      if (deployment !== null) return deployment;
      if (attempt < this.#deploymentObservationAttempts) {
        await this.#sleep(RAILWAY_DEPLOYMENT_OBSERVATION_INTERVAL_MS);
      }
    }
    return null;
  }

  /**
   * Updates only the service command. Supplying `null` is an intentional
   * provider reset. Railway currently ignores JSON null for this field and
   * clears it only with an empty string; omitting the field also retains a previous maintenance
   * command and must never be treated as cleanup.
   */
  async setServiceStartCommand(input: { readonly serviceId: string; readonly environmentId: string; readonly startCommand: string | null }): Promise<void> {
    requireInputId(input.serviceId);
    requireInputId(input.environmentId);
    if (input.startCommand !== null && input.startCommand.trim().length === 0) throw new RailwayReconcileExecutorError();
    const data = await this.#execute(railwayServiceInstanceUpdate, {
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      input: { startCommand: input.startCommand ?? "" },
    });
    if (field(data, "serviceInstanceUpdate") !== true) throw new RailwayReconcileExecutorError();
  }

  async connectService(input: { readonly serviceId: string; readonly environmentId: string; readonly image: string; readonly startCommand?: string | undefined }): Promise<RailwayServiceInstance> {
    requireInputId(input.serviceId);
    requireInputId(input.environmentId);
    requireDigestImageReference(input.image);
    if (input.startCommand !== undefined) {
      await this.setServiceStartCommand({
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        startCommand: input.startCommand,
      });
    }
    // Railway live qualification showed that attaching `source` through
    // serviceInstanceUpdate does not create the source-change deployment.
    // Keep the optional command update separate, then use serviceConnect's
    // public image-only path exactly once to start deployment.
    const data = await this.#execute(railwayServiceConnect, { id: input.serviceId, input: { image: input.image } });
    const connected = service(field(data, "serviceConnect"));
    if (connected === undefined || connected.id !== input.serviceId) throw new RailwayReconcileExecutorError();
    const observed = await this.getServiceInstance({ serviceId: input.serviceId, environmentId: input.environmentId });
    if (observed === null) throw new RailwayReconcileExecutorError();
    return observed;
  }

  async listVolumeInstances(input: { readonly projectId: string; readonly environmentId: string }): Promise<readonly RailwayVolumeInstance[]> {
    requireInputId(input.projectId);
    requireInputId(input.environmentId);
    const instances = await this.#pages(
      railwayEnvironmentVolumeInstances,
      { projectId: input.projectId, environmentId: input.environmentId, first: this.#pageSize },
      (data) => data.environment.volumeInstances,
      volumeInstance,
    );
    return instances.filter((instance) => (
      (instance.deletedAt === undefined || instance.deletedAt === null)
      && instance.isPendingDeletion !== true
    ));
  }

  async getVolume(input: { readonly projectId: string; readonly volumeId: string }): Promise<RailwayVolume | null> {
    requireInputId(input.projectId);
    requireInputId(input.volumeId);
    const volumes = await this.#pages(railwayProjectVolumes, { projectId: input.projectId, first: this.#pageSize }, (data) => data.project.volumes, volume);
    return volumes.find((entry) => entry.id === input.volumeId) ?? null;
  }

  async createVolume(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly mountPath: string; readonly region?: string | undefined }): Promise<RailwayVolume> {
    requireInputId(input.projectId);
    requireInputId(input.environmentId);
    requireInputId(input.serviceId);
    requireInputId(input.mountPath);
    const data = await this.#execute(railwayVolumeCreate, {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        mountPath: input.mountPath,
        ...(input.region === undefined ? {} : { region: input.region }),
      },
    });
    const result = volume(field(data, "volumeCreate"));
    if (result === undefined || result.projectId !== input.projectId) throw new RailwayReconcileExecutorError();
    return result;
  }

  async upsertVariables(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly variables: Readonly<Record<string, string>> }): Promise<void> {
    requireInputId(input.projectId);
    requireInputId(input.environmentId);
    requireInputId(input.serviceId);
    const data = await this.#execute(railwayVariableCollectionUpsert, {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        variables: input.variables,
        skipDeploys: true,
      },
    });
    if (field(data, "variableCollectionUpsert") !== true) throw new RailwayReconcileExecutorError();
  }

  /** Removes one exact service-scoped temporary variable without reading its value. */
  async deleteVariable(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly name: string }): Promise<void> {
    requireInputId(input.projectId);
    requireInputId(input.environmentId);
    requireInputId(input.serviceId);
    requireInputId(input.name);
    const data = await this.#execute(railwayVariableDelete, { input });
    if (field(data, "variableDelete") !== true) throw new RailwayReconcileExecutorError();
  }

  async listDomains(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }): Promise<readonly RailwayServiceDomain[]> {
    requireInputId(input.projectId);
    requireInputId(input.environmentId);
    requireInputId(input.serviceId);
    const data = await this.#execute(railwayDomains, input);
    const domains = field(data, "domains");
    const value = field(domains, "serviceDomains");
    if (!Array.isArray(value)) throw new RailwayReconcileExecutorError();
    const result = value.map(domain);
    if (result.some((entry) => entry === undefined)) throw new RailwayReconcileExecutorError();
    return result as RailwayServiceDomain[];
  }

  async createDomain(input: { readonly serviceId: string; readonly environmentId: string; readonly targetPort: number }): Promise<RailwayServiceDomain> {
    requireInputId(input.serviceId);
    requireInputId(input.environmentId);
    if (!Number.isSafeInteger(input.targetPort) || input.targetPort < 1 || input.targetPort > 65_535) throw new RailwayReconcileExecutorError();
    const data = await this.#execute(railwayServiceDomainCreate, { input });
    const result = domain(field(data, "serviceDomainCreate"));
    if (result === undefined || result.targetPort !== input.targetPort) throw new RailwayReconcileExecutorError();
    return result;
  }

  async listDeployments(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }): Promise<readonly RailwayDeployment[]> {
    const deployments = await this.listDeploymentsRaw(input);
    return deployments.filter((entry) => (
      entry.status !== "REMOVED" && entry.status !== "REMOVING" && entry.status !== "SKIPPED"
    ));
  }

  async listDeploymentsRaw(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }): Promise<readonly RailwayDeployment[]> {
    requireInputId(input.projectId);
    requireInputId(input.environmentId);
    requireInputId(input.serviceId);
    const deployments = await this.#pages(
      railwayDeployments,
      { input: { ...input, includeDeleted: false }, first: this.#pageSize },
      (data) => data.deployments,
      deployment,
    );
    return deployments;
  }

  async createDeployment(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayDeployment> {
    requireInputId(input.serviceId);
    requireInputId(input.environmentId);
    const data = await this.#execute(railwayServiceInstanceDeploy, input);
    const deploymentId = requiredString(field(data, "serviceInstanceDeployV2"));
    if (deploymentId === undefined) throw new RailwayReconcileExecutorError();
    const observed = await this.#execute(railwayDeployment, { id: deploymentId });
    const result = deployment(field(observed, "deployment"));
    if (result === undefined || result.id !== deploymentId) throw new RailwayReconcileExecutorError();
    return result;
  }

  async getDeployment(input: { readonly deploymentId: string }): Promise<RailwayDeployment> {
    requireInputId(input.deploymentId);
    const data = await this.#execute(railwayDeployment, { id: input.deploymentId });
    const result = deployment(field(data, "deployment"));
    if (result === undefined || result.id !== input.deploymentId) throw new RailwayReconcileExecutorError();
    return result;
  }

  async deleteService(input: { readonly serviceId: string; readonly environmentId: string }): Promise<void> {
    requireInputId(input.serviceId);
    requireInputId(input.environmentId);
    const data = await this.#execute(railwayServiceDelete, { id: input.serviceId, environmentId: input.environmentId });
    if (field(data, "serviceDelete") !== true) throw new RailwayReconcileExecutorError();
  }

  async inventorySurvivors(input: { readonly projectId?: string | undefined; readonly environmentId?: string | undefined }): Promise<readonly RailwayReconcileSurvivingResource[]> {
    if (input.projectId === undefined) return [];
    requireInputId(input.projectId);
    const observed = await this.getProject({ projectId: input.projectId });
    if (observed === null) return [];
    const survivors: RailwayReconcileSurvivingResource[] = [{ kind: "railway.project", id: observed.id, name: observed.name }];
    const services = await this.listServices({ projectId: input.projectId });
    survivors.push(...services.map((entry) => ({ kind: "railway.service", id: entry.id, name: entry.name })));
    if (input.environmentId === undefined) {
      const volumes = await this.#pages(
        railwayProjectVolumes,
        { projectId: input.projectId, first: this.#pageSize },
        (data) => data.project.volumes,
        volume,
      );
      survivors.push(...volumes.map((entry) => ({ kind: "railway.volume", id: entry.id, name: entry.name })));
      return survivors;
    }
    const volumeInstances = await this.listVolumeInstances({
      projectId: input.projectId,
      environmentId: input.environmentId,
    });
    survivors.push(...volumeInstances.map((entry) => ({ kind: "railway.volume", id: entry.volumeId })));
    const environments = await this.listEnvironments({ projectId: input.projectId });
    const environmentEntry = environments.find((entry) => entry.id === input.environmentId);
    if (environmentEntry === undefined) return survivors;
    survivors.push({ kind: "railway.environment", id: environmentEntry.id, name: environmentEntry.name });
    return survivors;
  }
}
