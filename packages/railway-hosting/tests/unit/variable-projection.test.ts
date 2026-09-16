import { describe, expect, test } from "bun:test";

import {
  projectRailwayRuntimeVariables,
  type RailwayVariableProjectionInputs,
} from "../../src/variable-projection";
import { buildRailwayTopology, type RailwayTopology } from "../../src/topology";
import {
  verifyReleaseManifest,
  HOSTING_PROVIDER_ENV_VARS,
  type VerifiedReleaseManifest,
} from "@nautilo/hosting";

const DIGESTS = {
  "app-postgres": "registry.nautilo.test/app-postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "logto-postgres": "registry.nautilo.test/logto-postgres@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  logto: "registry.nautilo.test/logto@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "nautilo-server": "registry.nautilo.test/nautilo-server@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "nautilo-bootstrap": "registry.nautilo.test/nautilo-bootstrap@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
} as const;

function verifiedManifest(): VerifiedReleaseManifest {
  const result = verifyReleaseManifest(
    {
      manifest: {
        schemaVersion: 1,
        releaseId: "2026.08.04-v1",
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
      },
      signature: { algorithm: "ed25519", keyId: "test-key", value: Buffer.alloc(64).toString("base64") },
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

function topology(): RailwayTopology {
  const result = buildRailwayTopology(verifiedManifest());
  if (!result.ok) throw new Error(result.code);
  return result.topology;
}

function inputs(overrides: Partial<RailwayVariableProjectionInputs> = {}): RailwayVariableProjectionInputs {
  return {
    generatedSecrets: new Map([
      ["app-postgres-superuser-password", "never-return-app-postgres-admin"],
      ["app-nautilo-db-password", "never-return-app-db"],
      ["app-nautilo-agent-db-password", "never-return-app-agent-db"],
      ["app-nautilo-crypto-db-password", "never-return-app-crypto-db"],
      ["logto-postgres-superuser-password", "never-return-logto-postgres-admin"],
      ["logto-db-password", "never-return-logto-db"],
      ["logto-bootstrap-handoff-token", "never-return-handoff-token"],
      ["nautilo-bootstrap-token", "never-return-bootstrap-token"],
      ["nautilo-logto-email-webhook-secret", "never-return-email-webhook"],
    ]),
    generatedPublicDomains: new Map([
      ["logto-public", "https://logto.generated.railway.app"],
      ["nautilo-public", "https://nautilo.generated.railway.app"],
    ]),
    bootstrapOutputs: new Map([
      ["logto-workbench-app-id", "workbench-id"],
      ["logto-tui-app-id", "tui-id"],
      ["logto-tui-loopback-app-id", "tui-loopback-id"],
      ["logto-desktop-app-id", "desktop-id"],
      ["logto-mobile-app-id", "mobile-id"],
      ["logto-mobile-web-app-id", "mobile-web-id"],
      ["logto-m2m-app-id", "m2m-id"],
      ["logto-m2m-app-secret", "never-return-m2m-secret"],
      ["logto-resource", "https://nautilo.generated.railway.app/api"],
    ]),
    externalProviderSecrets: new Map([
      ["openrouter:openrouter-api-key", "never-return-openrouter-provider-key"],
      ["tavily:tavily-api-key", "never-return-tavily-provider-key"],
      ["elevenlabs:elevenlabs-api-key", "never-return-elevenlabs-provider-key"],
      ["cloudconvert:cloudconvert-api-key", "never-return-cloudconvert-provider-key"],
      ["venice:venice-api-key", "never-return-venice-provider-key"],
    ]),
    ...overrides,
  };
}

describe("projectRailwayRuntimeVariables", () => {
  test("projects all registered keys only into the Nautilo service, including Browser Use", () => {
    const entries = Object.entries(HOSTING_PROVIDER_ENV_VARS);
    const result = projectRailwayRuntimeVariables(topology(), inputs({
      externalProviderSecrets: new Map(entries.map(([provider]) => [`${provider}:${provider}-api-key`, `synthetic-${provider}-credential`])),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [provider, envVar] of entries) {
      expect(result.projection.finalServices["nautilo-server"][envVar]).toBe(`synthetic-${provider}-credential`);
      for (const [service, variables] of Object.entries(result.projection.finalServices)) {
        if (service !== "nautilo-server") expect(variables[envVar]).toBeUndefined();
      }
    }
    const omitted = projectRailwayRuntimeVariables(topology(), inputs({ externalProviderSecrets: new Map() }));
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    for (const [, envVar] of entries) expect(omitted.projection.finalServices["nautilo-server"][envVar]).toBeUndefined();
  });
  test("renders Railway-documented mixed text/reference composites without exposing them through a receipt surface", () => {
    const result = projectRailwayRuntimeVariables(topology(), inputs());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.blockers[0]?.code);
    expect(result.projection.finalServices.logto["DB_URL"]).toBe(
      "postgres://logto:never-return-logto-db@${{logto-postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/logto_nautilo",
    );
    expect(result.projection.finalServices.logto["ADMIN_ENDPOINT"]).toBe(
      "http://logto.railway.internal:4302",
    );
    expect(result.projection.finalServices.logto["HOSTNAME"]).toBe("::");
    expect(result.projection.finalServices["nautilo-server"]["LOGTO_ENDPOINT_INTERNAL"]).toBe(
      "http://${{logto.RAILWAY_PRIVATE_DOMAIN}}:4301",
    );
    expect(result.projection.finalServices["nautilo-server"]["LOGTO_ISSUER"]).toBe(
      "https://${{logto.RAILWAY_PUBLIC_DOMAIN}}/oidc",
    );
    expect(result.projection.transientBootstrap["APP_POSTGRES_ADMIN_URL"]).toBe(
      "postgres://postgres:never-return-app-postgres-admin@${{app-postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/postgres",
    );
    expect(result.projection.transientLogtoBootstrap).toMatchObject({
      NAUTILO_BOOTSTRAP_MODE: "logto",
      NAUTILO_BOOTSTRAP_HANDOFF_TOKEN: "never-return-handoff-token",
      LOGTO_ENDPOINT_INTERNAL: "http://${{logto.RAILWAY_PRIVATE_DOMAIN}}:4301",
      LOGTO_RESOURCE: "https://${{nautilo-server.RAILWAY_PUBLIC_DOMAIN}}/api",
      NAUTILO_WORKBENCH_REDIRECT_URI: "https://${{nautilo-server.RAILWAY_PUBLIC_DOMAIN}}/auth/callback",
      PORT: "8080",
    });
  });

  test("projects only individually-qualified values into exact service maps and renders the documented service-reference grammar", () => {
    const source = topology();
    const withDirectReference = {
      ...source,
      finalServices: source.finalServices.map((service) => service.name === "logto"
        ? {
            ...service,
            variables: [
              ...service.variables,
              {
                key: "APP_POSTGRES_PRIVATE_DOMAIN",
                value: {
                  kind: "railway-service-private-reference" as const,
                  service: "app-postgres" as const,
                  variable: "RAILWAY_PRIVATE_DOMAIN" as const,
                },
              },
            ],
          }
        : service),
    };
    const result = projectRailwayRuntimeVariables(withDirectReference, inputs());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.blockers[0]?.code);
    expect(result.projection.finalServices["app-postgres"]).toEqual({
      PGDATA: "/var/lib/postgresql/data/pgdata",
      POSTGRES_PASSWORD: "never-return-app-postgres-admin",
      POSTGRES_USER: "postgres",
    });
    expect(result.projection.finalServices.logto["APP_POSTGRES_PRIVATE_DOMAIN"]).toBe("${{app-postgres.RAILWAY_PRIVATE_DOMAIN}}");
    expect(result.projection.finalServices["nautilo-server"]["OPENROUTER_API_KEY"]).toBe("never-return-openrouter-provider-key");
    expect(result.projection.finalServices["nautilo-server"]["CLOUDCONVERT_API_KEY"]).toBe("never-return-cloudconvert-provider-key");
    expect(result.projection.finalServices["nautilo-server"]["VENICE_API_KEY"]).toBe("never-return-venice-provider-key");
    expect(result.projection.finalServices["nautilo-server"]["DB_CRYPTO_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_crypto:never-return-app-crypto-db@${{app-postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/nautilo",
    );
    expect(result.projection.finalServices["nautilo-server"]["APP_NAUTILO_CRYPTO_DB_PASSWORD"]).toBeUndefined();
    expect(result.projection.transientBootstrap["APP_NAUTILO_CRYPTO_DB_PASSWORD"]).toBe("never-return-app-crypto-db");
  });

  test("omits absent provider enhancements without blocking deployment", () => {
    const missing = projectRailwayRuntimeVariables(topology(), inputs({ externalProviderSecrets: new Map() }));
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error(missing.blockers[0]?.code);
    expect(missing.projection.finalServices["nautilo-server"]["OPENROUTER_API_KEY"]).toBeUndefined();
    expect(missing.projection.finalServices["nautilo-server"]["TAVILY_API_KEY"]).toBeUndefined();
    expect(missing.projection.finalServices["nautilo-server"]["ELEVENLABS_API_KEY"]).toBeUndefined();
    expect(missing.projection.finalServices["nautilo-server"]["CLOUDCONVERT_API_KEY"]).toBeUndefined();
    expect(missing.projection.finalServices["nautilo-server"]["VENICE_API_KEY"]).toBeUndefined();
  });

  test("returns metadata-free typed blockers for duplicate keys without serializing injected provider values", () => {
    const source = topology();
    const duplicate = {
      ...source,
      finalServices: source.finalServices.map((service) => service.name === "app-postgres"
        ? { ...service, variables: [...service.variables, service.variables[0]!] }
        : service),
    };
    const result = projectRailwayRuntimeVariables(duplicate, inputs());
    expect(result).toEqual({
      ok: false,
      blockers: [{ code: "railway.variable-projection.duplicate-variable-key" }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("never-return-tavily-provider-key");
    expect(serialized).not.toContain("never-return-app-db");
  });

  test("fails closed with stable blockers for unknown runtime descriptors and services", () => {
    const source = topology();
    const unknownSlot = {
      ...source,
      finalServices: source.finalServices.map((service) => service.name === "app-postgres"
        ? {
            ...service,
            variables: [{
              key: "POSTGRES_PASSWORD",
              value: {
                kind: "generated-secret-slot" as const,
                slot: "unknown-slot" as never,
                purpose: "test only",
              },
            }],
          }
        : service),
    };
    const result = projectRailwayRuntimeVariables(unknownSlot, inputs());
    expect(result).toEqual({
      ok: false,
      blockers: [{ code: "railway.variable-projection.unknown-generated-secret-slot" }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("never-return-openrouter-provider-key");
    expect(serialized).not.toContain("never-return-app-postgres-admin");

    const unknownService = {
      ...source,
      finalServices: [{ ...source.finalServices[0]!, name: "unknown-service" as never }, ...source.finalServices.slice(1)],
    };
    expect(projectRailwayRuntimeVariables(unknownService, inputs())).toEqual({
      ok: false,
      blockers: [{ code: "railway.variable-projection.unknown-service" }],
    });
  });
});
