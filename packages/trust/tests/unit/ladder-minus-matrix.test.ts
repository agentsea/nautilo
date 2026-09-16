/**
 * M128 — Ladder MINUS invariant test (TP9, post-D4-A).
 *
 * Pins the seeded ROLE_CAPABILITIES to the expected strict-subset ladder
 * below, including each role's explicit capability exclusions.
 *
 * Test shape (B3 fix — was vacuous in first pass): the assertion
 * compares the **seeded grid** (`M128_ROLE_CAPABILITIES`, read from
 * `seed-trust-personal.ts`) against a **hard-coded literal grid**
 * representing the reviewed default role contract. Seed drift fails the test.
 *
 * For each (Role, Capability) pair: every canonical Role × Capability cell
 * parameterized assertions, plus strict-subset invariant + spot-checks.
 */

import { describe, expect, test } from "bun:test";
import {
  M128_CAPABILITY_SLUGS,
  M128_ROLE_CAPABILITIES,
  M128_ROLE_SLUGS,
} from "@nautilo/db";

// ---------------------------------------------------------------------------
// LITERAL GRID — reviewed default role capabilities.
// Change this only for an intentional authorization-policy change; keep
// it independent of the seed implementation so accidental seed drift fails.
// ---------------------------------------------------------------------------

type CapGrid = Readonly<Record<string, boolean>>;
type LadderGrid = Readonly<Record<string, CapGrid>>;

