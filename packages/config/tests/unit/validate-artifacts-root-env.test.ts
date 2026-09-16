/**
 * D136-P2 — `validateArtifactsRootEnv` boot-time validator tests.
 *
 * `getArtifactsRoot()` silently falls back to `~/.nautilo/artifacts/`
 * for malformed `NAUTILO_ARTIFACTS_ROOT` values (right behavior for the
 * byte-storage code path — a misconfigured env shouldn't crash the
 * server). `validateArtifactsRootEnv()` is the explicit boot-time
 * complement that surfaces misconfiguration loudly.
 *
 * Tests pin the three malformed shapes (blank / relative / contains
 * `..`) and the two happy paths (unset → default, absolute → env).
 */

import { describe, test, expect } from "bun:test";
import { validateArtifactsRootEnv } from "../../src/instance-defaults";

describe("validateArtifactsRootEnv — D136-P2 boot-time validation", () => {
  test("unset → ok with source=default", () => {
    const r = validateArtifactsRootEnv(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("default");
      expect(r.root.length).toBeGreaterThan(0);
    }
  });

  test("absolute path → ok with source=env", () => {
    const r = validateArtifactsRootEnv("/srv/nautilo/artifacts");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("env");
      expect(r.root).toBe("/srv/nautilo/artifacts");
    }
  });

  test("blank string → rejected", () => {
    const r = validateArtifactsRootEnv("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty|blank/);
  });

  test("whitespace-only → rejected (same as blank after trim)", () => {
    const r = validateArtifactsRootEnv("   \t  ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty|blank/);
  });

  test("relative path → rejected", () => {
    const r = validateArtifactsRootEnv("relative/artifacts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/);
  });

  test("relative path starting with ./ → rejected", () => {
    const r = validateArtifactsRootEnv("./artifacts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/);
  });

  test("absolute path containing .. segment → rejected", () => {
    const r = validateArtifactsRootEnv("/srv/nautilo/../artifacts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.\./);
  });

  test("absolute path with .. embedded in segment name (not its own segment) → accepted", () => {
    // `/srv/foo..bar/artifacts` — the `..` is part of a filename segment,
    // not its own segment. Must not be rejected by the segment-equality
    // check.
    const r = validateArtifactsRootEnv("/srv/foo..bar/artifacts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.root).toBe("/srv/foo..bar/artifacts");
  });

  test("trims surrounding whitespace before validation", () => {
    const r = validateArtifactsRootEnv("  /srv/nautilo/artifacts  ");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("env");
      expect(r.root).toBe("/srv/nautilo/artifacts");
    }
  });
});
