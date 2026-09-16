import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { isRecordedMainMergeMigration } from "../../src/lib/recorded-main-merge-migration";

const RECEIPT_PATH = "bin/nautilo-dev/src/lib/applied-migration-rewrites.json";
const SQL_PATH = "packages/db/src/migrations/0999_merge_guard_fixture.sql";
const BEFORE_SQL = "select 'before';\n";
const AFTER_SQL = "select 'after';\n";

type Rewrite = {
  path: string;
  createdAt: number;
  beforeSha256: string;
  afterSha256: string;
  reason: string;
};

type FixtureOptions = {
  migrationPath?: string;
  receipt?: string | ((rewrite: Rewrite) => unknown);
};

type MergeFixture = {
  root: string;
  migrationPath: string;
  baseSha: string;
  incomingSha: string;
};

const fixtureRoots: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Merge Guard Test",
      GIT_AUTHOR_EMAIL: "merge-guard@example.invalid",
      GIT_COMMITTER_NAME: "Merge Guard Test",
      GIT_COMMITTER_EMAIL: "merge-guard@example.invalid",
    },
  }).trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function write(root: string, path: string, contents: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function createMergeFixture(options: FixtureOptions = {}): MergeFixture {
  const root = mkdtempSync(join(tmpdir(), "nautilo-merged-migration-guard-"));
  fixtureRoots.push(root);
  const migrationPath = options.migrationPath ?? SQL_PATH;

  git(root, ["init", "--quiet"]);
  write(root, migrationPath, BEFORE_SQL);
  write(root, RECEIPT_PATH, JSON.stringify({ schemaVersion: 1, rewrites: [] }, null, 2));
  git(root, ["add", "--", migrationPath, RECEIPT_PATH]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);

  const rewrite: Rewrite = {
    path: migrationPath,
    createdAt: 1,
    beforeSha256: sha256(BEFORE_SQL),
    afterSha256: sha256(AFTER_SQL),
    reason: "Hermetic merge guard fixture",
  };
  const receipt = typeof options.receipt === "function"
    ? JSON.stringify(options.receipt(rewrite), null, 2)
    : options.receipt ?? JSON.stringify({ schemaVersion: 1, rewrites: [rewrite] }, null, 2);

  write(root, migrationPath, AFTER_SQL);
  write(root, RECEIPT_PATH, receipt);
  git(root, ["add", "--", migrationPath, RECEIPT_PATH]);
  git(root, ["commit", "--quiet", "-m", "incoming main"]);
  const incomingSha = git(root, ["rev-parse", "HEAD"]);

  git(root, ["update-ref", "refs/remotes/origin/main", incomingSha]);
  git(root, ["reset", "--quiet", "--hard", baseSha]);
  git(root, ["checkout", "--quiet", incomingSha, "--", migrationPath, RECEIPT_PATH]);
  writeFileSync(join(root, ".git/MERGE_HEAD"), `${incomingSha}\n`);

  return { root, migrationPath, baseSha, incomingSha };
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("isRecordedMainMergeMigration", () => {
  test("accepts the exact migration rewrite staged from an active origin/main merge", () => {
    const fixture = createMergeFixture();

    expect(isRecordedMainMergeMigration(fixture.migrationPath, fixture.root)).toBe(true);
  });

  test("rejects a rewrite when there is no active merge or MERGE_HEAD is not incoming main", () => {
    const noMerge = createMergeFixture();
    unlinkSync(join(noMerge.root, ".git/MERGE_HEAD"));
    expect(isRecordedMainMergeMigration(noMerge.migrationPath, noMerge.root)).toBe(false);

    const nonMain = createMergeFixture();
    git(nonMain.root, ["update-ref", "refs/remotes/origin/main", nonMain.baseSha]);
    expect(isRecordedMainMergeMigration(nonMain.migrationPath, nonMain.root)).toBe(false);

    const multipleParents = createMergeFixture();
    writeFileSync(
      join(multipleParents.root, ".git/MERGE_HEAD"),
      `${multipleParents.incomingSha}\n${multipleParents.baseSha}\n`,
    );
    expect(isRecordedMainMergeMigration(multipleParents.migrationPath, multipleParents.root)).toBe(false);
  });

  test("rejects an absent or mismatching approval in the incoming parent", () => {
    const absent = createMergeFixture({
      receipt: () => ({ schemaVersion: 1, rewrites: [] }),
    });
    expect(isRecordedMainMergeMigration(absent.migrationPath, absent.root)).toBe(false);

    const localOnly = createMergeFixture({
      receipt: () => ({ schemaVersion: 1, rewrites: [] }),
    });
    write(
      localOnly.root,
      RECEIPT_PATH,
      JSON.stringify({
        schemaVersion: 1,
        rewrites: [{
          path: localOnly.migrationPath,
          createdAt: 2,
          beforeSha256: sha256(BEFORE_SQL),
          afterSha256: sha256(AFTER_SQL),
          reason: "Index-only approval",
        }],
      }, null, 2),
    );
    git(localOnly.root, ["add", "--", RECEIPT_PATH]);
    expect(isRecordedMainMergeMigration(localOnly.migrationPath, localOnly.root)).toBe(false);

    for (const field of ["beforeSha256", "afterSha256"] as const) {
      const mismatch = createMergeFixture({
        receipt: (rewrite) => ({
          schemaVersion: 1,
          rewrites: [{ ...rewrite, [field]: "f".repeat(64) }],
        }),
      });
      expect(isRecordedMainMergeMigration(mismatch.migrationPath, mismatch.root)).toBe(false);
    }
  });

  test("rejects a local staged rewrite even when a local approval edit claims it", () => {
    const approvalEdit = createMergeFixture();
    const localSql = `${AFTER_SQL}-- local edit\n`;
    write(approvalEdit.root, approvalEdit.migrationPath, localSql);
    write(
      approvalEdit.root,
      RECEIPT_PATH,
      JSON.stringify({
        schemaVersion: 1,
        rewrites: [{
          path: approvalEdit.migrationPath,
          createdAt: 2,
          beforeSha256: sha256(BEFORE_SQL),
          afterSha256: sha256(localSql),
          reason: "Uncommitted local claim",
        }],
      }, null, 2),
    );
    git(approvalEdit.root, ["add", "--", approvalEdit.migrationPath, RECEIPT_PATH]);
    expect(isRecordedMainMergeMigration(approvalEdit.migrationPath, approvalEdit.root)).toBe(false);
  });

  test("fails closed for a malformed incoming receipt and a non-SQL path", () => {
    const malformed = createMergeFixture({ receipt: "{not-json" });
    expect(isRecordedMainMergeMigration(malformed.migrationPath, malformed.root)).toBe(false);

    const nonSql = createMergeFixture({
      migrationPath: "packages/db/src/migrations/0999_merge_guard_fixture.txt",
    });
    expect(isRecordedMainMergeMigration(nonSql.migrationPath, nonSql.root)).toBe(false);
  });
});
