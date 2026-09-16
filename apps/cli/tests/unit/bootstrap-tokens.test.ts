import { expect, test, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

test("writeBootstrapToken creates dir 0700 and file 0600; body has no trailing newline", () => {
  writeBootstrapToken("p1", "tokval", { home: fakeHome });
  const p = bootstrapTokenPath("p1", fakeHome);
  const d = dirname(p);
  expect(existsSync(p)).toBe(true);
  expect(statSync(d).mode & 0o777).toBe(0o700);
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(readFileSync(p, "utf8")).toBe("tokval");
});

test("readBootstrapToken round-trips; null for missing; null for empty file", () => {
  expect(readBootstrapToken("missing", { home: fakeHome })).toBe(null);
  mkdirSync(join(fakeHome, ".nautilo", "bootstrap-tokens"), { recursive: true, mode: 0o700 });
  const p = bootstrapTokenPath("empty", fakeHome);
  writeFileSync(p, "", { mode: 0o600 });
  chmodSync(p, 0o600);
  expect(readBootstrapToken("empty", { home: fakeHome })).toBe(null);
  writeBootstrapToken("x", "secret", { home: fakeHome });
  expect(readBootstrapToken("x", { home: fakeHome })).toBe("secret");
});

test("readBootstrapToken refuses 0644 on Unix", () => {
  if (process.platform === "win32") return;
  writeBootstrapToken("w", "v", { home: fakeHome });
  const p = bootstrapTokenPath("w", fakeHome);
  chmodSync(p, 0o644);
  expect(() => readBootstrapToken("w", { home: fakeHome })).toThrow(/chmod 600/);
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
