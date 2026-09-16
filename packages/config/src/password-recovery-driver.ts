import { getHostingMode } from "./hosting-mode";

export const PASSWORD_RECOVERY_DRIVERS = [
  "oss_relay",
  "logto_native",
  "disabled",
] as const;

export type PasswordRecoveryDriver = (typeof PASSWORD_RECOVERY_DRIVERS)[number];

export function getPasswordRecoveryDriver(
  env: NodeJS.ProcessEnv = process.env,
): PasswordRecoveryDriver {
  const raw = env["NAUTILO_PASSWORD_RECOVERY_DRIVER"]?.trim().toLowerCase();
  if (raw === "oss_relay" || raw === "logto_native" || raw === "disabled") {
    return raw;
  }
  if (raw && raw.length > 0) {
    throw new Error(
      `Invalid NAUTILO_PASSWORD_RECOVERY_DRIVER: ${raw}. Expected "oss_relay", "logto_native", or "disabled".`,
    );
  }
  return getHostingMode(env) === "cloud" ? "logto_native" : "oss_relay";
}

export function passwordRecoveryUsesOssRelay(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getPasswordRecoveryDriver(env) === "oss_relay";
}
