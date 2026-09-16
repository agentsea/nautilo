import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  BACKGROUND_AUTHORIZATION_BYTE_LIMITS,
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS,
  CRYPTO_STORAGE_TABLE_PRIVILEGES,
  LATTICE_STORAGE_ADAPTER_TABLE_NAMES,
  LATTICE_STORAGE_TABLE_NAMES,
  LATTICE_STORAGE_TABLES,
  backgroundCryptoAuthorizationRequests,
  cryptoObjects,
  nautiloCryptoRole,
  processorCryptoSignerAuthorizations,
} from "../../src/schema/crypto-storage";
import {
  ROOM_JOURNAL_CRYPTO_PUBLICATION_LIMITS,
  roomEventRollups,
  roomEvents,
  roomJournalCryptoPublications,
} from "../../src/schema/room-journal";

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((constraint) => constraint.name);
}

function indexNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).indexes
    .map((index) => index.config.name)
    .filter((name): name is string => typeof name === "string");
}

function uniqueNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).uniqueConstraints
    .map((constraint) => constraint.name)
    .filter((name): name is string => typeof name === "string");
}

function expectIncludes(actual: string[], expected: readonly string[]): void {
  for (const value of expected) expect(actual).toContain(value);
}

function checkSql(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): string {
  const constraint = getTableConfig(table).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint, name).toBeDefined();
  return new PgDialect().sqlToQuery(constraint!.value).sql;
}

