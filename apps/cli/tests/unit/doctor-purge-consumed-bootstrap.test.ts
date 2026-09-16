import { test, expect } from "bun:test";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { markBootstrapUsed, writeBootstrapAdminPassword } from "@nautilo/operator-secrets";
import { runDoctorPurgeConsumedBootstrap } from "../../src/lib/doctor-purge-consumed-bootstrap.ts";

function mkHome(): string {
  return join(tmpdir(), `npurge-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("empty home → no scanned rows, zero purged", () => {
  const home = mkHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const r = runDoctorPurgeConsumedBootstrap({ home });
  expect(r.scanned.length).toBe(0);
  expect(r.purgedCount).toBe(0);
});

test("bootstrap without .used → no-used-sentinel", () => {
  const home = mkHome();
  const root = join(home, ".nautilo-alpha");
  mkdirSync(join(root, ".bootstrap"), { recursive: true, mode: 0o700 });
  writeBootstrapAdminPassword(join(root, ".bootstrap"), "x");
  const r = runDoctorPurgeConsumedBootstrap({ home });
  expect(r.purgedCount).toBe(0);
  expect(r.scanned).toEqual([{ instanceRoot: root, reason: "no-used-sentinel" }]);
});

test(".used younger than 24h → too-young", () => {
  const home = mkHome();
  const root = join(home, ".nautilo-beta");
  const b = join(root, ".bootstrap");
  mkdirSync(b, { recursive: true, mode: 0o700 });
  writeBootstrapAdminPassword(b, "y");
  markBootstrapUsed(b, { now: new Date() });
  const r = runDoctorPurgeConsumedBootstrap({ home, now: new Date() });
  expect(r.purgedCount).toBe(0);
  expect(r.scanned[0]?.reason).toBe("too-young");
});

test(".used older than 24h → purged; directory removed", () => {
  const home = mkHome();
  const root = join(home, ".nautilo-gamma");
  const b = join(root, ".bootstrap");
  mkdirSync(b, { recursive: true, mode: 0o700 });
  writeBootstrapAdminPassword(b, "z");
  markBootstrapUsed(b, { now: new Date("2000-01-01T00:00:00.000Z") });
  const used = join(b, ".used");
  utimesSync(used, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
  const r = runDoctorPurgeConsumedBootstrap({
    home,
    now: new Date("2000-01-02T12:00:00.000Z"),
  });
  expect(r.purgedCount).toBe(1);
  expect(r.scanned[0]?.reason).toBe("purged");
  expect(existsSync(b)).toBe(false);
});

test("dry-run would purge but leaves tree", () => {
  const home = mkHome();
  const root = join(home, ".nautilo-delta");
  const b = join(root, ".bootstrap");
  mkdirSync(b, { recursive: true, mode: 0o700 });
  writeBootstrapAdminPassword(b, "d");
  markBootstrapUsed(b, { now: new Date("1999-06-01T00:00:00.000Z") });
  const used = join(b, ".used");
  utimesSync(used, new Date("1999-06-01T00:00:00.000Z"), new Date("1999-06-01T00:00:00.000Z"));
  const r = runDoctorPurgeConsumedBootstrap({
    home,
    dryRun: true,
    now: new Date("2000-01-01T12:00:00.000Z"),
  });
  expect(r.purgedCount).toBe(0);
  expect(r.scanned[0]?.reason).toBe("dry-run-would-purge");
  expect(existsSync(b)).toBe(true);
});

test("custom ttlMs honored", () => {
  const home = mkHome();
  const root = join(home, ".nautilo-eps");
  const b = join(root, ".bootstrap");
  mkdirSync(b, { recursive: true, mode: 0o700 });
  writeBootstrapAdminPassword(b, "e");
  const stamped = new Date("2000-01-01T12:00:00.000Z");
  markBootstrapUsed(b, { now: stamped });
  const used = join(b, ".used");
  utimesSync(used, stamped, stamped);
  const now = new Date("2000-01-01T13:00:00.000Z");
  const tooSoon = runDoctorPurgeConsumedBootstrap({
    home,
    now,
    ttlMs: 2 * 60 * 60 * 1000,
  });
  expect(tooSoon.scanned[0]?.reason).toBe("too-young");

  const home2 = mkHome();
  const root2 = join(home2, ".nautilo-eps2");
  const b2 = join(root2, ".bootstrap");
  mkdirSync(b2, { recursive: true, mode: 0o700 });
  writeBootstrapAdminPassword(b2, "e2");
  const old = new Date("2000-01-01T12:00:00.000Z");
  markBootstrapUsed(b2, { now: old });
  const used2 = join(b2, ".used");
  utimesSync(used2, old, old);
  const now2 = new Date("2000-01-01T14:30:00.000Z");
  const ok = runDoctorPurgeConsumedBootstrap({
    home: home2,
    now: now2,
    ttlMs: 60 * 60 * 1000,
  });
  expect(ok.scanned[0]?.reason).toBe("purged");
});

test("multiple instance dirs in one pass", () => {
  const home = mkHome();
  const r1 = join(home, ".nautilo-a");
  const r2 = join(home, ".nautilo-b");
  const b1 = join(r1, ".bootstrap");
  const b2 = join(r2, ".bootstrap");
  mkdirSync(b1, { recursive: true, mode: 0o700 });
  mkdirSync(b2, { recursive: true, mode: 0o700 });
  writeBootstrapAdminPassword(b1, "1");
  writeBootstrapAdminPassword(b2, "2");
  markBootstrapUsed(b1, { now: new Date("1990-01-01T00:00:00.000Z") });
  markBootstrapUsed(b2, { now: new Date("1990-01-01T00:00:00.000Z") });
  utimesSync(join(b1, ".used"), new Date("1990-01-01T00:00:00.000Z"), new Date("1990-01-01T00:00:00.000Z"));
  utimesSync(join(b2, ".used"), new Date("1990-01-01T00:00:00.000Z"), new Date("1990-01-01T00:00:00.000Z"));
  const r = runDoctorPurgeConsumedBootstrap({
    home,
    now: new Date("2020-01-01T00:00:00.000Z"),
  });
  expect(r.purgedCount).toBe(2);
  expect(r.scanned.length).toBe(2);
  expect(r.scanned.every((s) => s.reason === "purged")).toBe(true);
});
