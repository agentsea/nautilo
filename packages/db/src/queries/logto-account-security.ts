import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "../config/database";
import { logtoAccountSecurity } from "../schema/logto-account-security";
import { users } from "../schema/users";

/** Discriminator values for `password_change_reason` (D104). */
export const PASSWORD_CHANGE_REASON = {
  MIGRATION_TEMP_PASSWORD: "migration_temp_password",
  OPERATOR_RESET: "operator_reset",
  RECOVERY_CODE_RESET: "recovery_code_reset",
  /** D112 Phase 8 — CLI/setup template minted a temp password not typed in UI redeem. */
  SETUP_TEMP_PASSWORD: "setup_temp_password",
} as const;

export type PasswordChangeReason =
  (typeof PASSWORD_CHANGE_REASON)[keyof typeof PASSWORD_CHANGE_REASON];

export type AccountSecurityDb = Pick<Database, "insert" | "select" | "update">;

/**
 * After `migrate-to-logto` mints a one-time temporary password, mark the
 * Nautilo user so Workbench can force a rotation (D104).
 */
export async function markMigrationTempPasswordRequired(
  db: AccountSecurityDb,
  userId: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(logtoAccountSecurity)
    .values({
      userId,
      requiresPasswordChange: true,
      passwordChangeReason: PASSWORD_CHANGE_REASON.MIGRATION_TEMP_PASSWORD,
      requiredSince: now,
      completedAt: null,
      lastOperatorActorId: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: logtoAccountSecurity.userId,
      set: {
        requiresPasswordChange: true,
        passwordChangeReason: PASSWORD_CHANGE_REASON.MIGRATION_TEMP_PASSWORD,
        requiredSince: now,
        completedAt: null,
        updatedAt: now,
      },
    });
}

export async function markPasswordChangeRequired(
  db: AccountSecurityDb,
  args: {
    userId: string;
    reason: PasswordChangeReason;
    lastOperatorActorId?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await db
    .insert(logtoAccountSecurity)
    .values({
      userId: args.userId,
      requiresPasswordChange: true,
      passwordChangeReason: args.reason,
      requiredSince: now,
      completedAt: null,
      lastOperatorActorId: args.lastOperatorActorId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: logtoAccountSecurity.userId,
      set: {
        requiresPasswordChange: true,
        passwordChangeReason: args.reason,
        requiredSince: now,
        completedAt: null,
        lastOperatorActorId: args.lastOperatorActorId ?? null,
        updatedAt: now,
      },
    });
}

export async function markPasswordChangeCompleted(
  db: AccountSecurityDb,
  userId: string,
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(logtoAccountSecurity)
    .set({
      requiresPasswordChange: false,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(logtoAccountSecurity.userId, userId))
    .returning();
  return updated.length > 0;
}

export async function getAccountSecurityRowByUserId(
  db: AccountSecurityDb,
  userId: string,
) {
  const rows = await db
    .select()
    .from(logtoAccountSecurity)
    .where(eq(logtoAccountSecurity.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export interface UserRequiringPasswordChangeRow {
  userId: string;
  /** Nullable post-M107: local-install users sign up without email. */
  email: string | null;
  handle: string | null;
  passwordChangeReason: string | null;
  requiredSince: Date | null;
}

export async function listLocalLinkedUsersRequiringPasswordChange(
  db: AccountSecurityDb,
): Promise<UserRequiringPasswordChangeRow[]> {
  return db
    .select({
      userId: logtoAccountSecurity.userId,
      email: users.email,
      handle: users.handle,
      passwordChangeReason: logtoAccountSecurity.passwordChangeReason,
      requiredSince: logtoAccountSecurity.requiredSince,
    })
    .from(logtoAccountSecurity)
    .innerJoin(users, eq(logtoAccountSecurity.userId, users.id))
    .where(
      and(
        eq(logtoAccountSecurity.requiresPasswordChange, true),
        isNotNull(users.externalId),
        isNull(users.server),
      ),
    );
}
