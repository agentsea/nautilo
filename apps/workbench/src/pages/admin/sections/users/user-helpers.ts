import { ApiError, LastOwnerError, pickHighestRoleSlug } from "@nautilo/api-client/browser";
import type { AdminUserRow, GroupRow } from "@nautilo/api-client/browser";

export type { AdminUserRow, GroupRow };

export const VIRTUALIZE_THRESHOLD = 200;
export const PAGE_LIMIT = 50;

export const FEDERATED_ACTIONS_TOOLTIP =
  "Federated users are managed on their home server.";

export const TRANSFER_OWNER_TOOLTIP =
  "Only the server owner can transfer ownership.";

export const LAST_OWNER_MESSAGE =
  "Cannot remove the last server owner. Add another owner first.";

export const LAST_OWNER_DISABLE_MESSAGE =
  "Cannot disable the last server owner. Assign another owner first.";

export const LAST_OWNER_DELETE_MESSAGE =
  "Cannot delete the last server owner. Assign another owner first.";

/**
 * D298 — map an offboard failure (delete/disable) to a friendly, actionable
 * line prefixed with the user identity. Last-owner and federated cases get
 * the guidance copy; everything else falls back to the server message.
 */
export function friendlyOffboardFailure(
  e: unknown,
  label: string,
  verb: "delete" | "disable",
): string {
  if (e instanceof LastOwnerError) {
    return `${label} — ${verb === "disable" ? LAST_OWNER_DISABLE_MESSAGE : LAST_OWNER_DELETE_MESSAGE}`;
  }
  if (e instanceof ApiError) return `${label} — ${e.message}`;
  return `${label} — couldn't ${verb}`;
}

const ROLE_LADDER_RANK: Record<string, number> = {
  owner: 0,
  admin: 1,
  superuser: 2,
  member: 3,
  contributor: 4,
  guest: 5,
};

/** The six canonical server groups, highest-privilege first. */
const CANONICAL_GROUP_TYPES = [
  "owners",
  "admins",
  "superusers",
  "members",
  "contributors",
  "guests",
] as const;

export function isFederatedUser(user: AdminUserRow): boolean {
  return user.server != null;
}

export type UserStatus = "active" | "disabled" | "federated";

/** Federated takes precedence (foreign-origin), then disabled, else active. */
export function userStatus(user: AdminUserRow): UserStatus {
  if (user.server != null) return "federated";
  if (user.disabledAt != null) return "disabled";
  return "active";
}

export const USER_STATUS_GLYPH: Record<UserStatus, string> = {
  active: "●",
  disabled: "◌",
  federated: "⟲",
};

export const USER_STATUS_LABEL: Record<UserStatus, string> = {
  active: "Active",
  disabled: "Disabled",
  federated: "Federated",
};

/** Federated users cannot be deleted/disabled locally (home server owns them). */
export function canOffboard(user: AdminUserRow): boolean {
  return user.server == null;
}

export function formatUserIdentity(user: AdminUserRow): string {
  if (user.server != null) {
    const handle = user.handle ?? user.displayName;
    return `@${handle}@${user.server}`;
  }
  if (user.handle != null) return `@${user.handle}`;
  return user.displayName;
}

export function userRoleLabel(user: AdminUserRow): string {
  const role = pickHighestRoleSlug(user.groups);
  if (!role) return "Unknown";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString();
}

function roleRank(slug: string): number {
  return ROLE_LADDER_RANK[slug] ?? ROLE_LADDER_RANK.guest + 1;
}

/** The Role slug a canonical Group carries (canonical seed is 1:1). */
export function groupRoleSlug(group: GroupRow): string {
  return group.roleSlugs[0] ?? "guest";
}

/**
 * The canonical six groups, ordered highest-privilege first. Filters out any
 * non-canonical rows so the membership matrix only ever shows the fixed ladder.
 */
export function orderedCanonicalGroups(groups: GroupRow[]): GroupRow[] {
  return groups
    .filter((g) => (CANONICAL_GROUP_TYPES as readonly string[]).includes(g.type))
    .slice()
    .sort((a, b) => roleRank(groupRoleSlug(a)) - roleRank(groupRoleSlug(b)));
}

/** Is the user currently a member of this canonical Group? */
export function isUserInGroup(user: AdminUserRow, group: GroupRow): boolean {
  return user.groups.some((chip) => chip.id === group.id || chip.type === group.type);
}
