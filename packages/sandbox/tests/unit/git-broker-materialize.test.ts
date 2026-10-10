/**
 * Unit tests for broker-controlled worktree materialization.
 *
 * Pure parsing, validation, and broker-owned filesystem code. No Git
 * subprocess; no sandbox-exec required. Exercises the manifest threat
 * model (gitlink/submodule rejection, unsafe modes, symlink rejection,
 * absolute/escaping paths, NUL, duplicates, live `.env`, governance
 * entries, resource limits) and the atomic write / cleanup helpers.
 */

import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { GitPreflightError } from "../../src/git-broker/preflight";
import {
  cleanupMaterialization,
  MAX_WORKTREE_BLOB_BYTES,
  MAX_WORKTREE_FILE_COUNT,
  MAX_WORKTREE_TOTAL_BYTES,
  parseLsTreeZ,
  parseNetworkManifest,
  validateNetworkLinks,
  safeMkdirsForFile,
  writeBlobAtomic,
} from "../../src/git-broker/materialize";

function mkTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function record(mode: string, type: string, oid: string, path: string, size = 8): Buffer {
  return Buffer.from(`${mode} ${type} ${oid} ${size}\t${path}`, "utf8");
}

function manifest(records: Buffer[]): Buffer {
  return Buffer.concat(records.map((r) => Buffer.concat([r, Buffer.from([0])])));
}

const OID = "0123456789abcdef0123456789abcdef01234567";

