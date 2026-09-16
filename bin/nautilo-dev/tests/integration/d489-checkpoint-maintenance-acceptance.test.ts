/**
 * Expensive D489 4.2 acceptance. Run only through the parent runner script.
 * It never resolves a Nautilo instance and never writes canonical default state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  CHECKPOINT_RETENTION_PLAN_SQL,
  CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL,
  parseCheckpointRetentionPlan,
  parseCheckpointRetentionSchemaProbe,
  type CheckpointRetentionAggregate,
  type CheckpointRetentionPlan,
  type CheckpointRetentionPlanRow,
  type CheckpointRetentionSchemaProbeRow,
} from "../../src/lib/checkpoint-retention-plan";
import {
  CheckpointSemanticCompactionError,
  executeCheckpointSemanticCompaction,
  type CheckpointSemanticAggregate,
  type CheckpointSemanticCompactionExecutor,
  type CheckpointSemanticCompactionResult,
} from "../../src/lib/checkpoint-semantic-compaction";
import {
  CheckpointPhysicalReclamationError,
  defaultCheckpointPhysicalExecutor,
  executeCheckpointPhysicalReclamation,
  type CheckpointPhysicalExecutor,
} from "../../src/lib/checkpoint-physical-reclamation";
import { CheckpointMaintenanceGateError, gateCheckpointMaintenanceApply } from "../../src/lib/checkpoint-maintenance-gate";
import { checkpointFailureEvidence } from "../../src/commands/compact-checkpoints";
import {
  describeBackupArtifact,
  verifyCanonicalDefaultFullBackupDirectory,
  writeManifestFile,
  type VerifiedFullBackup,
} from "../../src/lib/full-dev-backup";
import { dumpPostgresDatabaseGzip, importPostgresDatabaseGzip } from "../../src/lib/postgres-archive";
import {
  createD489ResourceJournal,
  advanceD489StableReadiness,
  expectedD489ResourcePaths,
  hasD489NormalPostgresReadyLog,
  installD489WorkerCleanup,
  parseD489LoopbackMappedPort,
  recordD489OwnedProcess,
  recordD489PeakMeasurement,
  type D489ResourceJournal,
} from "./helpers/d489-disposable-resource-journal";

const enabled = process.env["NAUTILO_D489_DISPOSABLE_PG"] === "1";
const runId = process.env["NAUTILO_D489_RUN_ID"] ?? "";
const expectedPaths = runId === "" ? null : expectedD489ResourcePaths(runId);
const journalPath = expectedPaths?.journalPath ?? "";
let journal: D489ResourceJournal;
let removeWorkerCleanup: () => void = () => undefined;
let hostPort = 0;
let backup: VerifiedFullBackup;

function docker(args: readonly string[], input?: string) {
  return spawnSync("docker", [...args], { input, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
}

function psqlDb(database: string, script: string) {
  return docker(["exec", "-i", journal.resources.container, "psql", "-q", "-t", "-A", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], script);
}

function psql(script: string) { return psqlDb("nautilo", script); }

function mustPsql(database: string, script: string): string {
  const result = psqlDb(database, script);
  if (result.status !== 0) throw new Error(`Disposable PostgreSQL command failed for ${database}`);
  return result.stdout.trim();
}

function waitReady(): void {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (docker(["exec", journal.resources.container, "psql", "-q", "-t", "-A", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"]).status === 0) return;
    Bun.sleepSync(250);
  }
  throw new Error("Disposable PostgreSQL did not become queryable");
}

function refreshMappedHostPort(): void {
  const mapped = docker(["port", journal.resources.container, "5432/tcp"]);
  if (mapped.status !== 0) throw new Error("Disposable mapped port unavailable");
  hostPort = parseD489LoopbackMappedPort(mapped.stdout);
}

function waitInitialDatabaseServer(): void {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const logs = docker(["logs", journal.resources.container]);
    if (hasD489NormalPostgresReadyLog(`${logs.stdout}\n${logs.stderr}`)) {
      const ready = docker(["exec", journal.resources.container, "pg_isready", "-U", "postgres", "-d", "postgres"]);
      const first = psqlDb("postgres", "SELECT pg_postmaster_start_time()::text;");
      Bun.sleepSync(100);
      const second = psqlDb("postgres", "SELECT pg_postmaster_start_time()::text;");
      if (ready.status === 0 && first.status === 0 && second.status === 0 && first.stdout.trim() !== "" && first.stdout.trim() === second.stdout.trim()) return;
    }
    Bun.sleepSync(250);
  }
  throw new Error("Disposable PostgreSQL initialization did not complete");
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function protectedDefaultSnapshot(): string {
  const files = [
    join(homedir(), ".nautilo", "instance.json"), join(homedir(), ".nautilo", "instance.env"),
    join(homedir(), ".nautilo", ".bootstrap", "claim-invite"), join(homedir(), ".nautilo", "claim-invite.txt"),
    join(homedir(), ".nautilo", "server.pid"),
  ]
    .map((path) => ({ path, hash: existsSync(path) ? sha256(readFileSync(path)) : null }));
  const projects = docker(["ps", "-a", "--filter", "label=com.docker.compose.project=nautilo", "--format", "{{.ID}}|{{.Image}}|{{.Names}}"]);
  const volumes = docker(["volume", "ls", "--filter", "label=com.docker.compose.project=nautilo", "--format", "{{.Name}}|{{.Driver}}"]);
  const networks = docker(["network", "ls", "--filter", "label=com.docker.compose.project=nautilo", "--format", "{{.ID}}|{{.Name}}|{{.Driver}}"]);
  if ([projects, volumes, networks].some((result) => result.status !== 0)) throw new Error("Cannot snapshot protected default Docker project");
  const rows = (value: string) => value.trim().split("\n").filter(Boolean).sort();
  return sha256(JSON.stringify({ files, projects: rows(projects.stdout), volumes: rows(volumes.stdout), networks: rows(networks.stdout) }));
}

const schemaAndCorpus = `
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
CREATE SCHEMA protected_unrelated;
CREATE TABLE protected_unrelated.sentinel(id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO protected_unrelated.sentinel VALUES (1, 'nautilo-unrelated-sentinel');
WITH groups AS (
  SELECT 'thread-' || thread_no AS thread_id, CASE WHEN ns_no=1 THEN '' ELSE 'nested-' || ns_no END AS checkpoint_ns,
    thread_no >= 3 AS legacy
  FROM generate_series(1,4) AS thread_no CROSS JOIN generate_series(1,2) AS ns_no
), steps AS (SELECT * FROM groups CROSS JOIN generate_series(1,4) AS step)
INSERT INTO langchain.checkpoints(thread_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,checkpoint,metadata)
SELECT thread_id, checkpoint_ns, lpad(step::text,3,'0'),
  CASE WHEN legacy OR step=1 THEN NULL ELSE lpad((step-1)::text,3,'0') END,
  jsonb_build_object('v',CASE WHEN legacy THEN 3 ELSE 4 END,'id',lpad(step::text,3,'0'),'ts','2026-01-01T00:00:00Z',
    'channel_values','{}'::jsonb,'channel_versions',jsonb_build_object('state','v'||step,'shared','shared-v1'),'versions_seen','{}'::jsonb),
  jsonb_build_object('bounded_fixture',true)
FROM steps;
WITH groups AS (
  SELECT 'thread-' || thread_no AS thread_id, CASE WHEN ns_no=1 THEN '' ELSE 'nested-' || ns_no END AS checkpoint_ns
  FROM generate_series(1,4) AS thread_no CROSS JOIN generate_series(1,2) AS ns_no
), versions AS (SELECT * FROM groups CROSS JOIN generate_series(1,4) AS step), payloads AS (
  SELECT versions.*, (SELECT string_agg(md5(versions.thread_id||versions.checkpoint_ns||versions.step||n),'' ORDER BY n) FROM generate_series(1,2048) AS n) AS payload
  FROM versions
)
INSERT INTO langchain.checkpoint_blobs
SELECT thread_id,checkpoint_ns,'state','v'||step,'json',convert_to(to_json(payload)::text,'UTF8') FROM payloads;
WITH groups AS (
  SELECT 'thread-' || thread_no AS thread_id, CASE WHEN ns_no=1 THEN '' ELSE 'nested-' || ns_no END AS checkpoint_ns
  FROM generate_series(1,4) AS thread_no CROSS JOIN generate_series(1,2) AS ns_no
), payloads AS (
  SELECT groups.*, (SELECT string_agg(md5(groups.thread_id||groups.checkpoint_ns||n),'' ORDER BY n) FROM generate_series(1,4096) AS n) AS payload
  FROM groups
)
INSERT INTO langchain.checkpoint_blobs
SELECT thread_id,checkpoint_ns,'shared','shared-v1','json',convert_to(to_json(payload)::text,'UTF8') FROM payloads;
WITH groups AS (
  SELECT 'thread-' || thread_no AS thread_id, CASE WHEN ns_no=1 THEN '' ELSE 'nested-' || ns_no END AS checkpoint_ns
  FROM generate_series(1,4) AS thread_no CROSS JOIN generate_series(1,2) AS ns_no
), writes AS (SELECT * FROM groups CROSS JOIN generate_series(1,4) AS step), payloads AS (
  SELECT writes.*, (SELECT string_agg(md5(writes.thread_id||writes.checkpoint_ns||writes.step||n),'' ORDER BY n) FROM generate_series(1,512) AS n) AS payload
  FROM writes
)
INSERT INTO langchain.checkpoint_writes
SELECT thread_id,checkpoint_ns,lpad(step::text,3,'0'),'task-'||step,0,'tasks','json',convert_to(to_json(payload)::text,'UTF8') FROM payloads;
`;

function planner(database = "nautilo"): CheckpointRetentionPlan {
  const output = mustPsql(database, `
    BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';
    SELECT row_to_json(probe)::text FROM (${CHECKPOINT_RETENTION_SCHEMA_PROBE_SQL}) AS probe;
    SELECT row_to_json(retention)::text FROM (${CHECKPOINT_RETENTION_PLAN_SQL}) AS retention;
    ROLLBACK;
  `).split("\n").filter(Boolean);
  expect(parseCheckpointRetentionSchemaProbe(JSON.parse(output[0]!) as CheckpointRetentionSchemaProbeRow)).toEqual({ ok: true });
  const parsed = parseCheckpointRetentionPlan(JSON.parse(output[1]!) as CheckpointRetentionPlanRow);
  if (!parsed.ok) throw new Error(`Disposable retention planner rejected corpus: ${parsed.code}`);
  return parsed.plan;
}

function independentExpected(database = "nautilo"): { current: CheckpointRetentionAggregate; retained: CheckpointRetentionAggregate } {
  const value = mustPsql(database, `
    WITH latest AS MATERIALIZED (
      SELECT cp.* FROM langchain.checkpoints cp WHERE NOT EXISTS (
        SELECT 1 FROM langchain.checkpoints newer WHERE newer.thread_id=cp.thread_id AND newer.checkpoint_ns=cp.checkpoint_ns AND newer.checkpoint_id>cp.checkpoint_id)
    ), refs AS MATERIALIZED (
      SELECT latest.thread_id,latest.checkpoint_ns,ref.key AS channel,ref.value AS version
      FROM latest CROSS JOIN LATERAL jsonb_each_text(latest.checkpoint->'channel_versions') ref
    )
    SELECT json_build_object(
      'current',json_build_object(
        'checkpointRows',(SELECT count(*) FROM langchain.checkpoints),'checkpointBytes',(SELECT coalesce(sum(pg_column_size(cp)),0) FROM langchain.checkpoints cp),
        'writeRows',(SELECT count(*) FROM langchain.checkpoint_writes),'writeBytes',(SELECT coalesce(sum(pg_column_size(cw)),0) FROM langchain.checkpoint_writes cw),
        'blobRows',(SELECT count(*) FROM langchain.checkpoint_blobs),'blobBytes',(SELECT coalesce(sum(pg_column_size(cb)),0) FROM langchain.checkpoint_blobs cb),
        'payloadBytes',(SELECT coalesce(sum(octet_length(blob)),0) FROM langchain.checkpoint_blobs)),
      'retained',json_build_object(
        'checkpointRows',(SELECT count(*) FROM latest),'checkpointBytes',(SELECT coalesce(sum(pg_column_size(latest)),0) FROM latest),
        'writeRows',(SELECT count(*) FROM langchain.checkpoint_writes cw JOIN latest USING(thread_id,checkpoint_ns,checkpoint_id)),
        'writeBytes',(SELECT coalesce(sum(pg_column_size(cw)),0) FROM langchain.checkpoint_writes cw JOIN latest USING(thread_id,checkpoint_ns,checkpoint_id)),
        'blobRows',(SELECT count(*) FROM langchain.checkpoint_blobs cb JOIN refs USING(thread_id,checkpoint_ns,channel,version)),
        'blobBytes',(SELECT coalesce(sum(pg_column_size(cb)),0) FROM langchain.checkpoint_blobs cb JOIN refs USING(thread_id,checkpoint_ns,channel,version)),
        'payloadBytes',(SELECT coalesce(sum(octet_length(cb.blob)),0) FROM langchain.checkpoint_blobs cb JOIN refs USING(thread_id,checkpoint_ns,channel,version)))
    )::text;
  `);
  const raw = JSON.parse(value) as Record<"current" | "retained", Record<string, number>>;
  const convert = (row: Record<string, number>): CheckpointRetentionAggregate => ({
    checkpoints: { rows: row["checkpointRows"]!, logicalBytes: row["checkpointBytes"]!, blobPayloadBytes: 0 },
    writes: { rows: row["writeRows"]!, logicalBytes: row["writeBytes"]!, blobPayloadBytes: 0 },
    blobs: { rows: row["blobRows"]!, logicalBytes: row["blobBytes"]!, blobPayloadBytes: row["payloadBytes"]! },
    totalRows: row["checkpointRows"]! + row["writeRows"]! + row["blobRows"]!,
    totalLogicalBytes: row["checkpointBytes"]! + row["writeBytes"]! + row["blobBytes"]!,
    blobPayloadBytes: row["payloadBytes"]!,
  });
  return { current: convert(raw.current), retained: convert(raw.retained) };
}

function semanticAggregate(value: CheckpointRetentionAggregate): CheckpointSemanticAggregate {
  return {
    checkpointRows: value.checkpoints.rows, writeRows: value.writes.rows, blobRows: value.blobs.rows, totalRows: value.totalRows,
    checkpointLogicalBytes: value.checkpoints.logicalBytes, writeLogicalBytes: value.writes.logicalBytes,
    blobLogicalBytes: value.blobs.logicalBytes, totalLogicalBytes: value.totalLogicalBytes, blobPayloadBytes: value.blobPayloadBytes,
  };
}

function sentinelSnapshot(): string {
  return sha256([
    mustPsql("nautilo", "SELECT id||':'||value FROM protected_unrelated.sentinel ORDER BY id;"),
    mustPsql("logto_nautilo", "SELECT id||':'||value FROM public.sentinel ORDER BY id;"),
    mustPsql("unrelated", "SELECT id||':'||value FROM public.sentinel ORDER BY id;"),
  ].join("|"));
}

async function captureVerifiedBackup(): Promise<VerifiedFullBackup> {
  const dir = join(journal.resources.filesRoot, "checkpoint-maintenance-current");
  mkdirSync(dir, { mode: 0o700 });
  await dumpPostgresDatabaseGzip({ container: journal.resources.container, database: "nautilo", outputPath: join(dir, "nautilo.sql.gz") });
  await dumpPostgresDatabaseGzip({ container: journal.resources.container, database: "logto_nautilo", outputPath: join(dir, "logto.sql.gz") });
  writeFileSync(join(dir, "instance.env"), "D489_DISPOSABLE=1\n", { mode: 0o600 });
  const home = join(journal.resources.filesRoot, "captured-home");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "fixture.json"), "{\"disposable\":true}\n", { mode: 0o600 });
  const archived = spawnSync("tar", ["-czf", join(dir, "nautilo-home.tar.gz"), "-C", home, "."], { encoding: "utf8" });
  if (archived.status !== 0) throw new Error("Disposable home archive capture failed");
  chmodSync(join(dir, "nautilo-home.tar.gz"), 0o600);
  await writeManifestFile(dir, {
    formatVersion: 2, name: "checkpoint-maintenance-current", createdAt: new Date().toISOString(),
    sourceInstanceId: "", sourceDeploymentMode: "local-self-host",
    capture: { consistency: "quiesced", nautiloWriterStopped: false, logtoWriterStopped: false },
    artifacts: {
      nautiloDatabase: await describeBackupArtifact(dir, "nautilo.sql.gz"),
      logtoDatabase: await describeBackupArtifact(dir, "logto.sql.gz"),
      instanceEnv: await describeBackupArtifact(dir, "instance.env"),
      nautiloHome: await describeBackupArtifact(dir, "nautilo-home.tar.gz"),
    },
    drizzle: { lastAppliedIndex: -1, entries: [] }, postgres: { nautiloMajor: 16, logtoMajor: 16 },
    rowAnchors: { checkpoints: 32 }, complete: true, cloneEligible: false, backupMode: "dump",
  });
  return verifyCanonicalDefaultFullBackupDirectory(dir);
}

async function restoreNautilo(database = "nautilo"): Promise<void> {
  if (database === "nautilo") {
    mustPsql("postgres", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='nautilo' AND pid<>pg_backend_pid();");
    expect(docker(["exec", journal.resources.container, "dropdb", "-U", "postgres", "--if-exists", "nautilo"]).status).toBe(0);
  }
  expect(docker(["exec", journal.resources.container, "createdb", "-U", "postgres", database]).status).toBe(0);
  await importPostgresDatabaseGzip({ container: journal.resources.container, database, inputPath: join(backup.dir, "nautilo.sql.gz") });
}

async function verifyPinnedSaverResume(database = "nautilo"): Promise<void> {
  const saver = PostgresSaver.fromConnString(`postgresql://postgres:d489-disposable@127.0.0.1:${hostPort}/${database}`, { schema: "langchain" });
  try {
    for (let thread = 1; thread <= 4; thread += 1) for (const ns of ["", "nested-2"]) {
      const tuple = await saver.getTuple({ configurable: { thread_id: `thread-${thread}`, checkpoint_ns: ns } });
      expect(tuple?.config.configurable?.["checkpoint_id"]).toBe("004");
      expect(tuple?.checkpoint.channel_values["state"]).toBeString();
      expect(tuple?.checkpoint.channel_values["shared"]).toBeString();
      expect(tuple?.pendingWrites).toHaveLength(1);
    }
  } finally { await saver.end(); }
}

async function waitHostForwardedPostgres(database = "nautilo"): Promise<void> {
  let consecutiveSuccesses = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const saver = PostgresSaver.fromConnString(`postgresql://postgres:d489-disposable@127.0.0.1:${hostPort}/${database}`, { schema: "langchain" });
    let succeeded = false;
    try {
      const tuple = await saver.getTuple({ configurable: { thread_id: "thread-1", checkpoint_ns: "" } });
      succeeded = tuple?.config.configurable?.["checkpoint_id"] !== undefined;
    } catch { /* bounded readiness retry; no connection detail escapes */ }
    finally { try { await saver.end(); } catch { /* failed pools have nothing else to release */ } }
    const state = advanceD489StableReadiness(consecutiveSuccesses, succeeded);
    consecutiveSuccesses = state.consecutiveSuccesses;
    if (state.ready) return;
    await Bun.sleep(100);
  }
  throw new Error("Disposable host-forwarded PostgreSQL did not become stably queryable");
}

