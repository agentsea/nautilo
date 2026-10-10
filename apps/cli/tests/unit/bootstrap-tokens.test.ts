import { expect, test, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { isPrivateFilesystemPath, writePrivateFileExclusiveSync } from "@nautilo/config/private-filesystem";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootstrapTokenPath,
  deleteBootstrapToken,
  readBootstrapToken,
  writeBootstrapToken,
} from "../../src/lib/bootstrap-tokens.ts";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "nautilo-bt-"));
});

afterEach(() => {
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test("bootstrapTokenPath resolves under <home>/.nautilo/bootstrap-tokens/<name>", () => {
  const p = bootstrapTokenPath("demo", fakeHome);
  expect(p).toBe(join(fakeHome, ".nautilo", "bootstrap-tokens", "demo"));
  expect(dirname(p)).toBe(join(fakeHome, ".nautilo", "bootstrap-tokens"));
});

test("writeBootstrapToken creates an owner-private directory and file without a trailing newline", () => {
  writeBootstrapToken("p1", "tokval", { home: fakeHome });
  const p = bootstrapTokenPath("p1", fakeHome);
  const d = dirname(p);
  expect(existsSync(p)).toBe(true);
  expect(isPrivateFilesystemPath(d)).toBe(true);
  expect(isPrivateFilesystemPath(p)).toBe(true);
  expect(readFileSync(p, "utf8")).toBe("tokval");
});

test("readBootstrapToken round-trips; null for missing; null for empty file", () => {
  expect(readBootstrapToken("missing", { home: fakeHome })).toBe(null);
  mkdirSync(join(fakeHome, ".nautilo", "bootstrap-tokens"), { recursive: true, mode: 0o700 });
  const p = bootstrapTokenPath("empty", fakeHome);
  writePrivateFileExclusiveSync(p, Buffer.alloc(0));
  expect(readBootstrapToken("empty", { home: fakeHome })).toBe(null);
  writeBootstrapToken("x", "secret", { home: fakeHome });
  expect(readBootstrapToken("x", { home: fakeHome })).toBe("secret");
});

test("readBootstrapToken refuses a token readable by other users", () => {
  writeBootstrapToken("w", "v", { home: fakeHome });
  const p = bootstrapTokenPath("w", fakeHome);
  if (process.platform === "win32") {
    const icacls = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
    const result = spawnSync(icacls, [p, "/grant", "*S-1-1-0:R"], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
  } else chmodSync(p, 0o644);
  expect(isPrivateFilesystemPath(p)).toBe(false);
  expect(() => readBootstrapToken("w", { home: fakeHome })).toThrow(/owner-only/);
  expect(readFileSync(p, "utf8")).toBe("v");
});

test("deleteBootstrapToken is idempotent", () => {
  writeBootstrapToken("d", "t", { home: fakeHome });
  const p = bootstrapTokenPath("d", fakeHome);
  expect(existsSync(p)).toBe(true);
  deleteBootstrapToken("d", { home: fakeHome });
  expect(existsSync(p)).toBe(false);
  deleteBootstrapToken("d", { home: fakeHome });
  deleteBootstrapToken("nope", { home: fakeHome });
});
