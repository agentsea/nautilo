import { describe, expect, test } from "bun:test";

import {
  RAILWAY_LOGTO_HOLD_COMMAND,
  RAILWAY_LOGTO_SEED_HOLD_COMMAND,
  RAILWAY_NAUTILO_HOLD_COMMAND,
  RAILWAY_NAUTILO_SETUP_HOLD_COMMAND,
  isRailwayTemplateAdoptionReleaseCheckpoint,
  runRailwayTemplateAdoptionRelease,
  type RailwayDeployment,
  type RailwayTemplateAdoptionReleaseBinding,
  type RailwayTemplateAdoptionReleaseCheckpoint,
  type RailwayTemplateAdoptionReleaseExecutor,
} from "../../src";

const image = `registry.example/nautilo@sha256:${"a".repeat(64)}`;
const binding: RailwayTemplateAdoptionReleaseBinding = {
  releaseId: "release-1",
  projectId: "project-1",
  environmentId: "environment-1",
  serviceId: "service-logto",
  service: "logto",
  image,
  heldDeploymentId: "deployment-held",
};

function harness(input: { readonly setup?: boolean; readonly loseSource?: boolean; readonly refuseSourceCheckpoint?: boolean; readonly loseCommand?: boolean; readonly loseStart?: boolean; readonly many?: boolean; readonly exitRuntime?: boolean } = {}) {
  const setupImage = `ghcr.io/logto-io/logto@sha256:${"b".repeat(64)}`;
  const selectedBinding: RailwayTemplateAdoptionReleaseBinding = input.setup
    ? { ...binding, service: "nautilo-server", setupImage } : binding;
  let sourceImage = input.setup ? setupImage : image;
  let command: string | null = input.setup ? RAILWAY_NAUTILO_SETUP_HOLD_COMMAND : RAILWAY_LOGTO_HOLD_COMMAND;
  let checkpoint: RailwayTemplateAdoptionReleaseCheckpoint | undefined;
  let created = 0;
  const calls: string[] = [];
  const deployments: RailwayDeployment[] = [{ id: "deployment-held", status: "SUCCESS", deploymentStopped: false,
    instances: [{ id: "instance-held", status: "RUNNING" }] }];
  const executor: RailwayTemplateAdoptionReleaseExecutor = {
    getServiceInstance: async () => ({ id: "instance-1", serviceId: binding.serviceId,
      environmentId: binding.environmentId, source: { image: sourceImage, repo: null }, startCommand: command }),
    updateServiceSource: async ({ image: nextImage }) => {
      calls.push("source"); sourceImage = nextImage;
      if (input.loseSource) throw new Error("secret provider response");
      return { id: "instance-1", serviceId: binding.serviceId, environmentId: binding.environmentId,
        source: { image: sourceImage, repo: null }, startCommand: command };
    },
    setServiceStartCommand: async ({ startCommand }) => {
      calls.push("command"); command = startCommand;
      if (input.loseCommand) throw new Error("secret provider response");
    },
    listDeploymentsRaw: async () => deployments,
    createDeployment: async () => {
      calls.push("deploy"); created += 1;
      const next: RailwayDeployment = { id: `deployment-new-${created}`, status: "BUILDING", deploymentStopped: false,
        instances: [{ id: `instance-new-${created}`, status: "INITIALIZING" }] };
      deployments.push(next);
      if (input.many) deployments.push({ ...next, id: "deployment-foreign" });
      if (input.loseStart) throw new Error("secret provider response");
      return next;
    },
    getDeployment: async ({ deploymentId }) => {
      const found = deployments.find(({ id }) => id === deploymentId)!;
      return found.id === "deployment-held" ? found : { ...found, status: "SUCCESS",
        deploymentStopped: input.exitRuntime === true,
        instances: [{ id: "instance-new", status: input.exitRuntime === true ? "EXITED" : "RUNNING" }] };
    },
  };
  const run = () => runRailwayTemplateAdoptionRelease({
    binding: selectedBinding,
    checkpoint,
    executor,
    persistCheckpoint: async (next) => {
      if (input.refuseSourceCheckpoint && next.state === "source-pending") throw new Error("write failed");
      calls.push(`persist:${next.state}`); checkpoint = structuredClone(next);
    },
  });
  return { run, calls, get checkpoint() { return checkpoint; }, get command() { return command; } };
}

