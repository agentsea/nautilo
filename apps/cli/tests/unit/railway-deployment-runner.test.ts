import { describe, expect, test } from "bun:test";

import {
  classifyRailwayBootstrapStepResult,
  classifyRailwayReconcileStepResult,
  classifyRailwayServiceReadiness,
  applyRailwayLogtoBootstrapOutput,
  createRailwayDeploymentDriverState,
  mergeRailwayBootstrapCleanupResources,
  parseRailwayDeploymentDriverState,
} from "../../src/lib/railway-deployment-runner.ts";

describe("Railway deployment driver state", () => {
  test("creates the authorized, non-secret receipt used by the first reconciliation", () => {
    const state = createRailwayDeploymentDriverState({
      launchId: "launch-1",
      releaseId: "2026.08.04.1",
      providers: ["openrouter", "tavily"],
      target: {
        workspaceId: "workspace-1",
        projectName: "nautilo",
        environmentName: "production",
      },
      now: "2026-08-04T10:00:00.000Z",
    });
    expect(state.reconcile.receipt).toMatchObject({
      launchId: "launch-1",
      backend: "railway",
      revision: 1,
      stage: "authorized",
      resources: [],
      cleanup: { state: "not-required" },
    });
    expect(JSON.stringify(state)).not.toMatch(/token|secret|password/i);
  });

  test("rejects release drift, secret-bearing extensions, and malformed receipts", () => {
    const state = createRailwayDeploymentDriverState({
      launchId: "launch-1",
      releaseId: "2026.08.04.1",
      providers: ["openrouter"],
      target: { workspaceId: "workspace-1", projectName: "nautilo", environmentName: "production" },
      now: "2026-08-04T10:00:00.000Z",
    });
    expect(() => parseRailwayDeploymentDriverState({ ...state, apiToken: "railway-not-allowed" })).toThrow();
    expect(() => parseRailwayDeploymentDriverState({
      ...state,
      reconcile: { receipt: { ...state.reconcile.receipt, launchId: "other-launch" } },
    })).toThrow();
    expect(() => createRailwayDeploymentDriverState({
      launchId: "unsafe launch",
      releaseId: "2026.08.04.1",
      providers: [],
      target: state.target,
      now: "2026-08-04T10:00:00.000Z",
    })).toThrow();
    expect(() => createRailwayDeploymentDriverState({
      launchId: "launch-1",
      releaseId: "2026.08.04.1",
      providers: ["invented-provider"],
      target: state.target,
      now: "2026-08-04T10:00:00.000Z",
    })).toThrow();
    expect(() => parseRailwayDeploymentDriverState({
      ...state,
      providers: ["invented-provider"],
    })).toThrow();
  });

  test("admits only the durable owner-bound, active, superseded, and destroyed lifecycle projections", () => {
    const created = createRailwayDeploymentDriverState({ launchId: "launch-1", releaseId: "release-1", providers: [],
      target: { workspaceId: "workspace-1", projectName: "nautilo", environmentName: "production" }, now: "2026-08-04T10:00:00.000Z" });
    const state = { ...created, workflow: { schemaVersion: 1 as const, releaseId: "release-1", stage: "complete" as const },
      reconcile: { receipt: { ...created.reconcile.receipt, revision: 2, stage: "claimable" as const,
        updatedAt: "2026-08-04T10:00:01.000Z", claimableAt: "2026-08-04T10:00:01.000Z" } } };
    for (const lifecycle of [
      { state: "owner-bound", updatedAt: "2026-08-04T10:00:00.000Z" },
      { state: "active", updatedAt: "2026-08-04T10:00:00.000Z", maintenanceId: "maintenance-1" },
      { state: "superseded", updatedAt: "2026-08-04T10:00:00.000Z", supersededByLaunchId: "launch-2", maintenanceId: "maintenance-1" },
    ] as const) expect(parseRailwayDeploymentDriverState({ ...state, lifecycle }).lifecycle).toEqual(lifecycle);
    const { workflow: _workflow, ...claimableWithoutWorkflow } = state;
    expect(() => parseRailwayDeploymentDriverState({ ...claimableWithoutWorkflow,
      lifecycle: { state: "owner-bound", updatedAt: "2026-08-04T10:00:00.000Z" } })).toThrow();
    expect(() => parseRailwayDeploymentDriverState({ ...claimableWithoutWorkflow,
      lifecycle: { state: "active", updatedAt: "2026-08-04T10:00:00.000Z" } })).toThrow();
    const restoredBootstrap = { schemaVersion: 1, projectId: "project-2", environmentId: "environment-2",
      serviceName: "nautilo-bootstrap", imageDigest: `sha256:${"b".repeat(64)}`, serviceId: "bootstrap-service-2",
      handoffDomainId: "bootstrap-domain-2" } as const;
    expect(parseRailwayDeploymentDriverState({ ...claimableWithoutWorkflow, logtoBootstrap: restoredBootstrap,
      lifecycle: { state: "active", updatedAt: "2026-08-04T10:00:00.000Z", maintenanceId: "maintenance-1" } })
      .logtoBootstrap).toEqual(restoredBootstrap);
    expect(() => parseRailwayDeploymentDriverState({ ...state,
      lifecycle: { state: "destroyed", updatedAt: "2026-08-04T10:00:00.000Z" } })).toThrow();
    expect(() => parseRailwayDeploymentDriverState({ ...created,
      lifecycle: { state: "active", updatedAt: "2026-08-04T10:00:00.000Z" } })).toThrow();
    expect(() => parseRailwayDeploymentDriverState({ ...state,
      lifecycle: { state: "superseded", updatedAt: "bad", supersededByLaunchId: "launch-2", maintenanceId: "maintenance-1" } })).toThrow();
    expect(() => parseRailwayDeploymentDriverState({ ...state,
      lifecycle: { state: "superseded", updatedAt: "2026-08-04T10:00:00.000Z", supersededByLaunchId: "launch-1", maintenanceId: "maintenance-1" } })).toThrow();
    expect(() => parseRailwayDeploymentDriverState({ ...state,
      lifecycle: { state: "active", updatedAt: "2026-08-04 10:00:00Z" } })).toThrow();
  });

  test("permits only the canonical non-secret pending-effect shape", () => {
    const state = createRailwayDeploymentDriverState({
      launchId: "launch-1",
      releaseId: "2026.08.04.1",
      providers: ["openrouter"],
      target: { workspaceId: "workspace-1", projectName: "nautilo", environmentName: "production" },
      now: "2026-08-04T10:00:00.000Z",
    });
    const image = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"a".repeat(64)}`;
    const valid = {
      ...state,
      reconcile: {
        receipt: state.reconcile.receipt,
        pending: { kind: "service-connect", logicalName: "nautilo-server", image } as const,
      },
    };

    expect(parseRailwayDeploymentDriverState(valid).reconcile.pending).toEqual(valid.reconcile.pending);
    for (const pending of [
      { ...valid.reconcile.pending, registryCredentials: { username: "ignored", password: "ignored" } },
      { ...valid.reconcile.pending, privatePullAuthority: "ignored" },
      { ...valid.reconcile.pending, imagePullSecret: "ignored" },
      { kind: "service-connect", logicalName: "nautilo-server", image: "ghcr.io/agentsea/nautilo-runtime-v2:latest" },
      { kind: "service-connect", logicalName: "nautilo-server", image: `ghcr.io/agentsea/nautilo-runtime-v2:latest@sha256:${"a".repeat(64)}` },
      { kind: "deployment-create", logicalName: "nautilo-server", image },
    ]) {
      expect(() => parseRailwayDeploymentDriverState({
        ...state,
        reconcile: { receipt: state.reconcile.receipt, pending },
      })).toThrow("Invalid Railway deployment state");
    }
  });

  test("allows only the non-secret bootstrap variables-applied checkpoint marker", () => {
    const state = createRailwayDeploymentDriverState({
      launchId: "launch-1",
      releaseId: "2026.08.04.1",
      providers: ["openrouter"],
      target: { workspaceId: "workspace-1", projectName: "nautilo", environmentName: "production" },
      now: "2026-08-04T10:00:00.000Z",
    });
    const databaseBootstrap = {
      schemaVersion: 1,
      projectId: "project-1",
      environmentId: "environment-1",
      serviceName: "nautilo-bootstrap",
      imageDigest: `sha256:${"a".repeat(64)}`,
      serviceId: "service-1",
      variablesApplied: true,
    } as const;

    expect(parseRailwayDeploymentDriverState({ ...state, databaseBootstrap }).databaseBootstrap)
      .toEqual(databaseBootstrap);
    expect(() => parseRailwayDeploymentDriverState({
      ...state,
      databaseBootstrap: { ...databaseBootstrap, variablesApplied: "provider-secret" },
    })).toThrow();
    expect(() => parseRailwayDeploymentDriverState({
      ...state,
      databaseBootstrap: { ...databaseBootstrap, variables: { OPENROUTER_API_KEY: "not-allowed" } },
    })).toThrow();
  });

  test("binds held-template release checkpoints to exact receipt deployments and workflow order", () => {
    const created = createRailwayDeploymentDriverState({ launchId: "launch-1", releaseId: "release-1", providers: [],
      target: { workspaceId: "workspace-1", projectName: "nautilo", environmentName: "production" },
      now: "2026-08-18T10:00:00.000Z" });
    const resources = [
      { kind: "railway.project", id: "project-1", name: "nautilo" },
      { kind: "railway.environment", id: "environment-1", name: "production" },
      ...(["logto-seed", "logto", "nautilo-server"] as const).flatMap((name) => [
        { kind: "railway.service", id: `service-${name}`, name },
        { kind: "railway.deployment", id: `held-${name}`, name },
      ]),
    ];
    const adopted = { ...created, reconcile: { receipt: { ...created.reconcile.receipt, resources } },
      templateAdoption: { schemaVersion: 1, releaseId: "release-1", heldDeploymentIds: {
        "logto-seed": "held-logto-seed", logto: "held-logto", "nautilo-server": "held-nautilo-server",
      }, releases: {} } };
    expect(parseRailwayDeploymentDriverState(adopted).templateAdoption?.releaseId).toBe("release-1");
    expect(() => parseRailwayDeploymentDriverState({ ...adopted,
      workflow: { schemaVersion: 1, releaseId: "release-1", stage: "logto-seed-ready" } })).toThrow();
    expect(() => parseRailwayDeploymentDriverState({ ...adopted, templateAdoption: {
      ...adopted.templateAdoption, heldDeploymentIds: { ...adopted.templateAdoption.heldDeploymentIds, logto: "forged" },
    } })).toThrow();

    const verifiedAt = "2026-08-18T10:30:00.000Z";
    const destroyedReceipt = {
      ...adopted.reconcile.receipt,
      revision: 2,
      resources: [],
      cleanup: { state: "verified" as const, verifiedAt },
      updatedAt: verifiedAt,
    };
    const destroyed = {
      ...adopted,
      reconcile: { receipt: destroyedReceipt },
      destroy: { schemaVersion: 1 as const, stage: "verify-resources-absent" as const, receipt: destroyedReceipt },
      lifecycle: { state: "destroyed" as const, updatedAt: verifiedAt },
    };
    expect(parseRailwayDeploymentDriverState(destroyed).lifecycle?.state).toBe("destroyed");
    expect(() => parseRailwayDeploymentDriverState({
      ...destroyed,
      destroy: { ...destroyed.destroy, receipt: { ...destroyedReceipt, cleanup: { state: "failed" as const } } },
    })).toThrow("Invalid Railway deployment state");

    const release = (service: "logto" | "nautilo-server", state: "command-pending" | "complete") => ({
      schemaVersion: 1 as const,
      releaseId: "release-1",
      projectId: "project-1",
      environmentId: "environment-1",
      serviceId: `service-${service}`,
      service,
      image: `registry.example/nautilo@sha256:${"a".repeat(64)}`,
      heldDeploymentId: `held-${service}`,
      state,
      ...(state === "complete" ? { deploymentId: `released-${service}` } : {}),
    });
    for (const [service, stage] of [["logto", "logto-seed"], ["nautilo-server", "logto-core"]] as const) {
      for (const releaseState of ["command-pending", "complete"] as const) {
        expect(() => parseRailwayDeploymentDriverState({
          ...adopted,
          workflow: { schemaVersion: 1, releaseId: "release-1", stage },
          templateAdoption: { ...adopted.templateAdoption,
            releases: { [service]: release(service, releaseState) } },
        })).toThrow("Invalid Railway deployment state");
      }
    }

    expect(parseRailwayDeploymentDriverState({
      ...adopted,
      workflow: { schemaVersion: 1, releaseId: "release-1", stage: "logto-core" },
      templateAdoption: { ...adopted.templateAdoption,
        releases: { logto: release("logto", "command-pending"), "logto-seed": {
          schemaVersion: 1, releaseId: "release-1", projectId: "project-1", environmentId: "environment-1",
          serviceId: "service-logto-seed", service: "logto-seed", image: `registry.example/nautilo@sha256:${"a".repeat(64)}`,
          heldDeploymentId: "held-logto-seed", state: "complete", deploymentId: "released-logto-seed",
        } },
      },
    }).workflow?.stage).toBe("logto-core");
  });
});

describe("Railway deployment readiness", () => {
  const deployment = (input: Partial<import("@nautilo/railway-hosting").RailwayDeployment> = {}) => ({
    id: "deployment-1",
    status: "SUCCESS" as const,
    deploymentStopped: false,
    instances: [{ id: "instance-1", status: "RUNNING" as const }],
    ...input,
  });

  test("requires a running instance for long-lived services", () => {
    expect(classifyRailwayServiceReadiness("logto", deployment())).toEqual({ outcome: "complete" });
    expect(classifyRailwayServiceReadiness("logto", deployment({
      deploymentStopped: true,
      instances: [{ id: "instance-1", status: "EXITED" }],
    }))).toEqual({ outcome: "failure", code: "railway.readiness.failed" });
    expect(classifyRailwayServiceReadiness("nautilo-server", deployment({ instances: [] })))
      .toEqual({ outcome: "pending" });
  });

  test("requires a clean stopped instance for the one-shot Logto seed", () => {
    expect(classifyRailwayServiceReadiness("logto-seed", deployment({
      deploymentStopped: true,
      instances: [{ id: "instance-1", status: "EXITED" }],
    }))).toEqual({ outcome: "complete" });
    expect(classifyRailwayServiceReadiness("logto-seed", deployment({
      deploymentStopped: true,
      instances: [{ id: "instance-1", status: "CRASHED" }],
    }))).toEqual({ outcome: "failure", code: "railway.readiness.failed" });
  });
});

describe("Railway resumable provider uncertainty", () => {
  const receipt = {
    schemaVersion: 1 as const,
    launchId: "launch-1",
    backend: "railway" as const,
    revision: 2,
    stage: "provisioning" as const,
    resources: [],
    cleanup: { state: "not-required" as const },
    createdAt: "2026-08-06T10:00:00.000Z",
    updatedAt: "2026-08-06T10:00:01.000Z",
  };

  test("keeps an uncertain reconcile mutation pending only with its durable before-effect marker", () => {
    expect(classifyRailwayReconcileStepResult({
      outcome: "failure",
      stage: "deployment",
      code: "executor-failure",
      checkpoint: { receipt, pending: { kind: "deployment-create", logicalName: "app-postgres" } },
      survivingResources: [],
    })).toEqual({ outcome: "pending" });
    expect(classifyRailwayReconcileStepResult({
      outcome: "failure",
      stage: "deployment",
      code: "recovery-required",
      checkpoint: { receipt, pending: { kind: "deployment-create", logicalName: "app-postgres" } },
      survivingResources: [],
    })).toEqual({ outcome: "failure", code: "railway.reconcile.deployment.recovery-required" });
  });

  test("keeps a lost bootstrap start response pending only after service and variables are durable", () => {
    const checkpoint = {
      schemaVersion: 1 as const,
      projectId: "project-1",
      environmentId: "environment-1",
      serviceName: "nautilo-bootstrap" as const,
      imageDigest: `sha256:${"a".repeat(64)}`,
      serviceId: "service-1",
      variablesApplied: true as const,
    };
    expect(classifyRailwayBootstrapStepResult({
      outcome: "failure",
      stage: "start-deployment",
      code: "executor-failure",
      checkpoint,
    })).toEqual({ outcome: "pending" });
    expect(classifyRailwayBootstrapStepResult({
      outcome: "failure",
      stage: "observe-deployment",
      code: "bootstrap-deployment-failed",
      checkpoint: { ...checkpoint, deploymentId: "deployment-1", failedDeploymentId: "deployment-1" },
    })).toEqual({ outcome: "failure", code: "railway.bootstrap.observe-deployment.bootstrap-deployment-failed" });
  });
});

describe("Railway bootstrap cleanup inventory", () => {
  test("persists exact bootstrap output custody before applying the handoff and fails closed on custody loss", async () => {
    const state = createRailwayDeploymentDriverState({ launchId: "launch-1", releaseId: "release-1", providers: [],
      target: { workspaceId: "workspace-1", projectName: "nautilo", environmentName: "production" }, now: "2026-08-06T10:00:00.000Z" });
    const output = { "logto-workbench-app-id": "workbench", "logto-tui-app-id": "tui",
      "logto-tui-loopback-app-id": "loopback", "logto-desktop-app-id": "desktop", "logto-mobile-app-id": "mobile",
      "logto-mobile-web-app-id": "mobile-web",
      "logto-m2m-app-id": "m2m", "logto-m2m-app-secret": "secret", "logto-resource": "resource" } as const;
    const order: string[] = [];
    await applyRailwayLogtoBootstrapOutput({ state, output,
      persistOutput: async () => { order.push("custody"); }, applyOutput: async () => { order.push("handoff"); } });
    expect(order).toEqual(["custody", "handoff"]);
    let failed = false;
    try {
      await applyRailwayLogtoBootstrapOutput({ state, output,
        persistOutput: () => Promise.reject(new Error("lost")), applyOutput: async () => { order.push("forbidden"); } });
    } catch { failed = true; }
    expect(failed).toBe(true);
    expect(order).not.toContain("forbidden");
  });

  test("adds exact transient service and handoff-domain IDs without duplicating receipt resources", () => {
    const state = createRailwayDeploymentDriverState({
      launchId: "launch-1",
      releaseId: "release-1",
      providers: ["openrouter"],
      target: { workspaceId: "workspace-1", projectName: "nautilo", environmentName: "production" },
      now: "2026-08-06T10:00:00.000Z",
    });
    const logtoBootstrap = {
      schemaVersion: 1,
      projectId: "project-1",
      environmentId: "environment-1",
      serviceName: "nautilo-bootstrap",
      imageDigest: `sha256:${"a".repeat(64)}`,
      serviceId: "bootstrap-service-1",
      handoffDomainId: "bootstrap-domain-1",
    } as const;
    const first = mergeRailwayBootstrapCleanupResources(state.reconcile.receipt, { logtoBootstrap });
    const second = mergeRailwayBootstrapCleanupResources(first, { logtoBootstrap });
    expect(second.resources.filter((resource) => resource.id === "bootstrap-service-1")).toHaveLength(1);
    expect(second.resources).toContainEqual({
      kind: "railway.domain",
      id: "bootstrap-domain-1",
      name: "nautilo-bootstrap-handoff",
    });
  });
});
