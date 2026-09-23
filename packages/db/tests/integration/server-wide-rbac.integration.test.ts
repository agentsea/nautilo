/**
 * M128 — T15 server-wide RBAC integration test (MVS #6 + #9) + TP11
 * ladder coverage (MVS #2) via direct group_members INSERTs.
 *
 * Source spec: ISSUE-M128 §5.1 / §12.3 (T15), §5.2 / §12.2 (TP11).
 *
 * Covers:
 *   MVS #2 — ladder coverage: for each canonical Group,
 *     a fixture user inserted into that Group receives the exact
 *     ROLE_CAPABILITIES bundle for that rung (mirror of §6 grid).
 *   MVS #6 — server-wide caps: a user inserted into two Groups
 *     (member + admin) receives the UNION across them. There is no
 *     per-Agent dimension at the cap layer.
 *   MVS #9 — approver pool routing: every Human in any Group whose
 *     Role bundles `approve_destructive_actions` is returned by
 *     `findUsersWithCapability(...)`. Per §6, that's owner + admin +
 *     superuser; member / contributor / guest are NOT in the pool.
 *
 * Runs inside a rolled-back transaction against the scratch instance
 * (`NAUTILO_INSTANCE_ID=qa-source` is supported; default `test-cruft`
 * from `tests/test-env-preload.ts`). The assertion queries replicate
 * the JOIN chain used by `getUserCapabilities` /
 * `findUsersWithCapability` directly so the test sees fixture rows
 * that live only inside the rolled-back TX.
 *
 * Scope note: full HTTP redemption (P /api/invites/:token/redeem) is
 * NOT exercised here — it requires a real LogtoAdminClient + the full
 * setupOwnerAppFixture harness. The cap-grant half of MVS #2 is what
 * regresses if the JOIN chain breaks, and that's covered. The HTTP
 * half is covered by the existing redeem-invite tests in @nautilo/server.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { ensureDatabase, resolveDirectDatabaseConnectionString } from "@nautilo/db";
import { M128_ROLE_CAPABILITIES, M128_CAPABILITY_SLUGS, M128_ROLE_SLUGS } from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";
import {
  CUSTOM_ROLE_COMPATIBILITY_GRANTS,
  RETIRED_CAPABILITY_REPLACEMENTS,
  seedTrustPersonal,
} from "../../src/utils/seed-trust-personal";


let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  sql = postgres(resolveDirectDatabaseConnectionString(), { max: 1 });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

const LADDER: ReadonlyArray<{ groupType: string; roleSlug: string }> = [
  { groupType: "owners", roleSlug: "owner" },
  { groupType: "admins", roleSlug: "admin" },
  { groupType: "superusers", roleSlug: "superuser" },
  { groupType: "members", roleSlug: "member" },
  { groupType: "contributors", roleSlug: "contributor" },
  { groupType: "communities", roleSlug: "community" },
  { groupType: "guests", roleSlug: "guest" },
];

describe("D556 retired capability reconciliation", () => {
  test("a custom Role holding the former high-impact grant receives exactly the six ordinary replacement surfaces", () => {
    expect(RETIRED_CAPABILITY_REPLACEMENTS["use_high_impact_tools"]).toEqual([
      "use_project_content",
      "use_project_execution",
      "use_workstation",
      "use_remote_hosts",
      "use_connections",
      "use_media_generation",
    ]);
  });

  test("fragmented terminal/profile grants converge on workstation and the unused destructive slug has no replacement", () => {
    expect(RETIRED_CAPABILITY_REPLACEMENTS["use_terminal"]).toEqual([
      "use_workstation",
    ]);
    expect(RETIRED_CAPABILITY_REPLACEMENTS["use_workstation_profiles"]).toEqual(
      ["use_workstation"],
    );
    expect(RETIRED_CAPABILITY_REPLACEMENTS["use_destructive_tools"]).toEqual(
      [],
    );
  });

  test("real seed migrates and prunes every retired custom-Role grant idempotently", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const ownerRows = await sql<{ id: string }[]>`
      INSERT INTO users (name, email, handle)
      VALUES (${`d556-seed-${suffix}`}, ${`d556-seed-${suffix}@t`}, ${`ds${suffix.slice(-6)}`})
      RETURNING id
    `;
    const ownerId = ownerRows[0]!.id;
    const legacySlugs = [
      "use_high_impact_tools",
      "use_terminal",
      "use_workstation_profiles",
      "use_destructive_tools",
    ];
    const roleSlugs = {
      hil: `d556-hil-${suffix}`,
      terminal: `d556-terminal-${suffix}`,
      profile: `d556-profile-${suffix}`,
      destructive: `d556-destructive-${suffix}`,
      overlap: `d556-overlap-${suffix}`,
      unrelated: `d556-unrelated-${suffix}`,
    };

    try {
      // Establish the current catalogue first, then recreate the exact
      // populated legacy state a subsequent startup must reconcile.
      await seedTrustPersonal(ownerId, `D556 seed ${suffix}`);
      for (const slug of legacySlugs) {
        await sql`
          INSERT INTO capabilities (slug, description, category)
          VALUES (${slug}, ${slug}, 'tools')
          ON CONFLICT (slug) DO NOTHING
        `;
      }
      for (const slug of Object.values(roleSlugs)) {
        await sql`
          INSERT INTO roles (slug, label, is_system)
          VALUES (${slug}, ${slug}, false)
        `;
      }

      const assignments: Readonly<Record<string, readonly string[]>> = {
        [roleSlugs.hil]: ["use_high_impact_tools"],
        [roleSlugs.terminal]: ["use_terminal"],
        [roleSlugs.profile]: ["use_workstation_profiles"],
        [roleSlugs.destructive]: ["use_destructive_tools"],
        [roleSlugs.overlap]: [...legacySlugs],
        [roleSlugs.unrelated]: ["use_high_impact_tools", "use_research_tools"],
      };
      for (const [roleSlug, capabilitySlugs] of Object.entries(assignments)) {
        for (const capabilitySlug of capabilitySlugs) {
          await sql`
            INSERT INTO role_capabilities (role_id, capability_id)
            SELECT roles.id, capabilities.id
            FROM roles, capabilities
            WHERE roles.slug = ${roleSlug} AND capabilities.slug = ${capabilitySlug}
            ON CONFLICT (role_id, capability_id) DO NOTHING
          `;
        }
      }

      await seedTrustPersonal(ownerId, `D556 seed ${suffix}`);
      await seedTrustPersonal(ownerId, `D556 seed ${suffix}`);

      const replacementSlugs = RETIRED_CAPABILITY_REPLACEMENTS["use_high_impact_tools"]!;
      const expected: Readonly<Record<string, readonly string[]>> = {
        [roleSlugs.hil]: [...replacementSlugs, "use_server_provider_credentials"],
        [roleSlugs.terminal]: ["use_workstation"],
        [roleSlugs.profile]: ["use_workstation"],
        [roleSlugs.destructive]: [],
        [roleSlugs.overlap]: [...replacementSlugs, "use_server_provider_credentials"],
        [roleSlugs.unrelated]: [...replacementSlugs, "use_research_tools", "use_server_provider_credentials"].sort(),
      };
      for (const [roleSlug, expectedSlugs] of Object.entries(expected)) {
        const rows = await sql<{ slug: string }[]>`
          SELECT capabilities.slug
          FROM role_capabilities
          INNER JOIN roles ON roles.id = role_capabilities.role_id
          INNER JOIN capabilities ON capabilities.id = role_capabilities.capability_id
          WHERE roles.slug = ${roleSlug}
          ORDER BY capabilities.slug
        `;
        expect(rows.map((row) => row.slug)).toEqual([...expectedSlugs].sort());
      }

      const retiredCapabilities = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM capabilities
        WHERE slug = ANY(${legacySlugs as unknown as string[]})
      `;
      const retiredGrants = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM role_capabilities
        INNER JOIN capabilities ON capabilities.id = role_capabilities.capability_id
        WHERE capabilities.slug = ANY(${legacySlugs as unknown as string[]})
      `;
      expect(retiredCapabilities[0]?.count).toBe(0);
      expect(retiredGrants[0]?.count).toBe(0);
    } finally {
      await sql`
        DELETE FROM role_capabilities
        WHERE role_id IN (SELECT id FROM roles WHERE slug = ANY(${Object.values(roleSlugs) as unknown as string[]}))
      `;
      await sql`DELETE FROM roles WHERE slug = ANY(${Object.values(roleSlugs) as unknown as string[]})`;
      await sql`DELETE FROM group_members WHERE user_id = ${ownerId}`;
      await sql`DELETE FROM channel_identities WHERE user_id = ${ownerId}`;
      await sql`DELETE FROM actors WHERE owner_id = ${ownerId}`;
      await sql`DELETE FROM users WHERE id = ${ownerId}`;
    }
  }, 60_000);
});

describe("custom Role funding compatibility reconciliation", () => {
  test("widens historical entrances idempotently and preserves effective custom-Group, union, Guest, and Community boundaries", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const userRows = await sql<{ id: string; name: string }[]>`
      INSERT INTO users (name, email, handle)
      VALUES
        (${`funding-seed-${suffix}`}, ${`funding-seed-${suffix}@t`}, ${`fs${suffix.slice(-6)}`}),
        (${`funding-effective-${suffix}`}, ${`funding-effective-${suffix}@t`}, ${`fe${suffix.slice(-6)}`}),
        (${`funding-union-${suffix}`}, ${`funding-union-${suffix}@t`}, ${`fu${suffix.slice(-6)}`}),
        (${`funding-guest-${suffix}`}, ${`funding-guest-${suffix}@t`}, ${`fg${suffix.slice(-6)}`})
      RETURNING id, name
    `;
    const userIdByName = new Map(userRows.map((row) => [row.name, row.id]));
    const ownerId = userIdByName.get(`funding-seed-${suffix}`)!;
    const effectiveUserId = userIdByName.get(`funding-effective-${suffix}`)!;
    const unionUserId = userIdByName.get(`funding-union-${suffix}`)!;
    const guestUserId = userIdByName.get(`funding-guest-${suffix}`)!;
    const fixtureUserIds = [ownerId, effectiveUserId, unionUserId, guestUserId];
    const sourceSlugs = Object.keys(CUSTOM_ROLE_COMPATIBILITY_GRANTS);
    const roleSlugs = [
      ...sourceSlugs.map((source) => `compat-${source}-${suffix}`),
      `compat-both-${suffix}`,
      `compat-neither-${suffix}`,
    ];
    const customGroupTypes = [
      `compat-effective-${suffix}`,
      `compat-union-a-${suffix}`,
      `compat-union-b-${suffix}`,
    ];

    const customRoleGrantSnapshot = async (): Promise<readonly string[]> => {
      const rows = await sql<{ role_slug: string; capability_slug: string }[]>`
        SELECT roles.slug AS role_slug, capabilities.slug AS capability_slug
        FROM role_capabilities
        INNER JOIN roles ON roles.id = role_capabilities.role_id
        INNER JOIN capabilities ON capabilities.id = role_capabilities.capability_id
        WHERE roles.slug = ANY(${roleSlugs as unknown as string[]})
        ORDER BY roles.slug, capabilities.slug
      `;
      return rows.map((row) => `${row.role_slug}:${row.capability_slug}`);
    };

    const effectiveCapabilities = async (userId: string): Promise<readonly string[]> => {
      const rows = await sql<{ slug: string }[]>`
        SELECT DISTINCT capabilities.slug
        FROM group_members
        INNER JOIN "groups" ON "groups".id = group_members.group_id
        INNER JOIN group_roles ON group_roles.group_id = "groups".id
        INNER JOIN roles ON roles.id = group_roles.role_id
        INNER JOIN role_capabilities ON role_capabilities.role_id = roles.id
        INNER JOIN capabilities ON capabilities.id = role_capabilities.capability_id
        WHERE group_members.user_id = ${userId}
        ORDER BY capabilities.slug
      `;
      return rows.map((row) => row.slug);
    };

    try {
      await seedTrustPersonal(ownerId, `Funding seed ${suffix}`);
      for (const slug of roleSlugs) {
        await sql`
          INSERT INTO roles (slug, label, is_system)
          VALUES (${slug}, ${slug}, false)
        `;
      }
      for (const sourceSlug of sourceSlugs) {
        await sql`
          INSERT INTO role_capabilities (role_id, capability_id)
          SELECT roles.id, capabilities.id
          FROM roles, capabilities
          WHERE roles.slug = ${`compat-${sourceSlug}-${suffix}`}
            AND capabilities.slug = ${sourceSlug}
        `;
      }
      await sql`
        INSERT INTO role_capabilities (role_id, capability_id)
        SELECT roles.id, capabilities.id
        FROM roles, capabilities
        WHERE roles.slug = ${`compat-both-${suffix}`}
          AND capabilities.slug IN ('invoke_agents', 'use_research_tools', 'write_artifacts')
      `;
      await sql`
        INSERT INTO role_capabilities (role_id, capability_id)
        SELECT roles.id, capabilities.id
        FROM roles, capabilities
        WHERE roles.slug = ${`compat-neither-${suffix}`}
          AND capabilities.slug = 'write_artifacts'
      `;

      for (const groupType of customGroupTypes) {
        await sql`
          INSERT INTO "groups" (owner_id, type, label, trust_preset)
          VALUES (${ownerId}, ${groupType}, ${groupType}, 'personal')
        `;
      }
      const customGroupRolePairs: ReadonlyArray<readonly [string, string]> = [
        [customGroupTypes[0]!, `compat-use_project_content-${suffix}`],
        [customGroupTypes[1]!, `compat-invoke_agents-${suffix}`],
        [customGroupTypes[2]!, `compat-neither-${suffix}`],
      ];
      for (const [groupType, roleSlug] of customGroupRolePairs) {
        await sql`
          INSERT INTO group_roles (group_id, role_id)
          SELECT "groups".id, roles.id
          FROM "groups", roles
          WHERE "groups".type = ${groupType} AND roles.slug = ${roleSlug}
        `;
      }
      await sql`
        INSERT INTO group_members (group_id, user_id)
        SELECT id, ${effectiveUserId} FROM "groups" WHERE type = ${customGroupTypes[0]!}
      `;
      await sql`
        INSERT INTO group_members (group_id, user_id)
        SELECT id, ${unionUserId} FROM "groups"
        WHERE type = ANY(${customGroupTypes.slice(1) as unknown as string[]})
      `;

      const guestGroupRows = await sql<{ id: string }[]>`
        SELECT id FROM "groups" WHERE type = 'guests' LIMIT 1
      `;
      await sql`
        INSERT INTO group_members (group_id, user_id)
        VALUES (${guestGroupRows[0]!.id}, ${guestUserId})
        ON CONFLICT (group_id, user_id) DO NOTHING
      `;

      await seedTrustPersonal(ownerId, `Funding seed ${suffix}`);
      const firstGrantSnapshot = await customRoleGrantSnapshot();
      const firstEffectiveSnapshot = {
        effective: await effectiveCapabilities(effectiveUserId),
        union: await effectiveCapabilities(unionUserId),
        guest: await effectiveCapabilities(guestUserId),
      };
      await seedTrustPersonal(ownerId, `Funding seed ${suffix}`);
      expect(await customRoleGrantSnapshot()).toEqual(firstGrantSnapshot);
      expect({
        effective: await effectiveCapabilities(effectiveUserId),
        union: await effectiveCapabilities(unionUserId),
        guest: await effectiveCapabilities(guestUserId),
      }).toEqual(firstEffectiveSnapshot);

      for (const sourceSlug of sourceSlugs) {
        const rows = await sql<{ slug: string }[]>`
          SELECT capabilities.slug
          FROM role_capabilities
          INNER JOIN roles ON roles.id = role_capabilities.role_id
          INNER JOIN capabilities ON capabilities.id = role_capabilities.capability_id
          WHERE roles.slug = ${`compat-${sourceSlug}-${suffix}`}
          ORDER BY capabilities.slug
        `;
        const expected = [
          sourceSlug,
          ...(CUSTOM_ROLE_COMPATIBILITY_GRANTS[sourceSlug] ?? []),
        ];
        expect(rows.map((row) => row.slug)).toEqual([...new Set(expected)].sort());
        expect(rows.some((row) => row.slug === "use_personal_provider_credentials"))
          .toBe(false);
      }

      const bothRows = await sql<{ slug: string }[]>`
        SELECT capabilities.slug
        FROM role_capabilities
        INNER JOIN roles ON roles.id = role_capabilities.role_id
        INNER JOIN capabilities ON capabilities.id = role_capabilities.capability_id
        WHERE roles.slug = ${`compat-both-${suffix}`}
        ORDER BY capabilities.slug
      `;
      expect(bothRows.map((row) => row.slug)).toEqual([
        "invoke_agents",
        "invoke_other_agents",
        "use_research_tools",
        "use_server_provider_credentials",
        "write_artifacts",
      ]);
      const neitherRows = await sql<{ slug: string }[]>`
        SELECT capabilities.slug
        FROM role_capabilities
        INNER JOIN roles ON roles.id = role_capabilities.role_id
        INNER JOIN capabilities ON capabilities.id = role_capabilities.capability_id
        WHERE roles.slug = ${`compat-neither-${suffix}`}
      `;
      expect(neitherRows.map((row) => row.slug)).toEqual(["write_artifacts"]);

      expect(firstEffectiveSnapshot.effective).toEqual([
        "use_project_content",
        "use_server_provider_credentials",
      ]);
      expect(firstEffectiveSnapshot.union).toEqual([
        "invoke_agents",
        "invoke_other_agents",
        "use_server_provider_credentials",
        "write_artifacts",
      ]);
      expect(firstEffectiveSnapshot.guest).toEqual([]);

      const membershipRows = await sql<{ type: string }[]>`
        SELECT "groups".type
        FROM group_members
        INNER JOIN "groups" ON "groups".id = group_members.group_id
        WHERE group_members.user_id = ${guestUserId}
          AND "groups".type IN ('guests', 'communities')
        ORDER BY "groups".type
      `;
      expect(membershipRows.map((row) => row.type)).toEqual(["guests"]);
      const communityFixtureMemberships = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM group_members
        INNER JOIN "groups" ON "groups".id = group_members.group_id
        WHERE "groups".type = 'communities'
          AND group_members.user_id = ANY(${fixtureUserIds as unknown as string[]})
      `;
      expect(communityFixtureMemberships[0]?.count).toBe(0);
    } finally {
      await sql`
        DELETE FROM group_members
        WHERE user_id = ANY(${fixtureUserIds as unknown as string[]})
      `;
      await sql`
        DELETE FROM group_roles
        WHERE group_id IN (
          SELECT id FROM "groups" WHERE type = ANY(${customGroupTypes as unknown as string[]})
        )
      `;
      await sql`DELETE FROM "groups" WHERE type = ANY(${customGroupTypes as unknown as string[]})`;
      await sql`
        DELETE FROM role_capabilities
        WHERE role_id IN (SELECT id FROM roles WHERE slug = ANY(${roleSlugs as unknown as string[]}))
      `;
      await sql`DELETE FROM roles WHERE slug = ANY(${roleSlugs as unknown as string[]})`;
      await sql`DELETE FROM channel_identities WHERE user_id = ANY(${fixtureUserIds as unknown as string[]})`;
      await sql`DELETE FROM actors WHERE owner_id = ANY(${fixtureUserIds as unknown as string[]})`;
      await sql`DELETE FROM users WHERE id = ANY(${fixtureUserIds as unknown as string[]})`;
    }
  }, 60_000);
});

/** Mirror of getUserCapabilities() inline so it sees in-TX rows. */
async function capsOfInTx(
  tx: postgres.TransactionSql,
  userId: string,
): Promise<readonly string[]> {
  const rows = await tx<{ slug: string }[]>`
    SELECT DISTINCT capabilities.slug
    FROM group_members
    INNER JOIN "groups"          ON "groups".id          = group_members.group_id
    INNER JOIN group_roles       ON group_roles.group_id = "groups".id
    INNER JOIN "roles"           ON "roles".id           = group_roles.role_id
    INNER JOIN role_capabilities ON role_capabilities.role_id = "roles".id
    INNER JOIN capabilities      ON capabilities.id      = role_capabilities.capability_id
    WHERE group_members.user_id = ${userId}
  `;
  return rows.map((r) => r.slug);
}

