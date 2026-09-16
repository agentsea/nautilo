/**
 * D418 Wave 2 / Stack 193 — executable compatibility cleanup replay.
 *
 * Runs inside a rolled-back transaction. It reconstructs the pre-0100
 * state with the retired Group/Role and their real FK edges, executes the
 * immutable 0100 followed by corrective 0101, and proves the final state
 * is clean, idempotent, and narrowly scoped. A fresh migration sequence may
 * transiently backfill legacy preset rows in 0100 when they exist; 0101
 * removes them before application startup.
 *
 * Clean-db note: in a fresh test-cruft DB, infra:start applies migrations
 * before seedTrustPersonal runs, so the capability catalogue AND the six
 * canonical ladder Groups are both empty here. Fixtures therefore create
 * their own disposable capability and canonical Groups rather than
 * assuming either was seeded; production migration SQL/schema is
 * untouched and every fixture row is discarded by the rollback.
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
let migration0100Body: string;
let migrationBody: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  migration0100Body = stripStatementBreakpoints(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../src/migrations/0100_d418_system_managed_groups.sql",
      ),
      "utf8",
    ),
  );
  migrationBody = stripStatementBreakpoints(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../src/migrations/0101_d418_remove_workstation_preset.sql",
      ),
      "utf8",
    ),
  );
  sql = postgres(resolveDirectDatabaseConnectionString(), { max: 1 });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describe("D418 migration 0101 — retired preset compatibility cleanup", () => {
  test(
    "0100 → 0101 removes retired rows/edges while preserving canonical and unrelated objects",
    async () => {
      let completed = false;
      try {
        await sql.begin(async (tx) => {
          // Normalize any already-migrated scratch DB before reconstructing
          // the superseded local-0100 shape. This also proves an initial
          // execution succeeds against the ambient compatibility state.
          await tx.unsafe(migrationBody);

          const suffix = `${Date.now().toString(36)}${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const [fixtureUser] = await tx<{ id: string }[]>`
            INSERT INTO users (name, email, handle)
            VALUES (
              ${`d418-0101-${suffix}`},
              ${`d418-0101-${suffix}@test.local`},
              ${`d418c${suffix.slice(-8)}`}
            )
            RETURNING id
          `;
          if (!fixtureUser) throw new Error("fixture user missing");

          // The six canonical ladder Groups (owners/admins/superusers/
          // members/contributors/guests) are also seeded by
          // seedTrustPersonal, which runs after infra:start applies
          // migrations. A clean test-cruft DB has none, so 0100 would have
          // no canonical rows to mark system-managed and the
          // canonical_system_count assertion would collapse to 0. Create
          // disposable fixtures mirroring the seeded is_system=true /
          // owner_id=NULL state. ON CONFLICT DO NOTHING on the unique(type)
          // constraint keeps this idempotent on a populated DB where the
          // canonical Groups already exist.
          const canonicalGroupTypes = [
            "owners",
            "admins",
            "superusers",
            "members",
            "contributors",
            "guests",
          ];
          for (const type of canonicalGroupTypes) {
            await tx`
              INSERT INTO "groups" (owner_id, type, label, trust_preset, is_system)
              VALUES (NULL, ${type}, ${type}, 'personal', true)
              ON CONFLICT (type) DO NOTHING
            `;
          }

          // Reconstruct the pre-0100 Groups schema inside this rolled-back
          // transaction. All existing system Groups need a temporary Human
          // owner before owner_id can become NOT NULL and is_system can be
          // removed.
          await tx`ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_system_owner_check"`;
          await tx`
            UPDATE "groups"
            SET owner_id = ${fixtureUser.id}
            WHERE owner_id IS NULL
          `;
          await tx`ALTER TABLE "groups" ALTER COLUMN "owner_id" SET NOT NULL`;
          await tx`ALTER TABLE "groups" DROP COLUMN "is_system"`;

          // The capability catalogue is populated by seedTrustPersonal,
          // which runs after infra:start applies migrations. In a clean
          // test-cruft DB the catalogue is empty at this point, so do not
          // assume it was seeded — create a disposable fixture capability
          // inside this rolled-back transaction and use that. The unique
          // slug keeps it isolated from any catalogue rows that may exist.
          const fixtureCapabilitySlug = `d418-0101-cap-${suffix}`;
          await tx`
            INSERT INTO capabilities (slug, description, category)
            VALUES (
              ${fixtureCapabilitySlug},
              'D418 0101 disposable fixture capability',
              'test-fixture'
            )
            ON CONFLICT (slug) DO NOTHING
          `;
          const [capability] = await tx<{ id: string; slug: string }[]>`
            SELECT id, slug FROM capabilities
            WHERE slug = ${fixtureCapabilitySlug}
          `;
          if (!capability) throw new Error("fixture capability missing");

          const [retiredRole] = await tx<{ id: string }[]>`
            INSERT INTO roles (slug, label, is_system)
            VALUES ('workstation-user', 'Workstation User', false)
            RETURNING id
          `;
          if (!retiredRole) throw new Error("retired role fixture missing");

          const [retiredGroup] = await tx<{ id: string }[]>`
            INSERT INTO "groups" (owner_id, type, label, trust_preset)
            VALUES (
              ${fixtureUser.id},
              'workstation_users',
              'Workstation Users',
              'personal'
            )
            RETURNING id
          `;
          if (!retiredGroup) throw new Error("retired group fixture missing");

          await tx`
            INSERT INTO group_roles (group_id, role_id)
            VALUES (${retiredGroup.id}, ${retiredRole.id})
          `;
          await tx`
            INSERT INTO group_members (group_id, user_id)
            VALUES (${retiredGroup.id}, ${fixtureUser.id})
          `;
          await tx`
            INSERT INTO role_capabilities (role_id, capability_id)
            VALUES (${retiredRole.id}, ${capability.id})
          `;
          const [retiredChallenge] = await tx<{ id: string }[]>`
            INSERT INTO approval_challenges (
              group_id,
              required_capability,
              requested_by,
              action,
              eligible_approvers,
              expires_at
            )
            VALUES (
              ${retiredGroup.id},
              ${capability.slug},
              ${fixtureUser.id},
              'activate_workstation_profile',
              ${JSON.stringify([fixtureUser.id])}::jsonb,
              now() + interval '5 minutes'
            )
            RETURNING id
          `;
          if (!retiredChallenge) {
            throw new Error("retired approval challenge fixture missing");
          }

          const unrelatedRoleSlug = `d418-unrelated-role-${suffix}`;
          const unrelatedGroupType = `d418-unrelated-group-${suffix}`;
          const [unrelatedRole] = await tx<{ id: string }[]>`
            INSERT INTO roles (slug, label, is_system)
            VALUES (${unrelatedRoleSlug}, 'Unrelated Role', false)
            RETURNING id
          `;
          const [unrelatedGroup] = await tx<{ id: string }[]>`
            INSERT INTO "groups" (owner_id, type, label, trust_preset)
            VALUES (
              ${fixtureUser.id},
              ${unrelatedGroupType},
              'Unrelated Group',
              'personal'
            )
            RETURNING id
          `;
          if (!unrelatedRole || !unrelatedGroup) {
            throw new Error("unrelated authorization fixtures missing");
          }
          await tx`
            INSERT INTO group_roles (group_id, role_id)
            VALUES (${unrelatedGroup.id}, ${unrelatedRole.id})
          `;

          // Immutable 0100 transiently marks the six canonical Groups plus
          // the legacy preset Group system-managed, and marks its Role
          // system-managed. This characterizes history; 0101 below owns the
          // corrective removal before application startup.
          await tx.unsafe(migration0100Body);
          const [after0100] = await tx<{
            retired_group_system: boolean;
            retired_group_owner: string | null;
            retired_role_system: boolean;
            canonical_system_count: number;
            unrelated_group_system: boolean;
          }[]>`
            SELECT
              (SELECT is_system FROM "groups"
                WHERE id = ${retiredGroup.id}) AS retired_group_system,
              (SELECT owner_id FROM "groups"
                WHERE id = ${retiredGroup.id}) AS retired_group_owner,
              (SELECT is_system FROM roles
                WHERE id = ${retiredRole.id}) AS retired_role_system,
              (SELECT count(*)::int FROM "groups"
                WHERE type IN (
                  'owners', 'admins', 'superusers',
                  'members', 'contributors', 'guests'
                )
                  AND is_system = true
                  AND owner_id IS NULL) AS canonical_system_count,
              (SELECT is_system FROM "groups"
                WHERE id = ${unrelatedGroup.id}) AS unrelated_group_system
          `;
          expect(after0100).toEqual({
            retired_group_system: true,
            retired_group_owner: null,
            retired_role_system: true,
            canonical_system_count: 6,
            unrelated_group_system: false,
          });

          await tx.unsafe(migrationBody);

          const [removed] = await tx<{
            groups: number;
            roles: number;
            group_roles: number;
            group_members: number;
            role_capabilities: number;
            approval_challenges: number;
          }[]>`
            SELECT
              (SELECT count(*)::int FROM "groups" WHERE id = ${retiredGroup.id}) AS groups,
              (SELECT count(*)::int FROM roles WHERE id = ${retiredRole.id}) AS roles,
              (SELECT count(*)::int FROM group_roles WHERE group_id = ${retiredGroup.id}
                OR role_id = ${retiredRole.id}) AS group_roles,
              (SELECT count(*)::int FROM group_members
                WHERE group_id = ${retiredGroup.id}) AS group_members,
              (SELECT count(*)::int FROM role_capabilities
                WHERE role_id = ${retiredRole.id}) AS role_capabilities,
              (SELECT count(*)::int FROM approval_challenges
                WHERE id = ${retiredChallenge.id}) AS approval_challenges
          `;
          expect(removed).toEqual({
            groups: 0,
            roles: 0,
            group_roles: 0,
            group_members: 0,
            role_capabilities: 0,
            approval_challenges: 0,
          });

          const [canonical] = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM "groups"
            WHERE type IN (
              'owners', 'admins', 'superusers',
              'members', 'contributors', 'guests'
            )
              AND is_system = true
              AND owner_id IS NULL
          `;
          expect(canonical?.count).toBe(6);

          const [unrelated] = await tx<{
            groups: number;
            roles: number;
            edges: number;
          }[]>`
            SELECT
              (SELECT count(*)::int FROM "groups"
                WHERE id = ${unrelatedGroup.id}) AS groups,
              (SELECT count(*)::int FROM roles
                WHERE id = ${unrelatedRole.id}) AS roles,
              (SELECT count(*)::int FROM group_roles
                WHERE group_id = ${unrelatedGroup.id}
                  AND role_id = ${unrelatedRole.id}) AS edges
          `;
          expect(unrelated).toEqual({ groups: 1, roles: 1, edges: 1 });

          // A second execution is a no-op on the already-clean state.
          await tx.unsafe(migrationBody);
          const [afterSecondRun] = await tx<{ groups: number; roles: number }[]>`
            SELECT
              (SELECT count(*)::int FROM "groups"
                WHERE type = 'workstation_users') AS groups,
              (SELECT count(*)::int FROM roles
                WHERE slug = 'workstation-user') AS roles
          `;
          expect(afterSecondRun).toEqual({ groups: 0, roles: 0 });

          completed = true;
          throw new Error("__d418_0101_rollback__");
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("__d418_0101_rollback__");
      }
      expect(completed).toBe(true);
    },
    30_000,
  );
});
