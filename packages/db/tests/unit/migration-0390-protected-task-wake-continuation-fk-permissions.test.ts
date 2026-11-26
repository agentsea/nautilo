import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../src/migrations/0390_protected_task_wake_continuation_fk_permissions.sql",
  ),
  "utf8",
);

describe("protected Task wake continuation FK privileges", () => {
  test("grants only the referencing column update needed by cascades", () => {
    expect(migration).toContain(
      "GRANT UPDATE(wake_job_id)\n  ON TABLE public.protected_task_wake_continuation_receipts TO nautilo;",
    );
    expect(migration).not.toMatch(/GRANT\s+UPDATE\s+ON\s+TABLE/iu);
    expect(migration).not.toMatch(/GRANT[^;]*(?:DELETE|TRIGGER)/iu);
    expect(migration).not.toMatch(/TO\s+(?:PUBLIC|nautilo_agent|nautilo_crypto)/iu);
  });
});
