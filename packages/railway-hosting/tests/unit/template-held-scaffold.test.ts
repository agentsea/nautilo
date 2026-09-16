import { describe, expect, test } from "bun:test";

import {
  canonicalReleaseManifestBytes,
  verifyReleaseManifest,
  type ReleaseManifest,
  type VerifiedReleaseManifest,
} from "@nautilo/hosting";

import {
  compileRailwayHeldTemplateScaffold,
  RAILWAY_LOGTO_HOLD_COMMAND,
  RAILWAY_LOGTO_SEED_HOLD_COMMAND,
  RAILWAY_NAUTILO_SETUP_HOLD_COMMAND,
} from "../../src/template-held-scaffold";

const image = (name: string, character: string) => `${name}@sha256:${character.repeat(64)}`;

function manifest(): ReleaseManifest {
  return {
    schemaVersion: 1,
    releaseId: "held-template-test",
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
}

function verified(value = manifest()): VerifiedReleaseManifest {
  const result = verifyReleaseManifest(
    {
      manifest: value,
      signature: {
        algorithm: "ed25519",
        keyId: "test-key",
        value: Buffer.alloc(64).toString("base64"),
      },
    },
    { runtimeVersion: 1, protocolVersion: 1, topologySchemaVersion: 1 },
    {
      trustedPublicKeys: { "test-key": Buffer.from("test-spki").toString("base64") },
      verifier: {
        verify: ({ signedBytes }) => Buffer.from(signedBytes).equals(Buffer.from(canonicalReleaseManifestBytes(value))),
      },
    },
  );
  if (!result.ok) throw new Error(result.code);
  return result.manifest;
}

describe("compileRailwayHeldTemplateScaffold", () => {
  test("a new Nautilo stable runtime needs no template change or historical runtime pull", () => {
    const old = manifest();
    const next = { ...old, releaseId: "next-stable", images: old.images.map((entry) => entry.name === "nautilo-server"
      ? { ...entry, reference: image("ghcr.io/agentsea/nautilo-runtime-v2", "f") } : entry) };
    const before = compileRailwayHeldTemplateScaffold(verified(old));
    const after = compileRailwayHeldTemplateScaffold(verified(next));
    if (!before.ok || !after.ok) throw new Error("invalid fixture");
    expect(after.scaffold.services).toEqual(before.scaffold.services);
    expect(after.scaffold.services.some(({ image: source }) => source.includes("nautilo-runtime"))).toBe(false);
  });
  test("compiles the exact five-service, three-volume, two-domain held scaffold", () => {
    const result = compileRailwayHeldTemplateScaffold(verified());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.scaffold.services.map(({ name, mode }) => ({ name, mode }))).toEqual([
      { name: "app-postgres", mode: "database-normal" },
      { name: "logto-postgres", mode: "database-normal" },
      { name: "logto-seed", mode: "held-idle" },
      { name: "logto", mode: "held-listener" },
      { name: "nautilo-server", mode: "held-landing" },
    ]);
    expect(result.scaffold.services.map(({ name, image: source }) => ({ name, source }))).toEqual([
      { name: "app-postgres", source: image("pgvector/pgvector", "a") },
      { name: "logto-postgres", source: image("postgres", "b") },
      { name: "logto-seed", source: image("ghcr.io/logto-io/logto", "c") },
      { name: "logto", source: image("ghcr.io/logto-io/logto", "c") },
      { name: "nautilo-server", source: image("ghcr.io/logto-io/logto", "c") },
    ]);
    expect(result.scaffold.volumes).toHaveLength(3);
    expect(result.scaffold.domains).toEqual([
      { logicalName: "logto-public", service: "logto", targetPort: 4301 },
      { logicalName: "nautilo-public", service: "nautilo-server", targetPort: 3001 },
    ]);
    expect(result.scaffold.prohibitedOrdinaryStarts).toEqual(["logto-seed", "logto", "nautilo-server"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scaffold.services)).toBe(true);
  });

  test("uses harmless holds and a truthful Nautilo landing instead of ordinary startup", () => {
    const result = compileRailwayHeldTemplateScaffold(verified());
    if (!result.ok) throw new Error(result.code);
    expect(result.scaffold.services.find((service) => service.name === "logto-seed")?.startCommand)
      .toBe(RAILWAY_LOGTO_SEED_HOLD_COMMAND);
    expect(result.scaffold.services.find((service) => service.name === "logto")?.startCommand)
      .toBe(RAILWAY_LOGTO_HOLD_COMMAND);
    expect(result.scaffold.services.find((service) => service.name === "nautilo-server")?.startCommand)
      .toBe(RAILWAY_NAUTILO_SETUP_HOLD_COMMAND);
    expect(RAILWAY_NAUTILO_SETUP_HOLD_COMMAND).toContain("Finish setting up Nautilo with the administrator CLI.");
    expect(JSON.stringify(result.scaffold)).not.toContain("npm run cli db seed -- --swe");
    expect(JSON.stringify(result.scaffold)).not.toContain("/srv/entrypoint.sh");
  });

  test("generates every adoption credential in Railway and carries no literal secret", () => {
    const result = compileRailwayHeldTemplateScaffold(verified());
    if (!result.ok) throw new Error(result.code);
    const variables = result.scaffold.services.flatMap((service) => service.variables);
    const generated = variables.filter((variable) => variable.custody === "template-generated-secret");
    expect(generated).toHaveLength(9);
    expect(generated.every((variable) => variable.value === "${{ secret(48) }}")).toBe(true);
    const scopedGeneratedKeys = result.scaffold.services.flatMap((service) => service.variables
      .filter((variable) => variable.custody === "template-generated-secret")
      .map((variable) => `${service.name}:${variable.key}`));
    expect(new Set(scopedGeneratedKeys).size).toBe(generated.length);
    expect(variables.filter((variable) => variable.custody === "safe-literal")).toEqual([
      { key: "PGDATA", value: "/var/lib/postgresql/data/pgdata", custody: "safe-literal" },
      { key: "POSTGRES_USER", value: "postgres", custody: "safe-literal" },
      { key: "PGDATA", value: "/var/lib/postgresql/data/pgdata", custody: "safe-literal" },
      { key: "POSTGRES_USER", value: "postgres", custody: "safe-literal" },
      { key: "PORT", value: "3001", custody: "safe-literal" },
    ]);
  });

  test("pins the held Nautilo healthcheck port required by Railway", () => {
    const result = compileRailwayHeldTemplateScaffold(verified());
    if (!result.ok) throw new Error(result.code);
    const nautilo = result.scaffold.services.find((service) => service.name === "nautilo-server");
    expect(nautilo?.healthcheckPath).toBe("/health");
    expect(nautilo?.variables).toContainEqual({
      key: "PORT",
      value: "3001",
      custody: "safe-literal",
    });
  });

  test("fails closed when an allegedly verified release cannot produce the exact topology", () => {
    const invalid = structuredClone(manifest());
    (invalid.topology as { services: ReleaseManifest["topology"]["services"] }).services = invalid.topology.services.slice(0, 4);
    expect(() => verified(invalid)).toThrow();
    expect(compileRailwayHeldTemplateScaffold({} as VerifiedReleaseManifest)).toEqual({
      ok: false,
      code: "railway.template-held-scaffold.invalid-release",
    });
  });
});
