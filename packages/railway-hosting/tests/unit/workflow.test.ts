import { describe, expect, test } from "bun:test";

import {
  runRailwayDeploymentWorkflow,
  type RailwayDeploymentWorkflowRequest,
} from "../../src/workflow";
import type { RailwayTopology } from "../../src/topology";

const image = (name: string, fill: string) => `registry.test/${name}@sha256:${fill.repeat(64)}`;

function topology(): RailwayTopology {
  const literal = (value: string) => ({ kind: "safe-literal" as const, value });
  return {
    schemaVersion: 1,
    releaseId: "release-1",
    finalServices: [
      { name: "app-postgres", imageName: "app-postgres", image: image("app-postgres", "a"), kind: "long-lived", privatePorts: [], variables: [{ key: "POSTGRES_USER", value: literal("postgres") }] },
      { name: "logto-postgres", imageName: "logto-postgres", image: image("logto-postgres", "b"), kind: "long-lived", privatePorts: [], variables: [{ key: "POSTGRES_USER", value: literal("postgres") }] },
      { name: "logto-seed", imageName: "logto", image: image("logto", "c"), kind: "run-once", privatePorts: [], variables: [{ key: "DB_URL", value: literal("postgres://seed") }] },
      { name: "logto", imageName: "logto", image: image("logto", "c"), kind: "long-lived", privatePorts: [], variables: [{ key: "PORT", value: literal("4301") }] },
      {
        name: "nautilo-server",
        imageName: "nautilo-server",
        image: image("nautilo-server", "d"),
        kind: "long-lived",
        privatePorts: [],
        variables: [{
          key: "LOGTO_M2M_APP_SECRET",
          value: { kind: "bootstrap-output-reference", producer: "logto-post-seed-reconciliation", output: "logto-m2m-app-secret" },
        }],
      },
    ],
    mounts: [],
    generatedPublicDomains: [
      { logicalName: "logto-public", service: "logto", targetPort: 4301 },
      { logicalName: "nautilo-public", service: "nautilo-server", targetPort: 3001 },
    ],
    transientBootstrap: {
      kind: "transient-bootstrap", serviceName: "nautilo-bootstrap", imageName: "nautilo-bootstrap",
      image: image("nautilo-bootstrap", "e"), lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"],
      inputs: [{ key: "NAUTILO_BOOTSTRAP_MODE", value: literal("database") }],
      prohibitedLongLivedServices: ["logto-seed", "logto", "nautilo-server"],
    },
    transientLogtoBootstrap: {
      kind: "transient-bootstrap", serviceName: "nautilo-bootstrap", imageName: "nautilo-bootstrap",
      image: image("nautilo-bootstrap", "e"), lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"],
      inputs: [
        { key: "NAUTILO_BOOTSTRAP_MODE", value: literal("logto") },
        { key: "NAUTILO_BOOTSTRAP_HANDOFF_TOKEN", value: { kind: "generated-secret-slot", slot: "logto-bootstrap-handoff-token", purpose: "handoff" } },
      ],
      prohibitedLongLivedServices: ["nautilo-server"],
    },
    qualifications: [],
  };
}

const output = {
  "logto-workbench-app-id": "workbench",
  "logto-tui-app-id": "tui",
  "logto-tui-loopback-app-id": "tui-loopback",
  "logto-desktop-app-id": "desktop",
  "logto-mobile-app-id": "mobile",
  "logto-mobile-web-app-id": "mobile-web",
  "logto-m2m-app-id": "m2m",
  "logto-m2m-app-secret": "never-persist-output-secret",
  "logto-resource": "https://nautilo.test/api",
} as const;

