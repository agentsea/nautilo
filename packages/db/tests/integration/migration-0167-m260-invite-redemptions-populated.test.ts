/**
 * M260 — executable populated-DB replay for migration 0167.
 *
 * A migrated QA database already has the destination table, so this test
 * temporarily restores just the pre-0167 schema boundary inside a transaction,
 * executes the generated migration SQL, proves the legacy singleton evidence
 * is preserved, and then deliberately rolls every DDL/DML change back.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  ensureDatabase,
  resolveDirectDatabaseConnectionString,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

function stripStatementBreakpoints(sqlText: string): string {
  return sqlText.replace(/-->\s*statement-breakpoint/g, "");
}

let sql: ReturnType<typeof postgres>;
let migrationBody: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  migrationBody = stripStatementBreakpoints(
    readFileSync(
      resolve(import.meta.dirname, "../../src/migrations/0167_jazzy_jocasta.sql"),
      "utf8",
    ),
  );
  sql = postgres(resolveDirectDatabaseConnectionString(), { max: 1 });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describe("M260 migration 0167 — populated Invite redemption replay", () => {
  test(
    "backfills live and completed legacy evidence without inventing an unbound redemption",
    async () => {
      let completed = false;
      try {
        await sql.begin(async (tx) => {
          const suffix = `${Date.now().toString(36)}${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const [targetGroup] = await tx<{ id: string }[]>`
            SELECT id FROM groups WHERE type = 'guests' LIMIT 1
          `;
          if (!targetGroup) throw new Error("canonical guests group missing");

          const fixtureUsers = await tx<{ id: string }[]>`
            INSERT INTO users (name, email, handle) VALUES
              (${`m260 migration creator ${suffix}`}, ${`m260-migration-creator-${suffix}@test.local`}, ${`m260mc${suffix.slice(-8)}`}),
              (${`m260 migration live ${suffix}`}, ${`m260-migration-live-${suffix}@test.local`}, ${`m260ml${suffix.slice(-8)}`}),
              (${`m260 migration complete ${suffix}`}, ${`m260-migration-complete-${suffix}@test.local`}, ${`m260md${suffix.slice(-8)}`})
            RETURNING id
          `;
          const [creator, liveUser, completedUser] = fixtureUsers;
          if (!creator || !liveUser || !completedUser) {
            throw new Error("fixture users missing");
          }

          const fixtureInvites = await tx<{ id: string; token_hash: string }[]>`
            INSERT INTO invites (
              token_hash, kind, target_group_id, max_uses, used_count,
              created_by, half_redeemed_at, half_redeemed_user_id, created_at
            ) VALUES
              (
                ${`m260-migration-live-${suffix}`}, 'server', ${targetGroup.id}, NULL, 0,
                ${creator.id}, '2026-01-02 03:04:05', ${liveUser.id}, '2026-01-01 01:02:03'
              ),
              (
                ${`m260-migration-complete-${suffix}`}, 'server', ${targetGroup.id}, NULL, 1,
                ${creator.id}, NULL, ${completedUser.id}, '2026-02-03 04:05:06'
              ),
              (
                ${`m260-migration-unbound-${suffix}`}, 'server', ${targetGroup.id}, NULL, 0,
                ${creator.id}, NULL, NULL, '2026-03-04 05:06:07'
              )
            RETURNING id, token_hash
          `;
          expect(fixtureInvites).toHaveLength(3);

          await tx`DROP TABLE invite_redemptions`;
          await tx.unsafe(migrationBody);

          const redemptions = await tx<
            {
              token_hash: string;
              user_id: string;
              bound_at: string;
              completed_at: string | null;
            }[]
          >`
            SELECT
              i.token_hash,
              r.user_id,
              to_char(r.bound_at, 'YYYY-MM-DD HH24:MI:SS') AS bound_at,
              CASE
                WHEN r.completed_at IS NULL THEN NULL
                ELSE to_char(r.completed_at, 'YYYY-MM-DD HH24:MI:SS')
              END AS completed_at
            FROM invite_redemptions r
            JOIN invites i ON i.id = r.invite_id
            WHERE i.token_hash IN (
              ${`m260-migration-live-${suffix}`},
              ${`m260-migration-complete-${suffix}`},
              ${`m260-migration-unbound-${suffix}`}
            )
            ORDER BY i.token_hash
          `;

          expect([...redemptions]).toEqual([
            {
              token_hash: `m260-migration-complete-${suffix}`,
              user_id: completedUser.id,
              bound_at: "2026-02-03 04:05:06",
              completed_at: "2026-02-03 04:05:06",
            },
            {
              token_hash: `m260-migration-live-${suffix}`,
              user_id: liveUser.id,
              bound_at: "2026-01-02 03:04:05",
              completed_at: null,
            },
          ]);

          const indexRows = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname = 'idx_invite_redemptions_user_id'
          `;
          expect(indexRows[0]?.count).toBe(1);

          completed = true;
          throw new Error("__m260_0167_rollback__");
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("__m260_0167_rollback__");
      }
      expect(completed).toBe(true);
    },
    30_000,
  );
});
