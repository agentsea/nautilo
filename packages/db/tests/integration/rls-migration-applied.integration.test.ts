/**
 * D168 P2 — smoke test: assert the Path C RLS migration actually
 * applied. This catches the failure mode where Drizzle's migrator
 * silently records a migration's hash in `__drizzle_migrations`
 * without actually executing the SQL (observed during D168 P2
 * development when the migration file lacked `--> statement-breakpoint`
 * markers — drizzle's migrator parses by those markers and emits an
 * empty statement list when none are present, so the migration is
 * "applied" but does nothing).
 *
 * This test is the tripwire for that whole bug class on this and
 * any future RLS migration. If `ensureDatabase()` returns success
 * but these objects are missing, RLS is silently disabled — every
 * agent SELECT would return all rows regardless of trust context.
 * That's a security regression with no observable failure mode at
 * runtime (it just looks like more data is "visible"); the only
 * defense is asserting structurally that the migration's DB-side
 * artifacts exist.
 *
 * Failure mode for a future engineer: they add a new RLS migration
 * but forget `--> statement-breakpoint`; Drizzle marks it applied;
 * this test fails before the integration suite even gets to the
 * 7-scenario check.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ensureDatabase, createDirectDb } from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const EXPECTED_FUNCTIONS = [
  "app_caller_in_room",
  "app_can_read_namespace",
  "app_current_agent_id",
  "app_current_user_id",
] as const;

const EXPECTED_POLICY_TABLES = [
  "agent_scopes",
  "artifact_namespaces",
  "artifact_scopes",
  "artifacts",
  "credentials",
  "memories",
  "memory_namespaces",
  "memory_scopes",
  "recovery_codes",
  "room_members",
  "sessions",
] as const;

describe("D168 P2 migration applied smoke test", () => {
  let db: ReturnType<typeof createDirectDb>;

  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    db = createDirectDb(1);
  });

  test("all four GUC + SECURITY DEFINER helper functions exist post-migration", async () => {
    const rows = (await db.execute(
      `SELECT proname FROM pg_proc WHERE proname IN ('app_caller_in_room','app_can_read_namespace','app_current_agent_id','app_current_user_id') ORDER BY proname`,
    )) as unknown as Array<{ proname: string }>;
    const present = rows.map((r) => r.proname).sort();
    expect(present).toEqual([...EXPECTED_FUNCTIONS].sort());
  });

  test("all eleven Path C policies exist on the expected tables", async () => {
    const rows = (await db.execute(
      `SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public' AND (policyname LIKE '%_path_c%' OR policyname LIKE '%_self') ORDER BY tablename`,
    )) as unknown as Array<{ tablename: string }>;
    const tables = rows.map((r) => r.tablename).sort();
    expect(tables).toEqual([...EXPECTED_POLICY_TABLES].sort());
  });

  test("RLS is ENABLED on every policy-bearing table (relrowsecurity=true)", async () => {
    const rows = (await db.execute(
      `SELECT c.relname AS tablename, c.relrowsecurity AS rls_enabled
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('memories','artifacts','memory_namespaces','memory_scopes','artifact_namespaces','artifact_scopes','room_members','agent_scopes','credentials','recovery_codes','sessions')
       ORDER BY c.relname`,
    )) as unknown as Array<{ tablename: string; rls_enabled: boolean }>;
    expect(rows.length).toBe(EXPECTED_POLICY_TABLES.length);
    for (const row of rows) {
      expect(row.rls_enabled).toBe(true);
    }
  });

  test("D168 P3 — FORCE ROW LEVEL SECURITY is set on credentials + recovery_codes", async () => {
    // Without FORCE, the table OWNER (and any BYPASSRLS role) bypasses
    // the policy — meaning the chokepoint module's `withTrustContext`
    // would be a no-op for the superuser path that PinChallengeProvider
    // uses. FORCE makes the per-row `user_id = app_current_user_id()`
    // policy enforce even for `nautilo`. If a future engineer adds
    // `ALTER TABLE credentials NO FORCE ROW LEVEL SECURITY` for any
    // reason, this test fires before the security boundary degrades.
    const rows = (await db.execute(
      `SELECT c.relname, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('credentials','recovery_codes')
       ORDER BY c.relname`,
    )) as unknown as Array<{ relname: string; relforcerowsecurity: boolean }>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  test("SECURITY DEFINER attribute is set on the two recursion-breaking helpers", async () => {
    // app_can_read_namespace and app_caller_in_room MUST be
    // SECURITY DEFINER — without it the room_members policy hits
    // "infinite recursion detected in policy for relation room_members".
    // If a future engineer "simplifies" the helper by removing
    // SECURITY DEFINER, this test fires before the integration suite
    // runs (and explains why).
    const rows = (await db.execute(
      `SELECT proname, prosecdef FROM pg_proc
       WHERE proname IN ('app_can_read_namespace','app_caller_in_room')
       ORDER BY proname`,
    )) as unknown as Array<{ proname: string; prosecdef: boolean }>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.prosecdef).toBe(true);
    }
  });
});
