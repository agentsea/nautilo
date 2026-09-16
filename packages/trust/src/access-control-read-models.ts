/**
 * Stack 195 / W3.1 — read-only effective-access + provenance read models.
 *
 * Full-fidelity provenance: preserves every Group -> Role -> Capability path
 * (including multiple Roles on one Group and multiple Groups). M213's
 * `groupChips` projection collapses each Group to one Role and is NOT reused
 * here as detailed provenance.
 *
 * The highest canonical ladder Role is returned separately; custom Roles are
 * orthogonal and never influence that rank.
 *
 * See `wave-3-stack-195-tasks.md` W3.1.1 / W3.1.7 and
 * `general-rbac-administration-followup.md` §2.1 / §3.
 */
import {
  capabilities,
  eq,
  getSharedDirectDb,
  groupMembers,
  groupRoles,
  groups,
  roles,
  roleCapabilities,
  sql,
} from "@nautilo/db";
import { CAPABILITY_SLUGS } from "./capabilities";
import { findUserById } from "./queries";
import { SERVER_ROLE_RANK, SERVER_ROLE_TO_GROUP_TYPE } from "./queries";

// ---------------------------------------------------------------------------
// Browser-safe DTO shapes (no Date / no class instances). These are the
// canonical server response types; the api-client Zod schemas mirror them.
// ---------------------------------------------------------------------------

export interface AccessControlProvenancePath {
  readonly groupId: string;
  readonly groupType: string;
  readonly groupLabel: string;
  readonly groupIsSystem: boolean;
  readonly groupOwnerId: string | null;
  readonly roleSlug: string;
  readonly roleLabel: string;
  readonly roleIsSystem: boolean;
}

export interface AccessControlCapabilityRow {
  readonly slug: string;
  readonly description: string;
  readonly category: string;
  readonly granted: boolean;
  readonly provenance: readonly AccessControlProvenancePath[];
}

export interface AccessControlGroupSummary {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly isSystem: boolean;
  readonly ownerId: string | null;
  readonly roleSlugs: readonly string[];
}

export interface AccessControlRoleSummary {
  readonly slug: string;
  readonly label: string;
  readonly isSystem: boolean;
  readonly capabilitySlugs: readonly string[];
}

export interface AccessControlUserIdentity {
  readonly id: string;
  readonly handle: string | null;
  readonly displayName: string;
  readonly server: string | null;
}

export interface EffectiveAccessResponse {
  readonly user: AccessControlUserIdentity;
  /** Highest canonical ladder Role slug (owner/admin/superuser/member/contributor/guest). Null when the user holds no canonical ladder Role. Custom Roles never influence this. */
  readonly highestRole: string | null;
  /** Full capability catalogue in stable order; each row granted/not-granted with all provenance paths for granted rows. */
  readonly capabilities: readonly AccessControlCapabilityRow[];
  /** Every Group the user belongs to (multiple Roles on one Group preserved). */
  readonly groups: readonly AccessControlGroupSummary[];
  /** Deduped Roles the user effectively holds (custom Roles appear here too). */
  readonly roles: readonly AccessControlRoleSummary[];
  /** Every (Group, Role) pair the user holds, with the Role's bundle — the group-role facts. */
  readonly groupRoleFacts: readonly AccessControlGroupRoleFact[];
}

export interface AccessControlGroupRoleFact {
  readonly groupId: string;
  readonly groupType: string;
  readonly groupLabel: string;
  readonly groupIsSystem: boolean;
  readonly groupOwnerId: string | null;
  readonly roleSlug: string;
  readonly roleLabel: string;
  readonly roleIsSystem: boolean;
  readonly capabilitySlugs: readonly string[];
}

export interface CatalogueCapability {
  readonly slug: string;
  readonly description: string;
  readonly category: string;
}

export interface CatalogueRoleSummary {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly isSystem: boolean;
  readonly capabilitySlugs: readonly string[];
  readonly groupCount: number;
}

