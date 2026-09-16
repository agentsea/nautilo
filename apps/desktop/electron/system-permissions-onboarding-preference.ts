import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE_VERSION = 1 as const;

export type SystemPermissionsOnboardingPreference = Readonly<{
  version: typeof SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE_VERSION;
  showAutomatically: boolean;
}>;

export const DEFAULT_SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE: SystemPermissionsOnboardingPreference = Object.freeze({
  version: SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE_VERSION,
  showAutomatically: true,
});

export function parseSystemPermissionsOnboardingPreference(
  raw: unknown,
): SystemPermissionsOnboardingPreference | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).length !== 2
    || record["version"] !== SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE_VERSION
    || typeof record["showAutomatically"] !== "boolean") return null;
  return {
    version: SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE_VERSION,
    showAutomatically: record["showAutomatically"],
  };
}

/**
 * Deliberately app-wide rather than `userData`-scoped: every Nautilo profile
 * on this OS account observes the same decision about automatic Mac setup.
 */
export function systemPermissionsOnboardingPreferencePath(
  appDataPath: string,
  appName: string,
  appIdentity: "development" | "packaged",
): string {
  return join(appDataPath, appName, `system-permissions-onboarding-${appIdentity}.json`);
}

export type SystemPermissionsOnboardingPreferenceFileSystem = Readonly<{
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  openSync(path: string, flags: "wx", mode: number): number;
  writeFileSync(fd: number, data: string, encoding: "utf8"): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}>;

const nativeFileSystem: SystemPermissionsOnboardingPreferenceFileSystem = {
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  renameSync,
  unlinkSync,
};

export function loadSystemPermissionsOnboardingPreference(
  filePath: string,
  fileSystem: SystemPermissionsOnboardingPreferenceFileSystem = nativeFileSystem,
): SystemPermissionsOnboardingPreference {
  if (!fileSystem.existsSync(filePath)) {
    return DEFAULT_SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE;
  }
  try {
    const parsed: unknown = JSON.parse(fileSystem.readFileSync(filePath, "utf8"));
    return parseSystemPermissionsOnboardingPreference(parsed)
      ?? DEFAULT_SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE;
  } catch {
    return DEFAULT_SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE;
  }
}

export function saveSystemPermissionsOnboardingPreference(
  filePath: string,
  preference: SystemPermissionsOnboardingPreference,
  options: Readonly<{
    fileSystem?: SystemPermissionsOnboardingPreferenceFileSystem;
    temporaryId?: string;
  }> = {},
): void {
  const parsed = parseSystemPermissionsOnboardingPreference(preference);
  if (parsed === null) throw new Error("Invalid system-permissions onboarding preference.");
  const fileSystem = options.fileSystem ?? nativeFileSystem;
  fileSystem.mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${options.temporaryId ?? randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fileSystem.openSync(temporaryPath, "wx", 0o600);
    fileSystem.writeFileSync(fd, `${JSON.stringify(parsed)}\n`, "utf8");
    fileSystem.closeSync(fd);
    fd = null;
    fileSystem.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fd !== null) {
      try { fileSystem.closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    try { fileSystem.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}
