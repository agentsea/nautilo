import { describe, expect, test } from "bun:test";

import {
  RAILWAY_BOOTSTRAP_LIFECYCLE_SCHEMA_VERSION,
  RailwayBootstrapHandoffFetchError,
  RailwayBootstrapHandoffPendingError,
  RailwayGraphqlBootstrapExecutor,
  runRailwayBootstrapLifecycle,
  type RailwayBootstrapLifecycleCheckpoint,
  type RailwayBootstrapDeployment,
  type RailwayBootstrapLifecycleExecutor,
  type RailwayBootstrapLifecycleRequest,
  type RailwayDeploymentStatus,
} from "../../src/index";

type Interruption =
  | "create"
  | "variables"
  | "start-deployment"
  | "observe-deployment"
  | "checkpoint-success"
  | "delete"
  | "verify-absent";

interface Harness {
  readonly executor: RailwayBootstrapLifecycleExecutor;
  readonly calls: string[];
  readonly persisted: () => RailwayBootstrapLifecycleCheckpoint | undefined;
  readonly persist: (checkpoint: RailwayBootstrapLifecycleCheckpoint) => void;
  readonly serviceCount: () => number;
  readonly deploymentCount: () => number;
  readonly variableCalls: () => number;
}

function harness(interrupt?: Interruption, terminalStatus: RailwayDeploymentStatus = "SUCCESS"): Harness {
  const services = new Map<string, { readonly id: string; readonly name: string }>();
  const deployments = new Map<string, RailwayBootstrapDeployment>();
  const calls: string[] = [];
  let persisted: RailwayBootstrapLifecycleCheckpoint | undefined;
  let interrupted = false;
  let nextService = 1;
  let nextDeployment = 1;
  let variables = 0;
  let inventoryCalls = 0;

  const interruptAfterEffect = (stage: Interruption): void => {
    if (!interrupted && interrupt === stage) {
      interrupted = true;
      throw new Error(`raw provider error with never-surface-${stage}`);
    }
  };

  return {
    calls,
    persisted: () => persisted,
    persist: (checkpoint) => {
      persisted = checkpoint;
    },
    serviceCount: () => services.size,
    deploymentCount: () => deployments.size,
    variableCalls: () => variables,
    executor: {
      inventoryServices: async () => {
        calls.push("inventory-services");
        inventoryCalls += 1;
        if (interrupt === "verify-absent" && !interrupted && inventoryCalls === 3) {
          interruptAfterEffect("verify-absent");
        }
        return [...services.values()];
      },
      createService: async ({ name }) => {
        calls.push("create");
        const service = { id: `service-${nextService++}`, name };
        services.set(service.id, service);
        interruptAfterEffect("create");
        return service;
      },
      applyServiceVariables: async () => {
        calls.push("variables");
        variables += 1;
        interruptAfterEffect("variables");
      },
      inventoryDeployments: async ({ serviceId }) => {
        calls.push("inventory-deployments");
        return [...deployments.values()].filter(() => services.has(serviceId));
      },
      startDeployment: async () => {
        calls.push("start-deployment");
        const terminalFailure = ["CRASHED", "FAILED", "REMOVED", "SKIPPED"].includes(terminalStatus);
        const deployment: RailwayBootstrapDeployment = {
          id: `deployment-${nextDeployment++}`,
          status: terminalStatus,
          deploymentStopped: terminalStatus === "SUCCESS",
          instances: [{
            id: "instance-1",
            status: terminalStatus === "SUCCESS" ? "EXITED" : terminalFailure ? "CRASHED" : "INITIALIZING",
          }],
        };
        deployments.set(deployment.id, deployment);
        interruptAfterEffect("start-deployment");
        return deployment;
      },
      observeDeployment: async ({ deploymentId }) => {
        calls.push("observe-deployment");
        const deployment = deployments.get(deploymentId);
        if (!deployment) throw new Error("raw provider error with unknown deployment");
        interruptAfterEffect("observe-deployment");
        return deployment;
      },
      deleteService: async ({ serviceId }) => {
        calls.push("delete");
        services.delete(serviceId);
        interruptAfterEffect("delete");
      },
    },
  };
}

