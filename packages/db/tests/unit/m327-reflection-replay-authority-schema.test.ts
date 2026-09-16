import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  REFLECTION_RECORD_TABLES,
  reflectionRecordAuthorityDependencies,
  reflectionRecordPublications,
} from "../../src/schema/reflection-records";

function checkSql(name: string): string {
  const check = getTableConfig(reflectionRecordPublications).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(check).toBeDefined();
  return new PgDialect().sqlToQuery(check!.value).sql
    .replaceAll(/"[^"]+"\./g, "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

describe("M327 Reflection replay authority schema", () => {
  test("registers a product-only reverse authority dependency table", () => {
    const config = getTableConfig(reflectionRecordAuthorityDependencies);
    expect(getTableName(reflectionRecordAuthorityDependencies)).toBe(
      "reflection_record_authority_dependencies",
    );
    expect(config.columns.map((column) => column.name)).toEqual([
      "record_id",
      "dependency_record_id",
    ]);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.foreignKeys).toHaveLength(2);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "idx_reflection_record_authority_dependencies_source",
    ]);
    expect(config.checks.map((check) => check.name)).toEqual([
      "reflection_record_authority_dependencies_no_self",
    ]);
    expect(config.enableRLS).toBe(true);
    expect(config.policies).toHaveLength(1);
    expect(config.policies[0]?.to).toHaveProperty("name", "nautilo");
    expect(REFLECTION_RECORD_TABLES.map((table) => String(getTableName(table))))
      .toContain(
      "reflection_record_authority_dependencies",
    );
  });

  test("keeps legacy replay receipts all-null and complete new structure coherent", () => {
    const config = getTableConfig(reflectionRecordPublications);
    for (const column of [
      "replay_structural_height",
      "replay_processing_generation",
      "replay_predecessor_record_id",
      "replay_predecessor_relation",
    ]) {
      expect(config.columns.find((candidate) => candidate.name === column)?.notNull)
        .toBe(false);
    }
    const replayShape = checkSql("reflection_record_publications_replay_shape");
    expect(replayShape).toContain(
      '"replay_structural_height" is null and "replay_processing_generation" is null and "replay_predecessor_record_id" is null and "replay_predecessor_relation" is null',
    );
    expect(replayShape).toContain(
      '"replay_structural_height" is not null and "replay_structural_height" >= 0',
    );
    expect(replayShape).toContain(
      '"replay_processing_generation" is not null and "replay_processing_generation" > 0',
    );
    expect(replayShape).toContain(
      '"replay_predecessor_record_id" is null and "replay_predecessor_relation" is null',
    );
    expect(replayShape).toContain(
      '"replay_predecessor_record_id" is not null and "replay_predecessor_relation" is not null',
    );
    expect(replayShape).toContain(
      '"replay_predecessor_relation" in (\'supersedes\', \'resolves\')',
    );
  });
});
