import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  M237_DELETE_EFFECTS_AUTHORITY_MARKER,
  finalizeM237LifecycleMigration,
} from "../../scripts/finalize-m237-message-crypto-lifecycle.ts";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; tag: string }[];
};
const migrationEntry = journal.entries.find((entry) => entry.idx === 133);
const migration = migrationEntry === undefined
  ? ""
  : readFileSync(
    resolve(migrations, `${migrationEntry.tag}.sql`),
    "utf8",
  );

describe("M237 durable hard-delete effects", () => {
  test("generates a metadata-only additive migration with bounded coherent state", () => {
    expect(migrationEntry?.idx).toBe(133);
    for (const column of [
      "delete_was_unread",
      "delete_orphaned_turn_id",
      "delete_root_parent_room_id",
      "delete_root_anchor_message_id",
      "delete_root_reply_count",
      "delete_root_last_reply_at",
      "delete_root_summary_revision",
    ]) {
      expect(migration).toContain(
        `ADD COLUMN "${column}"`,
      );
    }
    for (const constraint of [
      "session_message_crypto_revisions_delete_effects_coherent",
      "session_message_crypto_revisions_delete_root_summary_coherent",
      "session_message_crypto_revisions_delete_root_anchor_positive",
      "session_message_crypto_revisions_delete_root_reply_count_nonnegative",
      "session_message_crypto_revisions_delete_root_revision_nonnegative",
      "session_message_crypto_revisions_delete_orphaned_turn_id_portable",
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
    expect(migration).toContain(
      `"session_message_crypto_revisions"."disposition" = 'hard_delete'
          and "session_message_crypto_revisions"."delete_was_unread" is not null`,
    );
    for (const column of [
      "delete_was_unread",
      "delete_orphaned_turn_id",
      "delete_root_parent_room_id",
      "delete_root_anchor_message_id",
      "delete_root_reply_count",
      "delete_root_last_reply_at",
      "delete_root_summary_revision",
    ]) {
      expect(migration).toContain(
        `"session_message_crypto_revisions"."${column}" is null`,
      );
    }
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_root_parent_room_id" is not null`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_root_anchor_message_id" is not null`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_root_reply_count" is not null`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_root_summary_revision" is not null`,
    );
    expect(migration).not.toContain(
      `"session_message_crypto_revisions"."delete_root_last_reply_at" is not null`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_root_anchor_message_id" > 0`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_root_reply_count" >= 0`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_root_summary_revision" >= 0`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_orphaned_turn_id") between 1 and 128`,
    );
    expect(migration).toContain(
      `"session_message_crypto_revisions"."delete_orphaned_turn_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
    );
    expect(migration).toContain(M237_DELETE_EFFECTS_AUTHORITY_MARKER);
    expect(migration).toMatch(
      /GRANT UPDATE \(([\s\S]*?)\) ON TABLE "session_message_crypto_revisions"\s+TO "nautilo_agent"/,
    );
    expect(migration).not.toMatch(
      /^\s*(?:DELETE|UPDATE|INSERT|TRUNCATE)\s+/im,
    );
    expect(migration).not.toContain("nautilo_crypto");
  });

  test("finalizer adds the narrow agent update authority exactly once", () => {
    const generated = [
      'ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "delete_was_unread" boolean;',
      "",
    ].join("\n");
    const once = finalizeM237LifecycleMigration(generated);
    const twice = finalizeM237LifecycleMigration(once);

    expect(twice).toBe(once);
    expect(
      once.match(
        new RegExp(M237_DELETE_EFFECTS_AUTHORITY_MARKER, "g"),
      ),
    ).toHaveLength(1);
    const updateGrant = once.match(
      /GRANT UPDATE \(([\s\S]*?)\) ON TABLE "session_message_crypto_revisions"\s+TO "nautilo_agent"/,
    );
    expect(updateGrant?.[1]?.match(/"[^"]+"/g)).toEqual([
      '"delete_was_unread"',
      '"delete_orphaned_turn_id"',
      '"delete_root_parent_room_id"',
      '"delete_root_anchor_message_id"',
      '"delete_root_reply_count"',
      '"delete_root_last_reply_at"',
      '"delete_root_summary_revision"',
    ]);
  });
});
