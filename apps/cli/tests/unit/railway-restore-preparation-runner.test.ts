import { describe, expect, test } from "bun:test";

import type {
  RailwayDeployment,
  RailwayEnvironment,
  RailwayProject,
  RailwayService,
  RailwayServiceDomain,
  RailwayServiceInstance,
  RailwayTopology,
  RailwayVolume,
  RailwayVolumeInstance,
} from "@nautilo/railway-hosting";

import type { RailwayMaintenanceState } from "../../src/lib/railway-maintenance-state";
import {
  runRailwayRestorePreparationFromState,
  type RailwayRestorePreparationExecutor,
  type RailwayRestorePreparationRunnerInput,
} from "../../src/lib/railway-restore-preparation-runner";
import type { RailwayUpgradeRestoreTargetStageContext } from "../../src/lib/railway-upgrade-runner";

const now = "2026-08-12T12:00:00.000Z";
const digest = (name: string, fill: string) => `registry.nautilo.test/${name}@sha256:${fill.repeat(64)}`;
const target = { workspaceId: "workspace-1", projectName: "Restore", environmentName: "restore" };

function topology(): RailwayTopology {
  return {
    schemaVersion: 1,
    releaseId: "release-target",
    finalServices: [
      { name: "app-postgres", imageName: "app-postgres", image: digest("app-postgres", "a"), kind: "long-lived", privatePorts: [], variables: [{ key: "POSTGRES_PASSWORD", value: { kind: "generated-secret-slot", slot: "app-postgres-superuser-password", purpose: "test" } }] },
      { name: "logto-postgres", imageName: "logto-postgres", image: digest("logto-postgres", "b"), kind: "long-lived", privatePorts: [], variables: [{ key: "POSTGRES_PASSWORD", value: { kind: "generated-secret-slot", slot: "logto-postgres-superuser-password", purpose: "test" } }] },
      { name: "logto-seed", imageName: "logto", image: digest("logto", "c"), kind: "run-once", privatePorts: [], variables: [] },
      { name: "logto", imageName: "logto", image: digest("logto", "c"), kind: "long-lived", privatePorts: [], variables: [] },
      { name: "nautilo-server", imageName: "nautilo-server", image: digest("nautilo-server", "d"), kind: "long-lived", privatePorts: [], variables: [] },
    ],
    mounts: [
      { logicalName: "app-postgres-data", service: "app-postgres", mountPath: "/var/lib/postgresql/data" },
      { logicalName: "logto-postgres-data", service: "logto-postgres", mountPath: "/var/lib/postgresql/data" },
      { logicalName: "nautilo-data", service: "nautilo-server", mountPath: "/var/lib/nautilo" },
    ],
    generatedPublicDomains: [
      { logicalName: "logto-public", service: "logto", targetPort: 4301 },
      { logicalName: "nautilo-public", service: "nautilo-server", targetPort: 3001 },
    ],
    transientBootstrap: { kind: "transient-bootstrap", serviceName: "nautilo-bootstrap", imageName: "nautilo-bootstrap", image: digest("bootstrap", "e"), lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"], inputs: [{ key: "APP_POSTGRES_PASSWORD", value: { kind: "generated-secret-slot", slot: "app-postgres-superuser-password", purpose: "test" } }], prohibitedLongLivedServices: ["logto-seed", "logto", "nautilo-server"] },
    transientLogtoBootstrap: { kind: "transient-bootstrap", serviceName: "nautilo-bootstrap", imageName: "nautilo-bootstrap", image: digest("bootstrap", "e"), lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"], inputs: [], prohibitedLongLivedServices: ["nautilo-server"] },
    qualifications: [],
  };
}

function projectionInputs() {
  return {
    generatedSecrets: new Map([
      ["app-postgres-superuser-password" as const, "request-only-app-password"],
      ["logto-postgres-superuser-password" as const, "request-only-logto-password"],
    ]),
    generatedPublicDomains: new Map(),
    bootstrapOutputs: new Map(),
    externalProviderSecrets: new Map(),
  };
}

class FakeExecutor implements RailwayRestorePreparationExecutor {
  project: RailwayProject | undefined;
  environment: RailwayEnvironment | undefined;
  readonly services = new Map<string, RailwayService>();
  readonly sources = new Map<string, string>();
  readonly volumes = new Map<string, RailwayVolume>();
  readonly volumeInstances: RailwayVolumeInstance[] = [];
  readonly domains = new Map<string, RailwayServiceDomain & { serviceId: string }>();
  readonly deployments = new Map<string, RailwayDeployment & { serviceId: string }>();
  readonly events: string[] = [];
  readonly counts: Record<string, number> = {};
  loseBootstrapConnect = false;
  loseServiceCreate: string | undefined;
  wrongBootstrapSource = false;
  duplicateBootstrapDeployment = false;
  throwProjectRead = false;

  private count(name: string): void { this.counts[name] = (this.counts[name] ?? 0) + 1; }
  private serviceName(id: string): string { return this.services.get(id)?.name ?? "unknown"; }

  listProjects = async (): Promise<readonly RailwayProject[]> => {
    this.events.push("read:projects");
    if (this.throwProjectRead) throw new Error("provider secret request-only-provider-body");
    return this.project === undefined ? [] : [this.project];
  };
  getProject = async ({ projectId }: { readonly projectId: string }): Promise<RailwayProject | null> => this.project?.id === projectId ? this.project : null;
  createProject = async (): Promise<RailwayProject> => {
    this.count("create:project"); this.events.push("create:project");
    return this.project = { id: "project-restore", name: target.projectName, workspaceId: target.workspaceId };
  };
  listEnvironments = async (): Promise<readonly RailwayEnvironment[]> => this.environment === undefined ? [] : [this.environment];
  getEnvironment = async ({ environmentId }: { readonly projectId: string; readonly environmentId: string }): Promise<RailwayEnvironment | null> => this.environment?.id === environmentId ? this.environment : null;
  createEnvironment = async (): Promise<RailwayEnvironment> => {
    this.count("create:environment"); this.events.push("create:environment");
    return this.environment = { id: "environment-restore", name: target.environmentName };
  };
  listServices = async (): Promise<readonly RailwayService[]> => [...this.services.values()];
  createService = async ({ name }: { readonly projectId: string; readonly environmentId: string; readonly name: string }): Promise<RailwayService> => {
    this.count(`create:service:${name}`); this.events.push(`create:service:${name}`);
    const service = { id: `service-${name}`, name }; this.services.set(service.id, service);
    if (this.loseServiceCreate === name) {
      this.loseServiceCreate = undefined;
      throw new Error("lost response with request-only-provider-body");
    }
    return service;
  };
  getServiceInstance = async ({ serviceId, environmentId }: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayServiceInstance | null> => {
    if (!this.services.has(serviceId)) return null;
    const image = this.wrongBootstrapSource && this.serviceName(serviceId) === "nautilo-bootstrap"
      ? digest("wrong", "f") : this.sources.get(serviceId);
    return { id: `instance-${serviceId}`, serviceId, environmentId, source: image === undefined ? null : { image } };
  };
  getLatestDeployment = async (): Promise<null> => { throw new Error("latest must not be called"); };
  waitForLatestDeployment = async (): Promise<null> => { throw new Error("latest must not be called"); };
  connectService = async ({ serviceId, environmentId, image }: { readonly serviceId: string; readonly environmentId: string; readonly image: string; readonly startCommand?: string | undefined }): Promise<RailwayServiceInstance> => {
    const name = this.serviceName(serviceId); this.count(`connect:${name}`); this.events.push(`connect:${name}`);
    this.sources.set(serviceId, image);
    const deployment = { id: `deployment-${name}`, status: "SUCCESS" as const, serviceId,
      ...(name === "nautilo-bootstrap" ? { deploymentStopped: true, instances: [{ id: "bootstrap-instance", status: "EXITED" as const }] } : {}) };
    this.deployments.set(deployment.id, deployment);
    if (name === "nautilo-bootstrap" && this.loseBootstrapConnect) {
      this.loseBootstrapConnect = false;
      throw new Error("lost response with request-only-provider-body");
    }
    return { id: `instance-${serviceId}`, serviceId, environmentId, source: { image } };
  };
  listVolumeInstances = async (): Promise<readonly RailwayVolumeInstance[]> => this.volumeInstances;
  getVolume = async ({ volumeId }: { readonly projectId: string; readonly volumeId: string }): Promise<RailwayVolume | null> => this.volumes.get(volumeId) ?? null;
  createVolume = async ({ projectId, serviceId, mountPath }: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly mountPath: string; readonly region?: string | undefined }): Promise<RailwayVolume> => {
    const name = this.serviceName(serviceId); this.count(`create:volume:${name}`); this.events.push(`create:volume:${name}`);
    const volume = { id: `volume-${name}`, name: `volume-${name}`, projectId }; this.volumes.set(volume.id, volume);
    this.volumeInstances.push({ id: `volume-instance-${name}`, volumeId: volume.id, serviceId, mountPath }); return volume;
  };
  upsertVariables = async ({ serviceId }: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly variables: Readonly<Record<string, string>> }): Promise<void> => {
    const name = this.serviceName(serviceId); this.count(`variables:${name}`); this.events.push(`variables:${name}`);
  };
  listDomains = async ({ serviceId }: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }): Promise<readonly RailwayServiceDomain[]> => [...this.domains.values()].filter((domain) => domain.serviceId === serviceId);
  createDomain = async ({ serviceId, targetPort }: { readonly serviceId: string; readonly environmentId: string; readonly targetPort: number }): Promise<RailwayServiceDomain> => {
    const name = this.serviceName(serviceId); this.count(`create:domain:${name}`); this.events.push(`create:domain:${name}`);
    const domain = { id: `domain-${name}`, domain: `${name}.restore.railway.app`, targetPort, serviceId };
    this.domains.set(domain.id, domain); return domain;
  };
  listDeployments = async ({ serviceId }: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }): Promise<readonly RailwayDeployment[]> => [...this.deployments.values()].filter((deployment) => deployment.serviceId === serviceId);
  listDeploymentsRaw = async (input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }): Promise<readonly RailwayDeployment[]> => {
    const deployments = await this.listDeployments(input);
    return this.duplicateBootstrapDeployment && this.serviceName(input.serviceId) === "nautilo-bootstrap" && deployments.length === 1
      ? [...deployments, { ...deployments[0]!, id: "deployment-bootstrap-duplicate" }]
      : deployments;
  };
  createDeployment = async (): Promise<RailwayDeployment> => { throw new Error("explicit deployment must not be called"); };
  getDeployment = async ({ deploymentId }: { readonly deploymentId: string }): Promise<RailwayDeployment> => {
    const deployment = this.deployments.get(deploymentId); if (deployment === undefined) throw new Error("missing deployment"); return deployment;
  };
  deleteService = async ({ serviceId }: { readonly serviceId: string; readonly environmentId: string }): Promise<void> => {
    const name = this.serviceName(serviceId); this.count(`delete:service:${name}`); this.events.push(`delete:service:${name}`);
    this.services.delete(serviceId); this.sources.delete(serviceId);
  };
  inventorySurvivors = async () => [];
}

