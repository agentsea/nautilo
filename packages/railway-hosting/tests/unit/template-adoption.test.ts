import { describe, expect, test } from "bun:test";

import {
  canonicalReleaseManifestBytes,
  verifyReleaseManifest,
  type LaunchReceipt,
  type ReleaseManifest,
  type VerifiedReleaseManifest,
} from "@nautilo/hosting";

import {
  auditRailwayTemplateAdoption,
  prepareRailwayTemplateAdoption,
  type RailwayTemplateAdoptionAuditCode,
  type RailwayTemplateAdoptionObservation,
} from "../../src/template-adoption";
import { compileRailwayHeldTemplateScaffold } from "../../src/template-held-scaffold";

const image = (name: string, character: string) => `${name}@sha256:${character.repeat(64)}`;

function verified(): VerifiedReleaseManifest {
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    releaseId: "template-adoption-test",
    images: [
      { name: "app-postgres", reference: image("pgvector/pgvector", "a") },
      { name: "logto-postgres", reference: image("postgres", "b") },
      { name: "logto", reference: image("ghcr.io/logto-io/logto", "c") },
      { name: "nautilo-server", reference: image("ghcr.io/agentsea/nautilo-runtime-v2", "d") },
      { name: "nautilo-bootstrap", reference: image("ghcr.io/agentsea/nautilo-bootstrap-runtime-v2", "e") },
    ],
    topology: {
      schemaVersion: 1,
      bootstrap: { image: "nautilo-bootstrap" },
      services: [
        { name: "app-postgres", role: "app-postgres", image: "app-postgres" },
        { name: "logto-postgres", role: "logto-postgres", image: "logto-postgres" },
        { name: "logto-seed", role: "logto-seed", image: "logto" },
        { name: "logto", role: "logto", image: "logto" },
        { name: "nautilo-server", role: "nautilo-server", image: "nautilo-server" },
      ],
      persistentMounts: [
        { role: "app-postgres-data", service: "app-postgres", mountPath: "/var/lib/postgresql/data" },
        { role: "logto-postgres-data", service: "logto-postgres", mountPath: "/var/lib/postgresql/data" },
        { role: "nautilo-data", service: "nautilo-server", mountPath: "/var/lib/nautilo" },
      ],
      environmentSchemaVersion: 1,
      migrationSchemaVersion: 1,
    },
    compatibility: {
      runtime: { minimum: 1, maximum: 1 },
      protocol: { minimum: 1, maximum: 1 },
      topology: { minimum: 1, maximum: 1 },
    },
  };
  const result = verifyReleaseManifest({
    manifest,
    signature: { algorithm: "ed25519", keyId: "test-key", value: Buffer.alloc(64).toString("base64") },
  }, { runtimeVersion: 1, protocolVersion: 1, topologySchemaVersion: 1 }, {
    trustedPublicKeys: { "test-key": Buffer.from("test-spki").toString("base64") },
    verifier: { verify: ({ signedBytes }) => Buffer.from(signedBytes).equals(Buffer.from(canonicalReleaseManifestBytes(manifest))) },
  });
  if (!result.ok) throw new Error(result.code);
  return result.manifest;
}

function observation(): RailwayTemplateAdoptionObservation {
  const release = verified();
  const compiled = compileRailwayHeldTemplateScaffold(release);
  if (!compiled.ok) throw new Error(compiled.code);
  const serviceIds = new Map(compiled.scaffold.services.map((service, index) => [service.name, `service-${index + 1}`]));
  const value = (name: string, key: string) => `generated-${name}-${key}`.padEnd(48, "x");
  return {
    workspaceId: "workspace-1",
    projectId: "project-1",
    projectName: "nautilo-template",
    environmentId: "environment-1",
    environmentName: "production",
    sourceTemplateId: "template-1",
    sourceTemplateThreadSlug: null,
    services: compiled.scaffold.services.map((service, index) => ({
      id: serviceIds.get(service.name)!,
      name: service.name,
      image: service.image,
      startCommand: service.startCommand,
      templateId: "template-1",
      templateServiceId: `template-service-${index + 1}`,
      templateThreadSlug: null,
      deploymentId: `deployment-${index + 1}`,
      deploymentStatus: "SUCCESS",
      variables: Object.fromEntries(service.variables.map((variable) => [
        variable.key,
        variable.custody === "safe-literal" ? variable.value : value(service.name, variable.key),
      ])),
      unrenderedVariables: Object.fromEntries(service.variables.map((variable) => [variable.key, variable.value])),
    })),
    volumes: compiled.scaffold.volumes.map((volume, index) => ({
      id: `volume-${index + 1}`,
      name: `provider-volume-${index + 1}`,
      serviceId: serviceIds.get(volume.service)!,
      mountPath: volume.mountPath,
    })),
    domains: compiled.scaffold.domains.map((domain, index) => ({
      id: `domain-${index + 1}`,
      serviceId: serviceIds.get(domain.service)!,
      targetPort: domain.targetPort,
    })),
  };
}

