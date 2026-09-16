import type { CapabilitySlug, UiTargetId } from "@nautilo/types";

export const ACCESS_CONTROL_TAB_IDS = ["users", "groups", "roles", "capabilities", "audit"] as const;
export type AccessControlTabId = (typeof ACCESS_CONTROL_TAB_IDS)[number];

export type AccessControlTab = {
  id: AccessControlTabId;
  label: string;
  available: boolean;
  catalogueTarget?: UiTargetId;
};

export function accessControlTabs(can: (capability: CapabilitySlug) => boolean): AccessControlTab[] {
  const manager = can("manage_members") || can("manage_groups") || can("manage_roles");
  return [
    { id: "users", label: "Users", available: can("manage_members"), catalogueTarget: "admin.access_control.users" },
    { id: "groups", label: "Groups", available: can("manage_groups"), catalogueTarget: "admin.access_control.groups" },
    { id: "roles", label: "Permission sets", available: can("manage_roles"), catalogueTarget: "admin.access_control.roles" },
    { id: "capabilities", label: "Permissions catalog", available: manager, catalogueTarget: "admin.access_control.capabilities" },
    // The audit reader has not landed. Do not route a permitted caller into
    // a broken panel; retain a truthful disabled affordance instead.
    { id: "audit", label: "Audit", available: false },
  ];
}
