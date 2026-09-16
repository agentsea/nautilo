import { describe, expect, test } from "bun:test";

import {
  buildRailwayTopology,
  RAILWAY_LOGTO_ADMIN_PORT,
  RAILWAY_LOGTO_BOOTSTRAP_PORT,
  RAILWAY_LOGTO_PORT,
  RAILWAY_NAUTILO_PORT,
  RAILWAY_POSTGRES_PORT,
} from "../../src/index";
import {
  verifyReleaseManifest,
  type ReleaseManifest,
  type VerifiedReleaseManifest,
} from "@nautilo/hosting";

const DIGESTS = {
  "app-postgres": "registry.nautilo.test/app-postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "logto-postgres": "registry.nautilo.test/logto-postgres@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  logto: "registry.nautilo.test/logto@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "nautilo-server": "registry.nautilo.test/nautilo-server@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "nautilo-bootstrap": "registry.nautilo.test/nautilo-bootstrap@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
} as const;

function releaseManifest(): unknown {
  return {
    schemaVersion: 1,
    releaseId: "2026.08.03-v1",
    images: Object.entries(DIGESTS).map(([name, reference]) => ({ name, reference })),
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

function verifiedManifest(): VerifiedReleaseManifest {
  const result = verifyReleaseManifest(
    {
      manifest: releaseManifest(),
      signature: {
        algorithm: "ed25519",
        keyId: "test-key",
        value: Buffer.alloc(64).toString("base64"),
      },
    },
    { runtimeVersion: 1, protocolVersion: 1, topologySchemaVersion: 1 },
    {
      trustedPublicKeys: { "test-key": Buffer.from("test-spki").toString("base64") },
      verifier: { verify: () => true },
    },
  );
  if (!result.ok) throw new Error(`fixture manifest unexpectedly rejected: ${result.code}`);
  return result.manifest;
}

function topology() {
  const result = buildRailwayTopology(verifiedManifest());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.topology;
}

function service(name: string) {
  const found = topology().finalServices.find((candidate) => candidate.name === name);
  expect(found).toBeDefined();
  if (!found) throw new Error(`service ${name} absent`);
  return found;
}

describe("Railway V1 certified topology", () => {
  test("has exactly five final services, three mounts, two final domains, and two sequential transient bootstrap phases", () => {
    const graph = topology();
    expect(graph.finalServices.map((entry) => entry.name)).toEqual([
      "app-postgres",
      "logto-postgres",
      "logto-seed",
      "logto",
      "nautilo-server",
    ]);
    expect(graph.mounts).toEqual([
      { logicalName: "app-postgres-data", service: "app-postgres", mountPath: "/var/lib/postgresql/data" },
      { logicalName: "logto-postgres-data", service: "logto-postgres", mountPath: "/var/lib/postgresql/data" },
      { logicalName: "nautilo-data", service: "nautilo-server", mountPath: "/var/lib/nautilo" },
    ]);
    expect(graph.generatedPublicDomains).toEqual([
      { logicalName: "logto-public", service: "logto", targetPort: RAILWAY_LOGTO_PORT },
      { logicalName: "nautilo-public", service: "nautilo-server", targetPort: RAILWAY_NAUTILO_PORT },
    ]);
    expect(graph.transientBootstrap.serviceName).toBe("nautilo-bootstrap");
    expect(graph.transientLogtoBootstrap.serviceName).toBe("nautilo-bootstrap");
    expect(graph.finalServices.map((entry) => entry.name)).not.toContain("nautilo-bootstrap");
    expect(graph.transientBootstrap.lifecycle).toEqual([
      "create",
      "run-idempotent-reconciler",
      "checkpoint-success",
      "delete",
      "verify-absent",
    ]);
    expect(graph.transientLogtoBootstrap.lifecycle).toEqual(graph.transientBootstrap.lifecycle);
    expect(graph.transientBootstrap.inputs).toContainEqual({
      key: "NAUTILO_BOOTSTRAP_MODE",
      value: { kind: "safe-literal", value: "database" },
    });
    expect(graph.transientLogtoBootstrap.inputs).toContainEqual({
      key: "NAUTILO_BOOTSTRAP_MODE",
      value: { kind: "safe-literal", value: "logto" },
    });
    expect(graph.transientLogtoBootstrap.inputs).toContainEqual({
      key: "PORT",
      value: { kind: "safe-literal", value: `${RAILWAY_LOGTO_BOOTSTRAP_PORT}` },
    });
    expect(graph.finalServices.find((entry) => entry.name === "logto")?.variables).toContainEqual({
      key: "PORT",
      value: { kind: "safe-literal", value: `${RAILWAY_LOGTO_PORT}` },
    });
    expect(graph.finalServices.find((entry) => entry.name === "nautilo-server")?.variables).toContainEqual({
      key: "NAUTILO_PORT",
      value: { kind: "safe-literal", value: `${RAILWAY_NAUTILO_PORT}` },
    });
    expect(graph.finalServices.find((service) => service.name === "logto")?.variables).toContainEqual({
      key: "ADMIN_ENDPOINT",
      value: { kind: "safe-literal", value: "http://logto.railway.internal:4302" },
    });
    expect(graph.finalServices.find((service) => service.name === "logto")?.variables).toContainEqual({
      key: "HOSTNAME",
      value: { kind: "safe-literal", value: "::" },
    });
    expect(graph.finalServices.find((service) => service.name === "nautilo-server")?.variables)
      .toContainEqual({
        key: "NAUTILO_DOTENV_PATH",
        value: { kind: "safe-literal", value: "/var/lib/nautilo/config/instance.env" },
      });
  });

  test("excludes office resources and any undeclared service", () => {
    const graph = topology();
    const serialized = JSON.stringify(graph).toLowerCase();
    expect(serialized).not.toContain("collabora");
    expect(serialized).not.toContain("office");
    expect(graph.finalServices).toHaveLength(5);
    expect(graph.mounts).toHaveLength(3);
    expect(graph.generatedPublicDomains).toHaveLength(2);
  });

  test("maps every image from the signed manifest and intentionally reuses Logto's digest", () => {
    const graph = topology();
    expect(Object.fromEntries(graph.finalServices.map((entry) => [entry.name, entry.image]))).toEqual({
      "app-postgres": DIGESTS["app-postgres"],
      "logto-postgres": DIGESTS["logto-postgres"],
      "logto-seed": DIGESTS.logto,
      logto: DIGESTS.logto,
      "nautilo-server": DIGESTS["nautilo-server"],
    });
    expect(graph.transientBootstrap.image).toBe(DIGESTS["nautilo-bootstrap"]);
    expect(graph.transientLogtoBootstrap.image).toBe(DIGESTS["nautilo-bootstrap"]);
    for (const image of [...graph.finalServices.map((entry) => entry.image), graph.transientBootstrap.image, graph.transientLogtoBootstrap.image]) {
      expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
    }
  });

  test("uses structured Railway private-domain references and makes every port private", () => {
    const graph = topology();
    const json = JSON.stringify(graph);
    expect(json).toContain('"kind":"railway-service-private-reference"');
    expect(json).toContain('"variable":"RAILWAY_PRIVATE_DOMAIN"');
    expect(json).not.toContain("${{");
    expect(graph.finalServices.flatMap((entry) => entry.privatePorts)).toEqual([
      { port: RAILWAY_POSTGRES_PORT, visibility: "private" },
      { port: RAILWAY_POSTGRES_PORT, visibility: "private" },
      { port: RAILWAY_LOGTO_PORT, visibility: "private" },
      { port: RAILWAY_LOGTO_ADMIN_PORT, visibility: "private" },
      { port: RAILWAY_NAUTILO_PORT, visibility: "private" },
    ]);
  });

  test("sets a healthcheck only on Nautilo server", () => {
    const graph = topology();
    expect(service("nautilo-server").healthcheck).toEqual({ path: "/health" });
    for (const candidate of graph.finalServices.filter((entry) => entry.name !== "nautilo-server")) {
      expect(candidate.healthcheck).toBeUndefined();
    }
  });

  test("projects every supported external provider into the Nautilo runtime", () => {
    const variables = service("nautilo-server").variables;
    for (const binding of [
      { key: "CLOUDCONVERT_API_KEY", value: { kind: "external-provider-secret-slot", provider: "cloudconvert", slot: "cloudconvert-api-key" } },
      { key: "ELEVENLABS_API_KEY", value: { kind: "external-provider-secret-slot", provider: "elevenlabs", slot: "elevenlabs-api-key" } },
      { key: "OPENROUTER_API_KEY", value: { kind: "external-provider-secret-slot", provider: "openrouter", slot: "openrouter-api-key" } },
      { key: "TAVILY_API_KEY", value: { kind: "external-provider-secret-slot", provider: "tavily", slot: "tavily-api-key" } },
      { key: "VENICE_API_KEY", value: { kind: "external-provider-secret-slot", provider: "venice", slot: "venice-api-key" } },
    ] as const) expect(variables).toContainEqual(binding);
  });

  test("uses Logto's documented one-shot seed command only for the seed service", () => {
    expect(service("logto-seed").startCommand).toBe("npm run cli db seed -- --swe");
    expect(service("logto").startCommand).toBeUndefined();
  });

  test("keeps Postgres data below Railway's non-empty volume mount root", () => {
    for (const name of ["app-postgres", "logto-postgres"]) {
      expect(service(name).variables).toContainEqual({
        key: "PGDATA",
        value: { kind: "safe-literal", value: "/var/lib/postgresql/data/pgdata" },
      });
    }
  });

  test("keeps role passwords off every final service except its real runtime consumer", () => {
    const graph = topology();
    const appPostgres = service("app-postgres");
    const logtoPostgres = service("logto-postgres");
    const logtoSeed = service("logto-seed");
    const logto = service("logto");
    const server = service("nautilo-server");
    const roleSlots = [
      "app-nautilo-db-password",
      "app-nautilo-agent-db-password",
      "app-nautilo-crypto-db-password",
      "logto-db-password",
    ];
    expect(appPostgres.variables.map((variable) => variable.key)).toEqual(["PGDATA", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
    expect(logtoPostgres.variables.map((variable) => variable.key)).toEqual(["PGDATA", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
    expect(JSON.stringify(appPostgres.variables)).not.toContain("app-nautilo-db-password");
    expect(JSON.stringify(logtoPostgres.variables)).not.toContain("logto-db-password");
    expect(JSON.stringify(logto.variables)).toContain("logto-db-password");
    expect(JSON.stringify(logtoSeed.variables)).toContain("logto-db-password");
    expect(JSON.stringify(server.variables)).toContain("app-nautilo-db-password");
    expect(JSON.stringify(server.variables)).toContain("app-nautilo-agent-db-password");
    expect(JSON.stringify(server.variables)).toContain("app-nautilo-crypto-db-password");
    expect(server.variables).toContainEqual({
      key: "DB_CRYPTO_CONNECTION_STRING",
      value: {
        kind: "railway-template-composite",
        parts: [
          { kind: "safe-literal", value: "postgres://nautilo_crypto:" },
          {
            kind: "generated-secret-slot",
            slot: "app-nautilo-crypto-db-password",
            purpose: "restricted runtime crypto database role",
          },
          { kind: "safe-literal", value: "@" },
          {
            kind: "railway-service-private-reference",
            service: "app-postgres",
            variable: "RAILWAY_PRIVATE_DOMAIN",
          },
          { kind: "safe-literal", value: ":5432/nautilo" },
        ],
      },
    });
    for (const candidate of graph.finalServices) {
      const serialized = JSON.stringify(candidate.variables);
      if (candidate.name !== "nautilo-server") {
        expect(serialized).not.toContain("app-nautilo-db-password");
        expect(serialized).not.toContain("app-nautilo-agent-db-password");
      }
      if (candidate.name !== "logto" && candidate.name !== "logto-seed") {
        expect(serialized).not.toContain("logto-db-password");
      }
      if (candidate.name !== "nautilo-server") {
        expect(serialized).not.toContain("app-nautilo-crypto-db-password");
      }
    }
    const bootstrap = JSON.stringify(graph.transientBootstrap.inputs);
    expect(bootstrap).toContain("app-postgres-superuser-password");
    expect(bootstrap).toContain("logto-postgres-superuser-password");
    for (const slot of roleSlots) expect(bootstrap).toContain(slot);
    const logtoBootstrap = JSON.stringify(graph.transientLogtoBootstrap.inputs);
    expect(logtoBootstrap).toContain("logto-db-password");
    expect(logtoBootstrap).toContain("logto-bootstrap-handoff-token");
    expect(logtoBootstrap).not.toContain("app-nautilo-db-password");
  });

  test("limits database admin slots to the database services and transient bootstrap", () => {
    const graph = topology();
    const databaseAdminSlots = ["app-postgres-superuser-password", "logto-postgres-superuser-password"];
    for (const candidate of graph.finalServices) {
      const serialized = JSON.stringify(candidate.variables);
      if (candidate.name === "app-postgres" || candidate.name === "logto-postgres") continue;
      for (const slot of databaseAdminSlots) expect(serialized).not.toContain(slot);
    }
    const bootstrap = JSON.stringify(graph.transientBootstrap.inputs);
    for (const slot of databaseAdminSlots) expect(bootstrap).toContain(slot);
  });

  test("is deterministic and has no raw secret-shaped value", () => {
    const first = JSON.stringify(topology());
    const second = JSON.stringify(topology());
    expect(first).toBe(second);
    expect(first).not.toMatch(/sk-(?:or|ant|proj)-/i);
    expect(first).not.toMatch(/tvly-/i);
    expect(first).not.toMatch(/postgres(?:ql)?:\/\/[^"}]+:[^"}]+@/i);
    expect(first).toContain('"kind":"generated-secret-slot"');
    expect(first).toContain('"kind":"external-provider-secret-slot"');
  });

  test("surfaces deployment blockers separately from readiness", () => {
    expect(topology().qualifications).toEqual([]);
    expect(topology().qualifications.every((qualification) => qualification.disposition === "blocking")).toBe(true);
  });

  test("fails closed when a caller presents incomplete or malformed allegedly verified input", () => {
    const incomplete = verifiedManifest() as unknown as { images: unknown[] };
    incomplete.images = incomplete.images.slice(0, 4);
    expect(buildRailwayTopology(incomplete as unknown as VerifiedReleaseManifest)).toEqual({
      ok: false,
      code: "railway.topology.invalid-verified-manifest",
    });

    const wrongTopology = verifiedManifest() as unknown as { topology: { schemaVersion: number } };
    wrongTopology.topology.schemaVersion = 2;
    expect(buildRailwayTopology(wrongTopology as unknown as VerifiedReleaseManifest)).toEqual({
      ok: false,
      code: "railway.topology.invalid-verified-manifest",
    });
  });

  test("requires an upstream verifier brand at compile time", () => {
    const ordinaryManifest = releaseManifest() as ReleaseManifest;
    // @ts-expect-error ordinary manifests cannot satisfy the driver's branded input type.
    const _unverifiedCannotBuild: Parameters<typeof buildRailwayTopology>[0] = ordinaryManifest;
    expect(buildRailwayTopology(verifiedManifest()).ok).toBe(true);
  });
});
