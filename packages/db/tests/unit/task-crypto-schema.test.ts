import { describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import {
  taskDefinitionCryptoRevisions,
  taskRunResultCryptoRevisions,
  taskRuns,
  tasks,
} from "../../src/schema";

const dialect = new PgDialect();
function checks(table: Parameters<typeof getTableConfig>[0]): string {
  return getTableConfig(table).checks.map((item) =>
    dialect.sqlToQuery(item.value).sql.replaceAll('"', "")
  ).join("\n");
}

describe("protected Task persistence schema", () => {
  test("keeps existing rows ordinary while exposing closed current mappings", () => {
    const taskColumns = getTableColumns(tasks);
    expect(taskColumns.prompt.notNull).toBe(true);
    expect(taskColumns.contentRepresentation.enumValues).toEqual([
      "ordinary", "dual", "protected",
    ]);
    expect(taskColumns.contentRepresentation.default).toBe("ordinary");
    expect(taskColumns.contentRevision.default).toBe(0);

    const runColumns = getTableColumns(taskRuns);
    expect(runColumns.resultRepresentation.enumValues).toEqual([
      "ordinary", "dual", "protected",
    ]);
    expect(runColumns.resultRepresentation.default).toBe("ordinary");
    expect(runColumns.resultRevision.default).toBe(0);

    expect(checks(tasks)).toContain("prompt = ''");
    expect(checks(tasks)).toContain("last_error is null");
    expect(checks(taskRuns)).toContain("result_text is null");
    expect(getTableConfig(tasks).foreignKeys.map((fk) => fk.getName()))
      .toContain("tasks_current_crypto_revision_fk");
    expect(getTableConfig(taskRuns).foreignKeys.map((fk) => fk.getName()))
      .toContain("task_runs_current_crypto_result_revision_fk");
  });

  test("historical repair provenance is closed, dual-only and rejects SQL unknown JSON fields", () => {
    for (const table of [taskDefinitionCryptoRevisions, taskRunResultCryptoRevisions]) {
      expect(getTableColumns(table).historicalRepair.notNull).toBe(false);
      const shape = getTableConfig(table).checks.find((item) => item.name.endsWith("_historical_repair"));
      expect(shape).toBeDefined();
      const statement = dialect.sqlToQuery(shape!.value).sql;
      expect(statement).toContain("is true");
      expect(statement).toContain("= 'dual'");
      expect(statement).toContain("sourceRevision");
      for (const field of ["claimId", "publisherDeviceId", "signedRequestDigest", "sourceDigest", "sourcePayloadHash"]) {
        expect(statement).toContain(`->'${field}') = 'string'`);
      }
    }
  });

  test("ordinary fallback receipts are nullable together and reject partial SQL-null receipts", () => {
    const columns = getTableColumns(tasks);
    for (const key of ["ordinaryFallbackOperationId", "ordinaryFallbackRequestDigest",
      "ordinaryFallbackReason", "ordinaryFallbackPolicyRevision", "ordinaryFallbackCompletedAt"] as const) {
      expect(columns[key].notNull).toBe(false);
    }
    const receipt = getTableConfig(tasks).checks.find(item =>
      item.name === "tasks_ordinary_fallback_receipt_coherent");
    expect(receipt).toBeDefined();
    const statement = dialect.sqlToQuery(receipt!.value).sql.replaceAll('"', "");
    for (const field of ["operation_id", "request_digest", "reason", "policy_revision", "completed_at"]) {
      expect(statement).toContain(`ordinary_fallback_${field} is null`);
      expect(statement).toContain(`ordinary_fallback_${field} is not null`);
    }
    expect(statement).toContain("octet_length(tasks.ordinary_fallback_request_digest) = 32");
    expect(statement).toContain("tasks.ordinary_fallback_policy_revision > 0");
    expect(statement).toContain("= 'target_encryption_not_ready'");
  });

  test("uses exactly two content-free receipt and revision ledgers", () => {
    for (const table of [
      taskDefinitionCryptoRevisions,
      taskRunResultCryptoRevisions,
    ]) {
      const columns = Object.keys(getTableColumns(table));
      for (const expected of [
        "operationId", "requestDigest", "authorityFingerprint",
        "requesterHumanId", "anchorNamespaceId", "contentNamespaceId",
        "cryptoObjectId", "representation", "payloadVersion", "cryptoAccessRevision",
        "requiredNamespaceFingerprint", "completion", "disposition",
        "attemptCount", "leaseToken", "failureCode",
      ]) expect(columns).toContain(expected);
      for (const forbidden of [
        "ciphertext", "payloadBytes", "wrappedDek", "envelopeBytes",
      ]) expect(columns).not.toContain(forbidden);
      expect(getTableColumns(table).representation.enumValues).toEqual([
        "protected", "dual",
      ]);
      expect(getTableColumns(table).representation.notNull).toBe(true);
      expect(getTableColumns(table).representation.default).toBeUndefined();
      const sql = checks(table);
      expect(sql).toContain("crypto_access_revision = 0");
      expect(sql).toContain("content_namespace_id =");
      expect(getTableConfig(table).policies).toHaveLength(1);
    }
    expect(checks(taskDefinitionCryptoRevisions)).toContain("task-definition:v1:");
    expect(getTableColumns(taskDefinitionCryptoRevisions).operationalMetadata.notNull)
      .toBe(true);
    expect(checks(taskRunResultCryptoRevisions)).toContain("task-run-result:v1:");
  });
});