export interface CatalogueGroupSummary {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly isSystem: boolean;
  readonly ownerId: string | null;
  readonly roleSlugs: readonly string[];
  readonly memberCount: number;
}

export interface AccessControlCatalogue {
  readonly capabilities: readonly CatalogueCapability[];
  readonly roles: readonly CatalogueRoleSummary[];
  readonly groups: readonly CatalogueGroupSummary[];
}

// ---------------------------------------------------------------------------
// Raw DB row shapes consumed by the pure folding helpers.
// ---------------------------------------------------------------------------

export interface EffectiveAccessPathRow {
  readonly groupId: string;
  readonly groupType: string;
  readonly groupLabel: string;
  readonly groupIsSystem: boolean;
  readonly groupOwnerId: string | null;
  readonly roleSlug: string;
  readonly roleLabel: string;
  readonly roleIsSystem: boolean;
  readonly capabilitySlug: string | null;
}

export interface CatalogueCapabilityRow {
  readonly slug: string;
  readonly description: string;
  readonly category: string;
}

// ---------------------------------------------------------------------------
// Pure folding helpers (no I/O — unit-testable without a database).
// ---------------------------------------------------------------------------

const CANONICAL_GROUP_ORDER: readonly string[] = Object.values(
  SERVER_ROLE_TO_GROUP_TYPE,
);

/**
 * Stable ordering key for a capability slug: its index in the canonical
 * `CAPABILITY_SLUGS` list, or `Number.MAX_SAFE_INTEGER`-ish for unknown
 * future slugs (sorted after known ones, then alphabetically). This makes
 * the catalogue order stable for known caps while tolerating slugs a
 * newer server may add without the client knowing them.
 */
function capabilityOrderIndex(
  slug: string,
  canonicalOrder: readonly string[],
): number {
  const idx = canonicalOrder.indexOf(slug);
  if (idx >= 0) return idx;
  // Unknown slug: sort after all known, alphabetical among unknowns.
  return canonicalOrder.length + slug.charCodeAt(0);
}

function sortCapabilitiesStable(
  rows: readonly { slug: string; description: string; category: string }[],
  canonicalOrder: readonly string[],
): { slug: string; description: string; category: string }[] {
  return [...rows].sort((a, b) => {
    const ai = capabilityOrderIndex(a.slug, canonicalOrder);
    const bi = capabilityOrderIndex(b.slug, canonicalOrder);
    if (ai !== bi) return ai - bi;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

function sortRolesStable<T extends { slug: string; isSystem: boolean }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const ai = a.isSystem ? SERVER_ROLE_RANK[a.slug as keyof typeof SERVER_ROLE_RANK] : undefined;
    const bi = b.isSystem ? SERVER_ROLE_RANK[b.slug as keyof typeof SERVER_ROLE_RANK] : undefined;
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

function sortGroupsStable<T extends { type: string; isSystem: boolean }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const ai = a.isSystem ? CANONICAL_GROUP_ORDER.indexOf(a.type) : -1;
    const bi = b.isSystem ? CANONICAL_GROUP_ORDER.indexOf(b.type) : -1;
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });
}

/**
 * Compute the highest canonical ladder Role slug across the user's Roles.
 * Custom (non-ladder) slugs are skipped. Returns `null` when the user
 * holds no canonical ladder Role.
 */
export function computeHighestCanonicalRole(
  roleSlugs: readonly string[],
): string | null {
  let best: string | null = null;
  let bestRank = Number.MAX_SAFE_INTEGER;
  for (const slug of roleSlugs) {
    const rank = SERVER_ROLE_RANK[slug as keyof typeof SERVER_ROLE_RANK];
    if (rank === undefined) continue;
    if (best === null || rank < bestRank) {
      best = slug;
      bestRank = rank;
    }
  }
  return best;
}

/** Dedupe string list preserving first-seen order. */
function dedupePreservingOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Fold raw provenance path rows + the capability catalogue (in stable
 * order) into the full effective-access response. Pure: no I/O.
 *
 * Preserves every Group -> Role -> Capability path. Each catalogue
 * capability is marked granted/not-granted; granted rows carry every
 * provenance path that resolves them.
 */
