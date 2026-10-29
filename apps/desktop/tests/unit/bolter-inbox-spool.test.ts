import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { renameWithWindowsRetry, renameWithWindowsRetrySync } from "@nautilo/config/private-filesystem";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BolterInboxSpool, createBolterSpoolDirectory, type BolterSpoolCipher, type BolterSpoolScope } from "../../electron/bolter-bridge/inbox-spool";

// Bolter is unsupported on Windows (the CLI contract refuses win32); the spool
// relies on POSIX permission bits and O_NOFOLLOW.
const test = bunTest.skipIf(process.platform === "win32");

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function cipher(): BolterSpoolCipher {
  const key = randomBytes(32);
  return {
    isAvailable: () => true,
    async seal(plaintext) {
      const nonce = randomBytes(12);
      const encoder = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([encoder.update(plaintext), encoder.final()]);
      return Buffer.concat([nonce, encoder.getAuthTag(), encrypted]);
    },
    async open(value) {
      const bytes = Buffer.from(value);
      const decoder = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decoder.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decoder.update(bytes.subarray(28)), decoder.final()]).toString("utf8");
    },
  };
}

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "bolter-spool-test-")));
  temporary.push(parent);
  const directory = await createBolterSpoolDirectory(parent);
  const scope = { serverId: "test-server", userId: "test-human", connectionId: "test-connection" };
  const storage = cipher();
  let current = true;
  const options = { directory, scope, cipher: storage, isCurrent: () => current };
  return { parent, directory, options, spool: new BolterInboxSpool(options), retire: () => { current = false; } };
}

