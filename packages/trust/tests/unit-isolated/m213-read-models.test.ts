/**
 * M213 — pure read-model folding helpers (no DB / server).
 */
import { describe, expect, test } from "bun:test";
import { M128_ROLE_CAPABILITIES } from "@nautilo/db";
import {
  bindingForCanonicalFederatedId,
  dedupeCapabilitySlugs,
  deepFreeze,
  foldGroupChipsFromMembershipRows,
  foldRbacProjection,
  pickHighestRoleSlug,
  type RbacMembershipFoldRow,
} from "../../src/m213-read-models.ts";
import { SERVER_ROLE_RANK } from "../../src/queries.ts";

function row(
  partial: RbacMembershipFoldRow,
): RbacMembershipFoldRow {
  return partial;
}

describe("M213 pickHighestRoleSlug", () => {
  test("returns null for empty input", () => {
    expect(pickHighestRoleSlug([], SERVER_ROLE_RANK)).toBeNull();
  });

  test("picks the strongest role on the ladder", () => {
    expect(
      pickHighestRoleSlug(["guest", "admin", "member"], SERVER_ROLE_RANK),
    ).toBe("admin");
    expect(pickHighestRoleSlug(["contributor", "owner"], SERVER_ROLE_RANK)).toBe(
      "owner",
    );
  });

  test("ignores unknown role slugs", () => {
    expect(
      pickHighestRoleSlug(["custom-role", "guest"], SERVER_ROLE_RANK),
    ).toBe("guest");
    expect(pickHighestRoleSlug(["custom-role"], SERVER_ROLE_RANK)).toBeNull();
  });
});

describe("M213 dedupeCapabilitySlugs", () => {
  test("preserves first-seen order and drops empties", () => {
    const slugs = dedupeCapabilitySlugs([
      "manage_members",
      "manage_members",
      "",
      "manage_rooms",
      "manage_members",
    ]);
    expect(slugs).toEqual(["manage_members", "manage_rooms"]);
    expect(Object.isFrozen(slugs)).toBe(true);
  });
});

describe("M213 canonical workbench binding", () => {
  test("does not treat a stale workbench identity as canonical verification", () => {
    const binding = bindingForCanonicalFederatedId("@alice@nautilo.example", {
      externalId: "@former-alice@nautilo.example",
      verifiedAt: new Date("2026-07-16T00:00:00.000Z"),
    });
    expect(binding).toBeNull();
  });

  test("keeps only the binding for the exact canonical federated identity", () => {
    const verifiedAt = new Date("2026-07-16T00:00:00.000Z");
    const binding = bindingForCanonicalFederatedId("@alice@nautilo.example", {
      externalId: "@alice@nautilo.example",
      verifiedAt,
    });
    expect(binding).toEqual({
      externalId: "@alice@nautilo.example",
      verifiedAt,
      isVerified: true,
    });
    expect(Object.isFrozen(binding)).toBe(true);
  });

  test("has no binding when the principal has no canonical federated identity", () => {
    expect(
      bindingForCanonicalFederatedId("", {
        externalId: "@alice@nautilo.example",
        verifiedAt: new Date(),
      }),
    ).toBeNull();
  });
});

describe("M213 foldGroupChipsFromMembershipRows", () => {
  test("collapses many-to-many group roles to highest rank per group", () => {
    const chips = foldGroupChipsFromMembershipRows(
      [
        row({
          groupId: "g1",
          groupType: "members",
          groupLabel: "Members",
          roleSlug: "contributor",
          capabilitySlug: null,
        }),
        row({
          groupId: "g1",
          groupType: "members",
          groupLabel: "Members",
          roleSlug: "member",
          capabilitySlug: null,
        }),
        row({
          groupId: "g2",
          groupType: "guests",
          groupLabel: "Guests",
          roleSlug: "guest",
          capabilitySlug: null,
        }),
      ],
      SERVER_ROLE_RANK,
    );
    expect(chips).toHaveLength(2);
    const members = chips.find((c) => c.id === "g1");
    expect(members?.roleSlug).toBe("member");
    expect(Object.isFrozen(chips)).toBe(true);
    expect(Object.isFrozen(members)).toBe(true);
  });
});

describe("M213 foldRbacProjection", () => {
  test("unions capabilities across roles without browser filtering", () => {
    const rows: RbacMembershipFoldRow[] = [
      row({
        groupId: "g1",
        groupType: "contributors",
        groupLabel: "Contributors",
        roleSlug: "contributor",
        capabilitySlug: "use_destructive_tools",
      }),
      row({
        groupId: "g1",
        groupType: "contributors",
        groupLabel: "Contributors",
        roleSlug: "contributor",
        capabilitySlug: "use_high_impact_tools",
      }),
      row({
        groupId: "g2",
        groupType: "members",
        groupLabel: "Members",
        roleSlug: "member",
        capabilitySlug: "use_high_impact_tools",
      }),
      row({
        groupId: "g2",
        groupType: "members",
        groupLabel: "Members",
        roleSlug: "member",
        capabilitySlug: "not-a-known-capability-slug",
      }),
    ];

    const projection = foldRbacProjection(rows, SERVER_ROLE_RANK);
    expect(projection.highestRole).toBe("member");
    expect(projection.capabilitySlugs).toEqual([
      "use_destructive_tools",
      "use_high_impact_tools",
      "not-a-known-capability-slug",
    ]);
    expect(projection.groupChips).toHaveLength(2);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.capabilitySlugs)).toBe(true);
  });

  test("empty membership yields null highest role and empty sets", () => {
    const projection = foldRbacProjection([], SERVER_ROLE_RANK);
    expect(projection.highestRole).toBeNull();
    expect(projection.capabilitySlugs).toEqual([]);
    expect(projection.groupChips).toEqual([]);
  });

  test("cap union matches seeded role bundles for a dual-role group", () => {
    const contributorCaps = M128_ROLE_CAPABILITIES["contributor"] ?? [];
    const memberCaps = M128_ROLE_CAPABILITIES["member"] ?? [];
    const rows: RbacMembershipFoldRow[] = [
      ...contributorCaps.map((capabilitySlug) =>
        row({
          groupId: "g1",
          groupType: "members",
          groupLabel: "Members",
          roleSlug: "contributor",
          capabilitySlug,
        }),
      ),
      ...memberCaps.map((capabilitySlug) =>
        row({
          groupId: "g1",
          groupType: "members",
          groupLabel: "Members",
          roleSlug: "member",
          capabilitySlug,
        }),
      ),
    ];
    const projection = foldRbacProjection(rows, SERVER_ROLE_RANK);
    expect(projection.highestRole).toBe("member");
    for (const cap of memberCaps) {
      expect(projection.capabilitySlugs.includes(cap)).toBe(true);
    }
    expect(projection.groupChips[0]?.roleSlug).toBe("member");
  });
});

describe("M213 deepFreeze", () => {
  test("prevents shallow mutation of nested results", () => {
    const obj = deepFreeze({ items: ["a"], nested: { x: 1 } });
    expect(() => {
      obj.items.push("b");
    }).toThrow();
    expect(() => {
      (obj.nested as { x: number }).x = 2;
    }).toThrow();
  });
});
