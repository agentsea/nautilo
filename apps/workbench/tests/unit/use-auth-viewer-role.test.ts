/**
 * D420 — viewer-role resolution from `/api/auth/whoami`.
 *
 * Regression test for the dev-auth guest-shell bug: a valid owner bearer
 * returned `groups: []` (group-chip projection came back empty) while
 * `highestRole: "owner"` was correct, but the pre-D420 derivation
 * `pickHighestRoleSlug(groups ?? [])` ranked `[]` to `"guest"`,
 * collapsing an authenticated owner into the Guest shell.
 *
 * Fix: `resolveViewerRole` treats `whoami.highestRole` as authoritative
 * when it is a recognized `ViewerRole`, and otherwise falls back to the
 * existing group-chip ranking. Unknown future Role slugs are NOT
 * accepted as authority.
 */
import { describe, expect, test } from "bun:test";
import type { GroupChip } from "@nautilo/types";
import { resolveViewerRole } from "../../src/hooks/use-auth";

const ownerChip: GroupChip = {
  id: "grp-owners",
  type: "owners",
  label: "Owners",
  roleSlug: "owner",
};

const memberChip: GroupChip = {
  id: "grp-members",
  type: "members",
  label: "Members",
  roleSlug: "member",
};

describe("resolveViewerRole (D420 — highestRole authority)", () => {
  test("REGRESSION: empty groups + highestRole owner → owner viewer (LOAD-BEARING; fails under pre-D420 pickHighestRoleSlug-only shape)", () => {
    // The live dev-auth evidence: groups: [] + highestRole: "owner".
    // Pre-fix: pickHighestRoleSlug([]) → "guest" (the bug).
    // Post-fix: highestRole is authoritative → "owner".
    const role = resolveViewerRole("owner", []);
    expect(role).toBe("owner");
  });

  test("empty groups + highestRole admin → admin", () => {
    expect(resolveViewerRole("admin", [])).toBe("admin");
  });

  test("empty groups + highestRole member → member", () => {
    expect(resolveViewerRole("member", [])).toBe("member");
  });

  test("Community is recognized from the server and ranked above Guest", () => {
    expect(resolveViewerRole("community", [])).toBe("community");
    expect(resolveViewerRole(null, [
      { id: "guest", type: "guests", label: "Guests", roleSlug: "guest" },
      { id: "community", type: "communities", label: "Community", roleSlug: "community" },
    ])).toBe("community");
  });

  test("populated groups + null highestRole → falls back to group-chip ranking", () => {
    expect(resolveViewerRole(null, [ownerChip, memberChip])).toBe("owner");
  });

  test("populated groups + undefined highestRole → falls back to group-chip ranking", () => {
    expect(resolveViewerRole(undefined, [memberChip])).toBe("member");
  });

  test("unknown highestRole string is NOT accepted as authority → falls back to group-chip ranking", () => {
    // Defense against drift: a future server adding e.g. "operator" must
    // not be trusted blindly. Falls back to the group chips.
    expect(resolveViewerRole("operator", [memberChip])).toBe("member");
  });

  test("unknown highestRole + empty groups → falls back to guest (safe default)", () => {
    expect(resolveViewerRole("operator", [])).toBe("guest");
  });

  test("null highestRole + empty groups → guest", () => {
    expect(resolveViewerRole(null, [])).toBe("guest");
  });

  test("recognized highestRole takes precedence over group-chip ranking", () => {
    // highestRole is authoritative when recognized, even if chips would
    // rank differently. The server computes highestRole from the same
    // membership, so in practice they agree; this pins the authority
    // order explicitly.
    expect(resolveViewerRole("member", [ownerChip])).toBe("member");
  });
});
