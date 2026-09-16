import { describe, expect, test } from "bun:test";

import {
  isRailwayWholeManifestUpgradeCheckpoint,
  isRailwayWholeManifestUpgradeCheckpointTransition,
  RailwayWholeManifestUpgrade,
  type RailwayWholeManifestUpgradeBinding,
  type RailwayWholeManifestUpgradeCheckpoint,
  type RailwayWholeManifestUpgradeExecutor,
  type RailwayWholeManifestUpgradeResult,
  type RailwayWholeManifestUpgradeService,
} from "../../src/whole-manifest-upgrade";
import type { RailwayDeployment, RailwayServiceInstance } from "../../src/operations";

const NAMES = ["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"] as const;
const key = (name: (typeof NAMES)[number]) => "abcde"[NAMES.indexOf(name)]!;
const image = (fill: string, name: string) => `ghcr.io/nautilo/${name}@sha256:${fill.repeat(64)}`;
const SECRET = "postgres://owner:DO_NOT_PERSIST@postgres.internal/nautilo";

function binding(): RailwayWholeManifestUpgradeBinding {
  return {
    releaseId: "release-2", projectId: "project-1", environmentId: "environment-1",
    migration: { migrationId: "schema-v2", executionId: "upgrade-release-2-schema-v2" },
    services: NAMES.map((name) => ({
      name, serviceId: `${name}-service`, oldImage: image("a", key(name)), newImage: image("b", key(name)),
      kind: name === "logto-seed" ? "run-once" as const : "long-lived" as const,
    })),
  };
}

class FixtureExecutor implements RailwayWholeManifestUpgradeExecutor {
  readonly events: string[];
  readonly sources = new Map(NAMES.map((name) => [name, image("a", key(name))]));
  readonly commands = new Map(NAMES.map((name) => [name, null as string | null]));
  readonly visible = new Map<string, RailwayDeployment[]>();
  readonly delayed = new Map<string, Array<{ deployment: RailwayDeployment; reads: number }>>();
  readonly exact = new Map<string, RailwayDeployment>();
  deploymentVisibilityDelay = 0;
  deploymentsPerStart = 1;
  loseStartResponse = false;
  sourceVisibilityDelay = 0;
  loseSourceResponse = false;
  readonly pendingSources = new Map<(typeof NAMES)[number], { image: string; reads: number }>();

  constructor(events: string[]) { this.events = events; }
  #name(serviceId: string) { return NAMES.find((name) => `${name}-service` === serviceId)!; }

  async getServiceInstance(input: { readonly serviceId: string; readonly environmentId: string }): Promise<RailwayServiceInstance | null> {
    this.events.push(`read:source:${input.serviceId}`);
    const name = this.#name(input.serviceId);
    const pending = this.pendingSources.get(name);
    if (pending !== undefined) {
      if (pending.reads === 0) { this.sources.set(name, pending.image); this.pendingSources.delete(name); }
      else this.pendingSources.set(name, { ...pending, reads: pending.reads - 1 });
    }
    return { id: `${input.serviceId}-instance`, serviceId: input.serviceId, environmentId: input.environmentId,
      source: { image: this.sources.get(name), repo: null }, startCommand: this.commands.get(name) };
  }

