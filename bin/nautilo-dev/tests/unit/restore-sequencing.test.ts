import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { clearHomeForRestore, extractHomeArchivePreservingProtection } from "../../src/commands/restore";

/**
 * Regression test for the restore.ts sequencing bug that was discovered
 * April 24 2026.
 *
 * Bug: restore.ts wrote config.env FIRST, then wiped ~/.nautilo except
 * dev-snapshots. The wipe deleted the config.env that had just been
 * written, leaving the restored system with no config.env at all.
 *
 * Fix: home-dir tar extract runs BEFORE the .env restore, so the wipe
 * can never touch the file we're about to write.
 *
 * We assert on the source order — a lexical check is sufficient because
 * the semantic ordering is entirely driven by top-to-bottom sequence in
 * the command handler, and running a full live restore in unit tests
 * would require a Postgres container.
 */
describe("restore.ts — sequencing guard (regression)", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "..", "src", "commands", "restore.ts"),
    "utf8",
  );

  test("home-dir restore ('Restoring ~/.nautilo...') runs BEFORE the .env restore ('.env restored.')", () => {
    const homeIdx = src.indexOf("Restoring ~/.nautilo...");
    const envIdx = src.indexOf(".env restored.");
    expect(homeIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(-1);
    expect(homeIdx).toBeLessThan(envIdx);
  });

  test("the home-dir wipe uses 'except dev-snapshots' exclusion (auto-save survives rollback)", () => {
    // Without this exclusion the auto-save snapshot we just took
    // would itself be wiped, making rollback impossible.
    expect(src).toContain('entry === "dev-snapshots" || entry === ".protected-instance" || entry === "profiles"');
  });

  test("preserves the target instance identity while extracting a source home archive", () => {
    expect(src).toContain('const instanceJsonPath = join(nautiloHome, "instance.json")');
    expect(src).toContain("const targetInstanceJson = existsSync(instanceJsonPath)");
    expect(src).toContain("await writeFile(instanceJsonPath, targetInstanceJson)");
  });

  test("preserves the target marker inode even when an unrelated removal fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-restore-marker-"));
    try {
      const marker = join(home, ".protected-instance");
      writeFileSync(marker, "protected-by=operator\n", { mode: 0o600 });
      const profiles = join(home, "profiles");
      mkdirSync(profiles);
      writeFileSync(join(profiles, "kept.toml"), 'retention = "durable"\n');
      writeFileSync(join(home, "other"), "data");
      const inode = statSync(marker).ino;
      const profilesInode = statSync(profiles).ino;
      let error: unknown;
      try {
        await clearHomeForRestore(home, async () => { throw new Error("injected removal failure"); });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("injected removal failure");
      expect(statSync(marker).ino).toBe(inode);
      expect(readFileSync(marker, "utf8")).toBe("protected-by=operator\n");
      const archiveRoot = join(home, "archive-source");
      mkdirSync(archiveRoot);
      writeFileSync(join(archiveRoot, ".protected-instance"), "untrusted-source-marker\n");
      mkdirSync(join(archiveRoot, "profiles"));
      writeFileSync(join(archiveRoot, "profiles", "kept.toml"), 'retention = "disposable"\n');
      writeFileSync(join(archiveRoot, "restored"), "payload\n");
      const archive = join(home, "source.tgz");
      expect(spawnSync("tar", ["czf", archive, "-C", archiveRoot, "."]).status).toBe(0);
      extractHomeArchivePreservingProtection(archive, home);
      expect(statSync(marker).ino).toBe(inode);
      expect(readFileSync(marker, "utf8")).toBe("protected-by=operator\n");
      expect(statSync(profiles).ino).toBe(profilesInode);
      expect(readFileSync(join(profiles, "kept.toml"), "utf8")).toBe('retention = "durable"\n');
      expect(readFileSync(join(home, "restored"), "utf8")).toBe("payload\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a linked protection marker before removing home entries", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-restore-linked-marker-"));
    try {
      const outside = join(home, "outside");
      writeFileSync(outside, "protected-by=operator\n");
      symlinkSync(outside, join(home, ".protected-instance"));
      mkdirSync(join(home, "kept"));
      let error: unknown;
      try {
        await clearHomeForRestore(home);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("non-regular protected-instance marker");
      expect(existsSync(join(home, "kept"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("auto-save runs BEFORE any destructive action (DB drop, home-dir wipe, env write)", () => {
    // Anchor on the BLOCK comment for the auto-save step — that is
    // the first place a destructive action gets guarded, and it stays
    // stable across minor edits to the handler.
    const autoIdx = src.indexOf("0. Auto-save");
    const dbStepIdx = src.indexOf("1. Database");
    const homeStepIdx = src.indexOf("2. ~/.nautilo/ home dir");
    const envStepIdx = src.indexOf("3. .env");

    expect(autoIdx).toBeGreaterThan(-1);
    expect(dbStepIdx).toBeGreaterThan(autoIdx);
    expect(homeStepIdx).toBeGreaterThan(autoIdx);
    expect(envStepIdx).toBeGreaterThan(autoIdx);
    // And the order of the destructive steps is DB → home → env.
    expect(homeStepIdx).toBeGreaterThan(dbStepIdx);
    expect(envStepIdx).toBeGreaterThan(homeStepIdx);
  });

  test("auto-save can be disabled via --no-autosave", () => {
    expect(src).toContain("options.noAutosave");
    expect(src).toContain("--no-autosave");
  });

  test("auto-save failure is a HARD STOP — never proceeds without the undo path by default", () => {
    expect(src).toContain("Refusing to restore");
    expect(src).toContain("process.exit(1)");
  });
});
