import { describe, expect, test } from "bun:test";
import { createMaintenanceReceipt } from "@nautilo/hosting";
import type {
  RailwayDesiredStateTarget,
  RailwayGraphqlVariables,
  RailwayOperation,
  RailwayOperationData,
  RailwayOperationVariables,
  RailwayReconcileExecutorTransport,
  RailwayTopology,
  RailwayTransportResult,
} from "@nautilo/railway-hosting";

import type { RailwayMaintenanceState } from "../../src/lib/railway-maintenance-state";
import { classifyRailwayActivationAdapterFailure, createRailwayAuthorityGuardedFetch, createRailwayUpgradeStageAdapters,
  mergeRailwayUpgradeWorkflow, selectRailwayPortableMaintenanceImage,
  type RailwayUpgradeStageAdaptersInput } from "../../src/lib/railway-upgrade-stage-adapters";
import type { RailwayUpgradeReceiptStageContext } from "../../src/lib/railway-upgrade-runner";

const timestamp = "2026-08-12T09:00:00.000Z";
const digest = "a".repeat(64);
const image = (name: string) => `registry.example.test/${name}@sha256:${digest}`;
const serviceNames = ["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"] as const;

function initial(): RailwayMaintenanceState {
  return {
    schemaVersion: 1, revision: 0, maintenanceId: "maintenance-1", sourceLaunchId: "launch-1",
    authorityGenerationId: "authority-1", sourceManagedWorkbenchHostname: "source.example.test",
    maintenanceReceipt: createMaintenanceReceipt({ maintenanceId: "maintenance-1", launchId: "launch-1", backend: "railway",
      sourceReleaseId: "release-old", targetReleaseId: "release-new", now: timestamp }),
    sourceLaunchState: {
      schemaVersion: 1, launchId: "launch-1", releaseId: "release-old", providers: [],
      target: { workspaceId: "workspace-1", projectName: "project-name", environmentName: "production" },
      reconcile: { receipt: { schemaVersion: 1, launchId: "launch-1", backend: "railway", revision: 1, stage: "authorized",
        cleanup: { state: "not-required" }, createdAt: timestamp, updatedAt: timestamp, resources: [
          { kind: "railway.project", id: "project-1", name: "project-name" },
          { kind: "railway.environment", id: "environment-1", name: "production" },
          ...serviceNames.map((name) => ({ kind: "railway.service", id: `service-${name}`, name })),
          { kind: "railway.deployment", id: "deployment-logto", name: "logto" },
          { kind: "railway.deployment", id: "deployment-nautilo", name: "nautilo-server" },
        ] } },
    },
  };
}

class QuiesceTransport implements RailwayReconcileExecutorTransport {
  readonly calls: { readonly name: string; readonly variables: unknown }[] = [];
  readonly stopped = new Set<string>();
  fail = false;

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push({ name: operation.name, variables: structuredClone(variables) });
    if (this.fail) {
      const failed: RailwayTransportResult<unknown> = { outcome: "failure",
        failure: { kind: "network-failure", operation: operation.name } };
      return failed as RailwayTransportResult<RailwayOperationData<Operation>>;
    }
    const value = variables as Readonly<Record<string, unknown>>;
    let data: unknown;
    if (operation.name === "RailwayDeployment") {
      const id = String(value["id"]); data = { deployment: { id, deploymentStopped: this.stopped.has(id) } };
    } else if (operation.name === "RailwayDeploymentStop") {
      this.stopped.add(String(value["id"])); data = { deploymentStop: true };
    } else throw new Error(`unexpected operation ${operation.name}`);
    return { outcome: "success", data } as RailwayTransportResult<RailwayOperationData<Operation>>;
  }
}

class BackupTransport implements RailwayReconcileExecutorTransport {
  readonly calls: string[] = [];
  readonly backups = new Map<string, { readonly id: string; readonly name: string; readonly createdAt: string; readonly expiresAt: null }>();

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push(operation.name);
    const value = variables as Readonly<Record<string, unknown>>; let data: unknown;
    if (operation.name === "RailwayVolumeInstanceBackupList") {
      const found = this.backups.get(String(value["volumeInstanceId"])); data = { volumeInstanceBackupList: found === undefined ? [] : [found] };
    } else if (operation.name === "RailwayVolumeInstanceBackupCreate") {
      const volume = String(value["volumeInstanceId"]); const name = String(value["name"]);
      this.backups.set(volume, { id: `backup-${volume}`, name, createdAt: timestamp, expiresAt: null });
      data = { volumeInstanceBackupCreate: { workflowId: `workflow-${volume}` } };
    } else if (operation.name === "RailwayWorkflowStatus") data = { workflowStatus: { status: "Complete", error: null } };
    else if (operation.name === "RailwayVolumeInstanceBackupLock") data = { volumeInstanceBackupLock: true };
    else throw new Error(`unexpected operation ${operation.name}`);
    return { outcome: "success", data } as RailwayTransportResult<RailwayOperationData<Operation>>;
  }
}

