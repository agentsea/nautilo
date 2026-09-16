import { describe, expect, test } from "bun:test";

import { RailwayGraphqlBootstrapExecutor } from "../../src/bootstrap-executor";
import { RailwayBootstrapHandoffFetchError } from "../../src/bootstrap-lifecycle";
import {
  railwayDeployment,
  railwayServiceInstance,
  railwayServiceInstanceDeploy,
  railwayServiceInstanceUpdate,
  railwayVariableCollectionUpsert,
} from "../../src/operations";
import type { RailwayReconcileExecutorTransport } from "../../src/reconcile-executor";
import type {
  RailwayGraphqlVariables,
  RailwayOperation,
  RailwayOperationData,
  RailwayOperationVariables,
  RailwayTransportResult,
} from "../../src/types";

const transport: RailwayReconcileExecutorTransport = {
  execute: () => Promise.reject(new Error("unexpected GraphQL call")),
};

const output = {
  "logto-workbench-app-id": "workbench-id",
  "logto-tui-app-id": "tui-id",
  "logto-tui-loopback-app-id": "tui-loopback-id",
  "logto-desktop-app-id": "desktop-id",
  "logto-mobile-app-id": "mobile-id",
  "logto-mobile-web-app-id": "mobile-web-id",
  "logto-m2m-app-id": "m2m-id",
  "logto-m2m-app-secret": "never-log-secret",
  "logto-resource": "https://nautilo.example.test/api",
} as const;

describe("RailwayGraphqlBootstrapExecutor handoff", () => {
  test("attaches source, reapplies reference variables, then creates one exact deployment", async () => {
    const calls: string[] = [];
    const variableInputs: unknown[] = [];
    const deploymentTransport: RailwayReconcileExecutorTransport = {
      async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
        operation: Operation,
        variables: RailwayOperationVariables<Operation>,
      ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
        calls.push(operation.name);
        let data: unknown;
        if (operation.name === railwayServiceInstanceUpdate.name) {
          data = { serviceInstanceUpdate: true };
        } else if (operation.name === railwayServiceInstance.name) {
          data = {
            serviceInstance: {
              id: "instance-1",
              serviceId: "service-1",
              environmentId: "environment-1",
              startCommand: null,
              source: { image: `ghcr.io/nautilo/bootstrap@sha256:${"a".repeat(64)}`, repo: null },
            },
          };
        } else if (operation.name === railwayVariableCollectionUpsert.name) {
          variableInputs.push(variables);
          data = { variableCollectionUpsert: true };
        } else if (operation.name === railwayServiceInstanceDeploy.name) {
          data = { serviceInstanceDeployV2: "deployment-1" };
        } else if (operation.name === railwayDeployment.name) {
          data = { deployment: { id: "deployment-1", status: "INITIALIZING" } };
        } else throw new Error("unexpected GraphQL operation");
        return { outcome: "success", data: data as RailwayOperationData<Operation>, metadata: { httpStatus: 200, rateLimit: {} } };
      },
    };
    const executor = new RailwayGraphqlBootstrapExecutor({
      transport: deploymentTransport,
      deploymentObservationAttempts: 3,
      sleep: () => Promise.resolve(),
    });

    expect(await executor.startDeployment({
      projectId: "project-1",
      environmentId: "environment-1",
      serviceId: "service-1",
      image: `ghcr.io/nautilo/bootstrap@sha256:${"a".repeat(64)}`,
      variables: { APP_POSTGRES_ADMIN_URL: "postgres://request-memory-only" },
    })).toEqual({ id: "deployment-1", status: "INITIALIZING" });
    expect(calls).toEqual([
      railwayServiceInstanceUpdate.name,
      railwayServiceInstance.name,
      railwayVariableCollectionUpsert.name,
      railwayServiceInstanceDeploy.name,
      railwayDeployment.name,
    ]);
    expect(variableInputs).toHaveLength(1);
    expect(JSON.stringify(variableInputs[0])).toContain("APP_POSTGRES_ADMIN_URL");
  });

  test("retries transient HTTPS readiness, sends the bearer token, and validates exact output", async () => {
    const calls: RequestInit[] = [];
    let attempt = 0;
    const executor = new RailwayGraphqlBootstrapExecutor({
      transport,
      attempts: 3,
      sleep: () => Promise.resolve(),
      fetch: ((_: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        attempt += 1;
        return Promise.resolve(attempt === 1
          ? new Response("warming", { status: 503 })
          : Response.json(output));
      }) as typeof fetch,
    });
    const result = await executor.fetchHandoff({
      origin: "https://handoff.example.test",
      token: "t".repeat(43),
    });
    expect(result).toEqual(output);
    expect(calls).toHaveLength(2);
    expect((calls[0]?.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${"t".repeat(43)}`);
    expect(calls[0]?.redirect).toBe("error");
  });

  test("retries fresh-domain routing statuses before accepting the handoff", async () => {
    const statuses = [404, 408, 425, 429, 503];
    let attempt = 0;
    const executor = new RailwayGraphqlBootstrapExecutor({
      transport,
      attempts: statuses.length + 1,
      sleep: () => Promise.resolve(),
      fetch: (() => {
        const status = statuses[attempt++];
        return Promise.resolve(status === undefined
          ? Response.json(output)
          : new Response("not-ready", { status }));
      }) as unknown as typeof fetch,
    });
    const result = await executor.fetchHandoff({
      origin: "https://handoff.example.test",
      token: "t".repeat(43),
    });
    expect(result).toEqual(output);
    expect(attempt).toBe(statuses.length + 1);
  });

  test("fails closed on authorization failure and never includes token or body in the error", async () => {
    const executor = new RailwayGraphqlBootstrapExecutor({
      transport,
      attempts: 3,
      sleep: () => Promise.resolve(),
      fetch: (() => Promise.resolve(new Response("never-log-provider-body", { status: 401 }))) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await executor.fetchHandoff({
        origin: "https://handoff.example.test",
        token: "never-log-token-".repeat(3),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(RailwayBootstrapHandoffFetchError);
    expect((caught as RailwayBootstrapHandoffFetchError).code).toBe("authorization-rejected");
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught as object));
    expect(serialized).not.toContain("never-log-token");
    expect(serialized).not.toContain("never-log-provider-body");
  });

  test("classifies an invalid success body without retaining it", async () => {
    const executor = new RailwayGraphqlBootstrapExecutor({
      transport,
      fetch: (() => Promise.resolve(Response.json({ leaked: "never-log-output" }))) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await executor.fetchHandoff({
        origin: "https://handoff.example.test",
        token: "never-log-token-".repeat(3),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RailwayBootstrapHandoffFetchError);
    expect((caught as RailwayBootstrapHandoffFetchError).code).toBe("response-invalid");
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught as object)))
      .not.toContain("never-log-output");
  });
});
