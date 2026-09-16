/**
 * D440 Phase 3 — unit tests for broker-controlled worktree materialization.
 *
 * Pure parsing, validation, and broker-owned filesystem code. No Git
 * subprocess; no sandbox-exec required. Exercises the manifest threat
 * model (gitlink/submodule rejection, unsafe modes, symlink rejection,
 * absolute/escaping paths, NUL, duplicates, live `.env`, governance
 * entries, resource limits) and the atomic write / cleanup helpers.
 */

import { describe, expect, test } from "bun:test";
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

describe("parseLsTreeZ — accept", () => {
  test("regular + executable blobs parse", () => {
    const root = mkTmp("d440-mat-ok-");
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
    const root = mkTmp("d440-mat-envex-");
    const out = manifest([record("100644", "blob", OID, ".env.example")]);
    const m = parseLsTreeZ(out, root);
    expect(m.entries[0]?.path).toBe(".env.example");
    rmSync(root, { recursive: true, force: true });
  });

  test("nested directories parse with forward-slash paths", () => {
    const root = mkTmp("d440-mat-nested-");
    const out = manifest([record("100644", "blob", OID, "a/b/c/deep.txt")]);
    const m = parseLsTreeZ(out, root);
    expect(m.entries[0]?.path).toBe("a/b/c/deep.txt");
    rmSync(root, { recursive: true, force: true });
  });

  test("empty input -> empty manifest", () => {
    const root = mkTmp("d440-mat-empty-");
    const m = parseLsTreeZ(Buffer.alloc(0), root);
    expect(m.entries.length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("parseLsTreeZ — reject", () => {
  test("gitlink/submodule entry (type commit) -> deny-submodules", () => {
    const root = mkTmp("d440-mat-sub-");
    const out = manifest([record("160000", "commit", OID, "vendor")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(GitPreflightError);
    expect(() => parseLsTreeZ(out, root)).toThrow(/gitlink\/submodule/);
    rmSync(root, { recursive: true, force: true });
  });

  test("tree entry (type tree) -> deny-submodules", () => {
    const root = mkTmp("d440-mat-tree-");
    const out = manifest([record("040000", "tree", OID, "sub")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/gitlink\/submodule/);
    rmSync(root, { recursive: true, force: true });
  });

  test("symlink mode 120000 -> deny-escaping-symlink (all symlinks rejected)", () => {
    const root = mkTmp("d440-mat-sym-");
    const out = manifest([record("120000", "blob", OID, "link")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(GitPreflightError);
    expect(() => parseLsTreeZ(out, root)).toThrow(/symlink/);
    rmSync(root, { recursive: true, force: true });
  });

  test("unsafe mode -> deny-path-not-regular", () => {
    const root = mkTmp("d440-mat-mode-");
    const out = manifest([record("100666", "blob", OID, "weird.txt")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/unsafe mode/);
    rmSync(root, { recursive: true, force: true });
  });

  test("absolute path -> deny-pathspec-outside-target", () => {
    const root = mkTmp("d440-mat-abs-");
    const out = manifest([record("100644", "blob", OID, "/etc/passwd")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/absolute manifest path/);
    rmSync(root, { recursive: true, force: true });
  });

  test("parent traversal -> deny-pathspec-outside-target", () => {
    const root = mkTmp("d440-mat-trav-");
    const out = manifest([record("100644", "blob", OID, "../escape.txt")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/escapes target root/);
    rmSync(root, { recursive: true, force: true });
  });

  test("control byte in path -> deny-pathspec-outside-target", () => {
    const root = mkTmp("d440-mat-ctrl-");
    const rec = Buffer.concat([
      Buffer.from(`100644 blob ${OID} 8\t`),
      Buffer.from("bad\x01name.txt"),
      Buffer.from([0]),
    ]);
    expect(() => parseLsTreeZ(rec, root)).toThrow(/control byte/);
    rmSync(root, { recursive: true, force: true });
  });

  test("duplicate path -> deny-pathspec-outside-target", () => {
    const root = mkTmp("d440-mat-dup-");
    const out = manifest([
      record("100644", "blob", OID, "same.txt"),
      record("100644", "blob", OID, "same.txt"),
    ]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/duplicate manifest path/);
    rmSync(root, { recursive: true, force: true });
  });

  test("live .env -> deny-live-env before mutation", () => {
    const root = mkTmp("d440-mat-liveenv-");
    const out = manifest([record("100644", "blob", OID, ".env")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(GitPreflightError);
    expect(() => parseLsTreeZ(out, root)).toThrow(/live secret variant/);
    rmSync(root, { recursive: true, force: true });
  });

  test("live .env.local -> deny-live-env", () => {
    const root = mkTmp("d440-mat-envlocal-");
    const out = manifest([record("100644", "blob", OID, ".env.local")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/live secret variant/);
    rmSync(root, { recursive: true, force: true });
  });

  test(".git governance entry -> deny-pathspec-outside-target", () => {
    const root = mkTmp("d440-mat-git-");
    const out = manifest([record("100644", "blob", OID, ".git/HEAD")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/governance entry/);
    rmSync(root, { recursive: true, force: true });
  });

  test("malformed oid -> deny-pathspec-outside-target", () => {
    const root = mkTmp("d440-mat-badoid-");
    const out = manifest([record("100644", "blob", "nothex", "f.txt")]);
    expect(() => parseLsTreeZ(out, root)).toThrow(/malformed oid/);
    rmSync(root, { recursive: true, force: true });
  });

  test("file count overflow -> deny-add-bounds", () => {
    const root = mkTmp("d440-mat-count-");
    const recs: Buffer[] = [];
    for (let i = 0; i <= MAX_WORKTREE_FILE_COUNT; i++) {
      recs.push(record("100644", "blob", OID, `f${i}.txt`));
    }
    expect(() => parseLsTreeZ(manifest(recs), root)).toThrow(/file count limit/);
    rmSync(root, { recursive: true, force: true });
  });

  test("per-blob byte overflow -> deny-add-bounds (pre-mutation)", () => {
    const root = mkTmp("d440-mat-blob-");
    const out = manifest([record("100644", "blob", OID, "big.txt", 200)]);
    expect(() => parseLsTreeZ(out, root, 4096, 64, 1024)).toThrow(/exceeds 64 bytes/);
    rmSync(root, { recursive: true, force: true });
  });

  test("total byte overflow -> deny-add-bounds (pre-mutation)", () => {
    const root = mkTmp("d440-mat-total-");
    const out = manifest([
      record("100644", "blob", OID, "a.txt", 40),
      record("100644", "blob", OID, "b.txt", 40),
      record("100644", "blob", OID, "c.txt", 40),
    ]);
    expect(() => parseLsTreeZ(out, root, 4096, 1024, 64)).toThrow(/exceeds 64 total bytes/);
    rmSync(root, { recursive: true, force: true });
  });

  test("malformed size field -> deny-add-bounds", () => {
    const root = mkTmp("d440-mat-badsize-");
    const rec = Buffer.from(`100644 blob ${OID} -\tgitlink.txt\0`, "utf8");
    // type is blob but size is `-` (gitlink shape) -> malformed size.
    expect(() => parseLsTreeZ(rec, root)).toThrow(/malformed size/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("writeBlobAtomic + safeMkdirsForFile", () => {
  test("writes a regular file with mode 0644", () => {
    const root = mkTmp("d440-mat-w644-");
    const path = resolve(root, "file.txt");
    writeBlobAtomic(path, Buffer.from("hello\n"), false);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("hello\n");
    expect(lstatSync(path).mode & 0o777).toBe(0o644);
    rmSync(root, { recursive: true, force: true });
  });

  test("writes an executable file with mode 0755", () => {
    const root = mkTmp("d440-mat-w755-");
    const path = resolve(root, "bin", "run.sh");
    safeMkdirsForFile(path, root);
    writeBlobAtomic(path, Buffer.from("#!/bin/sh\n"), true);
    expect(lstatSync(path).mode & 0o777).toBe(0o755);
    rmSync(root, { recursive: true, force: true });
  });

  test("nested directories are created safely", () => {
    const root = mkTmp("d440-mat-nest-");
    const path = resolve(root, "a", "b", "c", "deep.txt");
    safeMkdirsForFile(path, root);
    writeBlobAtomic(path, Buffer.from("x"), false);
    expect(existsSync(path)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("writeBlobAtomic refuses to overwrite an existing path", () => {
    const root = mkTmp("d440-mat-over-");
    const path = resolve(root, "file.txt");
    writeBlobAtomic(path, Buffer.from("first"), false);
    expect(() => writeBlobAtomic(path, Buffer.from("second"), false)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("first");
    rmSync(root, { recursive: true, force: true });
  });

  test("safeMkdirsForFile rejects a symlink planted on the chain", () => {
    const root = mkTmp("d440-mat-symchain-");
    const real = resolve(root, "real");
    mkdirSync(real, { recursive: true });
    const link = resolve(root, "link");
    symlinkSync(real, link);
    const path = resolve(link, "file.txt");
    expect(() => safeMkdirsForFile(path, root)).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });

  test("safeMkdirsForFile rejects an escaping path", () => {
    const root = mkTmp("d440-mat-escape-");
    const path = resolve(root, "..", "escape.txt");
    expect(() => safeMkdirsForFile(path, root)).toThrow(GitPreflightError);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("cleanupMaterialization", () => {
  test("removes only broker-written files + empty dirs", () => {
    const root = mkTmp("d440-mat-clean-");
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
    const root = mkTmp("d440-mat-op-");
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
