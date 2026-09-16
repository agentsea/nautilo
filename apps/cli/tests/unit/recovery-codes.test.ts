import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NautiloApiClient, saveCliSession } from "@nautilo/api-client";
import type { CommandModule } from "yargs";

async function loadRecoveryModule(): Promise<{ recoveryCodesModule: CommandModule }> {
  return import(`../../src/commands/recovery-codes.ts?t=${Date.now()}`) as Promise<{
    recoveryCodesModule: CommandModule;
  }>;
}

describe("nautilo recovery-codes", () => {
  let dir: string;
  const originalIsTty = process.stdin.isTTY;

  beforeEach(() => {
    process.exitCode = undefined;
    dir = mkdtempSync(join(tmpdir(), "nautilo-rc-"));
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTty, configurable: true });
    delete process.env["NAUTILO_HOME_OVERRIDE"];
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  test("status human prints configured line", async () => {
    await saveCliSession({
      schemaVersion: 1,
      instanceId: "i",
      serverUrl: "http://127.0.0.1:8",
      handle: "a",
      displayName: "A",
      externalId: "s",
      accessToken: "tok",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      scopes: [],
      source: "device",
      obtainedAt: Date.now(),
    });
    const spy = spyOn(NautiloApiClient.prototype, "getLogtoRecoveryCodeStatus").mockResolvedValue({
      remaining: 3,
      total: 5,
      lastGeneratedAt: "2020-01-01T00:00:00.000Z",
    });
    const { recoveryCodesModule } = await loadRecoveryModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "recovery-codes", "status", "--server", "http://127.0.0.1:8"]),
      )
        .command(recoveryCodesModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain("configured");
    expect(out).toContain("3 of 5");
  });

  test("status json is parseable", async () => {
    await saveCliSession({
      schemaVersion: 1,
      instanceId: "i",
      serverUrl: "http://127.0.0.1:8",
      handle: "a",
      displayName: "A",
      externalId: "s",
      accessToken: "tok",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      scopes: [],
      source: "device",
      obtainedAt: Date.now(),
    });
    const spy = spyOn(NautiloApiClient.prototype, "getLogtoRecoveryCodeStatus").mockResolvedValue({
      remaining: 2,
      total: 4,
      lastGeneratedAt: null,
    });
    const { recoveryCodesModule } = await loadRecoveryModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin([
          "node",
          "nautilo",
          "recovery-codes",
          "status",
          "--format",
          "json",
          "--server",
          "http://127.0.0.1:8",
        ]),
      )
        .command(recoveryCodesModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    const j = JSON.parse(out.trim()) as { remaining: number; total: number };
    expect(j.remaining).toBe(2);
    expect(j.total).toBe(4);
  });

  test("regenerate --yes human lists each code", async () => {
    await saveCliSession({
      schemaVersion: 1,
      instanceId: "i",
      serverUrl: "http://127.0.0.1:8",
      handle: "a",
      displayName: "A",
      externalId: "s",
      accessToken: "tok",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      scopes: [],
      source: "device",
      obtainedAt: Date.now(),
    });
    const spy = spyOn(NautiloApiClient.prototype, "regenerateLogtoRecoveryCodes").mockResolvedValue({
      recoveryCodes: ["aaa", "bbb"],
    });
    const { recoveryCodesModule } = await loadRecoveryModule();
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin([
          "node",
          "nautilo",
          "recovery-codes",
          "regenerate",
          "--yes",
          "--server",
          "http://127.0.0.1:8",
        ]),
      )
        .command(recoveryCodesModule)
        .parseAsync();
    } finally {
      process.stdout.write = ow;
      spy.mockRestore();
    }
    expect(out).toContain("1. aaa");
    expect(out).toContain("2. bbb");
  });

  test("regenerate without --yes on non-TTY refuses", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await saveCliSession({
      schemaVersion: 1,
      instanceId: "i",
      serverUrl: "http://127.0.0.1:8",
      handle: "a",
      displayName: "A",
      externalId: "s",
      accessToken: "tok",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      scopes: [],
      source: "device",
      obtainedAt: Date.now(),
    });
    const { recoveryCodesModule } = await loadRecoveryModule();
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "recovery-codes", "regenerate", "--server", "http://127.0.0.1:8"]),
      )
        .command(recoveryCodesModule)
        .parseAsync();
    } finally {
      process.stderr.write = ew;
    }
    expect(process.exitCode).toBe(2);
    expect(err).toContain("Refusing to regenerate");
  });

  test("no session exits 2 with login hint", async () => {
    const { recoveryCodesModule } = await loadRecoveryModule();
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const yargs = (await import("yargs/yargs")).default;
    const { hideBin } = await import("yargs/helpers");
    try {
      await yargs(
        hideBin(["node", "nautilo", "recovery-codes", "status", "--server", "http://127.0.0.1:8"]),
      )
        .command(recoveryCodesModule)
        .parseAsync();
    } finally {
      process.stderr.write = ew;
    }
    expect(process.exitCode).toBe(2);
    expect(err).toContain("login");
  });
});
