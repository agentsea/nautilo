import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import receipt from "../../tools/db-migration-safety/comment-redactions.json";
import { isRecordedCommentRedaction } from "../../tools/db-migration-safety/check-comment-redaction";

describe("recorded migration comment redactions", () => {
  test("accepts only the exact source, destination and migration path", () => {
    for (const row of receipt.redactions) {
      expect(isRecordedCommentRedaction(row.path, row.beforeSha256, row.afterSha256)).toBe(true);
      expect(isRecordedCommentRedaction(`${row.path}.other`, row.beforeSha256, row.afterSha256)).toBe(false);
      expect(isRecordedCommentRedaction(row.path, "0".repeat(64), row.afterSha256)).toBe(false);
      expect(isRecordedCommentRedaction(row.path, row.beforeSha256, "0".repeat(64))).toBe(false);
      // Once merged, the exception cannot authorize another edit.
      expect(isRecordedCommentRedaction(row.path, row.afterSha256, row.afterSha256)).toBe(false);
    }
  });

  test("retained migration files match the reviewed post-redaction hashes", () => {
    for (const row of receipt.redactions) {
      const bytes = readFileSync(resolve(import.meta.dir, "../../..", row.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.afterSha256);
    }
  });
});
