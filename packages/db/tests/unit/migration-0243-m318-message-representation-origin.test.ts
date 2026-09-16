import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(import.meta.dir, "../../src/migrations/0243_smooth_lila_cheney.sql"),
  "utf8",
);

test("M318 records durable representation origin without relabeling existing rows", () => {
  expect(sql).toContain(
    `ADD COLUMN "representation_mode" text DEFAULT 'shadow_encryption' NOT NULL`,
  );
  expect(sql).toContain(`"publication_policy_revision" >= 0`);
  expect(sql).toContain(`ADD COLUMN "publication_policy_revision" integer`);
  expect(sql).toContain(
    `"representation_mode" <> 'full_encryption' or "session_message_crypto_revisions"."publication_policy_revision" is not null`,
  );
  expect(sql).not.toMatch(/UPDATE\s+"session_message_crypto_revisions"/i);
});
