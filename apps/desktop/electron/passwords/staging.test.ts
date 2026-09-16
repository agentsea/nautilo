/**
 * D403 (ISSUE-D403) Phase 4 — PasswordStagingMap unit tests (bun:test).
 *
 * Electron-free pure helper. Covers stage/peek/take/clear/size, per-ORIGIN
 * keying + isolation (the save offer must survive a guest webContents swap by
 * being keyed on the stable origin), and the TTL backstop (an ignored offer
 * can't pin a plaintext password forever).
 *
 * TYPES NOTE: same as the sibling tests — the desktop tsconfig narrows `types`
 * to `["node"]` and typechecks `electron/**`, so Bun's runtime-injected test
 * globals are declared module-scoped (no `bun:test` import, which would leak
 * `bun-types` global lib augmentations into unrelated electron modules).
 */

import { PasswordStagingMap, type StagedCredential } from "./staging";

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeUndefined(): void;
}

// Module-scoped (NOT `declare global`) so this file does not conflict with the
// sibling test that declares these globally.
declare const describe: (label: string, fn: () => void) => void;
declare const test: (label: string, fn: () => void) => void;
declare const expect: (value: unknown) => Matchers;

const cred = (
  origin: string,
  username = `${origin}-user`,
): StagedCredential => ({
  origin,
  username,
  password: `${origin}-secret`,
});

describe("PasswordStagingMap (D403 P4)", () => {
  test("peek is non-destructive; take removes (keyed by origin)", () => {
    const m = new PasswordStagingMap();
    m.stage(cred("https://a.example"));
    expect(m.size).toBe(1);
    expect(m.peek("https://a.example")).toEqual(cred("https://a.example"));
    expect(m.size).toBe(1); // peek did not remove
    expect(m.take("https://a.example")).toEqual(cred("https://a.example"));
    expect(m.size).toBe(0); // take removed
    expect(m.peek("https://a.example")).toBeUndefined();
  });

  test("stage replaces the entry for the same origin", () => {
    const m = new PasswordStagingMap();
    m.stage(cred("https://x.example", "old"));
    m.stage(cred("https://x.example", "new"));
    expect(m.size).toBe(1);
    expect(m.peek("https://x.example")).toEqual(cred("https://x.example", "new"));
  });

  test("entries are isolated per origin", () => {
    const m = new PasswordStagingMap();
    m.stage(cred("https://one.example"));
    m.stage(cred("https://two.example"));
    expect(m.size).toBe(2);
    // Committing one origin must not touch the other's staged credential.
    expect(m.take("https://one.example")).toEqual(cred("https://one.example"));
    expect(m.peek("https://two.example")).toEqual(cred("https://two.example"));
    expect(m.size).toBe(1);
  });

  test("clear reports removal; take of an unknown origin is undefined", () => {
    const m = new PasswordStagingMap();
    m.stage(cred("https://c.example"));
    expect(m.clear("https://c.example")).toBe(true);
    expect(m.clear("https://c.example")).toBe(false); // already gone
    expect(m.take("https://nope.example")).toBeUndefined();
  });

  test("TTL: a staged credential expires and is not returned after ttlMs", () => {
    let nowMs = 1_000;
    const m = new PasswordStagingMap({ ttlMs: 5_000, now: () => nowMs });
    m.stage(cred("https://ttl.example"));
    nowMs += 4_999; // still within TTL
    expect(m.peek("https://ttl.example")).toEqual(cred("https://ttl.example"));
    nowMs += 2; // now past TTL (total 5_001 > 5_000)
    expect(m.peek("https://ttl.example")).toBeUndefined();
    expect(m.take("https://ttl.example")).toBeUndefined();
  });
});