describe("durable protected Bolter handover", () => {
  test("rejects unprotected parents for both allocation and an existing spool", async () => {
    const f = await fixture();
    const before = await readdir(f.parent);
    await chmod(f.parent, 0o777);
    await expect(createBolterSpoolDirectory(f.parent)).rejects.toThrow("unavailable");
    await expect(f.spool.store("synthetic data")).rejects.toThrow("unavailable");
    expect(await readdir(f.parent)).toEqual(before);
    expect((await stat(f.parent)).mode & 0o777).toBe(0o777);
    await expect(createBolterSpoolDirectory(join(f.parent, "missing-private-path")))
      .rejects.toThrow("Bolter inbox storage is unavailable.");
  });

  test("captures paths, scope, codec functions and authority instead of mutable caller options", async () => {
    const f = await fixture();
    const other = await createBolterSpoolDirectory(f.parent);
    f.options.directory = other;
    f.options.scope.connectionId = "other-connection";
    f.options.cipher.seal = async plaintext => Buffer.from(plaintext);
    f.options.isCurrent = () => true;
    const receipt = await f.spool.store("synthetic-private-canary");
    expect(await readdir(other)).toEqual([]);
    expect((await readFile(join(f.directory, receipt.id))).includes("synthetic-private-canary")).toBe(false);
    expect((await f.spool.read(receipt.id)).jsonl).toBe("synthetic-private-canary");
    f.retire();
    await expect(f.spool.pending()).rejects.toThrow("unavailable");
  });

  test("replacement during commit cannot acknowledge a batch by syncing another inode", async () => {
    const f = await fixture();
    const previous = join(f.parent, "previous");
    let replaced = false;
    const guarded = new BolterInboxSpool({ ...f.options, isCurrent: () => {
      if (!replaced && readdirSync(f.directory).some(name => name.endsWith(".sealed"))) {
        replaced = true;
        renameWithWindowsRetrySync(f.directory, previous);
        mkdirSync(f.directory, { mode: 0o700 });
      }
      return true;
    } });
    await expect(guarded.store("synthetic data")).rejects.toThrow("unavailable");
    expect(replaced).toBe(true);
    expect(await readdir(f.directory)).toEqual([]);
    expect((await readdir(previous)).filter(name => name.endsWith(".sealed"))).toHaveLength(1);
  });

  test("microtask revocation after directory admission preserves the unacknowledged file", async () => {
    const f = await fixture();
    const receipt = await f.spool.store("synthetic data");
    let afterDecrypt = false;
    let checksAfterDecrypt = 0;
    let current = true;
    const guarded = new BolterInboxSpool({ ...f.options,
      cipher: { ...f.options.cipher, open: async bytes => {
        const plaintext = await f.options.cipher.open(bytes);
        afterDecrypt = true;
        return plaintext;
      } },
      isCurrent: () => {
        if (afterDecrypt && ++checksAfterDecrypt === 3) queueMicrotask(() => { current = false; });
        return current;
      },
    });
    await expect(guarded.acknowledge(receipt)).rejects.toThrow("unavailable");
    expect(current).toBe(false);
    expect(await readdir(f.directory)).toEqual([receipt.id]);
  });

  test("retirement after removal never returns a successful acknowledgment", async () => {
    const f = await fixture();
    const receipt = await f.spool.store("synthetic data");
    const guarded = new BolterInboxSpool({ ...f.options, isCurrent: () =>
      readdirSync(f.directory).includes(receipt.id) });
    await expect(guarded.acknowledge(receipt)).rejects.toThrow("unavailable");
    expect(await readdir(f.directory)).toEqual([]);
  });

  test("retirement during asynchronous commit cleanup never returns a successful receipt", async () => {
    const f = await fixture();
    let current = true;
    let committedChecks = 0;
    const guarded = new BolterInboxSpool({ ...f.options, isCurrent: () => {
      if (readdirSync(f.directory).some(name => name.endsWith(".sealed")) && ++committedChecks === 4) {
        queueMicrotask(() => { current = false; });
      }
      return current;
    } });
    await expect(guarded.store("synthetic data")).rejects.toThrow("unavailable");
    expect(current).toBe(false);
    expect((await readdir(f.directory)).filter(name => name.endsWith(".sealed"))).toHaveLength(1);
  });

  test("requires all three explicit nonempty ownership fields before storing anything", async () => {
    const f = await fixture();
    const invalid: unknown[] = [null, undefined, [], {}, "scope"];
    for (const key of ["serverId", "userId", "connectionId"] as const) {
      const partial = { ...f.options.scope } as Partial<BolterSpoolScope>;
      delete partial[key];
      invalid.push(partial, { ...f.options.scope, [key]: "" }, { ...f.options.scope, [key]: "  " });
    }
    for (const scope of invalid) {
      expect(() => new BolterInboxSpool({ ...f.options, scope: scope as BolterSpoolScope })).toThrow("unavailable");
    }
    expect(await readdir(f.directory)).toEqual([]);
  });
  test("commits encrypted whole batches, survives reconstruction, and removes only the acknowledged receipt", async () => {
    const f = await fixture();
    const jsonl = '{"content":"synthetic-private-canary"}\n{"content":"second-message"}\n';
    const receipt = await f.spool.store(jsonl);
    const stored = await readFile(join(f.directory, receipt.id));
    expect(stored.includes("synthetic-private-canary")).toBe(false);
    expect(stored.includes("test-human")).toBe(false);
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.directory, receipt.id))).mode & 0o777).toBe(0o600);
    const restored = new BolterInboxSpool(f.options);
    expect(await restored.pending()).toEqual([receipt.id]);
    expect(await restored.read(receipt.id)).toEqual({ ...receipt, jsonl });
    await expect(restored.acknowledge({ ...receipt, fingerprint: "wrong" })).rejects.toThrow("unavailable");
    expect(await restored.pending()).toEqual([receipt.id]);
    await restored.acknowledge(receipt);
    expect(await restored.pending()).toEqual([]);
  });

  test("a failed cipher never acknowledges or writes plaintext", async () => {
    const f = await fixture();
    const broken = new BolterInboxSpool({ ...f.options, cipher: { ...f.options.cipher, seal: async () => { throw new Error("secret error details"); } } });
    await expect(broken.store("private content")).rejects.toThrow("Bolter inbox storage is unavailable.");
    expect(await readdir(f.directory)).toEqual([]);
  });

  test("unavailable encryption and retired ownership reject every operation", async () => {
    const f = await fixture();
    const receipt = await f.spool.store("one\n");
    f.retire();
    await expect(f.spool.store("two\n")).rejects.toThrow("unavailable");
    await expect(f.spool.pending()).rejects.toThrow("unavailable");
    await expect(f.spool.read(receipt.id)).rejects.toThrow("unavailable");
    await expect(f.spool.acknowledge(receipt)).rejects.toThrow("unavailable");
    expect(await readdir(f.directory)).toEqual([receipt.id]);
    const unavailable = new BolterInboxSpool({ ...f.options, isCurrent: () => true, cipher: { ...f.options.cipher, isAvailable: () => false } });
    await expect(unavailable.pending()).rejects.toThrow("unavailable");
  });

  test("revalidates ownership after sealing and retains no acknowledged batch on failure", async () => {
    const f = await fixture();
    const guarded = new BolterInboxSpool({ ...f.options, cipher: { ...f.options.cipher, seal: async plaintext => {
      const sealed = await f.options.cipher.seal(plaintext);
      f.retire();
      return sealed;
    } } });
    await expect(guarded.store("synthetic data")).rejects.toThrow("unavailable");
    expect(await readdir(f.directory)).toEqual([]);
  });

  test("copied ciphertext cannot cross connection, Human, or server scopes", async () => {
    const f = await fixture();
    const receipt = await f.spool.store("synthetic data\n");
    for (const key of ["connectionId", "userId", "serverId"] as const) {
      const other = new BolterInboxSpool({ ...f.options, scope: { ...f.options.scope, [key]: "other" } });
      await expect(other.read(receipt.id)).rejects.toThrow("unavailable");
      await expect(other.acknowledge(receipt)).rejects.toThrow("unavailable");
    }
    expect(await f.spool.pending()).toEqual([receipt.id]);
  });

  test("corruption stays retained and cannot become an empty successful batch", async () => {
    const f = await fixture();
    const receipt = await f.spool.store("valid\n");
    await writeFile(join(f.directory, receipt.id), "invalid ciphertext", { mode: 0o600 });
    await expect(f.spool.read(receipt.id)).rejects.toThrow("unavailable");
    await expect(f.spool.acknowledge(receipt)).rejects.toThrow("unavailable");
    expect(await f.spool.pending()).toEqual([receipt.id]);
    await expect(f.spool.store(" \n ")).rejects.toThrow("unavailable");
  });

  test("interrupted temporary writes are never presented as committed input", async () => {
    const f = await fixture();
    const receipt = await f.spool.store("one\n");
    await copyFile(join(f.directory, receipt.id), join(f.directory, receipt.id + ".pending"));
    expect(await f.spool.pending()).toEqual([receipt.id]);
  });

  test("path traversal, symlink substitution and broad directory modes fail closed", async () => {
    const f = await fixture();
    const receipt = await f.spool.store("one\n");
    await expect(f.spool.read("../outside")).rejects.toThrow("unavailable");
    const saved = join(f.parent, "saved.sealed");
    await renameWithWindowsRetry(join(f.directory, receipt.id), saved);
    await symlink(saved, join(f.directory, receipt.id));
    await expect(f.spool.read(receipt.id)).rejects.toThrow("unavailable");
    await expect(f.spool.acknowledge(receipt)).rejects.toThrow("unavailable");
    await chmod(f.directory, 0o755);
    await expect(f.spool.pending()).rejects.toThrow("unavailable");
    expect((await stat(f.directory)).mode & 0o777).toBe(0o755);
  });

  test("a replaced directory cannot inherit the old spool ownership", async () => {
    const f = await fixture();
    await f.spool.store("one\n");
    await renameWithWindowsRetry(f.directory, join(f.parent, "previous"));
    await expect(f.spool.pending()).rejects.toThrow("unavailable");
  });

  test("duplicate handover remains durable for canonical server deduplication", async () => {
    const f = await fixture();
    const [one, two] = await Promise.all([f.spool.store("same\n"), f.spool.store("same\n")]);
    expect(one.id).not.toBe(two.id);
    expect(one.fingerprint).toBe(two.fingerprint);
    expect(await f.spool.pending()).toHaveLength(2);
    await f.spool.acknowledge(one);
    expect((await f.spool.read(two.id)).jsonl).toBe("same\n");
  });
});
