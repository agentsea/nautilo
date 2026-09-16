import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0237_absurd_ben_parker";
const migration = readFileSync(
  resolve(import.meta.dir, `../../src/migrations/${tag}.sql`),
  "utf8",
);

describe(`${tag} M311 Message repair Room binding`, () => {
  test("binds every Agent mutation policy to the Session's actual Room", () => {
    for (const policy of [
      "session_message_crypto_revisions_agent_insert",
      "session_message_crypto_revisions_agent_update",
    ]) {
      const start = migration.indexOf(`ALTER POLICY "${policy}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = migration.indexOf("--> statement-breakpoint", start);
      const statement = migration.slice(
        start,
        end === -1 ? migration.length : end,
      );

      expect(statement).toContain(
        '"sessions"."id" = "session_message_crypto_revisions"."session_id"',
      );
      expect(statement).toContain(
        '"sessions"."room_id" = "session_message_crypto_revisions"."room_id"',
      );
    }
  });
});
