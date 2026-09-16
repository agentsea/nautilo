/**
 * M128 — TP1 populated-DB integration test for migration
 * `0062_m128_groups_server_wide.sql`.
 *
 * Source spec: ISSUE-M128 §5.2 / §12.1 / §15.1 — "the test that would
 * have caught B1." The unit text-shape sibling
 * (`tests/unit/migration-0062-m128.test.ts`) pins the SQL shape; this
 * test actually runs the migration against a populated DB fixture and
 * asserts data integrity.
 *
 * Runs inside a rolled-back transaction (mirrors
 * `tests/integration/migration-0034.test.ts`) so CI / dev DB state is
 * unchanged. Targets the scratch instance via
 * `NAUTILO_INSTANCE_ID` (default `test-cruft` from the test-env
 * preload; operators can target `qa-source` or another scratch instance
 * by setting the env var explicitly).
 *
 * Fixture (per §5.2 populated-DB path):
 *   - 2 Agents (A and B)
 *   - 4 Humans:
 *       H1 — owner of both
 *       H2 — household of A + teammate of B (collapses to single
 *            `members` membership)
 *       H3 — guest of A only
 *       H4 — teammate of B only
 *   - 8 per-Agent group rows (4 types × 2 agents)
 *   - 4 in-flight invites:
 *       kind='agent' (household-of-A)
 *       kind='agent' (teammate-of-B)
 *       kind='agent' (guest-of-A)
 *       kind='server'
 *
 * Asserts (per §5.2):
 *   - `groups` ends with 6 canonical rows (one per ladder slug)
 *   - H1 ∈ owners; H2 ∈ members (dedup: collapsed from two memberships)
 *   - H3 ∈ guests; H4 ∈ members
 *   - No duplicate (group_id, user_id) rows post-collapse
 *   - All 3 kind='agent' invites → kind='group' with correct target
 *   - kind='server' invite unchanged
 *   - groups.agent_id and invites.target_agent_id columns dropped
 *   - UNIQUE(groups.type) enforced
 *
 * Schema-already-collapsed handling: if `0062` has already been
 * applied to the target instance, the post-state columns
 * (`groups.agent_id`, `invites.target_agent_id`, etc.) are gone. The
 * test detects this and re-creates the pre-M128 schema slice inside
 * the rolled-back transaction before seeding fixture rows. The whole
 * thing rolls back on completion, so neither the schema mutations
 * nor the fixture rows persist.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { ensureDatabase, resolveDirectDatabaseConnectionString } from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";


function stripStatementBreakpoints(sqlText: string): string {
  return sqlText.replace(/-->\s*statement-breakpoint/g, "");
}

let sql: ReturnType<typeof postgres>;
let migrationBody: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  const path = resolve(
    import.meta.dirname,
    "../../src/migrations/0062_m128_groups_server_wide.sql",
  );
  migrationBody = stripStatementBreakpoints(readFileSync(path, "utf8"));
  sql = postgres(resolveDirectDatabaseConnectionString(), { max: 1 });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

/**
 * If migration `0062` has been applied to the target instance, the
 * pre-M128 schema slice is gone. Restore it inside the TX so the
 * migration can re-run end-to-end. Idempotent: skips work if the
 * pre-M128 column is already present.
 */