/** Mirror of findUsersWithCapability() inline so it sees in-TX rows. */
async function usersWithCapInTx(
  tx: postgres.TransactionSql,
  capSlug: string,
  fixtureUserIds: readonly string[],
): Promise<readonly string[]> {
  // Restrict to fixture users so we don't see pre-existing real users on
  // a retained populated instance may have additional owner memberships.
  const rows = await tx<{ user_id: string }[]>`
    SELECT DISTINCT group_members.user_id
    FROM group_members
    INNER JOIN "groups"          ON "groups".id          = group_members.group_id
    INNER JOIN group_roles       ON group_roles.group_id = "groups".id
    INNER JOIN "roles"           ON "roles".id           = group_roles.role_id
    INNER JOIN role_capabilities ON role_capabilities.role_id = "roles".id
    INNER JOIN capabilities      ON capabilities.id      = role_capabilities.capability_id
    WHERE capabilities.slug = ${capSlug}
      AND group_members.user_id = ANY(${fixtureUserIds as unknown as string[]})
  `;
  return rows.map((r) => r.user_id);
}

async function getCanonicalGroupId(
  tx: postgres.TransactionSql,
  groupType: string,
): Promise<string> {
  // Production: canonical groups exist with agent_id IS NULL.
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM "groups" WHERE type = ${groupType} LIMIT 1
  `;
  if (!rows[0]?.id) {
    throw new Error(`canonical group missing: ${groupType} — has seedTrustPersonal run?`);
  }
  return rows[0].id;
}

/**
 * Ensure the canonical catalogue (capabilities + roles + canonical groups +
 * role_capabilities) exists inside the TX. Mirrors `seedTrustPersonal`'s
 * catalogue half. Idempotent. All writes inside the TX roll back, so
 * this leaves the DB unchanged after the test.
 *
 * Required because:
 *   - The scratch instance may not have had `seedTrustPersonal` run
 *     with the M128 changes yet (roles + canonical groups absent).
 *   - The scratch instance may have had pre-M128 seed run (legacy roles
 *     present but canonical groups absent).
 *
 * On a clean post-M128 instance the helper is a no-op (everything
 * already exists; ON CONFLICT DO NOTHING short-circuits).
 */
async function ensureM128CatalogueInTx(
  tx: postgres.TransactionSql,
  bootstrapUserId: string,
): Promise<void> {
  // 1. Capabilities — insert all 30 ladder caps.
  for (const slug of M128_CAPABILITY_SLUGS) {
    await tx`
      INSERT INTO capabilities (slug, description, category)
      VALUES (${slug}, ${slug}, 'tools')
      ON CONFLICT (slug) DO NOTHING
    `;
  }

  // 2. Roles — insert every ladder role.
  for (const slug of M128_ROLE_SLUGS) {
    await tx`
      INSERT INTO "roles" (slug, label, is_system)
      VALUES (${slug}, ${slug}, true)
      ON CONFLICT (slug) DO NOTHING
    `;
  }

  // 3. role_capabilities — re-wire per M128_ROLE_CAPABILITIES. Scoped
  //    delete to ladder role ids only so custom rows survive.
  const roleRows = await tx<{ id: string; slug: string }[]>`
    SELECT id, slug FROM "roles" WHERE slug = ANY(${[...M128_ROLE_SLUGS] as unknown as string[]})
  `;
  const roleIdBySlug = new Map(roleRows.map((r) => [r.slug, r.id]));
  await tx`
    DELETE FROM role_capabilities WHERE role_id = ANY(${roleRows.map((r) => r.id) as unknown as string[]})
  `;

  const capRows = await tx<{ id: string; slug: string }[]>`
    SELECT id, slug FROM capabilities WHERE slug = ANY(${[...M128_CAPABILITY_SLUGS] as unknown as string[]})
  `;
  const capIdBySlug = new Map(capRows.map((c) => [c.slug, c.id]));

  for (const roleSlug of M128_ROLE_SLUGS) {
    const roleId = roleIdBySlug.get(roleSlug);
    if (!roleId) continue;
    const capsForRole = M128_ROLE_CAPABILITIES[roleSlug] ?? [];
    for (const capSlug of capsForRole) {
      const capId = capIdBySlug.get(capSlug);
      if (!capId) continue;
      await tx`
        INSERT INTO role_capabilities (role_id, capability_id)
        VALUES (${roleId}, ${capId})
        ON CONFLICT (role_id, capability_id) DO NOTHING
      `;
    }
  }

  // 4. Canonical groups — insert if missing.
  const ladder: ReadonlyArray<readonly [string, string, string]> = [
    ["owners", "Owners", "owner"],
    ["admins", "Admins", "admin"],
    ["superusers", "Superusers", "superuser"],
    ["members", "Members", "member"],
    ["contributors", "Contributors", "contributor"],
    ["communities", "Communities", "community"],
    ["guests", "Guests", "guest"],
  ];
  for (const [type, label, roleSlug] of ladder) {
    const roleId = roleIdBySlug.get(roleSlug);
    if (!roleId) continue;
    const existing = await tx<{ id: string }[]>`
      SELECT id FROM "groups" WHERE type = ${type} LIMIT 1
    `;
    let groupId = existing[0]?.id;
    if (!groupId) {
      // M131: groups.role_id is gone — insert the Group bare, then map it
      // to its Role via the group_roles junction.
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO "groups" (owner_id, type, label, trust_preset)
        VALUES (${bootstrapUserId}, ${type}, ${label}, 'personal')
        RETURNING id
      `;
      groupId = inserted[0]?.id;
    }
    if (!groupId) continue;
    await tx`
      INSERT INTO group_roles (group_id, role_id)
      VALUES (${groupId}, ${roleId})
      ON CONFLICT (group_id, role_id) DO NOTHING
    `;
  }
}

