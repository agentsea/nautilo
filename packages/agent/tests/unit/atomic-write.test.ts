/**
 * D087 Phase 1 §1.2 — atomic-write unit tests.
 *
 * These tests hit the real filesystem (temp dir) because the guarantee
 * we are testing (no torn writes, no empty destinations on crash, final
 * bytes match requested) is inherently about disk behavior. Each test
 * uses its own subdirectory to keep parallel runs safe.
 */

import { describe, test, expect, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AtomicPublishCommittedError,
  publishFileIfAbsent,
  writeAtomic,
  writeAtomicIfAbsent,
} from "../../src/tools/file/atomic-write";

let tmpRoot: string | null = null;

async function makeTmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-atomic-write-"));
  tmpRoot = dir;
  return dir;
}

afterEach(async () => {
  if (tmpRoot) {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    tmpRoot = null;
  }
});

describe("writeAtomic", () => {
  test("creates a new file with the requested bytes", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "new.md");
    await writeAtomic(target, "hello world\n");
    const read = await fsp.readFile(target, "utf-8");
    expect(read).toBe("hello world\n");
  });

  test("overwrites an existing file atomically (no torn state)", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "existing.md");
    await fsp.writeFile(target, "initial\n");

    await writeAtomic(target, "replaced\n");
    const read = await fsp.readFile(target, "utf-8");
    expect(read).toBe("replaced\n");
  });

  test("accepts Buffer input", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "binary.bin");
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await writeAtomic(target, bytes);
    const read = await fsp.readFile(target);
    expect(read).toEqual(bytes);
  });

  test("uses default mode 0o644", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "default-mode.md");
    await writeAtomic(target, "x");
    const stat = await fsp.stat(target);
    // On non-POSIX filesystems the mode mapping differs; just verify
    // the owner-readable/writable bits are set.
     
    expect(stat.mode & 0o600).toBe(0o600);
  });

  test("honors an explicit mode option", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "explicit-mode.md");
    await writeAtomic(target, "x", { mode: 0o600 });
    const stat = await fsp.stat(target);
     
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("leaves no .tmp residue on success", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "cleanup.md");
    await writeAtomic(target, "clean\n");
    const entries = await fsp.readdir(dir);
    // Only the final file — no sibling tmp artifact.
    expect(entries).toEqual(["cleanup.md"]);
  });

  test("propagates errors when the parent directory does not exist", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "nonexistent-sub", "x.md");
    // Expected to reject — write-file-atomic does not create parents.
    // Handlers that need parent-creation do it themselves before calling
    // writeAtomic (same as the existing write handler).
    let thrown: unknown = null;
    try {
      await writeAtomic(target, "x");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
  });

  test("two sequential writes to the same path land the last bytes", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "sequential.md");
    await writeAtomic(target, "first\n");
    await writeAtomic(target, "second\n");
    const read = await fsp.readFile(target, "utf-8");
    expect(read).toBe("second\n");
  });

  test("UTF-8 multi-byte content round-trips byte-exact", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "utf8.md");
    const content = "ñandú — 日本語 — 🦊\n";
    await writeAtomic(target, content);
    const read = await fsp.readFile(target, "utf-8");
    expect(read).toBe(content);
  });

  test("concurrent publish-if-absent preserves exactly one winner", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "exclusive.bin");
    const attempts = await Promise.allSettled([
      writeAtomicIfAbsent(target, Buffer.from("first")),
      writeAtomicIfAbsent(target, Buffer.from("second")),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(["first", "second"]).toContain(await fsp.readFile(target, "utf8"));
    expect((await fsp.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("publish-if-absent never replaces existing bytes and cleans its temp", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "existing.bin");
    await fsp.writeFile(target, "winner");
    const result = await writeAtomicIfAbsent(target, "loser").catch(
      (error: unknown) => error,
    );
    expect(result).toMatchObject({ code: "EEXIST" });
    expect(await fsp.readFile(target, "utf8")).toBe("winner");
    expect((await fsp.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("ordinary atomic write still performs an authorized overwrite", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "overwrite.bin");
    await writeAtomicIfAbsent(target, "first");
    await writeAtomic(target, "replacement");
    expect(await fsp.readFile(target, "utf8")).toBe("replacement");
    expect((await fsp.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("stream-style temporary publication has the same no-replace commit", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "stream.bin");
    const temporary = `${target}.stream.tmp`;
    const handle = await fsp.open(temporary, "wx", 0o644);
    await handle.writeFile("stream winner");
    await handle.sync();
    await handle.close();
    await publishFileIfAbsent(temporary, target);
    expect(await fsp.readFile(target, "utf8")).toBe("stream winner");
    expect(await fsp.readdir(dir)).toEqual(["stream.bin"]);
  });

  test("reports a post-link failure as committed state", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "committed.bin");
    const temporary = `${target}.fault.tmp`;
    await fsp.writeFile(temporary, "published bytes");
    const result = await publishFileIfAbsent(temporary, target, {
      syncDirectory: async () => {
        throw new Error("injected directory sync failure");
      },
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AtomicPublishCommittedError);
    expect(result).toMatchObject({ published: true });
    expect(await fsp.readFile(target, "utf8")).toBe("published bytes");
  });
});