export function buildEffectiveAccess(
  user: AccessControlUserIdentity,
  pathRows: readonly EffectiveAccessPathRow[],
  catalogue: readonly CatalogueCapabilityRow[],
): EffectiveAccessResponse {
  // Group path rows by (group, role); collect capability slugs per (group, role).
  const groupRoleKeys: { groupId: string; roleSlug: string }[] = [];
  const bundleByGroupRole = new Map<string, string[]>();
  const groupMeta = new Map<
    string,
    {
      groupType: string;
      groupLabel: string;
      groupIsSystem: boolean;
      groupOwnerId: string | null;
      roleSlugs: string[];
    }
  >();
  const roleMeta = new Map<
    string,
    { roleLabel: string; roleIsSystem: boolean; capabilitySlugs: Set<string> }
  >();
  const allRoleSlugs: string[] = [];

  for (const row of pathRows) {
    const gk = `${row.groupId}\0${row.roleSlug}`;
    if (!bundleByGroupRole.has(gk)) {
      bundleByGroupRole.set(gk, []);
      groupRoleKeys.push({ groupId: row.groupId, roleSlug: row.roleSlug });
    }
    if (row.capabilitySlug) {
      bundleByGroupRole.get(gk)!.push(row.capabilitySlug);
    }

    let g = groupMeta.get(row.groupId);
    if (!g) {
      g = {
        groupType: row.groupType,
        groupLabel: row.groupLabel,
        groupIsSystem: row.groupIsSystem,
        groupOwnerId: row.groupOwnerId,
        roleSlugs: [],
      };
      groupMeta.set(row.groupId, g);
    }
    if (!g.roleSlugs.includes(row.roleSlug)) g.roleSlugs.push(row.roleSlug);

    let r = roleMeta.get(row.roleSlug);
    if (!r) {
      r = { roleLabel: row.roleLabel, roleIsSystem: row.roleIsSystem, capabilitySlugs: new Set() };
      roleMeta.set(row.roleSlug, r);
      allRoleSlugs.push(row.roleSlug);
    }
    if (row.capabilitySlug) r.capabilitySlugs.add(row.capabilitySlug);
  }

  // Capabilities: full catalogue in stable order, granted/not-granted.
  const grantedPathsByCap = new Map<string, AccessControlProvenancePath[]>();
  for (const row of pathRows) {
    if (!row.capabilitySlug) continue;
    const path: AccessControlProvenancePath = {
      groupId: row.groupId,
      groupType: row.groupType,
      groupLabel: row.groupLabel,
      groupIsSystem: row.groupIsSystem,
      groupOwnerId: row.groupOwnerId,
      roleSlug: row.roleSlug,
      roleLabel: row.roleLabel,
      roleIsSystem: row.roleIsSystem,
    };
    const list = grantedPathsByCap.get(row.capabilitySlug);
    if (list) {
      list.push(path);
    } else {
      grantedPathsByCap.set(row.capabilitySlug, [path]);
    }
  }

  const orderedCatalogue = sortCapabilitiesStable(catalogue, CAPABILITY_SLUGS);
  const capabilities: AccessControlCapabilityRow[] = orderedCatalogue.map((c) => {
    const paths = grantedPathsByCap.get(c.slug) ?? [];
    return {
      slug: c.slug,
      description: c.description,
      category: c.category,
      granted: paths.length > 0,
      provenance: paths,
    };
  });

  // Groups (multiple Roles on one Group preserved).
  const groups: AccessControlGroupSummary[] = sortGroupsStable(
    [...groupMeta.entries()].map(([id, g]) => ({
      id,
      type: g.groupType,
      label: g.groupLabel,
      isSystem: g.groupIsSystem,
      ownerId: g.groupOwnerId,
      roleSlugs: dedupePreservingOrder(g.roleSlugs),
    })),
  );

  // Roles (deduped; custom Roles appear here too).
  const roles: AccessControlRoleSummary[] = sortRolesStable(
    allRoleSlugs.map((slug) => {
      const r = roleMeta.get(slug)!;
      return {
        slug,
        label: r.roleLabel,
        isSystem: r.roleIsSystem,
        capabilitySlugs: dedupePreservingOrder([...r.capabilitySlugs]),
      };
    }),
  );

  // Group-role facts: every (group, role) pair with the role's bundle.
  const groupRoleFacts: AccessControlGroupRoleFact[] = groupRoleKeys.map(
    ({ groupId, roleSlug }) => {
      const g = groupMeta.get(groupId)!;
      const r = roleMeta.get(roleSlug)!;
      return {
        groupId,
        groupType: g.groupType,
        groupLabel: g.groupLabel,
        groupIsSystem: g.groupIsSystem,
        groupOwnerId: g.groupOwnerId,
        roleSlug,
        roleLabel: r.roleLabel,
        roleIsSystem: r.roleIsSystem,
        capabilitySlugs: dedupePreservingOrder(
          bundleByGroupRole.get(`${groupId}\0${roleSlug}`) ?? [],
        ),
      };
    },
  );

  return {
    user,
    highestRole: computeHighestCanonicalRole(allRoleSlugs),
    capabilities,
    groups,
    roles,
    groupRoleFacts,
  };
}

