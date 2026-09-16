import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  CONTENT_ACCESS_OPERATION_OUTCOMES,
  contentAccessOperations,
} from "../../src/schema";

function checkSql(name: string): string {
  const constraint = getTableConfig(contentAccessOperations).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint, name).toBeDefined();
  return new PgDialect().sqlToQuery(constraint!.value).sql
    .replaceAll(/\s+/g, " ")
    .trim();
}

describe("M322 terminal content-access receipt schema", () => {
  test("stores one content-free historical result without prepared state", () => {
    const columns = getTableColumns(contentAccessOperations);
    expect(Object.keys(columns)).toEqual([
      "operationId",
      "requestDigest",
      "requesterUserId",
      "requesterActorId",
      "memoryId",
      "artifactId",
      "outcome",
      "changed",
      "attachedCount",
      "detachedCount",
      "skippedCount",
      "createdAt",
    ]);
    expect(columns.operationId?.primary).toBe(true);
    expect(columns.operationId?.hasDefault).toBe(false);
    expect(columns.requestDigest?.notNull).toBe(true);
    expect(columns.outcome?.enumValues).toEqual([...CONTENT_ACCESS_OPERATION_OUTCOMES]);
    expect(columns.outcome?.notNull).toBe(true);
    for (const forbidden of [
      "content",
      "result",
      "plan",
      "audience",
      "namespaceId",
      "token",
      "expiresAt",
      "pendingAt",
      "claimOwner",
      "nextAttemptAt",
    ]) expect(Reflect.has(columns, forbidden)).toBe(false);
  });

  test("binds exactly one object lifetime and preserves requester audit continuity", () => {
    const config = getTableConfig(contentAccessOperations);
    expect(config.enableRLS).toBe(true);
    expect(config.policies.map((policy) => policy.name)).toEqual([
      "content_access_operations_product_read",
      "content_access_operations_product_append",
    ]);
    expect(config.policies.map((policy) => policy.for)).toEqual([
      "select",
      "insert",
    ]);
    for (const policy of config.policies) {
      expect(policy.to).toHaveProperty("name", "nautilo");
    }
    expect(config.policies.some((policy) => policy.for === "update")).toBe(false);
    expect(config.policies.some((policy) => policy.for === "delete")).toBe(false);
    const foreignKeys = config.foreignKeys.map((foreignKey) => ({
      columns: foreignKey.reference().columns.map((column) => column.name),
      onDelete: foreignKey.onDelete,
    }));
    expect(foreignKeys).toContainEqual({ columns: ["requester_user_id"], onDelete: "set null" });
    expect(foreignKeys).toContainEqual({ columns: ["requester_actor_id"], onDelete: "set null" });
    expect(foreignKeys).toContainEqual({ columns: ["memory_id"], onDelete: "cascade" });
    expect(foreignKeys).toContainEqual({ columns: ["artifact_id"], onDelete: "cascade" });
    expect(config.indexes.map((index) => index.config.name)).toContainAllValues([
      "idx_content_access_operations_memory",
      "idx_content_access_operations_artifact",
    ]);
    expect(config.checks.map((check) => check.name)).toContainAllValues([
      "content_access_operations_request_digest_canonical",
      "content_access_operations_one_object",
      "content_access_operations_outcome_check",
      "content_access_operations_counts_nonnegative",
      "content_access_operations_changed_coherent",
      "content_access_operations_outcome_coherent",
    ]);

    expect(checkSql("content_access_operations_one_object"))
      .toContain('num_nonnulls("content_access_operations"."memory_id", "content_access_operations"."artifact_id") = 1');
    expect(checkSql("content_access_operations_counts_nonnegative"))
      .toContain('"attached_count" >= 0 and "content_access_operations"."detached_count" >= 0 and "content_access_operations"."skipped_count" >= 0');
    const changed = checkSql("content_access_operations_changed_coherent");
    expect(changed).toContain('"changed" = ("content_access_operations"."attached_count" > 0 or "content_access_operations"."detached_count" > 0)');
    expect(changed).not.toContain("+");
    const outcome = checkSql("content_access_operations_outcome_coherent");
    expect(outcome).toContain('"outcome" = \'applied\' and "content_access_operations"."changed"');
    expect(outcome).toContain('"outcome" = \'partial\'');
    expect(outcome).toContain("'already_applied', 'denied', 'stale', 'failed'");
    expect(outcome).toContain('and not "content_access_operations"."changed"');
  });
});
