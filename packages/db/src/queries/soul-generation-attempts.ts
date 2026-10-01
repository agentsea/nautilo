import { and, count, eq, gte, lt } from "drizzle-orm";
import { getSharedDirectDb, type DirectDatabase } from "../config/direct-database";
import { soulGenerationAttempts } from "../schema/soul-generation-attempts";
import { users } from "../schema/users";

export const PERSONAL_SOUL_ATTEMPT_LIMIT = 3;
export const PERSONAL_SOUL_WINDOW_MS = 24 * 60 * 60 * 1000;

export class SoulGenerationRateLimitError extends Error {
  constructor() {
    super("Personal Soul generation limit reached");
    this.name = "SoulGenerationRateLimitError";
  }
}

/**
 * Reserve one server-funded personal setup attempt before provider work. The
 * Human row lock serializes reservations across every server process sharing
 * this database; failed provider calls still consume an attempt.
 */
export async function consumePersonalSoulAttempt(
  humanUserId: string,
  db: DirectDatabase = getSharedDirectDb(),
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - PERSONAL_SOUL_WINDOW_MS);
  await db.transaction(async (tx) => {
    const [human] = await tx.select({ id: users.id }).from(users)
      .where(eq(users.id, humanUserId)).limit(1).for("update");
    if (!human) throw new Error("Soul generation Human no longer exists");

    await tx.delete(soulGenerationAttempts).where(and(
      eq(soulGenerationAttempts.humanUserId, humanUserId),
      lt(soulGenerationAttempts.startedAt, cutoff),
    ));
    const [usage] = await tx.select({ total: count() }).from(soulGenerationAttempts)
      .where(and(
        eq(soulGenerationAttempts.humanUserId, humanUserId),
        gte(soulGenerationAttempts.startedAt, cutoff),
      ));
    if ((usage?.total ?? 0) >= PERSONAL_SOUL_ATTEMPT_LIMIT) {
      throw new SoulGenerationRateLimitError();
    }
    await tx.insert(soulGenerationAttempts).values({ humanUserId, startedAt: now });
  });
}
