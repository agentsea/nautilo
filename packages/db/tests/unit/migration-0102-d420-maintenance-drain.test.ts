/**
 * D420 — validates migration 0102 adds the permanent `server_maintenance`
 * lease singleton and the payload-free `work_acceptances` ledger, plus
 * journal/snapshot-chain integrity. File-based (no live DB).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const META = resolve(MIGRATIONS_DIR, "meta");
const TAG = "0102_d420_maintenance_drain";
const SQL_PATH = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(META, "_journal.json");
const SQL = readFileSync(SQL_PATH, "utf-8");

describe("D420 migration 0102 — journal + snapshot chain", () => {
  test("journal references idx 102 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e102 = journal.entries.find((e) => e.idx === 102);
    expect(e102?.tag).toBe(TAG);
  });

  test("historical 0101 remains in the journal", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e101 = journal.entries.find((e) => e.idx === 101);
    expect(e101?.tag).toBe("0101_d418_remove_workstation_preset");
  });

  test("journal prefix through 0102 is strictly increasing and contiguous", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number }>;
    };
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs.slice(0, 103)).toEqual(Array.from({ length: 103 }, (_, i) => i));
  });

  test("0102 snapshot exists and chains prevId to 0101's id", () => {
    expect(existsSync(resolve(META, "0102_snapshot.json"))).toBe(true);
    const s102 = JSON.parse(
      readFileSync(resolve(META, "0102_snapshot.json"), "utf-8"),
    ) as { id: string; prevId: string };
    const s101 = JSON.parse(
      readFileSync(resolve(META, "0101_snapshot.json"), "utf-8"),
    ) as { id: string };
    expect(s102.prevId).toBe(s101.id);
  });

  test("0102 snapshot declares both new tables", () => {
    const s = JSON.parse(
      readFileSync(resolve(META, "0102_snapshot.json"), "utf-8"),
    ) as { tables: Record<string, unknown> };
    expect(s.tables["public.server_maintenance"]).toBeDefined();
    expect(s.tables["public.work_acceptances"]).toBeDefined();
  });
});

describe("D420 migration 0102 — server_maintenance shape", () => {
  test("creates the singleton table with lease + hard expiry columns", () => {
    expect(SQL).toContain('CREATE TABLE "server_maintenance"');
    expect(SQL).toContain('"singleton_key" text PRIMARY KEY DEFAULT \'upgrade\' NOT NULL');
    expect(SQL).toContain('"state" varchar(16) DEFAULT \'normal\' NOT NULL');
    expect(SQL).toContain('"operation_id" uuid');
    expect(SQL).toContain('"lease_expires_at" timestamp with time zone');
    expect(SQL).toContain('"hard_expires_at" timestamp with time zone');
    expect(SQL).toContain('"created_at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(SQL).toContain('"updated_at" timestamp with time zone DEFAULT now() NOT NULL');
  });

  test("state CHECK constraint restricts to normal | draining | applying", () => {
    expect(SQL).toContain('"server_maintenance_state_check"');
    expect(SQL).toContain("'normal', 'draining', 'applying'");
  });
});

describe("D420 migration 0102 — work_acceptances shape", () => {
  test("creates the ledger table with payload-free identity columns only", () => {
    expect(SQL).toContain('CREATE TABLE "work_acceptances"');
    expect(SQL).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL');
    expect(SQL).toContain('"kind" varchar(32) NOT NULL');
    expect(SQL).toContain('"status" varchar(32) DEFAULT \'accepted\' NOT NULL');
    expect(SQL).toContain('"job_id" uuid');
    expect(SQL).toContain('"accepted_at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(SQL).toContain('"dispatched_at" timestamp with time zone');
    expect(SQL).toContain('"cancelled_at" timestamp with time zone');
    expect(SQL).toContain('"cancellation_reason" text');
  });

  test("no prompt/room/user/tool/checkpoint payload columns on the ledger", () => {
    // The ledger is identity + lifecycle only. Assert the absence of any
    // content-bearing column the spec forbids.
    const tableBlock = SQL.split('CREATE TABLE "work_acceptances"')[1]!.split("-->")[0]!;
    for (const forbidden of [
      "prompt",
      "message",
      "room_id",
      "user_id",
      "owner_id",
      "requestor_id",
      "tool",
      "input",
      "checkpoint",
      "thread_id",
      "lane_key",
      "turn_id",
    ]) {
      expect(tableBlock.toLowerCase()).not.toContain(forbidden);
    }
  });

  test("kind + status CHECK constraints enforce the locked enums", () => {
    expect(SQL).toContain('"work_acceptances_kind_check"');
    expect(SQL).toContain("'foreground', 'system_report_back'");
    expect(SQL).toContain('"work_acceptances_status_check"');
    expect(SQL).toContain("'accepted', 'dispatched', 'maintenance_cancelled'");
  });

  test("job_id FK -> jobs.id ON DELETE SET NULL", () => {
    expect(SQL).toContain(
      '"work_acceptances_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null',
    );
  });

  test("status + job_id indexes", () => {
    expect(SQL).toContain('CREATE INDEX "idx_work_acceptances_status"');
    expect(SQL).toContain('CREATE INDEX "idx_work_acceptances_job"');
  });
});
