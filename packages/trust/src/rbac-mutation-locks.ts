import { approvalChallenges, capabilities, roles, roleCapabilities, groups, groupRoles, groupMembers, groupModerationScopes, type InviteSeedTx } from "@nautilo/db";

/** Drizzle may wrap the PostgreSQL serialization/deadlock error in a cause. */
export function isAuthorityTransactionConflict(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const cause = current as { code?: unknown; cause?: unknown };
    if (cause.code === "40P01" || cause.code === "40001") return true;
    current = cause.cause;
  }
  return false;
}

/** Existing RBAC lock order shared with moderator authority mutations. */
export async function lockFingerprintState(tx: InviteSeedTx): Promise<void> {
  await tx.select({ id: capabilities.id }).from(capabilities).for("update");
  await tx.select({ id: roles.id }).from(roles).for("update");
  await tx.select({ roleId: roleCapabilities.roleId, capabilityId: roleCapabilities.capabilityId }).from(roleCapabilities).for("update");
  await tx.select({ id: groups.id }).from(groups).for("update");
  await tx.select({ groupId: groupRoles.groupId, roleId: groupRoles.roleId }).from(groupRoles).for("update");
  await tx.select({ groupId: groupMembers.groupId, userId: groupMembers.userId }).from(groupMembers).for("update");
  await tx.select({ id: approvalChallenges.id }).from(approvalChallenges).for("update");
  await tx.select().from(groupModerationScopes).for("update");
}