const discovery = (values: readonly RailwayTemplateAdoptionObservation[]) => ({
  discoverNautiloShapedProjects: async () => values,
});

describe("Railway held-template adoption audit", () => {
  test("accepts one exact held project and returns no provider IDs or generated values", async () => {
    const candidate = observation();
    const result = await auditRailwayTemplateAdoption({ manifest: verified(), discovery: discovery([candidate]) });
    expect(result).toEqual({
      schemaVersion: 1,
      operation: "adopt-audit",
      backend: "railway",
      outcome: "ready",
      code: "railway.template-adoption.ready",
      projectName: "nautilo-template",
      releaseId: "template-adoption-test",
      nextAction: "review-adoption-plan",
      mutationAuthorized: false,
    });
    const publicBytes = JSON.stringify(result);
    expect(publicBytes).not.toContain("project-1");
    expect(publicBytes).not.toContain("generated-");
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("fails closed for zero or multiple Nautilo-shaped projects", async () => {
    expect((await auditRailwayTemplateAdoption({ manifest: verified(), discovery: discovery([]) })).code)
      .toBe("railway.template-adoption.no-match");
    expect((await auditRailwayTemplateAdoption({ manifest: verified(), discovery: discovery([observation(), observation()]) })).code)
      .toBe("railway.template-adoption.ambiguous");
  });

  test("rejects stale provenance, wrong digest, changed hold, missing and foreign resources", async () => {
    const cases: Array<[RailwayTemplateAdoptionObservation, RailwayTemplateAdoptionAuditCode]> = [];
    const provenanceBase = observation();
    const provenance = { ...provenanceBase, services: provenanceBase.services.map((service, index) => index === 0 ? { ...service, templateId: "stale-template" } : service) };
    cases.push([provenance, "railway.template-adoption.provenance-mismatch"]);
    const digestBase = observation();
    const digest = { ...digestBase, services: digestBase.services.map((service, index) => index === 4 ? { ...service, image: image("ghcr.io/agentsea/nautilo-runtime-v2", "f") } : service) };
    cases.push([digest, "railway.template-adoption.digest-mismatch"]);
    const holdBase = observation();
    const hold = { ...holdBase, services: holdBase.services.map((service, index) => index === 3 ? { ...service, startCommand: null } : service) };
    cases.push([hold, "railway.template-adoption.hold-mismatch"]);
    const missingBase = observation();
    const missing = { ...missingBase, volumes: missingBase.volumes.slice(0, -1) };
    cases.push([missing, "railway.template-adoption.resource-mismatch"]);
    const foreignBase = observation();
    const foreign = { ...foreignBase, services: [...foreignBase.services, { ...foreignBase.services[0]!, id: "foreign-service", name: "redis", deploymentId: "foreign-deployment" }] };
    cases.push([foreign, "railway.template-adoption.resource-mismatch"]);
    for (const [candidate, code] of cases) {
      expect((await auditRailwayTemplateAdoption({ manifest: verified(), discovery: discovery([candidate]) })).code).toBe(code);
    }
  });

  test("rejects missing, extra, short, or non-rendered generated variables", async () => {
    const mutateFirst = (change: (variables: Record<string, string>, unrendered: Record<string, string>) => void): RailwayTemplateAdoptionObservation => {
      const base = observation();
      const services = base.services.map((service, index) => {
        if (index !== 0) return service;
        const variables = { ...service.variables };
        const unrendered = { ...service.unrenderedVariables };
        change(variables, unrendered);
        return { ...service, variables, unrenderedVariables: unrendered };
      });
      return { ...base, services };
    };
    const missing = mutateFirst((variables) => { delete variables["POSTGRES_PASSWORD"]; });
    const extra = mutateFirst((variables, unrendered) => {
      variables["FOREIGN_SECRET"] = "x".repeat(48);
      unrendered["FOREIGN_SECRET"] = "${{ secret(48) }}";
    });
    const short = mutateFirst((variables) => { variables["POSTGRES_PASSWORD"] = "short"; });
    const unresolved = mutateFirst((variables) => { variables["POSTGRES_PASSWORD"] = "${{ secret(48) }}"; });
    for (const candidate of [missing, extra, short, unresolved]) {
      expect((await auditRailwayTemplateAdoption({ manifest: verified(), discovery: discovery([candidate]) })).code)
        .toBe("railway.template-adoption.variable-mismatch");
    }
  });

  test("accepts Railway-injected rendered variables while keeping template authority exact", async () => {
    const base = observation();
    const candidate = {
      ...base,
      services: base.services.map((service) => ({
        ...service,
        variables: { ...service.variables, RAILWAY_SERVICE_ID: "provider-owned" },
      })),
    };
    expect((await auditRailwayTemplateAdoption({ manifest: verified(), discovery: discovery([candidate]) })).code)
      .toBe("railway.template-adoption.ready");
  });

  test("persists the non-secret exact receipt before moving all nine values into credential custody", async () => {
    const events: string[] = [];
    let receipt: LaunchReceipt | undefined;
    const result = await prepareRailwayTemplateAdoption({
      manifest: verified(),
      discovery: discovery([observation()]),
      launchId: "launch-1",
      now: "2026-08-18T12:00:00.000Z",
      persistReceipt: async (value) => {
        events.push("receipt");
        receipt = structuredClone(value);
      },
      storeGeneratedSecrets: async (binding, secrets) => {
        events.push("keychain");
        expect(receipt).toBeDefined();
        expect(binding).toEqual({ launchId: "launch-1", releaseId: "template-adoption-test" });
        expect(secrets.size).toBe(9);
      },
    });
    expect(result.outcome).toBe("ready");
    expect(events).toEqual(["receipt", "keychain"]);
    expect(receipt?.stage).toBe("authorized");
    expect(receipt?.resources).toHaveLength(17);
    expect(JSON.stringify(receipt)).not.toContain("generated-");
    expect(receipt?.resources.filter((resource) => resource.kind === "railway.deployment")).toHaveLength(5);
  });

  test("never writes receipt or custody on mismatch and collapses callback failures", async () => {
    const calls: string[] = [];
    const invalidBase = observation();
    const invalid = { ...invalidBase, services: invalidBase.services.map((service, index) => index === 0 ? { ...service, image: "mutable:latest" } : service) };
    const rejected = await prepareRailwayTemplateAdoption({
      manifest: verified(), discovery: discovery([invalid]), launchId: "launch-1", now: "2026-08-18T12:00:00.000Z",
      persistReceipt: async () => { calls.push("receipt"); },
      storeGeneratedSecrets: async () => { calls.push("keychain"); },
    });
    expect(rejected.code).toBe("railway.template-adoption.digest-mismatch");
    expect(calls).toEqual([]);

    const secret = observation().services[0]!.variables["POSTGRES_PASSWORD"]!;
    const failed = await prepareRailwayTemplateAdoption({
      manifest: verified(), discovery: discovery([observation()]), launchId: "launch-1", now: "2026-08-18T12:00:00.000Z",
      persistReceipt: async () => { throw new Error(`do not leak ${secret}`); },
      storeGeneratedSecrets: async () => { calls.push("keychain"); },
    });
    expect(failed.outcome).toBe("blocked");
    expect(failed.code).toBe("railway.template-adoption.discovery-failed");
    expect(JSON.stringify(failed)).not.toContain(secret);
  });
});
