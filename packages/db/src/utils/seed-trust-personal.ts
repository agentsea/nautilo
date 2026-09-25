import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, count, isNull, and, sql as dsql, inArray } from "drizzle-orm";
import {
  actors,
  capabilities,
  roles,
  roleCapabilities,
  groups,
  groupRoles,
  groupMembers,
  channelIdentities,
} from "../schema/trust";
import { sessions } from "../schema/sessions";
import { users } from "../schema/users";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import { resolveDirectDatabaseConnectionString } from "../config/direct-database";

// ---------------------------------------------------------------------------
// Capability seeds — M128 catalogue + later approved additions.
// ---------------------------------------------------------------------------

export const CAPABILITY_SEEDS = [
  // identity
  { slug: "manage_members", description: "Add/remove Humans on the Server (invite, redeem, kick)", category: "identity" },
  { slug: "create_invites", description: "Create and manage bounded, creator-scoped Server invitations", category: "identity" },
  { slug: "manage_groups", description: "Create/rename/delete Groups; assign Roles to Groups", category: "identity" },
  { slug: "manage_roles", description: "Create/rename/delete Roles; assign Capabilities to Roles", category: "identity" },
  // agents
  { slug: "manage_agents", description: "Create Agents; edit Profile/Soul/Avatar (gates regenerate_soul, manage_profile)", category: "agents" },
  { slug: "invoke_agents", description: "Start or resume Agent execution through chat, Jobs, Tasks, and schedules.", category: "agents" },
  { slug: "invoke_other_agents", description: "Address a Genie owned by another Human, subject to existing invocation and scope checks.", category: "agents" },
  { slug: "use_personal_provider_credentials", description: "Use provider credentials owned by the authenticated Human when personal funding is available.", category: "agents" },
  { slug: "use_server_provider_credentials", description: "Use instance-owned provider credentials for an otherwise permitted Human-initiated operation.", category: "agents" },
  // rooms
  { slug: "create_rooms", description: "Create shared private Rooms on the Server", category: "rooms" },
  { slug: "manage_rooms", description: "Administer any Room on the Server", category: "rooms" },
  // server settings + security
  { slug: "read_server_settings", description: "Read safe server policy and operational configuration", category: "server_settings" },
  { slug: "manage_server_operations", description: "Manage safe non-secret server policy (identity, models, context retention, web research)", category: "server_settings" },
  { slug: "manage_connection_providers", description: "Configure server-wide provider API keys and connected-app OAuth credentials", category: "server_settings" },
  { slug: "manage_server_settings", description: "Mutate owner-only runtime configuration and secrets (gates update_config)", category: "server_settings" },
  { slug: "manage_server_security", description: "Mutate security posture (deployment_mode, security_level)", category: "server_security" },
  // audit
  { slug: "view_audit_log", description: "Read the server-wide security audit log", category: "audit" },
  { slug: "moderate_content_reports", description: "Review and close Server-local content reports, including canonical deletion of reported messages", category: "audit" },
  { slug: "timeout_server_members", description: "Timeout server members", category: "moderation" },
  { slug: "kick_server_members", description: "Kick server members", category: "moderation" },
  { slug: "ban_server_members", description: "Ban server members", category: "moderation" },
  { slug: "view_server_moderation", description: "View server moderation", category: "moderation" },
  { slug: "manage_server_enrollment", description: "Manage server enrollment", category: "moderation" },
  { slug: "timeout_room_members", description: "Timeout room members", category: "moderation" },
  { slug: "kick_room_members", description: "Kick room members", category: "moderation" },
  { slug: "ban_room_members", description: "Ban room members", category: "moderation" },
  { slug: "view_room_moderation", description: "View room moderation", category: "moderation" },
  // ordinary product surfaces
  { slug: "use_project_content", description: "Read and work with project content in the caller's owned or granted scope.", category: "tools" },
  { slug: "use_project_execution", description: "Run project-scoped execution in the caller's owned or granted scope.", category: "tools" },
  { slug: "use_workstation", description: "Use the paired Workstation, including Terminal and approved Workstation Profile activation.", category: "devices" },
  { slug: "use_remote_hosts", description: "Use the caller's owned or granted remote-host bindings.", category: "tools" },
  { slug: "use_connections", description: "Use Connections reachable through the caller's Agent and Namespace scope.", category: "tools" },
  { slug: "use_media_generation", description: "Use media-generation surfaces in the caller's owned or granted scope.", category: "tools" },
  { slug: "use_research_tools", description: "run_deep_research and large external-API-budget tools", category: "tools" },
  { slug: "use_image_generation", description: "generate_image", category: "tools" },
  { slug: "use_transcription", description: "transcribe_audio", category: "tools" },
  { slug: "write_artifacts", description: "Create or mutate Workspace Artifacts, documents, and mini-app state.", category: "artifacts" },
  { slug: "use_share_artifact", description: "share_artifact (cross-Room attachment)", category: "tools" },
  // memory
  { slug: "read_memories", description: "Read memories from any reachable Namespace (gates search_memory)", category: "memory" },
  { slug: "manage_memories", description: "Write/edit/share memories in any reachable Namespace (gates manage_memory, share_memory)", category: "memory" },
  // devices
  { slug: "control_desktop", description: "High-impact desktop automation via relay (screen capture, click, type — D291)", category: "devices" },
  { slug: "control_browser", description: "Embedded SaaS browser automation via relay (agent-browser observe/act on app surfaces — D336)", category: "devices" },
  { slug: "use_google_workspace", description: "Google Workspace API automation via local gog/gogcli relay (D138)", category: "tools" },
  { slug: "control_home", description: "Low-impact smart-home control via relay (Hue/Sonos — D055)", category: "devices" },
// Profile management remains admin-tier. Profile activation is part of
// the ordinary `use_workstation` surface above.
  { slug: "manage_workstation_profiles", description: "Create/edit/approve/delegate device-scoped Workstation Profile templates/deltas using the editor's own fresh PIN (D418 — separable from manage_server_security)", category: "devices" },
  { slug: "manage_uncontained_host_commands", description: "Manage the default-off uncontained host commands policy and memberships in its protected positive-grant Group (D538)", category: "server_security" },
  // billing
  { slug: "approve_spending", description: "Authorize financial transactions", category: "billing" },
  { slug: "manage_billing", description: "Payment methods, invoices", category: "billing" },
  { slug: "manage_standing_approvals", description: "Create/modify standing-approval rules (M037)", category: "billing" },
  // approvals
  { slug: "approve_destructive_actions", description: "Eligibility to appear in routeApproval's prove_it approver pool", category: "approvals" },
] as const;

