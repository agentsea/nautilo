import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  BASELINE_REGISTRY,
  CURRENT_FROZEN_BASELINE_DEBT,
} from "../../baseline/existing-debt";
import {
  PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS,
  REVIEWED_PERSONAL_MEMORY_EXPOSURE_DEBT_LINKS,
  REVIEWED_PERSONAL_MEMORY_FUNDING_COVERAGE,
} from "../../baseline/reviewed-personal-memory-funding-coverage";
import { validateCoverageEntry } from "../../src/model";
import { REVIEWED_LANDING_DTO_DECLARATIONS } from "../../baseline/reviewed-main-2026-09-05-landing-dto";

const repoRoot = resolve(import.meta.dir, "../../../..");

async function source(path: string): Promise<string> {
  return Bun.file(resolve(repoRoot, path)).text();
}

describe("personal Memory funding and exposure encryption review", () => {
  test("reports unknown provider outcomes as a fixed operational code", () => {
    const declaration = REVIEWED_LANDING_DTO_DECLARATIONS.find((entry) =>
      entry.locator === "http:request_response:GET /api/admin/memory-status");
    expect(declaration).toBeDefined();
    expect(declaration!.structuralSignatures?.join("\n") ?? "").toContain(
      '"provider_failed"|"provider_outcome_unknown"|"publication_uncertain"',
    );
    expect(declaration!.arbitraryPayloads).toEqual([]);
  });
  test("classifies exact durable operation metadata without adding debt", () => {
    expect(PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS).toHaveLength(8);
    expect(REVIEWED_PERSONAL_MEMORY_FUNDING_COVERAGE).toHaveLength(8);
    expect(new Set(PERSONAL_MEMORY_FUNDING_METADATA_LOCATORS).size).toBe(8);

    for (const entry of REVIEWED_PERSONAL_MEMORY_FUNDING_COVERAGE) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
      expect(entry.classification).toBe("bounded_metadata");
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
    expect(CURRENT_FROZEN_BASELINE_DEBT.some((entry) =>
      entry.id.includes("personal-memory-funding")
    )).toBe(false);

    const allowlist = REVIEWED_PERSONAL_MEMORY_FUNDING_COVERAGE.flatMap(
      (entry) => entry.classification === "bounded_metadata"
        ? entry.metadataAllowlist
        : [],
    );
    for (const forbidden of [
      "content",
      "prompt",
      "output",
      "apiKey",
      "credentialValue",
      "providerError",
      "modelExposureDependencies",
    ]) {
      expect(allowlist).not.toContain(forbidden);
    }
  });

  test("keeps confidential ancestry linked to ordinary content and out of metadata", () => {
    expect(REVIEWED_PERSONAL_MEMORY_EXPOSURE_DEBT_LINKS).toHaveLength(2);
    expect(REVIEWED_PERSONAL_MEMORY_EXPOSURE_DEBT_LINKS.map((link) =>
      [link.locator, link.targetDebtIds]
    )).toEqual([
      [
        "public.memories.model_exposure_dependencies",
        ["debt.db.public.memories.content"],
      ],
      [
        "public.room_event_rollups.model_exposure_dependencies",
        ["debt.db.public.room_event_rollups.content"],
      ],
    ]);
    for (const link of REVIEWED_PERSONAL_MEMORY_EXPOSURE_DEBT_LINKS) {
      expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(link);
      expect(BASELINE_REGISTRY.entries.some((entry) =>
        entry.locator === link.locator
      )).toBe(false);
      expect(link.crossBoundaryProjection?.fields).toEqual([
        "model_exposure_dependencies",
      ]);
    }
  });

  test("requires clear ancestry to be absent from protected-only rows", async () => {
    const memorySchema = await source("packages/db/src/schema/memories.ts");
    expect(memorySchema).toContain(
      "sql`${table.content} is not null or ${table.modelExposureDependencies} is null`",
    );
    const journalSchema = await source("packages/db/src/schema/room-journal.ts");
    expect(journalSchema).toContain(
      "sql`${table.content} IS NOT NULL OR ${table.modelExposureDependencies} IS NULL`",
    );

    const memoryPayload = await source(
      "packages/lattice-bridge/src/memory/memory-payload-v1.ts",
    );
    expect(memoryPayload).toContain('"modelExposureDependencies"');
    expect(memoryPayload).toContain(
      "normalizeRecordModelExposureDependenciesV1",
    );
    const rollupPayload = await source(
      "packages/lattice-bridge/src/journal/room-event-rollup-payload-v1.ts",
    );
    expect(rollupPayload).toContain('"modelExposureDependencies"');
    expect(rollupPayload).toContain(
      "normalizeRecordModelExposureDependenciesV1",
    );
  });

  test("binds accepted funding and known-nonusable recovery to exact durable state", async () => {
    const bindingParser = await source(
      "packages/types/src/memory-operation-funding.ts",
    );
    expect(bindingParser).toContain(
      'const base = ["version", "role", "modelId", "inputCommitment", "kind"]',
    );
    expect(bindingParser).toContain(
      'const expected = row["kind"] === "human" ? [...base, "humanUserId", "preferenceRevision", "funding"] : base',
    );
    expect(bindingParser).toContain(
      "Object.keys(row).length !== expected.length",
    );

    const reviewSchema = await source("packages/db/src/schema/memory-review.ts");
    expect(reviewSchema).toContain(
      'acceptedModelBinding: jsonb("accepted_model_binding")',
    );

    const reflectionSchema = await source(
      "packages/db/src/schema/reflection-records.ts",
    );
    const bindingCheck = reflectionSchema.slice(
      reflectionSchema.indexOf(
        '"reflection_record_semantic_work_model_binding_coherent"',
      ),
      reflectionSchema.indexOf(
        '"reflection_record_semantic_work_schedule_coherent"',
      ),
    );
    expect(bindingCheck).toContain("${table.acceptedModelBinding} is null");
    expect(bindingCheck).toContain(
      "${table.acceptedModelBindingGeneration} = ${table.generation}",
    );

    const journalSchema = await source("packages/db/src/schema/room-journal.ts");
    const acceptedPlanType = journalSchema.slice(
      journalSchema.indexOf("export type StenographerCompactionAcceptedPlan"),
      journalSchema.indexOf("function productPolicy"),
    );
    expect(acceptedPlanType.match(/selectedEventIds/gu)).toHaveLength(1);
    expect(acceptedPlanType.match(/protectedTailEventIds/gu)).toHaveLength(1);
    expect(acceptedPlanType).toContain('owner: "ordinary"');
    expect(acceptedPlanType).toContain('owner: "protected"');
    expect(journalSchema).toContain(
      "(${table.compactionAcceptedModelBinding} IS NULL)\n        = (${table.compactionAcceptedPlan} IS NULL)",
    );
    const knownNonusableCheck = journalSchema.slice(
      journalSchema.indexOf('"room_journal_state_compaction_known_nonusable"'),
      journalSchema.indexOf(
        '"room_journal_state_extraction_lease_pair"',
      ),
    );
    expect(knownNonusableCheck).toContain(
      "NOT ${table.compactionLastAttemptKnownNonusable}",
    );
    expect(knownNonusableCheck).toContain(
      "${table.lastCompactionErrorCode} = 'invalid_output'",
    );
    expect(knownNonusableCheck).toContain(
      "${table.lastCompactionErrorCode} IS NOT NULL",
    );
    expect(knownNonusableCheck).toContain(
      "${table.compactionAcceptedModelBinding} IS NOT NULL",
    );
    expect(knownNonusableCheck).toContain(
      "${table.compactionAcceptedPlan} IS NOT NULL",
    );
  });
});
