/**
 * M213 Phase 1–2 — canonical principal and RBAC read-model types plus pure
 * folding helpers. DB query entry points live in `queries.ts`.
 */

/** Workbench channel id used by PersonalPolicyResolver / resolve-bearer. */
export const M213_WORKBENCH_CHANNEL = "workbench" as const;

export type WorkbenchChannelBinding = Readonly<{
  /** Always identical to the principal's non-empty `federatedId`. */
  externalId: string;
  verifiedAt: Date | null;
  isVerified: boolean;
}>;

export type PersonalAgentSnapshot = Readonly<{
  agentId: string;
  handle: string;
  displayName: string;
}>;

export type CanonicalPrincipal = Readonly<{
  logtoSub: string;
  userId: string;
  disabledAt: Date | null;
  actorId: string;
  actorDisplayName: string;
  handle: string | null;
  displayName: string;
  server: string | null;
  /** Empty when `handle` is absent — same contract as `getFederatedIdForActor`. */
  federatedId: string;
  /**
   * The `workbench` binding for exactly this principal's `federatedId`.
   * Null when the canonical federated ID is absent or that exact identity
   * has no binding; a different/stale workbench identity never qualifies.
   */
  workbenchChannelBinding: WorkbenchChannelBinding | null;
  /** First personal agent by `agents.created_at ASC`, or explicit null. */
  personalAgent: PersonalAgentSnapshot | null;
}>;

export type RbacGroupChip = Readonly<{
  id: string;
  type: string;
  label: string;
  roleSlug: string;
}>;

export type RbacProjection = Readonly<{
  highestRole: string | null;
  capabilitySlugs: readonly string[];
  groupChips: readonly RbacGroupChip[];
}>;

export type RbacMembershipFoldRow = Readonly<{
  groupId: string;
  groupType: string;
  groupLabel: string;
  roleSlug: string;
  capabilitySlug: string | null;
}>;

export type RoleRankMap = Readonly<Record<string, number>>;

const UNKNOWN_ROLE_RANK = Number.MAX_SAFE_INTEGER;

export type WorkbenchChannelBindingCandidate = Readonly<{
  externalId: string | null;
  verifiedAt: Date | null;
}>;

/**
 * Retain a workbench binding only when it is for the canonical federated ID.
 * This defense-in-depth fold preserves the query's exact-identity invariant.
 */
export function bindingForCanonicalFederatedId(
  federatedId: string,
  candidate: WorkbenchChannelBindingCandidate,
): WorkbenchChannelBinding | null {
  if (!federatedId || candidate.externalId !== federatedId) {
    return null;
  }
  return deepFreeze({
    externalId: candidate.externalId,
    verifiedAt: candidate.verifiedAt,
    isVerified: candidate.verifiedAt !== null,
  });
}

function roleRank(slug: string, rankMap: RoleRankMap): number {
  return rankMap[slug] ?? UNKNOWN_ROLE_RANK;
}

/** Recursively freeze plain objects and arrays for caller-safe immutability. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Highest-rank (lowest numeric rank) server Role slug across the supplied
 * slugs. Unknown slugs are skipped. Returns `null` when no ranked slug exists.
 */
export function pickHighestRoleSlug(
  roleSlugs: readonly string[],
  rankMap: RoleRankMap,
): string | null {
  let best: string | null = null;
  let bestRank = UNKNOWN_ROLE_RANK;
  for (const slug of roleSlugs) {
    const rank = roleRank(slug, rankMap);
    if (rank === UNKNOWN_ROLE_RANK) continue;
    if (best === null || rank < bestRank) {
      best = slug;
      bestRank = rank;
    }
  }
  return best;
}

/** De-dupe capability slugs preserving first-seen order (server enforcement set). */
export function dedupeCapabilitySlugs(slugs: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of slugs) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return deepFreeze(out);
}

/**
 * Collapse many-to-many Group→Role rows to one chip per Group at the
 * Group's highest-rank Role (matches `/api/auth/whoami` folding).
 */
export function foldGroupChipsFromMembershipRows(
  rows: readonly RbacMembershipFoldRow[],
  rankMap: RoleRankMap,
): readonly RbacGroupChip[] {
  const byGroup = new Map<string, RbacGroupChip>();
  for (const row of rows) {
    const candidate: RbacGroupChip = {
      id: row.groupId,
      type: row.groupType,
      label: row.groupLabel,
      roleSlug: row.roleSlug,
    };
    const existing = byGroup.get(row.groupId);
    if (!existing) {
      byGroup.set(row.groupId, candidate);
      continue;
    }
    if (roleRank(row.roleSlug, rankMap) < roleRank(existing.roleSlug, rankMap)) {
      byGroup.set(row.groupId, candidate);
    }
  }
  return deepFreeze([...byGroup.values()]);
}

/** Fold one RBAC membership/capability query result into an immutable projection. */
export function foldRbacProjection(
  rows: readonly RbacMembershipFoldRow[],
  rankMap: RoleRankMap,
): RbacProjection {
  const roleSlugs = rows.map((r) => r.roleSlug);
  const capabilitySlugs = dedupeCapabilitySlugs(
    rows
      .map((r) => r.capabilitySlug)
      .filter((slug): slug is string => typeof slug === "string" && slug.length > 0),
  );
  const projection: RbacProjection = {
    highestRole: pickHighestRoleSlug(roleSlugs, rankMap),
    capabilitySlugs,
    groupChips: foldGroupChipsFromMembershipRows(rows, rankMap),
  };
  return deepFreeze(projection);
}

export function freezeCanonicalPrincipal(principal: CanonicalPrincipal): CanonicalPrincipal {
  return deepFreeze(principal);
}
