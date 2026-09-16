import { describe, expect, test } from "bun:test";

import {
  REVIEWED_MAIN_2026_08_14_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_08_14_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-08-14-coverage";
import {
  REVIEWED_MAIN_2026_08_14_NEW_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_08_14_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-14-dto";
import {
  REVIEWED_MAIN_2026_08_14_SOURCE_ALARMS,
} from "../../baseline/reviewed-main-2026-08-14-source-alarms";
import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";

describe("reviewed 2026-08-14 main encryption boundaries", () => {
  test("keeps the approved M264 plaintext vector explicit as inherited debt", () => {
    expect(REVIEWED_MAIN_2026_08_14_DEBT_LINKS).toHaveLength(6);
    expect(REVIEWED_MAIN_2026_08_14_DEBT_LINKS.every((link) =>
      link.targetDebtIds.length === 1
      && link.targetDebtIds[0] === "debt.db.public.memories.embedding"
      && link.crossBoundaryProjection?.fields[0] === "embedding"
    )).toBe(true);
    const classified = new Set(
      REVIEWED_MAIN_2026_08_14_COVERAGE_ENTRIES.map((entry) => entry.locator),
    );
    for (const link of REVIEWED_MAIN_2026_08_14_DEBT_LINKS) {
      expect(classified.has(link.locator)).toBe(false);
    }
  });

  test("classifies Artifact cryptographic boundaries as Human protected", () => {
    const protectedArtifact = REVIEWED_MAIN_2026_08_14_COVERAGE_ENTRIES.filter(
      (entry) => entry.locator.includes("artifact")
        && entry.classification === "protected",
    );
    expect(protectedArtifact.length).toBeGreaterThan(0);
    expect(protectedArtifact.every((entry) =>
      entry.classification === "protected"
      && entry.keyFamily === "namespace_human"
      && entry.migrationState === "ciphertext_only"
    )).toBe(true);
  });

  test("keeps D513 client sessions bounded, ephemeral, and non-authoritative", () => {
    const sessions = REVIEWED_MAIN_2026_08_14_COVERAGE_ENTRIES.filter((entry) =>
      entry.locator.includes("client.session.v1")
      || entry.locator.includes("clientActionSessionId")
    );
    expect(sessions).toHaveLength(3);
    expect(sessions.every((entry) =>
      entry.classification === "bounded_metadata"
      && entry.retention.includes("memory-only")
      && entry.plaintextReason.includes("not a credential")
    )).toBe(true);
  });

  test("closes exact new DTO leaves and source alarms without invented debt", () => {
    const replacements = DTO_BASELINE_DECLARATIONS.filter((declaration) =>
      SUPERSEDED_MAIN_2026_08_14_DTO_LOCATORS.has(declaration.locator),
    );
    expect(replacements).toHaveLength(10);
    expect(REVIEWED_MAIN_2026_08_14_NEW_DTO_DECLARATIONS).toHaveLength(10);
    expect(JSON.stringify(replacements)).toContain("ClientActionSessionIdV1");

    expect(REVIEWED_MAIN_2026_08_14_SOURCE_ALARMS).toHaveLength(12);
    expect(REVIEWED_MAIN_2026_08_14_SOURCE_ALARMS.some((review) =>
      review.locator.includes("authorized-human-artifact-client.ts")
      && review.closure === "reviewed_exclusion"
    )).toBe(true);
    expect(REVIEWED_MAIN_2026_08_14_SOURCE_ALARMS.filter((review) =>
      review.locator.includes("image-gen/")
    ).every((review) => review.closure === "declaration")).toBe(true);
  });
});
