/**
 * Opt-in process-crash proof with a fresh, loopback-only disposable PostgreSQL.
 * Never opens a Nautilo instance or inherited database connection. The worker
 * uses production graph/invocation/checkpoint code; Relay and Shadow are fixtures.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const enabled = process.env["NAUTILO_D516_DISPOSABLE_PG"] === "1";
const ownership = randomUUID();
const name = `d516-checkpoint-${ownership}`;
const database = "d516_checkpoint";
let containerId: string | undefined;
let port: string | undefined;
const children = new Set<ReturnType<typeof worker>>();

async function docker(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Disposable PostgreSQL command failed (${exitCode}): ${stderr}`);
  return stdout.trim();
}

async function query(sql: string): Promise<string> {
  if (containerId === undefined) throw new Error("Owned database is absent");
  return docker(["exec", "-i", containerId, "psql", "-X", "-q", "-t", "-A",
    "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], sql);
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  // Test watchdog, not a runtime policy: never turns absence into success.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type Event = Record<string, unknown>;

function worker(phase: string, threadId: string) {
  if (port === undefined || !/^\d+$/.test(port)) throw new Error("Owned loopback port unavailable");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DB_") || key.startsWith("DATABASE_") || key.startsWith("NAUTILO_INSTANCE")) delete env[key];
  }
  const direct = `postgresql://postgres@127.0.0.1:${port}/${database}`;
  const agent = `postgresql://nautilo_agent@127.0.0.1:${port}/${database}`;
  const child = spawn(process.execPath, [resolve(import.meta.dir, "fixtures/d516-postgres-read-worker.ts"), phase, threadId], {
    env: {
      ...env, NAUTILO_D516_DISPOSABLE_PG: "1", D516_PG_PORT: port,
      NAUTILO_INSTANCE_ID: "test-cruft", NAUTILO_TEST_MODE: "stub",
      DB_DIRECT_CONNECTION: direct, DB_CONNECTION_STRING: direct,
      DB_AGENT_DIRECT_CONNECTION: agent, DB_AGENT_CONNECTION_STRING: agent,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: Event[] = [];
  let partial = "";
  let errorOutput = "";
  let ended = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    partial += chunk;
    let newline: number;
    while ((newline = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, newline);
      partial = partial.slice(newline + 1);
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed as Event);
      } catch { /* Production logger lines are not test acknowledgement. */ }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { ended = true; resolveExit(code); });
  });
  return {
    events, exited,
    proceed() { child.stdin.end("proceed\n"); },
    diagnostics() { return errorOutput; },
    async wait(event: string, call?: string) {
      await until(() => {
        if (events.some((item) => item["event"] === event && (call === undefined || item["call"] === call))) return true;
        if (ended) throw new Error(`Checkpoint worker exited before ${event}: ${errorOutput}`);
        return false;
      }, `${phase}:${event}`);
    },
    async stop() {
      if (!ended) child.kill("SIGKILL");
      await exited;
    },
  };
}

function containsToolReturn(value: unknown, callId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsToolReturn(item, callId));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record["tool_call_id"] === callId
    || Object.values(record).some((item) => containsToolReturn(item, callId));
}

async function hasAcknowledgedFirst(threadId: string): Promise<boolean> {
  if (!/^d516:[a-f0-9-]+$/.test(threadId)) throw new Error("Unexpected disposable thread identity");
  // PostgreSQL's base64 encoder wraps lines; use JSON aggregation for rows.
  const encodedRows = JSON.parse(await query(`SELECT COALESCE(json_agg(encode(blob,'base64')),'[]'::json)
    FROM langchain.checkpoint_writes WHERE thread_id = '${threadId}'
    AND channel = '__return__' AND type = 'json';`)) as string[];
  return encodedRows.some((row) => containsToolReturn(JSON.parse(Buffer.from(row, "base64").toString("utf8")), "call:first"));
}

async function hasCompletedMessagesCheckpoint(threadId: string): Promise<boolean> {
  if (!/^d516:[a-f0-9-]+$/.test(threadId)) throw new Error("Unexpected disposable thread identity");
  const rows = JSON.parse(await query(`SELECT COALESCE(json_agg(encode(b.blob,'base64')),'[]'::json)
    FROM (SELECT * FROM langchain.checkpoints WHERE thread_id = '${threadId}'
      AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1) AS c
    JOIN langchain.checkpoint_blobs AS b ON b.thread_id = c.thread_id
      AND b.checkpoint_ns = c.checkpoint_ns AND b.channel = 'messages'
      AND b.version = c.checkpoint->'channel_versions'->>'messages'
    WHERE b.type = 'json';`)) as string[];
  return rows.some((row) => {
    const value: unknown = JSON.parse(Buffer.from(row, "base64").toString("utf8"));
    return containsToolReturn(value, "call:first") && containsToolReturn(value, "call:second");
  });
}

