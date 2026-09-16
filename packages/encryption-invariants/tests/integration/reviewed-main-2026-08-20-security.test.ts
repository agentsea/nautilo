import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { REVIEWED_LANDING_DTO_DECLARATIONS, SUPERSEDED_LANDING_DTO_LOCATORS } from "../../baseline/reviewed-main-2026-09-05-landing-dto";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { RAW_DATABASE_WRITER_DEBT } from "../../baseline/raw-database-writer-debt";
import {
  RETIRED_MAIN_2026_08_20_DATABASE_WRITER_LOCATORS,
  REVIEWED_MAIN_2026_08_20_COVERAGE_ENTRIES,
} from "../../baseline/reviewed-main-2026-08-20-coverage";
import {
  REVIEWED_MAIN_2026_08_20_DTO_DECLARATIONS,
} from "../../baseline/reviewed-main-2026-08-20-dto";
import { SUPERSEDED_MAIN_2026_08_22_DTO_LOCATORS } from "../../baseline/reviewed-main-2026-08-22-dto";
import { SUPERSEDED_MAIN_2026_08_29_DTO_LOCATORS } from "../../baseline/reviewed-main-2026-08-29-dto";
import { SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-main-2026-08-29-source-alarms";
import {
  REVIEWED_MAIN_2026_08_31_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_08_31_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-31-dto";
import {
  REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS,
  SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-dto";
import { SUPERSEDED_MAIN_2026_08_31_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-main-2026-08-31-source-alarms";
import { SUPERSEDED_M300_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-m300-source-alarms";
import { SUPERSEDED_M300_DTO_LOCATORS } from "../../baseline/reviewed-m300-dto";
import { SUPERSEDED_M301_DTO_LOCATORS } from "../../baseline/reviewed-m301-dto";
import { SUPERSEDED_D565_RELAY_DTO_LOCATORS } from "../../baseline/reviewed-d565-relay-dto";
import { REVIEWED_M318_DTO_DECLARATIONS, SUPERSEDED_M318_DTO_LOCATORS } from "../../baseline/reviewed-m318-dto";
import {
  REVIEWED_MAIN_2026_08_20_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_20_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-20-source-alarms";
import {
  RETIRED_MAIN_2026_08_20_FROZEN_DEBT,
  RETIRED_MAIN_2026_08_20_RAW_DATABASE_WRITER_LOCATORS,
} from "../../baseline/retired-main-2026-08-20-query-writers";
import {
  ACTIVATION_REFERENCE_EXCLUSIONS,
  inspectActivationReferenceExclusions,
} from "../../src/node/activation-inventory";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("reviewed main 2026-08-20 encryption inventory", () => {
  test("classifies protected device state narrowly and keeps all other additions bounded", () => {
    expect(REVIEWED_MAIN_2026_08_20_COVERAGE_ENTRIES).toHaveLength(95);
    const protectedEntries = REVIEWED_MAIN_2026_08_20_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "protected",
    );
    expect(protectedEntries).toHaveLength(16);
    for (const entry of protectedEntries) {
      expect(entry.keyFamily).toBe("namespace_human");
      expect(entry.migrationState).toBe("ciphertext_only");
      expect(entry.negativeTestEvidence).toContain(
        "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-20-security.test.ts",
      );
    }

    const boundedEntries = REVIEWED_MAIN_2026_08_20_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "bounded_metadata",
    );
    expect(boundedEntries).toHaveLength(79);
    for (const entry of boundedEntries) {
      expect(entry.plaintextReason).toContain("excludes message");
      expect(entry.metadataAllowlist?.join(" ")).not.toContain("content");
    }
  });

  test("accepts only the reviewed DTO schemas for current arbitrary leaves", () => {
    expect(REVIEWED_MAIN_2026_08_20_DTO_DECLARATIONS).toHaveLength(37);
    for (const declaration of REVIEWED_MAIN_2026_08_20_DTO_DECLARATIONS) {
      if (SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator))
          .toEqual(REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS.filter((candidate) => candidate.locator === declaration.locator));
        continue;
      }
      if (SUPERSEDED_M318_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator))
          .toEqual(REVIEWED_M318_DTO_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator));
        continue;
      }
      if (SUPERSEDED_LANDING_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator))
          .toEqual(REVIEWED_LANDING_DTO_DECLARATIONS.filter((candidate) => candidate.locator === declaration.locator));
        continue;
      }
      if (
        SUPERSEDED_MAIN_2026_08_22_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_MAIN_2026_08_29_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_M300_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_M301_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_D565_RELAY_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_M318_DTO_LOCATORS.has(declaration.locator)
      ) {
        if (
          SUPERSEDED_M301_DTO_LOCATORS.has(declaration.locator)
          || SUPERSEDED_D565_RELAY_DTO_LOCATORS.has(declaration.locator)
        ) {
          expect(DTO_BASELINE_DECLARATIONS.filter((candidate) =>
            candidate.locator === declaration.locator
          )).toHaveLength(1);
          continue;
        }
        const august31Replacement = REVIEWED_MAIN_2026_08_31_DTO_DECLARATIONS.find(
          (candidate) => candidate.locator === declaration.locator,
        );
        if (SUPERSEDED_MAIN_2026_08_31_DTO_LOCATORS.has(declaration.locator)) {
          expect(DTO_BASELINE_DECLARATIONS.filter((candidate) =>
            candidate.locator === declaration.locator
          )).toEqual(august31Replacement ? [august31Replacement] : []);
        } else {
          expect(DTO_BASELINE_DECLARATIONS.some((candidate) =>
            candidate.locator === declaration.locator
          )).toBe(true);
        }
        continue;
      }
      expect(DTO_BASELINE_DECLARATIONS).toContainEqual(declaration);
      for (const payload of declaration.arbitraryPayloads) {
        if ("schema" in payload) {
          expect(payload.schema).toMatch(
            /^(?:AccountDeletionConfirmationV1|AccountDeletionResultV1|BoundedSecurityAuditChangesV1|DesktopAutomationActionSetV1|EncryptionTransitionControlV1|McpTransportConfigV1)$/,
          );
        } else {
          expect(BASELINE_REGISTRY.debt.some((entry) =>
            entry.id === payload.debtId
          )).toBe(true);
        }
      }
    }

    const auditChanges = REVIEWED_MAIN_2026_08_20_DTO_DECLARATIONS.flatMap(
      (entry) => entry.arbitraryPayloads,
    ).find((payload) => payload.path === "response.body.events[].changes");
    expect(auditChanges?.schema).toBe("BoundedSecurityAuditChangesV1");
    for (const locator of [
      "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
      "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage",
      "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
      "relay:server_to_client:relay:dispatch",
    ]) {
      const args = REVIEWED_MAIN_2026_08_20_DTO_DECLARATIONS.find((entry) =>
        entry.locator === locator
      )?.arbitraryPayloads.find((payload) => payload.path === "args");
      expect(args).toHaveProperty("debtId");
    }
  });

  test("closes exact source alarms while retaining risky logs and secret files as debt", async () => {
    expect(REVIEWED_MAIN_2026_08_20_SOURCE_ALARMS).toHaveLength(68);
    expect(REVIEWED_MAIN_2026_08_20_SOURCE_ALARMS.filter((review) =>
      review.closure === "baseline_debt"
    )).toHaveLength(5);
    for (const review of REVIEWED_MAIN_2026_08_20_SOURCE_ALARMS) {
      if (
        SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS.has(review.locator)
        || SUPERSEDED_M300_SOURCE_ALARM_LOCATORS.has(review.locator)
        || SUPERSEDED_MAIN_2026_08_31_SOURCE_ALARM_LOCATORS.has(review.locator)
      ) {
        continue;
      }
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    for (const locator of SUPERSEDED_MAIN_2026_08_20_SOURCE_ALARM_LOCATORS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(false);
    }

    const source = await scanSourceAlarms({ repoRoot: repositoryRoot });
    expect(source.errors).toEqual([]);
    expect(inspectSourceAlarmReviews(source.alarms).errors).toEqual([]);
  });

  test("retires only vanished raw-query debt and preserves immutable history", () => {
    expect(RETIRED_MAIN_2026_08_20_RAW_DATABASE_WRITER_LOCATORS.size).toBe(5);
    expect(RETIRED_MAIN_2026_08_20_DATABASE_WRITER_LOCATORS.size).toBe(9);
    for (const locator of RETIRED_MAIN_2026_08_20_RAW_DATABASE_WRITER_LOCATORS) {
      expect(RAW_DATABASE_WRITER_DEBT.some((entry) => entry.locator === locator))
        .toBe(false);
    }
    for (const retirement of RETIRED_MAIN_2026_08_20_FROZEN_DEBT) {
      expect(BASELINE_REGISTRY.debt.some((entry) =>
        entry.id === retirement.debtId
      )).toBe(true);
      expect(BASELINE_REGISTRY.retiredFrozenDebt).toContainEqual(retirement);
    }
  });

  test("allows only the explicit manual transition control references", async () => {
    const transitionExclusions = ACTIVATION_REFERENCE_EXCLUSIONS.filter(
      (entry) => entry.token === "/admin/encryption-transition",
    );
    expect(transitionExclusions).toHaveLength(8);
    expect(await inspectActivationReferenceExclusions(repositoryRoot)).toEqual({
      count: ACTIVATION_REFERENCE_EXCLUSIONS.length,
      errors: [],
    });
  });
});
