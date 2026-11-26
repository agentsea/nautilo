import postgres from "postgres";

// ---------------------------------------------------------------------------
// In-process PostgreSQL wire probes.
//
// The probes authenticate as each runtime role over the host-published
// postgres port with the selected instance's credentials, exactly what the
// server's own pools do. They run through the `postgres` driver instead of
// a host `sh -c "psql ..."` so acceptance needs neither a POSIX shell nor a
// PostgreSQL client on the host (Windows has neither by default).
// ---------------------------------------------------------------------------

/**
 * Bounds the TCP connect + startup/auth handshake of one probe (seconds). The
 * postgres driver's own default; a refused port fails at once, so this only
 * bounds a port that never answers.
 */
const AUTHORITATIVE_PG_CONNECT_TIMEOUT_S = 30;

/**
 * Bounds closing one probe's connection (seconds). The driver otherwise waits
 * until the server closes the socket, so a server that stops answering after
 * the probe's verdict would hold up the readiness check. The verdict is
 * already final when the connection is closed.
 */
const AUTHORITATIVE_PG_END_TIMEOUT_S = 5;

export type AuthoritativePasswordEnv =
  | "NAUTILO_DB_PASSWORD"
  | "NAUTILO_AGENT_DB_PASSWORD"
  | "NAUTILO_CRYPTO_DB_PASSWORD";

export interface LocalPostgresProbeSpec {
  role: string;
  passwordEnv: AuthoritativePasswordEnv;
  host: string;
  port: number;
  database: string;
  /**
   * `select-1`: plain authenticated round trip. `parameterized`: a named
   * prepared statement with a bound wire parameter (extended protocol), the
   * shape the runtime pools use for every query.
   */
  query: "select-1" | "parameterized";
}

export interface LocalPostgresProbeClient {
  query(text: string, params: readonly number[]): Promise<ReadonlyArray<Record<string, unknown>>>;
  close(): Promise<void>;
}

export type LocalPostgresProbeConnect = (options: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}) => LocalPostgresProbeClient;

const LOCAL_PROBE_QUERIES: Record<
  LocalPostgresProbeSpec["query"],
  { text: string; params: readonly number[] }
> = {
  "select-1": { text: "SELECT 1 AS ok", params: [] },
  parameterized: { text: "SELECT $1::int AS ok", params: [1] },
};

export function buildLocalPostgresProbeSpecs(port: number): {
  appRoles: LocalPostgresProbeSpec[];
  direct: LocalPostgresProbeSpec;
} {
  const base = { host: "127.0.0.1", port, database: "nautilo" } as const;
  return {
    appRoles: (
      [
        ["nautilo", "NAUTILO_DB_PASSWORD"],
        ["nautilo_agent", "NAUTILO_AGENT_DB_PASSWORD"],
        ["nautilo_crypto", "NAUTILO_CRYPTO_DB_PASSWORD"],
      ] as const
    ).map(([role, passwordEnv]) => ({
      ...base,
      role,
      passwordEnv,
      query: "select-1" as const,
    })),
    direct: {
      ...base,
      role: "nautilo_agent",
      passwordEnv: "NAUTILO_AGENT_DB_PASSWORD",
      query: "parameterized",
    },
  };
}

/**
 * The driver-backed probe connection. `endTimeoutSeconds` bounds its close;
 * tests shorten it.
 */
export const localPostgresProbeConnect = (
  endTimeoutSeconds: number = AUTHORITATIVE_PG_END_TIMEOUT_S,
): LocalPostgresProbeConnect => (options) => {
  const sql = postgres({
    ...options,
    max: 1,
    connect_timeout: AUTHORITATIVE_PG_CONNECT_TIMEOUT_S,
    prepare: true,
    onnotice: () => {},
    connection: { application_name: "nautilo-dev.runtime-acceptance" },
  });
  return {
    query: async (text, params) =>
      [...(await sql.unsafe(text, [...params], { prepare: true }))] as Array<Record<string, unknown>>,
    close: () => sql.end({ timeout: endTimeoutSeconds }),
  };
};

const defaultLocalPostgresProbeConnect = localPostgresProbeConnect();

/**
 * Run one wire probe and report it in the gate's exec-result shape. Nonzero
 * means failed; stderr carries the driver's error with the password removed.
 */
export async function runLocalPostgresProbe(
  spec: LocalPostgresProbeSpec,
  env: NodeJS.ProcessEnv,
  connect: LocalPostgresProbeConnect = defaultLocalPostgresProbeConnect,
): Promise<{ code: number; stderr: string }> {
  const password = env[spec.passwordEnv];
  if (password === undefined || password === "") {
    return { code: 1, stderr: `${spec.passwordEnv} is not set` };
  }
  const { text, params } = LOCAL_PROBE_QUERIES[spec.query];
  let client: LocalPostgresProbeClient | undefined;
  try {
    client = connect({
      host: spec.host,
      port: spec.port,
      user: spec.role,
      password,
      database: spec.database,
    });
    const rows = await client.query(text, params);
    const ok = rows[0]?.["ok"];
    if (rows.length !== 1 || Number(ok) !== 1) {
      return { code: 1, stderr: `unexpected probe result from ${spec.host}:${spec.port}` };
    }
    return { code: 0, stderr: "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 1, stderr: message.split(password).join("<redacted>") };
  } finally {
    await client?.close().catch(() => {});
  }
}