function request(
  subject: Harness,
  checkpoint?: RailwayBootstrapLifecycleCheckpoint,
  interruptAfterPersist?: (checkpoint: RailwayBootstrapLifecycleCheckpoint) => boolean,
): RailwayBootstrapLifecycleRequest {
  return {
    target: {
      projectId: "project-1",
      environmentId: "environment-1",
      intent: {
        kind: "transient-bootstrap",
        serviceName: "nautilo-bootstrap",
        imageName: "nautilo-bootstrap",
        image: "ghcr.io/agentsea/nautilo-bootstrap@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"],
        inputs: [],
        prohibitedLongLivedServices: ["logto-seed", "logto", "nautilo-server"],
      },
    },
    variables: {
      APP_POSTGRES_ADMIN_URL: "postgres://postgres:never-surface-password@app-postgres:5432/postgres",
      APP_NAUTILO_DB_PASSWORD: "never-surface-password",
    },
    checkpoint,
    executor: subject.executor,
    persistCheckpoint: async (next) => {
      subject.calls.push("persist");
      // Persistence itself is the durable transition; an interruption after it
      // must resume deletion instead of rerunning the job.
      subject.persist(next);
      if (interruptAfterPersist?.(next)) {
        throw new Error("never-surface-after-durable-checkpoint");
      }
    },
  };
}

function currentCheckpoint(subject: Harness): RailwayBootstrapLifecycleCheckpoint | undefined {
  return subject.persisted();
}