function fixture(transport: RailwayReconcileExecutorTransport): RailwayUpgradeStageAdaptersInput {
  return {
    stateRoot: "/unused", statePath: "unused.json", operationId: "maintenance-1", authorityGenerationId: "authority-1", transport,
    recoveryConfig: { endpoint: "https://s3.example.test", region: "test-1", bucket: "recovery-bucket", objectPrefix: "prefix",
      accessKeyId: "access-secret", secretAccessKey: "secret-secret", sessionToken: "session-secret", encryptionKey: new Uint8Array(32) },
    backup: { targets: [
      { kind: "application-postgres", volumeInstanceId: "volume-app", backupName: "maintenance app" },
      { kind: "logto-postgres", volumeInstanceId: "volume-logto", backupName: "maintenance logto" },
      { kind: "server-volume", volumeInstanceId: "volume-server", backupName: "maintenance server" },
    ] },
    portable: { exportOperationId: "export-1", objectId: "object-1",
      sourceMaintenanceImage: image("nautilo-server-old"), targetMaintenanceImage: image("nautilo-server"), sourceAppDatabaseUrl: "postgres://source-app",
      sourceLogtoDatabaseUrl: "postgres://source-logto", targetAppDatabaseUrl: "postgres://target-app",
      targetLogtoDatabaseUrl: "postgres://target-logto" },
    candidate: { releaseId: "release-new", projectId: "project-1", environmentId: "environment-1",
      services: serviceNames.map((name) => ({ name, serviceId: `service-${name}`, oldImage: image(`${name}-old`),
        newImage: image(name), kind: name === "logto-seed" ? "run-once" : "long-lived" })),
      migration: { migrationId: "migration-1", executionId: "execution-1" } },
    targetLaunchId: "launch-restore", providers: [], topology: {} as RailwayTopology,
    projectionInputs: { generatedSecrets: new Map(), generatedPublicDomains: new Map(), bootstrapOutputs: new Map(), externalProviderSecrets: new Map() },
    target: {} as RailwayDesiredStateTarget, now: () => timestamp, wait: async () => undefined,
    readinessAttempts: 1, readinessDelayMs: 1, readinessTimeoutMs: 1,
  };
}

function context(state: RailwayMaintenanceState): { readonly context: RailwayUpgradeReceiptStageContext; readonly loads: () => number } {
  let current = state; let loadCount = 0;
  return {
    loads: () => loadCount,
    context: {
      state,
      loadState: async () => { loadCount += 1; return current; },
      persistReceipt: async (receipt) => { current = { ...current, revision: current.revision + 1, maintenanceReceipt: receipt }; return current; },
    },
  };
}

