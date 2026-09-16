import { describe, expect, test } from "bun:test";

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
  railwayServiceDomainCreate,
  railwayServiceInstance,
  railwayServiceInstanceLatestDeployment,
  railwayServiceInstanceDeploy,
  railwayServiceInstanceUpdate,
  railwayVariableDelete,
  railwayVariableCollectionUpsert,
  railwayVolumeCreate,
} from "../../src/operations";
import {
  RailwayGraphqlReconcileExecutor,
  RailwayReconcileExecutorError,
  type RailwayReconcileExecutorTransport,
} from "../../src/reconcile-executor";
import type {
  RailwayGraphqlVariables,
  RailwayOperation,
  RailwayOperationData,
  RailwayOperationVariables,
  RailwayTransportResult,
} from "../../src/types";

const metadata = { httpStatus: 200, rateLimit: {} } as const;

interface Call {
  readonly name: string;
  readonly variables: unknown;
}

class FixtureTransport implements RailwayReconcileExecutorTransport {
  readonly calls: Call[] = [];
  #startCommand: string | null = null;

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push({ name: operation.name, variables });
    const after = (variables as { readonly after?: string | null }).after;
    const page = <Node>(nodes: readonly Node[]) => ({
      edges: nodes.map((node, index) => ({ cursor: `cursor-${index + 1}`, node })),
      pageInfo: { hasNextPage: false, endCursor: after ?? null },
    });
    const data: unknown = operation.name === railwayProjects.name
      ? { projects: page([{ id: "project-1", name: "nautilo", workspaceId: "workspace-1" }]) }
      : operation.name === railwayProject.name
        ? { project: { id: "project-1", name: "nautilo", workspaceId: "workspace-1" } }
        : operation.name === railwayProjectCreate.name
          ? { projectCreate: { id: "project-1", name: "nautilo", workspaceId: "workspace-1" } }
          : operation.name === railwayEnvironments.name
            ? { environments: page([{ id: "environment-1", name: "production" }]) }
            : operation.name === railwayEnvironmentVolumeInstances.name
              ? {
                environment: {
                  id: "environment-1",
                  name: "production",
                  volumeInstances: page([{ id: "volume-instance-1", volumeId: "volume-1", serviceId: "service-1", mountPath: "/data" }]),
                },
              }
              : operation.name === railwayEnvironmentCreate.name
                ? { environmentCreate: { id: "environment-1", name: "production" } }
                : operation.name === railwayProjectServices.name
                  ? { project: { services: page([{ id: "service-1", name: "nautilo-server" }]) } }
                  : operation.name === railwayServiceCreate.name
                  ? { serviceCreate: { id: "service-1", name: "nautilo-server" } }
                    : operation.name === railwayServiceConnect.name
                      ? { serviceConnect: { id: "service-1", name: "nautilo-server" } }
                      : operation.name === railwayServiceInstance.name
                        ? {
                          serviceInstance: {
                            id: "instance-1",
                            serviceId: "service-1",
                            environmentId: "environment-1",
                            startCommand: this.#startCommand,
                            source: { image: `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}`, repo: null },
                            latestDeployment: { id: "deployment-1", status: "SUCCESS" },
                          },
                        }
                        : operation.name === railwayServiceInstanceLatestDeployment.name
                          ? { serviceInstance: { latestDeployment: { id: "deployment-1", status: "SUCCESS" } } }
                        : operation.name === railwayServiceInstanceUpdate.name
                          ? (() => {
                            const startCommand = (variables as {
                              readonly input?: { readonly startCommand?: unknown };
                            }).input?.startCommand;
                            if (typeof startCommand === "string" || startCommand === null) this.#startCommand = startCommand;
                            return { serviceInstanceUpdate: true };
                          })()
                    : operation.name === railwayProjectVolumes.name
                      ? { project: { volumes: page([{ id: "volume-1", name: "data", projectId: "project-1" }]) } }
                      : operation.name === railwayVolumeCreate.name
                        ? { volumeCreate: { id: "volume-1", name: "data", projectId: "project-1" } }
                        : operation.name === railwayVariableCollectionUpsert.name
                          ? { variableCollectionUpsert: true }
                          : operation.name === railwayVariableDelete.name
                            ? { variableDelete: true }
                          : operation.name === railwayDomains.name
                            ? { domains: { serviceDomains: [{ id: "domain-1", domain: "nautilo.up.railway.app", targetPort: 3001 }], customDomains: [] } }
                            : operation.name === railwayServiceDomainCreate.name
                              ? { serviceDomainCreate: { id: "domain-1", domain: "nautilo.up.railway.app", targetPort: 3001 } }
                              : operation.name === railwayDeployments.name
                                ? { deployments: page([
                                  { id: "deployment-removed", status: "REMOVED" },
                                  { id: "deployment-skipped", status: "SKIPPED" },
                                  { id: "deployment-1", status: "SUCCESS" },
                                ]) }
                                : operation.name === railwayServiceInstanceDeploy.name
                                  ? { serviceInstanceDeployV2: "deployment-1" }
                                  : operation.name === railwayDeployment.name
                                    ? { deployment: { id: "deployment-1", status: "SUCCESS", url: "https://nautilo.up.railway.app" } }
                                    : undefined;
    if (data === undefined) throw new Error(`unexpected operation ${operation.name}`);
    return { outcome: "success", data: data as RailwayOperationData<Operation>, metadata };
  }
}

