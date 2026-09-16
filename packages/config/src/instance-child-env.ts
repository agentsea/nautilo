import {
  DEFAULT_PORTS,
  DERIVED_INSTANCE_HOST_PORT_BASES,
} from "./instance-defaults";
import type { ResolvedInstance } from "./resolve-instance";

/** nwuno (D362 `office` profile) host port base; internal container port is 2003. */
const OFFICE_PORT_BASE = DERIVED_INSTANCE_HOST_PORT_BASES.office;

/**
 * D362 — nwuno host port, derived from the instance's stride offset rather than
 * joining the 7-port `instance.json` bundle (opt-in dev service; avoids a schema
 * migration). Offset mirrors the bundle stride, so it stays per-instance-unique.
 */
export function officeHostPort(inst: ResolvedInstance): number {
  return OFFICE_PORT_BASE + (inst.server.port - DEFAULT_PORTS.server);
}

/** collabora (D362 `office` profile) host port base; internal container port is 9980. */
const COLLABORA_PORT_BASE = DERIVED_INSTANCE_HOST_PORT_BASES.collabora;

/**
 * D362 — Collabora Online (coolwsd) host port. Same stride-offset derivation as
 * `officeHostPort` (kept distinct from the nwuno base + the server/logto/db
 * ports in DEFAULT_PORTS so multi-stack dev doesn't collide).
 */
export function collaboraHostPort(inst: ResolvedInstance): number {
  return COLLABORA_PORT_BASE + (inst.server.port - DEFAULT_PORTS.server);
}

/** Per-instance host port for the Compose-managed OpenConnector runtime. */
export function openConnectorHostPort(inst: ResolvedInstance): number {
  return DERIVED_INSTANCE_HOST_PORT_BASES.openConnector
    + (inst.server.port - DEFAULT_PORTS.server);
}

function roleDirectLocalhostUrl(
  role: string,
  password: string,
  postgresHostPort: number,
): string {
  const url = new URL(`postgres://${role}@localhost:${postgresHostPort}/nautilo`);
  url.password = password;
  return url.toString();
}

/**
 * Key/value pairs to merge into a child process `env` so it sees the same
 * ports, URLs, compose project, and hostnames as `resolveInstance()` for the
 * current `NAUTILO_INSTANCE_ID` (after any CLI `--instance` override).
 */
export function resolvedInstanceChildEnv(
  inst: ResolvedInstance,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const nautiloPassword = env["NAUTILO_DB_PASSWORD"] ?? "nautilo";
  const agentPassword = env["NAUTILO_AGENT_DB_PASSWORD"] ?? "nautilo_agent";
  const agentDirect = new URL(inst.db.directConnection);
  agentDirect.username = "nautilo_agent";
  agentDirect.password = agentPassword;

  return {
    NAUTILO_OFFICE_PORT: String(officeHostPort(inst)),
    NAUTILO_COLLABORA_PORT: String(collaboraHostPort(inst)),
    NAUTILO_OPENCONNECTOR_PORT: String(openConnectorHostPort(inst)),
    NAUTILO_OPENCONNECTOR_BASE_URL:
      env["NAUTILO_OPENCONNECTOR_BASE_URL"]?.trim()
      || `http://127.0.0.1:${openConnectorHostPort(inst)}`,
    NAUTILO_INSTANCE_ID: inst.instanceId,
    COMPOSE_PROJECT_NAME: inst.compose.projectName,
    NAUTILO_PORT: String(inst.server.port),
    NAUTILO_WORKBENCH_PORT: String(inst.workbench.port),
    NAUTILO_DB_PORT: String(inst.db.postgresHostPort),
    NAUTILO_LOGTO_DB_PORT: String(inst.logto.dbPort),
    NAUTILO_LOGTO_PORT: String(inst.logto.corePort),
    NAUTILO_LOGTO_ADMIN_PORT: String(inst.logto.adminPort),
    LOGTO_DB_PORT: String(inst.logto.dbPort),
    LOGTO_ENDPOINT: `http://localhost:${inst.logto.corePort}`,
    LOGTO_ADMIN_ENDPOINT: `http://localhost:${inst.logto.adminPort}`,
    NAUTILO_SERVER_URL: inst.server.url,
    NAUTILO_HOST: inst.server.host,
    DB_DIRECT_CONNECTION: inst.db.directConnection,
    DB_CONNECTION_STRING: roleDirectLocalhostUrl(
      "nautilo",
      nautiloPassword,
      inst.db.postgresHostPort,
    ),
    DB_AGENT_CONNECTION_STRING: roleDirectLocalhostUrl(
      "nautilo_agent",
      agentPassword,
      inst.db.postgresHostPort,
    ),
    DB_AGENT_DIRECT_CONNECTION: agentDirect.toString(),
    NAUTILO_FEDERATED_HOSTNAME: inst.hostname.federated,
    NAUTILO_MDNS_HOSTNAME: inst.hostname.mdns,
    NAUTILO_TLS_SAN: inst.hostname.tlsSan,
    NAUTILO_CADDY_AUTH_HOST: inst.hostname.caddyAuthHost,
    NAUTILO_CADDY_AUTH_ADMIN_HOST: inst.hostname.caddyAuthAdminHost,
  };
}
