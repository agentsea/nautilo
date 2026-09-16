/**
 * Stack 195 / W3.0.2 — shared trust-layer anti-escalation resolver.
 *
 * Closes the direct-API privilege-escalation hole in Group membership
 * writes (and is designed to be reused by the W3.2 preview/apply engine
 * without yet implementing those routes).
 *
 * Contract (§2.1, "Authorization gates are cumulative" + "Reduction is
 * not an exemption"):
 *
 *   - A membership add OR remove requires the actor to hold
 *     `manage_members` AND every Capability granted by the target
 *     Group's complete current bundle (the union across every Role the
 *     Group carries).
 *   - Reduction is not an exemption: removing a member still requires
 *     authority over the Group's bundle, so a delegated Admin cannot
 *     remove an Owner even when multiple Owners remain.
 *   - Some administrative Capabilities are nondelegable: they may not
 *     appear in any custom Role bundle, even one authored by an actor who
 *     holds them. `manage_server_settings` and `manage_server_security`
 *     are Owner-only; `manage_uncontained_host_commands` is Owner/Admin.
 *     The membership resolver remains governed by each target Group's
 *     complete bundle.
 *   - Existing last-Owner protection (`removeUserFromGroup`'s
 *     `last_owner` rail) remains independent of this resolver; this
 *     resolver only decides authority, not the last-Owner lifecycle
 *     guard.
 *
 * Design for reuse: the core authority check is dependency-injected so
 * unit tests cover the policy without a database, and a production
 * resolver (`resolveMembershipMutationAuthority`) wires the real
 * `@nautilo/trust` query functions for route call sites. The
 * nondelegable-capability ceiling is exposed as a pure function so the
 * W3.2 custom-Role preview/apply path can call it without a DB and
 * without a product route existing yet.
 */

import type { CapabilitySlug } from "./capabilities";
import {
  getGroupCapabilityBundle,
  getUserCapabilities,
  userHasCapability,
} from "./queries";

/**
 * Capabilities that are deliberately nondelegable through custom Roles.
 * This is a delegation boundary, not a role-rank boundary: the first two
 * are Owner-only while `manage_uncontained_host_commands` is held by both
 * Owner and Admin. Every entry is rejected even when the actor holds it.
 */
const NONDELEGABLE_CAPABILITIES = [
  "manage_server_settings",
  "manage_server_security",
  "manage_uncontained_host_commands",
] as const;

/**
 * Legacy Owner-only subset retained for callers that need to describe the
 * canonical Owner tier. Use {@link NONDELEGABLE_CAPABILITIES} for custom
 * Role validation.
 */
export const NONDELEGABLE_OWNER_ONLY_CAPABILITIES = [
  "manage_server_settings",
  "manage_server_security",
] as const;

export type NondelegableOwnerOnlyCapability =
  (typeof NONDELEGABLE_OWNER_ONLY_CAPABILITIES)[number];

/** Stable reason codes the resolver can return; serialized into 403 bodies. */
export type AuthorityDenialReason =
  | "missing_manage_members"
  | "insufficient_authority"
  | "group_not_found";

export interface AuthorityDenial {
  readonly ok: false;
  readonly reason: AuthorityDenialReason;
  /** Capabilities the actor needed but did not hold (empty for non-bundle reasons). */
  readonly missing: readonly string[];
}

export interface AuthorityOk {
  readonly ok: true;
  /** The bundle the actor was verified to hold in full (for audit/preview reuse). */
  readonly bundle: readonly string[];
}

export type AuthorityDecision = AuthorityOk | AuthorityDenial;

/** Injected reads so the core policy is unit-testable without a database. */
export interface AuthorityDeps {
  /** Complete effective capability union for an actor across every Group/Role. */
  getUserCapabilities(userId: string): Promise<string[]>;
  /** Single-capability probe; used for the `manage_members` management gate. */
  userHasCapability(userId: string, slug: CapabilitySlug): Promise<boolean>;
  /** Complete capability bundle granted by the target Group, or `null` if absent. */
  getGroupCapabilityBundle(
    groupId: string,
  ): Promise<{ groupType: string; capabilities: string[] } | null>;
}

export interface MembershipMutationInput {
  readonly actorUserId: string;
  readonly targetGroupId: string;
  /** `add` and `remove` are governed identically (reduction is not an exemption). */
  readonly op: "add" | "remove";
}

