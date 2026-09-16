import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, test } from "bun:test";
import { sessionMessageCryptoRevisions } from "../../src/schema";
import {
  M237_STRUCTURAL_PROJECTION_AUTHORITY_MARKER,
  finalizeM237LifecycleMigration,
} from "../../scripts/finalize-m237-message-crypto-lifecycle";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../src/migrations/0136_rare_goblin_queen.sql",
  ),
  "utf8",
);

describe("M237 message structural authority hardening", () => {
  test("adds only the bounded Subthread projection", () => {
    const config = getTableConfig(sessionMessageCryptoRevisions);
    const projection = config.columns.find(
      (column) => column.name === "subthread_reply_classification",
    );
    expect(projection?.notNull).toBe(true);
    expect(projection?.default).toBeDefined();
    expect(migration).toContain(
      'ADD COLUMN "subthread_reply_classification" text DEFAULT \'excluded\' NOT NULL',
    );
    expect(migration).toContain(
      "session_message_crypto_revisions_subthread_reply_classification",
    );
    expect(migration).toContain("in ('counted', 'excluded')");
    expect(migration).toContain(
      M237_STRUCTURAL_PROJECTION_AUTHORITY_MARKER,
    );
    expect(migration.match(
      /NEW\.subthread_reply_classification/g,
    )).toHaveLength(1);
    expect(migration.match(
      /OLD\.subthread_reply_classification/g,
    )).toHaveLength(1);
    expect(migration).not.toMatch(
      /^\s*(?:DELETE|UPDATE|INSERT|TRUNCATE)\s+/im,
    );
  });

  test("binds every Agent lifecycle policy to the exact Session Agent", () => {
    for (const policy of [
      "session_message_crypto_revisions_agent_select",
      "session_message_crypto_revisions_agent_insert",
      "session_message_crypto_revisions_agent_update",
    ]) {
      expect(migration).toContain(`ALTER POLICY "${policy}"`);
    }
    expect(migration.match(
      /"sessions"\."agent_id" = app_current_agent_id\(\)/g,
    )).toHaveLength(4);
    expect(migration).toContain(
      'and app_agent_in_room("session_message_crypto_revisions"."room_id")',
    );
    expect(migration).not.toContain("or app_agent_in_room");
  });

  test("finalizer appends the immutable projection authority exactly once", () => {
    const input =
      'ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "subthread_reply_classification" text;';
    const finalized = finalizeM237LifecycleMigration(input);
    expect(finalized).toContain(
      M237_STRUCTURAL_PROJECTION_AUTHORITY_MARKER,
    );
    expect(finalizeM237LifecycleMigration(finalized)).toBe(finalized);
  });
});