describe("production Railway upgrade stage adapters", () => {
  test("keeps portable export on the installed source image and restore on the verified target image", () => {
    const portable = fixture(new QuiesceTransport()).portable;

    expect(portable.sourceMaintenanceImage).not.toBe(portable.targetMaintenanceImage);
    expect(selectRailwayPortableMaintenanceImage(portable, "export")).toBe(image("nautilo-server-old"));
    expect(selectRailwayPortableMaintenanceImage(portable, "restore")).toBe(image("nautilo-server"));
  });

  test("fences every stage before provider effects after interruption", async () => {
    const transport = new QuiesceTransport();
    const adapters = createRailwayUpgradeStageAdapters({ ...fixture(transport), interrupted: () => true });
    expect(await adapters.quiesce(context(initial()).context)).toEqual({ outcome: "pending" });
    expect(transport.calls).toEqual([]);
  });

  test("quiesces the exact retained deployments in order and persists proof only after observation", async () => {
    const transport = new QuiesceTransport();
    const adapters = createRailwayUpgradeStageAdapters(fixture(transport));
    const scoped = context(initial());

    expect(await adapters.quiesce(scoped.context)).toEqual({ outcome: "complete" });
    expect(transport.calls.map(({ name }) => name)).toEqual([
      "RailwayDeployment", "RailwayDeploymentStop", "RailwayDeployment",
      "RailwayDeployment", "RailwayDeploymentStop", "RailwayDeployment",
    ]);
    expect(transport.calls.map(({ variables }) => variables)).toEqual([
      { id: "deployment-nautilo" }, { id: "deployment-nautilo" }, { id: "deployment-nautilo" },
      { id: "deployment-logto" }, { id: "deployment-logto" }, { id: "deployment-logto" },
    ]);
    expect((await scoped.context.loadState()).maintenanceReceipt.stage).toBe("quiesced");
    expect(scoped.loads()).toBeGreaterThanOrEqual(transport.calls.length);
    expect(JSON.stringify(transport.calls)).not.toContain("secret-secret");
  });

  test("maps provider observation failure to pending without inventing quiescence", async () => {
    const transport = new QuiesceTransport(); transport.fail = true;
    const adapters = createRailwayUpgradeStageAdapters(fixture(transport));
    const scoped = context(initial());

    expect(await adapters.quiesce(scoped.context)).toEqual({ outcome: "pending" });
    expect((await scoped.context.loadState()).maintenanceReceipt.stage).toBe("planned");
  });

  test("rejects a non-exact backup inventory before any provider effect", async () => {
    const transport = new QuiesceTransport();
    const input = fixture(transport);
    const adapters = createRailwayUpgradeStageAdapters({ ...input, backup: { targets: [input.backup.targets[0]!, input.backup.targets[0]!, input.backup.targets[2]!] } });
    const before = initial();
    const state: RailwayMaintenanceState = { ...before,
      maintenanceReceipt: { ...before.maintenanceReceipt, revision: 1, stage: "quiesced", updatedAt: timestamp } };

    expect(await adapters.backupExactlyThree(context(state).context)).toEqual({ outcome: "terminal-failure" });
    expect(transport.calls).toEqual([]);
  });

  test("creates and locks exactly three durable named backups through the real executor", async () => {
    const transport = new BackupTransport(); const adapters = createRailwayUpgradeStageAdapters(fixture(transport));
    const before = initial(); const state: RailwayMaintenanceState = { ...before,
      maintenanceReceipt: { ...before.maintenanceReceipt, revision: 1, stage: "quiesced", updatedAt: timestamp } };
    const scoped = context(state);

    expect(await adapters.backupExactlyThree(scoped.context)).toEqual({ outcome: "complete" });
    const receipt = (await scoped.context.loadState()).maintenanceReceipt;
    expect(receipt.stage).toBe("provider-backup");
    expect(receipt.backupSet?.backups).toEqual([
      { kind: "application-postgres", backupId: "backup-volume-app" },
      { kind: "logto-postgres", backupId: "backup-volume-logto" },
      { kind: "server-volume", backupId: "backup-volume-server" },
    ]);
    expect(receipt.providerWorkflows?.map(({ operation, state: workflowState }) => ({ operation, state: workflowState }))).toEqual([
      { operation: "backup-application-postgres", state: "complete" },
      { operation: "backup-logto-postgres", state: "complete" },
      { operation: "backup-server-volume", state: "complete" },
    ]);
    expect(transport.calls.filter((name) => name === "RailwayVolumeInstanceBackupCreate")).toHaveLength(3);
  });

  test("recovers exact named backups after create-response checkpoint loss", async () => {
    const transport = new BackupTransport(); const input = fixture(transport);
    for (const target of input.backup.targets) {
      transport.backups.set(target.volumeInstanceId, {
        id: `backup-${target.volumeInstanceId}`,
        name: target.backupName,
        createdAt: timestamp,
        expiresAt: null,
      });
    }
    const adapters = createRailwayUpgradeStageAdapters(input);
    const before = initial(); const scoped = context({ ...before,
      maintenanceReceipt: { ...before.maintenanceReceipt, revision: 1, stage: "quiesced", updatedAt: timestamp } });

    expect(await adapters.backupExactlyThree(scoped.context)).toEqual({ outcome: "complete" });
    const receipt = (await scoped.context.loadState()).maintenanceReceipt;
    expect(receipt.providerWorkflows?.map(({ workflowId, state }) => ({ workflowId, state }))).toEqual([
      { workflowId: "backup-volume-app", state: "complete" },
      { workflowId: "backup-volume-logto", state: "complete" },
      { workflowId: "backup-volume-server", state: "complete" },
    ]);
    expect(transport.calls.filter((name) => name === "RailwayVolumeInstanceBackupCreate")).toEqual([]);
    expect(transport.calls.filter((name) => name === "RailwayVolumeInstanceBackupLock")).toHaveLength(3);
  });

  test("uses only the receipt-owned HTTPS origin and persists exact candidate verification", async () => {
    const transport = new QuiesceTransport(); const input = fixture(transport); const urls: string[] = [];
    const readyFetch: typeof fetch = Object.assign(async (url: string | URL | Request) => {
      urls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      return new Response(null, { status: 200 });
    }, { preconnect: fetch.preconnect });
    const adapters = createRailwayUpgradeStageAdapters({ ...input, fetch: readyFetch });
    const before = initial(); const state: RailwayMaintenanceState = { ...before,
      maintenanceReceipt: { ...before.maintenanceReceipt, revision: 6, stage: "migration", updatedAt: timestamp,
        release: { releaseId: "release-new", appliedAt: timestamp }, migration: { migrationId: "migration-1", completedAt: timestamp } } };
    const scoped = context(state);

    expect(await adapters.verifyCandidateHttps(scoped.context)).toEqual({ outcome: "complete" });
    expect(urls).toEqual(["https://source.example.test/health/ready"]);
    expect((await scoped.context.loadState()).maintenanceReceipt.verification).toEqual({ subject: "candidate", verifiedAt: timestamp });
  });

  test("keeps bounded HTTPS exhaustion pending for both candidate and restored targets", async () => {
    const unavailable: typeof fetch = Object.assign(async () => new Response(null, { status: 503 }), { preconnect: fetch.preconnect });
    const base = fixture(new QuiesceTransport());
    const adapters = createRailwayUpgradeStageAdapters({ ...base, fetch: unavailable, readinessAttempts: 1 });
    const candidate = initial();
    const restored: RailwayMaintenanceState = { ...candidate, targetNautiloHostname: "restore.example.test" };

    expect(await adapters.verifyCandidateHttps(context(candidate).context)).toEqual({ outcome: "pending" });
    expect(await adapters.verifyRestoredTargetHttps(context(restored).context)).toEqual({ outcome: "pending" });
  });

  test("revalidates durable authority immediately before every HTTPS attempt", async () => {
    let calls = 0; let loads = 0;
    const unavailable: typeof fetch = Object.assign(async () => { calls += 1; return new Response(null, { status: 503 }); },
      { preconnect: fetch.preconnect });
    const adapters = createRailwayUpgradeStageAdapters({ ...fixture(new QuiesceTransport()), fetch: unavailable,
      readinessAttempts: 2, wait: async () => undefined });
    const state = initial();
    const guarded: RailwayUpgradeReceiptStageContext = {
      state,
      loadState: async () => {
        loads += 1;
        if (loads >= 3) throw new Error("rotated authority");
        return state;
      },
      persistReceipt: async () => { throw new Error("must not persist"); },
    };

    expect(await adapters.verifyCandidateHttps(guarded)).toEqual({ outcome: "pending" });
    expect(calls).toBe(1);
  });

  test("never regresses completed export or restore workflows to pending after response loss", () => {
    for (const operation of ["export-portable", "restore-portable"] as const) {
      const completed = [{ operation, workflowId: `${operation}-job`, state: "complete" as const, completedAt: timestamp }];
      expect(mergeRailwayUpgradeWorkflow(completed, { operation, workflowId: `${operation}-job`, state: "pending" })).toBe(completed);
    }
  });

  test("classifies transient activation failures pending and semantic failures terminal", () => {
    for (const code of ["executor-failure", "persistence-failure", "readiness-failed"] as const) {
      expect(classifyRailwayActivationAdapterFailure(code)).toEqual({ outcome: "pending" });
    }
    expect(classifyRailwayActivationAdapterFailure("projection-failed")).toEqual({ outcome: "terminal-failure" });
  });

  test("the activation fetch guard blocks network I/O after authority rotation", async () => {
    let networkCalls = 0;
    const request: typeof fetch = Object.assign(async () => { networkCalls += 1; return new Response(null, { status: 200 }); },
      { preconnect: fetch.preconnect });
    const guarded = createRailwayAuthorityGuardedFetch(async () => { throw new Error("rotated authority"); }, request);
    let failure: unknown;
    try { await guarded("https://restore.example.test/health/ready"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(networkCalls).toBe(0);
  });
});
