import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE,
  loadSystemPermissionsOnboardingPreference,
  parseSystemPermissionsOnboardingPreference,
  saveSystemPermissionsOnboardingPreference,
  systemPermissionsOnboardingPreferencePath,
  type SystemPermissionsOnboardingPreferenceFileSystem,
} from "../../electron/system-permissions-onboarding-preference";

function memoryFileSystem(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const handles = new Map<number, string>();
  let nextHandle = 1;
  const fs: SystemPermissionsOnboardingPreferenceFileSystem = {
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    mkdirSync: () => undefined,
    openSync: (path) => {
      if (files.has(path)) throw new Error("exists");
      const handle = nextHandle++;
      handles.set(handle, path);
      files.set(path, "");
      return handle;
    },
    writeFileSync: (handle, data) => {
      const path = handles.get(handle);
      if (path === undefined) throw new Error("closed");
      files.set(path, data);
    },
    closeSync: (handle) => { handles.delete(handle); },
    renameSync: (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error("missing temp");
      files.set(to, value);
      files.delete(from);
    },
    unlinkSync: (path) => { files.delete(path); },
  };
  return { fs, files };
}

describe("system permissions onboarding preference", () => {
  test("accepts only the exact versioned boolean schema", () => {
    expect(parseSystemPermissionsOnboardingPreference({ version: 1, showAutomatically: false }))
      .toEqual({ version: 1, showAutomatically: false });
    expect(parseSystemPermissionsOnboardingPreference({ version: 2, showAutomatically: false })).toBeNull();
    expect(parseSystemPermissionsOnboardingPreference({ version: 1, showAutomatically: "false" })).toBeNull();
    expect(parseSystemPermissionsOnboardingPreference({ version: 1, showAutomatically: false, serverUrl: "https://example.test" })).toBeNull();
  });

  test("defaults safely when the file is missing, malformed, or unreadable", () => {
    const missing = memoryFileSystem();
    expect(loadSystemPermissionsOnboardingPreference("/prefs.json", missing.fs))
      .toEqual(DEFAULT_SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE);
    const malformed = memoryFileSystem({ "/prefs.json": "{" });
    expect(loadSystemPermissionsOnboardingPreference("/prefs.json", malformed.fs))
      .toEqual(DEFAULT_SYSTEM_PERMISSIONS_ONBOARDING_PREFERENCE);
  });

  test("publishes exact bytes through a same-directory atomic rename", () => {
    const memory = memoryFileSystem();
    saveSystemPermissionsOnboardingPreference(
      "/shared/system-permissions-onboarding.json",
      { version: 1, showAutomatically: false },
      { fileSystem: memory.fs, temporaryId: "test" },
    );
    expect(memory.files.get("/shared/system-permissions-onboarding.json"))
      .toBe('{"version":1,"showAutomatically":false}\n');
    expect(memory.files.has("/shared/system-permissions-onboarding.json.test.tmp")).toBeFalse();
    expect(loadSystemPermissionsOnboardingPreference("/shared/system-permissions-onboarding.json", memory.fs))
      .toEqual({ version: 1, showAutomatically: false });
  });

  test("shares development profiles without suppressing the separately identified packaged app", () => {
    expect(systemPermissionsOnboardingPreferencePath(
      "/Library/Application Support",
      "Nautilo",
      "development",
    )).toBe("/Library/Application Support/Nautilo/system-permissions-onboarding-development.json");
    expect(systemPermissionsOnboardingPreferencePath(
      "/Library/Application Support",
      "Nautilo",
      "packaged",
    )).toBe("/Library/Application Support/Nautilo/system-permissions-onboarding-packaged.json");
  });
});
