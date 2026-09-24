/**
 * Stack 195 / W3.2 — shared RBAC mutation command engine.
 *
 * One discriminated operation request and one command engine serve both
 * `POST /api/admin/access-control/changes/preview` and `/apply`. Preview
 * is read-only: it returns structured checks/failures, current/proposed/
 * effective authority deltas, a redacted audit preview, deletion
 * consequences when relevant, and an opaque state fingerprint. Apply
 * receives the exact normalized operation plus the fingerprint,
 * re-resolves authorization inside a single direct-Postgres transaction
 * (with locks over the full fingerprinted RBAC catalogue), and returns `409 stale_preview`
 * when the fingerprint drifted.
 *
 * Contract (wave-3-stack-195-tasks.md W3.2.1–W3.2.5 + W3.0.1, and
 * general-rbac-administration-followup.md §2.1 + ASCII review flow):
 *
 *   - Action gate: `manage_roles` (role.*), `manage_groups` (group.*), or
 *     `manage_members` (membership.*) — the management Capability alone is
 *     insufficient.
 *   - The actor must hold the COMPLETE current AND proposed bundles;
 *     reduction/deletion is not exempt (a delegated Admin cannot remove an
 *     Owner or delete a stronger RBAC object).
 *   - System Role/Group definitions cannot be updated or deleted.
 *   - Canonical role assignment to custom Groups is rejected; custom Groups
 *     carry only custom Roles.
 *   - Nondelegable management caps may not appear in any custom Role
 *     bundle, even for an actor who holds them. This includes Owner-only
 *     server settings/security and the Owner/Admin uncontained-host policy.
 *   - Custom Role slugs cannot impersonate the six canonical ladder slugs;
 *     custom Group types use `custom:<slug>` and cannot impersonate the six
 *     canonical Group types.
 *   - New custom Roles are `is_system:false`; custom Groups require a
 *     non-null owner and `is_system:false`.
 *   - Apply writes one redacted RBAC `SecurityAuditEvent` after the DB
 *     commit; an append failure is surfaced as
 *     `applied=true, auditRecorded=false` and never rolls back or invites
 *     a blind retry.
 *
 * The pure decision core (`evaluateOperation`) is dependency-free so the
 * unit suite covers the policy matrix without a database; the production
 * wiring (`previewOperation` / `applyOperation`) reads real state through
 * injected {@link MutationEngineDeps}. The legacy
 * `PUT/DELETE /api/groups/:id/members/:userId` route is routed through the
 * same engine so direct API and legacy UI are equally protected.
 */

import { createHash } from "node:crypto";
import { lockFingerprintState } from "./rbac-mutation-locks";
import { holdsModerationPermission, MODERATION_PERMISSIONS, moderationCapability, type ModerationAuthority } from "./moderation-policy";
import type { Database } from "@nautilo/db";
import {
  and,
  approvalChallenges,
  capabilities,
  eq,
  getSharedDirectDb,
  groupMembers,
  groupModerationScopes,
  groupRoles,
  groups,
  inArray,
  roles,
  rooms,
  isNull,
  ne,
  roleCapabilities,
  sql,
  users,
} from "@nautilo/db";
import {
  assertNoNondelegableCapabilities,
  checkAuthorityOverBundle,
} from "./rbac-anti-escalation";
import { getUserCapabilities, userHasCapability, MembershipOpError } from "./queries";
import type { CapabilitySlug } from "./capabilities";

// ---------------------------------------------------------------------------
// Canonical ladder facts (mirror permission-model.md §4). Kept inline so
// the engine's policy is self-contained and unit-testable without the DB
// seed.
// ---------------------------------------------------------------------------

export const CANONICAL_ROLE_SLUGS = [
  "owner",
  "admin",
  "superuser",
  "member",
  "contributor",
  "community",
  "guest",
] as const;

export const CANONICAL_GROUP_TYPES = [
  "owners",
  "admins",
  "superusers",
  "members",
  "contributors",
  "communities",
  "guests",
] as const;

/**
 * D538's fixed positive-grant projection. This protected system Role/Group
 * deliberately sits outside the canonical ladder: membership is a future
 * execution grant, not a role-rank change.
 */
export const UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG =
  "uncontained_host_commands_grantee";
export const UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE =
  "uncontained_host_commands_grantees";

const CANONICAL_ROLE_SLUG_SET = new Set<string>(CANONICAL_ROLE_SLUGS);
const CANONICAL_GROUP_TYPE_SET = new Set<string>(CANONICAL_GROUP_TYPES);

export const CUSTOM_GROUP_TYPE_PREFIX = "custom:";

function isCanonicalRoleSlug(slug: string): boolean {
  return CANONICAL_ROLE_SLUG_SET.has(slug);
}

function isReservedSystemRoleSlug(slug: string): boolean {
  return isCanonicalRoleSlug(slug) || slug === UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG;
}

function isCanonicalGroupType(type: string): boolean {
  return CANONICAL_GROUP_TYPE_SET.has(type);
}

// ---------------------------------------------------------------------------
// Discriminated operation request (the normalized command both endpoints
// share).
// ---------------------------------------------------------------------------

export type AccessControlOperation =
  | {
      readonly kind: "role.create";
      readonly slug: string;
      readonly label: string;
      readonly capabilities: readonly string[];
    }
  | { readonly kind: "role.rename"; readonly roleId: string; readonly label: string }
  | {
      readonly kind: "role.set_capabilities";
      readonly roleId: string;
      readonly capabilities: readonly string[];
    }
  | { readonly kind: "role.delete"; readonly roleId: string }
  | {
      readonly kind: "group.create";
      readonly groupType: string;
      readonly label: string;
      readonly ownerUserId: string;
      readonly roleSlugs: readonly string[];
    }
  | { readonly kind: "group.set_moderation_scopes"; readonly groupId: string; readonly roomIds: readonly string[] }
  | { readonly kind: "group.rename"; readonly groupId: string; readonly label: string }
  | {
      readonly kind: "group.set_roles";
      readonly groupId: string;
      readonly roleSlugs: readonly string[];
    }
  | {
      readonly kind: "group.transfer_owner";
      readonly groupId: string;
      readonly newOwnerUserId: string;
    }
  | { readonly kind: "group.delete"; readonly groupId: string }
  | { readonly kind: "membership.add"; readonly groupId: string; readonly userId: string }
  | {
      readonly kind: "membership.remove";
      readonly groupId: string;
      readonly userId: string;
      readonly bypassLastOwner?: boolean;
    }
  | {
      /**
       * Stack 195 / W3.2.14 — atomic Create shared access composite. Creates
       * a new custom Permission set (Role), a new custom Group, the Group→Role
       * edge, and the initial memberships in ONE SERIALIZABLE transaction so
       * no partial Role/Group/membership survives a validation or write
       * failure. Requires ALL THREE management capabilities.
       */
      readonly kind: "shared_access.create";
      readonly role: {
        readonly slug: string;
        readonly label: string;
        readonly capabilities: readonly string[];
      };
      readonly group: {
        readonly groupType: string;
        readonly label: string;
        readonly ownerUserId: string;
      };
      /** Non-empty; de-duplicated by the engine before write. */
      readonly memberUserIds: readonly string[];
    }
  | {
      /**
       * Stack 195 / W3.2.14 — atomic Assign existing Permission set composite.
       * Attaches an EXISTING custom Permission set (Role) to a new custom Group
       * plus the initial memberships in ONE SERIALIZABLE transaction so no
       * partial Group/edge/membership survives a validation or write failure.
       * Requires `manage_groups` AND `manage_members` (NOT `manage_roles` — the
       * Role definition is never mutated) plus actor authority over the
       * existing Role's complete bundle.
       */
      readonly kind: "shared_access.assign_existing";
      /** Existing CUSTOM Permission set slug (canonical/system roles rejected). */
      readonly roleSlug: string;
      readonly group: {
        readonly groupType: string;
        readonly label: string;
        readonly ownerUserId: string;
      };
      /** Non-empty; de-duplicated by the engine before write. */
      readonly memberUserIds: readonly string[];
    };

export type AccessControlOperationKind = AccessControlOperation["kind"];

/**
 * The management Capability an operation requires as its action gate.
 * Kept for backward compatibility; returns the PRIMARY (first) required
 * cap. Composite operations requiring multiple caps should use
 * {@link managementCapabilitiesFor}.
 */
export function managementCapabilityFor(op: AccessControlOperation): CapabilitySlug {
  return managementCapabilitiesFor(op)[0]!;
}

/**
 * The full set of management Capabilities an operation requires as its
 * action gate. Single-cap operations return a one-element array (so
 * existing behavior is unchanged); the `shared_access.create` composite
 * returns all three (`manage_roles`, `manage_groups`, `manage_members`)
 * because it mutates Role, Group, and membership in one transaction.
 * Apply re-checks that the actor holds EVERY returned cap.
 */
export function managementCapabilitiesFor(
  op: AccessControlOperation,
  state?: EngineState,
): readonly CapabilitySlug[] {
  switch (op.kind) {
    case "role.create":
    case "role.rename":
    case "role.set_capabilities":
    case "role.delete":
      return ["manage_roles"];
    case "group.create":
    case "group.rename":
    case "group.set_moderation_scopes":
    case "group.set_roles":
    case "group.transfer_owner":
    case "group.delete":
      return ["manage_groups"];
    case "membership.add":
    case "membership.remove":
      if (
        state &&
        groupById(state, op.groupId)?.type === UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE
      ) {
        return ["manage_members", "manage_uncontained_host_commands"];
      }
      return ["manage_members"];
    case "shared_access.create":
      return ["manage_roles", "manage_groups", "manage_members"];
    case "shared_access.assign_existing":
      // Never mutates the Role definition, so manage_roles is NOT required;
      // only the Group + membership gates apply.
      return ["manage_groups", "manage_members"];
  }
}

// ---------------------------------------------------------------------------
// Resolved engine state (what preview reads; apply re-reads under locks).
// ---------------------------------------------------------------------------

export interface EngineRoleRow {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly isSystem: boolean;
  readonly capabilities: readonly string[];
}

export interface EngineGroupRow {
  readonly moderationRoomIds?: readonly string[];
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly isSystem: boolean;
  readonly ownerId: string | null;
  readonly roleSlugs: readonly string[];
  /** Complete capability bundle granted by this Group (union of its Roles). */
  readonly capabilities: readonly string[];
  /**
   * Exact membership edges: the userIds of every Human currently in this
   * Group. The fingerprint projects THIS set (sorted), not just a count, so
   * a membership swap with the same count changes the fingerprint. Kept
   * sorted + de-duplicated by the loader.
   */
  readonly members: readonly string[];
  /** Derivable count of {@link members}; kept for catalogue/consequence display. */
  readonly memberCount: number;
  readonly approvalChallengeCount: number;
}

export interface EngineState {
  readonly roles: readonly EngineRoleRow[];
  readonly groups: readonly EngineGroupRow[];
  readonly knownCapabilities: readonly string[];
}

// ---------------------------------------------------------------------------
// Check / decision shapes.
// ---------------------------------------------------------------------------

export type CheckCode =
  | "ok"
  | "missing_manage_roles"
  | "missing_manage_groups"
  | "missing_manage_members"
  | "missing_manage_uncontained_host_commands"
  | "insufficient_authority"
  | "nondelegable_capability"
  | "protected_definition"
  | "reserved_slug"
  | "reserved_type"
  | "invalid_custom_type"
  | "unknown_capability"
  | "not_found"
  | "not_member"
  | "owner_required"
  | "user_not_found"
  | "last_owner"
  | "community_enrollment_unavailable"
  | "insufficient_moderation_scope"
  | "moderation_room_unavailable";

export interface Check {
  readonly code: CheckCode;
  readonly passed: boolean;
  readonly detail?: string | undefined;
  readonly missing?: readonly string[] | undefined;
}

export interface AuthorityDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
}

