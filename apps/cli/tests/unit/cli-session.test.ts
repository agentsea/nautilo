import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rejects } from "node:assert/strict";
import { isPrivateFilesystemPathAsync } from "@nautilo/config/private-filesystem";
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
  let prevOverride: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-cli-session-"));
    prevOverride = process.env["NAUTILO_HOME_OVERRIDE"];
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;
    prevInstance = process.env["NAUTILO_INSTANCE_ID"];
    delete process.env["NAUTILO_INSTANCE_ID"];
  });
  afterEach(() => {
    if (prevOverride === undefined) delete process.env["NAUTILO_HOME_OVERRIDE"];
    else process.env["NAUTILO_HOME_OVERRIDE"] = prevOverride;
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

  test("atomic write with private permissions", async () => {
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
    expect(await isPrivateFilesystemPathAsync(join(dir, ".nautilo", "cli-session.json"))).toBe(true);
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

  test("refuses to overwrite a non-private credential file", async () => {
    const base = join(dir, ".nautilo");
    const path = join(base, "cli-session.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(base, { recursive: true });
    writeFileSync(path, "{}", "utf-8");
    if (process.platform === "win32") {
      const icacls = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
      const result = spawnSync(icacls, [path, "/grant", "*S-1-1-0:R"], { encoding: "utf8", windowsHide: true });
      expect(result.status, result.stderr).toBe(0);
    } else chmodSync(path, 0o644);
    await rejects(
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
      CliSessionFileModeError,
    );
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
    await rejects(requireSession(), CliSessionExpiredError);
  });

  test("requireSession throws when absent", async () => {
    await rejects(requireSession(), CliSessionMissingError);
  });

  test("clearCliSession is idempotent", async () => {
    await clearCliSession();
    await clearCliSession();
    expect(await loadCliSession()).toBeNull();
  });
});
