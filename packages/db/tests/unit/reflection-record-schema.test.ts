import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  REFLECTION_RECORD_BYTE_LIMITS,
  REFLECTION_RECORD_COLLECTION_LIMITS,
  REFLECTION_RECORD_SEMANTIC_WORK_CHANGE_REASONS,
  REFLECTION_RECORD_SEMANTIC_WORK_FAILURE_CODES,
  REFLECTION_RECORD_SEMANTIC_WORK_STAGES,
  REFLECTION_RECORD_SEMANTIC_WORK_STATES,
  REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS,
  REFLECTION_RECORD_TABLES,
  nextReflectionRecordSemanticWorkStage,
  reflectionRecordAuthorityAlternatives,
  reflectionRecordAuthorityBlocks,
  reflectionRecordAuthorityChanges,
  reflectionRecordAuthorityClosure,
  reflectionRecordAuthorityDependencies,
  reflectionRecordAuthorityProjections,
  reflectionRecordAuthorityReconciliations,
  reflectionRecordDependencies,
  reflectionRecordDependencyChangeRepairs,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPublications,
  reflectionRecordSearchProjections,
  reflectionRecordSemanticWork,
  reflectionRecordSemanticWorkAdmissions,
  reflectionRecordSourceChangeRepairs,
  reflectionRecordSourceDependencyIndex,
  reflectionRecords,
  reflectionRecordSuccessors,
} from "../../src/schema/reflection-records";

const EXPECTED_TABLE_NAMES = [
  "reflection_records",
  "reflection_record_dependencies",
  "reflection_record_authority_dependencies",
  "reflection_record_successors",
  "reflection_record_payload_representations",
  "reflection_record_payload_representation_heads",
  "reflection_record_publications",
  "reflection_record_source_dependency_index",
  "reflection_record_semantic_work_admissions",
  "reflection_record_source_change_repairs",
  "reflection_record_dependency_change_repairs",
  "reflection_record_semantic_work",
  "reflection_record_authority_closure",
  "reflection_record_authority_projections",
  "reflection_record_authority_alternatives",
  "reflection_record_authority_changes",
  "reflection_record_authority_reconciliations",
  "reflection_record_authority_blocks",
  "reflection_record_search_projections",
] as const;

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

