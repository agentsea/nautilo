import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import { protectedTaskPublicationIdlePredicate } from "../../src/queries/tasks";
import { tasks } from "../../src/schema/tasks";

describe("protected Task publication claim fence", () => {
  test("excludes the exact reserved next definition revision", () => {
    const db = drizzle.mock() as unknown as DirectDatabase;
    const compiled = db.select({ value: protectedTaskPublicationIdlePredicate(db) })
      .from(tasks)
      .toSQL();

    expect(compiled.sql).toContain("not exists");
    expect(compiled.sql).toContain("task_definition_crypto_revisions");
    expect(compiled.sql).toContain('"tasks"."content_revision" + 1');
  });
});
