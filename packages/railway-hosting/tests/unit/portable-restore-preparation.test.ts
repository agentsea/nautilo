import { describe, expect, test } from "bun:test";

import { compileRailwayPortableRestorePreparation } from "../../src/portable-restore-preparation";
import type { RailwayTopology } from "../../src/topology";

const digest = (name: string, fill: string) => `registry.nautilo.test/${name}@sha256:${fill.repeat(64)}`;
const target = { workspaceId: "workspace-1", projectName: "Restore", environmentName: "restore" };

function topology(): RailwayTopology {
  return {
    schemaVersion: 1,
    releaseId: "release-1",
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

function inputs() {
  return {
    generatedSecrets: new Map([
      ["app-postgres-superuser-password" as const, "request-only-app"],
      ["logto-postgres-superuser-password" as const, "request-only-logto"],
    ]),
    generatedPublicDomains: new Map(), bootstrapOutputs: new Map(), externalProviderSecrets: new Map(),
  };
}

describe("compileRailwayPortableRestorePreparation", () => {
  test("stages only fresh DBs plus an empty Nautilo scaffold and its immutable maintenance image", () => {
    const first = compileRailwayPortableRestorePreparation(topology(), inputs(), target);
    const second = compileRailwayPortableRestorePreparation(topology(), inputs(), target);
    expect(first).toEqual(second);
    if (!first.ok) throw new Error(first.blockers[0]?.code);
    expect(first.preparation.databases.services).toEqual([
      { name: "app-postgres", image: digest("app-postgres", "a"), variables: { POSTGRES_PASSWORD: "request-only-app" }, deploy: true },
      { name: "logto-postgres", image: digest("logto-postgres", "b"), variables: { POSTGRES_PASSWORD: "request-only-logto" }, deploy: true },
    ]);
    expect(first.preparation.databases.volumes).toEqual([
      { logicalName: "app-postgres-data", service: "app-postgres", mountPath: "/var/lib/postgresql/data" },
      { logicalName: "logto-postgres-data", service: "logto-postgres", mountPath: "/var/lib/postgresql/data" },
    ]);
    expect(first.preparation.publicScaffold.services).toEqual([{ name: "logto", variables: {}, deploy: false }, { name: "nautilo-server", variables: {}, deploy: false }]);
    expect(first.preparation.publicScaffold.volumes).toEqual([{ logicalName: "nautilo-data", service: "nautilo-server", mountPath: "/var/lib/nautilo" }]);
    expect(first.preparation.publicScaffold.domains).toHaveLength(2);
    expect(first.preparation.databaseBootstrapVariables).toEqual({ APP_POSTGRES_PASSWORD: "request-only-app" });
    expect(first.preparation.maintenanceImage).toEqual({ serviceName: "nautilo-server", image: digest("nautilo-server", "d"), releaseId: "release-1" });
  });

  test("excludes logto-seed and normal Logto/Nautilo image attachment", () => {
    const result = compileRailwayPortableRestorePreparation(topology(), inputs(), target);
    if (!result.ok) throw new Error(result.blockers[0]?.code);
    expect(result.preparation.publicScaffold.services.map((service) => service.name)).toEqual(["logto", "nautilo-server"]);
    expect(result.preparation.publicScaffold.services.find((service) => service.name === "nautilo-server")).not.toHaveProperty("image");
    expect(result.preparation.publicScaffold.services.find((service) => service.name === "logto")).not.toHaveProperty("image");
    expect(result.preparation.databases.services.map((service) => service.name)).not.toContain("logto-seed");
    expect(result.preparation.databases.services.map((service) => service.name)).not.toContain("logto");
    expect(result.preparation.publicScaffold.services.map((service) => service.name)).not.toContain("logto-seed");
  });

  test("fails closed for malformed frozen topology", () => {
    const missing = topology();
    (missing.mounts as Array<unknown>).pop();
    expect(compileRailwayPortableRestorePreparation(missing, inputs(), target)).toEqual({ ok: false, blockers: [{ code: "railway.desired-state.projection-mismatch" }] });
    expect(compileRailwayPortableRestorePreparation(topology(), inputs(), { ...target, workspaceId: " " })).toEqual({ ok: false, blockers: [{ code: "railway.desired-state.invalid-target" }] });
  });

  test("preserves the canonical projection blocker without serializing request values", () => {
    const result = compileRailwayPortableRestorePreparation(topology(), {
      generatedSecrets: new Map(), generatedPublicDomains: new Map(), bootstrapOutputs: new Map(), externalProviderSecrets: new Map(),
    }, target);
    expect(result).toEqual({ ok: false, blockers: [{ code: "railway.desired-state.projection-mismatch" }] });
    expect(JSON.stringify(result)).not.toContain("request-only-app");
  });

  test("rejects a blocking topology qualification before exposing a restore target", () => {
    const blocked = topology();
    (blocked.qualifications as Array<unknown>).push({
      code: "runtime.logto-post-seed-reconciliation-unqualified",
      disposition: "blocking",
      explanation: "test",
    });
    expect(compileRailwayPortableRestorePreparation(blocked, inputs(), target)).toEqual({
      ok: false,
      blockers: [{ code: "railway.desired-state.topology-qualification" }],
    });
  });
});