describe("held Railway template release", () => {
  test("attaches the selected stable runtime while held, before activating it", async () => {
    const h = harness({ setup: true });
    expect(await h.run()).toMatchObject({ outcome: "complete", checkpoint: { image } });
    expect(h.calls).toEqual([
      "persist:source-pending", "source", "persist:command-pending", "command", "persist:command-applied",
      "persist:start-pending", "deploy", "persist:started", "persist:complete",
    ]);
  });

  test("resumes a lost source-switch response without a second source mutation or deployment", async () => {
    const h = harness({ setup: true, loseSource: true });
    expect(await h.run()).toMatchObject({ outcome: "pending", checkpoint: { state: "source-pending" } });
    expect(await h.run()).toMatchObject({ outcome: "complete" });
    expect(h.calls.filter((call) => call === "source")).toHaveLength(1);
    expect(h.calls.filter((call) => call === "deploy")).toHaveLength(1);
  });

  test("does not switch the setup image if its checkpoint cannot be retained", async () => {
    const h = harness({ setup: true, refuseSourceCheckpoint: true });
    expect(await h.run()).toMatchObject({ outcome: "failure", code: "persistence-failure" });
    expect(h.calls).toEqual([]);
  });
  test("persists before command and deployment effects, then proves the exact new runtime", async () => {
    const h = harness();
    const result = await h.run();
    expect(result).toMatchObject({ outcome: "complete", deploymentId: "deployment-new-1" });
    expect(h.calls).toEqual([
      "persist:command-pending", "command", "persist:command-applied",
      "persist:start-pending", "deploy", "persist:started", "persist:complete",
    ]);
    expect(h.command).toBeNull();
  });

  test("recovers a committed command response loss idempotently without a second command mutation", async () => {
    const h = harness({ loseCommand: true });
    expect(await h.run()).toMatchObject({ outcome: "pending", checkpoint: { state: "command-pending" } });
    expect(await h.run()).toMatchObject({ outcome: "complete" });
    expect(h.calls.filter((call) => call === "command")).toHaveLength(1);
    expect(h.calls.filter((call) => call === "deploy")).toHaveLength(1);
  });

  test("recovers one deployment after response loss and never starts twice", async () => {
    const h = harness({ loseStart: true });
    expect(await h.run()).toMatchObject({ outcome: "pending", checkpoint: { state: "start-pending" } });
    expect(await h.run()).toMatchObject({ outcome: "complete", deploymentId: "deployment-new-1" });
    expect(h.calls.filter((call) => call === "deploy")).toHaveLength(1);
  });

  test("fails closed on an ambiguous post-baseline start", async () => {
    const h = harness({ loseStart: true, many: true });
    expect(await h.run()).toMatchObject({ outcome: "pending" });
    expect(await h.run()).toMatchObject({ outcome: "failure", code: "ambiguous-start" });
    expect(h.calls.filter((call) => call === "deploy")).toHaveLength(1);
  });

  test("requires run-once EXITED semantics for Logto seed", async () => {
    let checkpoint: RailwayTemplateAdoptionReleaseCheckpoint | undefined;
    const seedBinding = { ...binding, service: "logto-seed" as const, serviceId: "service-seed" };
    const executor: RailwayTemplateAdoptionReleaseExecutor = {
      getServiceInstance: async () => ({ id: "instance", serviceId: seedBinding.serviceId,
        environmentId: seedBinding.environmentId, source: { image, repo: null },
        startCommand: checkpoint === undefined ? RAILWAY_LOGTO_SEED_HOLD_COMMAND : "npm run cli db seed -- --swe" }),
      setServiceStartCommand: async () => undefined,
      listDeploymentsRaw: async () => [{ id: "deployment-held", status: "SUCCESS" }],
      createDeployment: async () => ({ id: "deployment-seed", status: "BUILDING" }),
      getDeployment: async () => ({ id: "deployment-seed", status: "SUCCESS", deploymentStopped: true,
        instances: [{ id: "instance-seed", status: "EXITED" }] }),
    };
    const result = await runRailwayTemplateAdoptionRelease({ binding: seedBinding, checkpoint, executor,
      persistCheckpoint: async (next) => { checkpoint = next; } });
    expect(result).toMatchObject({ outcome: "complete", deploymentId: "deployment-seed" });
  });

  test("treats an exited long-lived service as terminal failure", async () => {
    const h = harness({ exitRuntime: true });
    expect(await h.run()).toMatchObject({ outcome: "failure", code: "deployment-failed" });
  });

  test("rejects forged checkpoint identity and never reflects secret-bearing executor errors", async () => {
    const forged = { schemaVersion: 1, ...binding, state: "command-pending", projectId: "foreign" } as const;
    expect(isRailwayTemplateAdoptionReleaseCheckpoint(forged, binding)).toBeFalse();
    const result = await runRailwayTemplateAdoptionRelease({ binding, checkpoint: forged as never,
      executor: {} as RailwayTemplateAdoptionReleaseExecutor, persistCheckpoint: async () => undefined });
    expect(result).toEqual({ outcome: "failure", code: "invalid-checkpoint", checkpoint: forged });
    expect(JSON.stringify(result)).not.toContain("password");
    expect(RAILWAY_NAUTILO_HOLD_COMMAND).not.toBe("");
  });
});
