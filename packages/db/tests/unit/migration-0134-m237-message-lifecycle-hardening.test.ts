import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  M237_GROUP_RECEIPTS_AUTHORITY_MARKER,
  finalizeM237LifecycleMigration,
} from "../../scripts/finalize-m237-message-crypto-lifecycle.ts";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; tag: string }[];
};
const migrationEntry = journal.entries.find((entry) => entry.idx === 134);
const migration = migrationEntry === undefined
  ? ""
  : readFileSync(
    resolve(migrations, `${migrationEntry.tag}.sql`),
    "utf8",
  );

describe("M237 lifecycle hardening", () => {
  test("generates bounded edit-group and quarantine receipts", () => {
    expect(migrationEntry?.idx).toBe(134);
    expect(migration).toContain(
      'ADD COLUMN "terminal_operation_group_id" text',
    );
    expect(migration).toContain(
      'ADD COLUMN "quarantine_lease_token" uuid',
    );
    for (const constraint of [
      "session_message_crypto_revisions_quarantine_receipt_coherent",
      "session_message_crypto_revisions_delete_root_time_coherent",
      "session_message_crypto_revisions_operation_group_id_portable",
      "session_message_crypto_revisions_terminal_operation_coherent",
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
    expect(migration).toContain(
      `"session_message_crypto_revisions"."disposition" = 'superseded'
          and "session_message_crypto_revisions"."terminal_operation_id" is not null
          and "session_message_crypto_revisions"."terminal_operation_group_id" is not null`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_root_reply_count" = 0
            and "session_message_crypto_revisions"."delete_root_last_reply_at" is null`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_root_reply_count" > 0
            and "session_message_crypto_revisions"."delete_root_last_reply_at" is not null`,
    );
    expect(migration).toContain(M237_GROUP_RECEIPTS_AUTHORITY_MARKER);
    expect(migration).not.toMatch(
      /^\s*(?:DELETE|UPDATE|INSERT|TRUNCATE)\s+/im,
    );
  });

  test("makes Agent membership and AI row authority conjunctive", () => {
    for (const policy of [
      "session_message_crypto_revisions_agent_select",
      "session_message_crypto_revisions_agent_insert",
      "session_message_crypto_revisions_agent_update",
    ]) {
      expect(migration).toContain(`ALTER POLICY "${policy}"`);
    }
    expect(migration).not.toContain(
      "or app_agent_in_room",
    );
    expect(migration).toContain(
      'and app_agent_in_room("session_message_crypto_revisions"."room_id")',
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."key_class" = 'ai'`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."author_role" <> 'user'`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."parity_status" <> 'client_verified'`,
    );
  });

  test("finalizer grants only the two new mutable receipt columns once", () => {
    const generated = [
      'ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "terminal_operation_group_id" text;',
      "",
    ].join("\n");
    const once = finalizeM237LifecycleMigration(generated);
    expect(finalizeM237LifecycleMigration(once)).toBe(once);
    expect(
      once.match(
        new RegExp(M237_GROUP_RECEIPTS_AUTHORITY_MARKER, "g"),
      ),
    ).toHaveLength(1);
    const updateGrant = once.match(
      /GRANT UPDATE \(([\s\S]*?)\) ON TABLE "session_message_crypto_revisions"\s+TO "nautilo_agent"/,
    );
    expect(updateGrant?.[1]?.match(/"[^"]+"/g)).toEqual([
      '"terminal_operation_group_id"',
      '"quarantine_lease_token"',
    ]);
  });
});
