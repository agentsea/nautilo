import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type { MaintenanceReceipt } from "@nautilo/hosting";
import { RAILWAY_LOGTO_BOOTSTRAP_PORT } from "@nautilo/railway-hosting";
import type {
  RailwayDeployment,
  RailwayGraphqlVariables,
  RailwayOperation,
  RailwayOperationData,
  RailwayOperationVariables,
  RailwayReconcileExecutorTransport,
  RailwayService,
  RailwayServiceInstance,
  RailwayTopology,
  RailwayTransportResult,
} from "@nautilo/railway-hosting";

import { writeRailwayMaintenanceState, type RailwayMaintenanceState } from "../../src/lib/railway-maintenance-state";
import { runRailwayRestoredTargetActivationFromState } from "../../src/lib/railway-restored-target-activation-runner";

const sha = (fill: string) => fill.repeat(64);
const image = (name: string, fill: string) => `registry.example.test/${name}@sha256:${sha(fill)}`;
const operationId = "restore-operation-1";
const portableOperationId = "export-restore-operation-1";
const projectId = "project-1";
const environmentId = "environment-1";
const logtoServiceId = "logto-service-1";
const nautiloServiceId = "nautilo-service-1";
const secret = "request-memory-secret-that-must-never-persist";
// Full scenarios make repeated durability-fenced state writes. The repository-wide
// suite runs many packages concurrently, so leave enough headroom for contended
// fsyncs while keeping a bounded per-scenario timeout.
const RESTORED_TARGET_SCENARIO_TIMEOUT_MS = 30_000;

function topology(): RailwayTopology {
  const service = (name: RailwayTopology["finalServices"][number]["name"], fill: string, variables: RailwayTopology["finalServices"][number]["variables"] = []) => ({
    name,
    imageName: name === "logto-seed" ? "logto" as const : name,
    image: image(name, fill),
    kind: name === "logto-seed" ? "run-once" as const : "long-lived" as const,
    privatePorts: [],
    variables,
  });
  const transient = {
    kind: "transient-bootstrap" as const,
    serviceName: "nautilo-bootstrap" as const,
    imageName: "nautilo-bootstrap" as const,
    image: image("nautilo-bootstrap", "f"),
    lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"] as const,
    prohibitedLongLivedServices: ["nautilo-server"] as const,
  };
  return {
    schemaVersion: 1,
    releaseId: "release-target",
    finalServices: [
      service("app-postgres", "a"), service("logto-postgres", "b"), service("logto-seed", "c"),
      service("logto", "d", [{ key: "DB_URL", value: { kind: "safe-literal", value: "postgres://logto.railway.internal/db" } }]),
      service("nautilo-server", "e", [
        { key: "LOGTO_M2M_APP_SECRET", value: { kind: "bootstrap-output-reference", producer: "logto-post-seed-reconciliation", output: "logto-m2m-app-secret" } },
        { key: "NAUTILO_PUBLIC_BASE_URL", value: { kind: "generated-public-domain-reference", domain: "nautilo-public", scheme: "https" } },
      ]),
    ],
    mounts: [], generatedPublicDomains: [],
    transientBootstrap: { ...transient, inputs: [] },
    transientLogtoBootstrap: { ...transient, inputs: [
      { key: "NAUTILO_BOOTSTRAP_HANDOFF_TOKEN", value: { kind: "generated-secret-slot", slot: "logto-bootstrap-handoff-token", purpose: "handoff" } },
      { key: "NAUTILO_PUBLIC_BASE_URL", value: { kind: "generated-public-domain-reference", domain: "nautilo-public", scheme: "https" } },
    ] },
    qualifications: [],
  };
}

