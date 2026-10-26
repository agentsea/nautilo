import { describe, expect, test } from "bun:test";

import packageJson from "../../package.json";
import {
  TASK_CANCELLATION_STAGING_AUTHORITY_MARKER,
  finalizeTaskCancellationStagingMigration,
} from "../../scripts/finalize-task-cancellation-staging";

const TABLE = "task_cancellation_crypto_staging_receipts";

describe("Task cancellation crypto staging migration finalizer", () => {
  test("adds the exact crypto-only authority once", () => {
    const generated = `CREATE TABLE "${TABLE}" ("request_id" text PRIMARY KEY);`;
    const finalized = finalizeTaskCancellationStagingMigration(generated);

    expect(finalizeTaskCancellationStagingMigration(finalized)).toBe(finalized);
    expect(finalized.match(
      new RegExp(TASK_CANCELLATION_STAGING_AUTHORITY_MARKER, "g"),
    )).toHaveLength(1);
    expect(finalized).toContain(
      `ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`,
    );
    expect(finalized).toContain(
      `REVOKE ALL PRIVILEGES ON TABLE "${TABLE}" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto"`,
    );
    expect(finalized).toContain(
      `GRANT SELECT, INSERT ON TABLE "${TABLE}" TO "nautilo_crypto"`,
    );
    expect(finalized).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|TRIGGER)\b/);
  });

  test("ignores migrations that do not create the receipt table", () => {
    const unrelated = 'CREATE TABLE "crypto_objects" ("object_id" text);';
    expect(finalizeTaskCancellationStagingMigration(unrelated)).toBe(
      unrelated,
    );
  });

  test("keeps fresh Memory publication receipts immutable and crypto-only", () => {
    const table = "foreground_memory_crypto_publication_receipts";
    const generated = `CREATE TABLE "${table}" ("operation_id" text PRIMARY KEY);`;
    const finalized = finalizeTaskCancellationStagingMigration(generated);
    expect(finalizeTaskCancellationStagingMigration(finalized)).toBe(finalized);
    expect(finalized).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    expect(finalized).toContain(`GRANT SELECT, INSERT ON TABLE "${table}" TO "nautilo_crypto"`);
    expect(finalized).not.toMatch(/GRANT (?:UPDATE|DELETE|ALL)/);
    expect(finalized).toContain(`BEFORE UPDATE ON "${table}"`);
    expect(finalized).toContain("IF NEW IS DISTINCT FROM OLD THEN");
    expect(finalized).toContain("USING ERRCODE = '23514'");
    expect(finalized.match(/CREATE FUNCTION/g)).toHaveLength(1);
  });

  test("precedes the external transport and control finalizers at the end of canonical generation", () => {
    expect(packageJson.scripts["db:generate"]?.split(" && ").slice(-3)).toEqual([
      "bun scripts/finalize-task-cancellation-staging.ts",
      "bun scripts/finalize-magent-transport.ts",
      "bun scripts/finalize-magent-control.ts",
    ]);
  });
});