/**
 * Core anti-escalation resolver for a membership mutation. Pure with
 * respect to the injected `deps`; performs no I/O of its own.
 *
 * Decision order:
 *   1. `group_not_found` — the target Group does not exist.
 *   2. `missing_manage_members` — the actor lacks the management Capability.
 *   3. `insufficient_authority` — the actor lacks one or more Capabilities in
 *      the Group's complete current bundle.
 *
 * Note on ordering vs. information leakage: the management gate is checked
 * AFTER group existence only because the resolver needs the bundle to make
 * its decision. Route call sites that want to hide Group existence from a
 * non-manager should layer their own 403 in front; this resolver is the
 * authority oracle, not a route-level info-leak policy.
 */
export async function authorizeMembershipMutation(
  deps: AuthorityDeps,
  input: MembershipMutationInput,
): Promise<AuthorityDecision> {
  const bundle = await deps.getGroupCapabilityBundle(input.targetGroupId);
  if (!bundle) {
    return { ok: false, reason: "group_not_found", missing: [] };
  }
  const hasManageMembers = await deps.userHasCapability(
    input.actorUserId,
    "manage_members",
  );
  if (!hasManageMembers) {
    return { ok: false, reason: "missing_manage_members", missing: [] };
  }
  const actorCaps = new Set(await deps.getUserCapabilities(input.actorUserId));
  const missing = bundle.capabilities.filter((c) => !actorCaps.has(c));
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient_authority", missing };
  }
  return { ok: true, bundle: bundle.capabilities };
}

/**
 * Pure nondelegable-ceiling check for prospective custom-Role operations
 * (W3.2 preview/apply). A proposed Role bundle is rejected if it contains
 * a nondelegable Capability — including when the actor holds it. This is
 * the "nondelegable" half of W3.0.1a; the "delegable only when the actor
 * effectively holds it" half is `checkAuthorityOverBundle`.
 *
 * Exposed now as pure unit coverage so the W3.2 engine can call it without
 * a product route existing yet; do NOT add custom-Role routes here.
 */
export function assertNoNondelegableCapabilities(
  proposedCapabilities: readonly string[],
): { ok: true } | { ok: false; code: "nondelegable_capability"; rejected: string[] } {
  const forbidden = new Set<string>(NONDELEGABLE_CAPABILITIES);
  const rejected = proposedCapabilities.filter((c) => forbidden.has(c));
  if (rejected.length > 0) {
    return { ok: false, code: "nondelegable_capability", rejected };
  }
  return { ok: true };
}

/**
 * Pure delegable-capability authority check: every Capability in the
 * proposed bundle must be one the actor effectively holds. This is the
 * "delegable only when the actor effectively holds it" half of W3.0.1a,
 * factored so the W3.2 custom-Role preview/apply engine can reuse the
 * same primitive the membership resolver uses. The membership resolver
 * itself goes through `authorizeMembershipMutation` (it also needs the
 * `manage_members` gate + the target Group's current bundle).
 */
export function checkAuthorityOverBundle(
  actorCapabilities: readonly string[],
  requiredBundle: readonly string[],
): { ok: true } | { ok: false; code: "insufficient_authority"; missing: string[] } {
  const actorSet = new Set(actorCapabilities);
  const missing = requiredBundle.filter((c) => !actorSet.has(c));
  if (missing.length > 0) {
    return { ok: false, code: "insufficient_authority", missing };
  }
  return { ok: true };
}

/**
 * Production resolver for route call sites. Wires the real
 * `@nautilo/trust` query functions into {@link authorizeMembershipMutation}.
 * Returns the same {@link AuthorityDecision} shape so route handlers can
 * map `ok:false` to a stable 403 body and `ok:true` to proceeding with the
 * mutation. The last-Owner lifecycle rail stays independent of this call.
 */
export async function resolveMembershipMutationAuthority(
  input: MembershipMutationInput,
): Promise<AuthorityDecision> {
  return authorizeMembershipMutation(
    {
      getUserCapabilities,
      userHasCapability,
      getGroupCapabilityBundle: async (groupId: string) => {
        const bundle = await getGroupCapabilityBundle(groupId);
        if (!bundle) return null;
        return { groupType: bundle.groupType, capabilities: bundle.capabilities };
      },
    },
    input,
  );
}