test("network symlinks require a safe relative graph while legacy parser keeps rejecting them", async () => {
  const root = mkTmp("network-manifest-links-");
  try {
    const bytes = manifest([record("100644", "blob", OID, "a.txt"), record("120000", "blob", OID, "link", 5)]);
    const parsed = parseNetworkManifest(bytes, root, { fileCount: 3, blobBytes: 32, totalBytes: 64 });
    await validateNetworkLinks(parsed, root, async () => Buffer.from("a.txt"));
    expect(parsed.entries[1]?.mode).toBe("120000");
    expect(() => parseLsTreeZ(bytes, root)).toThrow(/symlink/);
    await rejects(validateNetworkLinks(parsed, root, async () => Buffer.from("../xx")), /Escaping symlink/);
    symlinkSync(resolve(root, "..", "outside"), join(root, "other"), process.platform === "win32" ? "junction" : "dir");
    await rejects(validateNetworkLinks(parsed, root, async () => Buffer.from("other")), /Unsafe existing symlink target/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["nested/.secret", "nested/credentials", "nested/credentials.json"])("network links reject nested secret target %s", async (target) => {
  const root = mkTmp("network-secret-link-");
  try {
    const bytes = manifest([record("120000", "blob", OID, "link", Buffer.byteLength(target))]);
    const parsed = parseNetworkManifest(bytes, root, { fileCount: 1, blobBytes: 64, totalBytes: 64 });
    await rejects(validateNetworkLinks(parsed, root, async () => Buffer.from(target)), /Secret manifest path or symlink target/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("network manifest rejects malformed UTF8, ambiguous object IDs and normalized case collisions", () => {
  const root = mkTmp("network-manifest-encoding-");
  const limits = { fileCount: 5, blobBytes: 32, totalBytes: 64 };
  try {
    expect(() => parseNetworkManifest(manifest([record("100644", "blob", "a".repeat(41), "a")]), root, limits)).toThrow();
    expect(() => parseNetworkManifest(manifest([Buffer.concat([Buffer.from(`100644 blob ${OID} 1\t`), Buffer.from([0xff])])]), root, limits)).toThrow();
    expect(() => parseNetworkManifest(manifest([record("100644", "blob", OID, "é"), record("100644", "blob", OID, "e\u0301")]), root, limits)).toThrow();
    expect(() => parseNetworkManifest(Buffer.alloc(0), root, { ...limits, totalBytes: 1.5 })).toThrow();
    for (const path of [".secret", ".secrets", "credentials", "credentials.json", "link/credentials"]) {
      expect(() => parseNetworkManifest(manifest([record("100644", "blob", OID, path)]), root, limits)).toThrow();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("parseLsTreeZ — accept", () => {
  test("regular + executable blobs parse", () => {
    const root = mkTmp("git-materialize-ok-");
    const out = manifest([
      record("100644", "blob", OID, "public.txt"),
      record("100755", "blob", OID, "bin/run.sh"),
    ]);
    const m = parseLsTreeZ(out, root);
    expect(m.entries.length).toBe(2);
    expect(m.entries[0]?.mode).toBe("100644");
    expect(m.entries[1]?.mode).toBe("100755");
    expect(m.entries[1]?.path).toBe("bin/run.sh");
    rmSync(root, { recursive: true, force: true });
  });

  test("public .env.example terminal suffix is allowed", () => {
    const root = mkTmp("git-materialize-envex-");
    const out = manifest([record("100644", "blob", OID, ".env.example")]);
    const m = parseLsTreeZ(out, root);
    expect(m.entries[0]?.path).toBe(".env.example");
    rmSync(root, { recursive: true, force: true });
  });

  test("nested directories parse with forward-slash paths", () => {
    const root = mkTmp("git-materialize-nested-");
    const out = manifest([record("100644", "blob", OID, "a/b/c/deep.txt")]);
    const m = parseLsTreeZ(out, root);
    expect(m.entries[0]?.path).toBe("a/b/c/deep.txt");
    rmSync(root, { recursive: true, force: true });
  });

  test("empty input -> empty manifest", () => {
    const root = mkTmp("git-materialize-empty-");
    const m = parseLsTreeZ(Buffer.alloc(0), root);
    expect(m.entries.length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("parseLsTreeZ — reject", () => {
  test("gitlink/submodule entry (type commit) -> deny-submodules", () => {
    const root = mkTmp("git-materialize-sub-");
    const out = manifest([record("160000", "commit", OID, "vendor")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(GitPreflightError);
    expect(() => parseLsTreeZ(out, root)).toThrow(/gitlink\/submodule/);
    rmSync(root, { recursive: true, force: true });
  });

  test("tree entry (type tree) -> deny-submodules", () => {
    const root = mkTmp("git-materialize-tree-");
    const out = manifest([record("040000", "tree", OID, "sub")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/gitlink\/submodule/);
    rmSync(root, { recursive: true, force: true });
  });

  test("symlink mode 120000 -> deny-escaping-symlink (all symlinks rejected)", () => {
    const root = mkTmp("git-materialize-sym-");
    const out = manifest([record("120000", "blob", OID, "link")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(GitPreflightError);
    expect(() => parseLsTreeZ(out, root)).toThrow(/symlink/);
    rmSync(root, { recursive: true, force: true });
  });

  test("unsafe mode -> deny-path-not-regular", () => {
    const root = mkTmp("git-materialize-mode-");
    const out = manifest([record("100666", "blob", OID, "weird.txt")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/unsafe mode/);
    rmSync(root, { recursive: true, force: true });
  });

  test("absolute path -> deny-pathspec-outside-target", () => {
    const root = mkTmp("git-materialize-abs-");
    const out = manifest([record("100644", "blob", OID, "/etc/passwd")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/absolute manifest path/);
    rmSync(root, { recursive: true, force: true });
  });

  test("parent traversal -> deny-pathspec-outside-target", () => {
    const root = mkTmp("git-materialize-trav-");
    const out = manifest([record("100644", "blob", OID, "../escape.txt")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/escapes target root/);
    rmSync(root, { recursive: true, force: true });
  });

  test("control byte in path -> deny-pathspec-outside-target", () => {
    const root = mkTmp("git-materialize-ctrl-");
    const rec = Buffer.concat([
      Buffer.from(`100644 blob ${OID} 8\t`),
      Buffer.from("bad\x01name.txt"),
      Buffer.from([0]),
    ]);
    expect(() => parseLsTreeZ(rec, root)).toThrow(/control byte/);
    rmSync(root, { recursive: true, force: true });
  });

  test("duplicate path -> deny-pathspec-outside-target", () => {
    const root = mkTmp("git-materialize-dup-");
    const out = manifest([
      record("100644", "blob", OID, "same.txt"),
      record("100644", "blob", OID, "same.txt"),
    ]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/duplicate manifest path/);
    rmSync(root, { recursive: true, force: true });
  });

  test("live .env -> deny-live-env before mutation", () => {
    const root = mkTmp("git-materialize-liveenv-");
    const out = manifest([record("100644", "blob", OID, ".env")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(GitPreflightError);
    expect(() => parseLsTreeZ(out, root)).toThrow(/live secret variant/);
    rmSync(root, { recursive: true, force: true });
  });

  test("live .env.local -> deny-live-env", () => {
    const root = mkTmp("git-materialize-envlocal-");
    const out = manifest([record("100644", "blob", OID, ".env.local")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/live secret variant/);
    rmSync(root, { recursive: true, force: true });
  });

  test(".git governance entry -> deny-pathspec-outside-target", () => {
    const root = mkTmp("git-materialize-git-");
    const out = manifest([record("100644", "blob", OID, ".git/HEAD")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/governance entry/);
    rmSync(root, { recursive: true, force: true });
  });

  test("malformed oid -> deny-pathspec-outside-target", () => {
    const root = mkTmp("git-materialize-badoid-");
    const out = manifest([record("100644", "blob", "nothex", "f.txt")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/malformed oid/);
    rmSync(root, { recursive: true, force: true });
  });

  test("file count overflow -> deny-add-bounds", () => {
    const root = mkTmp("git-materialize-count-");
    const recs: Buffer[] = [];
    for (let i = 0; i <= MAX_WORKTREE_FILE_COUNT; i++) {
      recs.push(record("100644", "blob", OID, `f${i}.txt`));
    }
    expect(() => parseLsTreeZ(manifest(recs), root)).toThrow(/file count limit/);
    rmSync(root, { recursive: true, force: true });
  });

  test("per-blob byte overflow -> deny-add-bounds (pre-mutation)", () => {
    const root = mkTmp("git-materialize-blob-");
    const out = manifest([record("100644", "blob", OID, "big.txt", 200)]);
    expect(() => parseLsTreeZ(out, root, 4096, 64, 1024)).toThrow(/exceeds 64 bytes/);
    rmSync(root, { recursive: true, force: true });
  });

  test("total byte overflow -> deny-add-bounds (pre-mutation)", () => {
    const root = mkTmp("git-materialize-total-");
    const out = manifest([
      record("100644", "blob", OID, "a.txt", 40),
      record("100644", "blob", OID, "b.txt", 40),
      record("100644", "blob", OID, "c.txt", 40),
    ]);
    expect(() => parseLsTreeZ(out, root, 4096, 1024, 64)).toThrow(/exceeds 64 total bytes/);
    rmSync(root, { recursive: true, force: true });
  });

  test("malformed size field -> deny-add-bounds", () => {
    const root = mkTmp("git-materialize-badsize-");
    const rec = Buffer.from(`100644 blob ${OID} -\tgitlink.txt\0`, "utf8");
    // type is blob but size is `-` (gitlink shape) -> malformed size.
    expect(() => parseLsTreeZ(rec, root)).toThrow(/malformed size/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("writeBlobAtomic + safeMkdirsForFile", () => {
  test("writes regular file bytes", () => {
    const root = mkTmp("git-materialize-w644-");
    const path = resolve(root, "file.txt");
    writeBlobAtomic(path, Buffer.from("hello\n"), false);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("hello\n");
    expect(lstatSync(path).isFile()).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("writes executable blob bytes", () => {
    const root = mkTmp("git-materialize-w755-");
    const path = resolve(root, "bin", "run.sh");
    safeMkdirsForFile(path, root);
    writeBlobAtomic(path, Buffer.from("#!/bin/sh\n"), true);
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\n");
    rmSync(root, { recursive: true, force: true });
  });

  test.skipIf(process.platform === "win32").each([false, true])("preserves POSIX mode for executable=%s", (executable) => {
    const root = mkTmp("git-materialize-mode-");
    try {
      const file = resolve(root, "blob");
      writeBlobAtomic(file, Buffer.from("fixture"), executable);
      expect(lstatSync(file).mode & 0o777).toBe(executable ? 0o755 : 0o644);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("nested directories are created safely", () => {
    const root = mkTmp("git-materialize-nest-");
    const path = resolve(root, "a", "b", "c", "deep.txt");
    safeMkdirsForFile(path, root);
    writeBlobAtomic(path, Buffer.from("x"), false);
    expect(existsSync(path)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("writeBlobAtomic refuses to overwrite an existing path", () => {
    const root = mkTmp("git-materialize-over-");
    const path = resolve(root, "file.txt");
    writeBlobAtomic(path, Buffer.from("first"), false);
    expect(() => writeBlobAtomic(path, Buffer.from("second"), false)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("first");
    rmSync(root, { recursive: true, force: true });
  });

  test("safeMkdirsForFile rejects a symlink planted on the chain", () => {
    const root = mkTmp("git-materialize-symchain-");
    const real = resolve(root, "real");
    mkdirSync(real, { recursive: true });
    const link = resolve(root, "link");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    const path = resolve(link, "file.txt");
    expect(() => safeMkdirsForFile(path, root)).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });

  test("safeMkdirsForFile rejects an escaping path", () => {
    const root = mkTmp("git-materialize-escape-");
    const path = resolve(root, "..", "escape.txt");
    expect(() => safeMkdirsForFile(path, root)).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("cleanupMaterialization", () => {
  test("removes only broker-written files + empty dirs", () => {
    const root = mkTmp("git-materialize-clean-");
    const a = resolve(root, "a.txt");
    const b = resolve(root, "sub", "b.txt");
    safeMkdirsForFile(b, root);
    writeBlobAtomic(a, Buffer.from("a"), false);
    writeBlobAtomic(b, Buffer.from("b"), false);
    const residuals = cleanupMaterialization(root, [a, b]);
    expect(residuals.length).toBe(0);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(resolve(root, "sub"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("leaves operator-added files untouched and reports residual dir", () => {
    const root = mkTmp("git-materialize-op-");
    const a = resolve(root, "a.txt");
    writeBlobAtomic(a, Buffer.from("a"), false);
    const opFile = resolve(root, "operator.txt");
    writeFileSync(opFile, "operator data");
    const residuals = cleanupMaterialization(root, [a]);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(opFile)).toBe(true);
    // The target root still holds the operator file, so it cannot be
    // pruned; cleanup leaves it in place (no residual reported for it
    // because it is not a broker-written path).
    expect(residuals.length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("materialize limits are exposed", () => {
  test("constants are exported and positive", () => {
    expect(MAX_WORKTREE_FILE_COUNT).toBeGreaterThan(0);
    expect(MAX_WORKTREE_BLOB_BYTES).toBeGreaterThan(0);
    expect(MAX_WORKTREE_TOTAL_BYTES).toBeGreaterThan(MAX_WORKTREE_BLOB_BYTES);
  });
});

// Silence unused import for chmodSync (kept for future fixtures).
void chmodSync;