describe("Reflection durable Record schema", () => {
  test("owns one bounded content-free product table family", () => {
    expect(REFLECTION_RECORD_TABLES.map(getTableName)).toEqual(
      [...EXPECTED_TABLE_NAMES],
    );
    expect(REFLECTION_RECORD_BYTE_LIMITS).toEqual({
      portableId: 128,
      payload: 256 * 1_024,
      requestCommitment: 32,
      authorityCommitment: 32,
      sourceDependencyCommitment: 32,
      semanticAdmissionCommitment: 32,
      sealedCheckpoint: 256 * 1_024,
      failureCode: 64,
    });
    expect(REFLECTION_RECORD_COLLECTION_LIMITS).toEqual({
      maximumAttempts: 8,
      leaseSeconds: 2 * 60,
      repairPageMaximum: 256,
    });
    expect(REFLECTION_RECORD_SEMANTIC_WORK_STAGES).toEqual([
      "authority_projection",
      "search_projection",
      "organization",
    ]);
    expect(REFLECTION_RECORD_SEMANTIC_WORK_CHANGE_REASONS).toEqual([
      "scheduled_review",
      "created",
      "revised",
      "dependency_lost",
      "parent_conflict",
    ]);
    expect(REFLECTION_RECORD_SEMANTIC_WORK_STATES).toEqual([
      "due",
      "claimed",
      "checkpointed",
      "deferred",
      "complete",
      "quarantined",
    ]);
    expect(REFLECTION_RECORD_SEMANTIC_WORK_FAILURE_CODES).toEqual([
      "authority_unavailable",
      "record_unavailable",
      "embedding_unavailable",
      "projection_unavailable",
      "candidate_unavailable",
      "invalid_model_output",
      "publication_unavailable",
      "unexpected_failure",
      "retry_exhausted",
    ]);
    expect(nextReflectionRecordSemanticWorkStage("authority_projection"))
      .toBe("search_projection");
    expect(nextReflectionRecordSemanticWorkStage("search_projection"))
      .toBe("organization");
    expect(nextReflectionRecordSemanticWorkStage("organization"))
      .toBeUndefined();
    expect(REFLECTION_RECORD_SEARCH_PROJECTION_LIMITS).toEqual({
      providerText: 256,
      canonicalModelText: 256,
      dimensions: 1_536,
      projectionVersion: 1,
      embeddingContractVersion: 1,
    });
  });

  test("enables product-only RLS and grants no Agent or crypto policy", () => {
    for (const table of REFLECTION_RECORD_TABLES) {
      const config = getTableConfig(table);
      expect(config.enableRLS, config.name).toBe(true);
      expect(config.policies.length, config.name).toBeGreaterThan(0);
      for (const policy of config.policies) {
        expect(policy.to, `${config.name}.${policy.name}`).toHaveProperty(
          "name",
          "nautilo",
        );
      }
    }
  });

  test("keeps semantic content and source coordinates out of relational columns", () => {
    const forbidden = /statement|excerpt|anchor|source_(id|ref|revision|type|kind)|message|artifact|prompt|model_output|content_hash/u;
    for (const table of REFLECTION_RECORD_TABLES) {
      for (const column of columnNames(table)) {
        expect(column, getTableName(table)).not.toMatch(forbidden);
      }
    }
  });

  test("separates immutable representations from their CAS heads", () => {
    expect(columnNames(reflectionRecordPayloadRepresentations)).toEqual([
      "record_id",
      "representation",
      "representation_generation",
      "payload_version",
      "plaintext_payload_bytes",
      "crypto_object_id",
      "created_at",
    ]);
    expect(columnNames(reflectionRecordPayloadRepresentationHeads)).toEqual([
      "record_id",
      "representation",
      "current_representation_generation",
      "updated_at",
    ]);
  });

  test("persists only opaque graph, lifecycle, and bounded recovery state", () => {
    expect(columnNames(reflectionRecords)).toEqual([
      "record_id",
      "lifecycle",
      "structural_height",
      "producer_policy_version",
      "processing_generation",
      "payload_version",
      "disposition",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(reflectionRecordDependencies)).toEqual([
      "parent_record_id",
      "child_record_id",
    ]);
    expect(columnNames(reflectionRecordAuthorityDependencies)).toEqual([
      "record_id",
      "dependency_record_id",
    ]);
    expect(columnNames(reflectionRecordSuccessors)).toEqual([
      "predecessor_record_id",
      "successor_record_id",
      "relation",
      "created_at",
    ]);
    expect(columnNames(reflectionRecordPublications)).toContain(
      "request_commitment",
    );
    expect(columnNames(reflectionRecordPublications)).toContain(
      "reserved_crypto_object_id",
    );
    expect(columnNames(reflectionRecordPublications)).not.toContain(
      "payload_bytes",
    );
    const publicationConfig = getTableConfig(reflectionRecordPublications);
    expect(publicationConfig.checks.map((item) => item.name)).toContain(
      "reflection_record_publications_reserved_crypto_object_portable",
    );
    expect(publicationConfig.indexes.map((item) => item.config.name)).not
      .toContain("uq_reflection_record_publications_reserved_crypto_object");
    expect(publicationConfig.uniqueConstraints.flatMap((item) =>
      item.columns.map((column) => column.name))).not
      .toContain("reserved_crypto_object_id");
  });

  test("separates closure, immutable projection generations, work, and blocks", () => {
    expect(columnNames(reflectionRecordSourceDependencyIndex)).toEqual([
      "source_dependency_commitment",
      "record_id",
      "created_at",
    ]);
    expect(columnNames(reflectionRecordSemanticWork)).toEqual([
      "record_id",
      "generation",
      "completed_generation",
      "change_reason",
      "stage",
      "state",
      "claim_generation",
      "attempt_count",
      "quarantine_round",
      "lease_token",
      "lease_expires_at",
      "next_attempt_at",
      "recover_after",
      "failure_code",
      "ordinary_fallback_reason",
      "due_since",
      "started_at",
      "completed_at",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(reflectionRecordSemanticWorkAdmissions)).toEqual([
      "record_id",
      "admission_commitment",
      "assigned_generation",
      "created_at",
    ]);
    expect(columnNames(reflectionRecordSourceChangeRepairs)).toEqual([
      "source_change_commitment",
      "source_dependency_commitment",
      "continuation",
      "completed_at",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(reflectionRecordDependencyChangeRepairs)).toEqual([
      "change_commitment",
      "changed_record_id",
      "continuation",
      "completed_at",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(reflectionRecordAuthorityClosure)).toEqual([
      "record_id",
      "terminal_leaf_handle",
      "closure_generation",
      "created_at",
    ]);
    expect(columnNames(reflectionRecordAuthorityProjections)).toContain(
      "audience_set_commitment",
    );
    expect(columnNames(reflectionRecordAuthorityAlternatives)).toEqual([
      "record_id",
      "projection_generation",
      "alternative_ordinal",
      "access_namespace_id",
      "includes_public_boundary",
      "alternative_commitment",
    ]);
    expect(columnNames(reflectionRecordAuthorityChanges)).toEqual([
      "change_id",
      "terminal_leaf_handle",
      "source_change_generation",
      "admitted_at",
    ]);
    expect(columnNames(reflectionRecordAuthorityReconciliations)).toContain(
      "sealed_checkpoint",
    );
    expect(columnNames(reflectionRecordAuthorityReconciliations)).toContain(
      "former_crypto_object_id",
    );
    expect(columnNames(reflectionRecordAuthorityReconciliations)).not.toContain(
      "checkpoint_json",
    );
    expect(columnNames(reflectionRecordAuthorityBlocks)).toContain(
      "terminal_leaf_handle",
    );
  });

  test("keeps one bounded search projection row per Record", () => {
    expect(columnNames(reflectionRecordSearchProjections)).toEqual([
      "record_id",
      "record_processing_generation",
      "projection_version",
      "projection_generation",
      "embedding_provider",
      "embedding_canonical_model",
      "embedding_dimensions",
      "embedding_contract_version",
      "embedding",
      "created_at",
      "updated_at",
    ]);
    const config = getTableConfig(reflectionRecordSearchProjections);
    expect(config.columns.find((column) => column.name === "embedding")?.getSQLType())
      .toBe("vector(1536)");
    expect(config.indexes.map((item) => item.config.name)).toEqual([
      "idx_reflection_record_search_projections_provenance",
      "idx_reflection_record_search_projections_record",
    ]);
    expect(config.checks.map((item) => item.name)).toEqual([
      "reflection_record_search_projections_record_id_portable",
      "reflection_record_search_projections_generations_positive",
      "reflection_record_search_projections_version_v1",
      "reflection_record_search_projections_provider_bounded",
      "reflection_record_search_projections_model_bounded",
      "reflection_record_search_projections_dimensions_v1",
      "reflection_record_search_projections_contract_v1",
    ]);
  });
});
