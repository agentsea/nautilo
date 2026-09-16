import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getOrCreateToken, rotateToken, readPersistedToken, maskToken } from "../../src/token";

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "nautilo-smoke-token-"));
});

afterEach(() => {
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

describe("token: getOrCreateToken", () => {
  test("generates + persists a fresh token when file doesn't exist", () => {
    const t = getOrCreateToken({ home: sandbox, envOverride: null });
    expect(t).toMatch(/^nsk_[0-9a-f]{64}$/);

    const tokenPath = join(sandbox, ".nautilo", "smoke-token");
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(t);
  });

  test("persisted file has 0600 permissions", () => {
    getOrCreateToken({ home: sandbox, envOverride: null });
    const tokenPath = join(sandbox, ".nautilo", "smoke-token");
    const mode = statSync(tokenPath).mode & 0o777;
    // 0600 on any POSIX filesystem. Test is skipped-by-implication on
    // filesystems that don't honor mode (Windows / some FUSE mounts).
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  test("reuses existing token on subsequent calls", () => {
    const first = getOrCreateToken({ home: sandbox, envOverride: null });
    const second = getOrCreateToken({ home: sandbox, envOverride: null });
    expect(second).toBe(first);
  });

  test("env override takes precedence over file", () => {
    // Pre-populate the file with one token…
    mkdirSync(join(sandbox, ".nautilo"), { recursive: true });
    writeFileSync(join(sandbox, ".nautilo", "smoke-token"), "nsk_persistedfromfile", { encoding: "utf8" });
    // …then ask with an env override.
    const t = getOrCreateToken({ home: sandbox, envOverride: "nsk_fromenv" });
    expect(t).toBe("nsk_fromenv");
    // File is unchanged.
    expect(readFileSync(join(sandbox, ".nautilo", "smoke-token"), "utf8").trim()).toBe("nsk_persistedfromfile");
  });

  test("empty env override falls through to file", () => {
    mkdirSync(join(sandbox, ".nautilo"), { recursive: true });
    writeFileSync(join(sandbox, ".nautilo", "smoke-token"), "nsk_fromfile", { encoding: "utf8" });
    const t = getOrCreateToken({ home: sandbox, envOverride: "" });
    expect(t).toBe("nsk_fromfile");
  });

  test("empty file is treated as missing (regenerated)", () => {
    mkdirSync(join(sandbox, ".nautilo"), { recursive: true });
    writeFileSync(join(sandbox, ".nautilo", "smoke-token"), "", { encoding: "utf8" });
    const t = getOrCreateToken({ home: sandbox, envOverride: null });
    expect(t).toMatch(/^nsk_[0-9a-f]{64}$/);
  });
});

describe("token: rotateToken", () => {
  test("overwrites the file with a new token", () => {
    const first = getOrCreateToken({ home: sandbox, envOverride: null });
    const rotated = rotateToken({ home: sandbox });
    expect(rotated).not.toBe(first);
    expect(rotated).toMatch(/^nsk_[0-9a-f]{64}$/);

    const onDisk = readFileSync(join(sandbox, ".nautilo", "smoke-token"), "utf8").trim();
    expect(onDisk).toBe(rotated);
  });

  test("works even when no token existed previously", () => {
    const t = rotateToken({ home: sandbox });
    expect(t).toMatch(/^nsk_[0-9a-f]{64}$/);
    expect(readPersistedToken({ home: sandbox })).toBe(t);
  });
});

describe("token: readPersistedToken", () => {
  test("returns null when file absent", () => {
    expect(readPersistedToken({ home: sandbox })).toBeNull();
  });

  test("returns the trimmed file contents when present", () => {
    mkdirSync(join(sandbox, ".nautilo"), { recursive: true });
    writeFileSync(join(sandbox, ".nautilo", "smoke-token"), "nsk_xyz\n", { encoding: "utf8" });
    expect(readPersistedToken({ home: sandbox })).toBe("nsk_xyz");
  });

  test("returns null when file is empty-after-trim", () => {
    mkdirSync(join(sandbox, ".nautilo"), { recursive: true });
    writeFileSync(join(sandbox, ".nautilo", "smoke-token"), "   \n", { encoding: "utf8" });
    expect(readPersistedToken({ home: sandbox })).toBeNull();
  });
});

describe("token: maskToken", () => {
  test("redacts middle chars, preserves prefix + last 4", () => {
    const t = "nsk_" + "a".repeat(60) + "b".repeat(4);
    const masked = maskToken(t);
    expect(masked.startsWith("nsk_")).toBe(true);
    expect(masked).toContain("…");
    expect(masked.endsWith("bbbb")).toBe(true);
    expect(masked.length).toBeLessThan(t.length);
  });

  test("returns [malformed] for implausibly short tokens", () => {
    expect(maskToken("abc")).toBe("[malformed]");
  });
});
