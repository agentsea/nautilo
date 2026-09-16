import { describe, expect, test } from "bun:test";

import {
  RailwayExactServiceActivation,
  RailwayExactServiceActivationError,
  type RailwayExactServiceActivationBinding,
  type RailwayExactServiceActivationCheckpoint,
  type RailwayExactServiceActivationExecutor,
} from "../../src/exact-service-activation";
import type { RailwayDeployment, RailwayServiceInstance } from "../../src/operations";

const image = `ghcr.io/nautilo/server@sha256:${"a".repeat(64)}`;
const SECRET = "postgres://owner:DO_NOT_PERSIST@postgres.internal/app";

function binding(effect: "connect" | "deploy" = "deploy"): RailwayExactServiceActivationBinding {
  return {
    projectId: "project-1",
    environmentId: "environment-1",
    serviceId: "service-1",
    image,
    effect,
  };
}

class FixtureExecutor implements RailwayExactServiceActivationExecutor {
  readonly calls: Array<{ readonly name: string; readonly input: unknown }> = [];
  source: RailwayServiceInstance["source"] = { image, repo: null };
  startCommand: string | null = null;
  deployments: RailwayDeployment[] = [
    { id: "maintenance-job", status: "SUCCESS", instances: [{ id: "old-instance", status: "EXITED" }] },
  ];
  terminal: RailwayDeployment = {
    id: "job-1",
    status: "DEPLOYING",
    deploymentStopped: false,
    instances: [{ id: "instance-1", status: "INITIALIZING" }],
  };
  responseLoss = false;
  addedOnStart = 1;

  async upsertVariables(input: Parameters<RailwayExactServiceActivationExecutor["upsertVariables"]>[0]) {
    this.calls.push({ name: "variables", input });
  }

  async getServiceInstance(input: Parameters<RailwayExactServiceActivationExecutor["getServiceInstance"]>[0]) {
    this.calls.push({ name: "instance", input });
    return {
      id: "service-instance-1",
      serviceId: "service-1",
      environmentId: "environment-1",
      source: this.source,
      startCommand: this.startCommand,
      latestDeployment: this.deployments[0],
    };
  }

  async listDeploymentsRaw(input: Parameters<RailwayExactServiceActivationExecutor["listDeploymentsRaw"]>[0]) {
    this.calls.push({ name: "inventory", input });
    return [...this.deployments];
  }

  async #effect(name: "connect" | "deploy", input: unknown) {
    this.calls.push({ name, input });
    if (name === "connect") this.source = { image, repo: null };
    const offset = this.deployments.filter(({ id }) => id.startsWith("job-")).length;
    for (let index = 0; index < this.addedOnStart; index += 1) {
      this.deployments.push({ id: `job-${offset + index + 1}`, status: index === 0 ? "DEPLOYING" : "SKIPPED" });
    }
    if (this.responseLoss) throw new Error(SECRET);
  }

  async createDeployment(input: Parameters<RailwayExactServiceActivationExecutor["createDeployment"]>[0]) {
    await this.#effect("deploy", input);
    return this.deployments.at(-1)!;
  }

  async connectService(input: Parameters<RailwayExactServiceActivationExecutor["connectService"]>[0]) {
    await this.#effect("connect", input);
    return this.getServiceInstance({ serviceId: input.serviceId, environmentId: input.environmentId });
  }

  async getDeployment(input: Parameters<RailwayExactServiceActivationExecutor["getDeployment"]>[0]) {
    this.calls.push({ name: "deployment", input });
    return { ...this.terminal, id: input.deploymentId };
  }
}