function mismatchTransport(name: string, data: unknown): RailwayReconcileExecutorTransport {
  return {
    async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
      operation: Operation,
      _variables: RailwayOperationVariables<Operation>,
    ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
      if (operation.name !== name) throw new Error("unexpected operation");
      return { outcome: "success", data: data as RailwayOperationData<Operation>, metadata };
    },
  };
}

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("RailwayGraphqlReconcileExecutor", () => {
  test("updates source without deploying and recovers a lost mutation response by exact observation", async () => {
    const calls: string[] = [];
    const digest = `ghcr.io/nautilo/server@sha256:${"b".repeat(64)}`;
    const transport: RailwayReconcileExecutorTransport = {
      async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
        operation: Operation,
        _variables: RailwayOperationVariables<Operation>,
      ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
        calls.push(operation.name);
        if (operation.name === railwayServiceInstanceUpdate.name) throw new Error("provider-secret");
        if (operation.name !== railwayServiceInstance.name) throw new Error("unexpected operation");
        return { outcome: "success", data: { serviceInstance: { id: "instance-1", serviceId: "service-1",
          environmentId: "environment-1", startCommand: null, source: { image: digest, repo: null } } } as RailwayOperationData<Operation>, metadata };
      },
    };
    const subject = new RailwayGraphqlReconcileExecutor({ transport });
    expect(await subject.updateServiceSource({ serviceId: "service-1", environmentId: "environment-1", image: digest }))
      .toMatchObject({ serviceId: "service-1", source: { image: digest, repo: null } });
    expect(calls).toEqual([railwayServiceInstanceUpdate.name, railwayServiceInstance.name]);
    expect(calls).not.toContain(railwayServiceInstanceDeploy.name);
    expect(calls).not.toContain(railwayServiceInstanceLatestDeployment.name);
  });
  test("uses the pinned scoped operation set and maps exact receipt identities", async () => {
    const transport = new FixtureTransport();
    const subject = new RailwayGraphqlReconcileExecutor({ transport });

    expect(await subject.listProjects({ workspaceId: "workspace-1" })).toEqual([
      { id: "project-1", name: "nautilo", workspaceId: "workspace-1" },
    ]);
    expect(transport.calls.find((call) => call.name === railwayProjects.name)?.variables).toEqual({
      workspaceId: "workspace-1",
      includeDeleted: false,
      first: 100,
    });
    expect(await subject.getProject({ projectId: "project-1" })).toEqual({ id: "project-1", name: "nautilo", workspaceId: "workspace-1" });
    expect(await subject.createProject({ name: "nautilo", workspaceId: "workspace-1" })).toEqual({ id: "project-1", name: "nautilo", workspaceId: "workspace-1" });
    expect(await subject.listEnvironments({ projectId: "project-1" })).toEqual([{ id: "environment-1", name: "production" }]);
    expect(await subject.getEnvironment({ projectId: "project-1", environmentId: "environment-1" })).toEqual({ id: "environment-1", name: "production" });
    expect(await subject.createEnvironment({ projectId: "project-1", name: "production" })).toEqual({ id: "environment-1", name: "production" });
    expect(await subject.listServices({ projectId: "project-1" })).toEqual([{ id: "service-1", name: "nautilo-server" }]);
    expect(await subject.createService({ projectId: "project-1", environmentId: "environment-1", name: "nautilo-server" })).toEqual({ id: "service-1", name: "nautilo-server" });
    expect(await subject.getServiceInstance({ serviceId: "service-1", environmentId: "environment-1" })).toEqual({
      id: "instance-1",
      serviceId: "service-1",
      environmentId: "environment-1",
      startCommand: null,
      source: { image: `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}`, repo: null },
      latestDeployment: { id: "deployment-1", status: "SUCCESS" },
    });
    expect(await subject.getLatestDeployment({ serviceId: "service-1", environmentId: "environment-1" })).toEqual({ id: "deployment-1", status: "SUCCESS" });
    expect(await subject.connectService({ serviceId: "service-1", environmentId: "environment-1", image: `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}` })).toEqual({
      id: "instance-1",
      serviceId: "service-1",
      environmentId: "environment-1",
      startCommand: null,
      source: { image: `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}`, repo: null },
      latestDeployment: { id: "deployment-1", status: "SUCCESS" },
    });
    expect(await subject.listVolumeInstances({ projectId: "project-1", environmentId: "environment-1" })).toEqual([
      { id: "volume-instance-1", volumeId: "volume-1", serviceId: "service-1", mountPath: "/data" },
    ]);
    expect(await subject.getVolume({ projectId: "project-1", volumeId: "volume-1" })).toEqual({ id: "volume-1", name: "data", projectId: "project-1" });
    expect(await subject.createVolume({ projectId: "project-1", environmentId: "environment-1", serviceId: "service-1", mountPath: "/data" })).toEqual({ id: "volume-1", name: "data", projectId: "project-1" });
    await subject.upsertVariables({ projectId: "project-1", environmentId: "environment-1", serviceId: "service-1", variables: { OPENROUTER_API_KEY: "provider-secret-never-returned" } });
    expect(await subject.listDomains({ projectId: "project-1", environmentId: "environment-1", serviceId: "service-1" })).toEqual([
      { id: "domain-1", domain: "nautilo.up.railway.app", targetPort: 3001 },
    ]);
    expect(await subject.createDomain({ serviceId: "service-1", environmentId: "environment-1", targetPort: 3001 })).toEqual({ id: "domain-1", domain: "nautilo.up.railway.app", targetPort: 3001 });
    expect(await subject.listDeployments({ projectId: "project-1", environmentId: "environment-1", serviceId: "service-1" })).toEqual([{ id: "deployment-1", status: "SUCCESS" }]);
    expect(await subject.listDeploymentsRaw({ projectId: "project-1", environmentId: "environment-1", serviceId: "service-1" })).toEqual([
      { id: "deployment-removed", status: "REMOVED" },
      { id: "deployment-skipped", status: "SKIPPED" },
      { id: "deployment-1", status: "SUCCESS" },
    ]);
    expect(await subject.createDeployment({ serviceId: "service-1", environmentId: "environment-1" })).toEqual({ id: "deployment-1", status: "SUCCESS", url: "https://nautilo.up.railway.app" });
    expect(await subject.inventorySurvivors({ projectId: "project-1", environmentId: "environment-1" })).toEqual([
      { kind: "railway.project", id: "project-1", name: "nautilo" },
      { kind: "railway.service", id: "service-1", name: "nautilo-server" },
      { kind: "railway.volume", id: "volume-1" },
      { kind: "railway.environment", id: "environment-1", name: "production" },
    ]);

    expect(transport.calls.find((call) => call.name === railwayVariableCollectionUpsert.name)?.variables).toEqual({
      input: {
        projectId: "project-1",
        environmentId: "environment-1",
        serviceId: "service-1",
        variables: { OPENROUTER_API_KEY: "provider-secret-never-returned" },
        skipDeploys: true,
      },
    });
    expect(transport.calls.find((call) => call.name === railwayServiceInstanceDeploy.name)?.variables).toEqual({ serviceId: "service-1", environmentId: "environment-1" });
    expect(transport.calls.find((call) => call.name === railwayServiceConnect.name)?.variables).toEqual({
      id: "service-1",
      input: { image: `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}` },
    });
    expect(transport.calls.find((call) => call.name === railwayDeployments.name)?.variables).toEqual({
      input: { projectId: "project-1", environmentId: "environment-1", serviceId: "service-1", includeDeleted: false },
      first: 100,
    });
  });

  test("sets a command before the public image attach that creates its deployment", async () => {
    const transport = new FixtureTransport();
    const subject = new RailwayGraphqlReconcileExecutor({ transport });
    const image = `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}`;
    const startCommand = "npm run cli db seed -- --swe";
    await subject.connectService({
      serviceId: "service-1",
      environmentId: "environment-1",
      image,
      startCommand,
    });
    expect(transport.calls
      .filter((call) => call.name === railwayServiceInstanceUpdate.name || call.name === railwayServiceConnect.name)
      .map((call) => ({ name: call.name, variables: call.variables })))
      .toEqual([
        {
          name: railwayServiceInstanceUpdate.name,
          variables: {
            serviceId: "service-1",
            environmentId: "environment-1",
            input: { startCommand },
          },
        },
        {
          name: railwayServiceConnect.name,
          variables: { id: "service-1", input: { image } },
        },
      ]);
    expect(transport.calls.find((call) => call.name === railwayServiceConnect.name)?.variables)
      .not.toHaveProperty("input.registryCredentials");
    expect(await subject.getServiceInstance({ serviceId: "service-1", environmentId: "environment-1" }))
      .toMatchObject({ source: { image }, startCommand });
  });

  test("deletes only an exact temporary variable and maps canonical null to Railway's empty reset", async () => {
    const transport = new FixtureTransport();
    const subject = new RailwayGraphqlReconcileExecutor({ transport });

    await subject.setServiceStartCommand({
      serviceId: "service-1",
      environmentId: "environment-1",
      startCommand: "node /opt/nautilo/maintenance-job.mjs export",
    });
    await subject.deleteVariable({
      projectId: "project-1",
      environmentId: "environment-1",
      serviceId: "service-1",
      name: "NAUTILO_MAINTENANCE_STORAGE_CREDENTIAL",
    });
    await subject.setServiceStartCommand({
      serviceId: "service-1",
      environmentId: "environment-1",
      startCommand: null,
    });

    expect(transport.calls
      .filter((call) => call.name === railwayVariableDelete.name || call.name === railwayServiceInstanceUpdate.name)
      .map((call) => ({ name: call.name, variables: call.variables })))
      .toEqual([
        {
          name: railwayServiceInstanceUpdate.name,
          variables: {
            serviceId: "service-1",
            environmentId: "environment-1",
            input: { startCommand: "node /opt/nautilo/maintenance-job.mjs export" },
          },
        },
        {
          name: railwayVariableDelete.name,
          variables: {
            input: {
              projectId: "project-1",
              environmentId: "environment-1",
              serviceId: "service-1",
              name: "NAUTILO_MAINTENANCE_STORAGE_CREDENTIAL",
            },
          },
        },
        {
          name: railwayServiceInstanceUpdate.name,
          variables: {
            serviceId: "service-1",
            environmentId: "environment-1",
            input: { startCommand: "" },
          },
        },
      ]);
    expect(await subject.getServiceInstance({ serviceId: "service-1", environmentId: "environment-1" }))
      .toMatchObject({ startCommand: null });
  });

  test("fails closed when Railway does not confirm a variable deletion or command reset", async () => {
    const variableDelete = new RailwayGraphqlReconcileExecutor({
      transport: mismatchTransport(railwayVariableDelete.name, { variableDelete: false }),
    });
    const commandReset = new RailwayGraphqlReconcileExecutor({
      transport: mismatchTransport(railwayServiceInstanceUpdate.name, { serviceInstanceUpdate: false }),
    });

    const variableError = await captureFailure(() => variableDelete.deleteVariable({
      projectId: "project-1",
      environmentId: "environment-1",
      serviceId: "service-1",
      name: "NAUTILO_MAINTENANCE_STORAGE_CREDENTIAL",
    }));
    const commandError = await captureFailure(() => commandReset.setServiceStartCommand({
      serviceId: "service-1",
      environmentId: "environment-1",
      startCommand: null,
    }));

    expect(variableError).toBeInstanceOf(RailwayReconcileExecutorError);
    expect(commandError).toBeInstanceOf(RailwayReconcileExecutorError);
  });

  test("bounds observation while Railway makes a source-created deployment visible", async () => {
    let observations = 0;
    const sleeps: number[] = [];
    const transport: RailwayReconcileExecutorTransport = {
      async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
        operation: Operation,
        _variables: RailwayOperationVariables<Operation>,
      ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
        if (operation.name !== railwayServiceInstanceLatestDeployment.name) throw new Error("unexpected operation");
        observations += 1;
        const data = {
          serviceInstance: {
            latestDeployment: observations < 3 ? null : { id: "deployment-1", status: "INITIALIZING" },
          },
        };
        return { outcome: "success", data: data as RailwayOperationData<Operation>, metadata };
      },
    };
    const subject = new RailwayGraphqlReconcileExecutor({
      transport,
      deploymentObservationAttempts: 3,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    });

    expect(await subject.waitForLatestDeployment({ serviceId: "service-1", environmentId: "environment-1" })).toEqual({
      id: "deployment-1",
      status: "INITIALIZING",
    });
    expect(observations).toBe(3);
    expect(sleeps).toEqual([500, 500]);
  });

  test("bounds a malformed endless connection and redacts provider failures", async () => {
    const secret = "provider-secret-never-surface";
    const transport: RailwayReconcileExecutorTransport = {
      async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
        operation: Operation,
        _variables: RailwayOperationVariables<Operation>,
      ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
        if (operation.name === railwayProjects.name) {
          return {
            outcome: "success",
            data: {
              projects: {
                edges: [{ cursor: "next", node: { id: "project-1", name: "nautilo" } }],
                pageInfo: { hasNextPage: true, endCursor: "next" },
              },
            } as RailwayOperationData<Operation>,
            metadata,
          };
        }
        return {
          outcome: "failure",
          failure: { kind: "graphql-error", operation: operation.name, graphql: { kind: "graphql-error", count: 1 } },
          metadata,
        };
      },
    };
    const subject = new RailwayGraphqlReconcileExecutor({ transport, maxPages: 1 });

    let paginationError: unknown;
    try {
      await subject.listProjects({ workspaceId: "workspace-1" });
    } catch (error) {
      paginationError = error;
    }
    expect(paginationError).toBeInstanceOf(RailwayReconcileExecutorError);
    let providerError: unknown;
    try {
      await subject.upsertVariables({ projectId: "project-1", environmentId: "environment-1", serviceId: "service-1", variables: { KEY: secret } });
    } catch (error) {
      providerError = error;
    }
    expect(providerError).toBeInstanceOf(RailwayReconcileExecutorError);
    expect(String(providerError)).not.toContain(secret);
    expect(String(providerError)).toContain("did not complete safely");
  });

  test("fails closed when a response is not scoped to the requested receipt ID", async () => {
    const transport: RailwayReconcileExecutorTransport = {
      async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
        _operation: Operation,
        _variables: RailwayOperationVariables<Operation>,
      ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
        return {
          outcome: "success",
          data: { project: { id: "other-project", name: "nautilo" } } as RailwayOperationData<Operation>,
          metadata,
        };
      },
    };
    const subject = new RailwayGraphqlReconcileExecutor({ transport });

    let scopeError: unknown;
    try {
      await subject.getProject({ projectId: "project-1" });
    } catch (error) {
      scopeError = error;
    }
    expect(scopeError).toBeInstanceOf(RailwayReconcileExecutorError);
  });

  test("rejects project workspace and create-name postcondition mismatches without surfacing provider data", async () => {
    const wrongWorkspace = "other-workspace-not-for-output";
    const projectList = new RailwayGraphqlReconcileExecutor({
      transport: mismatchTransport(railwayProjects.name, {
        projects: {
          edges: [{ cursor: "cursor-1", node: { id: "project-1", name: "nautilo", workspaceId: wrongWorkspace } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    });
    const projectCreate = new RailwayGraphqlReconcileExecutor({
      transport: mismatchTransport(railwayProjectCreate.name, { projectCreate: { id: "project-1", name: "other-name", workspaceId: "workspace-1" } }),
    });

    const listError = await captureFailure(() => projectList.listProjects({ workspaceId: "workspace-1" }));
    const createError = await captureFailure(() => projectCreate.createProject({ name: "nautilo", workspaceId: "workspace-1" }));
    expect(listError).toBeInstanceOf(RailwayReconcileExecutorError);
    expect(createError).toBeInstanceOf(RailwayReconcileExecutorError);
    expect(String(listError)).not.toContain(wrongWorkspace);
    expect(String(createError)).not.toContain("other-name");
  });

  test("rejects environment and service create-name mismatches", async () => {
    const environmentCreate = new RailwayGraphqlReconcileExecutor({
      transport: mismatchTransport(railwayEnvironmentCreate.name, { environmentCreate: { id: "environment-1", name: "other-environment" } }),
    });
    const serviceCreate = new RailwayGraphqlReconcileExecutor({
      transport: mismatchTransport(railwayServiceCreate.name, { serviceCreate: { id: "service-1", name: "other-service" } }),
    });

    const environmentError = await captureFailure(() => environmentCreate.createEnvironment({ projectId: "project-1", name: "production" }));
    const serviceError = await captureFailure(() => serviceCreate.createService({ projectId: "project-1", environmentId: "environment-1", name: "nautilo-server" }));
    expect(environmentError).toBeInstanceOf(RailwayReconcileExecutorError);
    expect(serviceError).toBeInstanceOf(RailwayReconcileExecutorError);
  });

  test("rejects a connected image observation outside the requested service instance", async () => {
    const subject = new RailwayGraphqlReconcileExecutor({
      transport: mismatchTransport(railwayServiceInstance.name, {
        serviceInstance: {
          id: "instance-1",
          serviceId: "other-service",
          environmentId: "environment-1",
          source: { image: `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}`, repo: null },
        },
      }),
    });

    const error = await captureFailure(() => subject.getServiceInstance({ serviceId: "service-1", environmentId: "environment-1" }));
    expect(error).toBeInstanceOf(RailwayReconcileExecutorError);
    expect(String(error)).not.toContain("other-service");
  });

  test("fails closed when Railway omits the requested latest-deployment observation", async () => {
    const subject = new RailwayGraphqlReconcileExecutor({
      transport: mismatchTransport(railwayServiceInstance.name, {
        serviceInstance: {
          id: "instance-1",
          serviceId: "service-1",
          environmentId: "environment-1",
          startCommand: null,
          source: null,
        },
      }),
    });

    const error = await captureFailure(() => subject.getLatestDeployment({
      serviceId: "service-1",
      environmentId: "environment-1",
    }));
    expect(error).toBeInstanceOf(RailwayReconcileExecutorError);
  });

  test("rejects a mutable image before issuing serviceConnect", async () => {
    const transport = new FixtureTransport();
    const subject = new RailwayGraphqlReconcileExecutor({ transport });

    const error = await captureFailure(() => subject.connectService({
      serviceId: "service-1",
      environmentId: "environment-1",
      image: "ghcr.io/nautilo/server:latest",
    }));

    expect(error).toBeInstanceOf(RailwayReconcileExecutorError);
    expect(transport.calls).toEqual([]);
  });

  test("projects a digest-pinned image through the only public source input", async () => {
    const transport = new FixtureTransport();
    const subject = new RailwayGraphqlReconcileExecutor({ transport });
    const image = `ghcr.io/agentsea/nautilo-server@sha256:${"a".repeat(64)}`;

    await subject.connectService({
      serviceId: "service-1",
      environmentId: "environment-1",
      image,
    });

    expect(transport.calls.find((call) => call.name === railwayServiceConnect.name)?.variables).toEqual({
      id: "service-1",
      input: { image },
    });
    expect(transport.calls.find((call) => call.name === railwayServiceConnect.name)?.variables).not.toHaveProperty(
      "input.registryCredentials",
    );
    expect(transport.calls.find((call) => call.name === railwayServiceConnect.name)?.variables).not.toHaveProperty(
      "input.imagePullSecret",
    );
  });
});
