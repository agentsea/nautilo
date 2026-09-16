/**
 * M128 T15 — server-wide RBAC unit tests (no DB).
 *
 * Exercises the seeded capability grid and ladder rank constants that back
 * `getUserCapabilities`, `findUsersWithCapability`, and
 * `findUserHighestRoleSlug` (see `packages/db/tests/integration/server-wide-rbac.integration.test.ts`
 * for the JOIN-chain integration coverage).
 */
import { describe, expect, test } from "bun:test";
import { M128_ROLE_CAPABILITIES, M128_ROLE_SLUGS } from "@nautilo/db";
import { SERVER_ROLE_RANK } from "../../src/queries.ts";

const APPROVER_CAP = "approve_destructive_actions";

function capsForRole(roleSlug: string): Set<string> {
  return new Set(M128_ROLE_CAPABILITIES[roleSlug] ?? []);
}

function unionCaps(roleSlugs: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const slug of roleSlugs) {
    for (const c of capsForRole(slug)) out.add(c);
  }
  return out;
}

function highestRole(roleSlugs: readonly string[]): string | null {
  let best: string | null = null;
  for (const slug of roleSlugs) {
    if (!(slug in SERVER_ROLE_RANK)) continue;
    if (best === null || SERVER_ROLE_RANK[slug as keyof typeof SERVER_ROLE_RANK] < SERVER_ROLE_RANK[best as keyof typeof SERVER_ROLE_RANK]) {
      best = slug;
    }
  }
  return best;
}

function usersWithCapInRoles(memberships: ReadonlyArray<{ userId: string; roleSlug: string }>, cap: string): string[] {
  const out = new Set<string>();
  for (const m of memberships) {
    if (capsForRole(m.roleSlug).has(cap)) out.add(m.userId);
  }
  return [...out];
}

describe("M128 server-wide RBAC (T15, grid + ladder)", () => {
  test("cap union across multiple Groups equals set-union of each Group's caps", () => {
    const actual = unionCaps(["member", "contributor"]);
    const expected = new Set([
      ...capsForRole("member"),
      ...capsForRole("contributor"),
    ]);
    expect(actual.size).toBe(expected.size);
    for (const cap of expected) {
      expect(actual.has(cap)).toBe(true);
    }
    expect(actual.has("use_workstation")).toBe(true);
  });

  test("M131: a single Group carrying two Roles yields the union of both bundles", () => {
    // The new M:N behavior (issue S2): a Group that carries ["contributor",
    // "member"] grants the union of both Roles' caps. `member` is a strict
    // superset of `contributor` on the ladder, so the union equals member's
    // bundle — and crucially includes a cap that `contributor` lacks.
    const union = unionCaps(["contributor", "member"]);
    const member = capsForRole("member");
    expect(union.size).toBe(member.size);
    for (const cap of member) expect(union.has(cap)).toBe(true);
    // `use_workstation` is held by member but stripped from contributor.
    expect(capsForRole("contributor").has("use_workstation")).toBe(false);
    expect(union.has("use_workstation")).toBe(true);

    // A non-nested pair still unions cleanly (no caps lost from either side).
    const mixed = unionCaps(["guest", "contributor"]);
    for (const cap of capsForRole("contributor")) expect(mixed.has(cap)).toBe(true);
  });

  test(`findUsersWithCapability("${APPROVER_CAP}") pool matches owner+admin+superuser only`, () => {
    const memberships = M128_ROLE_SLUGS.flatMap((roleSlug) => [
      { userId: `u-${roleSlug}`, roleSlug },
    ]);
    const pool = usersWithCapInRoles(memberships, APPROVER_CAP).sort();
    expect(pool).toEqual(["u-admin", "u-owner", "u-superuser"].sort());
    expect(pool).not.toContain("u-member");
    expect(pool).not.toContain("u-guest");
  });

  // D418 Wave 2 — Workstation Profile RBAC default bundles (permission-model.md §6):
  //   use_workstation  → owner + admin + superuser + member
  //   manage_workstation_profiles → owner + admin
  // Contributor/Guest have neither by default; Owner/Admin may delegate
  // through normal Group→Role assignment (exercised at the integration layer).
  test(`findUsersWithCapability("use_workstation") pool matches owner+admin+superuser+member`, () => {
    const memberships = M128_ROLE_SLUGS.map((roleSlug) => ({
      userId: `u-${roleSlug}`,
      roleSlug,
    }));
    const pool = usersWithCapInRoles(memberships, "use_workstation").sort();
    expect(pool).toEqual(["u-admin", "u-member", "u-owner", "u-superuser"].sort());
    expect(pool).not.toContain("u-contributor");
    expect(pool).not.toContain("u-guest");
  });

  test(`findUsersWithCapability("manage_workstation_profiles") pool matches owner+admin only`, () => {
    const memberships = M128_ROLE_SLUGS.map((roleSlug) => ({
      userId: `u-${roleSlug}`,
      roleSlug,
    }));
    const pool = usersWithCapInRoles(memberships, "manage_workstation_profiles").sort();
    expect(pool).toEqual(["u-admin", "u-owner"].sort());
    expect(pool).not.toContain("u-superuser");
    expect(pool).not.toContain("u-member");
    expect(pool).not.toContain("u-guest");
  });

  test(`findUsersWithCapability("manage_connection_providers") pool matches owner+admin only`, () => {
    const memberships = M128_ROLE_SLUGS.map((roleSlug) => ({
      userId: `u-${roleSlug}`,
      roleSlug,
    }));
    const pool = usersWithCapInRoles(memberships, "manage_connection_providers").sort();
    expect(pool).toEqual(["u-admin", "u-owner"].sort());
    expect(pool).not.toContain("u-superuser");
    expect(pool).not.toContain("u-member");
    expect(pool).not.toContain("u-guest");
  });

  test("use_workstation + manage_workstation_profiles are distinct from manage_server_security", () => {
    // manage_server_security is owner-only; the D418 caps are wider
    // (admin/superuser get use; admin gets manage). This pins the
    // separation contract: device-scoped profile authority is NOT
    // folded into global server-security authority.
    const securityPool = usersWithCapInRoles(
      M128_ROLE_SLUGS.map((roleSlug) => ({ userId: `u-${roleSlug}`, roleSlug })),
      "manage_server_security",
    );
    expect(securityPool).toEqual(["u-owner"]);
    expect(capsForRole("admin").has("manage_server_security")).toBe(false);
    expect(capsForRole("admin").has("manage_workstation_profiles")).toBe(true);
    expect(capsForRole("superuser").has("use_workstation")).toBe(true);
  });

  test("ladder ordering owner > admin > superuser > member > contributor > guest", () => {
    expect(highestRole(["guest", "admin", "member"])).toBe("admin");
    const pairs: ReadonlyArray<readonly [keyof typeof SERVER_ROLE_RANK, keyof typeof SERVER_ROLE_RANK]> =
      [
        ["admin", "owner"],
        ["superuser", "admin"],
        ["member", "superuser"],
        ["contributor", "member"],
        ["guest", "contributor"],
      ];
    for (const [lower, higher] of pairs) {
      expect(SERVER_ROLE_RANK[lower]).toBeGreaterThan(SERVER_ROLE_RANK[higher]);
    }
  });
});
