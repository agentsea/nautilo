import { expect, test } from "bun:test";
import {
  canManageGroupMembership,
  groupCapabilityBundle,
  isCommunityEnrollmentTarget,
  missingGroupMembershipCapabilities,
} from "./group-membership-authority";

const catalogue = {
  capabilities: [],
  roles: [
    { id: "member-role", slug: "member", label: "Member", isSystem: true, capabilitySlugs: ["invoke_agents", "create_rooms"], groupCount: 1 },
    { id: "billing-role", slug: "billing", label: "Billing", isSystem: false, capabilitySlugs: ["manage_billing"], groupCount: 1 },
  ],
  groups: [
    { id: "combined", type: "custom:combined", label: "Combined", isSystem: false, ownerId: "owner", roleSlugs: ["member", "billing"], memberCount: 0 },
  ],
} as const;

const group = catalogue.groups[0];

test("membership authority includes every Capability in the target Group bundle", () => {
  expect(groupCapabilityBundle(catalogue, group)).toEqual([
    "create_rooms",
    "invoke_agents",
    "manage_billing",
  ]);
  expect(missingGroupMembershipCapabilities(
    catalogue,
    group,
    ["manage_members", "create_rooms", "invoke_agents"],
  )).toEqual(["manage_billing"]);
  expect(canManageGroupMembership(
    catalogue,
    group,
    ["manage_members", "create_rooms", "invoke_agents"],
  )).toBeFalse();
  expect(canManageGroupMembership(
    catalogue,
    group,
    ["manage_members", "create_rooms", "invoke_agents", "manage_billing"],
  )).toBeTrue();
});

test("recognizes canonical and custom Community enrollment targets", () => {
  expect(isCommunityEnrollmentTarget({
    id: "communities", type: "communities", label: "Communities", isSystem: true,
    ownerId: null, roleSlugs: ["community"], memberCount: 0,
  })).toBeTrue();
  expect(isCommunityEnrollmentTarget({
    id: "custom", type: "custom:community", label: "Community helpers", isSystem: false,
    ownerId: "owner", roleSlugs: ["community", "billing"], memberCount: 0,
  })).toBeTrue();
  expect(isCommunityEnrollmentTarget(group)).toBeFalse();
});
