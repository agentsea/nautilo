/**
 * D104 — Logto account lifecycle metadata stored in Nautilo DB.
 *
 * Logto remains the credential authority; this table tracks enforcement
 * state (temporary migration passwords, operator resets, recovery-code
 * flows) for Workbench/Electron UX. Never stores plaintext passwords.
 */
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { actors } from "./trust";

export const logtoAccountSecurity = pgTable("logto_account_security", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  requiresPasswordChange: boolean("requires_password_change")
    .notNull()
    .default(false),
  /**
   * Why `requires_password_change` was set: `migration_temp_password`,
   * `operator_reset`, `recovery_code_reset`, etc.
   */
  passwordChangeReason: text("password_change_reason"),
  requiredSince: timestamp("required_since"),
  completedAt: timestamp("completed_at"),
  lastOperatorActorId: uuid("last_operator_actor_id").references(
    () => actors.id,
    { onDelete: "set null" },
  ),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type LogtoAccountSecurity = typeof logtoAccountSecurity.$inferSelect;
export type NewLogtoAccountSecurity = typeof logtoAccountSecurity.$inferInsert;
