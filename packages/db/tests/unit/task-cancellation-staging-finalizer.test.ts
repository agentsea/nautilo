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

  test("is the final generate-only migration step", () => {
    expect(packageJson.scripts["db:generate"]?.split(" && ").at(-1)).toBe(
      "bun scripts/finalize-task-cancellation-staging.ts",
    );
  });
});
