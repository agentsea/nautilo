/** Guards the custom SQL Drizzle cannot represent in D453's generated migration. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0144_cheerful_young_avengers";
const SQL = readFileSync(resolve(MIGRATIONS, `${TAG}.sql`), "utf8");
const JOURNAL = JSON.parse(
  readFileSync(resolve(MIGRATIONS, "meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

describe("D453 generated migration security contract", () => {
  test("keeps the canonical D453 migration without abandoned schema", () => {
    expect(JOURNAL.entries.find((entry) => entry.idx === 144)).toMatchObject({ tag: TAG });
    expect(SQL).not.toContain("codex_agent_preferences");
    expect(SQL).not.toContain("direct_room");
    expect(SQL).not.toContain("capability_manifest_hash");
  });

  test("retains functions, triggers, RLS, grants, and policies omitted by snapshots", () => {
    for (const marker of [
      "app_is_valid_codex_usage_snapshot",
      "app_is_valid_codex_user_input_questions",
      "app_can_access_codex_binding",
      "app_reject_codex_binding_immutable_update",
      "codex_thread_bindings_immutable_tuple",
      "app_reject_nonactive_codex_profile_reference",
      "codex_thread_bindings_require_active_profile",
      "app_enforce_codex_profile_removal_lifecycle",
      "codex_account_profiles_removal_lifecycle",
      "codex_user_preferences_require_active_profile",
      "app_list_codex_profile_removal_work",
      "app_archive_codex_profile_removal_bindings",
      "app_enforce_codex_user_input_request_lifecycle",
      "codex_user_input_requests_lifecycle",
      "FORCE ROW LEVEL SECURITY",
      "codex_thread_bindings_owner_room_agent",
      "codex_user_preferences_owner",
      "codex_user_input_requests_owner",
      "REVOKE ALL ON FUNCTION",
    ]) expect(SQL).toContain(marker);
  });

  test("creates validation functions before CHECK constraints use them", () => {
    expect(SQL.indexOf("CREATE OR REPLACE FUNCTION app_is_valid_codex_usage_snapshot"))
      .toBeLessThan(SQL.indexOf('CREATE TABLE "codex_account_profiles"'));
    expect(SQL.indexOf("CREATE OR REPLACE FUNCTION app_is_valid_codex_user_input_questions"))
      .toBeLessThan(SQL.indexOf('CREATE TABLE "codex_user_input_requests"'));
  });
});
