/** Disposable PostgreSQL proof. Never resolves or opens a Nautilo instance. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  buildCheckpointSemanticCompactionScript,
  parseCheckpointSemanticCompactionOutput,
} from "../../src/lib/checkpoint-semantic-compaction";

const enabled = process.env["NAUTILO_D489_DISPOSABLE_PG"] === "1";
const container = `d489-pg-${randomUUID().slice(0, 12)}`;
let hostPort = 0;

function docker(args: string[], input?: string) {
  return spawnSync("docker", args, { input, encoding: "utf8", timeout: 120_000 });
}

function psql(script: string) {
  return docker(["exec", "-i", container, "psql", "-q", "-t", "-A", "-U", "postgres", "-d", "nautilo", "-v", "ON_ERROR_STOP=1"], script);
}

const schema = `
CREATE SCHEMA langchain;
CREATE TABLE langchain.checkpoints (
  thread_id text NOT NULL, checkpoint_ns text NOT NULL, checkpoint_id text NOT NULL,
  parent_checkpoint_id text, checkpoint jsonb NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
);
CREATE TABLE langchain.checkpoint_blobs (
  thread_id text NOT NULL, checkpoint_ns text NOT NULL, channel text NOT NULL,
  version text NOT NULL, type text NOT NULL, blob bytea,
  PRIMARY KEY(thread_id, checkpoint_ns, channel, version)
);
CREATE TABLE langchain.checkpoint_writes (
  thread_id text NOT NULL, checkpoint_ns text NOT NULL, checkpoint_id text NOT NULL,
  task_id text NOT NULL, idx integer NOT NULL, channel text NOT NULL, type text, blob bytea NOT NULL,
  PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);
`;

const fixture = `
INSERT INTO langchain.checkpoints VALUES
  ('current', '', '001', NULL, '{"v":4,"channel_versions":{"state":"v1"}}', '{}'),
  ('current', '', '002', '001', '{"v":4,"channel_versions":{"state":"v2","shared":"s1"}}', '{}'),
  ('legacy', 'nested', '010', NULL, '{"v":3,"channel_versions":{"legacy":"l1"}}', '{}'),
  ('legacy', 'nested', '011', NULL, '{"v":3,"channel_versions":{"legacy":"l2","shared":"s2"}}', '{}');
INSERT INTO langchain.checkpoint_writes VALUES
  ('current', '', '001', 'old-task', 0, 'tasks', 'json', convert_to('"old"','UTF8')),
  ('current', '', '002', 'live-task', 0, 'tasks', 'json', convert_to('"current-pending"','UTF8')),
  ('legacy', 'nested', '010', 'old-legacy', 0, 'tasks', 'json', convert_to('"old-legacy"','UTF8')),
  ('legacy', 'nested', '011', 'live-legacy', 0, 'tasks', 'json', convert_to('"legacy-pending"','UTF8'));
INSERT INTO langchain.checkpoint_blobs VALUES
  ('current', '', 'state', 'v1', 'json', convert_to('"old-state"','UTF8')),
  ('current', '', 'state', 'v2', 'json', convert_to('"current-state"','UTF8')),
  ('current', '', 'shared', 's1', 'json', convert_to('"current-shared"','UTF8')),
  ('legacy', 'nested', 'legacy', 'l1', 'json', convert_to('"old-legacy"','UTF8')),
  ('legacy', 'nested', 'legacy', 'l2', 'json', convert_to('"legacy-state"','UTF8')),
  ('legacy', 'nested', 'shared', 's2', 'json', convert_to('"legacy-shared"','UTF8'));
`;

describe.skipIf(!enabled)("D489 disposable semantic compaction", () => {
  beforeAll(() => {
    docker(["rm", "-f", container]);
    const started = docker(["run", "-d", "--name", container, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=d489-disposable", "postgres:16"]);
    if (started.status !== 0) throw new Error("disposable PostgreSQL did not start");
    let initComplete = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const logs = docker(["logs", container]);
      if (`${logs.stdout}\n${logs.stderr}`.includes("PostgreSQL init process complete; ready for start up.")) {
        initComplete = true;
        break;
      }
      Bun.sleepSync(250);
    }
    if (!initComplete) throw new Error("disposable PostgreSQL initialization did not complete");
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (docker(["exec", container, "psql", "-q", "-t", "-A", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"]).status === 0) {
        ready = true;
        break;
      }
      Bun.sleepSync(250);
    }
    if (!ready) throw new Error("disposable PostgreSQL did not become queryable");
    const created = docker(["exec", container, "createdb", "-U", "postgres", "nautilo"]);
    if (created.status !== 0) throw new Error("disposable database unavailable");
    const port = docker(["port", container, "5432/tcp"]).stdout.trim().match(/:(\d+)$/)?.[1];
    hostPort = Number(port);
    if (!Number.isSafeInteger(hostPort) || hostPort < 1) throw new Error("disposable database port unavailable");
    const loaded = psql(schema + fixture);
    if (loaded.status !== 0) throw new Error("disposable fixture unavailable");
  });

  afterAll(() => { docker(["rm", "-f", container]); });

  test("retains current and supported legacy latest state, references, and matching writes; rerun is idempotent", async () => {
    const first = psql(buildCheckpointSemanticCompactionScript(1));
    expect(first.status).toBe(0);
    const evidence = parseCheckpointSemanticCompactionOutput(first.stdout);
    expect(evidence).toMatchObject({
      groups: 2,
      before: { checkpointRows: 4, writeRows: 4, blobRows: 6 },
      after: { checkpointRows: 2, writeRows: 2, blobRows: 4 },
      deleted: { checkpointRows: 2, writeRows: 2, blobRows: 2 },
    });
    const saverShape = psql(`
      SELECT count(*) FROM langchain.checkpoints;
      SELECT count(*) FROM langchain.checkpoint_writes AS cw JOIN langchain.checkpoints AS cp USING(thread_id, checkpoint_ns, checkpoint_id);
      SELECT count(*) FROM langchain.checkpoints AS cp CROSS JOIN LATERAL jsonb_each_text(cp.checkpoint->'channel_versions') AS ref(channel,version)
        JOIN langchain.checkpoint_blobs AS cb ON cb.thread_id=cp.thread_id AND cb.checkpoint_ns=cp.checkpoint_ns AND cb.channel=ref.channel AND cb.version=ref.version;
      SELECT count(*) FROM (
        SELECT cp.thread_id,
          (SELECT array_agg(array[bl.channel::bytea, bl.type::bytea, bl.blob])
            FROM jsonb_each_text(cp.checkpoint -> 'channel_versions')
            JOIN langchain.checkpoint_blobs AS bl
              ON bl.thread_id=cp.thread_id AND bl.checkpoint_ns=cp.checkpoint_ns
              AND bl.channel=jsonb_each_text.key AND bl.version=jsonb_each_text.value) AS channel_values,
          (SELECT array_agg(array[cw.task_id::text::bytea, cw.channel::bytea, cw.type::bytea, cw.blob] ORDER BY cw.task_id,cw.idx)
            FROM langchain.checkpoint_writes AS cw
            WHERE cw.thread_id=cp.thread_id AND cw.checkpoint_ns=cp.checkpoint_ns AND cw.checkpoint_id=cp.checkpoint_id) AS pending_writes
        FROM langchain.checkpoints AS cp
      ) AS saver_load
      WHERE cardinality(channel_values) > 0 AND cardinality(pending_writes) > 0;
    `);
    expect(saverShape.stdout.trim().split(/\s+/)).toEqual(["2", "2", "4", "2"]);
    const saver = PostgresSaver.fromConnString(
      `postgresql://postgres:d489-disposable@127.0.0.1:${hostPort}/nautilo`,
      { schema: "langchain" },
    );
    try {
      const current = await saver.getTuple({ configurable: { thread_id: "current", checkpoint_ns: "" } });
      expect(current?.config.configurable?.["checkpoint_id"]).toBe("002");
      expect(current?.checkpoint.channel_values).toMatchObject({ state: "current-state", shared: "current-shared" });
      expect(current?.pendingWrites).toHaveLength(1);
      const legacy = await saver.getTuple({ configurable: { thread_id: "legacy", checkpoint_ns: "nested" } });
      expect(legacy?.config.configurable?.["checkpoint_id"]).toBe("011");
      expect(legacy?.checkpoint.channel_values).toMatchObject({ legacy: "legacy-state", shared: "legacy-shared" });
      expect(legacy?.pendingWrites).toHaveLength(1);
    } finally {
      await saver.end();
    }
    const rerun = psql(buildCheckpointSemanticCompactionScript(1));
    expect(rerun.status).toBe(0);
    expect(parseCheckpointSemanticCompactionOutput(rerun.stdout)?.deleted).toMatchObject({ checkpointRows: 0, writeRows: 0, blobRows: 0 });
  });

  test("rolls back every delete when interrupted before verification", () => {
    expect(psql("TRUNCATE langchain.checkpoint_writes, langchain.checkpoint_blobs, langchain.checkpoints;" + fixture).status).toBe(0);
    const interrupted = buildCheckpointSemanticCompactionScript(1).replace(
      "DO $verify$",
      "DO $interrupt$ BEGIN RAISE EXCEPTION 'forced disposable interruption'; END $interrupt$;\nDO $verify$",
    );
    expect(psql(interrupted).status).not.toBe(0);
    const counts = psql("SELECT (SELECT count(*) FROM langchain.checkpoints), (SELECT count(*) FROM langchain.checkpoint_writes), (SELECT count(*) FROM langchain.checkpoint_blobs);");
    expect(counts.stdout.trim().split("|")).toEqual(["4", "4", "6"]);
    const staleInventory = buildCheckpointSemanticCompactionScript(1, {
      checkpointRows: 0, writeRows: 0, blobRows: 0, totalRows: 0,
      checkpointLogicalBytes: 0, writeLogicalBytes: 0, blobLogicalBytes: 0,
      totalLogicalBytes: 0, blobPayloadBytes: 0,
    });
    expect(psql(staleInventory).status).not.toBe(0);
    const unchanged = psql("SELECT (SELECT count(*) FROM langchain.checkpoints), (SELECT count(*) FROM langchain.checkpoint_writes), (SELECT count(*) FROM langchain.checkpoint_blobs);");
    expect(unchanged.stdout.trim().split("|")).toEqual(["4", "4", "6"]);
    expect(psql("UPDATE langchain.checkpoints SET checkpoint = jsonb_set(checkpoint, '{v}', '5') WHERE checkpoint_id = '002';").status).toBe(0);
    expect(psql(buildCheckpointSemanticCompactionScript(1)).status).not.toBe(0);
    const futureVersionUnchanged = psql("SELECT (SELECT count(*) FROM langchain.checkpoints), (SELECT count(*) FROM langchain.checkpoint_writes), (SELECT count(*) FROM langchain.checkpoint_blobs);");
    expect(futureVersionUnchanged.stdout.trim().split("|")).toEqual(["4", "4", "6"]);
  });
});