function harness(executor = new FakeExecutor()) {
  let revision = 0;
  let state = {
    maintenanceId: "maintenance-1",
    authorityGenerationId: "authority-1",
    sourceLaunchId: "launch-source",
    maintenanceReceipt: { targetReleaseId: "release-target" },
  } as RailwayMaintenanceState;
  const context: RailwayUpgradeRestoreTargetStageContext = {
    state,
    loadState: async () => state,
    persistRestoreTargetPreparation: async (next) => {
      state = { ...state, revision: ++revision, restoreTargetPreparation: next };
      return state;
    },
    completeRestoreTarget: async (completion) => {
      if (state.restoreTargetPreparation?.reconcile.receipt.stage !== "claimable") throw new Error("not claimable");
      state = { ...state, revision: ++revision, restoreTargetState: state.restoreTargetPreparation,
        maintenanceReceipt: { ...state.maintenanceReceipt, stage: "restore-target" },
        targetNautiloHostname: completion.targetNautiloHostname, targetLogtoHostname: completion.targetLogtoHostname };
      return state;
    },
  };
  const input = (): RailwayRestorePreparationRunnerInput => ({
    context,
    operationId: "maintenance-1",
    authorityGenerationId: "authority-1",
    targetLaunchId: "launch-restore",
    providers: [],
    topology: topology(),
    projectionInputs: projectionInputs(),
    target,
    transport: {} as RailwayRestorePreparationRunnerInput["transport"],
    executor,
    now: () => now,
  });
  return { executor, input, state: () => state, replaceState: (next: RailwayMaintenanceState) => { state = next; } };
}