function fixture(
  effect: "connect" | "deploy" = "deploy",
  executor = new FixtureExecutor(),
  recovery?: { readonly attempts: number; readonly wait: (milliseconds: number) => Promise<void> },
) {
  let checkpoint: RailwayExactServiceActivationCheckpoint | undefined;
  const persisted: RailwayExactServiceActivationCheckpoint[] = [];
  let cleanupComplete = true;
  const activation = new RailwayExactServiceActivation({
    binding: binding(effect),
    executor,
    maintenanceCleanupComplete: async () => cleanupComplete,
    loadCheckpoint: async () => checkpoint,
    persistCheckpoint: async (value) => {
      checkpoint = structuredClone(value);
      persisted.push(structuredClone(value));
    },
    deploymentObservationAttempts: recovery?.attempts ?? 1,
    ...(recovery === undefined ? {} : { wait: recovery.wait }),
  });
  return {
    activation,
    executor,
    persisted,
    checkpoint: () => checkpoint,
    setCheckpoint: (value: RailwayExactServiceActivationCheckpoint) => { checkpoint = value; },
    setCleanupComplete: (value: boolean) => { cleanupComplete = value; },
  };
}

async function captureFailure(action: () => Promise<unknown>): Promise<unknown> {
  try { await action(); } catch (error) { return error; }
  return undefined;
}

