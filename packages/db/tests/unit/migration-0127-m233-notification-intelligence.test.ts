import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const tag = "0127_notification_intelligence_facts";
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0127_snapshot.json"), "utf8"),
) as {
  tables: Record<
    string,
    {
      columns: Record<string, { notNull: boolean }>;
      checkConstraints: Record<string, { value: string }>;
    }
  >;
};

describe("M233 migration 0127 — notification intelligence facts", () => {
  test("journal and snapshot retain the semantic generated migration", () => {
    const journal = JSON.parse(
      readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.idx === 127)?.tag).toBe(tag);
    for (const table of [
      "public.user_notification_settings",
      "public.room_notification_settings",
      "public.session_message_directed_recipients",
      "public.subthread_notification_participants",
    ]) {
      expect(snapshot.tables[table]).toBeDefined();
    }
  });

  test("adds nullable Human-turn identity with a role check and index", () => {
    const messages = snapshot.tables["public.session_messages"];
    expect(messages?.columns["human_turn_id"]?.notNull).toBe(false);
    expect(
      messages?.checkConstraints[
        "session_messages_human_turn_id_role_check"
      ]?.value,
    ).toContain(`"human_turn_id" IS NULL OR "session_messages"."role" = 'user'`);
    expect(migration).toContain('"idx_session_messages_human_turn_id"');
  });

  test("materializes only durable historical direct and reply facts", () => {
    expect(migration).toContain("HAVING count(*) = 2");
    expect(migration).toContain("'direct_room'");
    expect(migration).toContain("'explicit_reply'");
    expect(migration).not.toMatch(/INSERT INTO[\s\S]*'mention'/);
    expect(migration).not.toMatch(/INSERT INTO[\s\S]*'agent_response'/);
  });

  test("reconciles exact append-role privileges", () => {
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent')",
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "user_notification_settings" FROM "nautilo_agent"',
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "room_notification_settings" FROM "nautilo_agent"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "session_message_directed_recipients" TO "nautilo_agent"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "subthread_notification_participants" TO "nautilo_agent"',
    );
  });
});