function independentPhysicalBytes(): number {
  const raw = mustPsql("nautilo", `SELECT coalesce(sum(pg_total_relation_size(format('langchain.%I', relation)::regclass)),0)
    FROM (VALUES ('checkpoints'),('checkpoint_blobs'),('checkpoint_writes')) AS owned(relation);`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Independent physical byte probe failed");
  return parsed;
}

async function waitForMarker(child: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output.includes(marker)) return;
    if (child.exitCode !== null) throw new Error("Disposable lock holder exited before acquiring lock");
    await Bun.sleep(50);
  }
  throw new Error("Disposable lock holder did not acquire lock");
}

describe.skipIf(!enabled)("D489 disposable checkpoint-maintenance acceptance", () => {
  beforeAll(async () => {
    if (expectedPaths === null) throw new Error("D489 acceptance must run through its parent runner");
    journal = createD489ResourceJournal(runId); // owner-only journal exists before Docker creation
    removeWorkerCleanup = installD489WorkerCleanup(journalPath);
    expect(docker(["network", "create", journal.resources.network]).status).toBe(0);
    expect(docker(["volume", "create", journal.resources.volume]).status).toBe(0);
    const started = docker([
      "run", "-d", "--pull=never", "--name", journal.resources.container, "--network", journal.resources.network,
      "--mount", `type=volume,source=${journal.resources.volume},target=/var/lib/postgresql/data`,
      "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=d489-disposable", journal.image.id,
    ]);
    if (started.status !== 0) throw new Error("Disposable PostgreSQL did not start from pre-existing exact image ID");
    expect(docker(["inspect", "--format", "{{.Image}}", journal.resources.container]).stdout.trim()).toBe(journal.image.id);
    waitInitialDatabaseServer();
    refreshMappedHostPort();
    for (const database of ["nautilo", "logto_nautilo", "unrelated"]) {
      if (docker(["exec", journal.resources.container, "createdb", "-U", "postgres", database]).status !== 0) throw new Error("Disposable database creation failed");
    }
    mustPsql("nautilo", schemaAndCorpus);
    mustPsql("logto_nautilo", "CREATE TABLE sentinel(id integer PRIMARY KEY,value text NOT NULL); INSERT INTO sentinel VALUES(1,'logto-sentinel');");
    mustPsql("unrelated", "CREATE TABLE sentinel(id integer PRIMARY KEY,value text NOT NULL); INSERT INTO sentinel VALUES(1,'unrelated-db-sentinel');");
    await waitHostForwardedPostgres();
    expect(recordD489PeakMeasurement(expectedPaths.journalPath)).toBeGreaterThan(0);
  }, 180_000);

  afterAll(() => { removeWorkerCleanup(); }); // outer parent runner is the sole ordinary cleanup authority

  test("proves planner, verified backup gate, semantic/physical apply, restart/resume, restore, rerun, failures, and isolation", async () => {
    const defaultBefore = protectedDefaultSnapshot();
    const sentinelsBefore = sentinelSnapshot();
    const dryRun = planner();
    const independentlyComputed = independentExpected();
    expect(dryRun.current).toEqual(independentlyComputed.current);
    expect(dryRun.retained).toEqual(independentlyComputed.retained);
    expect(dryRun.current).toMatchObject({ totalRows: 104, checkpoints: { rows: 32 }, writes: { rows: 32 }, blobs: { rows: 40 } });
    expect(dryRun.retained).toMatchObject({ totalRows: 32, checkpoints: { rows: 8 }, writes: { rows: 8 }, blobs: { rows: 16 } });
    expect(dryRun.current.blobPayloadBytes).toBeGreaterThan(3_000_000);

    let semantic: CheckpointSemanticCompactionResult | undefined;
    let logtoPaused = false;
    await gateCheckpointMaintenanceApply({
      assertConsent: () => undefined,
      captureSourceEvidence: async () => sentinelSnapshot(),
      publishVerifiedRecoveryBackup: async () => { backup = await captureVerifiedBackup(); return backup; },
      assertSourceEvidenceUnchanged: async (before) => expect(sentinelSnapshot()).toBe(before),
      quiescence: {
        findServerPid: () => null, isNautiloServer: () => true, isServerPaused: () => false,
        isLogtoRunning: () => true, pauseServer: () => undefined, resumeServer: () => undefined,
        pauseLogto: () => { logtoPaused = true; }, resumeLogto: () => { logtoPaused = false; },
        activeWriterCount: () => 0, sleep: async () => undefined, log: () => undefined,
      },
      afterWritersQuiesced: async () => {
        expect(logtoPaused).toBe(true);
        semantic = executeCheckpointSemanticCompaction({ container: journal.resources.container, expectedBefore: semanticAggregate(dryRun.current) });
      },
    });
    expect(logtoPaused).toBe(false);
    expect(recordD489PeakMeasurement(journalPath)).toBeGreaterThan(0); // includes verified dumps and real home archive
    expect(semantic?.before).toEqual(semanticAggregate(dryRun.current));
    expect(semantic?.after).toEqual(semanticAggregate(dryRun.retained));
    expect(semantic?.deleted).toEqual(semanticAggregate(dryRun.reclaimable));

    const independentlyMeasuredPhysicalBefore = independentPhysicalBytes();
    const physical = await executeCheckpointPhysicalReclamation({ container: journal.resources.container, expectedSemanticState: semantic!.after });
    const independentlyMeasuredPhysicalAfter = independentPhysicalBytes();
    expect(physical.beforeRelationBytes).toBe(independentlyMeasuredPhysicalBefore);
    expect(physical.afterRelationBytes).toBe(independentlyMeasuredPhysicalAfter);
    expect(physical.reclaimedBytes).toBe(physical.beforeRelationBytes - physical.afterRelationBytes);
    expect(physical.reclaimedBytes).toBe(independentlyMeasuredPhysicalBefore - independentlyMeasuredPhysicalAfter);
    expect(physical.reclaimedBytes).toBeGreaterThan(0);
    expect(physical.afterRelationBytes).toBeLessThan(physical.beforeRelationBytes);
    expect(docker(["restart", journal.resources.container]).status).toBe(0);
    waitReady();
    refreshMappedHostPort();
    await waitHostForwardedPostgres();
    await verifyPinnedSaverResume();
    const rerun = executeCheckpointSemanticCompaction({ container: journal.resources.container, expectedBefore: semantic!.after });
    expect(rerun.deleted.totalRows).toBe(0);

    await restoreNautilo("restored");
    expect(mustPsql("restored", "SELECT count(*) FROM langchain.checkpoints;")).toBe("32");
    expect(mustPsql("restored", "SELECT value FROM protected_unrelated.sentinel;")).toBe("nautilo-unrelated-sentinel");
    expect(planner("restored").current).toEqual(dryRun.current);
    expect(independentExpected("restored").current).toEqual(independentlyComputed.current);
    await verifyPinnedSaverResume("restored");
    await restoreNautilo();

    // A real concurrent PostgreSQL client makes the writer gate fail and recover before mutation.
    const writer = spawn("docker", ["exec", "-i", journal.resources.container, "psql", "-q", "-t", "-A", "-U", "postgres", "-d", "nautilo"], { stdio: ["pipe", "pipe", "pipe"] });
    recordD489OwnedProcess(journalPath, writer.pid!, journal.resources.container);
    writer.stdin.end("SELECT 'writer-held'; SELECT pg_sleep(60);\n");
    await waitForMarker(writer, "writer-held");
    let writerContention: unknown;
    try {
      await gateCheckpointMaintenanceApply({
        assertConsent: () => undefined, captureSourceEvidence: async () => sentinelSnapshot(),
        publishVerifiedRecoveryBackup: async () => backup,
        assertSourceEvidenceUnchanged: async (before) => expect(sentinelSnapshot()).toBe(before),
        quiescence: {
          findServerPid: () => null, isNautiloServer: () => true, isServerPaused: () => false, isLogtoRunning: () => true,
          pauseServer: () => undefined, resumeServer: () => undefined, pauseLogto: () => undefined, resumeLogto: () => undefined,
          activeWriterCount: () => Number(mustPsql("nautilo", "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state IS DISTINCT FROM 'idle';")),
          sleep: async () => { await Bun.sleep(1); }, log: () => undefined,
        },
        afterWritersQuiesced: async () => { throw new Error("writer contention incorrectly admitted mutation"); },
      });
    } catch (error) { writerContention = error; }
    expect(writerContention).toMatchObject({ code: "writer-quiescence", writerBoundary: "mutation" });
    expect(checkpointFailureEvidence(writerContention)).toMatchObject({
      failure: { code: "writer-quiescence-failed" }, retryState: "safe-to-retry", writersRestored: true,
    });
    writer.kill("SIGTERM");
    if (writer.exitCode === null) await new Promise<void>((resolve) => writer.once("exit", () => resolve()));

    // Fail-closed format/reference matrix on real planner/executor SQL.
    mustPsql("nautilo", "UPDATE langchain.checkpoints SET checkpoint=jsonb_set(checkpoint,'{v}','5') WHERE thread_id='thread-1' AND checkpoint_id='004';");
    expect(() => planner()).toThrow("invalid-retained-checkpoint-format");
    await restoreNautilo();
    mustPsql("nautilo", "UPDATE langchain.checkpoints SET checkpoint=jsonb_set(checkpoint,'{v}','3'),parent_checkpoint_id='003' WHERE thread_id='thread-1' AND checkpoint_id='004';");
    expect(() => planner()).toThrow("unsupported-retained-legacy-parent-format");
    await restoreNautilo();
    mustPsql("nautilo", "UPDATE langchain.checkpoints SET checkpoint=jsonb_set(checkpoint,'{channel_versions,state}','\"missing-v\"') WHERE thread_id='thread-1' AND checkpoint_id='004';");
    const missingRef = () => executeCheckpointSemanticCompaction({ container: journal.resources.container });
    expect(missingRef).toThrow(CheckpointSemanticCompactionError);
    expect(JSON.stringify(checkpointFailureEvidence(captureError(missingRef)))).not.toContain("missing-v");
    await restoreNautilo();

    const stale = () => executeCheckpointSemanticCompaction({ container: journal.resources.container, expectedBefore: {
      checkpointRows: 0,writeRows: 0,blobRows: 0,totalRows: 0,checkpointLogicalBytes: 0,writeLogicalBytes: 0,blobLogicalBytes: 0,totalLogicalBytes: 0,blobPayloadBytes: 0,
    } });
    expect(stale).toThrow(CheckpointSemanticCompactionError);
    expect(checkpointFailureEvidence(captureError(stale)).retryState).toBe("manual-recovery-required");

    const beforeRollback = independentExpected().current;
    const rollbackExecutor: CheckpointSemanticCompactionExecutor = { execute: ({ script }) => {
      const forced = script.replace("DO $verify$", "DO $forced$ BEGIN RAISE EXCEPTION 'private-payload-marker'; END $forced$;\nDO $verify$");
      const result = psql(forced);
      return result.status === 0 ? { ok: true, stdout: result.stdout } : { ok: false, stderr: "private-payload-marker" };
    } };
    const rollback = () => executeCheckpointSemanticCompaction({ container: journal.resources.container, executor: rollbackExecutor });
    expect(rollback).toThrow(CheckpointSemanticCompactionError);
    expect(independentExpected().current).toEqual(beforeRollback);
    expect(JSON.stringify(checkpointFailureEvidence(captureError(rollback)))).not.toContain("private-payload-marker");

    const ambiguousExecutor: CheckpointSemanticCompactionExecutor = { execute: ({ script }) => {
      expect(psql(script).status).toBe(0);
      return { ok: false, stderr: "private-commit-transport-marker" };
    } };
    const ambiguous = () => executeCheckpointSemanticCompaction({ container: journal.resources.container, executor: ambiguousExecutor });
    expect(ambiguous).toThrow(CheckpointSemanticCompactionError);
    expect(checkpointFailureEvidence(captureError(ambiguous))).toMatchObject({ failure: { code: "operation-interrupted" }, retryState: "manual-recovery-required" });
    await restoreNautilo();
    const compacted = executeCheckpointSemanticCompaction({ container: journal.resources.container });

    const holder = spawn("docker", ["exec", "-i", journal.resources.container, "psql", "-q", "-t", "-A", "-U", "postgres", "-d", "nautilo"], { stdio: ["pipe", "pipe", "pipe"] });
    recordD489OwnedProcess(journalPath, holder.pid!, journal.resources.container);
    holder.stdin.end("BEGIN; LOCK TABLE langchain.checkpoint_blobs IN ACCESS SHARE MODE; SELECT 'lock-held'; SELECT pg_sleep(60); COMMIT;\n");
    await waitForMarker(holder, "lock-held");
    let contention: unknown;
    try { await executeCheckpointPhysicalReclamation({ container: journal.resources.container, expectedSemanticState: compacted.after }); }
    catch (error) { contention = error; }
    expect(contention).toBeInstanceOf(CheckpointPhysicalReclamationError);
    expect(contention).toMatchObject({ code: "contention", stage: "preflight" });
    expect(checkpointFailureEvidence(contention)).toMatchObject({ failure: { code: "physical-reclamation-failed" } });
    holder.kill("SIGTERM");
    if (holder.exitCode === null) await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    mustPsql("nautilo", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();");

    let rewrites = 0;
    const partialExecutor: CheckpointPhysicalExecutor = { execute: (input) => {
      if (input.script.includes("VACUUM (FULL)")) { rewrites += 1; if (rewrites === 2) return { ok: false, stderr: "private-partial-marker" }; }
      return defaultCheckpointPhysicalExecutor.execute(input);
    } };
    let partial: unknown;
    try { await executeCheckpointPhysicalReclamation({ container: journal.resources.container, expectedSemanticState: compacted.after, executor: partialExecutor }); }
    catch (error) { partial = error; }
    expect(checkpointFailureEvidence(partial)).toMatchObject({ failure: { code: "operation-interrupted" } });
    expect(docker(["restart", journal.resources.container]).status).toBe(0);
    waitReady();
    refreshMappedHostPort();
    await waitHostForwardedPostgres();

    let probes = 0;
    const afterProbeExecutor: CheckpointPhysicalExecutor = { execute: (input) => {
      if (input.script.includes("'blockerLocks'")) { probes += 1; if (probes === 2) return { ok: false, stderr: "private-after-probe-marker" }; }
      return defaultCheckpointPhysicalExecutor.execute(input);
    } };
    let afterProbe: unknown;
    try { await executeCheckpointPhysicalReclamation({ container: journal.resources.container, expectedSemanticState: compacted.after, executor: afterProbeExecutor }); }
    catch (error) { afterProbe = error; }
    expect(afterProbe).toMatchObject({ code: "execution-failed", stage: "verification" });
    expect(JSON.stringify(checkpointFailureEvidence(afterProbe))).not.toContain("private-after-probe-marker");

    const corruptDir = join(journal.resources.filesRoot, "corrupt", "checkpoint-maintenance-current");
    mkdirSync(join(journal.resources.filesRoot, "corrupt"), { mode: 0o700 });
    cpSync(backup.dir, corruptDir, { recursive: true });
    chmodSync(corruptDir, 0o700);
    writeFileSync(join(corruptDir, "nautilo.sql.gz"), "corrupt", { flag: "a", mode: 0o600 });
    let corruptBackupFailure: unknown;
    try { await verifyCanonicalDefaultFullBackupDirectory(corruptDir); } catch (error) { corruptBackupFailure = error; }
    expect(corruptBackupFailure).toBeInstanceOf(Error);
    expect((corruptBackupFailure as Error).message).toMatch(/(size|hash) mismatch/);
    expect(checkpointFailureEvidence(new CheckpointMaintenanceGateError("backup", corruptBackupFailure)))
      .toMatchObject({ failure: { code: "backup-verification-failed" }, retryState: "safe-to-retry" });
    const corruptRestore = join(journal.resources.filesRoot, "corrupt-restore.sql.gz");
    writeFileSync(corruptRestore, "not-a-gzip", { mode: 0o600 });
    expect(docker(["exec", journal.resources.container, "createdb", "-U", "postgres", "restore_failure"]).status).toBe(0);
    let restoreFailure: unknown;
    try { await importPostgresDatabaseGzip({ container: journal.resources.container, database: "restore_failure", inputPath: corruptRestore }); }
    catch (error) { restoreFailure = error; }
    expect(restoreFailure).toBeInstanceOf(Error);
    expect(checkpointFailureEvidence(new CheckpointMaintenanceGateError("backup", restoreFailure)))
      .toMatchObject({ failure: { code: "backup-verification-failed" }, retryState: "safe-to-retry" });

    expect(recordD489PeakMeasurement(journalPath)).toBeGreaterThan(0); // includes corrupt backup/restore artifacts

    expect(sentinelSnapshot()).toBe(sentinelsBefore);
    expect(protectedDefaultSnapshot()).toBe(defaultBefore);
  }, 300_000);
});

function captureError(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected disposable failure was not raised");
}