describe("RailwayExactServiceActivation", () => {
  test("snapshots request-memory variables, persists prepared before variables, and never checkpoints secrets", async () => {
    const value = fixture();
    const variables = { DATABASE_URL: SECRET };
    const start = value.activation.start({ variables });
    variables.DATABASE_URL = "mutated";
    expect(await start).toEqual({ jobId: "job-1" });
    expect((value.executor.calls.find(({ name }) => name === "variables")!.input as { variables: Record<string, string> }).variables)
      .toEqual({ DATABASE_URL: SECRET });
    expect(value.persisted.map(({ state }) => state).slice(0, 3)).toEqual(["prepared", "start-pending", "started"]);
    expect(JSON.stringify(value.persisted)).not.toContain(SECRET);
    expect(JSON.stringify(value.persisted)).not.toContain("DATABASE_URL");
  });

  test("connects only a source-less scaffold and deploys only an exact existing digest", async () => {
    const connectExecutor = new FixtureExecutor(); connectExecutor.source = null;
    const connect = fixture("connect", connectExecutor);
    await connect.activation.start({ variables: { PUBLIC_URL: "https://target.example.test" } });
    expect(connectExecutor.calls.some(({ name }) => name === "connect")).toBe(true);
    expect(connectExecutor.calls.some(({ name }) => name === "deploy")).toBe(false);

    const deploy = fixture("deploy");
    await deploy.activation.start({ variables: {} });
    expect(deploy.executor.calls.some(({ name }) => name === "deploy")).toBe(true);
    expect(deploy.executor.calls.some(({ name }) => name === "connect")).toBe(false);

    const wrongConnect = fixture("connect");
    expect(await captureFailure(() => wrongConnect.activation.start({ variables: {} })))
      .toBeInstanceOf(RailwayExactServiceActivationError);
    const wrongDeployExecutor = new FixtureExecutor(); wrongDeployExecutor.source = null;
    const wrongDeploy = fixture("deploy", wrongDeployExecutor);
    expect(await captureFailure(() => wrongDeploy.activation.start({ variables: {} })))
      .toBeInstanceOf(RailwayExactServiceActivationError);
  });

  test("requires cleanup proof and null start command before any activation effect", async () => {
    const incomplete = fixture(); incomplete.setCleanupComplete(false);
    expect(await captureFailure(() => incomplete.activation.start({ variables: { SECRET } })))
      .toBeInstanceOf(RailwayExactServiceActivationError);
    expect(incomplete.executor.calls).toEqual([]);

    const command = fixture(); command.executor.startCommand = "maintenance-command";
    expect(await captureFailure(() => command.activation.start({ variables: {} })))
      .toBeInstanceOf(RailwayExactServiceActivationError);
    expect(command.executor.calls.some(({ name }) => name === "deploy")).toBe(false);
  });

  test("bounds variable values by UTF-8 bytes and redacts injected wait failures", async () => {
    const oversized = fixture();
    expect(await captureFailure(() => oversized.activation.start({ variables: { SECRET: "💥".repeat(20_000) } })))
      .toBeInstanceOf(RailwayExactServiceActivationError);
    expect(oversized.executor.calls).toEqual([]);

    const waitingExecutor = new FixtureExecutor(); waitingExecutor.addedOnStart = 0;
    const waiting = fixture("deploy", waitingExecutor, {
      attempts: 2,
      wait: async () => { throw new Error(SECRET); },
    });
    const error = await captureFailure(() => waiting.activation.start({ variables: {} }));
    expect(error).toBeInstanceOf(RailwayExactServiceActivationError);
    expect((error as Error).message).not.toContain(SECRET);
  });

  test("recovers exactly one raw deployment after response loss without adopting the baseline maintenance job", async () => {
    const executor = new FixtureExecutor(); executor.responseLoss = true;
    const value = fixture("deploy", executor);
    expect(await value.activation.start({ variables: {} })).toEqual({ jobId: "job-1" });
    expect(value.checkpoint()).toMatchObject({ state: "started", jobId: "job-1" });
    expect(value.checkpoint()).not.toMatchObject({ jobId: "maintenance-job" });
  });

  test("zero raw diff becomes unknown and only a later deliberate resume permits one bounded retry", async () => {
    const executor = new FixtureExecutor(); executor.responseLoss = true; executor.addedOnStart = 0;
    const value = fixture("deploy", executor);
    expect(await captureFailure(() => value.activation.start({ variables: {} })))
      .toBeInstanceOf(RailwayExactServiceActivationError);
    expect(value.checkpoint()).toMatchObject({ state: "start-unknown", attempt: 1 });
    expect(executor.calls.filter(({ name }) => name === "deploy")).toHaveLength(1);
    expect(await value.activation.find()).toBeUndefined();
    expect(value.checkpoint()).toMatchObject({ state: "prepared", attempt: 2 });
    executor.responseLoss = false; executor.addedOnStart = 1;
    expect(await value.activation.start({ variables: {} })).toEqual({ jobId: "job-1" });
    expect(executor.calls.filter(({ name }) => name === "deploy")).toHaveLength(2);
  });

  test("a crash-shaped pending checkpoint requires pending-to-unknown-to-prepared recovery", async () => {
    const value = fixture();
    value.setCheckpoint({
      state: "start-pending", attempt: 1, projectId: "project-1", environmentId: "environment-1",
      serviceId: "service-1", image, effect: "deploy", startEffect: "deploy", baselineDeploymentIds: ["maintenance-job"],
    });
    expect(await captureFailure(() => value.activation.find())).toBeInstanceOf(RailwayExactServiceActivationError);
    expect(value.checkpoint()).toMatchObject({ state: "start-unknown" });
    expect(await value.activation.find()).toBeUndefined();
    expect(value.checkpoint()).toMatchObject({ state: "prepared", attempt: 2 });
  });

  test("switches a source-committed zero-diff connect to one deliberate deploy without reconnecting", async () => {
    const connectExecutor = new FixtureExecutor(); connectExecutor.source = null; connectExecutor.responseLoss = true; connectExecutor.addedOnStart = 0;
    const connect = fixture("connect", connectExecutor);
    expect(await captureFailure(() => connect.activation.start({ variables: {} }))).toBeInstanceOf(RailwayExactServiceActivationError);
    expect(connect.checkpoint()).toMatchObject({ state: "start-unknown", startEffect: "connect" });
    expect(await connect.activation.find()).toBeUndefined();
    expect(connect.checkpoint()).toMatchObject({ state: "prepared", attempt: 2, startEffect: "deploy" });
    connectExecutor.responseLoss = false; connectExecutor.addedOnStart = 1;
    expect(await connect.activation.start({ variables: {} })).toEqual({ jobId: "job-1" });
    expect(connectExecutor.calls.filter(({ name }) => name === "connect")).toHaveLength(1);
    expect(connectExecutor.calls.filter(({ name }) => name === "deploy")).toHaveLength(1);
  });

  test("fails closed on multiple raw diffs, source drift, or malformed checkpoints", async () => {

    const multipleExecutor = new FixtureExecutor(); multipleExecutor.responseLoss = true; multipleExecutor.addedOnStart = 2;
    const multiple = fixture("deploy", multipleExecutor);
    expect(await captureFailure(() => multiple.activation.start({ variables: {} }))).toBeInstanceOf(RailwayExactServiceActivationError);

    const drift = fixture(); drift.executor.source = { image: `ghcr.io/nautilo/server@sha256:${"b".repeat(64)}`, repo: null };
    expect(await captureFailure(() => drift.activation.start({ variables: {} }))).toBeInstanceOf(RailwayExactServiceActivationError);

    const forged = fixture(); forged.setCheckpoint({ state: "evil", secret: SECRET } as unknown as RailwayExactServiceActivationCheckpoint);
    const error = await captureFailure(() => forged.activation.find());
    expect(error).toBeInstanceOf(RailwayExactServiceActivationError);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  test("a failed normal-service terminal permits one bounded later deploy attempt", async () => {
    const value = fixture();
    await value.activation.start({ variables: {} });
    value.executor.terminal = { id: "job-1", status: "FAILED", instances: [{ id: "one", status: "CRASHED" }] };
    expect(await value.activation.find()).toBeUndefined();
    expect(value.checkpoint()).toMatchObject({ state: "prepared", attempt: 2, startEffect: "deploy" });
    value.executor.terminal = { id: "job-2", status: "DEPLOYING", instances: [{ id: "two", status: "INITIALIZING" }] };
    expect(await value.activation.start({ variables: {} })).toEqual({ jobId: "job-2" });
    expect(value.executor.calls.filter(({ name }) => name === "deploy")).toHaveLength(2);
  });

  test("observes only the checkpointed job and completes only exact SUCCESS/RUNNING terminal state", async () => {
    const value = fixture();
    const { jobId } = await value.activation.start({ variables: {} });
    expect(await value.activation.observe(jobId)).toEqual({ state: "running" });
    value.executor.terminal = {
      id: jobId, status: "SUCCESS", deploymentStopped: false,
      instances: [{ id: "one", status: "RUNNING" }, { id: "two", status: "RUNNING" }],
    };
    expect(await value.activation.observe(jobId)).toEqual({ state: "complete" });
    expect(value.checkpoint()).toMatchObject({ state: "complete", jobId });
    expect(await captureFailure(() => value.activation.observe("maintenance-job")))
      .toBeInstanceOf(RailwayExactServiceActivationError);
  });

  test("fails terminal deployment and instance states immediately and never reads logs or latest deployment", async () => {
    for (const terminal of [
      { id: "job-1", status: "FAILED", instances: [{ id: "one", status: "RUNNING" }] },
      { id: "job-1", status: "SUCCESS", deploymentStopped: true, instances: [{ id: "one", status: "RUNNING" }] },
      { id: "job-1", status: "SUCCESS", deploymentStopped: false, instances: [{ id: "one", status: "EXITED" }] },
      { id: "job-1", status: "SUCCESS", deploymentStopped: false, instances: [{ id: "one", status: "STOPPED" }] },
      { id: "job-1", status: "SUCCESS", deploymentStopped: false, instances: [{ id: "one", status: "CRASHED" }] },
      { id: "job-1", status: "SUCCESS", deploymentStopped: false, instances: [{ id: "one", status: "SKIPPED" }] },
    ] satisfies RailwayDeployment[]) {
      const value = fixture(); const job = await value.activation.start({ variables: {} });
      value.executor.terminal = terminal;
      expect(await value.activation.observe(job.jobId)).toEqual({ state: "error" });
    }
    const value = fixture();
    expect("logs" in value.activation || "cleanup" in value.activation || "bootstrap" in value.activation).toBe(false);
  });
});