// ---------------------------------------------------------------------------
// Role seeds — canonical strict-subset ladder.
// owner ⊃ admin ⊃ superuser ⊃ member ⊃ contributor ⊃ community ⊃ guest.
// ---------------------------------------------------------------------------

type RoleSeed = {
  slug: string;
  label: string;
  capabilitySlugs: string[];
};

// Capability bundles as additive deltas; see grid in permission-model.md §6.
// `admin` = owner minus posture; `superuser` = admin minus meta-admin;
// `member` = superuser minus server-wide administration and approvals;
// `contributor` = member minus non-collaboration product surfaces;
// `community` = contributor minus server-funded and cross-owner invocation;
// `guest` = nothing.

const ALL_CAP_SLUGS = CAPABILITY_SEEDS.map((c) => c.slug);

const ADMIN_REMOVES = new Set([
  "manage_server_settings",
  "manage_server_security",
]);
// M128 D4-A (2026-05-28): `manage_agents` is the gate for editing OTHER
// Humans' Agents. Editing your own Personal Agent (`agents.ownerId ===
// userId`) is unconditional via the two-gate body check in
// routes/profile.ts + tools/regenerate_soul / manage_profile. Therefore
// the cap belongs only to admin-tier rungs (owner + admin); we strip it
// from superuser and below. See permission-model.md §7 item 9.
const SUPERUSER_REMOVES = new Set([
  ...ADMIN_REMOVES,
  "manage_server_operations",
  // D538 — the protected grant/policy manager is Owner/Admin-only. This is
  // management authority, not the independent later execution role floor.
  "manage_uncontained_host_commands",
  "manage_connection_providers",
  "manage_members",
  "manage_groups",
  "manage_roles",
  "manage_agents",
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
  "manage_billing",
  // Device-scoped profile management is admin-tier (Owner + Admin).
  "manage_workstation_profiles",
]);
const MEMBER_REMOVES = new Set([
  ...SUPERUSER_REMOVES,
  // Server configuration is an administrative surface. Ordinary research
  // status uses `use_research_tools`; Members do not need this broad read.
  "read_server_settings",
  // D543 — ordinary social creation is `create_rooms`; `manage_rooms` is
  // server-wide Room administration and stops at Superuser.
  "manage_rooms",
  "approve_destructive_actions",
  "approve_spending",
  "manage_standing_approvals",
]);
const CONTRIBUTOR_REMOVES = new Set([
  ...MEMBER_REMOVES,
  "create_invites",
  "use_project_execution",
  "use_workstation",
  "use_remote_hosts",
  "use_connections",
  "use_media_generation",
  "control_desktop",
  "control_browser",
  "use_google_workspace",
  "control_home",
]);
const COMMUNITY_REMOVES = new Set([
  ...CONTRIBUTOR_REMOVES,
  "use_server_provider_credentials",
  "invoke_other_agents",
]);

