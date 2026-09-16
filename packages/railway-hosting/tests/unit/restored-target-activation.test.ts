import { describe, expect, test } from "bun:test";

import {
  runRailwayRestoredTargetActivation,
  type RailwayRestoredTargetActivationCheckpoint,
  type RailwayRestoredTargetActivationExecutor,
  type RailwayRestoredTargetActivationRequest,
} from "../../src/restored-target-activation";
import type { RailwayBootstrapHandoffOutput } from "../../src/bootstrap-lifecycle";
import type { RailwayTopology } from "../../src/topology";

const SECRET = "never-persist-secret";
const FORBIDDEN = `postgres://owner:${SECRET}@example.test/private`;
const sourceOrigin = "https://source.example.test";
const targetOrigin = "https://target.example.test";
const digest = (name: string, fill: string) => `registry.example.test/${name}@sha256:${fill.repeat(64)}`;
const output: RailwayBootstrapHandoffOutput = {
  "logto-workbench-app-id": "workbench-id", "logto-tui-app-id": "tui-id",
  "logto-tui-loopback-app-id": "loopback-id", "logto-desktop-app-id": "desktop-id",
  "logto-mobile-app-id": "mobile-id", "logto-mobile-web-app-id": "mobile-web-id", "logto-m2m-app-id": "m2m-id",
  "logto-m2m-app-secret": SECRET, "logto-resource": `${targetOrigin}/api`,
};

function topology(): RailwayTopology {
  const service = (name: RailwayTopology["finalServices"][number]["name"], fill: string, variables: RailwayTopology["finalServices"][number]["variables"] = []) => ({
    name, imageName: name === "logto-seed" ? "logto" as const : name, image: digest(name, fill), kind: name === "logto-seed" ? "run-once" as const : "long-lived" as const, privatePorts: [], variables,
  });
  const bootstrap = {
    kind: "transient-bootstrap" as const, serviceName: "nautilo-bootstrap" as const,
    imageName: "nautilo-bootstrap" as const, image: digest("bootstrap", "f"),
    lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"] as const,
    prohibitedLongLivedServices: ["nautilo-server"] as const,
  };
  return {
    schemaVersion: 1, releaseId: "release-1",
    finalServices: [
      service("app-postgres", "a"), service("logto-postgres", "b"), service("logto-seed", "c"),
      service("logto", "c", [{ key: "DB_URL", value: { kind: "safe-literal", value: "postgres://logto.railway.internal/db" } }]),
      service("nautilo-server", "d", [
        { key: "LOGTO_M2M_APP_SECRET", value: { kind: "bootstrap-output-reference", producer: "logto-post-seed-reconciliation", output: "logto-m2m-app-secret" } },
        { key: "NAUTILO_PUBLIC_BASE_URL", value: { kind: "generated-public-domain-reference", domain: "nautilo-public", scheme: "https" } },
      ]),
    ],
    mounts: [], generatedPublicDomains: [],
    transientBootstrap: { ...bootstrap, inputs: [] },
    transientLogtoBootstrap: { ...bootstrap, inputs: [
      { key: "NAUTILO_BOOTSTRAP_HANDOFF_TOKEN", value: { kind: "generated-secret-slot", slot: "logto-bootstrap-handoff-token", purpose: "test" } },
      { key: "NAUTILO_PUBLIC_BASE_URL", value: { kind: "generated-public-domain-reference", domain: "nautilo-public", scheme: "https" } },
    ] },
    qualifications: [],
  };
}

class FixtureExecutor implements RailwayRestoredTargetActivationExecutor {
  readonly events: string[] = [];
  transfer = true;
  cleanup = true;
  logto: "running" | "complete" | "error" = "complete";
  nautilo: "running" | "complete" | "error" = "complete";
  bootstrap: "pending" | "complete" | "failure" = "complete";
  readiness = true;
  logtoJob: { jobId: string } | undefined;
  nautiloJob: { jobId: string } | undefined;
  bootstrapOutput: RailwayBootstrapHandoffOutput = output;
  applyThenFailOnce = false;
  bootstrapCompleteWithoutCallback = false;
  retryLogtoAfterError = false;
  retryNautiloAfterError = false;
  private logtoFailed = false;
  private nautiloFailed = false;
  private logtoAttempt = 0;
  private nautiloAttempt = 0;