async function hasAnyPersistedResult(threadId: string, callId: string): Promise<boolean> {
  if (!/^d516:[a-f0-9-]+$/.test(threadId)) throw new Error("Unexpected disposable thread identity");
  const rows = JSON.parse(await query(`SELECT COALESCE(json_agg(json_build_object('type',type,'data',encode(blob,'base64'))),'[]'::json)
    FROM (SELECT type,blob FROM langchain.checkpoint_writes WHERE thread_id = '${threadId}'
      UNION ALL SELECT type,blob FROM langchain.checkpoint_blobs WHERE thread_id = '${threadId}') AS receipts;`)) as Array<{ type: string; data: string | null }>;
  return rows.map((row) => {
    if (row.type === "empty" && row.data === null) return false;
    if (row.type !== "json" || row.data === null) throw new Error("Uncharacterized checkpoint receipt encoding");
    return containsToolReturn(JSON.parse(Buffer.from(row.data, "base64").toString("utf8")), callId);
  }).some(Boolean);
}

describe.skipIf(!enabled)("D516 real Postgres durable parallel reads", () => {
  beforeAll(async () => {
    // Explicitly isolated fixture: no persistent volume, loopback host port,
    // no production credentials, and no ability to select an inherited target.
    containerId = await docker(["run", "-d", "--rm", "--name", name,
      "--label", `dev.nautilo.d516.checkpoint-owner=${ownership}`,
      "--tmpfs", "/var/lib/postgresql/data", "-p", "127.0.0.1::5432",
      "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", `POSTGRES_DB=${database}`, "postgres:16"]);
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error("Docker returned no exact container identity");
    await until(async () => (await docker(["logs", containerId!]))
      .includes("PostgreSQL init process complete; ready for start up."), "final PostgreSQL server startup");
    await until(async () => {
      try { return (await query("SELECT 1;")) === "1"; } catch { return false; }
    }, "disposable PostgreSQL initialization");
    port = (await docker(["port", containerId, "5432/tcp"])).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (port === undefined) throw new Error("Postgres was not bound only to loopback");
    await query("CREATE ROLE nautilo_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;");
  });

  afterAll(async () => {
    await Promise.all([...children].map((child) => child.stop()));
    if (containerId !== undefined) {
      const actual = await docker(["inspect", "--format", '{{index .Config.Labels "dev.nautilo.d516.checkpoint-owner"}}', containerId]);
      if (actual !== ownership) throw new Error("Refusing cleanup of a foreign PostgreSQL container");
      await docker(["rm", "-f", containerId]);
    }
  });

  for (const acknowledged of [true, false]) {
    test(`fresh process reuses ${acknowledged ? "acknowledged" : "no unacknowledged"} sibling completion`, async () => {
      const threadId = `d516:${randomUUID()}`;
      const phase = acknowledged ? "crash-acknowledged" : "crash-unacknowledged";
      const initial = worker(phase, threadId);
      children.add(initial);
      await initial.wait("dispatch", "first");
      await initial.wait("dispatch", "second");
      await initial.wait("result_protected", "first");
      if (acknowledged) await until(() => hasAcknowledgedFirst(threadId), "SQL-visible first task return");
      else expect(await hasAcknowledgedFirst(threadId)).toBe(false);
      // Prove runtime role separation through PostgreSQL, not a mocked factory.
      expect(await query("SELECT rolsuper FROM pg_roles WHERE rolname='nautilo_agent';")).toBe("f");
      expect(await query("SELECT has_table_privilege('nautilo_agent','langchain.checkpoints','INSERT');")).toBe("t");
      expect(await query("SELECT has_table_privilege('nautilo_agent','langchain.checkpoint_migrations','INSERT');")).toBe("f");
      await initial.stop();
      children.delete(initial);

      const resumed = worker("resume", threadId);
      children.add(resumed);
      await resumed.wait("completed");
      expect(await resumed.exited).toBe(0);
      children.delete(resumed);
      const dispatches = resumed.events.filter((event) => event["event"] === "dispatch").map((event) => event["call"]);
      expect(dispatches.filter((call) => call === "first")).toHaveLength(acknowledged ? 0 : 1);
      expect(dispatches.filter((call) => call === "second")).toHaveLength(1);
      expect(resumed.events.filter((event) => event["event"] === "assistant_protected")).toHaveLength(0);
      const completed = resumed.events.find((event) => event["event"] === "completed");
      expect(completed?.["toolCallIds"]).toEqual(["call:first", "call:second"]);
      expect(completed?.["pendingToolCallIds"]).toEqual(["call:mutation"]);
      expect(completed?.["engagedSkillNames"]).toEqual(["computer-use"]);
      expect(completed?.["activatedToolNames"]).toEqual(["run_shell"]);
      expect(completed?.["activatedToolLeases"]).toEqual([{ name: "run_shell", idleTurns: 2 }]);
      expect(completed?.["resultDurableSidecarToolCallIds"]).toEqual(["call:first", "call:second"]);
      expect(dispatches).not.toContain("mutation");
    }, 60_000);
  }

  test("per-call SQL failure propagates while a committed graph checkpoint prevents replay", async () => {
    const threadId = `d516:${randomUUID()}`;
    const initial = worker("write-failure", threadId);
    children.add(initial);
    await initial.wait("ready");
    // This trigger exists only inside the owned disposable cluster, scoped to
    // this thread and the first read return. The runtime's real pg transactions
    // and retry wrapper must encounter the error; no saver method is mocked.
    await query(`CREATE FUNCTION langchain.d516_fail_first() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.thread_id = '${threadId}' AND NEW.channel = '__return__'
          AND NEW.type = 'json' AND jsonb_path_exists(convert_from(NEW.blob,'UTF8')::jsonb,
            '$.**.tool_call_id ? (@ == "call:first")') THEN
          RAISE EXCEPTION 'connection terminated: d516 persistence fixture';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER d516_fail_first BEFORE INSERT OR UPDATE ON langchain.checkpoint_writes
      FOR EACH ROW EXECUTE FUNCTION langchain.d516_fail_first();`);
    initial.proceed();
    await initial.wait("failed");
    expect(await initial.exited).toBe(1);
    children.delete(initial);
    expect(initial.diagnostics()).toContain("putWrites retry 2 also failed, propagating error");
    expect(await hasAcknowledgedFirst(threadId)).toBe(false);
    // A task-write failure can coexist with a successful later graph put.
    // Establish that alternative durable receipt independently before expecting
    // zero redispatch; absence of one task row alone is not lost-result proof.
    expect(await hasCompletedMessagesCheckpoint(threadId)).toBe(true);
    await query("DROP TRIGGER d516_fail_first ON langchain.checkpoint_writes; DROP FUNCTION langchain.d516_fail_first();");

    const resumed = worker("resume", threadId);
    children.add(resumed);
    await resumed.wait("completed");
    expect(await resumed.exited).toBe(0);
    children.delete(resumed);
    expect(resumed.events.filter((event) => event["event"] === "dispatch").map((event) => event["call"]))
      .toEqual([]);
    expect(resumed.events.filter((event) => event["event"] === "assistant_protected")).toHaveLength(0);
    const completed = resumed.events.find((event) => event["event"] === "completed");
    expect(completed?.["toolCallIds"]).toEqual(["call:first", "call:second"]);
    expect(completed?.["pendingToolCallIds"]).toEqual(["call:mutation"]);
  }, 60_000);

  test("failure of every first-result write retries only that read after recovery", async () => {
    const threadId = `d516:${randomUUID()}`;
    const initial = worker("write-failure", threadId);
    children.add(initial);
    await initial.wait("ready");
    await query(`CREATE FUNCTION langchain.d516_fail_all_first() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.thread_id = '${threadId}' AND NEW.type = 'json'
          AND jsonb_path_exists(convert_from(NEW.blob,'UTF8')::jsonb,
            '$.**.tool_call_id ? (@ == "call:first")') THEN
          RAISE EXCEPTION 'connection terminated: d516 persistence fixture';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER d516_fail_all_first BEFORE INSERT OR UPDATE ON langchain.checkpoint_writes
        FOR EACH ROW EXECUTE FUNCTION langchain.d516_fail_all_first();
      CREATE TRIGGER d516_fail_all_first BEFORE INSERT OR UPDATE ON langchain.checkpoint_blobs
        FOR EACH ROW EXECUTE FUNCTION langchain.d516_fail_all_first();`);
    initial.proceed();
    await initial.wait("failed");
    expect(await initial.exited).toBe(1);
    children.delete(initial);
    expect(await hasAnyPersistedResult(threadId, "call:first")).toBe(false);
    expect(await hasAnyPersistedResult(threadId, "call:second")).toBe(true);
    expect(await hasCompletedMessagesCheckpoint(threadId)).toBe(false);
    await query(`DROP TRIGGER d516_fail_all_first ON langchain.checkpoint_writes;
      DROP TRIGGER d516_fail_all_first ON langchain.checkpoint_blobs;
      DROP FUNCTION langchain.d516_fail_all_first();`);
    const resumed = worker("resume", threadId);
    children.add(resumed);
    await resumed.wait("completed");
    expect(await resumed.exited).toBe(0);
    children.delete(resumed);
    expect(resumed.events.filter((event) => event["event"] === "dispatch").map((event) => event["call"]))
      .toEqual(["first"]);
    const completed = resumed.events.find((event) => event["event"] === "completed");
    expect(completed?.["toolCallIds"]).toEqual(["call:first", "call:second"]);
    expect(completed?.["pendingToolCallIds"]).toEqual(["call:mutation"]);
  }, 60_000);
});