export interface AffectedUserDelta {
  readonly userId: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /**
   * Capabilities the Human keeps through the mutation (present in BOTH the
   * before and after effective union). For a membership remove where another
   * Group preserves a cap, that cap is UNCHANGED here, not removed. This is
   * the true source-aware effective delta, never the raw selected-Group
   * bundle.
   */
  readonly unchanged: readonly string[];
}

export interface DeletionConsequence {
  readonly targetKind: "role" | "group";
  readonly targetId: string;
  readonly targetLabel: string;
  /** Groups that carried the deleted Role. */
  readonly affectedGroups?: readonly {
    readonly groupId: string;
    readonly groupType: string;
    readonly memberCount: number;
  }[];
  /** group_roles edges removed when the Role is deleted. */
  readonly groupRolesRemoved?: number;
  /** role_capabilities edges removed when the Role is deleted. */
  readonly roleCapabilitiesRemoved?: number;
  /** group_members rows removed when the Group is deleted. */
  readonly membersRemoved?: number;
  /** approval_challenges rows removed before the Group row is deleted. */
  readonly approvalChallengesRemoved?: number;
  /** group_roles edges removed when the Group is deleted. */
  readonly roleAssignmentsRemoved?: number;
}

/**
 * Redacted audit payload the engine builds for an apply. This is
 * `Omit<SecurityAuditEvent, "ts" | "ip" | "userAgent">` for the RBAC event
 * variants — only identifiers + capability slugs, never a PIN, token,
 * secret, or path. The route adds the envelope (ts/ip/userAgent) at write
 * time.
 */
export type RbacAuditEventInput =
  | { readonly kind: "rbac_group_moderation_scopes_set"; readonly actorId: string | null; readonly groupId: string; readonly roomIds: readonly string[] }
  | {
      readonly kind: "rbac_role_created";
      readonly actorId: string | null;
      readonly roleId: string;
      readonly roleSlug: string;
      readonly capabilities: readonly string[];
    }
  | {
      readonly kind: "rbac_role_renamed";
      readonly actorId: string | null;
      readonly roleId: string;
      readonly roleSlug: string;
      readonly label: string;
    }
  | {
      readonly kind: "rbac_role_capabilities_set";
      readonly actorId: string | null;
      readonly roleId: string;
      readonly roleSlug: string;
      readonly capabilities: readonly string[];
    }
  | {
      readonly kind: "rbac_role_deleted";
      readonly actorId: string | null;
      readonly roleId: string;
      readonly roleSlug: string;
    }
  | {
      readonly kind: "rbac_group_created";
      readonly actorId: string | null;
      readonly groupId: string;
      readonly groupType: string;
      readonly ownerUserId: string;
      readonly roleSlugs: readonly string[];
    }
  | {
      readonly kind: "rbac_group_renamed";
      readonly actorId: string | null;
      readonly groupId: string;
      readonly groupType: string;
      readonly label: string;
    }
  | {
      readonly kind: "rbac_group_roles_set";
      readonly actorId: string | null;
      readonly groupId: string;
      readonly groupType: string;
      readonly roleSlugs: readonly string[];
    }
  | {
      readonly kind: "rbac_group_owner_transferred";
      readonly actorId: string | null;
      readonly groupId: string;
      readonly groupType: string;
      readonly fromOwnerUserId: string | null;
      readonly toOwnerUserId: string;
    }
  | {
      readonly kind: "rbac_group_deleted";
      readonly actorId: string | null;
      readonly groupId: string;
      readonly groupType: string;
    }
  | {
      readonly kind: "group_member_added";
      readonly actorId: string | null;
      readonly groupId: string;
      readonly groupType: string;
      readonly targetUserId: string;
    }
  | {
      readonly kind: "group_member_removed";
      readonly actorId: string | null;
      readonly groupId: string;
      readonly groupType: string;
      readonly targetUserId: string;
      readonly bypassedRail?: boolean;
    }
  | {
      /**
       * Stack 195 / W3.2.14 — atomic Create shared access composite. One
       * redacted row describes the whole Permission-set + Group + edge +
       * initial-membership creation. Carries ONLY ids/slugs/counts — never
       * a PIN, token, secret, path, or any member's PII.
       */
      readonly kind: "rbac_shared_access_created";
      readonly actorId: string | null;
      readonly roleId: string;
      readonly roleSlug: string;
      readonly capabilities: readonly string[];
      readonly groupId: string;
      readonly groupType: string;
      readonly ownerUserId: string;
      readonly memberCount: number;
    }
  | {
      /**
       * Stack 195 / W3.2.14 — atomic Assign existing Permission set composite.
       * One redacted row describes the Group + Group→existing-Role edge +
       * initial-membership creation. Carries ONLY ids/slugs/counts — never a
       * PIN, token, secret, path, or any member's PII. `capabilities` is the
       * existing Role's current bundle (forensic context only; the Role
       * definition is not mutated). `memberCount` is the de-duplicated
       * initial-member count.
       */
      readonly kind: "rbac_shared_access_assigned";
      readonly actorId: string | null;
      readonly roleId: string;
      readonly roleSlug: string;
      readonly capabilities: readonly string[];
      readonly groupId: string;
      readonly groupType: string;
      readonly ownerUserId: string;
      readonly memberCount: number;
    };

export interface PreviewResponse {
  readonly ok: boolean;
  readonly operation: AccessControlOperation;
  readonly checks: readonly Check[];
  readonly failures: readonly Check[];
  readonly currentAuthority?: readonly string[] | undefined;
  readonly proposedAuthority?: readonly string[] | undefined;
  readonly authorityDelta?: AuthorityDelta | undefined;
  /** Single-target (membership) true effective delta; preserved for compatibility. */
  readonly affectedUserDelta?: AffectedUserDelta | undefined;
  /**
   * Canonical plural impact shape for shared edits (Permission-set
   * set_capabilities/delete, Group set_roles/delete, and the
   * `shared_access.create` composite). One entry per affected Human with
   * true effective added/removed/unchanged deltas, de-duplicated by userId.
   */
  readonly affectedUserDeltas?: readonly AffectedUserDelta[] | undefined;
  readonly deletionConsequence?: DeletionConsequence | undefined;
  readonly auditPreview: RbacAuditEventInput;
  readonly fingerprint: string;
}

export type ApplyResult =
  | { readonly applied: true; readonly auditRecorded: boolean; readonly fingerprint: string }
  | {
      readonly applied: false;
      readonly code: "authorization_denied" | "not_found" | "stale_preview";
      readonly failures: readonly Check[];
      readonly reason?: string | undefined;
    };

// ---------------------------------------------------------------------------
// Dependency-injected I/O. The pure core takes {@link EngineState} +
// actor facts; the production wiring supplies real DB reads/writes.
// ---------------------------------------------------------------------------

/** A Drizzle transaction client. */
export type MutationTx = Parameters<
  NonNullable<Parameters<Database["transaction"]>[0]>
>[0];

/**
 * Outcome of executing an operation's writes: the created row ids for
 * `role.create` / `group.create` (absent for every other kind), used to
 * patch the redacted audit payload with the real id instead of the
 * preview placeholder.
 */
export interface WriteOutcome {
  readonly roleId?: string | undefined;
  readonly groupId?: string | undefined;
}

/**
 * Actor facts required by apply. These MUST be read from the transaction
 * supplied to `loadApplyFacts`, never through the ordinary shared-pool
 * preview hooks.
 */
export interface ApplyFacts {
  readonly actorCapabilities: readonly string[];
  /** Management caps the actor holds (subset of the operation's required set). */
  readonly actorHeldManagementCaps: readonly CapabilitySlug[];
  /** True iff the actor holds EVERY required management cap. */
  readonly actorHoldsManagement: boolean;
  /** All target users (owner + members for composite; single target otherwise) exist. */
  readonly targetUserExists: boolean;
  readonly moderationRoomsExist?: boolean;
}

export interface MutationEngineDeps {
  /** Effective capability union for an actor across every Group/Role. */
  getActorCapabilities(userId: string): Promise<string[]>;
  /** Single-capability probe (used for the management gate). */
  userHasCapability(userId: string, slug: CapabilitySlug): Promise<boolean>;
  /** Whether a user row exists (for owner / membership targets). */
  userExists(userId: string): Promise<boolean>;
  moderationRoomsExist?(roomIds: readonly string[]): Promise<boolean>;
  /** Read the full RBAC state snapshot outside a transaction (preview). */
  loadState(): Promise<EngineState>;
  /**
   * Re-resolve all authorization facts from the SAME transaction snapshot as
   * the locked state and writes. `requiredManagementCapability` is supplied
   * rather than inferred by the dependency so the command engine remains the
   * single source of operation-to-action-gate mapping.
   */
  loadApplyFacts(
    tx: MutationTx,
    input: {
      readonly actorUserId: string;
      readonly requiredManagementCapabilities: readonly CapabilitySlug[];
      readonly targetUserIds: readonly string[] | null;
      readonly moderationRoomIds?: readonly string[];
    },
  ): Promise<ApplyFacts>;
  /**
   * Run an apply in one direct-Postgres transaction. The callback receives
   * a locked {@link EngineState} (re-read inside the tx after locking every
   * table/edge included by the full-state fingerprint) and the transaction
   * client. The callback MUST
   * perform the writes through `tx` (via {@link MutationEngineDeps.execute})
   * before resolving. Implementations COMMIT on resolve and ROLLBACK on
   * throw, so the callback's resolved value is only durable after
   * `applyInTx` itself resolves.
   */
  applyInTx<T>(fn: (tx: MutationTx, state: EngineState) => Promise<T>): Promise<T>;
  /**
   * Execute the normalized operation's writes inside the supplied
   * transaction client. The state is the locked snapshot the callback
   * received, so slug→id resolution is consistent with the fingerprint.
   * Implementations MUST NOT commit (the tx is owned by {@link applyInTx}).
   * Returns the created row ids (for `role.create` / `group.create`) so the
   * engine can patch the audit payload with the real id instead of the
   * preview placeholder.
   */
  execute(tx: MutationTx, op: AccessControlOperation, state: EngineState): Promise<WriteOutcome>;
  /**
   * Append the redacted RBAC audit event after the DB commit. MUST throw on
   * failure so the engine can surface `auditRecorded:false`. The
   * implementation adds the envelope (ts/ip/userAgent) at write time.
   */
  appendAuditEvent(payload: RbacAuditEventInput): void;
}

// ---------------------------------------------------------------------------
// Opaque state fingerprint. A sha256 over a canonical projection of the
// full RBAC state snapshot. Opaque to clients; apply recomputes it inside
// the transaction under locks and rejects on mismatch (`409 stale_preview`).
// A full-snapshot fingerprint is the safe choice for a low-frequency admin
// surface: any concurrent RBAC drift invalidates the preview.
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).sort().join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