// Role order follows the canonical capability ladder.
const LITERAL_GRID: LadderGrid = Object.freeze({
  owner: Object.freeze({
    manage_workstation_profiles: true,
    manage_members: true,
    create_invites: true,
    manage_groups: true,
    manage_roles: true,
    manage_agents: true,
    invoke_agents: true,
    create_rooms: true,
    manage_rooms: true,
    read_server_settings: true,
    manage_server_operations: true,
    manage_connection_providers: true,
    manage_server_settings: true,
    manage_server_security: true,
    manage_uncontained_host_commands: true,
    view_audit_log: true,
    moderate_content_reports: true,
    use_project_content: true,
    use_project_execution: true,
    use_workstation: true,
    use_remote_hosts: true,
    use_connections: true,
    use_media_generation: true,
    use_research_tools: true,
    use_image_generation: true,
    use_transcription: true,
    write_artifacts: true,
    read_memories: true,
    manage_memories: true,
    use_share_artifact: true,
    control_desktop: true,
    control_browser: true,
    use_google_workspace: true,
    control_home: true,
    approve_spending: true,
    manage_billing: true,
    manage_standing_approvals: true,
    approve_destructive_actions: true,
  }),
  admin: Object.freeze({
    manage_workstation_profiles: true,
    manage_members: true,
    create_invites: true,
    manage_groups: true,
    manage_roles: true,
    manage_agents: true,
    invoke_agents: true,
    create_rooms: true,
    manage_rooms: true,
    read_server_settings: true,
    manage_server_operations: true,
    manage_connection_providers: true,
    manage_server_settings: false,
    manage_server_security: false,
    manage_uncontained_host_commands: true,
    view_audit_log: true,
    moderate_content_reports: true,
    use_project_content: true,
    use_project_execution: true,
    use_workstation: true,
    use_remote_hosts: true,
    use_connections: true,
    use_media_generation: true,
    use_research_tools: true,
    use_image_generation: true,
    use_transcription: true,
    write_artifacts: true,
    read_memories: true,
    manage_memories: true,
    use_share_artifact: true,
    control_desktop: true,
    control_browser: true,
    use_google_workspace: true,
    control_home: true,
    approve_spending: true,
    manage_billing: true,
    manage_standing_approvals: true,
    approve_destructive_actions: true,
  }),
  superuser: Object.freeze({
    // D418: superuser loses manage_workstation_profiles (device-profile
    // authority is admin-tier). Activation (use_workstation)
    // survives one rung lower.
    manage_workstation_profiles: false,
    manage_members: false,
    create_invites: true,
    manage_groups: false,
    manage_roles: false,
    // D4-A: superuser loses `manage_agents` (edit-others is admin-only).
    // Self-edit of own Personal Genie still works via the two-gate body
    // check in routes/profile.ts + manage_profile / regenerate_soul tools.
    manage_agents: false,
    invoke_agents: true,
    create_rooms: true,
    manage_rooms: true,
    read_server_settings: true,
    manage_server_operations: false,
    manage_connection_providers: false,
    manage_server_settings: false,
    manage_server_security: false,
    manage_uncontained_host_commands: false,
    view_audit_log: false,
    moderate_content_reports: false,
    use_project_content: true,
    use_project_execution: true,
    use_workstation: true,
    use_remote_hosts: true,
    use_connections: true,
    use_media_generation: true,
    use_research_tools: true,
    use_image_generation: true,
    use_transcription: true,
    write_artifacts: true,
    read_memories: true,
    manage_memories: true,
    use_share_artifact: true,
    control_desktop: true,
    control_browser: true,
    use_google_workspace: true,
    control_home: true,
    approve_spending: true,
    manage_billing: false,
    manage_standing_approvals: true,
    approve_destructive_actions: true,
  }),
  member: Object.freeze({
    // D418 Wave 2 — Casey+Alex policy: Member may activate profiles.
    manage_workstation_profiles: false,
    manage_members: false,
    create_invites: true,
    manage_groups: false,
    manage_roles: false,
    manage_agents: false,
    invoke_agents: true,
    create_rooms: true,
    manage_rooms: false,
    read_server_settings: false,
    manage_server_operations: false,
    manage_connection_providers: false,
    manage_server_settings: false,
    manage_server_security: false,
    manage_uncontained_host_commands: false,
    view_audit_log: false,
    moderate_content_reports: false,
    use_project_content: true,
    use_project_execution: true,
    use_workstation: true,
    use_remote_hosts: true,
    use_connections: true,
    use_media_generation: true,
    use_research_tools: true,
    use_image_generation: true,
    use_transcription: true,
    write_artifacts: true,
    read_memories: true,
    manage_memories: true,
    use_share_artifact: true,
    control_desktop: true,
    control_browser: true,
    use_google_workspace: true,
    control_home: true,
    approve_spending: false,
    manage_billing: false,
    manage_standing_approvals: false,
    approve_destructive_actions: false,
  }),
  contributor: Object.freeze({
    manage_workstation_profiles: false,
    manage_members: false,
    create_invites: false,
    manage_groups: false,
    manage_roles: false,
    manage_agents: false,
    invoke_agents: true,
    create_rooms: true,
    manage_rooms: false,
    read_server_settings: false,
    manage_server_operations: false,
    manage_connection_providers: false,
    manage_server_settings: false,
    manage_server_security: false,
    manage_uncontained_host_commands: false,
    view_audit_log: false,
    moderate_content_reports: false,
    use_project_content: true,
    use_project_execution: false,
    use_workstation: false,
    use_remote_hosts: false,
    use_connections: false,
    use_media_generation: false,
    use_research_tools: true,
    use_image_generation: true,
    use_transcription: true,
    write_artifacts: true,
    read_memories: true,
    manage_memories: true,
    use_share_artifact: true,
    control_desktop: false,
    control_browser: false,
    use_google_workspace: false,
    control_home: false,
    approve_spending: false,
    manage_billing: false,
    manage_standing_approvals: false,
    approve_destructive_actions: false,
  }),
  guest: Object.freeze({
    manage_workstation_profiles: false,
    manage_members: false,
    create_invites: false,
    manage_groups: false,
    manage_roles: false,
    manage_agents: false,
    invoke_agents: false,
    create_rooms: false,
    manage_rooms: false,
    read_server_settings: false,
    manage_server_operations: false,
    manage_connection_providers: false,
    manage_server_settings: false,
    manage_server_security: false,
    manage_uncontained_host_commands: false,
    view_audit_log: false,
    moderate_content_reports: false,
    use_project_content: false,
    use_project_execution: false,
    use_workstation: false,
    use_remote_hosts: false,
    use_connections: false,
    use_media_generation: false,
    use_research_tools: false,
    use_image_generation: false,
    use_transcription: false,
    write_artifacts: false,
    read_memories: false,
    manage_memories: false,
    use_share_artifact: false,
    control_desktop: false,
    control_browser: false,
    use_google_workspace: false,
    control_home: false,
    approve_spending: false,
    manage_billing: false,
    manage_standing_approvals: false,
    approve_destructive_actions: false,
  }),
});