describe("M128 — server-wide RBAC integration (T15 + TP11 + MVS #6 + MVS #9)", () => {
  test("MVS #2 ladder coverage: each rung's canonical Group yields the expected cap set", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    let ok = false;
    try {
      await sql.begin(async (tx) => {
        // Seed one fixture user per rung.
        const userRows = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle) VALUES
            (${`u-owner-${suffix}`},       ${`u-owner-${suffix}@t`},       ${`uo${suffix.slice(-6)}`}),
            (${`u-admin-${suffix}`},       ${`u-admin-${suffix}@t`},       ${`ua${suffix.slice(-6)}`}),
            (${`u-superuser-${suffix}`},   ${`u-superuser-${suffix}@t`},   ${`us${suffix.slice(-6)}`}),
            (${`u-member-${suffix}`},      ${`u-member-${suffix}@t`},      ${`um${suffix.slice(-6)}`}),
            (${`u-contributor-${suffix}`}, ${`u-contributor-${suffix}@t`}, ${`uc${suffix.slice(-6)}`}),
            (${`u-community-${suffix}`},   ${`u-community-${suffix}@t`},   ${`uy${suffix.slice(-6)}`}),
            (${`u-guest-${suffix}`},       ${`u-guest-${suffix}@t`},       ${`ug${suffix.slice(-6)}`})
          RETURNING id
        `;
        expect(userRows.length).toBe(7);

        // Ensure M128 catalogue exists (idempotent; rolls back with TX).
        await ensureM128CatalogueInTx(tx, userRows[0]!.id);

        // Each user gets a user-actor (group_members.granted_by FK).
        for (const u of userRows) {
          await tx`
            INSERT INTO actors (owner_id, display_name, trust_state, kind)
            VALUES (${u.id}, ${`actor-${u.id}`}, 'verified', 'user')
          `;
        }
        const actorByUser = new Map<string, string>();
        const actorRows = await tx<{ id: string; owner_id: string }[]>`
          SELECT id, owner_id FROM actors WHERE kind = 'user' AND owner_id = ANY(${userRows.map((u) => u.id) as unknown as string[]})
        `;
        for (const a of actorRows) actorByUser.set(a.owner_id, a.id);

        // Insert each user into the corresponding canonical Group.
        for (let i = 0; i < LADDER.length; i++) {
          const rung = LADDER[i]!;
          const user = userRows[i]!;
          const groupId = await getCanonicalGroupId(tx, rung.groupType);
          await tx`
            INSERT INTO group_members (group_id, user_id, granted_by)
            VALUES (${groupId}, ${user.id}, ${actorByUser.get(user.id)!})
            ON CONFLICT (group_id, user_id) DO NOTHING
          `;
        }

        // Assert cap distribution matches M128_ROLE_CAPABILITIES (single
        // source of truth, exported by @nautilo/db; mirror of §6 grid).
        for (let i = 0; i < LADDER.length; i++) {
          const rung = LADDER[i]!;
          const user = userRows[i]!;
          const actualCaps = new Set(await capsOfInTx(tx, user.id));
          const expectedCaps = new Set(
            M128_ROLE_CAPABILITIES[rung.roleSlug] ?? [],
          );
          // Diagnostic on mismatch
          if (actualCaps.size !== expectedCaps.size) {
            const missing = [...expectedCaps].filter((c) => !actualCaps.has(c));
            const extra = [...actualCaps].filter((c) => !expectedCaps.has(c));
            console.log(`DIAG rung=${rung.roleSlug}`, { missing, extra });
          }
          expect(actualCaps.size).toBe(expectedCaps.size);
          for (const cap of expectedCaps) {
            expect(actualCaps.has(cap)).toBe(true);
          }
        }

        ok = true;
        throw new Error("__t15_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__t15_rollback__");
    }
    expect(ok).toBe(true);
  }, 30_000);

  test("MVS #6 server-wide cap union: user in two Groups receives caps from BOTH (no per-Agent narrowing)", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    let ok = false;
    try {
      await sql.begin(async (tx) => {
        const userRows = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle)
          VALUES (${`u-union-${suffix}`}, ${`u-union-${suffix}@t`}, ${`uu${suffix.slice(-6)}`})
          RETURNING id
        `;
        const user = userRows[0]!;

        // Ensure M128 catalogue exists (idempotent; rolls back with TX).
        await ensureM128CatalogueInTx(tx, user.id);
        const actorRows = await tx<{ id: string }[]>`
          INSERT INTO actors (owner_id, display_name, trust_state, kind)
          VALUES (${user.id}, ${`actor-${user.id}`}, 'verified', 'user')
          RETURNING id
        `;
        const actorId = actorRows[0]!.id;

        // Add to both `members` and `contributors`. Member adds the ordinary
        // workstation and project-execution surfaces over Contributor.
        // Union == member's set (since admin ⊃ member ⊃ contributor).
        const membersId = await getCanonicalGroupId(tx, "members");
        const contributorsId = await getCanonicalGroupId(tx, "contributors");
        await tx`
          INSERT INTO group_members (group_id, user_id, granted_by)
          VALUES (${membersId}, ${user.id}, ${actorId}),
                 (${contributorsId}, ${user.id}, ${actorId})
        `;

        const actualCaps = new Set(await capsOfInTx(tx, user.id));
        const memberCaps = new Set(M128_ROLE_CAPABILITIES["member"] ?? []);
        // Union (members ∪ contributors) === members (strict-subset ladder).
        expect(actualCaps.size).toBe(memberCaps.size);
        for (const cap of memberCaps) {
          expect(actualCaps.has(cap)).toBe(true);
        }
        // Representative Member-only caps prove the union, not an intersection.
        for (const heavy of ["use_project_execution", "use_workstation", "control_desktop"]) {
          expect(actualCaps.has(heavy)).toBe(true);
        }

        ok = true;
        throw new Error("__t15_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__t15_rollback__");
    }
    expect(ok).toBe(true);
  }, 30_000);

  test("M131 MVS S2: user in ONE Group carrying TWO Roles gets the unioned caps", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    let ok = false;
    try {
      await sql.begin(async (tx) => {
        const userRows = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle)
          VALUES (${`u-m131-${suffix}`}, ${`u-m131-${suffix}@t`}, ${`u1${suffix.slice(-6)}`})
          RETURNING id
        `;
        const user = userRows[0]!;

        // Ensure M128 catalogue exists (idempotent; rolls back with TX).
        await ensureM128CatalogueInTx(tx, user.id);
        const actorRows = await tx<{ id: string }[]>`
          INSERT INTO actors (owner_id, display_name, trust_state, kind)
          VALUES (${user.id}, ${`actor-${user.id}`}, 'verified', 'user')
          RETURNING id
        `;
        const actorId = actorRows[0]!.id;

        // M131: a single, non-canonical Group carrying BOTH `member` and
        // `contributor` Roles via two group_roles rows. This is the new
        // expressive power the M:N junction unlocks — impossible under the
        // pre-M131 1:1 `groups.role_id`.
        const groupRows = await tx<{ id: string }[]>`
          INSERT INTO "groups" (owner_id, type, label, trust_preset)
          VALUES (${user.id}, ${`m131-dual-${suffix}`}, ${"M131 dual-role"}, 'personal')
          RETURNING id
        `;
        const groupId = groupRows[0]!.id;
        const roleRows = await tx<{ id: string; slug: string }[]>`
          SELECT id, slug FROM "roles" WHERE slug = ANY(${["member", "contributor"] as unknown as string[]})
        `;
        for (const r of roleRows) {
          await tx`
            INSERT INTO group_roles (group_id, role_id)
            VALUES (${groupId}, ${r.id})
            ON CONFLICT (group_id, role_id) DO NOTHING
          `;
        }
        await tx`
          INSERT INTO group_members (group_id, user_id, granted_by)
          VALUES (${groupId}, ${user.id}, ${actorId})
        `;

        const actualCaps = new Set(await capsOfInTx(tx, user.id));
        const memberCaps = new Set(M128_ROLE_CAPABILITIES["member"] ?? []);
        // Union (member ∪ contributor) === member (strict-subset ladder).
        expect(actualCaps.size).toBe(memberCaps.size);
        for (const cap of memberCaps) {
          expect(actualCaps.has(cap)).toBe(true);
        }
        // Member-only caps prove the union (not an arbitrary single-role pick).
        for (const heavy of ["use_project_execution", "use_workstation", "control_desktop"]) {
          expect(actualCaps.has(heavy)).toBe(true);
        }

        ok = true;
        throw new Error("__t15_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__t15_rollback__");
    }
    expect(ok).toBe(true);
  }, 30_000);

  test("MVS #9 approver pool: findUsersWithCapability('approve_destructive_actions') returns owner ∪ admin ∪ superuser only", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    let ok = false;
    try {
      await sql.begin(async (tx) => {
        // Seed one fixture user per rung (same fixture shape as MVS #2).
        const userRows = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle) VALUES
            (${`a-owner-${suffix}`},       ${`a-owner-${suffix}@t`},       ${`ao${suffix.slice(-6)}`}),
            (${`a-admin-${suffix}`},       ${`a-admin-${suffix}@t`},       ${`aa${suffix.slice(-6)}`}),
            (${`a-superuser-${suffix}`},   ${`a-superuser-${suffix}@t`},   ${`as${suffix.slice(-6)}`}),
            (${`a-member-${suffix}`},      ${`a-member-${suffix}@t`},      ${`am${suffix.slice(-6)}`}),
            (${`a-contributor-${suffix}`}, ${`a-contributor-${suffix}@t`}, ${`ac${suffix.slice(-6)}`}),
            (${`a-community-${suffix}`},   ${`a-community-${suffix}@t`},   ${`ay${suffix.slice(-6)}`}),
            (${`a-guest-${suffix}`},       ${`a-guest-${suffix}@t`},       ${`ag${suffix.slice(-6)}`})
          RETURNING id
        `;
        // Ensure M128 catalogue exists (idempotent; rolls back with TX).
        await ensureM128CatalogueInTx(tx, userRows[0]!.id);
        for (const u of userRows) {
          await tx`
            INSERT INTO actors (owner_id, display_name, trust_state, kind)
            VALUES (${u.id}, ${`actor-${u.id}`}, 'verified', 'user')
          `;
        }
        const actorRows = await tx<{ id: string; owner_id: string }[]>`
          SELECT id, owner_id FROM actors WHERE kind = 'user' AND owner_id = ANY(${userRows.map((u) => u.id) as unknown as string[]})
        `;
        const actorByUser = new Map(actorRows.map((a) => [a.owner_id, a.id]));

        // One fixture user per rung.
        for (let i = 0; i < LADDER.length; i++) {
          const rung = LADDER[i]!;
          const user = userRows[i]!;
          const groupId = await getCanonicalGroupId(tx, rung.groupType);
          await tx`
            INSERT INTO group_members (group_id, user_id, granted_by)
            VALUES (${groupId}, ${user.id}, ${actorByUser.get(user.id)!})
            ON CONFLICT (group_id, user_id) DO NOTHING
          `;
        }

        const fixtureIds = userRows.map((u) => u.id);
        const approvers = new Set(
          await usersWithCapInTx(tx, "approve_destructive_actions", fixtureIds),
        );

        // Expect: owner, admin, superuser in the pool (indices 0, 1, 2).
        // member, contributor, community, guest are not in the pool.
        expect(approvers.has(userRows[0]!.id)).toBe(true); // owner
        expect(approvers.has(userRows[1]!.id)).toBe(true); // admin
        expect(approvers.has(userRows[2]!.id)).toBe(true); // superuser
        expect(approvers.has(userRows[3]!.id)).toBe(false); // member
        expect(approvers.has(userRows[4]!.id)).toBe(false); // contributor
        expect(approvers.has(userRows[5]!.id)).toBe(false); // community
        expect(approvers.has(userRows[6]!.id)).toBe(false); // guest
        // Exactly 3 approvers among the fixture (no false positives).
        expect(approvers.size).toBe(3);

        ok = true;
        throw new Error("__t15_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__t15_rollback__");
    }
    expect(ok).toBe(true);
  }, 30_000);

  test("D4-A — `manage_agents` not held by superuser/member/contributor (regression guard for the ladder collapse)", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    let ok = false;
    try {
      await sql.begin(async (tx) => {
        const userRows = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle) VALUES
            (${`d-su-${suffix}`}, ${`d-su-${suffix}@t`}, ${`ds${suffix.slice(-6)}`}),
            (${`d-mb-${suffix}`}, ${`d-mb-${suffix}@t`}, ${`dm${suffix.slice(-6)}`}),
            (${`d-cb-${suffix}`}, ${`d-cb-${suffix}@t`}, ${`dc${suffix.slice(-6)}`})
          RETURNING id
        `;
        // Ensure M128 catalogue exists (idempotent; rolls back with TX).
        await ensureM128CatalogueInTx(tx, userRows[0]!.id);
        for (const u of userRows) {
          await tx`
            INSERT INTO actors (owner_id, display_name, trust_state, kind)
            VALUES (${u.id}, ${`actor-${u.id}`}, 'verified', 'user')
          `;
        }
        const actorRows = await tx<{ id: string; owner_id: string }[]>`
          SELECT id, owner_id FROM actors WHERE kind = 'user' AND owner_id = ANY(${userRows.map((u) => u.id) as unknown as string[]})
        `;
        const actorByUser = new Map(actorRows.map((a) => [a.owner_id, a.id]));

        const rungs: ReadonlyArray<readonly [string, { id: string }]> = [
          ["superusers", userRows[0]!],
          ["members", userRows[1]!],
          ["contributors", userRows[2]!],
        ];
        for (const [groupType, user] of rungs) {
          const groupId = await getCanonicalGroupId(tx, groupType);
          await tx`
            INSERT INTO group_members (group_id, user_id, granted_by)
            VALUES (${groupId}, ${user.id}, ${actorByUser.get(user.id)!})
            ON CONFLICT (group_id, user_id) DO NOTHING
          `;
        }

        for (const [groupType, user] of rungs) {
          const caps = new Set(await capsOfInTx(tx, user.id));
          // The cap that D4-A removed from this rung.
          expect(caps.has("manage_agents")).toBe(false);
          // Sanity — they still hold a rung-specific cap so we know
          // the fixture wiring is correct.
          expect(caps.has("read_memories")).toBe(true);
          void groupType;
        }

        ok = true;
        throw new Error("__t15_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__t15_rollback__");
    }
    expect(ok).toBe(true);
  }, 30_000);
});

// D418 Wave 2 / Stack 193 — system-managed Role + Group semantics.
// Verifies the ladder Roles and canonical Groups are platform-managed
// (independent of any Human lifecycle) and that membership administration
// of a canonical system Group still resolves capabilities correctly.
describe("D418 — system-managed Role + Group semantics (live Postgres)", () => {
  test("the ladder Roles are is_system=true", async () => {
    const rows = await sql<{ slug: string; is_system: boolean }[]>`
      SELECT slug, is_system FROM "roles"
      WHERE slug = ANY(${[...M128_ROLE_SLUGS] as unknown as string[]})
    `;
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(r.is_system).toBe(true);
    }
  });

  test("the canonical ladder Groups are is_system=true with NULL owner_id", async () => {
    const rows = await sql<{ type: string; is_system: boolean; owner_id: string | null }[]>`
      SELECT type, is_system, owner_id FROM "groups"
      WHERE type = ANY(${LADDER.map((rung) => rung.groupType) as unknown as string[]})
    `;
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(r.is_system).toBe(true);
      expect(r.owner_id).toBeNull();
    }
  });

  test("membership administration of a canonical system Group still resolves caps (no system-group block)", async () => {
    // Promote a fixture user into the canonical `members` system Group and
    // confirm the cap JOIN chain resolves the member cap bundle. This proves
    // the system-managed discriminator does NOT block legitimate membership
    // administration of canonical ladder Groups (only definition mutation
    // is reserved, which has no route here).
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let ok = false;
    try {
      await sql.begin(async (tx) => {
        const userRows = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle)
          VALUES (${`d418-promo-${suffix}`}, ${`d418-promo-${suffix}@t`}, ${`dp${suffix.slice(-6)}`})
          RETURNING id
        `;
        const user = userRows[0]!;
        await ensureM128CatalogueInTx(tx, user.id);
        await tx`
          INSERT INTO actors (owner_id, display_name, trust_state, kind)
          VALUES (${user.id}, ${`actor-${user.id}`}, 'verified', 'user')
        `;
        const actorRows = await tx<{ id: string }[]>`
          SELECT id FROM actors WHERE kind = 'user' AND owner_id = ${user.id}
        `;
        const actorId = actorRows[0]!.id;

        const membersId = await getCanonicalGroupId(tx, "members");
        await tx`
          INSERT INTO group_members (group_id, user_id, granted_by)
          VALUES (${membersId}, ${user.id}, ${actorId})
          ON CONFLICT (group_id, user_id) DO NOTHING
        `;
        const caps = new Set(await capsOfInTx(tx, user.id));
        // `member` rung holds read_memories (sanity that the JOIN resolved).
        expect(caps.has("read_memories")).toBe(true);
        // `member` does NOT hold manage_members (admin-tier) — proves the
        // system-group membership granted exactly the member rung, not more.
        expect(caps.has("manage_members")).toBe(false);

        ok = true;
        throw new Error("__t15_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__t15_rollback__");
    }
    expect(ok).toBe(true);
  }, 30_000);
});

