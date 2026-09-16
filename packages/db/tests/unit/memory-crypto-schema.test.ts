import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/schema";

describe("Wave 12 additive Memory crypto schema", () => {
  test("adds only bounded mapping, revision, embedding, and origin metadata", () => {
    const columns = Object.keys(getTableColumns(schema.memories));
    for (const column of [
      "cryptoObjectId",
      "contentRevision",
      "cryptoAccessRevision",
      "cryptoRequiredNamespaceFingerprint",
      "embeddingRevision",
      "embeddingProvider",
      "embeddingModel",
      "embeddingDimensions",
      "embeddingContractVersion",
      "scopeOriginNamespaceId",
    ]) {
      expect(columns).toContain(column);
    }

    expect(getTableConfig(schema.memories).checks.map((item) => item.name))
      .not.toContain("memories_protected_mapping_clears_confidential_columns");
  });

  test("exports one content-free revision lifecycle ledger", () => {
    const table = Reflect.get(schema, "memoryCryptoRevisions") as
      | PgTable
      | undefined;
    expect(table).toBeDefined();
    const columns = Object.keys(getTableColumns(table!));
    for (const column of [
      "sequence",
      "memoryId",
      "contentRevision",
      "cryptoObjectId",
      "allocationRequestDigest",
      "completion",
      "disposition",
      "attemptCount",
      "failureCode",
      "createdAt",
      "updatedAt",
    ]) {
      expect(columns).toContain(column);
    }
  });

  test("exports append-only identity for every repeated mutation", () => {
    const table = Reflect.get(schema, "memoryCryptoOperations") as
      | PgTable
      | undefined;
    expect(table).toBeDefined();
    const columns = Object.keys(getTableColumns(table!));
    for (const column of [
      "operationId",
      "memoryId",
      "anchorNamespaceId",
      "operationType",
      "expectedContentRevision",
      "resultContentRevision",
      "expectedAccessRevision",
      "resultAccessRevision",
      "requestDigest",
      "targetRequiredNamespaceFingerprint",
      "completion",
      "disposition",
      "attemptCount",
    ]) {
      expect(columns).toContain(column);
    }

    const operationType = getTableColumns(table!)["operationType"];
    expect(operationType?.enumValues).toEqual([
      "update",
      "access",
      "delete",
      "metadata",
    ]);
  });

  test("enforces the existing seed/scope origin state in Drizzle", () => {
    const checks = getTableConfig(schema.memoryScopes).checks.map(
      (check) => check.name,
    );
    expect(checks).toContain("memory_scopes_origin_check");
  });
});
