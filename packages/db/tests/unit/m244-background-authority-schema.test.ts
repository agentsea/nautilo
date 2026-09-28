import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  CRYPTO_STORAGE_TABLE_PRIVILEGES,
  LATTICE_STORAGE_TABLE_NAMES,
  LATTICE_STORAGE_TABLES,
  backgroundCryptoAuthorizationDomainRequirements,
  backgroundCryptoAuthorizationNamespaceRequirements,
  backgroundCryptoAuthorizationRequests,
  nautiloCryptoRole,
} from "../../src/schema/crypto-storage";

function config(
  table: Parameters<typeof getTableConfig>[0],
): ReturnType<typeof getTableConfig> {
  return getTableConfig(table);
}

function columns(table: Parameters<typeof getTableConfig>[0]): string[] {
  return config(table).columns.map((column) => column.name);
}

function checkSql(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): string {
  const constraint = config(table).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint, name).toBeDefined();
  return new PgDialect().sqlToQuery(constraint!.value).sql
    .replaceAll(/\s+/g, " ")
    .trim();
}

describe("M244 background Agent v2 authority-set schema", () => {
  test("admits both V2 subjects and retains the existing Agent authority tables", () => {
    expect(
      checkSql(
        backgroundCryptoAuthorizationRequests,
        "background_crypto_authorization_requests_format_version",
      ),
    ).toMatch(
      /"format_version" = 1 or \( .*"format_version" = 2 and .*"credential_subject_kind" in \('agent', 'processor'\) \)/,
    );

    expect(LATTICE_STORAGE_TABLE_NAMES.slice(-4)).toEqual([
      "background_crypto_authorization_requests",
      "background_crypto_authorization_domain_requirements",
      "background_crypto_authorization_namespace_requirements",
      "processor_crypto_signer_authorizations",
    ]);
    expect(LATTICE_STORAGE_TABLES.slice(-4).map(getTableName)).toEqual([
      ...LATTICE_STORAGE_TABLE_NAMES.slice(-4),
    ]);
    expect(
      CRYPTO_STORAGE_TABLE_PRIVILEGES
        .background_crypto_authorization_domain_requirements,
    ).toEqual(["SELECT", "INSERT", "DELETE"]);
    expect(
      CRYPTO_STORAGE_TABLE_PRIVILEGES
        .background_crypto_authorization_namespace_requirements,
    ).toEqual(["SELECT", "INSERT", "DELETE"]);
  });

  test("stores one canonical bounded row per Domain requirement", () => {
    expect(columns(backgroundCryptoAuthorizationDomainRequirements)).toEqual([
      "request_id",
      "domain_id",
      "ordinal",
      "expected_epoch",
      "expected_agent_authorization_revision",
      "expected_authorization_revision",
    ]);
    const table = config(backgroundCryptoAuthorizationDomainRequirements);
    expect(table.primaryKeys).toHaveLength(1);
    expect(table.primaryKeys[0]!.columns.map((column) => column.name)).toEqual([
      "request_id",
      "domain_id",
    ]);
    expect(
      table.uniqueConstraints.find(
        (constraint) =>
          constraint.name === "uq_bg_crypto_auth_domain_req_ordinal",
      )?.columns.map((column) => column.name),
    ).toEqual(["request_id", "ordinal"]);
    expect(table.foreignKeys).toHaveLength(0);
    for (const name of [
      "bg_crypto_auth_domain_req_ordinal_range",
      "bg_crypto_auth_domain_req_epoch_safe",
      "bg_crypto_auth_domain_req_agent_revision_safe",
    ]) {
      expect(table.checks.some((constraint) => constraint.name === name)).toBe(
        true,
      );
    }
  });

  test("stores exact Namespace operations with repository-validated Domain binding", () => {
    expect(columns(backgroundCryptoAuthorizationNamespaceRequirements)).toEqual([
      "request_id",
      "namespace_id",
      "ordinal",
      "domain_id",
      "operation_mask",
      "expected_access_revision",
      "expected_policy_revision",
    ]);
    const table = config(backgroundCryptoAuthorizationNamespaceRequirements);
    expect(table.primaryKeys[0]!.columns.map((column) => column.name)).toEqual([
      "request_id",
      "namespace_id",
    ]);
    expect(
      table.uniqueConstraints.find(
        (constraint) => constraint.name === "uq_bg_crypto_auth_ns_req_ordinal",
      )?.columns.map((column) => column.name),
    ).toEqual(["request_id", "ordinal"]);
    expect(checkSql(
      backgroundCryptoAuthorizationNamespaceRequirements,
      "bg_crypto_auth_ns_req_operation_mask",
    )).toContain('"operation_mask" between 1 and 3');

    expect(table.foreignKeys).toHaveLength(0);
  });

  test("keeps both authority inventories crypto-role-only and content-free", () => {
    for (const table of [
      backgroundCryptoAuthorizationDomainRequirements,
      backgroundCryptoAuthorizationNamespaceRequirements,
    ]) {
      const tableConfig = config(table);
      expect(tableConfig.enableRLS, tableConfig.name).toBe(true);
      const policyPrefix = tableConfig.name.includes("namespace")
        ? "bg_crypto_auth_ns_req"
        : "bg_crypto_auth_domain_req";
      expect(tableConfig.policies.map((policy) => policy.name)).toEqual([
        `${policyPrefix}_crypto_sel`,
        `${policyPrefix}_crypto_ins`,
        `${policyPrefix}_crypto_del`,
      ]);
      for (const policy of tableConfig.policies) {
        expect(policy.to, `${tableConfig.name}.${policy.name}`).toBe(
          nautiloCryptoRole,
        );
      }
      expect(columns(table).join("_")).not.toMatch(
        /root|key|grant|credential|secret|private|plaintext|payload|content|json/,
      );
    }
  });
});