/**
 * D556 compatibility widening applied to every existing Role before the
 * retired capability rows are removed. Kept exported for focused regression
 * proof; the seed remains the only persistence/reconciliation authority.
 */
export const RETIRED_CAPABILITY_REPLACEMENTS: Readonly<Record<string, readonly string[]>> = {
  use_high_impact_tools: [
    "use_project_content",
    "use_project_execution",
    "use_workstation",
    "use_remote_hosts",
    "use_connections",
    "use_media_generation",
  ],
  use_terminal: ["use_workstation"],
  use_workstation_profiles: ["use_workstation"],
  // This slug was never a production authority gate. It is pruned with no
  // replacement rather than perpetuating a meaningless permission.
  use_destructive_tools: [],
};

/**
 * Compatibility widening for existing user-managed Roles. Each source
 * Capability named here was sufficient to enter a server-funded provider path
 * before the funding boundary became explicit. Invocation also carried the
 * prior ability to address any otherwise reachable Genie. Personal credential
 * authority is intentionally absent because it did not exist before.
 */
export const CUSTOM_ROLE_COMPATIBILITY_GRANTS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  invoke_agents: Object.freeze([
    "invoke_other_agents",
    "use_server_provider_credentials",
  ]),
  manage_agents: Object.freeze(["use_server_provider_credentials"]),
  use_research_tools: Object.freeze(["use_server_provider_credentials"]),
  use_image_generation: Object.freeze(["use_server_provider_credentials"]),
  use_media_generation: Object.freeze(["use_server_provider_credentials"]),
  use_transcription: Object.freeze(["use_server_provider_credentials"]),
  use_connections: Object.freeze(["use_server_provider_credentials"]),
  use_project_content: Object.freeze(["use_server_provider_credentials"]),
});

function capsExcept(removes: Set<string>): string[] {
  return ALL_CAP_SLUGS.filter((s) => !removes.has(s));
}

const ROLE_SEEDS: RoleSeed[] = [
  { slug: "owner",       label: "Owner",       capabilitySlugs: [...ALL_CAP_SLUGS] },
  { slug: "admin",       label: "Admin",       capabilitySlugs: capsExcept(ADMIN_REMOVES) },
  { slug: "superuser",   label: "Superuser",   capabilitySlugs: capsExcept(SUPERUSER_REMOVES) },
  { slug: "member",      label: "Member",      capabilitySlugs: capsExcept(MEMBER_REMOVES) },
  { slug: "contributor", label: "Contributor", capabilitySlugs: capsExcept(CONTRIBUTOR_REMOVES) },
  { slug: "community",   label: "Community",   capabilitySlugs: capsExcept(COMMUNITY_REMOVES) },
  { slug: "guest",       label: "Guest",       capabilitySlugs: [] },
];

// ---------------------------------------------------------------------------
// Group seeds — canonical server-wide Groups (one per ladder Role).
// Only `owners` is seeded with a member (the bootstrap claimer).
//
// The canonical ladder Groups are
// platform/system-managed authorization objects (is_system=true,
// owner_id=NULL), exactly like the ladder Roles (`roles.is_system`).
// They are independent of any Human account lifecycle: deleting a
// Human (including the bootstrap owner) must NOT cascade-delete
// them or their memberships. The `groups_system_owner_check` CHECK
// constraint (migration 0100) enforces exactly one valid state per
// row: system-managed ⇔ no Human owner; user-managed ⇔ one.
// ---------------------------------------------------------------------------

type GroupSeed = { type: string; label: string; roleSlug: string };

// D538 — this protected Role/Group pair represents only an explicit positive
// Human grant. It is intentionally outside the canonical ladder: it carries
// no Capability, changes no role rank, and starts with no memberships.
export const UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG =
  "uncontained_host_commands_grantee";
export const UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE =
  "uncontained_host_commands_grantees";

const GROUP_SEEDS: GroupSeed[] = [
  { type: "owners",       label: "Owners",       roleSlug: "owner" },
  { type: "admins",       label: "Admins",       roleSlug: "admin" },
  { type: "superusers",   label: "Superusers",   roleSlug: "superuser" },
  { type: "members",      label: "Members",      roleSlug: "member" },
  { type: "contributors", label: "Contributors", roleSlug: "contributor" },
  { type: "communities",  label: "Communities",  roleSlug: "community" },
  { type: "guests",       label: "Guests",       roleSlug: "guest" },
];