export function computeFingerprint(state: EngineState): string {
  const projection = {
    roles: state.roles
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        label: r.label,
        isSystem: r.isSystem,
        capabilities: [...r.capabilities].sort(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    groups: state.groups
      .map((g) => ({
        id: g.id,
        type: g.type,
        label: g.label,
        isSystem: g.isSystem,
        ownerId: g.ownerId,
        roleSlugs: [...g.roleSlugs].sort(),
        // Exact membership edges — a swap with the same count changes the
        // fingerprint. Sorted userIds make the projection order-independent.
        // memberCount is deliberately NOT projected: it is derivable from
        // `members.length` and is kept on the row only for catalogue/
        // deletion-consequence display, so a count-only drift (with no
        // edge change) does NOT invalidate a preview.
        members: [...g.members].sort(),
        moderationRoomIds: [...(g.moderationRoomIds ?? [])].sort(),
        approvalChallengeCount: g.approvalChallengeCount,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    capabilities: [...state.knownCapabilities].sort(),
  };
  const hash = createHash("sha256").update(stableStringify(projection)).digest("hex");
  return `v1:${hash}`;
}

// ---------------------------------------------------------------------------
// Pure decision core.
// ---------------------------------------------------------------------------

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function bundleDelta(
  current: readonly string[],
  proposed: readonly string[],
): AuthorityDelta {
  const cur = new Set(current);
  const prop = new Set(proposed);
  return {
    added: dedupe(proposed.filter((c) => !cur.has(c))),
    removed: dedupe(current.filter((c) => !prop.has(c))),
    unchanged: dedupe(current.filter((c) => prop.has(c))),
  };
}

// ---------------------------------------------------------------------------
// True source-aware effective deltas (W3.2.13). A Human's effective
// capability union is the union of every Group bundle they belong to. A
// mutation's effective delta is the before/after difference of THAT union,
// not the raw selected-Group bundle — so a cap preserved by another source
// is UNCHANGED, not removed. All pure; apply re-evaluates from the locked tx
// state so preview and apply share one decision path.
// ---------------------------------------------------------------------------

/**
 * Effective capability union for a Human across every Group they are a
 * member of (union of each Group's bundle). Pure; reads only the supplied
 * {@link EngineState}. Returns a stable, de-duplicated, sorted list.
 */
export function effectiveCapabilitiesForUser(
  state: EngineState,
  userId: string,
): string[] {
  const caps = new Set<string>();
  for (const g of state.groups) {
    if (g.members.includes(userId)) {
      for (const c of g.capabilities) caps.add(c);
    }
  }
  return [...caps].sort();
}

/** Set-equality helper for sorted string lists. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Compute the true effective delta for a single Human between two states.
 * Pure: callers supply the original and projected {@link EngineState}.
 * Returns `null` when the Human's effective union is identical (no change).
 */
export function effectiveUserDelta(
  before: EngineState,
  after: EngineState,
  userId: string,
): AffectedUserDelta | null {
  const b = effectiveCapabilitiesForUser(before, userId);
  const a = effectiveCapabilitiesForUser(after, userId);
  if (sameSet(a, b)) return null;
  return {
    userId,
    added: a.filter((c) => !b.includes(c)),
    removed: b.filter((c) => !a.includes(c)),
    unchanged: b.filter((c) => a.includes(c)),
  };
}

/**
 * Compute true effective deltas for a set of Humans between two states,
 * de-duplicated by userId, sorted by userId. Only Humans whose effective
 * union actually changes are included (a cap preserved by another source
 * produces no entry, and a no-op membership produces no entry). Pure.
 */
export function computeAffectedUserDeltas(
  before: EngineState,
  after: EngineState,
  userIds: readonly string[],
): AffectedUserDelta[] {
  const seen = new Set<string>();
  const out: AffectedUserDelta[] = [];
  for (const userId of userIds) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    const delta = effectiveUserDelta(before, after, userId);
    if (delta) out.push(delta);
  }
  return out.sort((x, y) => (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Pure state projections. Each returns the {@link EngineState} that WOULD
// exist after the mutation, without I/O. Used by the shared-edit evaluators
// to compute true affected-Human deltas (before = current state, after =
// projected state). Membership edges are carried exactly so a swap changes
// the fingerprint.
// ---------------------------------------------------------------------------

function withRole(state: EngineState, roleId: string, patch: Partial<EngineRoleRow>): EngineState {
  return {
    ...state,
    roles: state.roles.map((r) => (r.id === roleId ? { ...r, ...patch } : r)),
  };
}

function withoutRole(state: EngineState, roleId: string): EngineState {
  const role = roleById(state, roleId);
  if (!role) return state;
  return {
    ...state,
    roles: state.roles.filter((r) => r.id !== roleId),
    groups: state.groups.map((g) =>
      g.roleSlugs.includes(role.slug)
        ? {
            ...g,
            roleSlugs: g.roleSlugs.filter((s) => s !== role.slug),
            capabilities: bundleOfRoleSlugs(
              { ...state, roles: state.roles.filter((r) => r.id !== roleId) },
              g.roleSlugs.filter((s) => s !== role.slug),
            ),
          }
        : g,
    ),
  };
}

function withGroup(state: EngineState, groupId: string, patch: Partial<EngineGroupRow>): EngineState {
  return {
    ...state,
    groups: state.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)),
  };
}

function withoutGroup(state: EngineState, groupId: string): EngineState {
  return {
    ...state,
    groups: state.groups.filter((g) => g.id !== groupId),
  };
}

/** Projected state after `role.set_capabilities`. */
function projectRoleSetCapabilities(
  state: EngineState,
  roleId: string,
  capabilities: readonly string[],
): EngineState {
  const role = roleById(state, roleId);
  if (!role) return state;
  const nextCaps = dedupe(capabilities);
  const next = withRole(state, roleId, { capabilities: nextCaps });
  // Recompute every Group bundle that carried this role.
  return {
    ...next,
    groups: next.groups.map((g) =>
      g.roleSlugs.includes(role.slug)
        ? { ...g, capabilities: bundleOfRoleSlugs(next, g.roleSlugs) }
        : g,
    ),
  };
}

/** Projected state after `group.set_roles`. */
function projectGroupSetRoles(
  state: EngineState,
  groupId: string,
  roleSlugs: readonly string[],
): EngineState {
  const group = groupById(state, groupId);
  if (!group) return state;
  const nextSlugs = dedupe(roleSlugs);
  return withGroup(state, groupId, {
    roleSlugs: nextSlugs,
    capabilities: bundleOfRoleSlugs(state, nextSlugs),
  });
}

/** Projected state after `membership.add` (idempotent if already a member). */
function projectMembershipAdd(
  state: EngineState,
  groupId: string,
  userId: string,
): EngineState {
  const group = groupById(state, groupId);
  if (!group || group.members.includes(userId)) return state;
  return withGroup(state, groupId, {
    members: dedupe([...group.members, userId]).sort(),
    memberCount: group.memberCount + 1,
  });
}

/** Projected state after `membership.remove`. */
function projectMembershipRemove(
  state: EngineState,
  groupId: string,
  userId: string,
): EngineState {
  const group = groupById(state, groupId);
  if (!group || !group.members.includes(userId)) return state;
  const members = group.members.filter((u) => u !== userId);
  return withGroup(state, groupId, {
    members: [...members].sort(),
    memberCount: members.length,
  });
}

/** Projected state after `shared_access.create` (Role + Group + edge + members). */
function projectSharedAccessCreate(
  state: EngineState,
  op: Extract<AccessControlOperation, { kind: "shared_access.create" }>,
  newRoleId: string,
  newGroupId: string,
): EngineState {
  const roleSlug = op.role.slug;
  const roleCaps = dedupe(op.role.capabilities);
  const memberUserIds = dedupe(op.memberUserIds).sort();
  const nextRoles: EngineRoleRow = {
    id: newRoleId,
    slug: roleSlug,
    label: op.role.label,
    isSystem: false,
    capabilities: roleCaps,
  };
  const withRoleAdded: EngineState = { ...state, roles: [...state.roles, nextRoles] };
  const newGroup: EngineGroupRow = {
    id: newGroupId,
    type: op.group.groupType,
    label: op.group.label,
    isSystem: false,
    ownerId: op.group.ownerUserId,
    roleSlugs: [roleSlug],
    capabilities: roleCaps,
    members: memberUserIds,
    memberCount: memberUserIds.length,
    approvalChallengeCount: 0,
  };
  return { ...withRoleAdded, groups: [...withRoleAdded.groups, newGroup] };
}

/**
 * Projected state after `shared_access.assign_existing` (new Group + edge to
 * an EXISTING Role + initial members). The Role row is unchanged; only the
 * Group catalogue grows. Pure.
 */
function projectSharedAccessAssignExisting(
  state: EngineState,
  op: Extract<AccessControlOperation, { kind: "shared_access.assign_existing" }>,
  newGroupId: string,
): EngineState {
  const role = roleBySlug(state, op.roleSlug);
  const roleCaps = role ? dedupe(role.capabilities) : [];
  const memberUserIds = dedupe(op.memberUserIds).sort();
  const newGroup: EngineGroupRow = {
    id: newGroupId,
    type: op.group.groupType,
    label: op.group.label,
    isSystem: false,
    ownerId: op.group.ownerUserId,
    roleSlugs: [op.roleSlug],
    capabilities: roleCaps,
    members: memberUserIds,
    memberCount: memberUserIds.length,
    approvalChallengeCount: 0,
  };
  return { ...state, groups: [...state.groups, newGroup] };
}



export interface EvaluationInput {
  readonly actorUserId?: string;
  readonly operation: AccessControlOperation;
  readonly state: EngineState;
  readonly actorCapabilities: readonly string[];
  /**
   * True iff the actor holds EVERY management Capability required by the
   * operation ({@link managementCapabilitiesFor}). Single-cap ops require
   * one; the composite requires all three. Kept as a boolean for the
   * single-cap evaluators' pass/fail; the composite evaluator also uses
   * {@link actorHeldManagementCaps} to report WHICH cap is missing.
   */
  readonly actorHoldsManagement: boolean;
  /** Management caps the actor actually holds (subset of the required set). */
  readonly actorHeldManagementCaps: readonly CapabilitySlug[];
  readonly targetUserExists: boolean;
  readonly moderationRoomsExist?: boolean;
}

export interface EvaluationResult {
  readonly ok: boolean;
  readonly checks: readonly Check[];
  readonly failures: readonly Check[];
  readonly currentAuthority?: readonly string[] | undefined;
  readonly proposedAuthority?: readonly string[] | undefined;
  readonly authorityDelta?: AuthorityDelta | undefined;
  readonly affectedUserDelta?: AffectedUserDelta | undefined;
  readonly affectedUserDeltas?: readonly AffectedUserDelta[] | undefined;
  readonly deletionConsequence?: DeletionConsequence | undefined;
  readonly auditPreview: RbacAuditEventInput;
}

function pass(code: CheckCode, detail?: string): Check {
  return { code, passed: true, detail };
}
function fail(code: CheckCode, detail?: string, missing?: readonly string[]): Check {
  return { code, passed: false, detail, missing };
}

function roleById(state: EngineState, roleId: string): EngineRoleRow | undefined {
  return state.roles.find((r) => r.id === roleId);
}
function roleBySlug(state: EngineState, slug: string): EngineRoleRow | undefined {
  return state.roles.find((r) => r.slug === slug);
}
function groupById(state: EngineState, groupId: string): EngineGroupRow | undefined {
  return state.groups.find((g) => g.id === groupId);
}
function groupByType(state: EngineState, type: string): EngineGroupRow | undefined {
  return state.groups.find((g) => g.type === type);
}

/** Union bundle of a set of role slugs (resolved against state). */
function bundleOfRoleSlugs(
  state: EngineState,
  slugs: readonly string[],
): string[] {
  const out: string[] = [];
  for (const slug of slugs) {
    const role = roleBySlug(state, slug);
    if (role) out.push(...role.capabilities);
  }
  return dedupe(out);
}

function authorityCheck(
  actorCapabilities: readonly string[],
  requiredBundle: readonly string[],
): Check {
  const decision = checkAuthorityOverBundle(actorCapabilities, requiredBundle);
  if (decision.ok) return pass("insufficient_authority");
  return fail("insufficient_authority", undefined, decision.missing);
}

function nondelegableCheck(proposedBundle: readonly string[]): Check {
  const decision = assertNoNondelegableCapabilities(proposedBundle);
  if (decision.ok) return pass("nondelegable_capability");
  return fail("nondelegable_capability", undefined, decision.rejected);
}

function knownCapabilityCheck(
  state: EngineState,
  proposed: readonly string[],
): Check {
  const known = new Set(state.knownCapabilities);
  const unknown = dedupe(proposed.filter((c) => !known.has(c)));
  if (unknown.length === 0) return pass("unknown_capability");
  return fail("unknown_capability", undefined, unknown);
}

function evaluateRoleCreate(
  op: Extract<AccessControlOperation, { kind: "role.create" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) {
    checks.push(fail("missing_manage_roles"));
  } else {
    checks.push(pass("missing_manage_roles"));
  }
  if (isReservedSystemRoleSlug(op.slug)) {
    checks.push(fail("reserved_slug", op.slug));
  } else {
    checks.push(pass("reserved_slug"));
  }
  if (roleBySlug(state, op.slug)) {
    checks.push(fail("reserved_slug", "slug already in use"));
  } else if (!isReservedSystemRoleSlug(op.slug)) {
    checks.push(pass("reserved_slug"));
  }
  checks.push(nondelegableCheck(op.capabilities));
  checks.push(knownCapabilityCheck(state, op.capabilities));
  checks.push(authorityCheck(actorCaps, op.capabilities));
  const failures = checks.filter((c) => !c.passed);
  return {
    ok: failures.length === 0,
    checks,
    failures,
    currentAuthority: [],
    proposedAuthority: dedupe(op.capabilities),
    authorityDelta: bundleDelta([], dedupe(op.capabilities)),
    auditPreview: {
      kind: "rbac_role_created",
      actorId: null,
      roleId: "",
      roleSlug: op.slug,
      capabilities: dedupe(op.capabilities),
    },
  };
}

function evaluateRoleRename(
  op: Extract<AccessControlOperation, { kind: "role.rename" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) checks.push(fail("missing_manage_roles"));
  else checks.push(pass("missing_manage_roles"));
  const role = roleById(state, op.roleId);
  if (!role) {
    checks.push(fail("not_found", "role"));
  } else {
    checks.push(pass("not_found"));
    if (role.isSystem) checks.push(fail("protected_definition", "system role"));
    else checks.push(pass("protected_definition"));
    checks.push(authorityCheck(actorCaps, role.capabilities));
  }
  const failures = checks.filter((c) => !c.passed);
  return {
    ok: failures.length === 0,
    checks,
    failures,
    auditPreview: {
      kind: "rbac_role_renamed",
      actorId: null,
      roleId: op.roleId,
      roleSlug: role?.slug ?? "",
      label: op.label,
    },
  };
}

function evaluateRoleSetCapabilities(
  op: Extract<AccessControlOperation, { kind: "role.set_capabilities" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) checks.push(fail("missing_manage_roles"));
  else checks.push(pass("missing_manage_roles"));
  const role = roleById(state, op.roleId);
  if (!role) {
    checks.push(fail("not_found", "role"));
  } else {
    checks.push(pass("not_found"));
    if (role.isSystem) checks.push(fail("protected_definition", "system role"));
    else checks.push(pass("protected_definition"));
    checks.push(nondelegableCheck(op.capabilities));
    checks.push(knownCapabilityCheck(state, op.capabilities));
    // Authority over BOTH current and proposed bundles.
    const combined = dedupe([...role.capabilities, ...op.capabilities]);
    checks.push(authorityCheck(actorCaps, combined));
  }
  const failures = checks.filter((c) => !c.passed);
  const proposed = dedupe(op.capabilities);
  // Shared Permission-set edit: enumerate EVERY affected Group and Human and
  // each Human's true effective added/removed/unchanged delta. Affected
  // Humans are the members of every Group carrying this Role, de-duplicated.
  let affectedUserDeltas: AffectedUserDelta[] | undefined;
  if (role) {
    const projected = projectRoleSetCapabilities(state, op.roleId, op.capabilities);
    const affectedHumans = state.groups
      .filter((g) => g.roleSlugs.includes(role.slug))
      .flatMap((g) => g.members);
    affectedUserDeltas = computeAffectedUserDeltas(state, projected, affectedHumans);
  }
  return {
    ok: failures.length === 0,
    checks,
    failures,
    currentAuthority: role?.capabilities,
    proposedAuthority: proposed,
    authorityDelta: role ? bundleDelta(role.capabilities, proposed) : undefined,
    affectedUserDeltas,
    auditPreview: {
      kind: "rbac_role_capabilities_set",
      actorId: null,
      roleId: op.roleId,
      roleSlug: role?.slug ?? "",
      capabilities: proposed,
    },
  };
}

function evaluateRoleDelete(
  op: Extract<AccessControlOperation, { kind: "role.delete" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) checks.push(fail("missing_manage_roles"));
  else checks.push(pass("missing_manage_roles"));
  const role = roleById(state, op.roleId);
  if (!role) {
    checks.push(fail("not_found", "role"));
  } else {
    checks.push(pass("not_found"));
    if (role.isSystem) checks.push(fail("protected_definition", "system role"));
    else checks.push(pass("protected_definition"));
    // Reduction is not an exemption: deleting requires authority over the
    // current bundle.
    checks.push(authorityCheck(actorCaps, role.capabilities));
  }
  const failures = checks.filter((c) => !c.passed);
  let consequence: DeletionConsequence | undefined;
  // Shared Permission-set delete blast radius: every Human who is a member
  // of a Group carrying this Role, with true effective removed/unchanged
  // deltas (a cap preserved by another Role/Group is UNCHANGED, not removed).
  let affectedUserDeltas: AffectedUserDelta[] | undefined;
  if (role) {
    const affectedGroups = state.groups
      .filter((g) => g.roleSlugs.includes(role.slug))
      .map((g) => ({ groupId: g.id, groupType: g.type, memberCount: g.memberCount }));
    consequence = {
      targetKind: "role",
      targetId: role.id,
      targetLabel: role.label,
      affectedGroups,
      groupRolesRemoved: affectedGroups.length,
      roleCapabilitiesRemoved: role.capabilities.length,
    };
    const projected = withoutRole(state, op.roleId);
    const affectedHumans = state.groups
      .filter((g) => g.roleSlugs.includes(role.slug))
      .flatMap((g) => g.members);
    affectedUserDeltas = computeAffectedUserDeltas(state, projected, affectedHumans);
  }
  return {
    ok: failures.length === 0,
    checks,
    failures,
    deletionConsequence: consequence,
    affectedUserDeltas,
    auditPreview: {
      kind: "rbac_role_deleted",
      actorId: null,
      roleId: op.roleId,
      roleSlug: role?.slug ?? "",
    },
  };
}

function validateCustomRoleSlugs(
  state: EngineState,
  slugs: readonly string[],
): Check[] {
  const checks: Check[] = [];
  for (const slug of slugs) {
    const role = roleBySlug(state, slug);
    if (!role) {
      checks.push(fail("not_found", `role ${slug}`));
    } else if (role.isSystem) {
      // Custom Groups carry ONLY custom Roles; canonical ladder assignment
      // stays canonical (membership in the matching canonical Group).
      checks.push(fail("protected_definition", `canonical role ${slug}`));
    }
  }
  if (checks.length === 0) checks.push(pass("protected_definition"));
  return checks;
}

function evaluateGroupCreate(
  op: Extract<AccessControlOperation, { kind: "group.create" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
  targetUserExists: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) checks.push(fail("missing_manage_groups"));
  else checks.push(pass("missing_manage_groups"));
  if (!op.groupType.startsWith(CUSTOM_GROUP_TYPE_PREFIX)) {
    checks.push(fail("invalid_custom_type", "must start with custom:"));
  } else {
    checks.push(pass("invalid_custom_type"));
    const suffix = op.groupType.slice(CUSTOM_GROUP_TYPE_PREFIX.length);
    if (suffix.length === 0) {
      checks.push(fail("invalid_custom_type", "empty custom suffix"));
    } else if (isCanonicalGroupType(suffix) || isCanonicalGroupType(op.groupType)) {
      checks.push(fail("reserved_type", op.groupType));
    } else {
      checks.push(pass("reserved_type"));
    }
  }
  if (groupByType(state, op.groupType)) {
    checks.push(fail("reserved_type", "group type already in use"));
  } else {
    checks.push(pass("reserved_type"));
  }
  if (!targetUserExists) checks.push(fail("user_not_found", "owner"));
  else checks.push(pass("user_not_found"));
  checks.push(...validateCustomRoleSlugs(state, op.roleSlugs));
  const proposedBundle = bundleOfRoleSlugs(state, op.roleSlugs);
  checks.push(nondelegableCheck(proposedBundle));
  checks.push(authorityCheck(actorCaps, proposedBundle));
  const failures = checks.filter((c) => !c.passed);
  return {
    ok: failures.length === 0,
    checks,
    failures,
    currentAuthority: [],
    proposedAuthority: proposedBundle,
    authorityDelta: bundleDelta([], proposedBundle),
    auditPreview: {
      kind: "rbac_group_created",
      actorId: null,
      groupId: "",
      groupType: op.groupType,
      ownerUserId: op.ownerUserId,
      roleSlugs: dedupe(op.roleSlugs),
    },
  };
}

function evaluateGroupRename(
  op: Extract<AccessControlOperation, { kind: "group.rename" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) checks.push(fail("missing_manage_groups"));
  else checks.push(pass("missing_manage_groups"));
  const group = groupById(state, op.groupId);
  if (!group) {
    checks.push(fail("not_found", "group"));
  } else {
    checks.push(pass("not_found"));
    if (group.isSystem) checks.push(fail("protected_definition", "system group"));
    else checks.push(pass("protected_definition"));
    checks.push(authorityCheck(actorCaps, group.capabilities));
  }
  const failures = checks.filter((c) => !c.passed);
  return {
    ok: failures.length === 0,
    checks,
    failures,
    auditPreview: {
      kind: "rbac_group_renamed",
      actorId: null,
      groupId: op.groupId,
      groupType: group?.type ?? "",
      label: op.label,
    },
  };
}

function evaluateGroupSetRoles(
  op: Extract<AccessControlOperation, { kind: "group.set_roles" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) checks.push(fail("missing_manage_groups"));
  else checks.push(pass("missing_manage_groups"));
  const group = groupById(state, op.groupId);
  if (!group) {
    checks.push(fail("not_found", "group"));
  } else {
    checks.push(pass("not_found"));
    if (group.isSystem) checks.push(fail("protected_definition", "system group"));
    else checks.push(pass("protected_definition"));
    checks.push(...validateCustomRoleSlugs(state, op.roleSlugs));
    if (group.members.length > 0 && op.roleSlugs.includes("community")) {
      checks.push(fail("community_enrollment_unavailable"));
    }
    const proposedBundle = bundleOfRoleSlugs(state, op.roleSlugs);
    checks.push(nondelegableCheck(proposedBundle));
    // Authority over BOTH current and proposed bundles.
    const combined = dedupe([...group.capabilities, ...proposedBundle]);
    checks.push(authorityCheck(actorCaps, combined));
  }
  const failures = checks.filter((c) => !c.passed);
  const proposedBundle = bundleOfRoleSlugs(state, op.roleSlugs);
  // Truthful affected-Human deltas: every member of this Group, before vs
  // after its Role set changes. A cap preserved by another Group the Human
  // belongs to is UNCHANGED, not removed.
  let affectedUserDeltas: AffectedUserDelta[] | undefined;
  if (group) {
    const projected = projectGroupSetRoles(state, op.groupId, op.roleSlugs);
    affectedUserDeltas = computeAffectedUserDeltas(state, projected, group.members);
  }
  return {
    ok: failures.length === 0,
    checks,
    failures,
    currentAuthority: group?.capabilities,
    proposedAuthority: proposedBundle,
    authorityDelta: group ? bundleDelta(group.capabilities, proposedBundle) : undefined,
    affectedUserDeltas,
    auditPreview: {
      kind: "rbac_group_roles_set",
      actorId: null,
      groupId: op.groupId,
      groupType: group?.type ?? "",
      roleSlugs: dedupe(op.roleSlugs),
    },
  };
}

function evaluateGroupTransferOwner(
  op: Extract<AccessControlOperation, { kind: "group.transfer_owner" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
  targetUserExists: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) checks.push(fail("missing_manage_groups"));
  else checks.push(pass("missing_manage_groups"));
  const group = groupById(state, op.groupId);
  if (!group) {
    checks.push(fail("not_found", "group"));
  } else {
    checks.push(pass("not_found"));
    if (group.isSystem) checks.push(fail("protected_definition", "system group"));
    else checks.push(pass("protected_definition"));
    checks.push(authorityCheck(actorCaps, group.capabilities));
  }
  if (!targetUserExists) checks.push(fail("user_not_found", "new owner"));
  else checks.push(pass("user_not_found"));
  const failures = checks.filter((c) => !c.passed);
  return {
    ok: failures.length === 0,
    checks,
    failures,
    auditPreview: {
      kind: "rbac_group_owner_transferred",
      actorId: null,
      groupId: op.groupId,
      groupType: group?.type ?? "",
      fromOwnerUserId: group?.ownerId ?? null,
      toOwnerUserId: op.newOwnerUserId,
    },
  };
}

function evaluateGroupDelete(
  op: Extract<AccessControlOperation, { kind: "group.delete" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) checks.push(fail("missing_manage_groups"));
  else checks.push(pass("missing_manage_groups"));
  const group = groupById(state, op.groupId);
  if (!group) {
    checks.push(fail("not_found", "group"));
  } else {
    checks.push(pass("not_found"));
    if (group.isSystem) checks.push(fail("protected_definition", "system group"));
    else checks.push(pass("protected_definition"));
    checks.push(authorityCheck(actorCaps, group.capabilities));
  }
  const failures = checks.filter((c) => !c.passed);
  let consequence: DeletionConsequence | undefined;
  // Truthful affected-Human deltas for every member: before vs after the
  // Group (and its memberships) is deleted. A cap preserved by another
  // Group the Human belongs to is UNCHANGED, not removed.
  let affectedUserDeltas: AffectedUserDelta[] | undefined;
  if (group) {
    consequence = {
      targetKind: "group",
      targetId: group.id,
      targetLabel: group.label,
      membersRemoved: group.memberCount,
      approvalChallengesRemoved: group.approvalChallengeCount,
      roleAssignmentsRemoved: group.roleSlugs.length,
    };
    const projected = withoutGroup(state, op.groupId);
    affectedUserDeltas = computeAffectedUserDeltas(state, projected, group.members);
  }
  return {
    ok: failures.length === 0,
    checks,
    failures,
    deletionConsequence: consequence,
    affectedUserDeltas,
    auditPreview: {
      kind: "rbac_group_deleted",
      actorId: null,
      groupId: op.groupId,
      groupType: group?.type ?? "",
    },
  };
}

function evaluateMembership(
  op: Extract<AccessControlOperation, { kind: "membership.add" | "membership.remove" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHoldsManagement: boolean,
  actorHeldManagementCaps: readonly CapabilitySlug[],
  targetUserExists: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  if (!actorHoldsManagement) checks.push(fail("missing_manage_members"));
  else checks.push(pass("missing_manage_members"));
  const group = groupById(state, op.groupId);
  if (!group) {
    checks.push(fail("not_found", "group"));
  } else {
    checks.push(pass("not_found"));
    if (op.kind === "membership.add" && (group.type === "communities" || group.roleSlugs.includes("community"))) {
      checks.push(fail("community_enrollment_unavailable"));
    }
    if (group.type === UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE) {
      if (actorHeldManagementCaps.includes("manage_uncontained_host_commands")) {
        checks.push(pass("missing_manage_uncontained_host_commands"));
      } else {
        checks.push(fail("missing_manage_uncontained_host_commands"));
      }
    }
    // Reduction is not an exemption: removing a member still requires
    // authority over the Group's current bundle (the last-Owner rail stays
    // independent of this authority check).
    const authority = authorityCheck(actorCaps, group.capabilities);
    checks.push(authority);
    // Stack 195 follow-up — Owner lifecycle rail (preview parity with
    // apply's `MembershipOpError("last_owner")`). Removing the sole
    // remaining Owner would leave zero Owners, so the preview MUST surface
    // a stable `last_owner` failure regardless of `bypassLastOwner` (the
    // bypass flag is no longer honored for the sole-Owner case). Uses the
    // fingerprinted `group.members` edge set (the exact projection the
    // apply fingerprint recomputes under locks) so a count-only drift
    // cannot mask the rail and preview/apply agree. The rail only fires
    // when the actor is authorized to remove: an unauthorized actor is
    // rejected with `insufficient_authority` (403), not `last_owner` (409).
    if (
      authority.passed &&
      op.kind === "membership.remove" &&
      group.type === "owners" &&
      group.members.length === 1 &&
      group.members[0] === op.userId
    ) {
      checks.push(fail("last_owner", "removing the sole Owner would leave zero Owners"));
    } else if (op.kind === "membership.remove" && group.type === "owners") {
      checks.push(pass("last_owner"));
    }
  }
  if (!targetUserExists) checks.push(fail("user_not_found", "target user"));
  else checks.push(pass("user_not_found"));
  const failures = checks.filter((c) => !c.passed);
  // True source-aware effective delta: the Human's effective union across
  // ALL their Groups before vs after this single membership edge changes.
  // A cap preserved by another Group is UNCHANGED, not removed.
  let affectedUserDelta: AffectedUserDelta | undefined;
  if (group && targetUserExists) {
    const projected =
      op.kind === "membership.add"
        ? projectMembershipAdd(state, op.groupId, op.userId)
        : projectMembershipRemove(state, op.groupId, op.userId);
    affectedUserDelta = effectiveUserDelta(state, projected, op.userId) ?? undefined;
    if (affectedUserDelta === undefined) {
      // No effective change (e.g. add of an existing member, or remove where
      // every cap is preserved elsewhere). Still surface an explicit no-op
      // delta so the UI can show "nothing changes" rather than a raw bundle.
      const before = effectiveCapabilitiesForUser(state, op.userId);
      affectedUserDelta = {
        userId: op.userId,
        added: [],
        removed: [],
        unchanged: before,
      };
    }
  }
  return {
    ok: failures.length === 0,
    checks,
    failures,
    affectedUserDelta,
    auditPreview:
      op.kind === "membership.add"
        ? {
            kind: "group_member_added",
            actorId: null,
            groupId: op.groupId,
            groupType: group?.type ?? "",
            targetUserId: op.userId,
          }
        : {
            kind: "group_member_removed",
            actorId: null,
            groupId: op.groupId,
            groupType: group?.type ?? "",
            targetUserId: op.userId,
            // Stack 195 follow-up — `bypassedRail` means a rail was ACTUALLY
            // exercised. Sole-Owner removal is now forbidden even with
            // `bypassLastOwner=true` (see executeOperationWrites), so a
            // successful removal never bypassed the last-Owner rail. Do NOT
            // log a bypass merely because the request asked for one.
            bypassedRail: false,
          },
  };
}

/**
 * Stack 195 / W3.2.14 — atomic Create shared access composite evaluator.
 * Validates the new Permission set (Role), the new custom Group, and the
 * initial memberships in one pass, requiring ALL THREE management caps and
 * every W3.0 anti-escalation / nondelegable / protected / reserved check.
 * Computes true effective deltas for every initial member. Pure.
 */
function evaluateSharedAccessCreate(
  op: Extract<AccessControlOperation, { kind: "shared_access.create" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHeldManagementCaps: readonly CapabilitySlug[],
  targetUserExists: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  // Composite authorization: ALL THREE management capabilities.
  const requiredMgmt = managementCapabilitiesFor(op);
  const missingMgmt = requiredMgmt.filter((c) => !actorHeldManagementCaps.includes(c));
  if (missingMgmt.length === 0) {
    // Single pass check entry per gate (mirrors single-cap evaluators).
    checks.push(pass("missing_manage_roles"));
    checks.push(pass("missing_manage_groups"));
    checks.push(pass("missing_manage_members"));
  } else {
    for (const cap of ["manage_roles", "manage_groups", "manage_members"] as const) {
      if (missingMgmt.includes(cap)) checks.push(fail(`missing_${cap}` as CheckCode));
      else checks.push(pass(`missing_${cap}` as CheckCode));
    }
  }

  // --- Permission set (Role) validation ---
  const roleSlug = op.role.slug;
  if (isReservedSystemRoleSlug(roleSlug)) {
    checks.push(fail("reserved_slug", roleSlug));
  } else {
    checks.push(pass("reserved_slug"));
  }
  if (roleBySlug(state, roleSlug)) {
    checks.push(fail("reserved_slug", "slug already in use"));
  } else if (!isReservedSystemRoleSlug(roleSlug)) {
    checks.push(pass("reserved_slug"));
  }
  const roleCaps = dedupe(op.role.capabilities);
  checks.push(nondelegableCheck(roleCaps));
  checks.push(knownCapabilityCheck(state, roleCaps));
  checks.push(authorityCheck(actorCaps, roleCaps));

  // --- Group validation ---
  const groupType = op.group.groupType;
  if (!groupType.startsWith(CUSTOM_GROUP_TYPE_PREFIX)) {
    checks.push(fail("invalid_custom_type", "must start with custom:"));
  } else {
    checks.push(pass("invalid_custom_type"));
    const suffix = groupType.slice(CUSTOM_GROUP_TYPE_PREFIX.length);
    if (suffix.length === 0) {
      checks.push(fail("invalid_custom_type", "empty custom suffix"));
    } else if (isCanonicalGroupType(suffix) || isCanonicalGroupType(groupType)) {
      checks.push(fail("reserved_type", groupType));
    } else {
      checks.push(pass("reserved_type"));
    }
  }
  if (groupByType(state, groupType)) {
    checks.push(fail("reserved_type", "group type already in use"));
  } else {
    checks.push(pass("reserved_type"));
  }

  // --- Owner + initial members existence ---
  if (!targetUserExists) checks.push(fail("user_not_found", "owner or member"));
  else checks.push(pass("user_not_found"));

  const memberUserIds = dedupe(op.memberUserIds);
  if (memberUserIds.length === 0) {
    checks.push(fail("not_found", "initial members must be non-empty"));
  } else {
    checks.push(pass("not_found"));
  }

  const failures = checks.filter((c) => !c.passed);

  // --- True effective deltas for every initial member ---
  // The new Group grants the new Role's bundle to each initial member. For
  // a member who already holds every cap via another Group, the delta is
  // all-UNCHANGED; for a brand-new cap it is ADDED. Computed against the
  // projected post-create state so the union is truthful.
  let affectedUserDeltas: AffectedUserDelta[] | undefined;
  if (failures.length === 0) {
    const projected = projectSharedAccessCreate(state, op, "r:new", "g:new");
    affectedUserDeltas = computeAffectedUserDeltas(state, projected, memberUserIds);
    // Even members with no effective change get an explicit UNCHANGED row so
    // the UI can show "already holds" rather than dropping them silently.
    const present = new Set(affectedUserDeltas.map((d) => d.userId));
    for (const userId of memberUserIds) {
      if (!present.has(userId)) {
        affectedUserDeltas.push({
          userId,
          added: [],
          removed: [],
          unchanged: effectiveCapabilitiesForUser(state, userId),
        });
      }
    }
    affectedUserDeltas.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  return {
    ok: failures.length === 0,
    checks,
    failures,
    proposedAuthority: roleCaps,
    authorityDelta: bundleDelta([], roleCaps),
    affectedUserDeltas,
    auditPreview: {
      kind: "rbac_shared_access_created",
      actorId: null,
      roleId: "",
      roleSlug,
      capabilities: roleCaps,
      groupId: "",
      groupType,
      ownerUserId: op.group.ownerUserId,
      memberCount: memberUserIds.length,
    },
  };
}

/**
 * Stack 195 / W3.2.14 — atomic Assign existing Permission set composite
 * evaluator. Validates the EXISTING custom Permission set (Role), the new
 * custom Group, and the initial memberships in one pass, requiring
 * `manage_groups` AND `manage_members` (NOT `manage_roles`) plus actor
 * authority over the existing Role's complete bundle. The Role definition
 * is never mutated, so the nondelegable / known-capability / reserved-slug
 * checks (which guard Role *creation/edit*) do not apply; the
 * protected-definition check still rejects canonical/system Roles, and the
 * authority check rejects a stronger/unheld bundle. Computes true effective
 * deltas for every initial member. Pure.
 */
function evaluateSharedAccessAssignExisting(
  op: Extract<AccessControlOperation, { kind: "shared_access.assign_existing" }>,
  state: EngineState,
  actorCaps: readonly string[],
  actorHeldManagementCaps: readonly CapabilitySlug[],
  targetUserExists: boolean,
): EvaluationResult {
  const checks: Check[] = [];
  // Composite authorization: manage_groups AND manage_members (two caps).
  const requiredMgmt = managementCapabilitiesFor(op);
  const missingMgmt = requiredMgmt.filter((c) => !actorHeldManagementCaps.includes(c));
  if (missingMgmt.length === 0) {
    checks.push(pass("missing_manage_groups"));
    checks.push(pass("missing_manage_members"));
  } else {
    for (const cap of ["manage_groups", "manage_members"] as const) {
      if (missingMgmt.includes(cap)) checks.push(fail(`missing_${cap}` as CheckCode));
      else checks.push(pass(`missing_${cap}` as CheckCode));
    }
  }

  // --- Existing Permission set (Role) validation ---
  // Reuse the custom-Role slug validator: not_found if absent,
  // protected_definition if canonical/system. No reserved-slug check (the
  // Role already exists), no nondelegable / known-capability check (the
  // Role definition is not mutated).
  const role = roleBySlug(state, op.roleSlug);
  checks.push(...validateCustomRoleSlugs(state, [op.roleSlug]));
  if (role) {
    // Authority over the existing Role's COMPLETE bundle (reduction is not
    // an exemption, and a stronger/unheld bundle is rejected here).
    checks.push(authorityCheck(actorCaps, role.capabilities));
  }

  // --- Group validation (mirrors group.create) ---
  const groupType = op.group.groupType;
  if (!groupType.startsWith(CUSTOM_GROUP_TYPE_PREFIX)) {
    checks.push(fail("invalid_custom_type", "must start with custom:"));
  } else {
    checks.push(pass("invalid_custom_type"));
    const suffix = groupType.slice(CUSTOM_GROUP_TYPE_PREFIX.length);
    if (suffix.length === 0) {
      checks.push(fail("invalid_custom_type", "empty custom suffix"));
    } else if (isCanonicalGroupType(suffix) || isCanonicalGroupType(groupType)) {
      checks.push(fail("reserved_type", groupType));
    } else {
      checks.push(pass("reserved_type"));
    }
  }
  if (groupByType(state, groupType)) {
    checks.push(fail("reserved_type", "group type already in use"));
  } else {
    checks.push(pass("reserved_type"));
  }

  // --- Owner + initial members existence ---
  if (!targetUserExists) checks.push(fail("user_not_found", "owner or member"));
  else checks.push(pass("user_not_found"));

  const memberUserIds = dedupe(op.memberUserIds);
  if (memberUserIds.length === 0) {
    checks.push(fail("not_found", "initial members must be non-empty"));
  } else {
    checks.push(pass("not_found"));
  }

  const failures = checks.filter((c) => !c.passed);

  // --- True effective deltas for every initial member ---
  // The new Group grants the existing Role's bundle to each initial member.
  // For a member who already holds every cap via another Group, the delta is
  // all-UNCHANGED; for a brand-new cap it is ADDED. Computed against the
  // projected post-assign state so the union is truthful.
  let affectedUserDeltas: AffectedUserDelta[] | undefined;
  if (failures.length === 0) {
    const projected = projectSharedAccessAssignExisting(state, op, "g:new");
    affectedUserDeltas = computeAffectedUserDeltas(state, projected, memberUserIds);
    const present = new Set(affectedUserDeltas.map((d) => d.userId));
    for (const userId of memberUserIds) {
      if (!present.has(userId)) {
        affectedUserDeltas.push({
          userId,
          added: [],
          removed: [],
          unchanged: effectiveCapabilitiesForUser(state, userId),
        });
      }
    }
    affectedUserDeltas.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  const roleCaps = role ? dedupe(role.capabilities) : [];
  return {
    ok: failures.length === 0,
    checks,
    failures,
    proposedAuthority: roleCaps,
    authorityDelta: bundleDelta([], roleCaps),
    affectedUserDeltas,
    auditPreview: {
      kind: "rbac_shared_access_assigned",
      actorId: null,
      roleId: role?.id ?? "",
      roleSlug: op.roleSlug,
      capabilities: roleCaps,
      groupId: "",
      groupType,
      ownerUserId: op.group.ownerUserId,
      memberCount: memberUserIds.length,
    },
  };
}

/**
 * Pure decision core: given a resolved {@link EngineState} + actor facts,
 * return the structured evaluation (checks, failures, deltas, deletion
 * consequence, redacted audit preview). No I/O. Both preview and apply
 * route through this so the policy is enforced identically.
 */
function evaluateBaseOperation(input: EvaluationInput): EvaluationResult {
  const { operation: op, state, actorCapabilities, actorHoldsManagement, actorHeldManagementCaps, targetUserExists } = input;
  switch (op.kind) {
    case "role.create":
      return evaluateRoleCreate(op, state, actorCapabilities, actorHoldsManagement);
    case "role.rename":
      return evaluateRoleRename(op, state, actorCapabilities, actorHoldsManagement);
    case "role.set_capabilities":
      return evaluateRoleSetCapabilities(op, state, actorCapabilities, actorHoldsManagement);
    case "role.delete":
      return evaluateRoleDelete(op, state, actorCapabilities, actorHoldsManagement);
    case "group.create":
      return evaluateGroupCreate(op, state, actorCapabilities, actorHoldsManagement, targetUserExists);
    case "group.rename":
      return evaluateGroupRename(op, state, actorCapabilities, actorHoldsManagement);
    case "group.set_moderation_scopes": {
      const group = groupById(state, op.groupId);
      const result = evaluateGroupSetRoles({ kind: "group.set_roles", groupId: op.groupId, roleSlugs: group?.roleSlugs ?? [] }, state, actorCapabilities, actorHoldsManagement);
      return { ...result, auditPreview: { kind: "rbac_group_moderation_scopes_set", actorId: null, groupId: op.groupId, roomIds: dedupe(op.roomIds).sort() } };
    }
    case "group.set_roles":
      return evaluateGroupSetRoles(op, state, actorCapabilities, actorHoldsManagement);
    case "group.transfer_owner":
      return evaluateGroupTransferOwner(op, state, actorCapabilities, actorHoldsManagement, targetUserExists);
    case "group.delete":
      return evaluateGroupDelete(op, state, actorCapabilities, actorHoldsManagement);
    case "membership.add":
    case "membership.remove":
      return evaluateMembership(
        op,
        state,
        actorCapabilities,
        actorHeldManagementCaps.includes("manage_members"),
        actorHeldManagementCaps,
        targetUserExists,
      );
    case "shared_access.create":
      return evaluateSharedAccessCreate(op, state, actorCapabilities, actorHeldManagementCaps, targetUserExists);
    case "shared_access.assign_existing":
      return evaluateSharedAccessAssignExisting(op, state, actorCapabilities, actorHeldManagementCaps, targetUserExists);
  }
}

// ---------------------------------------------------------------------------

/** Scope delegation is checked for every writer of an already scoped Group. */
export function evaluateOperation(input: EvaluationInput): EvaluationResult {
  const result = evaluateBaseOperation(input);
  const { operation: op, state } = input;
  const affected = "groupId" in op && op.kind !== "group.rename" ? state.groups.filter(g => g.id === op.groupId)
    : (op.kind === "role.set_capabilities" || op.kind === "role.delete")
      ? state.groups.filter(g => g.roleSlugs.includes(roleById(state, op.roleId)?.slug ?? "")) : [];
  const caller: ModerationAuthority = {
    userId: input.actorUserId ?? "", owner: false, disabled: false,
    grants: state.groups.filter(g => g.members.includes(input.actorUserId ?? "")).map(g => ({
      groupId: g.id, capabilities: g.capabilities, roomIds: g.moderationRoomIds ?? [],
    })),
  };
  const checks = [...result.checks];
  if (op.kind === "group.set_moderation_scopes" && input.moderationRoomsExist !== true) checks.push(fail("moderation_room_unavailable"));
  for (const group of affected) {
    const roomIds = dedupe([...(group.moderationRoomIds ?? []), ...(op.kind === "group.set_moderation_scopes" ? op.roomIds : [])]);
    const proposed = op.kind === "role.set_capabilities" ? op.capabilities
      : op.kind === "group.set_roles" ? bundleOfRoleSlugs(state, op.roleSlugs) : [];
    const bundle = dedupe([...group.capabilities, ...proposed]);
    for (const roomId of roomIds) for (const permission of MODERATION_PERMISSIONS) {
      if (!bundle.includes(moderationCapability(permission, "room"))) continue;
      if (!holdsModerationPermission(caller, permission, roomId)) checks.push(fail("insufficient_moderation_scope", roomId));
    }
  }
  const failures = checks.filter(check => !check.passed);
  return { ...result, checks, failures, ok: failures.length === 0 };
}

// Preview / apply orchestration (production wiring over injected deps).
// ---------------------------------------------------------------------------

export interface PreviewInput {
  readonly actorUserId: string;
  readonly actorActorId: string | null;
  readonly operation: AccessControlOperation;
}

export interface ApplyInput {
  readonly actorUserId: string;
  readonly actorActorId: string | null;
  readonly operation: AccessControlOperation;
  readonly fingerprint: string;
}

function targetUserIdsForOp(op: AccessControlOperation): readonly string[] | null {
  switch (op.kind) {
    case "group.create":
      return [op.ownerUserId];
    case "group.transfer_owner":
      return [op.newOwnerUserId];
    case "membership.add":
    case "membership.remove":
      return [op.userId];
    case "shared_access.create":
      // Owner + every initial member; de-duplicated. Existence of each is
      // checked inside apply's transaction.
      return dedupe([op.group.ownerUserId, ...op.memberUserIds]);
    case "shared_access.assign_existing":
      // Owner + every initial member; de-duplicated. Existence of each is
      // checked inside apply's transaction.
      return dedupe([op.group.ownerUserId, ...op.memberUserIds]);
    default:
      return null;
  }
}

/**
 * Read-only preview. Loads state (no locks), evaluates the operation, and
 * returns the structured checks/failures, authority delta, deletion
 * consequence, redacted audit preview, and fingerprint. Always returns
 * 200 — failures are surfaced in the response body, not as a 4xx.
 */
export async function previewOperation(
  deps: MutationEngineDeps,
  input: PreviewInput,
): Promise<PreviewResponse> {
  const [state, actorCapabilities] = await Promise.all([
    deps.loadState(),
    deps.getActorCapabilities(input.actorUserId),
  ]);
  const requiredMgmt = managementCapabilitiesFor(input.operation, state);
  const heldMgmt = await Promise.all(
    requiredMgmt.map((cap) => deps.userHasCapability(input.actorUserId, cap)),
  );
  const actorHeldManagementCaps = requiredMgmt.filter((_, i) => heldMgmt[i]);
  const actorHoldsManagement = heldMgmt.every((h) => h);
  const targetUserIds = targetUserIdsForOp(input.operation);
  const targetUserExists =
    targetUserIds === null ? true : await allUsersExist(deps, targetUserIds);
  const evaluation = evaluateOperation({
    actorUserId: input.actorUserId,
    operation: input.operation,
    state,
    actorCapabilities,
    actorHoldsManagement,
    actorHeldManagementCaps,
    targetUserExists,
    moderationRoomsExist: input.operation.kind === "group.set_moderation_scopes"
      ? await deps.moderationRoomsExist?.(input.operation.roomIds) ?? false : true,
  });
  return {
    ok: evaluation.ok,
    operation: input.operation,
    checks: evaluation.checks,
    failures: evaluation.failures,
    currentAuthority: evaluation.currentAuthority,
    proposedAuthority: evaluation.proposedAuthority,
    authorityDelta: evaluation.authorityDelta,
    affectedUserDelta: evaluation.affectedUserDelta,
    affectedUserDeltas: evaluation.affectedUserDeltas,
    deletionConsequence: evaluation.deletionConsequence,
    auditPreview: withActorId(evaluation.auditPreview, input.actorActorId),
    fingerprint: computeFingerprint(state),
  };
}

async function allUsersExist(deps: MutationEngineDeps, userIds: readonly string[]): Promise<boolean> {
  const checks = await Promise.all(userIds.map((id) => deps.userExists(id)));
  return checks.every((c) => c);
}

function withActorId(
  payload: RbacAuditEventInput,
  actorId: string | null,
): RbacAuditEventInput {
  return { ...payload, actorId } as RbacAuditEventInput;
}

/**
 * Patch the redacted audit payload with the real created-row id for
 * `role.create` / `group.create`. The preview builds these payloads before
 * the INSERT, so the id is a placeholder (`""`); after `execute` returns the
 * freshly inserted id, we splice it in so the audit row points at the real
 * object. Other operation kinds already carry their target id in the
 * operation itself, so they pass through unchanged.
 */
function patchAuditIds(
  payload: RbacAuditEventInput,
  op: AccessControlOperation,
  writes: WriteOutcome,
): RbacAuditEventInput {
  if (op.kind === "role.create" && writes.roleId) {
    return { ...payload, roleId: writes.roleId } as RbacAuditEventInput;
  }
  if (op.kind === "group.create" && writes.groupId) {
    return { ...payload, groupId: writes.groupId } as RbacAuditEventInput;
  }
  if (op.kind === "shared_access.create" && (writes.roleId || writes.groupId)) {
    return {
      ...payload,
      roleId: writes.roleId ?? (payload as { roleId: string }).roleId,
      groupId: writes.groupId ?? (payload as { groupId: string }).groupId,
    } as RbacAuditEventInput;
  }
  if (op.kind === "shared_access.assign_existing" && (writes.roleId || writes.groupId)) {
    return {
      ...payload,
      roleId: writes.roleId ?? (payload as { roleId: string }).roleId,
      groupId: writes.groupId ?? (payload as { groupId: string }).groupId,
    } as RbacAuditEventInput;
  }
  return payload;
}

/**
 * Transactional apply. Re-reads state plus actor facts inside one
 * direct-Postgres transaction after locking every catalogue/edge row
 * represented by the full-state fingerprint. Re-evaluates authorization,
 * and:
 *   - returns `409 stale_preview` (code `stale_preview`) when the
 *     fingerprint drifted,
 *   - returns `authorization_denied` (route → 403) when re-evaluation
 *     fails,
 *   - otherwise executes the writes, commits, appends the redacted audit
 *     event, and returns `applied:true` with `auditRecorded`.
 *
 * An audit append failure is surfaced as `applied:true, auditRecorded:false`
 * and never rolls back or invites a blind retry.
 */
export async function applyOperation(
  deps: MutationEngineDeps,
  input: ApplyInput,
): Promise<ApplyResult> {
  return runApply(deps, input, true);
}

/**
 * One-step direct apply (no fingerprint check). Used by the legacy
 * `PUT/DELETE /api/groups/:id/members/:userId` route so direct API and
 * legacy UI get the SAME anti-escalation + protected-definition +
 * protected-cap enforcement as the two-step preview/apply flow, while
 * keeping a single request shape. Reuses the same transactional evaluate +
 * execute + audit path.
 */
export async function applyDirectOperation(
  deps: MutationEngineDeps,
  input: { readonly actorUserId: string; readonly actorActorId: string | null; readonly operation: AccessControlOperation },
): Promise<ApplyResult> {
  return runApply(deps, input, false);
}

type TxOutcome =
  | { readonly kind: "stale"; readonly failures: readonly Check[] }
  | { readonly kind: "denied"; readonly failures: readonly Check[] }
  | {
      readonly kind: "ok";
      readonly auditPayload: RbacAuditEventInput;
      readonly fingerprint: string;
    };

async function runApply(
  deps: MutationEngineDeps,
  input: { readonly actorUserId: string; readonly actorActorId: string | null; readonly operation: AccessControlOperation; readonly fingerprint?: string },
  checkFingerprint: boolean,
): Promise<ApplyResult> {
  let outcome: TxOutcome;
  try {
    outcome = await deps.applyInTx<TxOutcome>(async (tx, state) => {
      const requiredMgmt = managementCapabilitiesFor(input.operation, state);
      const targetUserIds = targetUserIdsForOp(input.operation);
      const facts = await deps.loadApplyFacts(tx, {
        actorUserId: input.actorUserId,
        requiredManagementCapabilities: requiredMgmt,
        targetUserIds,
        moderationRoomIds: input.operation.kind === "group.set_moderation_scopes" ? input.operation.roomIds : [],
      });
      const evaluation = evaluateOperation({
        actorUserId: input.actorUserId,
        operation: input.operation,
        state,
        actorCapabilities: facts.actorCapabilities,
        actorHoldsManagement: facts.actorHoldsManagement,
        actorHeldManagementCaps: facts.actorHeldManagementCaps,
        targetUserExists: facts.targetUserExists,
        moderationRoomsExist: facts.moderationRoomsExist ?? false,
      });
      const currentFingerprint = computeFingerprint(state);
      if (checkFingerprint && input.fingerprint !== currentFingerprint) {
        return { kind: "stale", failures: evaluation.failures } as TxOutcome;
      }
      if (!evaluation.ok) {
      // Stack 195 follow-up — preview/apply parity for the sole-Owner rail.
      // The preview surfaces `last_owner` as a structured check; apply MUST
      // map the same invariant to the stable 409 `last_owner` the direct and
      // legacy routes already return, and execute MUST NOT run for a
      // rejected preview. Re-raise as `MembershipOpError("last_owner")` so
      // the routes' existing 409 mapping applies identically for the
      // two-step preview/apply flow AND the one-step direct/legacy path.
        if (evaluation.failures.some((f) => f.code === "last_owner")) {
          throw new MembershipOpError("last_owner");
        }
        return { kind: "denied", failures: evaluation.failures } as TxOutcome;
      }
      const writes = await deps.execute(tx, input.operation, state);
      return {
        kind: "ok",
        auditPayload: withActorId(patchAuditIds(evaluation.auditPreview, input.operation, writes), input.actorActorId),
        fingerprint: currentFingerprint,
      } as TxOutcome;
    });
  } catch (error) {
    // Serializable applies may be aborted by PostgreSQL when a concurrent
    // RBAC writer changes the catalogue/edges while this command is in
    // flight. The caller must obtain a fresh preview rather than retrying a
    // mutation against an unreviewed state.
    if (isSerializationFailure(error)) {
      return {
        applied: false,
        code: "stale_preview",
        failures: [],
        reason: "state changed while applying preview",
      };
    }
    throw error;
  }
  if (outcome.kind === "stale") {
    return {
      applied: false,
      code: "stale_preview",
      failures: outcome.failures,
      reason: "state drifted since preview",
    };
  }
  if (outcome.kind === "denied") {
    return { applied: false, code: "authorization_denied", failures: outcome.failures };
  }
  let auditRecorded = true;
  try {
    deps.appendAuditEvent(outcome.auditPayload);
  } catch {
    auditRecorded = false;
  }
  return { applied: true, auditRecorded, fingerprint: outcome.fingerprint };
}

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "40001"
  );
}

// ---------------------------------------------------------------------------
// Production wiring: real direct-Postgres reads/writes through the shared
// pool. The audit writer is injected by the route (it closes over the
// request envelope: ts/ip/userAgent + the audit file path).
// ---------------------------------------------------------------------------

async function loadStateFrom(dbClient: Pick<Database, "select">): Promise<EngineState> {
  const capRows = await dbClient
    .select({ slug: capabilities.slug })
    .from(capabilities);
  const knownCapabilities = capRows.map((r) => r.slug);

  const roleRows = await dbClient
    .select({ id: roles.id, slug: roles.slug, label: roles.label, isSystem: roles.isSystem })
    .from(roles);
  const roleCapRows = await dbClient
    .select({ roleId: roleCapabilities.roleId, slug: capabilities.slug })
    .from(roleCapabilities)
    .innerJoin(capabilities, eq(roleCapabilities.capabilityId, capabilities.id));
  const capsByRole = new Map<string, string[]>();
  for (const r of roleCapRows) {
    const list = capsByRole.get(r.roleId);
    if (list) list.push(r.slug);
    else capsByRole.set(r.roleId, [r.slug]);
  }
  const rolesState: EngineRoleRow[] = roleRows.map((r) => ({
    id: r.id,
    slug: r.slug,
    label: r.label,
    isSystem: r.isSystem,
    capabilities: dedupe(capsByRole.get(r.id) ?? []),
  }));

  const groupRows = await dbClient
    .select({
      id: groups.id,
      type: groups.type,
      label: groups.label,
      isSystem: groups.isSystem,
      ownerId: groups.ownerId,
    })
    .from(groups);
  const groupRoleRows = await dbClient
    .select({ groupId: groupRoles.groupId, slug: roles.slug })
    .from(groupRoles)
    .innerJoin(roles, eq(groupRoles.roleId, roles.id));
  const roleSlugsByGroup = new Map<string, string[]>();
  for (const r of groupRoleRows) {
    const list = roleSlugsByGroup.get(r.groupId);
    if (list) list.push(r.slug);
    else roleSlugsByGroup.set(r.groupId, [r.slug]);
  }
  const memberRows = await dbClient
    .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
    .from(groupMembers);
  const membersByGroup = new Map<string, string[]>();
  for (const r of memberRows) {
    const list = membersByGroup.get(r.groupId);
    if (list) list.push(r.userId);
    else membersByGroup.set(r.groupId, [r.userId]);
  }
  const challengeCountRows = await dbClient
    .select({
      groupId: approvalChallenges.groupId,
      challengeCount: sql<number>`count(*)::int`,
    })
    .from(approvalChallenges)
    .where(sql`${approvalChallenges.groupId} IS NOT NULL`)
    .groupBy(approvalChallenges.groupId);
  const challengeCountByGroup = new Map<string, number>();
  for (const r of challengeCountRows) {
    if (r.groupId) challengeCountByGroup.set(r.groupId, r.challengeCount);
  }

  const moderationScopeRows = await dbClient.select().from(groupModerationScopes);
  const roleBySlug = new Map(rolesState.map((r) => [r.slug, r]));
  const groupsState: EngineGroupRow[] = groupRows.map((g) => {
    const roleSlugs = dedupe(roleSlugsByGroup.get(g.id) ?? []);
    const bundle = bundleOfRoleSlugs({ roles: rolesState, groups: [], knownCapabilities }, roleSlugs);
    const members = dedupe(membersByGroup.get(g.id) ?? []).sort();
    return {
      id: g.id,
      type: g.type,
      label: g.label,
      isSystem: g.isSystem,
      ownerId: g.ownerId,
      roleSlugs,
      capabilities: bundle,
      members,
      memberCount: members.length,
      approvalChallengeCount: challengeCountByGroup.get(g.id) ?? 0,
      moderationRoomIds: moderationScopeRows.filter(scope => scope.groupId === g.id).map(scope => scope.roomId).sort(),
    };
  });
  void roleBySlug;
  return { roles: rolesState, groups: groupsState, knownCapabilities };
}

async function loadApplyFactsFrom(
  tx: MutationTx,
  input: {
    readonly actorUserId: string;
    readonly requiredManagementCapabilities: readonly CapabilitySlug[];
    readonly targetUserIds: readonly string[] | null;
    readonly moderationRoomIds?: readonly string[];
  },
): Promise<ApplyFacts> {
  const capabilityRows = await tx
    .select({ slug: capabilities.slug })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .innerJoin(roleCapabilities, eq(roles.id, roleCapabilities.roleId))
    .innerJoin(capabilities, eq(roleCapabilities.capabilityId, capabilities.id))
    .where(eq(groupMembers.userId, input.actorUserId));
  const actorCapabilities = dedupe(capabilityRows.map((row) => row.slug));

  // Every target user (owner + members for the composite; single target
  // otherwise) is existence-checked + locked inside this transaction so a
  // mid-flight FK violation cannot surprise the writes. An empty/null list
  // means the operation has no target user (true).
  let targetUserExists = true;
  if (input.targetUserIds !== null && input.targetUserIds.length > 0) {
    const uniqueIds = dedupe(input.targetUserIds);
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, uniqueIds))
      .for("update");
    targetUserExists = rows.length === uniqueIds.length;
  }

  const roomIds = dedupe(input.moderationRoomIds ?? []);
  const scopeRooms = roomIds.length === 0 ? [] : await tx.select({ id: rooms.id }).from(rooms)
    .where(and(inArray(rooms.id, roomIds), ne(rooms.kind, "access"), isNull(rooms.archivedAt)))
    .orderBy(rooms.id).for("update");
  const moderationRoomsExist = scopeRooms.length === roomIds.length;

  const actorHeldManagementCaps = input.requiredManagementCapabilities.filter((c) =>
    actorCapabilities.includes(c),
  );
  return {
    actorCapabilities,
    actorHeldManagementCaps,
    actorHoldsManagement: actorHeldManagementCaps.length === input.requiredManagementCapabilities.length,
    targetUserExists,
    moderationRoomsExist,
  };
}

export interface ProductionMutationEngineDepsOptions {
  /** Writes the redacted RBAC audit event; must throw on failure. */
  readonly appendAuditEvent: (payload: RbacAuditEventInput) => void;
  /** Actor's actorId (for `group_members.granted_by` + audit `actorId`). */
  readonly actorActorId: string | null;
}

/**
 * Production {@link MutationEngineDeps} over the shared direct-Postgres
 * pool. Preview reads state and actor facts through ordinary shared-pool
 * reads. Apply starts a SERIALIZABLE transaction, locks every RBAC table and
 * edge represented by the full-state fingerprint, then re-reads state AND
 * actor facts exclusively through that transaction before it evaluates and
 * writes. A concurrent phantom/edge change causes PostgreSQL serialization
 * failure, which `runApply` turns into `stale_preview`. The audit writer is
 * injected by the route so it can attach the request envelope
 * (ts/ip/userAgent).
 */
export function createProductionMutationEngineDeps(
  opts: ProductionMutationEngineDepsOptions,
): MutationEngineDeps {
  const { appendAuditEvent, actorActorId } = opts;
  return {
    getActorCapabilities: (userId) => getUserCapabilities(userId),
    userHasCapability: (userId, slug) => userHasCapability(userId, slug),
    userExists: async (userId) => {
      const db = getSharedDirectDb();
      const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
      return !!row;
    },
    moderationRoomsExist: async (ids) => {
      const roomIds = dedupe(ids);
      if (roomIds.length === 0) return true;
      const rows = await getSharedDirectDb().select({ id: rooms.id }).from(rooms)
        .where(and(inArray(rooms.id, roomIds), ne(rooms.kind, "access"), isNull(rooms.archivedAt)));
      return rows.length === roomIds.length;
    },
    loadState: async () => loadStateFrom(getSharedDirectDb()),
    loadApplyFacts: (tx, input) => loadApplyFactsFrom(tx, input),
    applyInTx: async <T>(fn: (tx: MutationTx, state: EngineState) => Promise<T>): Promise<T> => {
      const db = getSharedDirectDb();
      return db.transaction(async (tx) => {
        // This MUST be the first command after BEGIN. SERIALIZABLE closes
        // phantom-insert races that row locks alone cannot prevent; the
        // deterministic full-catalogue lock order serializes engine writers.
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        await lockFingerprintState(tx);
        const state = await loadStateFrom(tx);
        return fn(tx, state);
      });
    },
    execute: async (tx, op, state) => executeOperationWrites(tx, op, state, actorActorId),
    appendAuditEvent,
  };
}

async function resolveCapabilityIds(
  tx: MutationTx,
  slugs: readonly string[],
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const rows = await tx
    .select({ id: capabilities.id, slug: capabilities.slug })
    .from(capabilities)
    .where(inArray(capabilities.slug, [...slugs]));
  return new Map(rows.map((r) => [r.slug, r.id]));
}

async function resolveRoleIdsBySlug(
  tx: MutationTx,
  slugs: readonly string[],
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const rows = await tx
    .select({ id: roles.id, slug: roles.slug })
    .from(roles)
    .where(inArray(roles.slug, [...slugs]));
  return new Map(rows.map((r) => [r.slug, r.id]));
}

async function executeOperationWrites(
  tx: MutationTx,
  op: AccessControlOperation,
  state: EngineState,
  actorActorId: string | null,
): Promise<WriteOutcome> {
  switch (op.kind) {
    case "role.create": {
      const [role] = await tx
        .insert(roles)
        .values({ slug: op.slug, label: op.label, isSystem: false })
        .returning({ id: roles.id });
      if (!role) throw new Error("role.create: insert failed");
      const capIds = await resolveCapabilityIds(tx, op.capabilities);
      if (op.capabilities.length > 0) {
        await tx
          .insert(roleCapabilities)
          .values(
            dedupe(op.capabilities).map((slug) => ({
              roleId: role.id,
              capabilityId: capIds.get(slug)!,
            })),
          )
          .onConflictDoNothing();
      }
      return { roleId: role.id };
    }
    case "role.rename": {
      await tx.update(roles).set({ label: op.label }).where(eq(roles.id, op.roleId));
      break;
    }
    case "role.set_capabilities": {
      await tx.delete(roleCapabilities).where(eq(roleCapabilities.roleId, op.roleId));
      const capIds = await resolveCapabilityIds(tx, op.capabilities);
      if (op.capabilities.length > 0) {
        await tx
          .insert(roleCapabilities)
          .values(
            dedupe(op.capabilities).map((slug) => ({
              roleId: op.roleId,
              capabilityId: capIds.get(slug)!,
            })),
          )
          .onConflictDoNothing();
      }
      break;
    }
    case "role.delete": {
      // role_capabilities + group_roles cascade on DELETE.
      await tx.delete(roles).where(eq(roles.id, op.roleId));
      break;
    }
    case "group.create": {
      const [group] = await tx
        .insert(groups)
        .values({
          type: op.groupType,
          label: op.label,
          isSystem: false,
          ownerId: op.ownerUserId,
        })
        .returning({ id: groups.id });
      if (!group) throw new Error("group.create: insert failed");
      const roleIds = await resolveRoleIdsBySlug(tx, op.roleSlugs);
      if (op.roleSlugs.length > 0) {
        await tx
          .insert(groupRoles)
          .values(
            dedupe(op.roleSlugs).map((slug) => ({
              groupId: group.id,
              roleId: roleIds.get(slug)!,
            })),
          )
          .onConflictDoNothing();
      }
      return { groupId: group.id };
    }
    case "group.rename": {
      await tx.update(groups).set({ label: op.label }).where(eq(groups.id, op.groupId));
      break;
    }
    case "group.set_moderation_scopes": {
      await tx.delete(groupModerationScopes).where(eq(groupModerationScopes.groupId, op.groupId));
      const roomIds = dedupe(op.roomIds);
      if (roomIds.length) await tx.insert(groupModerationScopes).values(roomIds.map(roomId => ({ groupId: op.groupId, roomId })));
      break;
    }
    case "group.set_roles": {
      await tx.delete(groupRoles).where(eq(groupRoles.groupId, op.groupId));
      const roleIds = await resolveRoleIdsBySlug(tx, op.roleSlugs);
      if (op.roleSlugs.length > 0) {
        await tx
          .insert(groupRoles)
          .values(
            dedupe(op.roleSlugs).map((slug) => ({
              groupId: op.groupId,
              roleId: roleIds.get(slug)!,
            })),
          )
          .onConflictDoNothing();
      }
      break;
    }
    case "group.transfer_owner": {
      await tx.update(groups).set({ ownerId: op.newOwnerUserId }).where(eq(groups.id, op.groupId));
      break;
    }
    case "group.delete": {
      // approval_challenges.group_id has NO ON DELETE action — remove them
      // explicitly before the Group row so no FK violation surprises the
      // caller. group_roles + group_members cascade on DELETE.
      await tx.delete(approvalChallenges).where(eq(approvalChallenges.groupId, op.groupId));
      await tx.delete(groups).where(eq(groups.id, op.groupId));
      break;
    }
    case "membership.add": {
      await tx
        .insert(groupMembers)
        .values({
          groupId: op.groupId,
          userId: op.userId,
          grantedBy: actorActorId,
        })
        .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });
      break;
    }
    case "membership.remove": {
      const group = state.groups.find((g) => g.id === op.groupId);
      // Stack 195 follow-up — Owner invariant: a successful mutation may
      // NEVER leave zero Owners, even when `bypassLastOwner=true`. The
      // compatibility parameter is kept on the operation shape so legacy
      // callers still typecheck, but the sole-Owner rail is no longer
      // bypassable: removing the only remaining Owner is rejected
      // distinctly with `MembershipOpError("last_owner")` regardless of the
      // bypass flag. A multi-Owner removal proceeds normally (the bypass
      // flag is irrelevant there).
      if (group?.type === "owners") {
        const locked = await tx
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, op.groupId))
          .for("update");
        if (locked.length === 1 && locked[0]!.userId === op.userId) {
          throw new MembershipOpError("last_owner");
        }
      }
      await tx
        .delete(groupMembers)
        .where(and(eq(groupMembers.groupId, op.groupId), eq(groupMembers.userId, op.userId)));
      break;
    }
    case "shared_access.create": {
      // Atomic composite: Permission set (Role) + Group + Group→Role edge +
      // initial memberships in ONE transaction. If any write fails the whole
      // tx rolls back — no partial Role/Group/membership survives. No
      // direct-user capability edges are created (authority rides the
      // Group→Role→Capability graph).
      const [role] = await tx
        .insert(roles)
        .values({ slug: op.role.slug, label: op.role.label, isSystem: false })
        .returning({ id: roles.id });
      if (!role) throw new Error("shared_access.create: role insert failed");
      const capIds = await resolveCapabilityIds(tx, op.role.capabilities);
      const roleCaps = dedupe(op.role.capabilities);
      if (roleCaps.length > 0) {
        await tx
          .insert(roleCapabilities)
          .values(
            roleCaps.map((slug) => ({ roleId: role.id, capabilityId: capIds.get(slug)! })),
          )
          .onConflictDoNothing();
      }
      const [group] = await tx
        .insert(groups)
        .values({
          type: op.group.groupType,
          label: op.group.label,
          isSystem: false,
          ownerId: op.group.ownerUserId,
        })
        .returning({ id: groups.id });
      if (!group) throw new Error("shared_access.create: group insert failed");
      await tx
        .insert(groupRoles)
        .values({ groupId: group.id, roleId: role.id })
        .onConflictDoNothing();
      const memberUserIds = dedupe(op.memberUserIds);
      if (memberUserIds.length > 0) {
        await tx
          .insert(groupMembers)
          .values(
            memberUserIds.map((userId) => ({
              groupId: group.id,
              userId,
              grantedBy: actorActorId,
            })),
          )
          .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });
      }
      return { roleId: role.id, groupId: group.id };
    }
    case "shared_access.assign_existing": {
      // Atomic composite: new Group + Group→EXISTING-Role edge + initial
      // memberships in ONE transaction. The Role row is never mutated (no
      // manage_roles requirement); if any write fails the whole tx rolls
      // back — no partial Group/edge/membership survives. No direct-user
      // capability edges are created (authority rides the
      // Group→Role→Capability graph).
      const roleIds = await resolveRoleIdsBySlug(tx, [op.roleSlug]);
      const roleId = roleIds.get(op.roleSlug);
      if (!roleId) {
        throw new Error("shared_access.assign_existing: existing role not found");
      }
      const [group] = await tx
        .insert(groups)
        .values({
          type: op.group.groupType,
          label: op.group.label,
          isSystem: false,
          ownerId: op.group.ownerUserId,
        })
        .returning({ id: groups.id });
      if (!group) throw new Error("shared_access.assign_existing: group insert failed");
      await tx
        .insert(groupRoles)
        .values({ groupId: group.id, roleId })
        .onConflictDoNothing();
      const memberUserIds = dedupe(op.memberUserIds);
      if (memberUserIds.length > 0) {
        await tx
          .insert(groupMembers)
          .values(
            memberUserIds.map((userId) => ({
              groupId: group.id,
              userId,
              grantedBy: actorActorId,
            })),
          )
          .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });
      }
      return { roleId, groupId: group.id };
    }
  }
  return {};
}
