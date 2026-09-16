import { describe, expect, test } from "bun:test";

import type {
  RailwayGraphqlVariables,
  RailwayOperation,
  RailwayOperationData,
  RailwayOperationVariables,
  RailwayTransportResult,
} from "../../src/types";
import { RailwayGraphqlTemplateAdoptionDiscovery } from "../../src/template-adoption-executor";

const connection = (nodes: readonly unknown[]) => ({
  edges: nodes.map((node, index) => ({ cursor: `cursor-${index}`, node })),
  pageInfo: { hasNextPage: false, endCursor: null },
});

class FixtureTransport {
  readonly calls: Array<{ readonly name: string; readonly mutation: boolean; readonly variables: unknown }> = [];
  readonly #serviceNames: readonly string[];
  constructor(serviceNames: readonly string[] = ["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"]) {
    this.#serviceNames = serviceNames;
  }
  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push({ name: operation.name, mutation: operation.isMutation, variables });
    if (operation.isMutation) throw new Error("unexpected mutation");
    const input = variables as Readonly<Record<string, unknown>>;
    const services = this.#serviceNames.map((name, index) => ({
      id: `service-${index + 1}`, name, templateId: "template-1",
      templateServiceId: `template-service-${index + 1}`, templateThreadSlug: null,
    }));
    const success = (data: unknown) => ({
      outcome: "success" as const, data,
      metadata: { httpStatus: 200, rateLimit: {} },
    }) as RailwayTransportResult<RailwayOperationData<Operation>>;
    switch (operation.name) {
      case "RailwayMe": return success({ me: { id: "user-1", workspaces: [{ id: "workspace-1", name: "Workspace" }] } });
      case "RailwayProjects": return success({ projects: connection([{ id: "project-1", name: "nautilo", workspaceId: "workspace-1", primaryEnvironmentId: "environment-1" }]) });
      case "RailwayProjectServices": return success({ project: { services: connection(services) } });
      case "RailwayEnvironments": return success({ environments: connection([{ id: "environment-1", name: "production" }]) });
      case "RailwayEnvironmentVolumeInstances": return success({ environment: { id: "environment-1", name: "production", volumeInstances: connection([
        { id: "instance-1", volumeId: "volume-1", serviceId: "service-1", mountPath: "/var/lib/postgresql/data" },
        { id: "instance-2", volumeId: "volume-2", serviceId: "service-2", mountPath: "/var/lib/postgresql/data" },
        { id: "instance-3", volumeId: "volume-3", serviceId: "service-5", mountPath: "/var/lib/nautilo" },
      ]) } });
      case "RailwayProjectVolumes": return success({ project: { volumes: connection([
        { id: "volume-1", name: "one", projectId: "project-1" },
        { id: "volume-2", name: "two", projectId: "project-1" },
        { id: "volume-3", name: "three", projectId: "project-1" },
      ]) } });
      case "RailwayServiceInstance": {
        const serviceId = String(input["serviceId"]);
        return success({ serviceInstance: { id: `instance-${serviceId}`, serviceId, environmentId: "environment-1", startCommand: "held", source: { image: `image-${serviceId}@sha256:${"a".repeat(64)}`, repo: null } } });
      }
      case "RailwayDeployments": {
        const serviceId = String((input["input"] as Record<string, unknown>)["serviceId"]);
        return success({ deployments: connection([{ id: `deployment-${serviceId}`, status: "SUCCESS" }]) });
      }
      case "RailwayVariables": return success({ variables: input["unrendered"] === true ? { VALUE: "${{ secret(48) }}" } : { VALUE: "x".repeat(48) } });
      case "RailwayDomains": {
        const serviceId = String(input["serviceId"]);
        return success({ domains: { serviceDomains: serviceId === "service-4"
          ? [{ id: "domain-1", domain: "logto.example", targetPort: 4301 }]
          : serviceId === "service-5" ? [{ id: "domain-2", domain: "nautilo.example", targetPort: 3001 }] : [], customDomains: [] } });
      }
      default: throw new Error(`unexpected ${operation.name}`);
    }
  }
}

describe("RailwayGraphqlTemplateAdoptionDiscovery", () => {
  test("walks exact read-only provenance, source, resource, deployment, domain, and variable APIs", async () => {
    const transport = new FixtureTransport();
    const result = await new RailwayGraphqlTemplateAdoptionDiscovery({ transport }).discoverNautiloShapedProjects();
    expect(result).toHaveLength(1);
    expect(result[0]?.services).toHaveLength(5);
    expect(result[0]?.volumes).toHaveLength(3);
    expect(result[0]?.domains).toHaveLength(2);
    expect(result[0]?.sourceTemplateId).toBe("template-1");
    expect(result[0]?.services[0]?.variables).toEqual({ VALUE: "x".repeat(48) });
    expect(result[0]?.services[0]?.unrenderedVariables).toEqual({ VALUE: "${{ secret(48) }}" });
    expect(transport.calls.every((call) => call.mutation === false)).toBe(true);
    expect(transport.calls.filter((call) => call.name === "RailwayVariables")).toHaveLength(10);
    expect(transport.calls.some((call) => call.name === "RailwayTemplateSourceForProject")).toBe(false);
    expect(transport.calls.some((call) => call.name.includes("Latest"))).toBe(false);
  });

  test("does not read variables from a partial or foreign look-alike project", async () => {
    const transport = new FixtureTransport(["logto", "redis"]);
    const result = await new RailwayGraphqlTemplateAdoptionDiscovery({ transport }).discoverNautiloShapedProjects();
    expect(result).toHaveLength(1);
    expect(result[0]?.services).toEqual([]);
    expect(transport.calls.some((call) => call.name === "RailwayVariables")).toBe(false);
    expect(transport.calls.every((call) => call.mutation === false)).toBe(true);
  });
});
