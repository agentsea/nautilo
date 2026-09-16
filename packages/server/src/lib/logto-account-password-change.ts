import type { LogtoAdminClient } from "@nautilo/trust";
import { PasswordPolicyChecker, passwordPolicyGuard } from "@logto/core-kit";

export type LogtoPasswordChangeClient = Pick<
  LogtoAdminClient,
  "verifyUserPassword" | "setUserPassword" | "getPasswordPolicy" | "getUser"
>;

export type ExecuteLogtoPasswordChangeResult =
  | { outcome: "success" }
  | { outcome: "wrong_current" }
  | { outcome: "new_password_rejected"; message: string }
  | { outcome: "logto_unavailable"; message: string };

/**
 * D104 — verify current Logto password, then apply the new one.
 * Pure orchestration so unit tests can inject a fake Management client.
 */
export async function executeLogtoPasswordChange(
  client: LogtoPasswordChangeClient,
  logtoUserId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ExecuteLogtoPasswordChangeResult> {
  if (currentPassword === newPassword) {
    return {
      outcome: "new_password_rejected",
      message: "New password must be different from the current password.",
    };
  }
  const verified = await client.verifyUserPassword(
    logtoUserId,
    currentPassword,
  );
  if (!verified) return { outcome: "wrong_current" };

  try {
    const [rawPolicy, user] = await Promise.all([
      client.getPasswordPolicy(),
      client.getUser(logtoUserId),
    ]);
    if (!user) {
      return {
        outcome: "logto_unavailable",
        message: "The identity service could not validate the password change. Try again later.",
      };
    }
    const policy = passwordPolicyGuard.parse(rawPolicy);
    const checker = new PasswordPolicyChecker(policy);
    const userInfo: { username?: string; email?: string } = {};
    if (user.username !== null) userInfo.username = user.username;
    if (user.primaryEmail !== null) userInfo.email = user.primaryEmail;
    const issues = await checker.check(newPassword, userInfo);
    if (issues.length > 0) {
      return {
        outcome: "new_password_rejected",
        message:
          "The new password does not meet the configured identity-service password policy.",
      };
    }
  } catch {
    return {
      outcome: "logto_unavailable",
      message:
        "The identity service could not validate the password change. Try again later.",
    };
  }

  try {
    await client.setUserPassword(logtoUserId, newPassword);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b422\b/.test(msg)) {
      return {
        outcome: "new_password_rejected",
        message:
          "The new password could not be saved. It may be too weak, match a blocked pattern, or match the current password.",
      };
    }
    return {
      outcome: "logto_unavailable",
      message:
        "The identity service did not accept the password change. Try again later.",
    };
  }
  return { outcome: "success" };
}