async function finish(subject: ReturnType<typeof harness>): Promise<void> {
  for (let invocation = 0; invocation < 12; invocation += 1) {
    const result = await runRailwayRestorePreparationFromState(subject.input());
    if (result.outcome === "complete") return;
    expect(result.outcome).toBe("pending");
  }
  throw new Error("restore preparation did not complete");
}

describe("Railway restore preparation runner", () => {
  test("uses the explicit resume allowance for one inventory-proven absent project create", async () => {
    const subject = harness();
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    const prepared = subject.state().restoreTargetPreparation!;
    subject.replaceState({
      ...subject.state(),
      restoreTargetPreparation: {
        ...prepared,
        reconcile: {
          ...prepared.reconcile,
          pending: { kind: "project-create", logicalName: target.projectName, attempt: 1 },
        },
      },
    });

    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    expect(subject.executor.counts["create:project"]).toBe(1);
    expect(subject.state().restoreTargetPreparation?.reconcile.pending).toBeUndefined();
    expect(subject.state().restoreTargetPreparation?.reconcile.receipt.resources).toContainEqual({
      kind: "railway.project", id: "project-restore", name: target.projectName,
    });
  });

  test("advances one durable phase per invocation", async () => {
    const subject = harness();
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    expect(subject.state().restoreTargetPreparation?.reconcile.receipt.stage).toBe("authorized");
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    expect(subject.state().restoreTargetPreparation?.reconcile.receipt.stage).toBe("provisioning");
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    expect(subject.state().restoreTargetPreparation?.reconcile.receipt.stage).toBe("provisioning");
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    expect(subject.state().restoreTargetPreparation?.reconcile.receipt.stage).toBe("provisioning");
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    expect(subject.state().restoreTargetPreparation?.reconcile.receipt.stage).toBe("bootstrapping");
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    expect(subject.state().restoreTargetPreparation?.reconcile.receipt.stage).toBe("claimable");
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "complete" });
  });

  test("runs the exact ordered subset and persists generated hostnames without runtime public deployment", async () => {
    const subject = harness(); await finish(subject);
    const state = subject.state();
    expect(state.restoreTargetState?.reconcile.receipt.stage).toBe("claimable");
    expect(state.targetNautiloHostname).toBe("nautilo-server.restore.railway.app");
    expect(state.targetLogtoHostname).toBe("logto.restore.railway.app");
    expect([...subject.executor.services.values()].map((service) => service.name).sort()).toEqual([
      "app-postgres", "logto", "logto-postgres", "nautilo-server",
    ]);
    expect(subject.executor.counts["create:service:logto-seed"] ?? 0).toBe(0);
    expect(subject.executor.counts["connect:logto"] ?? 0).toBe(0);
    expect(subject.executor.counts["connect:nautilo-server"] ?? 0).toBe(0);
    expect(subject.executor.counts["delete:service:nautilo-bootstrap"]).toBe(1);
    expect(subject.executor.events.indexOf("delete:service:nautilo-bootstrap"))
      .toBeLessThan(subject.executor.events.indexOf("create:service:logto"));
    expect(state.restoreTargetState?.reconcile.receipt.resources.filter((resource) => resource.kind === "railway.deployment")).toEqual([
      { kind: "railway.deployment", id: "deployment-app-postgres", name: "app-postgres" },
      { kind: "railway.deployment", id: "deployment-logto-postgres", name: "logto-postgres" },
    ]);
    expect(JSON.stringify(state)).not.toContain("request-only-");
    const effects = [...subject.executor.events];
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "complete" });
    expect(subject.executor.events).toEqual(effects);
  });

  test("terminalizes a replacement hostname collision before completing target custody", async () => {
    const subject = harness();
    for (let invocation = 0; invocation < 6; invocation += 1) {
      expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    }
    expect(subject.state().restoreTargetPreparation?.reconcile.receipt.stage).toBe("claimable");
    const nautiloDomain = subject.executor.domains.get("domain-nautilo-server");
    if (nautiloDomain === undefined) throw new Error("missing Nautilo domain fixture");
    subject.executor.domains.set(nautiloDomain.id, {
      ...nautiloDomain,
      domain: "source.restore.railway.app",
    });
    subject.replaceState({
      ...subject.state(),
      sourceManagedWorkbenchHostname: "source.restore.railway.app",
    });

    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "terminal-failure" });
    expect(subject.state().restoreTargetState).toBeUndefined();
    expect(subject.state().targetNautiloHostname).toBeUndefined();
  });

  test("recovers a lost bootstrap connect response from exact source and deployment inventory", async () => {
    const executor = new FakeExecutor(); executor.loseBootstrapConnect = true;
    const subject = harness(executor); await finish(subject);
    expect(executor.counts["connect:nautilo-bootstrap"]).toBe(1);
    expect(executor.counts["create:service:nautilo-bootstrap"]).toBe(1);
    expect(executor.counts["create:project"]).toBe(1);
    expect(executor.counts["create:service:app-postgres"]).toBe(1);
    expect(JSON.stringify(subject.state())).not.toContain("request-only-provider-body");
  });

  test("resumes partial database reconciliation instead of entering bootstrap", async () => {
    const executor = new FakeExecutor(); executor.loseServiceCreate = "app-postgres";
    const subject = harness(executor); await finish(subject);
    expect(executor.counts["create:service:app-postgres"]).toBe(1);
    expect(executor.events.indexOf("create:service:logto-postgres"))
      .toBeLessThan(executor.events.indexOf("create:service:nautilo-bootstrap"));
  });

  test("keeps provider reads redacted and pending, but rejects stale authority before effects", async () => {
    const executor = new FakeExecutor(); executor.throwProjectRead = true;
    const subject = harness(executor);
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    expect(JSON.stringify(subject.state())).not.toContain("request-only-provider-body");
    const before = [...executor.events];
    subject.replaceState({ ...subject.state(), authorityGenerationId: "authority-2" });
    expect(runRailwayRestorePreparationFromState(subject.input())).rejects.toMatchObject({ code: "invalid-state" });
    expect(executor.events).toEqual(before);
  });

  test.each(["wrong-source", "multiple-deployments"] as const)("treats bootstrap %s as terminal", async (failure) => {
    const executor = new FakeExecutor(); const subject = harness(executor);
    for (let invocation = 0; invocation < 4; invocation += 1) {
      expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "pending" });
    }
    if (failure === "wrong-source") {
      executor.services.set("service-nautilo-bootstrap", { id: "service-nautilo-bootstrap", name: "nautilo-bootstrap" });
      executor.sources.set("service-nautilo-bootstrap", digest("wrong", "f"));
      executor.deployments.set("deployment-nautilo-bootstrap", {
        id: "deployment-nautilo-bootstrap", status: "SUCCESS", serviceId: "service-nautilo-bootstrap",
        deploymentStopped: true, instances: [{ id: "bootstrap-instance", status: "EXITED" }],
      });
      executor.wrongBootstrapSource = true;
    } else {
      executor.sources.set("service-nautilo-bootstrap", digest("bootstrap", "e"));
      executor.deployments.set("deployment-nautilo-bootstrap", {
        id: "deployment-nautilo-bootstrap", status: "SUCCESS", serviceId: "service-nautilo-bootstrap",
        deploymentStopped: true, instances: [{ id: "bootstrap-instance", status: "EXITED" }],
      });
      executor.duplicateBootstrapDeployment = true;
    }
    expect(await runRailwayRestorePreparationFromState(subject.input())).toEqual({ outcome: "terminal-failure" });
    if (failure === "wrong-source") expect(executor.counts["variables:nautilo-bootstrap"] ?? 0).toBe(0);
  });
});
