import { describe, expect, test } from "bun:test";
import type { PortableTransferAuthority } from "@nautilo/hosting";

import {
  RailwayPortableMaintenanceTarget,
  RailwayPortableMaintenanceTargetError,
  type PortableRecoveryDescriptor,
  type RailwayPortableMaintenanceBinding,
  type RailwayPortableMaintenanceExecutor,
  type RailwayPortableMaintenanceTargetCheckpoint,
} from "../../src/portable-maintenance-target";
import { RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES } from "../../src/portable-maintenance-cleanup";
import type { RailwayDeployment, RailwayServiceInstance } from "../../src/operations";

const image = `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}`;
const sha = "b".repeat(64);
const authority: PortableTransferAuthority = {
  endpoint: "https://objects.example.test",
  region: "auto",
  bucket: "recovery",
  accessKeyId: "ACCESS_SECRET",
  secretAccessKey: "SECRET_SECRET",
  encryptionKey: new Uint8Array(32).fill(7),
};
const descriptor: PortableRecoveryDescriptor = {
  operationId: "operation-1", objectId: "object-1", ciphertextSha256: sha,
  ciphertextBytes: 4096,
  sourceReleaseId: "release-1", completedAt: "2026-08-12T10:00:00.000Z",
};

function binding(direction: "export" | "restore" = "export"): RailwayPortableMaintenanceBinding {
  return {
    projectId: "project-1", environmentId: "environment-1", serviceId: "service-1", image,
    direction, operationId: "operation-1", objectId: "object-1", sourceReleaseId: "release-1",
    appDatabaseUrl: "postgres://app:APP_SECRET@app.internal/app",
    logtoDatabaseUrl: "postgres://logto:LOGTO_SECRET@logto.internal/logto",
    ...(direction === "restore" ? { expectedSha256: sha } : {}),
  };
}

class FixtureExecutor implements RailwayPortableMaintenanceExecutor {
  readonly calls: Array<{ readonly name: string; readonly input: unknown }> = [];
  deployments: RailwayDeployment[] = [{ id: "old", status: "REMOVED" }];
  source: RailwayServiceInstance["source"] = { image, repo: null };
  startCommand: string | null = null;
  responseLoss = false;
  addedOnStart = 1;
  terminal: RailwayDeployment = { id: "job-1", status: "SUCCESS", instances: [{ id: "instance-1", status: "EXITED" }] };

