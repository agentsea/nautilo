import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCliSession } from "@nautilo/api-client";
import { cliSessionPath } from "@nautilo/api-client";
import { setActiveProfileResolver } from "../../src/lib/cli-session.ts";
import { readActiveProfileName } from "../../src/lib/profile-aware-server.ts";
import { logoutModule } from "../../src/commands/logout.ts";

describe("nautilo logout", () => {
  let dir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    process.exitCode = undefined;
    dir = mkdtempSync(join(tmpdir(), "nautilo-logout-"));
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;
    savedHome = process.env["HOME"];
    process.env["HOME"] = dir;
    setActiveProfileResolver(() => readActiveProfileName());
  });
  afterEach(() => {
    process.exitCode = undefined;
    setActiveProfileResolver(null);
    if (savedHome !== undefined) {
      process.env["HOME"] = savedHome;
    } else {
      delete process.env["HOME"];
    }
    delete process.env["NAUTILO_HOME_OVERRIDE"];
    rmSync(dir, { recursive: true, force: true });
  });

  test("idempotent no session", async () => {
    let out = "";
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (logoutModule.handler as (args: unknown) => Promise<void>)({});
    } finally {
      process.stdout.write = w;
    }
    expect(out).toContain("No active session.");
    expect(process.exitCode).toBe(0);
  });

  test("clears session and prints Signed out", async () => {
    await saveCliSession({
      schemaVersion: 1,
      instanceId: "i",
      serverUrl: "http://127.0.0.1:9",
      handle: "a",
      displayName: "A",
      externalId: "s",
      accessToken: "t",
      tokenType: "Bearer",
      expiresAt: Date.now() + 60_000,
      scopes: [],
      source: "token",
      obtainedAt: Date.now(),
    });
    let out = "";
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (logoutModule.handler as (args: unknown) => Promise<void>)({});
    } finally {
      process.stdout.write = w;
    }
    expect(out).toContain("Signed out.");
  });

  test("prints profile name when ~/.nautilo/profiles/.active exists", async () => {
    const profiles = join(dir, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, ".active"), "prod\n");
    await saveCliSession(
      {
        schemaVersion: 1,
        instanceId: "i",
        serverUrl: "http://127.0.0.1:9",
        handle: "a",
        displayName: "A",
        externalId: "s",
        accessToken: "t",
        tokenType: "Bearer",
        expiresAt: Date.now() + 60_000,
        scopes: [],
        source: "token",
        obtainedAt: Date.now(),
      },
      { profile: "prod" },
    );
    let out = "";
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (logoutModule.handler as (args: unknown) => Promise<void>)({});
    } finally {
      process.stdout.write = w;
    }
    expect(out).toContain("Signed out from prod.");
  });

  test("removes an owned session whose file mode became insecure", async () => {
    await saveCliSession({
      schemaVersion: 1, instanceId: "i", serverUrl: "http://127.0.0.1:9",
      handle: "a", displayName: "A", externalId: "s", accessToken: "t", tokenType: "Bearer",
      expiresAt: Date.now() + 60_000, scopes: [], source: "token", obtainedAt: Date.now(),
    });
    chmodSync(cliSessionPath(), 0o644);
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (value: string | Uint8Array) => {
      out += typeof value === "string" ? value : Buffer.from(value).toString();
      return true;
    };
    try {
      await (logoutModule.handler as (args: unknown) => Promise<void>)({ format: "json" });
    } finally {
      process.stdout.write = write;
    }
    expect(process.exitCode).toBe(0);
    expect(out).toContain('"insecureMode":true');
    expect(() => writeFileSync(cliSessionPath(), "x", { flag: "wx" })).not.toThrow();
  });
});
