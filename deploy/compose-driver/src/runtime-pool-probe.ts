import { shellQuote } from "./remote-exec.ts";

export type RuntimePoolProbeSpec = {
  /** Human-readable label for fail-closed runtime-acceptance errors. */
  label: string;
  /** Full `sh -c` probe command routed to the profile Docker daemon. */
  cmd: string;
};

/**
 * M215 — parameterized postgres.js session probe for `nautilo_agent` through
 * the server's runtime DB_CONNECTION_STRING wiring (not direct psql alone).
 * Credentials expand inside the nautilo-server container shell.
 */
export function buildAgentRuntimePoolProbe(input: {
  composeBin: string;
  projectName: string;
}): RuntimePoolProbeSpec {
  const serverContainerFilter = shellQuote(`name=${input.projectName}-nautilo-server`);
  const serverExecPrefix =
    `${input.composeBin} exec -i ` +
    `"$(${input.composeBin} ps -q --filter ${serverContainerFilter} | head -n1)" `;
  const bunScript = [
    'import postgres from "postgres";',
    'const url = process.env.DB_AGENT_CONNECTION_STRING;',
    'if (!url) { console.error("DB_AGENT_CONNECTION_STRING is not set"); process.exit(1); }',
    'const sql = postgres(url, { max: 1, idle_timeout: 1, connect_timeout: 10 });',
    "try {",
    "  const rows = await sql`SELECT ${1}::int AS ok`;",
    "  if (Number(rows[0]?.ok) !== 1) { console.error('unexpected SELECT result'); process.exit(1); }",
    "} finally {",
    "  await sql.end({ timeout: 5 });",
    "}",
  ].join(" ");
  const probeInner = `bun -e ${shellQuote(bunScript)}`;
  return {
    label: "nautilo_agent postgres.js runtime pool probe (DB_AGENT_CONNECTION_STRING)",
    cmd: `${serverExecPrefix}sh -c ${shellQuote(probeInner)}`,
  };
}

/**
 * Wave 20 production acceptance: exercise both restricted postgres.js URLs
 * from inside nautilo-server and prove role identity without exporting either
 * credential through argv or logs.
 */
export function buildRestrictedRuntimePoolsProbe(input: {
  composeBin: string;
  projectName: string;
}): RuntimePoolProbeSpec {
  const serverContainerFilter = shellQuote(`name=${input.projectName}-nautilo-server`);
  const serverExecPrefix =
    `${input.composeBin} exec -i ` +
    `"$(${input.composeBin} ps -q --filter ${serverContainerFilter} | head -n1)" `;
  const bunScript = [
    'import postgres from "postgres";',
    'const specs = [["DB_AGENT_CONNECTION_STRING", "nautilo_agent"], ["DB_CRYPTO_CONNECTION_STRING", "nautilo_crypto"]];',
    "for (const [key, expectedRole] of specs) {",
    "  const url = process.env[key];",
    '  if (!url) { console.error(`${key} is not set`); process.exit(1); }',
    "  const sql = postgres(url, { max: 1, idle_timeout: 1, connect_timeout: 10 });",
    "  try {",
    "    const rows = await sql`SELECT current_user AS role, ${1}::int AS ok`;",
    "    if (rows[0]?.role !== expectedRole || Number(rows[0]?.ok) !== 1) { console.error(`${key} role probe failed`); process.exit(1); }",
    "  } finally {",
    "    await sql.end({ timeout: 5 });",
    "  }",
    "}",
  ].join(" ");
  const probeInner = `bun -e ${shellQuote(bunScript)}`;
  return {
    label: "restricted postgres.js runtime pool probes (nautilo_agent + nautilo_crypto)",
    cmd: `${serverExecPrefix}sh -c ${shellQuote(probeInner)}`,
  };
}