// ---------------------------------------------------------------------------
// DB query functions (server truth — never hardcoded client lists).
// ---------------------------------------------------------------------------

/**
 * Every Group -> Role -> Capability path for a user. One row per
 * (group, role, capability); a Group with multiple Roles produces
 * multiple rows, and a Role with no capabilities produces one row with
 * `capabilitySlug: null`. Preserves full fidelity (does NOT collapse to
 * one Role per Group the way M213 `groupChips` does).
 */
export async function fetchEffectiveAccessPathRows(
  userId: string,
): Promise<EffectiveAccessPathRow[]> {
  if (!userId) return [];
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      groupId: groups.id,
      groupType: groups.type,
      groupLabel: groups.label,
      groupIsSystem: groups.isSystem,
      groupOwnerId: groups.ownerId,
      roleSlug: roles.slug,
      roleLabel: roles.label,
      roleIsSystem: roles.isSystem,
      capabilitySlug: capabilities.slug,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(groupRoles.roleId, roles.id))
    .leftJoin(roleCapabilities, eq(roles.id, roleCapabilities.roleId))
    .leftJoin(
      capabilities,
      eq(roleCapabilities.capabilityId, capabilities.id),
    )
    .where(eq(groupMembers.userId, userId));
  return rows.map((r) => ({
    groupId: r.groupId,
    groupType: r.groupType,
    groupLabel: r.groupLabel,
    groupIsSystem: r.groupIsSystem,
    groupOwnerId: r.groupOwnerId,
    roleSlug: r.roleSlug,
    roleLabel: r.roleLabel,
    roleIsSystem: r.roleIsSystem,
    capabilitySlug: r.capabilitySlug ?? null,
  }));
}

/** Every capability row in the catalogue (slug/description/category). */
export async function fetchCatalogueCapabilities(): Promise<
  CatalogueCapabilityRow[]
> {
  const db = getSharedDirectDb();
  const rows = await db
    .select({
      slug: capabilities.slug,
      description: capabilities.description,
      category: capabilities.category,
    })
    .from(capabilities);
  return rows.map((r) => ({
    slug: r.slug,
    description: r.description,
    category: r.category,
  }));
}

/**
 * Resolve the full effective-access response for a user, or `null` when
 * the user does not exist. The capability catalogue is read from the DB
 * (server truth) and folded with the user's provenance paths in stable
 * catalogue order.
 */
export async function getEffectiveAccessForUser(
  userId: string,
): Promise<EffectiveAccessResponse | null> {
  if (!userId) return null;
  const userRow = await findUserById(userId);
  if (!userRow) return null;
  const [pathRows, catalogue] = await Promise.all([
    fetchEffectiveAccessPathRows(userId),
    fetchCatalogueCapabilities(),
  ]);
  return buildEffectiveAccess(
    {
      id: userRow.id,
      handle: userRow.handle,
      displayName: userRow.name,
      server: userRow.server,
    },
    pathRows,
    catalogue,
  );
}