  async listDeploymentsRaw(input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }) {
    this.events.push(`read:raw:${input.serviceId}`);
    const pending = this.delayed.get(input.serviceId) ?? [];
    const still: typeof pending = [];
    for (const item of pending) {
      if (item.reads === 0) (this.visible.get(input.serviceId) ?? []).push(item.deployment);
      else still.push({ ...item, reads: item.reads - 1 });
    }
    this.delayed.set(input.serviceId, still);
    return [...(this.visible.get(input.serviceId) ?? [])];
  }

  async updateServiceSource(input: { readonly serviceId: string; readonly environmentId: string; readonly image: string }) {
    this.events.push(`effect:source:${input.serviceId}`);
    const name = this.#name(input.serviceId);
    if (this.sourceVisibilityDelay === 0) this.sources.set(name, input.image);
    else this.pendingSources.set(name, { image: input.image, reads: this.sourceVisibilityDelay });
    if (this.loseSourceResponse) throw new Error(SECRET);
    return (await this.getServiceInstance(input))!;
  }

  async createDeployment(input: { readonly serviceId: string; readonly environmentId: string }) {
    const migration = this.commands.get(this.#name(input.serviceId))?.includes("maintenance-job.ts migrate ") === true;
    this.events.push(migration ? `effect:migration:${input.serviceId}` : `effect:start:${input.serviceId}`);
    const visible = this.visible.get(input.serviceId) ?? [];
    this.visible.set(input.serviceId, visible);
    const delayed = this.delayed.get(input.serviceId) ?? [];
    this.delayed.set(input.serviceId, delayed);
    let last: RailwayDeployment | undefined;
    for (let index = 0; index < this.deploymentsPerStart; index += 1) {
      const id = `${input.serviceId}-${migration ? "migration" : "deployment"}-${visible.length + delayed.length + 1}`;
      last = { id, status: "SUCCESS", deploymentStopped: migration, instances: [{ id: `${id}-instance`, status: migration ? "EXITED" : "RUNNING" }] };
      this.exact.set(id, last);
      delayed.push({ deployment: last, reads: this.deploymentVisibilityDelay });
    }
    if (this.loseStartResponse) throw new Error(SECRET);
    return last!;
  }

  async getDeployment(input: { readonly deploymentId: string }) {
    this.events.push(`read:deployment:${input.deploymentId}`);
    return this.exact.get(input.deploymentId)!;
  }

  async setServiceStartCommand(input: { readonly serviceId: string; readonly startCommand: string | null }) {
    this.events.push(`effect:command:${input.serviceId}:${input.startCommand === null ? "reset" : "migration"}`);
    this.commands.set(this.#name(input.serviceId), input.startCommand);
  }
}

function fixture(input = binding(), executor?: FixtureExecutor) {
  const events: string[] = executor?.events ?? [];
  const effects = executor ?? new FixtureExecutor(events);
  let checkpoint: RailwayWholeManifestUpgradeCheckpoint | undefined;
  let failSaveStage: RailwayWholeManifestUpgradeCheckpoint["stage"] | undefined;
  const upgrade = new RailwayWholeManifestUpgrade({ binding: input, executor: effects,
    loadCheckpoint: async () => checkpoint,
    persistCheckpoint: async (next) => {
      events.push(`persist:${next.stage}${next.serviceIndex === undefined ? "" : `:${next.serviceIndex}`}`);
      if (failSaveStage === next.stage) { failSaveStage = undefined; throw new Error(SECRET); }
      checkpoint = structuredClone(next);
    },
  });
  return { upgrade, executor: effects, events, checkpoint: () => checkpoint,
    setCheckpoint: (value: RailwayWholeManifestUpgradeCheckpoint) => { checkpoint = structuredClone(value); },
    failNextSave: (stage: RailwayWholeManifestUpgradeCheckpoint["stage"]) => { failSaveStage = stage; } };
}

async function until(value: ReturnType<typeof fixture>, predicate: (result: RailwayWholeManifestUpgradeResult) => boolean, maximum = 100) {
  let result = await value.upgrade.run();
  for (let index = 0; !predicate(result) && index < maximum; index += 1) result = await value.upgrade.run();
  return result;
}

async function untilStage(value: ReturnType<typeof fixture>, stage: RailwayWholeManifestUpgradeCheckpoint["stage"]) {
  return until(value, (result) => result.outcome !== "pending" || result.checkpoint.stage === stage);
}

describe("RailwayWholeManifestUpgrade", () => {
  test("exports the exact checkpoint grammar and rejects illegal stage jumps", async () => {
    const value = fixture();
    await untilStage(value, "source-ready");
    const before = value.checkpoint()!;
    const identity = binding();
    expect(isRailwayWholeManifestUpgradeCheckpoint(before, identity)).toBe(true);
    expect(isRailwayWholeManifestUpgradeCheckpointTransition(before, { ...before, stage: "source-pending" })).toBe(true);
    expect(isRailwayWholeManifestUpgradeCheckpointTransition(before, {
      schemaVersion: before.schemaVersion,
      releaseId: before.releaseId,
      projectId: before.projectId,
      environmentId: before.environmentId,
      services: before.services,
      migrationId: before.migrationId,
      migrationExecutionId: before.migrationExecutionId,
      completedDeployments: before.completedDeployments,
      stage: "complete",
    })).toBe(false);
    expect(isRailwayWholeManifestUpgradeCheckpoint({ ...before, unexpected: true }, identity)).toBe(false);
  });
  test("snapshots callers, verifies all old digests before effects, and checkpoints before every mutation", async () => {
    const input = binding(); const value = fixture(input);
    const first = value.upgrade.run();
    (input as unknown as { services: RailwayWholeManifestUpgradeService[] }).services[0] = { ...input.services[0]!, oldImage: image("c", "mutated") };
    await first;
    await untilStage(value, "migration-source-pending");
    const firstEffect = value.events.findIndex((event) => event.startsWith("effect:"));
    expect(value.events.slice(0, firstEffect).filter((event) => event.startsWith("read:source:"))).toHaveLength(6);
    for (const service of [0, 1]) {
      expect(value.events.indexOf(`persist:source-pending:${service}`)).toBeLessThan(value.events.indexOf(`effect:source:${NAMES[service]}-service`));
      expect(value.events.indexOf(`persist:start-pending:${service}`)).toBeLessThan(value.events.indexOf(`effect:start:${NAMES[service]}-service`));
    }
    expect(value.events.indexOf("persist:migration-source-pending")).toBeLessThan(value.events.indexOf("effect:source:nautilo-server-service"));
    expect(JSON.stringify(value.checkpoint())).not.toContain(SECRET);
  });

  test("rejects source drift and canonical tagged image references before mutation", async () => {
    const drift = fixture(); drift.executor.sources.set("logto", image("c", "d"));
    await drift.upgrade.run();
    expect(await drift.upgrade.run()).toMatchObject({ outcome: "failure", code: "source-drift", fallbackRequired: true });
    expect(drift.events.some((event) => event.startsWith("effect:"))).toBe(false);

    const tagged = binding();
    (tagged as unknown as { services: RailwayWholeManifestUpgradeService[] }).services[0] = {
      ...tagged.services[0]!, oldImage: `ghcr.io/nautilo/a:tag@sha256:${"a".repeat(64)}`,
    };
    const rejected = fixture(tagged);
    expect(await rejected.upgrade.run()).toMatchObject({ outcome: "failure", code: "invalid-input" });
    expect(rejected.events).toEqual([]);

    const port = binding();
    (port as unknown as { services: RailwayWholeManifestUpgradeService[] }).services[0] = {
      ...port.services[0]!, oldImage: `registry.example.test:5443/nautilo/a@sha256:${"a".repeat(64)}`,
    };
    const accepted = fixture(port); accepted.executor.sources.set("app-postgres", port.services[0]!.oldImage);
    await accepted.upgrade.run();
    expect(await accepted.upgrade.run()).toMatchObject({ outcome: "pending", checkpoint: { stage: "source-ready" } });
  });

  test("admits only the exact runtime-safe migration identifier grammar before effects", async () => {
    const maximum = `m${"a".repeat(127)}`;
    const acceptedBinding = binding();
    (acceptedBinding as { migration: { migrationId: string; executionId: string } }).migration = { migrationId: maximum, executionId: maximum };
    const accepted = fixture(acceptedBinding);
    expect(await accepted.upgrade.run()).toMatchObject({ outcome: "pending", checkpoint: { stage: "verify-old" } });
    expect(await accepted.upgrade.run()).toMatchObject({ outcome: "pending", checkpoint: { stage: "source-ready" } });
    expect(accepted.events.some((event) => event.startsWith("effect:"))).toBe(false);

    for (const identifier of [".", "..", "bad:id", "bad/id", "bad value", `m${"a".repeat(128)}`]) {
      const invalid = binding();
      (invalid as { migration: { migrationId: string; executionId: string } }).migration = { migrationId: identifier, executionId: "execution-safe" };
      const rejected = fixture(invalid);
      expect(await rejected.upgrade.run()).toMatchObject({ outcome: "failure", code: "invalid-input" });
      expect(rejected.events).toEqual([]);
      const checkpoint = { schemaVersion: 1, releaseId: invalid.releaseId, projectId: invalid.projectId,
        environmentId: invalid.environmentId, services: invalid.services, migrationId: identifier,
        migrationExecutionId: "execution-safe", completedDeployments: [], stage: "verify-old" };
      expect(isRailwayWholeManifestUpgradeCheckpoint(checkpoint, invalid)).toBe(false);
    }
  });

  test("orders database readiness, proven migration, dormant seed source, then Logto and Nautilo", async () => {
    const value = fixture();
    const result = await until(value, (entry) => entry.outcome === "complete");
    expect(result).toMatchObject({ outcome: "complete" });
    if (result.outcome !== "complete") throw new Error("test did not complete");
    expect(result.checkpoint.completedDeployments).toEqual([
      { name: "app-postgres", serviceId: "app-postgres-service", deploymentId: "app-postgres-service-deployment-1" },
      { name: "logto-postgres", serviceId: "logto-postgres-service", deploymentId: "logto-postgres-service-deployment-1" },
      { name: "logto", serviceId: "logto-service", deploymentId: "logto-service-deployment-1" },
      { name: "nautilo-server", serviceId: "nautilo-server-service", deploymentId: "nautilo-server-service-deployment-2" },
    ]);
    const starts = value.events.filter((event) => event.startsWith("effect:start:"));
    expect(starts).toEqual([
      "effect:start:app-postgres-service", "effect:start:logto-postgres-service",
      "effect:start:logto-service", "effect:start:nautilo-server-service",
    ]);
    const proof = value.events.indexOf("persist:migration-proven");
    expect(value.events.indexOf("read:deployment:logto-postgres-service-deployment-1")).toBeLessThan(proof);
    expect(proof).toBeLessThan(value.events.indexOf("effect:source:logto-seed-service"));
    expect(proof).toBeLessThan(value.events.indexOf("effect:start:logto-service"));
    expect(value.events.some((event) => event === "effect:start:logto-seed-service")).toBe(false);
  });

  test("durably appends a deployment only after exact readiness and resumes causally after append persistence loss", async () => {
    const value = fixture();
    await untilStage(value, "started");
    expect(value.checkpoint()).toMatchObject({ serviceIndex: 0, completedDeployments: [] });
    value.failNextSave("source-ready");
    expect(await value.upgrade.run()).toMatchObject({
      outcome: "pending", code: "persistence-failure",
      checkpoint: { stage: "started", completedDeployments: [] },
    });
    expect(await value.upgrade.run()).toMatchObject({
      outcome: "pending",
      checkpoint: { stage: "source-ready", serviceIndex: 1, completedDeployments: [
        { name: "app-postgres", serviceId: "app-postgres-service", deploymentId: "app-postgres-service-deployment-1" },
      ] },
    });
    value.executor.deploymentVisibilityDelay = 2;
    value.executor.loseStartResponse = true;
    await untilStage(value, "start-unknown");
    expect(value.checkpoint()?.completedDeployments).toEqual([
      { name: "app-postgres", serviceId: "app-postgres-service", deploymentId: "app-postgres-service-deployment-1" },
    ]);
  });

  test("migration uses a durable raw baseline, exact one-shot deployment, and command reset without duplication", async () => {
    const value = fixture();
    await untilStage(value, "migration-start-ready");
    expect(value.executor.commands.get("nautilo-server")).toBe("bun /srv/repo/bin/nautilo-server/src/maintenance-job.ts migrate schema-v2 upgrade-release-2-schema-v2");
    value.executor.deploymentVisibilityDelay = 2;
    await value.upgrade.run();
    expect(value.checkpoint()).toMatchObject({ stage: "migration-start-unknown", observations: 0, baselineDeploymentIds: [] });
    expect(value.events.indexOf("persist:migration-start-pending")).toBeLessThan(value.events.indexOf("effect:migration:nautilo-server-service"));
    await untilStage(value, "migration-proven");
    expect(value.checkpoint()).toMatchObject({ migrationDeploymentId: "nautilo-server-service-migration-1" });
    expect(value.events.filter((event) => event === "effect:migration:nautilo-server-service")).toHaveLength(1);
    expect(value.events).toContain("effect:command:nautilo-server-service:reset");
  });

  test("multiple migration deltas are terminally ambiguous and retain every exact identity", async () => {
    const value = fixture(); await untilStage(value, "migration-start-ready");
    value.executor.deploymentsPerStart = 2;
    const result = await value.upgrade.run();
    expect(result).toMatchObject({ outcome: "failure", code: "deployment-ambiguous", checkpoint: {
      stage: "migration-start-ambiguous", baselineDeploymentIds: [],
      ambiguousDeploymentIds: ["nautilo-server-service-migration-1", "nautilo-server-service-migration-2"],
    } });
    expect(value.events.filter((event) => event === "effect:migration:nautilo-server-service")).toHaveLength(1);
  });

  test("bounds zero migration deltas into durable unresolved fallback without ever re-creating", async () => {
    const value = fixture(); await untilStage(value, "migration-start-ready");
    value.executor.deploymentVisibilityDelay = 99;
    const result = await until(value, (entry) => entry.outcome === "failure");
    expect(result).toMatchObject({ outcome: "failure", code: "migration-start-unresolved", fallbackRequired: true,
      checkpoint: { stage: "migration-start-unresolved", observations: 3, baselineDeploymentIds: [] } });
    expect(value.events.filter((event) => event === "effect:migration:nautilo-server-service")).toHaveLength(1);
    expect(await value.upgrade.run()).toEqual(result);
    expect(value.events.filter((event) => event === "effect:migration:nautilo-server-service")).toHaveLength(1);
    if (result.outcome !== "failure" || result.checkpoint?.stage !== "migration-start-unresolved") throw new Error("missing unresolved fixture");
    expect(isRailwayWholeManifestUpgradeCheckpoint({ ...result.checkpoint, stage: "migration-start-unknown", observations: 3 }, binding())).toBe(false);

    const unknownOne: RailwayWholeManifestUpgradeCheckpoint = {
      ...result.checkpoint, stage: "migration-start-unknown", observations: 1, baselineDeploymentIds: ["baseline-a"],
    };
    const unknownTwo: RailwayWholeManifestUpgradeCheckpoint = {
      ...unknownOne, observations: 2, baselineDeploymentIds: ["baseline-b"],
    };
    const unresolvedMutated: RailwayWholeManifestUpgradeCheckpoint = {
      ...unknownOne, stage: "migration-start-unresolved", observations: 3, baselineDeploymentIds: ["baseline-b"],
    };
    expect(isRailwayWholeManifestUpgradeCheckpoint(unknownOne, binding())).toBe(true);
    expect(isRailwayWholeManifestUpgradeCheckpoint(unknownTwo, binding())).toBe(true);
    expect(isRailwayWholeManifestUpgradeCheckpoint(unresolvedMutated, binding())).toBe(true);
    expect(isRailwayWholeManifestUpgradeCheckpointTransition(unknownOne, unknownTwo)).toBe(false);
    expect(isRailwayWholeManifestUpgradeCheckpointTransition({ ...unknownOne, observations: 2 }, unresolvedMutated)).toBe(false);
  });

  test("treats non-EXITED terminal migration instances as terminal and proves only clean EXITED success", async () => {
    for (const status of ["STOPPED", "SKIPPED", "REMOVED", "REMOVING", "CRASHED"] as const) {
      const value = fixture(); await untilStage(value, "migration-started");
      const id = value.checkpoint()!.migrationDeploymentId!;
      value.executor.exact.set(id, { id, status: "SUCCESS", deploymentStopped: true,
        instances: [{ id: `${id}-instance`, status }] });
      expect(await value.upgrade.run()).toMatchObject({ outcome: "failure", code: "migration-terminal", checkpoint: { migrationDeploymentId: id } });
    }
  });

  test("source response loss plus delayed visibility recovers without a duplicate update", async () => {
    const value = fixture(); value.executor.sourceVisibilityDelay = 1; value.executor.loseSourceResponse = true;
    await value.upgrade.run();
    await value.upgrade.run();
    expect(await value.upgrade.run()).toMatchObject({ outcome: "pending", code: "source-update-unknown", checkpoint: { stage: "source-unknown", observations: 0 } });
    value.executor.loseSourceResponse = false;
    expect(await value.upgrade.run()).toMatchObject({ outcome: "pending", checkpoint: { stage: "source-updated", serviceIndex: 0 } });
    expect(value.events.filter((event) => event === "effect:source:app-postgres-service")).toHaveLength(1);
  });

  test("delayed zero deployment deltas stay pending and recover uniquely without duplicate start", async () => {
    const value = fixture(); value.executor.deploymentVisibilityDelay = 2; value.executor.loseStartResponse = true;
    await untilStage(value, "start-unknown");
    expect(value.checkpoint()).toMatchObject({ stage: "start-unknown", observations: 0, attempt: 1 });
    expect(await value.upgrade.run()).toMatchObject({ outcome: "pending", code: "deployment-unknown", checkpoint: { stage: "start-unknown", observations: 1 } });
    expect(await value.upgrade.run()).toMatchObject({ outcome: "pending", checkpoint: { stage: "started", deploymentId: "app-postgres-service-deployment-1" } });
    expect(value.events.filter((event) => event === "effect:start:app-postgres-service")).toHaveLength(1);
  });

  test("multiple raw deltas are durably terminal with every exact identity before fallback", async () => {
    const value = fixture(); value.executor.deploymentsPerStart = 2; value.executor.loseStartResponse = true;
    const result = await until(value, (entry) => entry.outcome === "failure");
    expect(result).toMatchObject({ outcome: "failure", code: "deployment-ambiguous", fallbackRequired: true, checkpoint: {
      stage: "start-ambiguous", serviceIndex: 0, attempt: 1, baselineDeploymentIds: [],
      ambiguousDeploymentIds: ["app-postgres-service-deployment-1", "app-postgres-service-deployment-2"],
      completedDeployments: [],
    } });
    expect(value.checkpoint()).toEqual(result.outcome === "failure" ? result.checkpoint : undefined);
    expect(value.events.at(-1)).toBe("persist:start-ambiguous:0");
    expect(await value.upgrade.run()).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("latest-must-not-be-used");
    expect(value.events.some((event) => event.includes("latest"))).toBe(false);
  });

  test("ambiguous response-loss cannot request fallback until its exact identities are durable", async () => {
    const value = fixture(); value.executor.deploymentsPerStart = 2; value.executor.loseStartResponse = true;
    await untilStage(value, "start-ready"); value.failNextSave("start-ambiguous");
    expect(await value.upgrade.run()).toMatchObject({
      outcome: "pending", code: "persistence-failure", checkpoint: { stage: "start-pending", completedDeployments: [] },
    });
    expect(value.checkpoint()).toMatchObject({ stage: "start-pending", completedDeployments: [] });
    expect(value.events.filter((event) => event === "effect:start:app-postgres-service")).toHaveLength(1);
    expect(await value.upgrade.run()).toMatchObject({
      outcome: "failure", code: "deployment-ambiguous", fallbackRequired: true, checkpoint: {
        stage: "start-ambiguous",
        ambiguousDeploymentIds: ["app-postgres-service-deployment-1", "app-postgres-service-deployment-2"],
      },
    });
    expect(value.events.filter((event) => event === "effect:start:app-postgres-service")).toHaveLength(1);
  });

  test("rejects forged, reordered, baseline-owned, completed-owned, seed, and advancing ambiguous checkpoints", async () => {
    const value = fixture(); value.executor.deploymentsPerStart = 2; value.executor.loseStartResponse = true;
    const result = await until(value, (entry) => entry.outcome === "failure");
    if (result.outcome !== "failure" || result.checkpoint?.stage !== "start-ambiguous") throw new Error("missing ambiguous fixture");
    const terminal = result.checkpoint; const identity = binding();
    const invalid = [
      { ...terminal, ambiguousDeploymentIds: [terminal.ambiguousDeploymentIds![1]!, terminal.ambiguousDeploymentIds![0]!] },
      { ...terminal, ambiguousDeploymentIds: [terminal.ambiguousDeploymentIds![0]!, terminal.ambiguousDeploymentIds![0]!] },
      { ...terminal, baselineDeploymentIds: [terminal.ambiguousDeploymentIds![0]!] },
      { ...terminal, ambiguousDeploymentIds: ["bad/id", terminal.ambiguousDeploymentIds![1]!] },
      { ...terminal, serviceIndex: 2 },
    ];
    for (const checkpoint of invalid) expect(isRailwayWholeManifestUpgradeCheckpoint(checkpoint, identity)).toBe(false);
    const completedOwner = fixture();
    await until(completedOwner, (entry) => entry.outcome === "pending"
      && entry.checkpoint.stage === "start-pending" && entry.checkpoint.serviceIndex === 1);
    const pending = completedOwner.checkpoint()!;
    const completedId = pending.completedDeployments[0]!.deploymentId;
    expect(isRailwayWholeManifestUpgradeCheckpoint({ ...pending, stage: "start-ambiguous",
      ambiguousDeploymentIds: [completedId, "forged-deployment-2"] }, identity)).toBe(false);
    expect(isRailwayWholeManifestUpgradeCheckpointTransition(terminal, terminal)).toBe(false);
    expect(isRailwayWholeManifestUpgradeCheckpointTransition(terminal, { ...terminal, stage: "started",
      deploymentId: terminal.ambiguousDeploymentIds![0], ambiguousDeploymentIds: undefined } as RailwayWholeManifestUpgradeCheckpoint)).toBe(false);
  });

  test("long-lived readiness rejects stopped, EXITED, and CRASHED exact deployments", async () => {
    for (const shape of [
      { stopped: true, status: "RUNNING" as const },
      { stopped: false, status: "EXITED" as const },
      { stopped: false, status: "CRASHED" as const },
    ]) {
      const value = fixture(); await untilStage(value, "started");
      const id = value.checkpoint()!.deploymentId!;
      value.executor.exact.set(id, { id, status: "SUCCESS", deploymentStopped: shape.stopped,
        instances: [{ id: `${id}-instance`, status: shape.status }] });
      expect(await value.upgrade.run()).toMatchObject({ outcome: "failure", code: "deployment-terminal", fallbackRequired: true, checkpoint: { deploymentId: id } });
    }
  });

  test("keeps a rolling deployment pending when its predecessor instance has exited", async () => {
    const value = fixture();
    await untilStage(value, "started");
    const id = value.checkpoint()!.deploymentId!;
    value.executor.exact.set(id, { id, status: "DEPLOYING", deploymentStopped: false,
      instances: [{ id: `${id}-old-instance`, status: "EXITED" }] });
    expect(await value.upgrade.run()).toMatchObject({ outcome: "pending", checkpoint: { stage: "started", deploymentId: id } });
    expect(value.checkpoint()).toMatchObject({ stage: "started", deploymentId: id, completedDeployments: [] });

    value.executor.exact.set(id, { id, status: "SUCCESS", deploymentStopped: false,
      instances: [{ id: `${id}-new-instance`, status: "RUNNING" }] });
    expect(await value.upgrade.run()).toMatchObject({ outcome: "pending", checkpoint: {
      stage: "source-ready", serviceIndex: 1, completedDeployments: [{ deploymentId: id }],
    } });
  });

  test("strict checkpoints reject unknown source-updated attempts and invalid start attempts", async () => {
    const value = fixture(); await untilStage(value, "source-updated");
    value.setCheckpoint({ ...value.checkpoint()!, attempt: 2 });
    expect(await value.upgrade.run()).toMatchObject({ outcome: "failure", code: "invalid-checkpoint" });

    const second = fixture(); await untilStage(second, "start-ready");
    second.setCheckpoint({ ...second.checkpoint()!, attempt: 0 });
    expect(await second.upgrade.run()).toMatchObject({ outcome: "failure", code: "invalid-checkpoint" });

    const seedStart = fixture(); await untilStage(seedStart, "source-ready");
    seedStart.setCheckpoint({ ...seedStart.checkpoint()!, stage: "start-ready", serviceIndex: 2, attempt: 1 });
    expect(await seedStart.upgrade.run()).toMatchObject({ outcome: "failure", code: "invalid-checkpoint" });
    expect(seedStart.events).not.toContain("effect:start:logto-seed-service");

    const fastForward = fixture(); await untilStage(fastForward, "start-unknown");
    fastForward.setCheckpoint({ ...fastForward.checkpoint()!, observations: 2 });
    expect(await fastForward.upgrade.run()).toMatchObject({ outcome: "failure", code: "invalid-checkpoint" });
  });

  test("rejects missing, forged, out-of-order, seed, and jumped completion ledgers", async () => {
    const value = fixture(); await untilStage(value, "started");
    const started = value.checkpoint()!;
    const service = binding().services[0]!;
    const validEntry = { name: "app-postgres" as const, serviceId: service.serviceId, deploymentId: started.deploymentId! };

    value.setCheckpoint(({ ...started, completedDeployments: undefined }) as unknown as RailwayWholeManifestUpgradeCheckpoint);
    expect(await value.upgrade.run()).toMatchObject({ outcome: "failure", code: "invalid-checkpoint" });

    for (const completedDeployments of [
      [{ ...validEntry, deploymentId: "forged-deployment" }],
      [{ name: "logto-postgres" as const, serviceId: "logto-postgres-service", deploymentId: "deployment-1" }],
      [{ name: "logto-seed" as const, serviceId: "logto-seed-service", deploymentId: "deployment-1" }],
      [validEntry, { name: "logto-postgres" as const, serviceId: "logto-postgres-service", deploymentId: "jumped" }],
    ]) {
      const candidate = { ...started, completedDeployments } as unknown as RailwayWholeManifestUpgradeCheckpoint;
      expect(isRailwayWholeManifestUpgradeCheckpoint(candidate, binding())).toBe(false);
    }

    const after: RailwayWholeManifestUpgradeCheckpoint = {
      schemaVersion: started.schemaVersion, releaseId: started.releaseId, projectId: started.projectId,
      environmentId: started.environmentId, services: started.services, migrationId: started.migrationId,
      migrationExecutionId: started.migrationExecutionId, stage: "source-ready", serviceIndex: 1,
      completedDeployments: [validEntry],
    };
    expect(isRailwayWholeManifestUpgradeCheckpointTransition(started, after)).toBe(true);
    expect(isRailwayWholeManifestUpgradeCheckpointTransition(started, {
      ...after, completedDeployments: [{ ...validEntry, deploymentId: "forged-deployment" }],
    })).toBe(false);
    expect(isRailwayWholeManifestUpgradeCheckpointTransition(started, {
      ...after, completedDeployments: [],
    })).toBe(false);

    const completedValue = fixture();
    const completed = await until(completedValue, (result) => result.outcome === "complete");
    if (completed.outcome !== "complete") throw new Error("test did not complete");
    expect(isRailwayWholeManifestUpgradeCheckpoint({
      ...completed.checkpoint,
      completedDeployments: completed.checkpoint.completedDeployments.map((entry, index) => (
        index === 1 ? { ...entry, deploymentId: completed.checkpoint.completedDeployments[0]!.deploymentId } : entry
      )),
    }, binding())).toBe(false);
  });

  test("final verification covers every exact new digest and errors remain redacted", async () => {
    const value = fixture(); await untilStage(value, "verify-final");
    value.executor.sources.set("nautilo-server", image("a", "e"));
    const result = await value.upgrade.run();
    expect(result).toMatchObject({ outcome: "failure", code: "source-drift", fallbackRequired: true });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
