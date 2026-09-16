/* eslint-disable @typescript-eslint/await-thenable -- Bun's test runner makes `.rejects` thenable; the lint rule doesn't model this. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageProvider } from "../../src/local-storage-provider";
import {
  StorageError,
  StorageNotFoundError,
  StoragePathTraversalError,
} from "../../src/storage-provider";

function makeRoot(): string {
  const path = join(
    tmpdir(),
    `lsp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

describe("LocalStorageProvider — construction", () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects non-absolute rootPath", () => {
    expect(() => new LocalStorageProvider("home", "relative/path")).toThrow(
      /rootPath must be absolute/,
    );
  });

  test("records zone, rootPath (canonical), and namespace", () => {
    const p = new LocalStorageProvider("scratch", root, "user-42");
    expect(p.zone).toBe("scratch");
    // macOS /var/folders → /private/var/folders. Compare against the
    // canonical form.
    expect(p.rootPath).toBe(realpathSync(root));
    expect(p.namespace).toBe("user-42");
  });

  test("namespace is undefined when not provided", () => {
    const p = new LocalStorageProvider("home", root);
    expect(p.namespace).toBeUndefined();
  });
});

describe("LocalStorageProvider — path safety", () => {
  let root: string;
  let provider: LocalStorageProvider;

  beforeEach(() => {
    root = makeRoot();
    provider = new LocalStorageProvider("home", root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects null bytes", async () => {
    await expect(provider.write("poison\x00.txt", "x")).rejects.toBeInstanceOf(
      StoragePathTraversalError,
    );
  });

  test("rejects absolute paths", async () => {
    await expect(provider.read("/etc/passwd")).rejects.toBeInstanceOf(
      StoragePathTraversalError,
    );
  });

  test("rejects `..` traversal", async () => {
    await expect(provider.read("../etc/passwd")).rejects.toBeInstanceOf(
      StoragePathTraversalError,
    );
    await expect(
      provider.read("subdir/../../outside.txt"),
    ).rejects.toBeInstanceOf(StoragePathTraversalError);
  });

  test("rejects sibling-prefix attacks", async () => {
    // `root` might be /tmp/lsp-test-XYZ. A path like "../lsp-test-XYZ-evil"
    // would land in a sibling of the zone root — must be rejected.
    await expect(
      provider.read("../lsp-test-sibling/file.txt"),
    ).rejects.toBeInstanceOf(StoragePathTraversalError);
  });

  test("rejects symlinks that escape the zone root", async () => {
    const outside = makeRoot();
    try {
      writeFileSync(join(outside, "secret.txt"), "classified");
      symlinkSync(join(outside, "secret.txt"), join(root, "escape-link.txt"));

      await expect(provider.read("escape-link.txt")).rejects.toBeInstanceOf(
        StoragePathTraversalError,
      );
      await expect(provider.readText("escape-link.txt")).rejects.toBeInstanceOf(
        StoragePathTraversalError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("write-through-symlink: refuses to write to a pre-planted escape symlink", async () => {
    const outside = makeRoot();
    try {
      const victim = join(outside, "target.txt");
      writeFileSync(victim, "original-content");
      symlinkSync(victim, join(root, "planted-link.txt"));

      await expect(
        provider.write("planted-link.txt", "ATTACKER-CONTROLLED"),
      ).rejects.toBeInstanceOf(StoragePathTraversalError);

      // Target is untouched.
      const contents = await import("node:fs/promises").then((m) =>
        m.readFile(victim, "utf8"),
      );
      expect(contents).toBe("original-content");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("write-through-symlink: refuses when an ANCESTOR directory is a link out of zone", async () => {
    const outside = makeRoot();
    try {
      symlinkSync(outside, join(root, "drafts"));

      await expect(
        provider.write("drafts/new-note.md", "escape"),
      ).rejects.toBeInstanceOf(StoragePathTraversalError);

      // No file was created at the target.
      const existsAt = await import("node:fs/promises").then(async (m) => {
        try {
          await m.stat(join(outside, "new-note.md"));
          return true;
        } catch {
          return false;
        }
      });
      expect(existsAt).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("append-through-symlink: same guard as write", async () => {
    const outside = makeRoot();
    try {
      const victim = join(outside, "log.txt");
      writeFileSync(victim, "initial\n");
      symlinkSync(victim, join(root, "log-link.txt"));

      await expect(
        provider.append("log-link.txt", "appended"),
      ).rejects.toBeInstanceOf(StoragePathTraversalError);

      const contents = await import("node:fs/promises").then((m) =>
        m.readFile(victim, "utf8"),
      );
      expect(contents).toBe("initial\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects paths over 4096 bytes (PATH_MAX)", async () => {
    const massive = "a/".repeat(3000) + "leaf.txt"; // >4096 bytes
    await expect(provider.read(massive)).rejects.toBeInstanceOf(
      StoragePathTraversalError,
    );
    await expect(provider.write(massive, "x")).rejects.toBeInstanceOf(
      StoragePathTraversalError,
    );
  });

  test("delete refuses the zone root itself (rm -rf protection)", async () => {
    // Populate the zone so the test is meaningful.
    await provider.write("keep.txt", "keep me");
    // "" and "." both normalise to rootPath.
    await expect(provider.delete("")).rejects.toBeInstanceOf(
      StoragePathTraversalError,
    );
    await expect(provider.delete(".")).rejects.toBeInstanceOf(
      StoragePathTraversalError,
    );
    // Zone root and its contents survive.
    expect(await provider.exists("keep.txt")).toBe(true);
  });

  test("allows well-formed relative paths", async () => {
    await provider.write("notes/today.md", "# today");
    const out = await provider.readText("notes/today.md");
    expect(out).toBe("# today");
  });
});

describe("LocalStorageProvider — CRUD", () => {
  let root: string;
  let provider: LocalStorageProvider;

  beforeEach(() => {
    root = makeRoot();
    provider = new LocalStorageProvider("home", root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("write + readText round-trip", async () => {
    await provider.write("greeting.txt", "hello");
    expect(await provider.readText("greeting.txt")).toBe("hello");
  });

  test("write auto-creates parent directories", async () => {
    await provider.write("a/b/c/deep.txt", "deep");
    expect(await provider.exists("a/b/c/deep.txt")).toBe(true);
  });

  test("read returns Uint8Array", async () => {
    await provider.write("bin.dat", new Uint8Array([1, 2, 3]));
    const bytes = await provider.read("bin.dat");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  test("read of missing file → StorageNotFoundError", async () => {
    await expect(provider.read("missing.txt")).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  test("append extends an existing file", async () => {
    await provider.write("log.txt", "line1\n");
    await provider.append("log.txt", "line2\n");
    expect(await provider.readText("log.txt")).toBe("line1\nline2\n");
  });

  test("append creates the file if it doesn't exist", async () => {
    await provider.append("new-log.txt", "first\n");
    expect(await provider.readText("new-log.txt")).toBe("first\n");
  });

  test("list returns entries in a directory", async () => {
    await provider.write("d/a.txt", "a");
    await provider.write("d/b.txt", "b");
    const entries = await provider.list("d");
    expect(entries.sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("list of missing directory → StorageNotFoundError", async () => {
    await expect(provider.list("no-such-dir")).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  test("exists returns true/false, never throws on missing", async () => {
    expect(await provider.exists("nope.txt")).toBe(false);
    await provider.write("yep.txt", "y");
    expect(await provider.exists("yep.txt")).toBe(true);
  });

  test("exists still rejects traversal", async () => {
    await expect(provider.exists("../etc/passwd")).rejects.toBeInstanceOf(
      StoragePathTraversalError,
    );
  });

  test("stat returns null for missing files", async () => {
    expect(await provider.stat("ghost.txt")).toBeNull();
  });

  test("stat returns metadata for real files", async () => {
    await provider.write("real.txt", "abcd");
    const s = await provider.stat("real.txt");
    expect(s).not.toBeNull();
    expect(s!.size).toBe(4);
    expect(s!.isDirectory).toBe(false);
    expect(s!.mtime).toBeInstanceOf(Date);
  });

  test("stat reports directories", async () => {
    await provider.mkdir("d");
    const s = await provider.stat("d");
    expect(s).not.toBeNull();
    expect(s!.isDirectory).toBe(true);
  });

  test("delete removes a file", async () => {
    await provider.write("doomed.txt", "x");
    await provider.delete("doomed.txt");
    expect(await provider.exists("doomed.txt")).toBe(false);
  });

  test("delete of a directory removes it recursively", async () => {
    await provider.write("tree/leaf.txt", "leaf");
    await provider.delete("tree");
    expect(await provider.exists("tree")).toBe(false);
  });

  test("delete of missing path → StorageNotFoundError", async () => {
    await expect(provider.delete("nothing.txt")).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  test("mkdir is idempotent", async () => {
    await provider.mkdir("p/q/r");
    await provider.mkdir("p/q/r");
    expect(await provider.exists("p/q/r")).toBe(true);
  });
});
