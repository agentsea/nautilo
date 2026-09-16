import { buildFullLegacyRoleRepairSql } from "../../src/utils/legacy-role-repair";
import { getHostedClusterContractSql } from "../../src/utils/hosted-cluster-reconcile";
import { describe, expect, test } from "bun:test";
import { finalizeEventFeedMigration } from "../../scripts/finalize-event-feed";
import { buildAgentRoleGrantsSql } from "../../src/utils/agent-role-grants";

describe("event feed authority", () => {
  test("forces owner RLS and denies nonproduct runtime roles idempotently", () => {
    const source = 'CREATE TABLE "feed_events" ();';
    const result = finalizeEventFeedMigration(source);
    expect(result).toContain('ALTER TABLE "feed_events" FORCE ROW LEVEL SECURITY');
    expect(result).toContain('ALTER TABLE "feed_recipients" FORCE ROW LEVEL SECURITY');
    expect(result).toContain('FROM PUBLIC, "nautilo_agent", "nautilo_crypto"');
    expect(finalizeEventFeedMigration(result)).toBe(result);
    expect(finalizeEventFeedMigration('CREATE TABLE "other" ();')).toBe('CREATE TABLE "other" ();');
  });
  test("admin bootstrap provisions the restricted reader before application migrations", () => {
    for (const setup of [buildFullLegacyRoleRepairSql(), getHostedClusterContractSql("app").schemaContract!]) {
      expect(setup).toContain("CREATE ROLE nautilo_feed_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
      expect(setup).toContain("GRANT nautilo_feed_reader TO nautilo WITH INHERIT FALSE");
      expect(setup).not.toContain("WITH ADMIN OPTION");
    }
    const migration = finalizeEventFeedMigration('CREATE TABLE "feed_events" ();');
    expect(migration.indexOf("CREATE ROLE nautilo_feed_reader")).toBeLessThan(migration.indexOf('CREATE TABLE "feed_events"'));
  });
  test("broad Agent role repair cannot reopen the personal feed", () => {
    const grants = buildAgentRoleGrantsSql();
    expect(grants).toContain('feed_events');
    expect(grants).toContain('feed_recipients');
  });
});
