import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { soulGenerationAttempts } from "../../src/schema";

const migrations = resolve(import.meta.dir, "../../src/migrations");

describe("personal Soul attempt admission storage", () => {
  test("has a Human-scoped, indexed receipt with cascading deletion", () => {
    const table = getTableConfig(soulGenerationAttempts);
    expect(table.columns.map((column) => column.name)).toEqual([
      "id", "human_user_id", "started_at",
    ]);
    expect(table.indexes.some((index) =>
      index.config.name === "idx_soul_generation_attempts_human_time"
    )).toBe(true);
    expect(table.foreignKeys.some((key) => key.onDelete === "cascade")).toBe(true);
  });

  test("revokes the default Agent and crypto grants before service use", () => {
    const grantMigration = readFileSync(
      resolve(migrations, "0311_soul_generation_attempt_privileges.sql"),
      "utf8",
    );
    expect(grantMigration).toContain(
      'REVOKE ALL ON TABLE "soul_generation_attempts" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
  });
});
