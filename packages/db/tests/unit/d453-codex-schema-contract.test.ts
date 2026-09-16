/** D453 task 2.1 — migration-only tripwires that do not require a live DB. */
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const migrationsDir = join(import.meta.dir, "../../src/migrations");

async function d453Migration(): Promise<string> {
  const files = await readdir(migrationsDir);
  const name = files.find((file) => /^0144_cheerful_young_avengers\.sql$/.test(file));
  if (!name) throw new Error("D453 migration 0144_cheerful_young_avengers is missing");
  return readFile(join(migrationsDir, name), "utf8");
}

async function d453OwnerPreferenceMigration(): Promise<string> {
  return d453Migration();
}

test("D453 migration keeps owner/profile and binding provenance constraints structural", async () => {
  const sql = await d453Migration();
  for (const table of [
    "codex_account_profiles",
    "codex_thread_bindings",
    "codex_user_preferences",
    "codex_user_input_requests",
  ]) {
    expect(sql).toContain(`CREATE TABLE "${table}"`);
    expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
  expect(sql).toContain('FOREIGN KEY ("user_id","account_profile_id")');
  expect(sql).toContain('REFERENCES "public"."codex_account_profiles"("user_id","id")');
  expect(sql).toContain("codex_thread_bindings_profile_owner_fk");
  expect(sql).not.toContain("codex_agent_preferences");
  expect(sql).not.toContain("direct_room");
  expect(sql).not.toContain("capability_manifest_hash");
  expect(sql).toContain("codex_thread_bindings_immutable_tuple");
  expect(sql).toContain("app_reject_codex_binding_immutable_update");
  expect(sql).toContain("idx_codex_thread_bindings_task_run");
  expect(sql).toContain("idx_codex_thread_bindings_job");
  expect(sql).toContain("NEW.id IS DISTINCT FROM OLD.id");
  expect(sql).toContain("NEW.created_at IS DISTINCT FROM OLD.created_at");
  expect(sql).toContain("OLD.archived_at IS NOT NULL");
  expect(sql).toContain("NEW.archived_at IS NULL OR NEW.state<>'archived'");
  expect(sql).toContain("OLD.state<>'needs_rebind'");
  expect(sql).toContain("NEW.state<>'active'");
  expect(sql).toContain("NEW.binding_generation<>OLD.binding_generation+1");
  expect(sql).toContain("NEW.revision<>OLD.revision+1");
  expect(sql.indexOf('CONSTRAINT "uq_codex_account_profiles_user_id" UNIQUE("user_id","id")')).toBeLessThan(
    sql.indexOf('FOREIGN KEY ("user_id","account_profile_id")'),
  );
});

test("D453 binding RLS requires the exact v8/task provenance tuple", async () => {
  const sql = await d453Migration();
  expect(sql).toContain("app_can_access_codex_binding");
  expect(sql).toContain("SECURITY DEFINER");
  expect(sql).toContain("app_current_agent_id() IS NOT NULL");
  expect(sql).toContain("source_run.task_id=source_task.id");
  expect(sql).toContain("source_run.job_id=p_job_id");
  expect(sql).toContain("source_job.lane_key=p_lane_key");
  expect(sql).toContain("app_caller_in_room(p_room_id)");
  expect(sql).toContain("app_agent_in_room(p_room_id,p_source_agent_id)");
  expect(sql).toContain("workspace_ref");
  expect(sql).toContain("workspace_fingerprint");
  expect(sql).toContain("workspace_issued_at");
  expect(sql).toContain("workspace_expires_at");
  expect(sql).toContain("workspace_issued_at\" < \"codex_thread_bindings\".\"workspace_expires_at");
  expect(sql).toContain("'needs_rebind'");
});

test("D453 usage snapshots are bounded, versioned safe projections", async () => {
  const sql = await d453Migration();
  expect(sql).toContain("app_is_valid_codex_usage_snapshot");
  expect(sql).toContain("app_is_canonical_codex_utc_timestamp");
  expect(sql).toContain("app_is_canonical_codex_date");
  expect(sql).toContain("public.app_is_canonical_codex_utc_timestamp");
  expect(sql).toContain("public.app_is_canonical_codex_date");
  expect(sql).toContain("octet_length(p_snapshot::text) > 16384");
  expect(sql).toContain("'schemaVersion','rateLimits','usage'");
  expect(sql).toContain("'primary','secondary','plan','credits','spendControl','reached','observedAt','freshness'");
  expect(sql).toContain("'lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays'");
  expect(sql).toContain("'free','go','plus','pro','prolite','team','business','enterprise','edu','usage_based','unknown'");
  expect(sql).toContain("jsonb_array_length(v->'daily') > 31");
  expect(sql).toContain("jsonb_typeof(v->'freshness')<>'string'");
  expect(sql).toContain("octet_length(convert_to(v->>'balance','UTF8'))");
  expect(sql).toContain("NOT (p_snapshot ? 'rateLimits' OR p_snapshot ? 'usage')");
  expect(sql).toContain("NOT (p_snapshot ? 'schemaVersion')");
  expect(sql).toContain("jsonb_typeof(p_snapshot -> 'schemaVersion') <> 'number'");
  expect(sql).toContain("codex_account_profiles_usage_snapshot_check");
  expect(sql).toContain("codex_account_profiles_usage_freshness_check");
  expect(sql).toContain("codex_account_profiles_plan_type_check");
});

test("D453 owner preference starts disabled and never backfills an arbitrary Genie", async () => {
  const sql = await d453OwnerPreferenceMigration();
  expect(sql).toContain('CREATE TABLE "codex_user_preferences"');
  expect(sql).toContain('"enabled" boolean DEFAULT false NOT NULL');
  expect(sql).toContain("codex_user_preferences_profile_owner_fk");
  expect(sql).not.toContain("INSERT INTO \"codex_user_preferences\"");
  expect(sql).not.toContain("FROM \"codex_agent_preferences\"");
});
