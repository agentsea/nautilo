import type { CapabilitySlug, UiTargetId } from "@nautilo/types";

export type AdminSectionId =
  | "server"
  | "memory"
  | "stenographer"
  | "reflection"
  | "search"
  | "costs"
  | "users"
  | "moderation"
  | "invites"
  | "reports"
  | "audit-log"
  | "models"
  | "provider-credentials"
  | "official-mcps"
  | "security"
  | "encryption";

export type AdminDestinationId = AdminSectionId | "access-control";
export const ADMIN_ACCESS_CONTROL_ROUTE = "/admin/access-control";

interface AdminDestinationBase {
  id: AdminDestinationId;
  label: string;
  requiresAnyCap: readonly CapabilitySlug[];
  catalogueTarget: UiTargetId;
  selfManagedOnly?: boolean;
}

export interface AdminSectionConfig extends AdminDestinationBase {
  kind: "section";
  id: AdminSectionId;
  href: `#${AdminSectionId}`;
}

export interface AdminRouteConfig extends AdminDestinationBase {
  kind: "route";
  id: "access-control";
  href: typeof ADMIN_ACCESS_CONTROL_ROUTE;
}

export type AdminDestinationConfig = AdminSectionConfig | AdminRouteConfig;

/**
 * Canonical Admin destination order and availability. Page navigation, the
 * global rail, route bindings, and Genie targets derive from this manifest.
 */
export const ADMIN_DESTINATIONS = [
  { kind: "section", id: "server", href: "#server", label: "Server", requiresAnyCap: ["read_server_settings", "manage_server_settings"], catalogueTarget: "admin.server" },
  { kind: "section", id: "provider-credentials", href: "#provider-credentials", label: "API Keys", requiresAnyCap: ["manage_connection_providers", "manage_server_settings"], catalogueTarget: "admin.provider_credentials", selfManagedOnly: true },
  { kind: "section", id: "search", href: "#search", label: "Search", requiresAnyCap: ["read_server_settings"], catalogueTarget: "admin.search" },
  { kind: "section", id: "costs", href: "#costs", label: "Costs", requiresAnyCap: ["manage_billing"], catalogueTarget: "admin.costs" },
  { kind: "section", id: "models", href: "#models", label: "Models", requiresAnyCap: ["read_server_settings"], catalogueTarget: "admin.models" },
  { kind: "section", id: "memory", href: "#memory", label: "Memory", requiresAnyCap: ["read_server_settings"], catalogueTarget: "admin.memory" },
  { kind: "section", id: "stenographer", href: "#stenographer", label: "Stenographer", requiresAnyCap: ["read_server_settings"], catalogueTarget: "admin.stenographer" },
  { kind: "section", id: "reflection", href: "#reflection", label: "Reflection", requiresAnyCap: ["read_server_settings"], catalogueTarget: "admin.reflection" },
  { kind: "section", id: "users", href: "#users", label: "Users", requiresAnyCap: ["manage_members"], catalogueTarget: "admin.users" },
  { kind: "section", id: "moderation", href: "#moderation", label: "Moderation", requiresAnyCap: ["ban_server_members", "kick_server_members", "view_server_moderation", "manage_server_enrollment"], catalogueTarget: "admin.moderation" },
  { kind: "section", id: "invites", href: "#invites", label: "Invites", requiresAnyCap: ["manage_members"], catalogueTarget: "admin.invites" },
  { kind: "route", id: "access-control", href: ADMIN_ACCESS_CONTROL_ROUTE, label: "Access control", requiresAnyCap: ["manage_members", "manage_groups", "manage_roles"], catalogueTarget: "admin.access_control" },
  { kind: "section", id: "reports", href: "#reports", label: "Reports", requiresAnyCap: ["moderate_content_reports"], catalogueTarget: "admin.reports" },
  { kind: "section", id: "audit-log", href: "#audit-log", label: "Audit log", requiresAnyCap: ["view_audit_log"], catalogueTarget: "admin.audit_log" },
  { kind: "section", id: "official-mcps", href: "#official-mcps", label: "Server MCPs", requiresAnyCap: ["manage_server_security"], catalogueTarget: "admin.official_mcps" },
  { kind: "section", id: "security", href: "#security", label: "Security", requiresAnyCap: ["manage_server_security", "manage_uncontained_host_commands"], catalogueTarget: "admin.security" },
  { kind: "section", id: "encryption", href: "#encryption", label: "Encryption", requiresAnyCap: ["read_server_settings", "manage_server_settings"], catalogueTarget: "admin.encryption" },
] as const satisfies readonly AdminDestinationConfig[];

export type AdminCatalogueTarget = (typeof ADMIN_DESTINATIONS)[number]["catalogueTarget"];

export const ADMIN_SECTIONS: readonly AdminSectionConfig[] =
  ADMIN_DESTINATIONS.filter(
    (destination): destination is Extract<(typeof ADMIN_DESTINATIONS)[number], { kind: "section" }> =>
      destination.kind === "section",
  );

/** Caps that unlock the `/admin` destination (rail + page advisory gate). */
export const ADMIN_PAGE_CAPS: readonly CapabilitySlug[] = [
  ...new Set(ADMIN_DESTINATIONS.flatMap((destination) => destination.requiresAnyCap)),
];

export function adminDestinationAvailable(
  destination: AdminDestinationConfig,
  capabilities: readonly string[],
  managedByCloud: boolean | null = null,
): boolean {
  return destination.requiresAnyCap.some((capability) => capabilities.includes(capability))
    && (!destination.selfManagedOnly || managedByCloud === false);
}
