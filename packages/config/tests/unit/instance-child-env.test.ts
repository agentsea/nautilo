import { describe, expect, test } from "bun:test";
import { deriveComposeContainerBundle } from "../../src/compose-container-names";
import {
  defaultDirectDbConnection,
  DERIVED_INSTANCE_HOST_PORT_BASES,
} from "../../src/instance-defaults";
import {
  collaboraHostPort,
  officeHostPort,
  openConnectorHostPort,
  resolvedInstanceChildEnv,
} from "../../src/instance-child-env";
import type { ResolvedInstance } from "../../src/resolve-instance";

function minimalInstance(postgresHostPort: number): ResolvedInstance {
  const directConnection = defaultDirectDbConnection(postgresHostPort);
  return {
    schemaVersion: 1,
    instanceId: "",
    server: { host: "127.0.0.1", port: 3001, url: "http://localhost:3001" },
    workbench: { port: 3000, url: "http://localhost:3000" },
    db: {
      directConnection,
      postgresHostPort,
    },
    logto: { dbPort: 5432, corePort: 3301, adminPort: 3302 },
    compose: {
      projectName: "nautilo",
      containers: deriveComposeContainerBundle("nautilo"),
    },
    hostname: {
      federated: "nautilo.local",
      mdns: "nautilo.local",
      tlsSan: "",
      caddyAuthHost: "auth.nautilo.local",
      caddyAuthAdminHost: "auth-admin.nautilo.local",
    },
    deploymentMode: "local-self-host",
  };
}

describe("resolvedInstanceChildEnv", () => {
  test("sets four direct localhost role URLs with default passwords", () => {
    const inst = minimalInstance(5434);
    const child = resolvedInstanceChildEnv(inst, {});

    expect(child["DB_DIRECT_CONNECTION"]).toBe(
      "postgresql://postgres:postgres@localhost:5434/nautilo",
    );
    expect(child["DB_CONNECTION_STRING"]).toBe(
      "postgres://nautilo:nautilo@localhost:5434/nautilo",
    );
    expect(child["DB_AGENT_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_agent:nautilo_agent@localhost:5434/nautilo",
    );
    expect(child["DB_AGENT_DIRECT_CONNECTION"]).toBe(
      "postgresql://nautilo_agent:nautilo_agent@localhost:5434/nautilo",
    );
  });

  test("uses supplied role passwords from env", () => {
    const inst = minimalInstance(5500);
    const child = resolvedInstanceChildEnv(inst, {
      NAUTILO_DB_PASSWORD: "full-secret",
      NAUTILO_AGENT_DB_PASSWORD: "agent-secret",
    });

    expect(child["DB_CONNECTION_STRING"]).toBe(
      "postgres://nautilo:full-secret@localhost:5500/nautilo",
    );
    expect(child["DB_AGENT_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_agent:agent-secret@localhost:5500/nautilo",
    );
    expect(child["DB_AGENT_DIRECT_CONNECTION"]).toBe(
      "postgresql://nautilo_agent:agent-secret@localhost:5500/nautilo",
    );
  });

  test("derives office profile ports from the shared generated topology", () => {
    const inst = minimalInstance(5434);
    inst.server.port = 3101;

    expect(officeHostPort(inst)).toBe(DERIVED_INSTANCE_HOST_PORT_BASES.office + 100);
    expect(collaboraHostPort(inst)).toBe(DERIVED_INSTANCE_HOST_PORT_BASES.collabora + 100);
    expect(openConnectorHostPort(inst)).toBe(
      DERIVED_INSTANCE_HOST_PORT_BASES.openConnector + 100,
    );
    expect(resolvedInstanceChildEnv(inst, {})["NAUTILO_OPENCONNECTOR_BASE_URL"]).toBe(
      "http://127.0.0.1:3110",
    );
  });

  test("preserves an explicit remote OpenConnector endpoint for cloud routing", () => {
    const inst = minimalInstance(5434);
    expect(resolvedInstanceChildEnv(inst, {
      NAUTILO_OPENCONNECTOR_BASE_URL: "https://connect.nautilo.ai",
    })["NAUTILO_OPENCONNECTOR_BASE_URL"]).toBe("https://connect.nautilo.ai");
  });
});
