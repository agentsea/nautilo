import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { finalizeM313ToolContextMigration } from
  "../../scripts/finalize-m313-tool-context";
import { SENSITIVE_TABLES } from "../../src/utils/agent-role-grants";

const migration = readFileSync(
  new URL("../../src/migrations/0263_confused_the_santerians.sql", import.meta.url),
  "utf8",
);

describe("M313 bounded Tool context migration", () => {
  test("keeps continuation state product-only and structurally bounded", () => {
    for (const table of [
      "message_backfill_tool_contexts",
      "message_backfill_tool_pending_calls",
    ] as const) {
      expect(migration).toContain(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `REVOKE ALL ON public.message_backfill_tool_contexts, public.message_backfill_tool_pending_calls FROM PUBLIC, nautilo_agent, nautilo_crypto`,
      );
      expect(SENSITIVE_TABLES).toContain(table);
    }
    expect(migration).toContain(
      'CONSTRAINT "message_backfill_tool_pending_coordinates"',
    );
    expect(migration).toContain(
      'CREATE INDEX "idx_session_messages_session_created_id"',
    );
  });

  test("serializes every insert before deciding whether source order changed", () => {
    const lock = migration.indexOf(
      "PERFORM 1 FROM public.sessions WHERE id = NEW.session_id FOR NO KEY UPDATE",
    );
    const laterProbe = migration.indexOf(
      "IF NOT EXISTS (SELECT 1 FROM public.session_messages AS later",
    );
    expect(lock).toBeGreaterThan(0);
    expect(laterProbe).toBeGreaterThan(lock);
    expect(migration).toContain(
      "(later.created_at, later.id) > (NEW.created_at, NEW.id)",
    );
  });

  test("protects the revision and advances it only for canonical source fields", () => {
    expect(migration).toContain(
      "IF pg_trigger_depth() < 2 OR NEW.message_source_revision <> OLD.message_source_revision + 1",
    );
    expect(migration).toContain("USING ERRCODE = '42501'");
    expect(migration).toContain(
      "AFTER INSERT OR DELETE OR UPDATE OF session_id, role, content, tool_calls, tool_name, created_at, edit_revision",
    );
    expect(migration).not.toContain("UPDATE OF crypto_object_id");
    expect(migration).toContain(
      "ALTER FUNCTION public.advance_message_source_revision() OWNER TO nautilo",
    );
    expect(finalizeM313ToolContextMigration(migration)).toBe(migration);
    expect(finalizeM313ToolContextMigration("SELECT 1;")).toBe("SELECT 1;");
  });
});
