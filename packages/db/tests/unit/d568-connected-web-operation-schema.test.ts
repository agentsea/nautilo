import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  CONNECTED_WEB_OPERATION_DRIVERS,
  CONNECTED_WEB_OPERATION_LIFECYCLES,
  connectedWebOperations,
} from "../../src/schema";

describe("D568 connected website operation authority", () => {
  test("requested Genie checks have their own nullable durable due-time column and index", async () => {
    const config = getTableConfig(connectedWebOperations);
    expect(config.columns.find((column) => column.name === "requested_wake_at")?.notNull).toBe(false);
    expect(config.indexes.map((index) => index.config.name)).toContain("idx_connected_web_operations_requested_wake");
    const migrations = join(import.meta.dir, "../../src/migrations");
    const migration = await readFile(join(migrations, "0234_old_plazm.sql"), "utf8");
    expect(migration).toContain('ADD COLUMN "requested_wake_at" timestamp with time zone');
    expect(migration).toContain('CREATE INDEX "idx_connected_web_operations_requested_wake"');
    const prior = JSON.parse(await readFile(join(migrations, "meta/0232_snapshot.json"), "utf8")) as { id: string };
    const snapshot = JSON.parse(await readFile(join(migrations, "meta/0233_snapshot.json"), "utf8")) as { prevId: string };
    expect(snapshot.prevId).toBe(prior.id);
  });
  test("stores exact initiation and durable CAS/wake authority without browser capabilities", () => {
    expect(CONNECTED_WEB_OPERATION_DRIVERS).toEqual(["hosted", "checking", "direct", "human"]);
    expect(CONNECTED_WEB_OPERATION_LIFECYCLES).toEqual(["admitted", "running", "attention", "terminal"]);
    const config = getTableConfig(connectedWebOperations);
    const columns = config.columns.map((column) => column.name);
    for (const name of [
      "owner_user_id", "account_id", "initiating_agent_id", "initiating_room_id", "initiating_thread_id", "initiating_lane", "delivery_id", "request_digest", "sealed_intent", "action_operation_id", "effect_idempotency_key", "driver", "lifecycle", "control_epoch", "control_lease_token", "sealed_provider_refs", "event_cursor", "safe_activity", "wake_fingerprint", "next_check_at", "supervisor_claim_owner", "wake_claim_owner", "cumulative_cost_usd_micros", "remaining_budget_usd_micros", "terminal_receipt", "terminal_read_result", "created_at", "updated_at",
    ]) expect(columns).toContain(name);
    for (const forbidden of ["live_url", "live_view_url", "cdp_url", "cookie", "api_key", "raw_event", "page_content", "reasoning"]) {
      expect(columns).not.toContain(forbidden);
    }
    expect(config.indexes.map((index) => String(index.config.name))).toContain("idx_connected_web_operations_supervisor_due");
    expect(config.indexes.map((index) => String(index.config.name))).toContain("idx_connected_web_operations_wake_due");
    const checkNames = config.checks.map((check) => String(check.name));
    for (const name of [
      "connected_web_operations_terminal_shape",
      "connected_web_operations_terminal_read_result_shape",
      "connected_web_operations_terminal_read_result_owner",
      "connected_web_operations_provider_refs_shape",
      "connected_web_operations_safe_activity_shape",
    ]) expect(checkNames).toContain(name);
  });

  test("uses a generated append-only migration and snapshot chain", async () => {
    const migrations = join(import.meta.dir, "../../src/migrations");
    const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8")) as {
      entries: readonly { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((candidate) => candidate.idx === 232);
    expect(entry).toMatchObject({ idx: 232, tag: "0232_short_morg" });
    const migration = await readFile(join(migrations, `${entry?.tag}.sql`), "utf8");
    const snapshot = await readFile(join(migrations, "meta/0232_snapshot.json"), "utf8");
    expect(migration).toContain('CREATE TABLE "connected_web_operations"');
    expect(migration).toContain('ALTER TABLE "connected_web_operations" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY "connected_web_operations_product_all"');
    expect(migration).toContain('"event_cursor" bigint');
    expect(migration).toContain('"cumulative_cost_usd_micros" bigint');
    expect(migration).not.toContain("live_view_url");
    expect(migration).not.toContain("cdp_url");
    expect(snapshot).toContain('"public.connected_web_operations"');

    // The unshipped branch migrations were regenerated from the final schema
    // after main's 0231 migration, preserving the shipped prefix byte-for-byte.
    expect(migration).toContain('"terminal_read_result" jsonb');
    expect(migration).toContain('CONSTRAINT "connected_web_operations_terminal_read_result_shape"');
    expect(migration).toContain('CONSTRAINT "connected_web_operations_terminal_read_result_owner"');
    expect(migration).toContain('"browser_idle_until" timestamp with time zone');
    expect(migration).toContain('"browser_cleanup_started_at" timestamp with time zone');
    expect(migration).toContain('CREATE TABLE "connected_web_operation_activity_entries"');
    expect(migration).toContain('CREATE UNIQUE INDEX "uq_connected_web_activity_event"');
    expect(migration).toContain('CREATE POLICY "connected_web_activity_product_all"');
    const prior = JSON.parse(await readFile(join(migrations, "meta/0231_snapshot.json"), "utf8")) as { id: string };
    expect(JSON.parse(snapshot) as unknown).toMatchObject({ prevId: prior.id });
  });
});