/**
 * The full access-control catalogue: canonical capabilities (stable
 * order), system + custom Role summaries (with bundles + group counts),
 * and system + custom Group summaries (with role attachments, member
 * counts, system discriminator, and Group ownerId). Server truth.
 */
export async function getAccessControlCatalogue(): Promise<AccessControlCatalogue> {
  const db = getSharedDirectDb();

  const capRows = await fetchCatalogueCapabilities();
  const capabilitiesOut = sortCapabilitiesStable(capRows, CAPABILITY_SLUGS).map(
    (c) => ({ slug: c.slug, description: c.description, category: c.category }),
  );

  // Roles + their bundles (capability slugs).
  const roleRows = await db
    .select({
      id: roles.id,
      slug: roles.slug,
      label: roles.label,
      isSystem: roles.isSystem,
    })
    .from(roles);
  const roleCapRows = await db
    .select({
      roleId: roleCapabilities.roleId,
      slug: capabilities.slug,
    })
    .from(roleCapabilities)
    .innerJoin(
      capabilities,
      eq(roleCapabilities.capabilityId, capabilities.id),
    );
  const bundleByRole = new Map<string, string[]>();
  for (const r of roleCapRows) {
    const list = bundleByRole.get(r.roleId);
    if (list) list.push(r.slug);
    else bundleByRole.set(r.roleId, [r.slug]);
  }
  // groupCount per role.
  const roleGroupCountRows = await db
    .select({
      roleId: groupRoles.roleId,
      groupCount: sql<number>`count(*)::int`,
    })
    .from(groupRoles)
    .groupBy(groupRoles.roleId);
  const groupCountByRole = new Map<string, number>();
  for (const r of roleGroupCountRows) {
    groupCountByRole.set(r.roleId, r.groupCount);
  }
  const rolesOut: CatalogueRoleSummary[] = sortRolesStable(
    roleRows.map((r) => ({
      id: r.id,
      slug: r.slug,
      label: r.label,
      isSystem: r.isSystem,
      capabilitySlugs: dedupePreservingOrder(bundleByRole.get(r.id) ?? []),
      groupCount: groupCountByRole.get(r.id) ?? 0,
    })),
  );

  // Groups + role attachments + member counts.
  const groupRows = await db
    .select({
      id: groups.id,
      type: groups.type,
      label: groups.label,
      isSystem: groups.isSystem,
      ownerId: groups.ownerId,
    })
    .from(groups);
  const groupRoleRows = await db
    .select({
      groupId: groupRoles.groupId,
      slug: roles.slug,
    })
    .from(groupRoles)
    .innerJoin(roles, eq(groupRoles.roleId, roles.id));
  const rolesByGroup = new Map<string, string[]>();
  for (const r of groupRoleRows) {
    const list = rolesByGroup.get(r.groupId);
    if (list) list.push(r.slug);
    else rolesByGroup.set(r.groupId, [r.slug]);
  }
  const memberCountRows = await db
    .select({
      groupId: groupMembers.groupId,
      memberCount: sql<number>`count(*)::int`,
    })
    .from(groupMembers)
    .groupBy(groupMembers.groupId);
  const memberCountByGroup = new Map<string, number>();
  for (const r of memberCountRows) {
    memberCountByGroup.set(r.groupId, r.memberCount);
  }
  const groupsOut: CatalogueGroupSummary[] = sortGroupsStable(
    groupRows.map((g) => ({
      id: g.id,
      type: g.type,
      label: g.label,
      isSystem: g.isSystem,
      ownerId: g.ownerId,
      roleSlugs: dedupePreservingOrder(rolesByGroup.get(g.id) ?? []),
      memberCount: memberCountByGroup.get(g.id) ?? 0,
    })),
  );

  return {
    capabilities: capabilitiesOut,
    roles: rolesOut,
    groups: groupsOut,
  };
}
