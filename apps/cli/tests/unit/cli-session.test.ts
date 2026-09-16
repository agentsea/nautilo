import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCliSession,
  loadCliSession,
  requireSession,
  saveCliSession,
  CliSessionFileModeError,
  CliSessionExpiredError,
  CliSessionMissingError,
} from "@nautilo/api-client";

describe("cli-session store", () => {
  let dir: string;
  let prevInstance: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-cli-session-"));
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

  test("missing file → loadCliSession null", async () => {
    expect(await loadCliSession()).toBeNull();
  });

  test("atomic write + chmod 0600", async () => {
    const row = {
      schemaVersion: 1 as const,
      instanceId: "i1",
      serverUrl: "http://127.0.0.1:8080",
      handle: "alice",
      displayName: "Alice",
      externalId: "sub",
      accessToken: "at",
      tokenType: "Bearer" as const,
      expiresAt: Date.now() + 86_400_000,
      scopes: [] as string[],
      source: "password" as const,
      obtainedAt: Date.now(),
    };
    await saveCliSession(row);
    const st = await import("node:fs/promises").then((fs) => fs.stat(join(dir, ".nautilo", "cli-session.json")));
    expect(st.mode & 0o777).toBe(0o600);
    const loaded = await loadCliSession();
    expect(loaded?.handle).toBe("alice");
  });

  test("concurrent writes use unique temp files and do not leak ENOENT races", async () => {
    const base = {
      schemaVersion: 1 as const,
      instanceId: "i1",
      serverUrl: "http://127.0.0.1:8080",
      displayName: "Alice",
      externalId: "sub",
      accessToken: "at",
      tokenType: "Bearer" as const,
      expiresAt: Date.now() + 86_400_000,
      scopes: [] as string[],
      source: "password" as const,
      obtainedAt: Date.now(),
    };

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        saveCliSession({
          ...base,
          handle: `alice-${i}`,
          obtainedAt: Date.now() + i,
        }),
      ),
    );

    const sessionDir = join(dir, ".nautilo");
    const tmpFiles = readdirSync(sessionDir).filter((name) =>
      name.startsWith(".cli-session.json.") && name.endsWith(".tmp"),
    );
    expect(tmpFiles).toEqual([]);

    const loaded = await loadCliSession();
    expect(loaded?.handle.startsWith("alice-")).toBe(true);
  });

  test("refuse overwrite when mode !== 0600", async () => {
    const base = join(dir, ".nautilo");
    const path = join(base, "cli-session.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(base, { recursive: true });
    writeFileSync(path, "{}", "utf-8");
    chmodSync(path, 0o644);
    expect(
      saveCliSession({
        schemaVersion: 1,
        instanceId: "i1",
        serverUrl: "http://127.0.0.1:8080",
        handle: "alice",
        displayName: "Alice",
        externalId: "sub",
        accessToken: "at",
        tokenType: "Bearer",
        expiresAt: Date.now() + 86_400_000,
        scopes: [],
        source: "password",
        obtainedAt: Date.now(),
      }),
    ).rejects.toBeInstanceOf(CliSessionFileModeError);
  });

  test("requireSession throws when expired", async () => {
    await saveCliSession({
      schemaVersion: 1,
      instanceId: "i1",
      serverUrl: "http://127.0.0.1:8080",
      handle: "alice",
      displayName: "Alice",
      externalId: "sub",
      accessToken: "at",
      tokenType: "Bearer",
      expiresAt: Date.now() - 1000,
      scopes: [],
      source: "password",
      obtainedAt: Date.now(),
    });
    expect(requireSession()).rejects.toBeInstanceOf(CliSessionExpiredError);
  });

  test("requireSession throws when absent", async () => {
    expect(requireSession()).rejects.toBeInstanceOf(CliSessionMissingError);
  });

  test("clearCliSession is idempotent", async () => {
    await clearCliSession();
    await clearCliSession();
    expect(await loadCliSession()).toBeNull();
  });
});