describe("runRailwayDeploymentWorkflow", () => {
  test("walks the full ordered graph and applies Logto output directly to final reconciliation", async () => {
    const events: string[] = [];
    let checkpoint: Parameters<typeof runRailwayDeploymentWorkflow>[0]["checkpoint"];
    const result = await runRailwayDeploymentWorkflow({
      topology: topology(),
      projectionInputs: {
        generatedSecrets: new Map([["logto-bootstrap-handoff-token", "h".repeat(43)]]),
        generatedPublicDomains: new Map(),
        bootstrapOutputs: new Map(),
        externalProviderSecrets: new Map(),
      },
      target: { workspaceId: "workspace-1", projectName: "Nautilo", environmentName: "production" },
      checkpoint,
      persistCheckpoint: (next) => { checkpoint = next; return Promise.resolve(); },
      executor: {
        reconcile: (desired) => {
          events.push(`reconcile:${desired.services.map((service) => service.name).join("+")}`);
          const server = desired.services.find((service) => service.name === "nautilo-server" && service.image);
          if (server) expect(server.variables["LOGTO_M2M_APP_SECRET"]).toBe("never-persist-output-secret");
          return Promise.resolve({ outcome: "complete" });
        },
        runDatabaseBootstrap: () => { events.push("database-bootstrap"); return Promise.resolve({ outcome: "complete" }); },
        waitForService: (service) => { events.push(`ready:${service}`); return Promise.resolve({ outcome: "complete" }); },
        runLogtoBootstrap: async ({ token, applyOutput }) => {
          events.push("logto-bootstrap");
          expect(token).toBe("h".repeat(43));
          await applyOutput(output);
          return { outcome: "complete" };
        },
      },
    });

    expect(result.outcome).toBe("complete");
    expect(events).toEqual([
      "reconcile:app-postgres+logto-postgres",
      "ready:app-postgres",
      "ready:logto-postgres",
      "database-bootstrap",
      "reconcile:logto-seed",
      "ready:logto-seed",
      "reconcile:logto+nautilo-server",
      "reconcile:logto",
      "ready:logto",
      "logto-bootstrap",
      "reconcile:app-postgres+logto-postgres+logto-seed+logto+nautilo-server",
      "ready:nautilo-server",
    ]);
    expect(JSON.stringify(result)).not.toContain("never-persist-output-secret");
    expect(JSON.stringify(checkpoint)).not.toContain("h".repeat(43));
  });

  test("returns pending at a readiness boundary and resumes from the persisted stage", async () => {
    let checkpoint: Parameters<typeof runRailwayDeploymentWorkflow>[0]["checkpoint"];
    let firstSeedWait = true;
    const executor = {
      reconcile: () => Promise.resolve({ outcome: "complete" as const }),
      runDatabaseBootstrap: () => Promise.resolve({ outcome: "complete" as const }),
      waitForService: (service: "app-postgres" | "logto-postgres" | "logto-seed" | "logto" | "nautilo-server") => {
        if (service === "logto-seed" && firstSeedWait) {
          firstSeedWait = false;
          return Promise.resolve({ outcome: "pending" as const });
        }
        return Promise.resolve({ outcome: "complete" as const });
      },
      runLogtoBootstrap: async ({ applyOutput }: { readonly applyOutput: (value: typeof output) => Promise<void> }) => {
        await applyOutput(output);
        return { outcome: "complete" as const };
      },
    };
    const request = (): RailwayDeploymentWorkflowRequest => ({
      topology: topology(),
      projectionInputs: {
        generatedSecrets: new Map([["logto-bootstrap-handoff-token", "h".repeat(43)]]),
        generatedPublicDomains: new Map(), bootstrapOutputs: new Map(), externalProviderSecrets: new Map(),
      },
      target: { workspaceId: "workspace-1", projectName: "Nautilo", environmentName: "production" },
      checkpoint,
      persistCheckpoint: (next) => { checkpoint = next; return Promise.resolve(); },
      executor,
    });
    const first = await runRailwayDeploymentWorkflow(request());
    expect(first).toMatchObject({ outcome: "pending", checkpoint: { stage: "logto-seed-ready" } });
    const resumed = await runRailwayDeploymentWorkflow(request());
    expect(resumed).toMatchObject({ outcome: "complete", checkpoint: { stage: "complete" } });
  });

  test("does not start database bootstrap until both PostgreSQL services are ready", async () => {
    let checkpoint: Parameters<typeof runRailwayDeploymentWorkflow>[0]["checkpoint"];
    const events: string[] = [];
    let appDatabaseReady = false;
    let logtoDatabaseReady = false;
    const request = (): RailwayDeploymentWorkflowRequest => ({
      topology: topology(),
      projectionInputs: {
        generatedSecrets: new Map([["logto-bootstrap-handoff-token", "h".repeat(43)]]),
        generatedPublicDomains: new Map(), bootstrapOutputs: new Map(), externalProviderSecrets: new Map(),
      },
      target: { workspaceId: "workspace-1", projectName: "Nautilo", environmentName: "production" },
      checkpoint,
      persistCheckpoint: (next) => { checkpoint = next; return Promise.resolve(); },
      executor: {
        reconcile: () => Promise.resolve({ outcome: "complete" }),
        waitForService: (service) => {
          events.push(`ready:${service}`);
          if (service === "app-postgres" && !appDatabaseReady) return Promise.resolve({ outcome: "pending" });
          if (service === "logto-postgres" && !logtoDatabaseReady) return Promise.resolve({ outcome: "pending" });
          return Promise.resolve({ outcome: "complete" });
        },
        runDatabaseBootstrap: () => { events.push("database-bootstrap"); return Promise.resolve({ outcome: "complete" }); },
        runLogtoBootstrap: async ({ applyOutput }) => {
          await applyOutput(output);
          return { outcome: "complete" };
        },
      },
    });

    const pending = await runRailwayDeploymentWorkflow(request());
    expect(pending).toMatchObject({ outcome: "pending", checkpoint: { stage: "database-bootstrap" } });
    expect(events).toEqual(["ready:app-postgres"]);

    appDatabaseReady = true;
    const stillPending = await runRailwayDeploymentWorkflow(request());
    expect(stillPending).toMatchObject({ outcome: "pending", checkpoint: { stage: "database-bootstrap" } });
    expect(events.slice(1)).toEqual(["ready:app-postgres", "ready:logto-postgres"]);

    logtoDatabaseReady = true;
    const complete = await runRailwayDeploymentWorkflow(request());
    expect(complete.outcome).toBe("complete");
    expect(events.slice(3, 6)).toEqual([
      "ready:app-postgres",
      "ready:logto-postgres",
      "database-bootstrap",
    ]);
  });
});
