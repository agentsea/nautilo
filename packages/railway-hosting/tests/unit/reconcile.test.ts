import { describe, expect, test } from "bun:test";

import { parseLaunchReceipt, type LaunchReceipt } from "@nautilo/hosting";

import { reconcileRailwayResources } from "../../src/reconcile";
import type {
  RailwayReconcileCheckpoint,
  RailwayReconcileDesiredState,
  RailwayReconcileEffectKind,
  RailwayReconcileExecutor,
  RailwayReconcileRequest,
} from "../../src/reconcile-types";

const image = (character: string): string => `ghcr.io/nautilo/service@sha256:${character.repeat(64)}`;

const desired: RailwayReconcileDesiredState = {
  project: { name: "nautilo", workspaceId: "workspace-1" },
  environment: { name: "production" },
  services: [
    { name: "logto", image: image("a"), variables: { LOGTO_SECRET: "never-surface-variable" }, deploy: true },
    { name: "nautilo-server", image: image("b"), variables: { OPENROUTER_API_KEY: "never-surface-variable" }, deploy: true },
  ],
  volumes: [{ logicalName: "nautilo-data", service: "nautilo-server", mountPath: "/var/lib/nautilo" }],
  domains: [{ logicalName: "nautilo-public", service: "nautilo-server", targetPort: 3001 }],
};

type InterruptedEffect = RailwayReconcileEffectKind | undefined;

interface Harness {
  readonly executor: RailwayReconcileExecutor;
  readonly counts: Readonly<Record<string, number>>;
  readonly events: readonly string[];
  readonly checkpoint: () => RailwayReconcileCheckpoint;
  readonly request: () => RailwayReconcileRequest;
}