/** Exported so tests / tooling can reason about the canonical catalogue. */
export const M128_CAPABILITY_SLUGS: readonly string[] = ALL_CAP_SLUGS;
export const M128_ROLE_SLUGS = [
  "owner",
  "admin",
  "superuser",
  "member",
  "contributor",
  "community",
  "guest",
] as const;
export const M128_GROUP_TYPES = GROUP_SEEDS.map((g) => g.type);
export const M128_ROLE_CAPABILITIES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(ROLE_SEEDS.map((r) => [r.slug, Object.freeze([...r.capabilitySlugs])])),
);

/**
 * Channels where the owner's presence is trusted at boot on an OSS
 * single-owner deployment. M042C seeds one `channel_identities` row
 * per (owner, channel) pair; M041 pairing adds rows for other
 * channels at runtime.
 */
// M054 — `"workbench"` added so the M052 preHandler's Logto branch
// (which hardcodes `channel="workbench"`) finds a binding for the
// pre-existing local owner. Without it, `findUserByChannelIdentity`
// returns null and the resolver falls through to the stranger path
// → 401s on capability-gated routes (`/api/security/posture`,
// `/api/security/audit-log`) and the workbench badge stuck on Guest.
// The seed reconciles all three channels on every boot.
const OWNER_BOOT_CHANNELS = ["tui", "electron", "workbench"] as const;

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

/**
 * Seeds trust-layer tables for Personal mode. Idempotent — safe to call
 * on every startup. Creates:
 * - Actor for the owner (user-kind; kept for room_members polymorphism
 *   and for the small number of audit fields that still reference
 *   `actors.id`)
 * - canonical capabilities (M128 catalogue + later approved additions)
 * - canonical ladder Roles (`owner`, `admin`, `superuser`, `member`,
 *   `contributor`, `community`, `guest`), with Community as the seventh rung
 * - Role → capability mappings
 * - canonical Groups, each mapped to one ladder Role via the
 *   `group_roles` junction (M131; was the 1:1 `groups.role_id` pre-M131)
 *
 * M044: this seed NO LONGER mints Namespaces. Per REL-NSP-RMS the
 * owner's private Namespace is born when the private Room is minted
 * by `seedDefaultRoom`; the `system` Namespace stops existing
 * entirely. Return shape collapses from `{ actorId, privateNamespaceId,
 * systemNamespaceId }` to `{ actorId }`.
 *
 * M042C additions (still in force):
 * - Reconciles `channel_identities` rows for the owner on the TUI and
 *   Electron channels with the current `@handle@server` federated id.
 *   If the handle changed since last boot, the rows are UPDATEd in
 *   place. Post-M043, these rows FK directly to `users.id`.
 * - Backfills `sessions.channel = 'tui'` for any session that still
 *   has `channel IS NULL`.
 */
