/**
 * Boot-time validator for `NAUTILO_MEDIA_ROOT`.
 *
 * `getMediaStorageRoot()` silently falls back to `resolveNautiloRootDir()`
 * for malformed values; `validateMediaStorageRootEnv()` surfaces
 * misconfiguration loudly at boot time.
 */

import { describe, test, expect } from "bun:test";
import { validateMediaStorageRootEnv } from "../../src/instance-defaults";

describe("validateMediaStorageRootEnv — boot-time validation", () => {
  test("unset → ok with source=default", () => {
    const r = validateMediaStorageRootEnv(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("default");
      expect(r.root.length).toBeGreaterThan(0);
    }
  });

  test("absolute path → ok with source=env", () => {
    const r = validateMediaStorageRootEnv("/srv/nautilo/media");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("env");
      expect(r.root).toBe("/srv/nautilo/media");
    }
  });

  test("blank string → rejected", () => {
    const r = validateMediaStorageRootEnv("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty|blank/);
  });

  test("whitespace-only → rejected (same as blank after trim)", () => {
    const r = validateMediaStorageRootEnv("   \t  ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty|blank/);
  });

  test("relative path → rejected", () => {
    const r = validateMediaStorageRootEnv("relative/media");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/);
  });

  test("absolute path containing .. segment → rejected", () => {
    const r = validateMediaStorageRootEnv("/srv/nautilo/../media");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.\./);
  });

  test("trims surrounding whitespace before validation", () => {
    const r = validateMediaStorageRootEnv("  /srv/nautilo/media  ");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("env");
      expect(r.root).toBe("/srv/nautilo/media");
    }
  });
});
