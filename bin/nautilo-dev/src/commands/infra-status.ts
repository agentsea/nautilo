/**
 * M051: snapshot of every infrastructure dependency. Useful answer to
 * "is everything I need running?" without typing four `docker ps |
 * grep` lines. Read-only — never mutates anything.
 *
 * Reports four containers + two service-level probes:
 *   {project}-postgres              legacy DB stack (host ports from instance)
 *   {project}-postgres-1               compose postgres (logto_nautilo DB)
 *   {project}-logto-1                  Logto core + admin
 *   {project}-logto-seed-1             one-shot seeder (Exited 0 once is healthy state)
 *
 * Plus liveness probes:
 *   /oidc/.well-known/openid-configuration on the resolved Logto core port
 *   /health on the resolved Nautilo server port (only if server is running)
 */
import { spawn } from "node:child_process";
import {
  openConnectorHostPort,
  resolveInstance,
  type ResolvedInstance,
} from "@nautilo/config";
import {
  formatInfraInstanceBanner,
  openConnectorContainerName,
} from "../lib/compose-infra";

export interface ContainerRow {
  name: string;
  role: string;
}

function containerRowsForInstance(inst: ResolvedInstance): ContainerRow[] {
  const c = inst.compose.containers;
  return [
    { name: c.legacyPostgres, role: "legacy DB (DATABASE_URL target)" },
    { name: c.logtoPostgres, role: "compose postgres (logto_nautilo DB)" },
    { name: c.logtoCore, role: "Logto core + admin console" },
    { name: c.logtoSeed, role: "Logto one-shot seeder" },
    { name: openConnectorContainerName(inst), role: "OpenConnector connected-app runtime" },
  ];
}

export interface ContainerStatus {
  name: string;
  role: string;
  state: "running" | "stopped" | "exited" | "missing";
  health: string;
}

function execOut(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("close", (code) => {
      res({ ok: code === 0, out: out.trim() });
    });
  });
}

async function inspectContainer(
  name: string,
  role: string,
): Promise<ContainerStatus> {
  // `--format` returns "<state>|<health>"; missing containers exit nonzero.
  const r = await execOut("docker", [
    "inspect",
    "-f",
    "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}",
    name,
  ]);
  if (!r.ok) {
    return { name, role, state: "missing", health: "—" };
  }
  const [statusRaw = "missing", healthRaw = "n/a"] = r.out.split("|");
  let state: ContainerStatus["state"];
  if (statusRaw === "running") state = "running";
  else if (statusRaw === "exited") state = "exited";
  else state = "stopped";
  return { name, role, state, health: healthRaw };
}

async function probeUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return `${res.status}`;
  } catch {
    return "unreachable";
  }
}

export function formatRow(s: ContainerStatus): string {
  return `  ${s.name.padEnd(24)} ${describeState(s).padEnd(20)} ${s.role}`;
}

/**
 * Reduce a `(state, health)` pair to the human-readable label printed in
 * the status table. Pulled out as a pure function so the row-shape logic
 * is testable without spinning up docker.
 *
 * Rules:
 *   - running + healthy   → "OK"
 *   - running + n/a (no healthcheck declared) → "OK"
 *   - exited + seed-ish container name → "OK (seeded)" (logto-seed exits 0
 *     by design; the dependent `logto` service `service_completed_successfully`
 *     gate proves seed succeeded)
 *   - missing → "—"
 *   - everything else  → "<state>/<health>" so the operator can diagnose
 */
export function describeState(s: ContainerStatus): string {
  if (s.state === "running" && (s.health === "healthy" || s.health === "n/a")) {
    return "OK";
  }
  if (s.state === "exited" && s.name.includes("seed")) {
    return "OK (seeded)";
  }
  if (s.state === "missing") {
    return "—";
  }
  return `${s.state}/${s.health}`;
}

export async function infraStatus(): Promise<number> {
  const inst = resolveInstance();
  const rows = containerRowsForInstance(inst);
  const statuses = await Promise.all(
    rows.map((c) => inspectContainer(c.name, c.role)),
  );
  const oidc = await probeUrl(
    `http://localhost:${inst.logto.corePort}/oidc/.well-known/openid-configuration`,
  );
  const nautilo = await probeUrl(`${inst.server.url.replace(/\/$/, "")}/health`);
  const openConnectorPort = openConnectorHostPort(inst);
  const openConnector = await probeUrl(`http://127.0.0.1:${openConnectorPort}/health`);

  console.log(formatInfraInstanceBanner(inst));
  console.log("");

  console.log("Containers:");
  for (const s of statuses) {
     
    console.log(formatRow(s));
  }
   
  console.log("\nService probes:");

  console.log(
    `  Logto OIDC discovery     ${oidc.padEnd(20)} (:${inst.logto.corePort})`,
  );

  console.log(
    `  Nautilo /health          ${nautilo.padEnd(20)} (:${inst.server.port} — server only)`,
  );

  console.log(
    `  OpenConnector /health    ${openConnector.padEnd(20)} (:${openConnectorPort})`,
  );

  // Compute aggregate health for exit code: any required container missing
  // or unhealthy → exit 1 so CI scripts can assert.
  const required = statuses.filter(
    (s) => !s.name.includes("seed"), // seed exits 0 by design
  );
  const ok = required.every(
    (s) => s.state === "running" && (s.health === "healthy" || s.health === "n/a"),
  );
  return ok ? 0 : 1;
}