  async transferComplete() { this.events.push("gate:transfer"); return this.transfer; }
  async maintenanceCleanupComplete() { this.events.push("gate:cleanup"); return this.cleanup; }
  async ensureLogtoActivation({ variables }: Parameters<RailwayRestoredTargetActivationExecutor["ensureLogtoActivation"]>[0]) {
    this.events.push(`logto:ensure:${Object.keys(variables).join(",")}`);
    if (this.logtoJob === undefined || ((this.logtoFailed || this.logto === "error") && this.retryLogtoAfterError)) {
      if (this.logtoJob !== undefined) { this.logtoAttempt = Math.max(this.logtoAttempt, 1); this.logtoFailed = false; this.logto = "complete"; }
      this.logtoAttempt += 1;
      this.events.push("logto:create"); this.logtoJob = { jobId: `logto-deployment-${this.logtoAttempt}` };
    }
    return this.logtoJob;
  }
  async observeLogtoActivation({ jobId }: { jobId: string }) { this.events.push(`logto:observe:${jobId}`); this.logtoFailed = this.logto === "error"; return { state: this.logto } as const; }
  async runRestoredLogtoBootstrap(input: Parameters<RailwayRestoredTargetActivationExecutor["runRestoredLogtoBootstrap"]>[0]) {
    this.events.push(`bootstrap:${input.variables["NAUTILO_MANAGED_WORKBENCH_SOURCE_ORIGIN"] ?? "missing"}`);
    if (this.applyThenFailOnce) {
      this.applyThenFailOnce = false;
      await input.applyOutput(this.bootstrapOutput);
      return { outcome: "failure" as const };
    }
    if (this.bootstrap === "complete" && !this.bootstrapCompleteWithoutCallback) {
      const child = await input.applyOutput(this.bootstrapOutput);
      if (child.state !== "complete") return { outcome: "pending" as const };
    }
    return { outcome: this.bootstrap } as const;
  }
  async upsertFinalNautiloVariables({ variables }: Parameters<RailwayRestoredTargetActivationExecutor["upsertFinalNautiloVariables"]>[0]) { this.events.push(`nautilo:variables:${variables["LOGTO_M2M_APP_SECRET"]}`); }
  async findNautiloActivation() { this.events.push("nautilo:find"); return this.nautiloJob; }
  async ensureNautiloActivation() {
    this.events.push("nautilo:ensure");
    if (this.nautiloJob === undefined || ((this.nautiloFailed || this.nautilo === "error") && this.retryNautiloAfterError)) {
      if (this.nautiloJob !== undefined) { this.nautiloAttempt = Math.max(this.nautiloAttempt, 1); this.nautiloFailed = false; this.nautilo = "complete"; }
      this.nautiloAttempt += 1;
      this.events.push("nautilo:create"); this.nautiloJob = { jobId: `nautilo-deployment-${this.nautiloAttempt}` };
    }
    return this.nautiloJob;
  }
  async observeNautiloActivation({ jobId }: { jobId: string }) { this.events.push(`nautilo:observe:${jobId}`); this.nautiloFailed = this.nautilo === "error"; return { state: this.nautilo } as const; }
  async waitForNautiloReadiness({ origin }: { origin: string }) { this.events.push(`readiness:${origin}`); return this.readiness ? { outcome: "complete" as const, attempts: 1 } : { outcome: "failure" as const, attempts: 3, code: "retry-exhausted" as const }; }
}

function fixture(executor = new FixtureExecutor()) {
  let checkpoint: RailwayRestoredTargetActivationCheckpoint | undefined;
  const persisted: RailwayRestoredTargetActivationCheckpoint[] = [];
  let failBeforePersistStage: RailwayRestoredTargetActivationCheckpoint["stage"] | undefined;
  let failedPersist = false;
  const request: RailwayRestoredTargetActivationRequest = {
    operationId: "restore-1", projectId: "project-1", environmentId: "environment-1",
    logtoServiceId: "logto-service-1", nautiloServiceId: "nautilo-service-1",
    authorityGenerationId: "custody-generation-1",
    topology: topology(),
    projectionInputs: {
      generatedSecrets: new Map([["logto-bootstrap-handoff-token", "t".repeat(43)]]),
      generatedPublicDomains: new Map([["nautilo-public", targetOrigin], ["logto-public", "https://identity.example.test"]]),
      bootstrapOutputs: new Map(), externalProviderSecrets: new Map(),
    },
    sourceManagedWorkbenchOrigin: sourceOrigin,
    executor,
    persistCheckpoint: async (value) => {
      if (!failedPersist && value.stage === failBeforePersistStage) { failedPersist = true; throw new Error(SECRET); }
      checkpoint = structuredClone(value); persisted.push(structuredClone(value));
    },
  };
  return {
    executor, request, persisted, checkpoint: () => checkpoint,
    failBeforePersist: (stage: RailwayRestoredTargetActivationCheckpoint["stage"]) => { failBeforePersistStage = stage; },
  };
}