// D556 — exact Member/Contributor effective-cap matrix.
describe("D556 — Member and Contributor effective-cap matrix (live Postgres)", () => {
  test("Member has ordinary product surfaces and lacks administration/approvals", async () => {
    const memberCaps = new Set(M128_ROLE_CAPABILITIES["member"] ?? []);
    for (const cap of [
      "use_project_content",
      "use_project_execution",
      "use_workstation",
      "use_remote_hosts",
      "use_connections",
      "use_media_generation",
      "control_desktop",
      "control_browser",
      "use_google_workspace",
      "control_home",
    ])
      expect(memberCaps.has(cap)).toBe(true);
    expect(memberCaps.has("manage_workstation_profiles")).toBe(false);
    expect(memberCaps.has("read_server_settings")).toBe(false);
    expect(memberCaps.has("approve_destructive_actions")).toBe(false);
    expect(new Set(M128_ROLE_CAPABILITIES["superuser"] ?? []).has("read_server_settings"))
      .toBe(true);
  });

  test("Contributor retains shared content but lacks Member-only product surfaces", async () => {
    const contributorCaps = new Set(
      M128_ROLE_CAPABILITIES["contributor"] ?? [],
    );
    expect(contributorCaps.has("use_project_content")).toBe(true);
    for (const cap of [
      "use_project_execution",
      "use_workstation",
      "use_remote_hosts",
      "use_connections",
      "use_media_generation",
      "control_desktop",
      "control_browser",
      "use_google_workspace",
      "control_home",
    ])
      expect(contributorCaps.has(cap)).toBe(false);
    expect(contributorCaps.has("read_memories")).toBe(true);
    expect(contributorCaps.has("read_server_settings")).toBe(false);
  });

  test("Guest holds no capabilities", async () => {
    const guestCaps = M128_ROLE_CAPABILITIES["guest"] ?? [];
    expect(guestCaps.length).toBe(0);
  });

  test("strict-subset ladder: owner ⊃ admin ⊃ superuser ⊃ member ⊃ contributor ⊃ community ⊃ guest", async () => {
    const caps = (slug: string): Set<string> =>
      new Set(M128_ROLE_CAPABILITIES[slug] ?? []);
    const owner = caps("owner");
    const admin = caps("admin");
    const superuser = caps("superuser");
    const member = caps("member");
    const contributor = caps("contributor");
    const community = caps("community");
    const guest = caps("guest");
    // Every lower rung is a strict subset of the rung above it.
    const isStrictSubset = (a: Set<string>, b: Set<string>): boolean => {
      for (const c of a) {
        if (!b.has(c)) return false;
      }
      let strict = false;
      for (const c of b) {
        if (!a.has(c)) {
          strict = true;
          break;
        }
      }
      return strict;
    };
    expect(isStrictSubset(admin, owner)).toBe(true);
    expect(isStrictSubset(superuser, admin)).toBe(true);
    expect(isStrictSubset(member, superuser)).toBe(true);
    expect(isStrictSubset(contributor, member)).toBe(true);
    expect(isStrictSubset(community, contributor)).toBe(true);
    expect(guest.size).toBe(0);
  });

  test("live DB: a fixture Member receives the ordinary product surfaces (real JOIN chain)", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let ok = false;
    try {
      await sql.begin(async (tx) => {
        const userRows = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle)
          VALUES (${`d418-mx-${suffix}`}, ${`d418-mx-${suffix}@t`}, ${`mx${suffix.slice(-6)}`})
          RETURNING id
        `;
        const user = userRows[0]!;
        await ensureM128CatalogueInTx(tx, user.id);
        await tx`
          INSERT INTO actors (owner_id, display_name, trust_state, kind)
          VALUES (${user.id}, ${`actor-${user.id}`}, 'verified', 'user')
        `;
        const actorRows = await tx<{ id: string }[]>`
          SELECT id FROM actors WHERE kind = 'user' AND owner_id = ${user.id}
        `;
        const actorId = actorRows[0]!.id;
        const membersId = await getCanonicalGroupId(tx, "members");
        await tx`
          INSERT INTO group_members (group_id, user_id, granted_by)
          VALUES (${membersId}, ${user.id}, ${actorId})
          ON CONFLICT (group_id, user_id) DO NOTHING
        `;
        const liveCaps = new Set(await capsOfInTx(tx, user.id));
        for (const cap of [
          "use_project_content",
          "use_project_execution",
          "use_workstation",
          "use_remote_hosts",
          "use_connections",
          "use_media_generation",
          "control_desktop",
          "control_browser",
          "use_google_workspace",
          "control_home",
        ])
          expect(liveCaps.has(cap)).toBe(true);
        expect(liveCaps.has("manage_workstation_profiles")).toBe(false);

        ok = true;
        throw new Error("__t15_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__t15_rollback__");
    }
    expect(ok).toBe(true);
  }, 30_000);

  test("live DB: a fixture Contributor lacks Member-only product surfaces", async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let ok = false;
    try {
      await sql.begin(async (tx) => {
        const userRows = await tx<{ id: string }[]>`
          INSERT INTO users (name, email, handle)
          VALUES (${`d418-cx-${suffix}`}, ${`d418-cx-${suffix}@t`}, ${`cx${suffix.slice(-6)}`})
          RETURNING id
        `;
        const user = userRows[0]!;
        await ensureM128CatalogueInTx(tx, user.id);
        await tx`
          INSERT INTO actors (owner_id, display_name, trust_state, kind)
          VALUES (${user.id}, ${`actor-${user.id}`}, 'verified', 'user')
        `;
        const actorRows = await tx<{ id: string }[]>`
          SELECT id FROM actors WHERE kind = 'user' AND owner_id = ${user.id}
        `;
        const actorId = actorRows[0]!.id;
        const contributorsId = await getCanonicalGroupId(tx, "contributors");
        await tx`
          INSERT INTO group_members (group_id, user_id, granted_by)
          VALUES (${contributorsId}, ${user.id}, ${actorId})
          ON CONFLICT (group_id, user_id) DO NOTHING
        `;
        const liveCaps = new Set(await capsOfInTx(tx, user.id));
        expect(liveCaps.has("use_project_content")).toBe(true);
        for (const cap of [
          "use_project_execution",
          "use_workstation",
          "control_desktop",
        ]) {
          expect(liveCaps.has(cap)).toBe(false);
        }
        expect(liveCaps.has("read_memories")).toBe(true);

        ok = true;
        throw new Error("__t15_rollback__");
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("__t15_rollback__");
    }
    expect(ok).toBe(true);
  }, 30_000);
});
