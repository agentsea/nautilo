import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_MAIN_2026_08_15_SOURCE_ALARMS,
} from "../../baseline/reviewed-main-2026-08-15-source-alarms";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";

describe("reviewed 2026-08-15 encryption inventory", () => {
  test("keeps Reflection semantic work content-free metadata", () => {
    const semanticWork = BASELINE_REGISTRY.entries.filter((entry) =>
      entry.locator.includes("reflection_record_semantic_work")
      || entry.locator.includes("reflection_record_source_")
      || entry.locator.includes("reflection_record_dependency_change_repairs")
    );
    expect(semanticWork.length).toBeGreaterThanOrEqual(56);
    expect(semanticWork.every((entry) =>
      entry.classification === "bounded_metadata"
    )).toBe(true);
    for (const entry of semanticWork) {
      if (entry.classification !== "bounded_metadata") {
        throw new Error(`${entry.locator} must remain bounded metadata`);
      }
      if (entry.locator === "public.reflection_record_semantic_work.ordinary_fallback_reason") {
        // The later replay review adds one closed reason enum, not payload.
        expect(entry.metadataAllowlist).toEqual(["ordinary_fallback_reason"]);
        expect(entry.plaintextReason).toContain("contain no Record semantic payload");
        expect(entry.plaintextReason).toContain("ordinary and protected payload representations retain their separate classifications");
      } else {
        expect(entry.plaintextReason).toMatch(/content-free|writes no Record payload/);
        expect(entry.plaintextReason).toMatch(/prompts?|source content/);
        expect(entry.plaintextReason).toMatch(/keys?|protected representation/);
      }
    }
  });

  test("does not disguise durable media prompts as metadata", () => {
    for (const locator of [
      "public.media_generations",
      "public.media_generations.request_payload",
    ]) {
      expect(BASELINE_REGISTRY.entries.some((entry) =>
        entry.locator === locator
      )).toBe(false);
      const link = BASELINE_REGISTRY.reviewedDebtLinks?.find((entry) =>
        entry.locator === locator
      );
      expect(link).toMatchObject({
        surface: "db",
        owner: "packages/db",
        targetDebtIds: ["debt.db.public.tasks.prompt"],
        crossBoundaryProjection: {
          fields: ["request_payload.prompt", "request_payload.lyrics"],
        },
      });
      expect(link?.reason).toContain("not bounded metadata");
    }

    const safeSnapshot = BASELINE_REGISTRY.entries.find((entry) =>
      entry.locator === "public.media_generations.safe_snapshot"
    );
    expect(safeSnapshot).toMatchObject({
      classification: "bounded_metadata",
      metadataAllowlist: ["safe_snapshot"],
    });
  });

  test("keeps public status routes content-free and closed", () => {
    for (const locator of [
      "http:request_response:GET /api/admin/reflection-status",
      "http:request_response:GET /api/media-generations/:receiptId",
    ]) {
      expect(BASELINE_REGISTRY.entries.find((entry) =>
        entry.locator === locator
      )).toMatchObject({
        surface: "wire",
        classification: "bounded_metadata",
      });
      const declaration = DTO_BASELINE_DECLARATIONS.find((entry) =>
        entry.locator === locator
      );
      expect(declaration).toBeDefined();
      expect(declaration?.arbitraryPayloads).toEqual([]);
      expect(declaration?.structuralSignatures?.length).toBeGreaterThan(1);
    }
  });

  test("distinguishes declared, excluded, and still-plaintext source boundaries", () => {
    expect(REVIEWED_MAIN_2026_08_15_SOURCE_ALARMS).toHaveLength(14);
    expect(REVIEWED_MAIN_2026_08_15_SOURCE_ALARMS.filter((review) =>
      review.closure === "declaration"
    )).toHaveLength(8);
    expect(REVIEWED_MAIN_2026_08_15_SOURCE_ALARMS.filter((review) =>
      review.closure === "reviewed_exclusion"
    )).toHaveLength(2);
    const debt = REVIEWED_MAIN_2026_08_15_SOURCE_ALARMS.filter((review) =>
      review.closure === "baseline_debt"
    );
    expect(debt).toHaveLength(4);
    expect(debt.map((review) => review.locator)).toEqual([
      "apps/cli/src/commands/backup.ts#backup_export:32617645b0b01ca2:1",
      "packages/agent/src/media-generation/artifact-writer.ts#filesystem_write:d4aeedf8367a20dc:1",
      "packages/agent/src/nodes/post-model.ts#log_emitter:89b81c36ea23316a:7",
      "packages/compose-lifecycle/src/lifecycle.ts#backup_export:9edc15f28c86b2a1:1",
    ]);
    for (const review of REVIEWED_MAIN_2026_08_15_SOURCE_ALARMS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
  });
});