export async function seedTrustPersonal(
  ownerId: string,
  ownerName: string,
  log?: (message: string) => void,
): Promise<{ actorId: string }> {
  const print = log ?? (() => {});
  const directConnection = resolveDirectDatabaseConnectionString();

  const sql = postgres(directConnection, { max: 1 });
  const db = drizzle(sql);

  try {
    // 1. Owner actor (idempotent: filter kind='user' so we never
    //    accidentally match the agent-actor mirror seeded by
    //    seedDefaultAgent on later boots).
    const [existingActor] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.ownerId, ownerId), eq(actors.kind, "user")))
      .limit(1);

    let actorId: string;
    if (existingActor) {
      actorId = existingActor.id;
    } else {
      print("Creating owner actor...");
      const [newActor] = await db
        .insert(actors)
        .values({ ownerId, displayName: ownerName, trustState: "verified", kind: "user" })
        .returning({ id: actors.id });
      if (!newActor) throw new Error("Failed to create owner actor");
      actorId = newActor.id;
    }

    // 2. M044 — Namespace seeding removed from this seed entirely.
    //    Per REL-NSP-RMS the private Namespace is minted by
    //    `seedDefaultRoom` in the same transaction as the private
    //    Room; the `system` Namespace stops existing (scope dissolves
    //    in the canonical model).

    // 3. Capabilities (idempotent via ON CONFLICT on slug). Upsert
    //    covers new slugs added to CAPABILITY_SEEDS against an
    //    already-seeded DB (D060 Sprint 1 G5.5 finding: pre-M043
    //    "seed if empty" silently skipped new slugs without a wipe).
    await db
      .insert(capabilities)
      .values([...CAPABILITY_SEEDS])
      .onConflictDoNothing({ target: capabilities.slug });

    // D556 — migrate custom Role grants before pruning the retired rows.
    // Canonical ladder Roles are reconciled to the exact bundles below; this
    // widening protects custom Roles that previously held the generic or
    // fragmented workstation grants. Re-running the seed is safe because the
    // role_capabilities junction has a unique (role, capability) key.
    const retiringSlugs = Object.keys(RETIRED_CAPABILITY_REPLACEMENTS);
    const seededCapabilities = await db.select().from(capabilities);
    const capabilityIdsBySlug = new Map(seededCapabilities.map((capability) => [capability.slug, capability.id]));

    // Preserve the effective authority of existing custom Roles before the
    // new checks become active. This only widens user-managed Roles from
    // explicit historical grants; canonical Roles are reconciled below and
    // personal-key authority is never inferred.
    const compatibilitySourceSlugs = Object.keys(
      CUSTOM_ROLE_COMPATIBILITY_GRANTS,
    );
    const compatibilityGrants = await db
      .select({
        roleId: roleCapabilities.roleId,
        capabilitySlug: capabilities.slug,
      })
      .from(roleCapabilities)
      .innerJoin(capabilities, eq(roleCapabilities.capabilityId, capabilities.id))
      .innerJoin(roles, eq(roleCapabilities.roleId, roles.id))
      .where(
        and(
          eq(roles.isSystem, false),
          inArray(capabilities.slug, compatibilitySourceSlugs),
        ),
      );

    for (const grant of compatibilityGrants) {
      for (const targetSlug of
        CUSTOM_ROLE_COMPATIBILITY_GRANTS[grant.capabilitySlug] ?? []) {
        const targetId = capabilityIdsBySlug.get(targetSlug);
        if (!targetId) {
          throw new Error(
            `custom Role compatibility capability missing from catalogue: ${targetSlug}`,
          );
        }
        await db
          .insert(roleCapabilities)
          .values({ roleId: grant.roleId, capabilityId: targetId })
          .onConflictDoNothing({
            target: [roleCapabilities.roleId, roleCapabilities.capabilityId],
          });
      }
    }

    const retiringGrants = await db
      .select({ roleId: roleCapabilities.roleId, capabilitySlug: capabilities.slug })
      .from(roleCapabilities)
      .innerJoin(capabilities, eq(roleCapabilities.capabilityId, capabilities.id))
      .where(inArray(capabilities.slug, retiringSlugs));

    for (const grant of retiringGrants) {
      for (const replacementSlug of RETIRED_CAPABILITY_REPLACEMENTS[grant.capabilitySlug] ?? []) {
        const replacementId = capabilityIdsBySlug.get(replacementSlug);
        if (!replacementId) continue;
        await db
          .insert(roleCapabilities)
          .values({ roleId: grant.roleId, capabilityId: replacementId })
          .onConflictDoNothing({
            target: [roleCapabilities.roleId, roleCapabilities.capabilityId],
          });
      }
    }

    const retiredCapabilityIds = retiringSlugs
      .map((slug) => capabilityIdsBySlug.get(slug))
      .filter((id): id is string => Boolean(id));
    if (retiredCapabilityIds.length > 0) {
      await db
        .delete(roleCapabilities)
        .where(inArray(roleCapabilities.capabilityId, retiredCapabilityIds));
      await db.delete(capabilities).where(inArray(capabilities.id, retiredCapabilityIds));
      log?.(`[seed] migrated and pruned retired capability slugs: ${retiringSlugs.join(", ")} (D556)`);
    }

    // D291 — prune the retired `control_devices` slug (renamed to
    // `control_desktop` + `control_home`). The upsert above never deletes,
    // so an already-seeded DB would keep the orphan capability row and any
    // grants to it. Delete grants first (FK), then the row. Scoped WHERE
    // (single slug) — idempotent on fresh DBs where the row never existed.
    const [legacyDevicesCap] = await db
      .select({ id: capabilities.id })
      .from(capabilities)
      .where(eq(capabilities.slug, "control_devices"));
    if (legacyDevicesCap) {
      await db
        .delete(roleCapabilities)
        .where(eq(roleCapabilities.capabilityId, legacyDevicesCap.id));
      await db.delete(capabilities).where(eq(capabilities.id, legacyDevicesCap.id));
      log?.("[seed] pruned retired capability slug: control_devices (D291)");
    }

    // 4. Roles + role_capabilities. M128: the catalogue is the single
    //    source of truth, so we WIPE role_capabilities for the canonical
    //    M128 Roles and re-insert from the seed. This replaces the
    //    pre-M128 "INSERT ON CONFLICT DO NOTHING" pattern which silently
    //    failed to remove a capability that had been retired from a
    //    Role's bundle (e.g. dropping `write_shared_memory` from
    //    `household` would have left the row orphaned).
    const allCaps = await db.select().from(capabilities);
    const capsBySlug = new Map(allCaps.map((c) => [c.slug, c.id]));

    for (const seed of ROLE_SEEDS) {
      await db
        .insert(roles)
        .values({
          slug: seed.slug,
          label: seed.label,
          isSystem: true,
        })
        .onConflictDoNothing({ target: roles.slug });
    }

    // Re-read roles to get stable ids for capability mapping (covers
    // both fresh-insert and already-seeded paths uniformly).
    let allRoles = await db.select().from(roles);
    const existingCommunityRole = allRoles.find(
      (role) => role.slug === "community",
    );
    if (existingCommunityRole && !existingCommunityRole.isSystem) {
      throw new Error(
        "Community role collision: community is not system-managed",
      );
    }
    const existingGranteeRole = allRoles.find(
      (role) => role.slug === UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG,
    );
    if (existingGranteeRole && !existingGranteeRole.isSystem) {
      throw new Error(
        `D538 protected role collision: ${UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG} is not system-managed`,
      );
    }
    if (!existingGranteeRole) {
      await db.insert(roles).values({
        slug: UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG,
        label: "Uncontained Host Commands Grantee",
        isSystem: true,
      });
      allRoles = await db.select().from(roles);
    }
    const rolesBySlug = new Map(allRoles.map((r) => [r.slug, r.id]));
    const granteeRoleId = rolesBySlug.get(
      UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG,
    );
    if (!granteeRoleId) {
      throw new Error("D538 protected role missing after seed");
    }

    // M128 reseed: clear role_capabilities for the canonical Roles, then
    // re-insert per CAPABILITY_SEEDS × ROLE_SEEDS. The DELETE is scoped
    // to the M128 role ids so any custom Role rows added outside this
    // seed are left alone.
    const m128RoleIds = ROLE_SEEDS
      .map((seed) => rolesBySlug.get(seed.slug))
      .filter((id): id is string => Boolean(id));
    if (m128RoleIds.length > 0) {
      await db
        .delete(roleCapabilities)
        .where(inArray(roleCapabilities.roleId, m128RoleIds));
    }

    for (const seed of ROLE_SEEDS) {
      const roleId = rolesBySlug.get(seed.slug);
      if (!roleId) continue;
      for (const capSlug of seed.capabilitySlugs) {
        const capId = capsBySlug.get(capSlug);
        if (!capId) continue;
        await db
          .insert(roleCapabilities)
          .values({ roleId, capabilityId: capId })
          .onConflictDoNothing({
            target: [roleCapabilities.roleId, roleCapabilities.capabilityId],
          });
      }
    }

    // The protected grant Role is deliberately capability-empty. A non-empty
    // system role is a malformed authority object, so fail closed rather than
    // silently widening a later Human membership grant.
    const protectedRoleCapabilities = await db
      .select({ capabilityId: roleCapabilities.capabilityId })
      .from(roleCapabilities)
      .where(eq(roleCapabilities.roleId, granteeRoleId));
    if (protectedRoleCapabilities.length > 0) {
      throw new Error("D538 protected role must have an empty capability bundle");
    }

    // 4b. M128 — server-wide canonical Groups (one per Role). Idempotent
    //     via the unique(type) constraint added in migration 0062.
    //     `owners` is seeded with the bootstrap claimer as the sole
    //     member on fresh installs; every other Group is created empty.
    //     D418 Wave 2: the canonical ladder Groups are system-managed
    //     (is_system=true, owner_id=NULL) — independent of any Human
    //     lifecycle, so deleting the bootstrap owner cannot cascade
    //     them away. The membership row below still references the
    //     bootstrap user via group_members.user_id (that FK cascades
    //     on the user's own delete, which is correct); the Group
    //     definition itself carries no Human owner.
    for (const groupSeed of GROUP_SEEDS) {
      const roleId = rolesBySlug.get(groupSeed.roleSlug);
      if (!roleId) {
        print(`[warn] role ${groupSeed.roleSlug} missing; skipping ${groupSeed.type} group seed`);
        continue;
      }
      // M131: insert the Group (no `role_id` column anymore), then map it
      // to its canonical Role via the `group_roles` junction. Each
      // canonical Group still carries exactly one Role at seed time
      // (Requirement 5) — the M:N schema simply allows more later.
      await db
        .insert(groups)
        .values({
          type: groupSeed.type,
          label: groupSeed.label,
          isSystem: true,
          ownerId: null,
          trustPreset: "personal",
        })
        .onConflictDoNothing({ target: groups.type });

      const [groupRow] = await db
        .select({ id: groups.id, isSystem: groups.isSystem })
        .from(groups)
        .where(eq(groups.type, groupSeed.type))
        .limit(1);
      if (!groupRow) {
        print(`[warn] group ${groupSeed.type} missing after upsert; skipping group_roles map`);
        continue;
      }
      if (groupSeed.type === "communities" && !groupRow.isSystem) {
        throw new Error(
          "Community group collision: communities is not system-managed",
        );
      }
      await db
        .insert(groupRoles)
        .values({ groupId: groupRow.id, roleId })
        .onConflictDoNothing({
          target: [groupRoles.groupId, groupRoles.roleId],
        });
    }

    const [existingGranteeGroup] = await db
      .select({ id: groups.id, isSystem: groups.isSystem })
      .from(groups)
      .where(eq(groups.type, UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE))
      .limit(1);
    if (existingGranteeGroup && !existingGranteeGroup.isSystem) {
      throw new Error(
        `D538 protected group collision: ${UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE} is not system-managed`,
      );
    }
    if (!existingGranteeGroup) {
      await db.insert(groups).values({
        type: UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE,
        label: "Uncontained Host Commands Grantees",
        isSystem: true,
        ownerId: null,
        trustPreset: "personal",
      });
    }
    const [granteeGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE))
      .limit(1);
    if (!granteeGroup) {
      throw new Error("D538 protected group missing after seed");
    }
    const granteeGroupRoles = await db
      .select({ roleId: groupRoles.roleId })
      .from(groupRoles)
      .where(eq(groupRoles.groupId, granteeGroup.id));
    if (granteeGroupRoles.some((edge) => edge.roleId !== granteeRoleId)) {
      throw new Error("D538 protected group has an unexpected role mapping");
    }
    if (granteeGroupRoles.length === 0) {
      await db.insert(groupRoles).values({
        groupId: granteeGroup.id,
        roleId: granteeRoleId,
      });
    }

    // Community is installed as a dormant rung. No startup reconciliation may
    // convert or otherwise enroll a Human before the complete journey ships.
    const [communityGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "communities"))
      .limit(1);
    if (communityGroup) {
      const [communityMemberCount] = await db
        .select({ total: count() })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, communityGroup.id));
      if ((communityMemberCount?.total ?? 0) > 0) {
        throw new Error(
          "Community enrollment is unavailable while the role is dormant",
        );
      }
    }

    // 4c. Seed bootstrap claimer into the `owners` Group on a fresh
    //     server. Idempotent via the (group_id, user_id) PK on
    //     group_members. ownerId is the bootstrap user passed into
    //     this seed.
    const [ownersGroupRow] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "owners"))
      .limit(1);
    if (ownersGroupRow) {
      await db
        .insert(groupMembers)
        .values({
          groupId: ownersGroupRow.id,
          userId: ownerId,
          grantedBy: actorId,
        })
        .onConflictDoNothing({
          target: [groupMembers.groupId, groupMembers.userId],
        });

      // 4d. Approver-pool invariant (permission-model.md §4): warn at
      //     boot if the `prove_it` approver pool is empty. This is a
      //     safety net — owners always seeded with the bootstrap user,
      //     so the warn should only fire if seeds were tampered with.
      const [approverCount] = await db
        .select({ total: count() })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
        .innerJoin(roles, eq(roles.id, groupRoles.roleId))
        .innerJoin(roleCapabilities, eq(roleCapabilities.roleId, roles.id))
        .innerJoin(capabilities, eq(capabilities.id, roleCapabilities.capabilityId))
        .where(eq(capabilities.slug, "approve_destructive_actions"));
      if ((approverCount?.total ?? 0) === 0) {
        print(
          "[warn] no Human holds approve_destructive_actions; prove_it approver pool is EMPTY",
        );
      }
    }


    // 5. M044 — memory.namespace_id backfill also removed from this
    //    seed. `seedDefaultRoom` now owns memory-backfill (it has
    //    the Room NS id, and the Room is the canonical scope per
    //    REL-NSP-RMS). Pre-M044 this block re-pointed NULL rows at
    //    the owner's `scope='private'` NS; post-M044 that NS row
    //    is reused in place as the Room's NS (same UUID), so
    //    `seedDefaultRoom`'s backfill is functionally equivalent
    //    for the default path.

    // 6. M042C — reconcile the owner's channel_identities on trusted
    //    boot channels with the current federated id. `users.handle`
    //    was populated by seedDefaultOwner; if the handle changed
    //    (via updateOwnerHandle or psql), this pass heals the rows.
    //    M043: rows now FK to users.id directly.
    const [ownerUser] = await db
      .select({ handle: users.handle })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    if (ownerUser?.handle) {
      const federatedId = composeFederatedId(
        ownerUser.handle,
        getServerHostname(),
      );
      for (const channel of OWNER_BOOT_CHANNELS) {
        await reconcileChannelIdentity(
          db,
          channel,
          federatedId,
          ownerId,
          print,
        );
      }
    } else {
      // seedDefaultOwner should have populated users.handle; this is a
      // defensive log in case the seed order changes in the future.
      print(
        `[warn] users.handle is NULL for ${ownerId}; skipping channel_identities reconcile`,
      );
    }

    // 7. M042C — backfill sessions.channel for any row the migration
    //    left NULL. Defaults to 'tui' since every pre-M042C session
    //    came from the TUI (no other client stamped a channel).
    const [sessionNullCount] = await db
      .select({ total: count() })
      .from(sessions)
      .where(and(eq(sessions.ownerId, ownerId), isNull(sessions.channel)));
    if ((sessionNullCount?.total ?? 0) > 0) {
      print(`Backfilling ${sessionNullCount?.total} sessions with channel='tui'...`);
      await db
        .update(sessions)
        .set({ channel: "tui" })
        .where(and(eq(sessions.ownerId, ownerId), isNull(sessions.channel)));
    }

    print("Trust seed complete.");
    return { actorId };
  } finally {
    await sql.end();
  }
}

