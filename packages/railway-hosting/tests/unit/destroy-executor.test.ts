import { describe, expect, test } from "bun:test";

import {
  RailwayGraphqlDestroyExecutor,
  type RailwayGraphqlVariables,
  type RailwayOperation,
  type RailwayOperationData,
  type RailwayOperationVariables,
  type RailwayReconcileExecutorTransport,
  type RailwayTransportResult,
} from "../../src/index.ts";

class FixtureTransport implements RailwayReconcileExecutorTransport {
  readonly calls: { readonly name: string; readonly variables: unknown }[] = [];

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push({ name: operation.name, variables });
    const data = operation.name === "RailwayProjects"
      ? {
          projects: {
            edges: [{ cursor: "p1", node: {
              id: "project-1",
              name: "nautilo",
              primaryEnvironmentId: "environment-1",
              workspaceId: "workspace-1",
            } }],
            pageInfo: { hasNextPage: false, endCursor: "p1" },
          },
        }
      : operation.name === "RailwayServiceDomainDelete" ? { serviceDomainDelete: true }
        : operation.name === "RailwayVolumeDelete" ? { volumeDelete: true }
          : operation.name === "RailwayServiceDelete" ? { serviceDelete: true }
            : operation.name === "RailwayProjectDelete" ? { projectDelete: true }
              : undefined;
    if (data === undefined) throw new Error(`unexpected operation ${operation.name}`);
    return {
      outcome: "success",
      data,
      metadata: { httpStatus: 200, rateLimit: {} },
    } as RailwayTransportResult<RailwayOperationData<Operation>>;
  }
}

describe("RailwayGraphqlDestroyExecutor", () => {
  test("uses workspace inventory for exact project absence and pinned ID-only deletes", async () => {
    const transport = new FixtureTransport();
    const executor = new RailwayGraphqlDestroyExecutor({
      transport,
      workspaceId: "workspace-1",
      environmentId: "environment-1",
    });
    expect(await executor.getProject({ projectId: "project-1" })).toMatchObject({ id: "project-1" });
    expect(await executor.getProject({ projectId: "missing" })).toBeNull();
    await executor.deleteDomain({ domainId: "domain-1" });
    await executor.deleteVolume({ volumeId: "volume-1" });
    await executor.deleteService({ serviceId: "service-1" });
    await executor.deleteProject({ projectId: "project-1" });

    expect(transport.calls.map((call) => call.name)).toEqual([
      "RailwayProjects",
      "RailwayProjects",
      "RailwayServiceDomainDelete",
      "RailwayVolumeDelete",
      "RailwayServiceDelete",
      "RailwayProjectDelete",
    ]);
    expect(transport.calls[4]?.variables).toEqual({ id: "service-1", environmentId: "environment-1" });
  });
});