// ---------------------------------------------------------------------------
// Derived view of the seed (the SUT). Used in assertions.
// ---------------------------------------------------------------------------

const SEEDED_GRID: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(M128_ROLE_CAPABILITIES).map(([role, caps]) => [
    role,
    new Set(caps),
  ]),
);

function seedHas(role: string, cap: string): boolean {
  return SEEDED_GRID[role]?.has(cap) ?? false;
}

// ---------------------------------------------------------------------------
// Catalogue completeness — fail loudly if the literal and the catalogue
// drift in slug count / set membership. This catches new caps added to
// the seed without a corresponding LITERAL_GRID row.
// ---------------------------------------------------------------------------

describe("M128 catalogue completeness", () => {
  test("LITERAL_GRID covers every role in M128_ROLE_SLUGS", () => {
    for (const role of M128_ROLE_SLUGS) {
      expect(LITERAL_GRID[role]).toBeDefined();
    }
  });

  test("LITERAL_GRID covers every capability in M128_CAPABILITY_SLUGS", () => {
    for (const role of M128_ROLE_SLUGS) {
      const row = LITERAL_GRID[role];
      expect(row).toBeDefined();
      for (const cap of M128_CAPABILITY_SLUGS) {
        // Will be `undefined` if a slug is in the seed but missing here.
        expect(row?.[cap]).toBeDefined();
      }
    }
  });

  test("LITERAL_GRID has no slug NOT in M128_CAPABILITY_SLUGS", () => {
    const caps = new Set(M128_CAPABILITY_SLUGS);
    for (const role of M128_ROLE_SLUGS) {
      const row = LITERAL_GRID[role] ?? {};
      for (const cap of Object.keys(row)) {
        expect(caps.has(cap)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 180-cell parameterized matrix: seed vs literal.
// ---------------------------------------------------------------------------

describe("M128 ladder MINUS — Role × Capability grid (seed vs permission-model.md §6 literal)", () => {
  for (const role of M128_ROLE_SLUGS) {
    for (const cap of M128_CAPABILITY_SLUGS) {
      const expected = LITERAL_GRID[role]?.[cap] ?? false;
      test(`${role} + ${cap} → ${expected}`, () => {
        expect(seedHas(role, cap)).toBe(expected);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Strict-subset invariant (independent of LITERAL_GRID — sanity-checks
// the seed shape regardless of what the doc says).
// ---------------------------------------------------------------------------

describe("M128 ladder strict-subset invariant", () => {
  // `owner ⊃ admin ⊃ superuser ⊃ member ⊃ contributor ⊃ guest`
  const adjacentPairs: ReadonlyArray<readonly [string, string]> = [
    ["admin", "owner"],
    ["superuser", "admin"],
    ["member", "superuser"],
    ["contributor", "member"],
    ["guest", "contributor"],
  ];
  for (const [lower, higher] of adjacentPairs) {
    test(`${lower} ⊆ ${higher} (every cap in ${lower} is in ${higher})`, () => {
      const lowerCaps = SEEDED_GRID[lower] ?? new Set<string>();
      const higherCaps = SEEDED_GRID[higher] ?? new Set<string>();
      for (const cap of lowerCaps) {
        expect(higherCaps.has(cap)).toBe(true);
      }
    });
  }

  test("owner holds every capability in the M128 catalogue", () => {
    const ownerCaps = SEEDED_GRID["owner"] ?? new Set<string>();
    for (const cap of M128_CAPABILITY_SLUGS) {
      expect(ownerCaps.has(cap)).toBe(true);
    }
  });

  test("guest holds zero capabilities", () => {
    const guestCaps = SEEDED_GRID["guest"] ?? new Set<string>();
    expect(guestCaps.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// High-signal spot-checks from issue §5.1.
// Updated 2026-05-28 (D4-A): `member + manage_agents` and
// `contributor + manage_agents` now expected `false` (cap moved to
// admin+ only; profile-owner self-edit is unconditional via tool body).
// ---------------------------------------------------------------------------

describe("M128 ladder MINUS — high-signal spot-checks (issue §5.1, D4-A updated)", () => {
  const spotChecks: ReadonlyArray<readonly [string, string, boolean]> = [
    ["admin", "manage_server_settings", false],
    ["member", "create_invites", true],
    ["contributor", "create_invites", false],
    ["owner", "manage_connection_providers", true],
    ["admin", "manage_connection_providers", true],
    ["superuser", "manage_connection_providers", false],
    ["owner", "manage_server_operations", true],
    ["admin", "manage_server_operations", true],
    ["superuser", "manage_server_operations", false],
    ["member", "manage_server_operations", false],
    ["contributor", "manage_server_operations", false],
    ["guest", "manage_server_operations", false],
    ["admin", "manage_server_security", false],
    ["superuser", "view_audit_log", false],
    ["superuser", "manage_billing", false],
    ["superuser", "manage_agents", false], // D4-A
    ["member", "approve_destructive_actions", false],
    ["member", "manage_agents", false], // D4-A (was true)
    ["member", "use_workstation", true],
    ["member", "control_desktop", true],
    ["member", "use_project_execution", true],
    ["contributor", "use_project_content", true],
    ["contributor", "use_project_execution", false],
    ["contributor", "use_workstation", false],
    ["contributor", "control_desktop", false],
    ["contributor", "control_home", false],
        ["contributor", "manage_agents", false], // D4-A (was true)
    ["guest", "approve_destructive_actions", false],
    ["guest", "manage_agents", false],
    ["guest", "read_memories", false],
    ["owner", "manage_server_settings", true],
    ["owner", "manage_server_security", true],
    ["owner", "manage_agents", true],
    ["owner", "approve_destructive_actions", true],
    ["admin", "manage_agents", true],
    ["admin", "approve_destructive_actions", true],
    ["superuser", "approve_destructive_actions", true],
    ["contributor", "use_research_tools", true],
    ["contributor", "use_image_generation", true],
    ["contributor", "read_memories", true],
    ["contributor", "invoke_agents", true],
    ["contributor", "write_artifacts", true],
    ["guest", "invoke_agents", false],
    ["guest", "write_artifacts", false],
    // D418 — Workstation Profile RBAC (permission-model.md §6).
    ["owner", "use_workstation", true],
    ["owner", "manage_workstation_profiles", true],
    ["admin", "use_workstation", true],
    ["admin", "manage_workstation_profiles", true],
    ["superuser", "use_workstation", true],
    ["superuser", "manage_workstation_profiles", false],
    ["member", "use_workstation", true],
    ["member", "manage_workstation_profiles", false],
    ["contributor", "use_workstation", false],
    ["contributor", "manage_workstation_profiles", false],
    ["guest", "use_workstation", false],
    ["guest", "manage_workstation_profiles", false],
  ];
  for (const [role, cap, expected] of spotChecks) {
    test(`${role} + ${cap} → ${expected} (spot)`, () => {
      expect(seedHas(role, cap)).toBe(expected);
    });
  }
});