async function restorePreM128SchemaIfNeeded(
  tx: postgres.TransactionSql,
): Promise<{ wasApplied: boolean }> {
  const colCheck = await tx<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'groups' AND column_name = 'agent_id'
    ) AS exists
  `;
  const hasAgentIdColumn = colCheck[0]?.exists === true;
  if (hasAgentIdColumn) {
    return { wasApplied: false };
  }

  // Reverse the schema mutations from the tail of 0062. The FK
  // constraints MUST be created with their drizzle-convention names
  // (`groups_agent_id_agents_id_fk` / `invites_target_agent_id_agents_id_fk`)
  // because 0062's body drops them by that exact name (non-IF-EXISTS).
  // Inline `REFERENCES` would auto-generate a `*_fkey` name and the
  // migration's DROP CONSTRAINT would then fail.
  await tx`DROP INDEX IF EXISTS uq_groups_type`;
  // M131 (migration 0065) dropped `groups.role_id`. Pre-0062 (and through
  // 0064) the column existed and 0062's canonical-group INSERT sets it.
  // Restore it (idempotently) so the fixture INSERTs and the post-0062
  // `role_slug` JOIN below work when replaying 0062 against a post-0065 DB.
  await tx`ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS role_id uuid`;
  await tx`ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_role_id_roles_id_fk"`;
  await tx`
    ALTER TABLE "groups" ADD CONSTRAINT "groups_role_id_roles_id_fk"
      FOREIGN KEY (role_id) REFERENCES roles(id)
  `;
  await tx`ALTER TABLE "groups" ADD COLUMN agent_id uuid`;
  await tx`
    ALTER TABLE "groups" ADD CONSTRAINT "groups_agent_id_agents_id_fk"
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  `;
  await tx`ALTER TABLE "invites" ADD COLUMN target_agent_id uuid`;
  await tx`
    ALTER TABLE "invites" ADD CONSTRAINT "invites_target_agent_id_agents_id_fk"
      FOREIGN KEY (target_agent_id) REFERENCES agents(id) ON DELETE CASCADE
  `;
  await tx`CREATE INDEX idx_groups_agent ON "groups" (agent_id)`;
  // The legacy partial-unique was `(agent_id, type) WHERE agent_id IS NOT NULL`.
  await tx`
    CREATE UNIQUE INDEX uq_groups_agent_id_type
      ON "groups" (agent_id, type)
      WHERE agent_id IS NOT NULL
  `;

  // D219 (migration 0066) dropped `users.server_role`, but 0062's canonical
  // group INSERT still probes it to pick an admin owner. Recreate the legacy
  // slice while replaying 0062 inside this rolled-back transaction.
  await tx`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS server_role text DEFAULT 'user' NOT NULL`;
  await tx`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_server_role_check"`;
  await tx`
    ALTER TABLE "users" ADD CONSTRAINT "users_server_role_check"
      CHECK ("server_role" IN ('admin', 'user'))
  `;
  // Also delete the post-M128 canonical group rows so the migration
  // re-creates them as it would on a true pre-M128 DB.
  await tx`
    DELETE FROM "groups"
    WHERE type IN ('owners', 'admins', 'superusers', 'members', 'contributors', 'guests')
      AND agent_id IS NULL
  `;

  // Migration 0063 (post-0062) tightened the invite-constraint slice:
  //   - invites_kind_chk → {claim, server} only
  //   - invites_group_kind_chk → server invites MUST carry target_group_id
  // To replay 0062 against an already-0063'd DB we must restore the
  // pre-0063 forms so the legacy fixture rows insert: three kind='agent'
  // invites (each with a target_group_id) and one kind='server' invite
  // with a NULL target_group_id. 0062's body re-adds invites_kind_chk to
  // the broad {claim,server,agent,group,room} set itself; we mirror that
  // here so the fixture INSERT (which runs before the migration body)
  // succeeds. All of this rolls back with the rest of the tx.
  await tx`ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_kind_chk"`;
  await tx`
    ALTER TABLE "invites" ADD CONSTRAINT "invites_kind_chk"
      CHECK ("kind" IN ('claim', 'server', 'agent', 'group', 'room'))
  `;
  await tx`ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_group_kind_chk"`;
  await tx`
    ALTER TABLE "invites" ADD CONSTRAINT "invites_group_kind_chk"
      CHECK ("kind" IN ('claim', 'server') OR "target_group_id" IS NOT NULL)
  `;
  return { wasApplied: true };
}

