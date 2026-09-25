/**
 * M129 — canonical, browser-safe Capability slug union. Single-sourced
 * here so the renderer can import it for `can(cap)` without pulling
 * `@nautilo/trust` (which transitively imports node-only modules).
 *
 * The runtime source of truth is the DB seed
 * (`packages/db/src/utils/seed-trust-personal.ts::CAPABILITY_SEEDS`).
 * A parity test (Phase 1.4) asserts this list === the seed list.
 * Keep this list aligned with the seed through the capability parity test.
 */
export const CAPABILITY_SLUGS = [
  "manage_members",
  "create_invites",
  "manage_groups",
  "manage_roles",
  "manage_agents",
  "invoke_agents",
  "invoke_other_agents",
  "use_personal_provider_credentials",
  "use_server_provider_credentials",
  "create_rooms",
  "manage_rooms",
  "read_server_settings",
  "manage_server_operations",
  "manage_connection_providers",
  "manage_server_settings",
  "manage_server_security",
  "view_audit_log",
  "moderate_content_reports",
  "timeout_server_members",
  "kick_server_members",
  "ban_server_members",
  "view_server_moderation",
  "manage_server_enrollment",
  "timeout_room_members",
  "kick_room_members",
  "ban_room_members",
  "view_room_moderation",
  "use_project_content",
  "use_project_execution",
  "use_workstation",
  "use_remote_hosts",
  "use_connections",
  "use_media_generation",
  "use_research_tools",
  "use_image_generation",
  "use_transcription",
  "write_artifacts",
  "use_share_artifact",
  "read_memories",
  "manage_memories",
  "control_desktop",
  "control_browser",
  "use_google_workspace",
  "control_home",
  "manage_workstation_profiles",
  "manage_uncontained_host_commands",
  "approve_spending",
  "manage_billing",
  "manage_standing_approvals",
  "approve_destructive_actions",
] as const;

export type CapabilitySlug = (typeof CAPABILITY_SLUGS)[number];

/** True when `slug` is a known canonical Capability. */
export function isCapabilitySlug(slug: string): slug is CapabilitySlug {
  return (CAPABILITY_SLUGS as readonly string[]).includes(slug);
}