  async upsertVariables(input: Parameters<RailwayPortableMaintenanceExecutor["upsertVariables"]>[0]) { this.calls.push({ name: "variables", input }); }
  async setServiceStartCommand(input: Parameters<RailwayPortableMaintenanceExecutor["setServiceStartCommand"]>[0]) { this.startCommand = input.startCommand; this.calls.push({ name: "command", input }); }
  async getServiceInstance(input: Parameters<RailwayPortableMaintenanceExecutor["getServiceInstance"]>[0]) {
    this.calls.push({ name: "instance", input });
    return { id: "instance-1", serviceId: "service-1", environmentId: "environment-1", source: this.source, startCommand: this.startCommand };
  }
  async listDeploymentsRaw(input: Parameters<RailwayPortableMaintenanceExecutor["listDeploymentsRaw"]>[0]) { this.calls.push({ name: "inventory", input }); return [...this.deployments]; }
  async #start(name: string, input: unknown) {
    this.calls.push({ name, input });
    const offset = this.deployments.filter(({ id }) => id.startsWith("job-")).length;
    for (let index = 0; index < this.addedOnStart; index += 1) this.deployments.push({ id: `job-${offset + index + 1}`, status: index === 0 ? "SUCCESS" : "SKIPPED" });
    if (this.responseLoss) throw new Error("response lost");
  }
  async createDeployment(input: Parameters<RailwayPortableMaintenanceExecutor["createDeployment"]>[0]) { await this.#start("deploy", input); return this.deployments.at(-1)!; }
  async connectService(input: Parameters<RailwayPortableMaintenanceExecutor["connectService"]>[0]) { this.source = { image: input.image, repo: null }; await this.#start("connect", input); return await this.getServiceInstance({ serviceId: input.serviceId, environmentId: input.environmentId }); }
  async getDeployment(input: Parameters<RailwayPortableMaintenanceExecutor["getDeployment"]>[0]) { this.calls.push({ name: "deployment", input }); return { ...this.terminal, id: input.deploymentId }; }
}

function fixture(direction: "export" | "restore" = "export", executor = new FixtureExecutor()) {
  let checkpoint: RailwayPortableMaintenanceTargetCheckpoint | undefined;
  const persisted: RailwayPortableMaintenanceTargetCheckpoint[] = [];
  let observed: { state: "complete"; descriptor: PortableRecoveryDescriptor } | { state: "not-found" | "inconsistent" } = { state: "complete", descriptor };
  const target = new RailwayPortableMaintenanceTarget({
    binding: binding(direction), authority, executor,
    descriptorProbe: { observe: async () => observed },
    deploymentObservationAttempts: 1,
    loadCheckpoint: async () => checkpoint,
    persistCheckpoint: async (value) => { checkpoint = structuredClone(value); persisted.push(structuredClone(value)); },
  });
  return { target, executor, persisted, checkpoint: () => checkpoint, setCheckpoint: (value: RailwayPortableMaintenanceTargetCheckpoint) => { checkpoint = value; }, setObserved: (value: typeof observed) => { observed = value; } };
}

describe("RailwayPortableMaintenanceTarget", () => {
  test("forwards the exact request-memory prefix and session credential only to descriptor observation", async () => {
    const executor = new FixtureExecutor();
    let checkpoint: RailwayPortableMaintenanceTargetCheckpoint | undefined;
    let observed: unknown;
    const target = new RailwayPortableMaintenanceTarget({
      binding: { ...binding(), storagePrefix: "tenant/backup", storageSessionToken: "SESSION_SECRET" },
      authority, executor,
      descriptorProbe: { observe: async (input) => { observed = structuredClone(input); return { state: "complete", descriptor }; } },
      deploymentObservationAttempts: 1,
      loadCheckpoint: async () => checkpoint,
      persistCheckpoint: async (value) => { checkpoint = structuredClone(value); },
    });
    const job = await target.startExport({ operationId: "operation-1", objectId: "object-1", authority });
    expect(await target.observe(job.jobId)).toMatchObject({ state: "complete" });
    expect(observed).toMatchObject({ operationId: "operation-1", objectId: "object-1", prefix: "tenant/backup", sessionToken: "SESSION_SECRET" });
    expect(JSON.stringify(checkpoint)).not.toContain("SESSION_SECRET");
  });

  test("upserts every fixed request-memory variable, checkpoints before deploy, and persists no secret", async () => {
    const value = fixture();
    const result = await value.target.startExport({ operationId: "operation-1", objectId: "object-1", authority });
    expect(result).toEqual({ jobId: "job-1" });
    expect(value.executor.calls.map(({ name }) => name)).toEqual(["instance", "variables", "command", "instance", "inventory", "deploy", "instance", "inventory"]);
    const variables = (value.executor.calls[1]!.input as { variables: Record<string, string> }).variables;
    expect(Object.keys(variables).sort()).toEqual([...RAILWAY_PORTABLE_MAINTENANCE_CLEANUP_VARIABLES]);
    expect(variables["NAUTILO_RECOVERY_S3_PREFIX"]).toBe("");
    expect(variables["NAUTILO_RECOVERY_S3_SESSION_TOKEN"]).toBe("");
    expect(variables["NAUTILO_RECOVERY_EXPECTED_SHA256"]).toBe("");
    expect(value.persisted.map(({ state }) => state)).toEqual(["prepared", "start-pending", "started"]);
    expect(JSON.stringify(value.persisted)).not.toContain("SECRET");
    expect(JSON.stringify(value.persisted)).not.toContain("postgres://");
    expect(JSON.stringify(value.persisted)).not.toContain(Buffer.from(authority.encryptionKey).toString("base64url"));
  });

  test("connects an exact digest for a source-less scaffold and deploys an existing exact source", async () => {
    const freshExecutor = new FixtureExecutor();
    freshExecutor.source = null;
    const fresh = fixture("restore", freshExecutor);
    await fresh.target.startRestore({ operationId: "operation-1", objectId: "object-1", expectedSha256: sha, authority });
    expect(freshExecutor.calls.some(({ name }) => name === "connect")).toBe(true);
    expect((freshExecutor.calls.find(({ name }) => name === "variables")!.input as { variables: Record<string, string> }).variables["NAUTILO_RECOVERY_EXPECTED_SHA256"]).toBe(sha);
    const existing = fixture();
    await existing.target.startExport({ operationId: "operation-1", objectId: "object-1", authority });
    expect(existing.executor.calls.some(({ name }) => name === "deploy")).toBe(true);
    expect(existing.executor.calls.some(({ name }) => name === "connect")).toBe(false);
  });

  test("recovers exactly one raw deployment after response loss", async () => {
    const executor = new FixtureExecutor(); executor.responseLoss = true;
    const value = fixture("export", executor);
    expect(await value.target.startExport({ operationId: "operation-1", objectId: "object-1", authority })).toEqual({ jobId: "job-1" });
    expect(value.checkpoint()).toMatchObject({ state: "started", jobId: "job-1" });
  });

  test("switches a source-committed zero-diff connect to one later deploy without reconnecting", async () => {
    const executor = new FixtureExecutor(); executor.source = null; executor.responseLoss = true; executor.addedOnStart = 0;
    const value = fixture("restore", executor);
    let failure: unknown;
    try { await value.target.startRestore({ operationId: "operation-1", objectId: "object-1", expectedSha256: sha, authority }); } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(RailwayPortableMaintenanceTargetError);
    expect(value.checkpoint()).toMatchObject({ state: "start-unknown", attempt: 1, startEffect: "connect" });
    expect(await value.target.find("operation-1")).toBeUndefined();
    expect(value.checkpoint()).toMatchObject({ state: "prepared", attempt: 2, startEffect: "deploy" });
    executor.responseLoss = false; executor.addedOnStart = 1;
    expect(await value.target.startRestore({ operationId: "operation-1", objectId: "object-1", expectedSha256: sha, authority })).toEqual({ jobId: "job-1" });
    expect(executor.calls.filter(({ name }) => name === "connect")).toHaveLength(1);
    expect(executor.calls.filter(({ name }) => name === "deploy")).toHaveLength(1);
  });

  test("records a zero-diff uncertain start and permits exactly one deliberate later attempt", async () => {
    const executor = new FixtureExecutor(); executor.responseLoss = true; executor.addedOnStart = 0;
    const value = fixture("export", executor);
    let failure: unknown;
    try { await value.target.startExport({ operationId: "operation-1", objectId: "object-1", authority }); } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(RailwayPortableMaintenanceTargetError);
    expect(value.checkpoint()).toMatchObject({ state: "start-unknown", attempt: 1 });
    expect(executor.calls.filter(({ name }) => name === "deploy")).toHaveLength(1);
    expect(await value.target.find("operation-1")).toBeUndefined();
    expect(value.checkpoint()).toMatchObject({ state: "prepared", attempt: 2 });
    executor.responseLoss = false; executor.addedOnStart = 1;
    expect(await value.target.startExport({ operationId: "operation-1", objectId: "object-1", authority })).toEqual({ jobId: "job-1" });
    expect(executor.calls.filter(({ name }) => name === "deploy")).toHaveLength(2);
  });

  test("recovers a crash-shaped pending checkpoint through unknown before permitting a new attempt", async () => {
    const value = fixture("restore");
    value.executor.startCommand = "bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts restore operation-1 object-1";
    value.executor.source = null;
    value.setCheckpoint({
      state: "start-pending", attempt: 1, operationId: "operation-1", direction: "restore", objectId: "object-1",
      projectId: "project-1", environmentId: "environment-1", serviceId: "service-1", image, sourceReleaseId: "release-1",
      command: "bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts restore operation-1 object-1", startEffect: "connect", baselineDeploymentIds: ["old"],
    });
    let firstFailure: unknown;
    try { await value.target.find("operation-1"); } catch (cause) { firstFailure = cause; }
    expect(firstFailure).toBeInstanceOf(RailwayPortableMaintenanceTargetError);
    expect(value.checkpoint()).toMatchObject({ state: "start-unknown", attempt: 1 });
    expect(await value.target.find("operation-1")).toBeUndefined();
    expect(value.checkpoint()).toMatchObject({ state: "prepared", attempt: 2 });
  });

  test("fails closed when more than one raw deployment differs", async () => {
    const executor = new FixtureExecutor(); executor.responseLoss = true; executor.addedOnStart = 2;
    const value = fixture("export", executor);
    let failure: unknown;
    try { await value.target.startExport({ operationId: "operation-1", objectId: "object-1", authority }); } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(RailwayPortableMaintenanceTargetError);
  });

  test("requires an exited successful job and an exact immutable export descriptor", async () => {
    const value = fixture();
    const job = await value.target.startExport({ operationId: "operation-1", objectId: "object-1", authority });
    expect(await value.target.observe(job.jobId)).toEqual({ state: "complete", objectId: "object-1", sha256: sha, completedAt: descriptor.completedAt });
    value.setObserved({ state: "inconsistent" });
    expect(await value.target.observe(job.jobId)).toEqual({ state: "running" });
    value.setObserved({ state: "complete", descriptor });
    expect(await value.target.observe(job.jobId)).toEqual({ state: "complete", objectId: "object-1", sha256: sha, completedAt: descriptor.completedAt });
    value.setObserved({ state: "complete", descriptor: { ...descriptor, sourceReleaseId: "other" } });
    expect(await value.target.observe(job.jobId)).toEqual({ state: "error" });
    value.setObserved({ state: "not-found" });
    value.executor.terminal = { id: "job-1", status: "SUCCESS", instances: [{ id: "instance-1", status: "RUNNING" }] };
    expect(await value.target.observe(job.jobId)).toEqual({ state: "running" });
    value.executor.terminal = { id: "job-1", status: "SUCCESS", instances: [{ id: "instance-1", status: "STOPPED" }] };
    expect(await value.target.observe(job.jobId)).toEqual({ state: "error" });
  });

  test("requires the exact restore source descriptor and the runtime's successful exited terminal", async () => {
    const value = fixture("restore");
    const job = await value.target.startRestore({ operationId: "operation-1", objectId: "object-1", expectedSha256: sha, authority });
    expect(await value.target.observe(job.jobId)).toMatchObject({ state: "complete", sha256: sha });
    value.executor.terminal = { id: "job-1", status: "SUCCESS", instances: [{ id: "instance-1", status: "RUNNING" }] };
    expect(await value.target.observe(job.jobId)).toEqual({ state: "running" });
  });

  test("turns a failed terminal into a bounded next-attempt redeploy on a later find", async () => {
    const value = fixture("restore");
    const first = await value.target.startRestore({ operationId: "operation-1", objectId: "object-1", expectedSha256: sha, authority });
    value.executor.terminal = { id: first.jobId, status: "FAILED", instances: [{ id: "instance-1", status: "CRASHED" }] };
    expect(await value.target.find("operation-1")).toBeUndefined();
    expect(value.checkpoint()).toMatchObject({ state: "prepared", attempt: 2 });
    const second = await value.target.startRestore({ operationId: "operation-1", objectId: "object-1", expectedSha256: sha, authority });
    expect(second).toEqual({ jobId: "job-2" });
    expect(value.checkpoint()).toMatchObject({ state: "started", attempt: 2 });
  });

  test("never retries a failed export without its immutable descriptor", async () => {
    const value = fixture("export");
    const first = await value.target.startExport({ operationId: "operation-1", objectId: "object-1", authority });
    value.setObserved({ state: "not-found" });
    value.executor.terminal = { id: first.jobId, status: "FAILED", instances: [{ id: "instance-1", status: "CRASHED" }] };
    let findFailure: unknown;
    try { await value.target.find("operation-1"); } catch (cause) { findFailure = cause; }
    expect(findFailure).toBeInstanceOf(RailwayPortableMaintenanceTargetError);
    let startFailure: unknown;
    try { await value.target.startExport({ operationId: "operation-1", objectId: "object-1", authority }); } catch (cause) { startFailure = cause; }
    expect(startFailure).toBeInstanceOf(RailwayPortableMaintenanceTargetError);
    expect(value.executor.calls.filter(({ name }) => name === "deploy")).toHaveLength(1);
  });

  test("rejects adversarial checkpoint states through the redacted target error", async () => {
    const value = fixture();
    value.setCheckpoint({ state: "evil", operationId: "operation-1" } as unknown as RailwayPortableMaintenanceTargetCheckpoint);
    let failure: unknown;
    try { await value.target.find("operation-1"); } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(RailwayPortableMaintenanceTargetError);
    expect((failure as Error).message).toBe("Railway portable maintenance target failed");
  });

  test("rejects endpoint paths and oversized bound database authority before any provider mutation", () => {
    const executor = new FixtureExecutor();
    const create = (nextBinding: RailwayPortableMaintenanceBinding, nextAuthority: PortableTransferAuthority) => new RailwayPortableMaintenanceTarget({
      binding: nextBinding, authority: nextAuthority, executor, descriptorProbe: { observe: async () => ({ state: "not-found" }) },
      loadCheckpoint: async () => undefined, persistCheckpoint: async () => undefined, deploymentObservationAttempts: 1,
    });
    expect(() => create(binding(), { ...authority, endpoint: "https://objects.example.test/path" })).toThrow(RailwayPortableMaintenanceTargetError);
    expect(() => create({ ...binding(), appDatabaseUrl: `postgres://${"x".repeat(16 * 1024)}` }, authority)).toThrow(RailwayPortableMaintenanceTargetError);
    expect(executor.calls).toEqual([]);
  });

  test("accepts canonical storage byte boundaries and rejects byte or multibyte overflow before effects", () => {
    const executor = new FixtureExecutor();
    const create = (nextBinding: RailwayPortableMaintenanceBinding, nextAuthority: PortableTransferAuthority) => new RailwayPortableMaintenanceTarget({
      binding: nextBinding, authority: nextAuthority, executor, descriptorProbe: { observe: async () => ({ state: "not-found" }) },
      loadCheckpoint: async () => undefined, persistCheckpoint: async () => undefined, deploymentObservationAttempts: 1,
    });
    const region64 = `a${"b".repeat(63)}`;
    const prefix256 = `${"a".repeat(128)}/${"b".repeat(127)}`;
    expect(() => create({ ...binding(), storagePrefix: prefix256, storageSessionToken: "t".repeat(16 * 1024) }, {
      ...authority, region: region64, accessKeyId: "a".repeat(2 * 1024), secretAccessKey: "s".repeat(8 * 1024),
    })).not.toThrow();
    for (const [nextBinding, nextAuthority] of [
      [{ ...binding(), storagePrefix: `${"a".repeat(128)}/${"b".repeat(128)}` }, authority],
      [{ ...binding(), storagePrefix: `${"a".repeat(128)}/${"b".repeat(125)}é` }, authority],
      [{ ...binding(), storageSessionToken: "é".repeat(8193) }, authority],
      [binding(), { ...authority, region: `a${"b".repeat(64)}` }],
      [binding(), { ...authority, region: `a${"b".repeat(62)}é` }],
      [binding(), { ...authority, accessKeyId: "é".repeat(1025) }],
      [binding(), { ...authority, secretAccessKey: "é".repeat(4097) }],
    ] as const) expect(() => create(nextBinding, nextAuthority)).toThrow(RailwayPortableMaintenanceTargetError);
    expect(executor.calls).toEqual([]);
  });

  test("snapshots caller-owned binding and authority before awaits and has no cleanup or log surface", async () => {
    const mutableBinding = binding() as RailwayPortableMaintenanceBinding & { objectId: string; appDatabaseUrl: string };
    const mutableAuthority = { ...authority, encryptionKey: Uint8Array.from(authority.encryptionKey) };
    const executor = new FixtureExecutor();
    let checkpoint: RailwayPortableMaintenanceTargetCheckpoint | undefined;
    const target = new RailwayPortableMaintenanceTarget({ binding: mutableBinding, authority: mutableAuthority, executor,
      descriptorProbe: { observe: async () => ({ state: "complete", descriptor }) },
      deploymentObservationAttempts: 1,
      loadCheckpoint: async () => checkpoint, persistCheckpoint: async (value) => { checkpoint = value; },
    });
    mutableBinding.objectId = "mutated"; mutableBinding.appDatabaseUrl = "postgres://mutated";
    mutableAuthority.secretAccessKey = "mutated"; mutableAuthority.encryptionKey.fill(9);
    await target.startExport({ operationId: "operation-1", objectId: "object-1", authority });
    const variables = (executor.calls.find(({ name }) => name === "variables")!.input as { variables: Record<string, string> }).variables;
    expect(variables["NAUTILO_RECOVERY_APP_DATABASE_URL"]).toContain("APP_SECRET");
    expect(variables["NAUTILO_RECOVERY_S3_SECRET_ACCESS_KEY"]).toBe("SECRET_SECRET");
    expect("cleanup" in target || "logs" in target || "restart" in target).toBe(false);
  });
});
