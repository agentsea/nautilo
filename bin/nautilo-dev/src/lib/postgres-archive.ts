import { createWriteStream, existsSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";

interface ProcessResult {
  code: number;
  stderr: string;
}

interface DockerMount {
  readonly Type?: unknown;
  readonly Source?: unknown;
  readonly Destination?: unknown;
}

export const POSTGRES_DUMP_SHELL =
  'pg_dump -U "$1" -f "$3" "$2"; gzip -n "$3"';

const EVENT_TRIGGER_OWNER_STATEMENT = /^ALTER EVENT TRIGGER .+ OWNER TO .+;$/;

export function isNonPortableEventTriggerOwnerStatement(line: string): boolean {
  return EVENT_TRIGGER_OWNER_STATEMENT.test(line.trim());
}

/**
 * Preserve ordinary table/function ownership (Logto relies on it), but omit
 * event-trigger owner changes. PostgreSQL reserves those ALTER statements for
 * superusers, while a target's compatibility `postgres` role is not guaranteed
 * to be superuser. The trigger itself is already present in the dump.
 *
 * Keep decompression, filtering, and psql in one OS pipeline. Bun's Node-stream
 * Transform bridge can truncate a large SQL statement when the psql child
 * applies backpressure, producing a misleading `syntax error at end of input`
 * late in an otherwise-valid restore. Positional parameters keep paths and
 * identifiers out of the shell program itself, and pipefail preserves an error
 * from any stage.
 */
export const POSTGRES_RESTORE_SHELL = String.raw`set -o pipefail
gzip -dc -- "$1" \
  | sed '/^ALTER EVENT TRIGGER .* OWNER TO .*;$/d' \
  | docker exec -i "$2" psql -U "$3" -v ON_ERROR_STOP=1 "$4"`;

/** Docker Desktop reports host binds under /host_mnt; map them back to macOS. */
export function dockerBindSourceOnHost(source: string): string {
  return source.startsWith("/host_mnt/") ? source.slice("/host_mnt".length) : source;
}

export function missingDockerBindSources(
  mounts: readonly DockerMount[],
  pathExists: (path: string) => boolean = existsSync,
): Array<{ source: string; destination: string }> {
  const missing: Array<{ source: string; destination: string }> = [];
  for (const mount of mounts) {
    if (mount.Type !== "bind" || typeof mount.Source !== "string") continue;
    const source = dockerBindSourceOnHost(mount.Source);
    if (pathExists(source)) continue;
    missing.push({
      source,
      destination: typeof mount.Destination === "string" ? mount.Destination : "<unknown>",
    });
  }
  return missing;
}

/** Refuse backup capture before writer pause when a container has stale binds. */
export function assertDockerBindSourcesAvailable(container: string): void {
  const inspect = spawnSync(
    "docker",
    ["inspect", container, "--format", "{{json .Mounts}}"],
    { encoding: "utf8" },
  );
  if (inspect.error) throw inspect.error;
  if (inspect.status !== 0) {
    throw new Error(`Cannot inspect Docker mounts for ${container}`);
  }
  let mounts: DockerMount[];
  try {
    const parsed = JSON.parse(inspect.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("mount list is not an array");
    mounts = parsed as DockerMount[];
  } catch {
    throw new Error(`Cannot parse Docker mounts for ${container}`);
  }
  const missing = missingDockerBindSources(mounts);
  if (missing.length === 0) return;
  const detail = missing
    .map((mount) => `${mount.source} -> ${mount.destination}`)
    .join(", ");
  throw new Error(
    `Docker container ${container} has missing host bind source(s): ${detail}. ` +
      "Recreate this exact instance's containers from the current checkout with " +
      "bun run infra:start --instance <instance>; named volumes are preserved.",
  );
}

function collectProcess(
  child: ChildProcess,
  label: string,
): Promise<ProcessResult> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr: stderr.trim() || `${label} failed` });
    });
  });
}

export async function dumpPostgresDatabaseGzip(input: {
  container: string;
  database: string;
  user?: string;
  outputPath: string;
}): Promise<void> {
  const user = input.user ?? "postgres";
  if (
    !/^[a-z_][a-z0-9_]*$/i.test(user) ||
    !/^[a-z_][a-z0-9_]*$/i.test(input.database)
  ) {
    throw new Error("PostgreSQL backup user and database must be identifiers");
  }
  const remotePath =
    `/tmp/nautilo-dev-${process.pid}-${Date.now()}-${input.database}.sql`;
  const dump = spawn(
    "docker",
    [
      "exec",
      input.container,
      "sh",
      "-ceu",
      POSTGRES_DUMP_SHELL,
      "nautilo-dev",
      user,
      input.database,
      remotePath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    const dumpResult = await collectProcess(dump, "pg_dump");
    if (dumpResult.code !== 0) {
      throw new Error(dumpResult.stderr);
    }
    // `docker cp` can fail before copying when any unrelated file bind on the
    // container points at a deleted worktree. Stream the already-compressed
    // dump through `docker exec cat` instead; this uses the same bounded temp
    // file but does not ask Docker to archive the container filesystem.
    const copy = spawn(
      "docker",
      ["exec", input.container, "cat", `${remotePath}.gz`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = createWriteStream(input.outputPath, { mode: 0o600 });
    const [copyResult] = await Promise.all([
      collectProcess(copy, "docker exec cat"),
      pipeline(copy.stdout, output),
    ]);
    if (copyResult.code !== 0) {
      throw new Error(copyResult.stderr);
    }
    await chmod(input.outputPath, 0o600);
  } catch (error) {
    await rm(input.outputPath, { force: true });
    throw error;
  } finally {
    spawnSync(
      "docker",
      ["exec", input.container, "rm", "-f", remotePath, `${remotePath}.gz`],
      { stdio: "ignore" },
    );
  }
}

export async function importPostgresDatabaseGzip(input: {
  container: string;
  database: string;
  user?: string;
  inputPath: string;
}): Promise<void> {
  const user = input.user ?? "postgres";
  const restore = spawn(
    "bash",
    [
      "-c",
      POSTGRES_RESTORE_SHELL,
      "nautilo-postgres-restore",
      input.inputPath,
      input.container,
      user,
      input.database,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  restore.stdout.resume();
  const result = await collectProcess(restore, "PostgreSQL restore pipeline");
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
}

export function queryPostgresContainer(input: {
  container: string;
  database: string;
  sql: string;
  user?: string;
}): string {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      input.container,
      "psql",
      "-U",
      input.user ?? "postgres",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
      input.database,
    ],
    {
      input: input.sql,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "psql failed").trim(),
    );
  }
  return result.stdout.trim();
}

export function postgresMajorVersion(container: string): number {
  const raw = queryPostgresContainer({
    container,
    database: "postgres",
    sql: "SHOW server_version_num;",
  });
  const version = Number.parseInt(raw, 10);
  if (!Number.isInteger(version) || version < 10_000) {
    throw new Error(`Cannot parse PostgreSQL version from ${container}`);
  }
  return Math.floor(version / 10_000);
}

export function countTableRows(
  container: string,
  database: string,
  table: string,
): number {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`Unsafe table name: ${table}`);
  }
  const exists = queryPostgresContainer({
    container,
    database,
    sql: `SELECT to_regclass('public.${table}') IS NOT NULL;`,
  });
  if (exists !== "t") return 0;
  const count = Number.parseInt(
    queryPostgresContainer({
      container,
      database,
      sql: `SELECT count(*) FROM public.${table};`,
    }),
    10,
  );
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Cannot parse row count for ${database}.${table}`);
  }
  return count;
}
