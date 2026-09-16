/**
 * D104 — operator repair for `logto_account_security` rows.
 *
 * Lists local Logto-linked users still flagged for mandatory password
 * rotation, or clears the flag after the operator confirms the human
 * already rotated their Logto password out of band.
 */
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import {
  exitUnlessSetupStateIn,
  SETUP_STATES_CLAIMED_OR_LATER,
} from "../lib/setup-state-precondition";
import {
  createDirectDb,
  listLocalLinkedUsersRequiringPasswordChange,
  markPasswordChangeCompleted,
} from "@nautilo/db";

export interface RepairLogtoAccountSecurityArgs {
  dryRun?: boolean | undefined;
  markCompleteUserId?: string | undefined;
  /** Required together with markCompleteUserId to apply. */
  yes?: boolean | undefined;
  configEnvPath?: string | undefined;
}

export async function repairLogtoAccountSecurity(
  args: RepairLogtoAccountSecurityArgs,
): Promise<number> {
  loadConfigEnvIntoProcess({ path: args.configEnvPath });
  await exitUnlessSetupStateIn(SETUP_STATES_CLAIMED_OR_LATER, "repair-logto-account-security");

  const db = createDirectDb(1);
  try {
    if (args.markCompleteUserId) {
      if (!args.yes) {
        console.error(
          "Refusing to clear password-change requirement without --yes.",
        );
        console.error(
          "Example: bun run dev:repair-logto-account-security -- --mark-complete <user-uuid> --yes",
        );
        return 1;
      }
      const ok = await markPasswordChangeCompleted(db, args.markCompleteUserId);
      if (!ok) {
        console.error(
          `No logto_account_security row for user id ${args.markCompleteUserId}.`,
        );
        return 1;
      }
      console.log(
        `Cleared requires_password_change for user ${args.markCompleteUserId}.`,
      );
      return 0;
    }

    const rows = await listLocalLinkedUsersRequiringPasswordChange(db);
    if (rows.length === 0) {
      console.log("No local Logto-linked users require a password change.");
      return 0;
    }

    console.log(
      `${rows.length} user(s) still flagged for password change (requires_password_change=true):`,
    );
    for (const r of rows) {
      console.log(
        `  ${r.userId}  ${r.email}  @${r.handle ?? "?"}  reason=${r.passwordChangeReason ?? "?"}  since=${r.requiredSince?.toISOString() ?? "?"}`,
      );
    }

    if (args.dryRun) {
      console.log("");
      console.log("Dry-run only — no changes made.");
      return 0;
    }

    console.log("");
    console.log(
      "Pass --mark-complete <user-uuid> --yes to clear a user after confirming they rotated their password.",
    );
    return 0;
  } finally {
    await db.end();
  }
}
