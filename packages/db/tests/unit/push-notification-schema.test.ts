import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  PUSH_INSTALLATION_BINDING_STATES,
  PUSH_MESSAGE_CANDIDATE_STATES,
  PUSH_NOTIFICATION_TEST_INTENT_STATES,
  pushInstallationBindings,
  pushMessageCandidates,
  pushNotificationTestIntents,
} from "../../src/schema";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const tag = "0148_common_scalphunter";
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0148_snapshot.json"), "utf8"),
) as {
  tables: Record<
    string,
    {
      columns: Record<string, { notNull: boolean; primaryKey: boolean }>;
      checkConstraints: Record<string, { value: string }>;
    }
  >;
};

const bindingTag = "0149_oval_nitro";

describe("D468 durable push-message candidate schema", () => {
  test("records one idempotent, content-free candidate per message", () => {
    const candidate = getTableConfig(pushMessageCandidates);
    expect(PUSH_MESSAGE_CANDIDATE_STATES).toEqual(["pending", "claimed", "terminal"]);
    expect(candidate.columns.map((column) => column.name)).toEqual([
      "message_id",
      "state",
      "claim_owner",
      "claim_expires_at",
      "terminal_at",
      "created_at",
    ]);
    expect(candidate.columns.find((column) => column.name === "message_id")?.primary).toBe(true);
    expect(candidate.checks.find((check) => check.name === "push_message_candidates_state_check")).toBeDefined();
    expect(candidate.indexes.find((index) => index.config.name === "idx_push_message_candidates_pending")).toBeDefined();

    const generated = snapshot.tables["public.push_message_candidates"];
    expect(generated?.columns["message_id"]?.primaryKey).toBe(true);
    expect(generated?.columns["state"]?.notNull).toBe(true);
    expect(generated?.checkConstraints["push_message_candidates_state_check"]?.value).toContain("'terminal'");
  });

  test("grants the restricted append path INSERT only", () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "push_message_candidates" FROM "nautilo_agent"',
    );
    expect(migration).toContain(
      'GRANT INSERT ON TABLE "push_message_candidates" TO "nautilo_agent"',
    );
    expect(migration).not.toContain(
      'GRANT SELECT ON TABLE "push_message_candidates" TO "nautilo_agent"',
    );
    expect(migration).not.toContain("jsonb");
  });

  test("stores push capabilities only as an owner-scoped encrypted envelope", () => {
    const binding = getTableConfig(pushInstallationBindings);
    expect(PUSH_INSTALLATION_BINDING_STATES).toEqual(["active", "disabled", "revoked"]);
    expect(binding.columns.map((column) => column.name)).toEqual([
      "binding_id",
      "user_id",
      "installation_id",
      "platform",
      "token_generation",
      "enabled",
      "badge_enabled",
      "permission",
      "state",
      "app_version",
      "token_key_version",
      "token_nonce_base64",
      "token_ciphertext_base64",
      "token_auth_tag_base64",
      "revoke_verifier_digest",
      "disabled_at",
      "revoked_at",
      "created_at",
      "updated_at",
    ]);
    expect(binding.columns.map((column) => column.name)).not.toContain("expo_push_token");
    expect(binding.indexes.find((index) => index.config.name === "uq_push_installation_bindings_user_installation_live")).toBeDefined();
  });

  test("keeps fixed generic test work separate from message or provider content", () => {
    const intent = getTableConfig(pushNotificationTestIntents);
    expect(PUSH_NOTIFICATION_TEST_INTENT_STATES).toEqual(["pending", "claimed", "terminal"]);
    expect(intent.columns.map((column) => column.name)).toEqual([
      "notification_id",
      "user_id",
      "binding_id",
      "token_generation",
      "state",
      "claim_owner",
      "claim_expires_at",
      "created_at",
      "terminal_at",
    ]);
    expect(intent.columns.map((column) => column.name)).not.toContain("body");
    expect(intent.columns.map((column) => column.name)).not.toContain("title");
  });

  test("enforces owner RLS and exposes proof digest only through a narrow revoke helper", () => {
    const bindingMigration = readFileSync(resolve(migrations, `${bindingTag}.sql`), "utf8");
    expect(bindingMigration).toContain('ALTER TABLE "push_installation_bindings" FORCE ROW LEVEL SECURITY');
    expect(bindingMigration).toContain('ALTER TABLE "push_notification_test_intents" FORCE ROW LEVEL SECURITY');
    expect(bindingMigration).toContain("app_read_push_installation_revoke_verifier");
    expect(bindingMigration).toContain('REVOKE ALL ON TABLE "push_installation_bindings" FROM "nautilo_agent"');
    expect(bindingMigration).not.toContain("expo_push_token");
  });
});
