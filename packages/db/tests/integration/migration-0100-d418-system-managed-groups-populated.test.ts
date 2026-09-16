/**
 * D418 Wave 2 — executable populated-DB replay for migration 0100.
 *
 * The live scratch DB normally already has 0100 applied. Inside a transaction
 * this test restores the pre-0100 groups slice, seeds canonical,
 * workstation_users, and ordinary user-managed data, executes the real SQL,
 * proves data/edge/lifecycle invariants, then deliberately rolls everything
 * back.
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
      resolve(
        import.meta.dirname,
        "../../src/migrations/0100_d418_system_managed_groups.sql",
      ),
      "utf8",
    ),
  );
  sql = postgres(resolveDirectDatabaseConnectionString(), { max: 1 });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

async function captureCheckViolation(
  tx: postgres.TransactionSql,
  savepoint: string,
  statement: string,
): Promise<{ code?: string; constraint_name?: string }> {
  await tx.unsafe(`SAVEPOINT ${savepoint}`);
  try {
    await tx.unsafe(statement);
  } catch (err) {
    await tx.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return err as { code?: string; constraint_name?: string };
  }
  await tx.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
  throw new Error(`expected CHECK violation at ${savepoint}`);
}

describe("D418 migration 0100 — populated system-managed Groups replay", () => {
  test(
    "backfills system rows without losing memberships/edges and preserves user-managed lifecycle",
    async () => {
      let completed = false;
      try {
        await sql.begin(async (tx) => {
          const suffix = `${Date.now().toString(36)}${Math.random()
            .toString(36)
            .slice(2, 8)}`;

          const fixtureUsers = await tx<{ id: string }[]>`
            INSERT INTO users (name, email, handle) VALUES
              (${`d418-mig-owner-${suffix}`}, ${`d418-mig-owner-${suffix}@test.local`}, ${`d418mo${suffix.slice(-8)}`}),
              (${`d418-mig-member-${suffix}`}, ${`d418-mig-member-${suffix}@test.local`}, ${`d418mm${suffix.slice(-8)}`})
            RETURNING id
          `;
          const formerOwner = fixtureUsers[0];
          const survivingMember = fixtureUsers[1];
          if (!formerOwner || !survivingMember) {
            throw new Error("fixture users missing");
          }
          const [ownerActor] = await tx<{ id: string }[]>`
            INSERT INTO actors (owner_id, display_name, trust_state, kind)
            VALUES (${formerOwner.id}, 'D418 migration owner', 'verified', 'user')
            RETURNING id
          `;
          if (!ownerActor) throw new Error("fixture actor missing");

          // Restore the pre-0100 schema slice. Existing system groups have
          // NULL owners on the migrated DB, so assign the fixture Human before
          // re-applying NOT NULL and dropping is_system.
          await tx`ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_system_owner_check"`;
          await tx`
            UPDATE "groups"
            SET owner_id = ${formerOwner.id}
            WHERE owner_id IS NULL
          `;
          await tx`ALTER TABLE "groups" ALTER COLUMN "owner_id" SET NOT NULL`;
          await tx`ALTER TABLE "groups" DROP COLUMN "is_system"`;

          // Explicitly seed/upsert the six populated canonical rows in their
          // pre-0100 shape. This is deterministic even if the scratch DB was
          // only migrated (not trust-seeded) before the test.
          await tx`
            INSERT INTO "groups" (owner_id, type, label, trust_preset) VALUES
              (${formerOwner.id}, 'owners',       'Owners',       'personal'),
              (${formerOwner.id}, 'admins',       'Admins',       'personal'),
              (${formerOwner.id}, 'superusers',   'Superusers',   'personal'),
              (${formerOwner.id}, 'members',      'Members',      'personal'),
              (${formerOwner.id}, 'contributors', 'Contributors', 'personal'),
              (${formerOwner.id}, 'guests',       'Guests',       'personal')
            ON CONFLICT (type) DO UPDATE
            SET owner_id = EXCLUDED.owner_id,
                label = EXCLUDED.label,
                trust_preset = EXCLUDED.trust_preset
          `;
          const canonical = await tx<{ id: string; type: string }[]>`
            SELECT id, type FROM "groups"
            WHERE type IN ('owners','admins','superusers','members','contributors','guests')
            ORDER BY type
          `;
          expect(canonical).toHaveLength(6);

          let [workstationGroup] = await tx<{ id: string }[]>`
            SELECT id FROM "groups" WHERE type = 'workstation_users'
          `;
          if (!workstationGroup) {
            [workstationGroup] = await tx<{ id: string }[]>`
              INSERT INTO "groups" (owner_id, type, label, trust_preset)
              VALUES (${formerOwner.id}, 'workstation_users', 'Workstation Users', 'personal')
              RETURNING id
            `;
          }
          if (!workstationGroup) throw new Error("workstation group missing");

          const ordinaryType = `d418-ordinary-${suffix}`;
          const [ordinaryGroup] = await tx<{ id: string }[]>`
            INSERT INTO "groups" (owner_id, type, label, trust_preset)
            VALUES (${formerOwner.id}, ${ordinaryType}, 'Ordinary Group', 'personal')
            RETURNING id
          `;
          if (!ordinaryGroup) throw new Error("ordinary group missing");

          let [workstationRole] = await tx<{ id: string }[]>`
            SELECT id FROM roles WHERE slug = 'workstation-user'
          `;
          if (!workstationRole) {
            [workstationRole] = await tx<{ id: string }[]>`
              INSERT INTO roles (slug, label, is_system)
              VALUES ('workstation-user', 'Workstation User', false)
              RETURNING id
            `;
          } else {
            await tx`
              UPDATE roles SET is_system = false
              WHERE id = ${workstationRole.id}
            `;
          }
          if (!workstationRole) throw new Error("workstation role missing");

          const [capability] = await tx<{ id: string }[]>`
            SELECT id FROM capabilities
            WHERE slug = 'use_workstation_profiles'
          `;
          if (!capability) throw new Error("workstation capability missing");

          await tx`
            INSERT INTO group_roles (group_id, role_id)
            VALUES (${workstationGroup.id}, ${workstationRole.id})
            ON CONFLICT DO NOTHING
          `;
          await tx`
            INSERT INTO role_capabilities (role_id, capability_id)
            VALUES (${workstationRole.id}, ${capability.id})
            ON CONFLICT DO NOTHING
          `;
          const ownersGroup = canonical.find((row) => row.type === "owners");
          if (!ownersGroup) throw new Error("owners group missing");
          await tx`
            INSERT INTO group_members (group_id, user_id, granted_by) VALUES
              (${ownersGroup.id}, ${survivingMember.id}, ${ownerActor.id}),
              (${workstationGroup.id}, ${survivingMember.id}, ${ownerActor.id})
            ON CONFLICT DO NOTHING
          `;

          // Execute the actual 0100 migration body.
          await tx.unsafe(migrationBody);

          const systemRows = await tx<{
            type: string;
            owner_id: string | null;
            is_system: boolean;
          }[]>`
            SELECT type, owner_id, is_system FROM "groups"
            WHERE type IN (
              'owners','admins','superusers','members','contributors','guests',
              'workstation_users'
            )
            ORDER BY type
          `;
          expect(systemRows).toHaveLength(7);
          expect(systemRows.every((row) => row.is_system)).toBe(true);
          expect(systemRows.every((row) => row.owner_id === null)).toBe(true);

          const [ordinaryAfter] = await tx<{
            owner_id: string | null;
            is_system: boolean;
          }[]>`
            SELECT owner_id, is_system FROM "groups"
            WHERE id = ${ordinaryGroup.id}
          `;
          expect(ordinaryAfter?.owner_id).toBe(formerOwner.id);
          expect(ordinaryAfter?.is_system).toBe(false);

          const preservedMemberships = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM group_members
            WHERE user_id = ${survivingMember.id}
              AND group_id IN (${ownersGroup.id}, ${workstationGroup.id})
          `;
          expect(preservedMemberships[0]?.count).toBe(2);
          const preservedRoleEdge = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM group_roles
            WHERE group_id = ${workstationGroup.id}
              AND role_id = ${workstationRole.id}
          `;
          expect(preservedRoleEdge[0]?.count).toBe(1);
          const preservedCapabilityEdge = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM role_capabilities
            WHERE role_id = ${workstationRole.id}
              AND capability_id = ${capability.id}
          `;
          expect(preservedCapabilityEdge[0]?.count).toBe(1);
          const [roleAfter] = await tx<{ is_system: boolean }[]>`
            SELECT is_system FROM roles WHERE id = ${workstationRole.id}
          `;
          expect(roleAfter?.is_system).toBe(true);

          const invalidSystem = await captureCheckViolation(
            tx,
            "d418_invalid_system",
            `INSERT INTO "groups" (owner_id, type, label, trust_preset, is_system)
             VALUES ('${formerOwner.id}', 'd418-invalid-system-${suffix}', 'bad', 'personal', true)`,
          );
          expect(invalidSystem.code).toBe("23514");
          expect(invalidSystem.constraint_name).toBe(
            "groups_system_owner_check",
          );
          const invalidUser = await captureCheckViolation(
            tx,
            "d418_invalid_user",
            `INSERT INTO "groups" (owner_id, type, label, trust_preset, is_system)
             VALUES (NULL, 'd418-invalid-user-${suffix}', 'bad', 'personal', false)`,
          );
          expect(invalidUser.code).toBe("23514");
          expect(invalidUser.constraint_name).toBe(
            "groups_system_owner_check",
          );

          // User-managed lifecycle remains CASCADE, while system definitions
          // and other Humans' memberships survive deletion of their former
          // pre-0100 Human owner/grantor.
          await tx`DELETE FROM users WHERE id = ${formerOwner.id}`;
          const systemAfterDelete = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM "groups"
            WHERE type IN (
              'owners','admins','superusers','members','contributors','guests',
              'workstation_users'
            )
          `;
          expect(systemAfterDelete[0]?.count).toBe(7);
          const membershipsAfterDelete = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM group_members
            WHERE user_id = ${survivingMember.id}
              AND group_id IN (${ownersGroup.id}, ${workstationGroup.id})
          `;
          expect(membershipsAfterDelete[0]?.count).toBe(2);
          const ordinaryAfterDelete = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM "groups"
            WHERE id = ${ordinaryGroup.id}
          `;
          expect(ordinaryAfterDelete[0]?.count).toBe(0);

          completed = true;
          throw new Error("__d418_0100_rollback__");
        });
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe("__d418_0100_rollback__");
      }
      expect(completed).toBe(true);
    },
    30_000,
  );
});