describe("restored target activation", () => {
  test("orders exact Logto, populated bootstrap, final Nautilo activation, and HTTPS readiness without seed", async () => {
    const value = fixture();
    const result = await runRailwayRestoredTargetActivation(value.request);
    expect(result.outcome).toBe("complete");
    expect(value.executor.events).toEqual([
      "gate:transfer", "gate:cleanup", "logto:ensure:DB_URL", "logto:create", "logto:observe:logto-deployment-1",
      `bootstrap:${sourceOrigin}`, `nautilo:variables:${SECRET}`, "nautilo:ensure", "nautilo:create",
      "nautilo:observe:nautilo-deployment-1", "nautilo:observe:nautilo-deployment-1", `readiness:${targetOrigin}`,
    ]);
    expect(value.executor.events.join("|")).not.toContain("seed");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  test("fails closed at transfer and cleanup gates before any activation effect", async () => {
    const transfer = fixture(); transfer.executor.transfer = false;
    expect(await runRailwayRestoredTargetActivation(transfer.request)).toMatchObject({ outcome: "failure", code: "transfer-incomplete" });
    expect(transfer.executor.events).toEqual(["gate:transfer", "gate:cleanup"]);
    const cleanup = fixture(); cleanup.executor.cleanup = false;
    expect(await runRailwayRestoredTargetActivation(cleanup.request)).toMatchObject({ outcome: "failure", code: "cleanup-incomplete" });
    expect(cleanup.executor.events).toEqual(["gate:transfer", "gate:cleanup"]);
  });

  test("persists and observes only exact child deployment IDs, with readiness strictly last", async () => {
    const value = fixture(); value.executor.logto = "running";
    const first = await runRailwayRestoredTargetActivation(value.request);
    expect(first).toMatchObject({ outcome: "pending", stage: "logto-observe", checkpoint: { logtoDeploymentId: "logto-deployment-1" } });
    expect(value.executor.events.some((event) => event.startsWith("bootstrap:"))).toBe(false);
    value.executor.logto = "complete";
    value.executor.nautilo = "running";
    const second = await runRailwayRestoredTargetActivation({ ...value.request, checkpoint: value.checkpoint() });
    expect(second).toMatchObject({ outcome: "pending", stage: "bootstrap-nautilo-start", checkpoint: { stage: "bootstrap-nautilo-start" } });
    expect(value.executor.events.some((event) => event.startsWith("readiness:"))).toBe(false);
    value.executor.nautilo = "complete";
    const third = await runRailwayRestoredTargetActivation({ ...value.request, checkpoint: value.checkpoint() });
    expect(third.outcome).toBe("complete");
    expect(value.executor.events.at(-1)).toBe(`readiness:${targetOrigin}`);
  });

  test("re-enters exact Logto activation after outer checkpoint loss without creating another deployment", async () => {
    const value = fixture(); value.failBeforePersist("logto-observe");
    const interrupted = await runRailwayRestoredTargetActivation(value.request);
    expect(interrupted).toMatchObject({ outcome: "failure", code: "persistence-failure" });
    expect(value.checkpoint()).toMatchObject({ stage: "logto-start" });
    const resumed = await runRailwayRestoredTargetActivation({ ...value.request, checkpoint: value.checkpoint() });
    expect(resumed.outcome).toBe("complete");
    expect(value.executor.events.filter((event) => event === "logto:create")).toHaveLength(1);
    expect(value.executor.events.filter((event) => event.startsWith("logto:ensure:"))).toHaveLength(2);
  });

  test("replays applyOutput idempotently after pre-handoff loss and recovers child after post-handoff outer loss", async () => {
    const replay = fixture(); replay.executor.applyThenFailOnce = true;
    const first = await runRailwayRestoredTargetActivation(replay.request);
    expect(first).toMatchObject({ outcome: "failure", code: "bootstrap-failed" });
    expect(replay.executor.events.filter((event) => event === "nautilo:create")).toHaveLength(1);
    const second = await runRailwayRestoredTargetActivation({ ...replay.request, checkpoint: replay.checkpoint() });
    expect(second.outcome).toBe("complete");
    expect(replay.executor.events.filter((event) => event === "nautilo:create")).toHaveLength(1);
    expect(replay.executor.events.filter((event) => event.startsWith("nautilo:variables:"))).toHaveLength(2);

    const recovered = fixture(); recovered.failBeforePersist("nautilo-observe");
    expect(await runRailwayRestoredTargetActivation(recovered.request)).toMatchObject({ outcome: "failure", code: "persistence-failure" });
    expect(recovered.checkpoint()).toMatchObject({ stage: "bootstrap-nautilo-start" });
    recovered.executor.bootstrapCompleteWithoutCallback = true;
    const resumed = await runRailwayRestoredTargetActivation({ ...recovered.request, checkpoint: recovered.checkpoint() });
    expect(resumed.outcome).toBe("complete");
    expect(recovered.executor.events.filter((event) => event === "nautilo:create")).toHaveLength(1);
    expect(recovered.executor.events).toContain("nautilo:find");
  });

  test("fresh-process resume bounded-retries failed exact Logto and Nautilo children without deleting handoff early", async () => {
    const logto = fixture(); logto.executor.logto = "error";
    expect(await runRailwayRestoredTargetActivation(logto.request)).toMatchObject({ outcome: "pending", stage: "logto-start" });
    const freshLogto = new FixtureExecutor();
    freshLogto.logtoJob = { jobId: "logto-deployment-1" }; freshLogto.logto = "error"; freshLogto.retryLogtoAfterError = true;
    expect((await runRailwayRestoredTargetActivation({ ...logto.request, executor: freshLogto, checkpoint: logto.checkpoint() })).outcome).toBe("complete");
    expect(freshLogto.events).toContain("logto:observe:logto-deployment-2");
    expect(freshLogto.events.filter((event) => event === "logto:create")).toHaveLength(1);

    const nautilo = fixture(); nautilo.executor.nautilo = "running";
    expect(await runRailwayRestoredTargetActivation(nautilo.request)).toMatchObject({ outcome: "pending", stage: "bootstrap-nautilo-start" });
    expect(nautilo.persisted.some(({ stage }) => stage === "nautilo-observe")).toBe(false);
    const freshNautilo = new FixtureExecutor();
    freshNautilo.logtoJob = { jobId: "logto-deployment-1" };
    freshNautilo.nautiloJob = { jobId: "nautilo-deployment-1" }; freshNautilo.nautilo = "error"; freshNautilo.retryNautiloAfterError = true;
    const resumed = await runRailwayRestoredTargetActivation({ ...nautilo.request, executor: freshNautilo, checkpoint: nautilo.checkpoint() });
    expect(resumed.outcome).toBe("complete");
    expect(freshNautilo.events.filter((event) => event === "nautilo:create")).toHaveLength(1);
    expect(freshNautilo.events.join("|")).not.toContain("seed");
    expect(JSON.stringify(resumed)).not.toContain(SECRET);
  });

  test("readiness failure never completes and a lost completion checkpoint safely reprobes last", async () => {
    const value = fixture(); value.executor.readiness = false;
    const failed = await runRailwayRestoredTargetActivation(value.request);
    expect(failed).toMatchObject({ outcome: "failure", code: "readiness-failed", checkpoint: { stage: "readiness" } });
    expect(value.persisted.some(({ stage }) => stage === "complete")).toBe(false);
    value.executor.readiness = true;
    value.failBeforePersist("complete");
    const lost = await runRailwayRestoredTargetActivation({ ...value.request, checkpoint: value.checkpoint() });
    expect(lost).toMatchObject({ outcome: "failure", code: "persistence-failure" });
    expect(value.checkpoint()).toMatchObject({ stage: "readiness" });
    const resumed = await runRailwayRestoredTargetActivation({ ...value.request, checkpoint: value.checkpoint() });
    expect(resumed.outcome).toBe("complete");
    expect(value.executor.events.filter((event) => event.startsWith("readiness:"))).toHaveLength(3);
  });

  test("distinguishes projection failure and rejects noncanonical/equal managed origins before effects", async () => {
    const projection = fixture();
    (projection.request.projectionInputs.generatedSecrets as Map<string, string>).delete("logto-bootstrap-handoff-token");
    expect(await runRailwayRestoredTargetActivation(projection.request)).toEqual({ outcome: "failure", code: "projection-failed" });
    expect(projection.executor.events).toEqual([]);
    for (const origin of ["http://source.example.test", `${targetOrigin}/`, targetOrigin]) {
      const invalid = fixture();
      const result = await runRailwayRestoredTargetActivation({ ...invalid.request, sourceManagedWorkbenchOrigin: origin });
      expect(result).toEqual({ outcome: "failure", code: "invalid-input" });
      expect(invalid.executor.events).toEqual([]);
    }
  });

  test("rejects oversized/control/extra handoff output before final variables or Nautilo activation", async () => {
    for (const invalid of [
      { ...output, "logto-m2m-app-secret": "x".repeat(4097) },
      { ...output, "logto-workbench-app-id": "bad\nvalue" },
      { ...output, "logto-resource": "https://other.example.test/api" },
      { ...output, extra: SECRET },
    ]) {
      const value = fixture(); value.executor.bootstrapOutput = invalid as RailwayBootstrapHandoffOutput;
      const result = await runRailwayRestoredTargetActivation(value.request);
      expect(result).toMatchObject({ outcome: "failure", code: "executor-failure" });
      expect(value.executor.events.some((event) => event.startsWith("nautilo:variables:"))).toBe(false);
      expect(value.executor.events).not.toContain("nautilo:create");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  test("binds custody generation and all three exact selected intents across process resume", async () => {
    const initial = fixture(); initial.executor.logto = "running";
    expect((await runRailwayRestoredTargetActivation(initial.request)).outcome).toBe("pending");
    const checkpoint = initial.checkpoint();
    expect(checkpoint).toBeDefined();
    const variants: RailwayRestoredTargetActivationRequest[] = [];
    variants.push({ ...initial.request, authorityGenerationId: "custody-generation-2", checkpoint });
    for (const selected of ["logto", "nautilo-server"] as const) {
      const changed = structuredClone(initial.request.topology);
      const service = changed.finalServices.find(({ name }) => name === selected)!;
      (service.variables as Array<unknown>).push({ key: "SAFE_DRIFT", value: { kind: "safe-literal", value: "changed" } });
      variants.push({ ...initial.request, topology: changed, checkpoint });
    }
    const changedBootstrap = structuredClone(initial.request.topology);
    (changedBootstrap.transientLogtoBootstrap.inputs as Array<unknown>).push({ key: "SAFE_DRIFT", value: { kind: "safe-literal", value: "changed" } });
    variants.push({ ...initial.request, topology: changedBootstrap, checkpoint });
    for (const request of variants) {
      initial.executor.events.length = 0;
      expect(await runRailwayRestoredTargetActivation(request)).toEqual({ outcome: "failure", code: "invalid-checkpoint" });
      expect(initial.executor.events).toEqual([]);
    }
    expect(JSON.stringify(checkpoint)).not.toContain("https://");
    expect(JSON.stringify(checkpoint)).not.toContain(SECRET);
  });

  test("snapshots callbacks, topology, maps, and origins before the first await", async () => {
    const value = fixture();
    const originalPersist = value.request.persistCheckpoint;
    const run = runRailwayRestoredTargetActivation(value.request);
    (value.request.executor as unknown as { transferComplete: () => Promise<boolean> }).transferComplete = async () => false;
    (value.request as unknown as { persistCheckpoint: typeof originalPersist }).persistCheckpoint = async () => { throw new Error(SECRET); };
    (value.request.projectionInputs.generatedPublicDomains as Map<string, string>).set("nautilo-public", "https://evil.example.test");
    (value.request.topology.finalServices.find(({ name }) => name === "logto")!.variables as Array<unknown>).push({ key: "EVIL", value: { kind: "safe-literal", value: SECRET } });
    (value.request as unknown as { sourceManagedWorkbenchOrigin: string }).sourceManagedWorkbenchOrigin = "https://evil.example.test";
    const result = await run;
    expect(result.outcome).toBe("complete");
    expect(value.executor.events).toContain(`bootstrap:${sourceOrigin}`);
    expect(value.executor.events).toContain(`readiness:${targetOrigin}`);
    expect(value.executor.events.join("|")).not.toContain("EVIL");
  });

  test("rejects hostile snapshots and attacker checkpoints without reflecting values", async () => {
    const hostile = fixture();
    Object.defineProperty(hostile.request, "topology", { get: () => { throw new Error(FORBIDDEN); } });
    expect(await runRailwayRestoredTargetActivation(hostile.request)).toEqual({ outcome: "failure", code: "invalid-input" });
    const value = fixture();
    const result = await runRailwayRestoredTargetActivation({
      ...value.request,
      checkpoint: { stage: "evil", secret: FORBIDDEN } as unknown as RailwayRestoredTargetActivationCheckpoint,
    });
    expect(result).toEqual({ outcome: "failure", code: "invalid-checkpoint" });
    expect(JSON.stringify(result)).not.toContain(FORBIDDEN);
  });
});
