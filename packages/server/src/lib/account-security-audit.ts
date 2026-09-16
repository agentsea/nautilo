/**
 * D104 — canonical audit event names for Logto account lifecycle.
 *
 * Writers (password change route, operator CLI, recovery redemption)
 * should use these constants so log lines and future JSONL rows stay
 * consistent. Never log passwords, recovery material, or lengths.
 */
export const ACCOUNT_SECURITY_AUDIT = {
  PASSWORD_CHANGED: "account_password_changed",
  PASSWORD_CHANGE_REJECTED: "account_password_change_rejected",
  PASSWORD_CHANGE_FAILED: "account_password_change_failed",
  PASSWORD_RESET_OPERATOR: "account_password_reset_operator",
  PASSWORD_RECOVERED: "account_password_recovered",
  /** D104 — operator or user viewed Logto recovery status (no secrets). */
  LOGTO_RECOVERY_CODES_STATUS: "logto_recovery_codes_status",
  /** M120 — user regenerated account recovery codes (no plaintext in log). */
  LOGTO_RECOVERY_CODES_REGENERATED: "logto_recovery_codes_regenerated",
} as const;