function receipt(): MaintenanceReceipt {
  return {
    schemaVersion: 1, maintenanceId: operationId, launchId: "launch-source-1", backend: "railway",
    revision: 7, stage: "restore", sourceReleaseId: "release-source", targetReleaseId: "release-target",
    providerWorkflows: [
      { operation: "backup-application-postgres", workflowId: "backup-app", state: "complete", completedAt: "2026-08-11T08:03:00.000Z" },
      { operation: "backup-logto-postgres", workflowId: "backup-logto", state: "complete", completedAt: "2026-08-11T08:03:00.000Z" },
      { operation: "backup-server-volume", workflowId: "backup-volume", state: "complete", completedAt: "2026-08-11T08:03:00.000Z" },
      { operation: "export-portable", workflowId: "export-job", state: "complete", completedAt: "2026-08-11T08:04:00.000Z" },
      { operation: "restore-portable", workflowId: "restore-job-1", state: "complete", completedAt: "2026-08-11T08:07:00.000Z" },
    ],
    backupSet: { backups: [
      { kind: "application-postgres", backupId: "backup-app" },
      { kind: "logto-postgres", backupId: "backup-logto" },
      { kind: "server-volume", backupId: "backup-volume" },
    ], completedAt: "2026-08-11T08:03:00.000Z" },
    portableExport: { objectId: "object-1", sha256: sha("9"), completedAt: "2026-08-11T08:04:00.000Z" },
    restoreTarget: { projectId, environmentId, createdAt: "2026-08-11T08:06:00.000Z" },
    createdAt: "2026-08-11T08:00:00.000Z", updatedAt: "2026-08-11T08:07:00.000Z",
  };
}

function initialState(): RailwayMaintenanceState {
  const command = `bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts restore ${portableOperationId} object-1`;
  return {
    schemaVersion: 1, revision: 0, maintenanceId: operationId, sourceLaunchId: "launch-source-1",
    authorityGenerationId: "authority-generation-1", sourceManagedWorkbenchHostname: "source.example.test",
    sourceLaunchState: {
      schemaVersion: 1, launchId: "launch-source-1", releaseId: "release-source", providers: [],
      target: { workspaceId: "workspace-1", projectName: "Nautilo Source", environmentName: "production" },
      reconcile: { receipt: {
        schemaVersion: 1, launchId: "launch-source-1", backend: "railway", revision: 2, stage: "provisioning",
        resources: [
          { kind: "railway.project", id: "source-project", name: "project" },
          { kind: "railway.environment", id: "source-environment", name: "environment" },
          { kind: "railway.service", id: "source-logto", name: "logto" },
          { kind: "railway.service", id: "source-nautilo", name: "nautilo-server" },
          { kind: "railway.domain", id: "source-domain", name: "nautilo-public" },
          { kind: "railway.domain", id: "source-logto-domain", name: "logto-public" },
        ],
        cleanup: { state: "not-required" }, createdAt: "2026-08-11T08:00:00.000Z", updatedAt: "2026-08-11T08:00:00.000Z",
      } },
    },
    maintenanceReceipt: receipt(),
    restoreTargetState: {
      schemaVersion: 1, launchId: "launch-target-1", releaseId: "release-target", providers: [],
      target: { workspaceId: "workspace-1", projectName: "Nautilo", environmentName: "production" },
      reconcile: { receipt: {
        schemaVersion: 1, launchId: "launch-target-1", backend: "railway", revision: 2, stage: "claimable",
        resources: [
          { kind: "railway.project", id: projectId, name: "Nautilo" },
          { kind: "railway.environment", id: environmentId, name: "production" },
          ...["app-postgres", "logto-postgres"].flatMap((name) => [
            { kind: "railway.service", id: `${name}-service`, name },
            { kind: "railway.variable-collection", id: `${environmentId}:${name}-service`, name: `variables-${name}` },
            { kind: "railway.service-image", id: `${name}-service`, name },
            { kind: "railway.deployment", id: `${name}-deployment`, name },
          ]),
          { kind: "railway.volume", id: "app-postgres-volume", name: "app-postgres-data" },
          { kind: "railway.volume", id: "logto-postgres-volume", name: "logto-postgres-data" },
          { kind: "railway.service", id: logtoServiceId, name: "logto" },
          { kind: "railway.service", id: nautiloServiceId, name: "nautilo-server" },
          { kind: "railway.domain", id: "domain-1", name: "nautilo-public" },
          { kind: "railway.domain", id: "domain-2", name: "logto-public" },
        ],
        cleanup: { state: "not-required" }, createdAt: "2026-08-11T08:06:00.000Z", updatedAt: "2026-08-11T08:06:00.000Z",
        claimableAt: "2026-08-11T08:06:00.000Z",
      } },
      databaseBootstrap: { schemaVersion: 1, projectId, environmentId, serviceName: "nautilo-bootstrap",
        imageDigest: `sha256:${sha("a")}`, serviceId: "database-bootstrap-service", variablesApplied: true,
        deploymentId: "database-bootstrap-deployment", successfulDeploymentId: "database-bootstrap-deployment" },
    },
    targetNautiloHostname: "target.example.test",
    targetLogtoHostname: "identity.example.test",
    portableRestore: {
      target: {
        state: "started", attempt: 1, operationId: portableOperationId, direction: "restore", objectId: "object-1",
        projectId, environmentId, serviceId: nautiloServiceId, image: image("nautilo-server", "e"),
        sourceReleaseId: "release-source", command, startEffect: "deploy", jobId: "restore-job-1",
      },
      cleanup: {
        schemaVersion: 1, projectId, environmentId, serviceId: nautiloServiceId, operationId: portableOperationId,
        imageDigest: sha("e"), commandSha256: createHash("sha256").update(command).digest("hex"), state: "complete", completedDeletes: 12,
      },
    },
  };
}

