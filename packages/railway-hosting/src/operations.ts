import type { RailwayConnection, RailwayOperation } from "./types";

export interface RailwayProject {
  readonly id: string;
  readonly name: string;
  readonly primaryEnvironmentId?: string | null | undefined;
  readonly workspaceId?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

export interface RailwayEnvironment {
  readonly id: string;
  readonly name: string;
}

export interface RailwayService {
  readonly id: string;
  readonly name: string;
  readonly templateId?: string | null | undefined;
  readonly templateServiceId?: string | null | undefined;
  readonly templateThreadSlug?: string | null | undefined;
}

/**
 * Railway exposes a source as either a Docker/OCI image or a repository.  The
 * reconciler uses this read-only shape to prove that an image attachment made
 * it to the exact service instance before it records the effect.
 */
export interface RailwayServiceSource {
  readonly image?: string | null | undefined;
  readonly repo?: string | null | undefined;
}

export interface RailwayServiceInstance {
  readonly id: string;
  readonly serviceId: string;
  readonly environmentId: string;
  readonly source?: RailwayServiceSource | null | undefined;
  readonly startCommand?: string | null | undefined;
  /** Railway's provider-declared most recent deployment for this service/environment. */
  readonly latestDeployment?: RailwayDeployment | null | undefined;
}

export interface RailwayVolume {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
}

export interface RailwayVolumeInstance {
  readonly id: string;
  readonly volumeId: string;
  readonly mountPath: string;
  readonly serviceId?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
  readonly isPendingDeletion?: boolean | undefined;
}

export interface RailwayVolumeInstanceBackup {
  readonly id: string;
  readonly name?: string | null | undefined;
  readonly createdAt: string;
  readonly expiresAt?: string | null | undefined;
  readonly usedMB?: number | null | undefined;
  readonly referencedMB?: number | null | undefined;
}

export type RailwayWorkflowStatus = "Complete" | "Error" | "NotFound" | "Running";

export interface RailwayWorkflowResult {
  readonly status: RailwayWorkflowStatus;
  /** Provider-controlled detail; maintenance code must never persist or render it. */
  readonly error?: string | null | undefined;
}

export interface RailwayServiceDomain {
  readonly id: string;
  readonly domain: string;
  readonly targetPort?: number | null | undefined;
}

export interface RailwayDeployment {
  readonly id: string;
  readonly status: RailwayDeploymentStatus;
  readonly url?: string | null | undefined;
  readonly staticUrl?: string | null | undefined;
  readonly deploymentStopped?: boolean | undefined;
  readonly instances?: readonly RailwayDeploymentInstance[] | undefined;
}

export interface RailwayDeploymentInstance {
  readonly id: string;
  readonly status: RailwayDeploymentInstanceStatus;
}

export type RailwayDeploymentInstanceStatus =
  | "CRASHED"
  | "CREATED"
  | "EXITED"
  | "INITIALIZING"
  | "REMOVED"
  | "REMOVING"
  | "RESTARTING"
  | "RUNNING"
  | "SKIPPED"
  | "STOPPED";

/** Exact members of Railway's `DeploymentStatus` enum, inspected on 2026-08-03. */
export type RailwayDeploymentStatus =
  | "BUILDING"
  | "CRASHED"
  | "DEPLOYING"
  | "FAILED"
  | "INITIALIZING"
  | "NEEDS_APPROVAL"
  | "QUEUED"
  | "REMOVED"
  | "REMOVING"
  | "SKIPPED"
  | "SLEEPING"
  | "SUCCESS"
  | "WAITING";

export type RailwayEnvironmentVariables = Readonly<Record<string, string>>;

const operation = <Name extends string, Variables extends Record<string, unknown>, Data>(
  name: Name,
  document: string,
  isMutation: boolean,
): RailwayOperation<Name, Variables, Data> => ({ name, document, isMutation });

/** Read-only discovery: current user and its workspaces. */
export const railwayMe = operation<
  "RailwayMe",
  Record<string, never>,
  { readonly me: { readonly id: string; readonly name?: string | null; readonly workspaces: readonly { readonly id: string; readonly name: string }[] } }
>(
  "RailwayMe",
  `query RailwayMe { me { id name workspaces { id name } } }`,
  false,
);

export const railwayProjects = operation<
  "RailwayProjects",
  { readonly workspaceId?: string | null; readonly includeDeleted: boolean; readonly after?: string | null; readonly first: number },
  { readonly projects: RailwayConnection<RailwayProject> }
>(
  "RailwayProjects",
  `query RailwayProjects($workspaceId: String, $includeDeleted: Boolean!, $after: String, $first: Int!) {
    projects(workspaceId: $workspaceId, includeDeleted: $includeDeleted, after: $after, first: $first) {
      edges { cursor node { id name primaryEnvironmentId workspaceId deletedAt } }
      pageInfo { endCursor hasNextPage }
    }
  }`,
  false,
);

export const railwayProject = operation<
  "RailwayProject",
  { readonly id: string },
  { readonly project: RailwayProject }
>(
  "RailwayProject",
  `query RailwayProject($id: String!) { project(id: $id) { id name primaryEnvironmentId workspaceId deletedAt } }`,
  false,
);

/** Read-before-create and final cleanup inventory of project services. */
export const railwayProjectServices = operation<
  "RailwayProjectServices",
  { readonly projectId: string; readonly after?: string | null; readonly first: number },
  { readonly project: { readonly services: RailwayConnection<RailwayService> } }
>(
  "RailwayProjectServices",
  `query RailwayProjectServices($projectId: String!, $after: String, $first: Int!) {
    project(id: $projectId) {
      services(after: $after, first: $first) {
        edges { cursor node { id name templateId templateServiceId templateThreadSlug } }
        pageInfo { endCursor hasNextPage }
      }
    }
  }`,
  false,
);

/**
 * Template adoption must inspect the rendered collection to move generated
 * values directly into OS credential custody. Callers must never persist or
 * render this response.
 */
export const railwayVariables = operation<
  "RailwayVariables",
  { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly unrendered: boolean },
  { readonly variables: RailwayEnvironmentVariables }
>(
  "RailwayVariables",
  `query RailwayVariables($projectId: String!, $environmentId: String!, $serviceId: String!, $unrendered: Boolean!) {
    variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: $unrendered)
  }`,
  false,
);

/** Volume identities exist at project scope; mount attachment is on VolumeInstance. */
export const railwayProjectVolumes = operation<
  "RailwayProjectVolumes",
  { readonly projectId: string; readonly after?: string | null; readonly first: number },
  { readonly project: { readonly volumes: RailwayConnection<RailwayVolume> } }
>(
  "RailwayProjectVolumes",
  `query RailwayProjectVolumes($projectId: String!, $after: String, $first: Int!) {
    project(id: $projectId) {
      volumes(after: $after, first: $first) {
        edges { cursor node { id name projectId } }
        pageInfo { endCursor hasNextPage }
      }
    }
  }`,
  false,
);

export const railwayEnvironments = operation<
  "RailwayEnvironments",
  { readonly projectId: string; readonly after?: string | null; readonly first: number },
  { readonly environments: RailwayConnection<RailwayEnvironment> }
>(
  "RailwayEnvironments",
  `query RailwayEnvironments($projectId: String!, $after: String, $first: Int!) {
    environments(projectId: $projectId, after: $after, first: $first) {
      edges { cursor node { id name } }
      pageInfo { endCursor hasNextPage }
    }
  }`,
  false,
);

/** Environment-scoped inventory resolves the volume's actual mount attachment. */
export const railwayEnvironmentVolumeInstances = operation<
  "RailwayEnvironmentVolumeInstances",
  { readonly environmentId: string; readonly projectId?: string; readonly after?: string | null; readonly first: number },
  { readonly environment: { readonly id: string; readonly name: string; readonly volumeInstances: RailwayConnection<RailwayVolumeInstance> } }
>(
  "RailwayEnvironmentVolumeInstances",
  `query RailwayEnvironmentVolumeInstances($environmentId: String!, $projectId: String, $after: String, $first: Int!) {
    environment(id: $environmentId, projectId: $projectId) {
      id
      name
      volumeInstances(after: $after, first: $first) {
        edges { cursor node { id volumeId serviceId mountPath deletedAt isPendingDeletion } }
        pageInfo { endCursor hasNextPage }
      }
    }
  }`,
  false,
);

export const railwayProjectCreate = operation<
  "RailwayProjectCreate",
  { readonly input: { readonly name?: string; readonly description?: string; readonly workspaceId?: string; readonly defaultEnvironmentName?: string } },
  { readonly projectCreate: RailwayProject }
>(
  "RailwayProjectCreate",
  `mutation RailwayProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) { id name primaryEnvironmentId workspaceId }
  }`,
  true,
);

export const railwayEnvironmentCreate = operation<
  "RailwayEnvironmentCreate",
  { readonly input: { readonly projectId: string; readonly name: string; readonly skipInitialDeploys?: boolean } },
  { readonly environmentCreate: RailwayEnvironment }
>(
  "RailwayEnvironmentCreate",
  `mutation RailwayEnvironmentCreate($input: EnvironmentCreateInput!) {
    environmentCreate(input: $input) { id name }
  }`,
  true,
);

export const railwayServiceCreate = operation<
  "RailwayServiceCreate",
  { readonly input: { readonly projectId: string; readonly environmentId?: string; readonly name?: string; readonly source?: { readonly image?: string } } },
  { readonly serviceCreate: RailwayService }
>(
  "RailwayServiceCreate",
  `mutation RailwayServiceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
  true,
);

/** Attach a Docker Hub or GHCR image only after an empty service has its variables. */
export const railwayServiceConnect = operation<
  "RailwayServiceConnect",
  { readonly id: string; readonly input: { readonly image: string } },
  { readonly serviceConnect: RailwayService }
>(
  "RailwayServiceConnect",
  `mutation RailwayServiceConnect($id: String!, $input: ServiceConnectInput!) {
    serviceConnect(id: $id, input: $input) { id name }
  }`,
  true,
);

/**
 * Exact service-instance source observation used for serviceConnect recovery.
 * `Query.serviceInstance` and `ServiceInstance.source { image repo }` were
 * read-only schema-inspected with Railway CLI 5.30.4 on 2026-08-04.
 */
export const railwayServiceInstance = operation<
  "RailwayServiceInstance",
  { readonly serviceId: string; readonly environmentId: string },
  { readonly serviceInstance: RailwayServiceInstance }
>(
  "RailwayServiceInstance",
  `query RailwayServiceInstance($serviceId: String!, $environmentId: String!) {
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
      id
      serviceId
      environmentId
      startCommand
      source { image repo }
    }
  }`,
  false,
);

/** Latest-deployment observation is isolated from exact source/command reads. */
export const railwayServiceInstanceLatestDeployment = operation<
  "RailwayServiceInstanceLatestDeployment",
  { readonly serviceId: string; readonly environmentId: string },
  { readonly serviceInstance: { readonly latestDeployment: RailwayDeployment | null } | null }
>(
  "RailwayServiceInstanceLatestDeployment",
  `query RailwayServiceInstanceLatestDeployment($serviceId: String!, $environmentId: String!) {
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
      latestDeployment { id status }
    }
  }`,
  false,
);

/** Service image, health check, region and command configuration update. */
export const railwayServiceInstanceUpdate = operation<
  "RailwayServiceInstanceUpdate",
  {
    readonly serviceId: string;
    readonly environmentId?: string;
    readonly input: {
      readonly source?: { readonly image?: string };
      readonly healthcheckPath?: string;
      readonly healthcheckTimeout?: number;
      readonly region?: string;
      /** `null` is Railway's explicit reset value; omission preserves the current command. */
      readonly startCommand?: string | null;
    };
  },
  { readonly serviceInstanceUpdate: boolean }
>(
  "RailwayServiceInstanceUpdate",
  `mutation RailwayServiceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
    serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
  }`,
  true,
);

/** Values remain request-only: Railway variables may contain secrets. */
export const railwayVariableCollectionUpsert = operation<
  "RailwayVariableCollectionUpsert",
  { readonly input: { readonly projectId: string; readonly environmentId: string; readonly serviceId?: string; readonly variables: RailwayEnvironmentVariables; readonly skipDeploys?: boolean } },
  { readonly variableCollectionUpsert: boolean }
>(
  "RailwayVariableCollectionUpsert",
  `mutation RailwayVariableCollectionUpsert($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }`,
  true,
);

/**
 * Deletes one exact service-scoped variable. Values are never queried or
 * returned, including while removing one-shot maintenance credentials.
 */
export const railwayVariableDelete = operation<
  "RailwayVariableDelete",
  { readonly input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly name: string } },
  { readonly variableDelete: boolean }
>(
  "RailwayVariableDelete",
  `mutation RailwayVariableDelete($input: VariableDeleteInput!) {
    variableDelete(input: $input)
  }`,
  true,
);

export const railwayVolumeCreate = operation<
  "RailwayVolumeCreate",
  { readonly input: { readonly projectId: string; readonly mountPath: string; readonly serviceId?: string; readonly environmentId?: string; readonly region?: string } },
  { readonly volumeCreate: RailwayVolume }
>(
  "RailwayVolumeCreate",
  `mutation RailwayVolumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name projectId } }`,
  true,
);

/** Public Railway volume-backup API, schema-inspected on 2026-08-11. */
export const railwayVolumeInstanceBackupList = operation<
  "RailwayVolumeInstanceBackupList",
  { readonly volumeInstanceId: string },
  { readonly volumeInstanceBackupList: readonly RailwayVolumeInstanceBackup[] }
>(
  "RailwayVolumeInstanceBackupList",
  `query RailwayVolumeInstanceBackupList($volumeInstanceId: String!) {
    volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId) {
      id
      name
      createdAt
      expiresAt
      usedMB
      referencedMB
    }
  }`,
  false,
);

export const railwayVolumeInstanceBackupCreate = operation<
  "RailwayVolumeInstanceBackupCreate",
  { readonly volumeInstanceId: string; readonly name?: string },
  { readonly volumeInstanceBackupCreate: { readonly workflowId?: string | null } }
>(
  "RailwayVolumeInstanceBackupCreate",
  `mutation RailwayVolumeInstanceBackupCreate($volumeInstanceId: String!, $name: String) {
    volumeInstanceBackupCreate(volumeInstanceId: $volumeInstanceId, name: $name) { workflowId }
  }`,
  true,
);

export const railwayVolumeInstanceBackupLock = operation<
  "RailwayVolumeInstanceBackupLock",
  { readonly volumeInstanceBackupId: string; readonly volumeInstanceId: string },
  { readonly volumeInstanceBackupLock: boolean }
>(
  "RailwayVolumeInstanceBackupLock",
  `mutation RailwayVolumeInstanceBackupLock($volumeInstanceBackupId: String!, $volumeInstanceId: String!) {
    volumeInstanceBackupLock(volumeInstanceBackupId: $volumeInstanceBackupId, volumeInstanceId: $volumeInstanceId)
  }`,
  true,
);

export const railwayVolumeInstanceBackupRestore = operation<
  "RailwayVolumeInstanceBackupRestore",
  { readonly volumeInstanceBackupId: string; readonly volumeInstanceId: string },
  { readonly volumeInstanceBackupRestore: { readonly workflowId?: string | null } }
>(
  "RailwayVolumeInstanceBackupRestore",
  `mutation RailwayVolumeInstanceBackupRestore($volumeInstanceBackupId: String!, $volumeInstanceId: String!) {
    volumeInstanceBackupRestore(volumeInstanceBackupId: $volumeInstanceBackupId, volumeInstanceId: $volumeInstanceId) { workflowId }
  }`,
  true,
);

export const railwayWorkflowStatus = operation<
  "RailwayWorkflowStatus",
  { readonly workflowId: string },
  { readonly workflowStatus: RailwayWorkflowResult }
>(
  "RailwayWorkflowStatus",
  `query RailwayWorkflowStatus($workflowId: String!) {
    workflowStatus(workflowId: $workflowId) { status error }
  }`,
  false,
);

export const railwayDeploymentStop = operation<
  "RailwayDeploymentStop",
  { readonly id: string },
  { readonly deploymentStop: boolean }
>(
  "RailwayDeploymentStop",
  `mutation RailwayDeploymentStop($id: String!) { deploymentStop(id: $id) }`,
  true,
);

export const railwayServiceDomainCreate = operation<
  "RailwayServiceDomainCreate",
  { readonly input: { readonly serviceId: string; readonly environmentId: string; readonly targetPort?: number } },
  { readonly serviceDomainCreate: RailwayServiceDomain }
>(
  "RailwayServiceDomainCreate",
  `mutation RailwayServiceDomainCreate($input: ServiceDomainCreateInput!) {
    serviceDomainCreate(input: $input) { id domain targetPort }
  }`,
  true,
);

export const railwayServiceInstanceDeploy = operation<
  "RailwayServiceInstanceDeploy",
  { readonly serviceId: string; readonly environmentId: string; readonly commitSha?: string },
  { readonly serviceInstanceDeployV2: string }
>(
  "RailwayServiceInstanceDeploy",
  `mutation RailwayServiceInstanceDeploy($serviceId: String!, $environmentId: String!, $commitSha: String) {
    serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
  }`,
  true,
);

export const railwayDeployment = operation<
  "RailwayDeployment",
  { readonly id: string },
  { readonly deployment: RailwayDeployment }
>(
  "RailwayDeployment",
  `query RailwayDeployment($id: String!) {
    deployment(id: $id) {
      id
      status
      url
      staticUrl
      deploymentStopped
      instances { id status }
    }
  }`,
  false,
);

/**
 * Scoped deployment inventory recovers a deployment whose create response
 * arrived before the driver durably recorded its ID.
 */
export const railwayDeployments = operation<
  "RailwayDeployments",
  {
    readonly input: {
      readonly projectId: string;
      readonly environmentId: string;
      readonly serviceId: string;
      readonly includeDeleted?: boolean;
    };
    readonly after?: string | null;
    readonly first: number;
  },
  { readonly deployments: RailwayConnection<Pick<RailwayDeployment, "id" | "status">> }
>(
  "RailwayDeployments",
  `query RailwayDeployments($input: DeploymentListInput!, $after: String, $first: Int!) {
    deployments(input: $input, after: $after, first: $first) {
      edges { cursor node { id status } }
      pageInfo { endCursor hasNextPage }
    }
  }`,
  false,
);

export const railwayDomains = operation<
  "RailwayDomains",
  { readonly projectId: string; readonly environmentId: string; readonly serviceId: string },
  { readonly domains: { readonly serviceDomains: readonly RailwayServiceDomain[]; readonly customDomains: readonly unknown[] } }
>(
  "RailwayDomains",
  `query RailwayDomains($projectId: String!, $environmentId: String!, $serviceId: String!) {
    domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
      serviceDomains { id domain targetPort }
      customDomains { id }
    }
  }`,
  false,
);

export const railwayServiceDelete = operation<
  "RailwayServiceDelete",
  { readonly id: string; readonly environmentId?: string },
  { readonly serviceDelete: boolean }
>(
  "RailwayServiceDelete",
  `mutation RailwayServiceDelete($id: String!, $environmentId: String) { serviceDelete(id: $id, environmentId: $environmentId) }`,
  true,
);

export const railwayServiceDomainDelete = operation<
  "RailwayServiceDomainDelete",
  { readonly id: string },
  { readonly serviceDomainDelete: boolean }
>(
  "RailwayServiceDomainDelete",
  `mutation RailwayServiceDomainDelete($id: String!) { serviceDomainDelete(id: $id) }`,
  true,
);

export const railwayVolumeDelete = operation<
  "RailwayVolumeDelete",
  { readonly volumeId: string },
  { readonly volumeDelete: boolean }
>(
  "RailwayVolumeDelete",
  `mutation RailwayVolumeDelete($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`,
  true,
);

export const railwayProjectDelete = operation<
  "RailwayProjectDelete",
  { readonly id: string },
  { readonly projectDelete: boolean }
>(
  "RailwayProjectDelete",
  `mutation RailwayProjectDelete($id: String!) { projectDelete(id: $id) }`,
  true,
);