describe("M128 migration 0062 — populated-DB collapse (TP1)", () => {
  test(
    "collapses 4-agent_* groups × 2 agents into 6 canonical Groups; no membership loss; in-flight invites repointed",
    async () => {
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      let ok = false;
      try {
        await sql.begin(async (tx) => {
          // 0. Restore pre-M128 schema slice if migration already applied.
          const { wasApplied } = await restorePreM128SchemaIfNeeded(tx);
          void wasApplied; // diagnostic-only

          // 1. Pre-M128 roles. The post-M128 ladder may already be
          //    seeded in the live DB (seedTrustPersonal runs at boot);
          //    we only need the legacy `household` / `teammate` /
          //    `stranger` slugs to exist for the per-Agent groups'
          //    FK below. `owner` and `guest` may already exist;
          //    ON CONFLICT covers either case.
          await tx`
            INSERT INTO roles (slug, label, is_system) VALUES
              ('owner',     'Owner',     true),
              ('household', 'Household', true),
              ('teammate',  'Teammate',  true),
              ('guest',     'Guest',     true),
              ('stranger',  'Stranger',  true)
            ON CONFLICT (slug) DO NOTHING
          `;

          // 2. 4 Humans.
          const userRows = await tx<{ id: string; handle: string }[]>`
            INSERT INTO users (name, email, handle) VALUES
              (${`h1-${suffix}`}, ${`h1-${suffix}@t`}, ${`h1${suffix.slice(-6)}`}),
              (${`h2-${suffix}`}, ${`h2-${suffix}@t`}, ${`h2${suffix.slice(-6)}`}),
              (${`h3-${suffix}`}, ${`h3-${suffix}@t`}, ${`h3${suffix.slice(-6)}`}),
              (${`h4-${suffix}`}, ${`h4-${suffix}@t`}, ${`h4${suffix.slice(-6)}`})
            RETURNING id, handle
          `;
          expect(userRows.length).toBe(4);
          const [h1, h2, h3, h4] = userRows;
          if (!h1 || !h2 || !h3 || !h4) throw new Error("user-seed-failed");

          // 3. user-actor rows (required by group_members.granted_by FK
          //    and invites.created_by_actor_id contract).
          const actorRows = await tx<{ id: string; owner_id: string }[]>`
            INSERT INTO actors (owner_id, display_name, trust_state, kind) VALUES
              (${h1.id}, ${`h1-actor`}, 'verified', 'user'),
              (${h2.id}, ${`h2-actor`}, 'verified', 'user'),
              (${h3.id}, ${`h3-actor`}, 'verified', 'user'),
              (${h4.id}, ${`h4-actor`}, 'verified', 'user')
            RETURNING id, owner_id
          `;
          const actorByUser = new Map(actorRows.map((a) => [a.owner_id, a.id]));

          // 4. 2 Agents (A and B), each with its agent-actor mirror.
          //    Note: `agents` schema today has only id/handle/
          //    customization/timestamps — there is no `owner_id` or `kind`
          //    on the agents row. The Agent→User binding lives in `actors`
          //    via (kind='agent', agent_id, owner_id). Per-Agent groups
          //    referenced the agent via `groups.agent_id`.
          const agentRows = await tx<{ id: string; handle: string }[]>`
            INSERT INTO agents (handle) VALUES
              (${`agentA-${suffix.slice(-6)}`}),
              (${`agentB-${suffix.slice(-6)}`})
            RETURNING id, handle
          `;
          const [agentA, agentB] = agentRows;
          if (!agentA || !agentB) throw new Error("agent-seed-failed");

          await tx`
            INSERT INTO actors (owner_id, display_name, trust_state, kind, agent_id) VALUES
              (${h1.id}, ${"Agent A"}, 'verified', 'agent', ${agentA.id}),
              (${h1.id}, ${"Agent B"}, 'verified', 'agent', ${agentB.id})
          `;

          // 5. 8 per-Agent groups (4 types × 2 agents). Resolve role ids
          //    by slug. agent_* group type → role slug mapping mirrors
          //    the pre-M128 seed shape.
          const roleRows = await tx<{ slug: string; id: string }[]>`
            SELECT slug, id FROM roles
            WHERE slug IN ('owner', 'household', 'teammate', 'guest')
          `;
          const roleBySlug = new Map(roleRows.map((r) => [r.slug, r.id]));
          const roleIdFor = (typ: string): string => {
            const slug =
              typ === "agent_ownership" ? "owner" :
              typ === "agent_household" ? "household" :
              typ === "agent_teammate" ? "teammate" :
              "guest";
            const id = roleBySlug.get(slug);
            if (!id) throw new Error(`role-missing:${slug}`);
            return id;
          };

          const groupTypes = [
            "agent_ownership",
            "agent_household",
            "agent_teammate",
            "agent_guest",
          ] as const;

          const perAgentGroupRows: Array<{ id: string; agent_id: string; type: string }> = [];
          for (const a of [agentA, agentB]) {
            for (const typ of groupTypes) {
              const inserted = await tx<{ id: string; agent_id: string; type: string }[]>`
                INSERT INTO "groups" (owner_id, agent_id, type, label, trust_preset, role_id)
                VALUES (${h1.id}, ${a.id}, ${typ}, ${`${typ}-${a.handle}`}, 'personal', ${roleIdFor(typ)})
                RETURNING id, agent_id, type
              `;
              if (!inserted[0]) throw new Error("group-seed-failed");
              perAgentGroupRows.push(inserted[0]);
            }
          }
          expect(perAgentGroupRows.length).toBe(8);

          function groupId(agentId: string, typ: string): string {
            const row = perAgentGroupRows.find(
              (g) => g.agent_id === agentId && g.type === typ,
            );
            if (!row) throw new Error(`group-missing:${agentId}:${typ}`);
            return row.id;
          }

          // 6. group_members per fixture spec:
          //    H1 ∈ agent_ownership of A AND of B
          //    H2 ∈ agent_household of A AND agent_teammate of B
          //    H3 ∈ agent_guest of A
          //    H4 ∈ agent_teammate of B
          const h1Actor = actorByUser.get(h1.id)!;
          await tx`
            INSERT INTO group_members (group_id, user_id, granted_by) VALUES
              (${groupId(agentA.id, "agent_ownership")}, ${h1.id}, ${h1Actor}),
              (${groupId(agentB.id, "agent_ownership")}, ${h1.id}, ${h1Actor}),
              (${groupId(agentA.id, "agent_household")}, ${h2.id}, ${h1Actor}),
              (${groupId(agentB.id, "agent_teammate")},  ${h2.id}, ${h1Actor}),
              (${groupId(agentA.id, "agent_guest")},     ${h3.id}, ${h1Actor}),
              (${groupId(agentB.id, "agent_teammate")},  ${h4.id}, ${h1Actor})
          `;

          // 7. 4 in-flight invites.
          //    Token-hash dedup: include suffix.
          //    Note: the `invites` schema today has no `created_by_actor_id`
          //    column; we use only `created_by` (user id). The kind='server'
          //    invite points at `agent_household-of-A`, which the migration
          //    will delete; in production kind='server' invites point at a
          //    canonical Group, but here we deliberately test that the UPDATE
          //    in step 3 does NOT touch this row (it's not kind='agent').
          //    Note: `invites_group_kind_chk` requires `target_group_id`
          //    on non-{claim,server} rows, so kind='agent' invites must
          //    also pre-carry a `target_group_id` pointing at the
          //    corresponding per-Agent group. Migration step 3 will
          //    UPDATE this to the canonical post-M128 group id.
          const inv = await tx<{ id: string; kind: string; target_group_id: string | null; target_agent_id: string | null }[]>`
            INSERT INTO invites (
              token_hash, kind, max_uses, used_count,
              created_by, expires_at,
              target_agent_id, target_group_id
            )
            VALUES
              (${`tok-h-${suffix}`}, 'agent',  1, 0, ${h1.id}, NULL, ${agentA.id}, ${groupId(agentA.id, "agent_household")}),
              (${`tok-t-${suffix}`}, 'agent',  1, 0, ${h1.id}, NULL, ${agentB.id}, ${groupId(agentB.id, "agent_teammate")}),
              (${`tok-g-${suffix}`}, 'agent',  1, 0, ${h1.id}, NULL, ${agentA.id}, ${groupId(agentA.id, "agent_guest")}),
              (${`tok-s-${suffix}`}, 'server', 1, 0, ${h1.id}, NULL, NULL,         NULL)
            RETURNING id, kind, target_group_id, target_agent_id
          `;
          expect(inv.length).toBe(4);
          const invByToken = (tag: string) => {
            const row = inv.find((_, idx) => idx === ({ h: 0, t: 1, g: 2, s: 3 })[tag]!);
            if (!row) throw new Error(`invite-missing:${tag}`);
            return row;
          };

          // Pre-migration sanity: per-agent groups visible
          const preCount = await tx<{ c: number }[]>`
            SELECT count(*)::int AS c FROM "groups" WHERE agent_id IS NOT NULL
          `;
          expect(preCount[0]?.c).toBeGreaterThanOrEqual(8);

          // 8. Run the migration body.
          await tx.unsafe(migrationBody);

          // ============================================================
          // Assertions — post-migration state
          // ============================================================

          // 8a. groups table: 6 canonical rows present.
          const canonicalGroupRows = await tx<{ type: string; id: string; role_slug: string }[]>`
            SELECT g.type, g.id, r.slug AS role_slug
            FROM "groups" g
            JOIN "roles" r ON r.id = g.role_id
            WHERE g.type IN ('owners', 'admins', 'superusers', 'members', 'contributors', 'guests')
            ORDER BY g.type
          `;
          const canonicalTypes = canonicalGroupRows.map((g) => g.type).sort();
          expect(canonicalTypes).toEqual(
            ["admins", "contributors", "guests", "members", "owners", "superusers"].sort(),
          );

          const canonicalById = new Map(canonicalGroupRows.map((g) => [g.type, g.id]));
          const owners = canonicalById.get("owners");
          const members = canonicalById.get("members");
          const guests = canonicalById.get("guests");
          expect(owners).toBeTruthy();
          expect(members).toBeTruthy();
          expect(guests).toBeTruthy();

          // 8b. Membership collapse:
          //   H1 ∈ owners (collapsed from 2 agent_ownership rows)
          //   H2 ∈ members (collapsed from agent_household-of-A + agent_teammate-of-B)
          //   H3 ∈ guests  (agent_guest-of-A)
          //   H4 ∈ members (agent_teammate-of-B)
          const h1Owners = await tx<{ c: number }[]>`
            SELECT count(*)::int AS c FROM group_members
            WHERE user_id = ${h1.id} AND group_id = ${owners!}
          `;
          expect(h1Owners[0]?.c).toBe(1);

          const h2Members = await tx<{ c: number }[]>`
            SELECT count(*)::int AS c FROM group_members
            WHERE user_id = ${h2.id} AND group_id = ${members!}
          `;
          expect(h2Members[0]?.c).toBe(1);

          const h3Guests = await tx<{ c: number }[]>`
            SELECT count(*)::int AS c FROM group_members
            WHERE user_id = ${h3.id} AND group_id = ${guests!}
          `;
          expect(h3Guests[0]?.c).toBe(1);

          const h4Members = await tx<{ c: number }[]>`
            SELECT count(*)::int AS c FROM group_members
            WHERE user_id = ${h4.id} AND group_id = ${members!}
          `;
          expect(h4Members[0]?.c).toBe(1);

          // 8c. No duplicate (group_id, user_id) rows for any fixture user.
          const dupes = await tx<{ user_id: string; group_id: string; c: number }[]>`
            SELECT user_id, group_id, count(*)::int AS c
            FROM group_members
            WHERE user_id IN (${h1.id}, ${h2.id}, ${h3.id}, ${h4.id})
            GROUP BY user_id, group_id
            HAVING count(*) > 1
          `;
          expect(dupes.length).toBe(0);

          // 8d. agent_* groups are gone.
          const remainingAgentGroups = await tx<{ c: number }[]>`
            SELECT count(*)::int AS c FROM "groups" WHERE type LIKE 'agent_%'
          `;
          expect(remainingAgentGroups[0]?.c).toBe(0);

          // 8e. groups.agent_id column is dropped post-migration.
          const colExistsAfter = await tx<{ exists: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'groups' AND column_name = 'agent_id'
            ) AS exists
          `;
          expect(colExistsAfter[0]?.exists).toBe(false);

          // 8f. invites.target_agent_id column is dropped.
          const invColAfter = await tx<{ exists: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'invites' AND column_name = 'target_agent_id'
            ) AS exists
          `;
          expect(invColAfter[0]?.exists).toBe(false);

          // 8g. UNIQUE(groups.type) enforced.
          const uniqueIdxExists = await tx<{ exists: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_indexes
              WHERE tablename = 'groups' AND indexname = 'uq_groups_type'
            ) AS exists
          `;
          expect(uniqueIdxExists[0]?.exists).toBe(true);

          // 8h. In-flight invites repointed.
          //   3 kind='agent' invites became kind='group'.
          //   household-of-A → members; teammate-of-B → members; guest-of-A → guests.
          //   kind='server' invite unchanged.
          const householdInvite = await tx<{ kind: string; target_group_id: string | null }[]>`
            SELECT kind, target_group_id FROM invites WHERE id = ${invByToken("h").id}
          `;
          expect(householdInvite[0]?.kind).toBe("group");
          expect(householdInvite[0]?.target_group_id).toBe(members);

          const teammateInvite = await tx<{ kind: string; target_group_id: string | null }[]>`
            SELECT kind, target_group_id FROM invites WHERE id = ${invByToken("t").id}
          `;
          expect(teammateInvite[0]?.kind).toBe("group");
          expect(teammateInvite[0]?.target_group_id).toBe(members);

          const guestInvite = await tx<{ kind: string; target_group_id: string | null }[]>`
            SELECT kind, target_group_id FROM invites WHERE id = ${invByToken("g").id}
          `;
          expect(guestInvite[0]?.kind).toBe("group");
          expect(guestInvite[0]?.target_group_id).toBe(guests);

          const serverInvite = await tx<{ kind: string; target_group_id: string | null }[]>`
            SELECT kind, target_group_id FROM invites WHERE id = ${invByToken("s").id}
          `;
          expect(serverInvite[0]?.kind).toBe("server");
          // Fixture seeded `target_group_id = NULL` to stay clear of the
          // step-4 cascade-delete (`groups.agent_id IS NOT NULL` rows
          // disappear; any FK from invites would CASCADE). The migration
          // step 3 UPDATE is `WHERE kind = 'agent'`, so the kind='server'
          // row's kind + target should remain exactly as inserted.
          expect(serverInvite[0]?.target_group_id).toBeNull();

          ok = true;
          throw new Error("__m128_rollback__");
        });
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toBe("__m128_rollback__");
      }
      expect(ok).toBe(true);
    },
    30_000, // 30s timeout — schema mutations + ~30 INSERTs + migration body
  );
});
