import { describe, expect, test } from "bun:test";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapDirForInstance,
  readBootstrapDir,
  writeBootstrapAdminPassword,
  writeBootstrapAdminPin,
  writeBootstrapClaimInvite,
  markBootstrapUsed,
  isBootstrapUsed,
  purgeBootstrapDir,
  listUnknownBootstrapFiles,
  BOOTSTRAP_FILE_ALLOWLIST,
} from "../../src/bootstrap-dir.ts";

describe("bootstrap-dir", () => {
  test("bootstrapDirForInstance(\"\") → <home>/.nautilo/.bootstrap", () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      expect(bootstrapDirForInstance("", { home })).toBe(join(home, ".nautilo", ".bootstrap"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('bootstrapDirForInstance("beta") → <home>/.nautilo-beta/.bootstrap', () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      expect(bootstrapDirForInstance("beta", { home })).toBe(join(home, ".nautilo-beta", ".bootstrap"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("round-trip writers and readers (password, pin, claim-invite)", () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      const dir = join(home, ".nautilo-x", ".bootstrap");
      writeBootstrapAdminPassword(dir, "secretpw");
      writeBootstrapAdminPin(dir, "123456");
      writeBootstrapClaimInvite(dir, "inv_abc123");
      const snap = readBootstrapDir(dir);
      expect(snap.adminPassword).toBe("secretpw");
      expect(snap.adminPin).toBe("123456");
      expect(snap.claimInvite).toBe("inv_abc123");
      expect(snap.used).toBe(false);
      expect(snap.usedAt).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("files are mode 0600; parent dir mode 0700", () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      const dir = join(home, ".nautilo-y", ".bootstrap");
      writeBootstrapAdminPassword(dir, "x");
      const parent = join(home, ".nautilo-y");
      expect(statSync(join(dir, "admin-password")).mode & 0o777).toBe(0o600);
      expect(statSync(parent).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("markBootstrapUsed is idempotent — second call preserves first stamp", () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      const dir = join(home, ".nautilo-z", ".bootstrap");
      const t0 = new Date("2020-01-02T03:04:05.000Z");
      markBootstrapUsed(dir, { now: t0 });
      markBootstrapUsed(dir, { now: new Date("2030-06-06T06:06:06.000Z") });
      const snap = readBootstrapDir(dir);
      expect(snap.used).toBe(true);
      // Bun's `readFileSync` overload typing trips `no-unsafe-call` here; body is UTF-8 text.
      const raw =
         
        readFileSync(join(dir, ".used")) as Buffer;
      const body = raw.toString("utf8").trim();
      expect(body).toBe(t0.toISOString());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("isBootstrapUsed: false on missing dir, false without .used, true when present", () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      const missing = join(home, ".nautilo-none", ".bootstrap");
      expect(isBootstrapUsed(missing)).toBe(false);
      const dir = join(home, ".nautilo-u", ".bootstrap");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      expect(isBootstrapUsed(dir)).toBe(false);
      markBootstrapUsed(dir);
      expect(isBootstrapUsed(dir)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("purgeBootstrapDir removes tree; reads are all-null + used:false", () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      const dir = join(home, ".nautilo-p", ".bootstrap");
      writeBootstrapAdminPin(dir, "999999");
      markBootstrapUsed(dir);
      purgeBootstrapDir(dir);
      expect(existsSync(dir)).toBe(false);
      expect(readBootstrapDir(dir)).toEqual({
        adminPassword: null,
        adminPin: null,
        claimInvite: null,
        used: false,
        usedAt: null,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("listUnknownBootstrapFiles reports hand-planted files; allowlist ignored", () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      const dir = join(home, ".nautilo-q", ".bootstrap");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "weird"), "x", { mode: 0o600 });
      for (const name of BOOTSTRAP_FILE_ALLOWLIST) {
        writeFileSync(join(dir, name), "v", { mode: 0o600 });
      }
      expect(listUnknownBootstrapFiles(dir)).toEqual(["weird"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("whitespace trimmed on write (roundtrip)", () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      const dir = join(home, ".nautilo-w", ".bootstrap");
      writeBootstrapClaimInvite(dir, "  inv_trimmed  \n");
      expect(readBootstrapDir(dir).claimInvite).toBe("inv_trimmed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("read returns null for empty files", () => {
    const home = mkdtempSync(join(tmpdir(), "nboot-"));
    try {
      const dir = join(home, ".nautilo-e", ".bootstrap");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "admin-password"), "   \n", { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(join(dir, "admin-password"), 0o600);
      expect(readBootstrapDir(dir).adminPassword).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