function initialReceipt(): LaunchReceipt {
  return {
    schemaVersion: 1,
    launchId: "launch-1",
    backend: "railway",
    revision: 0,
    stage: "authorized",
    resources: [],
    cleanup: { state: "not-required" },
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

function harness(interrupt?: InterruptedEffect, providerDeploysOnConnect = true): Harness {
  let checkpoint: RailwayReconcileCheckpoint = { receipt: initialReceipt() };
  let interrupted = false;
  let clock = 1;
  let project: { id: string; name: string; workspaceId: string } | undefined;
  let environment: { id: string; name: string } | undefined;
  const services = new Map<string, { id: string; name: string }>();
  const sources = new Map<string, { image: string }>();
  const volumeInstances: Array<{ id: string; volumeId: string; serviceId: string; mountPath: string }> = [];
  const volumes = new Map<string, { id: string; name: string; projectId: string }>();
  const domains = new Map<string, { id: string; domain: string; targetPort: number }>();
  const deployments = new Map<string, { id: string; status: "SUCCESS"; serviceId: string }>();
  const mutableCounts: Record<string, number> = {};
  const events: string[] = [];
  const count = (name: string): void => { mutableCounts[name] = (mutableCounts[name] ?? 0) + 1; };
  const afterEffect = (kind: RailwayReconcileEffectKind): void => {
    if (!interrupted && interrupt === kind) {
      interrupted = true;
      throw new Error(`provider response has never-surface-${kind}`);
    }
  };

  const executor: RailwayReconcileExecutor = {
    listProjects: async () => project ? [project] : [],
    getProject: async ({ projectId }) => project?.id === projectId ? project : null,
    createProject: async (input) => {
      count("project-create");
      project = { id: "project-1", name: input.name, workspaceId: input.workspaceId };
      afterEffect("project-create");
      return project;
    },
    listEnvironments: async () => environment ? [environment] : [],
    getEnvironment: async ({ environmentId }) => environment?.id === environmentId ? environment : null,
    createEnvironment: async ({ name }) => {
      count("environment-create");
      environment = { id: "environment-1", name };
      afterEffect("environment-create");
      return environment;
    },
    listServices: async () => [...services.values()],
    createService: async ({ name }) => {
      count(`service-create:${name}`);
      const service = { id: `service-${services.size + 1}`, name };
      services.set(service.id, service);
      afterEffect("service-create");
      return service;
    },
    getServiceInstance: async ({ serviceId, environmentId }) => {
      const service = services.get(serviceId);
      return service === undefined ? null : {
        id: `instance-${serviceId}`,
        serviceId,
        environmentId,
        source: sources.get(serviceId) ?? null,
      };
    },
    getLatestDeployment: async ({ serviceId }) =>
      [...deployments.values()].filter((deployment) => deployment.serviceId === serviceId).at(-1) ?? null,
    waitForLatestDeployment: async ({ serviceId }) =>
      [...deployments.values()].filter((deployment) => deployment.serviceId === serviceId).at(-1) ?? null,
    connectService: async ({ serviceId, environmentId, image: requestedImage }) => {
      count(`service-connect:${serviceId}`);
      events.push(`service-connect:${serviceId}`);
      sources.set(serviceId, { image: requestedImage });
      if (providerDeploysOnConnect) {
        const deployment = { id: `deployment-${deployments.size + 1}`, status: "SUCCESS" as const, serviceId };
        deployments.set(deployment.id, deployment);
      }
      afterEffect("service-connect");
      return { id: `instance-${serviceId}`, serviceId, environmentId, source: { image: requestedImage } };
    },
    listVolumeInstances: async () => volumeInstances,
    getVolume: async ({ volumeId }) => volumes.get(volumeId) ?? null,
    createVolume: async ({ projectId, serviceId, mountPath }) => {
      count("volume-create");
      const volume = { id: `volume-${volumes.size + 1}`, name: "provider-volume", projectId };
      volumes.set(volume.id, volume);
      volumeInstances.push({ id: `instance-${volumeInstances.length + 1}`, volumeId: volume.id, serviceId, mountPath });
      afterEffect("volume-create");
      return volume;
    },
    upsertVariables: async ({ serviceId }) => {
      count(`variables-upsert:${serviceId}`);
      events.push(`variables-upsert:${serviceId}`);
      afterEffect("variables-upsert");
    },
    listDomains: async () => [...domains.values()],
    createDomain: async ({ targetPort }) => {
      count("domain-create");
      const domain = { id: `domain-${domains.size + 1}`, domain: "generated.railway.app", targetPort: targetPort ?? 0 };
      domains.set(domain.id, domain);
      afterEffect("domain-create");
      return domain;
    },
    listDeployments: async ({ serviceId }) => [...deployments.values()].filter((deployment) => deployment.serviceId === serviceId),
    createDeployment: async ({ serviceId }) => {
      count("deployment-create");
      const deployment = { id: `deployment-${deployments.size + 1}`, status: "SUCCESS" as const, serviceId };
      deployments.set(deployment.id, deployment);
      afterEffect("deployment-create");
      return deployment;
    },
    inventorySurvivors: async () => [
      ...(project ? [{ kind: "railway.project", id: project.id, name: project.name }] : []),
      ...[...services.values()].map((service) => ({ kind: "railway.service", id: service.id, name: service.name })),
    ],
  };

  return {
    executor,
    counts: mutableCounts,
    events,
    checkpoint: () => checkpoint,
    request: () => ({
      desired,
      checkpoint,
      executor,
      persistCheckpoint: async (next) => { checkpoint = next; },
      now: () => `2026-08-04T00:00:${String(clock++).padStart(2, "0")}.000Z`,
    }),
  };
}

describe("reconcileRailwayResources", () => {
  test("walks all resource classes using receipt IDs and never serializes variables", async () => {
    const subject = harness();
    const result = await reconcileRailwayResources(subject.request());

    expect(result.outcome).toBe("complete");
    if (result.outcome === "complete") {
      expect(result.checkpoint.pending).toBeUndefined();
      expect(result.checkpoint.receipt.resources.map((entry) => entry.kind)).toEqual([
        "railway.project",
        "railway.environment",
        "railway.service",
        "railway.service",
        "railway.volume",
        "railway.variable-collection",
        "railway.variable-collection",
        "railway.service-image",
        "railway.service-image",
        "railway.domain",
        "railway.deployment",
        "railway.deployment",
      ]);
      expect(JSON.stringify(result)).not.toContain("never-surface-variable");
      expect(subject.events.indexOf("variables-upsert:service-1")).toBeLessThan(subject.events.indexOf("service-connect:service-1"));
      expect(subject.events.indexOf("variables-upsert:service-2")).toBeLessThan(subject.events.indexOf("service-connect:service-2"));
      expect(parseLaunchReceipt(result.checkpoint.receipt)).toEqual({
        ok: true,
        receipt: result.checkpoint.receipt,
      });
    }
  });

  test.each([
    "project-create",
    "environment-create",
    "service-create",
    "volume-create",
    "variables-upsert",
    "service-connect",
    "domain-create",
  ] as const)("recovers a process interruption after %s without a duplicate provider create", async (interruption) => {
    const subject = harness(interruption);
    const first = await reconcileRailwayResources(subject.request());
    expect(first.outcome).toBe("failure");
    expect(JSON.stringify(first)).not.toContain(`never-surface-${interruption}`);
    if (interruption === "service-connect" && first.outcome === "failure") {
      expect(first.checkpoint.pending).toEqual({
        kind: "service-connect",
        logicalName: "logto",
        image: image("a"),
      });
      expect(JSON.stringify(first.checkpoint)).not.toContain("never-surface-variable");
    }

    const second = await reconcileRailwayResources(subject.request());
    expect(second.outcome).toBe("complete");
    if (interruption === "service-create") {
      expect(Object.entries(subject.counts).filter(([key]) => key.startsWith("service-create:"))).toEqual([
        ["service-create:logto", 1],
        ["service-create:nautilo-server", 1],
      ]);
    } else if (interruption === "variables-upsert") {
      // Variable collection upsert is the intentional idempotent retry case.
      expect(subject.counts["variables-upsert:service-1"]).toBe(2);
      expect(subject.counts["variables-upsert:service-2"]).toBe(1);
    } else if (interruption === "service-connect") {
      expect(subject.counts["service-connect:service-1"]).toBe(1);
      expect(subject.counts["service-connect:service-2"]).toBe(1);
    } else {
      expect(subject.counts[interruption]).toBe(1);
    }
  });

  test("fails closed instead of recreating a pending resource that cannot be recovered", async () => {
    const subject = harness();
    const pending: RailwayReconcileCheckpoint = {
      receipt: initialReceipt(),
      pending: { kind: "project-create", logicalName: "nautilo" },
    };
    const result = await reconcileRailwayResources({ ...subject.request(), checkpoint: pending });

    expect(result).toMatchObject({ outcome: "failure", stage: "project", code: "recovery-required" });
    expect(subject.counts["project-create"] ?? 0).toBe(0);
  });

  test("uses one explicit resume to retry an inventory-proven absent project create exactly once", async () => {
    const subject = harness();
    const attempts: Array<number | undefined> = [];
    const pending: RailwayReconcileCheckpoint = {
      receipt: initialReceipt(),
      pending: { kind: "project-create", logicalName: "nautilo", attempt: 1 },
    };
    const result = await reconcileRailwayResources({
      ...subject.request(), checkpoint: pending, retryAbsentProjectCreate: true,
      persistCheckpoint: async (checkpoint) => { attempts.push(checkpoint.pending?.attempt); },
    });

    expect(result.outcome).toBe("complete");
    expect(subject.counts["project-create"]).toBe(1);
    expect(attempts[0]).toBe(2);
  });

  test("never issues a third project create after the explicit retry is already pending", async () => {
    const subject = harness();
    const pending: RailwayReconcileCheckpoint = {
      receipt: initialReceipt(),
      pending: { kind: "project-create", logicalName: "nautilo", attempt: 2 },
    };
    const result = await reconcileRailwayResources({
      ...subject.request(), checkpoint: pending, retryAbsentProjectCreate: true,
    });

    expect(result).toMatchObject({ outcome: "failure", stage: "project", code: "recovery-required" });
    expect(subject.counts["project-create"] ?? 0).toBe(0);
  });

  test("returns a non-secret surviving-resource inventory when a provider call fails", async () => {
    const subject = harness();
    const broken: RailwayReconcileExecutor = {
      ...subject.executor,
      createProject: async () => { throw new Error("password=never-surface-provider-error"); },
    };
    const result = await reconcileRailwayResources({ ...subject.request(), executor: broken });

    expect(result).toMatchObject({ outcome: "failure", stage: "project", code: "executor-failure" });
    expect(JSON.stringify(result)).not.toContain("never-surface-provider-error");
    if (result.outcome === "failure") expect(result.survivingResources).toEqual([]);
  });

  test.each([
    "ghcr.io/nautilo/service:latest",
    `ghcr.io/nautilo/service:latest@sha256:${"a".repeat(64)}`,
  ])("rejects mutable image intent %s before performing any provider effect", async (mutableImage) => {
    const subject = harness();
    const mutable: RailwayReconcileDesiredState = {
      ...desired,
      services: [{ ...desired.services[0]!, image: mutableImage }],
    };
    const result = await reconcileRailwayResources({ ...subject.request(), desired: mutable });

    expect(result).toMatchObject({ outcome: "failure", stage: "validate", code: "invalid-desired-state" });
    expect(subject.counts).toEqual({});
  });

  test("creates an empty domain-ready scaffold without variables, source attachment, or deployment", async () => {
    const subject = harness();
    const scaffold: RailwayReconcileDesiredState = {
      project: desired.project,
      environment: desired.environment,
      services: [{ name: "nautilo-server", variables: {}, deploy: false }],
      volumes: [],
      domains: [{ logicalName: "nautilo-public", service: "nautilo-server", targetPort: 3001 }],
    };
    const result = await reconcileRailwayResources({ ...subject.request(), desired: scaffold });
    expect(result.outcome).toBe("complete");
    expect(subject.counts["service-create:nautilo-server"]).toBe(1);
    expect(subject.counts["domain-create"]).toBe(1);
    expect(subject.counts["variables-upsert:service-1"]).toBeUndefined();
    expect(subject.counts["service-connect:service-1"]).toBeUndefined();
    expect(subject.counts["deployment-create"]).toBeUndefined();
  });

  test("adopts Railway's canonical latest deployment and never infers current identity from history", async () => {
    const subject = harness();
    const executor: RailwayReconcileExecutor = {
      ...subject.executor,
      listDeployments: async () => { throw new Error("deployment history must not be consulted"); },
    };
    const result = await reconcileRailwayResources({ ...subject.request(), executor });

    expect(result.outcome).toBe("complete");
    expect(subject.counts["deployment-create"]).toBeUndefined();
    if (result.outcome === "complete") {
      expect(result.checkpoint.receipt.resources.filter((entry) => entry.kind === "railway.deployment")).toHaveLength(2);
    }
  });

  test("does not create a second deployment when Railway's source-created deployment is not yet observable", async () => {
    const subject = harness(undefined, false);
    const result = await reconcileRailwayResources(subject.request());

    expect(result).toMatchObject({ outcome: "failure", stage: "deployment", code: "executor-failure" });
    expect(subject.counts["deployment-create"]).toBeUndefined();
  });

  test("fails closed when the receipt deployment is no longer Railway's canonical latest deployment", async () => {
    const subject = harness();
    const complete = await reconcileRailwayResources(subject.request());
    expect(complete.outcome).toBe("complete");
    if (complete.outcome !== "complete") return;

    const executor: RailwayReconcileExecutor = {
      ...subject.executor,
      getLatestDeployment: async () => ({ id: "a-different-current-deployment", status: "SUCCESS" }),
    };
    const result = await reconcileRailwayResources({
      ...subject.request(),
      checkpoint: complete.checkpoint,
      executor,
    });
    expect(result).toMatchObject({ outcome: "failure", stage: "deployment", code: "identity-mismatch" });
  });

  test("rejects an observed source that differs from the receipt's exact digest", async () => {
    const subject = harness();
    const complete = await reconcileRailwayResources(subject.request());
    expect(complete.outcome).toBe("complete");
    if (complete.outcome !== "complete") return;

    const mismatched: RailwayReconcileExecutor = {
      ...subject.executor,
      getServiceInstance: async ({ serviceId, environmentId }) => ({
        id: `instance-${serviceId}`,
        serviceId,
        environmentId,
        source: { image: image("f") },
      }),
    };
    const result = await reconcileRailwayResources({
      ...subject.request(),
      checkpoint: complete.checkpoint,
      executor: mismatched,
    });

    expect(result).toMatchObject({ outcome: "failure", stage: "image", code: "identity-mismatch" });
  });
});
