import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readlinkSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirectoryTree } from "../../src/ensure-directory-tree";
import { fromRuntimeConfig } from "../../src/config";
import { resolveNautiloRuntimePaths } from "../../src/runtime-paths";

function makeTempHome(): string {
  const path = join(tmpdir(), `nautilo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function nautiloRoot(fakeHome: string): string {
  return join(fakeHome, ".nautilo");
}

describe("ensureDirectoryTree", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = makeTempHome();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("creates every zone directory on a fresh root (four zones, no inbox)", async () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);

    // home zone
    expect(existsSync(paths.homeRootDir)).toBe(true);
    expect(existsSync(paths.workspaceDir)).toBe(true);
    expect(existsSync(paths.researchDir)).toBe(true);
    expect(existsSync(paths.notesDir)).toBe(true);
    expect(existsSync(paths.exportsDir)).toBe(true);
    expect(existsSync(paths.logsDir)).toBe(true);
    expect(existsSync(paths.transcriptsDir)).toBe(true);

    // scratch is SIBLING of home
    expect(existsSync(paths.scratchDir)).toBe(true);
    expect(paths.scratchDir.startsWith(paths.homeRootDir)).toBe(false);

    // data, vault
    expect(existsSync(paths.dataDir)).toBe(true);
    expect(existsSync(paths.dbDataDir)).toBe(true);
    expect(existsSync(paths.embeddingsDir)).toBe(true);
    expect(existsSync(paths.voiceCacheDir)).toBe(true);
    expect(existsSync(paths.audioCacheDir)).toBe(true);
    expect(existsSync(paths.vaultDir)).toBe(true);

    // certs
    expect(existsSync(paths.certsDir)).toBe(true);

    // NO inbox — post-pivot
    expect(existsSync(join(paths.rootDir, "inbox"))).toBe(false);
  });

  test("seeds .gitignore in scratch/ and data/ only (no inbox)", async () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);

    for (const dir of [paths.scratchDir, paths.dataDir]) {
      const gitignore = join(dir, ".gitignore");
      expect(existsSync(gitignore)).toBe(true);
      const contents = await readFile(gitignore, "utf8");
      expect(contents).toBe("*\n!.gitignore\n");
    }
  });

  test("is idempotent (safe to call twice)", async () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);
    await ensureDirectoryTree(paths);

    expect(existsSync(paths.scratchDir)).toBe(true);
  });

  test("writes migration marker inside data/", async () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);
    const marker = join(paths.dataDir, ".migrated-v049");
    expect(existsSync(marker)).toBe(true);
  });
});

describe("migrateStorageLayout (via ensureDirectoryTree)", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = makeTempHome();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("moves home/scratch/* → scratch/* on first boot", async () => {
    const nr = nautiloRoot(fakeHome);
    const oldScratch = join(nr, "home", "scratch");
    mkdirSync(oldScratch, { recursive: true });
    writeFileSync(join(oldScratch, "leftover.txt"), "hello");

    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);

    expect(existsSync(join(paths.scratchDir, "leftover.txt"))).toBe(true);

    // Compat symlink at old location should point to new scratch.
    const oldScratchStat = lstatSync(oldScratch);
    expect(oldScratchStat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(oldScratch)).toBe(paths.scratchDir);
  });

  test("moves root-level voice-previews/ → data/voice-previews/", async () => {
    const nr = nautiloRoot(fakeHome);
    const oldVoices = join(nr, "voice-previews");
    mkdirSync(oldVoices, { recursive: true });
    writeFileSync(join(oldVoices, "carolyn.mp3"), "fake-audio");

    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);

    expect(existsSync(join(paths.voiceCacheDir, "carolyn.mp3"))).toBe(true);
    expect(existsSync(oldVoices)).toBe(false);
  });

  test("moves root-level audio/ → data/audio/", async () => {
    const nr = nautiloRoot(fakeHome);
    const oldAudio = join(nr, "audio");
    mkdirSync(oldAudio, { recursive: true });
    writeFileSync(join(oldAudio, "tts-1.mp3"), "fake-audio");

    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);

    expect(existsSync(join(paths.audioCacheDir, "tts-1.mp3"))).toBe(true);
    expect(existsSync(oldAudio)).toBe(false);
  });

  test("does not re-run migration after marker is present", async () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);

    // Plant a fake old-layout dir AFTER migration happened.
    const oldScratch = join(paths.rootDir, "home", "scratch");
    mkdirSync(oldScratch, { recursive: true });
    writeFileSync(join(oldScratch, "post-marker.txt"), "should not move");

    await ensureDirectoryTree(paths);

    expect(existsSync(join(oldScratch, "post-marker.txt"))).toBe(true);
    expect(existsSync(join(paths.scratchDir, "post-marker.txt"))).toBe(false);
  });

  test("skips migration (does not clobber) when destination has content", async () => {
    const nr = nautiloRoot(fakeHome);
    const oldScratch = join(nr, "home", "scratch");
    mkdirSync(oldScratch, { recursive: true });
    writeFileSync(join(oldScratch, "old-file.txt"), "OLD");

    const newScratch = join(nr, "scratch");
    mkdirSync(newScratch, { recursive: true });
    writeFileSync(join(newScratch, "new-file.txt"), "NEW");

    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);

    // Both files still exist at their original locations.
    expect(existsSync(join(oldScratch, "old-file.txt"))).toBe(true);
    expect(existsSync(join(newScratch, "new-file.txt"))).toBe(true);

    // No compat symlink (old path is a real dir, not a symlink).
    const oldStat = lstatSync(oldScratch);
    expect(oldStat.isSymbolicLink()).toBe(false);

    // Migration marker IS written.
    expect(existsSync(join(paths.dataDir, ".migrated-v049"))).toBe(true);
  });

  test("leaves legacy pre-pivot inbox/ untouched (non-destructive)", async () => {
    const nr = nautiloRoot(fakeHome);
    const legacyInbox = join(nr, "inbox");
    mkdirSync(legacyInbox, { recursive: true });
    writeFileSync(join(legacyInbox, "user-dropped.txt"), "USER FILE");

    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: fakeHome,
    });

    await ensureDirectoryTree(paths);

    // The legacy directory + its contents are preserved.
    expect(existsSync(legacyInbox)).toBe(true);
    expect(existsSync(join(legacyInbox, "user-dropped.txt"))).toBe(true);
  });
});