/**
 * Reconcile the one canonical trusted boot identity for a user/channel.
 *
 * `channel_identities` only has a uniqueness constraint on
 * `(channel, external_id)`, so historical restarts can leave multiple stale
 * external ids for one user/channel. The canonical current-id row wins when
 * it belongs to this user; every other row for that same user/channel is
 * redundant and is removed. A canonical row belonging to another user is a
 * real identity collision and remains fail-closed — never rewrite or delete
 * the other user's mapping.
 *
 * The advisory transaction lock is keyed by the invariant being repaired —
 * one user's one boot-channel row — so concurrent restarts that derive
 * different current federated ids still serialize before deciding whether to
 * insert or heal. The table's `(channel, external_id)` unique key remains the
 * final cross-user collision backstop.
 */
export async function reconcileChannelIdentity(
  db: ReturnType<typeof drizzle>,
  channel: string,
  federatedId: string,
  userId: string,
  print: (msg: string) => void,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`
      select pg_advisory_xact_lock(
        hashtextextended(${`seed-trust-channel-identity:${channel}:${userId}`}::text, 0)
      )
    `);

    const [canonical] = await tx
      .select({ id: channelIdentities.id, userId: channelIdentities.userId })
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channel, channel),
          eq(channelIdentities.externalId, federatedId),
        ),
      )
      .limit(1);
    if (canonical && canonical.userId !== userId) {
      throw new Error(
        `channel_identity ownership conflict for channel=${channel}; canonical mapping belongs to another user`,
      );
    }

    if (canonical) {
      // Preserve the old seeder invariant: a trusted boot identity that was
      // restored without its verification timestamp is repaired in place.
      await tx
        .update(channelIdentities)
        .set({ verifiedAt: dsql`COALESCE(${channelIdentities.verifiedAt}, NOW())` })
        .where(eq(channelIdentities.id, canonical.id));
      const removed = await tx
        .delete(channelIdentities)
        .where(
          and(
            eq(channelIdentities.userId, userId),
            eq(channelIdentities.channel, channel),
            dsql`${channelIdentities.externalId} <> ${federatedId}`,
          ),
        )
        .returning({ id: channelIdentities.id });
      if (removed.length > 0) {
        print(
          `Removed ${removed.length} stale channel_identity row(s) (channel=${channel}, user=${userId})`,
        );
      }
      return;
    }

    const existing = await tx
      .select({ id: channelIdentities.id })
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.userId, userId),
          eq(channelIdentities.channel, channel),
        ),
      )
      .orderBy(channelIdentities.createdAt, channelIdentities.id)
      .limit(1);
    const survivor = existing[0];
    if (survivor) {
      await tx
        .update(channelIdentities)
        .set({
          externalId: federatedId,
          verifiedAt: dsql`COALESCE(${channelIdentities.verifiedAt}, NOW())`,
        })
        .where(eq(channelIdentities.id, survivor.id));
      const removed = await tx
        .delete(channelIdentities)
        .where(
          and(
            eq(channelIdentities.userId, userId),
            eq(channelIdentities.channel, channel),
            dsql`${channelIdentities.id} <> ${survivor.id}`,
          ),
        )
        .returning({ id: channelIdentities.id });
      print(
        `Healed drifted channel_identity (channel=${channel}, user=${userId}) → ${federatedId}`,
      );
      if (removed.length > 0) {
        print(
          `Removed ${removed.length} stale channel_identity row(s) (channel=${channel}, user=${userId})`,
        );
      }
      return;
    }

    await tx.insert(channelIdentities).values({
      channel,
      externalId: federatedId,
      userId,
      verifiedAt: new Date(),
    });
  });
}
