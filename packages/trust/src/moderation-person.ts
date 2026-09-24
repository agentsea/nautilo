import { and, asc, eq, gt, ilike, or, getSharedDirectDb, isNull, moderationAccessAllowedSql, moderationActions, moderationRestrictions, moderationSubjects, sql, users } from "@nautilo/db";
import type { ModerationPerson, ModerationRestriction } from "@nautilo/types";
import { inspectModerationPerson } from "./moderation-coordinator";
import { requireModerationCaller } from "./moderation-store";
import { ModerationError } from "./moderation-policy";

/** Minimal moderation projection, independent of account/password administration. */
export async function getServerModerationPerson(callerUserId: string, target: { userId: string } | { handle: string }): Promise<{
  person: ModerationPerson; restrictions: ModerationRestriction[];
}> {
  const db = getSharedDirectDb();
  await requireModerationCaller(db, callerUserId, null);
  const [human] = await db.select({ id: users.id }).from(users).where(
    "userId" in target ? eq(users.id, target.userId) : eq(users.handle, target.handle.replace(/^@/, "").toLowerCase()),
  );
  if (!human) throw new ModerationError("target_unavailable");
  const person = await inspectModerationPerson(callerUserId, human.id, null);
  const rows = await db.select({ restriction: moderationRestrictions, reason: moderationActions.reason })
    .from(moderationRestrictions).innerJoin(moderationSubjects, eq(moderationSubjects.id, moderationRestrictions.subjectId))
    .innerJoin(moderationActions, eq(moderationActions.operationId, moderationRestrictions.createOperationId))
    .where(and(eq(moderationSubjects.userId, human.id), isNull(moderationRestrictions.roomId),
      isNull(moderationRestrictions.liftedAt), sql`${moderationRestrictions.startsAt} <= statement_timestamp()`,
      sql`(${moderationRestrictions.expiresAt} IS NULL OR ${moderationRestrictions.expiresAt} > statement_timestamp())`));
  // Lifting an access restriction uses the same current ban authority and
  // target protections. Advertise it only when there is a ban to lift.
  const canLiftBan = person.allowedActions.includes("ban") && rows.some(({ restriction }) => restriction.kind === "access");
  return { person: canLiftBan ? { ...person, allowedActions: [...person.allowedActions, "lift" as const] } : person,
    restrictions: rows.map(({ restriction, reason }) => ({
    id: restriction.id, targetUserId: human.id, displayName: person.displayName, roomId: null,
    kind: restriction.kind, reason, startsAt: restriction.startsAt.toISOString(),
    expiresAt: restriction.expiresAt?.toISOString() ?? null, revision: restriction.revision,
  })) };
}

/** Search the same local identities as Admin Users, with moderation-only access
 * and a minimal projection. Removed accounts remain discoverable for lifting bans. */
export async function searchServerModerationPeople(callerUserId: string, input: {
  search: string; limit: number; after?: string; activeOnly?: boolean;
}) {
  const db = getSharedDirectDb();
  await requireModerationCaller(db, callerUserId, null);
  const term = input.search.trim().replace(/^@/, "");
  const pattern = `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = await db.select({ userId: users.id, displayName: users.name, handle: users.handle })
    .from(users).where(and(isNull(users.server),
      input.activeOnly ? and(isNull(users.disabledAt), moderationAccessAllowedSql(sql`${users.id}`)) : undefined,
      or(ilike(users.name, pattern), ilike(users.handle, pattern)),
      input.after ? gt(users.id, input.after) : undefined,
    )).orderBy(asc(users.id)).limit(input.limit + 1);
  const items = rows.slice(0, input.limit);
  return { items, next: rows.length > input.limit ? items.at(-1)!.userId : null };
}
