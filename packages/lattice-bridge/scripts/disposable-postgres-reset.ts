import { spawnSync } from "node:child_process";

export const DISPOSABLE_RESET_CONTAINER_ENV =
  "LATTICE_BRIDGE_TEST_RESET_CONTAINER" as const;
export const DISPOSABLE_RESET_TOKEN_ENV =
  "LATTICE_BRIDGE_TEST_RESET_TOKEN" as const;
export const DISPOSABLE_RESET_PORT_ENV =
  "LATTICE_BRIDGE_TEST_RESET_PORT" as const;
export const DISPOSABLE_RESET_LABEL =
  "com.nautilo.lattice-bridge.reset-token" as const;
export const DISPOSABLE_TEMPLATE_DATABASE =
  "nautilo_lattice_bridge_template" as const;

export type DisposableResetUrls = Readonly<{
  admin: string;
  app: string;
  agent: string;
  crypto: string;
}>;

const EXPECTED_DATABASE_ROLES = Object.freeze({
  admin: "postgres",
  app: "nautilo",
  agent: "nautilo_agent",
  crypto: "nautilo_crypto",
});

export function readDisposableResetAuthority(
  urls: DisposableResetUrls,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<{ container: string; token: string; port: string }> {
  const container = env[DISPOSABLE_RESET_CONTAINER_ENV];
  const token = env[DISPOSABLE_RESET_TOKEN_ENV];
  const port = env[DISPOSABLE_RESET_PORT_ENV];
  if (!container?.startsWith("nautilo-lattice-bridge-test-")) {
    throw new Error("Disposable Postgres reset container authority is missing");
  }
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    throw new Error("Disposable Postgres reset token authority is missing");
  }
  if (!port || !/^[0-9]+$/.test(port)) {
    throw new Error("Disposable Postgres reset port authority is missing");
  }
  for (const [name, value] of Object.entries(urls)) {
    const url = new URL(value);
    const expectedRole = EXPECTED_DATABASE_ROLES[
      name as keyof typeof EXPECTED_DATABASE_ROLES
    ];
    if (
      url.protocol !== "postgres:"
      || url.hostname !== "127.0.0.1"
      || url.port !== port
      || url.pathname !== "/nautilo"
      || url.username !== expectedRole
    ) {
      throw new Error(`${name} database URL is outside disposable reset authority`);
    }
  }
  return { container, token, port };
}

function dockerOutput(args: readonly string[], input?: string): string {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    input,
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args[0] ?? "command"} failed with exit ${String(result.status)}`,
    );
  }
  return result.stdout.trim();
}

export function resetDisposablePostgresDatabase(
  urls: DisposableResetUrls,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const authority = readDisposableResetAuthority(urls, env);
  const label = dockerOutput([
    "inspect",
    "--format",
    `{{ index .Config.Labels "${DISPOSABLE_RESET_LABEL}" }}`,
    authority.container,
  ]);
  if (label !== authority.token) {
    throw new Error("Disposable Postgres reset label does not match authority");
  }
  const running = dockerOutput([
    "inspect",
    "--format",
    "{{.State.Running}}",
    authority.container,
  ]);
  if (running !== "true") {
    throw new Error("Disposable Postgres reset container is not running");
  }
  const mapping = dockerOutput([
    "port",
    authority.container,
    "5432/tcp",
  ]);
  if (!mapping.endsWith(`:${authority.port}`)) {
    throw new Error("Disposable Postgres reset port does not match authority");
  }

  dockerOutput([
    "exec",
    "-i",
    authority.container,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "postgres",
  ], `
DROP DATABASE nautilo WITH (FORCE);
CREATE DATABASE nautilo
  WITH TEMPLATE ${DISPOSABLE_TEMPLATE_DATABASE} OWNER nautilo;
REVOKE ALL ON DATABASE nautilo
  FROM PUBLIC, logto, nautilo_agent, nautilo_crypto;
GRANT ALL ON DATABASE nautilo TO nautilo;
GRANT CONNECT ON DATABASE nautilo TO nautilo_agent, nautilo_crypto;
`);
}