const connection = <T>(nodes: readonly T[]) => ({
  edges: nodes.map((node, index) => ({ cursor: `cursor-${index}`, node })),
  pageInfo: { endCursor: nodes.length === 0 ? null : `cursor-${nodes.length - 1}`, hasNextPage: false },
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid test input");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid test input");
  return value;
}

class Provider implements RailwayReconcileExecutorTransport {
  readonly events: string[] = [];
  readonly connectServiceIds: string[] = [];
  readonly services = new Map<string, RailwayService>([
    [logtoServiceId, { id: logtoServiceId, name: "logto" }],
    [nautiloServiceId, { id: nautiloServiceId, name: "nautilo-server" }],
  ]);
  readonly sources = new Map<string, string | null>([
    [logtoServiceId, null], [nautiloServiceId, image("nautilo-server", "e")],
  ]);
  readonly deployments = new Map<string, RailwayDeployment[]>();
  readonly domains = new Map<string, { id: string; domain: string; targetPort: number }[]>();
  next = 0;
  loseConnectResponse = false;
  lost = false;
  bootstrapPreexistingDeployments = 0;
  holdNautiloRunning = false;
  failNautilo = false;

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    const value = record(variables);
    this.events.push(operation.name);
    let data: unknown;
    if (operation.name === "RailwayProjectServices") data = { project: { services: connection([...this.services.values()]) } };
    else if (operation.name === "RailwayServiceCreate") {
      const id = "bootstrap-service-1"; const item = { id, name: text(record(value["input"])["name"]) }; this.services.set(id, item); this.sources.set(id, null);
      for (let index = 0; index < this.bootstrapPreexistingDeployments; index += 1) this.addDeployment(id);
      data = { serviceCreate: item };
    } else if (operation.name === "RailwayVariableCollectionUpsert") data = { variableCollectionUpsert: true };
    else if (operation.name === "RailwayServiceInstance") {
      const serviceId = text(value["serviceId"]);
      const instance: RailwayServiceInstance = { id: `instance-${serviceId}`, serviceId, environmentId, startCommand: null, source: this.sources.get(serviceId) === null ? null : { image: this.sources.get(serviceId)! }, latestDeployment: null };
      data = { serviceInstance: instance };
    } else if (operation.name === "RailwayDeployments") {
      data = { deployments: connection(this.deployments.get(text(record(value["input"])["serviceId"])) ?? []) };
    } else if (operation.name === "RailwayServiceConnect") {
      const serviceId = text(value["id"]); this.connectServiceIds.push(serviceId); this.sources.set(serviceId, text(record(value["input"])["image"]));
      const deployment = this.addDeployment(serviceId); data = { serviceConnect: this.services.get(serviceId) };
      if (this.loseConnectResponse && !this.lost) { this.lost = true; throw new Error(`provider ${deployment.id} ${secret}`); }
    } else if (operation.name === "RailwayServiceInstanceDeploy") {
      const serviceId = text(value["serviceId"]); const deployment = this.addDeployment(serviceId);
      if (serviceId === nautiloServiceId && this.holdNautiloRunning) {
        this.deployments.set(serviceId, (this.deployments.get(serviceId) ?? []).map((item) => item.id === deployment.id
          ? { ...item, status: "DEPLOYING", instances: [{ id: item.instances![0]!.id, status: "INITIALIZING" }] }
          : item));
      } else if (serviceId === nautiloServiceId && this.failNautilo) {
        this.deployments.set(serviceId, (this.deployments.get(serviceId) ?? []).map((item) => item.id === deployment.id
          ? { ...item, status: "FAILED", instances: [{ id: item.instances![0]!.id, status: "CRASHED" }] }
          : item));
      }
      data = { serviceInstanceDeployV2: deployment.id };
    } else if (operation.name === "RailwayDeployment") {
      const deployment = [...this.deployments.values()].flat().find((entry) => entry.id === text(value["id"])); data = { deployment };
    } else if (operation.name === "RailwayDomains") data = { domains: { serviceDomains: this.domains.get(text(value["serviceId"])) ?? [], customDomains: [] } };
    else if (operation.name === "RailwayServiceDomainCreate") {
      const input = record(value["input"]); const targetPort = Number(input["targetPort"]);
      const item = { id: "bootstrap-domain-1", domain: "bootstrap.example.test", targetPort };
      this.domains.set(text(input["serviceId"]), [item]); data = { serviceDomainCreate: item };
    } else if (operation.name === "RailwayServiceDelete") { this.services.delete(text(value["id"])); data = { serviceDelete: true }; }
    else throw new Error(`unexpected ${operation.name}`);
    return { outcome: "success", data } as RailwayTransportResult<RailwayOperationData<Operation>>;
  }

  addDeployment(serviceId: string): RailwayDeployment {
    const deployment = { id: `deployment-${++this.next}`, status: "SUCCESS" as const, deploymentStopped: false, instances: [{ id: `instance-${this.next}`, status: "RUNNING" as const }] };
    this.deployments.set(serviceId, [...(this.deployments.get(serviceId) ?? []), deployment]);
    return deployment;
  }

  releaseNautilo(): void {
    this.deployments.set(nautiloServiceId, (this.deployments.get(nautiloServiceId) ?? []).map((deployment) => ({
      ...deployment, status: "SUCCESS", instances: [{ id: deployment.instances![0]!.id, status: "RUNNING" }],
    })));
    this.holdNautiloRunning = false;
  }
}

