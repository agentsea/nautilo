/**
 * Canonical Capability slugs. D060 Sprint 1 G5.5 (ship plan v3 §5.5)
 * + M042D (the planned REL-CAP track).
 *
 * M129 — the canonical browser-safe union (`CAPABILITY_SLUGS` /
 * `CapabilitySlug` / `isCapabilitySlug`) now lives in `@nautilo/types`
 * so the renderer can import it without pulling node-only trust deps.
 * This module re-exports it and keeps the named `CAP_*` consts that
 * production code references by symbol. The DB `capabilities` table is
 * seeded from `packages/db/src/utils/seed-trust-personal.ts`
 * (`CAPABILITY_SEEDS`), which is the runtime source of truth; a parity
 * test asserts the `@nautilo/types` union matches the seed.
 *
 * Add new capabilities by:
 *   1. Adding the slug to `CAPABILITY_SLUGS` in `@nautilo/types`.
 *   2. Updating CAPABILITY_SEEDS in seed-trust-personal.ts.
 *   3. Updating the server-wide Role ladder bundles in
 *      seed-trust-personal.ts as appropriate (M128 — per-group-type
 *      splits retired; `manage_agents` is admin-tier per D4-A).
 *   4. Re-seeding the DB (upsert semantics in seed-trust-personal.ts).
 */

export {
  CAPABILITY_SLUGS,
  isCapabilitySlug,
  type CapabilitySlug,
} from "@nautilo/types";

/**
 * Can mutate the Server's deployment_mode + security_level +
 * security-adjacent config fields. Holder of this cap is the
 * addressee of `PUT /api/security/posture`; missing it → 403
 * (`capability_check_failed` audit row). Bundled only into the Owner Role on
 * the server-wide ladder (ship plan v3 §5.5).
 */
export const CAP_MANAGE_SERVER_SECURITY = "manage_server_security" as const;
export const CAP_INVOKE_AGENTS = "invoke_agents" as const;
export const CAP_WRITE_ARTIFACTS = "write_artifacts" as const;

// Existing M042D caps — kept here as a reference point so the
// canonical list is discoverable in one module. Seed values live in
// packages/db/src/utils/seed-trust-personal.ts which is the single
// source of truth the DB ingests.
export const CAP_APPROVE_SPENDING = "approve_spending" as const;
export const CAP_MANAGE_BILLING = "manage_billing" as const;
export const CAP_CONTROL_DESKTOP = "control_desktop" as const;
export const CAP_CONTROL_BROWSER = "control_browser" as const;
export const CAP_USE_PROJECT_CONTENT = "use_project_content" as const;
export const CAP_USE_PROJECT_EXECUTION = "use_project_execution" as const;
export const CAP_USE_WORKSTATION = "use_workstation" as const;
export const CAP_USE_REMOTE_HOSTS = "use_remote_hosts" as const;
export const CAP_USE_CONNECTIONS = "use_connections" as const;
export const CAP_USE_MEDIA_GENERATION = "use_media_generation" as const;
export const CAP_USE_GOOGLE_WORKSPACE = "use_google_workspace" as const;
export const CAP_CONTROL_HOME = "control_home" as const;
export const CAP_MANAGE_MEMBERS = "manage_members" as const;
export const CAP_CREATE_INVITES = "create_invites" as const;
export const CAP_MANAGE_STANDING_APPROVALS = "manage_standing_approvals" as const;
export const CAP_MODERATE_CONTENT_REPORTS = "moderate_content_reports" as const;

/**
 * D418 — Workstation Profile RBAC. Two device-scoped caps, separable from
 * global `manage_server_security`:
 *
 *   - `use_workstation`: gates workstation use and approved-profile activation
 *     on the caller's paired desktop. Activation requires this capability,
 *     the caller's own fresh PIN, and a paired binding — not
 *     `control_desktop`. Default bundle: Owner / Admin / Superuser / Member.
 *   - `manage_workstation_profiles`: gates device-scoped profile
 *     create / edit / approve / delegate (editor's own fresh PIN). Default
 *     bundle: Owner + Admin; separable from `manage_server_security`.
 *
 * Capability seeds and default role bundles live in
 * `packages/db/src/utils/seed-trust-personal.ts`.
 *
 * NOTE: these canonical symbols live here, but the `@nautilo/trust` barrel
 * (`./index.ts`) does not yet re-export them — that one-line addition is
 * tracked as a D418 follow-up so callers can import them by symbol the
 * same way they import `CAP_CONTROL_DESKTOP`. Until then, the
 * workstation-access route references the stable slug literal directly.
 */
export const CAP_MANAGE_WORKSTATION_PROFILES = "manage_workstation_profiles" as const;

/**
 * D538 — manages the default-off uncontained-host-command policy and the one
 * protected per-Human grant group. It is an Owner/Admin capability; the later
 * Superuser-or-above execution floor remains independent of this management
 * authority.
 */
export const CAP_MANAGE_UNCONTAINED_HOST_COMMANDS =
  "manage_uncontained_host_commands" as const;
