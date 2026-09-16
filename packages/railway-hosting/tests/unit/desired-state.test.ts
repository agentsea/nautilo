import { describe, expect, test } from "bun:test";

import {
  compileRailwayPreparationDesiredStates,
  compileRailwayReconcileDesiredState,
} from "../../src/desired-state";
import type { RailwayTopology } from "../../src/topology";
import type { RailwayVariableProjection } from "../../src/variable-projection";

const digest = (name: string, fill: string): string =>
  `registry.nautilo.test/${name}@sha256:${fill.repeat(64)}`;

function topology(qualified = true): RailwayTopology {
  return {
    schemaVersion: 1,
    releaseId: "release-1",
    finalServices: [
      { name: "app-postgres", imageName: "app-postgres", image: digest("app-postgres", "a"), kind: "long-lived", privatePorts: [], variables: [] },
      { name: "logto-postgres", imageName: "logto-postgres", image: digest("logto-postgres", "b"), kind: "long-lived", privatePorts: [], variables: [] },
      { name: "logto-seed", imageName: "logto", image: digest("logto", "c"), kind: "run-once", privatePorts: [], startCommand: "npm run cli db seed -- --swe", variables: [] },
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
    transientBootstrap: {
      kind: "transient-bootstrap",
      serviceName: "nautilo-bootstrap",
      imageName: "nautilo-bootstrap",
      image: digest("nautilo-bootstrap", "e"),
      lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"],
      inputs: [],
      prohibitedLongLivedServices: ["logto-seed", "logto", "nautilo-server"],
    },
    transientLogtoBootstrap: {
      kind: "transient-bootstrap",
      serviceName: "nautilo-bootstrap",
      imageName: "nautilo-bootstrap",
      image: digest("nautilo-bootstrap", "e"),
      lifecycle: ["create", "run-idempotent-reconciler", "checkpoint-success", "delete", "verify-absent"],
      inputs: [],
      prohibitedLongLivedServices: ["nautilo-server"],
    },
    qualifications: qualified ? [] : [{
      code: "runtime.logto-post-seed-reconciliation-unqualified",
      disposition: "blocking",
      explanation: "test",
    }],
  };
}

function projection(): RailwayVariableProjection {
  return {
    finalServices: {
      "app-postgres": { POSTGRES_PASSWORD: "secret-app" },
      "logto-postgres": { POSTGRES_PASSWORD: "secret-logto" },
      "logto-seed": { DB_URL: "secret-seed" },
      logto: { DB_URL: "secret-logto-url" },
      "nautilo-server": { OPENROUTER_API_KEY: "secret-provider" },
    },
    transientBootstrap: { APP_POSTGRES_ADMIN_URL: "secret-bootstrap" },
    transientLogtoBootstrap: { NAUTILO_BOOTSTRAP_MODE: "logto" },
  };
}

const target = { workspaceId: "workspace-1", projectName: "Nautilo", environmentName: "production" };

describe("compileRailwayReconcileDesiredState", () => {
  test("compiles ordered preparation slices without attaching images to public scaffolds", () => {
    const result = compileRailwayPreparationDesiredStates(topology(false), {
      generatedSecrets: new Map(),
      generatedPublicDomains: new Map(),
      bootstrapOutputs: new Map(),
      externalProviderSecrets: new Map(),
    }, target);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.blockers[0]?.code);
    expect(result.preparation.databases.services.map((entry) => entry.name)).toEqual([
      "app-postgres",
      "logto-postgres",
    ]);
    expect(result.preparation.logtoSeed.services).toMatchObject([{
      name: "logto-seed",
      deploy: true,
      startCommand: "npm run cli db seed -- --swe",
    }]);
    expect(result.preparation.publicScaffold.services).toEqual([
      { name: "logto", variables: {}, deploy: false },
      { name: "nautilo-server", variables: {}, deploy: false },
    ]);
    expect(result.preparation.publicScaffold.domains).toHaveLength(2);
    expect(result.preparation.logtoCore.services[0]).toMatchObject({ name: "logto", deploy: true });
    expect(result.preparation.logtoCore.services[0]?.image).toBe(digest("logto", "c"));
  });

  test("compiles the exact topology, mounts, domains, images, and request-only variables", () => {
    const result = compileRailwayReconcileDesiredState(topology(), projection(), target);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.blockers[0]?.code);
    expect(result.desired.project).toEqual({ name: "Nautilo", workspaceId: "workspace-1" });
    expect(result.desired.services).toHaveLength(5);
    expect(result.desired.services[4]).toMatchObject({
      name: "nautilo-server",
      image: digest("nautilo-server", "d"),
      variables: { OPENROUTER_API_KEY: "secret-provider" },
      deploy: true,
    });
    expect(result.desired.volumes).toHaveLength(3);
    expect(result.desired.domains).toHaveLength(2);
  });

  test("fails closed on a remaining topology qualification without serializing variables", () => {
    const result = compileRailwayReconcileDesiredState(topology(false), projection(), target);
    expect(result).toEqual({
      ok: false,
      blockers: [{ code: "railway.desired-state.topology-qualification" }],
    });
    expect(JSON.stringify(result)).not.toContain("secret-provider");
  });

  test("rejects projection drift and invalid target identity", () => {
    const drifted = projection() as unknown as { finalServices: Record<string, Record<string, string>>; transientBootstrap: Record<string, string> };
    delete drifted.finalServices["logto-seed"];
    expect(compileRailwayReconcileDesiredState(topology(), drifted as RailwayVariableProjection, target)).toEqual({
      ok: false,
      blockers: [{ code: "railway.desired-state.projection-mismatch" }],
    });
    expect(compileRailwayReconcileDesiredState(topology(), projection(), { ...target, workspaceId: " " })).toEqual({
      ok: false,
      blockers: [{ code: "railway.desired-state.invalid-target" }],
    });
  });
});