async function fixture(provider = new Provider(), handoffStatus = 200) {
  const root = await mkdtemp(join(tmpdir(), "nautilo-restored-runner-"));
  const path = join(root, "maintenance-1");
  await writeRailwayMaintenanceState(root, path, initialState());
  const calls: string[] = [];
  const run = () => runRailwayRestoredTargetActivationFromState({
    stateRoot: root, statePath: path, operationId, authorityGenerationId: "authority-generation-1",
    topology: topology(), transport: provider,
    projectionInputs: {
      generatedSecrets: new Map([["logto-bootstrap-handoff-token", "t".repeat(43)]]),
      generatedPublicDomains: new Map([["nautilo-public", "https://target.example.test"]]),
      bootstrapOutputs: new Map(), externalProviderSecrets: new Map(),
    },
    fetch: (async (request) => {
      const url = request instanceof Request ? request.url : request instanceof URL ? request.toString() : request; calls.push(url);
      if (url.endsWith("/handoff") && handoffStatus !== 200) return new Response("not ready", { status: handoffStatus });
      if (url.endsWith("/handoff")) return new Response(JSON.stringify({
        "logto-workbench-app-id": "workbench-id", "logto-tui-app-id": "tui-id", "logto-tui-loopback-app-id": "loopback-id",
        "logto-desktop-app-id": "desktop-id", "logto-mobile-app-id": "mobile-id",
        "logto-mobile-web-app-id": "mobile-web-id", "logto-m2m-app-id": "m2m-id",
        "logto-m2m-app-secret": secret, "logto-resource": "https://target.example.test/api",
      }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("ready", { status: 200 });
    }) as typeof fetch,
    wait: async () => {}, readinessAttempts: 1, readinessDelayMs: 1, readinessTimeoutMs: 100,
  });
  return { root, path, provider, calls, run };
}

describe("Railway restored-target production runner", () => {
  test("orders exact activation, retained populated handoff, cleanup, and exact readiness without persisting authority", async () => {
    const value = await fixture();
    const result = await value.run();
    expect(result.outcome).toBe("complete");
    expect(value.calls).toEqual(["https://bootstrap.example.test/handoff", "https://target.example.test/health/ready"]);
    expect(value.provider.domains.get("bootstrap-service-1")).toEqual([{
      id: "bootstrap-domain-1",
      domain: "bootstrap.example.test",
      targetPort: RAILWAY_LOGTO_BOOTSTRAP_PORT,
    }]);
    expect(value.provider.events.join("|")).not.toContain("Latest");
    expect(value.provider.events.join("|")).not.toContain("seed");
    const inventory = JSON.stringify(await (await import("../../src/lib/railway-maintenance-state")).readRailwayMaintenanceState(value.root, value.path));
    expect(inventory).not.toContain(secret);
    expect(inventory).not.toContain("https://");
  }, RESTORED_TARGET_SCENARIO_TIMEOUT_MS);

  test("recovers a lost connect response from the unique raw baseline without a second connect", async () => {
    const provider = new Provider(); provider.loseConnectResponse = true;
    const value = await fixture(provider);
    expect((await value.run()).outcome).toBe("complete");
    expect(provider.events.filter((event) => event === "RailwayServiceConnect").length).toBe(2);
    expect(provider.connectServiceIds.filter((id) => id === logtoServiceId)).toHaveLength(1);
    expect(provider.deployments.get(logtoServiceId)).toHaveLength(1);
  }, RESTORED_TARGET_SCENARIO_TIMEOUT_MS);

  test("keeps an exhausted transient handoff fetch resumable and retains its exact service", async () => {
    const provider = new Provider();
    const value = await fixture(provider, 502);
    expect(await value.run()).toMatchObject({ outcome: "pending", stage: "bootstrap-nautilo-start" });
    expect(provider.services.has("bootstrap-service-1")).toBe(true);
    expect(provider.deployments.get(nautiloServiceId)).toBeUndefined();
  }, RESTORED_TARGET_SCENARIO_TIMEOUT_MS);

  test("fails closed on authority drift before resuming provider effects", async () => {
    const value = await fixture();
    const first = await value.run();
    expect(first.outcome).toBe("complete");
    const changed = { ...topology(), releaseId: "other-release" };
    let rejected = false;
    try {
      await runRailwayRestoredTargetActivationFromState({
        stateRoot: value.root, statePath: value.path, operationId, authorityGenerationId: "authority-generation-1",
        topology: changed, transport: value.provider,
        projectionInputs: { generatedSecrets: new Map(), generatedPublicDomains: new Map(), bootstrapOutputs: new Map(), externalProviderSecrets: new Map() },
      });
    } catch { rejected = true; }
    expect(rejected).toBe(true);
  }, RESTORED_TARGET_SCENARIO_TIMEOUT_MS);

  test("rejects rotated recovery authority before any provider or HTTPS effect", async () => {
    const value = await fixture();
    let rejected = false;
    try {
      await runRailwayRestoredTargetActivationFromState({
        stateRoot: value.root, statePath: value.path, operationId, authorityGenerationId: "authority-generation-2",
        topology: topology(), transport: value.provider,
        projectionInputs: {
          generatedSecrets: new Map([["logto-bootstrap-handoff-token", "t".repeat(43)]]),
          generatedPublicDomains: new Map([["nautilo-public", "https://target.example.test"]]),
          bootstrapOutputs: new Map(), externalProviderSecrets: new Map(),
        },
      });
    } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(value.provider.events).toHaveLength(0);
    expect(value.calls).toHaveLength(0);

    rejected = false;
    try {
      await runRailwayRestoredTargetActivationFromState({
        stateRoot: value.root, statePath: value.path, operationId, authorityGenerationId: "authority-generation-1",
        topology: topology(), transport: value.provider,
        projectionInputs: {
          generatedSecrets: new Map([["logto-bootstrap-handoff-token", "t".repeat(43)]]),
          generatedPublicDomains: new Map([["nautilo-public", "https://target.example.test"], ["logto-public", "https://attacker.example.test"]]),
          bootstrapOutputs: new Map(), externalProviderSecrets: new Map(),
        },
      });
    } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(value.provider.events).toHaveLength(0);
  });

  test("rejects unowned one-or-more bootstrap deployments instead of adopting latest", async () => {
    for (const count of [1, 2]) {
      const provider = new Provider(); provider.bootstrapPreexistingDeployments = count;
      const value = await fixture(provider);
      expect((await value.run()).outcome).toBe("failure");
      expect(provider.connectServiceIds).not.toContain("bootstrap-service-1");
      expect(provider.services.has("bootstrap-service-1")).toBe(true);
    }
  }, RESTORED_TARGET_SCENARIO_TIMEOUT_MS);

  test("retains the handoff service while Nautilo is running, then resumes without redeploy", async () => {
    const provider = new Provider(); provider.holdNautiloRunning = true;
    const value = await fixture(provider);
    expect(await value.run()).toMatchObject({ outcome: "pending", stage: "bootstrap-nautilo-start" });
    const pending = await (await import("../../src/lib/railway-maintenance-state")).readRailwayMaintenanceState(value.root, value.path);
    expect(pending?.restoredLogtoBootstrap?.lifecycle.handoffApplied).toBeUndefined();
    expect(provider.services.has("bootstrap-service-1")).toBe(true);
    provider.releaseNautilo();
    expect((await value.run()).outcome).toBe("complete");
    expect(provider.deployments.get(nautiloServiceId)).toHaveLength(1);
    expect(provider.services.has("bootstrap-service-1")).toBe(false);
  }, RESTORED_TARGET_SCENARIO_TIMEOUT_MS);

  test("retains the handoff service across bounded failed Nautilo retries", async () => {
    const provider = new Provider(); provider.failNautilo = true;
    const value = await fixture(provider);
    expect(await value.run()).toMatchObject({ outcome: "pending", stage: "bootstrap-nautilo-start" });
    const pending = await (await import("../../src/lib/railway-maintenance-state")).readRailwayMaintenanceState(value.root, value.path);
    expect(pending?.restoredLogtoBootstrap?.lifecycle.handoffApplied).toBeUndefined();
    expect(provider.services.has("bootstrap-service-1")).toBe(true);
    expect(provider.deployments.get(nautiloServiceId)).toHaveLength(2);
  }, RESTORED_TARGET_SCENARIO_TIMEOUT_MS);
});
