import { expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateProfileEnvBootstrapTokenIfPresent } from "../../src/lib/bootstrap-token-migration.ts";
import { bootstrapTokenPath } from "../../src/lib/bootstrap-tokens.ts";

const FIXED_NOW = new Date("2026-03-10T15:04:05.000Z");
const STAMP = "20260310T150405Z";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "nautilo-pem-"));
  mkdirSync(join(fakeHome, ".nautilo", "profiles"), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test("legacy .env with NAUTILO_BOOTSTRAP_TOKEN migrates to bootstrap-tokens and archives legacy", () => {
  const name = "demo";
  const legacy = join(fakeHome, ".nautilo", "profiles", `${name}.env`);
  writeFileSync(legacy, "NAUTILO_BOOTSTRAP_TOKEN=secretXYZ\nFOO=1\n", { mode: 0o600 });
  const r = migrateProfileEnvBootstrapTokenIfPresent(name, { home: fakeHome, now: FIXED_NOW });
  expect(r.migrated).toBe(true);
  expect(r.tokenLength).toBe(9);
  expect(r.backupPath).toBe(join(fakeHome, ".nautilo", "profiles", `${name}.env.bak-m091-${STAMP}`));
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(bootstrapTokenPath(name, fakeHome), "utf8")).toBe("secretXYZ");
  expect(existsSync(r.backupPath!)).toBe(true);
});

test("legacy .env without NAUTILO_BOOTSTRAP_TOKEN line leaves files untouched", () => {
  const name = "x";
  const legacy = join(fakeHome, ".nautilo", "profiles", `${name}.env`);
  const body = "FOO=1\n";
  writeFileSync(legacy, body, { mode: 0o600 });
  const r = migrateProfileEnvBootstrapTokenIfPresent(name, { home: fakeHome, now: FIXED_NOW });
  expect(r).toEqual({ migrated: false, reason: "no-bootstrap-token-line" });
  expect(readFileSync(legacy, "utf8")).toBe(body);
  expect(existsSync(bootstrapTokenPath(name, fakeHome))).toBe(false);
});

test("legacy .env with empty NAUTILO_BOOTSTRAP_TOKEN leaves files untouched", () => {
  const name = "x";
  const legacy = join(fakeHome, ".nautilo", "profiles", `${name}.env`);
  const body = "NAUTILO_BOOTSTRAP_TOKEN=\n";
  writeFileSync(legacy, body, { mode: 0o600 });
  const r = migrateProfileEnvBootstrapTokenIfPresent(name, { home: fakeHome, now: FIXED_NOW });
  expect(r).toEqual({ migrated: false, reason: "empty-bootstrap-token-line" });
  expect(readFileSync(legacy, "utf8")).toBe(body);
  expect(existsSync(bootstrapTokenPath(name, fakeHome))).toBe(false);
});

test("new bootstrap-tokens file already present skips token copy but archives legacy when present", () => {
  const name = "p";
  mkdirSync(join(fakeHome, ".nautilo", "bootstrap-tokens"), { recursive: true, mode: 0o700 });
  const newPath = bootstrapTokenPath(name, fakeHome);
  writeFileSync(newPath, "already", { mode: 0o600 });
  const legacy = join(fakeHome, ".nautilo", "profiles", `${name}.env`);
  writeFileSync(legacy, "NAUTILO_BOOTSTRAP_TOKEN=secretXYZ\n", { mode: 0o600 });
  const r = migrateProfileEnvBootstrapTokenIfPresent(name, { home: fakeHome, now: FIXED_NOW });
  expect(r.migrated).toBe(false);
  expect(r.reason).toBe("new-location-already-populated");
  expect(r.legacyArchived).toBe(true);
  expect(readFileSync(newPath, "utf8")).toBe("already");
  expect(existsSync(legacy)).toBe(false);
  expect(r.backupPath).toBe(join(fakeHome, ".nautilo", "profiles", `${name}.env.bak-m091-${STAMP}`));
});

test("no legacy file returns no-legacy-file", () => {
  const r = migrateProfileEnvBootstrapTokenIfPresent("ghost", { home: fakeHome, now: FIXED_NOW });
  expect(r).toEqual({ migrated: false, reason: "no-legacy-file" });
});

test("idempotent: second migrate after successful migration does not recreate legacy", () => {
  const name = "demo";
  const legacy = join(fakeHome, ".nautilo", "profiles", `${name}.env`);
  writeFileSync(legacy, "NAUTILO_BOOTSTRAP_TOKEN=once\n", { mode: 0o600 });
  const first = migrateProfileEnvBootstrapTokenIfPresent(name, { home: fakeHome, now: FIXED_NOW });
  expect(first.migrated).toBe(true);
  const second = migrateProfileEnvBootstrapTokenIfPresent(name, { home: fakeHome, now: FIXED_NOW });
  expect(second.migrated).toBe(false);
  expect(second.reason).toBe("new-location-already-populated");
  expect(readFileSync(bootstrapTokenPath(name, fakeHome), "utf8")).toBe("once");
  expect(existsSync(legacy)).toBe(false);
});
