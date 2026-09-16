/** Disposable-only D489 3.4 acceptance. Never resolves a Nautilo instance. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CheckpointPhysicalReclamationError,
  buildCheckpointPhysicalProbeScript,
  defaultCheckpointPhysicalExecutor,
  executeCheckpointPhysicalReclamation,
  parseCheckpointPhysicalProbe,
  type CheckpointPhysicalExecutor,
} from "../../src/lib/checkpoint-physical-reclamation";
import { buildCheckpointSemanticCompactionScript } from "../../src/lib/checkpoint-semantic-compaction";

const enabled = process.env["NAUTILO_D489_DISPOSABLE_PG"] === "1";
const container = `d489-physical-${randomUUID().slice(0, 12)}`;

function docker(args: string[], input?: string) {
  return spawnSync("docker", args, { input, encoding: "utf8", timeout: 180_000 });
}

function psql(script: string) {
  return docker(["exec", "-i", container, "psql", "-q", "-t", "-A", "-U", "postgres", "-d", "nautilo", "-v", "ON_ERROR_STOP=1"], script);
}

function physicalProbe() {
  const result = defaultCheckpointPhysicalExecutor.execute({ container, database: "nautilo", script: buildCheckpointPhysicalProbeScript() });
  if (!result.ok) throw new Error("disposable physical probe failed");
  const parsed = parseCheckpointPhysicalProbe(result.stdout);
  if (parsed === undefined) throw new Error("disposable physical probe was invalid");
  return parsed;
}

const schemaAndBloat = `
CREATE SCHEMA langchain;
CREATE TABLE langchain.checkpoints (
  thread_id text NOT NULL, checkpoint_ns text NOT NULL, checkpoint_id text NOT NULL,
  parent_checkpoint_id text, checkpoint jsonb NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
) WITH (autovacuum_enabled=false);
CREATE TABLE langchain.checkpoint_blobs (
  thread_id text NOT NULL, checkpoint_ns text NOT NULL, channel text NOT NULL,
  version text NOT NULL, type text NOT NULL, blob bytea,
  PRIMARY KEY(thread_id, checkpoint_ns, channel, version)
) WITH (autovacuum_enabled=false);
CREATE TABLE langchain.checkpoint_writes (
  thread_id text NOT NULL, checkpoint_ns text NOT NULL, checkpoint_id text NOT NULL,
  task_id text NOT NULL, idx integer NOT NULL, channel text NOT NULL, type text, blob bytea NOT NULL,
  PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
) WITH (autovacuum_enabled=false);
INSERT INTO langchain.checkpoints VALUES ('live','','002',NULL,'{"v":4,"channel_versions":{"state":"v2"}}','{}');
INSERT INTO langchain.checkpoint_blobs VALUES ('live','','state','v2','json',convert_to('"live"','UTF8'));
INSERT INTO langchain.checkpoint_writes VALUES ('live','','002','task',0,'tasks','json',convert_to('"pending"','UTF8'));
INSERT INTO langchain.checkpoint_blobs
SELECT 'bloat', '', 'dead-' || series, 'v1', 'bytes', decode(repeat('ab', 2000), 'hex')
FROM generate_series(1, 5000) AS series;
DELETE FROM langchain.checkpoint_blobs WHERE thread_id='bloat';
INSERT INTO langchain.checkpoint_writes
SELECT 'bloat', '', '001', 'dead-' || series, series, 'tasks', 'bytes', decode(repeat('cd', 1000), 'hex')
FROM generate_series(1, 3000) AS series;
DELETE FROM langchain.checkpoint_writes WHERE thread_id='bloat';
`;

const semanticState = {
  checkpointRows: 1, writeRows: 1, blobRows: 1, totalRows: 3,
  checkpointLogicalBytes: 0, writeLogicalBytes: 0, blobLogicalBytes: 0,
  totalLogicalBytes: 0, blobPayloadBytes: 0,
};

async function waitForOutput(child: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output.includes(marker)) return;
    if (child.exitCode !== null) throw new Error("disposable contention holder exited early");
    await Bun.sleep(50);
  }
  throw new Error("disposable contention holder did not acquire its lock");
}

describe.skipIf(!enabled)("D489 disposable physical reclamation", () => {
  beforeAll(() => {
    const started = docker(["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=d489-disposable", "postgres:16"]);
    if (started.status !== 0) throw new Error("disposable PostgreSQL did not start");
    let initialized = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const logs = docker(["logs", container]);
      if (`${logs.stdout}\n${logs.stderr}`.includes("PostgreSQL init process complete; ready for start up.")) { initialized = true; break; }
      Bun.sleepSync(250);
    }
    if (!initialized) throw new Error("disposable PostgreSQL did not finish initialization");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (docker(["exec", container, "psql", "-q", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"]).status === 0) break;
      Bun.sleepSync(250);
    }
    if (docker(["exec", container, "createdb", "-U", "postgres", "nautilo"]).status !== 0) throw new Error("disposable database unavailable");
    if (psql(schemaAndBloat).status !== 0) throw new Error("disposable physical fixture unavailable");
  });

  afterAll(() => { docker(["rm", "-f", container]); });

  test("semantic-only, contention, interruption/restart, success, ANALYZE, and rerun stay truthful", async () => {
    const beforeSemantic = physicalProbe();
    expect(psql(buildCheckpointSemanticCompactionScript(10)).status).toBe(0);
    const afterSemantic = physicalProbe();
    expect(afterSemantic.physical.totalBytes).toBe(beforeSemantic.physical.totalBytes);

    const holder = spawn("docker", ["exec", "-i", container, "psql", "-q", "-t", "-A", "-U", "postgres", "-d", "nautilo"], { stdio: ["pipe", "pipe", "pipe"] });
    holder.stdin.end("BEGIN; LOCK TABLE langchain.checkpoint_blobs IN ACCESS SHARE MODE; SELECT 'd489-lock-held'; SELECT pg_sleep(30); COMMIT;\n");
    await waitForOutput(holder, "d489-lock-held");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(executeCheckpointPhysicalReclamation({ container, expectedSemanticState: semanticState })).rejects.toMatchObject({ code: "contention", stage: "preflight" });
    holder.kill("SIGTERM");
    if (holder.exitCode === null) await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    expect(psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid();").status).toBe(0);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = physicalProbe();
      if (probe.blockerLocks === 0 && probe.activeClients === 0) break;
      await Bun.sleep(50);
    }

    let rewrites = 0;
    const interruptedExecutor: CheckpointPhysicalExecutor = {
      execute: (input) => {
        if (input.script.includes("VACUUM (FULL)")) {
          rewrites += 1;
          if (rewrites === 2) return { ok: false, stderr: "forced disposable interruption" };
        }
        return defaultCheckpointPhysicalExecutor.execute(input);
      },
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(executeCheckpointPhysicalReclamation({ container, expectedSemanticState: semanticState, executor: interruptedExecutor })).rejects.toEqual(new CheckpointPhysicalReclamationError("execution-failed", "checkpoints"));
    expect(rewrites).toBe(2);

    const restarted = await executeCheckpointPhysicalReclamation({ container, expectedSemanticState: semanticState });
    expect(restarted.rewritten).toEqual(["checkpoint_writes", "checkpoints", "checkpoint_blobs"]);
    expect(restarted.afterRelationBytes).toBeLessThanOrEqual(restarted.beforeRelationBytes);
    expect(restarted.reclaimedBytes).toBe(restarted.beforeRelationBytes - restarted.afterRelationBytes);
    expect(psql("SELECT count(*) FROM pg_stat_all_tables WHERE schemaname='langchain' AND relname IN ('checkpoints','checkpoint_writes','checkpoint_blobs') AND last_analyze IS NOT NULL;").stdout.trim()).toBe("3");

    const rerun = await executeCheckpointPhysicalReclamation({ container, expectedSemanticState: semanticState });
    expect(rerun.afterRelationBytes).toBeLessThanOrEqual(rerun.beforeRelationBytes);
    expect(rerun.reclaimedBytes).toBe(rerun.beforeRelationBytes - rerun.afterRelationBytes);
  }, 180_000);
});