function normalizedSql(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

describe("M241 background authorization durable schema", () => {
  test("admits the exact semantic Reflection V2 work-purpose pairs", () => {
    const workKindSql = checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_work_kind",
    );
    const purposeSql = checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_purpose",
    );
    const coherenceSql = normalizedSql(checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_work_purpose_coherent",
    ));

    for (const [workKind, purpose] of [
      ["reflection.search_projection", "record.search_projection"],
      ["reflection.organization", "record.organize"],
      ["reflection.dependency_rewrite", "record.dependency_rewrite"],
    ] as const) {
      expect(workKindSql).toContain(workKind);
      expect(purposeSql).toContain(purpose);
      expect(coherenceSql).toContain(
        `= '${workKind}' and "background_crypto_authorization_requests"."format_version" = 2 and "background_crypto_authorization_requests"."purpose" = '${purpose}'`,
      );
    }
  });

  test("freezes product policy and opaque-wire bounds independently of crypto imports", () => {
    expect(BACKGROUND_AUTHORIZATION_BYTE_LIMITS).toEqual({
      hash: 32,
      legacyDescriptor: 131_072,
      legacyProcessorResponse: 200_704,
      legacySignerAuthorization: 131_072,
      descriptor: 16_457_643,
      processorResponse: 35_669_931,
      agentResponse: 16_912_384,
      response: 35_669_931,
      recipientPublicKey: 65,
      signingPublicKey: 32,
      signerAuthorization: 16_458_519,
    });
    expect(BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS).toEqual({
      maximumAttempts: 8,
      maximumOutputObjects: 256,
      productTtlSeconds: 300,
      claimLeaseSeconds: 120,
      terminalRetentionDays: 30,
      pruningBatch: 256,
    });
    expect(ROOM_JOURNAL_CRYPTO_PUBLICATION_LIMITS).toEqual({
      attachmentPlanBytes: 131_072,
      maximumOutputObjects: 5,
      maximumAttempts: 8,
      leaseSeconds: 120,
    });
  });

  test("adds one mutable request ledger and append-only signer evidence to crypto storage", () => {
    expect(LATTICE_STORAGE_ADAPTER_TABLE_NAMES).toHaveLength(15);
    expect(LATTICE_STORAGE_TABLE_NAMES.slice(-4)).toEqual([
      "background_crypto_authorization_requests",
      "background_crypto_authorization_domain_requirements",
      "background_crypto_authorization_namespace_requirements",
      "processor_crypto_signer_authorizations",
    ]);
    expect(LATTICE_STORAGE_TABLES.slice(-4).map(getTableName)).toEqual([
      "background_crypto_authorization_requests",
      "background_crypto_authorization_domain_requirements",
      "background_crypto_authorization_namespace_requirements",
      "processor_crypto_signer_authorizations",
    ]);
    expect(
      CRYPTO_STORAGE_TABLE_PRIVILEGES
        .background_crypto_authorization_requests,
    ).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
    expect(
      CRYPTO_STORAGE_TABLE_PRIVILEGES
        .processor_crypto_signer_authorizations,
    ).toEqual(["SELECT", "INSERT"]);

    for (const table of [
      backgroundCryptoAuthorizationRequests,
      processorCryptoSignerAuthorizations,
    ]) {
      const config = getTableConfig(table);
      expect(config.enableRLS, config.name).toBe(true);
      expect(config.policies.length, config.name).toBeGreaterThan(0);
      for (const policy of config.policies) {
        expect(policy.to, `${config.name}.${policy.name}`).toBe(
          nautiloCryptoRole,
        );
      }
    }
  });

  test("stores a strict typed request state without a private key, JSON, or plaintext", () => {
    expect(columnNames(backgroundCryptoAuthorizationRequests)).toEqual([
      "request_id",
      "format_version",
      "work_identity_hash",
      "idempotency_key",
      "work_id",
      "work_kind",
      "purpose",
      "namespace_id",
      "domain_id",
      "credential_subject_kind",
      "processor_kind",
      "processor_version",
      "processor_authorization_revision",
      "agent_id",
      "agent_runtime_generation",
      "agent_authorization_revision",
      "expected_domain_epoch",
      "expected_namespace_access_revision",
      "expected_policy_revision",
      "recipient_generation",
      "descriptor_hash",
      "descriptor_bytes",
      "recipient_key_id",
      "recipient_public_key",
      "recipient_expires_at",
      "accepted_response_kind",
      "accepted_response_hash",
      "accepted_response_bytes",
      "credential_id",
      "credential_hash",
      "issuing_human_id",
      "issuing_device_id",
      "issuing_device_authorization_revision",
      "issuer_signing_public_key_hash",
      "accepted_at",
      "authorization_expires_at",
      "request_revision",
      "state",
      "claim_id",
      "claim_expires_at",
      "transform_commit_claim_id",
      "transform_commit_descriptor_hash",
      "transform_commit_recipient_generation",
      "transform_commit_output_count",
      "transform_committed_at",
      "retry_count",
      "maximum_attempts",
      "last_retry_reason",
      "next_attempt_at",
      "terminal_reason",
      "finished_at",
      "created_at",
      "updated_at",
    ]);
    expect(
      columnNames(backgroundCryptoAuthorizationRequests).some((name) =>
        /private|secret|plaintext|prompt|model_output|json/.test(name)
      ),
    ).toBe(false);
    expectIncludes(checkNames(backgroundCryptoAuthorizationRequests), [
      "background_crypto_authorization_requests_format_version",
      "background_crypto_authorization_requests_domain_epoch_coherent",
      "background_crypto_authorization_requests_subject_coherent",
      "background_crypto_authorization_requests_work_subject_coherent",
      "background_crypto_authorization_requests_work_purpose_coherent",
      "background_crypto_authorization_requests_descriptor_coherent",
      "background_crypto_authorization_requests_legacy_carrier_bounds",
      "background_crypto_authorization_requests_recipient_coherent",
      "background_crypto_authorization_requests_response_coherent",
      "background_crypto_authorization_requests_recipient_ttl",
      "background_crypto_authorization_requests_authorization_ttl",
      "background_crypto_authorization_requests_claim_coherent",
      "background_crypto_authorization_requests_retry_bounds",
      "background_crypto_authorization_requests_terminal_coherent",
      "background_crypto_authorization_requests_time_order",
    ]);
    expectIncludes(uniqueNames(backgroundCryptoAuthorizationRequests), [
      "uq_background_crypto_authorization_requests_work_identity",
      "uq_background_crypto_authorization_requests_idempotency",
    ]);
    expectIncludes(indexNames(backgroundCryptoAuthorizationRequests), [
      "idx_background_crypto_authorization_requests_eligible",
      "idx_background_crypto_authorization_requests_recipient_expiry",
      "idx_background_crypto_authorization_requests_claim_expiry",
      "idx_background_crypto_authorization_requests_terminal_cleanup",
    ]);
  });

  test("enforces response-family wire ceilings and five-minute durable TTLs", () => {
    const responseSql = normalizedSql(
      checkSql(
        backgroundCryptoAuthorizationRequests,
        "background_crypto_authorization_requests_response_coherent",
      ),
    );
    expect(responseSql).toContain(
      `"accepted_response_kind" = 'processor'`,
    );
    expect(responseSql).toContain(
      `"accepted_response_bytes") between 1 and 35669931`,
    );
    expect(responseSql).toContain(
      `"accepted_response_kind" = 'agent'`,
    );
    expect(responseSql).toContain(
      `"accepted_response_bytes") between 1 and 16912384`,
    );

    const recipientTtlSql = checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_recipient_ttl",
    );
    expect(recipientTtlSql).toContain(
      `"updated_at" < "background_crypto_authorization_requests"."recipient_expires_at"`,
    );
    expect(recipientTtlSql).toContain("interval '300 seconds'");

    const authorizationTtlSql = checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_authorization_ttl",
    );
    expect(authorizationTtlSql).toContain(
      `"accepted_at" < "background_crypto_authorization_requests"."authorization_expires_at"`,
    );
    expect(authorizationTtlSql).toContain("interval '300 seconds'");

    const terminalReasonSql = checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_terminal_reason",
    );
    expect(terminalReasonSql).toContain("'integrity_failure'");
    const terminalCoherenceSql = checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_terminal_coherent",
    );
    expect(terminalCoherenceSql).toContain("'integrity_failure'");
  });

  test("keeps successful processor signer evidence append-only and independent of prunable requests", () => {
    const config = getTableConfig(processorCryptoSignerAuthorizations);
    expect(columnNames(processorCryptoSignerAuthorizations)).toEqual([
      "authorization_id",
      "format_version",
      "request_id",
      "recipient_generation",
      "processor_kind",
      "processor_version",
      "work_id",
      "namespace_id",
      "domain_id",
      "domain_epoch",
      "namespace_access_revision",
      "policy_revision",
      "processor_authorization_revision",
      "issuing_human_id",
      "issuing_device_id",
      "issuing_device_authorization_revision",
      "issuer_signing_public_key_hash",
      "signer_key_id",
      "signer_public_key",
      "work_descriptor_hash",
      "work_descriptor_bytes",
      "authorization_hash",
      "credential_hash",
      "authorization_bytes",
      "issued_at",
      "expires_at",
      "created_at",
    ]);
    expect(config.foreignKeys).toHaveLength(0);
    expectIncludes(uniqueNames(processorCryptoSignerAuthorizations), [
      "uq_processor_crypto_signer_authorizations_request_generation",
      "uq_processor_crypto_signer_authorizations_signer_key",
      "uq_processor_crypto_signer_authorizations_authorization_hash",
      "uq_processor_crypto_signer_authorizations_credential_hash",
    ]);
    expectIncludes(checkNames(processorCryptoSignerAuthorizations), [
      "processor_crypto_signer_authorizations_processor",
      "processor_crypto_signer_authorizations_generation_safe",
      "processor_crypto_signer_authorizations_format_version",
      "processor_crypto_signer_authorizations_legacy_authority_coherent",
      "processor_crypto_signer_authorizations_public_key_size",
      "processor_crypto_signer_authorizations_descriptor_hash_size",
      "processor_crypto_signer_authorizations_descriptor_size",
      "processor_crypto_signer_authorizations_authorization_size",
      "processor_crypto_signer_authorizations_legacy_carrier_bounds",
      "processor_crypto_signer_authorizations_time_order",
    ]);
    expect(
      checkSql(
        processorCryptoSignerAuthorizations,
        "processor_crypto_signer_authorizations_time_order",
      ),
    ).toContain("interval '300 seconds'");
  });

  test("adds unique no-cascade journal mappings and a bounded product receipt", () => {
    for (const table of [roomEvents, roomEventRollups]) {
      const config = getTableConfig(table);
      const mapping = config.columns.find(
        (column) => column.name === "crypto_object_id",
      );
      expect(mapping?.notNull, config.name).toBe(false);
      expect(
        config.uniqueConstraints.find((constraint) =>
          constraint.columns.some(
            (column) => column.name === "crypto_object_id",
          )
        ),
        config.name,
      ).toBeDefined();
      const foreignKey = config.foreignKeys.find((constraint) =>
        constraint.reference().columns.some(
          (column) => column.name === "crypto_object_id",
        )
      );
      expect(foreignKey, config.name).toBeDefined();
      expect(
        foreignKey && getTableName(foreignKey.reference().foreignTable),
        config.name,
      ).toBe(getTableName(cryptoObjects));
      expect(foreignKey?.onDelete, config.name).not.toBe("cascade");
    }

    expect(columnNames(roomJournalCryptoPublications)).toEqual([
      "publication_id",
      "request_id",
      "room_id",
      "namespace_id_at_allocation",
      "work_id",
      "source_batch_id",
      "rebuild_generation",
      "work_identity_hash",
      "descriptor_hash",
      "attachment_plan_version",
      "attachment_plan_hash",
      "attachment_plan_bytes",
      "output_object_count",
      "state",
      "lease_token",
      "lease_expires_at",
      "retry_count",
      "maximum_attempts",
      "failure_code",
      "last_failure_at",
      "crypto_committed_at",
      "attached_at",
      "tombstone_requested_at",
      "tombstoned_at",
      "last_audited_at",
      "created_at",
      "updated_at",
    ]);
    expectIncludes(uniqueNames(roomJournalCryptoPublications), [
      "uq_room_journal_crypto_publications_request",
      "uq_room_journal_crypto_publications_work",
      "uq_room_journal_crypto_publications_work_identity",
    ]);
    expectIncludes(checkNames(roomJournalCryptoPublications), [
      "room_journal_crypto_publications_attachment_plan",
      "room_journal_crypto_publications_output_count",
      "room_journal_crypto_publications_state",
      "room_journal_crypto_publications_lease_coherent",
      "room_journal_crypto_publications_retry_bounds",
      "room_journal_crypto_publications_failure_coherent",
      "room_journal_crypto_publications_publication_coherent",
      "room_journal_crypto_publications_time_order",
    ]);
    expect(
      columnNames(roomJournalCryptoPublications).some((name) =>
        /content|statement|plaintext|prompt|model_output|secret|private/.test(
          name,
        )
      ),
    ).toBe(false);
    const failureConstraint = getTableConfig(
      roomJournalCryptoPublications,
    ).checks.find((constraint) =>
      constraint.name === "room_journal_crypto_publications_failure_code"
    );
    expect(failureConstraint).toBeDefined();
    expect(inspect(failureConstraint!.value.queryChunks)).not.toContain(
      "'unknown'",
    );
    expectIncludes(indexNames(roomJournalCryptoPublications), [
      "idx_room_journal_crypto_publications_reconciliation",
      "idx_room_journal_crypto_publications_lease",
      "idx_room_journal_crypto_publications_audit",
    ]);
  });

  test("permits content-free zero-output completion while keeping publication scope closed", () => {
    const outputSql = checkSql(
      roomJournalCryptoPublications,
      "room_journal_crypto_publications_output_count",
    );
    expect(outputSql).toContain("between 0");
    expect(outputSql).toContain("and 5");

    const leaseSql = normalizedSql(
      checkSql(
        roomJournalCryptoPublications,
        "room_journal_crypto_publications_lease_coherent",
      ),
    );
    expect(leaseSql).toMatch(
      /"state" in \( 'reserved', 'crypto_committed', 'tombstone_pending' \)/,
    );
    expect(leaseSql).toContain(
      `"updated_at" < "room_journal_crypto_publications"."lease_expires_at"`,
    );
    expect(leaseSql).toContain("interval '120 seconds'");

    const publicationSql = checkSql(
      roomJournalCryptoPublications,
      "room_journal_crypto_publications_publication_coherent",
    );
    expect(publicationSql).not.toContain(`"output_object_count"`);
    expect(publicationSql).not.toContain(
      `"state" in ('quarantined', 'superseded')`,
    );
    expect(publicationSql).toContain(`"state" = 'quarantined'`);
    expect(publicationSql).toContain(`"state" = 'superseded'`);
    expect(publicationSql).toMatch(
      /"state" = 'superseded'[\s\S]*?"crypto_committed_at" is null[\s\S]*?"attached_at" is null[\s\S]*?"tombstone_requested_at" is null[\s\S]*?"tombstoned_at" is null/,
    );
    expect(publicationSql).toMatch(
      /"state" = 'quarantined'[\s\S]*?"attached_at" is null[\s\S]*?"tombstone_requested_at" is null[\s\S]*?"tombstoned_at" is null/,
    );
  });
});
