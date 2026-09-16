/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  accessOverview,
  capabilityStatusLabel,
  provenanceSummary,
  roleLabel,
  viewerFreshnessNotice,
  type EffectiveAccess,
} from "./access-presentation";

const verifiedAccess: EffectiveAccess = {
  user: { id: "user-1", handle: "mira", displayName: "Mira", server: "Nautilo" },
  highestRole: "owner",
  capabilities: [
    {
      slug: "manage_rooms",
      description: "Create and manage rooms",
      category: "rooms",
      granted: true,
      provenance: [{
        groupId: "group-owners",
        groupType: "workspace",
        groupLabel: "Workspace owners",
        groupIsSystem: true,
        groupOwnerId: null,
        roleSlug: "owner",
        roleLabel: "Owner",
        roleIsSystem: true,
      }],
    },
    {
      slug: "manage_users",
      description: "Manage other people",
      category: "people",
      granted: false,
      provenance: [],
    },
  ],
  groups: [],
  roles: [],
  groupRoleFacts: [],
};

describe("effective access presentation", () => {
  test("shows the server-calculated highest role and separates granted and denied capabilities", () => {
    const overview = accessOverview(verifiedAccess);
    expect(overview.highestRole).toBe("owner");
    expect(overview.granted.map((capability) => capability.slug)).toEqual(["manage_rooms"]);
    expect(overview.denied.map((capability) => capability.slug)).toEqual(["manage_users"]);
    const deniedCapability = overview.denied.find((capability) => capability.slug === "manage_users");
    if (!deniedCapability) throw new Error("Fixture must include the denied capability.");
    expect(capabilityStatusLabel(deniedCapability)).toBe("Not granted");
  });

  test("represents an empty/no-grants response without inventing a role", () => {
    const overview = accessOverview({ ...verifiedAccess, highestRole: null, capabilities: [] });
    expect(overview).toMatchObject({ highestRole: null, granted: [], denied: [], hasAnyGrant: false });
    expect(roleLabel(overview.highestRole)).toBe("No role granted");
  });

  test("keeps server provenance intact for the focused source detail", () => {
    const path = verifiedAccess.capabilities.flatMap((capability) => capability.provenance)[0];
    if (!path) throw new Error("Fixture must include a provenance path.");
    expect(provenanceSummary(path)).toBe("Workspace owners · Owner");
  });

  test("marks a stale cached viewer without treating it as access authority", () => {
    expect(viewerFreshnessNotice("stale")).toContain("before Nautilo reads your access");
    expect(viewerFreshnessNotice("verified")).toBeNull();
  });

  test("never substitutes cached viewer capabilities for the canonical access read", () => {
    const staleViewerCapabilities = ["manage_users", "delete_everything"];
    const overview = accessOverview(verifiedAccess);

    // The presentation API intentionally has no viewer/capability parameter;
    // a stale cache therefore cannot turn this canonical denial into a grant.
    expect(staleViewerCapabilities).toContain("manage_users");
    expect(overview.denied.map((capability) => capability.slug)).toContain("manage_users");
    expect(overview.granted.map((capability) => capability.slug)).not.toContain("manage_users");
  });
});
