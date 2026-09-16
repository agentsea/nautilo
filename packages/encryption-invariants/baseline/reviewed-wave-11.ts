import type { EncryptionCoverageEntry } from "../src/model";

const REPOSITORY =
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts";
const SCHEMA_EVIDENCE =
  "packages/db/tests/unit/m244-background-authority-schema.test.ts";
const MIGRATION_EVIDENCE =
  "packages/db/tests/unit/migration-0151-m244-background-authority-sets.test.ts";
const REPOSITORY_EVIDENCE =
  "packages/runtime/tests/unit/postgres-background-authorization-repository.test.ts";
const RETENTION =
  "One append-only ordered authority row is retained only with its bounded background request; the crypto repository transaction deletes Namespace rows, then Domain rows, then the terminal parent.";

const TABLES = Object.freeze([
  Object.freeze({
    id: "domain-requirements",
    table: "background_crypto_authorization_domain_requirements",
    columns: Object.freeze([
      "request_id",
      "domain_id",
      "ordinal",
      "expected_epoch",
      "expected_agent_authorization_revision",
    ]),
  }),
  Object.freeze({
    id: "namespace-requirements",
    table: "background_crypto_authorization_namespace_requirements",
    columns: Object.freeze([
      "request_id",
      "namespace_id",
      "ordinal",
      "domain_id",
      "operation_mask",
      "expected_access_revision",
      "expected_policy_revision",
    ]),
  }),
]);

function stableId(value: string): string {
  return value.replaceAll("_", "-");
}

function entry(input: Readonly<{
  id: string;
  locator: string;
  metadataAllowlist: readonly string[];
}>): EncryptionCoverageEntry {
  return {
    id: input.id,
    surface: "db",
    locator: input.locator,
    owner: "packages/runtime",
    readers: [REPOSITORY],
    writers: [REPOSITORY],
    migrationState: "not_applicable",
    retention: RETENTION,
    testEvidence: [SCHEMA_EVIDENCE, MIGRATION_EVIDENCE, REPOSITORY_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: input.metadataAllowlist,
    plaintextReason:
      "The closed allowlist contains only canonical request, Namespace, and Domain identifiers; immutable ordinals and operation masks; and bounded public authorization revisions. It contains no content, root, key, credential, plaintext, or provider payload.",
  };
}

const tableEntries = TABLES.flatMap((table) => [
  entry({
    id: `db.wave11.${table.id}`,
    locator: `public.${table.table}`,
    metadataAllowlist: table.columns,
  }),
  ...table.columns.map((column) => entry({
    id: `db.wave11.${table.id}.${stableId(column)}`,
    locator: `public.${table.table}.${column}`,
    metadataAllowlist: [column],
  })),
]);

const writerEntries = TABLES.flatMap((table, index) => [
  entry({
    id: `db.wave11.authority-writer-${String(index + 1).padStart(2, "0")}`,
    locator:
      `${REPOSITORY}##insertAuthoritySet:raw_sql:insert:public.${table.table}:1`,
    metadataAllowlist: table.columns,
  }),
  entry({
    id: `db.wave11.authority-pruner-${String(index + 1).padStart(2, "0")}`,
    locator:
      `${REPOSITORY}#pruneTerminal:raw_sql:delete:public.${table.table}:1`,
    metadataAllowlist: table.columns,
  }),
]);

/** Exact content-free durable surfaces and raw writers introduced by Wave 11. */
export const REVIEWED_WAVE_11_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...tableEntries,
    ...writerEntries,
  ];
