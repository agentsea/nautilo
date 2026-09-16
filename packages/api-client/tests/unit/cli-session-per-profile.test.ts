import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCliSession,
  compareCliSessionProfileNames,
  CliSessionSecurityError,
  cliSessionPath,
  loadCliSession,
  migrateLegacySessionFile,
  saveCliSessionIfRevisionMatches,
  saveCliSession,
} from "@nautilo/api-client";

function rootDir(): string {
  const override = process.env["NAUTILO_HOME_OVERRIDE"];
  if (!override) throw new Error("NAUTILO_HOME_OVERRIDE not set");
  return join(override, ".nautilo");
}

function sessionRow(handle: string) {
  return {
    schemaVersion: 1 as const,
    instanceId: "i1",
    serverUrl: "http://127.0.0.1:8080",
    handle,
    displayName: "Alice",
    serverRole: "admin" as const,
    externalId: "sub",
    accessToken: "at",
    tokenType: "Bearer" as const,
    expiresAt: Date.now() + 86_400_000,
    scopes: [] as string[],
    source: "password" as const,
    obtainedAt: Date.now(),
  };
}

describe("cli-session per-profile + migration (M108 1.1)", () => {
  let dir: string;
  let prevInstance: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-cli-session-profile-"));
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;
    prevInstance = process.env["NAUTILO_INSTANCE_ID"];
    delete process.env["NAUTILO_INSTANCE_ID"];
  });

  afterEach(() => {
    delete process.env["NAUTILO_HOME_OVERRIDE"];
    if (prevInstance !== undefined) {
      process.env["NAUTILO_INSTANCE_ID"] = prevInstance;
    } else {
      delete process.env["NAUTILO_INSTANCE_ID"];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("orders reversed NFC/NFD profile enumeration by UTF-8 bytes, not locale", () => {
    const reversedCreationOrder = ["é", "e\u0301"];
    expect(reversedCreationOrder.sort(compareCliSessionProfileNames)).toEqual(["e\u0301", "é"]);
    expect(compareCliSessionProfileNames("é", "e\u0301")).not.toBe(0);
  });

  test("cliSessionPath() uses legacy single file", () => {
    expect(cliSessionPath()).toBe(join(rootDir(), "cli-session.json"));
  });

  test("cliSessionPath({ profile }) uses sessions/<profile>.json", () => {
    expect(cliSessionPath({ profile: "default" })).toBe(
      join(rootDir(), "sessions", "default.json"),
    );
  });

  test("saveCliSession + loadCliSession round-trip per profile with mode 0600", async () => {
    const row = sessionRow("alpha");
    await saveCliSession(row, { profile: "alpha" });
    const st = await stat(join(rootDir(), "sessions", "alpha.json"));
    expect(st.mode & 0o777).toBe(0o600);
    const loaded = await loadCliSession({ profile: "alpha" });
    expect(loaded?.handle).toBe("alpha");
  });

  test("clearCliSession({ profile }) removes only profile file", async () => {
    await saveCliSession(sessionRow("legacy"), undefined);
    await saveCliSession(sessionRow("prof"), { profile: "p1" });
    await clearCliSession({ profile: "p1" });
    expect(await loadCliSession()).not.toBeNull();
    expect(await loadCliSession({ profile: "p1" })).toBeNull();
  });

  test("per-profile and legacy stores are independent", async () => {
    await saveCliSession(sessionRow("leg"), undefined);
    await saveCliSession(sessionRow("pro"), { profile: "x" });
    expect((await loadCliSession())?.handle).toBe("leg");
    expect((await loadCliSession({ profile: "x" }))?.handle).toBe("pro");
    await saveCliSession(sessionRow("leg2"), undefined);
    expect((await loadCliSession({ profile: "x" }))?.handle).toBe("pro");
    await saveCliSession(sessionRow("pro2"), { profile: "x" });
    expect((await loadCliSession())?.handle).toBe("leg2");
    expect((await loadCliSession({ profile: "x" }))?.handle).toBe("pro2");
  });

  test("migrateLegacySessionFile: migrates once then no-ops", async () => {
    const r = rootDir();
    await mkdir(r, { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    const legacyPath = join(r, "cli-session.json");
    const payload = JSON.stringify(sessionRow("mig"), null, 2);
    writeFileSync(legacyPath, `${payload}\n`, { mode: 0o600 });
    chmodSync(legacyPath, 0o600);

    expect(await migrateLegacySessionFile("default")).toBe(true);
    expect(await migrateLegacySessionFile("default")).toBe(false);

    const target = join(r, "sessions", "default.json");
    expect(() => readFileSync(legacyPath, "utf-8")).toThrow();
    expect(readFileSync(`${legacyPath}.bak`, "utf-8")).toContain('"handle": "mig"');
    expect(readFileSync(target, "utf-8")).toContain('"handle": "mig"');
    const st = await stat(target);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("migrateLegacySessionFile: false when target profile file exists", async () => {
    const r = rootDir();
    await mkdir(join(r, "sessions"), { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    chmodSync(join(r, "sessions"), 0o700);
    writeFileSync(
      join(r, "sessions", "default.json"),
      `${JSON.stringify(sessionRow("already"), null, 2)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(r, "cli-session.json"),
      `${JSON.stringify(sessionRow("leg"), null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(join(r, "cli-session.json"), 0o600);

    expect(await migrateLegacySessionFile("default")).toBe(false);
    expect(readFileSync(join(r, "cli-session.json"), "utf-8")).toContain("leg");
  });

  test("migrateLegacySessionFile: false when sessions dir has another .json", async () => {
    const r = rootDir();
    await mkdir(join(r, "sessions"), { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    chmodSync(join(r, "sessions"), 0o700);
    writeFileSync(
      join(r, "sessions", "beta.json"),
      `${JSON.stringify(sessionRow("beta"), null, 2)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(r, "cli-session.json"),
      `${JSON.stringify(sessionRow("leg"), null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(join(r, "cli-session.json"), 0o600);

    expect(await migrateLegacySessionFile("default")).toBe(false);
    expect(readFileSync(join(r, "cli-session.json"), "utf-8")).toContain("leg");
  });

  test("migrateLegacySessionFile: false when nothing to migrate", async () => {
    expect(await migrateLegacySessionFile("default")).toBe(false);
  });

  test("rejects profile traversal before constructing a session path", () => {
    expect(() => cliSessionPath({ profile: "../outside" })).toThrow(CliSessionSecurityError);
    expect(() => cliSessionPath({ profile: ".active" })).toThrow(CliSessionSecurityError);
  });

  test("preserves existing Unicode and space profile names", async () => {
    const profile = "prod café west";
    await saveCliSession(sessionRow("unicode"), { profile });
    expect((await loadCliSession({ profile }))?.handle).toBe("unicode");
  });

  test("hardens an owned historical sessions directory instead of rejecting it", async () => {
    const r = rootDir();
    const sessions = join(r, "sessions");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    chmodSync(sessions, 0o755);
    await saveCliSession(sessionRow("hardened"), { profile: "prod" });
    expect((await stat(sessions)).mode & 0o777).toBe(0o700);
  });

  test("rejects a symlinked sessions parent during load", async () => {
    const r = rootDir();
    await mkdir(r, { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    symlinkSync("/tmp", join(r, "sessions"));
    expect(loadCliSession({ profile: "prod" })).rejects.toBeInstanceOf(CliSessionSecurityError);
  });

  test("refuses a symlinked session file", async () => {
    const r = rootDir();
    await mkdir(r, { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    symlinkSync("/tmp/not-a-session", join(r, "cli-session.json"));
    expect(loadCliSession()).rejects.toBeInstanceOf(CliSessionSecurityError);
  });

  test("clear removes an owned regular session even when its mode is insecure", async () => {
    await saveCliSession(sessionRow("clear-mode"));
    chmodSync(cliSessionPath(), 0o644);
    await clearCliSession();
    expect(existsSync(cliSessionPath())).toBe(false);
  });

  test("does not present malformed or schema-invalid session bytes as a missing login", async () => {
    const r = rootDir();
    await mkdir(r, { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    writeFileSync(cliSessionPath(), "{ malformed", { mode: 0o600 });
    chmodSync(cliSessionPath(), 0o600);
    expect(loadCliSession()).rejects.toBeInstanceOf(CliSessionSecurityError);
    writeFileSync(cliSessionPath(), "{}", { mode: 0o600 });
    chmodSync(cliSessionPath(), 0o600);
    expect(loadCliSession()).rejects.toBeInstanceOf(CliSessionSecurityError);
  });

  test("accepts an owned legacy root with compatible non-0700 mode", async () => {
    const r = rootDir();
    await mkdir(r, { recursive: true, mode: 0o700 });
    chmodSync(r, 0o755);
    await saveCliSession(sessionRow("root-compatible"));
    expect((await loadCliSession())?.handle).toBe("root-compatible");
  });

  test("fails closed instead of racing to reclaim a dead-owner lock", async () => {
    const r = rootDir();
    await mkdir(r, { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    const lock = join(r, "cli-session.json.lock");
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, nonce: "dead", createdAt: 1 }), { mode: 0o600 });
    chmodSync(lock, 0o600);
    expect(saveCliSession(sessionRow("blocked"))).rejects.toBeDefined();
    expect(readFileSync(lock, "utf8")).toContain('"dead"');
  });

  test("does not remove a lock owned by a live process", async () => {
    const r = rootDir();
    await mkdir(r, { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    const lock = join(r, "cli-session.json.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "live", createdAt: Date.now() }), { mode: 0o600 });
    chmodSync(lock, 0o600);
    expect(saveCliSession(sessionRow("blocked"))).rejects.toBeDefined();
    expect(readFileSync(lock, "utf8")).toContain('"live"');
  });

  test("serializes clear and save without leaving a lock or temporary file", async () => {
    await saveCliSession(sessionRow("before"));
    await Promise.all([clearCliSession(), saveCliSession(sessionRow("after"))]);
    const r = rootDir();
    const result = await loadCliSession();
    expect(result?.handle === "after" || result === null).toBe(true);
    expect(existsSync(join(r, "cli-session.json.lock"))).toBe(false);
  });

  test("compare-and-swap rotation refuses a stale opaque revision", async () => {
    const original = { ...sessionRow("rotate"), refreshToken: "refresh-a" };
    await saveCliSession(original, { profile: "default" });

    const loaded = await loadCliSession({ profile: "default" });
    expect(loaded?.revision).toBeDefined();
    const first = {
      ...original,
      accessToken: "access-b",
      refreshToken: "refresh-a",
    };
    expect(
      await saveCliSessionIfRevisionMatches(loaded?.revision, first, { profile: "default" }),
    ).toBe(true);

    const stale = {
      ...original,
      accessToken: "access-c",
      refreshToken: "refresh-c",
    };
    expect(
      await saveCliSessionIfRevisionMatches(loaded?.revision, stale, { profile: "default" }),
    ).toBe(false);
    expect((await loadCliSession({ profile: "default" }))?.refreshToken).toBe("refresh-a");
  });

  test("migration will not overwrite an existing legacy backup", async () => {
    const r = rootDir();
    await mkdir(r, { recursive: true, mode: 0o700 });
    chmodSync(r, 0o700);
    writeFileSync(join(r, "cli-session.json"), JSON.stringify(sessionRow("legacy")), { mode: 0o600 });
    chmodSync(join(r, "cli-session.json"), 0o600);
    writeFileSync(join(r, "cli-session.json.bak"), "existing", { mode: 0o600 });
    chmodSync(join(r, "cli-session.json.bak"), 0o600);
    expect(migrateLegacySessionFile("prod")).rejects.toBeInstanceOf(CliSessionSecurityError);
  });

  test("serializes a concurrent legacy save and migration without clobbering either session", async () => {
    const r = rootDir();
    const original = sessionRow("legacy-before");
    await saveCliSession(original);
    const concurrent = sessionRow("legacy-after");
    const [migrated] = await Promise.all([
      migrateLegacySessionFile("prod"),
      saveCliSession(concurrent),
    ]);
    const legacy = await loadCliSession();
    const profiled = await loadCliSession({ profile: "prod" });
    expect(migrated === true || migrated === false).toBe(true);
    expect(legacy?.handle === "legacy-after" || profiled?.handle === "legacy-after").toBe(true);
    expect(existsSync(join(r, "cli-session.json.lock"))).toBe(false);
    expect(existsSync(join(r, "sessions", "prod.json.lock"))).toBe(false);
  });
});
