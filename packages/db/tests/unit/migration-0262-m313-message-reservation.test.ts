import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { finalizeM313MessageReservationMigration } from
  "../../scripts/finalize-m313-message-reservation";

const migration = readFileSync(
  new URL("../../src/migrations/0262_organic_brood.sql", import.meta.url),
  "utf8",
);

describe("M313 pending Message reservation authority", () => {
  test("keeps Human publisher identity outside Agent write authority", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.protect_message_repair_publisher_human()",
    );
    expect(migration).toContain(
      "RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog",
    );
    expect(migration).toContain("current_user = 'nautilo_agent'");
    expect(migration).toContain("NEW.repair_publisher_human_id IS NOT NULL");
    expect(migration).toContain("OLD.completion <> 'pending'");
    expect(migration).toContain(
      "NEW.repair_publisher_kind IS DISTINCT FROM 'foreground_runtime'",
    );
    expect(migration).toContain("USING ERRCODE = '42501'");
    expect(migration).toContain(
      "BEFORE UPDATE OF repair_publisher_human_id ON session_message_crypto_revisions",
    );
  });

  test("grants only the trigger-mediated column path to the Agent role", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.protect_message_repair_publisher_human() FROM PUBLIC, nautilo_crypto",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.protect_message_repair_publisher_human() TO nautilo, nautilo_agent",
    );
    expect(migration).toContain(
      "GRANT UPDATE (repair_publisher_human_id) ON session_message_crypto_revisions TO nautilo_agent",
    );
    expect(finalizeM313MessageReservationMigration(migration)).toBe(migration);
    expect(finalizeM313MessageReservationMigration("SELECT 1;")).toBe(
      "SELECT 1;",
    );
  });
});