describe("runRailwayBootstrapLifecycle", () => {
  test("fetches an authenticated hosted output, applies it idempotently, then deletes the transient service", async () => {
    const subject = harness();
    const base = request(subject);
    const output = {
      "logto-workbench-app-id": "workbench-id",
      "logto-tui-app-id": "tui-id",
      "logto-tui-loopback-app-id": "tui-loopback-id",
      "logto-desktop-app-id": "desktop-id",
      "logto-mobile-app-id": "mobile-id",
      "logto-mobile-web-app-id": "mobile-web-id",
      "logto-m2m-app-id": "m2m-id",
      "logto-m2m-app-secret": "never-persist-m2m-secret",
      "logto-resource": "https://nautilo.example.test/api",
    } as const;
    let domain: { readonly id: string; readonly domain: string; readonly targetPort: number } | undefined;
    let applied = 0;
    const result = await runRailwayBootstrapLifecycle({
      ...base,
      executor: {
        ...base.executor,
        observeDeployment: async ({ deploymentId }) => ({
          id: deploymentId,
          status: "SUCCESS",
          deploymentStopped: false,
          instances: [{ id: "instance-1", status: "RUNNING" }],
        }),
        listDomains: async () => domain ? [domain] : [],
        createDomain: async ({ targetPort }) => {
          subject.calls.push("create-domain");
          domain = { id: "domain-1", domain: "handoff.example.test", targetPort };
          return domain;
        },
        fetchHandoff: async ({ origin, token }) => {
          subject.calls.push("fetch-handoff");
          expect(origin).toBe("https://handoff.example.test");
          expect(token).toBe("h".repeat(43));
          return output;
        },
      },
      handoff: {
        token: "h".repeat(43),
        targetPort: 8080,
        applyOutput: async (received) => {
          subject.calls.push("apply-handoff");
          applied += 1;
          expect(received).toEqual(output);
        },
      },
    });

    expect(result.outcome).toBe("complete");
    if (result.outcome !== "complete") throw new Error(`unexpected ${result.outcome}`);
    expect(result.checkpoint.handoffApplied).toBe(true);
    expect(applied).toBe(1);
    expect(subject.serviceCount()).toBe(0);
    expect(subject.calls.indexOf("create-domain")).toBeLessThan(subject.calls.indexOf("fetch-handoff"));
    expect(subject.calls.indexOf("fetch-handoff")).toBeLessThan(subject.calls.indexOf("delete"));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("never-persist-m2m-secret");
    expect(serialized).not.toContain("h".repeat(43));
  });

  test("keeps a durable child handoff pending and retries it without deleting the bootstrap service", async () => {
    const subject = harness();
    const output = {
      "logto-workbench-app-id": "workbench-id", "logto-tui-app-id": "tui-id",
      "logto-tui-loopback-app-id": "loopback-id", "logto-desktop-app-id": "desktop-id",
      "logto-mobile-app-id": "mobile-id", "logto-mobile-web-app-id": "mobile-web-id",
      "logto-m2m-app-id": "m2m-id", "logto-m2m-app-secret": "never-persist-secret",
      "logto-resource": "https://nautilo.example.test/api",
    } as const;
    const domain = { id: "domain-1", domain: "handoff.example.test", targetPort: 8080 };
    let applyAttempts = 0;
    const base = request(subject);
    const executor = {
      ...base.executor,
      observeDeployment: async ({ deploymentId }: { readonly deploymentId: string }) => ({
        id: deploymentId, status: "SUCCESS" as const, deploymentStopped: false,
        instances: [{ id: "instance-1", status: "RUNNING" as const }],
      }),
      listDomains: async () => [domain],
      createDomain: async () => domain,
      fetchHandoff: async () => output,
    };
    const handoff = {
      token: "h".repeat(43),
      targetPort: 8080,
      applyOutput: async () => {
        applyAttempts += 1;
        if (applyAttempts === 1) throw new RailwayBootstrapHandoffPendingError();
      },
    };

    const pending = await runRailwayBootstrapLifecycle({ ...base, executor, handoff });
    expect(pending).toMatchObject({ outcome: "pending", stage: "handoff-apply" });
    if (pending.outcome !== "pending") throw new Error(`unexpected ${pending.outcome}`);
    expect(pending.checkpoint.handoffApplied).toBeUndefined();
    expect(subject.serviceCount()).toBe(1);

    const complete = await runRailwayBootstrapLifecycle({
      ...request(subject, pending.checkpoint), executor, handoff,
    });
    expect(complete.outcome).toBe("complete");
    expect(applyAttempts).toBe(2);
    expect(subject.serviceCount()).toBe(0);
    expect(JSON.stringify([pending, complete])).not.toContain("never-persist-secret");
  });

  test("preserves only the safe hosted-fetch classification", async () => {
    const subject = harness();
    const base = request(subject);
    const result = await runRailwayBootstrapLifecycle({
      ...base,
      executor: {
        ...base.executor,
        observeDeployment: async ({ deploymentId }) => ({
          id: deploymentId,
          status: "SUCCESS",
          deploymentStopped: false,
          instances: [{ id: "instance-1", status: "RUNNING" }],
        }),
        listDomains: async () => [{ id: "domain-1", domain: "handoff.example.test", targetPort: 8080 }],
        createDomain: async ({ targetPort }) => ({ id: "domain-1", domain: "handoff.example.test", targetPort }),
        fetchHandoff: async () => {
          throw new RailwayBootstrapHandoffFetchError("authorization-rejected");
        },
      },
      handoff: {
        token: "never-log-token-".repeat(3),
        targetPort: 8080,
        applyOutput: () => Promise.reject(new Error("must not apply")),
      },
    });
    expect(result).toMatchObject({
      outcome: "failure",
      stage: "handoff-fetch",
      code: "handoff-authorization-rejected",
    });
    expect(JSON.stringify(result)).not.toContain("never-log-token");
  });

  test("invokes the concrete hosted-fetch adapter with its receiver", async () => {
    const subject = harness();
    const base = request(subject);
    const output = {
      "logto-workbench-app-id": "workbench-id",
      "logto-tui-app-id": "tui-id",
      "logto-tui-loopback-app-id": "tui-loopback-id",
      "logto-desktop-app-id": "desktop-id",
      "logto-mobile-app-id": "mobile-id",
      "logto-mobile-web-app-id": "mobile-web-id",
      "logto-m2m-app-id": "m2m-id",
      "logto-m2m-app-secret": "never-persist-m2m-secret",
      "logto-resource": "https://nautilo.example.test/api",
    } as const;
    const concrete = new RailwayGraphqlBootstrapExecutor({
      transport: { execute: () => Promise.reject(new Error("unexpected GraphQL call")) },
      fetch: (() => Promise.resolve(Response.json(output))) as unknown as typeof fetch,
      attempts: 1,
    });
    Object.assign(concrete, base.executor, {
      observeDeployment: async ({ deploymentId }: { readonly deploymentId: string }) => ({
        id: deploymentId,
        status: "SUCCESS" as const,
        deploymentStopped: false,
        instances: [{ id: "instance-1", status: "RUNNING" as const }],
      }),
      listDomains: async () => [{ id: "domain-1", domain: "handoff.example.test", targetPort: 8080 }],
      createDomain: async ({ targetPort }: { readonly targetPort: number }) => ({
        id: "domain-1", domain: "handoff.example.test", targetPort,
      }),
    });
    const result = await runRailwayBootstrapLifecycle({
      ...base,
      executor: concrete,
      handoff: {
        token: "h".repeat(43),
        targetPort: 8080,
        applyOutput: (received) => {
          expect(received).toEqual(output);
          return Promise.resolve();
        },
      },
    });
    expect(result.outcome).toBe("complete");
    expect(JSON.stringify(result)).not.toContain("never-persist-m2m-secret");
  });

  test("creates, runs, checkpoints success before deletion, and proves the transient service absent", async () => {
    const subject = harness();
    const result = await runRailwayBootstrapLifecycle(request(subject));

    expect(result.outcome).toBe("complete");
    expect(subject.serviceCount()).toBe(0);
    expect(subject.deploymentCount()).toBe(1);
    expect(subject.calls).toEqual([
      "inventory-services",
      "create",
      "persist",
      "variables",
      "persist",
      "inventory-deployments",
      "start-deployment",
      "persist",
      "observe-deployment",
      "persist",
      "inventory-services",
      "delete",
      "inventory-services",
    ]);
    if (result.outcome === "complete") {
      expect(result.checkpoint.successfulDeploymentId).toBe("deployment-1");
      expect(JSON.stringify(result.checkpoint)).not.toContain("APP_POSTGRES_ADMIN_URL");
      expect(JSON.stringify(result.checkpoint)).not.toContain("never-surface-password");
    }
  });

  test.each([
    "create",
    "variables",
    "start-deployment",
    "observe-deployment",
    "delete",
    "verify-absent",
  ] as const)("retries an interruption after %s without duplicating service or deployment", async (stage) => {
    const subject = harness(stage);
    const first = await runRailwayBootstrapLifecycle(request(subject));
    expect(first.outcome).toBe("failure");

    const second = await runRailwayBootstrapLifecycle(request(subject, currentCheckpoint(subject)));
    expect(second.outcome).toBe("complete");
    expect(subject.serviceCount()).toBe(0);
    expect(subject.deploymentCount()).toBe(1);
    expect(subject.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(subject.calls.filter((call) => call === "start-deployment")).toHaveLength(1);
  });

  test("persists successful deployment before cleanup and resumes cleanup after a post-checkpoint interruption", async () => {
    const subject = harness();
    let interrupted = false;
    const first = await runRailwayBootstrapLifecycle(request(subject, undefined, (checkpoint) => {
      if (!interrupted && checkpoint.successfulDeploymentId) {
        interrupted = true;
        return true;
      }
      return false;
    }));

    expect(first).toMatchObject({ outcome: "failure", stage: "checkpoint-success" });
    expect(currentCheckpoint(subject)?.successfulDeploymentId).toBe("deployment-1");
    const second = await runRailwayBootstrapLifecycle(request(subject, currentCheckpoint(subject)));
    expect(second.outcome).toBe("complete");
    expect(subject.calls.filter((call) => call === "start-deployment")).toHaveLength(1);
  });

  test.each([
    ["service ID", (checkpoint: RailwayBootstrapLifecycleCheckpoint) => checkpoint.serviceId !== undefined && !checkpoint.variablesApplied],
    ["variable application", (checkpoint: RailwayBootstrapLifecycleCheckpoint) => checkpoint.variablesApplied === true && checkpoint.deploymentId === undefined],
    ["deployment ID", (checkpoint: RailwayBootstrapLifecycleCheckpoint) => checkpoint.deploymentId !== undefined && !checkpoint.successfulDeploymentId],
  ] as const)("resumes safely after persisting the %s checkpoint", async (_name, matchesCheckpoint) => {
    const subject = harness();
    let interrupted = false;
    const first = await runRailwayBootstrapLifecycle(request(subject, undefined, (checkpoint) => {
      if (!interrupted && matchesCheckpoint(checkpoint)) {
        interrupted = true;
        return true;
      }
      return false;
    }));
    expect(first.outcome).toBe("failure");

    const second = await runRailwayBootstrapLifecycle(request(subject, currentCheckpoint(subject)));
    expect(second.outcome).toBe("complete");
    expect(subject.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(subject.calls.filter((call) => call === "start-deployment")).toHaveLength(1);
  });

  test("records terminal failure, cleans up, and does not recreate on the same checkpoint", async () => {
    const subject = harness(undefined, "FAILED");
    const first = await runRailwayBootstrapLifecycle(request(subject));
    expect(first).toMatchObject({ outcome: "failure", code: "bootstrap-deployment-failed" });
    expect(subject.serviceCount()).toBe(0);
    const checkpoint = currentCheckpoint(subject);
    expect(checkpoint?.failedDeploymentId).toBe("deployment-1");

    const second = await runRailwayBootstrapLifecycle(request(subject, checkpoint));
    expect(second).toMatchObject({ outcome: "failure", code: "bootstrap-deployment-failed" });
    expect(subject.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(subject.calls.filter((call) => call === "start-deployment")).toHaveLength(1);
  });

  test("returns pending for a documented non-terminal status and preserves only safe checkpoint data", async () => {
    const subject = harness(undefined, "WAITING");
    const result = await runRailwayBootstrapLifecycle(request(subject));
    expect(result).toMatchObject({ outcome: "pending", stage: "observe-deployment" });
    expect(JSON.stringify(result)).not.toContain("APP_POSTGRES_ADMIN_URL");
    expect(JSON.stringify(result)).not.toContain("never-surface-password");
  });

  test("rejects a checkpoint for another certified bootstrap target before making a provider call", async () => {
    const subject = harness();
    const result = await runRailwayBootstrapLifecycle(request(subject, {
      schemaVersion: RAILWAY_BOOTSTRAP_LIFECYCLE_SCHEMA_VERSION,
      projectId: "another-project",
      environmentId: "environment-1",
      serviceName: "nautilo-bootstrap",
      imageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));
    expect(result).toEqual({ outcome: "failure", stage: "inventory", code: "invalid-checkpoint" });
    expect(subject.calls).toEqual([]);
  });

  test.each([
    {
      name: "variables without a service",
      patch: { variablesApplied: true as const },
    },
    {
      name: "deployment without variables",
      patch: { serviceId: "service-1", deploymentId: "deployment-1" },
    },
    {
      name: "success for another deployment",
      patch: {
        serviceId: "service-1",
        variablesApplied: true as const,
        deploymentId: "deployment-1",
        successfulDeploymentId: "deployment-2",
      },
    },
  ])("rejects malformed durable progress: $name", async ({ patch }) => {
    const subject = harness();
    const result = await runRailwayBootstrapLifecycle(request(subject, {
      schemaVersion: RAILWAY_BOOTSTRAP_LIFECYCLE_SCHEMA_VERSION,
      projectId: "project-1",
      environmentId: "environment-1",
      serviceName: "nautilo-bootstrap",
      imageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...patch,
    }));
    expect(result).toEqual({ outcome: "failure", stage: "inventory", code: "invalid-checkpoint" });
    expect(subject.calls).toEqual([]);
  });

  test("redacts raw executor failures, variable names, secrets, and connection URLs", async () => {
    const subject = harness("variables");
    const result = await runRailwayBootstrapLifecycle(request(subject));
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain("never-surface");
    expect(rendered).not.toContain("APP_POSTGRES_ADMIN_URL");
    expect(rendered).not.toContain("postgres://");
    expect(rendered).not.toContain("ghcr.io/");
  });

  test("fails closed when the provider inventory has ambiguous bootstrap identities", async () => {
    const subject = harness();
    const executor: RailwayBootstrapLifecycleExecutor = {
      ...subject.executor,
      inventoryServices: async () => [
        { id: "bootstrap-1", name: "nautilo-bootstrap" },
        { id: "bootstrap-2", name: "nautilo-bootstrap" },
      ],
    };
    const result = await runRailwayBootstrapLifecycle({ ...request(subject), executor });
    expect(result).toEqual({ outcome: "failure", stage: "inventory", code: "ambiguous-service", checkpoint: {
      schemaVersion: RAILWAY_BOOTSTRAP_LIFECYCLE_SCHEMA_VERSION,
      projectId: "project-1",
      environmentId: "environment-1",
      serviceName: "nautilo-bootstrap",
      imageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } });
    expect(subject.calls).toEqual([]);
  });

  test("fails closed when a checkpointed bootstrap ID coexists with another bootstrap identity", async () => {
    const subject = harness();
    const checkpoint: RailwayBootstrapLifecycleCheckpoint = {
      schemaVersion: RAILWAY_BOOTSTRAP_LIFECYCLE_SCHEMA_VERSION,
      projectId: "project-1",
      environmentId: "environment-1",
      serviceName: "nautilo-bootstrap",
      imageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      serviceId: "bootstrap-1",
    };
    const executor: RailwayBootstrapLifecycleExecutor = {
      ...subject.executor,
      inventoryServices: async () => [
        { id: "bootstrap-1", name: "nautilo-bootstrap" },
        { id: "bootstrap-2", name: "nautilo-bootstrap" },
      ],
    };

    const result = await runRailwayBootstrapLifecycle({ ...request(subject, checkpoint), executor });
    expect(result).toEqual({ outcome: "failure", stage: "inventory", code: "ambiguous-service", checkpoint });
    expect(subject.calls).toEqual([]);
  });
});
